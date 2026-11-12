import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_PATH = path.join(ROOT, 'scripts/fixtures/memory-v2-evaluation.json');
export const FROZEN_SHA256 = '70c664208a85f1d7dedac7cb28aeb2dc8e7f5102881203cff46a5023f2fdecc3';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

// Mirrors V1's case-sensitive tokenizer only to audit the overlap labels, never to expand the index.
export function v1QueryTokens(text, limit = 20) {
  const tokens = [];
  for (const segment of String(text).split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
    if (/[\u4e00-\u9fa5]/.test(segment)) {
      for (let i = 0; i + 2 <= segment.length && tokens.length < limit; i++) {
        const token = segment.slice(i, i + 2);
        if (!/^(一个|这个|那个|就是|什么|怎么|可以|不是|没有|还是|已经|我们|你们|他们|自己|现在|今天|明天|昨天|然后|因为|所以)$/.test(token)) tokens.push(token);
      }
    } else if (segment.length >= 3 && tokens.length < limit) tokens.push(segment);
  }
  return [...new Set(tokens)].slice(0, limit);
}

export function partitionFixture(data) {
  const familySplits = new Map(data.queries.map((query) => [query.family, query.split]));
  const partitions = { development: { events: [], queries: [] }, holdout: { events: [], queries: [] } };
  for (const event of data.events) {
    const split = familySplits.get(event.family) ?? (parseInt(sha256(event.family).slice(0, 2), 16) % 2 ? 'holdout' : 'development');
    partitions[split].events.push(event);
  }
  for (const query of data.queries) partitions[query.split].queries.push(query);
  return partitions;
}

export function validateFixture(data) {
  assert.equal(data.events.length, 10000);
  assert.equal(data.queries.length, 160);
  assert.equal(new Set(data.events.map((event) => event.sourceId)).size, 10000);
  assert.equal(new Set(data.queries.map((query) => query.queryId)).size, 160);
  assert.equal(data.events.filter((event) => event.longTermCandidate).length, 1200);
  assert.equal(new Set(data.scenarios.map((scenario) => scenario.designCategory)).size, 13);
  assert(data.scenarios.every((scenario) => scenario.verification === 'scenario_metadata_only_not_production_test'));
  const events = new Map(data.events.map((event) => [event.sourceId, event]));
  const splitFamilies = { development: new Set(), holdout: new Set() };
  const groupCounts = {};
  for (const event of data.events) {
    assert.match(event.sourceId, /^fixture-event-\d{5}$/);
    assert(['fixture-aurora', 'fixture-boreal'].includes(event.characterId));
    assert(data.provenance.syntheticPlatforms.includes(event.channel));
    assert.match(event.accountId, /:fixture-/);
    assert(event.text.includes(event.factSpan), `${event.sourceId}: fact span missing`);
    assert(Number.isFinite(Date.parse(event.occurredAt)));
    assert(Number.isFinite(Date.parse(event.validTime.from)));
    if (event.validTime.until) assert(Date.parse(event.validTime.until) > Date.parse(event.validTime.from));
    assert(event.aclDomains.length > 0);
    assert(!/https?:\/\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|-----BEGIN|\bsk-[A-Za-z0-9]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,}/.test(event.text), `${event.sourceId}: secret-shaped content`);
  }
  for (const query of data.queries) {
    assert(splitFamilies[query.split]);
    splitFamilies[query.split].add(query.family);
    assert.equal(query.expectedAclDomain, query.context.aclDomain);
    groupCounts[query.group] = (groupCounts[query.group] ?? 0) + 1;
    for (const id of [...query.expectedSourceIds, ...query.forbiddenSourceIds, ...(query.relatedButInsufficientSourceIds ?? [])]) {
      assert(events.has(id), `${query.queryId}: missing source ${id}`);
      assert.equal(events.get(id).family, query.family, `${query.queryId}: wrong source family`);
    }
    assert.equal(query.unknownAnswerExpected, query.expectedSourceIds.length === 0);
    assert.equal(query.answerSpans.length, query.expectedSourceIds.length);
    assert.deepEqual([...new Set(query.answerSpans.map((span) => span.sourceId))].sort(), [...query.expectedSourceIds].sort());
    for (const span of query.answerSpans) {
      const event = events.get(span.sourceId);
      assert(event.text.includes(span.text), `${query.queryId}: unsupported answer span`);
      assert.deepEqual(span.validTime, event.validTime);
      assert.equal(event.characterId, query.context.characterId);
      assert(event.aclDomains.includes(query.expectedAclDomain));
      assert(!['deleted', 'suppressed', 'quarantined'].includes(event.status));
    }
    for (const set of query.necessarySourceSets) assert(set.length && set.every((id) => query.expectedSourceIds.includes(id)));
    if (!query.unknownAnswerExpected) assert(query.necessarySourceSets.length > 0);
    else assert(query.unknownReason && query.answerSpans.length === 0);
    if (query.lexicalClass !== 'not_applicable') {
      const tokenHits = query.expectedSourceIds.flatMap((id) => v1QueryTokens(query.text).filter((token) => events.get(id).text.includes(token)));
      if (query.lexicalClass === 'zero_v1_query_tokens') assert.equal(tokenHits.length, 0, query.queryId);
      else assert(tokenHits.length > 0, query.queryId);
    }
  }
  const partitions = partitionFixture(data);
  const developmentEventFamilies = new Set(partitions.development.events.map((event) => event.family));
  assert(partitions.holdout.events.every((event) => !developmentEventFamilies.has(event.family)));
  assert.equal(partitions.development.events.length + partitions.holdout.events.length, 10000);
  assert.equal(data.queries.filter((query) => query.lexicalClass === 'meaningful_overlap').length, 48);
  assert.equal(data.queries.filter((query) => query.lexicalClass === 'zero_v1_query_tokens').length, 12);
  assert.equal(splitFamilies.development.size, 80);
  assert.equal(splitFamilies.holdout.size, 80);
  assert([...splitFamilies.development].every((family) => !splitFamilies.holdout.has(family)));
  assert.deepEqual(groupCounts, { paraphrase_long_delay: 60, time_versions_promises: 30, identity_relationships: 25, self_experience_attribution: 25, no_answer_insufficient: 20 });
  assert.equal(data.canarySourceIds.length, 4);
  for (const id of data.canarySourceIds) {
    const event = events.get(id);
    assert(event.privateCanary && event.text.includes('FICTIONAL_CANARY_'));
    assert.deepEqual(event.aclDomains, ['kitechat:private:fixture-iris']);
    assert(data.scenarios.find((scenario) => scenario.designCategory === 4).sourceIds.includes(id));
  }
  const needle = events.get(data.oldNeedleSourceId);
  assert.equal(data.events[0].sourceId, needle.sourceId);
  assert(Date.parse(data.referenceTime) - Date.parse(needle.occurredAt) > 180 * 86400000);
  return { events: events.size, queries: data.queries.length, developmentFamilies: 80, holdoutFamilies: 80, developmentEvents: partitions.development.events.length, holdoutEvents: partitions.holdout.events.length, groupCounts, meaningfulOverlap: 48, zeroOverlap: 12, longTermCandidates: 1200, privateCanaries: 4, scenarioCategories: 13 };
}

export function measureCandidates(query, sourceIds, events) {
  const ids = sourceIds.slice(0, 8);
  const hasGold = query.expectedSourceIds.length > 0;
  const forbidden = ids.filter((id) => {
    const event = events.get(id);
    return !event || query.forbiddenSourceIds.includes(id) || event.characterId !== query.context.characterId
      || !event.aclDomains.includes(query.expectedAclDomain) || ['deleted', 'suppressed', 'quarantined'].includes(event.status);
  });
  return {
    sourceIds: ids,
    hitAt8: hasGold ? ids.some((id) => query.expectedSourceIds.includes(id)) : null,
    completeEvidenceAt8: hasGold ? query.necessarySourceSets.some((set) => set.every((id) => ids.includes(id))) : null,
    forbiddenSourceIds: forbidden,
    empty: ids.length === 0,
  };
}

export function summarizeMetrics(rows) {
  const answerable = rows.filter((row) => row.hitAt8 !== null);
  const unknown = rows.filter((row) => row.hitAt8 === null);
  const hits = answerable.filter((row) => row.hitAt8).length;
  return {
    queries: rows.length, answerable: answerable.length, hits, hitAt8: answerable.length ? hits / answerable.length : null,
    completeEvidenceHits: answerable.filter((row) => row.completeEvidenceAt8).length,
    completeEvidenceAt8: answerable.length ? answerable.filter((row) => row.completeEvidenceAt8).length / answerable.length : null,
    unknownQueries: unknown.length, unknownEmptyCandidates: unknown.filter((row) => row.empty).length,
    forbiddenCandidates: rows.reduce((sum, row) => sum + row.forbiddenSourceIds.length, 0),
    queriesWithForbiddenCandidates: rows.filter((row) => row.forbiddenSourceIds.length).length,
  };
}

export function latencyStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
}

const CHANNELS = { kitechat: 'qq', reefvideo: 'bili', waveshort: 'douyin', nestdesk: 'local' };
const CONVERSATIONS = { 'group:fixture-harbor': 'group:71001', 'group:fixture-lighthouse': 'group:71002', 'private:fixture-iris': 'private:72001', 'local:fixture-home': 'local:fixture-home', public: 'public' };
function legacyDomain(domain) {
  for (const [channel, mapped] of Object.entries(CHANNELS)) {
    if (domain === `${channel}:public`) return mapped;
    if (domain.startsWith(`${channel}:`)) {
      const conversation = domain.slice(channel.length + 1);
      return `${mapped}:${CONVERSATIONS[conversation] ?? conversation}`;
    }
  }
  return 'fixture:quarantine';
}

export function projectLegacyInput(event) {
  const platform = CHANNELS[event.channel];
  return {
    source: 'system', sourceId: event.sourceId, eventId: event.sourceId,
    text: event.text, title: '', createdAt: event.occurredAt,
    platform, scope: platform === 'qq' ? 'qq' : platform === 'bili' ? 'bili' : 'shared',
    sourceChannel: platform, conversationKey: CONVERSATIONS[event.conversationId] ?? event.conversationId,
    private: event.conversationId.startsWith('private:'),
    groupId: event.conversationId === 'group:fixture-harbor' ? '71001' : event.conversationId === 'group:fixture-lighthouse' ? '71002' : '',
    visibilityClassification: event.conversationId.startsWith('private:') ? 'private' : 'restricted',
    allowedContexts: event.aclDomains.map(legacyDomain),
    attributionSubject: event.attribution.subject, attributionCertainty: event.attribution.certainty,
    characterEpoch: 1,
  };
}

function assertMetricHelpers() {
  const event = { characterId: 'fixture-aurora', aclDomains: ['nestdesk:local:fixture-home'], status: 'active' };
  const query = { expectedSourceIds: ['a', 'b'], necessarySourceSets: [['a', 'b']], forbiddenSourceIds: [], context: { characterId: 'fixture-aurora' }, expectedAclDomain: event.aclDomains[0] };
  const events = new Map([['a', event], ['b', event], ['c', { ...event, status: 'deleted' }]]);
  const partial = measureCandidates(query, ['a', 'c'], events);
  assert.equal(partial.hitAt8, true);
  assert.equal(partial.completeEvidenceAt8, false);
  assert.deepEqual(partial.forbiddenSourceIds, ['c']);
  assert.equal(measureCandidates(query, ['a', 'b'], events).completeEvidenceAt8, true);
  assert.equal(measureCandidates(query, Array(8).fill('x').concat('a'), events).hitAt8, false);
  assert.equal(summarizeMetrics([{ ...partial, hitAt8: null }]).hitAt8, null);
  assert.equal(latencyStats([3, 1, 2]).p95Ms, 3);
}

async function runV1() {
  assert.equal(process.argv.slice(2).length, 0, 'Standalone mode is fixed V1; no V2 adapter or tuning options.');
  const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
  assert.equal(sha256(fixtureBytes), FROZEN_SHA256, 'Frozen corpus changed; create a reviewed new corpus version.');
  const data = JSON.parse(fixtureBytes);
  const integrity = validateFixture(data);
  assertMetricHelpers();
  const artifactRoot = path.join(ROOT, '_backups/memory-v2-evaluation');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(artifactRoot, 'v1-'));
  const fixtureHome = path.join(runDir, 'synthetic-home');
  // Set before importing the production memory-card module: every role read stays inside the fixture.
  process.env.DSH_HOME = fixtureHome;
  const { addMemoryRecord, createEmptyCard, recallFullMemory, resolveMemoryCardPaths, renderMemoryCard, normalizeMemoryCardConfig } = await import('../src/memory-card.js');
  const { DSH_HOME } = await import('../src/character-persona.js');
  assert.equal(path.resolve(DSH_HOME), fixtureHome, 'Production module was imported before fixture isolation.');
  const fixedNow = Date.parse(data.referenceTime);
  const cards = new Map();
  const archives = new Map();
  const records = new Map();
  const legacyPaths = new Map();
  const setupStart = performance.now();
  for (const event of data.events) {
    if (!cards.has(event.characterId)) {
      cards.set(event.characterId, createEmptyCard(fixedNow));
      archives.set(event.characterId, []);
    }
    const { record, added } = addMemoryRecord(cards.get(event.characterId), projectLegacyInput(event), { maxRecords: 600 }, fixedNow);
    assert(added && record, `V1 projection rejected ${event.sourceId}`);
    archives.get(event.characterId).push(JSON.stringify(record));
    records.set(event.sourceId, record);
  }
  for (const [characterId, card] of cards) {
    const memoryDir = path.join(fixtureHome, 'surfcore/characters', characterId, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    const paths = resolveMemoryCardPaths(memoryDir);
    fs.writeFileSync(paths.json, `${JSON.stringify(card)}\n`);
    fs.writeFileSync(paths.fullJsonl, `${archives.get(characterId).join('\n')}\n`);
    legacyPaths.set(characterId, paths);
  }
  const setupMs = performance.now() - setupStart;
  const events = new Map(data.events.map((event) => [event.sourceId, event]));
  const archiveBytes = [...legacyPaths.values()].reduce((sum, paths) => sum + fs.statSync(paths.fullJsonl).size, 0);
  const mainPaths = legacyPaths.get('fixture-aurora');
  const maxScanBytes = 200 * 1024 * 1024;
  assert(archiveBytes < maxScanBytes);
  assert(!cards.get('fixture-aurora').records.some((record) => record.sourceId === data.oldNeedleSourceId));
  // Separate unmeasured warmups from one measured call per frozen query.
  for (const query of data.queries.slice(0, 3)) recallFullMemory(mainPaths, query.text, { limit: 8, maxScanBytes });
  const rows = [];
  const diagnosticTimes = [];
  const automaticTimes = [];
  const previousNow = Date.now;
  Date.now = () => fixedNow;
  try {
    for (const query of data.queries) {
      const start = performance.now();
      const candidates = recallFullMemory(legacyPaths.get(query.context.characterId), query.text, { limit: 8, maxScanBytes });
      diagnosticTimes.push(performance.now() - start);
      const automaticStart = performance.now();
      // V1 后端已移除：automatic 臂改为直接渲染导出的 V1 记忆卡，保持与冻结基线同口径的测量。
      const channelKey = CHANNELS[query.context.channel];
      const conversationKey = CONVERSATIONS[query.context.conversationId] ?? query.context.conversationId;
      const memoryPlatform = ['qq', 'bili', 'pet', 'local', 'douyin'].includes(channelKey) ? channelKey : 'restricted';
      const effectivePlatform = memoryPlatform === 'qq' && !conversationKey ? 'restricted' : memoryPlatform;
      const memoryText = renderMemoryCard(cards.get(query.context.characterId), {
        platform: effectivePlatform, conversationKey, config: normalizeMemoryCardConfig({}), maxChars: 1800,
      });
      automaticTimes.push(performance.now() - automaticStart);
      const lines = memoryText.split('\n').filter((line) => line.startsWith('- '));
      const renderedIds = lines.flatMap((line) => cards.get(query.context.characterId).records.filter((record) => line.includes(record.text)).map((record) => record.sourceId));
      rows.push({ queryId: query.queryId, split: query.split, group: query.group, lexicalClass: query.lexicalClass,
        diagnostic: measureCandidates(query, candidates.map((record) => record.sourceId), events),
        automatic: measureCandidates(query, [...new Set(renderedIds)], events),
        automaticMemoryChars: memoryText.length, automaticRenderedSources: renderedIds.length,
      });
    }
  } finally { Date.now = previousNow; }
  const groups = {};
  const selected = (predicate, key) => summarizeMetrics(rows.filter(predicate).map((row) => row[key]));
  for (const group of Object.keys(integrity.groupCounts)) groups[group] = { diagnostic: selected((row) => row.group === group, 'diagnostic'), automatic: selected((row) => row.group === group, 'automatic') };
  const splits = Object.fromEntries(['development', 'holdout'].map((split) => [split, { diagnostic: selected((row) => row.split === split, 'diagnostic'), automatic: selected((row) => row.split === split, 'automatic') }]));
  const overlap = Object.fromEntries(['meaningful_overlap', 'zero_v1_query_tokens'].map((lexicalClass) => [lexicalClass, { diagnostic: selected((row) => row.lexicalClass === lexicalClass, 'diagnostic'), automatic: selected((row) => row.lexicalClass === lexicalClass, 'automatic') }]));
  const canaryProbes = data.canarySourceIds.map((id) => {
    const event = events.get(id);
    const ids = recallFullMemory(mainPaths, event.text.match(/FICTIONAL_CANARY_[A-Z]+/)[0], { limit: 8, maxScanBytes }).map((record) => record.sourceId);
    return { sourceId: id, diagnosticReturned: ids.includes(id), queryAudience: 'not_supported_by_V1_diagnostic' };
  });
  const first = rows.find((row) => row.queryId === data.queries.find((query) => query.expectedSourceIds.includes(data.oldNeedleSourceId)).queryId);
  assert(first.diagnostic.sourceIds.includes(data.oldNeedleSourceId), 'Real old needle was not found by exported V1 full scan.');
  const sourceHashes = Object.fromEntries(['src/memory-card.js', 'src/core/context.js', 'src/character-persona.js'].map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))]));
  const report = {
    fixtureId: data.fixtureId, fixtureSha256: FROZEN_SHA256, node: process.version, mode: 'exported_V1_only', sourceHashes,
    integrity, setupMs, archiveBytes, maxScanBytes, hotRecords: Object.fromEntries([...cards].map(([id, card]) => [id, card.records.length])),
    budgets: { automaticMemoryChars: 1800, totalContextChars: 6000, diagnosticFinalCandidates: 8 },
    diagnostic: selected(() => true, 'diagnostic'), automatic: selected(() => true, 'automatic'), groups, splits, overlap,
    latency: { diagnostic: latencyStats(diagnosticTimes), automatic: latencyStats(automaticTimes), measuredDurationMs: [...diagnosticTimes, ...automaticTimes].reduce((sum, value) => sum + value, 0), conditions: 'single process, warm OS cache after 3 diagnostic warmups, 160 distinct fixed queries, nearest-rank P95; not cold start, SLA or threshold' },
    oldNeedle: { sourceId: data.oldNeedleSourceId, inArchive: true, inHotCard: false, diagnosticHitAt8: first.diagnostic.hitAt8, automaticHitAt8: first.automatic.hitAt8 },
    canaryProbes,
    notMeasured: { generatedAnswerSupport: null, hallucinationRate: null, noAnswerRestraint: null, productionAclSafety: null, productionLifecycleReplayRestore: null, productionSessionRevocation: null, modelUsage: null },
    limitations: [
      'Synthetic authored language and template background; no claim of human linguistic validation or production distribution.',
      'Hot fixture is built with real addMemoryRecord scoring and cap600; full JSONL uses every returned legacy record before eviction. Not an end-to-end ingestion/maintenance test.',
      'longTermCandidate is corpus ground truth metadata; V1 ignores it and can evict these records.',
      'Deleted/suppressed/quarantined source states remain in legacy projection because V1 has no lifecycle overlay here. This is raw diagnostic data, not production restore verification.',
      'Automatic context has no query search; source coverage is reconstructed by exact full text in rendered lines and bounded to first8 distinct lines, not production source-ID receipts.',
      'Diagnostic retrieval has no audience input or ACL enforcement. Forbidden counts describe raw candidates and do not demonstrate a platform send leak.',
      '160 queries cover five retrieval groups; remaining 13-category fault/session/lifecycle scenarios are metadata only.',
      'Character epoch is fixture1; no live role switch or revocation exercised.',
      'One hot-card reference clock; temporal labels are measured as source coverage, not temporal answer correctness.',
      'No models, generation, network, platform send, V2 kernel dependency or synonyms expansion.',
    ],
    proposedTargets: data.proposedTargets,
    rows,
  };
  fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'PASS', fixtureSha256: FROZEN_SHA256, node: process.version, integrity, archiveBytes, hotRecords: report.hotRecords, diagnostic: report.diagnostic, automatic: report.automatic, overlap, latency: report.latency, oldNeedle: report.oldNeedle, canaryProbes, report: path.relative(ROOT, path.join(runDir, 'report.json')) }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runV1().catch((error) => { console.error(`memory-v2-evaluation FAILED: ${error.stack}`); process.exitCode = 1; });
}
