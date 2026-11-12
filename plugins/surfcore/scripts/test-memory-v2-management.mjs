import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createMemoryService } from '../../../src/core/memory-v2-service.js';
import { digest, validatePolicy } from '../../../src/core/memory-v2-contract.js';
import { createMemoryManagementController } from '../lib/memory-v2-management.mjs';

const root = path.resolve('_backups/memory-v2-management', `fixtures-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const checks = [], fixtures = [];
const selectedCase = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const good = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code, JSON.stringify(value)); assert.ok(value.code && value.error && value.hint); return value; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const timed = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture wait timed out')), 8000); })]); } finally { clearTimeout(timer); } };
async function test(name, fn) { if (selectedCase && selectedCase !== name) return; await fn(); checks.push(name); }
const BASE = '/dsh-surfcore/api/memory-v2';
function policy(id) { return validatePolicy({ policyId: id, approved: true, audiences: [['local', 'app:one', 'local:person']], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] }); }
async function fixture(name, extra = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const role = { id: 'app', epoch: 1, name: '当前角色' }, authorization = Symbol(name), records = new Map();
  const runtime = { backend: 'v2', policies: [{ id: 'private', label: '当前私有授权' }], backups: [], operations: [], approvedConversations: [{ id: 'approved-one', label: '当前已批准会话', processorScopes: [{ id: 'local', label: '本机处理', policy: policy('selected-policy') }] }], budget: {} };
  const base = { channel: 'local', conversationKey: 'app:one', sourceAccountKey: 'local:person', requesterAccountKey: 'local:person', audiencePolicyId: 'private', providerRouteId: 'local:test', processingGrantId: 'grant' };
  let worker;
  const config = { stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => ({ ...role }), authorizeManagement: cap => cap === authorization,
    workerFactory: (url, options) => (worker = new Worker(url, { ...options, workerData: { ...options.workerData, faults: extra.faults || {} } })),
    lifecycleInventory: async () => ({ complete: true, sealedSpool: [], externalCopies: [], quotaSnapshot: null }),
    // Fixture-only retirement: no production session retirement or history purge is claimed.
    retireForLifecycle: Object.hasOwn(extra, 'retireForLifecycle') ? extra.retireForLifecycle : async challenge => { role.epoch++; return { ok: true, nonce: challenge.nonce, characterId: role.id, epoch: role.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }; },
  };
  let service = createMemoryService(config), controller, server;
  good(await service.initialize());
  const admin = async () => good(await service.host.captureAdminContext(base, authorization)).context;
  let ctx = await admin(); good(await service.host.configurePolicy(ctx, policy('private'), ctx.controlRevision, 'initial-policy'));
  ctx = await admin(); good(await service.applyMemoryAction(ctx, { type: 'enable_shadow', enabled: true }, ctx.controlRevision, 'initial-shadow'));
  const f = { dir, role, authorization, runtime, records, admin, get service() { return service; }, get worker() { return worker; }, get controller() { return controller; }, clearFaults() { extra.faults = {}; }, setFaults(value) { extra.faults = value; }, get server() { return server; }, notifications: [], runtimeHook: null, serviceOverride: null, reader: true, now: Date.now(),
    async ingest(id, content = '管理角色私有来源') { const c = good(await service.captureContext(base)).context; const result = good(await service.ingestEvents(c, [{ eventId: id, operationId: `event:${id}`, sourceKey: `source:${id}`, producerId: 'producer', segmentId: 'segment', producerSeq: 1, subject: 'local:person', content }], `batch:${id}`)); records.set(id, { characterId: role.id, id, revision: 1, content, roots: result.eventRefs.map(ref => ref.id) }); return result; },
    async status() { return good((await f.request('/status')).value); },
    async body(action, payload = {}, id = randomUUID(), changes = {}) { const s = await f.status(); return { action, payload: { ...payload, payloadDigest: digest(payload) }, expectedRevision: s.revision, operationId: id, characterId: s.character.id, characterEpoch: s.character.epoch, ...changes }; },
    async preview(body) { const action = ({ backup: 'preview_backup', restore: 'preview_restore', request_delete: 'preview_delete', migrate: 'preview_migration' })[body.action]; return (await f.request('/manage', { body: { ...body, action: action || body.action, payload: { ...body.payload, ...(!action ? { preview: true } : {}) } } })).value; },
    async commit(body) { return (await f.request('/manage', { body })).value; },
    async resetController(options = {}) {
      controller?.dispose();
      controller = createMemoryManagementController({ memoryService: f.serviceOverride || service, getCharacter: config.getCharacter, getAuthorization: req => req.headers.cookie === 'fixture-admin' ? authorization : null,
        getRuntimeStatus: async ({ context }) => { assert.equal(context.purpose, 'admin'); if (f.runtimeHook) await f.runtimeHook(); return runtime; }, now: () => f.now,
        ...(f.reader ? { inspectMemory: async ({ context, query, limit, recordId, recordRevision }) => { assert.equal(context.purpose, 'admin'); assert.equal(context.characterId, role.id); if (recordId) { const record = records.get(recordId); return record?.revision === recordRevision ? { ok: true, record } : { ok: false, code: 'MEMORY_RECORD_STALE' }; } return { ok: true, records: [...records.values()].filter(r => r.characterId === role.id && r.content.includes(query)).slice(0, limit) }; } } : {}),
        onControlChanged: info => { f.notifications.push(info); }, ...options });
    },
    async restartService() { controller.dispose(); await service.close(); service = createMemoryService(config); good(await service.initialize()); f.serviceOverride = null; await f.resetController(); },
    async restartHttp() { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.port = server.address().port; },
    async close() { controller?.dispose(); await new Promise(resolve => server.close(resolve)); await service.close(); },
  };
  await f.resetController();
  server = http.createServer((req, res) => { if (f.dropNextResponse) { f.dropNextResponse = false; res.end = () => { res.destroy(); return res; }; } void controller.handle(req, res, new URL(req.url, 'http://127.0.0.1')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.port = server.address().port;
  f.request = async (route, { body, raw, headers = {}, method = body !== undefined || raw !== undefined ? 'POST' : 'GET', cookie = 'fixture-admin' } = {}) => {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, path: `${BASE}${route}`, method, headers: { cookie, origin: `http://127.0.0.1:${f.port}`, ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
        let string = ''; res.on('data', chunk => { string += chunk; }); res.on('end', () => { let value; try { value = JSON.parse(string); } catch { value = string; } resolve({ status: res.statusCode, value, text: string }); });
      });
      req.on('error', reject); req.end(raw ?? (body !== undefined ? JSON.stringify(body) : undefined));
    });
  };
  fixtures.push(f); return f;
}
async function resumable(name, { fault, action = 'correct', inject = true } = {}) {
  let healthy = false, calls = 0, x;
  x = await fixture(name, { retireForLifecycle: async challenge => { if (!healthy) throw new Error('fixture retirement pending'); x.role.epoch++; return { ok: true, nonce: challenge.nonce, characterId: x.role.id, epoch: x.role.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }; } });
  const options = () => {
    const runner = { preview: ({ context, action, payload, expectedRevision }) => x.service.host.admin.preview(context, { action, payload }, expectedRevision), commit: ({ context, action, payload, previewDigest, expectedRevision, operationId }) => x.service.host.admin.commit(context, { action, payload, previewDigest }, expectedRevision, operationId), receipt: ({ context, operationId }) => x.service.getMemoryReceipt(context, operationId) };
    return { getRuntimeStatus: ({ context }) => x.service.host.admin.status(context), corrector: runner, identityManager: runner, hotManager: runner, ...(inject ? { adminResumer: { resume: args => { calls++; return x.service.host.admin.resume(args.context, { operationId: args.operationId, ...(args.content !== undefined ? { content: args.content } : {}) }); } } } : {}) };
  };
  x.setupResume = overrides => x.resetController({ ...options(), ...overrides }); x.allowRetirement = () => { healthy = true; }; x.resumeCalls = () => calls;
  await x.setupResume(); await x.ingest('resume-original', 'original resume evidence');
  x.originalContent = 'REPORTED_RESUME_CONTENT_CANARY';
  x.original = await x.body(action, action === 'correct' ? { recordId: 'resume-original', recordRevision: 1, content: x.originalContent } : action === 'remove_hot' ? { recordId: 'resume-original', recordRevision: 1 } : { platform: 'local', accountId: 'person' }, `${name}:original`);
  if (action === 'create_person') {
    const c = await x.admin(), payload = { platform: 'local', accountId: 'person' }; good(await x.service.host.admin.bindRequest(c, { operationId: x.original.operationId, action, payloadDigest: digest(payload), expectedRevision: c.controlRevision, characterId: x.role.id, characterEpoch: x.role.epoch })); const p = good(await x.service.host.admin.preview(c, { action, payload }, c.controlRevision));
    const pending = good(await x.service.host.admin.commit(c, { action, payload, previewDigest: p.previewDigest }, c.controlRevision, x.original.operationId)); assert.equal(pending.complete, false); assert.equal(pending.code, 'MEMORY_RETIREMENT_REQUIRED');
  } else {
    if (fault) {
      const b = x.original, payload = action === 'correct' ? { recordId: 'resume-original', recordRevision: 1, content: x.originalContent } : { recordId: 'resume-original', recordRevision: 1 };
      good(await x.service.host.admin.bindRequest(await x.admin(), { operationId: b.operationId, action, payloadDigest: digest(payload), expectedRevision: b.expectedRevision, characterId: b.characterId, characterEpoch: b.characterEpoch }));
      x.setFaults({ operationId: b.operationId, [fault]: 1 }); await x.restartService(); await x.setupResume();
    }
    good(await x.preview(x.original)); bad(await x.commit(x.original));
  }
  if (fault) { x.clearFaults(); await x.restartService(); await x.setupResume(); }
  x.resumeBody = async content => { const c = await x.admin(), payload = { operationId: x.original.operationId, ...(content !== undefined ? { content } : {}) }; return { ...payload, characterId: x.role.id, characterEpoch: x.role.epoch, expectedRevision: c.controlRevision, payloadDigest: digest(payload) }; };
  x.previewResume = async b => (await x.request('/admin-resume', { body: { ...b, preview: true } })).value;
  x.commitResume = async b => (await x.request('/admin-resume', { body: b })).value;
  return x;
}

try {
  const f = await fixture('primary'); await f.ingest('own-root', 'OWN_ADMIN_SOURCE');
  await test('admin-resume-real-generic-gap-native-control-and-dedicated-original-ID', async () => {
    const native = await resumable('resume-native'); const legacy = await native.body('resume'); bad(await native.preview(legacy), 'MEMORY_OPERATION_REQUIRED');
    native.allowRetirement(); assert.equal(good(await native.service.host.admin.resume(await native.admin(), { operationId: native.original.operationId })).complete, true);
    const x = await resumable('resume-http'); const before = good(await x.service.getMemoryReceipt(await x.admin(), x.original.operationId)); assert.equal(before.complete, false); assert.equal(before.sourceState, 'committed'); assert.equal((await x.status()).capabilities.adminResume, true);
    const b = await x.resumeBody(); const p = good(await x.previewResume(b)); assert.equal(p.operationId, b.operationId); assert.equal(p.payloadDigest, b.payloadDigest); assert.equal(p.preview.action, 'correct'); assert.equal(x.resumeCalls(), 0);
    x.allowRetirement(); const r = bad(await x.commitResume(b), 'CHARACTER_EPOCH_STALE'); assert.equal(r.operationId, b.operationId); assert.equal(r.operationState, 'completed_before_cancel'); assert.equal(r.sourceState, 'committed'); assert.equal(r.retry, 'query_receipt');
    const receipt = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(receipt.complete, true); assert.equal(receipt.operationId, b.operationId); assert.equal(x.resumeCalls(), 1);
    const after = good(await x.service.getMemoryReceipt(await x.admin(), b.operationId)); assert.deepEqual(after.requestBinding, before.requestBinding); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2);
    assert.ok(!JSON.stringify([p,r,receipt]).includes(x.originalContent));
  });
  await test('admin-resume-intent-requires-original-content-without-persisting-plaintext', async () => {
    const x = await resumable('resume-intent', { fault: 'adminAfterIntent' });
    const before = good(await x.service.getMemoryReceipt(await x.admin(), x.original.operationId)); assert.equal(before.phase, 'intent'); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 1);
    let b = await x.resumeBody(); good(await x.previewResume(b)); const missing = bad(await x.commitResume(b), 'MEMORY_CORRECTION_CONTENT_REQUIRED'); assert.equal(missing.operationId, b.operationId); assert.equal(missing.complete, false); assert.match(missing.hint, /原文/);
    b = await x.resumeBody('DIFFERENT_RESUME_CONTENT'); good(await x.previewResume(b)); const wrong = bad(await x.commitResume(b), 'MEMORY_DIGEST_CONFLICT'); assert.match(wrong.hint, /原文/); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 1);
    b = await x.resumeBody(x.originalContent); const p = good(await x.previewResume(b)); assert.ok(!JSON.stringify(p).includes(x.originalContent)); x.allowRetirement(); const result = bad(await x.commitResume(b), 'CHARACTER_EPOCH_STALE'); assert.equal(result.sourceState, 'committed');
    const after = good(await x.service.getMemoryReceipt(await x.admin(), b.operationId)); assert.equal(after.complete, true); assert.deepEqual(after.requestBinding, before.requestBinding); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2);
    for (const file of fs.readdirSync(path.join(x.dir, 'state')).filter(name => name.startsWith('memory-control.sqlite'))) assert.equal(fs.readFileSync(path.join(x.dir, 'state', file)).includes(Buffer.from(x.originalContent)), false);
  });
  await test('admin-resume-auth-typed-body-preview-TTL-and-scope-denials', async () => {
    const x = await resumable('resume-denials'); let b = await x.resumeBody();
    await x.setupResume({ adminResumer: null }); assert.equal((await x.status()).capabilities.adminResume, false); bad(await x.previewResume(b), 'MEMORY_ACTION_UNAVAILABLE'); await x.setupResume();
    bad((await x.request('/admin-resume', { body: { ...b, preview: true }, cookie: '' })).value, 'MEMORY_ADMIN_REQUIRED');
    bad((await x.request('/admin-resume', { body: { ...b, preview: true }, headers: { origin: 'https://invalid.example' } })).value, 'MEMORY_ORIGIN_REJECTED');
    bad((await x.request('/admin-resume', { body: { ...b, preview: true }, headers: { host: 'invalid.example' } })).value, 'MEMORY_AUTH_REQUIRED');
    for (const key of ['action', 'admin', 'authorization', 'purpose', 'controlRevision', 'previewDigest']) bad(await x.previewResume({ ...b, [key]: 'forged' }), 'MEMORY_FIELD_FORBIDDEN');
    bad((await x.request('/admin-resume', { body: { ...b, preview: false } })).value, 'MEMORY_REQUEST_INVALID'); bad(await x.previewResume({ ...b, content: 'tampered' }), 'MEMORY_PAYLOAD_MISMATCH'); bad(await x.previewResume({ ...b, characterId: 'other' }), 'CHARACTER_EPOCH_STALE'); bad(await x.previewResume({ ...b, characterEpoch: b.characterEpoch + 1 }), 'CHARACTER_EPOCH_STALE');
    bad(await x.previewResume({ ...b, expectedRevision: 0 }), 'MEMORY_REVISION_CONFLICT'); bad(await x.commitResume(b), 'MEMORY_PREVIEW_REQUIRED');
    good(await x.previewResume(b)); const changed = await x.resumeBody('different valid digest'); bad(await x.commitResume(changed), 'MEMORY_DIGEST_CONFLICT'); assert.equal(x.resumeCalls(), 0);
    good(await x.previewResume(b)); x.now += 120001; bad(await x.commitResume(b), 'MEMORY_PREVIEW_REQUIRED'); assert.equal(x.resumeCalls(), 0);
    good(await x.previewResume(b)); await x.setupResume(); bad(await x.commitResume(b), 'MEMORY_PREVIEW_REQUIRED');
    for (const operationId of ['absent-operation', 'initial-policy', 'batch:resume-original']) { const q = { ...b, operationId }; q.payloadDigest = digest({ operationId }); bad(await x.previewResume(q), 'MEMORY_OPERATION_NOT_FOUND'); }
    x.role.id = 'other'; x.role.epoch++; b = await x.resumeBody(); const denied = bad(await x.previewResume(b), 'MEMORY_OPERATION_NOT_FOUND'); assert.equal(denied.operationId, x.original.operationId); assert.equal(x.resumeCalls(), 0); assert.ok(!JSON.stringify(denied).includes(x.originalContent));
  });
  await test('admin-resume-native-control-CAS-and-fresh-phase-races', async () => {
    const x = await resumable('resume-CAS'); let nativeCalls = 0;
    await x.setupResume({ adminResumer: { resume: async args => { nativeCalls++; const c = await x.admin(); good(await x.service.applyMemoryAction(c, { type: 'binding_barrier' }, c.controlRevision, 'interleaved-control')); return x.service.host.admin.resume(args.context, { operationId: args.operationId }); } } });
    const b = await x.resumeBody(); good(await x.previewResume(b)); const stale = bad(await x.commitResume(b), 'MEMORY_CONTEXT_STALE'); assert.equal(stale.operationId, b.operationId); assert.equal(stale.sourceState, 'committed'); assert.equal(nativeCalls, 1); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2);
    bad(await x.previewResume(b), 'MEMORY_REVISION_CONFLICT');
    const y = await resumable('resume-phase', { fault: 'adminAfterIntent' }); const q = await y.resumeBody(y.originalContent); good(await y.previewResume(q));
    const moved = good(await y.service.host.admin.resume(await y.admin(), { operationId: y.original.operationId, content: y.originalContent })); assert.equal(moved.complete, false); assert.equal(moved.phase, 'retirement_required');
    bad(await y.commitResume(q), 'MEMORY_PREVIEW_STALE'); assert.equal(y.resumeCalls(), 0); assert.equal(good(await y.service.host.admin.status(await y.admin())).counts.events, 2);
    const next = await y.resumeBody(); good(await y.previewResume(next)); y.allowRetirement(); assert.equal(good(await y.service.host.admin.resume(await y.admin(), { operationId: y.original.operationId })).complete, true);
    const expiredRole = bad(await y.commitResume(next), 'CHARACTER_EPOCH_STALE'); assert.equal(expiredRole.operationId, next.operationId); assert.equal(expiredRole.retry, 'query_receipt'); const completed = await y.resumeBody(); bad(await y.previewResume(completed), 'MEMORY_OPERATION_COMPLETED'); assert.equal(y.resumeCalls(), 0); assert.equal(good(await y.service.host.admin.status(await y.admin())).counts.events, 2);
  });
  await test('admin-resume-lost-HTTP-restart-original-receipt-readonly-no-duplicates', async () => {
    const x = await resumable('resume-lost'); const b = await x.resumeBody(), original = good(await x.service.getMemoryReceipt(await x.admin(), b.operationId)); good(await x.previewResume(b));
    x.dropNextResponse = true; await assert.rejects(x.commitResume(b)); assert.equal(x.resumeCalls(), 1); await x.restartService(); await x.setupResume();
    const first = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(first.complete, false);
    const files = fs.readdirSync(path.join(x.dir, 'state')).filter(name => name.startsWith('memory-control.sqlite')); const bytes = files.map(file => fs.readFileSync(path.join(x.dir, 'state', file)));
    for (let i = 0; i < 2; i++) { const r = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(r.complete, false); assert.equal(r.operationId, b.operationId); }
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(x.dir, 'state', file)), bytes[i], 'GET receipt cannot write or resume'));
    bad(await x.commitResume(b), 'MEMORY_PREVIEW_REQUIRED'); const fresh = await x.resumeBody(); good(await x.previewResume(fresh)); x.allowRetirement(); bad(await x.commitResume(fresh), 'CHARACTER_EPOCH_STALE');
    const after = good(await x.service.getMemoryReceipt(await x.admin(), b.operationId)); assert.equal(after.complete, true); assert.deepEqual(after.requestBinding, original.requestBinding); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2); assert.equal(x.resumeCalls(), 2);
    bad(await x.previewResume(await x.resumeBody()), 'MEMORY_OPERATION_COMPLETED'); assert.equal(x.resumeCalls(), 2);
  });
  await test('admin-resume-native-identity-and-remove-hot-original-targets', async () => {
    const identity = await resumable('resume-identity', { action: 'create_person' }); const b = await identity.resumeBody(); const before = good(await identity.service.getMemoryReceipt(await identity.admin(), b.operationId));
    bad(await identity.previewResume(await identity.resumeBody('forbidden identity text')), 'MEMORY_FIELD_FORBIDDEN'); good(await identity.previewResume(b)); identity.allowRetirement(); bad(await identity.commitResume(b), 'CHARACTER_EPOCH_STALE');
    const after = good(await identity.service.getMemoryReceipt(await identity.admin(), b.operationId)); assert.equal(after.complete, true); assert.deepEqual(after.requestBinding, before.requestBinding); assert.equal(good(await identity.service.host.admin.status(await identity.admin())).bindings.length, 1); assert.equal(identity.resumeCalls(), 1);
    const hot = await resumable('resume-hot', { action: 'remove_hot', fault: 'adminAfterRole' }); const q = await hot.resumeBody(); good(await hot.previewResume(q)); const removed = good(await hot.commitResume(q)); assert.equal(removed.operationId, q.operationId); assert.equal(removed.complete, true); assert.equal(removed.selectionState, 'removed_hot'); assert.equal(hot.role.epoch, 1); assert.equal(hot.resumeCalls(), 1);
  });
  await test('admin-resume-keeps-generic-lifecycle-resume-original-protocol', async () => {
    let healthy = false, x;
    x = await fixture('resume-lifecycle', { retireForLifecycle: async challenge => { if (!healthy) throw new Error('fixture pending lifecycle'); return { ok: true, nonce: challenge.nonce, characterId: x.role.id, epoch: ++x.role.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }; } });
    await x.ingest('legacy-root'); await x.resetController({ getRuntimeStatus: ({ context }) => x.service.host.admin.status(context), adminResumer: { resume: ({ context, operationId }) => x.service.host.admin.resume(context, { operationId }) } });
    const a = await x.body('request_delete', { mode: 'delete_roots', recordId: 'legacy-root', recordRevision: 1 }); good(await x.preview(a)); assert.equal((await x.commit(a)).complete, false);
    const c = await x.admin(), q = { operationId: a.operationId, characterId: x.role.id, characterEpoch: x.role.epoch, expectedRevision: c.controlRevision, payloadDigest: digest({ operationId: a.operationId }), preview: true }; bad((await x.request('/admin-resume', { body: q })).value, 'MEMORY_OPERATION_NOT_FOUND');
    const continuation = await x.body('resume'); good(await x.preview(continuation)); healthy = true; const r = bad(await x.commit(continuation), 'CHARACTER_EPOCH_STALE'); assert.equal(r.operationId, continuation.operationId); assert.notEqual(r.operationId, a.operationId); const receipt = good((await x.request(`/receipt?operationId=${r.operationId}`)).value); assert.equal(receipt.complete, true);
  });
  await test('admin-resume-same-A-inflight-and-native-role-change-drop-content', async () => {
    const x = await resumable('resume-concurrent'); const entered = deferred(), release = deferred(); let calls = 0;
    await x.setupResume({ adminResumer: { resume: async args => { calls++; entered.resolve(); await release.promise; return x.service.host.admin.resume(args.context, { operationId: args.operationId }); } } });
    const b = await x.resumeBody(); good(await x.previewResume(b)); const first = x.commitResume(b); await timed(entered.promise); const second = bad(await x.commitResume(b), 'MEMORY_OPERATION_BUSY'); assert.equal(second.operationId, b.operationId); assert.equal(calls, 1); release.resolve(); const r = bad(await first, 'MEMORY_RETIREMENT_REQUIRED'); assert.equal(r.sourceState, 'committed'); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2);
    const y = await resumable('resume-role-await'); const paused = deferred(), proceed = deferred(), real = y.service.host.admin.status;
    y.serviceOverride = { ...y.service, host: { ...y.service.host, admin: { ...y.service.host.admin, status: async (...args) => { const value = await real(...args); paused.resolve(); await proceed.promise; return value; } } } }; await y.setupResume();
    const q = await y.resumeBody(), pending = y.previewResume(q); await timed(paused.promise); y.role.id = 'other'; y.role.epoch++; proceed.resolve(); const denied = bad(await pending, 'CHARACTER_EPOCH_STALE'); assert.equal(denied.operationId, q.operationId); assert.equal(denied.retry, 'query_receipt'); assert.ok(!JSON.stringify(denied).includes(y.originalContent)); assert.equal(y.resumeCalls(), 0);
  });
  await test('admin-resume-worker-loss-stays-original-ID-query-only-until-explicit-preview', async () => {
    const x = await resumable('resume-worker-loss'); const b = await x.resumeBody(); good(await x.previewResume(b)); await x.worker.terminate();
    const failed = bad(await x.commitResume(b), 'MEMORY_WORKER_UNAVAILABLE'); assert.equal(failed.operationId, b.operationId); assert.equal(failed.retry, 'query_receipt'); assert.equal(failed.operationState, 'unknown'); assert.equal(x.resumeCalls(), 0);
    const waiting = bad((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(waiting.operationId, b.operationId); assert.equal(waiting.retry, 'query_receipt');
    await x.restartService(); await x.setupResume(); assert.equal(good((await x.request(`/receipt?operationId=${b.operationId}`)).value).complete, false); assert.equal(x.resumeCalls(), 0); bad(await x.commitResume(b), 'MEMORY_PREVIEW_REQUIRED');
    const q = await x.resumeBody(); good(await x.previewResume(q)); x.allowRetirement(); bad(await x.commitResume(q), 'CHARACTER_EPOCH_STALE'); assert.equal(good((await x.request(`/receipt?operationId=${b.operationId}`)).value).complete, true); assert.equal(x.resumeCalls(), 1); assert.equal(good(await x.service.host.admin.status(await x.admin())).counts.events, 2);
  });
  await test('real-worker-private-admin-capability-status-and-fixed-module', async () => {
    const foreign = { characterId: 'other', id: 'foreign', label: 'FOREIGN_ROLE_CANARY', verified: true };
    f.runtime.backups.push(foreign); f.runtime.policies.push(foreign); f.runtime.bindings = [foreign]; f.runtime.operations.push({ characterId: 'other', operationId: 'foreign', action: 'backup' });
    f.runtime.secret = 'RAW_SECRET_CANARY'; f.runtime.paths = '/Users/private/token'; f.runtime.approvedConversations[0].processorScopes[0].policy.privateText = 'HIDDEN_POLICY_CANARY';
    const s = await f.status(); assert.equal(s.backend, 'v2'); assert.equal(s.readiness, 'ready'); assert.equal(s.capabilities.activation, false); assert.equal(s.capabilities.correct, false); assert.equal(s.capabilities.organize, false); assert.equal(s.capabilities.migration, false); assert.equal(s.counts.sources, 1); assert.deepEqual(s.budget, {});
    assert.ok(!JSON.stringify(s).match(/FOREIGN_ROLE_CANARY|RAW_SECRET_CANARY|HIDDEN_POLICY_CANARY|\/Users\/|processingGrants|providerRouteId/));
    const script = await f.request('/panel-client'); assert.equal(script.status, 200); assert.match(script.text, /createMemoryV2Panel/);
  });
  await test('auth-origin-loopback-body-authority-and-prototype-actions-denied', async () => {
    bad((await f.request('/status', { cookie: '' })).value, 'MEMORY_ADMIN_REQUIRED');
    bad((await f.request('/status', { headers: { origin: 'https://evil.example' } })).value, 'MEMORY_ORIGIN_REJECTED');
    bad((await f.request('/status', { headers: { host: 'evil.example' } })).value, 'MEMORY_AUTH_REQUIRED');
    await f.resetController({ getAuthorization: () => Promise.resolve(f.authorization) }); bad((await f.request('/status')).value, 'MEMORY_ADMIN_REQUIRED');
    await f.resetController({ getAuthorization: () => true }); bad((await f.request('/status')).value, 'MEMORY_ADMIN_REQUIRED'); await f.resetController();
    const body = await f.body('backup');
    for (const action of ['constructor', '__proto__', 'applyMemoryAction', 'enable_shadow']) bad(await f.commit({ ...body, action }), 'MEMORY_ACTION_UNAVAILABLE');
    for (const key of ['admin', 'purpose', 'authorization', 'controlRevision']) bad(await f.commit({ ...body, [key]: true }), 'MEMORY_FIELD_FORBIDDEN');
    for (const key of ['admin', 'grantId', 'previewDigest']) bad(await f.commit({ ...body, payload: { ...body.payload, [key]: 'forged' } }), 'MEMORY_FIELD_FORBIDDEN');
    bad((await f.request('/manage', { raw: '{' })).value, 'MEMORY_JSON_INVALID');
    bad((await f.request('/manage', { raw: ' '.repeat(65537) })).value, 'MEMORY_REQUEST_TOO_LARGE');
    bad((await f.request('/status?admin=true')).value, 'MEMORY_FIELD_FORBIDDEN');
  });
  await test('actual-ui-configure-and-revoke-use-hidden-trusted-policy-CAS', async () => {
    const body = await f.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' });
    good(await f.preview(body)); const committed = good(await f.commit(body)); assert.equal(committed.operationId, body.operationId); assert.equal(f.notifications.length, 1);
    good(await f.commit(body)); assert.equal(f.notifications.length, 1);
    const revoke = await f.body('revoke_policy', { policyId: 'selected-policy' }); f.runtime.policies.push({ id: 'selected-policy', label: '已批准共享' }); good(await f.preview(revoke)); good(await f.commit(revoke));
    const forged = await f.body('configure_policy', { conversationId: 'unknown', processorScope: 'local' }); bad(await f.preview(forged), 'MEMORY_POLICY_REQUIRED');
    const stale = await f.body('backup', {}, randomUUID(), { expectedRevision: 0 }); bad(await f.preview(stale), 'MEMORY_REVISION_CONFLICT');
  });
  await test('durable-same-ID-binding-rejects-changed-action-payload-or-revision-after-restart', async () => {
    const x = await fixture('request-binding'); let dispatches = 0;
    const track = async () => { const original = x.service.applyMemoryAction; x.serviceOverride = { ...x.service, applyMemoryAction: async (...args) => { dispatches++; return original(...args); } }; await x.resetController(); };
    await track(); const original = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(original)); good(await x.commit(original)); assert.equal(dispatches, 1);
    await x.restartService(); await track(); good(await x.commit(original)); assert.equal(dispatches, 1);
    x.runtime.approvedConversations.push({ id: 'approved-two', label: '另一已批准会话', processorScopes: [{ id: 'local', label: '本机处理', policy: policy('second-policy') }] });
    const alternatePayload = { conversationId: 'approved-two', processorScope: 'local' }, revokePayload = { policyId: 'private' };
    const changed = [
      { ...original, action: 'revoke_policy', payload: { ...revokePayload, payloadDigest: digest(revokePayload) } },
      { ...original, payload: { ...alternatePayload, payloadDigest: digest(alternatePayload) } },
      { ...original, expectedRevision: original.expectedRevision + 1 },
    ];
    const outcomes = []; for (const body of changed) outcomes.push(await x.commit(body));
    assert.equal(dispatches, 1, 'changed requests must never dispatch again');
    for (const value of outcomes) { bad(value); assert.ok(['MEMORY_DIGEST_CONFLICT', 'MEMORY_OPERATION_CONFLICT'].includes(value.code), JSON.stringify(value)); }
    good((await x.request(`/receipt?operationId=${original.operationId}`)).value);
  });
  await test('binding-only-is-never-a-business-commit-and-unbound-legacy-replay-fails-closed', async () => {
    const x = await fixture('binding-only'); const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' });
    good(await x.service.host.admin.bindRequest(await x.admin(), { operationId: b.operationId, action: b.action, payloadDigest: digest({ conversationId: 'approved-one', processorScope: 'local' }), expectedRevision: b.expectedRevision, characterId: x.role.id, characterEpoch: x.role.epoch }));
    const pending = bad((await x.request(`/receipt?operationId=${b.operationId}`)).value, 'MEMORY_RECEIPT_UNRESOLVED'); assert.equal(pending.retry, 'query_receipt'); assert.notEqual(pending.sourceState, 'committed'); good(await x.preview(b)); good(await x.commit(b));
    const legacy = await x.body('revoke_policy', { policyId: 'private' }), ctx = await x.admin(); const result = good(await x.service.applyMemoryAction(ctx, { type: 'revoke_policy', policyId: 'private' }, ctx.controlRevision, legacy.operationId));
    const refused = bad(await x.commit(legacy), 'MEMORY_REQUEST_BINDING_REQUIRED'); assert.equal(refused.operationId, legacy.operationId); assert.equal(refused.controlRevision, result.controlRevision); assert.equal(refused.sourceState, 'committed'); assert.equal(refused.retry, 'query_receipt');
    assert.equal((await x.service.getMemoryReceipt(await x.admin(), legacy.operationId)).requestBinding, undefined); good((await x.request(`/receipt?operationId=${legacy.operationId}`)).value);
  });
  await test('genuine-core-admin-HTTP-preserves-original-preview-capability', async () => {
    const x = await fixture('genuine-admin'); await x.ingest('admin-hot', 'genuine hotword'); await x.ingest('admin-original', 'original reported statement');
    let previewContext, coreDigest, commits = 0;
    const runner = {
      preview: async ({ context, action, payload, expectedRevision }) => { previewContext = context; const r = await x.service.host.admin.preview(context, { action, payload }, expectedRevision); coreDigest = r.previewDigest; return r; },
      commit: async ({ context, action, payload, expectedRevision, operationId, previewDigest }) => { assert.equal(context, previewContext, 'actual core commit requires its original WeakMap preview capability'); commits++; return x.service.host.admin.commit(context, { action, payload, previewDigest }, expectedRevision, operationId); },
      receipt: ({ context, operationId }) => x.service.getMemoryReceipt(context, operationId),
    };
    await x.resetController({ hotManager: runner, corrector: runner, getRuntimeStatus: ({ context }) => x.service.host.admin.status(context), inspectMemory: async ({ context, recordId, recordRevision, query, limit }) => { const r = await x.service.host.admin.inspect(context, recordId ? { recordId, recordRevision } : { query, limit }); return { ...r, ...(recordId ? { record: r.records?.[0] } : {}) }; } });
    assert.equal((await x.status()).capabilities.removeHot, true); const hot = await x.body('remove_hot', { recordId: 'admin-hot', recordRevision: 1 }); good(await x.preview(hot));
    const fresh = await x.admin(); assert.notEqual(fresh, previewContext); bad(await x.service.host.admin.commit(fresh, { action: 'remove_hot', payload: { recordId: 'admin-hot', recordRevision: 1 }, previewDigest: coreDigest }, hot.expectedRevision, 'fresh-context-probe'), 'MEMORY_PREVIEW_UNTRUSTED');
    assert.equal(good(await x.commit(hot)).selectionState, 'removed_hot'); assert.equal(good(await x.service.host.admin.inspect(await x.admin(), { recordId: 'admin-hot', recordRevision: 1 })).records[0].hot, false); assert.ok(good((await x.request('/search?q=genuine')).value).records.some(r => r.id === 'admin-hot'));
    const correction = await x.body('correct', { recordId: 'admin-original', recordRevision: 1, content: 'corrected genuine reported statement' }); good(await x.preview(correction)); const retired = bad(await x.commit(correction), 'CHARACTER_EPOCH_STALE'); assert.equal(retired.operationState, 'completed_before_cancel'); assert.equal(retired.sourceState, 'committed'); assert.equal(retired.retry, 'query_receipt');
    const confirmed = good((await x.request(`/receipt?operationId=${correction.operationId}`)).value); assert.equal(confirmed.complete, true); assert.equal(confirmed.sourceState, 'committed'); assert.equal(commits, 2); assert.ok(good((await x.request('/search?q=corrected')).value).records.some(r => r.content === 'corrected genuine reported statement'));
    const originalBinding = good(await x.service.getMemoryReceipt(await x.admin(), correction.operationId)).requestBinding; assert.equal(originalBinding.characterEpoch, correction.characterEpoch); assert.notEqual(originalBinding.characterEpoch, x.role.epoch);
  });
  await test('create-person-strict-identity-adapter-transport-only', async () => {
    const x = await fixture('create-person'); const invalid = await x.body('create_person', { platform: 'other', accountId: '123' }); bad(await x.preview(invalid), 'MEMORY_REQUEST_INVALID');
    const body = await x.body('create_person', { platform: 'qq', accountId: '123' }); bad(await x.preview(body), 'MEMORY_ACTION_UNAVAILABLE'); bad(await x.preview({ ...body, payload: { ...body.payload, personId: 'arbitrary' } }), 'MEMORY_FIELD_FORBIDDEN');
    let stored, calls = 0, previewContext;
    const runner = { preview: async ({ context, action, payload }) => { previewContext = context; return preview(context, action, payload); }, receipt: async () => stored || { ok: true, operationState: 'not_found' }, commit: async ({ context, action, payload, operationId }) => { assert.equal(context, previewContext, 'commit must retain original preview capability'); assert.equal(context.purpose, 'admin'); assert.equal(action, 'create_person'); calls++; x.runtime.bindings = [{ id: 'anchor:new', platform: payload.platform, accountId: payload.accountId, personId: 'person:new' }]; stored = { ok: true, operationId, sourceState: 'committed', operationState: 'completed', retry: 'none' }; return stored; } };
    function preview(context, action, payload) { assert.equal(action, 'create_person'); assert.deepEqual(payload, { platform: 'qq', accountId: '123' }); return { ok: true, previewDigest: digest(payload), preview: {} }; }
    await x.resetController({ identityManager: runner }); assert.equal((await x.status()).capabilities.identity, true); good(await x.preview(body)); good(await x.commit(body)); assert.equal(calls, 1); assert.equal((await x.status()).bindings[0].personId, 'person:new');
  });
  await test('backup-real-core-preview-digest-private-cache-and-receipt', async () => {
    const body = await f.body('backup'); bad(await f.commit(body), 'MEMORY_PREVIEW_REQUIRED'); const first = good(await f.preview(body)); assert.ok(first.preview && !first.preview.previewDigest); assert.equal(first.payloadDigest, digest({}));
    assert.equal(first.expiresAt, f.now + 120000); assert.deepEqual(good(await f.preview(body)), first); const done = good(await f.commit(body)); assert.ok(done.backupId); f.runtime.backups.push({ id: done.backupId, label: '真实备份', verified: true }); f.savedBackup = done.backupId;
    good((await f.request(`/receipt?operationId=${body.operationId}`)).value);
    const unresolved = bad((await f.request('/receipt?operationId=missing-original')).value, 'MEMORY_RECEIPT_UNRESOLVED'); assert.equal(unresolved.retry, 'query_receipt'); assert.equal(unresolved.operationId, 'missing-original');
  });
  await test('payload-tamper-same-ID-conflict-expiry-revision-and-restart-cache', async () => {
    const body = await f.body('restore', { backupId: f.savedBackup }); good(await f.preview(body));
    bad(await f.commit({ ...body, payload: { backupId: 'invented', payloadDigest: body.payload.payloadDigest } }), 'MEMORY_PAYLOAD_MISMATCH');
    bad(await f.preview({ ...body, payload: { backupId: 'invented', payloadDigest: digest({ backupId: 'invented' }) } }), 'MEMORY_OPERATION_CONFLICT');
    f.now += 120001; bad(await f.commit(body), 'MEMORY_PREVIEW_REQUIRED');
    const pending = await f.body('backup'); good(await f.preview(pending)); await f.resetController(); bad(await f.commit(pending), 'MEMORY_PREVIEW_REQUIRED');
    const cas = await f.body('backup'); good(await f.preview(cas));
    const c = good(await f.service.host.captureAdminContext({ channel: 'local', conversationKey: 'local:m', sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', audiencePolicyId: 'local:m', providerRouteId: 'local:m', processingGrantId: 'local:m' }, f.authorization)).context;
    good(await f.service.applyMemoryAction(c, { type: 'configure_policy', policy: policy('concurrent') }, c.controlRevision, 'concurrent-control')); bad(await f.commit(cas), 'MEMORY_REVISION_CONFLICT');
  });
  await test('native-role-change-during-body-and-status-await-drops-content', async () => {
    const gate = deferred(), entered = deferred(); f.runtimeHook = async () => { entered.resolve(); await gate.promise; };
    const pending = f.request('/status'); await timed(entered.promise); f.role.id = 'other'; f.role.epoch++; gate.resolve(); bad((await pending).value, 'CHARACTER_EPOCH_STALE'); f.runtimeHook = null;
    f.role.id = 'app'; f.role.epoch++;
    const body = await f.body('backup');
    const incoming = deferred(); f.server.once('request', () => incoming.resolve());
    let partial;
    const answer = new Promise((resolve, reject) => { partial = http.request({ host: '127.0.0.1', port: f.port, path: `${BASE}/manage`, method: 'POST', headers: { cookie: 'fixture-admin', origin: `http://127.0.0.1:${f.port}`, 'content-type': 'application/json' } }, res => { let value = ''; res.on('data', c => value += c); res.on('end', () => resolve(JSON.parse(value))); }); partial.on('error', reject); partial.write('{'); });
    await timed(incoming.promise); f.role.epoch++; partial.end(JSON.stringify(body).slice(1));
    bad(await timed(answer), 'CHARACTER_EPOCH_STALE');
  });
  await test('inspection-adapter-transport-scope-and-unavailable-capabilities', async () => {
    const found = good((await f.request('/search?q=OWN_ADMIN_SOURCE&limit=20')).value); assert.equal(found.records[0].content, 'OWN_ADMIN_SOURCE');
    bad((await f.request('/search?limit=21')).value, 'MEMORY_QUERY_INVALID');
    f.reader = false; await f.resetController(); assert.equal((await f.status()).capabilities.purge, false); bad((await f.request('/search')).value, 'MEMORY_INSPECTION_UNAVAILABLE');
    for (const [action, payload] of [['correct', { recordId: 'own-root', recordRevision: 1, content: '修正' }], ['remove_hot', { recordId: 'own-root', recordRevision: 1 }], ['organize', { optIn: true, manual: true }], ['migrate', { snapshotId: 'approved-snapshot' }], ['bind_account', { platform: 'qq', accountId: 'qq:1', personId: 'person:1' }], ['unbind_account', { bindingId: 'binding:1' }]]) bad(await f.preview(await f.body(action, payload)), 'MEMORY_ACTION_UNAVAILABLE');
    f.reader = true; await f.resetController();
  });
  await test('real-suppress-selected-current-role-root', async () => {
    await f.ingest('suppress-root', 'SUPPRESS_CANARY'); const body = await f.body('suppress', { recordId: 'suppress-root', recordRevision: 1 }); good(await f.preview(body)); good(await f.commit(body));
    const ctx = good(await f.service.captureContext({ channel: 'local', conversationKey: 'app:one', sourceAccountKey: 'local:person', requesterAccountKey: 'local:person', audiencePolicyId: 'private', providerRouteId: 'local:test', processingGrantId: 'grant' })).context;
    assert.equal(good(await f.service.searchMemory(ctx, 'SUPPRESS_CANARY')).records.length, 0);
  });
  await test('real-delete-and-restore-contentfree-completed-before-cancel', async () => {
    const x = await fixture('lifecycle'); await x.ingest('delete-root');
    const b = await x.body('backup'); good(await x.preview(b)); const saved = good(await x.commit(b)); x.runtime.backups.push({ id: saved.backupId, verified: true });
    const d = await x.body('request_delete', { mode: 'delete_roots', recordId: 'delete-root', recordRevision: 1 }); const plan = good(await x.preview(d)); assert.deepEqual(plan.preview.roots, ['delete-root']);
    const deleted = bad(await x.commit(d), 'CHARACTER_EPOCH_STALE'); assert.equal(deleted.operationState, 'completed_before_cancel'); assert.equal(deleted.retry, 'query_receipt'); assert.equal(deleted.operationId, d.operationId); assert.ok(!JSON.stringify(deleted).includes('管理角色私有来源'));
    const receipt = good((await x.request(`/receipt?operationId=${d.operationId}`)).value); assert.equal(receipt.deletionPhase, 'access_revoked');
    const restore = await x.body('restore', { backupId: saved.backupId }); good(await x.preview(restore)); const restored = bad(await x.commit(restore), 'CHARACTER_EPOCH_STALE'); assert.equal(restored.operationState, 'completed_before_cancel'); assert.equal(good((await x.request(`/receipt?operationId=${restore.operationId}`)).value).complete, true);
  });
  await test('commit-unknown-preserves-ID-and-real-receipt-across-controller-worker-restart', async () => {
    const x = await fixture('lost-response');
    const originalApply = x.service.applyMemoryAction;
    let dispatches = 0; x.serviceOverride = { ...x.service, applyMemoryAction: async (...args) => { dispatches++; good(await originalApply(...args)); throw new Error('RAW_SECRET_TOKEN_STACK_PATH_/Users/hidden'); } }; await x.resetController();
    const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(b)); const result = bad(await x.commit(b)); assert.equal(result.retry, 'query_receipt'); assert.equal(result.operationId, b.operationId); assert.equal(result.operationState, 'unknown'); assert.ok(!JSON.stringify(result).includes('RAW_SECRET'));
    good(await x.commit(b)); assert.equal(dispatches, 1);
    await x.restartService(); const receipt = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(receipt.operationId, b.operationId); good(await x.commit(b)); assert.equal(dispatches, 1);
  });
  await test('worker-crash-is-visible-and-does-not-claim-zero-or-saved', async () => {
    const x = await fixture('dead-worker'); await x.worker.terminate(); const result = bad((await x.request('/status')).value); assert.match(result.code, /^MEMORY_WORKER_/); assert.ok(!Object.hasOwn(result, 'budget'));
  });
  await test('optional-runner-transport-only-optin-digest-and-unknown-receipt', async () => {
    const receipts = new Map(); let commits = 0, args;
    const runner = { preview: async input => { args = input; return { ok: true, previewDigest: digest(input.payload), preview: { ignored: 'PRIVATE_PATH_/Users/hidden' } }; }, commit: async input => { commits++; assert.equal(input.context.purpose, 'admin'); assert.equal(input.payload.optIn, true); const value = { ok: false, code: 'MEMORY_COMMIT_UNKNOWN', operationId: input.operationId, sourceState: 'commit_unknown', operationState: 'unknown', selectionState: 'not_selected', indexState: 'not_applicable', retry: 'query_receipt' }; receipts.set(input.operationId, value); return value; }, receipt: async ({ operationId }) => receipts.get(operationId) || { ok: true, operationState: 'not_found' } };
    await f.resetController({ organizer: runner }); assert.equal((await f.status()).capabilities.organize, true);
    const b = await f.body('organize', { optIn: true, manual: true }); good(await f.preview(b)); assert.equal(args.context.purpose, 'admin'); const value = bad(await f.commit(b)); assert.equal(value.state, 'commit_unknown'); assert.equal(value.sourceState, 'commit_unknown'); bad(await f.commit(b)); assert.equal(commits, 1); bad((await f.request(`/receipt?operationId=${b.operationId}`)).value);
    bad(await f.preview(await f.body('organize', { optIn: false, manual: true })), 'MEMORY_ORGANIZER_OPT_IN_REQUIRED');
    // This injected runner proves transport only; production runner must mint fresh organize purpose before any model call.
    await f.resetController();
  });
  await test('denied-cross-role-receipt-remains-original-ID-query-only', async () => {
    const x = await fixture('cross-role'); const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(b)); good(await x.commit(b));
    x.role.id = 'other'; x.role.epoch++;
    const denied = bad((await x.request(`/receipt?operationId=${b.operationId}`)).value, 'MEMORY_ADMIN_REQUIRED'); assert.equal(denied.operationId, b.operationId); assert.equal(denied.operationState, 'unknown'); assert.equal(denied.retry, 'query_receipt'); assert.ok(!JSON.stringify(denied).includes('approved-one'));
    x.role.id = 'app'; x.role.epoch++; good((await x.request(`/receipt?operationId=${b.operationId}`)).value);
  });
  await test('real-core-after-commit-fault-recovers-durable-original-receipt', async () => {
    const x = await fixture('core-fault');
    const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }, 'uncertain-control');
    good(await x.service.host.admin.bindRequest(await x.admin(), { operationId: b.operationId, action: b.action, payloadDigest: digest({ conversationId: 'approved-one', processorScope: 'local' }), expectedRevision: b.expectedRevision, characterId: b.characterId, characterEpoch: b.characterEpoch }));
    x.setFaults({ operationId: b.operationId, controlCommitAfter: 1 }); await x.restartService(); good(await x.preview(b)); const result = bad(await x.commit(b), 'MEMORY_COMMIT_UNCERTAIN'); assert.equal(result.retry, 'query_receipt'); assert.equal(result.sourceState, 'commit_unknown'); assert.equal(result.operationId, b.operationId);
    const waiting = bad((await x.request(`/receipt?operationId=${b.operationId}`)).value, 'MEMORY_CONTROL_BLOCKED'); assert.equal(waiting.operationId, b.operationId); assert.equal(waiting.retry, 'query_receipt');
    await x.restartService(); const receipt = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(receipt.operationId, b.operationId); assert.equal(receipt.applied, true);
  });
  await test('same-ID-inflight-optional-commit-never-dispatches-twice', async () => {
    const x = await fixture('concurrent'); const entered = deferred(), release = deferred(); let count = 0, receipt;
    const runner = { preview: async ({ payload }) => ({ ok: true, previewDigest: digest(payload), preview: {} }), receipt: async () => receipt || { ok: true, operationState: 'not_found' }, commit: async ({ operationId }) => { count++; entered.resolve(); await release.promise; receipt = { ok: true, operationId, sourceState: 'committed', operationState: 'completed', retry: 'none' }; return receipt; } };
    await x.resetController({ organizer: runner }); const b = await x.body('organize', { optIn: true, manual: true }); good(await x.preview(b)); const first = x.commit(b); await timed(entered.promise);
    const second = bad(await x.commit(b), 'MEMORY_OPERATION_BUSY'); assert.equal(second.retry, 'query_receipt'); assert.equal(second.operationId, b.operationId); assert.equal(count, 1); release.resolve(); good(await first); good((await x.request(`/receipt?operationId=${b.operationId}`)).value);
  });
  await test('reader-role-revision-scope-rejects-foreign-and-stale-selection', async () => {
    await f.resetController({ inspectMemory: async () => ({ ok: true, records: [{ id: 'foreign', revision: 1, characterId: 'other', content: 'FOREIGN_READER_CANARY' }] }) }); const result = bad((await f.request('/search')).value, 'MEMORY_INSPECTION_SCOPE_INVALID'); assert.ok(!JSON.stringify(result).includes('FOREIGN_READER_CANARY'));
    await f.resetController(); bad(await f.preview(await f.body('suppress', { recordId: 'own-root', recordRevision: 999 })), 'MEMORY_RECORD_STALE');
  });
  await test('lost-HTTP-body-and-server-restart-query-original-ID-without-resend', async () => {
    const x = await fixture('lost-http'); const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(b)); x.dropNextResponse = true;
    await assert.rejects(x.commit(b)); assert.equal(x.notifications.length, 1); await x.resetController(); await x.restartHttp(); const r = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(r.operationId, b.operationId); good(await x.commit(b)); assert.equal(x.notifications.length, 1);
  });
  await test('postcommit-notification-role-change-keeps-confirmed-phases', async () => {
    const x = await fixture('callback-epoch'); await x.resetController({ onControlChanged: () => { x.role.epoch++; } }); const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(b)); const r = bad(await x.commit(b), 'CHARACTER_EPOCH_STALE'); assert.equal(r.operationState, 'completed_before_cancel'); assert.equal(r.retry, 'query_receipt'); assert.equal(r.sourceState, 'committed'); assert.ok(Number.isInteger(r.controlRevision));
  });
  await test('committed-controls-with-unapplied-view-remain-query-only-until-reopen', async () => {
    const x = await fixture('unapplied-control', { faults: { applyControlsAtRevision: 3 } }); const b = await x.body('configure_policy', { conversationId: 'approved-one', processorScope: 'local' }); good(await x.preview(b)); const r = bad(await x.commit(b), 'MEMORY_CONTROL_BLOCKED'); assert.equal(r.sourceState, 'committed'); assert.equal(r.applied, false); assert.equal(r.retry, 'query_receipt');
    const pending = (await x.request(`/receipt?operationId=${b.operationId}`)).value; assert.equal(pending.operationId, b.operationId); assert.equal(pending.retry, 'query_receipt'); assert.equal(pending.applied, false); x.clearFaults(); await x.restartService(); const ready = good((await x.request(`/receipt?operationId=${b.operationId}`)).value); assert.equal(ready.applied, true); assert.equal(ready.retry, 'none');
  });
  await test('missing-production-retirement-is-visible-committed-not-completed', async () => {
    const x = await fixture('retirement-pending', { retireForLifecycle: undefined }); await x.ingest('pending-root'); const b = await x.body('request_delete', { mode: 'delete_roots', recordId: 'pending-root', recordRevision: 1 }); good(await x.preview(b)); const r = bad(await x.commit(b), 'MEMORY_RETIREMENT_REQUIRED'); assert.equal(r.complete, false); assert.equal(r.sourceState, 'committed'); assert.equal(r.retry, 'query_receipt'); assert.equal(r.operationId, b.operationId); const progress = (await x.request(`/receipt?operationId=${b.operationId}`)).value; assert.equal(progress.complete, false); assert.equal(progress.retry, 'query_receipt');
  });
  await test('concurrent-preview-same-ID-cannot-replace-authorized-payload', async () => {
    const x = await fixture('preview-race'); const entered = deferred(), release = deferred();
    const runner = { preview: async ({ payload }) => { entered.resolve(); await release.promise; return { ok: true, previewDigest: digest(payload), preview: {} }; }, receipt: async () => ({ ok: true, operationState: 'not_found' }), commit: async () => { throw new Error('must not commit'); } };
    await x.resetController({ organizer: runner, migrator: runner }); const b = await x.body('organize', { optIn: true, manual: true }); const competing = await x.body('migrate', { snapshotId: 'another-snapshot' }, b.operationId); const pending = x.preview(b); await timed(entered.promise); bad(await x.preview(competing), 'MEMORY_OPERATION_CONFLICT'); bad(await x.preview(b), 'MEMORY_PREVIEW_BUSY'); release.resolve(); good(await pending);
  });
  await test('migration-preview-exposes-safe-counts-and-quarantine-while-keeping-activation-false', async () => {
    const x = await fixture('migrator-preview');
    const migrator = {
      preview: async ({ payload }) => ({
        ok: true,
        previewDigest: digest(payload),
        preview: {
          manifest: { phase: 'plan-only', importReady: false },
          counts: { sources: 2, records: 10, candidates: 8, quarantined: 2, invalidRows: 0, partialTails: 0, protectedRecords: 1, parts: 8 },
          candidates: 8,
          quarantined: 2,
          conflicts: 0,
          highWaterBytes: 4096,
        },
      }),
      receipt: async () => ({ ok: true, operationState: 'not_found' }),
      commit: async () => ({ ok: false, code: 'MIGRATION_CUTOVER_REQUIRED' }),
    };
    await x.resetController({ migrator });
    const b = await x.body('migrate', { snapshotId: 'approved-snapshot' });
    const res = good(await x.preview(b));
    const preview = res.preview;
    assert.equal(preview.action, 'migrate');
    assert.deepEqual(preview.counts, { sources: 2, records: 10, candidates: 8, quarantined: 2, invalidRows: 0, partialTails: 0, protectedRecords: 1, parts: 8 });
    assert.equal(preview.candidates, 8);
    assert.equal(preview.quarantined, 2);
    assert.equal(preview.highWaterBytes, 4096);
    assert.equal(preview.phase, 'plan-only');
    assert.equal(preview.importReady, false);
    const status = (await x.request('/status')).value;
    assert.equal(status.capabilities.activation, false);
    assert.equal(status.capabilities.migration, true);
  });
  await test('dispose-closes-admission-without-claiming-to-retire-production-sessions', async () => {
    const x = await fixture('dispose'); const b = await x.body('backup'); good(await x.preview(b)); x.controller.dispose(); bad((await x.request('/status')).value, 'MEMORY_AUTH_REQUIRED'); await x.resetController(); bad(await x.commit(b), 'MEMORY_PREVIEW_REQUIRED');
  });
  assert.ok(checks.length, 'requested test case was not found');
  console.log(JSON.stringify({ ok: true, checks, fixture: root }));
} finally { await Promise.all(fixtures.map(f => f.close())); }
