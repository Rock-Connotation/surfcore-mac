import { types, isDeepStrictEqual } from 'node:util';
import { deriveBiliV2PublicSourceSet } from './bili-v2-public-source-set.mjs';

// Copy only data descriptors, rejecting proxies before any observable operation.
export function safeData(value, seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw new Error('untrusted');
  seen.add(value);
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) || Object.getOwnPropertySymbols(value).length) throw new Error('untrusted');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = array ? [] : {};
  if (array && (!Number.isSafeInteger(descriptors.length?.value) || descriptors.length.value > 128 || Object.keys(descriptors).length !== descriptors.length.value + 1)) throw new Error('untrusted');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('untrusted');
    Object.defineProperty(result, key, { value: safeData(descriptor.value, seen), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return result;
}

export function verifyPublicSet(scope, job, accountMid) {
  try {
    const copy = safeData(scope.publicSourceSet);
    const derived = deriveBiliV2PublicSourceSet({ characterId: job.characterId, characterEpoch: job.characterEpoch, accountMid, providerRouteId: job.providerRouteId, selectors: copy.selectors, outputTarget: copy.outputTarget });
    return derived.ok && isDeepStrictEqual(copy, derived) && isDeepStrictEqual(scope.target, derived.outputTarget) ? derived : null;
  } catch { return null; }
}
export function memberFor(set, selector) {
  return set.sourceConversations.find((entry) => isDeepStrictEqual(entry.selector, selector));
}
export function sameData(a, b) { return isDeepStrictEqual(a, b); }
