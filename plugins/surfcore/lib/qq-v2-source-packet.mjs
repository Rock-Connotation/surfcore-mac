import { types } from 'node:util';
import { digest, redactContent, validateEvent } from '../../../src/core/memory-v2-contract.js';
import { validateQQSourceFacts } from './memory-v2-identity.mjs';

const problem = () => ({ ok: false, code: 'QQ_SOURCE_PACKET_UNPROVEN', error: 'QQ原文包不完整或身份、分片、摘要不一致。', hint: '保留原始producer片段，重新读取完整回执与同角色原文；不要用摘要、部分分片或当前账号补写来源。' });
const requirePacket = condition => { if (!condition) throw new Error('Invalid QQ source packet'); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function snapshot(value, ancestors = new WeakSet(), depth = 0) {
  requirePacket(depth <= 32);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  requirePacket(value && typeof value === 'object' && !types.isProxy(value) && !ancestors.has(value));
  requirePacket(!Object.getOwnPropertySymbols(value).length);
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
  requirePacket(array ? proto === Array.prototype && value.length <= 256 && Object.keys(descriptors).length === value.length + 1 : proto === Object.prototype || proto === null);
  ancestors.add(value);
  const copy = array ? [] : {};
  for (const key of array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(descriptors)) {
    const descriptor = descriptors[key]; requirePacket(descriptor && 'value' in descriptor && descriptor.enumerable);
    Object.defineProperty(copy, key, { value: snapshot(descriptor.value, ancestors, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  ancestors.delete(value); return copy;
}

/** Pure text assembly. A matching digest is not a Core receipt or permission. */
export function buildQQV2SourcePacket(input = {}) {
  try {
    const copied = snapshot(input), { character, conversationKey, sources } = copied;
    requirePacket(Object.keys(copied).sort().join(',') === 'character,conversationKey,sources');
    requirePacket(character && Object.keys(character).sort().join(',') === 'epoch,id' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(character.id) && Number.isSafeInteger(character.epoch) && character.epoch > 0);
    requirePacket(Array.isArray(sources) && sources.length >= 1 && sources.length <= 7 && Buffer.byteLength(JSON.stringify(sources)) <= 2 * 1024 * 1024);
    const refs = [], actors = new Set(), eventsSeen = new Set(), rootsSeen = new Set(), rendered = [];
    for (const source of sources) {
      requirePacket(source && Object.keys(source).sort().join(',') === 'eventRefs,events,sourceFacts');
      const checked = validateQQSourceFacts({ ...source.sourceFacts }); requirePacket(checked.ok);
      const facts = checked.sourceFacts, key = `qq:${facts.loginAccountId}:${facts.conversationType}:${facts.conversationId}`;
      requirePacket(key === conversationKey && (facts.direction !== 'outbound' || facts.actorAccountId === facts.loginAccountId));
      requirePacket(facts.conversationType !== 'private' || facts.direction === 'outbound' || facts.actorAccountId === facts.conversationId);
      const actor = `qq:${facts.actorAccountId}`, segmentId = digest([character.id, character.epoch, key, facts.objectId, facts.direction]);
      requirePacket(Array.isArray(source.events) && source.events.length >= 1 && source.events.length <= 128 && Array.isArray(source.eventRefs) && source.eventRefs.length === source.events.length);
      const first = source.events[0], root = first.rootEventId, count = first.partCount;
      requirePacket(source.events.length === count && /^[a-f0-9]{64}$/.test(first.wholeDigest) && !rootsSeen.has(root)); rootsSeen.add(root);
      for (let index = 0; index < source.events.length; index++) {
        const event = source.events[index], ref = source.eventRefs[index]; validateEvent(event);
        requirePacket(event.channel === 'qq' && event.characterId === character.id && event.capturedEpoch === character.epoch && event.conversationKey === key && event.actorAccountKey === actor);
        requirePacket(event.producerId === `qq:${facts.loginAccountId}:actor:${facts.actorAccountId}` && event.segmentId === segmentId && event.rootEventId === root && event.wholeDigest === first.wholeDigest && event.partCount === count && event.partIndex === index);
        requirePacket(event.coverage?.deliveryState === (facts.direction === 'inbound' ? 'received' : 'delivered'));
        requirePacket(!eventsSeen.has(event.eventId) && ref && Object.keys(ref).sort().join(',') === 'id,payloadDigest,revision,type' && ref.type === 'event' && ref.id === event.eventId && ref.revision === 1 && ref.payloadDigest === event.payloadDigest);
        eventsSeen.add(event.eventId); refs.push(ref);
      }
      actors.add(actor);
      rendered.push({ rootEventId: root, actorAccountKey: actor, direction: facts.direction, coverage: 'text-only', text: source.events.map(event => event.content).join('') });
    }
    requirePacket(refs.length <= 128);
    return freeze({ ok: true, character: { ...character }, conversationKey, coverage: 'text-only', authority: 'requires-kernel-binding', actors: [...actors], eventRefs: refs,
      content: [{ type: 'text', text: redactContent(JSON.stringify({ kind: 'qq-original-text-sources', coverage: 'text-only', sources: rendered }), { scope: 'qq' }) }] });
  } catch { return freeze(problem()); }
}
