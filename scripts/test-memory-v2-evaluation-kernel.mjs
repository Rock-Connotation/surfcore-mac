import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { redactContent } from '../src/core/memory-v2-contract.js';
import { loadFixture, validateFixture, partitionFixture, measureCandidates, summarizeMetrics, latencyStats, FIXTURE_PATH, FROZEN_SHA256, sha256 } from './test-memory-v2-evaluation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER = 'fixture-local:uninvoked-provider';
const GRANT = 'fixture-local-processing';
function resolveV1ReportPath() {
  // R05：runner 显式编排依赖，把本轮生成的隔离基线路径传进来。
  // 不再从 `_backups/` 里任选一个历史报告（干净克隆里根本没有、本地历史也可能漂移）。
  const explicit = process.env.SURFCORE_MEMORY_V2_BASELINE;
  if (explicit) {
    if (!path.isAbsolute(explicit) || !fs.existsSync(explicit)) throw new Error(`Baseline report not found: ${explicit}`);
    return explicit;
  }
  throw new Error('V1 evaluation baseline is required. Run scripts/test-memory-v2-evaluation.mjs first via npm run test:memory-v2 (the runner wires SURFCORE_MEMORY_V2_BASELINE). Never pick a random local _backups report.');
}
const V1_PATH = resolveV1ReportPath();
const KERNEL_FILES = ['contract', 'store', 'worker', 'service'].map((name) => `src/core/memory-v2-${name}.js`);
const good = (value) => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const tuple = (facts) => [facts.channel, facts.conversationKey, facts.requesterAccountKey];
const policyKey = (role, domains) => `${role}:${JSON.stringify([...domains].sort())}`;
const policyId = (key) => `fixture-policy-${sha256(key).slice(0, 24)}`;
const unique = (values) => [...new Set(values)];
const sourceHashes = () => Object.fromEntries(KERNEL_FILES.map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));

export function queryFacts(context) {
  return { channel: context.channel, conversationKey: context.conversationId, sourceAccountKey: context.accountId, requesterAccountKey: context.accountId, providerRouteId: PROVIDER, purpose: 'conversation' };
}
export function ingressFacts(event) {
  const quarantined = event.aclDomains.includes('unknown');
  return { channel: quarantined ? 'fixture-quarantine' : event.channel, conversationKey: quarantined ? 'quarantine:unknown-acl' : event.conversationId, sourceAccountKey: event.accountId, requesterAccountKey: event.accountId, providerRouteId: PROVIDER, purpose: 'conversation' };
}

// Only source ACL metadata and trusted request contexts enter the policy builder, never answer gold.
export function buildPolicyFixture(events, contexts) {
  const audiences = new Map(), definitions = new Map();
  const add = (role, domain, facts) => {
    const key = `${role}:${domain}`, values = audiences.get(key) ?? new Map();
    values.set(JSON.stringify(tuple(facts)), tuple(facts)); audiences.set(key, values);
  };
  for (const event of events) {
    for (const domain of event.aclDomains) add(event.characterId, domain, ingressFacts(event));
    const key = policyKey(event.characterId, event.aclDomains);
    definitions.set(key, { characterId: event.characterId, domains: [...event.aclDomains] });
  }
  for (const context of contexts) {
    add(context.characterId, context.aclDomain, queryFacts(context));
    const key = policyKey(context.characterId, [context.aclDomain]);
    definitions.set(key, { characterId: context.characterId, domains: [context.aclDomain] });
  }
  const policies = [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, definition]) => ({
    ...definition, key, policyId: policyId(key), approved: true,
    audiences: unique(definition.domains.flatMap((domain) => [...(audiences.get(`${definition.characterId}:${domain}`)?.values() ?? [])]).map(JSON.stringify)).sort().map(JSON.parse),
    processingGrants: [{ grantId: GRANT, providerRouteId: PROVIDER }],
  }));
  assert(policies.every((policy) => policy.audiences.length > 0));
  return { policies, eventPolicies: Object.fromEntries(events.map((event) => [event.sourceId, policyId(policyKey(event.characterId, event.aclDomains))])) };
}

export function projectSource(event, sequence) {
  return {
    eventId: event.sourceId, sourceKey: `fixture-source:${event.sourceId}`, operationId: `fixture-source-op:${event.sourceId}`,
    producerId: 'fixture-producer', segmentId: 'fixture-frozen-corpus', producerSeq: sequence,
    content: event.text, subject: `${event.attribution.subject}:${event.accountId}`, speaker: event.accountId,
    certainty: event.assertionMode === 'uncertain_asr' ? 'unknown' : event.attribution.certainty,
    attribution: event.assertionMode === 'joke' ? 'joke' : event.assertionMode === 'quoted_injection' ? 'quote' : 'statement',
    occurredAt: event.occurredAt, observedAt: event.occurredAt, timePrecision: 'exact', coverage: event.coverage ?? {},
    evidenceRefs: [{ sourceId: event.sourceId, validTime: event.validTime, sourceStatus: event.status, bindingState: event.bindingState ?? null, supersedes: event.supersedes ?? null }],
  };
}

function exposure(query, ids, events) {
  return {
    wrongRole: ids.filter((id) => events.get(id).characterId !== query.context.characterId),
    wrongAcl: ids.filter((id) => !events.get(id).aclDomains.includes(query.context.aclDomain)),
    lifecycleMetadata: ids.filter((id) => ['deleted', 'suppressed', 'quarantined'].includes(events.get(id).status)),
    queryDeclared: ids.filter((id) => query.forbiddenSourceIds.includes(id)),
  };
}
function groups(rows, field) {
  return Object.fromEntries(unique(rows.map((row) => row[field])).map((key) => {
    const selected = rows.filter((row) => row[field] === key);
    return [key, { search: summarizeMetrics(selected.map((row) => row.search)), prepared: summarizeMetrics(selected.map((row) => row.prepared)) }];
  }));
}

export async function runKernelEvaluation() {
  assert.equal(process.argv.slice(2).length, 0, 'Fixed corpus/kernel mode; no tuning options.');
  const hashesBefore = sourceHashes();
  assert.equal(sha256(fs.readFileSync(FIXTURE_PATH)), FROZEN_SHA256, 'Frozen corpus changed.');
  const data = loadFixture(), integrity = validateFixture(data), partitions = partitionFixture(data);
  assert.equal(partitions.development.queries.length, 80); assert.equal(partitions.holdout.queries.length, 80);
  const events = new Map(data.events.map((event) => [event.sourceId, event]));
  const normalizedTexts = new Map(data.events.map((event) => [event.sourceId, redactContent(event.text, { scope: ingressFacts(event).channel === 'qq' ? 'qq' : 'shared' })]));
  const v1 = JSON.parse(fs.readFileSync(V1_PATH, 'utf8'));
  assert.equal(v1.fixtureSha256, FROZEN_SHA256); assert.equal(v1.rows.length, 160);
  assert.deepEqual(v1.rows.map((row) => row.queryId), data.queries.map((query) => query.queryId));
  const policyFixture = buildPolicyFixture(data.events, data.queries.map((query) => query.context));
  const runDir = fs.mkdtempSync(path.join(ROOT, '_backups/memory-v2-evaluation/v2-'));
  fs.writeFileSync(path.join(runDir, 'policy-mapping.json'), `${JSON.stringify(policyFixture, null, 2)}\n`);
  const mapping = data.events.map((event, index) => ({ sourceId: event.sourceId, eventId: event.sourceId, sourceKey: `fixture-source:${event.sourceId}`, characterId: event.characterId, originalAclDomains: event.aclDomains, policyId: policyFixture.eventPolicies[event.sourceId], ingressFacts: ingressFacts(event), producerSeq: index + 1 }));
  fs.writeFileSync(path.join(runDir, 'source-mapping.json'), `${JSON.stringify(mapping, null, 2)}\n`);
  const management = Symbol('fixture-authenticated-settings');
  const snapshotHost = { character: { id: data.events[0].characterId, epoch: 1 } };
  const setRole = (id) => { snapshotHost.character = { id, epoch: 1 }; };
  const createService = () => createMemoryService({ stateDir: path.join(runDir, 'state'), charactersDir: path.join(runDir, 'characters'), getCharacter: () => ({ ...snapshotHost.character }), now: () => Date.parse(data.referenceTime), authorizeManagement: (authorization) => authorization === management });
  let service = createService();
  const capture = async (characterId, facts, approvedPolicy) => {
    setRole(characterId);
    return good(await service.captureContext({ ...facts, audiencePolicyId: approvedPolicy, processingGrantId: GRANT })).context;
  };
  const admin = async () => good(await service.host.captureAdminContext({ ...ingressFacts(data.events[0]), audiencePolicyId: policyFixture.policies[0].policyId, processingGrantId: GRANT }, management)).context;
  const mappingId = (event) => policyFixture.eventPolicies[event.sourceId];
  const queryContext = (query) => capture(query.context.characterId, queryFacts(query.context), policyId(policyKey(query.context.characterId, [query.context.aclDomain])));
  const initializeStart = performance.now();
  let statusAfterIngest, statusAfterReopen;
  const ingestTimes = [], rows = [], canaryProbes = [], noRelevance = [];
  try {
    const initial = good(await service.initialize()); assert.equal(initial.activeBackend, 'v2');
    for (const policy of policyFixture.policies) {
      const ctx = await admin();
      const { policyId: id, approved, audiences, processingGrants } = policy;
      good(await service.host.configurePolicy(ctx, { policyId: id, approved, audiences, processingGrants }, ctx.controlRevision, `configure:${id}`));
    }
    const adminCtx = await admin();
    good(await service.applyMemoryAction(adminCtx, { type: 'enable_shadow', enabled: true }, adminCtx.controlRevision, 'fixture-enable-shadow'));
    const initializedMs = performance.now() - initializeStart;
    const batches = new Map();
    data.events.forEach((event, index) => {
      const key = JSON.stringify([event.characterId, mappingId(event), ingressFacts(event)]), batch = batches.get(key) ?? [];
      batch.push({ event, raw: projectSource(event, index + 1) }); batches.set(key, batch);
    });
    const accepted = new Set(), ingestStart = performance.now(); let operation = 0;
    for (const entries of batches.values()) {
      const first = entries[0].event, ctx = await capture(first.characterId, ingressFacts(first), mappingId(first));
      for (let index = 0; index < entries.length; index += 100) {
        const batch = entries.slice(index, index + 100), start = performance.now();
        const result = good(await service.ingestEvents(ctx, batch.map((item) => item.raw), `fixture-ingest-batch-${++operation}`));
        ingestTimes.push(performance.now() - start);
        assert.equal(result.sourceState, 'committed');
        assert.deepEqual(result.eventIds, batch.map((item) => item.event.sourceId));
        for (const id of result.eventIds) { assert(!accepted.has(id)); accepted.add(id); }
      }
    }
    const ingestMs = performance.now() - ingestStart;
    assert.equal(accepted.size, 10000);
    statusAfterIngest = good(await service.getStatus());
    assert.equal(statusAfterIngest.characters.reduce((n, role) => n + role.eventCount, 0), 10000);
    assert.equal(statusAfterIngest.characters.reduce((n, role) => n + role.memoryVersionCount, 0), 0);
    good(await service.close()); service = createService(); good(await service.initialize());
    for (const id of unique(data.events.map((event) => event.characterId))) {
      const first = data.events.find((event) => event.characterId === id);
      await capture(id, ingressFacts(first), mappingId(first));
    }
    statusAfterReopen = good(await service.getStatus());
    assert.equal(statusAfterReopen.characters.reduce((n, role) => n + role.eventCount, 0), 10000);
    assert.equal(statusAfterReopen.activeBackend, 'v2');
    const warm = data.queries[0];
    for (let i = 0; i < 3; i++) { const ctx = await queryContext(warm); good(await service.searchMemory(ctx, warm.text, { limit: 8 })); good(await service.prepareMemoryContext(ctx, warm.text, { memory: 1800, total: 6000 })); }
    const searchTimes = [], prepareTimes = [], captureTimes = [], validationTimes = [];
    for (const query of data.queries) {
      let start = performance.now(); const ctx = await queryContext(query); captureTimes.push(performance.now() - start);
      start = performance.now(); const search = good(await service.searchMemory(ctx, query.text, { limit: 8 })); const searchMs = performance.now() - start; searchTimes.push(searchMs);
      assert(search.records.length <= 8);
      for (const record of search.records) { assert.equal(record.type, 'event'); assert(events.has(record.id)); assert.equal(record.content, normalizedTexts.get(record.id)); }
      start = performance.now(); const prepared = good(await service.prepareMemoryContext(ctx, query.text, { memory: 1800, total: 6000 })).prepared; const prepareMs = performance.now() - start; prepareTimes.push(prepareMs);
      assert(prepared.evidenceIds.length <= 8); assert(prepared.text.length <= 1800);
      for (const id of prepared.evidenceIds) { assert(events.has(id)); assert(prepared.text.includes(normalizedTexts.get(id))); assert(normalizedTexts.get(id).length <= 320); }
      assert.deepEqual(prepared.inputManifest.map((ref) => ref.id), prepared.evidenceIds);
      start = performance.now(); good(service.host.verifyPrepared(ctx, prepared)); good(await service.host.bindInputManifest(ctx, prepared.inputManifest)); good(await service.validateContext(ctx, prepared)); validationTimes.push(performance.now() - start);
      rows.push({ queryId: query.queryId, split: query.split, group: query.group, lexicalClass: query.lexicalClass, unknownAnswerExpected: query.unknownAnswerExpected,
        search: measureCandidates(query, search.records.map((record) => record.id), events), prepared: measureCandidates(query, prepared.evidenceIds, events),
        searchExposure: exposure(query, search.records.map((record) => record.id), events), preparedExposure: exposure(query, prepared.evidenceIds, events),
        candidateCount: search.candidateCount, preparedCharacters: prepared.text.length, searchTop8NotPrepared: search.records.map((record) => record.id).filter((id) => !prepared.evidenceIds.includes(id)), preparedBeyondSearchTop8: prepared.evidenceIds.filter((id) => !search.records.some((record) => record.id === id)), searchMs, prepareMs, preparedText: prepared.text, inputManifest: prepared.inputManifest });
    }
    // Fixed source canary texts are additional probes, never added to the 160 scored questions.
    for (const id of data.canarySourceIds) {
      const event = events.get(id);
      for (const context of unique(data.queries.map((query) => JSON.stringify(query.context))).map(JSON.parse)) {
        const ctx = await queryContext({ context }), start = performance.now();
        const search = good(await service.searchMemory(ctx, event.text, { limit: 8 }));
        const prepared = good(await service.prepareMemoryContext(ctx, event.text, { memory: 1800, total: 6000 })).prepared;
        canaryProbes.push({ sourceId: id, context, searchIds: search.records.map((record) => record.id), preparedIds: prepared.evidenceIds, returnedCanarySearch: search.records.some((record) => data.canarySourceIds.includes(record.id)), returnedCanaryPrepared: prepared.evidenceIds.some((sourceId) => data.canarySourceIds.includes(sourceId)), durationMs: performance.now() - start });
      }
      const ctx = await capture(event.characterId, ingressFacts(event), mappingId(event)), start = performance.now();
      const search = good(await service.searchMemory(ctx, event.text, { limit: 8 }));
      canaryProbes.push({ sourceId: id, audience: 'authorized-private-source', searchIds: search.records.map((record) => record.id), exactSourceFound: search.records.some((record) => record.id === id), durationMs: performance.now() - start });
    }
    for (const context of unique(data.queries.map((query) => JSON.stringify(query.context))).map(JSON.parse)) {
      const ctx = await queryContext({ context }), query = 'zzfixture_norelevance_7acfd9c0', start = performance.now();
      const search = good(await service.searchMemory(ctx, query, { limit: 8 })); const prepared = good(await service.prepareMemoryContext(ctx, query, { memory: 1800, total: 6000 })).prepared;
      assert.deepEqual(search.records, []); assert.deepEqual(prepared.evidenceIds, []); assert.equal(prepared.text, '');
      noRelevance.push({ context, query, searchIds: [], preparedIds: [], text: '', durationMs: performance.now() - start });
    }
    const hashesAfter = sourceHashes(); assert.deepEqual(hashesAfter, hashesBefore, 'Kernel changed during measurement; discard run and rerun after freeze.');
    assert.equal(sha256(fs.readFileSync(FIXTURE_PATH)), FROZEN_SHA256);
    const needleQuery = data.queries.find((query) => query.expectedSourceIds.includes(data.oldNeedleSourceId)), needle = rows.find((row) => row.queryId === needleQuery.queryId);
    const report = { status: 'MEASURED', mode: 'real-v2-worker-raw-source-search-and-prepare', node: process.version, fixtureSha256: FROZEN_SHA256, artifactRoot: runDir, integrity,
      sourceHashes: hashesAfter, baseline: { path: V1_PATH, sha256: sha256(fs.readFileSync(V1_PATH)), node: v1.node, diagnostic: v1.diagnostic, automatic: v1.automatic, overlap: v1.overlap, latency: v1.latency },
      mapping: { eventIds: 'fixture sourceId unchanged', policies: policyFixture.policies.length, providerRouteId: PROVIDER, processingGrantId: GRANT, inputs: 'event ACL sets, original source actor/channel/conversation, query context audiences only; no query text or gold', unknownAcl: 'approved isolated quarantine ingress, no ordinary audience', lifecycle: 'retained source metadata, no management overlay applied', proposals: 0, redactedSourceIds: data.events.filter((event) => normalizedTexts.get(event.sourceId) !== event.text).map((event) => event.sourceId) },
      persistence: { acceptedEvents: accepted.size, markedLongTermSources: data.events.filter((event) => event.longTermCandidate && accepted.has(event.sourceId)).length, actualSelectedMemoryVersions: 0, statusAfterIngest, statusAfterReopen },
      search: summarizeMetrics(rows.map((row) => row.search)), prepared: summarizeMetrics(rows.map((row) => row.prepared)), groups: groups(rows, 'group'), splits: groups(rows, 'split'), overlap: groups(rows.filter((row) => row.lexicalClass !== 'not_applicable'), 'lexicalClass'),
      timing: { initializedMs, ingestMs, ingestBatches: latencyStats(ingestTimes), search: latencyStats(searchTimes), prepare: latencyStats(prepareTimes), capture: latencyStats(captureTimes), admissionAndManifest: latencyStats(validationTimes), conditions: 'real reopened worker, all10000 persisted sources, three warmups, 160 distinct questions per search/prepare; RPC wall time includes worker work, excludes capture and separate admission; nearest-rank P95; no SLA/threshold assertion' },
      oldNeedle: { sourceId: data.oldNeedleSourceId, queryId: needle.queryId, ageDays: (Date.parse(data.referenceTime) - Date.parse(events.get(data.oldNeedleSourceId).occurredAt)) / 86400000, search: needle.search, prepared: needle.prepared },
      canaryProbes, noRelevance, unmeasured: { generatedAnswerSupport: null, hallucination: null, noAnswerRestraint: null, proposedSummarySelection: null, productionRevocationLifecycleUsage: null }, rows };
    fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, node: report.node, fixtureSha256: report.fixtureSha256, artifactRoot: runDir, integrity, search: report.search, prepared: report.prepared, overlap: report.overlap, timing: report.timing, oldNeedle: report.oldNeedle, canaryUnauthorizedReturns: canaryProbes.filter((probe) => probe.context && (probe.returnedCanarySearch || probe.returnedCanaryPrepared)).length, noRelevance: noRelevance.length, generatedAnswerMetrics: 'not_measured' }, null, 2));
    return report;
  } finally { await service.close(); }
}

export function evaluationFailure(error) {
  return { ok: false, code: error?.code || 'EVALUATION_FAILED', error: `memory-v2-evaluation-kernel FAILED: ${error?.message || String(error)}`, hint: '检查冻结语料哈希、kernel API/policy 和本次 v2-* artifact；若 kernel 中途改变，稳定后重跑。不要改 gold 迁就结果。', stack: error?.stack || null };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runKernelEvaluation().catch((error) => { console.error(JSON.stringify(evaluationFailure(error), null, 2)); process.exitCode = 1; });
}
