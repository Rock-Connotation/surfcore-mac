import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

const root = path.join(testHome, 'douyin-reflection-receipt');
fs.mkdirSync(root, { recursive: true });
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
let failed = false;
try {
await fixture('cancel-reflection', async f => {
  const original = f.service.ingestEvents;
  let resume, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let operationId;
  f.service.ingestEvents = async (...args) => {
    if (args[1].some(event => event.attribution === 'reflection')) {
      operationId = args[2]; entered(); await new Promise(resolve => { resume = resolve; });
    }
    return original(...args);
  };
  try {
  const api = f.engine();
  const started = good(await api.start(f.context));
  await waiting;
  const cancelled = await api.cancel(f.context);
  assert.equal(cancelled.ok, true); assert.equal(cancelled.state, 'cancelled');
  const store = createDouyinCompanionStore(f.stateDir, () => new Date().toISOString());
  const job = store.readLedger().jobs[started.jobId];
  console.log('CANCELLED_JOB', JSON.stringify({operationId, recorded: job.items[0].reflectionOperation ?? null, state: job.state, memorySaved: job.items[0].memorySaved}));
  resume();
  await new Promise(resolve => setTimeout(resolve, 100));
  const receipt = await api.queryReflection(f.context, operationId);
  console.log('HOST_RECEIPT', JSON.stringify({ok: receipt.ok, operationId: receipt.operationId, sourceState: receipt.sourceState, operationState: receipt.operationState}));
  assert.equal(cancelled.items[0].reflectionOperation?.operationId, operationId);
  const status = good(await api.status(f.context));
  assert.equal(status.recentJobs.find(row => row.jobId === started.jobId).items[0].reflectionOperation.operationId, operationId);
  api.releaseResponse(status);
  const stale = await api.queryReflection({ ...f.context, characterEpoch: 99 }, operationId);
  assert.equal(stale.ok, false); assert.ok(stale.code && stale.error && stale.hint);
  console.log('STALE_FAILURE', JSON.stringify(stale));
  const missing = await api.queryReflection(f.context, 'not-an-operation');
  assert.equal(missing.ok, false); assert.ok(missing.code && missing.error && missing.hint);
  console.log('QUERY_FAILURE', JSON.stringify(missing));
  assert.equal(job.items[0].reflectionOperation?.operationId, operationId, 'cancelled job must retain the original reflection operation id');
  assert.equal(job.items[0].reflectionOperation?.state, 'unknown');
  assert.equal(receipt.operationId, operationId); assert.equal(receipt.sourceState, 'committed'); assert.equal(receipt.operationState, 'completed');
  assert.equal(job.items[0].memorySaved, false);
  console.log('PASS real host cancelled reflection receipt');
  } finally { resume?.(); }
});
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
