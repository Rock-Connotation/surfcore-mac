import assert from 'node:assert/strict';
import { digest, eventDigest, normalizeEvent } from '../../../src/core/memory-v2-contract.js';

const character = { id: 'alpha', epoch: 1 }, conversationKey = 'qq:1:group:2';
const facts = { loginAccountId: '1', actorAccountId: '3', conversationType: 'group', conversationId: '2', objectId: 'message-one', direction: 'inbound' };
function source(sourceFacts = facts, text = 'original group text') {
  const key = `qq:${sourceFacts.loginAccountId}:${sourceFacts.conversationType}:${sourceFacts.conversationId}`;
  const segmentId = digest([character.id, character.epoch, key, sourceFacts.objectId, sourceFacts.direction]);
  const events = normalizeEvent({ eventId: 'qq-event:' + digest([character.id, character.epoch, key, sourceFacts.objectId, sourceFacts.direction]), operationId: `qq-source:${segmentId}`, sourceKey: `qq-source:${digest([key, sourceFacts.objectId, sourceFacts.direction])}`, producerId: `qq:${sourceFacts.loginAccountId}:actor:${sourceFacts.actorAccountId}`, segmentId, producerSeq: 1, occurredAt: '2026-11-11T00:00:00.000Z', content: text, coverage: { deliveryState: sourceFacts.direction === 'outbound' ? 'delivered' : 'received', platformMessageId: null } }, { characterId: character.id, capturedEpoch: character.epoch, channel: 'qq', conversationKey: key, sourceAccountKey: `qq:${sourceFacts.actorAccountId}`, audiencePolicyId: 'policy-fixture', processingGrantId: 'grant-fixture' });
  return { sourceFacts, events, eventRefs: events.map(event => ({ type: 'event', id: event.eventId, revision: 1, payloadDigest: event.payloadDigest })) };
}
const { buildQQV2SourcePacket } = await import('../lib/qq-v2-source-packet.mjs');
const build = sources => buildQQV2SourcePacket({ character, conversationKey, sources });
const denied = value => { assert.equal(value?.ok, false, JSON.stringify(value)); assert.ok(value.code && value.error && value.hint); };
const one = source(), two = source({ ...facts, actorAccountId: '4', objectId: 'message-two' }, 'second actual actor');
const valid = build([one, two]);
assert.equal(valid.ok, true, JSON.stringify(valid)); assert.equal(valid.eventRefs.length, 2);
assert.ok(valid.content[0].text.includes('original group text')); assert.ok(valid.content[0].text.includes('second actual actor'));
assert.deepEqual(valid.actors, ['qq:3', 'qq:4']); assert.equal(valid.coverage, 'text-only'); assert.equal(valid.authority, 'requires-kernel-binding');
assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.eventRefs) && Object.isFrozen(valid.content[0]));
assert.deepEqual(one.events, source().events, 'Building a source packet must not alter the original spool.');
const segmented = source(facts, '甲'.repeat(30_000)); assert.ok(segmented.events.length > 1);
assert.equal(build([segmented]).ok, true);
for (const mutate of [
  input => { input.events[0].content = 'forged text'; },
  input => { input.eventRefs[0].payloadDigest = 'f'.repeat(64); },
  input => { input.sourceFacts.actorAccountId = '4'; },
  input => { input.sourceFacts.conversationType = 'private'; input.sourceFacts.conversationId = '3'; },
  input => { input.sourceFacts.objectId = 'different-message'; },
  input => { input.eventRefs.push({ ...input.eventRefs[0] }); },
  input => { input.events.push({ ...input.events[0] }); },
  input => { input.events[0] = normalizeEvent({ eventId: 'foreign', operationId: 'foreign-op', sourceKey: 'foreign-source', producerId: 'foreign', segmentId: 'foreign-segment', producerSeq: 1, content: 'foreign' }, { characterId: 'beta', capturedEpoch: 1, channel: 'qq', conversationKey, sourceAccountKey: 'qq:3', audiencePolicyId: 'foreign-policy', processingGrantId: 'foreign-grant' })[0]; input.eventRefs[0] = { type: 'event', id: input.events[0].eventId, revision: 1, payloadDigest: input.events[0].payloadDigest }; },
]) { const input = structuredClone(one); mutate(input); denied(build([input])); }
const missing = structuredClone(segmented); missing.events.pop(); missing.eventRefs.pop(); denied(build([missing]));
const reversed = structuredClone(segmented); reversed.events.reverse(); reversed.eventRefs.reverse(); denied(build([reversed]));
denied(build([])); denied(build([one, one]));
const owner = source({ ...facts, actorAccountId: '1', objectId: 'send-operation', direction: 'outbound' }, 'confirmed previous reply');
assert.equal(build([owner]).ok, true);
const uncertain = structuredClone(owner); uncertain.events[0].coverage.deliveryState = 'delivery_unknown'; denied(build([uncertain]));
let getterCalls = 0; const hostile = Object.defineProperty({}, 'sourceFacts', { enumerable: true, get() { getterCalls++; return facts; } });
denied(build([hostile])); assert.equal(getterCalls, 0);
let proxyCalls = 0; const proxy = new Proxy(one, { ownKeys() { proxyCalls++; return Reflect.ownKeys(one); } });
denied(build([proxy])); assert.equal(proxyCalls, 0);
assert.equal(build([source(facts, 'token=example-fixture-value')]).ok, true, 'Only the already redacted Core event text is rendered.');
const privateFacts = { ...facts, conversationType: 'private', conversationId: '3' }, privateSource = source(privateFacts);
assert.equal(buildQQV2SourcePacket({ character, conversationKey: 'qq:1:private:3', sources: [privateSource] }).ok, true);
denied(build([privateSource]));
denied(buildQQV2SourcePacket({ character, conversationKey: 'qq:1:private:3', sources: [source({ ...privateFacts, actorAccountId: '4' })] }));
denied(buildQQV2SourcePacket({ character: { ...character, epoch: 2 }, conversationKey, sources: [one] }));
denied(buildQQV2SourcePacket({ character, conversationKey, sources: [one], attachments: [{ type: 'image' }] }));
const unknownDelivery = structuredClone(owner); unknownDelivery.events[0].coverage.deliveryState = 'delivery_unknown';
unknownDelivery.events[0].payloadDigest = eventDigest(unknownDelivery.events[0]); unknownDelivery.eventRefs[0].payloadDigest = unknownDelivery.events[0].payloadDigest;
denied(build([unknownDelivery]));
let arrayGetterCalls = 0; const arrayGetter = []; Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { arrayGetterCalls++; return one; } });
denied(build(arrayGetter)); assert.equal(arrayGetterCalls, 0);
console.log('QQ source packet: PASS (complete ordered source parts; Kernel binding still required)');
