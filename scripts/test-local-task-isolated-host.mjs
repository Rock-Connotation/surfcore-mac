// 隔离环境真实 DSH Host + 真实 Bridge.js 端到端集成测试（本机任务 T01–T08）。
// 启动真实 DeepSeek Harness App 宿主进程（ELECTRON_RUN_AS_NODE=1，非回环外网硬阻断），
// 并连接真实 src/bridge.js 控制台与 OneBot 回环夹具，绝不接触真实 ~/.dsh、不重启桌面 DSH、不发真 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createLocalTaskClient } from '../src/core/local-task-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = '/Applications/DeepSeek Harness.app/Contents/Resources';
const EXECUTABLE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const HOST_ENTRY = path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');

if (!fs.existsSync(EXECUTABLE) || !fs.existsSync(path.join(RESOURCES, 'app.asar'))) {
  console.log('SKIP: DeepSeek Harness.app not installed on this host');
  process.exit(0);
}

const SNAPSHOT_PATHS = [
  'state/mode.json',
  'plugins/surfcore/presets/qq-chat-v2.patch.yml',
  'plugins/surfcore/presets/local-task.patch.yml',
];
const snapshots = SNAPSHOT_PATHS.map((rel) => {
  const full = path.join(REPO_ROOT, rel);
  return {
    full,
    existed: fs.existsSync(full),
    content: fs.existsSync(full) ? fs.readFileSync(full) : null,
  };
});

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-isolated-host-'));
const runtimeDir = path.join(tmpBase, 'runtime');
const homeDir = path.join(tmpBase, 'home');
const dshHome = path.join(homeDir, '.dsh');
const qqRoot = path.join(tmpBase, 'qq-fixture');
const wsDir = path.join(tmpBase, 'workspace');
const outsideDir = path.join(tmpBase, 'outside');
const guardFile = path.join(tmpBase, 'guard.mjs');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(dshHome, { recursive: true });
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
fs.symlinkSync(path.join(RESOURCES, 'app.asar'), path.join(runtimeDir, 'app.asar'));
fs.symlinkSync(path.join(RESOURCES, 'app.asar.unpacked'), path.join(runtimeDir, 'app.asar.unpacked'), 'dir');
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '// fixture');
fs.writeFileSync(path.join(wsDir, 'seed.txt'), 'SEED_IN_WORKSPACE');
fs.writeFileSync(path.join(wsDir, 'existing.txt'), 'ORIGINAL_HOST_CONTENT', { mode: 0o640 });
fs.writeFileSync(path.join(wsDir, 'normal.txt'), 'NORMAL_V1');
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET');
const existingStatBefore = fs.statSync(path.join(wsDir, 'existing.txt'));

// 阻断一切非 127.0.0.1 / localhost 外网访问；允许本地回环 IPC / Host HTTP 与桥接测试流量。
fs.writeFileSync(guardFile, `
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

const isLoopback = (host) => !host || host === '127.0.0.1' || host === '::1' || host === 'localhost';
const denyError = (kind, target) => Object.assign(new Error('isolated Host gate denied ' + kind + ': ' + target), { code: 'ISOLATED_NET_DENIED' });
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const opt = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
  const host = opt.host ?? (typeof args[1] === 'string' ? args[1] : undefined);
  if (typeof args[0] !== 'string' && !opt.path && host && !isLoopback(host)) {
    const err = denyError('tcp', host);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};
const origTls = tls.connect;
tls.connect = function(...args) {
  const opt = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
  const host = opt.host ?? opt.servername ?? (typeof args[1] === 'string' ? args[1] : undefined);
  if (host && !isLoopback(host)) {
    const s = new tls.TLSSocket();
    const err = denyError('tls', String(host));
    process.nextTick(() => s.destroy(err));
    return s;
  }
  return origTls.apply(this, args);
};
dgram.createSocket = () => { throw denyError('udp', 'dgram'); };
for (const key of ['resolve', 'resolve4', 'resolve6', 'reverse']) {
  dns[key] = (...args) => {
    const host = args[0];
    const cb = args.find((a) => typeof a === 'function');
    if (!isLoopback(host)) {
      const err = denyError('dns:' + key, String(host));
      if (cb) { process.nextTick(() => cb(err)); return; }
      throw err;
    }
  };
}
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!isLoopback(url.hostname)) throw denyError('fetch', url.href);
  return origFetch(input, init);
};
for (const mod of [http, https]) {
  const origReq = mod.request;
  mod.request = function(urlOrOpts, ...rest) {
    try {
      const host = typeof urlOrOpts === 'string' ? new URL(urlOrOpts).hostname : (urlOrOpts?.hostname || urlOrOpts?.host?.split(':')[0]);
      if (host && !isLoopback(host)) {
        const req = origReq.call(this, { host: '127.0.0.1', port: 1 }, ...rest);
        process.nextTick(() => req.destroy(denyError('http', host)));
        return req;
      }
    } catch {}
    return origReq.call(this, urlOrOpts, ...rest);
  };
}
syncBuiltinESMExports();
`);

let bridge = null;
let consoleServer = null;
let hostProc = null;

try {
  // 1. 先起真实 bridge.js 控制台，取得动态 consolePort 与 consoleToken，写进隔离 qqRoot/config.json。
  const consoleToken = 'isolated-host-console-token-0123456789abcdef';
  bridge = await bridgeHarness({
    config: {
      consoleToken,
      consolePort: 0,
      ownerQQ: 123456,
      snowluma: { httpUrl: 'http://127.0.0.1:19999', accessToken: 'fixture-onebot-token' },
      allow: { private: ['123456'], groups: [] },
      deny: { users: [], private: [], groups: [] },
    },
    globals: {
      createLocalTaskClient: () => createLocalTaskClient({ stateDir: path.join(dshHome, 'surfcore') }),
      createQQMemoryBridge: () => ({
        routing: () => ({ ok: true, backend: 'v2' }),
        status: () => ({ active: false, sourceState: 'committed', failure: null }),
        validate: async () => ({ ok: true }),
        captureSource: async () => ({ ok: true }),
        prepareReply: async () => ({ ok: true }),
        retire: async () => ({ ok: true }),
        validateSessionSafety: async () => ({ ok: true }),
      }),
    },
  });
  bridge.setMode('reserved2');
  const sendPrivate = (msgId, text) => bridge.handleIncoming('private', 123456, {
    user_id: 123456,
    self_id: 999999,
    message_id: msgId,
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: 123456, nickname: '主人' },
  }, bridge.cfg);
  const extractSentTexts = (fromHttpIdx, fromSentIdx) => [
    ...bridge.calls.http.slice(fromHttpIdx)
      .filter((c) => c.url.endsWith('/send_private_msg'))
      .map((c) => JSON.stringify(c.body)),
    ...bridge.calls.sent.slice(fromSentIdx).map((m) => String(m.text ?? m.message ?? '')),
  ];
  consoleServer = bridge.startConsoleServer();
  if (!consoleServer.listening) await new Promise((resolve) => consoleServer.once('listening', resolve));
  const consoleReqs = [];
  consoleServer.on('request', (req, res) => {
    const chunks = [];
    const origEnd = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      consoleReqs.push({ method: req.method, url: req.url, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) });
      return origEnd(chunk, ...rest);
    };
  });
  const consolePort = consoleServer.address().port;
  fs.writeFileSync(path.join(qqRoot, 'config.json'), JSON.stringify({
    ownerQQ: '123456',
    consolePort,
    consoleToken,
    allow: { private: ['123456'], groups: [] },
  }, null, 2));

  // 2. 用 setup-dsh.mjs 生成完整的隔离 desktop profile（含 surfcore bundle、local-task / qq-chat-v2 预设、MCP 条目）。
  fs.mkdirSync(path.join(dshHome, 'surfcore'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'surfcore', 'config.json'), JSON.stringify({
    version: 1,
    platforms: { start: { qq: false, bili: false } },
    updates: { enabled: false, checkOnStart: false },
    localTask: { mode: 'files-only', chatHandoff: false },
  }, null, 2));
  const cleanEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete cleanEnv[k];
  }
  const childEnv = {
    ...cleanEnv,
    HOME: homeDir,
    USERPROFILE: homeDir,
    DSH_HOME: dshHome,
    DSH_NODE: process.execPath,
    DSH_TELEMETRY_DISABLED: '1',
    SURFCORE_ROOT: qqRoot,
    SURFCORE_LOCAL_TASK_ROOT: wsDir,
    SURFCORE_SKIP_AUTOSTART: '1',
    SURFCORE_DISABLE_CHARACTER_MIGRATION: '1',
    SURFCORE_DISABLE_MEMORY_TIMER: '1',
    QQ_BRIDGE_SKIP_DSH_INSTALL: '1',
    DEEPSEEK_API_KEY: 'sk-isolated-dummy-key',
  };
  execFileSync(process.execPath, ['scripts/setup-dsh.mjs', 'desktop'], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: 'pipe',
  });

  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  const surfcoreLink = path.join(profileDir, 'node_modules', 'surfcore');
  if (!fs.existsSync(surfcoreLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'plugins', 'surfcore'), surfcoreLink, 'dir');
  }
  const probeFile = path.join(profileDir, 'lt-probe.mjs');
  const gateModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'local-task-gate.mjs')).href;
  const hostModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'local-task-host.mjs')).href;
  const pipelineModuleUrl = pathToFileURL(path.join(runtimeDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'pipeline.js')).href;

  fs.writeFileSync(probeFile, `
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const name = 'lt-isolated-probe';
export const inject = ['agentPresets', 'agents', 'tools', 'sessionController', 'storageDomain', 'webServer'];

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export async function apply(ctx, config) {
  const { taskGateIsLive } = await import(${JSON.stringify(gateModuleUrl)});
  const { getLocalTasks } = await import(${JSON.stringify(hostModuleUrl)});
  const { ToolExecutionPipeline } = await import(${JSON.stringify(pipelineModuleUrl)});

  // 接管本机任务会话的真实 agent-loop / title-llm llm/stream：挂起 t1 回合直到验收释放，并可触发真实 turn/end completed。
  const heldStreams = new Map();
  const releasedSessions = new Set();
  ctx.on('llm/stream', (options, next) => {
    if (options?._probeDirect) return next();
    const sid = options?.sessionId;
    const rt = getLocalTasks();
    if (!rt.ok || typeof sid !== 'string' || !rt.service.isTaskSession(sid)) return next();
    return (async function* () {
      let outcome = 'completed';
      if (!releasedSessions.has(sid)) {
        let release;
        const gate = new Promise((r) => { release = r; });
        if (!heldStreams.has(sid)) heldStreams.set(sid, []);
        heldStreams.get(sid).push(release);
        const onAbort = () => release('aborted');
        options?.signal?.addEventListener?.('abort', onAbort, { once: true });
        outcome = await gate;
        options?.signal?.removeEventListener?.('abort', onAbort);
      }
      if (outcome === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '已完成工作区报告新建，未覆盖既有文件。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已完成工作区报告新建，未覆盖既有文件。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  });

  ctx.webServer.register({
    kind: 'prefix',
    path: '/__lt_probe',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/__lt_probe/presets' && req.method === 'GET') {
          const list = await ctx.agentPresets.list();
          const compositions = ctx.agentPresets.inspectCompositions();
          sendJson(res, 200, {
            ok: true,
            list,
            compositions,
            localTaskGateLive: taskGateIsLive('local-task'),
          });
          return;
        }
        if (u.pathname === '/__lt_probe/verify-session' && req.method === 'POST') {
          const body = await readJson(req);
          const agent = ctx.agents.get(body.sessionId);
          if (!agent) { sendJson(res, 404, { ok: false, error: 'agent not found for ' + body.sessionId }); return; }
          const presetId = ctx.agentPresets.composedPreset(agent.ctx);
          const schemaNames = (ctx.tools.schemas(agent) ?? []).map((t) => t.name).sort();
          const pipeline = new ToolExecutionPipeline(agent.ctx);
          const runTool = async (name, args, targetAgent = agent) => {
            const ac = new AbortController();
            const prepared = await pipeline.prepare({ callId: 'p-' + Math.random().toString(36).slice(2), name, arguments: args, agent: targetAgent, signal: ac.signal });
            if (prepared.kind !== 'dispatch') return await pipeline.complete(prepared.exec, prepared);
            const out = await pipeline.dispatch(prepared.exec);
            return await pipeline.complete(prepared.exec, out);
          };
          const readInside = await runTool('read', { file_path: 'seed.txt' });
          const readOutside = await runTool('read', { file_path: path.join(config.outsideDir, 'secret.txt') });
          const createFresh = await runTool('write', { file_path: 'report.md', content: '# Report\\nOK' });
          const readExisting = await runTool('read', { file_path: 'existing.txt' });
          const overwriteExisting = await runTool('write', { file_path: 'existing.txt', content: 'HACKED' });

          // llm/stream 真实瀑布流验证（主任务 t1 上验证放行与透传；第 31 次额度阻断等 t1 归还席位后测）
          let streamExecs = 0;
          for await (const _ of ctx.waterfall(null, 'llm/stream', { sessionId: body.sessionId, _probeDirect: true }, async function* () { streamExecs += 1; yield 's1'; })) {}

          sendJson(res, 200, {
            ok: true,
            presetId,
            schemaNames,
            liveGateInProbe: taskGateIsLive('local-task'),
            taskNow: getLocalTasks().service?.findBySessionId?.(body.sessionId) ?? null,
            readInside,
            readOutside,
            createFresh,
            readExisting,
            overwriteExisting,
            streamExecs,
            compositionsAfterSession: ctx.agentPresets.inspectCompositions(),
          });
          return;
        }
        if (u.pathname === '/__lt_probe/emit-turn-end' && req.method === 'POST') {
          const body = await readJson(req);
          const agent = ctx.agents.get(body.sessionId);
          if (!agent) { sendJson(res, 404, { ok: false, error: 'agent not found' }); return; }
          const runtime = getLocalTasks();
          releasedSessions.add(body.sessionId);
          for (let w = 0; w < 20 && !(heldStreams.get(body.sessionId)?.length); w++) {
            const cur = runtime.service.findBySessionId(body.sessionId);
            if (!cur || cur.executionStatus !== 'running') break;
            await new Promise((r) => setTimeout(r, 50));
          }
          const waiters = heldStreams.get(body.sessionId) ?? [];
          heldStreams.delete(body.sessionId);
          for (const release of waiters) release('completed');
          for (let i = 0; i < 80; i++) {
            const drained = heldStreams.get(body.sessionId) ?? [];
            if (drained.length) {
              heldStreams.delete(body.sessionId);
              for (const r of drained) r('completed');
            }
            const cur = runtime.service.findBySessionId(body.sessionId);
            const lastDlv = cur?.deliveries?.slice(-1)?.[0];
            if (cur && cur.executionStatus !== 'running' && lastDlv && lastDlv.state !== 'sending') break;
            await new Promise((r) => setTimeout(r, 50));
          }
          if (runtime.service.findBySessionId(body.sessionId)?.executionStatus === 'running') {
            await runtime.runner.observe(agent.session, { seq: Number(agent.session.seq ?? 0) + 100, type: 'turn/end', data: { reason: body.reason ?? 'completed' } });
          }
          await new Promise((r) => setTimeout(r, 100));
          sendJson(res, 200, {
            ok: true,
            usedRealStream: waiters.length > 0,
            sessionTail: agent.session.snapshotEvents().slice(-6).map((e) => ({ seq: e.seq, type: e.type, data: e.type === 'turn/end' ? e.data : undefined })),
            localTasks: runtime.service.queryTask(),
          });
          return;
        }
        if (u.pathname === '/__lt_probe/verify-llm-budget' && req.method === 'POST') {
          const runtime = getLocalTasks();
          const scratch = await runtime.service.submitTask({
            trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: '123456', userId: '123456' },
            source: { botId: 'b', channel: 'private', conversationId: '123456', messageId: 'm-budget-' + Date.now() },
            text: '额度边界测试',
            workspaceId: 'w',
          });
          if (!scratch.ok) { sendJson(res, 400, scratch); return; }
          if (scratch.task.executionStatus !== 'running') {
            const promoted = await runtime.service.promoteNext();
            if (!promoted.ok || promoted.task?.taskId !== scratch.task.taskId) {
              sendJson(res, 409, { ok: false, error: 'promote failed', promoted });
              return;
            }
          }
          const scSession = await ctx.sessionController.create({ cwd: config.wsDir, agentPreset: 'local-task' });
          await runtime.service.attachSession({ taskId: scratch.task.taskId, sessionId: scSession.sessionId, requestId: 'req-budget-' + Date.now() });
          let blocked31 = false;
          let blockedCode = '';
          let upstreamCount = 0;
          for (let i = 1; i <= 31; i++) {
            try {
              for await (const _ of ctx.waterfall(null, 'llm/stream', { sessionId: scSession.sessionId, _probeDirect: true }, async function* () { upstreamCount += 1; yield i; })) {}
            } catch (err) {
              blocked31 = true;
              blockedCode = err?.code || err?.message || 'err';
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 80));
          sendJson(res, 200, {
            ok: true,
            blocked31,
            blockedCode,
            upstreamCount,
            scratchStatus: runtime.service.queryTask({ taskId: scratch.task.taskId }).task?.executionStatus,
          });
          return;
        }
        if (u.pathname === '/__lt_probe/verify-normal-preset' && req.method === 'POST') {
          // 1) 验证 qq-chat-v2 仍由 qq-tool-restrict 保护（不含 read / write，避免本机能力误泄进聊天）
          const qqCreated = await ctx.sessionController.create({ cwd: config.wsDir, agentPreset: 'qq-chat-v2' });
          const qqAgent = ctx.agents.get(qqCreated.sessionId);
          const qqSchemas = (ctx.tools.schemas(qqAgent) ?? []).map((t) => t.name).sort();
          // 2) 验证非 local-task 的普通 DSH coding preset（或 fs/write-intent 对普通 preset）未被 local-task-gate 改写成 createIfAbsent
          const presets = await ctx.agentPresets.list();
          const normalPresetDef = presets.find((p) => p.id !== 'local-task' && p.id !== 'qq-chat-v2' && !p.broken);
          let normalOverwriteOk = null;
          let normalPresetUsed = null;
          if (normalPresetDef) {
            normalPresetUsed = normalPresetDef.id;
            const normCreated = await ctx.sessionController.create({ cwd: config.wsDir, agentPreset: normalPresetDef.id });
            const normAgent = ctx.agents.get(normCreated.sessionId);
            const pipeline = new ToolExecutionPipeline(normAgent.ctx);
            const runTool = async (name, args) => {
              const ac = new AbortController();
              const prepared = await pipeline.prepare({ callId: 'n-' + Math.random().toString(36).slice(2), name, arguments: args, agent: normAgent, signal: ac.signal });
              if (prepared.kind !== 'dispatch') return await pipeline.complete(prepared.exec, prepared);
              const out = await pipeline.dispatch(prepared.exec);
              return await pipeline.complete(prepared.exec, out);
            };
            const r = await runTool('read', { file_path: 'normal.txt' });
            const w = await runTool('write', { file_path: 'normal.txt', content: 'NORMAL_V2' });
            normalOverwriteOk = !r.isError && !w.isError;
          } else {
            // 若精简 desktop profile 只装了 qq-chat-v2 + local-task，则在宿主 ctx 验证 fs/write-intent 对非 local-task 仍保持透传 undefined
            const intent = await ctx.waterfall('fs/write-intent', { path: path.join(config.wsDir, 'normal.txt') }, { agent: qqAgent }, () => 'passthrough');
            normalOverwriteOk = intent === 'passthrough';
          }
          sendJson(res, 200, {
            ok: true,
            qqPreset: ctx.agentPresets.composedPreset(qqAgent.ctx),
            qqSchemas,
            normalPresetUsed,
            normalOverwriteOk,
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'unknown probe path' });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error?.message ?? String(error), stack: error?.stack });
      }
    },
  });
}
`);

  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const existingPatch = yaml.load(fs.readFileSync(patchPath, 'utf8')) ?? [];
  existingPatch.push({ insert: [{ id: 'lt-isolated-probe', name: './lt-probe.mjs', config: { wsDir, outsideDir } }] });
  fs.writeFileSync(patchPath, yaml.dump(existingPatch, { lineWidth: 120 }), 'utf8');

  // 3. 启动真实 DeepSeek Harness App 宿主进程
  const hostLogs = [];
  hostProc = spawn(
    EXECUTABLE,
    [
      '--import', pathToFileURL(guardFile).href,
      HOST_ENTRY,
      path.join(runtimeDir, 'app.asar', 'dsh'),
      profileDir,
      path.join(tmpBase, 'primary-runtime'),
    ],
    {
      env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  hostProc.stdout.on('data', (d) => hostLogs.push(d.toString()));
  hostProc.stderr.on('data', (d) => hostLogs.push(d.toString()));

  const readyMsg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSH Host 启动超时:\n${hostLogs.join('')}`)), 45000);
    hostProc.on('message', (msg) => {
      if (msg?.type === 'ready') { clearTimeout(timer); resolve(msg); }
      else if (msg?.type === 'fatal') { clearTimeout(timer); reject(new Error(`DSH Host fatal: ${msg.message}\n${msg.diagnostic || ''}`)); }
    });
    hostProc.once('exit', (code, sig) => {
      clearTimeout(timer);
      reject(new Error(`DSH Host 提前退出 code=${code} sig=${sig}:\n${hostLogs.join('')}`));
    });
  });

  const readyUrl = new URL(readyMsg.url);
  const hostOrigin = readyUrl.origin;

  // 通过 launchToken 换取真实 DSH Web Cookie，验证 /dsh-surfcore/api/local-tasks 与 health。
  const authRes = await fetch(readyMsg.url, { redirect: 'manual' });
  const setCookie = authRes.headers.getSetCookie?.() ?? (authRes.headers.get('set-cookie') ? [authRes.headers.get('set-cookie')] : []);
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieHeader.length > 0, '真实 Host 必须签发认证 Cookie');

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { cookie: cookieHeader, ...(opts.headers ?? {}) } });
    const raw = await res.text();
    try {
      return { status: res.status, data: JSON.parse(raw) };
    } catch (error) {
      throw new Error(`HTTP ${res.status} non-JSON from ${url}: ${raw.slice(0, 300)} (err=${error.message})\nHostLogs:\n${hostLogs.join('').slice(-2000)}`);
    }
  }

  const healthRes = await fetchJson(`${hostOrigin}/dsh-surfcore/health`);
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.data.ok, true);
  assert.equal(healthRes.data.name, 'surfcore');
  console.log('PASS 真实 DSH Host 启动且 SurfCore 健康检查通过:', hostOrigin);

  // 确认 discovery 文件与 Web 设置页接口
  const discoveryFile = path.join(dshHome, 'surfcore', 'local-task', 'qq.json');
  assert.equal(fs.existsSync(discoveryFile), true, '真实 Host 必须写出 local-task/qq.json');
  const uiListRes = await fetchJson(`${hostOrigin}/dsh-surfcore/api/local-tasks`);
  assert.equal(uiListRes.status, 200);
  assert.equal(uiListRes.data.ok, true);
  assert.equal(uiListRes.data.presetId, 'local-task');

  // Check 1 (Blocking Item 1): preset 装配与零 leakedServices
  const presetsInfo = (await fetchJson(`${hostOrigin}/__lt_probe/presets`)).data;
  assert.equal(presetsInfo.ok, true);
  const ltDef = presetsInfo.list.find((p) => p.id === 'local-task');
  const qqDef = presetsInfo.list.find((p) => p.id === 'qq-chat-v2');
  assert.ok(ltDef && ltDef.broken == null, `local-task 预设必须无 broken 装配成功：${JSON.stringify(ltDef)}`);
  assert.ok(qqDef && qqDef.broken == null, `qq-chat-v2 预设必须无 broken 装配成功：${JSON.stringify(qqDef)}`);
  assert.equal(presetsInfo.localTaskGateLive, true, 'taskGateIsLive(local-task) 在真实 Host 中必须为 true');
  console.log('PASS Blocking-1 真实 dsh-agent-preset-registry 挂载 local-task 与 qq-chat-v2 无报错且 gate 在册');

  // Check 3 (Blocking Item 2a): 真实 src/bridge.js 私聊「本机任务」→ 真实 Host → 存储域持久化 + FIFO 队列 + 取消
  await sendPrivate(1001, '本机任务：列出目录并新建 report.md，不允许覆盖已有文件');
  // 等待真实 Host 完成 submit + createSession + verifySurface
  let list1;
  for (let i = 0; i < 40; i++) {
    list1 = (await fetchJson(`${hostOrigin}/dsh-surfcore/api/local-tasks`)).data;
    if (list1.items?.[0]?.sessionId) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(list1.items.length, 1, `应有 1 条任务，实际: ${JSON.stringify(list1)} sent=${JSON.stringify(extractSentTexts(0, 0))}`);
  const t1 = list1.items[0];
  assert.equal(t1.status, 'running', `t1 应处于 running，实际: ${JSON.stringify(t1)}`);
  assert.ok(t1.sessionId, 'Host 必须为 t1 创建并绑定真实 DSH sessionId');
  assert.equal(list1.activeTaskId, t1.taskId);

  // 第 2 条任务入队 → FIFO queued，不抢占并发 1 席位
  await sendPrivate(1002, '本机任务：统计 docs 文件数');
  const list2 = (await fetchJson(`${hostOrigin}/dsh-surfcore/api/local-tasks`)).data;
  assert.equal(list2.items.length, 2);
  const t2 = list2.items.find((i) => i.taskId !== t1.taskId);
  assert.equal(t2.status, 'queued');
  assert.equal(list2.activeTaskId, t1.taskId);

  // 查询「本机任务列表」与取消「取消本机任务 t2」
  const httpBeforeQuery = bridge.calls.http.length;
  const sentBeforeQuery = bridge.calls.sent.length;
  await sendPrivate(1003, '本机任务列表');
  assert.ok(extractSentTexts(httpBeforeQuery, sentBeforeQuery).some((s) => s.includes(t1.taskId) && s.includes(t2.taskId)));

  await sendPrivate(1004, `取消本机任务 ${t2.taskId}`);
  const list3 = (await fetchJson(`${hostOrigin}/dsh-surfcore/api/local-tasks`)).data;
  assert.equal(list3.items.find((i) => i.taskId === t2.taskId).status, 'cancelled');
  assert.equal(list3.activeTaskId, t1.taskId);
  console.log('PASS Blocking-2a 真实 Bridge ↔ 真实 Host local-task-api 提交/FIFO排队/列表/取消链路通过');

  // Check 4 (Blocking Item 2b): 在真实 local-task 会话里执行真实 ToolExecutionPipeline + createIfAbsent + 工作区外拒绝 + llm/stream 额度 + leakedServices
  const verifyRes = (await fetchJson(`${hostOrigin}/__lt_probe/verify-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: t1.sessionId }),
  })).data;
  assert.equal(verifyRes.ok, true, JSON.stringify(verifyRes));
  assert.equal(verifyRes.presetId, 'local-task');
  assert.deepEqual(verifyRes.schemaNames, ['read', 'write'], 'local-task 会话必须且只能暴露 read 与 write');
  assert.equal(verifyRes.readInside.isError, false, JSON.stringify(verifyRes.readInside));
  assert.equal(verifyRes.readOutside.isError, true, '工作区外 read 必须被真实 local-task-gate 拒绝');
  assert.equal(verifyRes.createFresh.isError, false, JSON.stringify(verifyRes.createFresh));
  assert.equal(fs.readFileSync(path.join(wsDir, 'report.md'), 'utf8'), '# Report\nOK');
  assert.equal(verifyRes.readExisting.isError, false);
  assert.equal(verifyRes.overwriteExisting.isError, true, '先 read 过已有文件再 write 仍必须被真实 Host createIfAbsent 拒绝');
  assert.equal(fs.readFileSync(path.join(wsDir, 'existing.txt'), 'utf8'), 'ORIGINAL_HOST_CONTENT');
  assert.equal(fs.statSync(path.join(wsDir, 'existing.txt')).ino, existingStatBefore.ino);
  assert.equal(verifyRes.streamExecs, 1);

  for (const comp of verifyRes.compositionsAfterSession) {
    assert.deepEqual(comp.leakedServices, [], `预设 ${comp.id} 不得向根作用域泄漏任何 service`);
  }
  console.log('PASS Blocking-1&2b 真实 DSH 会话工具面/工作区围栏/createIfAbsent/零 leakedServices 验证通过');

  // Check 5 (Blocking Item 2c): 真实 turn/end → deliver → 真实 bridge.js /api/notify/owner → sendPrivateMessage + session.v4.jsonl.zstd
  const sentBeforeDeliver = bridge.calls.sent.length;
  const endRes = (await fetchJson(`${hostOrigin}/__lt_probe/emit-turn-end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: t1.sessionId, reason: 'completed' }),
  })).data;
  assert.equal(endRes.ok, true);
  const settledT1 = endRes.localTasks.tasks.find((x) => x.taskId === t1.taskId);
  assert.equal(settledT1.executionStatus, 'succeeded', `endRes=${JSON.stringify({ usedRealStream: endRes.usedRealStream, sessionTail: endRes.sessionTail, settledT1 })}`);
  assert.equal(settledT1.deliveries.slice(-1)[0]?.state, 'delivered', `真实 Host 必须成功通过 bridge /api/notify/owner 回传：${JSON.stringify({ deliveries: settledT1.deliveries, consolePort, consoleReqs, sent: bridge.calls.sent.slice(sentBeforeDeliver) })}`);
  const deliveredMsgs = bridge.calls.sent.slice(sentBeforeDeliver).filter((m) => String(m.text ?? '').includes(t1.taskId));
  assert.ok(deliveredMsgs.length >= 1, '真实 bridge 必须把任务结果发往主人私聊');

  // Check 5b: t1 归还并发席位后，验证真实 Host llm/stream 第 31 次额度阻断
  const budgetRes = (await fetchJson(`${hostOrigin}/__lt_probe/verify-llm-budget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })).data;
  assert.equal(budgetRes.ok, true, JSON.stringify(budgetRes));
  assert.equal(budgetRes.blocked31, true, '真实 Host llm/stream 第 31 次调用必须在进入上游前被阻断');
  assert.equal(budgetRes.upstreamCount, 30);
  assert.equal(budgetRes.scratchStatus, 'failed');
  console.log('PASS llm/stream 真实 Host 第 31 次模型调用前阻断与失败收敛验证通过');

  // 补发接口：已送达任务不重跑工具、不新建会话
  const httpBeforeRedeliver = bridge.calls.http.length;
  const sentBeforeRedeliver = bridge.calls.sent.length;
  await sendPrivate(1005, `补发本机任务 ${t1.taskId}`);
  assert.ok(extractSentTexts(httpBeforeRedeliver, sentBeforeRedeliver).some((s) => s.includes('已确认送达') || s.includes(t1.taskId)));

  // 确认真实 DSH 会话日志 .jsonl.zstd 已落盘到隔离 dshHome/sessions
  const findZstd = (dir) => {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...findZstd(full));
      else if (ent.name === 'session.v4.jsonl.zstd') out.push(full);
    }
    return out;
  };
  const sessionLogs = fs.existsSync(path.join(dshHome, 'sessions')) ? findZstd(path.join(dshHome, 'sessions')) : [];
  assert.ok(sessionLogs.length >= 1, '真实 DSH 必须在隔离目录写出 session.v4.jsonl.zstd');
  console.log('PASS Blocking-2c 真实 turn/end → deliver → Bridge /api/notify/owner → OneBot 回执与 session.v4.jsonl.zstd 落盘验证通过');

  // Check 6 (Blocking Item 2d): 普通 qq-chat-v2 会话 + 普通 QQ 消息 + Memory V2 路由无回归
  const normRes = (await fetchJson(`${hostOrigin}/__lt_probe/verify-normal-preset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })).data;
  assert.equal(normRes.ok, true);
  assert.equal(normRes.qqPreset, 'qq-chat-v2');
  assert.ok(!normRes.qqSchemas.includes('read') && !normRes.qqSchemas.includes('write'), 'qq-chat-v2 不得出现 read/write');
  assert.equal(normRes.normalOverwriteOk, true, `非 local-task 会话不得被 local-task-gate 影响: ${JSON.stringify(normRes)}`);
  if (normRes.normalPresetUsed) {
    assert.equal(fs.readFileSync(path.join(wsDir, 'normal.txt'), 'utf8'), 'NORMAL_V2');
  }

  await sendPrivate(1006, '你好，今天天气怎么样');
  const v2State = bridge.getSocialV2State('private:123456');
  const v2Texts = [...(v2State?.unread ?? []), ...(v2State?.recentMessages ?? [])];
  assert.ok(v2Texts.some((m) => String(m.text ?? m.content ?? '').includes('你好，今天天气怎么样')), `reserved2 下普通 QQ 消息必须进入 socialV2 消息箱: ${JSON.stringify(v2Texts)}`);

  const nativeBefore = bridge.calls.nativeReplies.length;
  bridge.setMode('chat');
  bridge.cfg.sendDelayMs = 0;
  await sendPrivate(1007, '在吗，顺便聊聊');
  assert.ok(bridge.calls.nativeReplies.length > nativeBefore, '普通 QQ 聊天消息必须继续进入原聊天链路，不被本机任务拦截');
  console.log('PASS Blocking-2d 普通 qq-chat-v2 预设与普通 QQ 聊天 / Memory V2 无回归验证通过');

  // Check 7: 优雅停机（无孤儿进程）
  const exitPromise = new Promise((resolve) => hostProc.once('exit', (code, signal) => resolve({ code, signal })));
  hostProc.send({ type: 'shutdown' });
  const exitResult = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Host shutdown timeout')), 20000)),
  ]);
  assert.equal(exitResult.code, 0, `DSH Host 停机退出码应为 0：${JSON.stringify(exitResult)}`);
  hostProc = null;
  console.log('PASS 隔离真实 DSH Host + 真实 Bridge 全链路验收完成并优雅停机');
} finally {
  if (hostProc && !hostProc.killed) {
    try { hostProc.send({ type: 'shutdown' }); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { hostProc.kill('SIGKILL'); } catch {}
  }
  if (consoleServer) await new Promise((resolve) => consoleServer.close(resolve));
  if (bridge) await bridge.close();
  for (const snap of snapshots) {
    if (snap.existed) fs.writeFileSync(snap.full, snap.content);
    else if (fs.existsSync(snap.full)) fs.rmSync(snap.full, { force: true });
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}
