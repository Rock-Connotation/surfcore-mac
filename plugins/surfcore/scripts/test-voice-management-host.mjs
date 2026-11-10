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
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const originalConnect = net.connect, originalFetch = globalThis.fetch;
net.connect = () => {
  const socket = new EventEmitter(); socket.setTimeout = () => socket; socket.destroy = () => socket;
  queueMicrotask(() => socket.emit('error', new Error('offline fixture'))); return socket;
};
globalThis.fetch = async () => { throw new Error('offline fixture'); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-platform-host-'));
const stateDir = path.join(tmp, 'surfcore');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), `${JSON.stringify({
  version: 1,
  bridge: { autoStart: true },
  platforms: { start: { qq: false, bili: false } },
}, null, 2)}\n`, 'utf8');

const qqRoot = path.join(tmp, 'qq-fixture');
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '');
fs.writeFileSync(path.join(qqRoot, 'config.json'), '{}');
process.env.SURFCORE_ROOT = qqRoot;
process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');

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
  apply(ctx);
  const api = routes.find((route) => route.path === '/dsh-surfcore/api');
  assert.ok(api, 'API 路由没有注册');

  if (fs.constants.O_NOFOLLOW) {
  const savedKey = await invoke(api, 'POST', '/dsh-surfcore/api/voice/volc-config', { provider: 'volc', apiKey: 'host-fixture-key' });
  assert.equal(savedKey.data.ok, true);
  assert(!JSON.stringify(savedKey).includes('host-fixture-key'));
  const keyStatus = await invoke(api, 'GET', '/dsh-surfcore/api/voice/volc-config');
  assert.equal(keyStatus.data.hasKey, true);
  assert(!JSON.stringify(keyStatus).includes('host-fixture-key'));
  const invalidKey = await invoke(api, 'POST', '/dsh-surfcore/api/voice/volc-config', { provider: 'volc', apiKey: 'bad' + String.fromCharCode(10) + 'key' });
  assert.equal(invalidKey.data.code, 'VOICE_VOLC_KEY_INVALID');
  assert(invalidKey.data.hint);
  }

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
  if (fs.constants.O_NOFOLLOW) {
    const beforeSelect = await invoke(api, 'GET', '/dsh-surfcore/api/config');
    const selected = await invoke(api, 'POST', '/dsh-surfcore/api/voice/volc-config', { provider: 'volc', activate: true });
    assert.equal(selected.data.ok, true); assert.equal(selected.data.route, 'cloud'); assert.equal(selected.data.ttsEnabled, true);
    assert.equal(selected.data.beforeStamp, beforeSelect.data.stamps.qq);
    const afterSelect = await invoke(api, 'GET', '/dsh-surfcore/api/config');
    assert.equal(selected.data.afterStamp, afterSelect.data.stamps.qq);
    const selectedDraft = structuredClone(beforeSelect.data.qq); selectedDraft.socialV2 ||= {}; selectedDraft.socialV2.voice ||= {};
    selectedDraft.socialV2.voice.tts = afterSelect.data.qq.socialV2.voice.tts;
    selectedDraft.socialV2.voice.enabled = true; selectedDraft.fixtureDraft = 'kept';
    const master = await invoke(api, 'POST', '/dsh-surfcore/api/config', { qq: selectedDraft, baseStamp: { ...beforeSelect.data.stamps, qq: selected.data.afterStamp } });
    assert.equal(master.data.ok, true, JSON.stringify(master.data)); assert.equal(master.data.qq.fixtureDraft, 'kept');
    const loaded = await invoke(api, 'GET', '/dsh-surfcore/api/config');
    const quota = await invoke(api, 'POST', '/dsh-surfcore/api/voice/volc-config', { monthlyQuota: 5000 });
    assert.equal(quota.data.monthlyLimit, 5000); assert.equal(quota.data.beforeStamp, loaded.data.stamps.qq);
    const refreshed = await invoke(api, 'GET', '/dsh-surfcore/api/config');
    assert.equal(quota.data.afterStamp, refreshed.data.stamps.qq);
    const draft = structuredClone(refreshed.data.qq); draft.socialV2.voice.enabled = true; draft.testDraft = 'preserved';
    const savedConfig = await invoke(api, 'POST', '/dsh-surfcore/api/config', { qq: draft, baseStamp: { ...loaded.data.stamps, qq: quota.data.afterStamp } });
    assert.equal(savedConfig.data.ok, true, JSON.stringify(savedConfig.data));
    assert.equal(savedConfig.data.qq.socialV2.voice.enabled, true); assert.equal(savedConfig.data.qq.testDraft, 'preserved');
    const savedRules = await invoke(api, 'GET', '/dsh-surfcore/api/voice/rules');
    assert.equal(savedRules.data.aiEnabled, true); assert.equal(savedRules.data.route, 'cloud');
  }
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
  const latest = await invoke(api, 'GET', '/dsh-surfcore/api/config');
  const staleMissing = await invoke(api, 'POST', '/dsh-surfcore/api/config', { qq: { fixtureDraft: 'must-not-save' }, baseStamp: { ...latest.data.stamps, qq: '', strict: true } });
  assert.equal(staleMissing.status, 409); assert.equal(staleMissing.data.code, 'CONFIG_STALE'); assert(staleMissing.data.hint);
  const legacy = await invoke(api, 'POST', '/dsh-surfcore/api/config', { qq: { legacyFixture: true }, baseStamp: { ...latest.data.stamps, qq: '' } });
  assert.equal(legacy.data.ok, true); assert.equal(legacy.data.qq.legacyFixture, true);
  const budgetLock = path.join(path.dirname(QQ_CONFIG), 'state', 'volc-voice-budget.lock'); fs.mkdirSync(budgetLock);
  const blockedConfig = await invoke(api, 'GET', '/dsh-surfcore/api/config');
  assert.equal(blockedConfig.status, 409); assert.equal(blockedConfig.data.code, 'VOICE_VOLC_BUDGET_BUSY'); assert(blockedConfig.data.hint);
  fs.rmdirSync(budgetLock);
  console.log('voice management actual Host route: QQ-off reads, launch state, guarded start/check/stop passed');

} finally {
  for (const fn of effects) {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    } catch {}
  }
  net.connect = originalConnect; globalThis.fetch = originalFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
