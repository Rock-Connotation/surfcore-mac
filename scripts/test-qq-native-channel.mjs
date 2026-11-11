import assert from 'node:assert/strict';
import { createNativeQQChannel } from '../src/core/qq-native-channel.js';

let role = { id: 'fixture', epoch: 1 }, allowed = true, online = true, unknown = false, sends = 0, records = 0, completed = 0, lastOptions;
const memory = {
  exportNativeSources: async key => ({ ok: true, packet: { key } }),
  authorizeSend: async () => ({ ok: true, lease: {} }),
  validate: async () => ({ ok: true }),
  recordSent: async (_lease, data) => { records++; assert.ok(['delivered', 'delivery_unknown'].includes(data.deliveryState)); return { ok: true }; },
  retire: async (_key, options) => { assert.equal(options.preserveSources, true); },
};
const channel = createNativeQQChannel({ memory, getCharacter: () => role, getIdentity: async () => ({ ok: online, verified: online, accountId: '100' }),
  isAllowed: () => allowed, getCapabilities: () => ({ ok: true, voice: { enabled: true, maxChars: 120 } }), send: async (_key, _text, options) => { lastOptions = options; await options.validate(); sends++; if (unknown) throw Error('lost after dispatch'); return { ok: true, messageId: '123' }; }, onComplete: () => { completed++; } });
const first = channel.begin('private:200', role, 4).request;
const rpc = (action, body = {}, request = first) => channel.request({ ...request, action, ...body });
assert.equal(channel.begin('private:200', role, 5).code, 'MEMORY_QQ_BUSY');
assert.equal((await rpc('sources', { requestId: 'foreign' })).ok, false);
assert.equal((await rpc('sources', { unexpected: true })).code, 'MEMORY_FIELD_FORBIDDEN');
assert.equal((await rpc('capabilities')).voice.enabled, true);
assert.equal((await rpc('authorize', { loginAccountId: '101' })).code, 'MEMORY_QQ_IDENTITY_CHANGED');
const lease = (await rpc('authorize', { loginAccountId: '100' })).lease;
const sent = await rpc('send', { lease, text: 'complete reply' });
assert.equal(sent.deliveryState, 'delivered'); assert.equal(sends, 1); assert.equal(records, 1);
assert.equal((await rpc('send', { lease, text: 'again' })).ok, false); assert.equal(sends, 1);
assert.equal((await rpc('record', { lease, text: 'complete reply', messageId: '123', deliveryState: 'delivered' })).ok, true); assert.equal(records, 1);
assert.equal((await rpc('record', { lease, text: 'changed', messageId: '123', deliveryState: 'delivered' })).code, 'MEMORY_QQ_RECEIPT_MISMATCH');
await rpc('retire'); await rpc('complete', { ok: true }); await rpc('complete', { ok: true }); assert.equal(completed, 1);
const second = channel.begin('private:200', role, 5).request;
const next = (action, body = {}) => rpc(action, body, second);
unknown = true;
const uncertainLease = (await next('authorize', { loginAccountId: '100' })).lease;
const uncertain = await next('send', { lease: uncertainLease, text: 'uncertain' });
assert.equal(uncertain.code, 'MEMORY_QQ_DELIVERY_UNKNOWN'); assert.ok(uncertain.hint); assert.equal(records, 2);
await next('send', { lease: uncertainLease, text: 'uncertain' }); assert.equal(sends, 2);
await next('complete', { ...uncertain, ok: false });
const third = channel.begin('group:300', role, 1).request;
role = { ...role, epoch: 2 };
assert.equal((await rpc('sources', {}, third)).code, 'MEMORY_QQ_JOB_STALE');
assert.equal(sends, 2);
role = { id: 'fixture', epoch: 2 }; unknown = false;
const voiceJob = channel.begin('group:300', role, 2).request;
const voiceRpc = (action, body = {}) => rpc(action, body, voiceJob);
const voiceLease = (await voiceRpc('authorize', { loginAccountId: '100' })).lease;
assert.equal((await voiceRpc('send', { lease: voiceLease, text: 'hello', delivery: 'file' })).code, 'MEMORY_QQ_OUTPUT_INVALID');
assert.equal((await voiceRpc('send', { lease: voiceLease, text: 'hello', delivery: 'voice' })).ok, true);
assert.equal(lastOptions.delivery, 'voice');
assert.equal((await voiceRpc('record', { lease: voiceLease, text: 'hello', messageId: '123', deliveryState: 'delivered', delivery: 'text' })).code, 'MEMORY_QQ_RECEIPT_MISMATCH');
await voiceRpc('retire');
assert.equal(lastOptions.signal.aborted, true);
await assert.rejects(lastOptions.validate(), error => !!error.code && !!error.hint);
console.log('PASS Native QQ transport: private job binding, single-use send, atomic real receipt, unknown no replay, role drift and completion');
