import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQQMemoryBridge } from '../src/core/memory-v2-qq.js';
import { deriveMemoryProviderRouteId } from '../src/core/memory-v2-routing.js';
import { digest } from '../src/core/memory-v2-contract.js';

assert.notEqual(deriveMemoryProviderRouteId({ provider: 'a/b', model: 'c' }).providerRouteId, deriveMemoryProviderRouteId({ provider: 'a', model: 'b/c' }).providerRouteId);
assert.equal(deriveMemoryProviderRouteId({ provider: '', model: 'c' }).code, 'MEMORY_PROVIDER_ROUTE_REQUIRED');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v2-qq-'));
let role = { id: 'test', epoch: 1 }, revision = 1, route = { ok: true, backend: 'v2', descriptor: { generation: 'one' } }, failIngest = false, unknown = false, captureFailure = false;
const contexts = new Map(), events = new Map(), receipts = new Map(), calls = { captures: [], ingests: [], receipts: [], binds: [] };
let sequence = 0;
const client = {
  async capture(conversationKey, { sourceFacts }) {
    calls.captures.push({ conversationKey, sourceFacts });
    if (captureFailure) return { ok: false, code: 'MEMORY_HOST_UNAVAILABLE', error: 'Host down', hint: 'Check Host.' };
    const handle = `handle-${++sequence}`, sourceStamp = { characterId: role.id, capturedEpoch: role.epoch, channel: 'qq', conversationKey, sourceAccountKey: `qq:${sourceFacts.actorAccountId}`, requesterAccountKey: `qq:${sourceFacts.direction === 'outbound' && sourceFacts.conversationType === 'private' ? sourceFacts.conversationId : sourceFacts.actorAccountId}`, audiencePolicyId: 'policy', policyRevision: revision, bindingRevision: 1, deletionRevision: revision, controlRevision: revision, providerRouteId: 'route', processingGrantId: 'grant', purpose: 'conversation', requestId: handle, storeGeneration: 'generation' };
    contexts.set(handle, { stamp: sourceStamp, revision, refs: [] }); return { ok: true, handle, sourceStamp, expiresAt: Date.now() + 300000 };
  },
  async registerProducer(handle, producer, operationId) { return { ok: true, registrationId: `registration:${producer.segmentId}` }; },
  async replayProducer({ registrationId, batch, operationId }) { return this.ingest(null, batch, operationId); },
  async queryProducerReceipt({ registrationId, operationId }) { return this.receipt(null, operationId); },
  async ingest(handle, batch, operationId) {
    calls.ingests.push(operationId);
    if (failIngest) return { ok: false, code: 'MEMORY_HOST_UNAVAILABLE', error: 'Host down', hint: 'Check original receipt.' };
    for (const event of batch.events) events.set(event.eventId, event);
    const result = { ok: true, operationState: 'completed', sourceState: 'committed', nextOffset: batch.nextOffset, eventRefs: batch.events.map(event => ({ type: 'event', id: event.eventId, revision: 1, payloadDigest: event.payloadDigest })) };
    receipts.set(operationId, result);
    return unknown ? { ok: false, code: 'MEMORY_OPERATION_UNKNOWN', error: 'Connection lost after commit', hint: 'Query original receipt.' } : result;
  },
  async receipt(handle, operationId) { calls.receipts.push(operationId); return receipts.get(operationId) ?? { ok: false, code: 'MEMORY_RECEIPT_UNKNOWN', error: 'Unknown', hint: 'Keep pending.' }; },
  async bindActualInput(handle, refs) { calls.binds.push(structuredClone(refs)); const context = contexts.get(handle); if (!context || context.revision !== revision) return { ok: false, code: 'MEMORY_DELETION_STALE', error: 'Revoked', hint: 'Prepare again.' }; context.refs.push(...refs); return { ok: true }; },
  async validate(handle) { const context = contexts.get(handle); return context && context.revision === revision ? { ok: true } : { ok: false, code: 'MEMORY_DELETION_STALE', error: 'Revoked', hint: 'Retire the session.' }; },
  async release(handle) { contexts.delete(handle); return { ok: true }; },
};
const prepareContext = async (request, { handle }) => ({ ok: true, text: 'trusted persona + authorized recall', memoryHandle: handle, preparedHandle: 'prepared', inputManifest: contexts.get(handle).refs });
const bridge = createQQMemoryBridge({ stateDir: root, getCharacter: () => role, getRouting: () => route, client, prepareContext });
const source = (objectId, text = 'complete current input') => ({ key: 'group:300', loginAccountId: '100', actorAccountId: '200', objectId: String(objectId), text, expectedCharacter: structuredClone(role) });
try {
  const unsafe = await bridge.validateSessionSafety({ sessionId: 'sid', preset: 'qq-safe' }); assert.equal(unsafe.code, 'MEMORY_PRESET_UNSAFE'); assert.ok(unsafe.hint);
  const publicClaim = createQQMemoryBridge({ stateDir: root, getCharacter: () => role, getRouting: () => route, client, prepareContext, getSessionMemorySafety: () => ({ ok: true, sessionId: 'sid', preset: 'qq-safe' }) }); assert.equal((await publicClaim.validateSessionSafety({ sessionId: 'sid', preset: 'qq-safe' })).code, 'MEMORY_PRESET_UNSAFE');
  const first = await bridge.captureSource(source(1, 'complete '.repeat(1000) + 'token=abcdef1234567890'));
  assert.equal(first.sourceState, 'committed'); assert.ok([...events.values()][0].content.length > 600); assert.ok(![...events.values()][0].content.includes('abcdef1234567890'));
  assert.equal(calls.captures[0].conversationKey, 'qq:100:group:300'); assert.equal(calls.captures[0].sourceFacts.actorAccountId, '200');
  await bridge.captureSource({ ...source(2), actorAccountId: '201' });
  const prepared = await bridge.prepareReply({ key: 'group:300' }); assert.equal(prepared.ok, true); assert.equal(prepared.inputManifest.length, 2); assert.match(prepared.text, /qq:201/);
  assert.equal((await bridge.validate('group:300', { prepared: true })).ok, true);
  const lease = await bridge.authorizeSend({ key: 'group:300', loginAccountId: '100', objectId: 'send:one' }); assert.equal(lease.ok, true);
  role = { id: 'test', epoch: 2 };
  const sent = await bridge.recordSent(lease.lease, { text: 'actually sent under original role', messageId: '44', deliveryState: 'delivered' });
  assert.equal(sent.acceptance, 'queued_durable'); assert.equal(sent.sourceState, 'pending'); assert.equal((await bridge.drainPending()).outcomes[0].sourceState, 'committed');
  assert.equal((await bridge.recordSent(lease.lease, { text: 'reuse' })).code, 'MEMORY_SOURCE_LEASE_REQUIRED');
  assert.equal((await bridge.validate('group:300')).code, 'CHARACTER_EPOCH_STALE');
  const noRoleRewrite = [...fs.readdirSync(path.join(root, 'memory-v2', 'qq-producer', 'test', '1'))].filter(name => name.endsWith('.jsonl')).map(name => fs.readFileSync(path.join(root, 'memory-v2', 'qq-producer', 'test', '1', name), 'utf8')).join('');
  assert.ok(noRoleRewrite.includes('actually sent under original role')); assert.ok(noRoleRewrite.includes('"capturedEpoch":1'));
  unknown = true;
  const lost = await bridge.captureSource(source(3)); assert.equal(lost.acceptance, 'queued_durable'); const originalOperation = calls.ingests.at(-1), count = calls.ingests.length;
  unknown = false; assert.equal((await bridge.drainPending('group:300')).outcomes.at(-1).sourceState, 'committed'); assert.equal(calls.ingests.length, count); assert.equal(calls.receipts.at(-1), originalOperation);
  captureFailure = true; const rejected = await bridge.captureSource(source(4)); assert.equal(rejected.sourceState, 'not_saved'); captureFailure = false;
  await bridge.captureSource(source(5)); assert.equal((await bridge.prepareReply({ key: 'group:300' })).ok, true); revision++; assert.equal((await bridge.validate('group:300')).ok, false);
  const badMetadataRoot = path.join(root, 'bad-metadata');
  const badMetadata = createQQMemoryBridge({ stateDir: badMetadataRoot, getCharacter: () => role, getRouting: () => route, client, prepareContext });
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (String(to).startsWith(badMetadataRoot)) throw Object.assign(new Error('fixture metadata write denied'), { code: 'EACCES' }); return originalRename(from, to); };
    const failed = await badMetadata.captureSource(source(50)); assert.equal(failed.sourceState, 'not_saved'); assert.equal(failed.code, 'MEMORY_SPOOL_METADATA_FAILED'); assert.ok(failed.hint); assert.notEqual(failed.acceptance, 'queued_durable');
  } finally { fs.renameSync = originalRename; }
  route = { ok: false, code: 'MEMORY_ROUTING_INVALID', error: 'Invalid', hint: 'Check control.' }; assert.equal((await bridge.validate('group:300')).code, 'MEMORY_ROUTING_INVALID');
  route = { ok: true, backend: 'v1' }; assert.equal((await bridge.captureSource(source(6))).code, 'MEMORY_BACKEND_CHANGED'); assert.equal((await bridge.validate('group:300')).code, 'MEMORY_BACKEND_CHANGED');
  const freshLegacy = createQQMemoryBridge({ stateDir: root, getCharacter: () => role, getRouting: () => route, client, prepareContext }); assert.equal((await freshLegacy.captureSource(source(6))).backend, 'v1'); assert.equal((await freshLegacy.validate('group:300')).backend, 'v1');
  console.log('PASS QQ adapter: complete redacted sources, account/actor identities, full manifests, original-epoch send lease, unknown receipt, revocation and fail-closed routing');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
