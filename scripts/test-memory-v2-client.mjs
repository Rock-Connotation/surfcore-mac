import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryClient } from '../src/core/memory-v2-client.js';

const root = path.resolve('_backups/memory-v2-host', `client-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const file = path.join(root, 'qq-bridge.json'), prefix = '/dsh-surfcore/memory-v2-api';
const record = { version: 1, baseUrl: 'http://127.0.0.1:12345', api: prefix, scope: 'qq-bridge', token: 'a'.repeat(64) };
function save(value = record) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); }
function bad(result, code) { assert.equal(result?.ok, false, JSON.stringify(result)); assert.equal(result.code, code); assert.ok(result.error && result.hint); assert.ok(!JSON.stringify(result).includes('SECRET_SOURCE')); return result; }
function okay(value) { assert.equal(value?.ok, true, JSON.stringify(value)); return value; }
const calls = [], client = createMemoryClient({ discoveryFile: file, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return Response.json({ ok: true }); } });
save();
const commands = [
  [() => client.status(), undefined],
  [() => client.capture('login:private:a'), { action: 'capture', conversationKey: 'login:private:a' }],
  [() => client.ingest('handle', [{ eventId: 'one' }], 'batch'), { action: 'ingest', handle: 'handle', events: [{ eventId: 'one' }], operationId: 'batch' }],
  [() => client.receipt('handle', 'batch'), { action: 'receipt', handle: 'handle', operationId: 'batch' }],
  [() => client.registerProducer('handle', { producerId: 'producer', segmentId: 'segment' }, 'register'), { action: 'registerProducer', handle: 'handle', producerId: 'producer', segmentId: 'segment', operationId: 'register' }],
  [() => client.replayProducer({ registrationId: 'registered', batch: { events: [] }, operationId: 'replay' }), { action: 'replayProducer', registrationId: 'registered', batch: { events: [] }, operationId: 'replay' }],
  [() => client.queryProducerReceipt({ registrationId: 'registered', operationId: 'replay' }), { action: 'queryProducerReceipt', registrationId: 'registered', operationId: 'replay' }],
  [() => client.prepare('handle', 'current', { memory: 1800 }), { action: 'prepare', handle: 'handle', query: 'current', budget: { memory: 1800 } }],
  [() => client.search('handle', 'current', { limit: 4 }), { action: 'search', handle: 'handle', query: 'current', options: { limit: 4 } }],
  [() => client.validate('handle', 'prepared'), { action: 'validate', handle: 'handle', preparedHandle: 'prepared' }],
  [() => client.bindActualInput('handle', []), { action: 'bindActualInput', handle: 'handle', refs: [] }],
  [() => client.release('handle'), { action: 'release', handle: 'handle' }],
];
for (const [run, shape] of commands) {
  okay(await run()); const actual = calls.at(-1);
  assert.equal(actual.url, `${record.baseUrl}${prefix}`); assert.equal(actual.redirect, 'error');
  assert.equal(actual.headers['x-memory-v2-token'], record.token);
  assert.equal(actual.method, shape ? 'POST' : 'GET'); assert.deepEqual(shape ? JSON.parse(actual.body) : actual.body, shape);
}
console.log('PASS exact ordinary RPC JSON call shapes; no generic method, SQL, path, role or management RPC');
save({ ...record, baseUrl: 'http://127.0.0.1:54321', token: 'b'.repeat(64) }); okay(await client.status());
assert.equal(calls.at(-1).url, `http://127.0.0.1:54321${prefix}`); assert.equal(calls.at(-1).headers['x-memory-v2-token'], 'b'.repeat(64));
const before = calls.length;
for (const unsafe of [
  { baseUrl: 'https://example.com' }, { baseUrl: 'http://192.168.1.1' }, { baseUrl: 'file:///SECRET_SOURCE' },
  { baseUrl: 'http://user:fixture@localhost' }, { baseUrl: 'http://localhost/path' }, { baseUrl: 'http://localhost/?secret=x' },
  { baseUrl: 'http://localhost/#secret' }, { api: '/api/arbitrary' }, { scope: 'local-search' }, { token: '' },
]) { save({ ...record, ...unsafe }); bad(await client.status(), 'MEMORY_DISCOVERY_INVALID'); }
assert.equal(calls.length, before);
save();
if (process.platform !== 'win32') { fs.chmodSync(file, 0o644); bad(await client.status(), 'MEMORY_DISCOVERY_INVALID'); fs.chmodSync(file, 0o600); }
const link = path.join(root, 'symlink.json'); fs.symlinkSync(file, link); bad(await createMemoryClient({ discoveryFile: link }).status(), 'MEMORY_DISCOVERY_INVALID');
console.log('PASS fresh discovery, loopback-only origins, protected scope/token, size and symlink boundaries');
const requestBound = createMemoryClient({ discoveryFile: file, maxRequestBytes: 1024, fetchImpl: async () => { throw new Error('must not send'); } });
bad(await requestBound.prepare('handle', 'x'.repeat(2000)), 'MEMORY_REQUEST_TOO_LARGE');
const responseBound = createMemoryClient({ discoveryFile: file, maxResponseBytes: 1024, fetchImpl: async () => new Response(JSON.stringify({ ok: true, text: 'x'.repeat(2000) })) });
bad(await responseBound.status(), 'MEMORY_RESPONSE_TOO_LARGE');
const lengthBound = createMemoryClient({ discoveryFile: file, maxResponseBytes: 1024, fetchImpl: async () => new Response('{}', { headers: { 'content-length': '2000' } }) });
bad(await lengthBound.status(), 'MEMORY_RESPONSE_TOO_LARGE');
const rejected = createMemoryClient({ discoveryFile: file, fetchImpl: async () => Response.json({ ok: false, code: 'MEMORY_POLICY_DENIED', error: 'SECRET_SOURCE /Users/private/token', hint: 'SECRET_SOURCE' }, { status: 403 }) });
bad(await rejected.status(), 'MEMORY_POLICY_DENIED');
const readonly = createMemoryClient({ discoveryFile: file, fetchImpl: async () => Response.json({ ok: false, code: 'MEMORY_READ_ONLY', error: 'SECRET_SOURCE', hint: 'SECRET_SOURCE', retry: 'query_receipt', operationState: 'unknown' }) });
const uncertain = await readonly.ingest('handle', [], 'original'); bad(uncertain, 'MEMORY_READ_ONLY'); assert.equal(uncertain.retry, 'query_receipt'); assert.match(uncertain.hint, /original operation/);
let attempts = 0;
const timeout = createMemoryClient({ discoveryFile: file, timeoutMs: 20, fetchImpl: async (url, options) => { attempts++; return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('SECRET_SOURCE')), { once: true })); } });
bad(await timeout.ingest('handle', [], 'original'), 'MEMORY_REQUEST_TIMEOUT'); assert.equal(attempts, 1);
const unavailable = createMemoryClient({ discoveryFile: file, fetchImpl: async () => { throw new Error('SECRET_SOURCE path'); } }); bad(await unavailable.status(), 'MEMORY_HOST_UNAVAILABLE');
const malformed = createMemoryClient({ discoveryFile: file, fetchImpl: async () => Response.json({ sql: 'SECRET_SOURCE' }) }); bad(await malformed.status(), 'MEMORY_RESPONSE_INVALID');
console.log(`PASS request/response byte bounds, timeout without retries, safe structured failures, uncertain receipts on ${process.version}`);

let current = { id: 'alpha', epoch: 1 }, responseHook = null, failPreparation = false, expired = false;
const prepared = () => ({ characterId: 'alpha', capturedEpoch: 1, expiresAt: Date.now() + (expired ? -1000 : 30_000), text: 'authorized memory', inputManifest: [] });
const getCharacter = () => current;
const fetchIssued = async (url, options) => {
  const body = JSON.parse(options.body ?? '{}'); await responseHook?.();
  if (body.action === 'capture') return Response.json({ ok: true, handle: 'issued-handle', expiresAt: Date.now() + 30_000 });
  if (body.action === 'prepare') return Response.json(failPreparation ? { ok: false, code: 'MEMORY_POLICY_DENIED' } : { ok: true, preparedHandle: 'issued-prepared', prepared: prepared() });
  return Response.json({ ok: true });
};
const local = createMemoryClient({ discoveryFile: file, getCharacter, fetchImpl: fetchIssued });
const issued = okay(await local.capture('login:private:a')), packet = okay(await local.prepare(issued.handle, 'current'));
bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
okay(await local.validate(issued.handle, packet.preparedHandle)); okay(local.verifyPrepared(issued.handle, packet.preparedHandle, structuredClone(packet.prepared)));
bad(local.verifyPrepared(issued.handle, packet.preparedHandle, { ...packet.prepared, text: 'forged' }), 'MEMORY_PREPARED_UNTRUSTED');
bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
okay(await local.validate(issued.handle, packet.preparedHandle));
save({ ...record, token: 'b'.repeat(64) }); bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
save(); bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
okay(await local.validate(issued.handle, packet.preparedHandle)); current = { id: 'alpha', epoch: 2 }; bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED'); current = { id: 'alpha', epoch: 1 };
for (const mutate of [() => local.ingest(issued.handle, [], 'op'), () => local.bindActualInput(issued.handle, []), () => local.registerProducer(issued.handle, { producerId: 'p', segmentId: 's' }, 'register'), () => local.replayProducer({ registrationId: 'r', batch: {}, operationId: 'replay' })]) {
  okay(await local.validate(issued.handle, packet.preparedHandle)); okay(await mutate()); bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
}
okay(await local.validate(issued.handle, packet.preparedHandle)); failPreparation = true; bad(await local.prepare(issued.handle, 'other'), 'MEMORY_POLICY_DENIED'); failPreparation = false; bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
expired = true; const old = okay(await local.prepare(issued.handle, 'expired')); okay(await local.validate(issued.handle, old.preparedHandle)); bad(local.verifyPrepared(issued.handle, old.preparedHandle, old.prepared), 'MEMORY_PREPARED_UNTRUSTED'); expired = false;
okay(await local.release(issued.handle)); bad(local.verifyPrepared(issued.handle, packet.preparedHandle, packet.prepared), 'MEMORY_PREPARED_UNTRUSTED');
const noGetter = createMemoryClient({ discoveryFile: file, fetchImpl: fetchIssued }); bad(noGetter.verifyPrepared('x', 'y', {}), 'CHARACTER_CONTEXT_REQUIRED');
let getterNetworkCalls = 0;
const asyncGetter = createMemoryClient({ discoveryFile: file, getCharacter: async () => current, fetchImpl: async () => { getterNetworkCalls++; return Response.json({ ok: true }); } });
bad(await asyncGetter.capture('login:private:a'), 'CHARACTER_CONTEXT_REQUIRED'); assert.equal(getterNetworkCalls, 0);
responseHook = async () => { current = { id: 'beta', epoch: 2 }; };
bad(await local.capture('login:private:a'), 'CHARACTER_EPOCH_STALE'); responseHook = null;
console.log(`PASS synchronous issued-copy verification: validation ack, tamper, role, TTL, discovery rotation, mutation/release invalidation, async-getter denial on ${process.version}`);

const scopedFacts = { loginAccountId: '100', actorAccountId: '200', conversationType: 'group', conversationId: '900', objectId: '-123', direction: 'inbound' };
save(); okay(await client.capture('100:group:900', { sourceFacts: scopedFacts }));
assert.deepEqual(JSON.parse(calls.at(-1).body), { action: 'capture', conversationKey: '100:group:900', sourceFacts: scopedFacts });
assert.equal(calls.at(-1).sourceFacts, undefined);
const cursorBatch = { ok: true, producerId: 'producer', segmentId: 'segment', events: [{ eventId: 'fixture' }], startOffset: 0, nextOffset: 10, positions: [{ start: 0, end: 10 }], incompleteTail: false, segmentDigest: 'fixture' };
okay(await client.ingest('handle', cursorBatch, 'cursor-op')); assert.deepEqual(JSON.parse(calls.at(-1).body).events, cursorBatch);
console.log('PASS scoped source facts remain typed RPC data and complete spool byte cursors pass unchanged');

const invalidRegisterCalls = calls.length;
for (const extra of [{ characterId: 'beta' }, { action: 'search' }, { handle: 'other' }, { authorization: 'forged' }]) bad(await client.registerProducer('handle', { producerId: 'producer', segmentId: 'segment', ...extra }, 'forged-register'), 'MEMORY_FIELD_FORBIDDEN');
assert.equal(calls.length, invalidRegisterCalls);
const recoveryCalls = [], originalInput = { registrationId: 'producer-original', batch: cursorBatch, operationId: 'original-replay' };
const recovery = createMemoryClient({ discoveryFile: file, getCharacter: () => current, fetchImpl: async (url, options) => {
  const body = JSON.parse(options.body); recoveryCalls.push(body); current = { id: 'gamma', epoch: current.epoch + 1 };
  return Response.json({ ok: true, characterId: 'alpha', capturedEpoch: 1, operationId: body.operationId, sourceState: 'committed', nextOffset: cursorBatch.nextOffset });
} });
const recovered = okay(await recovery.replayProducer(originalInput)); assert.equal(recovered.characterId, 'alpha'); assert.equal(recovered.capturedEpoch, 1); assert.equal(recovered.nextOffset, cursorBatch.nextOffset);
okay(await recovery.queryProducerReceipt({ registrationId: originalInput.registrationId, operationId: originalInput.operationId })); assert.deepEqual(recoveryCalls[0], { action: 'replayProducer', ...originalInput });
assert.equal(recoveryCalls[1].operationId, originalInput.operationId); assert.deepEqual(originalInput.batch, cursorBatch);
okay(await recovery.queryProducerReceipt({ operationId: 'original-register' })); assert.deepEqual(recoveryCalls[2], { action: 'queryProducerReceipt', operationId: 'original-register' });
const uncertainCalls = [], uncertainProducer = createMemoryClient({ discoveryFile: file, fetchImpl: async (url, options) => { uncertainCalls.push(JSON.parse(options.body)); throw new Error('SECRET_SOURCE'); } });
for (const run of [() => uncertainProducer.registerProducer('handle', { producerId: 'producer', segmentId: 'segment' }, 'original-register'), () => uncertainProducer.replayProducer(originalInput)]) {
  const result = bad(await run(), 'MEMORY_HOST_UNAVAILABLE'); assert.equal(result.retry, 'query_receipt'); assert.equal(result.operationState, 'unknown'); assert.equal(result.sourceState, 'pending'); assert.equal(result.operationId, uncertainCalls.at(-1).operationId);
}
assert.equal(uncertainCalls.length, 2);
const phaseClient = createMemoryClient({ discoveryFile: file, fetchImpl: async () => Response.json({ ok: false, code: 'CHARACTER_EPOCH_STALE', error: 'SECRET_SOURCE', hint: 'SECRET_SOURCE', operationId: 'original-replay', sourceState: 'committed', operationState: 'completed_before_cancel', retry: 'query_receipt', selectionState: 'not_selected', indexState: 'pending' }) });
const committed = bad(await phaseClient.replayProducer(originalInput), 'CHARACTER_EPOCH_STALE'); assert.equal(committed.sourceState, 'committed'); assert.equal(committed.operationState, 'completed_before_cancel'); assert.equal(committed.operationId, originalInput.operationId); assert.equal(committed.indexState, 'pending'); assert.equal(committed.retry, 'query_receipt');
const missingOperation = createMemoryClient({ discoveryFile: file, fetchImpl: async () => Response.json({ ok: false, code: 'MEMORY_WORKER_EXITED', sourceState: 'pending', operationState: 'unknown', retry: 'query_receipt' }) });
for (const [operationId, run] of [['lost-registry-op', () => missingOperation.registerProducer('live', { producerId: 'producer', segmentId: 'segment' }, 'lost-registry-op')], ['lost-replay-op', () => missingOperation.replayProducer({ ...originalInput, operationId: 'lost-replay-op' })]]) {
  const result = bad(await run(), 'MEMORY_WORKER_EXITED'); assert.equal(result.operationId, operationId); assert.equal(result.operationState, 'unknown'); assert.equal(result.sourceState, 'pending'); assert.equal(result.retry, 'query_receipt');
}
console.log('PASS typed producer RPC, private-authority field rejection, original-role recovery, mutation ack invalidation, original operation IDs and source phases without automatic retry');
