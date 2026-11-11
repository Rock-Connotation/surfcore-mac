import assert from 'node:assert/strict';
import { createBiliV2OfficialTransport } from '../lib/bili-v2-official-transport.mjs';
import { deriveBiliV2PublicSourceSet } from '../lib/bili-v2-public-source-set.mjs';
import { biliV2InputDigest } from '../lib/bili-v2-agent.mjs';

const job = Object.freeze({ jobId: 'job', characterId: 'alpha', characterEpoch: 1, providerRouteId: 'route:test' });
const video = { kind: 'video', bvid: 'BV1234567890', aid: '9007199254740993123', authorMid: '9007199254740993124' };
const comment = { kind: 'comment', rpid: '31', type: '1', oid: '11', root: '0', parent: '0', authorMid: '8' };
const comment2 = { ...comment, rpid: '32' };
const target = { audience: 'public', kind: 'dynamic' };
const setFor = (selectors = [video, comment, comment2]) => deriveBiliV2PublicSourceSet({ characterId: job.characterId, characterEpoch: job.characterEpoch, accountMid: '9', providerRouteId: job.providerRouteId, selectors, outputTarget: target });
const videoTarget = { audience: 'public', kind: 'video', bvid: video.bvid, aid: video.aid };
const commentTarget = { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' };
const proofOf = r => ({ sourceKey: r.sourceKey, revision: r.revision, objectId: r.objectId, authorMid: r.authorMid, audience: r.audience, target: r.target, wireDigest: biliV2InputDigest({ value: r.wire }) });
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const bad = r => { assert.equal(r.ok, false); for (const k of ['code', 'error', 'hint']) assert.ok(typeof r[k] === 'string' && r[k]); return r; };
function fixture() {
  const state = { credentials: { cookie: 'fixture-cookie' }, scope: { audience: 'public', target, providerRouteId: job.providerRouteId, publicSourceSet: setFor() }, mid: '9', calls: [], pubdate: 1700000000, changed: false, authorMid: video.authorMid, commentRoot: '0' };
  const api = createBiliV2OfficialTransport({ getCredentials: () => state.credentials, getScope: () => state.scope, fetchImpl: async url => {
    const u = new URL(url); state.calls.push(u.pathname);
    let data;
    if (u.pathname.endsWith('/nav')) data = { isLogin: true, mid: state.mid };
    else if (u.pathname.endsWith('/view')) data = { bvid: video.bvid, aid: video.aid, title: state.changed ? 'changed' : 'title', desc: 'description', owner: { mid: state.authorMid, name: 'author' }, pubdate: state.pubdate };
    else if (u.pathname.endsWith('/reply')) data = { replies: [comment, comment2].map(c => ({ rpid_str: c.rpid, member: { mid: c.authorMid }, type: c.type, oid: c.oid, root: state.commentRoot, parent: c.parent, content: { message: 'original', pictures: [] }, ctime: 1700000000 })) };
    else throw new Error('unexpected network');
    return { status: 200, json: async () => ({ code: 0, data }) };
  } });
  return { api, state };
}
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
await test('inspect videos uses fresh NAV and returns frozen canonical identifiers', async () => {
  const f = fixture(); const result = ok(await f.api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }, { kind: 'video', aid: video.aid }] }));
  assert.deepEqual(result.selectors, [video, video]); assert.equal(result.accountMid, '9'); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.selectors) && Object.isFrozen(result.selectors[0]));
  assert.deepEqual(f.state.calls, ['/x/web-interface/nav', '/x/web-interface/view', '/x/web-interface/view']);
  ok(await fixture().api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }], signal: new AbortController().signal }));
  const controller = new AbortController(); controller.abort(); bad(await fixture().api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }], signal: controller.signal }));
});
await test('inspect video rejects invalid counts and shapes', async () => {
  for (const locators of [[], Array(32).fill({ kind: 'video', bvid: video.bvid }), [{ kind: 'video', bvid: video.bvid, aid: video.aid }], [{ kind: 'video', aid: 9007199254740992 }], [{ kind: 'video', bvid: video.bvid, text: 'extra' }]]) bad(await fixture().api.inspectVideos({ locators }));
});
await test('public output and two same-coordinate comments receive distinct aliases', async () => {
  const f = fixture(), set = f.state.scope.publicSourceSet;
  for (const action of ['prompt', 'live', 'dynamic', 'read']) assert.equal(ok(await f.api.getIdentity({ job, action })).conversationKey, set.outputConversationKey);
  for (const member of [video, comment, comment2]) {
    const result = ok(await f.api.getIdentity({ job, action: 'read', target: member.kind === 'video' ? videoTarget : commentTarget, ...member }));
    assert.equal(result.conversationKey, set.sourceConversations.find(x => x.selector.rpid === member.rpid && x.selector.kind === member.kind).conversationKey);
    assert.equal(Object.keys(result).length, 8);
  }
  assert.notEqual(set.sourceConversations.find(x => x.selector.rpid === '31').conversationKey, set.sourceConversations.find(x => x.selector.rpid === '32').conversationKey);
});
await test('selector container, mixed, partial, non-read, physical target and outsider fail', async () => {
  for (const request of [
    { job, action: 'read', target: videoTarget, sourceSelector: video },
    { job, action: 'read', target: videoTarget, ...video, rpid: '31' },
    { job, action: 'read', target: videoTarget, kind: 'video', bvid: video.bvid },
    ...['prompt', 'live', 'dynamic', 'send'].map(action => ({ job, action, target: videoTarget, ...video })),
    { job, action: 'read', target: commentTarget, ...video },
    { job, action: 'read', target: commentTarget, ...comment, rpid: '33' },
    { job, action: 'comment', target: commentTarget },
  ]) bad(await fixture().api.getIdentity(request));
});
await test('all full public-set fields and bindings are revalidated', async () => {
  const mutations = [s => { s.ok = false; }, s => { s.id = 'a'.repeat(64); }, s => { s.label += 'x'; }, s => { s.outputConversationKey += 'x'; }, s => { s.outputTarget.kind = 'comment'; }, s => { s.selectors[0].authorMid = '123'; }, s => { s.sourceConversations[0].conversationKey += 'x'; }, s => { s.sourceConversations[0].selector.authorMid = '123'; }, s => { s.extra = 1; }, s => { s.selectors.reverse(); }];
  for (const mutate of mutations) { const f = fixture(); f.state.scope.publicSourceSet = structuredClone(f.state.scope.publicSourceSet); mutate(f.state.scope.publicSourceSet); bad(await f.api.getIdentity({ job, action: 'prompt' })); }
  for (const alteredJob of [{ ...job, characterId: 'beta' }, { ...job, characterEpoch: 2 }, { ...job, providerRouteId: 'route:other' }]) bad(await fixture().api.getIdentity({ job: alteredJob, action: 'prompt' }));
  const f = fixture(); f.state.mid = '10'; bad(await f.api.getIdentity({ job, action: 'prompt' }));
});
await test('typed feed and debrief return only approved bounded locators', async () => {
  const f = fixture(), set = f.state.scope.publicSourceSet;
  const feed = ok(await f.api.transport.read({ job, action: 'feed', args: { kind: 'feed' } })); assert.deepEqual(JSON.parse(feed.stdout), { items: set.selectors });
  const debrief = ok(await f.api.transport.read({ job, action: 'debrief', args: { kind: 'debrief', bv: video.bvid } })); assert.deepEqual(JSON.parse(debrief.stdout), { items: [video] });
  for (const [action, args] of [['feed', { kind: 'feed', bv: video.bvid }], ['debrief', { kind: 'debrief', bv: 'BV9999999999' }], ['debrief', { kind: 'debrief', bv: video.bvid, x: '1' }], ['today', { kind: 'today' }]]) bad(await f.api.transport.read({ job, action, args }));
  for (const scope of [{ audience: 'public', target, providerRouteId: job.providerRouteId }, { audience: 'private', target: { audience: 'private', kind: 'dm', mid: '8' }, providerRouteId: job.providerRouteId }]) { const g = fixture(); g.state.scope = scope; bad(await g.api.transport.read({ job, action: 'feed', args: { kind: 'feed' } })); }
});
await test('hydrate and revalidate fetch exact official originals and output alias', async () => {
  const f = fixture(), set = f.state.scope.publicSourceSet;
  const result = ok(await f.api.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: { kind: 'public-source-set', items: set.selectors } } }));
  assert.equal(result.conversationKey, set.outputConversationKey); assert.equal(result.records.length, 3);
  const record = result.records.find(r => r.kind === 'video'); assert.equal(Object.keys(record).length, 10); assert.equal(record.objectId, video.aid); assert.deepEqual(record.target, videoTarget); assert.equal(record.coverage, 'text-only'); assert.deepEqual(record.wire, { bvid: video.bvid, aid: video.aid, title: 'title', desc: 'description', owner: { mid: video.authorMid, name: 'author' }, pubdate: 1700000000 });
  const proofs = result.records.map(proofOf); ok(await f.api.sourceTransport.revalidate({ job, sources: proofs })); f.state.changed = true; bad(await f.api.sourceTransport.revalidate({ job, sources: proofs }));
});
await test('tool hydration accepts only exact generated members and denies tampering', async () => {
  const f = fixture(), args = { kind: 'debrief', bv: video.bvid }; const { stdout } = ok(await f.api.transport.read({ job, action: 'debrief', args }));
  const selector = { kind: 'tool', action: 'debrief', args, stdout }; assert.equal(ok(await f.api.sourceTransport.hydrate({ job, selector })).records.length, 1);
  bad(await f.api.sourceTransport.hydrate({ job, selector: { ...selector, stdout: JSON.stringify({ items: [{ ...video, aid: '1' }] }) } }));
  bad(await f.api.sourceTransport.hydrate({ job, selector: { ...selector, stdout: ' '.repeat(32769) } }));
  bad(await f.api.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: { kind: 'public-source-set', items: [{ ...video, aid: '1' }] } } }));
});
await test('unsafe objects invoke no getters or proxy traps', async () => {
  for (const mode of ['getter', 'proxy']) {
    let hits = 0;
    const evil = mode === 'proxy' ? new Proxy({}, { get() { hits++; throw Error(); }, getPrototypeOf() { hits++; throw Error(); }, ownKeys() { hits++; throw Error(); } }) : Object.defineProperty({}, 'kind', { enumerable: true, get() { hits++; throw Error(); } });
    const f = fixture();
    bad(await f.api.inspectVideos({ locators: [evil] })); bad(await f.api.transport.read({ job, action: 'feed', args: evil })); bad(await f.api.getIdentity(evil));
    bad(await f.api.sourceTransport.hydrate({ job, selector: evil }));
    bad(await f.api.sourceTransport.revalidate({ job, sources: [evil] }));
    bad(await f.api.sourceTransport.revalidate({ job, sources: evil }));
    bad(await f.api.getIdentity({ job: evil, action: 'prompt' }));
    bad(await f.api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }], signal: evil }));
    for (const method of [f.api.inspectVideos, f.api.transport.read, f.api.sourceTransport.hydrate, f.api.sourceTransport.revalidate]) bad(await method(evil));
    f.state.scope.publicSourceSet = evil; bad(await f.api.getIdentity({ job, action: 'prompt' }));
    assert.equal(hits, 0);
  }
});
await test('date bounds and changed identifiers are enforced', async () => {
  for (const n of [0, -1, 1.5, 8640000000001]) { const f = fixture(); f.state.pubdate = n; bad(await f.api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }] })); }
  const f = fixture(); f.state.pubdate = 8640000000000; ok(await f.api.inspectVideos({ locators: [{ kind: 'video', aid: video.aid }] }));
  const g = fixture(); const wrong = { ...video, aid: '9007199254740993125' }; g.state.scope.publicSourceSet = setFor([wrong]); bad(await g.api.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: { kind: 'public-source-set', items: [wrong] } } }));
  const h = fixture(); h.state.authorMid = '123'; bad(await h.api.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: { kind: 'public-source-set', items: [video] } } }));
  const c = fixture(); c.state.commentRoot = '44'; bad(await c.api.sourceTransport.hydrate({ job, selector: { kind: 'trigger', input: { kind: 'public-source-set', items: [comment] } } }));
});
await test('credentials and fresh account changes fail closed without leaking errors', async () => {
  const f = fixture(); f.state.credentials = null; const failure = bad(await f.api.inspectVideos({ locators: [{ kind: 'video', bvid: video.bvid }] })); assert.ok(!JSON.stringify(failure).includes('fixture-cookie'));
  const g = fixture(); ok(await g.api.getIdentity({ job, action: 'prompt' })); g.state.mid = '10'; bad(await g.api.transport.read({ job, action: 'feed', args: { kind: 'feed' } }));
});
console.log(`PASS public read: ${count} focused cases`);
