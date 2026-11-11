const KEYS = ['loginAccountId', 'actorAccountId', 'conversationType', 'conversationId', 'objectId'];
const ALL_KEYS = [...KEYS, 'direction'];
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const OBJECT_ID = /^-?[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/;
const fail = (code, error) => ({ ok: false, code, error, hint: 'Check the current official QQ login, approved conversation list and original platform message ID before capturing again.' });

export function validateQQSourceFacts(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || KEYS.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !ALL_KEYS.includes(key))) return fail('MEMORY_SOURCE_FACTS_INVALID', 'QQ source facts require the exact bounded platform fields.');
  if (!['loginAccountId', 'actorAccountId', 'conversationId'].every((key) => typeof value[key] === 'string' && DECIMAL.test(value[key])) || !['group', 'private'].includes(value.conversationType) || typeof value.objectId !== 'string' || !OBJECT_ID.test(value.objectId) || (value.direction !== undefined && !['inbound', 'outbound'].includes(value.direction))) return fail('MEMORY_SOURCE_FACTS_INVALID', 'QQ source facts require decimal IDs and a stable original message ID.');
  return { ok: true, sourceFacts: { ...Object.fromEntries(KEYS.map((key) => [key, value[key]])), direction: value.direction ?? 'inbound' } };
}

/** The first argument comes only from fresh Host channel state, never the request body. */
export function resolveQQMemoryIdentity({ accountId, allowedGroups = [], allowedPrivates = [], providerRouteId } = {}, sourceFacts) {
  const checked = validateQQSourceFacts(sourceFacts);
  if (!checked.ok) return checked;
  if (typeof accountId !== 'string' || !DECIMAL.test(accountId) || !Array.isArray(allowedGroups) || !Array.isArray(allowedPrivates) || [...allowedGroups, ...allowedPrivates].some((id) => typeof id !== 'string' || !DECIMAL.test(id)) || typeof providerRouteId !== 'string' || !ROUTE.test(providerRouteId)) return fail('MEMORY_IDENTITY_REQUIRED', 'The authoritative QQ channel state is unavailable.');
  const facts = checked.sourceFacts;
  if (facts.loginAccountId !== accountId) return fail('MEMORY_IDENTITY_REQUIRED', 'The observed QQ login differs from the current Host login.');
  const allowed = facts.conversationType === 'group' ? allowedGroups : allowedPrivates;
  if (!allowed.includes(facts.conversationId) || (facts.direction === 'outbound' && facts.actorAccountId !== accountId) || (facts.direction === 'inbound' && facts.conversationType === 'private' && facts.actorAccountId !== facts.conversationId)) return fail('MEMORY_IDENTITY_REQUIRED', 'The QQ conversation or private sender is not authorized by current Host state.');
  return { channel: 'qq', conversationKey: `qq:${accountId}:${facts.conversationType}:${facts.conversationId}`, sourceAccountKey: `qq:${facts.actorAccountId}`, requesterAccountKey: `qq:${facts.conversationType === 'private' && facts.direction === 'outbound' ? facts.conversationId : facts.actorAccountId}`, providerRouteId, purpose: 'conversation' };
}
