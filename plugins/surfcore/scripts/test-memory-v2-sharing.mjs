import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v2-sharing-')));
process.env.DSH_HOME = root;
const { characterPaths, CHARACTERS_DIR } = await import('../../../src/character-persona.js');
const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
const { COMPANION_ROUTE } = await import('../lib/douyin-companion-model.mjs');
const routeId = deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId;
const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');
const { createCompanionSharing } = await import('../lib/companion-sharing.mjs');
const { createSharingStore } = await import('../lib/companion-sharing-store.mjs');
const { createSharingController } = await import('../lib/companion-sharing-controller.mjs');
const { createDouyinCompanionStore } = await import('../lib/douyin-companion-ledger.mjs');
const rolePaths = characterPaths('alpha');
fs.mkdirSync(path.dirname(rolePaths.manifest), { recursive: true });
fs.writeFileSync(rolePaths.manifest, JSON.stringify({ id: 'alpha', name: 'Alpha', version: 1 }));
fs.writeFileSync(rolePaths.persona, '# Alpha\n温柔、有主见的小白鲸。ALPHA_SYSTEM_PERSONA_CANARY');
fs.writeFileSync(rolePaths.personaDaily, 'LEGACY_DAILY_PRIVATE_CANARY');
const foreignPaths = characterPaths('beta');
fs.mkdirSync(path.dirname(foreignPaths.persona), { recursive: true });
fs.writeFileSync(foreignPaths.persona, 'FOREIGN_ROLE_PRIVATE_CANARY');
let role = { id: 'alpha', epoch: 1, name: 'Alpha' };
function setRole(value) { role = value; fs.writeFileSync(path.join(CHARACTERS_DIR, 'current.json'), JSON.stringify(role)); }
setRole(role);
const context = { characterId: role.id, characterEpoch: role.epoch };
const now = () => new Date('2026-11-07T06:00:00Z');
const conversationKey = 'local:companion-sharing:alpha';
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = value => { assert.equal(value?.ok, false, JSON.stringify(value)); assert.ok(value.code && value.error && value.hint); return value; };
const jobId = 'douyin-11111111-1111-4111-8111-111111111111';
const item = { id: '123456', url: 'https://www.douyin.com/video/123456', title: '纸箱里的猫', durationMs: 17000,
  occurredAt: now().toISOString(), state: 'partial', memorySaved: true, partial: true,
  coverage: { status: 'partial', transcriptComplete: true, missingRanges: 0, visualCoverage: 'sparse', frameSamples: 3, warningCount: 0, acceptanceQualified: true },
  feeling: 'like', reason: '把纸箱当成窝。', summary: '猫钻进纸箱。', draft: '' };
const management = Symbol('fixture-settings');
let scenario = 0;
async function fixture({ model, patchAdapter = value => value, metadata = true, runBeforeSend = true, seedOpening = true, sourceFromDouyin = false, allowLocal = true } = {}) {
  const stateDir = path.join(root, `scenario-${++scenario}`), getCharacter = () => role;
  let clock = Date.now();
  const kernel = createMemoryService({ stateDir, now: () => clock, charactersDir: path.join(stateDir, 'characters'), getCharacter, authorizeManagement: value => value === management });
  good(await kernel.initialize());
  const facts = { channel: 'local', conversationKey, sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', providerRouteId: routeId, purpose: 'conversation' };
  const admin = async () => good(await kernel.host.captureAdminContext({ ...facts, audiencePolicyId: 'management', processingGrantId: 'management' }, management)).context;
  let state = good(await kernel.getStatus());
  good(await kernel.host.configurePolicy(await admin(), { policyId: 'sharing-policy', approved: true, audiences: [...(allowLocal ? [['local', conversationKey, 'local:owner']] : []), ...(sourceFromDouyin ? [['douyin', 'douyin:fixture-source', 'douyin:owner']] : [])], processingGrants: [{ grantId: 'local-grant', providerRouteId: routeId }] }, state.revision, 'fixture:policy'));
  if (!allowLocal) {
    state = good(await kernel.getStatus());
    good(await kernel.host.configurePolicy(await admin(), { policyId: 'independent-local-policy', approved: true, audiences: [['local', conversationKey, 'local:owner']], processingGrants: [{ grantId: 'local-grant', providerRouteId: routeId }] }, state.revision, 'fixture:local-policy'));
  }
  state = good(await kernel.getStatus());
  good(await kernel.applyMemoryAction(await admin(), { type: 'enable_shadow', enabled: true }, state.revision, 'fixture:shadow'));
  const host = createMemoryHost({ memoryService: kernel, getCharacter, now: () => clock, handleTtlMs: 300000,
    resolveIdentity: ({ channel, conversationKey, purpose }) => ({ channel, conversationKey, purpose, sourceAccountKey: channel === 'douyin' ? 'douyin:owner' : 'local:owner', requesterAccountKey: channel === 'douyin' ? 'douyin:owner' : 'local:owner', providerRouteId: routeId }) });
  const originalAdapter = host.createAdapter({ channel: 'local', principal: { owner: 'fixture' }, canBindInput: true });
  const adapter = patchAdapter(originalAdapter), blocked = [];
  const ledger = createDouyinCompanionStore(stateDir, () => now().toISOString());
  function resetBudget(proof = {}) {
    ledger.writeLedger({ version: 1, acceptanceCalls: 0, roles: { '"alpha"': { characterId: 'alpha', acceptedEpoch: 1, enabled: true, paused: false, lastError: null, days: {} } },
      jobs: { [jobId]: { jobId, mode: 'acceptance', state: 'partial', phase: 'finished', characterId: 'alpha', characterEpoch: 1,
        createdAt: now().toISOString(), updatedAt: now().toISOString(), completedAt: now().toISOString(), calls: 0, acceptanceQualified: true, scheduleDate: null, scheduleWindow: null, items: [item], ...proof } } });
  }
  resetBudget();
  const sourceAdapter = sourceFromDouyin ? host.createAdapter({ channel: 'douyin', principal: { source: 'fixture' }, canBindInput: true }) : originalAdapter;
  const captured = good(await sourceAdapter.capture({ conversationKey: sourceFromDouyin ? 'douyin:fixture-source' : conversationKey }));
  const sourceReceipt = good(await sourceAdapter.ingest(captured.handle, [{ eventId: 'fixture:opening', operationId: 'fixture:source', sourceKey: 'fixture:opening', producerId: 'sharing-fixture', segmentId: 'fixture:segment', producerSeq: 1, content: '猫钻进纸箱，只有三帧稀疏取样。', certainty: 'observed', attribution: 'action' }], 'fixture:opening-ingest'));
  good(sourceAdapter.release(captured.handle));
  assert.ok(sourceReceipt.eventRefs?.length, 'kernel must export canonical committed eventRefs');
  const sharingStore = createSharingStore(stateDir), openingId = `${jobId}:${item.id}`;
  const opening = { version: 1, kind: 'opening', id: openingId, epoch: 1, at: now().toISOString(), jobId, sourceId: item.id, sourceTitle: item.title, occurredAt: item.occurredAt,
    text: '猫把纸箱当成了家。', question: '你也喜欢猫吗？', coverage: { transcriptComplete: true, frameSamples: 3 }, memoryV2Refs: sourceReceipt.eventRefs, memoryV2Receipts: [sourceReceipt] };
  if (seedOpening) sharingStore.append('alpha', opening);
  let calls = 0;
  const options = { stateDir, getCharacter, now, readiness: async () => ({ ok: true }), buildContext: () => { throw new Error('V2 read legacy context'); },
    memoryV2: { adapter, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: value => blocked.push(value) },
    ...(metadata ? { getModelRequest: input => ({ requestId: input.jobId, jobId: input.jobId, category: 'other', purpose: 'conversation', role: input.characterId, epoch: input.characterEpoch, providerRouteId: input.providerRouteId, model: input.model, estimatedTokens: 1000 }) } : {}),
    modelReply: async input => { calls++; if (runBeforeSend) good(await input.beforeSend()); assert.match(input.system, /ALPHA_SYSTEM_PERSONA_CANARY/); assert.doesNotMatch(input.system + input.prompt, /LEGACY_.*_PRIVATE_CANARY|FOREIGN_ROLE_PRIVATE_CANARY/); return input.admitNetwork(() => model ? model(input) : { text: '纸箱像一个小窝。', finishReason: 'stop' }, { signal: input.signal }); } };
  let sharing = createCompanionSharing(options);
  const controller = () => createSharingController({ service: sharing, getCharacter });
  async function http(body, customController = controller()) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify({ ...context, ...body }))] : []);
    req.method = body ? 'POST' : 'GET'; req.headers = { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}) };
    let payload, status;
    const res = { writeHead(code) { status = code; }, end(value) { payload = JSON.parse(value); } };
    assert.equal(await customController.handle(req, res, new URL('http://localhost/dsh-surfcore/api/douyin/companion-sharing')), true);
    return { status, body: payload };
  }
  const reply = (text = '纸箱里的猫真可爱。', requestId = crypto.randomUUID()) => http({ action: 'reply', openingId, requestId, text });
  const action = async value => { const state = good(await kernel.getStatus()); return good(await kernel.applyMemoryAction(await admin(), value, state.revision, `fixture:control:${crypto.randomUUID()}`)); };
  return { stateDir, kernel, host, adapter, originalAdapter, ledger, resetBudget, sourceReceipt, opening, sharingStore, openingId, options, blocked, http, reply, action,
    advance(ms) { clock += ms; }, get sharing() { return sharing; }, get calls() { return calls; }, async restart() { await sharing.dispose(); sharing = createCompanionSharing(options); },
    async close() { await sharing.dispose(); host.close(); await kernel.close(); } };
}

const checks = [];
{
  const f = await fixture({ seedOpening: false });
  let old, late, fresh, beta;
  try {
    const sourceIds = f.sourceReceipt.eventRefs.map(ref => ref.id);
    old = good(await f.originalAdapter.capture({ conversationKey }));
    late = good(await f.originalAdapter.capture({ conversationKey }));
    assert.equal(old.sourceStamp.capturedEpoch, 1);
    assert.equal(old.sourceStamp.conversationKey, conversationKey);
    assert.deepEqual(good(await f.originalAdapter.search(old.handle, '纸箱')).records.map(row => row.id), sourceIds);
    const first = good(await f.sharing.status(context));
    good(await f.sharing.validateResponse(context, first)); f.sharing.releaseResponse(first);
    setRole({ id: 'beta', epoch: 3, name: 'Beta' });
    good(await f.action({ type: 'configure_policy', policy: { policyId: 'beta-sharing-policy', approved: true, audiences: [['local', 'local:companion-sharing:beta', 'local:owner']], processingGrants: [{ grantId: 'beta-local-grant', providerRouteId: routeId }] } }));
    beta = good(await f.originalAdapter.capture({ conversationKey: 'local:companion-sharing:beta' }));
    assert.equal(good(await f.originalAdapter.search(beta.handle, '纸箱')).records.length, 0);
    const betaContext = { characterId: 'beta', characterEpoch: 3 };
    const betaView = good(await f.sharing.status(betaContext));
    assert.equal(betaView.openings.length + betaView.messages.length, 0);
    good(await f.sharing.validateResponse(betaContext, betaView)); f.sharing.releaseResponse(betaView);
    bad(await f.originalAdapter.validate(old.handle));
    setRole({ id: 'alpha', epoch: 4, name: 'Alpha' });
    const returnedContext = { characterId: 'alpha', characterEpoch: 4 };
    const returned = good(await f.sharing.status(returnedContext));
    good(await f.sharing.validateResponse(returnedContext, returned)); f.sharing.releaseResponse(returned);
    fresh = good(await f.originalAdapter.capture({ conversationKey }));
    assert.equal(fresh.sourceStamp.capturedEpoch, 4);
    assert.deepEqual(good(await f.originalAdapter.search(fresh.handle, '纸箱')).records.map(row => row.id), sourceIds);
    assert.equal(fresh.sourceStamp.conversationKey, old.sourceStamp.conversationKey);
    assert.equal(fresh.sourceStamp.requesterAccountKey, old.sourceStamp.requesterAccountKey);
    good(await f.originalAdapter.bindActualInput(fresh.handle, f.sourceReceipt.eventRefs));
    const packet = good(await f.originalAdapter.prepare(fresh.handle, '纸箱'));
    assert.ok(packet.prepared.inputManifest.some(ref => sourceIds.includes(ref.id)));
    good(await f.originalAdapter.validate(fresh.handle, packet.preparedHandle));
    bad(await f.originalAdapter.validate(old.handle));
    assert.equal(bad(await f.originalAdapter.validate(late.handle)).code, 'CHARACTER_EPOCH_STALE');
    bad(await f.originalAdapter.validate(beta.handle));
    good(await f.sharing.withTransition(() => ({ ok: true })));
    await f.restart();
    const reset = good(await f.sharing.status(returnedContext));
    good(await f.sharing.validateResponse(returnedContext, reset)); f.sharing.releaseResponse(reset);
    assert.deepEqual(good(await f.originalAdapter.search(fresh.handle, '纸箱')).records.map(row => row.id), sourceIds);
    checks.push('local-role-source-survives-A1-B3-A4-and-ordinary-service-reset', 'beta-isolation-and-old-alpha-handle-stays-denied');
  } finally {
    for (const value of [old, late, fresh, beta]) if (value?.handle) f.originalAdapter.release(value.handle);
    setRole({ id: 'alpha', epoch: 1, name: 'Alpha' }); await f.close();
  }
}
{
  const f = await fixture({ seedOpening: false });
  let legacy, canonical;
  try {
    const epochKey = 'local:companion-sharing:alpha:1';
    good(await f.action({ type: 'configure_policy', policy: { policyId: 'legacy-epoch-policy', approved: true, audiences: [['local', epochKey, 'local:owner']], processingGrants: [{ grantId: 'legacy-epoch-grant', providerRouteId: routeId }] } }));
    legacy = good(await f.originalAdapter.capture({ conversationKey: epochKey }));
    const receipt = good(await f.originalAdapter.ingest(legacy.handle, [{ eventId: 'fixture:legacy-epoch', operationId: 'fixture:legacy-epoch-source', sourceKey: 'fixture:legacy-epoch', producerId: 'sharing-fixture', segmentId: 'fixture:legacy-epoch-segment', producerSeq: 1, content: 'ephemeralepochcanary', certainty: 'observed', attribution: 'action' }], 'fixture:legacy-epoch-ingest'));
    assert.equal(good(await f.originalAdapter.search(legacy.handle, 'ephemeralepochcanary')).records.length, 1);
    canonical = good(await f.originalAdapter.capture({ conversationKey }));
    assert.equal(good(await f.originalAdapter.search(canonical.handle, 'ephemeralepochcanary')).records.length, 0);
    assert.equal(bad(await f.originalAdapter.bindActualInput(canonical.handle, receipt.eventRefs)).code, 'MEMORY_EVIDENCE_DENIED');
    checks.push('old-epoch-audience-source-needs-explicit-migration-no-implicit-alias');
  } finally {
    for (const value of [legacy, canonical]) if (value?.handle) f.originalAdapter.release(value.handle);
    await f.close();
  }
}
{
  const f = await fixture({ seedOpening: false, sourceFromDouyin: true });
  try {
    assert.equal(bad(await f.sharing.record(context, { jobId, id: item.id, share: f.opening.text, question: f.opening.question })).code, 'DOUYIN_CHAT_MIGRATION_REQUIRED');
    assert.equal(f.sharingStore.read('alpha').length, 0);
    f.resetBudget({ memoryV2Refs: f.sourceReceipt.eventRefs, memoryV2Receipts: [{ ...f.sourceReceipt, phase: 'source' }] });
    good(await f.sharing.record(context, { jobId, id: item.id, share: f.opening.text, question: f.opening.question }));
    const requestId = crypto.randomUUID(); good((await f.reply('看完这次真实来源后接着聊。', requestId)).body);
    assert.deepEqual(f.ledger.readLedger().jobs[jobId].memoryV2Receipts[0], { ...f.sourceReceipt, phase: 'source' });
    assert.equal(f.calls, 1);
    checks.push('production-record-canonical-source-and-budget-ledger-roundtrip');
  } finally { await f.close(); }
}

{
  const f = await fixture();
  try {
    const requestId = crypto.randomUUID(), text = '纸箱里的猫。'.repeat(210) + 'token=fixture-secret';
    const first = await f.reply(text, requestId); good(first.body); assert.equal(first.status, 200); assert.equal(f.calls, 1);
    const rows = f.sharingStore.read('alpha'), user = rows.find(row => row.kind === 'request'), answer = rows.find(row => row.kind === 'answer');
    assert.ok(user.text.length > 1000); assert.doesNotMatch(user.text, /fixture-secret/); assert.equal(user.sourceState, 'committed');
    assert.ok(answer.memoryV2Refs.some(ref => ref.id === 'fixture:opening')); assert.ok(answer.memoryV2Refs.some(ref => ref.id === `sharing:${requestId}:user`));
    assert.ok(answer.memoryV2Refs.some(ref => ref.id === `sharing:${requestId}:assistant`)); assert.equal(answer.memoryV2Receipts.length, 3);
    good((await f.reply(text, requestId)).body); assert.equal(f.calls, 1);
    await f.restart(); const restored = await f.http(); good(restored.body); assert.equal(restored.body.value.messages.length, 2);
    f.resetBudget(); good((await f.reply('又想起这只猫。')).body);
    const newest = f.sharingStore.read('alpha').filter(row => row.kind === 'answer').at(-1);
    assert.ok(newest.memoryV2Refs.some(ref => ref.id === `sharing:${requestId}:user`), 'full raw history remains an actual dependency');
    const retained = good(await f.sharing.status(context));
    await f.action({ type: 'suppress', roots: [`sharing:${requestId}:user`] });
    bad(await f.sharing.validateResponse(context, retained)); f.sharing.releaseResponse(retained);
    const denied = await f.http(); bad(denied.body); assert.doesNotMatch(JSON.stringify(denied.body), /纸箱里的猫真|小窝/);
    let transitioned = false; const barrier = await f.sharing.withTransition(() => { transitioned = true; return { ok: true }; });
    assert.equal(barrier.retirementRequired, true); assert.equal(transitioned, false); assert.ok(f.blocked.length);
    good(await f.sharing.withTransition(() => ({ ok: true }), { retirementAcknowledged: true }));
    await f.restart(); bad((await f.http()).body);
    checks.push('full-redacted-input-output-capture', 'duplicate-one-call', 'history-full-manifest', 'private-root-revocation-no-laundering', 'retained-send-and-restart-barrier');
  } finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    const legacy = { ...f.opening, id: `${jobId}:654321`, sourceId: '654321', text: 'LEGACY_UNKNOWN_PRIVATE_CANARY' }; delete legacy.memoryV2Refs; delete legacy.memoryV2Receipts;
    f.sharingStore.append('alpha', legacy);
    const response = await f.http(); good(response.body); assert.equal(response.body.value.openings.length, 1); assert.equal(response.body.value.lastError.code, 'DOUYIN_CHAT_MIGRATION_REQUIRED');
    assert.doesNotMatch(JSON.stringify(response.body), /LEGACY_UNKNOWN_PRIVATE_CANARY/);
    const unknown = await f.http({ action: 'reply', openingId: legacy.id, requestId: crypto.randomUUID(), text: '聊旧分享。' });
    assert.equal(bad(unknown.body).code, 'DOUYIN_CHAT_MIGRATION_REQUIRED'); assert.equal(f.calls, 0);
    checks.push('legacy-unknown-row-quarantine');
  } finally { await f.close(); }
}
{
  const f = await fixture({ model: async () => { throw Object.assign(new Error('provider failed without usage'), { code: 'MODEL_INVOKE_FAILED', hint: 'Inspect original budget receipt.' }); } });
  try {
    const response = await f.reply(); bad(response.body); assert.equal(response.body.sourceState, 'committed'); assert.equal(response.body.modelState, 'failed');
    assert.equal(response.body.memoryV2Receipts[0].sourceState, 'committed'); assert.equal(f.calls, 1);
    assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0);
    checks.push('model-failure-keeps-source-and-canonical-receipt');
  } finally { await f.close(); }
}
{
  const f = await fixture({ metadata: false });
  try { const response = await f.reply(); assert.equal(bad(response.body).code, 'DOUYIN_CHAT_MODEL_METADATA_REQUIRED'); assert.equal(f.calls, 0); assert.equal(response.body.sourceState, 'committed'); checks.push('missing-trusted-metadata-fails-before-model'); }
  finally { await f.close(); }
}
for (const retirementAcknowledged of [false, true]) {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ model: async ({ signal }) => { entered(); return new Promise(resolve => { finish = () => resolve({ text: signal.aborted ? '取消后不得保存。' : '正常回复。', finishReason: 'stop' }); }); } });
  try {
    const pending = f.reply(); await started;
    let transitioned = false;
    const transition = f.sharing.withTransition(() => { transitioned = true; return { ok: true }; }, { retirementAcknowledged });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(transitioned, false, 'barrier must await model settlement');
    finish(); bad((await pending).body); good(await transition); assert.equal(transitioned, true);
    assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0);
    checks.push('abort-awaits-actual-settlement');
  } finally { await f.close(); }
}
{
  const f = await fixture({ model: async () => { setRole({ id: 'beta', epoch: 2, name: 'Beta' }); return { text: '旧角色迟到回复。', finishReason: 'stop' }; } });
  try { bad((await f.reply()).body); assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0); checks.push('stale-role-postmodel-denied'); }
  finally { setRole({ id: 'alpha', epoch: 1, name: 'Alpha' }); await f.close(); }
}
for (const phase of ['capture', 'prepare', 'validate', 'ingest']) {
  let armed = false;
  const f = await fixture({ patchAdapter: original => ({ ...original, [phase]: async (...args) => armed ? { ok: false, code: 'MEMORY_WORKER_UNAVAILABLE', error: 'Fixture worker unavailable.', hint: 'Retire original session and inspect worker.' } : original[phase](...args) }) });
  try { armed = true; bad((await f.reply()).body); assert.equal(f.calls, 0); assert.ok(f.blocked.length); checks.push(`worker-failure-${phase}`); }
  finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    const before = f.sharingStore.read('alpha').length;
    const file = path.join(f.stateDir, 'characters/alpha/douyin/sharing.jsonl');
    const prefix = fs.readFileSync(file), originalWrite = fs.writeSync;
    for (const mode of ['zero', 'enospc']) {
      fs.writeSync = function(fd, data, ...args) {
        if (Buffer.isBuffer(data) && data.toString().includes('"kind":"ack"')) { if (mode === 'zero') return 0; throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }
        return originalWrite.call(this, fd, data, ...args);
      };
      try { const response = await f.http({ action: 'ack', openingId: f.openingId }); bad(response.body); assert.ok(['DOUYIN_CHAT_WRITE_FAILED', 'DOUYIN_CHAT_STORAGE'].includes(response.body.code)); }
      finally { fs.writeSync = originalWrite; }
      assert.deepEqual(fs.readFileSync(file), prefix); assert.equal(f.sharingStore.read('alpha').length, before); assert.equal(fs.existsSync(path.join(path.dirname(file), '.sharing.lock')), false);
    }
    checks.push('zero-write-and-enospc-visible-prefix-and-lock-safe');
  } finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    const guardedController = createSharingController({ getCharacter: () => role, service: { ...f.sharing,
      validateResponse: async (...args) => { await f.action({ type: 'suppress', roots: ['fixture:opening'] }); return f.sharing.validateResponse(...args); } } });
    const response = await f.http(null, guardedController); bad(response.body); assert.doesNotMatch(JSON.stringify(response.body), /纸箱当成/);
    checks.push('current-policy-rechecked-before-http-json');
  } finally { await f.close(); }
}
{
  let afterModel = false;
  const f = await fixture({ model: async () => { afterModel = true; return { text: '不应保存的迟到回复。', finishReason: 'stop' }; },
    patchAdapter: original => ({ ...original, validate: (...args) => afterModel ? { ok: false, code: 'MEMORY_WORKER_UNAVAILABLE', error: 'Postmodel worker failed.', hint: 'Inspect original receipt and retire session.' } : original.validate(...args) }) });
  try { const response = await f.reply(); bad(response.body); assert.equal(response.body.sourceState, 'committed'); assert.equal(f.calls, 1); assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0); checks.push('postmodel-worker-failure-before-persist'); }
  finally { await f.close(); }
}
{
  const f = await fixture({ runBeforeSend: false });
  try { assert.equal(bad((await f.reply()).body).code, 'DOUYIN_CHAT_SEND_GUARD_REQUIRED'); assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0); assert.ok(f.blocked.length); checks.push('model-must-await-before-send-guard'); }
  finally { await f.close(); }
}
{
  const f = await fixture({ model: async () => { f.advance(31000); return { text: '模型结束后按当前权限保存。', finishReason: 'stop' }; } });
  try { good((await f.reply()).body); checks.push('prepared-package-expiry-after-model-keeps-current-context'); }
  finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    f.options.memoryV2.getRouting = () => ({ ok: false, code: 'MEMORY_ROUTING_BLOCKED', error: 'Route proof invalid.', hint: 'Inspect routing receipt.' });
    bad((await f.http()).body); assert.equal(f.calls, 0); checks.push('routing-error-never-reads-legacy-context');
  } finally { await f.close(); }
}
{
  const f = await fixture({ patchAdapter: original => ({ ...original, receipt: async () => ({ ok: false, code: 'MEMORY_WORKER_UNAVAILABLE', error: 'Receipt worker unavailable.', hint: 'Query original operation ID after reopening.' }) }) });
  try { const response = await f.reply(); bad(response.body); assert.equal(response.body.sourceState, 'committed'); assert.ok(response.body.operationId); assert.equal(response.body.retry, 'query_receipt'); assert.equal(response.body.memoryV2Receipts[0].sourceState, 'committed'); assert.equal(f.calls, 0); checks.push('receipt-query-failure-keeps-confirmed-source'); }
  finally { await f.close(); }
}
{
  const f = await fixture({ patchAdapter: original => ({ ...original, ingest: async () => ({ ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: 'Commit outcome unknown.', hint: 'Query original receipt.', operationState: 'unknown', retry: 'query_receipt' }) }) });
  try { const response = await f.reply(); bad(response.body); assert.equal(response.body.sourceState, 'commit_unknown'); assert.ok(response.body.operationId); assert.equal(response.body.retry, 'query_receipt'); assert.equal(f.calls, 0); checks.push('unknown-commit-never-claims-unsaved'); }
  finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    const result = await f.sharing.withTransition(() => ({ ok: false, code: 'MEMORY_CONTROL_BLOCKED', error: 'Worker did not acknowledge revocation.', hint: 'Retire the unverifiable session.' }));
    bad(result); assert.equal(result.retirementRequired, true); assert.ok(f.blocked.length);
    let invoked = false; bad(await f.sharing.withTransition(() => { invoked = true; return { ok: true }; })); assert.equal(invoked, false);
    good(await f.sharing.withTransition(() => ({ ok: true }), { retirementAcknowledged: true })); checks.push('failed-transition-needs-explicit-retirement-ack');
  } finally { await f.close(); }
}
{
  const f = await fixture({ model: async () => { await f.action({ type: 'suppress', roots: ['fixture:opening'] }); return { text: '撤权后不应保存。', finishReason: 'stop' }; } });
  try { const response = await f.reply(); bad(response.body); assert.equal(response.body.sourceState, 'committed'); assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'answer').length, 0); assert.ok(f.blocked.length); checks.push('actual-root-revocation-after-model-before-save'); }
  finally { await f.close(); }
}
{
  const stateDir = path.join(root, 'partial-write'), store = createSharingStore(stateDir);
  const record = id => ({ version: 1, kind: 'ack', id, epoch: 1, at: now().toISOString(), openingId: 'fixture:opening' });
  store.append('alpha', record('ack:first'));
  const file = path.join(stateDir, 'characters/alpha/douyin/sharing.jsonl'), prefix = fs.readFileSync(file), original = fs.writeSync;
  let partial = false;
  fs.writeSync = function(fd, data, offset, length, ...args) {
    if (Buffer.isBuffer(data) && data.toString().includes('ack:second')) {
      if (partial) return 0;
      partial = true; return original.call(this, fd, data, offset, 7, ...args);
    }
    return original.call(this, fd, data, offset, length, ...args);
  };
  try { assert.throws(() => store.append('alpha', record('ack:second')), error => error.code === 'DOUYIN_CHAT_WRITE_FAILED' && !!error.hint); }
  finally { fs.writeSync = original; }
  const after = fs.readFileSync(file); assert.deepEqual(after.subarray(0, prefix.length), prefix); assert.equal(after.length, prefix.length + 7);
  assert.equal(fs.existsSync(path.join(path.dirname(file), '.sharing.lock')), false);
  assert.throws(() => store.read('alpha'), error => error.code === 'DOUYIN_CHAT_STORAGE' && !!error.hint);
  checks.push('partial-zero-write-preserves-prefix-and-fails-closed');
}
{
  const f = await fixture({ sourceFromDouyin: true, allowLocal: false });
  try { bad((await f.http()).body); bad((await f.reply()).body); assert.equal(f.calls, 0); assert.ok(f.blocked.length); checks.push('cross-channel-source-without-local-grant-never-renders'); }
  finally { await f.close(); }
}
{
  const issued = [], released = [];
  const f = await fixture({ patchAdapter: original => ({ ...original,
    capture: async (...args) => { const value = await original.capture(...args); if (value.ok) issued.push(value.handle); return value; },
    release: handle => { released.push(handle); return original.release(handle); } }) });
  try {
    const view = good(await f.sharing.status(context)), lease = issued.at(-1), healthyRouting = f.options.memoryV2.getRouting;
    good(await f.sharing.status(context)); const heldLease = issued.at(-1);
    f.options.memoryV2.getRouting = () => ({ ok: false, code: 'MEMORY_ROUTING_BLOCKED', error: 'Transient fixture route failure.', hint: 'Retire the retained session before continuing.' });
    bad(await f.sharing.status(context)); assert.ok(f.blocked.length);
    f.options.memoryV2.getRouting = healthyRouting;
    assert.equal(bad(await f.sharing.validateResponse(context, view)).code, 'MEMORY_ROUTING_BLOCKED');
    const oldViewController = createSharingController({ getCharacter: () => role, service: { ...f.sharing, status: async () => view } });
    const rejected = await f.http(null, oldViewController); bad(rejected.body); assert.doesNotMatch(JSON.stringify(rejected.body), /猫把纸箱当成了家/);
    bad((await f.reply()).body); assert.equal(f.calls, 0);
    bad(await f.sharing.ack(context, { openingId: f.openingId })); assert.equal(f.sharingStore.read('alpha').filter(row => row.kind === 'ack').length, 0);
    assert.ok(!released.includes(heldLease));
    bad(await f.sharing.withTransition(() => ({ ok: true }))); assert.ok(released.includes(lease)); assert.ok(released.includes(heldLease), 'transition must release unconsumed retained leases');
    bad((await f.http()).body);
    good(await f.sharing.withTransition(() => ({ ok: true }), { retirementAcknowledged: true }));
    good((await f.http()).body); assert.notEqual(issued.at(-1), lease);
    checks.push('sticky-retained-view-block-survives-route-recovery-until-retirement-ack', 'current-role-persona-in-model-system-no-foreign-persona');
  } finally { await f.close(); }
}
console.log(JSON.stringify({ ok: true, checks, fixture: root }));
