import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createVoiceManagement } from '../src/voice-management.js';

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
  const context3 = vm.createContext({ rulesSaving:false, setRulesSaving:()=>{}, rules: draft, rulesBaseRef: { current: {} },
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
  let current = initial, release, started;
  const postStarted = new Promise(resolve => { started = resolve; });
  const context3 = vm.createContext({ rulesSaving:false, setRulesSaving:()=>{}, rules: initial, rulesBaseRef: { current: initial },
    api: (_url, options) => options?.method === 'POST' ? new Promise(resolve => { release = resolve; started(); }) : Promise.resolve(initial), setRules: fn => { current = fn(current); },
    planVoiceRebase: plan,
    onVoiceConfigSaved: async () => ({ ok: true }), voiceError: e => e.message, toast: () => {} });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', context3);
  const pending = context3.run(); await postStarted; current = { ...current, triggerWho: 'list' };
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


test('真实控制器：同页先保存价格再保存分群规则，不误报CONFIG_STALE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rules-rebase-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { trigger: { who: 'owner' }, cloud: { pricePerKChar: 1, monthlyQuota: 900000 } } } }));
  const service = createVoiceManagement({ configFile, programRoot: root });
  try {
    const base = (await service.dispatch({ method: 'GET', pathname: '/rules' })).data;
    const draft = { ...base, groupRules: [{ groupId: '12345', triggerWho: 'mention', maxPerDay: 20 }] };
    const pricing = await service.dispatch({ method: 'POST', pathname: '/rules', body: { pricePerKChar: 2 } });
    assert.equal(pricing.status, 200);
    const start = source.indexOf('      const saveRules = async () => {'), end = source.indexOf('      const card =', start);
    let message = '', current = draft;
    const ctx = vm.createContext({ rulesSaving: false, setRulesSaving: () => {}, rules: draft,
      rulesBaseRef: { current: base }, rulesDraftRef: { current: draft }, planVoiceRebase: plan,
      api: async (_url, options) => {
        const result = await service.dispatch({ method: options?.method || 'GET', pathname: '/rules', body: options?.body });
        if (result.data.ok === false) throw Object.assign(new Error(result.data.error), { code: result.data.code, hint: result.data.hint });
        return result.data;
      }, setRules: update => { current = typeof update === 'function' ? update(current) : update; },
      onVoiceConfigSaved: async () => ({ ok: true }), voiceError: e => [e.code, e.message, e.hint].filter(Boolean).join(' · '), toast: value => { message = value; } });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', ctx);
    await ctx.run();
    assert.match(message, /触发规则已保存/);
    const saved = (await service.dispatch({ method: 'GET', pathname: '/rules' })).data;
    assert.equal(saved.pricePerKChar, 2, 'cannot overwrite the pricing saved by the same page');
    assert.equal(saved.groupRules[0].maxPerDay, 20);
    assert.equal(current.pricePerKChar, 2);
    assert.equal(current.configStamp, saved.configStamp);
  } finally { await service.dispose(); }
});


test('真实控制器：同一分群规则被另一处修改时仍拒绝，草稿和远端均保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rules-conflict-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { groupPolicies: { '12345': { triggerWho: 'mention', maxPerDay: 0 } } } } }));
  const service = createVoiceManagement({ configFile, programRoot: root });
  try {
    const base = (await service.dispatch({ method: 'GET', pathname: '/rules' })).data;
    const draft = { ...base, groupRules: [{ groupId: '12345', triggerWho: 'mention', maxPerDay: 20 }] };
    await service.dispatch({ method: 'POST', pathname: '/rules', body: { groupRules: [{ groupId: '12345', triggerWho: 'mention', maxPerDay: 30 }], baseStamp: base.configStamp } });
    const start = source.indexOf('      const saveRules = async () => {'), end = source.indexOf('      const card =', start);
    let message = '', posts = 0, current = draft;
    const ref = { current: base };
    const ctx = vm.createContext({ rulesSaving: false, setRulesSaving: () => {}, rules: draft, rulesBaseRef: ref, planVoiceRebase: plan,
      api: async (_url, options) => { if (options?.method === 'POST') posts++; return (await service.dispatch({ method: options?.method || 'GET', pathname: '/rules', body: options?.body })).data; },
      setRules: update => { current = typeof update === 'function' ? update(current) : update; }, onVoiceConfigSaved: async () => ({ ok: true }),
      voiceError: e => [e.code, e.message, e.hint].filter(Boolean).join(' · '), toast: value => { message = value; } });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', ctx);
    await ctx.run();
    assert.equal(posts, 0); assert.match(message, /CONFIG_STALE/); assert.match(message, /保留草稿/);
    assert.equal(current.groupRules[0].maxPerDay, 20); assert.equal(ref.current.configStamp, base.configStamp);
    assert.equal((await service.dispatch({ method: 'GET', pathname: '/rules' })).data.groupRules[0].maxPerDay, 30);
  } finally { await service.dispose(); }
});

test('主草稿版本早于规则保存前版本时，安全合并其他设置变更', async () => {
  const start = source.indexOf('      const onVoiceConfigSaved = async result => {');
  const end = source.indexOf('      useEffect(() => { loadOverview()', start);
  const base = { note: 'base', socialV2: { voice: { trigger: { who: 'owner' }, cloud: { pricePerKChar: 1 } } } };
  const draft = structuredClone(base); draft.note = 'pending';
  const remote = structuredClone(base); remote.socialV2.voice.trigger.who = 'mention'; remote.socialV2.voice.cloud.pricePerKChar = 2;
  const ref = { current: { qq: draft, saved: JSON.stringify({ qq: base }), configStamps: { qq: 'initial' } } };
  let saved, merged, stamp;
  const ctx = vm.createContext({ voiceDraftRef: ref, api: async () => ({ qq: remote, stamps: { qq: 'after' } }),
    planVoiceRebase: plan, setQq: x => { merged = x; }, setSaved: x => { saved = x; }, setConfigStamps: value => { stamp = value.qq; } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.run = onVoiceConfigSaved;', ctx);
  assert.equal((await ctx.run({ beforeStamp: 'pricing-written', afterStamp: 'after' })).ok, true);
  assert.equal(merged.note, 'pending'); assert.equal(merged.socialV2.voice.cloud.pricePerKChar, 2);
  assert.equal(JSON.parse(saved).qq.note, 'base'); assert.equal(stamp, 'after');
});

test('读取最新规则后又发生配置写入，后端CAS仍拒绝并保留草稿', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rules-race-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { trigger: { who: 'owner' }, cloud: { monthlyQuota: 900000 } } } }));
  const service = createVoiceManagement({ configFile, programRoot: root });
  try {
    const base = (await service.dispatch({ method: 'GET', pathname: '/rules' })).data;
    const draft = { ...base, triggerWho: 'list' };
    let current = draft, message = '';
    const start = source.indexOf('      const saveRules = async () => {'), end = source.indexOf('      const card =', start);
    const ctx = vm.createContext({ rulesSaving: false, setRulesSaving: () => {}, rules: draft, rulesBaseRef: { current: base }, planVoiceRebase: plan,
      api: async (_url, options) => {
        if (!options?.method) {
          const latest = await service.dispatch({ method: 'GET', pathname: '/rules' });
          await service.dispatch({ method: 'POST', pathname: '/rules', body: { monthlyQuota: 800000 } });
          return latest.data;
        }
        const result = await service.dispatch({ method: 'POST', pathname: '/rules', body: options.body });
        if (result.data.ok === false) throw Object.assign(new Error(result.data.error), { code: result.data.code, hint: result.data.hint });
        return result.data;
      }, setRules: update => { current = typeof update === 'function' ? update(current) : update; },
      onVoiceConfigSaved: async () => ({ ok: true }), voiceError: e => [e.code, e.message, e.hint].filter(Boolean).join(' · '), toast: value => { message = value; } });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.run = saveRules;', ctx);
    await ctx.run();
    assert.match(message, /CONFIG_STALE/); assert.match(message, /保留未保存草稿/);
    assert.equal(current.triggerWho, 'list'); assert.equal(current.configStamp, base.configStamp);
    const saved = (await service.dispatch({ method: 'GET', pathname: '/rules' })).data;
    assert.equal(saved.triggerWho, 'owner'); assert.equal(saved.monthlyQuota, 800000);
  } finally { await service.dispose(); }
});
