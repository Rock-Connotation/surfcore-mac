import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQQMemoryBridge } from '../src/core/memory-v2-qq.js';
import { buildQQV2SourcePacket } from '../plugins/surfcore/lib/qq-v2-source-packet.mjs';

const root = path.resolve('_backups/memory-v2-qq-native-source-export', randomUUID());
fs.mkdirSync(root, { recursive: true });
let role = { id: 'fixture', epoch: 1 }, route = { ok: true, backend: 'v2', descriptor: { generation: 'one' } }, revision = 1, seq = 0;
const contexts = new Map(), stored = new Map();
let validateHook = null;
const denied = { ok: false, code: 'MEMORY_PREPARED_STALE', error: 'Prepared context expired.', hint: 'Prepare a fresh context.' };
const client = {
  async capture(conversationKey, { sourceFacts }) {
    const handle = `h-${++seq}`;
    const sourceStamp = { characterId: role.id, capturedEpoch: role.epoch, channel: 'qq', conversationKey, sourceAccountKey: `qq:${sourceFacts.actorAccountId}`, requesterAccountKey: `qq:${sourceFacts.actorAccountId}`, audiencePolicyId: 'policy', policyRevision: revision, bindingRevision: 1, deletionRevision: revision, controlRevision: revision, providerRouteId: 'route', processingGrantId: 'grant', purpose: 'conversation', requestId: handle, storeGeneration: 'generation' };
    contexts.set(handle, { refs: [], revision }); return { ok: true, handle, sourceStamp };
  },
  async registerProducer(handle, producer) { return { ok: true, registrationId: `r:${producer.segmentId}` }; },
  async ingest(handle, batch) {
    for (const event of batch.events) stored.set(event.eventId, event);
    return { ok: true, sourceState: 'committed', nextOffset: batch.nextOffset, eventRefs: batch.events.map(event => ({ type: 'event', id: event.eventId, revision: 1, payloadDigest: event.payloadDigest })) };
  },
  async bindActualInput(handle, refs) {
    const ctx = contexts.get(handle); if (!ctx || ctx.revision !== revision) return denied;
    ctx.refs.push(...structuredClone(refs)); return { ok: true };
  },
  async validate(handle, preparedHandle) {
    if (validateHook) await validateHook();
    const ctx = contexts.get(handle); return ctx && ctx.revision === revision && preparedHandle === 'prepared' ? { ok: true } : denied;
  },
  async release(handle) { contexts.delete(handle); return { ok: true }; },
};
const bridge = createQQMemoryBridge({ stateDir: root, getCharacter: () => role, getRouting: () => route, client,
  prepareContext: async (_, { handle }) => ({ ok: true, text: 'rendered recall', preparedHandle: 'prepared', inputManifest: structuredClone(contexts.get(handle).refs) }) });
const good = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result; };
const bad = result => { assert.equal(result?.ok, false, JSON.stringify(result)); assert.ok(result.code && result.error && result.hint, JSON.stringify(result)); return result; };
const add = async (objectId, actor, text, key = 'group:300') => good(await bridge.captureSource({ key, loginAccountId: '100', actorAccountId: actor, objectId, direction: 'inbound', text }));
await add('one', '200', '先前');
const long = '多字节🌊'.repeat(14000);
await add('two', '201', long);
await add('private', '202', '私密信息', 'private:202');
good(await bridge.prepareReply({ key: 'group:300' }));
const spoolDir = path.join(root, 'memory-v2', 'qq-producer', role.id, String(role.epoch));
const files = fs.readdirSync(spoolDir).filter(name => name.endsWith('.jsonl')).map(name => path.join(spoolDir, name));
const bytesBeforeExport = files.map(file => fs.readFileSync(file));
const first = good(await bridge.exportNativeSources('group:300'));
files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), bytesBeforeExport[index]));
assert.equal(first.authority, 'requires-kernel-binding');
assert.deepEqual(first.packet.character, role);
assert.equal(first.packet.conversationKey, 'qq:100:group:300');
assert.equal(first.packet.sources.length, 2);
assert.deepEqual(first.packet.sources.map(source => source.sourceFacts.actorAccountId), ['200', '201']);
assert.equal(first.packet.sources[1].events.map(event => event.content).join(''), long);
assert.ok(first.packet.sources[1].events.length > 1);
assert.equal(good(buildQQV2SourcePacket(first.packet)).authority, 'requires-kernel-binding');
assert.ok(!JSON.stringify(first.packet).includes('私密信息'));
first.packet.sources[0].events[0].content = 'changed';
assert.equal(good(await bridge.exportNativeSources('group:300')).packet.sources[0].events[0].content, '先前');
good(await bridge.prepareReply({ key: 'private:202' }));
assert.equal(good(await bridge.exportNativeSources('private:202')).packet.sources.length, 1);
assert.ok(!JSON.stringify(good(await bridge.exportNativeSources('private:202')).packet).includes('先前'));
const target = files.find(file => fs.readFileSync(file, 'utf8').includes('先前'));
const original = fs.readFileSync(target);
fs.writeFileSync(target, Buffer.from(original.toString('utf8').replace('先前', '改动')));
bad(await bridge.exportNativeSources('group:300'));
fs.writeFileSync(target, original);
fs.writeFileSync(target, Buffer.concat([original, original]));
bad(await bridge.exportNativeSources('group:300'));
fs.writeFileSync(target, original);
fs.writeFileSync(target, Buffer.alloc(0));
bad(await bridge.exportNativeSources('group:300'));
fs.writeFileSync(target, original);
const multipartFile = files.find(file => fs.readFileSync(file, 'utf8').includes('多字节'));
const multipartOriginal = fs.readFileSync(multipartFile);
const multipartLines = multipartOriginal.toString('utf8').trimEnd().split('\n');
assert.ok(multipartLines.length > 1);
fs.writeFileSync(multipartFile, multipartLines.slice(0, -1).join('\n') + '\n');
bad(await bridge.exportNativeSources('group:300'));
fs.writeFileSync(multipartFile, multipartOriginal);
good(await bridge.exportNativeSources('group:300'));
validateHook = async () => { route = { ok: true, backend: 'v2', descriptor: { generation: 'two' } }; validateHook = null; };
bad(await bridge.exportNativeSources('group:300'));
route = { ok: true, backend: 'v2', descriptor: { generation: 'one' } };
validateHook = async () => { role = { id: 'fixture', epoch: 2 }; validateHook = null; };
bad(await bridge.exportNativeSources('group:300'));
role = { id: 'fixture', epoch: 1 };
revision++; bad(await bridge.exportNativeSources('group:300')); revision--;
route = { ok: true, backend: 'v2', descriptor: { generation: 'two' } }; bad(await bridge.exportNativeSources('group:300'));
route = { ok: true, backend: 'v2', descriptor: { generation: 'one' } };
role = { id: 'fixture', epoch: 2 }; bad(await bridge.exportNativeSources('group:300')); role = { id: 'fixture', epoch: 1 };
validateHook = async () => { await bridge.retire('group:300'); validateHook = null; };
bad(await bridge.exportNativeSources('group:300'));
bad(await bridge.exportNativeSources('group:300'));
const oversizeBridge = createQQMemoryBridge({ stateDir: path.join(root, 'oversize'), getCharacter: () => role, getRouting: () => route, client,
  prepareContext: async (_, { handle }) => ({ ok: true, text: '', preparedHandle: 'prepared', inputManifest: structuredClone(contexts.get(handle).refs) }) });
good(await oversizeBridge.captureSource({ key: 'group:300', loginAccountId: '100', actorAccountId: '200', objectId: 'huge', direction: 'inbound', text: '这是一个人工样本，非机密。 '.repeat(60000) }));
good(await oversizeBridge.prepareReply({ key: 'group:300' }));
assert.equal(bad(await oversizeBridge.exportNativeSources('group:300')).code, 'MEMORY_SOURCE_EXPORT_TOO_LARGE');
const manyParts = '这是一个人工样本，非机密。 '.repeat(250000);
good(await oversizeBridge.captureSource({ key: 'group:302', loginAccountId: '100', actorAccountId: '200', objectId: 'many-parts', direction: 'inbound', text: manyParts }));
good(await oversizeBridge.prepareReply({ key: 'group:302' }));
const refLimit = bad(await oversizeBridge.exportNativeSources('group:302'));
assert.equal(refLimit.code, 'MEMORY_SOURCE_EXPORT_TOO_LARGE');
assert.match(refLimit.error, /reference limit/);
for (let index = 0; index < 9; index++) await add(`history-${index}`, '200', `history ${index}`, 'group:301');
good(await bridge.prepareReply({ key: 'group:301' }));
const bounded = good(await bridge.exportNativeSources('group:301'));
assert.equal(bounded.packet.sources.length, 7);
assert.deepEqual(bounded.packet.sources.map(source => source.sourceFacts.objectId), Array.from({ length: 7 }, (_, index) => `history-${index + 2}`));
const legacy = createQQMemoryBridge({ stateDir: path.join(root, 'v1'), getCharacter: () => role, getRouting: () => ({ ok: true, backend: 'v1' }), client });
bad(await legacy.exportNativeSources('group:300'));
console.log('QQ Native source export: PASS (synthetic spools only)');
