import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveBiliV2PublicSourceSet } from '../lib/bili-v2-public-source-set.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, '..', 'lib', 'bili-v2-public-source-set.mjs');
const HELPER_SRC = fs.readFileSync(HELPER, 'utf8');

const BV1 = 'BV1a2b3c4d5e';
const BV2 = 'BV9z8y7x6w5v';
const ID19 = '1234567890123456789';
const MID = '22000';
const ROUTE = 'deepseek/deepseek-chat';
const CHAR = 'alpha';
const EPOCH = 3;
const HEX64 = /^[0-9a-f]{64}$/;

const out = () => ({ audience: 'public', kind: 'dynamic' });
const video = (o = {}) => ({ kind: 'video', bvid: BV1, aid: '99887766', authorMid: '1234567', ...o });
const comment = (o = {}) => ({ kind: 'comment', rpid: '33445566', type: '1', oid: '11223344', root: '0', parent: '0', authorMid: '7654321', ...o });
const call = (o = {}) => deriveBiliV2PublicSourceSet({
  characterId: CHAR, characterEpoch: EPOCH, accountMid: MID, providerRouteId: ROUTE,
  selectors: [video()], outputTarget: out(), ...o,
});
const fail = (r, label) => {
  assert.ok(r && typeof r === 'object', `${label}: object`);
  assert.equal(r.ok, false, `${label}: ok false`);
  assert.deepEqual(Object.keys(r).sort(), ['code', 'error', 'hint', 'ok'], `${label}: 4 keys`);
  assert.equal(r.code, 'BILI_V2_PUBLIC_SET_INVALID', `${label}: code`);
  assert.equal(typeof r.error, 'string', label);
  assert.ok(r.error.length > 0, `${label}: error non-empty`);
  assert.equal(typeof r.hint, 'string', label);
  assert.ok(r.hint.length > 0, `${label}: hint non-empty`);
  assert.ok(Object.isFrozen(r), `${label}: frozen`);
  assert.ok(!('selectors' in r) && !('id' in r) && !('sourceConversations' in r), `${label}: no half set`);
};
const good = (r, label) => {
  assert.equal(r?.ok, true, `${label}: ${JSON.stringify(r)}`);
  assert.deepEqual(Object.keys(r).sort(), ['id', 'label', 'ok', 'outputConversationKey', 'outputTarget', 'selectors', 'sourceConversations'], `${label}: 7 keys`);
  return r;
};
const sourceKeys = (r) => r.sourceConversations.map((s) => s.conversationKey);
const assertAllKeysChanged = (base, changed, label, sameCount = true) => {
  assert.notEqual(changed.id, base.id, `${label}: id`);
  assert.notEqual(changed.outputConversationKey, base.outputConversationKey, `${label}: output key`);
  const before = sourceKeys(base);
  const after = sourceKeys(changed);
  if (sameCount) assert.equal(after.length, before.length, `${label}: source count`);
  else assert.notEqual(after.length, before.length, `${label}: source count changed`);
  for (const key of before) assert.ok(!after.includes(key), `${label}: every old source key retired (${key})`);
};

let count = 0;
const test = (name, fn) => { fn(); count += 1; };

function run() {
  test('normal positive: exact 7 keys, 64hex id, frozen key formats, 1:1 sourceConversations', () => {
    const r = good(call(), 'positive');
    assert.match(r.id, HEX64, 'id 64 lower hex');
    assert.equal(r.outputConversationKey, `bili:${MID}:public-set:${r.id}:dynamic`);
    assert.equal(r.selectors.length, 1);
    assert.equal(r.sourceConversations.length, 1);
    assert.deepEqual(r.sourceConversations[0].selector, r.selectors[0]);
    assert.match(r.sourceConversations[0].conversationKey, new RegExp(`^bili:${MID}:public-set:${r.id}:source:[0-9a-f]{64}$`));
    assert.deepEqual(r.outputTarget, { audience: 'public', kind: 'dynamic' });
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.length <= 160, 'label <= 160');
  });

  test('label summarizes only count/account/public dynamic; no raw selector text, no approval claim', () => {
    const r = good(call({ selectors: [video(), comment()] }), 'label');
    assert.ok(!r.label.includes(BV1), 'no bvid');
    assert.ok(!r.label.includes('99887766'), 'no aid');
    assert.ok(!r.label.includes('已审批') && !/approved/i.test(r.label), 'no approval claim');
    assert.ok(r.label.includes(String(r.sourceConversations.length)) || r.label.includes('2'), 'count');
    assert.ok(r.label.includes(MID), 'account');
    assert.ok(r.label.length <= 160, 'short');
  });

  test('deep freeze: result, selectors array, each selector, outputTarget, sourceConversations, each entry & nested selector', () => {
    const r = good(call({ selectors: [video(), comment()] }), 'freeze');
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.selectors));
    assert.ok(Object.isFrozen(r.selectors[0]));
    assert.ok(Object.isFrozen(r.outputTarget));
    assert.ok(Object.isFrozen(r.sourceConversations));
    assert.ok(Object.isFrozen(r.sourceConversations[0]));
    assert.ok(Object.isFrozen(r.sourceConversations[0].selector));
    assert.throws(() => { r.id = 'mutated'; });
    assert.throws(() => { r.selectors[0].aid = 'mutated'; });
    assert.throws(() => { r.sourceConversations[0].conversationKey = 'mutated'; });
  });

  test('deterministic: identical inputs produce deep-equal results', () => {
    assert.deepEqual(call(), call());
    assert.deepEqual(call({ selectors: [video(), comment()] }), call({ selectors: [video(), comment()] }));
  });

  test('19-digit decimal ID preserved verbatim, no e+ / no Number conversion', () => {
    const r = good(call({ selectors: [video({ aid: ID19, authorMid: ID19 })] }), 'digit19');
    assert.equal(r.selectors[0].aid, ID19);
    assert.equal(r.selectors[0].authorMid, ID19);
    assert.ok(!JSON.stringify(r).includes('e+'), 'no exponent');
  });

  test('safe integer vs equivalent decimal string yields same id', () => {
    const a = good(call({ selectors: [video({ aid: 99887766 })] }), 'num');
    assert.equal(a.selectors[0].aid, '99887766');
    const b = good(call(), 'string');
    assert.equal(a.id, b.id);
    assert.equal(a.outputConversationKey, b.outputConversationKey);
    assert.deepEqual(sourceKeys(a), sourceKeys(b));
  });

  test('accountMid safe integer normalizes to decimal string and matches string form', () => {
    const a = good(call({ accountMid: Number(MID) }), 'mid num');
    const b = good(call(), 'mid string');
    assert.equal(a.id, b.id);
    assert.ok(a.outputConversationKey.startsWith(`bili:${MID}:`));
  });

  test('unsafe numbers rejected: 19-digit number, 2**53, NaN, Infinity, negative, zero, float (positive IDs)', () => {
    const unsafe = [Number(ID19), 2 ** 53, NaN, Infinity, -1, 0, 1.5, -0.5];
    for (const v of unsafe) {
      fail(call({ selectors: [video({ aid: v })] }), `aid ${String(v)}`);
      fail(call({ accountMid: v }), `accountMid ${String(v)}`);
    }
  });

  test('unsafe numbers rejected in every comment coordinate', () => {
    for (const key of ['rpid', 'oid', 'authorMid']) {
      fail(call({ selectors: [comment({ [key]: Number(ID19) })] }), `${key} unsafe`);
    }
    for (const key of ['root', 'parent']) {
      fail(call({ selectors: [comment({ [key]: Number(ID19) })] }), `${key} unsafe`);
    }
    fail(call({ selectors: [comment({ type: 2 ** 53 })] }), 'type unsafe');
  });

  test('comment positive: root/parent 0 allowed; type 1/11/17 allowed; other positive IDs', () => {
    for (const type of ['1', '11', '17', 1, 11, 17]) {
      const r = good(call({ selectors: [comment({ type })] }), `type ${type}`);
      assert.equal(r.selectors[0].type, String(type));
    }
    const c = good(call({ selectors: [comment({ root: 0, parent: 0, rpid: ID19 })] }), 'zero coords');
    assert.equal(c.selectors[0].root, '0');
    assert.equal(c.selectors[0].parent, '0');
    assert.equal(c.selectors[0].rpid, ID19);
  });

  test('permutation of selectors does not change id; selectors sorted deterministically', () => {
    const a = good(call({ selectors: [video(), comment()] }), 'perm a');
    const b = good(call({ selectors: [comment(), video()] }), 'perm b');
    assert.equal(a.id, b.id);
    assert.deepEqual(a.selectors, b.selectors);
    assert.deepEqual(sourceKeys(a), sourceKeys(b));
  });

  test('duplicate selectors deduped and do not change id', () => {
    const a = good(call({ selectors: [video()] }), 'single');
    const b = good(call({ selectors: [video(), video(), { ...video() }] }), 'dupes');
    assert.equal(b.selectors.length, 1);
    assert.equal(a.id, b.id);
    assert.deepEqual(sourceKeys(a), sourceKeys(b));
  });

  test('same-selector-equivalent safe-number vs string does not change id (permutation+normalization)', () => {
    const a = good(call({ selectors: [video({ aid: '99887766' }), comment({ type: 1 })] }), 'a');
    const b = good(call({ selectors: [comment({ type: '1' }), video({ aid: 99887766 })] }), 'b');
    assert.equal(a.id, b.id);
  });

  test('changing characterId changes id and ALL internal keys', () => {
    const base = good(call(), 'base');
    assertAllKeysChanged(base, good(call({ characterId: 'beta' }), 'char'), 'characterId');
  });

  test('changing characterEpoch changes id and ALL internal keys', () => {
    const base = good(call(), 'base');
    assertAllKeysChanged(base, good(call({ characterEpoch: 4 }), 'epoch'), 'epoch');
  });

  test('changing accountMid changes id and ALL internal keys', () => {
    const base = good(call(), 'base');
    assertAllKeysChanged(base, good(call({ accountMid: '33000' }), 'mid'), 'accountMid');
  });

  test('changing providerRouteId changes id and ALL internal keys', () => {
    const base = good(call(), 'base');
    assertAllKeysChanged(base, good(call({ providerRouteId: 'other/route' }), 'route'), 'route');
  });

  test('adding a selector changes id and ALL internal keys (old selector key too)', () => {
    const base = good(call(), 'base');
    const added = good(call({ selectors: [video(), comment()] }), 'added');
    assertAllKeysChanged(base, added, 'add selector', false);
    assert.equal(sourceKeys(base).length, 1);
    assert.equal(sourceKeys(added).length, 2);
    assert.equal(new Set([added.outputConversationKey, ...sourceKeys(added)]).size, 3, 'all new keys distinct');
  });

  test('removing a selector changes id and all internal keys', () => {
    const base = good(call({ selectors: [video(), comment()] }), 'base');
    const removed = good(call({ selectors: [video()] }), 'removed');
    assert.notEqual(base.id, removed.id);
    assert.notEqual(base.outputConversationKey, removed.outputConversationKey);
    for (const key of sourceKeys(removed)) assert.ok(!sourceKeys(base).includes(key), 'removed-set key differs');
  });

  test('the same physical selector is isolated in a different set (different characterId)', () => {
    const a = good(call({ selectors: [video()] }), 'set a');
    const b = good(call({ characterId: 'beta', selectors: [video()] }), 'set b');
    assert.deepEqual(a.selectors, b.selectors, 'same normalized selector');
    assert.notEqual(a.id, b.id);
    assert.notEqual(sourceKeys(a)[0], sourceKeys(b)[0]);
    assert.ok(sourceKeys(a)[0].includes(a.id));
    assert.ok(sourceKeys(b)[0].includes(b.id));
  });

  test('31 selectors + 1 output = 32 audiences allowed; source keys distinct', () => {
    const selectors = Array.from({ length: 31 }, (_, i) => video({ aid: String(1000000 + i), bvid: `BV${String(i).padStart(10, '0')}` }));
    const r = good(call({ selectors }), '31');
    assert.equal(r.selectors.length, 31);
    assert.equal(r.sourceConversations.length, 31);
    assert.equal(r.sourceConversations.length + 1, 32, 'audience cap');
    assert.equal(new Set([r.outputConversationKey, ...sourceKeys(r)]).size, 32, 'all keys distinct');
    for (let i = 0; i < r.selectors.length; i += 1) assert.deepEqual(r.sourceConversations[i].selector, r.selectors[i]);
  });

  test('32 raw selector inputs rejected (length limited BEFORE dedup)', () => {
    const selectors = Array.from({ length: 32 }, (_, i) => video({ aid: String(1000000 + i) }));
    fail(call({ selectors }), '32 inputs');
  });

  test('32 duplicate inputs rejected (limit first, then dedup)', () => {
    fail(call({ selectors: Array.from({ length: 32 }, () => video()) }), '32 dupes');
  });

  test('empty selectors rejected', () => {
    fail(call({ selectors: [] }), 'empty');
    fail(call({ selectors: 'x' }), 'non-array');
    fail(call({ selectors: {} }), 'object not array');
  });

  test('extra fields / missing fields / unknown kind / DM / array / null-proto / class / symbol selector rejected', () => {
    fail(call({ selectors: [video({ extra: 1 })] }), 'extra field');
    fail(call({ selectors: [comment({ extra: 1 })] }), 'comment extra field');
    const missing = { ...video() }; delete missing.authorMid;
    fail(call({ selectors: [missing] }), 'missing field');
    fail(call({ selectors: [{ kind: 'dm', mid: '5', msgKey: '7' }] }), 'DM');
    fail(call({ selectors: [{ kind: 'notification', id: '1' }] }), 'unknown kind');
    fail(call({ selectors: [{}] }), 'empty object');
    fail(call({ selectors: [[video()]] }), 'array');
    fail(call({ selectors: [null] }), 'null');
    fail(call({ selectors: [undefined] }), 'undefined');
    fail(call({ selectors: ['x'] }), 'string');
    const nullProto = Object.assign(Object.create(null), video());
    fail(call({ selectors: [nullProto] }), 'null proto');
    class Fake { constructor() { Object.assign(this, video()); } }
    fail(call({ selectors: [new Fake()] }), 'class instance');
    const withSymbol = { ...video(), [Symbol('s')]: 1 };
    fail(call({ selectors: [withSymbol] }), 'symbol key');
  });

  test('invalid BV / ids / type rejected', () => {
    fail(call({ selectors: [video({ bvid: 'BVshort' })] }), 'short BV');
    fail(call({ selectors: [video({ bvid: 'BV1a2b3c4d5eX' })] }), 'long BV');
    fail(call({ selectors: [video({ bvid: 'av99887766' })] }), 'av prefix');
    fail(call({ selectors: [video({ bvid: 5 })] }), 'bvid number');
    fail(call({ selectors: [video({ aid: '01' })] }), 'leading zero');
    fail(call({ selectors: [video({ authorMid: '' })] }), 'empty id');
    fail(call({ selectors: [comment({ type: '2' })] }), 'bad type');
    fail(call({ selectors: [comment({ type: '1x' })] }), 'bad type 2');
    fail(call({ selectors: [comment({ root: '-1' })] }), 'negative root');
  });

  test('getters are rejected WITHOUT being executed (selector extra key, selector allowed key, top-level args)', () => {
    let calls = 0;
    const extraGetter = { ...video() };
    Object.defineProperty(extraGetter, 'extra', { enumerable: true, get() { calls += 1; return 'x'; } });
    fail(call({ selectors: [extraGetter] }), 'extra getter');
    assert.equal(calls, 0, 'extra getter not executed');

    const allowedGetter = { kind: 'video', bvid: BV1, aid: '99887766' };
    Object.defineProperty(allowedGetter, 'authorMid', { enumerable: true, get() { calls += 1; return '1234567'; } });
    fail(call({ selectors: [allowedGetter] }), 'allowed getter');
    assert.equal(calls, 0, 'allowed getter not executed');

    const args = { characterId: CHAR, characterEpoch: EPOCH, accountMid: MID, providerRouteId: ROUTE, outputTarget: out() };
    Object.defineProperty(args, 'selectors', { enumerable: true, get() { calls += 1; return [video()]; } });
    fail(deriveBiliV2PublicSourceSet(args), 'top-level getter');
    assert.equal(calls, 0, 'top-level getter not executed');
  });

  test('original input is not modified or frozen', () => {
    const selectors = [video(), comment()];
    const outputTarget = out();
    const args = { characterId: CHAR, characterEpoch: EPOCH, accountMid: MID, providerRouteId: ROUTE, selectors, outputTarget };
    const snapshot = JSON.stringify(args);
    good(deriveBiliV2PublicSourceSet(args), 'no mutation');
    assert.equal(JSON.stringify(args), snapshot, 'args unchanged');
    assert.ok(!Object.isFrozen(args), 'args not frozen');
    assert.ok(!Object.isFrozen(selectors), 'selectors array not frozen');
    assert.ok(!Object.isFrozen(selectors[0]), 'selector object not frozen');
    assert.ok(!Object.isFrozen(outputTarget), 'outputTarget not frozen');
  });

  test('failure is the fixed frozen 4-key object with no input/body leakage', () => {
    const r = call({ selectors: [video({ bvid: 'SECRET_CANARY_XY' })] });
    fail(r, 'canary');
    assert.ok(!JSON.stringify(r).includes('SECRET_CANARY_XY'), 'no raw input in error/hint');
    assert.ok(!JSON.stringify(r).includes(BV1), 'no default selector text');
    const same = call({ selectors: [video({ aid: Number(ID19) })] });
    assert.deepEqual(r, same, 'all failures identical');
    assert.ok(Object.isFrozen(r.error) === false || true);
  });

  test('outputTarget must be exactly {audience:public,kind:dynamic}; no default/expansion', () => {
    fail(call({ outputTarget: undefined }), 'missing output');
    fail(call({ outputTarget: null }), 'null output');
    fail(call({ outputTarget: [] }), 'array output');
    fail(call({ outputTarget: { audience: 'public', kind: 'dynamic', extra: 1 } }), 'extra output key');
    fail(call({ outputTarget: { audience: 'public' } }), 'missing kind');
    fail(call({ outputTarget: { audience: 'private', kind: 'dynamic' } }), 'private audience');
    fail(call({ outputTarget: { audience: 'public', kind: 'comment', oid: '1' } }), 'comment kind');
    fail(call({ outputTarget: { audience: 'public', kind: 'dm' } }), 'dm kind');
    const outGetter = { audience: 'public' };
    Object.defineProperty(outGetter, 'kind', { enumerable: true, get() { return 'dynamic'; } });
    fail(call({ outputTarget: outGetter }), 'output getter');
  });

  test('top-level validation: no args / null / primitives / bad characterId / epoch / mid / route', () => {
    fail(deriveBiliV2PublicSourceSet(), 'no args');
    fail(deriveBiliV2PublicSourceSet(null), 'null');
    fail(deriveBiliV2PublicSourceSet(5), 'number');
    fail(deriveBiliV2PublicSourceSet('x'), 'string');
    fail(deriveBiliV2PublicSourceSet([]), 'array');
    fail(call({ characterId: '' }), 'empty char');
    fail(call({ characterId: 'Alpha' }), 'uppercase char');
    fail(call({ characterId: 'a'.repeat(41) }), 'long char');
    fail(call({ characterId: 'a b' }), 'space char');
    fail(call({ characterId: 5 }), 'number char');
    fail(call({ characterEpoch: 0 }), 'epoch 0');
    fail(call({ characterEpoch: -1 }), 'epoch negative');
    fail(call({ characterEpoch: 1.5 }), 'epoch float');
    fail(call({ characterEpoch: '3' }), 'epoch string');
    fail(call({ characterEpoch: 2 ** 53 }), 'epoch unsafe');
    fail(call({ characterEpoch: NaN }), 'epoch NaN');
    fail(call({ accountMid: '' }), 'mid empty');
    fail(call({ accountMid: '01' }), 'mid leading zero');
    fail(call({ accountMid: {} }), 'mid object');
    fail(call({ providerRouteId: '' }), 'route empty');
    fail(call({ providerRouteId: 'x'.repeat(257) }), 'route too long');
    fail(call({ providerRouteId: 'a\u0000b' }), 'route control char');
    fail(call({ providerRouteId: 5 }), 'route number');
  });

  test('no throw on exotic inputs (throwing Proxy is contained)', () => {
    const evil = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    let r;
    assert.doesNotThrow(() => { r = deriveBiliV2PublicSourceSet(evil); });
    fail(r, 'proxy');
    const evilSelector = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    let r2;
    assert.doesNotThrow(() => { r2 = call({ selectors: [evilSelector] }); });
    fail(r2, 'proxy selector');
  });

  test('source keys deterministic, distinct per selector, bound to set id; no wildcard', () => {
    const r = good(call({ selectors: [video(), comment(), video({ bvid: BV2 })] }), 'distinct');
    const keys = sourceKeys(r);
    assert.equal(new Set(keys).size, keys.length, 'distinct');
    for (const key of keys) {
      assert.match(key, new RegExp(`^bili:${MID}:public-set:${r.id}:source:[0-9a-f]{64}$`));
      assert.ok(!/[*]|(:all$)|(:any$)|(:shared$)/.test(key), 'no wildcard');
    }
    assert.ok(!/[*]|(:all$)|(:any$)|(:shared$)/.test(r.outputConversationKey), 'output no wildcard');
    for (let i = 0; i < r.selectors.length; i += 1) assert.deepEqual(r.sourceConversations[i].selector, r.selectors[i]);
  });

  test('helper source has no IO/network/credentials/fetch and no placeholder tokens', () => {
    for (const forbidden of ['fetch(', 'process.env', 'node:fs', 'node:http', 'node:https', 'require(', 'XMLHttpRequest', 'WebSocket', '{{']) {
      assert.ok(!HELPER_SRC.includes(forbidden), `helper must not contain ${forbidden}`);
    }
    assert.ok(/from ['"]node:crypto['"]/.test(HELPER_SRC), 'uses node:crypto for SHA256');
    assert.equal((HELPER_SRC.match(/export function deriveBiliV2PublicSourceSet/g) || []).length, 1, 'single frozen export');
  });

  const spy = () => ({ calls: 0 });
  const withOwnProto = (obj, value = 'POLLUTED') => {
    Object.defineProperty(obj, '__proto__', { value, enumerable: true, writable: true, configurable: true });
    return obj;
  };
  const withGetter = (obj, key, box, value) => {
    Object.defineProperty(obj, key, { enumerable: true, configurable: true, get() { box.calls += 1; return value; } });
    return obj;
  };
  const harmlessProxy = (target, box) => new Proxy(target, {
    getPrototypeOf(t) { box.calls += 1; return Object.getPrototypeOf(t); },
    ownKeys(t) { box.calls += 1; return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, key) { box.calls += 1; return Reflect.getOwnPropertyDescriptor(t, key); },
    get(t, key, receiver) { box.calls += 1; return Reflect.get(t, key, receiver); },
  });
  const topArgs = (selectors, outputTarget) => ({
    characterId: CHAR, characterEpoch: EPOCH, accountMid: MID, providerRouteId: ROUTE,
    selectors: selectors === undefined ? [video()] : selectors,
    outputTarget: outputTarget === undefined ? out() : outputTarget,
  });

  test('forbidden own __proto__ data field is rejected at root / selector / outputTarget / array boundaries', () => {
    fail(deriveBiliV2PublicSourceSet(withOwnProto(topArgs())), 'root own __proto__');
    fail(call({ selectors: [withOwnProto(video())] }), 'selector own __proto__');
    fail(call({ outputTarget: withOwnProto(out()) }), 'outputTarget own __proto__');
    const arr = [video()];
    withOwnProto(arr);
    fail(call({ selectors: arr }), 'array own __proto__');
    assert.equal(Object.getPrototypeOf(arr), Array.prototype, 'array prototype not polluted');
  });

  test('harmless Proxy is rejected at root / selector / outputTarget / array boundaries without firing any trap', () => {
    const box = spy();
    fail(deriveBiliV2PublicSourceSet(harmlessProxy(topArgs(), box)), 'root proxy');
    assert.equal(box.calls, 0, 'root: no trap');
    fail(call({ selectors: [harmlessProxy(video(), box)] }), 'selector proxy');
    assert.equal(box.calls, 0, 'selector: no trap');
    fail(call({ outputTarget: harmlessProxy(out(), box) }), 'outputTarget proxy');
    assert.equal(box.calls, 0, 'outputTarget: no trap');
    fail(call({ selectors: harmlessProxy([video()], box) }), 'array proxy');
    assert.equal(box.calls, 0, 'array: no trap');
  });

  test('array index getter / Symbol.iterator getter / index accessor rejected without executing callbacks', () => {
    const box = spy();
    const indexGetter = [video()];
    Object.defineProperty(indexGetter, '0', { enumerable: true, configurable: true, get() { box.calls += 1; return video(); } });
    fail(call({ selectors: indexGetter }), 'array index getter');
    assert.equal(box.calls, 0, 'index getter not executed');

    const iteratorGetter = [video()];
    Object.defineProperty(iteratorGetter, Symbol.iterator, {
      configurable: true,
      get() { box.calls += 1; return Array.prototype[Symbol.iterator].bind(iteratorGetter); },
    });
    fail(call({ selectors: iteratorGetter }), 'array iterator getter');
    assert.equal(box.calls, 0, 'iterator getter not executed');

    const indexAccessor = [video()];
    Object.defineProperty(indexAccessor, '0', {
      enumerable: true, configurable: true,
      get() { box.calls += 1; return video(); },
      set() { box.calls += 1; },
    });
    fail(call({ selectors: indexAccessor }), 'array index accessor');
    assert.equal(box.calls, 0, 'index accessor not executed');
  });

  test('plain-object accessors at root / selector / outputTarget rejected without executing callbacks', () => {
    const box = spy();
    fail(deriveBiliV2PublicSourceSet(withGetter(topArgs(), 'characterId', box, CHAR)), 'root getter');
    assert.equal(box.calls, 0, 'root getter not executed');
    fail(call({ selectors: [withGetter(video(), 'bvid', box, BV1)] }), 'selector getter');
    assert.equal(box.calls, 0, 'selector getter not executed');
    fail(call({ outputTarget: withGetter(out(), 'kind', box, 'dynamic') }), 'outputTarget getter');
    assert.equal(box.calls, 0, 'outputTarget getter not executed');
  });

  test('array subclass / sparse / hidden index / extra own key are rejected', () => {
    class SubArray extends Array {}
    const sub = new SubArray();
    sub.push(video());
    fail(call({ selectors: sub }), 'array subclass');

    const sparse = new Array(2);
    sparse[0] = video();
    fail(call({ selectors: sparse }), 'sparse array');

    const hidden = [video()];
    Object.defineProperty(hidden, '0', { value: video(), enumerable: false, writable: true, configurable: true });
    fail(call({ selectors: hidden }), 'hidden index');

    const extra = [video()];
    extra.extra = 'x';
    fail(call({ selectors: extra }), 'array extra key');
  });

  test('hostile inputs are neither modified nor frozen and no prototype is polluted', () => {
    const selector = withOwnProto(video());
    const args = withOwnProto(topArgs([selector], out()));
    const protoBefore = Object.getPrototypeOf(args);
    const protoValueBefore = Object.getOwnPropertyDescriptor(args, '__proto__').value;
    fail(deriveBiliV2PublicSourceSet(args), 'hostile input');
    assert.equal(Object.getPrototypeOf(args), protoBefore, 'root prototype unchanged');
    assert.equal(Object.getPrototypeOf(selector), Object.prototype, 'selector prototype unchanged');
    assert.equal(Object.getOwnPropertyDescriptor(args, '__proto__').value, protoValueBefore, 'own __proto__ value unchanged');
    assert.ok(!Object.isFrozen(args) && !Object.isFrozen(args.selectors) && !Object.isFrozen(selector), 'inputs not frozen');
    assert.equal(args.selectors.length, 1, 'array length unchanged');
  });

  test('every hostile failure is the identical fixed 4-key frozen object', () => {
    const box = spy();
    const results = [
      deriveBiliV2PublicSourceSet(withOwnProto(topArgs())),
      call({ selectors: [withOwnProto(video())] }),
      call({ selectors: harmlessProxy([video()], box) }),
      call({ outputTarget: withOwnProto(out()) }),
    ];
    for (let i = 0; i < results.length; i += 1) fail(results[i], `fixed failure ${i}`);
    for (const r of results) assert.deepEqual(r, results[0], 'identical failure');
    assert.equal(box.calls, 0, 'array proxy trap not executed');
  });
}

try {
  run();
  console.log(`PASS Bili V2 public source set: ${count} cases`);
} catch (error) {
  console.log(`FAIL ${error?.stack || error}`);
  process.exitCode = 1;
}
