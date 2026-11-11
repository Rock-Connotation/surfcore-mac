import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createVoiceManagement } from '../src/voice-management.js';
import { synthesizeToFile } from '../src/voice-tts.js';
import { encodeVoiceRecord } from '../src/voice-record.js';
import { withVolcBudgetLock } from '../src/voice-volc-budget.js';
import { fileStamp } from '../src/config-stamps.js';

const tempRoot = os.tmpdir();
function fixture() {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'volc-management-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { maxPerMinute: 2, maxPerHour: 10, trigger: { who: 'owner' }, tts: { maxChars: 120, enabled: true, route: 'cloud' } } } }));
  return { dir, configFile };
}
const post = (pathname, body = {}) => ({ method: 'POST', pathname, body });

test('保存密钥不回显，不改变发送限制，自检只请求一次', { skip: !fs.constants.O_NOFOLLOW }, async () => {
  const f = fixture(); let calls = 0;
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir, synthesize: async opts => {
    calls++; assert.equal(opts.provider, 'volc'); assert.equal(opts.apiKey, 'fixture-key'); assert.equal(opts.budget.configFile, f.configFile); return { durationMs: 100 };
  }, fetchImpl: () => { throw new Error('unexpected network'); } });
  const invalid = await svc.dispatch(post('/volc-config', { provider: 'volc', apiKey: 'bad' + String.fromCharCode(10) + 'key' }));
  assert.equal(invalid.data.code, 'VOICE_VOLC_KEY_INVALID'); assert.ok(invalid.data.hint);
  const saved = await svc.dispatch(post('/volc-config', { provider: 'volc', apiKey: 'fixture-key' }));
  assert.equal(saved.data.ok, true); assert.ok(!JSON.stringify(saved).includes('fixture-key'));
  const status = await svc.dispatch({ pathname: '/volc-config' });
  assert.equal(status.data.hasKey, true); assert.ok(!JSON.stringify(status).includes('fixture-key'));
  const stats = await svc.dispatch({ pathname: '/packs/cloud-stats' });
  assert.equal(stats.data.provider, 'volc'); assert.equal(stats.data.usageAvailable, false); assert.equal(stats.data.remainChars, undefined);
  const disk = fs.readFileSync(f.configFile, 'utf8'); assert.ok(!disk.includes('fixture-key'));
  const voice = JSON.parse(disk).socialV2.voice;
  assert.equal(voice.maxPerMinute, 2); assert.equal(voice.maxPerHour, 10); assert.equal(voice.trigger.who, 'owner'); assert.equal(voice.tts.maxChars, 120);
  const file = path.join(f.dir, 'state', 'volc-voice-keys', voice.tts.volcKeyId);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const check = await svc.dispatch(post('/tts-check')); assert.equal(check.data.ok, true); assert.equal(calls, 1);
  await svc.dispose();
});

test('火山显式启用合成并单独设置月上限，不打开发送开关', { skip: !fs.constants.O_NOFOLLOW }, async () => {
  const f = fixture();
  const cfg = JSON.parse(fs.readFileSync(f.configFile));
  cfg.socialV2.voice.enabled = false; cfg.socialV2.voice.tts.enabled = false; cfg.socialV2.voice.tts.route = 'local';
  cfg.socialV2.voice.cloud = { monthlyQuota: 7000, pricePerKChar: 2 };
  cfg.socialV2.tools = { sendVoice: false }; fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir });
  const missing = await svc.dispatch(post('/volc-config', { provider: 'volc', activate: true }));
  assert.equal(missing.data.code, 'VOICE_VOLC_KEY_INVALID'); assert.ok(missing.data.hint);
  const originalStamp = fileStamp(f.configFile);
  const selected = await svc.dispatch(post('/volc-config', { provider: 'volc', activate: true, apiKey: 'fixture-key' }));
  assert.equal(selected.data.ok, true); assert.equal(selected.data.route, 'cloud'); assert.equal(selected.data.ttsEnabled, true);
  assert.equal(selected.data.beforeStamp, originalStamp); assert.equal(selected.data.afterStamp, fileStamp(f.configFile)); assert.notEqual(selected.data.afterStamp, originalStamp);
  const strict = await svc.dispatch(post('/volc-config', { monthlyQuota: 1 })); assert.equal(strict.data.monthlyLimit, 1);
  let requests = 0;
  await assert.rejects(synthesizeToFile({ provider: 'volc', text: '你好', apiKey: 'fixture-key', budget: { configFile: f.configFile, keyId: JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.tts.volcKeyId, selectionRevision: JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.tts.selectionRevision ?? 0 }, outDir: f.dir,
    fetchImpl: async () => { requests++; } }), e => e.code === 'VOICE_VOLC_BUDGET_EXHAUSTED' && Boolean(e.hint));
  assert.equal(requests, 0);
  const quota = await svc.dispatch(post('/volc-config', { monthlyQuota: 5000 }));
  assert.equal(quota.data.monthlyLimit, 5000);
  const invalid = await svc.dispatch(post('/volc-config', { monthlyQuota: 900001 }));
  assert.equal(invalid.data.code, 'VOICE_VOLC_QUOTA_INVALID'); assert.ok(invalid.data.hint);
  const read = await svc.dispatch({ pathname: '/volc-config' }); assert.equal(read.data.monthlyLimit, 5000);
  const raised = await svc.dispatch(post('/volc-config', { monthlyQuota: 9000 })); assert.equal(raised.data.monthlyLimit, 7000);
  const afterRaised = JSON.parse(fs.readFileSync(f.configFile));
  assert.equal(afterRaised.socialV2.voice.tts.volcMonthlyQuota, 7000);
  delete afterRaised.socialV2.voice.cloud.monthlyQuota; fs.writeFileSync(f.configFile, JSON.stringify(afterRaised));
  assert.equal((await svc.dispatch({ pathname: '/volc-config' })).data.monthlyLimit, 7000);
  afterRaised.socialV2.voice.cloud.monthlyQuota = 7000; fs.writeFileSync(f.configFile, JSON.stringify(afterRaised));
  await svc.dispatch(post('/volc-config', { monthlyQuota: 5000 }));
  const saved = JSON.parse(fs.readFileSync(f.configFile));
  assert.equal(saved.socialV2.voice.enabled, false); assert.equal(saved.socialV2.tools.sendVoice, false);
  assert.equal(saved.socialV2.voice.tts.route, 'cloud'); assert.equal(saved.socialV2.voice.tts.enabled, true);
  assert.equal(saved.socialV2.voice.tts.volcMonthlyQuota, 5000);
  assert.deepEqual(saved.socialV2.voice.cloud, { monthlyQuota: 7000, pricePerKChar: 2 });
  assert.equal(saved.socialV2.voice.maxPerMinute, 2); assert.equal(saved.socialV2.voice.trigger.who, 'owner');
  await svc.dispose();
});

test('只有明确开启的发送总闸在启用合成后保持开启', { skip: !fs.constants.O_NOFOLLOW }, async () => {
  for (const value of [undefined, null, 'true', true]) {
    const f = fixture();
    const cfg = JSON.parse(fs.readFileSync(f.configFile));
    cfg.socialV2.voice.tts = { enabled: false, route: 'local' };
    if (value !== undefined) cfg.socialV2.voice.enabled = value;
    fs.writeFileSync(f.configFile, JSON.stringify(cfg));
    const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir });
    const activated = await svc.dispatch(post('/volc-config', { provider: 'volc', activate: true, apiKey: 'fixture-key' }));
    assert.equal(activated.data.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.enabled, value === true);
    const restored = await svc.dispatch(post('/volc-config', { provider: 'voxd' }));
    assert.equal(restored.data.ok, true); assert.equal(restored.data.selected, false);
    assert.equal(JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.enabled, value === true);
    await svc.dispose();
  }
});

test('Host 自检的失败请求也占用持久合成预算', { skip: !fs.constants.O_NOFOLLOW }, async () => {
  const f = fixture(); let calls = 0;
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir, fetchImpl: async () => { calls++; throw new Error('offline fixture'); } });
  await svc.dispatch(post('/volc-config', { provider: 'volc', apiKey: 'fixture-key' }));
  assert.equal((await svc.dispatch(post('/tts-check'))).data.code, 'VOICE_VOLC_FAILED');
  await assert.rejects(synthesizeToFile({ provider: 'volc', text: '你好', apiKey: 'fixture-key', budget: { configFile: f.configFile, keyId: JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.tts.volcKeyId, selectionRevision: JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.tts.selectionRevision ?? 0 }, outDir: f.dir,
    fetchImpl: async () => { calls++; throw new Error('offline fixture'); } }), e => e.code === 'VOICE_VOLC_FAILED');
  const blocked = await svc.dispatch(post('/tts-check'));
  assert.equal(blocked.data.code, 'VOICE_VOLC_BUDGET_EXHAUSTED'); assert.ok(blocked.data.hint); assert.equal(calls, 2);
  await svc.dispose();
});

test('规则单字段更新不重置触发人或语音合成', async () => {
  const f = fixture(), cfg = JSON.parse(fs.readFileSync(f.configFile));
  cfg.socialV2.voice.trigger.who = 'anyone'; cfg.socialV2.voice.tts.cloudProvider = 'volc';
  fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir });
  const result = await svc.dispatch(post('/rules', { pricePerKChar: 2 })); assert.equal(result.data.ok, true);
  const quota = await svc.dispatch(post('/rules', { monthlyQuota: 1234 })); assert.equal(quota.data.ok, true);
  const saved = JSON.parse(fs.readFileSync(f.configFile));
  assert.equal(saved.socialV2.voice.trigger.who, 'anyone'); assert.equal(saved.socialV2.voice.tts.enabled, true);
  assert.equal(saved.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(saved.socialV2.voice.cloud.pricePerKChar, 2);
  assert.equal(saved.socialV2.voice.cloud.monthlyQuota, 1234);
  await svc.dispose();
});

test('规则整表保存遇到并发修改时拒绝且不覆盖', async () => {
  const f = fixture(), svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir });
  const initial = await svc.dispatch({ pathname: '/rules' }); assert.ok(initial.data.configStamp);
  const changed = await svc.dispatch(post('/volc-config', { monthlyQuota: 5000 })); assert.equal(changed.data.ok, true);
  const before = fs.readFileSync(f.configFile, 'utf8');
  const stale = await svc.dispatch(post('/rules', { ...initial.data, baseStamp: initial.data.configStamp, triggerWho: 'list' }));
  assert.equal(stale.data.code, 'CONFIG_STALE'); assert.ok(stale.data.hint); assert.equal(fs.readFileSync(f.configFile, 'utf8'), before);
  await svc.dispose();
});

test('额度锁被占用时 provider 修改拒绝且配置保持原样', async () => {
  const f = fixture(); const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir });
  fs.mkdirSync(path.join(f.dir, 'state')); fs.mkdirSync(path.join(f.dir, 'state', 'volc-voice-budget.lock'));
  const before = fs.readFileSync(f.configFile, 'utf8');
  const result = await svc.dispatch(post('/volc-config', { provider: 'voxd' }));
  assert.equal(result.data.ok, false); assert.equal(result.data.code, 'VOICE_VOLC_BUDGET_BUSY'); assert.ok(result.data.hint);
  const rules = await svc.dispatch(post('/rules', { aiEnabled: true, route: 'local' }));
  assert.equal(rules.data.ok, false); assert.equal(rules.data.code, 'VOICE_VOLC_BUDGET_BUSY'); assert.ok(rules.data.hint);
  assert.equal(fs.readFileSync(f.configFile, 'utf8'), before); await svc.dispose();
});

test('旧云自检仅在共享锁内发起合成', async () => {
  const f = fixture(); let synths = 0;
  const cfg = JSON.parse(fs.readFileSync(f.configFile)); cfg.socialV2.voice.tts.cloudProvider = 'voxd'; fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir, fetchImpl: async () => ({ ok: true }),
    synthesize: async () => { synths++; assert.throws(() => withVolcBudgetLock(f.configFile, () => {}), e => e.code === 'VOICE_VOLC_BUDGET_BUSY'); return { durationMs: 1 }; } });
  const result = await svc.dispatch(post('/tts-check')); assert.equal(result.data.ok, true); assert.equal(synths, 1);
  await svc.dispose();
});

test('旧云健康检查期间切换火山后，自检不得继续合成旧云', async () => {
  const f = fixture(); let release, synths = 0;
  const cfg = JSON.parse(fs.readFileSync(f.configFile));
  cfg.socialV2.voice.tts.cloudProvider = 'voxd'; fs.writeFileSync(f.configFile, JSON.stringify(cfg));
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir,
    fetchImpl: () => new Promise(resolve => { release = resolve; }), synthesize: async () => { synths++; return {}; } });
  const pending = svc.dispatch(post('/tts-check'));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  cfg.socialV2.voice.tts.cloudProvider = 'volc'; cfg.socialV2.voice.tts.selectionRevision = 1;
  fs.writeFileSync(f.configFile, JSON.stringify(cfg)); release({ ok: true });
  const result = await pending;
  assert.equal(result.data.code, 'VOICE_TTS_CONFIG_CHANGED'); assert.ok(result.data.hint); assert.equal(synths, 0);
  await svc.dispose();
});

test('未配置密钥时自检返回结构化错误且不发请求', async () => {
  const f = fixture(); let calls = 0;
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir, synthesize: async () => { calls++; } });
  await svc.dispatch(post('/volc-config', { provider: 'volc' }));
  const result = await svc.dispatch(post('/tts-check'));
  assert.equal(result.data.code, 'VOICE_VOLC_KEY_INVALID'); assert.ok(result.data.hint); assert.equal(calls, 0);
  await svc.dispose();
});

test('凭据文件权限不安全时拒绝读取且不发请求', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(); let calls = 0;
  const svc = createVoiceManagement({ configFile: f.configFile, programRoot: f.dir, synthesize: async () => { calls++; } });
  await svc.dispatch(post('/volc-config', { provider: 'volc', apiKey: 'fixture-key' }));
  const id = JSON.parse(fs.readFileSync(f.configFile)).socialV2.voice.tts.volcKeyId;
  fs.chmodSync(path.join(f.dir, 'state', 'volc-voice-keys', id), 0o644);
  const result = await svc.dispatch(post('/tts-check'));
  assert.equal(result.data.code, 'VOICE_VOLC_FAILED'); assert.ok(result.data.hint); assert.equal(calls, 0);
  await svc.dispose();
});

test('容器内联只读取普通文件并保留字节和大小限制', { skip: !fs.constants.O_NOFOLLOW }, () => {
  const f = fixture(); const audio = path.join(f.dir, 'audio.wav');
  fs.writeFileSync(audio, Buffer.from([1, 2, 3, 4]));
  assert.equal(encodeVoiceRecord(audio, 4), 'base64://AQIDBA==');
  assert.throws(() => encodeVoiceRecord(audio, 3));
  const before = fs.statSync(audio);
  fs.appendFileSync(audio, Buffer.from([5]));
  assert.throws(() => encodeVoiceRecord(audio, 10, before));
  const link = path.join(f.dir, 'link.wav'); fs.symlinkSync(audio, link);
  assert.throws(() => encodeVoiceRecord(link, 4));
});
