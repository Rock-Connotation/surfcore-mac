import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createSpool, readSpool } from '../src/core/memory-v2-spool.js';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { canonical, digest, eventDigest, normalizeEvent, intersectPolicies, policyAllows, validatePolicy } from '../src/core/memory-v2-contract.js';

const root = path.resolve('_backups/memory-v2-lifecycle', `fixtures-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
let count = 0;
const good = (value) => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value.ok, false); if (code) assert.equal(value.code, code, JSON.stringify(value)); assert.ok(value.code && value.error && value.hint); return value; };
async function test(name, fn) { if (process.argv.includes('--first-binding-only') && !name.startsWith('backup preview survives first durable request binding')) return; if(process.argv.includes('--network-only') && !/^(network admission|revocation committed|queued native|queued source|native admission)/.test(name)) return; await fn(); count++; console.log(`ok ${count} - ${name}`); }
function policy(id, audiences) { return validatePolicy({ policyId: id, approved: true, audiences, processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] }); }

await test('QQ approved group wildcard is confined to one login/group and intersects without widening', () => {
  const group = ['qq', 'qq:10001:group:20001', '*'], shared = policy('shared', [group, group]), actor = { channel: 'qq', conversationKey: group[1], requesterAccountKey: 'qq:30001', processingGrantId: 'grant', providerRouteId: 'local:test' };
  assert.equal(policyAllows(shared, actor), true); assert.equal(policyAllows(shared, { ...actor, requesterAccountKey: 'qq:30002' }), true);
  for (const conversationKey of ['qq:10001:group:20002', 'qq:10002:group:20001', 'qq:10001:private:30001']) assert.equal(policyAllows(shared, { ...actor, conversationKey }), false);
  for (const audience of [['local', 'app:one', '*'], ['qq', 'qq:10001:private:30001', '*'], ['bili', 'bili:one', '*'], ['douyin', 'douyin:one', '*'], ['qq', '*', '*']]) assert.throws(() => policy('invalid', [audience]));
  const one = policy('one', [[group[0], group[1], 'qq:30001']]), two = policy('two', [[group[0], group[1], 'qq:30002']]), privateA = policy('private', [['qq', 'qq:10001:private:30001', 'qq:30001']]);
  assert.deepEqual(intersectPolicies([shared, one]).audiences, one.audiences); assert.deepEqual(intersectPolicies([one, shared]).audiences, one.audiences);
  assert.deepEqual(intersectPolicies([shared, shared]).audiences, [group]); assert.deepEqual(intersectPolicies([one, two]).audiences, []); assert.deepEqual(intersectPolicies([privateA, shared]).audiences, []);
  assert.equal(digest(intersectPolicies([shared, one])), digest(intersectPolicies([one, shared])));
  assert.deepEqual(policy('normalized', [one.audiences[0], group, group]).audiences, [group]);
});
if (process.argv.includes('--policy-only')) { console.log(`Memory V2 lifecycle policy: ${count} checks passed; runtime ${process.version}`); process.exit(0); }

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const within=(promise)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture deadlock timeout')),5000);})]).finally(()=>clearTimeout(timer));};
const instances = [];
function instance(name, options = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir); const stateDir = path.join(dir, 'state'), charactersDir = path.join(dir, 'characters'); fs.mkdirSync(stateDir); fs.mkdirSync(charactersDir);
  const authorization = Symbol(name), role = { id: 'app', epoch: 1 }; let clock = Date.parse('2026-11-09T12:00:00Z');
  const base = { channel: 'local', conversationKey: 'app:one', sourceAccountKey: 'local:person', requesterAccountKey: 'local:person', audiencePolicyId: 'private', providerRouteId: 'local:test', processingGrantId: 'grant' };
  let service;
  const config = { workerFactory: (url, config) => new Worker(url, { ...config, workerData: { ...config.workerData, faults: options.faults ?? {} } }), stateDir, charactersDir, getCharacter: () => ({ ...role }), now: () => clock, authorizeManagement: (token) => token === authorization, authorizeProducerReplay: async (token) => token === authorization ? { ok: true } : false,
    lifecycleInventory: async () => ({ complete: true, sealedSpool: [], externalCopies: [], quotaSnapshot: { recordedAt: new Date(clock).toISOString(), usedRequests: 19, usedTokens: 9999, usedCost: 2.2, reservedRequests: 1 } }),
    retireForLifecycle: async (challenge) => { role.epoch++; return { ok: true, nonce: challenge.nonce, characterId: role.id, epoch: role.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }; },
    ...options,
  };
  service = createMemoryService(config);
  const f = { dir, stateDir, charactersDir, base, authorization, role, service, config, get clock() { return clock; }, set clock(n) { clock = n; }, restart: async () => { await service.close(); service = createMemoryService(config); f.service = service; return service.initialize(); }, disableFaults: () => { options.faults = {}; } };
  instances.push(f); return f;
}
async function admin(f) { return good(await f.service.host.captureAdminContext(f.base, f.authorization)).context; }
async function context(f, purpose = 'conversation') { return good(await f.service.captureContext({ ...f.base, purpose })).context; }
async function setup(f) { good(await f.service.initialize()); let ctx = await admin(f); good(await f.service.host.configurePolicy(ctx, policy('private', [['local', 'app:one', 'local:person']]), ctx.controlRevision, 'setup-policy')); ctx = await admin(f); good(await f.service.applyMemoryAction(ctx, { type: 'enable_shadow', enabled: true }, ctx.controlRevision, 'setup-shadow')); }
const raw = (id, content, more = {}) => ({ eventId: id, sourceKey: `source:${id}`, operationId: `eventop:${id}`, producerId: 'producer', segmentId: 'segment', producerSeq: 1, subject: 'local:person', content, ...more });
async function ingest(f, id, content, more = {}) { return good(await f.service.ingestEvents(await context(f), [raw(id, content, more)], `batch:${id}`)); }
async function backup(f, operationId = 'backup-one') { const ctx = await admin(f), preview = good(await f.service.host.lifecycle.previewBackup(ctx, {})); return good(await f.service.host.lifecycle.backup(ctx, { previewDigest: preview.previewDigest }, ctx.controlRevision, operationId)); }
function selectedFile(f) { const control = new DatabaseSync(path.join(f.stateDir, 'memory-control.sqlite'), { readOnly: true }); try { const selected = control.prepare('SELECT relativeFile FROM role_generations WHERE characterId=?').get(f.role.id); return selected ? path.join(f.charactersDir, f.role.id, selected.relativeFile) : path.join(f.charactersDir, f.role.id, 'memory', 'memory-v2.sqlite'); } finally { control.close(); } }
async function restore(f, backupId, id = 'restore-one') { const ctx = await admin(f), preview = good(await f.service.host.lifecycle.previewRestore(ctx, { backupId })); return good(await f.service.host.lifecycle.restore(ctx, { backupId, previewDigest: preview.previewDigest }, ctx.controlRevision, id)); }
async function deleteRoot(f, roots, id = 'delete-one') { const ctx = await admin(f), preview = good(await f.service.host.lifecycle.previewDelete(ctx, { roots })); return good(await f.service.host.lifecycle.requestDelete(ctx, { roots, previewDigest: preview.previewDigest }, ctx.controlRevision, id)); }

try {
  await test('committed canonical source refs survive replay and bind directly without text search', async () => {
    const f = instance('receipt-refs'); await setup(f); const ctx = await context(f), event = raw('receipt-source', 'citationword exact source');
    const first = good(await f.service.ingestEvents(ctx, [event], 'source-operation'));
    assert.equal(first.eventRefs.length, 1); assert.equal(first.eventRefs[0].id, first.eventIds[0]); assert.equal(first.eventRefs[0].revision, 1);
    assert.match(first.eventRefs[0].payloadDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(good(await f.service.ingestEvents(ctx, [event], 'source-operation')), first);
    const reuse = good(await f.service.ingestEvents(ctx, [event], 'source-reuse')); assert.deepEqual(reuse.eventRefs, first.eventRefs);
    good(await f.service.host.bindInputManifest(ctx, first.eventRefs));
    good(await f.service.proposeMemory(ctx, { operationId: 'direct-citation', propositionKey: 'cited', kind: 'fact', subject: 'local:person', content: 'citationword', certainty: 'reported', expectedRevision: 0, evidenceRefs: [{ ...first.eventRefs[0], start: 0, end: 12, text: 'citationword' }] }));
  });
  await test('registered original producer replays only its original role/epoch after restart and role switch', async () => {
    const f = instance('producer'); await setup(f); const alpha = await context(f), registration = good(await f.service.host.registerProducer(alpha, { producerId: 'producer', segmentId: 'segment' }, 'register-alpha'));
    assert.equal(registration.capturedEpoch, 1); const originalRevision = alpha.controlRevision;
    assert.equal((await admin(f)).controlRevision, originalRevision);
    const spool = good(createSpool({ directory:path.join(f.stateDir,'queue'),producerId:'producer',segmentId:'segment',context:alpha })); good(spool.append(raw('queued-alpha','originalalphaword'))); good(spool.seal()); const batch = good(readSpool({file:spool.file}));
    f.role.id = 'beta'; f.role.epoch = 3; good(await f.restart()); await ingest(f, 'only-beta', 'betaword');
    assert.deepEqual(good(await f.service.host.queryProducerReceipt({operationId:'register-alpha'},f.authorization)),registration);
    bad(await f.service.validateContext(alpha), 'MEMORY_CONTEXT_UNTRUSTED'); bad(await f.service.captureContext({ ...f.base, purpose: 'producer_replay' }), 'MEMORY_SCHEMA_INVALID');
    bad(await f.service.host.replayProducer({ registrationId: registration.registrationId, batch, operationId: 'replay-alpha' }, Symbol('fake')), 'MEMORY_PRODUCER_REPLAY_DENIED');
    const result = good(await f.service.host.replayProducer({ registrationId: registration.registrationId, batch, operationId: 'replay-alpha' }, f.authorization));
    assert.equal(result.characterId, 'app'); assert.equal(result.capturedEpoch, 1); assert.equal(result.eventRefs[0].id, 'queued-alpha');
    assert.equal(good(await f.service.searchMemory(await context(f), 'originalalphaword')).records.length, 0);
    assert.deepEqual(good(await f.service.host.queryProducerReceipt({ registrationId: registration.registrationId, operationId: 'replay-alpha' }, f.authorization)), result);
    assert.deepEqual(good(await f.service.host.replayProducer({ registrationId: registration.registrationId, batch, operationId: 'replay-alpha' }, f.authorization)), result);
    const forged = structuredClone(batch); forged.events[0].characterId = 'beta'; forged.events[0].payloadDigest = eventDigest(forged.events[0]);
    bad(await f.service.host.replayProducer({ registrationId: registration.registrationId, batch: forged, operationId: 'forged-replay' }, f.authorization), 'MEMORY_PRODUCER_SCOPE_CONFLICT');
    bad(await f.service.host.replayProducer({ registrationId: 'producer-missing', batch, operationId: 'unregistered-replay' }, f.authorization), 'MEMORY_PRODUCER_NOT_REGISTERED');
    f.role.id = 'app'; f.role.epoch = 4; const visible = good(await f.service.searchMemory(await context(f), 'originalalphaword')); assert.equal(visible.records.length, 1); assert.equal(visible.records[0].content, 'originalalphaword');
    await deleteRoot(f,['queued-alpha'],'delete-registered-source');
    bad(await f.service.host.replayProducer({registrationId:registration.registrationId,batch,operationId:'deleted-replay'},f.authorization),'MEMORY_SOURCE_DELETED');
    const a = await admin(f); good(await f.service.applyMemoryAction(a, { type: 'revoke_policy', policyId: 'private' }, a.controlRevision, 'producer-revoke'));
    bad(await f.service.host.replayProducer({ registrationId: registration.registrationId, batch, operationId: 'revoked-replay' }, f.authorization), 'MEMORY_POLICY_DENIED');
  });
  await test('backup preview survives first durable request binding while retaining real-cut checks', async () => {
    const f = instance('first-bound-backup'); await setup(f); const ctx = await admin(f);
    const marker = path.join(f.stateDir, 'memory-v2.lifecycle.json'), readMarker = () => fs.existsSync(marker) ? fs.readFileSync(marker) : null, originalMarker = readMarker();
    assert.equal(originalMarker ? JSON.parse(originalMarker).minimumCompatibleKernel : 1, 1);
    const before = good(await f.service.host.lifecycle.previewBackup(ctx, {}));
    assert.deepEqual(readMarker(), originalMarker);
    good(await f.service.host.admin.bindRequest(ctx, { operationId: 'first-bound-backup', action: 'backup', payloadDigest: digest({}), expectedRevision: ctx.controlRevision, characterId: ctx.characterId, characterEpoch: ctx.capturedEpoch }));
    const after = good(await f.service.host.lifecycle.previewBackup(ctx, {}));
    assert.equal(after.previewDigest, before.previewDigest);
    assert.equal(before.preview.minimumCompatibleKernel, 2);
    const saved = good(await f.service.host.lifecycle.backup(ctx, { previewDigest: before.previewDigest }, ctx.controlRevision, 'first-bound-backup'));
    assert.equal(saved.phase, 'backup_verified'); assert.equal(saved.manifest.minimumCompatibleKernel, 2);
    assert.equal(JSON.parse(fs.readFileSync(marker)).minimumCompatibleKernel, 2);
    const current = await admin(f), stale = good(await f.service.host.lifecycle.previewBackup(current, {}));
    await ingest(f, 'after-preview', 'new source changes the actual backup cut');
    bad(await f.service.host.lifecycle.backup(current, { previewDigest: stale.previewDigest }, current.controlRevision, 'changed-source-backup'), 'MEMORY_PREVIEW_STALE');
  });
  if (!process.argv.includes('--seams-only')) await test('real Worker produces independent verified backup and preserves actual quota ledger', async () => {
    const f = instance('backup'); await setup(f); await ingest(f, 'before', 'backupword before snapshot');
    const ledger = path.join(f.stateDir, 'quota-ledger.json'); fs.writeFileSync(ledger, '{"used":19}');
    const saved = await backup(f); assert.equal(saved.phase, 'backup_verified'); assert.equal(saved.manifest.quotaSnapshotAtomicWithContent, false);
    const roleFile = path.join(f.stateDir, 'memory-v2-lifecycle', 'backups', saved.backupId, 'role.sqlite'), before = fs.readFileSync(roleFile);
    await ingest(f, 'after', 'newword after snapshot'); assert.deepEqual(fs.readFileSync(roleFile), before);
    const db = new DatabaseSync(roleFile, { readOnly: true }); try { assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1); } finally { db.close(); }
    assert.equal(fs.readFileSync(ledger, 'utf8'), '{"used":19}');
    const ctx = await admin(f); bad(await f.service.host.lifecycle.backup(ctx, { previewDigest: 'different' }, ctx.controlRevision, 'backup-one'), 'MEMORY_DIGEST_CONFLICT');
  });
  if (!process.argv.includes('--seams-only')) {
    await test('restore uses current controls, preserves post-backup sources, changes actual Worker generation and never rewinds ledger', async () => {
      const f = instance('restore'); await setup(f); await ingest(f, 'old', 'oldword earlier source'); const saved = await backup(f);
      await ingest(f, 'new', 'newword post backup source'); const oldCtx = await context(f), oldGeneration = oldCtx.storeGeneration;
      const ledger = path.join(f.stateDir, 'quota-ledger.json'); fs.writeFileSync(ledger, '{"used":27}');
      const result = await restore(f, saved.backupId); assert.equal(result.complete, true); assert.equal(result.phase, 'completed'); assert.notEqual(result.storeGeneration, oldGeneration); assert.equal(f.role.epoch, 2);
      assert.equal(good(await f.service.searchMemory(await context(f), 'newword')).records.length, 1); assert.equal(good(await f.service.searchMemory(await context(f), 'oldword')).records.length, 1);
      assert.equal(fs.readFileSync(ledger, 'utf8'), '{"used":27}'); bad(await f.service.validateContext(oldCtx), 'MEMORY_CONTEXT_UNTRUSTED');
      const oldPath = path.join(f.charactersDir, 'app', 'memory', 'memory-v2.sqlite'), db = new DatabaseSync(oldPath, { readOnly: true }); try { assert.ok(db.prepare('SELECT lifecycle_guard FROM metadata').get()); } finally { db.close(); }
    });
    await test('deletion tombstones defeat old restore and replay with changed IDs; clean purge removes body and index bytes', async () => {
      const f = instance('delete'); await setup(f); const canary = 'EraseThisLifecycleCanary', source = await ingest(f, 'erase-root', canary, { occurredAt:new Date(f.clock).toISOString(),attribution:'reflection' }); await ingest(f, 'keep-root', 'survivingword');
      const c = await context(f); good(await f.service.host.bindInputManifest(c, source.eventRefs)); good(await f.service.proposeMemory(c, { operationId: 'derived-canary', propositionKey: 'derived', kind: 'reflection', subject: 'local:person', content: canary, certainty: 'inferred', expectedRevision: 0, evidenceRefs: [{ ...source.eventRefs[0], start: 0, end: canary.length, text: canary }] }));
      const saved = await backup(f); const revoked = await deleteRoot(f, ['erase-root']); assert.equal(revoked.deletionPhase, 'access_revoked'); assert.equal(revoked.activeStorePurged, false);
      assert.equal(good(await f.service.searchMemory(await context(f), 'EraseThisLifecycleCanary')).records.length, 0);
      bad(await f.service.ingestEvents(await context(f), [raw('different-id', canary, { sourceKey: 'source:erase-root' })], 'different-request'), 'MEMORY_SOURCE_DELETED');
      await ingest(f, 'post-delete', 'afterdeleteword'); await restore(f, saved.backupId, 'restore-deleted-backup');
      assert.equal(good(await f.service.searchMemory(await context(f), 'EraseThisLifecycleCanary')).records.length, 0); assert.equal(good(await f.service.searchMemory(await context(f), 'afterdeleteword')).records.length, 1);
      const ctx = await admin(f), result = good(await f.service.host.lifecycle.continueDelete(ctx, { deleteOperationId: 'delete-one', purgeRetained: true }, ctx.controlRevision, 'purge-one'));
      assert.equal(result.deletionPhase, 'retained_copies_purged'); assert.equal(result.retainedCopiesPurged, true); assert.equal(result.activeStorePurged, true);
      assert.equal(fs.readFileSync(selectedFile(f)).includes(Buffer.from(canary)), false);
      const db = new DatabaseSync(selectedFile(f), { readOnly: true }); try { assert.equal(db.prepare('SELECT COUNT(*) n FROM search_docs WHERE text LIKE ?').get('%'+canary+'%').n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 2); } finally { db.close(); }
      const backupFile = path.join(f.stateDir, 'memory-v2-lifecycle', 'backups', saved.backupId, 'role.sqlite'); assert.equal(fs.readFileSync(backupFile).includes(Buffer.from(canary)), false);
      bad(await f.service.ingestEvents(await context(f), [raw('again-other-id', canary, { sourceKey: 'source:erase-root' })], 'again-other-request'), 'MEMORY_SOURCE_DELETED');
    });
    await test('missing retirement callback and invented epoch keep durable lifecycle barrier closed', async () => {
      for (const mode of ['absent', 'fake']) {
        const f = instance('retirement-'+mode, { retireForLifecycle: mode === 'absent' ? undefined : async (r) => ({ ok: true, nonce: r.nonce, characterId: r.characterId, epoch: r.previousEpoch+1, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }) });
        await setup(f); await ingest(f, 'blocked-root', 'blockedword'); const old = await context(f), a = await admin(f), preview = good(await f.service.host.lifecycle.previewDelete(a, { roots: ['blocked-root'] }));
        const result = await f.service.host.lifecycle.requestDelete(a, { roots: ['blocked-root'], previewDigest: preview.previewDigest }, a.controlRevision, 'blocked-delete');
        if (mode === 'absent') { assert.equal(result.phase, 'retirement_required'); assert.equal(result.complete, false); assert.ok(result.code && result.hint); } else bad(result, 'MEMORY_RETIREMENT_REQUIRED');
        bad(await f.service.validateContext(old), 'MEMORY_LIFECYCLE_BLOCKED'); bad(await f.service.captureContext(f.base), 'MEMORY_LIFECYCLE_BLOCKED');
        const progress = good(await f.service.host.lifecycle.progress(await admin(f), 'blocked-delete')); assert.equal(progress.phase, 'retirement_required'); assert.equal(progress.complete, false);
      }
    });
    await test('tampered backup manifest is rejected before candidate construction', async () => {
      const f = instance('corrupt'); await setup(f); await ingest(f, 'one', 'oneword'); const saved = await backup(f), manifest = path.join(f.stateDir, 'memory-v2-lifecycle', 'backups', saved.backupId, 'manifest.json');
      fs.appendFileSync(manifest, ' '); bad(await f.service.host.lifecycle.previewRestore(await admin(f), { backupId: saved.backupId }), 'MEMORY_MANIFEST_CORRUPT');
      assert.equal(fs.existsSync(path.join(f.charactersDir, 'app', 'memory', 'generations')), false);
    });
    await test('growth thresholds count cited original roots only and reject derived or uncited inflation', async () => {
      const f=instance('growth'); await setup(f); f.base.sourceAccountKey='character:app'; const sources=[];
      for(let i=0;i<3;i++) sources.push(await ingest(f,'growth-'+i,'selfgrowthsource '+i,{subject:'self',speaker:'self',attribution:i===2?'action':'reflection',occurredAt:i===2?'2026-11-09T10:00:00Z':'2026-11-08T10:00:00Z'}));
      const refs=sources.flatMap((s)=>s.eventRefs), c=await context(f); good(await f.service.host.bindInputManifest(c,refs));
      const span=(i)=>({...refs[i],start:0,end:'selfgrowthsource'.length,text:'selfgrowthsource'}), base={propositionKey:'stable-view',kind:'self_view',subject:'self',content:'stablegrowthword',certainty:'inferred',expectedRevision:0};
      const review=good(await f.service.proposeMemory(c,{...base,operationId:'one-cited-root',evidenceRefs:[span(0)]})); assert.equal(review.selectionState,'review'); assert.equal(review.code,'MEMORY_GROWTH_THRESHOLD_UNMET');
      assert.equal(good(await f.service.searchMemory(c,'stablegrowthword')).records.length,0);
      good(await f.service.proposeMemory(c,{operationId:'derived-one-root',propositionKey:'derived-fact',kind:'fact',subject:'self',content:'derivedgrowthword',certainty:'reported',expectedRevision:0,evidenceRefs:[span(0)]}));
      const d=good(await f.service.searchMemory(c,'derivedgrowthword')).records.find((r)=>r.type==='memory'), dc=await context(f); good(await f.service.host.bindInputManifest(dc,[{type:'memory',id:d.id,revision:d.revision,payloadDigest:d.payloadDigest}]));
      assert.equal(good(await f.service.proposeMemory(dc,{...base,propositionKey:'derived-view',operationId:'derived-not-three',evidenceRefs:[{type:'memory',id:d.id,revision:d.revision,start:0,end:17,text:'derivedgrowthword'}]})).selectionState,'review');
      const committed=good(await f.service.proposeMemory(c,{...base,operationId:'three-cited-roots',evidenceRefs:[span(0),span(1),span(2)]})); assert.equal(committed.selectionState,'committed');
      const db=new DatabaseSync(selectedFile(f),{readOnly:true}); try{ const p=JSON.parse(db.prepare('SELECT payload FROM memory_versions WHERE memoryId=?').get(committed.memoryId).payload); assert.equal(p.growth.stable,true); assert.equal(p.growth.independentRootIds.length,3); assert.equal(p.growth.dates.length,2); }finally{db.close();}
    });
    await test('three derived reflection IDs across dates never inflate one original view into stable self evidence',async()=>{
      const f=instance('derived-growth-inflation'); await setup(f); const original=good(await f.service.ingestEvents(await context(f),[raw('one-original-view','originalselfsource',{subject:'self',speaker:'self',occurredAt:'2026-11-08T10:00:00.000Z',attribution:'reflection',certainty:'reported'})],'one-original-import'));
      const c=await context(f); good(await f.service.host.bindInputManifest(c,original.eventRefs)); const derived=[];
      for(let i=0;i<3;i++) derived.push(...good(await f.service.ingestEvents(c,[raw('derived-reflection-'+i,'derivedselfsourceword '+i,{subject:'self',speaker:'self',occurredAt:i===2?'2026-11-09T10:00:00.000Z':'2026-11-08T10:00:00.000Z',attribution:'reflection',certainty:'reported'})],'derived-import-'+i)).eventRefs);
      const p=await context(f); good(await f.service.host.bindInputManifest(p,derived)); const result=good(await f.service.proposeMemory(p,{operationId:'reject-derived-inflation',kind:'self_view',propositionKey:'false-stable-derived',subject:'self',content:'falsederivedstableword',certainty:'inferred',expectedRevision:0,evidenceRefs:derived.map((ref)=>({...ref,start:0,end:'derivedselfsourceword'.length,text:'derivedselfsourceword'}))}));
      assert.equal(result.selectionState,'review'); assert.equal(result.code,'MEMORY_GROWTH_DERIVED_EVIDENCE'); assert.equal(good(await f.service.searchMemory(await context(f),'falsederivedstableword')).records.length,0);
    });
    await test('correction links an independent genuine role version while control and backup controls never contain replacement text',async()=>{
      const f=instance('content-free-correction'); await setup(f); const old=await ingest(f,'old-correct-root','incorrectoldword'); let c=await context(f); good(await f.service.host.bindInputManifest(c,old.eventRefs)); good(await f.service.proposeMemory(c,{operationId:'old-correct-memory',kind:'fact',propositionKey:'old-correct-key',subject:'local:person',content:'incorrectoldword',certainty:'reported',expectedRevision:0,evidenceRefs:[{...old.eventRefs[0],start:0,end:'incorrectoldword'.length,text:'incorrectoldword'}]}));
      const canary='corrected private canary violet lantern', fresh=await ingest(f,'new-correct-root',canary); c=await context(f); good(await f.service.host.bindInputManifest(c,fresh.eventRefs)); const created=good(await f.service.proposeMemory(c,{operationId:'new-correct-memory',kind:'fact',propositionKey:'new-correct-key',subject:'local:person',content:canary,certainty:'reported',expectedRevision:0,evidenceRefs:[{...fresh.eventRefs[0],start:0,end:canary.length,text:canary}]}));
      const db=new DatabaseSync(selectedFile(f),{readOnly:true}), stored=db.prepare('SELECT payloadDigest,payload FROM memory_versions WHERE memoryId=? AND revision=?').get(created.memoryId,created.revision); db.close(); assert.equal(JSON.parse(stored.payload).content,canary);
      const a=await admin(f), pointer={type:'memory',id:created.memoryId,revision:created.revision,payloadDigest:stored.payloadDigest}; bad(await f.service.applyMemoryAction(a,{type:'correct',roots:['old-correct-root'],replacement:{...pointer,content:canary}},a.controlRevision,'unsupported-plaintext-correction'),'MEMORY_CORRECTION_TEXT_UNSUPPORTED');
      assert.equal(good(await f.service.searchMemory(await context(f),'incorrectoldword')).records.length,2);
      const corrected=good(await f.service.applyMemoryAction(a,{type:'correct',roots:['old-correct-root'],replacement:pointer},a.controlRevision,'link-correct-version')); assert.equal(corrected.correctionState,'persisted-replacement-linked'); assert.deepEqual(corrected.replacement,pointer);
      assert.equal(fs.readFileSync(path.join(f.stateDir,'memory-control.sqlite')).includes(Buffer.from(canary)),false); assert.equal(good(await f.service.searchMemory(await context(f),'incorrectoldword')).records.length,0); assert.equal(good(await f.service.searchMemory(await context(f),canary)).records.filter((row)=>row.type==='memory').length,1);
      const saved=await backup(f,'corrected-control-backup'), control=saved.manifest.files.find((file)=>file.kind==='control'); assert.equal(fs.readFileSync(path.join(f.stateDir,'memory-v2-lifecycle','backups',saved.backupId,control.file)).includes(Buffer.from(canary)),false);
    });
    await test('typed commitment transitions use actual prior state, new evidence and original-root deletion closure',async()=>{
      const f=instance('commitment-chain'); await setup(f); const initial=good(await f.service.ingestEvents(await context(f),[raw('promise-root','promiseword',{occurredAt:'2026-11-08T12:00:00.000Z',certainty:'reported'})],'promise-import'));
      const definition={kind:'commitment',propositionKey:'promise-key',subject:'local:person',content:'commitmentword',certainty:'reported',commitment:{promiserAccountKey:'local:person',beneficiaryAccountKey:'local:friend',dueAt:'2026-11-10T12:00:00.000Z',status:'open'},evidenceRefs:[{...initial.eventRefs[0],start:0,end:'promiseword'.length,text:'promiseword'}]};
      let c=await context(f); good(await f.service.host.bindInputManifest(c,initial.eventRefs)); const opened=good(await f.service.proposeMemory(c,{...definition,operationId:'commitment-open',expectedRevision:0})); assert.equal(opened.selectionState,'committed');
      const premature=good(await f.service.proposeMemory(c,{...definition,operationId:'commitment-premature',expectedRevision:1,commitment:{...definition.commitment,status:'completed'}})); assert.equal(premature.selectionState,'review');
      const completion=good(await f.service.ingestEvents(await context(f),[raw('completion-root','completionword',{occurredAt:'2026-11-09T11:00:00.000Z',certainty:'reported',attribution:'action'})],'completion-import')); c=await context(f); good(await f.service.host.bindInputManifest(c,completion.eventRefs));
      const closed=good(await f.service.proposeMemory(c,{...definition,operationId:'commitment-completed',expectedRevision:1,commitment:{...definition.commitment,status:'completed',transitionEvidenceId:'completion-root'},evidenceRefs:[{...completion.eventRefs[0],start:0,end:'completionword'.length,text:'completionword'}]})); assert.equal(closed.selectionState,'committed'); assert.equal(closed.revision,2);
      const db=new DatabaseSync(selectedFile(f),{readOnly:true}); const roots=JSON.parse(db.prepare('SELECT roots FROM memory_versions WHERE memoryId=? AND revision=2').get(closed.memoryId).roots); db.close(); assert.ok(roots.includes('promise-root')); assert.ok(roots.includes('completion-root'));
      await deleteRoot(f,['promise-root'],'delete-promise-origin'); assert.equal(good(await f.service.searchMemory(await context(f),'commitmentword')).records.length,0);
    });
    await test('retained inventory remains pending until actual managed and external copy proofs exist', async () => {
      const f=instance('retained-pending',{lifecycleInventory:async()=>({complete:false,sealedSpool:[],externalCopies:[{copyId:'session-copy',kind:'session',state:'pending'}],quotaSnapshot:null})}); await setup(f); await ingest(f,'pending-root','pendingcopyword'); await backup(f);
      await deleteRoot(f,['pending-root']); const a=await admin(f), result=good(await f.service.host.lifecycle.continueDelete(a,{deleteOperationId:'delete-one',purgeRetained:true},a.controlRevision,'pending-purge'));
      assert.equal(result.activeStorePurged,true); assert.equal(result.retainedCopiesPurged,false); assert.equal(result.deletionPhase,'active_store_purged'); assert.ok(result.pending.some((x)=>x.kind==='host-inventory')); assert.ok(result.pending.some((x)=>x.copyId==='session-copy'));
    });
    await test('sealed trusted spool high-water is copied independently and never advertised as all queues',async()=>{
      let inv={complete:true,sealedSpool:[],externalCopies:[],quotaSnapshot:null}; const f=instance('sealed-backup',{lifecycleInventory:async()=>inv}); await setup(f); const c=await context(f), spool=good(createSpool({directory:path.join(f.stateDir,'queues'),producerId:'sealed-producer',segmentId:'sealed-segment',context:c})); good(spool.append(raw('sealed-event','sealedword'))); const sealed=good(spool.seal());
      inv.sealedSpool=[{copyId:'sealed-copy',path:spool.file,producerId:spool.producerId,segmentId:spool.segmentId,sealed:true,highWater:sealed.nextOffset,sha256:createHash('sha256').update(fs.readFileSync(spool.file)).digest('hex')}];
      const a=await admin(f), preview=good(await f.service.host.lifecycle.previewBackup(a,{sealedSpoolIds:['sealed-copy']})), result=good(await f.service.host.lifecycle.backup(a,{previewDigest:preview.previewDigest,sealedSpoolIds:['sealed-copy']},a.controlRevision,'sealed-snapshot'));
      assert.equal(result.manifest.scope,'role-and-controls'); assert.equal(result.manifest.spool.length,1); const copy=result.manifest.files.find((x)=>x.kind==='spool'); assert.deepEqual(fs.readFileSync(path.join(f.stateDir,'memory-v2-lifecycle','backups',result.backupId,copy.file)),fs.readFileSync(spool.file));
      fs.appendFileSync(spool.file,'\n'); bad(await f.service.host.lifecycle.previewBackup(await admin(f),{sealedSpoolIds:['sealed-copy']}),'MEMORY_SPOOL_HIGHWATER_CHANGED');
      assert.equal(good(await f.service.host.lifecycle.progress(await admin(f),'sealed-snapshot')).complete,true);
    });
    await test('failed backup verification cannot authorize restore or physical purge',async()=>{
      const f=instance('backup-fault',{faults:{operationId:'failed-backup',backupAfterCopy:1}}); await setup(f); await ingest(f,'not-purged','backupfailureword'); const a=await admin(f), preview=good(await f.service.host.lifecycle.previewBackup(a,{}));
      bad(await f.service.host.lifecycle.backup(a,{previewDigest:preview.previewDigest},a.controlRevision,'failed-backup'),'MEMORY_STORE_FAILED');
      const progress=good(await f.service.host.lifecycle.progress(await admin(f),'failed-backup')); assert.equal(progress.complete,false);
      const backupId='backup-'+digest(['app','failed-backup']).slice(0,32); bad(await f.service.host.lifecycle.previewRestore(await admin(f),{backupId}),'MEMORY_BACKUP_UNVERIFIED');
      assert.ok(fs.readFileSync(selectedFile(f)).includes(Buffer.from('backupfailureword'))); assert.equal(fs.existsSync(path.join(f.charactersDir,'app','memory','generations')),false);
    });
    await test('durable intent and candidate publication failures recover safely with close-before-rename ordering (Windows simulation only)',async()=>{
      for(const stage of ['lifecycleAfterIntent','lifecycleAfterCandidate','lifecycleAfterRetirement','lifecycleRenameBusy','lifecycleBeforePublish','lifecycleAfterPublish']){
        const f=instance('crash-'+stage,{faults:{operationId:'faulty-restore',[stage]:1}}); await setup(f); await ingest(f,'before-crash','beforecrashword'); const saved=await backup(f); await ingest(f,'after-crash','aftercrashword'); const a=await admin(f), preview=good(await f.service.host.lifecycle.previewRestore(a,{backupId:saved.backupId}));
        bad(await f.service.host.lifecycle.restore(a,{backupId:saved.backupId,previewDigest:preview.previewDigest},a.controlRevision,'faulty-restore'),'MEMORY_STORE_FAILED');
        f.disableFaults(); good(await f.restart()); let result=good(await f.service.host.lifecycle.progress(await admin(f),'faulty-restore'));
        if(stage==='lifecycleAfterPublish'){ assert.equal(result.complete,true); }
        else{ assert.equal(result.complete,false); bad(await f.service.captureContext(f.base),'MEMORY_LIFECYCLE_BLOCKED'); const b=await admin(f); result=good(await f.service.host.lifecycle.resume(b,{operationId:'faulty-restore'},b.controlRevision,'resume-restore')); assert.equal(result.complete,true); }
        assert.equal(good(await f.service.searchMemory(await context(f),'aftercrashword')).records.length,1); assert.equal(good(await f.service.searchMemory(await context(f),'beforecrashword')).records.length,1);
      }
    });
    await test('original progress follows repeated resume and later controls remain inspectable without reopening stale candidates',async()=>{
      const f=instance('resume-chain',{faults:{operationId:'chain-original',lifecycleAfterCandidate:1}}); await setup(f); await ingest(f,'chain-source','chainword'); const saved=await backup(f),a=await admin(f),preview=good(await f.service.host.lifecycle.previewRestore(a,{backupId:saved.backupId})); bad(await f.service.host.lifecycle.restore(a,{backupId:saved.backupId,previewDigest:preview.previewDigest},a.controlRevision,'chain-original'),'MEMORY_STORE_FAILED');
      f.config.workerFactory=(url,options)=>new Worker(url,{...options,workerData:{...options.workerData,faults:{operationId:'chain-first-resume',lifecycleAfterCandidate:1}}}); good(await f.restart()); let current=await admin(f); bad(await f.service.host.lifecycle.resume(current,{operationId:'chain-original'},current.controlRevision,'chain-first-resume'),'MEMORY_STORE_FAILED'); good(await f.restart()); current=await admin(f); assert.equal(good(await f.service.host.lifecycle.resume(current,{operationId:'chain-original'},current.controlRevision,'chain-final-resume')).complete,true); const original=good(await f.service.host.lifecycle.progress(await admin(f),'chain-original')); assert.equal(original.complete,true); assert.equal(original.effectiveOperationId,'chain-final-resume');
      const g=instance('post-publish-controls',{faults:{operationId:'changed-control-restore',lifecycleAfterPublish:1}}); await setup(g); await ingest(g,'changed-control-source','changedcontrolword'); const backupData=await backup(g),before=await admin(g),plan=good(await g.service.host.lifecycle.previewRestore(before,{backupId:backupData.backupId})); bad(await g.service.host.lifecycle.restore(before,{backupId:backupData.backupId,previewDigest:plan.previewDigest},before.controlRevision,'changed-control-restore'),'MEMORY_STORE_FAILED');
      current=await admin(g); good(await g.service.applyMemoryAction(current,{type:'binding_barrier'},current.controlRevision,'later-binding-control')); g.disableFaults(); good(await g.restart()); const progress=good(await g.service.host.lifecycle.progress(await admin(g),'changed-control-restore')); assert.equal(progress.complete,false); assert.equal(progress.phase,'recovery_blocked'); bad(await g.service.captureContext(g.base),'MEMORY_LIFECYCLE_BLOCKED'); current=await admin(g); assert.equal(good(await g.service.host.lifecycle.resume(current,{operationId:'changed-control-restore'},current.controlRevision,'latest-controls-resume')).complete,true); assert.equal(good(await g.service.searchMemory(await context(g),'changedcontrolword')).records.length,1);
    });
    await test('latest current controls missing quarantines candidates and denies startup instead of replaying backup controls',async()=>{
      const f=instance('lost-controls'); await setup(f); await ingest(f,'control-source','controlword'); const saved=await backup(f); await restore(f,saved.backupId); await f.service.close();
      fs.renameSync(path.join(f.stateDir,'memory-control.sqlite'),path.join(f.stateDir,'preserved-missing-controls.sqlite'));
      bad(await f.restart(),'MEMORY_CURRENT_CONTROL_MISSING'); assert.equal(fs.existsSync(path.join(f.charactersDir,'app','memory','generations')),false); assert.ok(fs.readdirSync(path.join(f.charactersDir,'app','memory','quarantine')).some((name)=>name.startsWith('missing-control-')));
    });
    await test('empty and older valid current-control files remain unknown rather than creating a fresh authority',async()=>{
      for(const variant of ['empty','rollback']) {
        const f=instance('unknown-controls-'+variant); await setup(f); await ingest(f,'unknown-control-root','unknowncontrolword'); const saved=await backup(f); await restore(f,saved.backupId,'restore-before-control-loss'); await deleteRoot(f,['unknown-control-root']); await f.service.close();
        const current=path.join(f.stateDir,'memory-control.sqlite'); fs.renameSync(current,path.join(f.stateDir,'preserved-latest-controls.sqlite'));
        if(variant==='empty') fs.writeFileSync(current,''); else fs.copyFileSync(path.join(f.stateDir,'memory-v2-lifecycle','backups',saved.backupId,'control.sqlite'),current);
        bad(await f.restart(),'MEMORY_CURRENT_CONTROL_UNKNOWN');
        assert.ok(fs.readdirSync(path.join(f.charactersDir,'app','memory','quarantine')).some((name)=>name.startsWith('unknown-control-')));
      }
    });
    await test('lost registration commit response recovers by stable operation alone across native role switch',async()=>{
      const f=instance('registration-unknown',{faults:{operationId:'unknown-register',controlCommitAfter:1}}); await setup(f); const c=await context(f), spool=good(createSpool({directory:path.join(f.stateDir,'unknown-queue'),producerId:'producer',segmentId:'segment',context:c})); good(spool.append(raw('unknown-queued','unknownregisteredword'))); good(spool.seal());
      bad(await f.service.host.registerProducer(c,{producerId:'producer',segmentId:'segment'},'unknown-register'),'MEMORY_COMMIT_UNCERTAIN');
      f.disableFaults(); f.role.id='beta'; f.role.epoch=3; good(await f.restart()); const recovered=good(await f.service.host.queryProducerReceipt({operationId:'unknown-register'},f.authorization)); assert.equal(recovered.characterId,'app'); assert.equal(recovered.capturedEpoch,1); assert.ok(recovered.registrationId);
      const imported=good(await f.service.host.replayProducer({registrationId:recovered.registrationId,batch:good(readSpool({file:spool.file})),operationId:'import-unknown'},f.authorization)); assert.equal(imported.characterId,'app');
      assert.equal(good(await f.service.host.queryProducerReceipt({operationId:'never-registered'},f.authorization)).operationState,'not_found');
      bad(await f.service.host.queryProducerReceipt({registrationId:'wrong-id',operationId:'unknown-register'},f.authorization),'MEMORY_PRODUCER_SCOPE_CONFLICT');
    });
    await test('network admission orders final validation and immediate dispatch before queued revocation, then returns late usage',async()=>{
      let hold=false, release; const entered=deferred(), response=deferred(), order=[];
      const f=instance('network-order',{workerFactory:(url,options)=>{const w=new Worker(url,options),send=w.postMessage.bind(w);w.postMessage=(packet)=>{if(hold && packet.method==='validateContext'){hold=false;release=()=>send(packet);entered.resolve();}else send(packet);};return w;}}); await setup(f); const c=await context(f),a=await admin(f); hold=true;
      const network=f.service.host.withNetworkAdmission(c,()=>{order.push('dispatch');return response.promise;}); await entered.promise;
      const revoke=f.service.applyMemoryAction(a,{type:'revoke_policy',policyId:'private'},a.controlRevision,'revoke-during-network').then((result)=>{order.push('revoke');return result;});
      release(); good(await revoke); assert.deepEqual(order,['dispatch','revoke']); f.role.epoch++; response.resolve({usage:{tokens:17},text:'late vendor result'}); assert.equal((await network).usage.tokens,17); bad(await f.service.validateContext(c),'CHARACTER_EPOCH_STALE');
    });
    await test('network admission releases the fence before custom thenable settlement and preserves billing result or private error',async()=>{
      const f=instance('network-thenable'); await setup(f); const c=await context(f),a=await admin(f),entered=deferred(),response=deferred();
      const pending=f.service.host.withNetworkAdmission(c,()=>({then(resolve,reject){entered.resolve();response.promise.then(resolve,reject);}})); await entered.promise;
      good(await within(f.service.applyMemoryAction(a,{type:'binding_barrier'},a.controlRevision,'thenable-control'))); f.role.epoch++; response.resolve({usage:{tokens:23},text:'late thenable result'}); assert.equal((await pending).usage.tokens,23);
      const fresh=await context(f),cause=new Error('private thenable provider error'); await assert.rejects(f.service.host.withNetworkAdmission(fresh,()=>({then(_resolve,reject){reject(cause);}})),(error)=>error===cause);
    });
    await test('revocation committed first, forged contexts and closed services cannot dispatch',async()=>{
      const f=instance('network-denial'); await setup(f); const c=await context(f),a=await admin(f); let dispatched=0; const send=()=>{dispatched++;return{usage:{tokens:1}};};
      await assert.rejects(f.service.host.withNetworkAdmission({...c},send),(error)=>error.code==='MEMORY_CONTEXT_UNTRUSTED' && !!error.error && !!error.hint);
      good(await f.service.applyMemoryAction(a,{type:'revoke_policy',policyId:'private'},a.controlRevision,'before-native-revoke'));
      await assert.rejects(f.service.host.withNetworkAdmission(c,send),(error)=>typeof error.code==='string' && !!error.error && !!error.hint); assert.equal(dispatched,0);
      good(await f.service.close()); await assert.rejects(f.service.host.withNetworkAdmission(c,send),(error)=>error.code==='MEMORY_WORKER_UNAVAILABLE'); assert.equal(dispatched,0);
    });
    await test('queued native abort settles while lifecycle retirement waits for task idle without deadlocking',async()=>{
      const inventoryEntered=deferred(), inventoryRelease=deferred(), abort=new AbortController(); let armed=false, queued, dispatched=0, f;
      f=instance('network-lifecycle-abort',{lifecycleInventory:async({purpose})=>{if(armed && purpose==='requestDelete'){inventoryEntered.resolve();await inventoryRelease.promise;}return{complete:true,sealedSpool:[],externalCopies:[],quotaSnapshot:null};},retireForLifecycle:async(challenge)=>{abort.abort();await queued;f.role.epoch++;return{ok:true,nonce:challenge.nonce,characterId:f.role.id,epoch:f.role.epoch,sessionsRetired:true,inflightCancelled:true,legacyAdmissionBlocked:true};}}); await setup(f); await ingest(f,'retirement-native-root','nativeretirementword'); const c=await context(f),a=await admin(f),preview=good(await f.service.host.lifecycle.previewDelete(a,{roots:['retirement-native-root']})); armed=true;
      const lifecycle=f.service.host.lifecycle.requestDelete(a,{roots:['retirement-native-root'],previewDigest:preview.previewDigest},a.controlRevision,'delete-queued-native'); await inventoryEntered.promise;
      queued=f.service.host.withNetworkAdmission(c,()=>{dispatched++;return{usage:{tokens:1}};},{signal:abort.signal}).then(()=>null,(error)=>error); inventoryRelease.resolve(); assert.equal(good(await within(lifecycle)).complete,true); assert.equal((await queued).code,'MEMORY_ADMISSION_ABORTED'); assert.equal(dispatched,0);
    });
    await test('queued source expiry is checked again at dispatch and callback failures preserve their private identity',async()=>{
      let hold=false,release; const entered=deferred(); const f=instance('network-expiry',{workerFactory:(url,options)=>{const w=new Worker(url,options),send=w.postMessage.bind(w);w.postMessage=(packet)=>{if(hold && packet.method==='validateContext'){hold=false;release=()=>send(packet);entered.resolve();}else send(packet);};return w;}}); await setup(f);
      const stored=good(await f.service.ingestEvents(await context(f),[raw('expiring-native-root','expiringnativeword',{expiresAt:new Date(f.clock+100).toISOString()})],'expiring-native-import')), c=await context(f); good(await f.service.host.bindInputManifest(c,stored.eventRefs)); let dispatched=0; hold=true;
      const call=f.service.host.withNetworkAdmission(c,()=>{dispatched++;return{};}).catch((error)=>error); await entered.promise; f.clock+=101; release(); assert.equal((await call).code,'MEMORY_SOURCE_STALE'); assert.equal(dispatched,0);
      const fresh=await context(f), cause=new Error('private vendor fixture failure'); await assert.rejects(f.service.host.withNetworkAdmission(fresh,()=>{throw cause;}),(error)=>error===cause);
      const afterStartAbort=new AbortController(); assert.equal((await f.service.host.withNetworkAdmission(fresh,()=>{afterStartAbort.abort();return{usage:{tokens:9}};},{signal:afterStartAbort.signal})).usage.tokens,9);
      const a=await admin(f), attempted=await f.service.host.withNetworkAdmission(fresh,()=>f.service.applyMemoryAction(a,{type:'binding_barrier'},a.controlRevision,'recursive-control')); bad(attempted,'MEMORY_NETWORK_DISPATCH_REENTRANT'); good(await f.service.validateContext(fresh));
    });
    await test('native admission backlog is bounded and cancelled callbacks never execute later',async()=>{
      let hold=false,release; const entered=deferred(); const f=instance('network-bound',{workerFactory:(url,options)=>{const w=new Worker(url,options),send=w.postMessage.bind(w);w.postMessage=(packet)=>{if(hold && packet.method==='validateContext'){hold=false;release=()=>send(packet);entered.resolve();}else send(packet);};return w;}}); await setup(f); const c=await context(f), signals=Array.from({length:67},()=>new AbortController()); let dispatched=0; hold=true;
      const first=f.service.host.withNetworkAdmission(c,()=>{dispatched++;return{};},{signal:signals[0].signal}).catch((error)=>error); await entered.promise;
      const rest=signals.slice(1).map((signal)=>f.service.host.withNetworkAdmission(c,()=>{dispatched++;return{};},{signal:signal.signal}).catch((error)=>error)); signals.forEach((signal)=>signal.abort()); const results=await within(Promise.all([first,...rest])); assert.ok(results.some((error)=>error.code==='MEMORY_ADMISSION_BUSY')); assert.ok(results.every((error)=>!!error.code && !!error.hint)); release(); good(await f.service.getStatus()); assert.equal(dispatched,0);
    });
    await test('organize sources are Host-only, single-domain, complete, bounded and carry stable references/job highwater', async () => {
      const f = instance('organize'); await setup(f); for (let i=0;i<7;i++) await ingest(f, 'batch-'+i, 'organizeword '+i);
      bad(await f.service.host.readOrganizeBatch(await context(f), {}), 'MEMORY_ORGANIZE_REQUIRED');
      let ctx = await context(f, 'organize'); const batch = good(await f.service.host.readOrganizeBatch(ctx, { limit: 3, maxInputTokens: 6000 }));
      assert.equal(batch.events.length, 3); assert.equal(batch.inputManifest.length, 3); assert.equal(batch.automaticModelCall, false); assert.ok(batch.inputTokens <= 6000); assert.ok(batch.domain && batch.policyDomain.audiences.length);
      assert.deepEqual(good(await f.service.host.readOrganizeBatch(ctx, { limit: 3, maxInputTokens: 6000 })), batch);
      bad(await f.service.host.readOrganizeBatch(ctx, { limit:3,cursor:batch.cursor }), 'MEMORY_ORGANIZE_JOB_PENDING');
      const claim = { jobId:batch.jobId,cursor:batch.cursor,inputManifest:batch.inputManifest,requestId:'model-original',inputDigest:batch.inputDigest,state:'model_unknown',candidates:[] };
      good(await f.service.host.finishOrganizeBatch(ctx,claim,'claim-original'));
      assert.equal(good(await f.service.host.readOrganizeBatch(ctx,{limit:3})).jobState,'model_unknown');
      good(await f.restart()); ctx = await context(f,'organize'); const replayed = good(await f.service.host.readOrganizeBatch(ctx,{limit:3})); assert.equal(replayed.jobId,batch.jobId); assert.equal(replayed.jobState,'model_unknown');
      good(await f.service.host.bindInputManifest(ctx,batch.inputManifest)); const item=batch.events[0], candidate=good(await f.service.proposeMemory(ctx,{operationId:'organized-candidate',jobId:batch.jobId,propositionKey:'organizer-fact',kind:'fact',subject:item.subject,content:'organizedfactword',certainty:'reported',expectedRevision:0,evidenceRefs:[{...batch.inputManifest[0],start:0,end:item.content.length,text:item.content}]}));
      assert.equal(good(await f.service.host.readOrganizeBatch(ctx,{limit:3})).jobState,'model_unknown');
      good(await f.service.host.finishOrganizeBatch(ctx,{...claim,state:'completed',candidates:[candidate]},'finish-original'));
      const next = good(await f.service.host.readOrganizeBatch(ctx, { limit: 3, cursor: batch.cursor })); assert.equal(next.events.length, 3); assert.ok(next.events.every((e) => !batch.events.some((old) => old.eventId === e.eventId)));
      bad(await f.service.host.readOrganizeBatch(ctx, { limit: 41 }), 'MEMORY_ORGANIZE_BUDGET_INVALID');
      const tiny = good(await f.service.host.readOrganizeBatch(ctx, { maxInputTokens: 1 })); assert.equal(tiny.events.length, 0); assert.ok(tiny.deferred.length);
    });
  }
} finally { for (const f of instances) await f.service.close(); }
console.log(`Memory V2 lifecycle: ${count} checks passed; runtime ${process.version}; fixtures ${root}`);
