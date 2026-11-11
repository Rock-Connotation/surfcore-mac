import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { canonical, digest, validatePolicy } from '../src/core/memory-v2-contract.js';

const root = path.resolve('_backups/memory-v2-admin', `fixtures-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const good = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const bad = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r)); if (code) assert.equal(r.code, code, JSON.stringify(r)); assert.ok(r.code && r.error && r.hint); return r; };
let count = 0; const instances = [];
async function test(name, task) { const only = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7); if ((only && !name.includes(only)) || (process.argv.includes('--status-only') && !name.startsWith('status inventory'))) return; await task(); console.log(`ok ${++count} - ${name}`); }
function fixture(name, options = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir); const stateDir = path.join(dir, 'state'), charactersDir = path.join(dir, 'characters'); const role = { id: 'alpha', epoch: 1 }, authorization = Symbol(name);
  const base = { channel: 'local', conversationKey: 'app:one', sourceAccountKey: 'local:person', requesterAccountKey: 'local:person', audiencePolicyId: 'private', processingGrantId: 'grant', providerRouteId: 'local:test' };
  const config = { stateDir, charactersDir, getCharacter: () => ({ ...role }), now: () => Date.parse('2026-11-09T12:00:00Z'), authorizeManagement: (value) => value === authorization, workerFactory: (url, value) => new Worker(url, { ...value, workerData: { ...value.workerData, faults: options.faults ?? {} } }), retireForLifecycle: async (r) => ({ ok: true, nonce: r.nonce, characterId: role.id, epoch: ++role.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }), ...options };
  let service = createMemoryService(config); const f = { dir, stateDir, charactersDir, role, authorization, base, get service() { return service; }, disableFaults() { options.faults = {}; }, async restart() { await service.close(); service = createMemoryService(config); return good(await service.initialize()); } }; instances.push(f); return f;
}
const policy = (id, audiences) => validatePolicy({ policyId: id, approved: true, audiences, processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] });
const admin = async (f) => good(await f.service.host.captureAdminContext({ ...f.base, sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner' }, f.authorization)).context;
const context = async (f, override = {}) => good(await f.service.captureContext({ ...f.base, ...override })).context;
async function configure(f, p, id) { const c = await admin(f); return good(await f.service.host.configurePolicy(c, p, c.controlRevision, id)); }
async function setup(f) { good(await f.service.initialize()); await configure(f, policy('private', [['local', 'app:one', 'local:person']]), 'setup-policy'); const c = await admin(f); good(await f.service.applyMemoryAction(c, { type: 'enable_shadow', enabled: true }, c.controlRevision, 'setup-shadow')); }
async function ingest(f, id, content, override = {}) { const c = await context(f, override); return good(await f.service.ingestEvents(c, [{ eventId: id, operationId: `event:${id}`, sourceKey: `source:${id}`, producerId: 'producer', segmentId: 'segment', producerSeq: 1, content }], `ingest:${id}`)); }
async function formal(f, id, content, override = {}) { const c = await context(f, override), ingested = await ingest(f, id, content, override); good(await f.service.host.bindInputManifest(c, ingested.eventRefs)); return good(await f.service.proposeMemory(c, { operationId: `propose:${id}`, propositionKey: id, kind: 'fact', subject: c.sourceAccountKey, content, certainty: 'reported', expectedRevision: 0, evidenceRefs: [{ ...ingested.eventRefs[0], start: 0, end: content.length, text: content }] })); }
async function preview(f, action, payload) { const c = await admin(f), p = good(await f.service.host.admin.preview(c, { action, payload }, c.controlRevision)); return { c, p, request: { action, payload, previewDigest: p.previewDigest } }; }
async function commit(f, action, payload, id) { const { c, p, request } = await preview(f, action, payload); return good(await f.service.host.admin.commit(c, request, c.controlRevision, id)); }
function selectedFile(f) { const db = new DatabaseSync(path.join(f.stateDir, 'memory-control.sqlite'), { readOnly: true }); try { const r = db.prepare('SELECT relativeFile FROM role_generations WHERE characterId=?').get(f.role.id); return r ? path.join(f.charactersDir, f.role.id, r.relativeFile) : path.join(f.charactersDir, f.role.id, 'memory/memory-v2.sqlite'); } finally { db.close(); } }
async function backup(f, id) { const c = await admin(f), p = good(await f.service.host.lifecycle.previewBackup(c, {})); return good(await f.service.host.lifecycle.backup(c, { previewDigest: p.previewDigest }, c.controlRevision, id)); }

try {
  await test('status inventory includes configured unseen policies only in their actual role', async () => {
    const f = fixture('status-policies'); await setup(f); await configure(f, policy('alpha-unseen', [['local','app:one','local:person']]), 'alpha-configure'); const a = await admin(f), first = good(await f.service.host.admin.status(a));
    assert.equal(first.counts.events, 0); assert.ok(first.policies.some((p) => p.policyId === 'alpha-unseen' && p.approved));
    good(await f.service.applyMemoryAction(a, {type:'revoke_policy',policyId:'alpha-unseen'}, a.controlRevision, 'alpha-revoke')); assert.equal(good(await f.service.host.admin.status(await admin(f))).policies.find((p) => p.policyId === 'alpha-unseen').approved, false);
    f.role.id = 'beta'; f.role.epoch++; await configure(f, policy('beta-unseen', [['local','app:one','local:person']]), 'beta-configure'); const b = await admin(f), other = good(await f.service.host.admin.status(b)); assert.equal(other.counts.events, 0); assert.deepEqual(other.policies.map((p) => p.policyId), ['beta-unseen']); bad(await f.service.getMemoryReceipt(b, 'alpha-configure'), 'MEMORY_ADMIN_REQUIRED'); bad(await f.service.host.admin.status(a), 'CHARACTER_EPOCH_STALE');
    await ingest(f, 'beta-source', 'inventory source canary'); assert.ok(good(await f.service.host.admin.status(await admin(f))).policies.some((p) => p.policyId === 'private'));
    f.role.id = 'alpha'; f.role.epoch++; await f.restart(); const own = good(await f.service.host.admin.status(await admin(f))); assert.equal(own.counts.events, 0); assert.ok(own.policies.some((p) => p.policyId === 'alpha-unseen' && !p.approved)); assert.ok(!own.policies.some((p) => p.policyId === 'beta-unseen'));
  });
  await test('status inventory preserves real lifecycle original IDs and pending phases across reopen', async () => {
    const inventory = async (f, operationId, action) => {
      const c = await admin(f), actual = good(await f.service.host.lifecycle.progress(c, operationId)), data = good(await f.service.host.admin.status(c)), row = data.operations.find((item) => item.operationId === operationId);
      assert.ok(row, `missing lifecycle operation ${operationId}`); assert.deepEqual(row, {operationId,characterId:f.role.id,action,phase:actual.phase,complete:actual.complete});
      for (const value of [f.dir, 'inventory source canary', 'catalog-source-root']) assert.ok(!JSON.stringify(data).includes(value)); assert.ok(!JSON.stringify(row).includes('nonce')); return row;
    };
    const f = fixture('status-delete', {retireForLifecycle:undefined}); await setup(f); await ingest(f, 'catalog-source-root', 'inventory source canary'); const saved = await backup(f, 'catalog-backup'); await inventory(f, 'catalog-backup', 'backup');
    let a = await admin(f), p = good(await f.service.host.lifecycle.previewDelete(a, {roots:['catalog-source-root']})); const started = good(await f.service.host.lifecycle.requestDelete(a, {roots:['catalog-source-root'],previewDigest:p.previewDigest}, a.controlRevision, 'catalog-delete')); assert.equal(started.complete, false); await inventory(f, 'catalog-delete', 'request_delete'); await f.restart(); await inventory(f, 'catalog-delete', 'request_delete');
    a = await admin(f); const continued = good(await f.service.host.lifecycle.continueDelete(a, {deleteOperationId:'catalog-delete',purgeRetained:true}, a.controlRevision, 'catalog-continue')); assert.equal(continued.complete, false); await inventory(f, 'catalog-continue', 'continue_delete'); await inventory(f, 'catalog-delete', 'request_delete');
    const g = fixture('status-restore', {retireForLifecycle:undefined}); await setup(g); await ingest(g, 'restore-root', 'inventory source canary'); const old = await backup(g, 'restore-backup'); a = await admin(g); p = good(await g.service.host.lifecycle.previewRestore(a, {backupId:old.backupId})); const restored = good(await g.service.host.lifecycle.restore(a, {backupId:old.backupId,previewDigest:p.previewDigest}, a.controlRevision, 'catalog-restore')); assert.equal(restored.complete, false); await g.restart(); await inventory(g, 'catalog-restore', 'restore');
    g.role.id = 'beta'; g.role.epoch++; const b = await admin(g), other = good(await g.service.host.admin.status(b)); assert.ok(!other.operations.some((row) => row.operationId === 'catalog-restore')); bad(await g.service.getMemoryReceipt(b, 'catalog-restore'));
  });
  await test('inspection is current-role only and rejects ordinary or cloned capabilities', async () => {
    const f = fixture('scope'); await setup(f); await ingest(f, 'own', 'alpha source text'); const c = await admin(f);
    assert.equal(good(await f.service.host.admin.inspect(c, { recordId: 'own', recordRevision: 1 })).records[0].content, 'alpha source text');
    bad(await f.service.host.admin.inspect({ ...c }, {}), 'MEMORY_CONTEXT_UNTRUSTED'); bad(await f.service.host.admin.inspect(await context(f), {}), 'MEMORY_ADMIN_REQUIRED'); bad(await f.service.host.admin.inspect(c, { limit: 21 }), 'MEMORY_QUERY_INVALID');
    f.role.id = 'beta'; f.role.epoch++; const b = await admin(f); assert.equal(good(await f.service.host.admin.status(b)).counts.events, 0); bad(await f.service.host.admin.inspect(b, { recordId: 'own', recordRevision: 1 }), 'MEMORY_RECORD_NOT_FOUND'); bad(await f.service.host.admin.status(c), 'CHARACTER_EPOCH_STALE');
  });
  await test('private preview is mandatory and remove_hot changes prepare selection while keeping explicit search', async () => {
    const f = fixture('hot'); await setup(f); const m = await formal(f, 'hot-source', 'hotword remembered source'); const target = { recordId: m.memoryId, recordRevision: m.revision };
    bad(await f.service.host.admin.commit(await admin(f), { action: 'remove_hot', payload: target, previewDigest: 'f'.repeat(64) }, (await admin(f)).controlRevision, 'untrusted'), 'MEMORY_PREVIEW_UNTRUSTED');
    assert.ok(good(await f.service.prepareMemoryContext(await context(f), 'hotword')).prepared.evidenceIds.includes(m.memoryId));
    const removed = await commit(f, 'remove_hot', target, 'remove-hot'); assert.equal(removed.complete, true);
    assert.equal(good(await f.service.host.admin.inspect(await admin(f), target)).records[0].hot, false); assert.ok(!good(await f.service.prepareMemoryContext(await context(f), 'hotword')).prepared.evidenceIds.includes(m.memoryId));
    assert.ok(good(await f.service.searchMemory(await context(f), 'hotword')).records.some((r) => r.id === m.memoryId)); await commit(f, 'remove_hot', { recordId: 'hot-source', recordRevision: 1 }, 'remove-hot-event'); assert.equal(good(await f.service.prepareMemoryContext(await context(f), 'hotword')).prepared.text, '');
    const c = await admin(f); good(await f.service.applyMemoryAction(c, { type: 'suppress', roots: ['hot-source'] }, c.controlRevision, 'suppress-hot')); assert.equal(good(await f.service.searchMemory(await context(f), 'hotword')).records.length, 0);
  });
  await test('durable request binding survives reopen and is not a committed business receipt', async () => {
    const f = fixture('binding'); await setup(f); const c = await admin(f), r = { operationId: 'bound-only', action: 'correct', payloadDigest: digest({ recordId: 'absent', recordRevision: 1, content: 'binding canary text' }), expectedRevision: c.controlRevision, characterId: c.characterId, characterEpoch: c.capturedEpoch };
    good(await f.service.host.admin.bindRequest(c, r)); assert.equal((await admin(f)).controlRevision, c.controlRevision); await f.restart(); const a = await admin(f);
    assert.deepEqual(good(await f.service.host.admin.bindRequest(a, r)).requestBinding, r); const queried = good(await f.service.getMemoryReceipt(a, r.operationId)); assert.equal(queried.operationState, 'not_started'); assert.equal(queried.sourceState, 'not_applicable'); assert.deepEqual(queried.requestBinding, r);
    for (const delta of [{ payloadDigest: digest('different') }, { action: 'remove_hot' }, { expectedRevision: r.expectedRevision + 1 }, { characterEpoch: r.characterEpoch + 1 }, { characterId: 'beta' }]) bad(await f.service.host.admin.bindRequest(a, { ...r, ...delta }), 'MEMORY_DIGEST_CONFLICT');
    f.role.id = 'beta'; f.role.epoch++; bad(await f.service.getMemoryReceipt(await admin(f), r.operationId), 'MEMORY_RECEIPT_DENIED'); assert.equal(fs.readFileSync(path.join(f.stateDir, 'memory-control.sqlite')).includes(Buffer.from('binding canary text')), false);
  });
  await test('a completed bound business receipt cannot acknowledge a different action body after reopen', async () => {
    const f = fixture('bound-complete'); await setup(f); await ingest(f,'original','boundword'); const c = await admin(f), payload = {recordId:'original',recordRevision:1}, binding = {operationId:'bound-remove',action:'remove_hot',payloadDigest:digest(payload),expectedRevision:c.controlRevision,characterId:c.characterId,characterEpoch:c.capturedEpoch};
    good(await f.service.host.admin.bindRequest(c,binding)); const p = good(await f.service.host.admin.preview(c,{action:'remove_hot',payload},c.controlRevision)); assert.equal(good(await f.service.host.admin.commit(c,{action:'remove_hot',payload,previewDigest:p.previewDigest},c.controlRevision,binding.operationId)).complete,true); await f.restart(); const a = await admin(f), prior = good(await f.service.getMemoryReceipt(a,binding.operationId)); assert.equal(prior.operationState,'completed'); assert.equal(prior.selectionState,'removed_hot'); assert.deepEqual(prior.requestBinding,binding);
    bad(await f.service.host.admin.bindRequest(a,{...binding,payloadDigest:digest({...payload,recordRevision:2})}),'MEMORY_DIGEST_CONFLICT'); assert.equal(good(await f.service.getMemoryReceipt(a,binding.operationId)).operationState,'completed');
  });
  await test('unknown binding COMMIT is queried by original ID after reopen without inventing source success', async () => {
    const f = fixture('binding-unknown', { faults:{operationId:'bind-unknown',controlCommitAfter:1} }); await setup(f); const c = await admin(f), r = {operationId:'bind-unknown',action:'correct',payloadDigest:digest('source is not written'),expectedRevision:c.controlRevision,characterId:c.characterId,characterEpoch:c.capturedEpoch};
    bad(await f.service.host.admin.bindRequest(c,r),'MEMORY_COMMIT_UNCERTAIN'); f.disableFaults(); await f.restart(); const a = await admin(f), receipt = good(await f.service.getMemoryReceipt(a,r.operationId)); assert.deepEqual(receipt.requestBinding,r); assert.equal(receipt.operationState,'not_started'); assert.equal(receipt.sourceState,'not_applicable'); bad(await f.service.host.admin.bindRequest(a,{...r,payloadDigest:digest('another body')}),'MEMORY_DIGEST_CONFLICT');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'memory-v2.lifecycle.json'),'utf8')).minimumCompatibleKernel,2);
  });
  await test('confirmed person creation requires actual stable actor evidence and never silently merges', async () => {
    const f = fixture('person'); await setup(f); const c = await admin(f);
    bad(await f.service.host.admin.preview(c, { action: 'create_person', payload: { platform: 'qq', accountId: '12345' } }, c.controlRevision), 'MEMORY_IDENTITY_EVIDENCE_REQUIRED'); await ingest(f, 'anchor', 'anchorword');
    const created = await commit(f, 'create_person', { platform: 'local', accountId: 'person' }, 'person-one'); assert.equal(created.complete, true); assert.match(created.personId, /^person-/);
    const s = good(await f.service.host.admin.status(await admin(f))); assert.equal(s.bindings[0].personId, created.personId); assert.equal(s.bindings[0].accountId, 'local:person');
    const a = await admin(f); bad(await f.service.host.admin.preview(a, { action: 'create_person', payload: { platform: 'local', accountId: 'person' } }, a.controlRevision), 'MEMORY_IDENTITY_CONFLICT');
    f.role.id = 'beta'; f.role.epoch++; assert.equal(good(await f.service.host.admin.status(await admin(f))).bindings.length, 0);
  });
  await test('cross-channel person queries filter ACL first and unlink invalidates actual identity-dependent views through restore', async () => {
    const f = fixture('identity'); await setup(f); const privateScope = { channel: 'qq', conversationKey: 'qq:90001:private:11001', sourceAccountKey: 'qq:11001', requesterAccountKey: 'qq:11001', audiencePolicyId: 'qq-private' }, publicScope = { channel: 'bili', conversationKey: 'bili:public', sourceAccountKey: 'bili:22001', requesterAccountKey: 'bili:22001', audiencePolicyId: 'bili-public' };
    await configure(f, policy('qq-private', [['qq', privateScope.conversationKey, 'qq:11001']]), 'qq-policy'); await configure(f, policy('bili-public', [['bili', publicScope.conversationKey, 'bili:22001']]), 'bili-policy');
    await ingest(f, 'private-source', 'private identity canary orchid teapot', privateScope); await ingest(f, 'public-source', 'publicword activity', publicScope);
    const person = await commit(f, 'create_person', { platform: 'qq', accountId: '11001' }, 'person-qq'); const old = await context(f, publicScope);
    const linked = await commit(f, 'bind_account', { platform: 'bili', accountId: '22001', personId: person.personId }, 'bind-bili'); bad(await f.service.validateContext(old), 'MEMORY_CONTEXT_UNTRUSTED');
    const records = good(await f.service.searchMemory(await context(f, publicScope), 'publicword', { personId: person.personId })).records; assert.ok(records.some((r) => r.id === 'public-source')); assert.ok(!JSON.stringify(records).includes('orchid teapot'));
    const view = await formal(f, 'derived-public', 'publicword remembered activity', publicScope); assert.ok(good(await f.service.prepareMemoryContext(await context(f, publicScope), 'publicword')).prepared.text.includes('identity=')); const saved = await backup(f, 'before-unlink');
    await commit(f, 'unbind_account', { bindingId: linked.bindingId }, 'unlink-bili'); const after = good(await f.service.searchMemory(await context(f, publicScope), 'publicword')).records; assert.ok(after.some((r) => r.id === 'public-source')); assert.ok(!after.some((r) => r.id === view.memoryId)); assert.ok(after.every((r) => r.identity.state === 'unknown'));
    const a = await admin(f), p = good(await f.service.host.lifecycle.previewRestore(a, { backupId: saved.backupId })); good(await f.service.host.lifecycle.restore(a, { backupId: saved.backupId, previewDigest: p.previewDigest }, a.controlRevision, 'restore-identity')); assert.ok(!good(await f.service.searchMemory(await context(f, publicScope), 'publicword')).records.some((r) => r.id === view.memoryId));
  });
  await test('correction creates a real independent reported version, preserves subject/time, and keeps control snapshots text-free', async () => {
    const f = fixture('correct'); await setup(f); const old = await formal(f, 'old-fact', 'oldword original belief'), target = { recordId: old.memoryId, recordRevision: old.revision }, content = 'corrected private canary silver meadow';
    const result = await commit(f, 'correct', { ...target, content }, 'correct-one'); assert.equal(result.complete, true); assert.equal(result.memoryId, old.memoryId); assert.equal(result.revision, 2);
    const inspected = good(await f.service.host.admin.inspect(await admin(f), { recordId: old.memoryId, recordRevision: 2 })).records[0]; assert.equal(inspected.content, content); assert.equal(inspected.provenance.certainty, 'reported'); assert.equal(inspected.provenance.attribution, 'administrator-statement'); assert.equal(inspected.provenance.corrects.revision, 1); assert.equal(inspected.subject, 'local:person'); assert.ok(!inspected.roots.includes('old-fact'));
    assert.equal(good(await f.service.searchMemory(await context(f), 'oldword')).records.length, 0); assert.ok(good(await f.service.searchMemory(await context(f), 'meadow')).records.some((r) => r.revision === 2));
    const snap = await backup(f, 'correct-backup'); assert.equal(fs.readFileSync(path.join(f.stateDir, 'memory-control.sqlite')).includes(Buffer.from(content)), false);
    const manifests = fs.readdirSync(path.join(f.stateDir, 'memory-v2-lifecycle', 'backups'), { recursive: true });
    for (const name of manifests.filter((name) => String(name).endsWith('control.sqlite'))) assert.equal(fs.readFileSync(path.join(f.stateDir, 'memory-v2-lifecycle', 'backups', name)).includes(Buffer.from(content)), false);
    await f.restart(); const same = good(await f.service.getMemoryReceipt(await admin(f), 'correct-one')); assert.equal(same.memoryId, old.memoryId); assert.equal(same.revision, 2);
    const forged = await f.service.host.admin.commit(await admin(f), { action: 'correct', payload: { ...target, content: 'different text' }, previewDigest: 'ignored-for-receipt' }, 2, 'correct-one'); bad(forged, 'MEMORY_DIGEST_CONFLICT'); assert.ok(snap.backupId);
  });
  await test('correction normalizes source text without storing its body in control and rejects expired originals', async () => {
    let clock = Date.parse('2026-11-09T12:00:00Z'); const f = fixture('normalization', { now: () => clock }); await setup(f); await ingest(f, 'normal-original', 'normalword');
    const raw = 'normalizedword api_key=synthetic-correction-fixture-secret'; const result = await commit(f, 'correct', { recordId: 'normal-original', recordRevision: 1, content: raw }, 'normalize-correct');
    const actual = good(await f.service.host.admin.inspect(await admin(f), { recordId: result.memoryId, recordRevision: result.revision })).records[0]; assert.ok(actual.content.includes('[已隐藏]')); assert.ok(!actual.content.includes('synthetic-correction-fixture-secret')); assert.ok(!fs.readFileSync(path.join(f.stateDir, 'memory-control.sqlite')).includes(Buffer.from(raw)));
    const c = await context(f); good(await f.service.ingestEvents(c, ['expired-original','expiring-original'].map((eventId,index)=>({eventId,operationId:`event:${eventId}`,sourceKey:`source:${eventId}`,producerId:'producer',segmentId:'expiry',producerSeq:index+1,content:'expiryword',expiresAt:'2026-11-09T13:00:00Z'})), 'expired-ingest')); await commit(f,'correct',{recordId:'expiring-original',recordRevision:1,content:'boundedword reported assertion'},'bounded-correct'); clock = Date.parse('2026-11-09T14:00:00Z'); assert.equal(good(await f.service.searchMemory(await context(f),'boundedword')).records.length,0); const a = await admin(f);
    bad(await f.service.host.admin.preview(a, { action:'correct',payload:{recordId:'expired-original',recordRevision:1,content:'new assertion'} }, a.controlRevision), 'MEMORY_SOURCE_EXPIRED');
  });
  await test('an operation ID owned by another business cannot invalidate a source before digest rejection', async () => {
    const f = fixture('operation-collision'); await setup(f); await ingest(f,'original','collisionword'); const {c,request} = await preview(f,'correct',{recordId:'original',recordRevision:1,content:'replacementword'});
    bad(await f.service.host.admin.commit(c,request,c.controlRevision,'ingest:original'),'MEMORY_DIGEST_CONFLICT'); assert.equal((await admin(f)).controlRevision,c.controlRevision); assert.ok(good(await f.service.searchMemory(await context(f),'collisionword')).records.length);
  });
  await test('missing retirement remains pending and blocks ordinary admission without claiming completion', async () => {
    const f = fixture('retirement', { retireForLifecycle: undefined }); await setup(f); await ingest(f, 'original', 'beforeword'); const result = await commit(f, 'correct', { recordId: 'original', recordRevision: 1, content: 'afterword' }, 'no-retirement'); assert.equal(result.complete, false); assert.equal(result.code, 'MEMORY_RETIREMENT_REQUIRED'); bad(await f.service.captureContext(f.base), 'MEMORY_ADMIN_PENDING'); assert.equal(good(await f.service.getMemoryReceipt(await admin(f), 'no-retirement')).operationState, 'pending');
  });
  for (const stage of ['adminAfterIntent', 'adminAfterRole', 'adminBeforeRetirement', 'adminAfterAcknowledgement', 'controlCommitBefore', 'controlCommitAfter', 'roleCommitBefore', 'roleCommitAfter']) await test(`original correction resumes without duplicates after ${stage}`, async () => {
    const f = fixture(stage, { faults: { operationId: 'recover-correct', [stage]: 1 } }); await setup(f); await ingest(f, 'original', 'beforeword original source'); const { c, request } = await preview(f, 'correct', { recordId: 'original', recordRevision: 1, content: 'recoveryword confirmed reported assertion' });
    const first = await f.service.host.admin.commit(c, request, c.controlRevision, 'recover-correct'); assert.equal(first.ok, false, JSON.stringify(first)); f.disableFaults(); await f.restart(); const queried = good(await f.service.getMemoryReceipt(await admin(f), 'recover-correct'));
    if (queried.operationState === 'not_found') { await commit(f, 'correct', request.payload, 'recover-correct'); } else if (!queried.complete) { const resumed = good(await f.service.host.admin.resume(await admin(f), { operationId: 'recover-correct', content: request.payload.content })); assert.equal(resumed.complete, true); }
    assert.equal(good(await f.service.searchMemory(await context(f), 'beforeword')).records.length, 0); const db = new DatabaseSync(selectedFile(f), { readOnly: true }); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE sourceKey LIKE 'admin-%'").get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_versions').get().n, 1); } finally { db.close(); }
  });
  await test('intent without source text is explicitly pending and exact-content replay rejects a changed assertion', async () => {
    const f = fixture('missing-content', { faults: { operationId: 'correct-needs-text', adminAfterIntent: 1 } }); await setup(f); await ingest(f, 'original', 'beforeword'); const { c, request } = await preview(f, 'correct', { recordId: 'original', recordRevision: 1, content: 'sameword confirmed content' }); bad(await f.service.host.admin.commit(c, request, c.controlRevision, 'correct-needs-text')); f.disableFaults(); await f.restart();
    bad(await f.service.host.admin.resume(await admin(f), { operationId: 'correct-needs-text' }), 'MEMORY_CORRECTION_CONTENT_REQUIRED'); bad(await f.service.host.admin.resume(await admin(f), { operationId: 'correct-needs-text', content: 'different content' }), 'MEMORY_DIGEST_CONFLICT'); assert.equal(good(await f.service.getMemoryReceipt(await admin(f), 'correct-needs-text')).operationState, 'pending'); assert.equal(good(await f.service.host.admin.resume(await admin(f), { operationId: 'correct-needs-text', content: request.payload.content })).complete, true);
  });
  console.log(`Memory V2 admin: ${count} checks passed; runtime ${process.version}`);
} finally { for (const f of instances) await f.service.close(); }
