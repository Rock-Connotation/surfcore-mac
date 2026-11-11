import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SCHEMA_VERSION = 2;
export const MAX_PART_BYTES = 64 * 1024;
export const CONTEXT_FIELDS = Object.freeze(['characterId', 'capturedEpoch', 'requestId', 'channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'audiencePolicyId', 'policyRevision', 'bindingRevision', 'deletionRevision', 'controlRevision', 'providerRouteId', 'processingGrantId', 'purpose', 'storeGeneration']);
export const fail = (code, error, hint = 'Keep V1 active. Refresh the trusted Host context and inspect memory diagnostics before retrying.') => ({ ok: false, code, error, hint });
export function requireThat(condition, code, error, hint) {
  if (!condition) throw Object.assign(new Error(error), fail(code, error, hint));
}
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'MEMORY_SCHEMA_INVALID', 'Only plain JSON values are accepted.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export const stamp = (value, secret) => createHmac('sha256', secret).update(canonical(value)).digest('hex');
export function checkStamp(value, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(stamp(value, secret), 'hex'), Buffer.from(signature, 'hex'));
}
export function identifier(value, name = 'identifier') {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value), 'MEMORY_SCHEMA_INVALID', `${name} must be a bounded stable identifier.`);
  return value;
}
export function characterId(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value), 'CHARACTER_CONTEXT_REQUIRED', 'A valid characterId is required.');
  return value;
}

// Same privacy transformations as redactForMemory, applied to the complete string without its 4000-character cap.
export function redactContent(value, { scope = 'shared' } = {}) {
  requireThat(typeof value === 'string', 'MEMORY_SCHEMA_INVALID', 'Memory content must be text.');
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\r\n?/g, '\n')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b\s*[:=：]\s*[^\s，。；]+/gi, '$1=[已隐藏]')
    .replace(/(密码|口令|密钥|令牌|验证码)\s*(?:是|为|[:=：])\s*[^\s，。；]+/g, '$1=[已隐藏]')
    .replace(/\b(?:sk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}\b/g, '[令牌已隐藏]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '[长串已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]').replace(/\b\d{15,19}\b/g, '[证件号已隐藏]')
    .replace(/https?:\/\/[^\s，。；）)]+/gi, '（链接已省略）')
    .replace(scope === 'qq' ? /$^/g : /(?<!\d)\d{5,12}(?!\d)/g, '[号码已隐藏]')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
export function splitUtf8(text, limit = MAX_PART_BYTES) {
  requireThat(Number.isInteger(limit) && limit >= 4 && limit <= MAX_PART_BYTES, 'MEMORY_SCHEMA_INVALID', 'Invalid UTF-8 part limit.');
  const parts = [];
  let current = '', size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > limit) { parts.push(current); current = ''; size = 0; }
    current += point; size += bytes;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}
export function safeHead(text, limit) {
  let end = Math.max(0, Math.floor(limit));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
function redactJson(value, scope) {
  if (typeof value === 'string') return redactContent(value, { scope });
  if (Array.isArray(value)) return value.map((item) => redactJson(item, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactContent(key, { scope }), redactJson(item, scope)]));
  requireThat(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)), 'MEMORY_SCHEMA_INVALID', 'Invalid evidence metadata.');
  return value;
}
export function eventDigest(event) {
  const { payloadDigest, ingestedAt, ...immutable } = event;
  return digest(immutable);
}
export function normalizeEvent(raw, ctx) {
  requireThat(raw && typeof raw === 'object', 'MEMORY_SCHEMA_INVALID', 'An event object is required.');
  for (const key of ['corePersona', 'policyId', 'processingGrantId', 'characterId', 'capturedEpoch', 'inputManifest', 'roots']) {
    if (key in raw) requireThat(['characterId', 'capturedEpoch'].includes(key) && raw[key] === ctx[key], 'MEMORY_FIELD_FORBIDDEN', `Event field ${key} is controlled by the Host.`);
  }
  const scope = ctx.channel === 'qq' ? 'qq' : 'shared';
  const content = redactContent(raw.content, { scope });
  requireThat(content.length > 0, 'MEMORY_SCHEMA_INVALID', 'Empty events are not accepted.');
  const certainty = raw.certainty ?? 'reported';
  requireThat(['observed', 'reported', 'inferred', 'unknown'].includes(certainty), 'MEMORY_SCHEMA_INVALID', 'Unknown certainty.');
  const attribution = raw.attribution ?? 'statement';
  requireThat(['statement', 'quote', 'joke', 'conditional', 'plan', 'action', 'reflection'].includes(attribution), 'MEMORY_SCHEMA_INVALID', 'Unknown attribution.');
  const base = {
    schemaVersion: SCHEMA_VERSION, eventId: identifier(raw.eventId, 'eventId'), operationId: identifier(raw.operationId, 'operationId'),
    sourceKey: identifier(raw.sourceKey, 'sourceKey'), producerId: identifier(raw.producerId, 'producerId'), segmentId: identifier(raw.segmentId, 'segmentId'),
    producerSeq: raw.producerSeq, characterId: characterId(ctx.characterId), capturedEpoch: ctx.capturedEpoch,
    channel: ctx.channel, conversationKey: ctx.conversationKey, actorAccountKey: ctx.sourceAccountKey,
    policyId: ctx.audiencePolicyId, processingGrantId: ctx.processingGrantId,
    occurredAt: raw.occurredAt ?? null, observedAt: raw.observedAt ?? null, timePrecision: raw.timePrecision ?? 'unknown',
    subject: redactContent(raw.subject ?? ctx.sourceAccountKey, { scope }), speaker: redactContent(raw.speaker ?? ctx.sourceAccountKey, { scope }),
    certainty, attribution, content, textCompleteness: 'complete',
    evidenceRefs: redactJson(raw.evidenceRefs ?? [], scope), coverage: redactJson(raw.coverage ?? {}, scope),
    expiresAt: raw.expiresAt ?? null,
  };
  requireThat(Number.isSafeInteger(base.producerSeq) && base.producerSeq >= 1, 'MEMORY_SCHEMA_INVALID', 'producerSeq must be a positive integer.');
  for (const key of ['occurredAt', 'observedAt', 'expiresAt']) requireThat(base[key] === null || (typeof base[key] === 'string' && Number.isFinite(Date.parse(base[key]))), 'MEMORY_SCHEMA_INVALID', `Invalid ${key}.`);
  requireThat(['unknown', 'exact', 'day', 'approximate'].includes(base.timePrecision), 'MEMORY_SCHEMA_INVALID', 'Invalid time precision.');
  const parts = splitUtf8(content);
  const wholeDigest = eventDigest(base);
  if (raw.payloadDigest !== undefined) requireThat(raw.payloadDigest === wholeDigest, 'MEMORY_DIGEST_CONFLICT', 'Event payloadDigest differs from the normalized event.');
  return parts.map((part, index) => {
    const event = { ...base, content: part, rootEventId: base.eventId, wholeDigest, partIndex: index, partCount: parts.length, textCompleteness: parts.length === 1 ? 'complete' : 'segmented' };
    if (parts.length > 1) {
      event.eventId = `${base.eventId}.part-${index + 1}-of-${parts.length}`;
      event.sourceKey = `${base.sourceKey}.part-${index + 1}-of-${parts.length}`;
      event.operationId = `${base.operationId}.part-${index + 1}-of-${parts.length}`;
    }
    event.payloadDigest = eventDigest(event);
    return event;
  });
}
export function validateEvent(event) {
  requireThat(event?.schemaVersion === SCHEMA_VERSION && event.payloadDigest === eventDigest(event), 'MEMORY_DIGEST_CONFLICT', 'Spool event schema or digest is invalid.');
  for (const key of ['eventId', 'operationId', 'sourceKey', 'producerId', 'segmentId', 'rootEventId', 'policyId', 'processingGrantId']) identifier(event[key], key);
  characterId(event.characterId);
  requireThat(typeof event.content === 'string' && Buffer.byteLength(event.content) <= MAX_PART_BYTES, 'MEMORY_SCHEMA_INVALID', 'Event parts must be at most 64 KiB.');
  requireThat(Number.isSafeInteger(event.producerSeq) && event.producerSeq >= 1 && Number.isSafeInteger(event.partIndex) && Number.isSafeInteger(event.partCount) && event.partIndex >= 0 && event.partIndex < event.partCount, 'MEMORY_SCHEMA_INVALID', 'Invalid part sequence.');
  return event;
}
export const audienceKey = (ctx) => canonical([ctx.channel, ctx.conversationKey, ctx.requesterAccountKey]);
const groupWildcard = (item) => item[0] === 'qq' && /^qq:\d+:group:\d+$/.test(item[1]) && item[2] === '*';
function normalizeAudiences(items) {
  const unique = [...new Map(items.map((item) => [canonical(item), item])).values()];
  return unique.filter((item) => groupWildcard(item) || !unique.some((other) => groupWildcard(other) && other[0] === item[0] && other[1] === item[1])).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
const normalizeGrants = (items) => [...new Map(items.map((item) => { const grant = { grantId: item.grantId, providerRouteId: item.providerRouteId }; return [canonical(grant), grant]; })).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
export function validatePolicy(policy) {
  identifier(policy?.policyId, 'policyId');
  requireThat(policy.approved === true && Array.isArray(policy.audiences) && policy.audiences.length > 0 && Array.isArray(policy.processingGrants) && policy.processingGrants.length > 0, 'MEMORY_POLICY_REQUIRED', 'An explicitly approved audience and processing policy is required.');
  policy.audiences.forEach((item) => {
    requireThat(Array.isArray(item) && item.length === 3, 'MEMORY_SCHEMA_INVALID', 'Each audience must bind channel, conversation, and requester.');
    identifier(item[0]); identifier(item[1]);
    if (item[2] === '*') requireThat(groupWildcard(item), 'MEMORY_POLICY_WILDCARD_INVALID', 'A requester wildcard is allowed only in one canonical QQ login/group conversation.');
    else identifier(item[2]);
  });
  policy.processingGrants.forEach((item) => { identifier(item.grantId); identifier(item.providerRouteId); });
  return { policyId: policy.policyId, approved: true, audiences: normalizeAudiences(policy.audiences), processingGrants: normalizeGrants(policy.processingGrants) };
}
export function policyAllows(policy, ctx, { admin = false } = {}) {
  return !!policy?.approved && (admin || policy.audiences.some((item) => item[0] === ctx.channel && item[1] === ctx.conversationKey && (item[2] === ctx.requesterAccountKey || groupWildcard(item))))
    && policy.processingGrants.some((grant) => grant.grantId === ctx.processingGrantId && grant.providerRouteId === ctx.providerRouteId);
}
export function intersectPolicies(policies) {
  if (!policies.length || policies.some((policy) => !policy?.approved)) return { audiences: [], processingGrants: [] };
  let audiences = normalizeAudiences(policies[0].audiences);
  for (const policy of policies.slice(1)) {
    const next = [];
    for (const item of audiences) for (const other of policy.audiences) {
      if (item[0] !== other[0] || item[1] !== other[1]) continue;
      if (item[2] === other[2]) next.push(item);
      else if (groupWildcard(item)) next.push(other);
      else if (groupWildcard(other)) next.push(item);
    }
    audiences = normalizeAudiences(next);
  }
  return { audiences, processingGrants: normalizeGrants(policies[0].processingGrants.filter((item) => policies.every((policy) => policy.processingGrants.some((other) => other.grantId === item.grantId && other.providerRouteId === item.providerRouteId)))) };
}
export function terms(text) {
  const lower = String(text).toLowerCase();
  return [...new Set([...(lower.match(/[a-z0-9_]+/g) ?? []), ...[...lower.matchAll(/[\p{Script=Han}]+/gu)].flatMap(([part]) => part.length === 1 ? [part] : Array.from({ length: part.length - 1 }, (_, i) => part.slice(i, i + 2)))])].slice(0, 128);
}
export function receipt(operationId, values = {}) {
  return { ok: true, operationId, acceptance: 'volatile', sourceState: 'pending', selectionState: 'not_selected', indexState: 'not_applicable', operationState: 'completed', retry: 'none', ...values };
}
export function validatePrepared(prepared, ctx, now) {
  requireThat(prepared?.schemaVersion === SCHEMA_VERSION && prepared.expiresAt > now, 'MEMORY_PREPARED_STALE', 'The memory preparation has expired.');
  for (const key of CONTEXT_FIELDS) requireThat(prepared[key] === ctx[key], 'MEMORY_PREPARED_STALE', `Prepared context ${key} is stale.`);
  requireThat(typeof prepared.queryDigest === 'string' && Array.isArray(prepared.evidenceIds) && prepared.evidenceIds.length <= 8 && Array.isArray(prepared.inputManifest) && typeof prepared.text === 'string' && prepared.text.length <= 1800, 'MEMORY_PREPARED_INVALID', 'Invalid prepared memory envelope.');
  return true;
}
