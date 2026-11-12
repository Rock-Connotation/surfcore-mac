import { DatabaseSync } from 'node:sqlite';
import { deriveBiliV2PublicSourceSet } from '../lib/bili-v2-public-source-set.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMemoryV2Runtime } from '../lib/memory-v2-runtime.mjs';
import { digest, validatePolicy } from '../../../src/core/memory-v2-contract.js';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { COMPANION_ROUTE } from '../lib/douyin-companion-model.mjs';
import { createQQMemoryBridge } from '../../../src/core/memory-v2-qq.js';

const root = path.resolve('_backups/memory-v2-runtime', randomUUID());
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
let current = { id: 'alpha', epoch: 1 }, verified = true, runtime, base;
let biliAccount = '9', douyinFailure = null, douyinReads = 0;
const biliPublicSets = [];
const biliTargets = [{ audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' }, { audience: 'private', kind: 'dm', mid: '22' }];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (await runtime.handleApi(req, res, url)) return;
    if (await runtime.handleManagement(req, res, url)) return;
    res.writeHead(404).end();
  } catch (error) { if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ ok: false, code: error.code || 'FIXTURE_FAILED', error: 'Fixture failed.', hint: 'Inspect this isolated test.' })); else res.destroy(error); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
const selected = { provider: 'fixture-provider', model: 'fixture-model' };
runtime = createMemoryV2Runtime({ stateDir: path.join(root, 'state'), charactersDir: path.join(root, 'characters'), getCharacter: () => current,
  currentDshUrl: () => base,
  getManagementAuthorization: req => req.headers['x-fixture-owner'] === 'fixture-owner',
  getQQState: () => ({ verified, accountId: '1', allowedGroups: ['2'], allowedPrivates: ['3'] }), getQQRoute: () => selected,
  getPlatformState: channel => channel === 'douyin' ? (++douyinReads, douyinFailure ?? { verified, accountId: 'fixture-douyin-owner' }) : channel === 'bili' ? { verified, accountId: biliAccount, route: selected, targets: biliTargets, publicSourceSets: biliPublicSets } : null });
const request = async (suffix, body, owner = true) => {
  const response = await fetch(`${base}/dsh-surfcore/api/memory-v2/${suffix}`, { method: body ? 'POST' : 'GET', headers: { origin: base, ...(owner ? { 'x-fixture-owner': 'fixture-owner' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
};
try {
  const init = await runtime.initialize(); assert.equal(init.ok, true, JSON.stringify(init)); assert.equal(init.backend, 'v2');
  // Use the production writer and the production QQ factory; a hand-aligned
  // fixture scope hid the real qq / qq-bridge discovery mismatch.
  const defaultQq = createQQMemoryBridge({ stateDir: path.join(root, 'state'), getCharacter: () => current, getRouting: () => ({ ok: true, backend: 'v2' }) });
  const scopeProbe = await defaultQq.captureSource({ key: 'private:3', loginAccountId: '1', actorAccountId: '3', objectId: 'scope-regression', text: 'hello' });
  assert.notEqual(scopeProbe.code, 'MEMORY_DISCOVERY_INVALID', 'The QQ default must reach the actual Host discovery, even when V1 refuses the source.');
  const state = await request('status'); assert.equal(state.status, 200); assert.equal(state.value.ok, true, JSON.stringify(state));
  assert.equal(state.value.backend, 'v2'); assert.equal(state.value.capabilities.activation, false); assert.equal(state.value.capabilities.migration, false);
  assert.equal(state.value.capabilities.adminResume, true);
  const denied = await request('status', null, false); assert.equal(denied.value.ok, false); assert.ok(denied.value.code && denied.value.hint);
  const conversations = await runtime.approvedConversations(); assert.ok(conversations.length >= 4);
  const readsBeforeQQ = douyinReads;
  const qqOnly = (await request('status?channel=qq')).value;
  assert.equal(qqOnly.ok, true); assert.equal(douyinReads, readsBeforeQQ, 'QQ setup must never wait for unrelated platform identity');
  assert.equal(qqOnly.approvedConversations.length, 2);
  assert.ok(qqOnly.approvedConversations.every(row => row.id.startsWith('qq-') && row.replyAccess.approved === false));
  assert.equal(qqOnly.approvedConversations[0].replyAccess.model, selected.model);
  assert.equal((await request('status?channel=bili')).value.code, 'MEMORY_REQUEST_INVALID');
  for (const conversation of conversations) for (const scope of conversation.processorScopes) validatePolicy(scope.policy);
  assert.equal(conversations.find(item => item.id === 'qq-group-2').processorScopes[0].policy.processingGrants[0].providerRouteId, deriveMemoryProviderRouteId(selected).providerRouteId);
  assert.equal(JSON.stringify(state.value).includes('processingGrants'), false);
  async function manage(action, payload) {
    const status = (await request('status')).value;
    const body = { action, payload: { ...payload, payloadDigest: digest(payload), preview: true }, expectedRevision: status.revision,
      operationId: randomUUID(), characterId: current.id, characterEpoch: current.epoch };
    const preview = await request('manage', body); assert.equal(preview.value.ok, true, JSON.stringify(preview));
    if (action === 'configure_policy' && payload.conversationId.startsWith('qq-')) {
      assert.equal(preview.value.preview.qqAccessPreview.conversationId, payload.conversationId);
      assert.equal(preview.value.preview.qqAccessPreview.model, selected.model);
      assert.equal(preview.value.preview.qqAccessPreview.accountId, '1');
    }
    if (action === 'configure_policy' && payload.conversationId.startsWith('bili-public-set-')) {
      const candidate = (await runtime.approvedConversations()).find(item => item.id === payload.conversationId);
      assert.deepEqual(preview.value.preview.sourceSetPreview, candidate.sourceSetPreview, 'The final confirmation must bind the same complete source list shown before approval.');
    }
    delete body.payload.preview;
    const committed = await request('manage', body); assert.equal(committed.value.ok, true, JSON.stringify(committed));
    return committed.value;
  }
  const localPolicy = conversations.find(item => item.id === 'local-sharing').processorScopes[0].policy.policyId;
  await manage('configure_policy', { conversationId: 'qq-group-2', processorScope: 'exact-model' });
  const qqGranted = (await request('status?channel=qq')).value;
  assert.equal(qqGranted.approvedConversations.find(row => row.id === 'qq-group-2').replyAccess.approved, true);
  assert.equal(qqGranted.approvedConversations.find(row => row.id === 'qq-private-3').replyAccess.approved, false);
  selected.model = 'different-model';
  assert.equal((await request('status?channel=qq')).value.approvedConversations.find(row => row.id === 'qq-group-2').replyAccess.approved, false, 'A model change cannot inherit old processing approval');
  selected.model = 'fixture-model';
  const beforeRouteRace = (await request('status?channel=qq')).value;
  const racePayload = { conversationId: 'qq-private-3', processorScope: 'exact-model' };
  const raceBody = { action: 'configure_policy', payload: { ...racePayload, payloadDigest: digest(racePayload), preview: true }, expectedRevision: beforeRouteRace.revision, operationId: randomUUID(), characterId: current.id, characterEpoch: current.epoch };
  selected.model = 'changed-before-preview';
  const actualPreview = (await request('manage', raceBody)).value;
  assert.equal(actualPreview.preview.qqAccessPreview.model, 'changed-before-preview', 'Confirmation must display the plan actually previewed, not stale status');
  selected.model = 'fixture-model'; delete raceBody.payload.preview;
  assert.equal((await request('manage', raceBody)).value.ok, false, 'A changed preview model cannot be committed under the previous route');
  await manage('configure_policy', { conversationId: 'local-sharing', processorScope: 'exact-model' });
  const configured = (await request('status')).value;
  assert.ok(configured.policies.some(row => row.id === localPolicy), 'Configured policy must be available for revocation before any source ingestion.');
  await manage('revoke_policy', { policyId: localPolicy });
  const revoked = (await request('status')).value;
  assert.equal(revoked.policies.find(row => row.id === localPolicy)?.label, '已撤销');
  const backup = await manage('backup', {});
  const backedUp = (await request('status')).value;
  assert.ok(backedUp.backups.some(row => row.id === backup.backupId && row.verified === true), JSON.stringify(backedUp));
  assert.ok(backedUp.operations.some(row => row.operationId === backup.operationId && row.complete === true));
  const dy = runtime.channelMemory('douyin');
  const dyCandidate = conversations.find(item => item.processorScopes[0].policy.audiences[0][0] === 'douyin');
  assert.ok(dyCandidate);
  await manage('configure_policy', { conversationId: dyCandidate.id, processorScope: 'exact-model' });
  const dyCapture = await dy.adapter.capture({ conversationKey: 'douyin:homepage-recommendation' });
  assert.equal(dyCapture.code, 'MEMORY_SHADOW_DISABLED', JSON.stringify(dyCapture));
  douyinFailure = { ok: false, code: 'DOUYIN_BUSY', error: 'PRIVATE_PLATFORM_ERROR', hint: 'PRIVATE_PLATFORM_HINT' };
  const dyBusy = await dy.adapter.capture({ conversationKey: 'douyin:homepage-recommendation' });
  assert.equal(dyBusy.code, 'MEMORY_IDENTITY_BUSY', JSON.stringify(dyBusy));
  assert.equal(dyBusy.hint, '等待当前平台操作结束后重试。');
  assert.ok(dyBusy.error);
  assert.equal(JSON.stringify(dyBusy).includes('PRIVATE_PLATFORM'), false);
  const busyCandidates = await runtime.approvedConversations();
  assert.ok(busyCandidates.some(item => item.id === 'local-sharing'));
  assert.equal(busyCandidates.some(item => item.processorScopes[0].policy.audiences[0][0] === 'douyin'), false);
  douyinFailure = null;
  assert.equal((await dy.adapter.capture({ conversationKey: 'douyin:homepage-recommendation' })).code, 'MEMORY_SHADOW_DISABLED');
  assert.ok(douyinReads >= 4, 'Identity must be read freshly for each capture and candidate lookup.');
  const hidden = runtime.channelMemory('bili'); assert.equal((await hidden.adapter.capture({ conversationKey: 'bili:unproven' })).ok, false);
  const biliPublic = conversations.find(item => item.processorScopes[0].policy.audiences[0][1] === 'bili:9:public:11');
  assert.ok(biliPublic, 'Official Bili targets must appear as explicit approval candidates.');
  const biliPrivate = conversations.find(item => item.processorScopes[0].policy.audiences[0][1] === 'bili:9:private:22');
  assert.ok(biliPrivate);
  assert.deepEqual(biliPrivate.processorScopes[0].policy.audiences, [['bili', 'bili:9:private:22', 'bili:9:actor:9']]);
  await manage('configure_policy', { conversationId: biliPublic.id, processorScope: 'exact-model' });
  const captured = await hidden.adapter.capture({ conversationKey: 'bili:9:public:11' });
  assert.equal(captured.code, 'MEMORY_SHADOW_DISABLED', JSON.stringify(captured));
  assert.ok(captured.hint);
  assert.equal(biliPublic.processorScopes[0].policy.processingGrants[0].providerRouteId, deriveMemoryProviderRouteId(selected).providerRouteId);
  assert.equal((await hidden.adapter.capture({ conversationKey: 'bili:9:public:99' })).ok, false);
  biliAccount = '10';
  assert.equal((await hidden.adapter.capture({ conversationKey: 'bili:9:public:11' })).ok, false);
  biliAccount = '9';
  biliTargets.push({ audience: 'public', kind: 'comment', type: '999', oid: '99', root: '0', parent: '0' });
  assert.equal((await runtime.approvedConversations()).some(item => item.processorScopes[0].policy.audiences[0][1] === 'bili:9:public:99'), false);
  biliTargets.pop();

  const exactSet = deriveBiliV2PublicSourceSet({ characterId: current.id, characterEpoch: current.epoch, accountMid: biliAccount, providerRouteId: deriveMemoryProviderRouteId(selected).providerRouteId,
    selectors: [{ kind: 'video', bvid: 'BV1234567890', aid: '123', authorMid: '8' }, { kind: 'comment', rpid: '31', type: '1', oid: '11', root: '0', parent: '0', authorMid: '8' }], outputTarget: { audience: 'public', kind: 'dynamic' } });
  assert.equal(exactSet.ok, true, JSON.stringify(exactSet)); biliPublicSets.push(exactSet);
  const setCandidates = await runtime.approvedConversations();
  const setCandidate = setCandidates.find(item => item.sourceSetPreview?.id === exactSet.id);
  assert.ok(setCandidate, 'Verified exact public sets must expose a separate approval with the complete source list.');
  const setPolicy = setCandidate.processorScopes[0].policy;
  assert.equal(setPolicy.audiences.length, 3);
  assert.deepEqual(new Set(setPolicy.audiences.map(row => row[1])), new Set([exactSet.outputConversationKey, ...exactSet.sourceConversations.map(row => row.conversationKey)]));
  assert.ok(setPolicy.audiences.every(row => row[0] === 'bili' && row[2] === 'bili:9:actor:9'));
  assert.deepEqual(setCandidate.sourceSetPreview.selectors, exactSet.selectors);
  const safeSet = (await request('status')).value.approvedConversations.find(item => item.id === setCandidate.id);
  assert.deepEqual(safeSet.sourceSetPreview, setCandidate.sourceSetPreview); assert.equal(JSON.stringify(safeSet).includes('processingGrants'), false);
  assert.equal(setCandidates.filter(item => item.processorScopes[0].policy.audiences.some(row => row[1] === exactSet.sourceConversations[0].conversationKey)).length, 1, 'A set member must not also create a per-object approval candidate.');
  await manage('configure_policy', { conversationId: setCandidate.id, processorScope: 'exact-model' });
  // Exercise a pre-enabled isolated shadow store; the public management API does not expose a shadow switch.
  const shadowFixture = new DatabaseSync(path.join(root, 'state', 'memory-control.sqlite'));
  shadowFixture.prepare('UPDATE state SET shadowEnabled=1 WHERE id=1').run(); shadowFixture.close();
  for (const conversationKey of [exactSet.outputConversationKey, ...exactSet.sourceConversations.map(row => row.conversationKey)]) {
    const scoped = await hidden.adapter.capture({ conversationKey }); assert.equal(scoped.ok, true, JSON.stringify(scoped)); assert.equal(scoped.sourceStamp.conversationKey, conversationKey); assert.equal(hidden.adapter.release(scoped.handle).ok, true);
  }
  const videoSet = deriveBiliV2PublicSourceSet({ characterId: current.id, characterEpoch: current.epoch, accountMid: biliAccount, providerRouteId: deriveMemoryProviderRouteId(selected).providerRouteId,
    selectors: [{ kind: 'video', bvid: 'BV1234567890', aid: '9007199254740993123', authorMid: '9007199254740993124' }, { kind: 'video', bvid: 'BV1234567891', aid: '9007199254740993125', authorMid: '9007199254740993124' }], outputTarget: exactSet.outputTarget });
  assert.equal(videoSet.ok, true); biliPublicSets.push(videoSet);
  const videoCandidate = (await runtime.approvedConversations()).find(item => item.sourceSetPreview?.id === videoSet.id);
  assert.ok(videoCandidate);
  await manage('configure_policy', { conversationId: videoCandidate.id, processorScope: 'exact-model' });
  for (const conversationKey of [videoSet.outputConversationKey, ...videoSet.sourceConversations.map(row => row.conversationKey)]) {
    const captured = await hidden.adapter.capture({ conversationKey }); assert.equal(captured.ok, true, JSON.stringify(captured)); assert.equal(hidden.adapter.release(captured.handle).ok, true);
  }
  biliPublicSets.pop();
  console.log('PASS multi-video approval uses Core canonical audience ordering rather than selector hash order');
  assert.equal((await hidden.adapter.capture({ conversationKey: exactSet.outputConversationKey.replace(exactSet.id, 'f'.repeat(64)) })).ok, false);
  const expandedSet = deriveBiliV2PublicSourceSet({ characterId: current.id, characterEpoch: current.epoch, accountMid: biliAccount, providerRouteId: deriveMemoryProviderRouteId(selected).providerRouteId,
    selectors: [...exactSet.selectors, { kind: 'video', bvid: 'BVabcdefghij', aid: '456', authorMid: '7' }], outputTarget: exactSet.outputTarget });
  assert.equal(expandedSet.ok, true, JSON.stringify(expandedSet)); biliPublicSets.splice(0, 1, expandedSet);
  const unapprovedExpanded = await hidden.adapter.capture({ conversationKey: expandedSet.outputConversationKey });
  assert.equal(unapprovedExpanded.code, 'MEMORY_POLICY_DENIED', JSON.stringify(unapprovedExpanded)); assert.ok(unapprovedExpanded.error && unapprovedExpanded.hint);
  biliPublicSets.splice(0, 1, exactSet);
  const tampered = { ...exactSet, id: 'f'.repeat(64) }; biliPublicSets.splice(0, 1, tampered);
  assert.equal((await runtime.approvedConversations()).some(item => item.sourceSetPreview?.id === tampered.id), false);
  assert.equal((await hidden.adapter.capture({ conversationKey: exactSet.outputConversationKey })).ok, false);
  biliPublicSets.splice(0, 1, exactSet); biliAccount = '10';
  assert.equal((await hidden.adapter.capture({ conversationKey: exactSet.outputConversationKey })).ok, false); biliAccount = '9';
  selected.model = 'fixture-model-changed'; assert.equal((await hidden.adapter.capture({ conversationKey: exactSet.outputConversationKey })).ok, false); selected.model = 'fixture-model';
  current = { id: 'alpha', epoch: 2 }; assert.equal((await hidden.adapter.capture({ conversationKey: exactSet.outputConversationKey })).ok, false); current = { id: 'alpha', epoch: 1 };
  const isolatedPrivate = await hidden.adapter.capture({ conversationKey: 'bili:9:private:22' });
  assert.equal(isolatedPrivate.code, 'MEMORY_POLICY_DENIED', JSON.stringify(isolatedPrivate)); assert.ok(isolatedPrivate.error && isolatedPrivate.hint);
  biliPublicSets.length = 0;
  const restoreShadow = new DatabaseSync(path.join(root, 'state', 'memory-control.sqlite')); restoreShadow.prepare('UPDATE state SET shadowEnabled=0 WHERE id=1').run(); restoreShadow.close();

  const localBefore = conversations.find(item => item.id === 'local-sharing').processorScopes[0].policy;
  current = { id: 'alpha', epoch: 2 };
  const localAfter = (await runtime.approvedConversations()).find(item => item.id === 'local-sharing').processorScopes[0].policy;
  if (JSON.stringify(localBefore.audiences) !== JSON.stringify(localAfter.audiences)) assert.notEqual(localBefore.policyId, localAfter.policyId);
  const metadata = runtime.modelRequest({ jobId: 'sharing:fixture', step: 'reply', characterId: 'alpha', characterEpoch: 2, providerRouteId: deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId, model: COMPANION_ROUTE.model, system: 'approved fixture persona', prompt: 'fixture current input' });
  assert.equal(metadata.requestId, 'sharing:fixture'); assert.equal(metadata.purpose, 'conversation'); assert.ok(metadata.estimatedTokens > 8192);
  assert.throws(() => runtime.modelRequest({ ...metadata, jobId: metadata.jobId, characterId: 'alpha', characterEpoch: 1, step: 'reply' }), error => error.code === 'COMPANION_ROUTE_MISMATCH');
  verified = false;
  const unknown = await runtime.approvedConversations(); assert.deepEqual(unknown.map(item => item.id), ['local-sharing']);
  assert.equal(runtime.routing().backend, 'v2');
  const personPayload = { platform: 'qq', accountId: '3' }, originalId = randomUUID();
  const beforeResume = (await request('status')).value;
  const personBody = { action: 'create_person', payload: { ...personPayload, payloadDigest: digest(personPayload), preview: true }, expectedRevision: beforeResume.revision,
    operationId: originalId, characterId: current.id, characterEpoch: current.epoch };
  const personPreview = (await request('manage', personBody)).value;
  assert.equal(personPreview.code, 'MEMORY_IDENTITY_EVIDENCE_REQUIRED', JSON.stringify(personPreview)); assert.ok(personPreview.hint);
  const resumeBody = { operationId: originalId, characterId: current.id, characterEpoch: current.epoch, expectedRevision: beforeResume.revision, payloadDigest: digest({ operationId: originalId }), preview: true };
  const previewResume = (await request('admin-resume', resumeBody)).value;
  assert.equal(previewResume.code, 'MEMORY_OPERATION_NOT_FOUND', JSON.stringify(previewResume)); assert.equal(previewResume.operationId, originalId); assert.ok(previewResume.hint);
  const afterResume = (await request('status')).value;
  assert.equal(afterResume.revision, beforeResume.revision); assert.equal(afterResume.operations.some(row => row.operationId === originalId), false);
  console.log(JSON.stringify({ ok: true, douyinIdentity: 'fresh reads, actionable failure and candidate isolation verified', biliIdentity: 'fresh official-state candidates and exact-set identities verified', publicSourceSet: { memberCaptures: exactSet.sourceConversations.length, outputCaptures: 1, syntheticShadowEnabled: true, expandedSetDenied: true, accountModelEpochFenced: true, privateIsolation: true }, productionActivationVerified: false, backend: 'v1', fixture: root, actualMemoryWorker: true, managementAuth: 'fixture-only', nativeAgent: 'not mounted', nativeAdminResumer: 'injected; unknown original ID denied', productionRetirement: 'not mounted', noProviderCalled: true }));
} finally {
  await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
