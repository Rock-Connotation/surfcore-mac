import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-context');
fs.mkdirSync(root, { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'run-'));
process.env.DSH_HOME = fixture;
const { characterPaths, CHARACTERS_DIR } = await import('../src/character-persona.js');
const { buildCharacterContext, prepareCharacterContext } = await import('../src/core/context.js');
const { CONTEXT_FIELDS, digest } = await import('../src/core/memory-v2-contract.js');
const role = characterPaths('alpha');
for (const target of [role.memoryDir, path.dirname(role.lifeState), path.dirname(role.purposeState)]) fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: 1, name: 'Alpha' }));
fs.writeFileSync(role.manifest, JSON.stringify({ id: 'alpha', name: 'Alpha', version: 1 }));
fs.writeFileSync(role.persona, '# Alpha\n角色核心😀');
fs.writeFileSync(role.personaDaily, 'LEGACY_DAILY_PRIVATE_CANARY');
fs.writeFileSync(role.lifeState, JSON.stringify({ currentFocus: 'LEGACY_LIFE_PRIVATE_CANARY' }));
fs.writeFileSync(role.purposeState, JSON.stringify({ lastPurpose: 'LEGACY_PURPOSE_PRIVATE_CANARY' }));
// An unreadable old card proves the V2 branch never relies on its parsing or projection.
fs.mkdirSync(role.memoryJson);
const context = Object.fromEntries(CONTEXT_FIELDS.map(key => [key, key]));
Object.assign(context, { characterId: 'alpha', capturedEpoch: 1, channel: 'local', conversationKey: 'local:owner:conversation', purpose: 'conversation' });
const query = '下一次出门要带什么';
const prepared = { ...context, schemaVersion: 2, queryDigest: digest(query), expiresAt: Date.now() + 60000,
  eventWatermark: 9, evidenceIds: ['source:umbrella'], inputManifest: [{ type: 'event', eventId: 'source:umbrella' }],
  text: '已确认约定：下次出门不要忘记带雨伞。覆盖范围：这次约定。', budget: { estimated: true } };
const request = { characterId: 'alpha', characterEpoch: 1, scene: 'local', audience: { channel: 'local', conversationKey: context.conversationKey },
  memoryContext: context, preparedMemory: prepared, memoryQuery: query,
  verifyPreparedMemory: () => ({ ok: true }) };
const view = buildCharacterContext(request);
assert.equal(view.ok, true, JSON.stringify(view));
assert.equal(typeof view.then, 'undefined', 'the shared builder must remain synchronous');
assert.equal(view.memoryText, prepared.text);
assert.equal(view.memoryBackend, 'v2');
assert.doesNotMatch(view.text, /LEGACY_.*_PRIVATE_CANARY/);
assert.deepEqual(view.inputManifest, prepared.inputManifest);
assert.ok(view.text.length <= 6000);
for (const [patch, code] of [
  [{ memoryContext: null }, 'MEMORY_PREPARED_STALE'],
  [{ preparedMemory: null }, 'MEMORY_PREPARED_STALE'],
  [{ memoryQuery: query + '修改' }, 'MEMORY_QUERY_MISMATCH'],
  [{ audience: { channel: 'qq', conversationKey: context.conversationKey } }, 'MEMORY_PREPARED_STALE'],
  [{ preparedMemory: { ...prepared, expiresAt: Date.now() - 1 } }, 'MEMORY_PREPARED_STALE'],
  [{ preparedMemory: { ...prepared, deletionRevision: 'retired' } }, 'MEMORY_PREPARED_STALE'],
  [{ preparedMemory: { ...prepared, storeGeneration: 'retired' } }, 'MEMORY_PREPARED_STALE'],
  [{ budget: { memory: 1 } }, 'MEMORY_PREPARED_BUDGET'],
  [{ verifyPreparedMemory: undefined }, 'MEMORY_PREPARED_UNTRUSTED'],
  [{ verifyPreparedMemory: () => Promise.resolve({ ok: true }) }, 'MEMORY_PREPARED_UNTRUSTED'],
  [{ verifyPreparedMemory: value => ({ ok: digest(value) === digest(prepared) }), preparedMemory: { ...prepared, text: 'forged' } }, 'MEMORY_PREPARED_UNTRUSTED'],
]) {
  const result = buildCharacterContext({ ...request, ...patch });
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.ok(result.error && result.hint);
  assert.equal(result.text, '');
}
const priorRevision = view.personaRevision;
fs.writeFileSync(role.personaDaily, 'OTHER_PRIVATE_DAILY_CANARY');
assert.equal(buildCharacterContext(request).personaRevision, priorRevision, 'unscoped daily state must not alter V2 metadata');
for (let maxChars = 0; maxChars < 120; maxChars++) {
  const result = buildCharacterContext({ ...request, preparedMemory: { ...prepared, text: '' }, budget: { maxChars } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.text.length <= maxChars);
  assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
}
const { createMemoryService } = await import('../src/core/memory-v2-service.js');
const { createMemoryHost } = await import('../plugins/surfcore/lib/memory-v2-host.mjs');
const getCharacter = () => JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, 'current.json'), 'utf8'));
const authorization = Symbol('fixture-settings');
const service = createMemoryService({ stateDir: path.join(fixture, 'surfcore'), charactersDir: CHARACTERS_DIR, getCharacter,
  authorizeManagement: value => value === authorization });
assert.equal((await service.initialize()).ok, true);
const adminFacts = { channel: 'local', conversationKey: 'local:settings', sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', audiencePolicyId: 'management', providerRouteId: 'fixture-route', processingGrantId: 'management' };
const admin = async () => (await service.host.captureAdminContext(adminFacts, authorization)).context;
const policy = { policyId: 'local-policy', approved: true, audiences: [['local', context.conversationKey, 'local:owner']], processingGrants: [{ grantId: 'local-grant', providerRouteId: 'fixture-route' }] };
let status = await service.getStatus();
assert.equal((await service.host.configurePolicy(await admin(), policy, status.revision, 'ctx:policy')).ok, true);
status = await service.getStatus();
assert.equal((await service.applyMemoryAction(await admin(), { type: 'enable_shadow', enabled: true }, status.revision, 'ctx:shadow')).ok, true);
const host = createMemoryHost({ memoryService: service, getCharacter,
  resolveIdentity: ({ channel, conversationKey, purpose }) => ({ channel, conversationKey, sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', providerRouteId: 'fixture-route', purpose }) });
const adapter = host.createAdapter({ channel: 'local', principal: { owner: 'fixture' }, canBindInput: true });
try {
  const captured = await adapter.capture({ conversationKey: context.conversationKey });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal((await adapter.ingest(captured.handle, [{ eventId: 'ctx:umbrella', operationId: 'ctx:source-operation', sourceKey: 'ctx:source', producerId: 'context-test', segmentId: 'ctx:segment', producerSeq: 1, content: '下次出门不要忘记带雨伞。', subject: 'self', certainty: 'reported', attribution: 'statement' }], 'ctx:ingest')).ok, true);
  const composed = await prepareCharacterContext(request, { adapter, handle: captured.handle, query });
  assert.equal(composed.ok, true, JSON.stringify(composed));
  assert.match(composed.text, /不要忘记带雨伞/);
  assert.ok(composed.preparedHandle && composed.memoryHandle === captured.handle);
  assert.equal(composed.inputManifest.length, 1);
  assert.equal((await prepareCharacterContext({ ...request, audience: { channel: 'qq', conversationKey: context.conversationKey } }, { adapter, handle: captured.handle, query })).code, 'MEMORY_PREPARED_STALE');
  status = await service.getStatus();
  assert.equal((await service.applyMemoryAction(await admin(), { type: 'revoke_policy', policyId: policy.policyId }, status.revision, 'ctx:revoke')).ok, true);
  const revoked = await prepareCharacterContext(request, { adapter, handle: captured.handle, query });
  assert.equal(revoked.ok, false);
  assert.ok(revoked.code && revoked.hint);
  assert.ok(!revoked.text);
} finally {
  host.close();
  await service.close();
}
fs.writeFileSync(path.join(CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'beta', epoch: 2, name: 'Beta' }));
assert.equal(buildCharacterContext(request).code, 'CHARACTER_EPOCH_STALE');
assert.equal(buildCharacterContext({ ...request, allowStale: true }).code, 'CHARACTER_EPOCH_STALE');
console.log(JSON.stringify({ ok: true, checks: ['synchronous-prepared-only', 'no-legacy-card-read', 'no-unscoped-life-purpose-daily', 'all-stamps-query-and-audience', 'whole-evidence-budget', 'surrogate-safe-budget', 'no-private-metadata-dependency', 'role-change'], fixture }));
