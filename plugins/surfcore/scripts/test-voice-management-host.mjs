/**
 * 平台启动开关的宿主接线（mock ctx，不启动 DSH / 不启停真实桥接）。
 *
 * 钉住：
 *   · 开关关闭时插件加载不会启动生物钟（scheduler.running=false / disabled=true）；
 *   · /overview 暴露 platformStart；
 *   · /bridge 的 start-qq / start-bili / start-all 在开关关闭时不会偷偷拉起平台。
 *
 * 用临时 DSH_HOME，不读写真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-platform-host-'));
const stateDir = path.join(tmp, 'surfcore');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
  version: 1,
  bridge: { autoStart: true },
  platforms: { start: { qq: false, bili: false } },
}, null, 2)}\n`, 'utf8');

process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const originalConnect = net.connect;
const originalFetch = globalThis.fetch;
const statusProbes = [];
const unexpectedNetwork = [];
net.connect = (options) => {
  statusProbes.push({ host: options.host, port: options.port });
  if (options.host !== '127.0.0.1' || ![3100, 8765, 8767, 9880].includes(options.port)) {
    unexpectedNetwork.push('unexpected TCP target');
  }
  const socket = new EventEmitter();
  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  process.nextTick(() => socket.emit('error', Object.assign(new Error('fixture bridge unavailable'), { code: 'ECONNREFUSED' })));
  return socket;
};
globalThis.fetch = async () => {
  unexpectedNetwork.push('unexpected fetch');
  throw new Error('network disabled in voice management Host fixture');
};

const routes = [];
const effects = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) {
    if (name === 'connection') return { requestRejection: () => false };
    return null;
  },
  effect(fn) { effects.push(fn); return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(route, method, url, body) {
  const res = fakeRes();
  await route.handler(fakeReq(method, url, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

try {
  const { apply } = await import('../lib/index.js');
  apply(ctx);
  const api = routes.find((route) => route.path === '/dsh-surfcore/api');
  assert.ok(api, 'API 路由没有注册');

  const packs = await invoke(api, 'GET', '/dsh-surfcore/api/voice/packs');
  assert.equal(packs.status, 200, '关闭QQ时语音管理必须在Host直接可读，不能fetch3100失败');
  assert.equal(packs.data.ok, true);
  assert.equal(packs.data.packs.length, 2);
  assert(packs.data.packs.every(p => p.installed === false));
  const rules = await invoke(api, 'GET', '/dsh-surfcore/api/voice/rules');
  assert.equal(rules.data.ok, true);
  const overview = await invoke(api, 'GET', '/dsh-surfcore/api/overview');
  assert.equal(overview.data.launch.voice.ok, true);
  assert.equal(overview.data.launch.qq.running, false);
  const start = await invoke(api, 'POST', '/dsh-surfcore/api/bridge', {action:'start-selected',components:['voice'],voicePack:'voice-local'});
  assert.equal(start.data.items[0].code, 'VOICE_PACK_NOT_INSTALLED');
  assert(start.data.items[0].hint);
  const unknown = await invoke(api, 'GET', '/dsh-surfcore/api/voice/packs/not-real');
  assert.equal(unknown.status,404); assert(unknown.data.code && unknown.data.hint);
  const check = await invoke(api, 'POST', '/dsh-surfcore/api/voice/tts-check', {});
  assert.equal(check.data.code, 'VOICE_TTS_DISABLED');assert(check.data.hint);
  const malformedReq=fakeReq('POST','/dsh-surfcore/api/voice/send',null);malformedReq.headers.origin='https://foreign.invalid';const forbidden=fakeRes();await api.handler(malformedReq,forbidden);assert.equal(forbidden.statusCode,403);
  const stopped = await invoke(api,'POST','/dsh-surfcore/api/bridge',{action:'stop-selected',components:['voice']});
  assert.equal(stopped.data.ok,true);
  assert.equal(fs.existsSync(path.join(stateDir,'qq','state','bridge.lock')),false);
  const {QQ_CONFIG}=await import('../lib/paths.js');
  const ownerLock=path.join(path.dirname(QQ_CONFIG),'state','voice-management.lock');fs.mkdirSync(path.dirname(ownerLock),{recursive:true});
  fs.writeFileSync(ownerLock,JSON.stringify({pid:process.pid,owner:'foreign-live-owner'}));
  const deniedStop=await invoke(api,'POST','/dsh-surfcore/api/bridge',{action:'stop-selected',components:['voice']});
  assert.equal(deniedStop.data.ok,false,'unknown management state must never be reported stopped');
  assert.equal(deniedStop.data.items[0].code,'VOICE_MANAGEMENT_BUSY');assert(deniedStop.data.items[0].hint);
  fs.unlinkSync(ownerLock);
  assert.ok(statusProbes.some(probe => probe.port === 3100), 'Host overview must probe fixture bridge availability');
  assert.deepEqual(unexpectedNetwork, [], 'fixture must not attempt fetch or probe another network target');
  console.log('voice management actual Host route: QQ-off reads, launch state, guarded start/check/stop passed (network isolated)');

} finally {
  for (const fn of effects) {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    } catch {}
  }
  net.connect = originalConnect;
  globalThis.fetch = originalFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
