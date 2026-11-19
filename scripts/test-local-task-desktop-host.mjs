// Isolated real DSH Desktop + Chrome DevTools MCP + CUA bundle + Owner QQ confirmation end-to-end test.
// Spawns real DeepSeek Harness App host (ELECTRON_RUN_AS_NODE=1, non-loopback network blocked) + real src/bridge.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-desktop-host-'));
const runtimeDir = path.join(tmpBase, 'runtime');
const homeDir = path.join(tmpBase, 'home');
const dshHome = path.join(homeDir, '.dsh');
const qqRoot = path.join(tmpBase, 'qq-fixture');
const wsDir = path.join(tmpBase, 'workspace');
const guardFile = path.join(tmpBase, 'guard.mjs');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(dshHome, { recursive: true });
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
fs.symlinkSync(path.join(RESOURCES, 'app.asar'), path.join(runtimeDir, 'app.asar'));
fs.symlinkSync(path.join(RESOURCES, 'app.asar.unpacked'), path.join(runtimeDir, 'app.asar.unpacked'), 'dir');
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '// fixture');

// Block non-loopback networking while allowing loopback IPC/HTTP/MCP.
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
  const consoleToken = 'desktop-host-console-token-0123456789abcdef';
  bridge = await bridgeHarness({
    config: {
      consoleToken,
      consolePort: 0,
      ownerQQ: 123456,
      snowluma: { httpUrl: 'http://127.0.0.1:19999', accessToken: 'fixture-onebot-token' },
      allow: { private: ['123456'], groups: ['999'] },
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

  consoleServer = bridge.startConsoleServer();
  if (!consoleServer.listening) await new Promise((resolve) => consoleServer.once('listening', resolve));
  const consolePort = consoleServer.address().port;
  fs.writeFileSync(path.join(qqRoot, 'config.json'), JSON.stringify({
    ownerQQ: '123456',
    consolePort,
    consoleToken,
    allow: { private: ['123456'], groups: ['999'] },
  }, null, 2));

  fs.mkdirSync(path.join(dshHome, 'surfcore'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'surfcore', 'config.json'), JSON.stringify({
    version: 1,
    platforms: { start: { qq: false, bili: false } },
    updates: { enabled: false, checkOnStart: false },
    localTask: { mode: 'desktop', chatHandoff: true },
  }, null, 2));

  const realNpmCache = path.join(os.homedir(), '.npm');
  const cleanEnv = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    delete cleanEnv[k];
  }
  const childEnv = {
    ...cleanEnv,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NPM_CONFIG_CACHE: realNpmCache,
    npm_config_cache: realNpmCache,
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

  const hostModuleUrl = pathToFileURL(path.join(REPO_ROOT, 'plugins', 'surfcore', 'lib', 'local-task-host.mjs')).href;
  const scopeModuleUrl = pathToFileURL(path.join(runtimeDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js')).href;
  const probeFile = path.join(profileDir, 'lt-desktop-probe.mjs');

  fs.writeFileSync(probeFile, `
import path from 'node:path';

export const name = 'lt-desktop-probe';
export const inject = ['agentPresets', 'agents', 'tools', 'sessionController', 'webServer'];

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
  const { getLocalTasks } = await import(${JSON.stringify(hostModuleUrl)});
  const { scopeTarget } = await import(${JSON.stringify(scopeModuleUrl)});

  const heldStreams = new Map();
  const releasedSessions = new Set();
  ctx.on('llm/stream', (options, next) => {
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
      yield { type: 'text-delta', index: 0, text: '已在隔离浏览器查完 Example Domain 首页。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已在隔离浏览器查完 Example Domain 首页。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  });

  ctx.webServer.register({
    kind: 'prefix',
    path: '/__lt_desktop_probe',
    handler: async (req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/__lt_desktop_probe/tools-snapshot' && req.method === 'POST') {
          const body = await readJson(req);
          const ownedAgent = ctx.agents.get(body.sessionId);
          const qqCreated = await ctx.sessionController.create({ cwd: config.wsDir, agentPreset: 'qq-chat-v2' });
          const qqAgent = ctx.agents.get(qqCreated.sessionId);
          const manualCreated = await ctx.sessionController.create({ cwd: config.wsDir, agentPreset: 'ptc' });
          const manualAgent = ctx.agents.get(manualCreated.sessionId);
          const globalSchemas = (ctx.tools.schemas(undefined) ?? []).map((t) => t.name).sort();
          const ownedDefs = (ctx.tools.definitions(ownedAgent) ?? []).map((t) => t.name).sort();
          const ownedSchemas = (ctx.tools.schemas(ownedAgent) ?? []).map((t) => t.name).sort();
          const manualDefs = (ctx.tools.definitions(manualAgent) ?? []).map((t) => t.name).sort();
          const qqSchemas = (ctx.tools.schemas(qqAgent) ?? []).map((t) => t.name).sort();
          const guardChecks = {
            ownedChrome: ctx.tools.checkGuards({ name: 'mcp__surfcore-chrome__navigate_page', agent: ownedAgent, arguments: {} }) ?? null,
            ownedPersonalConnectorChrome: ctx.tools.checkGuards({ name: 'mcp__chrome-devtools__navigate_page', agent: ownedAgent, arguments: {} }) ?? null,
            ownedCua: ctx.tools.checkGuards({ name: 'cua', agent: ownedAgent, arguments: {} }) ?? null,
            ownedQqSend: ctx.tools.checkGuards({ name: 'mcp__snowluma__qq_send_private_message', agent: ownedAgent, arguments: {} }) ?? null,
            ownedSubagent: ctx.tools.checkGuards({ name: 'subagent', agent: ownedAgent, arguments: {} }) ?? null,
            manualSubagent: ctx.tools.checkGuards({ name: 'subagent', agent: manualAgent, arguments: {} }) ?? null,
          };
          // Test manual session passthrough without blocking on Web UI: surfcore must leave pendingInteractions empty
          // and pass through to dsh-web-app (which aborts cleanly on manualAc.abort()).
          const rt = getLocalTasks();
          const pendingBeforeManual = rt.interactions?.listPending?.()?.length ?? 0;
          const manualAc = new AbortController();
          setTimeout(() => manualAc.abort(), 30);
          let manualPassthrough = false;
          try {
            await ctx.waterfall(
              scopeTarget(manualAgent, manualAgent),
              'user-questions/request',
              { agent: manualAgent, signal: manualAc.signal, questions: [{ id: 'probe-manual', question: 'Manual?', options: [{ label: 'Allow' }] }] },
              () => { manualPassthrough = true; return Promise.resolve({ answers: [{ id: 'probe-manual', selected: ['Allow'] }] }); },
            );
          } catch {
            manualPassthrough = true;
          }
          const pendingAfterManual = rt.interactions?.listPending?.()?.length ?? 0;
          sendJson(res, 200, {
            ok: true,
            ownedPreset: ctx.agentPresets.composedPreset(ownedAgent.ctx),
            globalSchemas,
            ownedDefs,
            ownedSchemas,
            manualDefs,
            qqSchemas,
            guardChecks,
            manualSessionId: manualCreated.sessionId,
            manualPassthrough: manualPassthrough && pendingBeforeManual === 0 && pendingAfterManual === 0,
          });
          return;
        }
        if (u.pathname === '/__lt_desktop_probe/ask-owned-cua' && req.method === 'POST') {
          const body = await readJson(req);
          const agent = ctx.agents.get(body.sessionId);
          const answer = await ctx.waterfall(
            scopeTarget(agent, agent),
            'user-questions/request',
            {
              agent,
              questions: [{
                id: 'cua-app-access',
                question: 'Allow computer use to control Safari?',
                detail: 'App consent test',
                options: [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }],
                intent: {
                  kind: 'approval',
                  approve: 'Allow for this session',
                  reject: 'Deny',
                  always: 'Always allow',
                  subject: { name: 'Safari' },
                },
              }],
            },
            () => Promise.reject(new Error('NO_PROVIDER')),
          );
          sendJson(res, 200, { ok: true, answer });
          return;
        }
        if (u.pathname === '/__lt_desktop_probe/release' && req.method === 'POST') {
          const body = await readJson(req);
          const sid = body.sessionId;
          releasedSessions.add(sid);
          for (let w = 0; w < 20 && !(heldStreams.get(sid)?.length); w++) {
            await new Promise((r) => setTimeout(r, 50));
          }
          const waiters = heldStreams.get(sid) ?? [];
          heldStreams.delete(sid);
          for (const release of waiters) release('completed');
          for (let i = 0; i < 60; i++) {
            const cur = getLocalTasks().service?.findBySessionId?.(sid);
            const last = cur?.deliveries?.slice(-1)?.[0];
            if (cur && cur.executionStatus !== 'running' && last && last.state !== 'sending') break;
            await new Promise((r) => setTimeout(r, 50));
          }
          sendJson(res, 200, { ok: true, tasks: getLocalTasks().service?.queryTask?.() });
          return;
        }
        sendJson(res, 404, { ok: false });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error?.message || String(error), stack: error?.stack });
      }
    },
  });
}
`);

  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const existingPatch = yaml.load(fs.readFileSync(patchPath, 'utf8')) ?? [];
  existingPatch.push({ insert: [{ id: 'lt-desktop-probe', name: './lt-desktop-probe.mjs', config: { wsDir } }] });
  fs.writeFileSync(patchPath, yaml.dump(existingPatch, { lineWidth: 120 }), 'utf8');

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

  const watchdog = setTimeout(() => {
    try { hostProc?.kill('SIGKILL'); } catch {}
    console.error('[desktop-host WATCHDOG TIMEOUT]\nHostLogs:\n' + hostLogs.join('').slice(-3000));
    process.exit(1);
  }, 60000);
  watchdog.unref();

  const readyMsg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSH Host timeout:\n${hostLogs.join('')}`)), 45000);
    hostProc.on('message', (msg) => {
      if (msg?.type === 'ready') { clearTimeout(timer); resolve(msg); }
      else if (msg?.type === 'fatal') { clearTimeout(timer); reject(new Error(`DSH Host fatal: ${msg.message}\n${msg.diagnostic || ''}`)); }
    });
    hostProc.once('exit', (code, sig) => {
      clearTimeout(timer);
      reject(new Error(`DSH Host exit early code=${code} sig=${sig}:\n${hostLogs.join('')}`));
    });
  });

  const hostOrigin = new URL(readyMsg.url).origin;
  console.log('[desktop-host] Host ready at', hostOrigin);
  const authRes = await fetch(readyMsg.url, { redirect: 'manual' });
  const setCookie = authRes.headers.getSetCookie?.() ?? (authRes.headers.get('set-cookie') ? [authRes.headers.get('set-cookie')] : []);
  const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookieHeader.length > 0);

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { cookie: cookieHeader, ...(opts.headers ?? {}) } });
    return { status: res.status, data: JSON.parse(await res.text()) };
  }

  // Wait briefly for stdio MCP client (mcp-chrome-devtools) to finish tool discovery if async
  await sendPrivate(2001, '本机任务：用浏览器查 example.com 并总结');
  console.log('[desktop-host] submitted task via private chat');
  let listRes;
  for (let i = 0; i < 40; i++) {
    listRes = (await fetchJson(`${hostOrigin}/dsh-surfcore/api/local-tasks`)).data;
    if (listRes.items?.[0]?.sessionId) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const t1 = listRes.items[0];
  assert.equal(t1.mode, 'desktop', JSON.stringify(t1));
  assert.ok(t1.sessionId);
  console.log('[desktop-host] created session', t1.sessionId);

  // Give MCP stdio handshake a brief moment if needed until chrome-devtools registers globally
  let snap;
  for (let i = 0; i < 20; i++) {
    snap = (await fetchJson(`${hostOrigin}/__lt_desktop_probe/tools-snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: t1.sessionId }),
    })).data;
    if (snap.globalSchemas?.some((n) => n.startsWith('mcp__surfcore-chrome__'))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('[desktop-host] tools-snapshot ok=', snap.ok, 'chromeCount=', snap.globalSchemas?.filter((n) => n.startsWith('mcp__surfcore-chrome__')).length);
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.equal(snap.ownedPreset, 'ptc');

  // Verify Chrome DevTools MCP & CUA exist on owned PTC, forbidden tools absent on owned PTC,
  // qq-chat-v2 sees zero chrome-devtools/cua/bash/read/write, and manual PTC is untouched!
  assert.ok(snap.ownedDefs.includes('cua'), `owned ptc must expose cua: ${snap.ownedDefs.join(',')}`);
  assert.ok(snap.ownedDefs.includes('mcp__surfcore-chrome__navigate_page'), `owned ptc must expose surfcore-chrome MCP: ${snap.ownedDefs.join(',')}`);
  assert.ok(!snap.ownedDefs.includes('subagent'), 'owned ptc must forbid subagent');
  assert.ok(!snap.ownedDefs.includes('schedule_create'), 'owned ptc must forbid schedule_create');
  assert.ok(!snap.ownedDefs.some((n) => n.startsWith('mcp__snowluma')), 'owned ptc must forbid QQ MCP');

  assert.ok(!snap.qqSchemas.some((n) => n.startsWith('mcp__surfcore-chrome__')), 'qq-chat-v2 must NEVER expose surfcore-chrome MCP');
  assert.ok(!snap.qqSchemas.includes('cua') && !snap.qqSchemas.includes('bash') && !snap.qqSchemas.includes('read'), 'qq-chat-v2 stays isolated');

  assert.ok(snap.manualDefs.includes('subagent'), 'manual ptc keeps subagent untouched');
  assert.equal(snap.manualPassthrough, true, 'manual ptc user-questions must pass through untouched');
  assert.equal(snap.guardChecks.ownedChrome, null);
  assert.equal(typeof snap.guardChecks.ownedPersonalConnectorChrome?.reason, 'string');
  assert.equal(snap.guardChecks.ownedCua, null);
  assert.equal(typeof snap.guardChecks.ownedQqSend?.reason, 'string');
  assert.equal(typeof snap.guardChecks.ownedSubagent?.reason, 'string');
  assert.equal(snap.guardChecks.manualSubagent, null);
  console.log('PASS Real DSH Desktop profile: CUA + isolated Chrome MCP mounted, qq-chat-v2 & manual PTC strictly isolated');

  // Verify Native capabilities gating in real bridge.js
  assert.equal(bridge.getNativeQQCapabilities('private:123456').localTask.enabled, true);
  assert.equal(bridge.getNativeQQCapabilities('group:999').localTask.enabled, false);
  console.log('PASS Native QQ capabilities expose localTask ONLY to Owner private chat');

  // Verify real DSH user-questions/request waterfall -> Owner QQ notify -> `通过 t<hex>` reply!
  const sentBeforeAsk = bridge.calls.sent.length;
  const askPromise = fetchJson(`${hostOrigin}/__lt_desktop_probe/ask-owned-cua`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: t1.sessionId }),
  });
  let interId = null;
  for (let i = 0; i < 30; i++) {
    const newMsgs = bridge.calls.sent.slice(sentBeforeAsk).map((m) => String(m.text ?? ''));
    const hit = newMsgs.map((s) => /\b(t[a-f0-9]{7})\b/.exec(s)?.[1]).find(Boolean);
    if (hit) { interId = hit; break; }
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.ok(interId, `Owner QQ must receive t<hex> approval prompt: ${JSON.stringify(bridge.calls.sent.slice(sentBeforeAsk))}`);
  await sendPrivate(2002, `通过 ${interId}`);
  const askResult = await askPromise;
  assert.equal(askResult.data.ok, true, JSON.stringify(askResult));
  assert.deepEqual(askResult.data.answer, { answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] });
  console.log('PASS Real DSH user-questions/request bridged to Owner QQ and approved via 通过', interId);

  // Release desktop task turn -> deliver grounded assistant resultSummary -> recentMessages updated
  const relRes = (await fetchJson(`${hostOrigin}/__lt_desktop_probe/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: t1.sessionId }),
  })).data;
  const settled = relRes.tasks.tasks.find((t) => t.taskId === t1.taskId);
  assert.equal(settled.executionStatus, 'succeeded');
  assert.equal(settled.resultSummary, '已在隔离浏览器查完 Example Domain 首页。');
  assert.equal(settled.deliveries.slice(-1)[0]?.state, 'delivered');
  const recent = bridge.getSocialV2State('private:123456')?.recentMessages ?? [];
  assert.ok(recent.some((m) => String(m.text ?? '').includes('Example Domain')), 'confirmed result syncs to Owner recentMessages');
  console.log('PASS Desktop task grounded resultSummary delivered & synced to QQ context');

  // Verify real bridge.js /api/notify/owner path audit + base64 image segment delivery + fail-closed blocking
  const notifyUrl = `http://127.0.0.1:${consolePort}/api/notify/owner`;
  const authHeaders = { 'content-type': 'application/json', 'x-console-token': consoleToken };
  const validShot = path.join(wsDir, 'host-shot.png');
  fs.writeFileSync(validShot, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
    0, 0, 0, 12, 73, 68, 65, 84, 8, 0xd7, 99, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0,
    0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82,
  ]));
  const sentBeforeShot = bridge.calls.sent.length;
  const okNotify = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: `任务 task-shot-1：已完成\n结果：已保存截图到 ${validShot}`,
      taskResult: { taskId: 'task-shot-1', status: 'succeeded', images: [validShot] },
    }),
  });
  const okJson = await okNotify.json();
  assert.equal(okNotify.status, 200, JSON.stringify(okJson));
  assert.equal(okJson.ok, true);
  assert.equal(okJson.imageCount, 1);
  const lastSent = bridge.calls.sent[sentBeforeShot];
  const sentSegments = Array.isArray(lastSent?.text) ? lastSent.text : [];
  assert.ok(sentSegments.length === 2, `bridge must dispatch text + image segments to sendPrivateMessage: ${JSON.stringify(lastSent)}`);
  assert.ok(sentSegments.some((s) => s.type === 'text' && String(s.data?.text ?? '').includes(validShot)));
  assert.ok(sentSegments.some((s) => s.type === 'image' && String(s.data?.file ?? '').startsWith('base64://')));

  // Generic notification without taskResult must still reject /Users/... paths
  const genericReject = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: `日记带路径 ${validShot}` }),
  });
  const genericJson = await genericReject.json();
  assert.equal(genericReject.status, 403);
  assert.equal(genericJson.code, 'NOTIFY_SENSITIVE');
  assert.ok(genericJson.hint);

  // Task result with secret or unsafe image path must fail closed with code + hint
  const secretReject = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: '任务 task-bad-1：token=supersecretvalue',
      taskResult: { taskId: 'task-bad-1', status: 'succeeded' },
    }),
  });
  assert.equal(secretReject.status, 403);
  assert.equal((await secretReject.json()).code, 'NOTIFY_SENSITIVE');

  const blockedImg = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: '任务 task-bad-2：已完成',
      taskResult: { taskId: 'task-bad-2', status: 'succeeded', images: [path.join(homeDir, '.ssh', 'id_rsa.png')] },
    }),
  });
  const blockedImgJson = await blockedImg.json();
  assert.equal(blockedImg.status, 403);
  assert.equal(blockedImgJson.code, 'NOTIFY_IMAGE_BLOCKED');
  assert.ok(blockedImgJson.hint);

  // Task interaction approval mentioning /Users/... workspace or Desktop path must pass through to Owner QQ,
  // while secrets or .ssh paths in interaction text must still be blocked with actionable hint.
  const sentBeforeInteraction = bridge.calls.sent.length;
  const okInteraction = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: `【需要授权 t1a2b3c4】任务 task-int-1\n工具：bash\n说明：允许写入 /Users/owner/Desktop/report.txt\n请回复：通过 t1a2b3c4 或 拒绝 t1a2b3c4`,
      taskInteraction: { id: 't1a2b3c4', kind: 'approval', taskId: 'task-int-1' },
    }),
  });
  const okInteractionJson = await okInteraction.json();
  assert.equal(okInteraction.status, 200, JSON.stringify(okInteractionJson));
  assert.equal(okInteractionJson.ok, true);
  assert.equal(bridge.calls.sent.length, sentBeforeInteraction + 1);

  const badInteraction = await fetch(notifyUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      message: '【需要授权 t1a2b3c5】任务 task-int-2\n说明：读取 /Users/owner/.ssh/id_rsa',
      taskInteraction: { id: 't1a2b3c5', kind: 'approval', taskId: 'task-int-2' },
    }),
  });
  const badInteractionJson = await badInteraction.json();
  assert.equal(badInteraction.status, 403);
  assert.equal(badInteractionJson.code, 'NOTIFY_SENSITIVE');
  assert.ok(badInteractionJson.hint && badInteractionJson.hint.includes('设置页'));
  console.log('PASS Real bridge /api/notify/owner enforces task path audit, delivers base64 image segments, and blocks unsafe paths');

  const exitPromise = new Promise((resolve) => hostProc.once('exit', (code, signal) => resolve({ code, signal })));
  hostProc.send({ type: 'shutdown' });
  const exitResult = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Host shutdown timeout')), 20000)),
  ]);
  clearTimeout(watchdog);
  assert.equal(exitResult.code, 0);
  hostProc = null;
} finally {
  if (hostProc && !hostProc.killed) {
    try { hostProc.send({ type: 'shutdown' }); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { hostProc.kill('SIGKILL'); } catch {}
  }
  if (consoleServer) consoleServer.close();
  if (bridge) await bridge.close();
  for (const snap of snapshots) {
    if (snap.existed) fs.writeFileSync(snap.full, snap.content);
    else if (fs.existsSync(snap.full)) fs.rmSync(snap.full, { force: true });
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}
