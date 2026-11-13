// F01/F02 R2 回归公共夹具：真实 V2 默认工厂 + 隔离测试根。
//
// 约束（任务书）：
//   · 测试根必须来自 isolate-test-home.mjs / shareTestRoot()，禁止碰真实 ~/.dsh；
//   · 不启动服务、不发真实 QQ/B站消息、不跑 probe/setup-dsh、不调用付费模型；
//   · createQQMemoryBridge / createMemoryClient 使用真实默认工厂，不手填恒真安全谓词、
//     不伪造 session、不伪造 V2 来源。routing.json 由真实 MemoryService 的 Host 快照发布。
//   · 平台边界用受控假对象：FakeBot 的 sendPrivateMessage/sendGroupMessage 与
//     OneBot identity HTTP 用 loopback 假响应；模型回复提交点由真实 Host API 接收。
import { testHome, shareTestRoot } from '../plugins/surfcore/scripts/isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OWNER = '10001';
const GROUP = '90001';
const LOGIN = '100';
const KEY = `private:${OWNER}`;
const GROUP_KEY = `group:${GROUP}`;

const good = (value, label = '') => {
  assert.equal(value?.ok, true, `${label} ${JSON.stringify(value)}`);
  return value;
};

/**
 * 每个用例在 isolate-test-home 拥有的 testHome 下创建独立子根；
 * 静态角色目录常量在子进程启动时已由 DSH_HOME 固定到这个子根。
 */
export function newCaseRoot(label) {
  const root = fs.mkdtempSync(path.join(testHome, `r2-v2-${label}-`));
  const stateDir = path.join(root, 'surfcore');
  fs.mkdirSync(path.join(stateDir, 'characters'), { recursive: true });
  return { root, stateDir };
}

/** 进程隔离入口：用 spawnSync 让每个用例拿到全新 DSH_HOME / 模块缓存。 */
export function runIsolated(script, label, extraEnv = {}) {
  const { root, stateDir } = newCaseRoot(label);
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, script], {
      env: {
        ...process.env,
        DSH_HOME: root,
        R2_CASE_ROOT: root,
        R2_CASE_STATE_DIR: stateDir,
        ...shareTestRoot(),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      encoding: 'utf8',
    });
    return { status: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
  } finally {
    assert.ok(root.startsWith(testHome + path.sep), 'case root must stay inside the owned test home');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 只在本模块被直接作为进程入口时由各用例调用：拼装真实 V2 工厂。 */
export async function createRealV2Factory({ label = 'case' } = {}) {
  const root = fs.realpathSync(process.env.R2_CASE_ROOT ?? '');
  const stateDir = fs.realpathSync(process.env.R2_CASE_STATE_DIR ?? '');
  assert.ok(root.startsWith(testHome + path.sep), 'R2 case root must be owned by isolate-test-home/shareTestRoot()');
  assert.ok(stateDir.startsWith(root + path.sep), 'R2 case stateDir must stay inside the owned case root');

  const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
  const { createMemoryService } = await imp('src/core/memory-v2-service.js');
  const { createQQMemoryBridge } = await imp('src/core/memory-v2-qq.js');
  const { createMemoryClient } = await imp('src/core/memory-v2-client.js');
  const { writeMemoryRouting, deriveMemoryProviderRouteId } = await imp('src/core/memory-v2-routing.js');
  const { createMemoryHost } = await imp('plugins/surfcore/lib/memory-v2-host.mjs');
  const { createMemoryApiService } = await imp('plugins/surfcore/lib/memory-v2-api.mjs');
  const { resolveQQMemoryIdentity } = await imp('plugins/surfcore/lib/memory-v2-identity.mjs');
  const { createCharacter, switchCharacter, readCurrentCharacter, CHARACTERS_DIR } = await imp('src/character-persona.js');
  const { bridgeHarness } = await imp('scripts/audit-bridge-harness.mjs');

  const management = Object.freeze({});
  const replayAuthority = Object.freeze({});
  const routeId = good(deriveMemoryProviderRouteId({ provider: 'fixture', model: 'fixture' }), 'routeId').providerRouteId;
  createCharacter({ name: 'R2 fixture', id: 'r2-fixture', personaText: '隔离测试角色，不读取旧记忆。' });
  switchCharacter('r2-fixture');
  const role = readCurrentCharacter();
  assert.ok(role?.id === 'r2-fixture');

  const service = createMemoryService({
    stateDir, charactersDir: CHARACTERS_DIR, getCharacter: readCurrentCharacter,
    authorizeManagement: (auth) => auth === management,
    authorizeProducerReplay: (auth) => auth === replayAuthority,
  });
  good(await service.initialize(), 'service.initialize');

  const base = {
    channel: 'qq', conversationKey: `qq:${LOGIN}:private:${OWNER}`,
    sourceAccountKey: `qq:${OWNER}`, requesterAccountKey: `qq:${OWNER}`,
    providerRouteId: routeId, purpose: 'conversation',
  };
  let operation = 0;
  const action = async (value) => {
    const admin = good(await service.host.captureAdminContext(base, management), 'captureAdminContext').context;
    return service.applyMemoryAction(admin, value, admin.controlRevision, `manage:${++operation}`);
  };
  // 正式授权：精确 conversation/actor/providerRoute 域，而非恒真策略。
  good(await action({ type: 'configure_policy', policy: {
    policyId: 'r2-private', approved: true,
    audiences: [['qq', `qq:${LOGIN}:private:${OWNER}`, `qq:${OWNER}`]],
    processingGrants: [{ grantId: 'r2-grant', providerRouteId: routeId }],
  } }), 'configure_policy');
  // 真实 Host 快照发布 routing.json（不是手填文件）。
  const publishRoute = async () => good(writeMemoryRouting({
    stateDir, status: { ...good(await service.getStatus(), 'getStatus'), activeBackend: 'v2' },
  }), 'writeMemoryRouting');
  await publishRoute();

  const host = createMemoryHost({
    memoryService: service, getCharacter: readCurrentCharacter, handleTtlMs: 300_000,
    resolveIdentity: ({ sourceFacts }) => resolveQQMemoryIdentity({
      accountId: LOGIN, allowedGroups: [GROUP], allowedPrivates: [OWNER], providerRouteId: routeId,
    }, sourceFacts),
    getProducerReplayAuthorization: () => replayAuthority,
  });

  const nativeSubmissions = [];
  let api, server;
  const onebot = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const data = req.url === '/get_login_info' ? { user_id: LOGIN, nickname: 'r2' } : { online: true, good: true };
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  try {
    await new Promise((resolve) => onebot.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${onebot.address().port}`;
    server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, `http://${req.headers.host}`)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = createMemoryApiService({
      host, stateDir, currentDshUrl: () => `http://127.0.0.1:${server.address().port}`,
      onQQReply: (input) => { nativeSubmissions.push(input); return { ok: true, accepted: true, requestId: input.requestId }; },
      scopes: [{ id: 'qq', channel: 'qq', principal: {}, canBindInput: true, canSubmitSourceFacts: true }],
    });
    good(api.writeHostFiles(), 'writeHostFiles');

    const harness = await bridgeHarness({
      config: {
        ownerQQ: OWNER,
        allow: { private: [OWNER], groups: [GROUP] },
        deny: { private: [], groups: [], users: [] },
        dsh: { provider: 'fixture', model: 'fixture', followDefaultModel: false, allowModelFallback: true },
        agentPreset: 'qq-chat-v2',
        snowluma: { httpUrl: gatewayUrl, accessToken: '' },
        sendDelayMs: 0,
        interaction: { requireRequestId: false },
        fishGuard: { enabled: false },
        chat: { presence: { enabled: false } },
        slang: { enabled: false },
      },
      globals: {
        readCurrentCharacter,
        // 真实 V2 默认工厂：stateDir/getCharacter 指向真实 Host 持久状态；
        // 不提供 getRouting / getSessionMemorySafety 覆盖（恒真安全谓词被禁止）。
        createQQMemoryBridge: (options) => createQQMemoryBridge({ ...options, stateDir, getCharacter: readCurrentCharacter }),
        createMemoryClient: (options) => createMemoryClient({ ...options, stateDir, getCharacter: readCurrentCharacter }),
        // 网关 fetch 组合：OneBot 身份/发送动作返回受控假响应（不发真实 QQ），
        // 其余动作走通用兜底。真实 Memory RPC 不经 VM fetch（client 在真实模块域用 node fetch）。
        fetch: gatewayFetch,
        // 受控平台 bot：ACK（delivered/unknown/throw）与发送挂起点由测试控制；
        // 保留 sendToQQ → bot wrapper 的完整生产路径（ticket 旁路、guard、beginMemoryV2Send）。
        SnowLumaWebSocketClient: ControlledBot,
      },
    });
    assert.equal(harness.memoryV2Route().backend, 'v2', 'bridge must run on the real V2 route');
    harness.setReady(true);
    harness.setPresets(['qq-chat-v2']);
    harness.setSelfUserId(LOGIN);
    harness.setMode('chat');
    return {
      root, stateDir, harness, service, host, api, onebot, server,
      role, routeId, action, publishRoute, nativeSubmissions,
      KEY, GROUP_KEY, OWNER, LOGIN,
      async close() {
        await harness.close();
        api?.close(); host.close();
        await Promise.all([
          new Promise((resolve) => server?.close(resolve)),
          new Promise((resolve) => onebot.close(resolve)),
        ]);
        await service.close();
      },
    };
  } catch (error) {
    api?.close(); host.close();
    try { await new Promise((resolve) => server?.close(resolve)); } catch {}
    try { await new Promise((resolve) => onebot.close(resolve)); } catch {}
    await service.close();
    throw error;
  }
}

/** owner 私聊入站信封（真实 handleIncoming，不触发真实平台 IO）。 */
export function inbound(overrides = {}) {
  return {
    post_type: 'message', message_type: 'private',
    self_id: Number(LOGIN), user_id: Number(OWNER),
    message_id: crypto.randomInt(1e6, 2e6),
    raw_message: '当前测试消息', message: [{ type: 'text', data: { text: '当前测试消息' } }],
    sender: { user_id: Number(OWNER), nickname: '主人' },
    ...overrides,
  };
}

export { assert, fs, path, http, crypto, good, testHome, KEY, GROUP_KEY, OWNER, LOGIN };
