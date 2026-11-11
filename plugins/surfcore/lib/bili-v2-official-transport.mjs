import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { readBiliV2VideoMetadata } from './bili-v2-video-metadata.mjs';
import { safeData, verifyPublicSet, memberFor, sameData } from './bili-v2-official-public-source.mjs';
import { biliV2InputDigest } from './bili-v2-agent.mjs';
import { BILI_V2_ENDPOINTS, decodeBiliV2Request } from '../tools/lib/bili-v2-dispatch.mjs';

const VIEW = 'https://api.bilibili.com/x/web-interface/view';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const REPLY = 'https://api.bilibili.com/x/v2/reply/reply';
const MAIN_REPLY = 'https://api.bilibili.com/x/v2/reply';
const DYNAMIC = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';
const SESSIONS = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions';
const MSGFEED = 'https://api.bilibili.com/x/msgfeed/reply';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const ERROR = 'Bili official source proof was refused.';
const DENIED_WORKER_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'host', 'x-forwarded-host', 'x-forwarded-for',
  'x-original-url', 'x-rewrite-url', 'forwarded', 'via',
]);
const LOCATOR_KEYS = Object.freeze({
  video: ['kind', 'bvid', 'aid', 'authorMid'],
  comment: ['kind', 'rpid', 'type', 'oid', 'root', 'parent', 'authorMid'],
  dynamic: ['kind', 'id'],
  dm: ['kind', 'mid', 'msgKey'],
  notification: ['kind', 'id'],
  telemetry: ['kind', 'id'],
});
const REQUIRED_IDS = Object.freeze({
  comment: ['rpid', 'type', 'oid', 'root', 'parent', 'authorMid'],
  dynamic: ['id'],
  dm: ['mid', 'msgKey'],
  notification: ['id'],
  telemetry: ['id'],
});
const OFFICIAL_BASES = new Set([NAV, VIEW, REPLY, MAIN_REPLY, DYNAMIC, SESSIONS, MSGFEED, ...Object.values(BILI_V2_ENDPOINTS)]
  .map((url) => { const parsed = new URL(url); return parsed.origin + parsed.pathname; }));

const MIXIN_TAB = Object.freeze([46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]);
function officialWbiQuery({ csrf, imgUrl, subUrl, wts }) {
  const keyOf = (value) => { const url = String(value); return url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.')); };
  const raw = keyOf(imgUrl) + keyOf(subUrl);
  const mixin = MIXIN_TAB.map((index) => raw[index]).join('').slice(0, 32);
  if (mixin.length !== 32) return null;
  const clean = (value) => String(value).replace(/[!'()*]/g, '');
  const merged = { csrf, wts };
  const query = Object.keys(merged).sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(clean(merged[key]))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
}

const numeric = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value);
const clone = (value) => structuredClone(value);
const hash = (value) => biliV2InputDigest({ value });
const exact = (value, keys) => value && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
  && !Object.getOwnPropertySymbols(value).length
  && Object.keys(Object.getOwnPropertyDescriptors(value))
    .every((key) => keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key));

function targetValid(target) {
  if (!exact(target, ['audience', 'kind', 'bvid', 'aid', 'mid', 'type', 'oid', 'root', 'parent']) || !['public', 'private'].includes(target.audience)) return false;
  if (target.kind === 'video') return exact(target, ['audience', 'kind', 'bvid', 'aid']) && Object.keys(target).length === 4 && target.audience === 'public' && /^BV[A-Za-z0-9]{10}$/.test(target.bvid) && /^[1-9][0-9]{0,29}$/.test(target.aid);
  if (target.kind === 'dynamic') return exact(target, ['audience', 'kind']) && target.audience === 'public';
  if (target.kind === 'dm') return exact(target, ['audience', 'kind', 'mid']) && target.audience === 'private' && numeric(target.mid);
  return exact(target, ['audience', 'kind', 'type', 'oid', 'root', 'parent'])
    && target.audience === 'public' && target.kind === 'comment'
    && ['1', '11', '17'].includes(target.type)
    && ['oid', 'root', 'parent'].every((key) => numeric(target[key]));
}

function abort(code, hint, extra = {}) {
  const error = new Error(ERROR);
  Object.assign(error, { ok: false, code, error: ERROR, hint }, extra);
  throw error;
}
function officialId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    abort('BILI_OFFICIAL_ID_UNSAFE', 'The official identifier lost integer precision; require an exact decimal string before using this source.');
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function toFailure(error) {
  if (!error || typeof error.code !== 'string' || typeof error.hint !== 'string') {
    return { ok: false, code: 'BILI_OFFICIAL_FAILED', error: ERROR, hint: 'Inspect the original official source and retry under the same approved job.' };
  }
  const failure = { ok: false, code: error.code, error: typeof error.error === 'string' && error.error ? error.error : ERROR, hint: error.hint };
  if (typeof error.scope === 'string') failure.scope = error.scope;
  return failure;
}

export function createBiliV2OfficialTransport({ getCredentials, getScope, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof getCredentials !== 'function' || typeof getScope !== 'function'
    || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new Error('BILI_OFFICIAL_UNSUPPORTED: Host must inject getCredentials, getScope, fetchImpl and now.');
  }
  let closed = false;
  let boundMid = null;
  let lastFailure = null;
  const unimplementedScopes = new Set();
  const registry = new Map();
  const counters = { navChecks: 0, identities: 0, accounts: 0, hydrations: 0, revalidations: 0, sends: 0 };

  function ensureOpen(signal) {
    if (closed) abort('BILI_OFFICIAL_CLOSED', 'This official transport is closed; start a new approved Host job instead of reusing it.');
    if (signal?.aborted) abort('BILI_OFFICIAL_ABORTED', 'The approved job was cancelled; do not resend or re-read under a stale signal.');
  }
  // One immutable, value-copied Host credential snapshot per public operation.
  // It lives only in the operation's local ctx (never a global currentCredentials),
  // so concurrent jobs cannot cross accounts and no request mixes two snapshots.
  function readSnapshot(credentials) {
    if (!credentials || typeof credentials !== 'object' || typeof credentials.cookie !== 'string'
      || credentials.cookie.length === 0 || credentials.cookie.length > 8192) {
      abort('BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE', 'The Host has no current Bili credentials; restore the approved session before retrying.');
    }
    return Object.freeze({
      cookie: credentials.cookie,
      bili_jct: typeof credentials.bili_jct === 'string' ? credentials.bili_jct : undefined,
    });
  }
  function sameCredentials(current, snapshot) {
    if (!current || typeof current !== 'object' || typeof current.cookie !== 'string') return false;
    const jct = typeof current.bili_jct === 'string' ? current.bili_jct : undefined;
    return current.cookie === snapshot.cookie && jct === snapshot.bili_jct;
  }
  async function beginOperation(signal) {
    ensureOpen(signal);
    let raw;
    try { raw = await getCredentials(); } catch { raw = null; }
    return { snapshot: readSnapshot(raw), signal };
  }
  // Re-read only to COMPARE private values before the next network request; never
  // log, hash or expose the cookie/nonce/credentials, and never reuse the re-read
  // object for headers. A switch during any await is refused before the next fetch.
  async function assertStable(ctx) {
    if (ctx.signal?.aborted) abort('BILI_OFFICIAL_ABORTED', 'The approved job was cancelled; do not resend or re-read under a stale signal.');
    let current;
    try { current = await getCredentials(); }
    catch { abort('BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE', 'Host credentials became unavailable; cancel the job and restore the approved session.'); }
    if (!sameCredentials(current, ctx.snapshot)) {
      abort('BILI_OFFICIAL_CREDENTIALS_CHANGED', 'Host credentials or account changed during this operation; cancel the job and capture a fresh one under a single account.');
    }
  }
  function officialHeaders(credentials, contentType) {
    const headers = { 'user-agent': USER_AGENT, referer: REFERER, cookie: credentials.cookie };
    if (contentType) headers['content-type'] = contentType;
    return headers;
  }
  function hostCsrf(credentials) {
    const values = new Set();
    if (typeof credentials.bili_jct === 'string' && credentials.bili_jct.length) values.add(credentials.bili_jct);
    for (const part of String(credentials.cookie).split(';')) {
      const entry = part.trim();
      const eq = entry.indexOf('=');
      if (eq < 0 || entry.slice(0, eq).trim().toLowerCase() !== 'bili_jct') continue;
      const value = entry.slice(eq + 1).trim();
      if (value.length) values.add(value);
    }
    if (values.size === 0) abort('BILI_OFFICIAL_CSRF_UNAVAILABLE', 'The Host credentials expose no bili_jct; restore one approved account session before sending.');
    if (values.size !== 1) abort('BILI_OFFICIAL_CSRF_CONFLICT', 'The Host bili_jct and Cookie bili_jct disagree; cancel the write instead of mixing two account credentials.');
    const csrf = [...values][0];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(csrf)) abort('BILI_OFFICIAL_CSRF_CONFLICT', 'The Host bili_jct is malformed; restore one approved account session before sending.');
    return csrf;
  }
  async function guardedFetch(url, init, ctx) {
    await assertStable(ctx);
    ensureOpen(ctx.signal);
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error' });
    } catch (error) {
      if (ctx.signal?.aborted) abort('BILI_OFFICIAL_ABORTED', 'The approved job was cancelled; do not resend or re-read under a stale signal.');
      const reason = `${error?.cause?.message ?? ''} ${error?.message ?? ''}`;
      if (/redirect/i.test(reason)) abort('BILI_OFFICIAL_REDIRECT_DENIED', 'The fixed official endpoint tried to redirect; restore the original endpoint instead of following to an unknown origin.');
      abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official endpoint did not return a receipt; restore the source before retrying.');
    }
    const status = response?.status;
    if (response?.redirected === true || (Number.isInteger(status) && status >= 300 && status < 400)) {
      abort('BILI_OFFICIAL_REDIRECT_DENIED', 'The fixed official endpoint tried to redirect; restore the original endpoint instead of following to an unknown origin.');
    }
    return response;
  }
  function assertOfficialUrl(url) {
    const parsed = new URL(url);
    if (!OFFICIAL_BASES.has(parsed.origin + parsed.pathname) || parsed.username || parsed.password || parsed.hash) {
      abort('BILI_OFFICIAL_ENDPOINT_DENIED', 'Only the fixed official Bili read and write endpoints may be contacted by this transport.');
    }
  }
  async function jsonBody(response, signal) {
    if (signal?.aborted) abort('BILI_OFFICIAL_ABORTED', 'The approved job was cancelled; do not resend or re-read under a stale signal.');
    if (!response || typeof response.json !== 'function') abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official endpoint returned no readable receipt; restore the source before retrying.');
    try { return await response.json(); }
    catch { abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official endpoint returned an unreadable receipt; restore the source before retrying.'); }
  }
  async function officialGet(url, ctx) {
    assertOfficialUrl(url);
    const response = await guardedFetch(url, { method: 'GET', headers: officialHeaders(ctx.snapshot), signal: ctx.signal }, ctx);
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status > 299) {
      abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official endpoint did not return a successful receipt; restore the source before retrying.');
    }
    return jsonBody(response, ctx.signal);
  }

  // The same nav helper backs getIdentity, getAccount, hydrate and revalidate.
  async function confirmAccount(ctx) {
    const body = await officialGet(NAV, ctx);
    counters.navChecks += 1;
    if (!body || body.code !== 0 || body.data?.isLogin !== true || !numeric(officialId(body.data?.mid ?? ''))) {
      abort('BILI_OFFICIAL_LOGIN_REQUIRED', 'The official nav endpoint did not confirm a logged-in numeric mid; re-authorize the Host account instead of reusing a claimed identity.');
    }
    const accountMid = officialId(body.data.mid);
    if (boundMid === null) boundMid = accountMid;
    else if (boundMid !== accountMid) abort('BILI_OFFICIAL_ACCOUNT_CHANGED', 'The official account mid changed mid-job; cancel the job and capture a fresh one under the current account.');
    return accountMid;
  }
  function scopeFor(job, accountMid) {
    let safeJob, scope;
    try { safeJob = safeData(job); scope = safeData(getScope(job)); } catch { abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Restore the exact trusted job and registered scope.'); }
    if (!scope || !exact(scope, ['audience', 'target', 'providerRouteId', 'publicSourceSet'])
      || !['public', 'private'].includes(scope.audience)
      || !targetValid(scope.target) || scope.target.audience !== scope.audience
      || typeof safeJob?.providerRouteId !== 'string' || scope.providerRouteId !== safeJob.providerRouteId) {
      abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'The Host-registered job scope is invalid or does not match the approved private job route; re-register the audience and target.');
    }
    if (Object.hasOwn(scope, 'publicSourceSet')) {
      if (scope.audience !== 'public' || scope.target.kind !== 'dynamic') abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Use a public dynamic output for the approved source set.');
      const set = verifyPublicSet(scope, safeJob, accountMid);
      if (!set) abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Reapprove the exact source set under the current account, character and route.');
      scope.publicSourceSet = set;
    }
    return scope;
  }
  function assertTargetInScope(target, scope) {
    if (!targetValid(target)) abort('BILI_OFFICIAL_TARGET_INVALID', 'The sink target is not one of the four approved Bili target shapes.');
    if (target.audience !== scope.audience || target.kind !== scope.target.kind) {
      abort('BILI_OFFICIAL_TARGET_ESCALATION', 'A private conversation cannot escalate into a public send, nor change target kind.');
    }
    if (target.kind === 'comment' && (target.oid !== scope.target.oid || target.type !== scope.target.type)) {
      abort('BILI_OFFICIAL_TARGET_ESCALATION', 'The comment sink must stay inside the Host-registered object and type.');
    }
    if (target.kind === 'dm' && target.mid !== scope.target.mid) {
      abort('BILI_OFFICIAL_TARGET_ESCALATION', 'A private message cannot be redirected to a different registered peer.');
    }
  }
  function conversationKey(accountMid, target) {
    if (target.kind === 'dynamic') return `bili:${accountMid}:public:dynamic`;
    if (target.kind === 'dm') return `bili:${accountMid}:private:${target.mid}`;
    return `bili:${accountMid}:public:${target.oid}`;
  }

  function mandatoryOk(locator) {
    const keys = REQUIRED_IDS[locator?.kind];
    if (!keys || !keys.every((key) => numeric(locator[key]))) return false;
    return locator.kind !== 'comment' || ['1', '11', '17'].includes(locator.type);
  }
  function strictLocator(item) {
    if (!item || typeof item !== 'object' || types.isProxy(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'A trigger item asserted a body, identity, proof or coverage claim; only restricted official identifiers are accepted.');
    }
    if (!exact(item, Object.values(LOCATOR_KEYS).flat())) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use only data descriptors for source identifiers.');
    const keys = LOCATOR_KEYS[item.kind];
    if (!keys || !exact(item, keys) || !mandatoryOk(item)) {
      abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'A trigger item asserted a body, identity, proof or coverage claim; only restricted official identifiers are accepted.');
    }
    return clone(item);
  }
  function toolLocators(selector) {
    const out = [];
    for (const container of [selector.args, selector.stdout]) {
      let value = container;
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } }
      if (!value || typeof value !== 'object') continue;
      const candidates = Array.isArray(value) ? value : Array.isArray(value.items) ? value.items : [value];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const keys = LOCATOR_KEYS[candidate.kind];
        if (!keys) continue;
        // Worker stdout is untrusted: project ONLY restricted identifiers, discard every body/identity/coverage claim.
        const projected = {};
        for (const key of keys) if (Object.hasOwn(candidate, key)) projected[key] = String(candidate[key]);
        if (mandatoryOk(projected)) out.push(projected);
      }
    }
    return out;
  }
  function collectLocators(selector) {
    if (!selector || typeof selector !== 'object') abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'The selector must be a restricted trigger or tool identifier set.');
    if (selector.kind === 'trigger') {
      const input = selector.input;
      if (!input || typeof input !== 'object' || !Array.isArray(input.items) || input.items.length === 0) {
        abort('BILI_OFFICIAL_TARGET_MISSING', 'The trigger did not name any complete official target; a notification digest is not an original.');
      }
      if (input.coverage === 'full') abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'A trigger cannot assert full coverage; the complete original must come from a new official GET.');
      return input.items.map(strictLocator);
    }
    if (selector.kind === 'tool') {
      if (['feed', 'debrief', 'today'].includes(selector.action)) {
        unimplementedScopes.add(selector.action);
        abort('BILI_OFFICIAL_SCOPE_UNSUPPORTED', `The ${selector.action} VIDEO output cannot be expressed by the frozen source schema; extend the shared seam instead of forging a full original.`, { scope: selector.action });
      }
      return toolLocators(selector);
    }
    abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'The selector must be a restricted trigger or tool identifier set.');
  }

  function occurredAt(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  async function officialComment(locator, scope, ctx) {
    let found = null;
    for (let page = 1; page <= 6 && !found; page += 1) {
      const url = locator.root === '0'
        ? `${MAIN_REPLY}?type=${encodeURIComponent(locator.type)}&oid=${encodeURIComponent(locator.oid)}&pn=${page}&ps=20&sort=2`
        : `${REPLY}?type=${encodeURIComponent(locator.type)}&oid=${encodeURIComponent(locator.oid)}&root=${encodeURIComponent(locator.root)}&ps=20&pn=${page}`;
      const body = await officialGet(url, ctx);
      if (!body || body.code !== 0) abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official reply thread did not return code 0; restore the source before retrying.');
      const replies = Array.isArray(body.data?.replies) ? body.data.replies : [];
      for (const reply of replies) {
        if (reply && officialId(reply.rpid_str ?? reply.rpid) === locator.rpid) { found = reply; break; }
      }
      if (replies.length < 20) break;
    }
    if (!found) abort('BILI_OFFICIAL_PAGINATION_NOT_FOUND', 'The exact rpid was not found in the official reply pages; a notification digest or a last-author fallback is not the original.');
    if (found.deleted === true || found.action === 'delete' || typeof found.content?.message !== 'string' || found.content.message.length === 0) {
      abort('BILI_OFFICIAL_ORIGINAL_DELETED', 'The official reply was deleted or has no text; do not substitute a digest.');
    }
    const pictures = found.content?.pictures;
    if (pictures !== undefined && !(Array.isArray(pictures) && pictures.length === 0)) {
      abort('BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED', 'The official reply contains multimedia; the frozen text-only schema cannot cover it.');
    }
    if (['type', 'oid', 'root', 'parent'].some(key => !Object.hasOwn(found, key) || found[key] === undefined || found[key] === null)) {
      abort('BILI_OFFICIAL_ORIGINAL_INCOMPLETE', 'The official reply omitted original coordinates; do not fill them from selector claims.');
    }
    const authorMid = officialId(found.member?.mid ?? '');
    if (!numeric(authorMid) || authorMid !== locator.authorMid) {
      abort('BILI_OFFICIAL_AUTHOR_MISMATCH', 'The official reply author mid does not match the restricted selector identifier.');
    }
    const type = officialId(found.type);
    const oid = officialId(found.oid);
    if (type !== locator.type || oid !== locator.oid) abort('BILI_OFFICIAL_TARGET_INVALID', 'The official reply coordinates do not match the restricted selector identifiers.');
    const root = officialId(found.root);
    const parent = officialId(found.parent);
    if (root !== locator.root || parent !== locator.parent) abort('BILI_OFFICIAL_TARGET_INVALID', 'The official reply coordinates do not match the restricted selector identifiers.');
    const wire = {
      rpid_str: officialId(found.rpid_str ?? found.rpid), member: { mid: authorMid },
      oid, type, root, parent, content: { message: String(found.content.message), pictures: [] },
    };
    const target = { audience: 'public', kind: 'comment', type, oid, root, parent };
    if (!scope.publicSourceSet) assertTargetInScope(target, scope);
    return { kind: 'comment', objectId: locator.rpid, authorMid, occurredAt: occurredAt(found.ctime), audience: 'public', target, coverage: 'full', wire };
  }
  async function officialDynamic(locator, scope, ctx) {
    const url = `${DYNAMIC}?id=${encodeURIComponent(locator.id)}&features=itemOpusStyle`;
    const body = await officialGet(url, ctx);
    const item = body?.data?.item;
    if (!body || body.code !== 0 || !item || officialId(item.id_str ?? '') !== locator.id) {
      abort('BILI_OFFICIAL_PAGINATION_NOT_FOUND', 'The exact dynamic id was not returned by the official detail endpoint; a digest is not the original.');
    }
    const modules = item.modules;
    const authorMid = officialId(modules?.module_author?.mid ?? '');
    if (!numeric(authorMid)) abort('BILI_OFFICIAL_AUTHOR_MISMATCH', 'The official dynamic author mid is not a numeric account id.');
    const dynamic = modules?.module_dynamic;
    if (!dynamic || typeof dynamic.desc?.text !== 'string' || dynamic.desc.text.length === 0) {
      abort('BILI_OFFICIAL_ORIGINAL_DELETED', 'The official dynamic has no text; do not substitute a digest.');
    }
    if (dynamic.major != null || dynamic.additional != null) {
      abort('BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED', 'The official dynamic contains multimedia; the frozen text-only schema cannot cover it.');
    }
    const wire = {
      id_str: officialId(item.id_str),
      modules: { module_author: { mid: authorMid }, module_dynamic: { desc: { text: String(dynamic.desc.text) }, major: null, additional: null } },
    };
    const target = { audience: 'public', kind: 'dynamic' };
    assertTargetInScope(target, scope);
    return { kind: 'dynamic', objectId: locator.id, authorMid, occurredAt: occurredAt(modules?.module_author?.pub_ts), audience: 'public', target, coverage: 'full', wire };
  }
  async function officialDm(locator, scope, accountMid, ctx) {
    const url = `${SESSIONS}?session_type=1&group_id=0&count=50&mobi_app=web`;
    const body = await officialGet(url, ctx);
    if (!body || body.code !== 0 || !Array.isArray(body.data?.session_list)) {
      abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official private-message sessions did not return code 0; restore the source before retrying.');
    }
    const session = body.data.session_list.find((entry) => entry && officialId(entry.talker_id) === locator.mid);
    if (!session) abort('BILI_OFFICIAL_PAGINATION_NOT_FOUND', 'The registered private peer was not present in the official session list.');
    const last = session.last_msg;
    if (!last || officialId(last.msg_key ?? '') !== locator.msgKey) {
      unimplementedScopes.add('dm-history');
      abort('BILI_OFFICIAL_SCOPE_UNSUPPORTED', 'Only the latest official private message per session is retrievable; a historical msg_key needs a shared-seam extension.', { scope: 'dm-history' });
    }
    if (last.deleted === true || typeof last.content !== 'string') abort('BILI_OFFICIAL_ORIGINAL_DELETED', 'The official private message was deleted; do not substitute a digest.');
    let parsed;
    try { parsed = JSON.parse(last.content); } catch { abort('BILI_OFFICIAL_ORIGINAL_DELETED', 'The official private message content is unreadable; do not substitute a digest.'); }
    if (typeof parsed?.content !== 'string' || parsed.content.length === 0) abort('BILI_OFFICIAL_ORIGINAL_DELETED', 'The official private message has no text; do not substitute a digest.');
    const authorMid = officialId(last.sender_uid ?? '');
    if (!numeric(authorMid) || authorMid !== locator.mid || officialId(last.receiver_id ?? '') !== accountMid) {
      abort('BILI_OFFICIAL_AUTHOR_MISMATCH', 'The official private message sender or receiver does not match the registered peer and current account.');
    }
    if (Number(last.msg_type) !== 1) abort('BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED', 'Only a text private message can be a complete original in the frozen schema.');
    const wire = { msg_key: officialId(last.msg_key), sender_uid: authorMid, receiver_id: officialId(last.receiver_id), msg_type: 1, content: String(last.content) };
    const target = { audience: 'private', kind: 'dm', mid: authorMid };
    assertTargetInScope(target, scope);
    return { kind: 'dm', objectId: locator.msgKey, authorMid, occurredAt: occurredAt(last.timestamp), audience: 'private', target, coverage: 'full', wire };
  }
  async function officialObservation(locator, scope, accountMid, ctx) {
    const url = `${MSGFEED}?platform=web&build=0&mobi_app=web`;
    const body = await officialGet(url, ctx);
    if (!body || body.code !== 0 || !Array.isArray(body.data?.items)) {
      abort('BILI_OFFICIAL_OFFICIAL_UNAVAILABLE', 'The official receiver feed did not return code 0; restore the source before retrying.');
    }
    const item = body.data.items.find((entry) => entry && officialId(entry.id ?? '') === locator.id);
    if (!item) abort('BILI_OFFICIAL_PAGINATION_NOT_FOUND', 'The receiver notification id was not found in the official feed; it cannot be invented.');
    // Identifier-only wire: the notification digest text is deliberately NOT carried into the source record.
    const wire = { id: officialId(item.id), kind: String(item.kind ?? locator.kind) };
    const target = clone(scope.target);
    assertTargetInScope(target, scope);
    return { kind: locator.kind, objectId: locator.id, authorMid: accountMid, occurredAt: null, audience: scope.audience, target, coverage: 'observed-receiver', wire };
  }
  async function officialRecord(locator, scope, accountMid, ctx) {
    if (scope.publicSourceSet && !memberFor(scope.publicSourceSet, locator)) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Reapprove this exact public source before reading it.');
    if (locator.kind === 'video') {
      if (!scope.publicSourceSet) abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Approve an exact public source set before reading video metadata.');
      const result = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: locator.bvid }, officialGet: url => officialGet(url, ctx) });
      if (!result.ok) abort(result.code, result.hint);
      if (result.aid !== locator.aid || result.authorMid !== locator.authorMid) abort('BILI_OFFICIAL_AUTHOR_MISMATCH', 'The official video identifiers or author changed; approve a fresh source.');
      return { kind: 'video', objectId: result.aid, authorMid: result.authorMid, occurredAt: result.occurredAt, audience: 'public', target: { audience: 'public', kind: 'video', bvid: result.bvid, aid: result.aid }, coverage: 'text-only', wire: result.wire };
    }
    if (locator.kind === 'comment') return officialComment(locator, scope, ctx);
    if (locator.kind === 'dynamic') return officialDynamic(locator, scope, ctx);
    if (locator.kind === 'dm') return officialDm(locator, scope, accountMid, ctx);
    return officialObservation(locator, scope, accountMid, ctx);
  }
  function buildRecord(base) {
    const sourceKey = `bili:${base.kind}:${base.objectId}`;
    if (!identifier(sourceKey) || !identifier(base.objectId) || !numeric(base.authorMid) || !targetValid(base.target)) {
      abort('BILI_OFFICIAL_COVERAGE_UNPROVEN', 'The official record identifiers or target are not expressible by the frozen source schema.');
    }
    const wireDigest = hash(base.wire);
    const revision = `r-${wireDigest.slice(0, 16)}`;
    const record = { sourceKey, revision, ...base };
    const proof = {
      sourceKey, revision, objectId: base.objectId, authorMid: base.authorMid,
      audience: base.audience, target: clone(base.target), wireDigest,
    };
    return { record, proof };
  }

  function publicLocators(raw, set) {
    let selector;
    try { selector = safeData(raw); } catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use exact data-only source locators.'); }
    let items;
    if (selector.kind === 'trigger') {
      if (!exact(selector, ['kind', 'input']) || !exact(selector.input, ['kind', 'items']) || selector.input.kind !== 'public-source-set' || !Array.isArray(selector.input.items)) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use approved trigger members.');
      items = selector.input.items;
    } else if (selector.kind === 'tool') {
      if (!exact(selector, ['kind', 'action', 'args', 'stdout']) || Object.keys(selector).length !== 4) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the exact scoped tool result.');
      const expected = readMembers(selector.action, selector.args, set);
      let stdout;
      if (typeof selector.stdout !== 'string' || Buffer.byteLength(selector.stdout) > 32768) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the bounded locator result from the scoped read.');
      try { stdout = JSON.parse(selector.stdout); } catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the bounded locator result from the scoped read.'); }
      if (!sameData(stdout, { items: expected })) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the exact scoped read locator result.');
      items = expected;
    } else abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use an approved source trigger or scoped read.');
    if (!items.length || items.length > 31 || items.some(item => !memberFor(set, item))) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Every source must be an exact approved member.');
    return items;
  }
  function readMembers(action, raw, set) {
    let args;
    try { args = safeData(raw); } catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use only exact data-only read arguments.'); }
    if (action === 'feed' && sameData(args, { kind: 'feed' })) return set.selectors;
    if (action === 'debrief' && exact(args, ['kind', 'bv']) && Object.keys(args).length === 2 && args.kind === 'debrief' && typeof args.bv === 'string') {
      const found = set.selectors.filter(item => item.kind === 'video' && item.bvid === args.bv);
      if (found.length === 1) return found;
    }
    abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Read only approved feed members or one exact approved video BV.');
  }
  async function readImpl({ job, action, args, signal } = {}) {
    const ctx = await beginOperation(signal);
    const accountMid = await confirmAccount(ctx);
    const scope = scopeFor(job, accountMid);
    if (!scope.publicSourceSet) abort('BILI_OFFICIAL_SCOPE_UNSUPPORTED', 'Approve an exact public source set before typed reads.');
    return { ok: true, stdout: JSON.stringify({ items: readMembers(action, args, scope.publicSourceSet) }) };
  }
  async function inspectVideosImpl({ locators, signal } = {}) {
    let items;
    try { items = safeData(locators); } catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use exact data-only video locators.'); }
    if (!Array.isArray(items) || items.length < 1 || items.length > 31 || items.some(item => !exact(item, ['kind', 'bvid', 'aid']) || Object.keys(item).length !== 2 || item.kind !== 'video' || (Object.hasOwn(item, 'bvid') === Object.hasOwn(item, 'aid')) || typeof (item.bvid ?? item.aid) !== 'string')) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Provide 1 to 31 exact video locators containing one string BV or aid.');
    const ctx = await beginOperation(signal), accountMid = await confirmAccount(ctx), selectors = [];
    for (const locator of items) {
      const result = await readBiliV2VideoMetadata({ locator, officialGet: url => officialGet(url, ctx) });
      if (!result.ok) abort(result.code, result.hint);
      selectors.push(Object.freeze({ kind: 'video', bvid: result.bvid, aid: result.aid, authorMid: result.authorMid }));
    }
    return Object.freeze({ ok: true, accountMid, selectors: Object.freeze(selectors) });
  }
  async function getIdentityImpl(request = {}) {
    let data;
    try {
      if (!exact(request, ['job', 'action', 'target', 'signal', 'sourceSelector', ...LOCATOR_KEYS.comment, ...LOCATOR_KEYS.video])) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(request);
      data = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
      if (data.target !== undefined) data.target = safeData(data.target);
    } catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use an exact top-level selector with ordinary data fields.'); }
    const { job, action, target, signal } = data;
    const selectorKeys = Object.keys(data).filter(key => !['job', 'action', 'target', 'signal'].includes(key));
    const hasSelector = selectorKeys.length > 0;
    let selector;
    if (hasSelector) {
      selector = Object.fromEntries(selectorKeys.map(key => [key, data[key]]));
      if (action !== 'read' || !target || !['video', 'comment'].includes(selector.kind) || !exact(selector, LOCATOR_KEYS[selector.kind]) || Object.keys(selector).length !== LOCATOR_KEYS[selector.kind].length || Object.values(selector).some(value => typeof value !== 'string')) {
        abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Only a complete top-level approved selector with its physical read target is allowed.');
      }
    }
    const ctx = await beginOperation(signal);
    counters.identities += 1;
    const accountMid = await confirmAccount(ctx);
    const scope = scopeFor(job, accountMid);
    const sink = target === undefined ? scope.target : target;
    let key;
    if (scope.publicSourceSet && hasSelector) {
      const member = memberFor(scope.publicSourceSet, selector);
      const physical = selector.kind === 'video' ? { audience: 'public', kind: 'video', bvid: selector.bvid, aid: selector.aid } : { audience: 'public', kind: 'comment', type: selector.type, oid: selector.oid, root: selector.root, parent: selector.parent };
      if (!member || !sameData(sink, physical)) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Approve this exact source and physical target before reading.');
      key = member.conversationKey;
    } else {
      if (hasSelector && scope.publicSourceSet) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Approve the exact source.');
      if (hasSelector && selector.kind === 'video') abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Approve the video source set.');
      assertTargetInScope(sink, scope);
      key = scope.publicSourceSet?.outputConversationKey ?? conversationKey(accountMid, sink);
    }
    return { ok: true, accountMid, conversationKey: key, sourceAccountKey: `bili:${accountMid}:actor:${accountMid}`, requesterAccountKey: `bili:${accountMid}:actor:${accountMid}`, providerRouteId: scope.providerRouteId, audience: sink.audience, target: clone(sink) };
  }
  async function getAccountImpl({ signal } = {}) {
    const ctx = await beginOperation(signal);
    counters.accounts += 1;
    const accountMid = await confirmAccount(ctx);
    return { ok: true, accountMid };
  }
  async function hydrateImpl({ job, selector, signal } = {}) {
    const ctx = await beginOperation(signal);
    counters.hydrations += 1;
    const accountMid = await confirmAccount(ctx);
    const scope = scopeFor(job, accountMid);
    const locators = scope.publicSourceSet ? publicLocators(selector, scope.publicSourceSet) : collectLocators(selector);
    if (locators.length === 0) abort('BILI_OFFICIAL_TARGET_MISSING', 'No complete official target was named; a notification digest is not an original.');
    if (locators.length > 32) abort('BILI_OFFICIAL_COVERAGE_UNPROVEN', 'At most 32 official source records may enter one provider request.');
    const records = [];
    const seen = new Set();
    for (const locator of locators) {
      const base = await officialRecord(locator, scope, accountMid, ctx);
      const built = buildRecord(base);
      if (seen.has(built.record.sourceKey)) abort('BILI_OFFICIAL_COVERAGE_UNPROVEN', 'Duplicate official source keys cannot enter one provider request.');
      seen.add(built.record.sourceKey);
      records.push(built.record);
      let key;
      try { key = String(safeData(job)?.jobId ?? ''); } catch { abort('BILI_OFFICIAL_SCOPE_MISMATCH', 'Restore the exact trusted job.'); }
      if (!registry.has(key)) registry.set(key, new Map());
      registry.get(key).set(built.record.sourceKey, { proof: built.proof, locator });
    }
    return { ok: true, conversationKey: scope.publicSourceSet?.outputConversationKey ?? conversationKey(accountMid, scope.target), records };
  }
  async function revalidateImpl({ job, sources, signal } = {}) {
    const ctx = await beginOperation(signal);
    counters.revalidations += 1;
    const accountMid = await confirmAccount(ctx);
    const scope = scopeFor(job, accountMid);
    let safeSources, jobKey;
    try { safeSources = safeData(sources); jobKey = String(safeData(job)?.jobId ?? ''); } catch { abort('BILI_OFFICIAL_PROOF_UNREGISTERED', 'Use data-only proofs and the exact trusted job.'); }
    if (!Array.isArray(safeSources)) abort('BILI_OFFICIAL_PROOF_UNREGISTERED', 'Only source proofs registered by this factory hydrate can be revalidated.');
    // A factory may serve several jobs. Only the proofs this exact job hydrated are the trusted
    // root set: another job's sourceKeys are neither accepted nor counted toward completeness.
    const registeredForJob = registry.get(jobKey) || new Map();
    const seen = new Set();
    for (const proof of safeSources) {
      if (!proof || typeof proof.sourceKey !== 'string' || seen.has(proof.sourceKey)) {
        abort('BILI_OFFICIAL_PROOF_UNREGISTERED', 'A duplicated or malformed source proof cannot be revalidated.');
      }
      seen.add(proof.sourceKey);
      const registered = registeredForJob.get(proof.sourceKey);
      if (!registered) {
        abort('BILI_OFFICIAL_PROOF_UNREGISTERED', 'An arbitrary selector cannot forge a root proof that this factory never hydrated for this job.');
      }
      if (hash(proof) !== hash(registered.proof)) {
        abort('BILI_OFFICIAL_PROOF_TAMPERED', 'A registered source proof was changed; restore the original proof instead of retrying.');
      }
    }
    if (seen.size !== registeredForJob.size) {
      abort('BILI_OFFICIAL_PROOF_SET_MISMATCH', 'Every registered source proof of this job must be revalidated; dropping one cannot hide a revocation.');
    }
    for (const proof of safeSources) {
      const registered = registeredForJob.get(proof.sourceKey);
      let fresh;
      try { fresh = await officialRecord(registered.locator, scope, accountMid, ctx); }
      catch (error) {
        if (['BILI_OFFICIAL_ORIGINAL_DELETED', 'BILI_OFFICIAL_PAGINATION_NOT_FOUND'].includes(error?.code)) {
          abort('BILI_OFFICIAL_SOURCE_REVOKED', 'The official original was deleted or removed; cancel the job instead of sending on a revoked source.');
        }
        if (['BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED', 'BILI_OFFICIAL_AUTHOR_MISMATCH', 'BILI_OFFICIAL_TARGET_INVALID', 'BILI_OFFICIAL_TARGET_ESCALATION'].includes(error?.code)) {
          abort('BILI_OFFICIAL_SOURCE_CHANGED', 'The official original author, target or coverage changed since hydrate.');
        }
        throw error;
      }
      const digest = hash(fresh.wire);
      if (digest !== proof.wireDigest || fresh.objectId !== proof.objectId || fresh.authorMid !== proof.authorMid
        || fresh.audience !== proof.audience || hash(fresh.target) !== hash(proof.target)
        || `r-${digest.slice(0, 16)}` !== proof.revision) {
        abort('BILI_OFFICIAL_SOURCE_CHANGED', 'The official original changed since hydrate; do not send on a stale or edited source.');
      }
    }
    return { ok: true, unchanged: true };
  }
  async function sendImpl(request = {}) {
    const ctx = await beginOperation(request.signal);
    counters.sends += 1;
    const signal = request.signal;
    const workerHeaders = request.headers && typeof request.headers === 'object' ? request.headers : {};
    for (const name of Object.keys(workerHeaders)) {
      if (DENIED_WORKER_HEADERS.has(name.toLowerCase())) {
        abort('BILI_OFFICIAL_HEADER_DENIED', 'A worker-supplied credential or routing header cannot affect the official destination; only Host credentials may build headers.');
      }
    }
    let decoded;
    try {
      // Strip signal (structuredClone cannot clone AbortSignal) and all worker headers before decoding.
      decoded = decodeBiliV2Request({ action: request.action, url: request.url, method: request.method, headers: {}, body: request.body });
    } catch (error) {
      if (error && typeof error.code === 'string') throw error;
      abort('BILI_OFFICIAL_REQUEST_INVALID', 'Use one supported typed Bili write tool and its fixed official endpoint.');
    }
    await confirmAccount(ctx);
    const csrf = hostCsrf(ctx.snapshot);
    const action = decoded.request.action;
    const base = BILI_V2_ENDPOINTS[action];
    assertOfficialUrl(base);
    let url = base;
    let postBody = decoded.request.body;
    if (action === 'dynamic') {
      const nav = await officialGet(NAV, ctx);
      const imgUrl = nav?.data?.wbi_img?.img_url;
      const subUrl = nav?.data?.wbi_img?.sub_url;
      const query = typeof imgUrl === 'string' && typeof subUrl === 'string'
        ? officialWbiQuery({ csrf, imgUrl, subUrl, wts: Math.round(now() / 1000) }) : null;
      if (!query) abort('BILI_OFFICIAL_WBI_UNAVAILABLE', 'The official nav response has no usable WBI material; the fixed dynamic intent cannot be signed, so no write is sent.');
      url = `${base}?${query}`;
      assertOfficialUrl(url);
    } else {
      const params = new URLSearchParams(postBody);
      params.set('csrf', csrf);
      if (params.has('csrf_token')) params.set('csrf_token', csrf);
      postBody = params.toString();
    }
    const contentType = action === 'dynamic' ? 'application/json' : 'application/x-www-form-urlencoded';
    const response = await guardedFetch(url, { method: 'POST', headers: officialHeaders(ctx.snapshot, contentType), body: postBody, signal }, ctx);
    const body = await jsonBody(response, ctx.signal);
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status > 599 || !body || !Number.isSafeInteger(body.code)) {
      abort('BILI_OFFICIAL_RECEIPT_INVALID', 'The official write returned no typed receipt; inspect the original action receipt before retrying.');
    }
    return {
      http: response.status,
      body: {
        code: body.code,
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
        ...(body.data && typeof body.data === 'object' ? { data: body.data } : {}),
      },
    };
  }

  function wrapResult(impl, keys) {
    return async (...args) => {
      try {
        const request = args[0] ?? {};
        if (keys) {
          if (!exact(request, keys)) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use data-only request fields and a trusted signal.');
          const signal = request.signal;
          if (signal !== undefined) {
            if (!signal || typeof signal !== 'object' || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype || Object.getOwnPropertyNames(signal).length) abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the original trusted abort signal.');
            try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(signal); }
            catch { abort('BILI_OFFICIAL_SELECTOR_UNTRUSTED', 'Use the original trusted abort signal.'); }
          }
        }
        return await impl(...args);
      }
      catch (error) { lastFailure = toFailure(error); return lastFailure; }
    };
  }

  return {
    getIdentity: wrapResult(getIdentityImpl, ['job', 'action', 'target', 'signal', 'sourceSelector', ...LOCATOR_KEYS.comment, ...LOCATOR_KEYS.video]),
    inspectVideos: wrapResult(inspectVideosImpl, ['locators', 'signal']),
    getAccount: wrapResult(getAccountImpl),
    sourceTransport: {
      hydrate: wrapResult(hydrateImpl, ['job', 'selector', 'signal']),
      revalidate: wrapResult(revalidateImpl, ['job', 'sources', 'signal']),
    },
    transport: {
      read: wrapResult(readImpl, ['job', 'action', 'args', 'signal']),
      send: async (request) => {
        try { return await sendImpl(request); }
        catch (error) {
          const failure = toFailure(error);
          lastFailure = failure;
          if (error && typeof error.code === 'string') throw error;
          throw Object.assign(new Error(failure.error), failure);
        }
      },
    },
    close() {
      closed = true;
      registry.clear();
      return { ok: true, closed: true };
    },
    getStatus() {
      return {
        ok: true, closed,
        navChecks: counters.navChecks, identities: counters.identities, accounts: counters.accounts,
        hydrations: counters.hydrations, revalidations: counters.revalidations, sends: counters.sends,
        registeredSources: [...registry.values()].reduce((total, entries) => total + entries.size, 0),
        unimplementedScopes: [...unimplementedScopes],
        at: now(),
        ...(lastFailure ? { lastFailure: clone(lastFailure) } : {}),
      };
    },
  };
}
