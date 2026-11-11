import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { canonical, digest } from '../src/core/memory-v2-contract.js';
import { createSpool, readSpool } from '../src/core/memory-v2-spool.js';

const root = path.resolve('_backups/memory-v2-kernel', `kernel-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const services = [], management = Symbol('authenticated-settings-transport');
const facts = { channel: 'qq', conversationKey: 'qq:login:private:a', sourceAccountKey: 'qq:login:actor:a', requesterAccountKey: 'qq:login:actor:a', providerRouteId: 'local:test', purpose: 'conversation' };
const publicFacts = { ...facts, conversationKey: 'qq:login:group:one', requesterAccountKey: 'qq:login:actor:b' };
const base = { ...facts, audiencePolicyId: 'private', processingGrantId: 'grant-one' };
const publicBase = { ...publicFacts, audiencePolicyId: 'public', processingGrantId: 'grant-one' };
const audience = (value) => [value.channel, value.conversationKey, value.requesterAccountKey];
const privatePolicy = { policyId: 'private', approved: true, audiences: [audience(facts)], processingGrants: [{ grantId: 'grant-one', providerRouteId: 'local:test' }] };
const publicPolicy = { ...privatePolicy, policyId: 'public', audiences: [audience(facts), audience(publicFacts)] };
let count = 0, eventSequence = 0;
function good(result) { assert.equal(result?.ok, true, JSON.stringify(result)); return result; }
function bad(result, code) { assert.equal(result?.ok, false, JSON.stringify(result)); assert.equal(result.code, code, JSON.stringify(result)); assert.ok(result.error); assert.ok(result.hint); return result; }
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }
function instance(name, faults = {}, existing) {
  const dir = existing?.dir ?? path.join(root, name);
  let character = existing?.getCharacter() ?? { id: 'alpha', epoch: 1 }, actualWorker;
  const service = createMemoryService({ stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => character, now: () => fixture.clock,
    authorizeManagement: (authorization) => authorization === management,
    workerFactory: (url, options) => { actualWorker = new Worker(url, { ...options, workerData: { ...options.workerData, faults } }); return actualWorker; } });
  const fixture = { dir, service, clock: Date.parse('2026-11-09T12:00:00Z'), getCharacter: () => character, setCharacter(value) { character = value; }, worker: () => actualWorker };
  services.push(service); return fixture;
}
async function admin(f) { return good(await f.service.host.captureAdminContext(base, management)).context; }
async function context(f, input = base) { return good(await f.service.captureContext(input)).context; }
async function action(f, value, id) { const ctx = await admin(f); return f.service.applyMemoryAction(ctx, value, ctx.controlRevision, id); }
async function setup(f) {
  const status = good(await f.service.initialize()); assert.equal(status.activeBackend, 'v1'); assert.equal(status.capabilities.activation, false); assert.deepEqual(status.pragmas, { journal_mode: 'delete', synchronous: 3, foreign_keys: 1 });
  good(await action(f, { type: 'configure_policy', policy: privatePolicy }, 'setup-private'));
  good(await action(f, { type: 'configure_policy', policy: publicPolicy }, 'setup-public'));
  good(await action(f, { type: 'enable_shadow', enabled: true }, 'setup-shadow'));
}
function raw(id, content = '小明说他没有答应见面，只是提出计划。', extra = {}) {
  return { eventId: id, sourceKey: `source:${id}`, operationId: `source-op:${id}`, producerId: 'p', segmentId: 's', producerSeq: ++eventSequence, subject: facts.sourceAccountKey, content, ...extra };
}
async function ingest(f, ctx, item, id = `ingest:${item.eventId}`) { return good(await f.service.ingestEvents(ctx, [item], id)); }
async function ref(f, ctx, query, id) {
  const found = good(await f.service.searchMemory(ctx, query)).records.find((item) => item.id === id);
  assert.ok(found, `missing evidence ${id}`);
  return { type: found.type, id: found.id, revision: found.revision, payloadDigest: found.payloadDigest };
}
async function proposal(f, ctx, refs, cited, values = {}) {
  good(await f.service.host.bindInputManifest(ctx, refs));
  return f.service.proposeMemory(ctx, { operationId: `proposal:${randomUUID()}`, propositionKey: 'meeting-plan', expectedRevision: 0, kind: 'fact', content: '小明没有答应见面，只提出计划。', subject: facts.sourceAccountKey, certainty: 'reported', evidenceRefs: [{ ...cited, start: 0, end: '小明'.length, text: '小明' }], ...values });
}
try {
  const f = instance('main');
  await test('real worker, independent databases, default V1, explicit policy and shadow capabilities', async () => {
    good(await f.service.initialize());
    bad(await f.service.captureContext(base), 'MEMORY_POLICY_DENIED');
    bad(await f.service.captureContext({ ...base, purpose: 'admin' }), 'MEMORY_ADMIN_REQUIRED');
    bad(await f.service.host.captureAdminContext(base, 'model-admin'), 'MEMORY_ADMIN_REQUIRED');
    const defaultDenied = createMemoryService({ stateDir: path.join(root, 'deny'), charactersDir: path.join(root, 'deny-roles'), getCharacter: f.getCharacter }); services.push(defaultDenied);
    good(await defaultDenied.initialize()); bad(await defaultDenied.host.captureAdminContext(base, management), 'MEMORY_ADMIN_REQUIRED'); good(await defaultDenied.close());
    await setup(f);
    const ctx = await context(f);
    bad(await f.service.searchMemory({ ...ctx }, 'meeting'), 'MEMORY_CONTEXT_UNTRUSTED');
    bad(await f.service.getMemoryReceipt(ctx), 'MEMORY_SCHEMA_INVALID'); good(await f.service.validateContext(ctx));
    bad(await f.service.applyMemoryAction(ctx, { type: 'enable_shadow', enabled: true }, ctx.controlRevision, 'fake-admin'), 'MEMORY_ADMIN_REQUIRED');
    const adminCtx = await admin(f); bad(await f.service.applyMemoryAction(adminCtx, { type: 'activate' }, adminCtx.controlRevision, 'activate'), 'MEMORY_ACTION_UNAVAILABLE');
    assert.ok(fs.existsSync(path.join(f.dir, 'state/memory-control.sqlite'))); assert.ok(fs.existsSync(path.join(f.dir, 'characters/alpha/memory/memory-v2.sqlite')));
    const resolved = good(await f.service.host.resolveAudience(publicFacts)); assert.equal(resolved.audiencePolicyId, 'public'); good(await f.service.captureContext(resolved));
    bad(await f.service.host.resolveAudience(facts), 'MEMORY_AUDIENCE_AMBIGUOUS');
    bad(await f.service.host.resolveAudience({ ...publicFacts, providerRouteId: 'other' }), 'MEMORY_POLICY_DENIED');
    bad(await f.service.host.resolveAudience({ ...publicFacts, audiencePolicyId: 'public' }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await action(f, { type: 'configure_policy', policy: { ...privatePolicy, audiences: publicPolicy.audiences } }, 'broaden'), 'MEMORY_POLICY_IMMUTABLE');
  });
  await test('installation-wide live writer lock refuses a concurrent worker', async () => {
    const second = instance('same-installation', {}, f); bad(await second.service.initialize(), 'MEMORY_WRITER_LOCKED'); good(await second.service.close());
    good(await f.service.getStatus());
  });
  await test('proven-stale PID/start ownership recovers once under simultaneous contenders', async () => {
    const first = instance('stale-lock'), second = instance('stale-contender', {}, first), dir = path.join(first.dir, 'state'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory-v2.writer.lock'), canonical({ pid: process.pid, startIdentity: 'synthetic-old-start-identity', installRoot: fs.realpathSync(dir), ownerToken: 'stale-owner' }));
    const results = await Promise.all([first.service.initialize(), second.service.initialize()]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    bad(results.find((result) => !result.ok), 'MEMORY_WRITER_LOCKED');
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.retired-')).length, 1);
    const winner = results[0].ok ? first : second; good(await winner.service.close());
    assert.equal(fs.existsSync(path.join(dir, 'memory-v2.writer.lock.acquiring')), false);
  });
  await test('real worker rejects unsigned channel requests without touching persistent state', async () => {
    const live = await context(f), originalWorker = f.worker();
    async function rejectedPacket(packet, id) {
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { f.worker().off('message', listener); reject(new Error('Worker rejection response missing')); }, 5000);
        const listener = (message) => { if (message.id === id) { clearTimeout(timer); f.worker().off('message', listener); resolve(message.result); } }; f.worker().on('message', listener);
      });
      f.worker().postMessage(packet);
      bad(await response, 'MEMORY_WORKER_STAMP_INVALID');
      good(await f.service.validateContext(live)); assert.equal(f.worker(), originalWorker);
      assert.equal(good(await f.service.getStatus()).revision, 3);
    }
    for (const method of ['applyMemoryAction', 'close']) {
      const id = `unsigned-${method}`;
      await rejectedPacket({ id, method, args: [], now: f.clock, signature: '0'.repeat(64) }, id);
    }
    await rejectedPacket(null, null); await rejectedPacket('malformed', null);
    good(await f.service.validateContext(await context(f)));
  });
  await test('atomic event import, immutable operation/source digests, and no partial conflict batch', async () => {
    const ctx = await context(f), first = raw('private-a');
    const one = await ingest(f, ctx, first, 'batch-a'); assert.equal(one.sourceState, 'committed');
    assert.deepEqual(good(await f.service.ingestEvents(ctx, [first], 'batch-a')), one);
    bad(await f.service.ingestEvents(ctx, [{ ...first, content: 'changed' }], 'batch-a'), 'MEMORY_DIGEST_CONFLICT');
    bad(await f.service.ingestEvents(ctx, [{ ...first, content: 'changed' }], 'batch-new'), 'MEMORY_DIGEST_CONFLICT');
    bad(await f.service.ingestEvents(ctx, [raw('must-rollback'), { ...first, content: 'changed' }], 'rollback-batch'), 'MEMORY_DIGEST_CONFLICT');
    assert.equal(good(await f.service.searchMemory(ctx, 'changed')).records.length, 0);
    assert.equal(good(await f.service.getMemoryReceipt(ctx, 'rollback-batch')).operationState, 'not_found');
    assert.equal(good(await f.service.getStatus()).characters.find((item) => item.characterId === 'alpha').eventCount, 1);
  });
  await test('full Host manifest prevents evidence cherry-picking and separates private/public heads', async () => {
    const privateCtx = await context(f), publicCtx = await context(f, publicBase), publicInPrivate = await context(f, { ...base, audiencePolicyId: 'public' });
    await ingest(f, publicInPrivate, raw('public-b'));
    const a = await ref(f, privateCtx, '小明', 'private-a'), b = await ref(f, privateCtx, '小明', 'public-b');
    const publicVersion = good(await proposal(f, privateCtx, [b], b, { operationId: 'public-head' }));
    const privateVersion = good(await proposal(f, privateCtx, [a, b], b, { operationId: 'private-head', content: '小明没有答应见面，私有解释保留。' }));
    assert.notEqual(publicVersion.memoryId, privateVersion.memoryId); assert.notEqual(publicVersion.lineageDomainId, privateVersion.lineageDomainId);
    bad(await f.service.getMemoryReceipt(publicCtx, 'batch-a'), 'MEMORY_RECEIPT_DENIED');
    const visible = good(await f.service.searchMemory(publicCtx, '小明')).records;
    assert.ok(visible.some((item) => item.id === publicVersion.memoryId)); assert.ok(!visible.some((item) => item.id === privateVersion.memoryId || item.id === 'private-a'));
    good(await f.service.host.bindInputManifest(publicInPrivate, [a, b]));
    await ingest(f, publicInPrivate, raw('derived-event', '私有输入后的公开会话输出。'));
    assert.equal(good(await f.service.searchMemory(publicCtx, '私有输入')).records.length, 0);
    bad(await f.service.host.bindInputManifest(await context(f, publicBase), [a]), 'MEMORY_EVIDENCE_DENIED');
    bad(await proposal(f, privateCtx, [b], b, { propositionKey: 'wrong-subject', subject: 'someone-else' }), 'MEMORY_SUBJECT_UNPROVEN');
    bad(await proposal(f, privateCtx, [b], b, { propositionKey: 'wrong-reality', certainty: 'observed' }), 'MEMORY_REALITY_UPGRADE_DENIED');
    bad(await proposal(f, privateCtx, [b], b, { propositionKey: 'persona', corePersona: 'override' }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await proposal(f, privateCtx, [b], b, { propositionKey: 'wrong-span', evidenceRefs: [{ ...b, start: 0, end: 2, text: '假的' }] }), 'MEMORY_EVIDENCE_SPAN_INVALID');
    bad(await proposal(f, privateCtx, [b], b, { propositionKey: 'bad-link', links: [{ id: 'absent', revision: 1, type: 'derived_from' }] }), 'MEMORY_LINK_INVALID');
    good(await f.service.host.bindInputManifest(privateCtx, [b]));
    const monotonic = good(await proposal(f, privateCtx, [b], b, { propositionKey: 'monotonic-proof' })); assert.equal(monotonic.lineageDomainId, privateVersion.lineageDomainId);
    assert.ok(!good(await f.service.searchMemory(publicCtx, '小明')).records.some((item) => item.id === monotonic.memoryId));
    const fresh = await context(f), self = await ref(f, fresh, '小明', publicVersion.memoryId);
    bad(await proposal(f, fresh, [self], self, { expectedRevision: 1, memoryId: publicVersion.memoryId, evidenceRefs: [{ ...self, start: 0, end: 2, text: '小明' }] }), 'MEMORY_DEPENDENCY_CYCLE');
  });
  await test('full bound history manifest expires preflight even when omitted from prepared selection', async () => {
    const isolated = instance('manifest-expiry'); await setup(isolated); const ctx = await context(isolated);
    await ingest(isolated, ctx, raw('short-history', 'historyonlyword prior conversation', { expiresAt: new Date(isolated.clock + 1000).toISOString() }));
    await ingest(isolated, ctx, raw('current-input', 'currentqueryword active conversation'));
    const history = await ref(isolated, ctx, 'historyonlyword', 'short-history');
    const prepared = good(await isolated.service.prepareMemoryContext(ctx, 'currentqueryword')).prepared;
    assert.ok(prepared.evidenceIds.includes('current-input')); assert.ok(!prepared.evidenceIds.includes('short-history'));
    const binding = isolated.service.host.bindInputManifest(ctx, [history]), preflight = isolated.service.validateContext(ctx, prepared);
    good(await binding); good(await preflight);
    isolated.clock += 1001; assert.ok(prepared.expiresAt > isolated.clock);
    good(isolated.service.host.verifyPrepared(ctx, prepared));
    bad(await isolated.service.validateContext(ctx, prepared), 'MEMORY_SOURCE_STALE');
    bad(await isolated.service.validateContext(ctx), 'MEMORY_SOURCE_STALE');
  });
  await test('failed actual input attachment retires request admission even when its failure is ignored', async () => {
    const ctx = await context(f, publicBase), b = await ref(f, ctx, '小明', 'public-b');
    good(await f.service.host.bindInputManifest(ctx, [b]));
    const prepared = good(await f.service.prepareMemoryContext(ctx, '小明')).prepared;
    const forbidden = await ref(f, await context(f), '小明', 'private-a');
    const rejected = f.service.host.bindInputManifest(ctx, [forbidden]);
    const pendingWrite = f.service.ingestEvents(ctx, [raw('must-not-write-after-bind')], 'rejected-bind-ingest');
    bad(await rejected, 'MEMORY_EVIDENCE_DENIED'); bad(await pendingWrite, 'MEMORY_MANIFEST_BINDING_FAILED');
    bad(await f.service.ingestEvents(ctx, [raw('also-must-not-write')], 'rejected-bind-later'), 'MEMORY_MANIFEST_BINDING_FAILED');
    bad(await f.service.proposeMemory(ctx, { operationId: 'rejected-bind-proposal' }), 'MEMORY_MANIFEST_BINDING_FAILED');
    bad(await f.service.validateContext(ctx, prepared), 'MEMORY_MANIFEST_BINDING_FAILED');
    bad(f.service.host.verifyPrepared(ctx, prepared), 'MEMORY_MANIFEST_BINDING_FAILED');
    bad(await f.service.host.bindInputManifest(ctx, []), 'MEMORY_MANIFEST_BINDING_FAILED');
    const fresh = await context(f, publicBase); good(await f.service.validateContext(fresh));
    assert.equal(good(await f.service.getMemoryReceipt(fresh, 'rejected-bind-ingest')).operationState, 'not_found');
    const invalid = await context(f, publicBase); bad(await f.service.host.bindInputManifest(invalid, null), 'MEMORY_MANIFEST_INVALID');
    bad(await f.service.validateContext(invalid), 'MEMORY_MANIFEST_BINDING_FAILED');
  });
  await test('prepared envelope, exact negative/conditional text, empty search, expiry and role cancellation', async () => {
    const ctx = await context(f);
    const envelope = good(await f.service.prepareMemoryContext(ctx, '小明', { memory: 1800, total: 6000 })).prepared;
    assert.ok(envelope.text.includes('没有答应')); assert.ok(envelope.text.length <= 1800); assert.ok(envelope.evidenceIds.length <= 8); assert.equal(envelope.queryDigest, digest('小明')); assert.ok(envelope.eventWatermark > 0);
    assert.equal(typeof f.service.host.verifyPrepared, 'function');
    assert.deepEqual(good(f.service.host.verifyPrepared(ctx, envelope)), { ok: true, admission: 'issued-package-only' });
    bad(f.service.host.verifyPrepared(ctx, { ...envelope }), 'MEMORY_PREPARED_UNTRUSTED');
    good(await f.service.validateContext(ctx, envelope)); bad(await f.service.validateContext(ctx, { ...envelope }), 'MEMORY_PREPARED_UNTRUSTED');
    assert.equal(good(await f.service.prepareMemoryContext(ctx, 'zz-no-relevance')).prepared.text, '');
    const giant = raw('giant', '没有'.repeat(250) + '答应'); await ingest(f, ctx, giant);
    assert.equal(good(await f.service.prepareMemoryContext(ctx, '答应')).prepared.evidenceIds.includes('giant'), false);
    const split = await ingest(f, ctx, raw('split-negative', '甲'.repeat(21844) + '没有答应见面'));
    assert.equal(split.eventIds.length, 2);
    assert.equal(good(await f.service.prepareMemoryContext(ctx, '答应见面')).prepared.evidenceIds.some((id) => id.startsWith('split-negative')), false);
    const tail = good(await f.service.searchMemory(ctx, '答应见面')).records.find((item) => item.id.startsWith('split-negative')); assert.ok(tail);
    const tailRef = { type: tail.type, id: tail.id, revision: tail.revision, payloadDigest: tail.payloadDigest }, isolated = await context(f);
    bad(await proposal(f, isolated, [tailRef], tailRef, { propositionKey: 'partial-negative', evidenceRefs: [{ ...tailRef, start: 0, end: tail.content.length, text: tail.content }] }), 'MEMORY_EVIDENCE_INCOMPLETE');
    f.clock += 30001; bad(f.service.host.verifyPrepared(ctx, envelope), 'MEMORY_PREPARED_STALE'); bad(await f.service.validateContext(ctx, envelope), 'MEMORY_PREPARED_STALE');
    f.setCharacter({ id: 'beta', epoch: 2 }); bad(await f.service.searchMemory(ctx, '小明'), 'CHARACTER_EPOCH_STALE');
    const beta = await context(f); assert.equal(good(await f.service.searchMemory(beta, '小明')).records.length, 0);
    f.setCharacter({ id: 'alpha', epoch: 3 });
    const current = await context(f), inFlight = f.service.searchMemory(current, '小明'); f.setCharacter({ id: 'beta', epoch: 4 }); bad(await inFlight, 'CHARACTER_EPOCH_STALE'); f.setCharacter({ id: 'alpha', epoch: 5 });
  });
  await test('spool receipt and byte offset commit together and rollback on contiguous gaps', async () => {
    const ctx = await context(f), spool = good(createSpool({ directory: path.join(f.dir, 'queue'), producerId: 'sp', segmentId: 'ss', context: ctx }));
    good(spool.append(raw('spool-event', '按字节队列持久记录。'))); good(spool.seal());
    const largeSpool = good(createSpool({ directory: path.join(f.dir, 'queue-large'), producerId: 'sp-large', segmentId: 'ss-large', context: ctx }));
    good(largeSpool.append(raw('spool-large', '甲'.repeat(22000) + ' ' + ['pass', 'word'].join('') + '=' + ['synthetic', 'producer', 'value'].join('-')))); good(largeSpool.seal());
    good(await f.service.ingestEvents(ctx, good(readSpool({ file: largeSpool.file })), 'large-spool-import'));
    const batch = good(readSpool({ file: spool.file })), done = good(await f.service.ingestEvents(ctx, batch, 'spool-import'));
    assert.equal(done.nextOffset, batch.nextOffset); assert.deepEqual(good(await f.service.ingestEvents(ctx, batch, 'spool-import')), done);
    bad(await f.service.ingestEvents(ctx, { ...batch, startOffset: 1 }, 'spool-gap'), 'MEMORY_OFFSET_GAP');
    bad(await f.service.ingestEvents(ctx, { ...batch, nextOffset: batch.nextOffset + 0.5 }, 'spool-fraction'), 'MEMORY_OFFSET_GAP');
    const db = new DatabaseSync(path.join(f.dir, 'characters/alpha/memory/memory-v2.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT position FROM ingest_offsets WHERE producerId=? AND segmentId=?').get('sp', 'ss').position, batch.nextOffset); db.close();
  });
  await test('suppression closes raw and derived roots, blocks regeneration, preserves control receipts', async () => {
    const old = await context(f), revoked = good(await action(f, { type: 'suppress', roots: ['private-a'] }, 'suppress-a'));
    assert.equal(revoked.applied, true); bad(await f.service.searchMemory(old, '小明'), 'MEMORY_CONTEXT_STALE');
    const ctx = await context(f), found = good(await f.service.searchMemory(ctx, '小明')).records;
    assert.ok(found.every((item) => !item.roots.includes('private-a')));
    const controlReceipt = good(await f.service.getMemoryReceipt(await admin(f), 'suppress-a')); assert.equal(controlReceipt.applied, true);
    bad(await f.service.ingestEvents(ctx, [raw('private-a')], 'recollect-a'), 'MEMORY_ROOT_SUPPRESSED');
    good(await action(f, { type: 'revoke_policy', policyId: 'private' }, 'revoke-private'));
    bad(await f.service.captureContext(base), 'MEMORY_POLICY_DENIED');
    good(await f.service.getMemoryReceipt(await admin(f), 'revoke-private'));
  });
  await test('worker death retires contexts and prepared packages while durable records survive reopen', async () => {
    const ctx = await context(f, publicBase), prepared = good(await f.service.prepareMemoryContext(ctx, '小明')).prepared;
    await f.worker().terminate(); bad(await f.service.validateContext(ctx, prepared), 'MEMORY_CONTEXT_UNTRUSTED');
    good(await f.service.initialize()); bad(await f.service.searchMemory(ctx, '小明'), 'MEMORY_CONTEXT_UNTRUSTED');
    const next = await context(f, publicBase); assert.ok(good(await f.service.searchMemory(next, '小明')).records.length > 0);
    assert.equal(good(await f.service.getStatus()).activeBackend, 'v1');
  });
  await test('control commit without view acknowledgment blocks admission and remains recoverable', async () => {
    const blocked = instance('blocked-control', { applyControlsAtRevision: 4 }); await setup(blocked);
    const before = await context(blocked); await ingest(blocked, before, raw('blocked-source'));
    const result = bad(await action(blocked, { type: 'suppress', roots: ['blocked-source'] }, 'blocked-suppress'), 'MEMORY_CONTROL_BLOCKED'); assert.equal(result.applied, false);
    const managementCtx = await admin(blocked), receipt = good(await blocked.service.getMemoryReceipt(managementCtx, 'blocked-suppress')); assert.equal(receipt.applied, false);
    bad(await blocked.service.captureContext(base), 'MEMORY_CONTROL_BLOCKED');
    const status = good(await blocked.service.getStatus()); assert.equal(status.revision, 4); assert.equal(status.characters[0].appliedControlRevision, 3);
    good(await blocked.service.close()); const reopened = instance('reopen-blocked', {}, blocked); good(await reopened.service.initialize());
    const ctx = await context(reopened); assert.equal(good(await reopened.service.searchMemory(ctx, '小明')).records.length, 0);
    assert.equal(good(await reopened.service.getMemoryReceipt(await admin(reopened), 'blocked-suppress')).applied, true);
  });
  for (const after of [false, true]) await test(`uncertain role COMMIT ${after ? 'after' : 'before'} disk commit queries original receipt after reopen`, async () => {
    const uncertain = instance(`uncertain-${after}`, { operationId: 'uncertain-import', [after ? 'roleCommitAfter' : 'roleCommitBefore']: 1 }); await setup(uncertain);
    const ctx = await context(uncertain), item = raw('uncertain-source');
    const result = bad(await uncertain.service.ingestEvents(ctx, [item], 'uncertain-import'), 'MEMORY_COMMIT_UNCERTAIN'); assert.equal(result.retry, 'query_receipt'); assert.equal(result.sourceState, 'commit_unknown');
    bad(await uncertain.service.searchMemory(ctx, '小明'), 'MEMORY_CONTROL_BLOCKED'); good(await uncertain.service.close());
    const reopened = instance(`reopened-${after}`, {}, uncertain); good(await reopened.service.initialize()); const next = await context(reopened);
    const queried = good(await reopened.service.getMemoryReceipt(next, 'uncertain-import')); assert.equal(queried.operationState, after ? 'completed' : 'not_found');
    const count = good(await reopened.service.searchMemory(next, '小明')).records.length; assert.equal(count, after ? 1 : 0);
    if (!after) good(await reopened.service.ingestEvents(next, [item], 'uncertain-import'));
  });
  for (const after of [false, true]) await test(`uncertain control COMMIT ${after ? 'after' : 'before'} disk commit resolves the same management receipt`, async () => {
    const uncertain = instance(`control-uncertain-${after}`, { operationId: 'uncertain-control', [after ? 'controlCommitAfter' : 'controlCommitBefore']: 1 }); await setup(uncertain);
    const ctx = await context(uncertain); await ingest(uncertain, ctx, raw('control-uncertain-source'));
    const result = bad(await action(uncertain, { type: 'suppress', roots: ['control-uncertain-source'] }, 'uncertain-control'), 'MEMORY_COMMIT_UNCERTAIN'); assert.equal(result.retry, 'query_receipt');
    good(await uncertain.service.close()); const reopened = instance(`control-reopened-${after}`, {}, uncertain); good(await reopened.service.initialize());
    const managementCtx = await admin(reopened), receipt = good(await reopened.service.getMemoryReceipt(managementCtx, 'uncertain-control'));
    assert.equal(receipt.operationState, after ? 'completed' : 'not_found');
    assert.equal(good(await reopened.service.searchMemory(await context(reopened), '小明')).records.length, after ? 0 : 1);
  });
  await test('600 is not a persistent event cap; concurrent requests serialize without loss', async () => {
    const capacity = instance('capacity'); await setup(capacity); const ctx = await context(capacity);
    await Promise.all(Array.from({ length: 7 }, (_, batch) => capacity.service.ingestEvents(ctx, Array.from({ length: batch === 6 ? 5 : 100 }, (_, i) => raw(`capacity-${batch}-${i}`, `独立事件，第${batch}批第${i}条。`)), `capacity-batch-${batch}`).then(good)));
    assert.equal(good(await capacity.service.getStatus()).characters[0].eventCount, 605);
    assert.ok(good(await capacity.service.searchMemory(ctx, '独立事件')).records.length <= 80);
  });
  console.log(`Memory V2 kernel: ${count} checks passed; runtime ${process.version}; fixtures ${root}`);
} finally { await Promise.all(services.map((service) => service.close())); }
