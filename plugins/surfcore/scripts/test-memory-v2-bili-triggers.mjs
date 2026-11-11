import assert from 'node:assert/strict';
import { pullFeed } from '../tools/lib/msgfeed.mjs';

const originalFetch = globalThis.fetch;
let message;
try {
  globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { items: [{ id: '700', user: { mid: '8' }, item: { uri: 'https://www.bilibili.com/video/av11', business_id: 1, subject_id: '11', root_id: '0', source_id: '31', target_id: '0', source_content: 'DO_NOT_TRUST_THIS_DIGEST' } }] } }) });
  [message] = (await pullFeed('reply', { headers: {}, pages: 1 })).items;
  assert.equal(message.sourceRoot, '0', 'The notification must retain its original root separately from POST coordinates.');
  assert.equal(message.root, '31'); assert.equal(message.parent, '31');
} finally { globalThis.fetch = originalFetch; }

const { projectBiliV2Trigger } = await import('../lib/bili-v2-triggers.mjs');
const providerRouteId = 'route:trigger-fixture';
const project = input => projectBiliV2Trigger({ input, providerRouteId });
const bad = value => { assert.equal(value.ok, false); assert.ok(value.code && value.error && value.hint); };
const first = project({ kind: 'comment-notification', items: [message] });
assert.equal(first.ok, true, JSON.stringify(first));
assert.equal(first.groups.length, 1);
const group = first.groups[0];
assert.deepEqual(group.scope, { audience: 'public', target: { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '31', parent: '31' }, providerRouteId });
assert.deepEqual(group.input.items, [{ kind: 'comment', rpid: '31', type: '1', oid: '11', root: '0', parent: '0', authorMid: '8' }]);
assert.equal(JSON.stringify(first).includes('DO_NOT_TRUST'), false);
assert.equal(Object.isFrozen(group.scope.target), true);
assert.equal(Object.isFrozen(group.input.items[0]), true);
const other = { ...message, sourceId: '32', sourceRoot: '30', targetId: '30', root: '30', parent: '32' };
assert.equal(project({ kind: 'comment-notification', items: [message, other] }).groups.length, 2);
assert.equal(project({ kind: 'comment-notification', items: [message, message] }).groups[0].input.items.length, 1);
for (const changed of [{ sourceRoot: undefined }, { sourceId: 9000000000000000000 }, { business: 999 }, { mid: {} }, { oid: '' }]) bad(project({ kind: 'comment-notification', items: [{ ...message, ...changed }] }));
const key = '9000000000000000001';
const dm = project({ kind: 'dm-notification', items: [{ mid: '22000', msgKey: key, text: 'PRIVATE_DIGEST', who: 'ignored' }] });
assert.equal(dm.ok, true, JSON.stringify(dm));
assert.deepEqual(dm.groups[0].scope.target, { audience: 'private', kind: 'dm', mid: '22000' });
assert.deepEqual(dm.groups[0].input.items, [{ kind: 'dm', mid: '22000', msgKey: key }]);
assert.equal(JSON.stringify(dm).includes('PRIVATE_DIGEST'), false);
for (const msgKey of [undefined, '', 9000000000000000000, {}, -1]) bad(project({ kind: 'dm-notification', items: [{ mid: '22000', msgKey }] }));
assert.equal(project({ kind: 'dm-notification', items: [{ mid: 22000, msgKey: 31 }] }).groups[0].input.items[0].msgKey, '31');
bad(project({ kind: 'daily-nudge', note: 'unregistered local telemetry' }));
bad(project({ kind: 'comment-notification', items: [] }));
bad(project({ kind: 'dm-notification', items: Array.from({ length: 33 }, () => ({ mid: '22000', msgKey: '31' })) }));
bad(projectBiliV2Trigger({ input: { kind: 'dm-notification', items: [{ mid: '22000', msgKey: '31' }] }, providerRouteId: '' }));
const { createBiliV2OfficialTransport } = await import('../lib/bili-v2-official-transport.mjs');
const calls = [];
const official = createBiliV2OfficialTransport({
  getCredentials: () => ({ cookie: 'fixture-cookie' }), getScope: () => group.scope,
  fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push(u.pathname);
    assert.equal(init.redirect, 'error');
    if (u.pathname === '/x/web-interface/nav') return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: '9' } }) };
    assert.equal(u.pathname, '/x/v2/reply');
    assert.equal(u.searchParams.get('oid'), '11');
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { replies: [{ rpid_str: '31', type: '1', oid: '11', root: '0', parent: '0', member: { mid: '8' }, content: { message: 'COMPLETE_OFFICIAL_TEXT', pictures: [] }, ctime: 1700000000 }], page: { count: 1 } } }) };
  },
});
const job = { jobId: 'projected-trigger', requestId: 'trigger-request', sessionId: 'trigger-session', characterId: 'alpha', characterEpoch: 1, providerRouteId, provider: 'fixture', model: 'fixture' };
try {
  const hydrated = await official.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: group.input } });
  assert.equal(hydrated.ok, true, JSON.stringify(hydrated));
  assert.equal(hydrated.records[0].wire.content.message, 'COMPLETE_OFFICIAL_TEXT');
  assert.equal(hydrated.records[0].wire.root, '0');
  const readIdentity = await official.getIdentity({ job, action: 'read', target: hydrated.records[0].target });
  const sendIdentity = await official.getIdentity({ job, action: 'send', target: group.scope.target });
  assert.equal(readIdentity.ok, true); assert.equal(sendIdentity.ok, true);
  assert.equal(readIdentity.conversationKey, sendIdentity.conversationKey);
  assert.equal(sendIdentity.target.parent, '31');
  bad(await official.getIdentity({ job, action: 'read', target: { ...group.scope.target, oid: '12' } }));
  assert.equal(calls.some(path => path.includes('reply/add')), false);
} finally { official.close(); }

console.log('PASS Bili trigger projection: original/write coordinates, exact IDs, target grouping, digest stripping and explicit unsupported paths');
