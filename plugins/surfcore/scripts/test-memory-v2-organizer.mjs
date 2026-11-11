import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGrowthProposal } from '../../../src/core/memory-v2-growth.js';
import { createMemoryOrganizer } from '../lib/memory-v2-organizer.mjs';
import { createModelCallAdmission } from '../lib/model-call-admission.mjs';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createMemoryService } from '../../../src/core/memory-v2-service.js';

const root = fileURLToPath(new URL('../../../_backups/memory-v2-growth/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, 'run-'));
const clock = Date.parse('2026-11-09T12:00:00Z'), results = [];
const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const measuredFiles = ['src/core/memory-v2-growth.js', 'src/core/memory-v2-contract.js', 'src/core/memory-v2-store.js', 'src/core/memory-v2-worker.js', 'src/core/memory-v2-service.js', 'plugins/surfcore/lib/memory-v2-organizer.mjs', 'plugins/surfcore/lib/model-call-admission.mjs', 'plugins/surfcore/lib/token-budget-admission.mjs'];
const codeHashes = () => Object.fromEntries(measuredFiles.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(checkout, file))).digest('hex')]));
const codeBefore = codeHashes();
const good = (result) => { assert.equal(result?.ok, true, JSON.stringify(result)); return result; };
const bad = (result, code, selection) => { assert.equal(result?.ok, false, JSON.stringify(result)); if (code) assert.equal(result.code, code, JSON.stringify(result)); if (selection) assert.equal(result.selectionState, selection); assert.ok(result.error); assert.ok(result.hint); return result; };
async function test(name, run, layer = 'pure') { await run(); results.push({ name, layer, status: 'PASS' }); console.log(`PASS [${layer}] ${name}`); }
const event = (id, date = '2026-11-08T12:00:00Z', extra = {}) => ({ eventId: id, rootEventId: id, characterId: 'whale', subject: 'whale', speaker: 'whale', actorAccountKey: 'qq:123', occurredAt: date, attribution: 'action', certainty: 'observed', content: '我听完后写下了看法。', ...extra });
const roots = [event('e1'), event('e2'), event('e3', '2026-11-09T10:00:00Z')];
const proposal = (extra = {}) => ({ propositionKey: 'self-reading', kind: 'self_view', subject: 'whale', content: '我似乎偏爱细读。', certainty: 'inferred', attribution: 'reflection', evidenceRefs: [], ...extra });
const validate = (extra = {}) => validateGrowthProposal({ proposal: proposal(), rootEvents: roots, asOf: new Date(clock).toISOString(), ...extra });
const span = (source) => ({ type: 'event', id: source.eventId, revision: 1, start: 0, end: source.content.length, text: source.content });
const draft = (source, extra = {}) => ({ propositionKey: `reflection-${source.eventId}`, kind: 'reflection', subject: source.subject, content: source.content, certainty: 'inferred', attribution: 'reflection', evidenceRefs: [span(source)], ...extra });

await test('three independent experience roots on two dates yield inferred stable self metadata', () => {
  const result = good(validate()); assert.equal(result.growth.classification, 'stable_self'); assert.deepEqual(result.growth.independentRootIds, ['e1', 'e2', 'e3']); assert.equal(result.growth.certainty, 'inferred');
});
await test('duplicates, derived summaries, repeated roots and one date cannot inflate growth', () => {
  bad(validate({ rootEvents: [roots[0], roots[0], { ...roots[0], eventId: 'part-2' }, { ...roots[1], type: 'memory' }, { ...roots[2], memoryId: 'derived' }] }), 'MEMORY_GROWTH_THRESHOLD_UNMET', 'review');
  bad(validate({ rootEvents: roots.map((source) => ({ ...source, occurredAt: roots[0].occurredAt })) }), 'MEMORY_GROWTH_THRESHOLD_UNMET', 'review');
});
await test('unresolved counterproof routes to review; resolved evidence does not block', () => {
  bad(validate({ counterEvidence: [{ id: 'counter-1', resolved: false }] }), 'MEMORY_GROWTH_COUNTER_EVIDENCE', 'review'); good(validate({ counterEvidence: [{ resolved: true }] }));
});
await test('one root can support a reflection but not a stable trait', () => {
  assert.equal(good(validate({ proposal: proposal({ kind: 'reflection' }), rootEvents: [roots[0]] })).growth.classification, 'reflection');
  assert.deepEqual(good(validate({ proposal: proposal({ kind: 'reflection' }), rootEvents: [{ ...roots[0], occurredAt: null }] })).growth.dates, []);
  bad(validate({ rootEvents: [roots[0]] }), 'MEMORY_GROWTH_THRESHOLD_UNMET');
});
await test('current self statement remains reported/current, never a stable observed truth', () => {
  const source = event('choice', undefined, { attribution: 'statement', certainty: 'reported' });
  const p = proposal({ attribution: 'current_self_statement', certainty: 'reported' });
  const result = good(validate({ proposal: p, rootEvents: [source] })); assert.equal(result.growth.classification, 'current_statement'); assert.equal(result.growth.stable, false);
  bad(validate({ proposal: { ...p, certainty: 'observed' }, rootEvents: [source] }), 'MEMORY_GROWTH_REALITY_UPGRADE');
});
await test('reported user preference is not subject to self-behavior threshold', () => {
  const source = event('preference', undefined, { subject: 'qq:123', speaker: 'qq:123', attribution: 'statement', certainty: 'reported' });
  assert.equal(good(validate({ proposal: proposal({ kind: 'preference', subject: 'qq:123', certainty: 'reported' }), rootEvents: [source] })).growth.classification, 'reported_preference');
  bad(validate({ proposal: proposal({ subject: 'qq:123' }), rootEvents: [source] }), 'MEMORY_GROWTH_SUBJECT_INVALID');
});
await test('jokes, plans, quotations, unknown ASR and persona/control fields do not establish growth', () => {
  for (const attribution of ['joke', 'plan', 'quote', 'conditional']) bad(validate({ rootEvents: roots.map((source) => ({ ...source, attribution })) }), 'MEMORY_GROWTH_EVIDENCE_REQUIRED');
  bad(validate({ rootEvents: roots.map((source) => ({ ...source, certainty: 'unknown' })) }), 'MEMORY_GROWTH_EVIDENCE_REQUIRED');
  for (const field of ['corePersona', 'policyId', 'growth', 'rootCount']) bad(validate({ proposal: proposal({ [field]: true }) }), 'MEMORY_GROWTH_INVALID');
  good(validate({ proposal: proposal({ kind: 'fact' }), rootEvents: [] }));
});
const c = { promiserAccountKey: 'qq:123', beneficiaryAccountKey: 'qq:456', dueAt: '2026-11-09T10:00:00Z', status: 'open' };
const commitmentProposal = (commitment) => proposal({ kind: 'commitment', certainty: 'reported', attribution: 'statement', commitment });
await test('new commitment uses stable actors and explicit deadline; legacy candidates remain compatible', () => {
  const result = good(validate({ proposal: commitmentProposal(c) })); assert.equal(result.commitment.confirmation, 'reported');
  bad(validate({ proposal: commitmentProposal({ ...c, promiserAccountKey: '昵称' }) }), 'MEMORY_COMMITMENT_INVALID');
  bad(validate({ proposal: commitmentProposal({ ...c, dueAt: '明天' }) }), 'MEMORY_COMMITMENT_INVALID');
  bad(validate({ proposal: commitmentProposal({ ...c, dueAt: '2026-02-31T10:00:00Z' }) }), 'MEMORY_COMMITMENT_INVALID');
  bad(validate({ proposal: commitmentProposal({ ...c, status: 'completed' }) }), 'MEMORY_COMMITMENT_PREVIOUS_REQUIRED', 'review');
  good(validate({ proposal: proposal({ kind: 'commitment' }), rootEvents: [] }));
});
await test('completion/cancellation requires new actual evidence from the same promiser', () => {
  const previous = { commitment: { ...c, evidenceRootIds: ['e1'] } };
  for (const status of ['completed', 'cancelled']) {
    bad(validate({ proposal: commitmentProposal({ ...c, status, transitionEvidenceId: 'e1' }), previous }), 'MEMORY_COMMITMENT_NEW_EVIDENCE_REQUIRED');
    const result = good(validate({ proposal: commitmentProposal({ ...c, status, transitionEvidenceId: 'e2' }), previous })); assert.equal(result.commitment.status, status);
    bad(validate({ proposal: commitmentProposal({ ...c, status, transitionEvidenceId: 'e2' }), previous, rootEvents: roots.map((source) => ({ ...source, actorAccountKey: 'qq:999' })) }), 'MEMORY_COMMITMENT_ACTOR_UNPROVEN');
  }
});
await test('elapsed deadline only yields overdue/unconfirmed and closed transitions require dispute', () => {
  const previous = { commitment: { ...c, evidenceRootIds: ['e1'] } };
  const result = good(validate({ proposal: commitmentProposal({ ...c, status: 'overdue' }), previous })); assert.equal(result.commitment.confirmation, 'unconfirmed');
  bad(validate({ proposal: commitmentProposal({ ...c, status: 'overdue' }), previous, asOf: '2026-11-09T09:00:00Z' }), 'MEMORY_COMMITMENT_DEADLINE_UNPROVEN');
  bad(validate({ proposal: commitmentProposal({ ...c, dueAt: '2026-11-10T10:00:00Z' }), previous }), 'MEMORY_COMMITMENT_NEW_EVIDENCE_REQUIRED');
  bad(validate({ proposal: commitmentProposal(c), previous: { commitment: { ...c, status: 'completed' } } }), 'MEMORY_COMMITMENT_TRANSITION_INVALID');
});

async function injected(name, body) {
  const home = fs.mkdtempSync(path.join(evidence, 'injected-'));
  const budget = createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq'), now: () => clock });
  let role = { id: 'whale', epoch: 4 }, jobId = 'fixture-job', state = 'pending', calls = 0, applied = [], bound = [];
  const receipts = new Map(), source = event('injected-event');
  let context = { characterId: 'whale', capturedEpoch: 4, purpose: 'organize', providerRouteId: 'fixture-route' };
  const batch = () => ({ ok: true, events: [source], inputManifest: [{ type: 'event', id: source.eventId, revision: 1, payloadDigest: 'fixture-digest' }], domain: 'fixture-domain', jobId, highWater: 1, cursor: { afterRowId: 1 }, jobState: state, deferred: [] });
  const service = { validateContext: async () => ({ ok: true }), getMemoryReceipt: async (_ctx, id) => receipts.get(id) ?? { ok: true, operationState: 'not_found' }, proposeMemory: async (_ctx, value) => { applied.push(value); const result = { ok: true, selectionState: 'committed', operationId: value.operationId }; receipts.set(value.operationId, result); return result; }, host: { readOrganizeBatch: async (_ctx, options) => { assert.equal(options.limit, 40); assert(options.maxInputTokens <= 6000); return batch(); }, bindInputManifest: async (_ctx, refs) => { bound.push(...refs); return { ok: true }; }, finishOrganizeBatch: async (_ctx, value) => { state = value.state; return { ok: true, ...value }; } } };
  const admission = createModelCallAdmission({ tokenBudget: budget, getCharacter: () => role, authorize: () => true, now: () => clock });
  const make = (extra = {}) => createMemoryOrganizer({ memoryService: service, modelAdmission: admission, getCharacter: () => role, now: () => clock, getModelRequest: () => ({ providerRouteId: 'fixture-route', model: 'fixture-model' }), modelCall: async ({ onUsage, input }) => { calls++; assert.equal(bound.length, 1); assert.equal(input.events[0].eventId, source.eventId); assert.equal(input.inputManifest.length, 1); onUsage({ inputTokens: 20, outputTokens: 10 }); return { proposals: [draft(source)] }; }, ...extra });
  try { await body({ make, service, source, get context() { return context; }, budget, applied, bound, receipts, admission, get calls() { return calls; }, setRole: (value) => { role = value; }, next: () => { jobId += '-next'; state = 'pending'; bound = []; context = { ...context }; } }); results.push({ name, layer: 'injected Host + real budget + fake model', status: 'PASS' }); console.log(`PASS [injected Host + real budget] ${name}`); }
  finally { budget.dispose(); }
}
await injected('known usage commits only after complete manifest; duplicate durable job does not call model', async (f) => {
  const organizer = f.make(); const first = good(await organizer.run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(first.candidates[0].phase, 'committed'); assert.equal(f.applied.length, 1); assert.equal(first.modelReceipt.actualTokens, 30);
  const second = good(await organizer.run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(second.phase, 'existing'); assert.equal(f.calls, 1); assert.equal(f.applied.length, 1);
});
await injected('opt-in and durable Host hooks gate before model or source mutation', async (f) => {
  bad(await f.make().run({ context: f.context, trigger: 'idle5min' }), 'ORGANIZER_OPT_IN_REQUIRED');
  const method = f.service.host.finishOrganizeBatch; delete f.service.host.finishOrganizeBatch; bad(await f.make().run({ context: f.context, trigger: 'manual', optIn: true }), 'ORGANIZER_HOST_NOT_READY'); f.service.host.finishOrganizeBatch = method; assert.equal(f.calls, 0); assert.equal(f.applied.length, 0);
});
await injected('unknown fields, persona and tampered spans are individually rejected; usage remains charged', async (f) => {
  const organizer = f.make({ modelCall: async ({ onUsage }) => { onUsage({ outputTokens: 42 }); return { proposals: [draft(f.source, { corePersona: 'replace' }), draft(f.source, { evidenceRefs: [{ ...span(f.source), text: 'forged' }] })] }; } });
  const result = good(await organizer.run({ context: f.context, trigger: 'before_compact', optIn: true })); assert.deepEqual(result.candidates.map((candidate) => candidate.phase), ['rejected', 'rejected']); assert.equal(f.applied.length, 0); assert.equal(result.modelReceipt.actualTokens, 42);
});
await injected('unknown usage retains original reservation and forbids new global organize work', async (f) => {
  let calls = 0;
  const organizer = f.make({ modelCall: async () => { calls++; return { proposals: [draft(f.source)] }; } });
  const first = bad(await organizer.run({ context: f.context, trigger: 'manual', optIn: true }), 'MODEL_USAGE_UNKNOWN'); assert.equal(first.phase, 'model_unknown'); assert.equal(first.modelReceipt.state, 'usage_unknown'); assert.equal(f.applied.length, 0);
  f.next(); bad(await organizer.run({ context: f.context, trigger: 'manual', optIn: true }), 'BUDGET_USAGE_UNKNOWN'); assert.equal(calls, 1);
});
await injected('actual overrun is charged and pauses the next call', async (f) => {
  let calls = 0; const organizer = f.make({ modelCall: async ({ onUsage }) => { calls++; onUsage({ inputTokens: 40000, outputTokens: 10 }); return { proposals: [] }; } });
  const first = await organizer.run({ context: f.context, trigger: 'manual', optIn: true }); assert.equal(first.modelReceipt.actualTokens, 40010);
  f.next(); const next = bad(await organizer.run({ context: f.context, trigger: 'manual', optIn: true })); assert.match(next.code, /BUDGET_/); assert.equal(calls, 1);
});
await injected('late role switch discards proposal but charges usage', async (f) => {
  const organizer = f.make({ modelCall: async ({ onUsage }) => { onUsage({ outputTokens: 31 }); f.setRole({ id: 'other', epoch: 5 }); return { proposals: [draft(f.source)] }; } });
  const result = bad(await organizer.run({ context: f.context, trigger: 'manual', optIn: true }), 'ORGANIZER_CONTEXT_STALE'); assert.equal(result.modelReceipt.actualTokens, 31); assert.equal(f.applied.length, 0); assert.ok(result.finishError);
});
await injected('malformed envelope and provider failure do not leak output or automatically retry', async (f) => {
  const first = bad(await f.make({ modelCall: async ({ onUsage }) => { onUsage({ outputTokens: 8 }); return '{bad'; } }).run({ context: f.context, trigger: 'manual', optIn: true }), 'ORGANIZER_OUTPUT_INVALID'); assert.equal(first.modelReceipt.actualTokens, 8); assert.equal(f.applied.length, 0);
  f.next(); const secret = 'fixture-private-provider-secret'; const second = bad(await f.make({ modelCall: async ({ onUsage }) => { onUsage({ outputTokens: 9 }); throw new Error(secret); } }).run({ context: f.context, trigger: 'manual', optIn: true }), 'MODEL_INVOKE_FAILED'); assert.equal(second.modelReceipt.actualTokens, 9); assert.equal(JSON.stringify(second).includes(secret), false);
});

const real = { status: 'pending', fixtures: [] };
const management = Symbol('growth-fixture-management');
async function realFixture(name, sources, body) {
  const home = fs.mkdtempSync(path.join(evidence, 'real-host-'));
  let role = { id: 'whale', epoch: 4 }, service, context;
  const facts = { channel: 'qq', conversationKey: 'qq:fixture:private:123', sourceAccountKey: 'qq:123', requesterAccountKey: 'qq:123', audiencePolicyId: 'growth-private', providerRouteId: 'fixture-route', processingGrantId: 'growth-grant', purpose: 'organize' };
  const create = () => createMemoryService({ stateDir: path.join(home, 'state'), charactersDir: path.join(home, 'characters'), getCharacter: () => role, now: () => clock, authorizeManagement: (value) => value === management });
  const budget = createTokenBudgetService({ ctx: {}, dshHome: path.join(home, 'quota'), qqStateDir: path.join(home, 'quota-qq'), now: () => clock });
  service = create();
  try {
    if (typeof service.host.finishOrganizeBatch !== 'function') { if (process.argv.includes('--require-real')) assert.fail('durable Host completion hook required'); return; }
    good(await service.initialize());
    for (const [id, action] of [['policy', { type: 'configure_policy', policy: { policyId: facts.audiencePolicyId, approved: true, audiences: [[facts.channel, facts.conversationKey, facts.requesterAccountKey]], processingGrants: [{ grantId: facts.processingGrantId, providerRouteId: facts.providerRouteId }] } }], ['shadow', { type: 'enable_shadow', enabled: true }]]) {
      const admin = good(await service.host.captureAdminContext(facts, management)).context; good(await service.applyMemoryAction(admin, action, admin.controlRevision, `setup-${id}`));
    }
    context = good(await service.captureContext(facts)).context;
    if (sources.length) good(await service.ingestEvents(context, sources.map((source, index) => ({ eventId: source.eventId, operationId: `source-${source.eventId}`, sourceKey: `source:${source.eventId}`, producerId: 'growth-test', segmentId: 'sources', producerSeq: index + 1, content: source.content, subject: source.subject, speaker: source.speaker, certainty: source.certainty, attribution: source.attribution, occurredAt: source.occurredAt })), 'ingest-sources'));
    const admission = createModelCallAdmission({ tokenBudget: budget, getCharacter: () => role, authorize: () => true, now: () => clock });
    const fixture = { home, budget, facts, get service() { return service; }, get context() { return context; }, setRole: (value) => { role = value; }, make: (modelCall) => createMemoryOrganizer({ memoryService: service, modelAdmission: admission, modelCall, getCharacter: () => role, getModelRequest: () => ({ providerRouteId: facts.providerRouteId, model: 'fixture-model' }), now: () => clock }), async refresh() { context = good(await service.captureContext(facts)).context; }, async reopen() { good(await service.close()); service = create(); good(await service.initialize()); context = good(await service.captureContext(facts)).context; } };
    await body(fixture);
    const status = good(await service.getStatus()); real.fixtures.push({ name, home, status }); real.status = 'PASS'; results.push({ name, layer: 'real Host/Worker + real budget + fake model', status: 'PASS' }); console.log(`PASS [real Host/Worker] ${name}`);
  } finally { await service.close(); budget.dispose(); }
}
await realFixture('actual full-input provenance, stable self growth, commit and reopen cursor', roots, async (f) => {
  let calls = 0;
  const organizer = f.make(async ({ input, onUsage }) => { calls++; onUsage({ inputTokens: 25, outputTokens: 15 }); assert.equal(input.events.length, 3); assert.equal(input.inputManifest.length, 3); return { proposals: [proposal({ evidenceRefs: input.events.map(span) })] }; });
  const result = good(await organizer.run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(result.candidates[0].phase, 'committed'); assert.equal(result.receipt.jobState, 'completed'); assert.equal(result.modelReceipt.actualTokens, 40);
  const status = good(await f.service.getStatus()).characters.find((value) => value.characterId === 'whale'); assert.equal(status.eventCount, 3); assert.equal(status.memoryVersionCount, 1);
  await f.reopen(); const receipt = good(await f.service.getMemoryReceipt(f.context, result.candidates[0].operationId)); assert.equal(receipt.selectionState, 'committed');
  const next = good(await f.make(() => assert.fail('completed job must not invoke model')).run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(next.phase, 'empty'); assert.equal(calls, 1);
});
await realFixture('a single cited root stays review even with three full actual inputs', roots, async (f) => {
  const result = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 12 }); return { proposals: [proposal({ evidenceRefs: [span(input.events[0])] })] }; }).run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.equal(result.candidates[0].phase, 'review'); assert.equal(result.receipt.jobState, 'review'); assert.equal(good(await f.service.getStatus()).characters[0].memoryVersionCount, 0); assert.equal(result.candidates[0].receipt.code, 'MEMORY_GROWTH_THRESHOLD_UNMET');
});
await realFixture('existing source reflection is directly proposed without another model call', [event('media-reflection', undefined, { producerId: 'douyin-companion', attribution: 'reflection', certainty: 'reported' })], async (f) => {
  const result = good(await f.make(() => assert.fail('source reflection must not call model')).run({ context: f.context, trigger: 'before_compact', optIn: true })); assert.equal(result.candidates[0].phase, 'committed'); assert.equal(result.modelReceipt, null); assert(result.phases.some((value) => value.phase === 'source_reflection'));
});
await realFixture('actual unknown model claim survives restart without automatic dispatch', [event('unknown-source')], async (f) => {
  let calls = 0; const result = bad(await f.make(async ({ input }) => { calls++; return { proposals: [draft(input.events[0])] }; }).run({ context: f.context, trigger: 'manual', optIn: true }), 'MODEL_USAGE_UNKNOWN'); assert.equal(result.phase, 'model_unknown'); assert.equal(good(await f.service.getStatus()).characters[0].eventCount, 1);
  await f.reopen(); const batch = good(await f.service.host.readOrganizeBatch(f.context, { limit: 40, maxInputTokens: 5000 })); assert.equal(batch.jobState, 'model_unknown');
  const next = good(await f.make(() => assert.fail('unknown claim must not redispatch')).run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(next.phase, 'existing'); assert.equal(calls, 1);
});
await realFixture('actual local parser rejection is durable and original source remains', [event('rejected-source')], async (f) => {
  const result = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 16 }); return { proposals: [draft(input.events[0], { corePersona: 'forbidden' })] }; }).run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(result.candidates[0].phase, 'rejected'); assert.equal(result.receipt.jobState, 'rejected'); assert.equal(good(await f.service.getStatus()).characters[0].eventCount, 1);
});
await realFixture('actual batches partition policy domains and same proposition gets separate version chains', [event('domain-private')], async (f) => {
  const policy = { policyId: 'growth-shared', approved: true, audiences: [[f.facts.channel, f.facts.conversationKey, f.facts.requesterAccountKey], ['qq', 'qq:fixture:group:public', 'qq:999']], processingGrants: [{ grantId: f.facts.processingGrantId, providerRouteId: f.facts.providerRouteId }] };
  const admin = good(await f.service.host.captureAdminContext(f.facts, management)).context; good(await f.service.applyMemoryAction(admin, { type: 'configure_policy', policy }, admin.controlRevision, 'setup-second-policy'));
  const shared = good(await f.service.captureContext({ ...f.facts, audiencePolicyId: policy.policyId })).context;
  good(await f.service.ingestEvents(shared, [{ eventId: 'domain-shared', operationId: 'source-domain-shared', sourceKey: 'source:domain-shared', producerId: 'growth-test', segmentId: 'other', producerSeq: 1, content: '我认真听了共享来源。', subject: 'whale', speaker: 'whale', attribution: 'action', certainty: 'observed', occurredAt: '2026-11-09T10:00:00Z' }], 'ingest-shared'));
  await f.reopen();
  const batches = [], make = () => f.make(async ({ input, onUsage }) => { batches.push(input); onUsage({ outputTokens: 7 }); assert.equal(input.events.length, 1); return { proposals: [draft(input.events[0], { propositionKey: 'same-claim' })] }; });
  const first = good(await make().run({ context: f.context, trigger: 'manual', optIn: true }));
  const reused = bad(await make().run({ context: f.context, trigger: 'manual', optIn: true }), 'ORGANIZER_CONTEXT_REUSED'); assert.equal(reused.requestId, null);
  await f.refresh();
  const second = good(await make().run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.notEqual(batches[0].domain, batches[1].domain); assert.notEqual(first.candidates[0].receipt.memoryId, second.candidates[0].receipt.memoryId); assert.equal(good(await f.service.getStatus()).characters[0].memoryVersionCount, 2);
});
await realFixture('oversized complete segmented source is deferred without truncation or model', [event('oversized', undefined, { content: '分段完整来源。'.repeat(4000) })], async (f) => {
  const before = good(await f.service.getStatus()).characters[0].eventCount; assert(before > 1);
  const result = good(await f.make(() => assert.fail('oversized complete source must not call model')).run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(result.phase, 'review'); assert.equal(result.cursorAdvanced, false); assert(result.deferred.length > 0); assert.equal(good(await f.service.getStatus()).characters[0].eventCount, before);
  bad(await f.service.host.readOrganizeBatch(f.context, { limit: 41, maxInputTokens: 6000 }), 'MEMORY_ORGANIZE_BUDGET_INVALID');
  bad(await f.service.host.readOrganizeBatch(f.context, { limit: 40, maxInputTokens: 6001 }), 'MEMORY_ORGANIZE_BUDGET_INVALID');
});
await realFixture('grant revocation during admitted model work discards output but preserves usage', [event('revoke-source')], async (f) => {
  const result = bad(await f.make(async ({ input, onUsage }) => {
    onUsage({ inputTokens: 10, outputTokens: 13 }); const admin = good(await f.service.host.captureAdminContext(f.facts, management)).context;
    good(await f.service.applyMemoryAction(admin, { type: 'revoke_policy', policyId: f.facts.audiencePolicyId }, admin.controlRevision, 'revoke-during-model'));
    return { proposals: [draft(input.events[0])] };
  }).run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.match(result.code, /^MEMORY_/); assert.equal(result.modelReceipt.actualTokens, 23); assert.equal(result.candidates.length, 0); assert.ok(result.finishError);
});
await realFixture('kernel reality rejection remains a durable rejected candidate without false commitment', [event('joke-source', undefined, { attribution: 'joke', certainty: 'reported' })], async (f) => {
  const result = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 9 }); return { proposals: [draft(input.events[0], { certainty: 'observed' })] }; }).run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.equal(result.candidates[0].phase, 'rejected'); assert.equal(result.candidates[0].code, 'MEMORY_REALITY_UPGRADE_DENIED'); assert.ok(result.candidates[0].hint); assert.equal(result.receipt.jobState, 'rejected'); assert.equal(good(await f.service.getStatus()).characters[0].memoryVersionCount, 0);
});
await realFixture('typed commitment transitions use the actual previous version and fresh promiser root', [event('promise-open', undefined, { content: '我答应在 2026-11-10T10:00:00Z 前整理材料。', attribution: 'statement', certainty: 'reported' })], async (f) => {
  const metadata = { ...c, dueAt: '2026-11-10T10:00:00Z' };
  const opened = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 10 }); return { proposals: [draft(input.events[0], { propositionKey: 'promise-material', kind: 'commitment', certainty: 'reported', commitment: metadata })] }; }).run({ context: f.context, trigger: 'manual', optIn: true }));
  const first = opened.candidates[0].receipt; assert.equal(first.selectionState, 'committed'); assert.equal(first.revision, 1);
  await f.refresh(); good(await f.service.ingestEvents(f.context, [{ eventId: 'promise-completed', operationId: 'source-promise-completed', sourceKey: 'source:promise-completed', producerId: 'growth-test', segmentId: 'sources', producerSeq: 2, content: '我已经整理完答应的材料。', subject: 'whale', speaker: 'whale', attribution: 'statement', certainty: 'reported', occurredAt: '2026-11-09T11:00:00Z' }], 'ingest-completion'));
  await f.refresh(); const completed = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 11 }); return { proposals: [draft(input.events[0], { propositionKey: 'promise-material', memoryId: first.memoryId, expectedRevision: 1, kind: 'commitment', certainty: 'reported', commitment: { ...metadata, status: 'completed', transitionEvidenceId: 'promise-completed' } })] }; }).run({ context: f.context, trigger: 'manual', optIn: true }));
  const second = completed.candidates[0].receipt; assert.equal(second.selectionState, 'committed'); assert.equal(second.memoryId, first.memoryId); assert.equal(second.revision, 2);
  await f.reopen(); assert.equal(good(await f.service.getMemoryReceipt(f.context, completed.candidates[0].operationId)).revision, 2);
});
await realFixture('three new derived ingest IDs across dates cannot multiply one actual original experience', [event('one-original', '2026-11-07T12:00:00Z')], async (f) => {
  const found = good(await f.service.searchMemory(f.context, '我听完')).records.find((record) => record.id === 'one-original'); assert.ok(found);
  const originalRef = { type: found.type, id: found.id, revision: found.revision, payloadDigest: found.payloadDigest };
  const prior = good(await f.make(async ({ onUsage }) => { onUsage({ outputTokens: 1 }); return { proposals: [] }; }).run({ context: f.context, trigger: 'manual', optIn: true })); assert.equal(prior.phase, 'completed');
  for (const [index, attribution] of ['action', 'reflection', 'action'].entries()) {
    await f.refresh(); good(await f.service.host.bindInputManifest(f.context, [originalRef]));
    good(await f.service.ingestEvents(f.context, [{ eventId: `derived-repeated-${index}`, operationId: `derived-source-${index}`, sourceKey: `source:derived-repeated-${index}`, producerId: 'growth-derived', segmentId: 'repeated-output', producerSeq: index + 1, content: `同一次阅读体验的第${index + 1}次派生记录。`, subject: 'whale', speaker: 'whale', attribution, certainty: attribution === 'action' ? 'observed' : 'reported', occurredAt: index < 2 ? '2026-11-08T12:00:00Z' : '2026-11-09T10:00:00Z' }], `ingest-derived-${index}`));
  }
  await f.reopen();
  const result = good(await f.make(async ({ input, onUsage }) => {
    const derived = input.events.filter((source) => source.eventId.startsWith('derived-repeated-')); assert.equal(derived.length, 3);
    assert.equal(new Set(derived.map((source) => source.occurredAt.slice(0, 10))).size, 2);
    for (const source of derived) assert.deepEqual(source.inputManifest.map((ref) => ref.id), ['one-original']);
    onUsage({ outputTokens: 17 }); return { proposals: [proposal({ kind: 'preference', propositionKey: 'derived-is-not-independent', evidenceRefs: derived.map(span) })] };
  }).run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.equal(result.candidates[0].phase, 'review'); assert.equal(result.candidates[0].receipt.code, 'MEMORY_GROWTH_DERIVED_EVIDENCE'); assert.equal(result.receipt.jobState, 'review'); assert.equal(good(await f.service.getStatus()).characters[0].memoryVersionCount, 0);
});
await realFixture('three distinct cited originals still establish a stable self preference', roots, async (f) => {
  const result = good(await f.make(async ({ input, onUsage }) => { onUsage({ outputTokens: 18 }); assert.equal(input.events.length, 3); for (const source of input.events) assert.deepEqual(source.inputManifest, []); return { proposals: [proposal({ kind: 'preference', propositionKey: 'independent-originals-positive', evidenceRefs: input.events.map(span) })] }; }).run({ context: f.context, trigger: 'manual', optIn: true }));
  assert.equal(result.candidates[0].phase, 'committed'); assert.equal(result.receipt.jobState, 'completed'); assert.equal(good(await f.service.getStatus()).characters[0].memoryVersionCount, 1);
});
const codeAfter = codeHashes(); assert.deepEqual(codeAfter, codeBefore, 'Core or organizer code changed during the isolated verification run.');
fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ status: real.status === 'PASS' ? 'PASS' : 'PASS_WITH_REAL_HOST_PENDING', tests: results, realHost: real, runtime: { node: process.version, executable: process.execPath, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1' }, codeBefore, codeAfter, codeHashesStable: true, noNetworkOrModels: true }, null, 2) + '\n');
console.log(`Growth organizer: ${results.length} checks passed; realHost=${real.status}; evidence=${evidence}`);
