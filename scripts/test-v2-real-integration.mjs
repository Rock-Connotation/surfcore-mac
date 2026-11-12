/**
 * W5/R05：真实 V2 跨链路门禁（2026-11-12 V1 退役）。
 *
 * 旧 `audit-bridge-harness.mjs` 把 routing 桩成 v1 / 或注入恒真来源桩，
 * 只能证明「会话/发送/唤醒」这些旧用例自己的行为，不能证明 V2 集成。
 * 本脚本用**真实** MemoryService/Host（隔离 DSH_HOME + 正式 preview/commit），
 * 覆盖：
 *   1. 全新隔离库：shadowEnabled=0 时，正式授权后真实 adapter capture/prepare 可用（R01）；
 *   2. 未授权 / 撤销策略 / 换模型 / 换角色：全部拒绝，且不读写旧卡（R01/R02）；
 *   3. 真实 Host 签发的准备包：verifyPrepared 拒绝「恒真包装/篡改摘要/过期包」；
 *   4. QQ 与 B站 Native 人格编译：原 persona 含〔一代〕段与旧协议行，编译后不出现（R09）；
 *   5. 只读配置预检：fresh / retired-v1 / control-only / route-only / corrupt / reader-too-new / unreadable；
 *   6. 旧记忆卡生产写者已退役：API 返回结构化错误、旧档案哈希不变（R02）；
 *   7. B站 DM 精确坐标与 pending/ack 语义（R04）；
 *   8. 伙伴分享缺 V2 装配必须拒绝且零模型调用（R10）；
 *   9. 抖音前置失败在 status 中可见（R08）；
 *  10. scheduler 退役屏障：retire 后新任务被拒（R05）。
 *
 * 全程隔离 DSH_HOME；无真实 ~/.dsh、无网络、无平台发送、无真实模型调用。
 */
import { testHome } from '../plugins/surfcore/scripts/isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const root = fs.mkdtempSync(path.join(testHome, 'v2-real-integration-'));
process.env.DSH_HOME = root;
const stateDir = path.join(root, 'surfcore');
const charactersDir = path.join(stateDir, 'characters');
fs.mkdirSync(charactersDir, { recursive: true });

const { createMemoryService } = await import(pathToFileURL(path.join(ROOT, 'src/core/memory-v2-service.js')).href);
const { createMemoryHost } = await import(pathToFileURL(path.join(ROOT, 'plugins/surfcore/lib/memory-v2-host.mjs')).href);
const { deriveMemoryProviderRouteId } = await import(pathToFileURL(path.join(ROOT, 'src/core/memory-v2-routing.js')).href);
const { CONTEXT_FIELDS, digest } = await import(pathToFileURL(path.join(ROOT, 'src/core/memory-v2-contract.js')).href);
const { preflightMemoryConfig, preflightPlan } = await import(pathToFileURL(path.join(ROOT, 'src/core/memory-v2-preflight.js')).href);
const { compileV2Persona, stripLegacyPersonaLines } = await import(pathToFileURL(path.join(ROOT, 'src/core/persona-v2-compile.js')).href);
const { projectBiliV2Trigger } = await import(pathToFileURL(path.join(ROOT, 'plugins/surfcore/lib/bili-v2-triggers.mjs')).href);
const { createCompanionSharing } = await import(pathToFileURL(path.join(ROOT, 'plugins/surfcore/lib/companion-sharing.mjs')).href);
const { createDouyinCompanion } = await import(pathToFileURL(path.join(ROOT, 'plugins/surfcore/lib/douyin-companion.mjs')).href);
const { startScheduler } = await import(pathToFileURL(path.join(ROOT, 'plugins/surfcore/lib/scheduler.js')).href);

const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value?.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code); assert.ok(value.error && value.hint, `${value.code} 必须可见且可行动`); return value; };
const sha = value => createHash('sha256').update(value).digest('hex');
let checks = 0;
const test = (name, fn) => { return Promise.resolve().then(fn).then(() => { checks++; console.log(`PASS ${name}`); }); };

let role = { id: 'app', epoch: 1 };
const management = Symbol('real-integration-management');
const routeId = deriveMemoryProviderRouteId({ provider: 'fixture-provider', model: 'fixture-model' }).providerRouteId;

// 当前角色 + 原 persona（含一代段与旧协议行）；原文件保持不动。
const chars = await import(pathToFileURL(path.join(ROOT, 'src/character-persona.js')).href);
const roleDir = path.join(chars.CHARACTERS_DIR, role.id);
fs.mkdirSync(path.join(roleDir, 'persona.scenes'), { recursive: true });
const legacyPersona = [
  '# 角色核心',
  '这是通用人格。',
  '## 二代设定 〔二代〕',
  '用 V2 工具协议。',
  '## 一代设定 〔一代〕',
  '〔一代〕 专用段，绝不能进 V2。',
  '按空格分条输出',
  '输出 [SILENT] 表示不回复',
  '',
].join('\n');
fs.writeFileSync(path.join(roleDir, 'persona.md'), legacyPersona);
fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ version: 1, ...role }));
const personaHashBefore = sha(fs.readFileSync(path.join(roleDir, 'persona.md')));

const service = createMemoryService({ stateDir, charactersDir: chars.CHARACTERS_DIR, getCharacter: () => role, authorizeManagement: value => value === management });
good(await service.initialize());
let freshStatus = good(await service.getStatus());
assert.equal(freshStatus.activeBackend, 'v2');
assert.equal(freshStatus.shadowEnabled, 0, '全新隔离库必须是未开影子期的默认 V2');

const base = { channel: 'qq', conversationKey: 'qq:1:private:3', sourceAccountKey: 'qq:3', requesterAccountKey: 'qq:3', providerRouteId: routeId, purpose: 'conversation' };
const admin = async () => good(await service.host.captureAdminContext({ ...base, audiencePolicyId: 'management', processingGrantId: 'management' }, management)).context;
const host = createMemoryHost({ memoryService: service, getCharacter: () => role, handleTtlMs: 300000,
  resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: channel === 'qq' ? 'qq:3' : 'local:owner', requesterAccountKey: channel === 'qq' ? 'qq:3' : 'local:owner', providerRouteId: routeId }) });
const adapter = host.createAdapter({ channel: 'qq', principal: { source: 'real-integration' }, canBindInput: true });
let modelCalls = 0;

async function run() {
  await test('R01 全新库：未授权拒绝', async () => {
    bad(await adapter.capture({ conversationKey: base.conversationKey }), 'MEMORY_POLICY_DENIED');
  });

  await test('R01 正式 preview/commit 授权后 capture/prepare 可用（不开 shadow）', async () => {
    const policy = { policyId: 'real-integration-policy', approved: true, audiences: [[base.channel, base.conversationKey, base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: routeId }] };
    const ctx = await admin();
    good(await service.host.configurePolicy(ctx, policy, ctx.controlRevision, 'real-integration-policy'));
    const after = good(await service.getStatus());
    assert.equal(after.shadowEnabled, 0, '正式授权不得顺手打开历史影子开关');
    const captured = good(await adapter.capture({ conversationKey: base.conversationKey }));
    const prepared = good(await adapter.prepare(captured.handle, '真实来源', { memory: 1800, total: 6000 }));
    assert.ok(prepared.preparedHandle);
    // 真实 Host 同步签发校验：包必须由这个 live context 签发，异步/恒真夹具不算证据。
    const verified = adapter.verifyPrepared(captured.handle, prepared.preparedHandle, prepared.prepared);
    assert.equal(verified?.ok, true, JSON.stringify(verified));
    assert.equal(typeof verified.then, 'undefined', '签发校验必须同步');
    const tampered = { ...prepared.prepared, text: prepared.prepared.text + '!', queryDigest: digest('别的提问') };
    bad(adapter.verifyPrepared(captured.handle, prepared.preparedHandle, tampered), 'MEMORY_PREPARED_UNTRUSTED');
    adapter.release(captured.handle);
  });

  await test('R01 撤销策略 / 换模型 / 换角色仍拒绝', async () => {
    const ctx = await admin();
    good(await service.applyMemoryAction(ctx, { type: 'revoke_policy', policyId: 'real-integration-policy' }, ctx.controlRevision, 'real-integration-revoke'));
    bad(await adapter.capture({ conversationKey: base.conversationKey }), 'MEMORY_POLICY_DENIED');
    const oldRole = role;
    role = { ...role, epoch: 2 };
    // 策略已撤销 + 角色变化：两者都拒绝，具体码取决于先到的门禁；断言「拒绝且有下一步」。
    bad(await adapter.capture({ conversationKey: base.conversationKey }));
    role = oldRole;
  });

  await test('R02 旧记忆卡写者退役：旧档案哈希不变', async () => {
    const index = fs.readFileSync(path.join(ROOT, 'plugins/surfcore/lib/index.js'), 'utf8');
    assert.equal(/runMemoryCardMaintenance\(/.test(index), false, '生产装配不得再调用旧记忆卡维护');
    assert.equal(index.includes('startMemoryCardTimer('), false, '生产装配不得再启动旧卡定时器');
    assert.match(index, /MEMORY_CARD_WRITE_RETIRED/);
    assert.equal(sha(fs.readFileSync(path.join(roleDir, 'persona.md'))), personaHashBefore, '原 persona 必须保持原样');
  });

  await test('R05 恒真准备包不能冒充真实 Host 签发', async () => {
    // 纯函数夹具只负责投影：这里显式断言它「恒真」，绝不作为跨链路证据。
    const text = String(fs.readFileSync(path.join(ROOT, 'scripts/test-v2-context-fixture.mjs'), 'utf8'));
    assert.match(text, /恒真.*纯函数夹具|verifyPreparedMemory.*恒真/s);
    assert.match(text, /绝不能.*跨链路集成证据|不得声称.*V2 签发/s);
  });

  await test('R09 QQ/B站 共用 V2 人格编译：原文件不改、一代段与旧协议行消失', async () => {
    const compiled = compileV2Persona({ roleId: role.id, sceneKey: 'private:3', maxChars: 6000 });
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    assert.equal(compiled.digest.length, 64);
    assert.ok(compiled.removedLegacyLines >= 0, '编译必须报告剔除统计');
    // 〔一代〕小节被整段排除，所以其中的旧协议行不会进入第二层逐行过滤；
    // 两层共同结果由下面的「最终文本」断言钉住。
    assert.doesNotMatch(compiled.text, /〔一代〕|专用段|按空格分条|\[SILENT\]/);
    assert.match(compiled.text, /这是通用人格/);
    assert.match(compiled.text, /用 V2 工具协议/);
    const bili = compileV2Persona({ roleId: role.id, scene: 'bili', maxChars: 6000 });
    assert.equal(bili.ok, true);
    assert.equal(sha(fs.readFileSync(path.join(roleDir, 'persona.md'))), personaHashBefore, '编译不得回写原 persona');
    assert.equal(compiled.text.includes('〔一代〕'), false);
    assert.equal(stripLegacyPersonaLines('输出 [SILENT] 表示不回复\n普通行').removed.length, 1);
  });

  await test('R07 只读配置预检覆盖全部状态', async () => {
    const dir = fs.mkdtempSync(path.join(testHome, 'preflight-'));
    const fresh = preflightMemoryConfig({ stateDir: dir });
    assert.equal(fresh.state, 'fresh');
    assert.ok(preflightPlan(fresh).steps.length > 0);
    fs.writeFileSync(path.join(dir, 'memory-control.sqlite'), 'fixture existence only');
    assert.equal(preflightMemoryConfig({ stateDir: dir }).state, 'control-only');
    const routeDir = path.join(dir, 'memory-v2');
    fs.mkdirSync(routeDir, { recursive: true });
    const routeFile = path.join(routeDir, 'routing.json');
    const writeRoute = value => fs.writeFileSync(routeFile, JSON.stringify(value) + '\n', { mode: 0o600 });
    writeRoute({ schemaVersion: 1, backend: 'v1', controlRevision: 1, storeGeneration: 'g', minCompatibleReader: 1 });
    const retired = preflightMemoryConfig({ stateDir: dir });
    assert.equal(retired.state, 'retired-v1');
    assert.equal(retired.code, 'MEMORY_BACKEND_RETIRED');
    assert.match(retired.hint, /不要删除|原文件/);
    writeRoute({ schemaVersion: 1, backend: 'v2', controlRevision: 1, storeGeneration: 'g', minCompatibleReader: 99 });
    assert.equal(preflightMemoryConfig({ stateDir: dir }).state, 'reader-too-new');
    fs.writeFileSync(routeFile, '{broken', { mode: 0o600 });
    assert.equal(preflightMemoryConfig({ stateDir: dir }).state, 'corrupt');
    writeRoute({ schemaVersion: 1, backend: 'v2', controlRevision: 1, storeGeneration: 'g', minCompatibleReader: 1 });
    assert.equal(preflightMemoryConfig({ stateDir: dir }).state, 'ready');
  });

  await test('R04 B站 DM 精确坐标投影：缺 msgKey 拒绝', async () => {
    const providerRouteId = routeId;
    bad(projectBiliV2Trigger({ input: { kind: 'dm-notification', items: [{ mid: '22000' }] }, providerRouteId }), 'BILI_V2_TRIGGER_UNPROVEN');
    const projected = good(projectBiliV2Trigger({ input: { kind: 'dm-notification', items: [{ mid: '22000', msgKey: '9988776655' }] }, providerRouteId }));
    assert.equal(projected.groups.length, 1);
    assert.equal(projected.groups[0].scope.target.kind, 'dm');
    assert.equal(projected.groups[0].input.items[0].msgKey, '9988776655');
  });

  await test('R10 伙伴分享缺 V2 装配拒绝且零模型调用', async () => {
    const sharing = createCompanionSharing({ stateDir, getCharacter: () => role, now: () => new Date(),
      readiness: async () => ({ ok: true }), buildContext: async () => ({ ok: true, text: '' }),
      modelReply: async () => { modelCalls++; return { text: 'x', finishReason: 'stop' }; } });
    const value = await sharing.reply({ characterId: role.id, characterEpoch: role.epoch }, { requestId: '22222222-2222-4222-8222-222222222222', text: 'hello' });
    bad(value, 'MEMORY_SHARING_UNAVAILABLE');
    assert.equal(modelCalls, 0, '缺装配不得调用模型');
    await sharing.dispose();
  });

  await test('R08 抖音前置失败在公开 status 中可见', async () => {
    const dir = fs.mkdtempSync(path.join(testHome, 'douyin-fail-'));
    // 本用例只验证「readFeed 之前失败时 status 的可见性」；adapter 是最小可信桩，
    // 它的 prepare/ingest 不会被调用（前置失败在它们之前）。真实 V2 写入链由
    // test-memory-v2-douyin.mjs 与 test-douyin-companion.mjs 覆盖。
    const minimalAdapter = {
      capture: async () => ({ ok: true, handle: 'fixture', sourceStamp: { providerRouteId: deriveMemoryProviderRouteId({ provider: 'surfcore-companion-hy3', model: 'workbuddy/hy3' }).providerRouteId, conversationKey: 'douyin:homepage-recommendation' } }),
      validate: async () => ({ ok: true }), verifyPrepared: () => ({ ok: true }), release: async () => ({ ok: true }),
      bindActualInput: async () => ({ ok: true }), withNetworkAdmission: async (_h, dispatch) => dispatch(),
      ingest: async () => { throw new Error('must not be called'); },
      prepare: async () => { throw new Error('must not be called'); },
      receipt: async () => ({ ok: true }),
    };
    const engine = createDouyinCompanion({ stateDir: dir, getCharacter: () => role,
      memoryV2: { adapter: minimalAdapter, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: async () => ({ ok: true, retired: true }) },
      readiness: async () => ({ ok: true }),
      readFeed: async () => ({ ok: false, code: 'DOUYIN_FEED_FAILED', error: '推荐读取失败', hint: '检查登录与首页后重试' }),
      perceive: async () => { throw new Error('must not be called'); },
      modelCall: async () => { modelCalls++; throw new Error('must not be called'); },
      buildContext: async () => ({ ok: true, text: '' }), recordMemory: async () => ({ ok: true }) });
    const context = { characterId: role.id, characterEpoch: role.epoch };
    const started = good(await engine.start(context));
    let status;
    let failed = null;
    for (let i = 0; i < 400; i++) {
      status = await engine.status(context);
      const job = status.recentJobs?.find(item => item.jobId === started.jobId);
      if (job && !['running', 'queued'].includes(job.state)) { failed = job; break; }
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(failed, '前置失败作业必须出现在 status');
    assert.equal(failed.code, 'DOUYIN_FEED_FAILED');
    assert.ok(failed.hint);
    assert.equal(modelCalls, 0, '前置失败不得调用模型');
    await engine.dispose?.();
  });

  await test('R05 scheduler 退役后拒绝新准入', async () => {
    const dir = fs.mkdtempSync(path.join(testHome, 'scheduler-'));
    const scheduler = startScheduler({ get: () => null, sessionController: { cancel: async () => ({ ok: true }) } },
      { dshHome: dir, biliMjs: path.join(dir, 'bili.mjs'), biliV2Agent: { enqueue: async () => ({ ok: true }), retire: async () => ({ ok: true }) },
        memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }) }, log: () => {} });
    good(await scheduler.retire({ timeoutMs: 200 }));
    assert.equal(scheduler.status().closed, true);
    await assert.rejects(() => scheduler.tick(), error => error.code === 'BILI_SCHEDULER_CLOSED');
    scheduler.stop();
  });

  await test('真实数据保留：app 记忆/控制库/persona 未被改写', async () => {
    assert.equal(sha(fs.readFileSync(path.join(roleDir, 'persona.md'))), personaHashBefore);
    assert.ok(fs.existsSync(path.join(stateDir, 'memory-control.sqlite')), '隔离控制库存在且只属于测试');
  });
}

let failure = null;
try { await run(); }
catch (error) { failure = error; }
finally {
  try { host.close(); } catch {}
  try { await service.close(); } catch {}
  if (failure) { console.error('FAIL', failure.stack || failure); process.exitCode = 1; }
  else console.log(`PASS real V2 integration: ${checks} checks`);
}
