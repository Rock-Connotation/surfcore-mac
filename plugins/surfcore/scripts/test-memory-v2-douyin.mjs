import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const root = path.resolve('_backups/memory-v2-douyin', `fixtures-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
process.env.DSH_HOME = path.join(root, 'dsh');
const chars = await import('../../../src/character-persona.js');
const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
const routeId = deriveMemoryProviderRouteId({ provider: 'surfcore-companion-hy3', model: 'workbuddy/hy3' }).providerRouteId;
const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');
const { createCompanionMemory } = await import('../lib/douyin-companion-memory.mjs');
const { createCompanionController } = await import('../lib/douyin-companion-controller.mjs');
const { createDouyinCompanion } = await import('../lib/douyin-companion.mjs');
const { createCompanionModel, COMPANION_ROUTE } = await import('../lib/douyin-companion-model.mjs');
const { createDouyinCompanionStore } = await import('../lib/douyin-companion-ledger.mjs');
const { createTokenBudgetService } = await import('../lib/token-budget.js');
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value?.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code); assert.ok(value.error && value.hint); return value; };
const image = { atMs: 500, dataUrl: 'data:image/jpeg;base64,YWJj' };
const output = JSON.stringify({ feeling: 'like', reason: '旁白清楚，取样画面有小鱼。', summary: '小鱼在海洋中缓慢游动。', draft: '这段海洋片段很轻松。' });
const observation = id => ({ ok: true, id, url: `https://www.douyin.com/video/${id}`, title: '海洋小鱼', source: 'homepage-recommendation', durationMs: 1000,
  observedAt: '2026-11-09T03:00:00.000Z', transcript: { text: `海洋小鱼${id}。${'完整原文。'.repeat(160)} token=PRIVATE_SOURCE_TOKEN`, speechState: 'speech',
    coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: 1000 }], processedRanges: [{ startMs: 0, endMs: 400 }, { startMs: 600, endMs: 1000 }], missingRanges: [{ startMs: 400, endMs: 600 }] } },
  frames: [image], visualCoverage: 'sparse', warnings: ['middle audio gap'] });
const engineDirectories = new WeakMap();
let count = 0;
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }
function current(role) {
  const dir = path.join(chars.CHARACTERS_DIR, role.id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ version: 1, ...role }));
  fs.writeFileSync(path.join(dir, 'persona.md'), '这是角色核心人格。');
  fs.writeFileSync(path.join(dir, 'persona.daily.md'), 'LEGACY_CANARY_DAILY');
  const paths = chars.characterPaths(role.id); fs.mkdirSync(path.dirname(paths.lifeState), { recursive: true });
  fs.writeFileSync(paths.lifeState, JSON.stringify({ version: 1, characterId: role.id, currentFocus: 'LEGACY_CANARY_LIFE' }));
  fs.writeFileSync(paths.purposeState, JSON.stringify({ purpose: 'LEGACY_CANARY_PURPOSE' }));
}
async function fixture(name, run) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const initialRole = `role-${name}`;
  let role = { id: initialRole, epoch: 1 }; current(role);
  let clock = Date.now();
  const auth = Symbol('settings'), stateDir = path.join(dir, 'state');
  const service = createMemoryService({ stateDir, now: () => clock, charactersDir: chars.CHARACTERS_DIR, getCharacter: () => role, authorizeManagement: input => input === auth });
  good(await service.initialize());
  const base = { channel: 'douyin', conversationKey: 'douyin:homepage-recommendation', sourceAccountKey: 'douyin:login:one', requesterAccountKey: 'douyin:owner:one', providerRouteId: routeId, purpose: 'conversation', audiencePolicyId: `private-${name}`, processingGrantId: 'grant' };
  let actionNumber = 0;
  const action = async value => { const admin = good(await service.host.captureAdminContext(base, auth)).context; return service.applyMemoryAction(admin, value, admin.controlRevision, `${name}-control-${++actionNumber}`); };
  good(await action({ type: 'configure_policy', policy: { policyId: base.audiencePolicyId, approved: true, audiences: [[base.channel, base.conversationKey, base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: base.providerRouteId }] } }));
  good(await action({ type: 'enable_shadow', enabled: true }));
  const host = createMemoryHost({ memoryService: service, now: () => clock, getCharacter: () => role, handleTtlMs: 300000, resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: base.sourceAccountKey, requesterAccountKey: base.requesterAccountKey, providerRouteId: base.providerRouteId }) });
  const adapter = host.createAdapter({ channel: 'douyin', principal: {}, canBindInput: true });
  let retirements = 0, queryCount = 0;
  const wrapped = { ...adapter, prepare: async (...args) => { queryCount++; return adapter.prepare(...args); } };
  const memoryV2 = { adapter: wrapped, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: async () => { await Promise.resolve(); host.retireAll(); retirements++; return { ok: true, retired: true }; } };
  const memory = createCompanionMemory({ stateDir, getCharacter: () => role, memoryV2 });
  const context = { characterId: role.id, characterEpoch: role.epoch };
  const events = () => { const db = new DatabaseSync(path.join(chars.CHARACTERS_DIR, initialRole, 'memory', 'memory-v2.sqlite'), { readOnly: true }); try { return db.prepare('SELECT eventId,payload FROM events').all().map(row => ({ id: row.eventId, ...JSON.parse(row.payload) })); } finally { db.close(); } };
  let api;
  const engine = (options = {}) => { api = createDouyinCompanion({ stateDir, getCharacter: () => role, memoryV2, readiness: async () => ({ ok: true }),
    readFeed: async () => ({ ok: true, items: ['123', '456'].map(id => ({ id, url: `https://www.douyin.com/video/${id}`, title: '海洋小鱼', durationMs: 1000 })) }),
    perceive: async item => observation(item.id), buildContext: () => { throw Error('legacy context called'); }, recordMemory: () => { throw Error('legacy memory called'); },
    getModelRequest: ({ jobId, activityId, characterId, characterEpoch, providerRouteId, model }) => ({ requestId: `${activityId}:model`, category: 'other', purpose: 'organize', jobId, role: characterId, epoch: characterEpoch, providerRouteId, model, estimatedTokens: 100 }),
    modelCall: async args => { await args.beforeSend(); return { text: output, finishReason: 'stop' }; }, ...options }); engineDirectories.set(api, stateDir); return api; };
  try { await run({ memory, memoryV2, adapter, host, service, base, action, context, engine, events, stateDir, role: () => role,
    advance: amount => { clock += amount; }, queryCount: () => queryCount, retirements: () => retirements, changeRole: () => { role = { id: 'beta', epoch: 2 }; current(role); } }); }
  finally { await api?.dispose(); host.close(); await service.close(); }
}
async function finish(api, context, jobId) {
  const store = createDouyinCompanionStore(engineDirectories.get(api), () => new Date().toISOString());
  for (let i = 0; i < 1500; i++) { const job = store.readLedger().jobs[jobId]; if (job && !['queued', 'running'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('engine did not settle');
}
async function controllerResponse(controller, context, action) {
  const req = new EventEmitter(); req.method = action ? 'POST' : 'GET'; req.headers = { host: '127.0.0.1:3100', 'content-type': 'application/json' };
  let status, bytes;
  const res = { writeHead: code => { status = code; }, end: body => { bytes = body; } };
  const pending = controller.handle(req, res, new URL('http://127.0.0.1:3100/dsh-surfcore/api/douyin/companion'));
  if (action) queueMicrotask(() => { req.emit('data', Buffer.from(JSON.stringify({ ...context, action, enabled: false }))); req.emit('end'); });
  assert.equal(await pending, true); return { status, body: JSON.parse(bytes), text: bytes };
}
const captureObservation = async f => {
  const session = await f.memory.capture(f.context, f.base.conversationKey);
  const perceived = observation('123');
  const source = await f.memory.observe(session, { jobId: 'stable-job', activityId: 'stable-activity', entry: { id: '123', title: perceived.title, url: perceived.url }, perceived, images: [image] });
  return { session, source };
};
await test('real worker source before reflection, full original coverage, idempotent source receipts and no legacy context', () => fixture('source', async f => {
  const first = await captureObservation(f);
  assert.equal(first.source.receipt.sourceState, 'committed'); assert.equal(first.source.refs.length, 2);
  const rows = f.events(); assert.equal(rows.length, 2);
  const author = rows.find(row => row.attribution === 'quote'); assert.equal(author.speaker, 'external-author:unknown'); assert.equal(author.certainty, 'reported');
  assert.ok(author.content.length > 350); assert.doesNotMatch(author.content, /PRIVATE_SOURCE_TOKEN/);
  assert.deepEqual(author.coverage.transcript, observation('123').transcript.coverage);
  const processing = rows.find(row => row.attribution === 'action'); assert.equal(processing.subject, f.context.characterId); assert.equal(processing.certainty, 'observed');
  const repeated = await captureObservation(f); assert.deepEqual(repeated.source.refs, first.source.refs); assert.equal(f.events().length, 2);
  const built = await f.memory.prepareStep(first.session, '海洋小鱼123'); assert.ok(built.preparedHandle); assert.doesNotMatch(built.text, /LEGACY_CANARY/);
  await f.memory.bindStep(first.session, { system: 'actual system', prompt: 'actual prompt 海洋小鱼', images: [image] });
  const saved = await f.memory.reflect(first.session, { summary: '海洋小鱼', reason: '完整理由'.repeat(130), coverage: observation('123').transcript.coverage });
  assert.equal(saved.receipt.sourceState, 'committed'); const reflection = f.events().find(row => row.attribution === 'reflection');
  assert.ok(reflection.content.length > 350); assert.ok(reflection.inputManifest.length >= 3);
  f.memory.release(first.session); f.memory.release(repeated.session);
}));
await test('actual engine prepares independently for two sequential model steps and exposes canonical refs', () => fixture('engine', async f => {
  let models = 0;
  const api = f.engine({ modelCall: async args => { models++; assert.ok(f.events().filter(row => row.attribution === 'quote').length >= models); assert.doesNotMatch(args.prompt, /LEGACY_CANARY/); assert.ok(args.requestMetadata.requestId); await args.beforeSend(); return { text: output, finishReason: 'stop' }; } });
  const job = await finish(api, f.context, good(await api.start(f.context)).jobId);
  assert.equal(models, 2, JSON.stringify(job)); assert.equal(f.queryCount(), 2); assert.equal(job.memoryV2Refs.length, 8);
  assert.equal(job.memoryV2Receipt.sourceState, 'committed'); assert.ok(job.items.every(item => item.memorySaved));
  for (const ref of job.memoryV2Refs) { assert.equal(ref.type, 'event'); assert.equal(ref.revision, 1); assert.match(ref.payloadDigest, /^[a-f0-9]{64}$/); }
  await api.dispose();
  const store = createDouyinCompanionStore(f.stateDir, () => new Date().toISOString());
  const ledger = store.readLedger(); store.writeLedger(ledger);
  const persisted = store.readLedger().jobs[job.jobId];
  assert.deepEqual(persisted.memoryV2Refs, job.memoryV2Refs); assert.equal(persisted.memoryV2Receipts.length, 6);
  assert.equal(persisted.items[0].memoryV2Receipts.length, 3);
  for (const receipt of persisted.memoryV2Receipts) { assert.equal(receipt.ok, true); assert.equal(receipt.operationState, 'completed'); assert.ok(receipt.commitSequence >= 1); }
  for (const corrupt of [value => { value.memoryV2Refs[0].payloadDigest = 'bad'; }, value => { value.memoryV2Receipts[0].phase = 'admin'; }, value => { value.memoryV2Refs[0].admin = true; }, value => { delete value.memoryV2Receipts[0].commitSequence; }, value => { value.memoryV2Receipts[0].eventIds[0] = 'forged'; }]) {
    const invalid = structuredClone(ledger); corrupt(invalid.jobs[job.jobId]);
    assert.throws(() => store.writeLedger(invalid), error => error.code === 'DOUYIN_STATE_INVALID');
  }

}));
await test('actual engine keeps source committed when model throws and awaits retirement proof', () => fixture('throws', async f => {
  const api = f.engine({ modelCall: async () => { throw Object.assign(Error('fake model failure'), { code: 'COMPANION_MODEL_FAILED', hint: 'inspect model' }); } });
  const job = await finish(api, f.context, good(await api.start(f.context)).jobId);
  assert.equal(job.code, 'COMPANION_MODEL_FAILED'); assert.equal(f.retirements(), 1); assert.equal(job.memoryV2Receipt.sourceState, 'committed');
  assert.equal(f.events().filter(row => row.attribution === 'quote').length, 1); assert.equal(f.events().filter(row => row.attribution === 'reflection').length, 0);
}));
await test('engine refuses unconfirmed retirement proof and keeps source receipt', () => fixture('unretired', async f => {
  f.memoryV2.onBlocked = async () => ({ ok: true });
  const api = f.engine({ modelCall: async () => { throw Error('fake failure'); } });
  const job = await finish(api, f.context, good(await api.start(f.context)).jobId);
  assert.equal(job.code, 'MEMORY_RETIREMENT_UNCONFIRMED'); assert.ok(job.error && job.hint);
  assert.equal(job.memoryV2Receipts[0].sourceState, 'committed'); assert.ok(job.items.every(item => !item.feeling));
}));
await test('late engine model completion under a new role cannot adopt old output', () => fixture('late-engine-role', async f => {
  const api = f.engine({ modelCall: async args => { await args.beforeSend(); f.changeRole(); return { text: output, finishReason: 'stop' }; } });
  const started = good(await api.start(f.context)), id = started.jobId; api.releaseResponse(started);
  const store = createDouyinCompanionStore(f.stateDir, () => new Date().toISOString());
  let job;
  for (let i = 0; i < 1500; i++) {
    job = store.readLedger().jobs[id];
    if (job && !['queued', 'running'].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(job.code, 'DOUYIN_STALE_CHARACTER'); assert.equal(f.retirements(), 1);
  assert.ok(job.items.every(item => !item.feeling && !item.memorySaved));
  assert.equal(f.events().filter(row => row.attribution === 'reflection').length, 0);
}));
for (const stage of ['query', 'pre-model', 'during-generation', 'pre-save']) await test(`real revocation ${stage} discards adoption and retires`, () => fixture(`revoke-${stage}`, async f => {
  const revoke = async () => good(await f.action({ type: 'revoke_policy', policyId: f.base.audiencePolicyId }));
  if (stage === 'query') { const original = f.memoryV2.adapter.prepare; f.memoryV2.adapter.prepare = async (...args) => { const result = await original(...args); await revoke(); return result; }; }
  if (stage === 'pre-model') { const original = f.memoryV2.adapter.bindActualInput; let calls = 0; f.memoryV2.adapter.bindActualInput = async (...args) => { const result = await original(...args); if (++calls === 2) await revoke(); return result; }; }
  let models = 0;
  const api = f.engine({ modelCall: async args => { models++; await args.beforeSend(); await revoke(); if (stage === 'during-generation') await args.beforeSend({ phase: 'completion' }); return { text: output, finishReason: 'stop' }; } });
  const job = await finish(api, f.context, good(await api.start(f.context)).jobId);
  assert.ok(job.code && job.error && job.hint, JSON.stringify(job)); assert.equal(f.retirements(), 1); assert.ok(job.items.every(item => !item.memorySaved && !item.feeling));
  assert.equal(f.events().filter(row => row.attribution === 'reflection').length, 0); assert.equal(models, ['query', 'pre-model'].includes(stage) ? 0 : 1);
}));
await test('worker unavailable and malformed routing never import legacy canaries', () => fixture('worker', async f => {
  const source = await captureObservation(f); await f.service.close();
  await assert.rejects(f.memory.prepareStep(source.session, '海洋小鱼'), error => !!error.code && !!error.hint);
  f.memoryV2.getRouting = () => ({ ok: false, code: 'MEMORY_ROUTING_INVALID', error: 'broken routing', hint: 'repair Host route' });
  bad(f.memory.buildContext(f.context), 'MEMORY_ROUTING_INVALID'); bad(await f.memory.recordMemory(f.context, {}), 'MEMORY_ROUTING_INVALID');
}));
await test('late source callback after role change cannot adopt or prepare under new role', () => fixture('role', async f => {
  const original = f.memoryV2.adapter.capture; f.memoryV2.adapter.capture = async (...args) => { const result = await original(...args); f.changeRole(); return result; };
  await assert.rejects(f.memory.capture(f.context, f.base.conversationKey), error => error.code === 'COMPANION_CHARACTER_STALE');
  assert.equal(f.queryCount(), 0);
}));
await test('full actual manifest private A plus public B cannot be laundered through B-only references', () => fixture('manifest', async f => {
  const publicPolicy = { policyId: 'public-b', approved: true, audiences: [['douyin', f.base.conversationKey, f.base.requesterAccountKey], ['douyin', 'douyin:public-thread', f.base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: f.base.providerRouteId }] };
  good(await f.action({ type: 'configure_policy', policy: publicPolicy }));
  const privateContext = good(await f.service.captureContext(f.base)).context;
  const publicFacts = { ...f.base, conversationKey: 'douyin:public-thread', audiencePolicyId: 'public-b' };
  const publicContext = good(await f.service.captureContext(publicFacts)).context;
  const raw = id => ({ eventId: id, operationId: id, sourceKey: id, producerId: 'fixture', segmentId: id, producerSeq: 1, content: `海洋小鱼 ${id}` });
  const privateA = good(await f.service.ingestEvents(privateContext, [raw('private-a')], 'source-a')).eventRefs;
  const publicB = good(await f.service.ingestEvents(publicContext, [raw('public-b')], 'source-b')).eventRefs;
  good(await f.service.host.bindInputManifest(privateContext, [...privateA, ...publicB]));
  good(await f.service.host.bindInputManifest(privateContext, publicB));
  const derived = good(await f.service.ingestEvents(privateContext, [{ ...raw('derived'), evidenceRefs: publicB }], 'derive')).eventRefs;
  assert.deepEqual(f.events().find(row => row.eventId === 'derived').inputManifest.map(ref => ref.id).sort(), ['private-a', 'public-b']);
  good(await f.service.host.bindInputManifest(publicContext, publicB));
  bad(await f.service.host.bindInputManifest(publicContext, derived), 'MEMORY_EVIDENCE_DENIED');
}));
await test('expired prepared packet permits current-control adoption but cannot authorize a new model send', () => fixture('ttl', async f => {
  const { session } = await captureObservation(f); await f.memory.prepareStep(session, '海洋小鱼');
  await f.memory.bindStep(session, { system: 'system', prompt: 'prompt', images: [image] });
  f.advance(31000); good(await f.memory.validate(session));
  good(await f.memory.reflect(session, { summary: '海洋小鱼', reason: '已完成观察', coverage: {} }));
  await assert.rejects(f.memory.validate(session, true), error => !!error.code && !!error.hint);
}));
for (const control of ['policy', 'root', 'worker']) await test(`completed engine/controller read rejects ${control} revocation without derived content or IDs`, () => fixture(`response-${control}`, async f => {
  const canary = 'PRIVATE_DIARY_CANARY';
  const api = f.engine({ modelCall: async args => { await args.beforeSend(); return { text: output.replace('旁白清楚', canary), finishReason: 'stop' }; } });
  const started = good(await api.start(f.context)); api.releaseResponse(started);
  const job = await finish(api, f.context, started.jobId);
  const retained = good(await api.status(f.context)); assert.match(JSON.stringify(retained), new RegExp(canary)); good(await api.validateResponse(f.context, retained));
  assert.equal(retained.recentJobs[0].items.length, 2);
  const controller = createCompanionController({ engine: api, getCharacter: f.role, readiness: async () => ({ ok: true }) });
  const approved = await controllerResponse(controller, f.context); assert.equal(approved.status, 200); assert.match(approved.text, new RegExp(canary));
  if (control === 'policy') good(await f.action({ type: 'revoke_policy', policyId: f.base.audiencePolicyId }));
  else if (control === 'root') good(await f.action({ type: 'suppress', roots: [job.items[1].memoryV2Receipts[0].eventIds[0]] }));
  else await f.service.close();
  bad(await api.validateResponse(f.context, retained)); api.releaseResponse(retained);
  const status = await api.status(f.context); bad(status); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_DIARY_CANARY|douyin-.*123|\/video\/123|\/video\/456/);
  const denied = await controllerResponse(controller, f.context); assert.equal(denied.status, 409); bad(denied.body); assert.doesNotMatch(denied.text, /PRIVATE_DIARY_CANARY|\/video\/123|\/video\/456/);
}));
await test('controller revalidates retained exact view after asynchronous readiness and releases every lease', () => fixture('response-readiness', async f => {
  const api = f.engine({ modelCall: async args => { await args.beforeSend(); return { text: output.replace('旁白清楚', 'PRIVATE_DIARY_CANARY'), finishReason: 'stop' }; } });
  const started = good(await api.start(f.context)); api.releaseResponse(started); await finish(api, f.context, started.jobId);
  let released = 0; const facade = { ...api, releaseResponse: value => { released++; api.releaseResponse(value); } };
  const controller = createCompanionController({ engine: facade, getCharacter: f.role, readiness: async () => { good(await f.action({ type: 'revoke_policy', policyId: f.base.audiencePolicyId })); return { ok: true }; } });
  const result = await controllerResponse(controller, f.context); assert.equal(result.status, 409); bad(result.body); assert.equal(released, 1); assert.doesNotMatch(result.text, /PRIVATE_DIARY_CANARY|\/video\/123/);
}));
await test('V2 quarantines legacy unproven rows and exact-response tampering while allowing expired preparation reads', () => fixture('response-quarantine', async f => {
  const api = f.engine(); const started = good(await api.start(f.context)); api.releaseResponse(started); await finish(api, f.context, started.jobId);
  f.advance(31000); const value = good(await api.status(f.context)); good(await api.validateResponse(f.context, value));
  const clone = structuredClone(value); bad(await api.validateResponse(f.context, clone), 'MEMORY_RESPONSE_UNTRUSTED');
  value.recentJobs[0].items[0].reason = 'PRIVATE_TAMPER'; bad(await api.validateResponse(f.context, value), 'MEMORY_RESPONSE_UNTRUSTED'); api.releaseResponse(value);
  await api.dispose(); const store = createDouyinCompanionStore(f.stateDir, () => new Date().toISOString()), ledger = store.readLedger();
  for (const row of [ledger.jobs[started.jobId], ...ledger.jobs[started.jobId].items]) { delete row.memoryV2Refs; delete row.memoryV2Receipts; delete row.memoryV2Receipt; }
  store.writeLedger(ledger); const fresh = f.engine(); const hidden = good(await fresh.status(f.context));
  assert.deepEqual(hidden.recentJobs, []); assert.equal(hidden.activeJob, null); assert.doesNotMatch(JSON.stringify(hidden), /\/video\/123|\/video\/456/); fresh.releaseResponse(hidden);
}));
await test('production POST validates exact engine lease before JSON and releases on denial', () => fixture('response-post', async f => {
  const api = f.engine(); let released = 0;
  const facade = { ...api, start: async (...args) => { const value = await api.start(...args); good(await f.action({ type: 'revoke_policy', policyId: f.base.audiencePolicyId })); return value; }, releaseResponse: value => { released++; api.releaseResponse(value); } };
  const controller = createCompanionController({ engine: facade, getCharacter: f.role, readiness: async () => ({ ok: true }) });
  const result = await controllerResponse(controller, f.context, 'start'); assert.equal(result.status, 409); bad(result.body); assert.equal(released, 1); assert.doesNotMatch(result.text, /\/video\/123|\/video\/456/);
}));
await test('fresh factory is V2 by default while V2 requires prepared input', async () => {
  current({ id: 'alpha', epoch: 1 }); const dir = path.join(root, 'fresh-v1');
  const memory = createCompanionMemory({ stateDir: dir, getCharacter: () => ({ id: 'alpha', epoch: 1 }) });
  good(memory.routing()); assert.equal(memory.routing().backend, 'v2');
  const v2 = createCompanionMemory({ getCharacter: () => ({ id: 'alpha', epoch: 1 }), memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }) } });
  bad(v2.buildContext({ characterId: 'alpha', characterEpoch: 1 }), 'MEMORY_PREPARATION_REQUIRED');
});
async function modelFixture(name, run) {
  return fixture(name, async f => {
    const budget = createTokenBudgetService({ ctx: {}, dshHome: path.join(f.stateDir, 'budget'), qqStateDir: path.join(f.stateDir, 'qq') });
    let sends = 0;
    const llm = { listModels: async () => [{ id: COMPANION_ROUTE.model, inputModalities: ['text', 'image'] }], stream: async function* () { sends++; yield { type: 'text-delta', text: output }; yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    llm.prepareCall = async config => { const stream = llm.stream; return Object.freeze({ config: Object.freeze({ ...config }), stream: options => stream(options) }); };
    const model = createCompanionModel({ ctx: { get: key => key === 'llm' ? llm : { saveImages: async () => ['image-ref'] } }, tokenBudget: budget, getCharacter: f.role });
    const { session } = await captureObservation(f); await f.memory.prepareStep(session, '海洋小鱼'); await f.memory.bindStep(session, { system: 'system', prompt: 'prompt', images: [image] });
    const admitNetwork = (dispatch, options) => f.memory.admitNetwork(session, dispatch, options);
    const requestMetadata = { requestId: name, category: 'other', purpose: 'organize', jobId: name, role: f.context.characterId, epoch: 1, providerRouteId: routeId, model: COMPANION_ROUTE.model, estimatedTokens: 100 };
    try { await run({ model, budget, llm, requestMetadata, admitNetwork, sends: () => sends, changeRole: f.changeRole }); } finally { f.memory.release(session); budget.dispose(); }
  });
}
await test('direct .call uses admission once, unknown CNY stays unknown and .call preserves beforeSend', () => modelFixture('admission', async f => {
  let checks = 0;
  const args = { system: 'system', prompt: 'prompt', images: [image], requestMetadata: f.requestMetadata, admitNetwork: f.admitNetwork, beforeSend: async () => { checks++; return { ok: true }; } };
  const result = await f.model.call(args); assert.equal(result.admissionReceipt.actualTokens, 18); assert.ok(checks >= 5);
  assert.equal(result.admissionReceipt.actualCostCny, null); await assert.rejects(f.model.call(args), error => error.code === 'COMPANION_REQUEST_REUSED'); assert.equal(f.sends(), 1);
  assert.equal((await f.budget.status()).usage.total.tokens, 18);
}));
await test('direct .reply charges known usage before privacy or stale-role output rejection', () => modelFixture('discard', async f => {
  let guardAllowed = true;
  f.llm.stream = async function* () { yield { type: 'text-delta', text: 'unadopted' }; guardAllowed = false; f.changeRole(); yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 9 } }; };
  await assert.rejects(f.model.reply({ system: 'system', prompt: 'prompt', requestMetadata: f.requestMetadata, admitNetwork: f.admitNetwork, beforeSend: async () => guardAllowed ? { ok: true } : { ok: false, code: 'MEMORY_CONTEXT_STALE', error: 'revoked', hint: 'retire' } }), error => !!error.code && !!error.hint);
  assert.equal((await f.budget.status()).usage.total.tokens, 22);
}));
await test('direct admission defaults deny and never invents metadata', () => modelFixture('deny', async f => {
  await assert.rejects(f.model.reply({ system: 'system', prompt: 'prompt', requestMetadata: f.requestMetadata, admitNetwork: f.admitNetwork }), error => error.code === 'COMPANION_ADMISSION_REQUIRED');
  await assert.rejects(f.model.reply({ system: 'system', prompt: 'prompt', requestMetadata: f.requestMetadata, admitNetwork: f.admitNetwork, beforeSend: async () => undefined }), error => error.code === 'MODEL_NOT_AUTHORIZED');
  assert.equal(f.sends(), 0);
}));
await test('usage in the chunk that aborts generation is charged before cancellation checks', () => modelFixture('abort-usage', async f => {
  const controller = new AbortController();
  f.llm.stream = async function* () { controller.abort(); yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }; };
  await assert.rejects(f.model.reply({ system: 'system', prompt: 'prompt', signal: controller.signal, requestMetadata: f.requestMetadata, admitNetwork: f.admitNetwork, beforeSend: async () => ({ ok: true }) }), error => !!error.code && !!error.hint);
  assert.equal((await f.budget.status()).usage.total.tokens, 9);
}));
console.log(`PASS memory V2 Douyin: ${count} offline scenarios; real worker + fake direct model; evidence ${root}`);
