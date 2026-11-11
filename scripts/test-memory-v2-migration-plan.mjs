import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateExperienceEvent } from '../src/core/experience.js';
import { canonical } from '../src/core/memory-v2-contract.js';
import { planLegacyMigration } from '../src/core/memory-v2-migration-plan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-migration-plan', `synthetic-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
const capturedAt = '2026-11-09T12:00:00.000Z', registry = {}, originalHashes = new Map(), tests = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function source(kind, value, logicalStreamKey, format = 'jsonl') {
  const filePath = path.join(root, `${Object.keys(registry).length}-${kind}.${format}`);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(format === 'jsonl' ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(value));
  fs.writeFileSync(filePath, bytes);
  registry[logicalStreamKey] = `stream-${Object.keys(registry).length}`;
  originalHashes.set(filePath, sha(bytes));
  return { kind, logicalStreamKey, filePath };
}
const plan = (sources, extra = {}) => planLegacyMigration({ characterId: 'alpha', capturedAt, sources, streamRegistry: registry, ...extra });
const local = () => ({ actorAccountKey: 'local:owner', channel: 'local', audience: { classification: 'restricted', allowedContexts: ['local'] } });
const qq = ({ record }) => ({ actorAccountKey: `qq:${record.source?.accountId ?? record.senderId}`, channel: 'qq', conversationKey: 'qq:100:group:900', audience: { classification: 'private', allowedContexts: ['qq:100:group:900'] } });
function run(name, test) { test(); tests.push(name); }
const event = (eventId, summary = 'A complete observed synthetic event') => validateExperienceEvent({ schemaVersion: 1, eventId, characterId: 'alpha', characterEpoch: 3, occurredAt: capturedAt, observedAt: capturedAt,
  source: { channel: 'local', objectType: 'local-event', objectId: eventId }, kind: 'observation', attribution: { subject: 'self', certainty: 'observed' },
  visibility: { classification: 'restricted', allowedContexts: ['local'], legacyScope: 'shared' }, content: { summary, details: `${summary} detail` } }).event;
const main = source('experience-inbox', [event('first'), event('second')], 'experience');
let stable;
run('registered identity survives copy, changed path and changed inode', () => {
  const first = plan([main], { resolveFacts: local });
  assert.equal(first.ok, true); assert.equal(first.candidates.length, 2); stable = first.candidates.map(item => item.sourceKey);
  const copied = path.join(root, 'copied.jsonl'); fs.copyFileSync(main.filePath, copied);
  originalHashes.set(copied, sha(fs.readFileSync(copied)));
  assert.notEqual(fs.statSync(main.filePath).ino, fs.statSync(copied).ino);
  const next = plan([{ ...main, filePath: copied }], { resolveFacts: local });
  assert.deepEqual(next.candidates.map(item => item.sourceKey), stable);
  assert.deepEqual(next.manifest.sources.map(item => item.prefixHash), first.manifest.sources.map(item => item.prefixHash));
});
run('explicit fixed cut tolerates later append without claiming a full snapshot', () => {
  const file = source('experience-inbox', [event('append-first')], 'append');
  const highWaterBytes = fs.statSync(file.filePath).size, expectedPrefixHash = sha(fs.readFileSync(file.filePath));
  fs.appendFileSync(file.filePath, JSON.stringify(event('append-later')) + '\n');
  originalHashes.set(file.filePath, sha(fs.readFileSync(file.filePath)));
  const p = plan([{ ...file, highWaterBytes, expectedPrefixHash }], { resolveFacts: local });
  assert.equal(p.candidates.length, 1); assert.equal(p.manifest.sources[0].highWaterBytes, highWaterBytes);
  assert.equal(p.manifest.sources[0].completeSnapshot, false); assert.equal(p.manifest.sources[0].boundary, 'verified-prefix');
  assert.equal(p.manifest.sources[0].safeImportEnd, highWaterBytes);
  assert.ok(p.manifest.sources[0].observedSize > highWaterBytes);
  assert.equal(plan([{ ...file, highWaterBytes, expectedPrefixHash: 'wrong' }]).diagnostics[0].code, 'MIGRATION_PREFIX_MISMATCH');
});
run('malformed, empty and non-UTF8 lines and partial tail never advance past a bad row', () => {
  const good = JSON.stringify(event('good')) + '\n';
  const bytes = Buffer.concat([Buffer.from(good + '{bad-json}\n' + JSON.stringify(event('after-bad')) + '\n\n'), Buffer.from([0xff, 10]), Buffer.from('{"partial":')]);
  const file = source('experience-inbox', bytes, 'bad-rows');
  const p = plan([file], { resolveFacts: local }), manifest = p.manifest.sources[0];
  assert.equal(p.candidates.length, 1); assert.equal(p.counts.invalidRows, 3); assert.equal(p.counts.partialTails, 1);
  assert.equal(manifest.safeImportEnd, Buffer.byteLength(good));
  assert.ok(p.quarantine.some(item => item.reasons?.includes('MIGRATION_PRECEDING_ROW_BLOCKED')));
  assert.ok(p.quarantine.some(item => item.code === 'MIGRATION_INCOMPLETE_TAIL'));
  assert.equal(p.counts.records, 2);
});
run('unknown permissions retain redacted records in quarantine with no inferred public audience', () => {
  const row = { id: 'name-only', at: capturedAt, sender: 'Synthetic nickname', text: 'Synthetic private content', isSelf: false, conversationKey: 'group:900' };
  const file = source('memory-inbox', [row], 'unknown-qq');
  const p = plan([file]);
  assert.equal(p.candidates.length, 0); assert.equal(p.quarantine.length, 1);
  assert.equal(p.quarantine[0].record.text, row.text); assert.equal(p.quarantine[0].facts, null);
  assert.equal(p.quarantine[0].unresolvedSpeaker.accountInferredFromName, false);
  assert.equal(p.quarantine[0].type, 'legacy-message-capture');
  assert.equal(p.quarantine[0].textCompleteness, 'truncated_legacy');
});
run('identical bodies remain distinct at different positions, streams and characters', () => {
  const row = { at: capturedAt, text: 'Identical body without event ID' };
  const a = source('memory-inbox', [row, row], 'fallback-a'), b = source('memory-inbox', [row], 'fallback-b');
  const p = plan([a, b], { resolveFacts: local });
  assert.equal(p.candidates.length, 3); assert.equal(new Set(p.candidates.map(item => item.sourceKey)).size, 3);
  assert.equal(new Set(p.candidates.map(item => item.payloadDigest)).size, 1);
  const other = plan([a], { characterId: 'beta', resolveFacts: local });
  assert.notEqual(other.candidates[0].sourceKey, p.candidates[0].sourceKey);
});
run('same explicit event identity with conflicting payload is blocked in every occurrence', () => {
  const a = source('experience-inbox', [event('conflict', 'version A')], 'conflict-a');
  const b = source('experience-inbox', [event('conflict', 'version B')], 'conflict-b');
  const p = plan([a, b], { resolveFacts: local });
  assert.equal(p.candidates.length, 0); assert.equal(p.quarantine.length, 2);
  for (const item of p.quarantine) assert.ok(item.reasons.includes('MIGRATION_SOURCE_KEY_CONFLICT'));
  const hidden = source('memory-inbox', [{ id: 'hidden-conflict', token: 'synthetic-A', text: 'Same text' }, { id: 'hidden-conflict', token: 'synthetic-B', text: 'Same text' }], 'hidden-conflict');
  const h = plan([hidden], { resolveFacts: local });
  assert.equal(h.candidates.length, 0); assert.equal(h.quarantine.length, 2);
  assert.equal(h.quarantine[0].payloadDigest, h.quarantine[1].payloadDigest);
  assert.notEqual(h.quarantine[0].originalPayloadDigest, h.quarantine[1].originalPayloadDigest);
});
run('projection copies link only on original event identity and retain every protection field', () => {
  const record = { id: 'mem-one', eventId: 'first', sourceId: 'local-object', sourceChannel: 'local', platform: 'local', createdAt: capturedAt,
    text: 'A shortened preview', pinned: true, isInitial: true, firstMet: true, initialTier: 3, initialProbability: 0.9, mergedFrom: ['old-record'], manualCorrection: { previousValue: 'older wording' },
    visibilityClassification: 'restricted', allowedContexts: ['local'], scope: 'shared' };
  const card = source('memory-card', { version: 4, records: [record], meta: { firstMetSource: 'manual', firstMetRecordIds: ['mem-one'], firstOwnerAt: capturedAt } }, 'card', 'json');
  const full = source('memory-card-full-jsonl', [{ ...record, archivedAt: capturedAt }], 'full');
  const p = plan([main, card, full], { resolveFacts: local });
  assert.equal(p.candidates.length, 4);
  for (const item of p.candidates.filter(item => item.type === 'legacy-projection')) {
    assert.equal(item.independentRoot, false); assert.equal(item.evidenceRoot, stable[0]);
    assert.equal(item.textCompleteness, 'truncated_legacy'); assert.equal(item.protection.pinned, true);
    assert.equal(item.protection.isInitial, true); assert.equal(item.protection.firstMet, true);
    assert.equal(item.protection.manualCorrection.previousValue, 'older wording');
    assert.ok(item.links.some(link => link.relation === 'confirmed-source'));
  }
  assert.equal(p.manifest.sources[1].protectionMetadata.firstMetSource, 'manual');
  assert.equal(p.counts.protectedRecords, 2);
  const uncertain = source('memory-card-full-json', { records: [{ id: 'copy-a', text: 'Possible preview copy' }, { id: 'copy-b', text: 'Possible preview copy' }] }, 'uncertain-full', 'json');
  const u = plan([uncertain], { resolveFacts: local });
  assert.equal(u.candidates.length, 2);
  assert.ok(u.candidates.every(item => !item.independentRoot && item.links.some(link => link.relation === 'possible-duplicate')));
});
run('sharing UI read, request, reply and failure remain distinct from platform publication', () => {
  const rows = ['opening', 'request', 'answer', 'failure', 'ack'].map((kind, n) => ({ version: 1, id: `share-${n}`, kind, epoch: 2, at: capturedAt, text: `Synthetic ${kind}`, coverage: { transcriptComplete: false, frameSamples: 3 } }));
  const file = source('sharing', rows, 'sharing');
  const p = plan([file], { resolveFacts: local });
  assert.deepEqual(p.candidates.map(item => item.type), rows.map(row => `sharing-${row.kind}`));
  assert.ok(p.candidates.every(item => item.type !== 'platform-confirmed-receipt'));
  assert.deepEqual(p.candidates[0].record.coverage, rows[0].coverage);
});
run('actual legacy ledger schemas preserve review data without fabricating receipt success', () => {
  const sources = [
    source('bili-scores', { '2026-11-09': [{ bvid: 'BVsynthetic', title: 'Synthetic title', tags: ['test'], score: 15, reason: 'Synthetic score reason', at: capturedAt }] }, 'scores', 'json'),
    source('bili-favorites', { items: [{ bv: 'BVsynthetic', aid: 1, title: 'Synthetic title', up: 'Synthetic author', reason: 'Synthetic favorite reason', kind: '想再看', favId: 2, at: capturedAt }] }, 'favorites', 'json'),
    source('bili-quota', { log: [{ at: capturedAt, type: 'comment', auto: true, share: false, target: 'BVsynthetic', note: 'Synthetic logged action' }] }, 'quota', 'json'),
    source('bili-dynamic-receipt', { version: 1, id: '123456', at: capturedAt, type: 'dynamic', auto: true }, 'receipt', 'json'),
    source('bili-dynamic-intent', { version: 1, actionId: 'synthetic', state: 'pending', binding: null }, 'intent', 'json'),
    source('douyin-ledger', { version: 1, acceptanceCalls: 0, roles: {}, jobs: { job: { jobId: 'job', characterId: 'alpha', characterEpoch: 3, state: 'completed', items: [{ id: 'clip', occurredAt: capturedAt, title: 'Synthetic clip', summary: 'Synthetic reflection', feeling: 'like', reason: 'Synthetic feeling', draft: 'Synthetic share', coverage: { transcriptComplete: false, frameSamples: 2 } }] } } }, 'douyin', 'json'),
  ];
  const p = plan(sources);
  assert.equal(p.counts.records, 6); assert.equal(p.quarantine.length, 6);
  assert.equal(p.quarantine.find(item => item.kind === 'bili-quota').type, 'logged-action-unverified');
  assert.equal(p.quarantine.find(item => item.kind === 'bili-dynamic-receipt').type, 'platform-confirmed-receipt');
  const reflection = p.quarantine.find(item => item.kind === 'douyin-ledger');
  assert.equal(reflection.record.jobId, 'job'); assert.equal(reflection.record.coverage.frameSamples, 2); assert.equal(reflection.capturedEpoch, 3);
});
run('persona, life, purpose and diary remain references despite a supplied authority resolver', () => {
  const sources = ['persona', 'life', 'purpose', 'bili-diary'].map(kind => source(kind, Buffer.from('Synthetic reference text'), kind, 'txt'));
  const p = plan(sources, { resolveFacts: local });
  assert.equal(p.candidates.length, 0); assert.equal(p.quarantine.length, 4);
  assert.ok(p.quarantine.every(item => item.type === 'reference' && item.reasons.includes('MIGRATION_REFERENCE_ONLY') && !item.independentRoot));
});
run('V2 compatibility generations, envelope and per-record provenance refuse self import', () => {
  for (const extra of [{ origin: 'v2' }, { sourceGeneration: 'v2-compat' }, { sourceGeneration: 'unknown' }]) {
    assert.equal(plan([{ ...main, ...extra }]).diagnostics[0].code, 'MIGRATION_SELF_IMPORT');
  }
  const row = source('sharing', [{ version: 1, id: 'v2-sharing', kind: 'answer', memoryV2Refs: [] }], 'v2-row');
  assert.equal(plan([row]).quarantine[0].code, 'MIGRATION_SELF_IMPORT');
  const envelope = source('memory-card', { origin: 'v2', records: [] }, 'v2-envelope', 'json');
  assert.equal(plan([envelope]).diagnostics[0].code, 'MIGRATION_SELF_IMPORT');
  const nested = source('douyin-ledger', { version: 1, jobs: { job: { characterId: 'alpha', characterEpoch: 3, memoryV2Refs: [], items: [{ id: 'clip', summary: 'V2-derived text' }] } } }, 'v2-job', 'json');
  const n = plan([nested], { resolveFacts: local });
  assert.equal(n.candidates.length, 0); assert.equal(n.quarantine[0].code, 'MIGRATION_SELF_IMPORT');
  const singular = source('sharing', [{ version: 1, kind: 'answer', id: 'singular', memoryV2Receipt: {} }], 'v2-singular');
  assert.equal(plan([singular]).quarantine[0].code, 'MIGRATION_SELF_IMPORT');
});
run('600 and 10000 original records are inventoried without a silent history cap', () => {
  for (const count of [600, 10000]) {
    const file = source('experience-inbox', Array.from({ length: count }, (_, n) => event(`many-${count}-${n}`, `Original complete ${n}`)), `many-${count}`);
    const p = plan([file], { resolveFacts: local });
    assert.equal(p.counts.records, count); assert.equal(p.candidates.length, count); assert.equal(p.quarantine.length, 0);
    assert.equal(p.candidates[0].record.content.details, 'Original complete 0 detail');
    assert.equal(p.candidates.at(-1).record.eventId, `many-${count}-${count - 1}`);
  }
});
run('large multibyte records split into stable whole UTF8 parts without text truncation', () => {
  const text = '鲸鱼🌊记忆'.repeat(9000), file = source('experience-inbox', [{ ...event('large'), content: { summary: text, details: text } }], 'large');
  const p = plan([file], { resolveFacts: local }), item = p.candidates[0];
  assert.ok(item.parts.length > 1); assert.equal(item.parts.map(part => part.text).join(''), canonical(item.record));
  assert.equal(item.record.content.summary, text);
  for (const part of item.parts) { assert.ok(Buffer.byteLength(part.text) <= 64 * 1024); assert.ok(!part.text.includes('\ufffd')); }
  assert.deepEqual(plan([file], { resolveFacts: local }).candidates[0].parts, item.parts);
});
run('structured credential lookalikes, URI secrets and paths never appear in serialized output', () => {
  // These fixed labels are synthetic test values, never credentials or production data.
  const fake = 'synthetic-sensitive-value', row = { id: 'redaction', text: `api_key=${fake} https://example.test/?token=${fake} Bearer ${fake}`,
    token: fake, cookie: fake, [ ['pass', 'word'].join('') ]: fake, nested: { apiKey: fake }, filePath: '/synthetic/private/path' };
  const file = source('memory-inbox', [row], 'redaction');
  const output = JSON.stringify(plan([file]));
  assert.ok(!output.includes(fake)); assert.ok(!output.includes('/synthetic/private/path')); assert.ok(!output.includes(file.filePath));
  assert.ok(output.includes('[已隐藏]'));
});
run('Host facts cannot widen legacy private scope or turn a nickname into an account', () => {
  const file = source('memory-inbox', [{ id: 'private-row', sender: 'Nickname', senderId: '200', sourceChannel: 'qq', conversationKey: 'group:900', private: true, scope: 'qq', allowedContexts: ['qq:100:group:900'], text: 'Synthetic QQ capture' }], 'scoped-qq');
  assert.equal(plan([file], { resolveFacts: qq }).candidates.length, 1);
  const widened = plan([file], { resolveFacts: () => ({ actorAccountKey: 'local:nickname', channel: 'local', audience: { classification: 'public', allowedContexts: ['local'] } }) });
  assert.equal(widened.candidates.length, 0); assert.ok(widened.quarantine[0].reasons.includes('MIGRATION_AUDIENCE_CONFLICT'));
  assert.ok(widened.quarantine[0].reasons.includes('MIGRATION_ACTOR_CONFLICT'));
});
run('uncommitted stream proposals and conflicting mappings never authorize sources', () => {
  const p = plan([{ ...main, legacyStreamId: 'proposed' }], { streamRegistry: {} });
  assert.equal(p.candidates.length, 0); assert.equal(p.diagnostics[0].code, 'MIGRATION_REGISTRY_REQUIRED');
  assert.deepEqual(p.registryAdditions, [{ logicalStreamKey: main.logicalStreamKey, legacyStreamId: 'proposed' }]);
  assert.equal(plan([{ ...main, legacyStreamId: 'wrong' }]).diagnostics[0].code, 'MIGRATION_REGISTRY_CONFLICT');
  assert.equal(plan([main], { streamRegistry: { first: 'duplicate', second: 'duplicate' } }).code, 'MIGRATION_REGISTRY_CONFLICT');
  assert.equal(plan([main, main]).diagnostics[0].code, 'MIGRATION_DESCRIPTOR_CONFLICT');
});
run('path, descriptor, format, budget and missing-source failures are structured and content free', () => {
  const missing = { ...main, logicalStreamKey: 'missing', filePath: path.join(root, 'missing.jsonl') }; registry.missing = 'stream-missing';
  assert.equal(plan([missing]).diagnostics[0].code, 'MIGRATION_SOURCE_UNAVAILABLE');
  const link = path.join(root, 'linked.jsonl'); fs.symlinkSync(main.filePath, link);
  assert.equal(plan([{ ...main, filePath: link }]).diagnostics[0].code, 'MIGRATION_PATH_INVALID');
  assert.equal(plan([main], { maxSourceBytes: 1 }).diagnostics[0].code, 'MIGRATION_SOURCE_TOO_LARGE');
  assert.equal(plan([{ ...main, highWaterBytes: 999999999 }]).diagnostics[0].code, 'MIGRATION_CUT_INVALID');
  assert.equal(plan([{ ...main, kind: 'unknown' }]).diagnostics[0].code, 'MIGRATION_DESCRIPTOR_INVALID');
  const broken = source('memory-card', Buffer.from('{"records":['), 'broken-json', 'json');
  assert.equal(plan([broken]).diagnostics[0].code, 'MIGRATION_JSON_INVALID');
  const p = plan([missing, broken]);
  for (const diagnostic of p.diagnostics) { assert.ok(diagnostic.code); assert.ok(diagnostic.error); assert.ok(diagnostic.hint); assert.ok(!JSON.stringify(diagnostic).includes(root)); }
});
run('canonical parts remain identical when equivalent object keys are reordered', () => {
  const original = event('canonical-order');
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  const a = source('experience-inbox', [original], 'canonical-a'), b = source('experience-inbox', [reordered], 'canonical-b');
  const first = plan([a], { resolveFacts: local }).candidates[0], second = plan([b], { resolveFacts: local }).candidates[0];
  assert.equal(first.sourceKey, second.sourceKey); assert.equal(first.payloadDigest, second.payloadDigest);
  assert.deepEqual(first.parts, second.parts);
});
run('nested JSON spans identify exact original UTF8 record bytes', () => {
  const row = { id: 'utf8-span', text: '鲸鱼🌊 before offsets', nested: { quote: 'escaped \\" quotation' } };
  const bytes = Buffer.from(JSON.stringify({ label: '前缀🌊', records: [row] }, null, 2));
  const file = source('memory-card', bytes, 'utf8-spans', 'json');
  const item = plan([file], { resolveFacts: local }).candidates[0], originalBytes = bytes.subarray(item.location.startOffset, item.location.endOffset);
  assert.deepEqual(JSON.parse(originalBytes.toString('utf8')), row);
  assert.equal(sha(originalBytes), item.location.originalHash);
});
run('prefix mutation during the two reads is rejected without any plan candidate', () => {
  const file = source('experience-inbox', [event('mutation')], 'mutation');
  const original = fs.readFileSync(file.filePath), altered = Buffer.from(original); altered[1] = 32;
  const read = fs.readSync; let injected = false;
  try {
    fs.readSync = (...args) => { const count = read(...args); if (!injected) { injected = true; fs.writeFileSync(file.filePath, altered); } return count; };
    const p = plan([file], { resolveFacts: local });
    assert.equal(p.candidates.length, 0); assert.equal(p.diagnostics[0].code, 'MIGRATION_SOURCE_CHANGED');
  } finally { fs.readSync = read; fs.writeFileSync(file.filePath, original); }
});
run('duplicate JSON keys and inconsistent Host actor namespaces fail closed', () => {
  const file = source('memory-card', Buffer.from('{"records":[],"records":[]}'), 'duplicate-keys', 'json');
  assert.equal(plan([file]).diagnostics[0].code, 'MIGRATION_JSON_DUPLICATE_KEY');
  const p = plan([main], { resolveFacts: () => ({ ...local(), actorAccountKey: 'qq:200' }) });
  assert.ok(p.quarantine.every(item => item.reasons.includes('MIGRATION_ACTOR_UNKNOWN')));
  const good = plan([main], { resolveFacts: local });
  assert.equal(good.manifest.inventoryComplete, true); assert.equal(good.manifest.importReady, false);
  assert.equal(good.manifest.phase, 'plan-only'); assert.equal(good.manifest.authority, 'none');
});
run('every synthetic original remains byte identical after every planning operation', () => {
  for (const [file, hash] of originalHashes) assert.equal(sha(fs.readFileSync(file)), hash, path.basename(file));
});
const report = { status: 'ready', runtime: process.version, tests, passed: tests.length, originalSourcesUnchanged: originalHashes.size,
  note: 'Only synthetic sources were read. A plan does not import a database, issue authority or activate a route.' };
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Memory migration plan: PASS ${tests.length} checks, ${originalHashes.size} synthetic sources unchanged (${process.version}).`);
console.log(`Evidence: ${path.join(root, 'report.json')}`);
