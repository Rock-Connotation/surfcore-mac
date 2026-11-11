import { createHash } from 'node:crypto';
import { types } from 'node:util';

const ERROR = 'Bili V2 public source set was refused.';
const HINT = 'Provide a complete, exact public video/comment selector set with a valid character, epoch, account, route and dynamic output target; approval is a separate explicit step.';
const FAILURE = Object.freeze({ ok: false, code: 'BILI_V2_PUBLIC_SET_INVALID', error: ERROR, hint: HINT });

const CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,29}$/;
const COORDINATE_ID = /^(0|[1-9][0-9]{0,29})$/;
const BV_PATTERN = /^BV[A-Za-z0-9]{10}$/;
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/;
const COMMENT_TYPES = ['1', '11', '17'];
const TOP_KEYS = ['characterId', 'characterEpoch', 'accountMid', 'providerRouteId', 'selectors', 'outputTarget'];
const VIDEO_KEYS = ['kind', 'bvid', 'aid', 'authorMid'];
const COMMENT_KEYS = ['kind', 'rpid', 'type', 'oid', 'root', 'parent', 'authorMid'];

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return 'null';
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function plainData(value) {
  if (value === null || typeof value !== 'object') return null;
  if (types.isProxy(value)) return null;
  if (Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!('value' in descriptor) || !descriptor.enumerable) return null;
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function plainArray(value) {
  if (value === null || typeof value !== 'object') return null;
  if (types.isProxy(value)) return null;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
  const size = lengthDescriptor.value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > 31) return null;
  if (Object.keys(descriptors).length !== size + 1) return null;
  const items = [];
  for (let index = 0; index < size; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    items.push(descriptor.value);
  }
  return items;
}

function readExact(value, keys) {
  const data = plainData(value);
  if (!data) return null;
  const present = Object.keys(data);
  if (present.length !== keys.length) return null;
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(data, key)) return null;
  return data;
}

function exactId(value, allowZero) {
  if (typeof value === 'string') {
    return (allowZero ? COORDINATE_ID : POSITIVE_ID).test(value) ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    if (allowZero ? value < 0 : value <= 0) return null;
    const text = String(value);
    return POSITIVE_ID.test(text) || (allowZero && text === '0') ? text : null;
  }
  return null;
}

function exactType(value) {
  if (typeof value === 'string') return COMMENT_TYPES.includes(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && COMMENT_TYPES.includes(String(value))) return String(value);
  return null;
}

function normalizeSelector(raw) {
  const data = plainData(raw);
  if (!data) return null;
  const keys = Object.keys(data);
  if (data.kind === 'video') {
    if (keys.length !== VIDEO_KEYS.length || !VIDEO_KEYS.every((key) => Object.prototype.hasOwnProperty.call(data, key))) return null;
    if (typeof data.bvid !== 'string' || !BV_PATTERN.test(data.bvid)) return null;
    const aid = exactId(data.aid, false);
    const authorMid = exactId(data.authorMid, false);
    if (aid === null || authorMid === null) return null;
    return { kind: 'video', bvid: data.bvid, aid, authorMid };
  }
  if (data.kind === 'comment') {
    if (keys.length !== COMMENT_KEYS.length || !COMMENT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(data, key))) return null;
    const rpid = exactId(data.rpid, false);
    const oid = exactId(data.oid, false);
    const authorMid = exactId(data.authorMid, false);
    const root = exactId(data.root, true);
    const parent = exactId(data.parent, true);
    const type = exactType(data.type);
    if (rpid === null || oid === null || authorMid === null || root === null || parent === null || type === null) return null;
    return { kind: 'comment', rpid, type, oid, root, parent, authorMid };
  }
  return null;
}

function derive(input) {
  const args = readExact(input, TOP_KEYS);
  if (!args) return FAILURE;

  if (typeof args.characterId !== 'string' || !CHARACTER_ID.test(args.characterId)) return FAILURE;
  if (typeof args.characterEpoch !== 'number' || !Number.isSafeInteger(args.characterEpoch) || args.characterEpoch <= 0) return FAILURE;
  const accountMid = exactId(args.accountMid, false);
  if (accountMid === null) return FAILURE;
  if (typeof args.providerRouteId !== 'string' || !ROUTE_PATTERN.test(args.providerRouteId)) return FAILURE;

  const output = readExact(args.outputTarget, ['audience', 'kind']);
  if (!output || output.audience !== 'public' || output.kind !== 'dynamic') return FAILURE;

  const sourceItems = plainArray(args.selectors);
  if (sourceItems === null) return FAILURE;

  const deduped = new Map();
  for (const raw of sourceItems) {
    const selector = normalizeSelector(raw);
    if (selector === null) return FAILURE;
    const key = canonical(selector);
    if (!deduped.has(key)) deduped.set(key, selector);
  }
  const sorted = [...deduped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const selectors = sorted.map((entry) => entry[1]);
  if (selectors.length + 1 > 32) return FAILURE;

  const outputTarget = { audience: 'public', kind: 'dynamic' };
  const binding = {
    characterId: args.characterId,
    characterEpoch: String(args.characterEpoch),
    accountMid,
    providerRouteId: args.providerRouteId,
    selectors,
    outputTarget,
  };
  const id = sha256(binding);
  const prefix = `bili:${accountMid}:public-set:${id}`;
  const label = `Bili 公开动态来源集合：${selectors.length} 个精确来源 / 账号 ${accountMid} / 输出 public:dynamic（候选）`;
  if (label.length > 160) return FAILURE;

  const sourceConversations = selectors.map((selector) => ({
    selector,
    conversationKey: `${prefix}:source:${sha256(canonical(selector))}`,
  }));

  return deepFreeze({
    ok: true,
    id,
    label,
    selectors,
    outputTarget,
    outputConversationKey: `${prefix}:dynamic`,
    sourceConversations,
  });
}

export function deriveBiliV2PublicSourceSet(input = {}) {
  try {
    return derive(input);
  } catch {
    return FAILURE;
  }
}
