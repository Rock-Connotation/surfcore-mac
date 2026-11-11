import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createBiliV2OfficialTransport } from '../lib/bili-v2-official-transport.mjs';
import { createBiliV2SourceRuntime } from '../lib/bili-v2-source-runtime.mjs';
import { biliV2InputDigest } from '../lib/bili-v2-agent.mjs';
import { BILI_V2_ENDPOINTS, decodeBiliV2Request } from '../tools/lib/bili-v2-dispatch.mjs';

const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const REPLY = 'https://api.bilibili.com/x/v2/reply/reply';
const MAIN_REPLY = 'https://api.bilibili.com/x/v2/reply';
const DYNAMIC = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';
const SESSIONS = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions';
const MSGFEED = 'https://api.bilibili.com/x/msgfeed/reply';
const ALLOWED = new Set([NAV, REPLY, MAIN_REPLY, DYNAMIC, SESSIONS, MSGFEED, ...Object.values(BILI_V2_ENDPOINTS)]
  .map((u) => { const p = new URL(u); return p.origin + p.pathname; }));

const HOST_SECRET = 'SESSDATA=HOST_ONLY_SECRET_VALUE';
const HOST_CSRF = 'HOST_CSRF_VALUE';
const ROUTE = 'route:fixture-bili-official';
const MAIN_BASE = new URL(MAIN_REPLY).origin + new URL(MAIN_REPLY).pathname;
const SUB_BASE = new URL(REPLY).origin + new URL(REPLY).pathname;
const OTHER_CSRF = 'OTHER_CSRF_VALUE';
const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08f87e641.png';
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const WBI_KEY_OF = (u) => String(u).slice(String(u).lastIndexOf('/') + 1, String(u).lastIndexOf('.'));
const EXPECTED_MIXIN = MIXIN_TAB.map((i) => (WBI_KEY_OF(WBI_IMG) + WBI_KEY_OF(WBI_SUB))[i]).join('').slice(0, 32);
const EXPECTED_W_RID = createHash('md5').update('csrf=' + HOST_CSRF + '&wts=1700000000' + EXPECTED_MIXIN).digest('hex');
const cookieWith = (value) => HOST_SECRET + '; bili_jct=' + value;

function commentReply(overrides = {}) {
  return {
    rpid_str: '31', member: { mid: '8' }, oid: '11', type: '1', root: '0', parent: '0',
    content: { message: 'Complete official original.', pictures: [] }, ctime: 1700000000,
    api_key: 'OFFICIAL_RESPONSE_CANARY', ...overrides,
  };
}
function dynamicItem(overrides = {}) {
  return {
    id_str: '9000000000000000001',
    modules: {
      module_author: { mid: '8', name: 'author' },
      module_dynamic: { desc: { text: 'Official dynamic text.' }, major: null, additional: null },
    },
    ...overrides,
  };
}
function dmSession(overrides = {}) {
  return {
    talker_id: '22',
    last_msg: {
      msg_key: '31', sender_uid: '22', receiver_id: '9', msg_type: 1,
      content: JSON.stringify({ content: 'Private original.' }), timestamp: 1700000000,
    },
    ...overrides,
  };
}

const commentLocator = () => ({ kind: 'comment', rpid: '31', type: '1', oid: '11', root: '0', parent: '0', authorMid: '8' });
const dynamicLocator = () => ({ kind: 'dynamic', id: '9000000000000000001' });
const dmlLocator = () => ({ kind: 'dm', mid: '22', msgKey: '31' });
const notificationLocator = () => ({ kind: 'notification', id: '31' });
const telemetryLocator = () => ({ kind: 'telemetry', id: '31' });

const commentScope = () => ({ audience: 'public', target: { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' }, providerRouteId: ROUTE });
const dynamicScope = () => ({ audience: 'public', target: { audience: 'public', kind: 'dynamic' }, providerRouteId: ROUTE });
const dmScope = () => ({ audience: 'private', target: { audience: 'private', kind: 'dm', mid: '22' }, providerRouteId: ROUTE });

function job(overrides = {}) {
  return Object.freeze({
    jobId: 'job-fixture-1', requestId: 'req-fixture-1', sessionId: 'session-fixture-1',
    characterId: 'alpha', characterEpoch: 1, providerRouteId: ROUTE,
    provider: 'fixture-provider', model: 'fixture-model',
    // Deliberately bogus: the factory must never trust an account claimed in the job.
    accountMid: '999', ...overrides,
  });
}
function trig(items, kind = 'comment-notification') { return { kind, items }; }

function fixture(overrides = {}) {
  const state = {
    credentials: { cookie: HOST_SECRET, bili_jct: HOST_CSRF },
    nav: { code: 0, data: { isLogin: true, mid: 9, wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } },
    scope: commentScope(),
    replyPages: [[commentReply()]],
    dynamic: dynamicItem(),
    sessions: [dmSession()],
    notifications: [{ id: '31', kind: 'reply', uri: 'https://www.bilibili.com/opus/11' }],
    write: { code: 0, message: '0', data: {} },
    status: 200,
    calls: [],
    ...overrides,
  };
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    const u = new URL(text);
    const base = u.origin + u.pathname;
    assert.ok(ALLOWED.has(base), `unapproved URL: ${text}`);
    state.calls.push({
      base, url: text, method: (init.method || 'GET').toUpperCase(),
      headers: { ...(init.headers || {}) }, body: init.body, query: u.searchParams, redirect: init.redirect,
    });
    if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (state.redirectResponse) return { status: 302, ok: false, redirected: true, headers: { location: 'https://evil.example/' }, json: async () => ({}), text: async () => '' };
    let body;
    if (base === new URL(NAV).origin + new URL(NAV).pathname) body = state.nav;
    else if (base === MAIN_BASE || base === SUB_BASE) {
      const pn = Number(u.searchParams.get('pn') || '1');
      body = { code: 0, data: { replies: state.replyPages[pn - 1] || [] } };
    } else if (base === new URL(DYNAMIC).origin + new URL(DYNAMIC).pathname) body = { code: 0, data: { item: state.dynamic } };
    else if (base === new URL(SESSIONS).origin + new URL(SESSIONS).pathname) body = { code: 0, data: { session_list: state.sessions } };
    else if (base === new URL(MSGFEED).origin + new URL(MSGFEED).pathname) body = { code: 0, data: { items: state.notifications } };
    else body = state.write;
    return {
      status: state.status, ok: state.status >= 200 && state.status < 400,
      json: async () => structuredClone(body), text: async () => JSON.stringify(body),
    };
  };
  const api = createBiliV2OfficialTransport({
    getCredentials: () => state.credentials,
    getScope: () => state.scope,
    fetchImpl,
    now: () => 1700000000000,
  });
  return { api, state, fetchImpl };
}

function good(value) {
  assert.equal(value?.ok, true, `expected ok:true, got ${JSON.stringify(value)}`);
  return value;
}
function bad(value, code) {
  assert.equal(value?.ok, false, `expected ok:false, got ${JSON.stringify(value)}`);
  if (code) assert.equal(value.code, code, JSON.stringify(value));
  assert.ok(typeof value.code === 'string' && value.code.length > 0, 'failure code');
  assert.ok(typeof value.error === 'string' && value.error.length > 0, 'failure error');
  assert.ok(typeof value.hint === 'string' && value.hint.length > 0, 'failure hint');
  return value;
}
async function badSend(fn, code) {
  try { await fn(); } catch (error) {
    assert.ok(typeof error?.code === 'string' && error.code.length > 0, 'send failure code');
    assert.ok(typeof error?.error === 'string' && error.error.length > 0, 'send failure error');
    assert.ok(typeof error?.hint === 'string' && error.hint.length > 0, 'send failure hint');
    if (code) assert.equal(error.code, code);
    return error;
  }
  throw new Error('expected transport.send to reject');
}
function proofOf(record) {
  return {
    sourceKey: record.sourceKey, revision: record.revision, objectId: record.objectId,
    authorMid: record.authorMid, audience: record.audience, target: structuredClone(record.target),
    wireDigest: biliV2InputDigest({ value: record.wire }),
  };
}
function writeRequest(action = 'comment', overrides = {}) {
  const bodies = {
    comment: new URLSearchParams({ oid: '11', type: '1', root: '0', parent: '0', message: 'hello' }).toString(),
    dynamic: JSON.stringify({ dyn_req: { scene: 1, content: { contents: [{ raw_text: 'hello' }] } } }),
    dm: new URLSearchParams({ 'msg[receiver_id]': '22', 'msg[content]': JSON.stringify({ content: 'hello' }) }).toString(),
  };
  return {
    action, url: BILI_V2_ENDPOINTS[action], method: 'POST',
    headers: { cookie: 'SESSDATA=WORKER_SUPPLIED', 'content-type': 'application/x-www-form-urlencoded' },
    body: bodies[action], ...overrides,
  };
}
function assertIdentityShape(value, j, navMid) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.getOwnPropertySymbols(value).length, 0);
  const allowed = ['ok', 'accountMid', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'audience', 'target'];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    assert.ok(allowed.includes(key), `unexpected identity key ${key}`);
    assert.ok('value' in descriptor, `${key} must be a data property`);
  }
  assert.match(value.accountMid, /^\d{1,30}$/);
  assert.equal(value.accountMid, navMid);
  assert.match(value.conversationKey, /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/);
  assert.equal(value.sourceAccountKey, `bili:${navMid}:actor:${navMid}`);
  assert.equal(value.requesterAccountKey, `bili:${navMid}:actor:${navMid}`);
  assert.equal(value.providerRouteId, j.providerRouteId);
  assert.ok(['public', 'private'].includes(value.audience));
}

let count = 0;
async function test(name, body) {
  try { await body(); count += 1; console.log('PASS ' + name); }
  catch (error) { console.error(`FAIL ${name} :: ${error?.stack || error}`); throw error; }
}

// ---- identity / account -------------------------------------------------

await test('getAccount confirms the real official nav mid and leaks no credentials', async () => {
  const { api, state } = fixture();
  const value = good(await api.getAccount());
  assert.deepEqual(Object.keys(value).sort(), ['accountMid', 'ok']);
  assert.equal(value.accountMid, '9');
  assert.ok(!JSON.stringify(value).includes(HOST_SECRET) && !JSON.stringify(value).includes(HOST_CSRF));
  assert.ok(state.calls.some((c) => c.base === new URL(NAV).origin + new URL(NAV).pathname));
  const navCall = state.calls.find((c) => c.base === new URL(NAV).origin + new URL(NAV).pathname);
  assert.equal(navCall.headers.cookie, HOST_SECRET);
});

await test('getAccount refuses a failed official login with a visible hint', async () => {
  for (const nav of [
    { code: -101, data: { isLogin: false, mid: 9 } },
    { code: 0, data: { isLogin: false, mid: 9 } },
    { code: 0, data: { isLogin: true } },
    { code: 0, data: { isLogin: true, mid: 'not-a-mid' } },
  ]) {
    const { api } = fixture({ nav });
    bad(await api.getAccount(), 'BILI_OFFICIAL_LOGIN_REQUIRED');
  }
});

await test('getIdentity returns the exact source-runtime identity shape', async () => {
  const { api } = fixture();
  const j = job();
  const value = good(await api.getIdentity({ job: j, action: 'prompt' }));
  assertIdentityShape(value, j, '9');
  assert.equal(value.conversationKey, 'bili:9:public:11');
  assert.equal(value.audience, 'public');
  assert.deepEqual(value.target, commentScope().target);
});

await test('getIdentity ignores an account claimed by the job', async () => {
  const { api } = fixture();
  const value = good(await api.getIdentity({ job: job({ accountMid: '777' }), action: 'prompt' }));
  assert.equal(value.accountMid, '9');
  assert.equal(value.sourceAccountKey, 'bili:9:actor:9');
});

await test('getIdentity uses the explicit target for the sink handle', async () => {
  const { api } = fixture();
  const target = { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '31', parent: '31' };
  const value = good(await api.getIdentity({ job: job(), action: 'comment', target }));
  assert.deepEqual(value.target, target);
  assert.equal(value.conversationKey, 'bili:9:public:11');
});

await test('private scope conversationKey is private and dynamic is public:dynamic', async () => {
  const dm = fixture({ scope: dmScope() });
  assert.equal(good(await dm.api.getIdentity({ job: job(), action: 'prompt' })).conversationKey, 'bili:9:private:22');
  const dyn = fixture({ scope: dynamicScope() });
  assert.equal(good(await dyn.api.getIdentity({ job: job(), action: 'prompt' })).conversationKey, 'bili:9:public:dynamic');
});

await test('a private conversation cannot escalate into a public send', async () => {
  const { api } = fixture({ scope: dmScope() });
  const target = { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' };
  bad(await api.getIdentity({ job: job(), action: 'comment', target }), 'BILI_OFFICIAL_TARGET_ESCALATION');
});

await test('a cross-private target is refused', async () => {
  const { api } = fixture({ scope: dmScope() });
  const target = { audience: 'private', kind: 'dm', mid: '23' };
  bad(await api.getIdentity({ job: job(), action: 'dm', target }), 'BILI_OFFICIAL_TARGET_ESCALATION');
});

await test('an invalid target is refused with a visible hint', async () => {
  const { api } = fixture();
  bad(await api.getIdentity({ job: job(), action: 'comment', target: { audience: 'public', kind: 'comment', type: '1', oid: '11' } }), 'BILI_OFFICIAL_TARGET_INVALID');
});

await test('a Host scope whose route differs from the job is refused', async () => {
  const { api } = fixture({ scope: { ...commentScope(), providerRouteId: 'route:other' } });
  bad(await api.getIdentity({ job: job(), action: 'prompt' }), 'BILI_OFFICIAL_SCOPE_MISMATCH');
});

await test('an account switch is rejected by getIdentity', async () => {
  const { api, state } = fixture();
  good(await api.getIdentity({ job: job(), action: 'prompt' }));
  state.nav = { code: 0, data: { isLogin: true, mid: 10 } };
  bad(await api.getIdentity({ job: job(), action: 'prompt' }), 'BILI_OFFICIAL_ACCOUNT_CHANGED');
});

await test('missing Host credentials are refused without leaking them', async () => {
  for (const credentials of [null, {}, { cookie: '' }, { cookie: 5 }]) {
    const { api } = fixture({ credentials });
    bad(await api.getIdentity({ job: job(), action: 'prompt' }), 'BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE');
  }
});

// ---- hydrate: complete originals from NEW official GETs -----------------

await test('a comment-notification trigger hydrates a full original plus receiver notification', async () => {
  const { api, state } = fixture();
  const value = good(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator(), notificationLocator()]) },
  }));
  assert.equal(value.conversationKey, 'bili:9:public:11');
  assert.ok(value.records.length >= 1 && value.records.length <= 32);
  const original = value.records.find((r) => r.kind === 'comment');
  assert.ok(original, 'a full comment original is required');
  assert.equal(original.coverage, 'full');
  assert.equal(original.objectId, '31');
  assert.equal(original.authorMid, '8');
  assert.equal(original.audience, 'public');
  assert.equal(original.wire.content.message, 'Complete official original.');
  assert.ok(!('api_key' in original.wire), 'official credential-named fields are not carried into the wire');
  assert.ok(!JSON.stringify(value).includes('OFFICIAL_RESPONSE_CANARY'));
  assert.ok(state.calls.some((c) => c.base === MAIN_BASE));
  const note = value.records.find((r) => r.kind === 'notification');
  assert.ok(note, 'receiver notification is supported');
  assert.equal(note.coverage, 'observed-receiver');
  assert.equal(note.authorMid, '9');
  assert.equal(note.audience, 'public');
});

await test('a dynamic id hydrates a strict full dynamic wire', async () => {
  const { api } = fixture({ scope: dynamicScope() });
  const value = good(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([dynamicLocator()], 'dynamic') },
  }));
  const record = value.records.find((r) => r.kind === 'dynamic');
  assert.ok(record);
  assert.equal(record.coverage, 'full');
  assert.equal(record.objectId, '9000000000000000001');
  assert.equal(record.authorMid, '8');
  assert.equal(record.wire.modules.module_dynamic.desc.text, 'Official dynamic text.');
  assert.equal(record.wire.modules.module_dynamic.major, null);
  assert.equal(record.wire.modules.module_dynamic.additional, null);
});

await test('a dm peer + msgKey hydrates a strict full private wire', async () => {
  const { api } = fixture({ scope: dmScope() });
  const value = good(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([dmlLocator()], 'dm') },
  }));
  const record = value.records.find((r) => r.kind === 'dm');
  assert.ok(record);
  assert.equal(record.coverage, 'full');
  assert.equal(record.audience, 'private');
  assert.equal(record.target.mid, record.authorMid);
  assert.equal(record.wire.receiver_id, '9');
  assert.equal(record.wire.sender_uid, record.authorMid);
  assert.equal(record.wire.msg_type, 1);
});

await test('telemetry is supported as observed-receiver only', async () => {
  const { api } = fixture();
  const value = good(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator(), telemetryLocator()]) },
  }));
  const telemetry = value.records.find((r) => r.kind === 'telemetry');
  assert.ok(telemetry);
  assert.equal(telemetry.coverage, 'observed-receiver');
  assert.equal(telemetry.authorMid, '9');
});

await test('an author/rpid mismatch against the official original is refused', async () => {
  const { api } = fixture({ replyPages: [[commentReply({ member: { mid: '77' } })]] });
  bad(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_AUTHOR_MISMATCH');
});

await test('a notification digest is never accepted as the original', async () => {
  const { api } = fixture({ replyPages: [[commentReply({ rpid_str: '32' })]] });
  bad(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_PAGINATION_NOT_FOUND');
});

await test('truncation / multimedia coverage is refused, never forged as full', async () => {
  const pictures = fixture({ replyPages: [[commentReply({ content: { message: 'pictured', pictures: [{ url: 'https://img.example/a.png' }] } })]] });
  bad(await pictures.api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED');
  const truncated = fixture({ replyPages: [[commentReply({ content: { message: '' } })]] });
  bad(await truncated.api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_ORIGINAL_DELETED');
  const dyn = fixture({ scope: dynamicScope(), dynamic: dynamicItem({ modules: { module_author: { mid: '8' }, module_dynamic: { desc: { text: 'video' }, major: { type: 'MAJOR_TYPE_ARCHIVE' }, additional: null } } }) });
  bad(await dyn.api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([dynamicLocator()], 'dynamic') },
  }), 'BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED');
});

await test('a deleted original is refused with a visible hint', async () => {
  const { api } = fixture({ replyPages: [[commentReply({ deleted: true })]] });
  bad(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_ORIGINAL_DELETED');
});

await test('pagination that never finds the exact rpid is refused (no last-author fallback)', async () => {
  const fullPage = Array.from({ length: 20 }, (_, i) => commentReply({ rpid_str: String(100 + i) }));
  const { api } = fixture({ replyPages: [fullPage, fullPage, fullPage, fullPage, fullPage, fullPage] });
  bad(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) },
  }), 'BILI_OFFICIAL_PAGINATION_NOT_FOUND');
});

await test('a missing complete target is refused', async () => {
  const { api } = fixture();
  bad(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([]) },
  }), 'BILI_OFFICIAL_TARGET_MISSING');
});

await test('selector trust claims (wire/identity/coverage full) are rejected', async () => {
  const { api } = fixture();
  for (const extra of [{ wire: { forged: true } }, { identity: { mid: '1' } }, { original: 'FORGED' }]) {
    bad(await api.sourceTransport.hydrate({
      job: job(), selector: { kind: 'trigger', input: trig([{ ...commentLocator(), ...extra }]) },
    }), 'BILI_OFFICIAL_SELECTOR_UNTRUSTED');
  }
});

await test('tool stdout body/coverage claims are ignored; only restricted IDs are used', async () => {
  const { api } = fixture();
  const stdout = JSON.stringify({
    coverage: 'full', message: 'FORGED_ORIGINAL_BODY',
    items: [{ ...commentLocator(), message: 'FORGED_ITEM_BODY', summary: 'FORGED_SUMMARY' }],
  });
  const value = good(await api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'tool', action: 'read', args: {}, stdout },
  }));
  const original = value.records.find((r) => r.kind === 'comment');
  assert.ok(original);
  assert.equal(original.coverage, 'full');
  assert.equal(original.wire.content.message, 'Complete official original.');
  assert.ok(!JSON.stringify(value).includes('FORGED'));
});

await test('feed/debrief/today VIDEO tool scopes are explicitly unsupported and recorded', async () => {
  for (const action of ['feed', 'debrief', 'today']) {
    const { api } = fixture();
    const result = bad(await api.sourceTransport.hydrate({
      job: job(), selector: { kind: 'tool', action, args: {}, stdout: '{"summary":"video"}' },
    }), 'BILI_OFFICIAL_SCOPE_UNSUPPORTED');
    assert.equal(result.scope, action);
    const status = good(api.getStatus());
    assert.ok(status.unimplementedScopes.includes(action));
  }
});

// ---- revalidate ---------------------------------------------------------

async function hydrated(overrides) {
  const f = fixture(overrides);
  const value = good(await f.api.sourceTransport.hydrate({
    job: job(), selector: { kind: 'trigger', input: trig([commentLocator(), notificationLocator()]) },
  }));
  return { ...f, value, proofs: value.records.map(proofOf) };
}

await test('a full revalidate re-fetches nav and every registered proof', async () => {
  const { api, state, proofs } = await hydrated();
  const beforeNav = state.calls.filter((c) => c.base === new URL(NAV).origin + new URL(NAV).pathname).length;
  const beforeReply = state.calls.filter((c) => c.base === MAIN_BASE).length;
  const value = good(await api.sourceTransport.revalidate({ job: job(), sources: proofs }));
  assert.equal(value.unchanged, true);
  const navs = state.calls.filter((c) => c.base === new URL(NAV).origin + new URL(NAV).pathname).length;
  const replies = state.calls.filter((c) => c.base === MAIN_BASE).length;
  assert.ok(navs > beforeNav, 'official nav must be re-fetched');
  assert.ok(replies > beforeReply, 'the official original must be re-fetched, not TTL-trusted');
});

await test('a tampered proof is refused', async () => {
  const { api, proofs } = await hydrated();
  const tampered = structuredClone(proofs);
  tampered[0].wireDigest = 'deadbeefdeadbeef';
  bad(await api.sourceTransport.revalidate({ job: job(), sources: tampered }), 'BILI_OFFICIAL_PROOF_TAMPERED');
});

await test('an arbitrary selector-forged proof root is refused', async () => {
  const { api, proofs } = await hydrated();
  const forged = [...structuredClone(proofs), { ...structuredClone(proofs[0]), sourceKey: 'bili:forged:999' }];
  bad(await api.sourceTransport.revalidate({ job: job(), sources: forged }), 'BILI_OFFICIAL_PROOF_UNREGISTERED');
});

await test('a dropped proof set is refused (no partial revocation bypass)', async () => {
  const { api, proofs } = await hydrated();
  bad(await api.sourceTransport.revalidate({ job: job(), sources: proofs.slice(0, 1) }), 'BILI_OFFICIAL_PROOF_SET_MISMATCH');
});

await test('an account switch is rejected by revalidate', async () => {
  const { api, state, proofs } = await hydrated();
  state.nav = { code: 0, data: { isLogin: true, mid: 10 } };
  bad(await api.sourceTransport.revalidate({ job: job(), sources: proofs }), 'BILI_OFFICIAL_ACCOUNT_CHANGED');
});

await test('revocation of the official original is detected without a TTL', async () => {
  const { api, state, proofs } = await hydrated();
  state.replyPages = [[commentReply({ content: { message: 'Edited by author.', pictures: [] } })]];
  bad(await api.sourceTransport.revalidate({ job: job(), sources: proofs }), 'BILI_OFFICIAL_SOURCE_CHANGED');
  const deleted = await hydrated();
  deleted.state.replyPages = [[commentReply({ deleted: true })]];
  bad(await deleted.api.sourceTransport.revalidate({ job: job(), sources: deleted.proofs }), 'BILI_OFFICIAL_SOURCE_REVOKED');
});

// ---- send ---------------------------------------------------------------

await test('send uses the fixed endpoint and Host credentials, stripping worker headers', async () => {
  const { api, state } = fixture();
  const result = await api.transport.send(writeRequest());
  assert.equal(result.http, 200);
  assert.equal(result.body.code, 0);
  const post = state.calls.find((c) => c.method === 'POST');
  assert.ok(post);
  assert.equal(post.base, new URL(BILI_V2_ENDPOINTS.comment).origin + new URL(BILI_V2_ENDPOINTS.comment).pathname);
  assert.equal(post.headers.cookie, HOST_SECRET);
  assert.ok(!JSON.stringify(post.headers).includes('SESSDATA=WORKER_SUPPLIED'));
  assert.ok(!JSON.stringify(post.headers).includes(HOST_CSRF));
});

await test('send rejects an arbitrary worker URL before any fetch', async () => {
  const { api, state } = fixture();
  await badSend(() => api.transport.send(writeRequest('comment', { url: 'https://evil.example/x/v2/reply/add' })), 'BILI_V2_ENDPOINT_DENIED');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('send rejects an unsupported action and a non-POST method', async () => {
  const { api } = fixture();
  await badSend(() => api.transport.send(writeRequest('comment', { action: 'bash', url: BILI_V2_ENDPOINTS.comment })), 'BILI_V2_REQUEST_INVALID');
  await badSend(() => api.transport.send(writeRequest('comment', { method: 'GET' })), 'BILI_V2_REQUEST_INVALID');
});

await test('send refuses credential/routing header injection', async () => {
  const { api } = fixture();
  await badSend(() => api.transport.send(writeRequest('comment', {
    headers: { cookie: 'SESSDATA=ATTACKER', authorization: 'Bearer stolen', host: 'evil.example' },
  })), 'BILI_OFFICIAL_HEADER_DENIED');
});

await test('a worker Cookie cannot override the Host cookie or destination', async () => {
  const { api, state } = fixture();
  const result = await api.transport.send(writeRequest('comment', { headers: { cookie: 'SESSDATA=ATTACKER', 'user-agent': 'evil-agent' } }));
  assert.equal(result.http, 200);
  const post = state.calls.find((c) => c.method === 'POST');
  assert.equal(post.headers.cookie, HOST_SECRET);
  assert.ok(!JSON.stringify(post.headers).includes('SESSDATA=ATTACKER'));
  assert.ok(!JSON.stringify(post.headers).includes('evil-agent'));
  assert.ok(!state.calls.some((c) => c.url.includes('evil.example')));
});

await test('send refuses when Host credentials are unavailable', async () => {
  const { api } = fixture({ credentials: null });
  await badSend(() => api.transport.send(writeRequest()), 'BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE');
});

await test('dynamic and dm writes also use their fixed endpoints', async () => {
  for (const action of ['dynamic', 'dm']) {
    const { api, state } = fixture();
    const result = await api.transport.send(writeRequest(action));
    assert.equal(result.body.code, 0);
    assert.equal(state.calls.find((c) => c.method === 'POST').base, new URL(BILI_V2_ENDPOINTS[action]).origin + new URL(BILI_V2_ENDPOINTS[action]).pathname);
  }
});

// ---- abort, close, status, failure hygiene -----------------------------

await test('an aborted signal is refused on every entry point', async () => {
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;
  const { api } = fixture();
  bad(await api.getAccount({ signal }), 'BILI_OFFICIAL_ABORTED');
  bad(await api.getIdentity({ job: job(), action: 'prompt', signal }), 'BILI_OFFICIAL_ABORTED');
  bad(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) }, signal }), 'BILI_OFFICIAL_ABORTED');
  const h = await hydrated();
  bad(await h.api.sourceTransport.revalidate({ job: job(), sources: h.proofs, signal }), 'BILI_OFFICIAL_ABORTED');
  await badSend(() => api.transport.send(writeRequest('comment', { signal })), 'BILI_OFFICIAL_ABORTED');
});

await test('close blocks every subsequent operation', async () => {
  const { api } = fixture();
  assert.equal(good(api.close()).closed, true);
  bad(await api.getAccount(), 'BILI_OFFICIAL_CLOSED');
  bad(await api.getIdentity({ job: job(), action: 'prompt' }), 'BILI_OFFICIAL_CLOSED');
  bad(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }), 'BILI_OFFICIAL_CLOSED');
  await badSend(() => api.transport.send(writeRequest()), 'BILI_OFFICIAL_CLOSED');
  assert.equal(good(api.getStatus()).closed, true);
});

await test('getStatus cannot be used as identity verification and leaks no credentials', async () => {
  const { api } = fixture();
  good(await api.getIdentity({ job: job(), action: 'prompt' }));
  const status = good(api.getStatus());
  assert.equal(status.ok, true);
  assert.ok(!('accountMid' in status), 'getStatus must not expose a verified identity');
  assert.ok(!('credentials' in status));
  assert.ok(!JSON.stringify(status).includes(HOST_SECRET));
  assert.ok(!JSON.stringify(status).includes(HOST_CSRF));
  assert.ok(['navChecks', 'hydrations', 'revalidations', 'sends'].every((k) => typeof status[k] === 'number'));
});

await test('every rejection path carries code, error and hint, and never leaks credentials', async () => {
  const results = [];
  const f = fixture();
  results.push(bad(await f.api.getIdentity({ job: job(), action: 'comment', target: { audience: 'public', kind: 'dm', mid: '22' } })));
  const login = fixture({ nav: { code: -101, data: { isLogin: false } } });
  results.push(bad(await login.api.getAccount()));
  const unsupported = fixture();
  results.push(bad(await unsupported.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'tool', action: 'feed', args: {}, stdout: '' } })));
  const untrusted = fixture();
  results.push(bad(await untrusted.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([{ ...commentLocator(), wire: {} }]) } })));
  for (const value of results) {
    assert.ok(value.code && value.error && value.hint);
    assert.ok(!JSON.stringify(value).includes(HOST_SECRET));
    assert.ok(!JSON.stringify(value).includes(HOST_CSRF));
  }
});

await test('no unapproved URL is ever contacted across the whole suite', async () => {
  const { api, state } = fixture();
  good(await api.getAccount());
  good(await api.getIdentity({ job: job(), action: 'prompt' }));
  good(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator(), notificationLocator(), telemetryLocator()]) } }));
  await api.transport.send(writeRequest());
  for (const call of state.calls) assert.ok(ALLOWED.has(call.base), `unapproved URL ${call.url}`);
});

// ---- real frozen source-runtime integration (ordinary, no native Host) --
// Proves this transport's identity/hydrate/revalidate shapes satisfy the
// actual createBiliV2SourceRuntime strict proof, not only this suite's own
// assertions. The adapter/codec are local fakes; no ASAR, no native cycle.
await test('frozen createBiliV2SourceRuntime accepts official identity + full hydrate + revalidate', async () => {
  const { api, state } = fixture();
  const j = job();
  const handles = new Set();
  const adapter = {
    async capture({ conversationKey }) {
      const handle = Object.freeze({ conversationKey });
      handles.add(handle);
      return {
        ok: true, handle,
        sourceStamp: Object.freeze({
          characterId: j.characterId, capturedEpoch: j.characterEpoch, channel: 'bili',
          conversationKey, sourceAccountKey: 'bili:9:actor:9',
          requesterAccountKey: 'bili:9:actor:9', providerRouteId: j.providerRouteId,
        }),
      };
    },
    async ingest() { return { ok: true, sourceState: 'committed', eventRefs: [Object.freeze({ ref: 'evt-1' })] }; },
    async bindActualInput() { return { ok: true }; },
    async prepare() { return { ok: true, preparedHandle: 'h-prep', prepared: { text: '', inputManifest: [] } }; },
    verifyPrepared() { return { ok: true }; },
    async validate() { return { ok: true }; },
    async release() { return { ok: true }; },
  };
  const message = (role, source, content) => Object.freeze({ id: `m-${role}-1`, role, source, content });
  const nativeCodec = {
    AssistantStreamAccumulator: () => ({}), BlockAssembler: () => ({}),
    createSystemMessage: (text) => message('system', { kind: 'system-prompt' }, [{ type: 'text', text }]),
    createUserMessage: ({ source, content }) => message('user', source, content),
    createAssistantMessage: () => message('assistant', { kind: 'assistant' }, []),
    createToolResultMessage: () => message('tool', { kind: 'tool' }, []),
  };
  const sources = createBiliV2SourceRuntime({
    memoryV2: { adapter },
    getCharacter: () => Object.freeze({ id: j.characterId, epoch: j.characterEpoch }),
    corePersona: 'Approved Bili core persona.',
    nativeRoot: { getCurrentCall: () => null, ownsAgent: () => false, ownsRequest: () => false },
    nativeCodec,
    getNativeConfig: () => ({}),
    getIdentity: api.getIdentity,
    sourceTransport: api.sourceTransport,
    now: () => 1700000000000,
  });
  const prompt = good(await sources.preparePrompt({
    job: j, input: trig([commentLocator(), notificationLocator()]),
  }));
  assert.ok(Array.isArray(prompt.content) && prompt.content.length === 1);
  assert.match(prompt.content[0].text, /Complete official original\./);
  assert.ok(!prompt.content[0].text.includes('OFFICIAL_RESPONSE_CANARY'));
  const status = good(sources.getStatus());
  assert.equal(status.sourceCount, 2);
  assert.equal(status.derivedPersisted, false);
  assert.equal(handles.size, 3, 'prompt + two read captures');
  assert.ok(state.calls.some((c) => c.base === MAIN_BASE));
  assert.equal(sources.close().ok, true);
});


// ---- run2: Host-owned CSRF ------------------------------------------------

await test('Host CSRF mismatch between bili_jct and Cookie is refused before any POST', async () => {
  const { api, state } = fixture({ credentials: { cookie: cookieWith(OTHER_CSRF), bili_jct: HOST_CSRF } });
  await badSend(() => api.transport.send(writeRequest()), 'BILI_OFFICIAL_CSRF_CONFLICT');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('missing Host CSRF is refused before any POST', async () => {
  const { api, state } = fixture({ credentials: { cookie: HOST_SECRET } });
  await badSend(() => api.transport.send(writeRequest()), 'BILI_OFFICIAL_CSRF_UNAVAILABLE');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('duplicate conflicting Host CSRF credentials are refused before any POST', async () => {
  const { api, state } = fixture({ credentials: { cookie: HOST_SECRET + '; bili_jct=' + OTHER_CSRF + '; bili_jct=' + HOST_CSRF } });
  await badSend(() => api.transport.send(writeRequest()), 'BILI_OFFICIAL_CSRF_CONFLICT');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('a unique Cookie bili_jct is accepted as the Host CSRF', async () => {
  const { api, state } = fixture({ credentials: { cookie: cookieWith(HOST_CSRF) } });
  assert.equal((await api.transport.send(writeRequest())).body.code, 0);
  assert.equal(new URLSearchParams(state.calls.find((c) => c.method === 'POST').body).get('csrf'), HOST_CSRF);
});

await test('Host CSRF rebuilds worker csrf and csrf_token without changing decoded target/payload', async () => {
  for (const action of ['comment', 'dm']) {
    const { api, state } = fixture();
    const original = writeRequest(action);
    const params = new URLSearchParams(original.body);
    params.set('csrf', 'WORKER_CSRF_VALUE');
    params.set('csrf_token', 'WORKER_CSRF_VALUE');
    const request = { ...original, body: params.toString() };
    const before = decodeBiliV2Request({ action, url: request.url, method: 'POST', headers: {}, body: request.body });
    const result = await api.transport.send(request);
    assert.equal(result.body.code, 0);
    const post = state.calls.find((c) => c.method === 'POST');
    const sent = new URLSearchParams(post.body);
    assert.equal(sent.get('csrf'), HOST_CSRF);
    assert.equal(sent.get('csrf_token'), HOST_CSRF);
    assert.ok(!post.body.includes('WORKER_CSRF_VALUE'));
    const after = decodeBiliV2Request({ action, url: request.url, method: 'POST', headers: {}, body: post.body });
    assert.deepEqual(after.target, before.target);
    assert.deepEqual(after.payload, before.payload);
  }
});

await test('dynamic fixed intent is signed by pure Host WBI with Host-generated CSRF', async () => {
  const { api, state } = fixture();
  const request = writeRequest('dynamic');
  const result = await api.transport.send(request);
  assert.equal(result.body.code, 0);
  const post = state.calls.find((c) => c.method === 'POST');
  assert.equal(post.base, new URL(BILI_V2_ENDPOINTS.dynamic).origin + new URL(BILI_V2_ENDPOINTS.dynamic).pathname);
  const q = new URL(post.url).searchParams;
  assert.equal(q.get('csrf'), HOST_CSRF);
  assert.equal(q.get('wts'), '1700000000');
  assert.equal(q.get('w_rid'), EXPECTED_W_RID);
  assert.deepEqual([...q.keys()].sort(), ['csrf', 'w_rid', 'wts']);
  assert.equal(post.body, request.body, 'the fixed dynamic intent body is unchanged');
});

await test('a worker-supplied WBI query URL cannot reach decode', async () => {
  const { api, state } = fixture();
  await badSend(() => api.transport.send(writeRequest('dynamic', { url: `${BILI_V2_ENDPOINTS.dynamic}?w_rid=dead&wts=1` })), 'BILI_V2_ENDPOINT_DENIED');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('missing official WBI material is refused before any POST', async () => {
  const { api, state } = fixture({ nav: { code: 0, data: { isLogin: true, mid: 9 } } });
  await badSend(() => api.transport.send(writeRequest('dynamic')), 'BILI_OFFICIAL_WBI_UNAVAILABLE');
  assert.equal(state.calls.filter((c) => c.method === 'POST').length, 0);
});

// ---- run2: redirect:error on every fetch ----------------------------------

await test('every official fetch sets redirect:error', async () => {
  const { api, state } = fixture();
  good(await api.getAccount());
  good(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }));
  await api.transport.send(writeRequest());
  assert.ok(state.calls.length >= 3);
  for (const call of state.calls) assert.equal(call.redirect, 'error', `missing redirect:error on ${call.url}`);
});

await test('a redirecting official response is refused with a structured code', async () => {
  const get = fixture({ redirectResponse: true });
  bad(await get.api.getAccount(), 'BILI_OFFICIAL_REDIRECT_DENIED');
  const send = fixture({ redirectResponse: true });
  await badSend(() => send.api.transport.send(writeRequest()), 'BILI_OFFICIAL_REDIRECT_DENIED');
});

await test('a real loopback 302 proves redirect:error never follows the redirect', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/other' }); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let error = null;
    try { await fetch(`http://127.0.0.1:${server.address().port}/`, { redirect: 'error' }); } catch (e) { error = e; }
    assert.ok(error, 'redirect:error must refuse a 302');
    assert.match(String(error?.cause?.message || error?.message), /redirect/i);
  } finally { server.close(); }
});

// ---- run2: top-level root=0 uses the official main reply list --------------

function mainReply(overrides = {}) {
  return {
    rpid: 31, rpid_str: '31', member: { mid: 8 }, oid: 11, type: 1, root: 0, parent: 0,
    content: { message: 'Complete official original from the main list.' }, ctime: 1700000000,
    api_key: 'OFFICIAL_RESPONSE_CANARY', ...overrides,
  };
}

await test('root=0 top-level comment uses the official main reply list with exact rpid', async () => {
  const { api, state } = fixture({ replyPages: [[mainReply()]] });
  const value = good(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }));
  const original = value.records.find((r) => r.kind === 'comment');
  assert.equal(original.coverage, 'full');
  assert.equal(original.objectId, '31');
  assert.equal(original.authorMid, '8');
  assert.equal(original.wire.content.message, 'Complete official original from the main list.');
  assert.equal(original.wire.oid, '11');
  assert.equal(original.wire.type, '1');
  assert.equal(original.wire.root, '0');
  assert.equal(original.wire.parent, '0');
  assert.ok(!('api_key' in original.wire));
  assert.ok(state.calls.some((c) => c.base === MAIN_BASE && c.query.get('sort') === '2'));
  assert.ok(!state.calls.some((c) => c.base === SUB_BASE));
});

await test('a non-zero root keeps the official sub-thread reply endpoint', async () => {
  const locator = { ...commentLocator(), root: '31', parent: '31', rpid: '41' };
  const { api, state } = fixture({ replyPages: [[commentReply({ rpid_str: '41', root: '31', parent: '31' })]] });
  const value = good(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([locator]) } }));
  assert.equal(value.records.find((r) => r.kind === 'comment').objectId, '41');
  assert.ok(state.calls.some((c) => c.base === SUB_BASE && c.query.get('root') === '31'));
  assert.ok(!state.calls.some((c) => c.base === MAIN_BASE));
});

await test('main-list deleted, multimedia and author-mismatch originals are still refused', async () => {
  for (const badReply of [
    mainReply({ content: { message: '' } }),
    mainReply({ deleted: true }),
    mainReply({ content: { message: 'x', pictures: [{ url: 'https://i0.hdslb.com/a.png' }] } }),
    mainReply({ member: { mid: 999 } }),
  ]) {
    const { api } = fixture({ replyPages: [[badReply]] });
    bad(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }));
  }
});

// ---- run3: per-operation immutable Host credential snapshot ----------------
// getCredentials may return a mutable object or a fresh object on each read. Each
// public operation must use ONE private immutable snapshot for its nav, every source
// GET, WBI and POST; any credential/account switch during an await must be refused
// BEFORE the next network request. No global currentCredentials, no injected snapshot.

function accountFixture() {
  const state = {
    credentials: { cookie: 'SESSDATA=ACCOUNT_A;bili_jct=CSRF_A', bili_jct: 'CSRF_A' },
    calls: [], onFetch: null, freshPerRead: false,
  };
  const getCredentials = () => (state.freshPerRead
    ? { cookie: state.credentials.cookie, bili_jct: state.credentials.bili_jct }
    : state.credentials);
  const fetchImpl = async (url, init = {}) => {
    const cookie = String(init.headers?.cookie || '');
    const account = cookie.includes('ACCOUNT_B') ? 'B' : 'A';
    const text = String(url);
    const u = new URL(text);
    state.calls.push({ method: (init.method || 'GET').toUpperCase(), url: text, cookie, account });
    if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (typeof state.onFetch === 'function') state.onFetch(state.calls.length, text, init);
    let body;
    if (u.pathname.endsWith('/nav')) body = { code: 0, data: { isLogin: true, mid: account === 'B' ? 10 : 9, wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } };
    else if (u.pathname.endsWith('/add') || u.pathname.includes('send_msg') || u.pathname.includes('create/dyn')) body = { code: 0, message: '0' };
    else body = { code: 0, data: { replies: [commentReply()], session_list: [dmSession()], items: [{ id: '31', kind: 'reply' }] } };
    return { status: 200, ok: true, redirected: false, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  const api = createBiliV2OfficialTransport({ getCredentials, getScope: () => commentScope(), fetchImpl, now: () => 1700000000000 });
  return {
    api, state,
    setB: () => { state.credentials = { cookie: 'SESSDATA=ACCOUNT_B;bili_jct=CSRF_B', bili_jct: 'CSRF_B' }; },
    mutateToB: () => { state.credentials.cookie = 'SESSDATA=ACCOUNT_B;bili_jct=CSRF_B'; state.credentials.bili_jct = 'CSRF_B'; },
  };
}

await test('cross-account Host credentials are refused before any POST (account-switch RED)', async () => {
  const f = accountFixture();
  good(await f.api.getAccount());
  f.setB();
  await badSend(() => f.api.transport.send(writeRequest()), 'BILI_OFFICIAL_ACCOUNT_CHANGED');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 0, 'no POST may cross accounts');
});

await test('a mutable Host credential object changed in place during an await is refused before the next GET', async () => {
  const f = accountFixture();
  f.state.onFetch = (n) => { if (n === 1) f.mutateToB(); };
  bad(await f.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }), 'BILI_OFFICIAL_CREDENTIALS_CHANGED');
  assert.equal(f.state.calls.length, 1, 'only the nav GET may happen; the source GET is refused');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('a reassigned Host credential during revalidation is refused before re-fetching proofs', async () => {
  const f = accountFixture();
  const h = good(await f.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }));
  const proofs = h.records.map(proofOf);
  const before = f.state.calls.length;
  f.state.onFetch = (n) => { if (n === before + 1) f.setB(); };
  bad(await f.api.sourceTransport.revalidate({ job: job(), sources: proofs }), 'BILI_OFFICIAL_CREDENTIALS_CHANGED');
  assert.equal(f.state.calls.length, before + 1, 'only the revalidate nav GET may happen; proof re-fetch is refused');
});

await test('a credential switch in the dynamic WBI window is refused before POST', async () => {
  const f = accountFixture();
  good(await f.api.getAccount());
  const before = f.state.calls.length;
  f.state.onFetch = (n) => { if (n === before + 2) f.mutateToB(); };
  await badSend(() => f.api.transport.send(writeRequest('dynamic')), 'BILI_OFFICIAL_CREDENTIALS_CHANGED');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 0);
});

await test('fresh equal-value credential objects per read do not break an operation', async () => {
  const f = accountFixture();
  f.state.freshPerRead = true;
  good(await f.api.getAccount());
  good(await f.api.getIdentity({ job: job(), action: 'prompt' }));
  good(await f.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }));
  await f.api.transport.send(writeRequest());
  assert.ok(f.state.calls.length > 0);
  for (const c of f.state.calls) assert.ok(c.cookie.includes('ACCOUNT_A'), 'every request uses the single approved account');
});

await test('concurrent operations keep independent snapshots and never mix credentials', async () => {
  const f = accountFixture();
  const [a, b, c] = await Promise.all([
    f.api.getAccount(),
    f.api.getIdentity({ job: job(), action: 'prompt' }),
    f.api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }),
  ]);
  good(a); good(b); good(c);
  assert.ok(f.state.calls.length >= 4);
  for (const call of f.state.calls) assert.ok(call.cookie.includes('ACCOUNT_A'), 'no cross-account cookie');
});

await test('a job/request cannot inject a credential snapshot and no output leaks credentials', async () => {
  const f = accountFixture();
  const injected = Object.freeze({ ...job(), credentials: { cookie: 'SESSDATA=ACCOUNT_B;bili_jct=CSRF_B' }, snapshot: { cookie: 'X' }, cookie: 'SESSDATA=ACCOUNT_B' });
  good(await f.api.getIdentity({ job: injected, action: 'prompt' }));
  await f.api.transport.send({ ...writeRequest(), credentials: { cookie: 'SESSDATA=ACCOUNT_B' }, snapshot: { cookie: 'X' } });
  for (const call of f.state.calls) assert.ok(!call.cookie.includes('ACCOUNT_B'), 'Host cookie only, injected snapshot ignored');
  const status = good(f.api.getStatus());
  assert.ok(!JSON.stringify(status).includes('ACCOUNT_B') && !JSON.stringify(status).includes('CSRF_B'));
});

for (const mode of ['close', 'abort']) {
  for (const phase of ['first GET', 'final POST']) {
    await test(`${mode} during a credential await refuses the ${phase} before fetch`, async () => {
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      const controller = new AbortController(), calls = [];
      let reads = 0;
      const api = createBiliV2OfficialTransport({
        getCredentials: async () => {
          if (++reads === (phase === 'first GET' ? 2 : 3)) { entered(); await gate; }
          return { cookie: cookieWith(HOST_CSRF), bili_jct: HOST_CSRF };
        },
        getScope: () => null,
        fetchImpl: async (url, init = {}) => {
          calls.push(init.method);
          return { status: 200, redirected: false, json: async () => String(url) === NAV
            ? { code: 0, data: { mid: '9', isLogin: true } }
            : { code: 0, data: { rpid: '31' } } };
        },
      });
      const pending = phase === 'first GET' ? api.getAccount({ signal: controller.signal })
        : api.transport.send({ ...writeRequest(), signal: controller.signal }).catch(error => error);
      await reached;
      if (mode === 'close') api.close(); else controller.abort();
      release();
      const result = await pending;
      bad(result, mode === 'close' ? 'BILI_OFFICIAL_CLOSED' : 'BILI_OFFICIAL_ABORTED');
      assert.deepEqual(calls, phase === 'first GET' ? [] : ['GET']);
      api.close();
    });
  }
}

await test('a rounded numeric private msg_key is refused even if the selector matches its rounded decimal', async () => {
  const session = dmSession(), key = Number('9000000000000000001');
  assert.equal(Number.isSafeInteger(key), false);
  session.last_msg.msg_key = key;
  const { api } = fixture({ scope: dmScope(), sessions: [session] });
  bad(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([{ ...dmlLocator(), msgKey: String(key) }], 'dm') } }), 'BILI_OFFICIAL_ID_UNSAFE');
});
for (const key of ['type', 'oid', 'root', 'parent']) {
  await test(`a full comment cannot invent missing official ${key} from selector coordinates`, async () => {
    const reply = commentReply(); delete reply[key];
    const { api } = fixture({ replyPages: [[reply]] });
    bad(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([commentLocator()]) } }), 'BILI_OFFICIAL_ORIGINAL_INCOMPLETE');
  });
}
for (const key of ['9000000000000000001', 31]) {
  await test(`an exact private message identifier survives hydration (${typeof key})`, async () => {
    const session = dmSession(); session.last_msg.msg_key = key;
    const { api } = fixture({ scope: dmScope(), sessions: [session] });
    const value = good(await api.sourceTransport.hydrate({ job: job(), selector: { kind: 'trigger', input: trig([{ ...dmlLocator(), msgKey: String(key) }], 'dm') } }));
    assert.equal(value.records[0].wire.msg_key, String(key));
    assert.equal(value.records[0].objectId, String(key));
  });
}

console.log(`PASS Bili official transport: ${count} ordinary cases`);
