import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
const begin = source.indexOf('    function planVoiceRebase('), end = source.indexOf('    function VolcForm(', begin);
assert(begin >= 0 && end > begin);
const context = vm.createContext({});
vm.runInContext(source.slice(begin, end) + '\nglobalThis.planVoiceRebase = planVoiceRebase; globalThis.rebaseVoiceRules = rebaseVoiceRules;', context);
const plan = context.planVoiceRebase;
const stamps = { baseStamp: 'before', beforeStamp: 'before', afterStamp: 'after', remoteStamp: 'after' };

test('语音保存后合并其他未保存草稿并刷新戳', () => {
  const base = { socialV2: { voice: { enabled: false, tts: { enabled: false, route: 'local' } } }, note: 'old' };
  const draft = structuredClone(base); draft.socialV2.voice.enabled = true; draft.note = 'user draft';
  const remote = structuredClone(base); remote.socialV2.voice.tts = { enabled: true, route: 'cloud', cloudProvider: 'volc', selectionRevision: 1 };
  const result = plan({ ...stamps, base, draft, remote });
  assert.equal(result.draft.socialV2.voice.enabled, true); assert.equal(result.draft.note, 'user draft');
  assert.equal(result.draft.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(result.stamp, 'after');
  assert.equal(result.saved.note, 'old');
});

test('实际保存回调刷新 QQ 戳并保留请求期间的新草稿', async () => {
  const beginCallback = source.indexOf('      const onVoiceConfigSaved = async result => {');
  const endCallback = source.indexOf('      useEffect(() => { loadOverview()', beginCallback);
  assert(beginCallback >= 0 && endCallback > beginCallback);
  const base = { socialV2: { voice: { enabled: false, tts: { route: 'local', enabled: false } } }, note: 'base' };
  const remote = structuredClone(base); remote.socialV2.voice.tts = { route: 'cloud', enabled: true, cloudProvider: 'volc' };
  const ref = { current: { qq: structuredClone(base), saved: JSON.stringify({ qq: base, bili: { stable: true }, unified: {} }), configStamps: { qq: 'before', bili: 'b', unified: 'u' } } };
  let release, newQq, newSaved, newStamps;
  const context2 = vm.createContext({ voiceDraftRef: ref, planVoiceRebase: plan,
    api: () => new Promise(resolve => { release = resolve; }), setQq: value => { newQq = value; }, setSaved: value => { newSaved = value; }, setConfigStamps: value => { newStamps = value; } });
  vm.runInContext(source.slice(beginCallback, endCallback) + '\nglobalThis.run = onVoiceConfigSaved;', context2);
  const pending = context2.run({ beforeStamp: 'before', afterStamp: 'after' });
  ref.current.qq.note = 'edited while waiting';
  release({ qq: remote, stamps: { qq: 'after' } });
  assert.equal((await pending).ok, true); assert.equal(newQq.note, 'edited while waiting');
  assert.equal(newQq.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(JSON.parse(newSaved).bili.stable, true);
  assert.equal(newStamps.qq, 'after'); assert.equal(newStamps.bili, 'b');
});

test('规则整表冲突显示提示且不修改草稿', async () => {
  const start = source.indexOf('      const saveRules = async () => {'), end = source.indexOf('      const card =', start);
  assert(start >= 0 && end > start);
  const draft = { triggerWho: 'list', aiEnabled: true, route: 'cloud', configStamp: 'old' };
  let message = '', writes = 0;
  const context3 = vm.createContext({ rules: draft, rulesBaseRef: { current: {} },
    api: async () => { throw Object.assign(new Error('规则已变化'), { code: 'CONFIG_STALE', hint: '保留草稿' }); },
    setRules: () => { writes++; }, onVoiceConfigSaved: async () => ({ ok: true }),
    voiceError: e => [e.code, e.message, e.hint].filter(Boolean).join(' · '), toast: value => { message = value; } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', context3);
  await context3.run(); assert.match(message, /CONFIG_STALE/); assert.match(message, /保留草稿/); assert.equal(writes, 0);
  assert.equal(draft.triggerWho, 'list');
});

test('规则保存期间的新编辑不被成功回执覆盖', async () => {
  const start = source.indexOf('      const saveRules = async () => {'), end = source.indexOf('      const card =', start);
  const initial = { triggerWho: 'owner', aiEnabled: true, route: 'cloud', configStamp: 'old' };
  let current = initial, release;
  const context3 = vm.createContext({ rules: initial, rulesBaseRef: { current: initial },
    api: () => new Promise(resolve => { release = resolve; }), setRules: fn => { current = fn(current); },
    onVoiceConfigSaved: async () => ({ ok: true }), voiceError: e => e.message, toast: () => {} });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', context3);
  const pending = context3.run(); current = { ...current, triggerWho: 'list' };
  release({ afterStamp: 'new', beforeStamp: 'old' }); await pending;
  assert.equal(current.triggerWho, 'list'); assert.equal(current.configStamp, 'new');
});

test('语音开关合并保留未保存触发规则并拒绝同字段冲突', () => {
  const base = { aiEnabled: false, route: 'local', triggerWho: 'owner' };
  const draft = { ...base, triggerWho: 'list' };
  const merged = context.rebaseVoiceRules(base, draft, { ttsEnabled: true, route: 'cloud' });
  assert.equal(merged.triggerWho, 'list'); assert.equal(merged.aiEnabled, true); assert.equal(merged.route, 'cloud');
  assert.throws(() => context.rebaseVoiceRules({ ...base, route: 'cloud' }, { ...draft, route: 'manual' }, { ttsEnabled: true, route: 'local' }), /冲突/);
});

test('同字段冲突或版本漂移时拒绝并保持原草稿', () => {
  const base = { voice: { route: 'local' }, note: 'old' };
  const draft = { voice: { route: 'manual' }, note: 'draft' };
  const remote = { voice: { route: 'cloud' }, note: 'old' };
  assert.throws(() => plan({ ...stamps, base, draft, remote }), /冲突/);
  assert.deepEqual(draft, { voice: { route: 'manual' }, note: 'draft' });
  assert.throws(() => plan({ ...stamps, baseStamp: 'other', base, draft, remote }), /版本/);
  assert.throws(() => plan({ ...stamps, remoteStamp: 'changed', base, draft, remote }), /版本/);
});
