import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createMemoryHost } from '../lib/memory-v2-host.mjs';
import { createMemoryApiService } from '../lib/memory-v2-api.mjs';
import { createMemoryClient } from '../../../src/core/memory-v2-client.js';
import { resolveQQMemoryIdentity, validateQQSourceFacts } from '../lib/memory-v2-identity.mjs';
import { createSpool, readSpool } from '../../../src/core/memory-v2-spool.js';
import { CONTEXT_FIELDS, eventDigest } from '../../../src/core/memory-v2-contract.js';

const root = path.resolve('_backups/memory-v2-host', `host-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const good = (value) => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value?.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code, JSON.stringify(value)); assert.ok(value.error && value.hint); assert.ok(!JSON.stringify(value).includes('SECRET_SOURCE')); return value; };
const ref = (id) => ({ type: 'event', id, revision: 1, payloadDigest: 'a'.repeat(64) });
function fake() {
  let current = { id: 'alpha', epoch: 1 }, revision = 1, allowed = true, time = 1000;
  const contexts = new WeakMap(), preparations = new WeakSet(), bound = [], calls = [];
  const fixture = { current: () => current, setRole: (value) => { current = value; }, bump: () => revision++, deny: () => { allowed = false; }, clock: () => time, advance: () => { time += 40_000; }, bound, calls };
  const valid = (ctx) => !contexts.has(ctx) ? { ok: false, code: 'MEMORY_CONTEXT_UNTRUSTED' } : contexts.get(ctx) !== revision ? { ok: false, code: 'MEMORY_CONTEXT_STALE' } : { ok: true };
  fixture.service = {
    getStatus: async () => ({ ok: true, activeBackend: 'v2', shadowEnabled: 1 }),
    host: {
      async resolveAudience(facts) { calls.push(['resolve', facts]); await fixture.onResolve?.(); return allowed ? { ok: true, ...facts, audiencePolicyId: 'private', processingGrantId: 'grant' } : { ok: false, code: 'MEMORY_POLICY_DENIED' }; },
      async bindInputManifest(ctx, refs) { good(valid(ctx)); bound.push(structuredClone(refs)); if (refs.some((r) => r.id === 'forbidden')) return { ok: false, code: 'MEMORY_EVIDENCE_DENIED' }; return { ok: true }; },
      verifyPrepared(ctx, prepared) { return contexts.has(ctx) && preparations.has(prepared) ? { ok: true } : { ok: false, code: 'MEMORY_PREPARED_UNTRUSTED' }; },
    },
    async captureContext(facts) { const ctx = Object.freeze({ ...facts, characterId: current.id, capturedEpoch: current.epoch }); contexts.set(ctx, revision); return { ok: true, context: ctx }; },
    async validateContext(ctx, prepared) { await fixture.onValidate?.(); return prepared && !preparations.has(prepared) ? { ok: false, code: 'MEMORY_PREPARED_UNTRUSTED' } : valid(ctx); },
    async prepareMemoryContext(ctx) { const prepared = Object.freeze({ text: 'authorized memory', inputManifest: [ref('prepared')], characterId: ctx.characterId }); preparations.add(prepared); return { ok: true, prepared }; },
    async searchMemory() { await fixture.onSearch?.(); return { ok: true, records: [] }; },
    async ingestEvents(ctx, events, operationId) { calls.push(['ingest', events]); await fixture.onIngest?.(); return { ok: true, operationId, sourceState: 'committed' }; },
    async getMemoryReceipt(ctx, operationId) { return { ok: true, operationId, operationState: 'not_found' }; },
  };
  fixture.identity = ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: 'login:actor:a', requesterAccountKey: 'login:actor:a', providerRouteId: 'local:test' });
  fixture.host = createMemoryHost({ memoryService: fixture.service, getCharacter: fixture.current, resolveIdentity: fixture.identity, now: fixture.clock });
  fixture.adapter = fixture.host.createAdapter({ channel: 'qq', principal: { login: 'login' }, canBindInput: true });
  return fixture;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function bounded(promise, ms = 1500) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms); })]); } finally { clearTimeout(timer); } }
async function admissionDenied(promise, code) { await assert.rejects(promise, (error) => { assert.equal(error.code, code); assert.ok(error.error && error.hint); return true; }); }
async function networkFixture(name) {
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const f = { current: { id: 'alpha', epoch: 1 }, time: Date.now(), management: Symbol('fixture management'), held: [], pause: null, retire: null };
  f.base = { channel: 'qq', conversationKey: 'qq:login:private:a', sourceAccountKey: 'qq:login:actor:a', requesterAccountKey: 'qq:login:actor:a', providerRouteId: 'local:test', purpose: 'conversation', audiencePolicyId: 'private', processingGrantId: 'grant' };
  f.service = createMemoryService({ stateDir: path.join(root, name, 'state'), charactersDir: path.join(root, name, 'characters'), getCharacter: () => f.current, now: () => f.time, authorizeManagement: (value) => value === f.management, workerFactory: (url, options) => {
    const worker = new Worker(url, options), post = worker.postMessage.bind(worker);
    worker.postMessage = (packet, ...args) => {
      if (f.pause?.method === packet.method) { const held = f.pause; f.pause = null; held.release = () => { if (held.sent) return; held.sent = true; post(packet, ...args); }; f.held.push(held); held.entered.resolve(); }
      else post(packet, ...args);
    }; return worker;
  }, retireForLifecycle: async (challenge) => {
    if (f.retire) await f.retire(challenge);
    f.host.retireAll(); f.current = { id: challenge.characterId, epoch: f.current.epoch + 1 };
    return { ok: true, nonce: challenge.nonce, characterId: f.current.id, epoch: f.current.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true };
  } });
  good(await f.service.initialize());
  f.action = async (action, operationId) => { const admin = good(await f.service.host.captureAdminContext(f.base, f.management)).context; return f.service.applyMemoryAction(admin, action, admin.controlRevision, operationId); };
  good(await f.action({ type: 'configure_policy', policy: { policyId: 'private', approved: true, audiences: [['qq', f.base.conversationKey, f.base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] } }, 'configure'));
  good(await f.action({ type: 'enable_shadow', enabled: true }, 'shadow'));
  f.makeHost = (memoryService = f.service) => createMemoryHost({ memoryService, getCharacter: () => f.current, now: () => f.time, resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: f.base.sourceAccountKey, requesterAccountKey: f.base.requesterAccountKey, providerRouteId: f.base.providerRouteId }) });
  f.host = f.makeHost(); f.adapter = f.host.createAdapter({ channel: 'qq', principal: {}, canBindInput: true });
  f.capture = () => f.adapter.capture({ conversationKey: 'login:private:a' });
  f.hold = (method) => { assert.equal(f.pause, null); return f.pause = { method, entered: deferred(), release() {} }; };
  f.close = async () => { for (const held of f.held) held.release(); f.host.close(); await f.service.close(); };
  return f;
}
let count = 0;
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }
await test('default deny, canonical facts, exact conversation and forbidden authority fields', async () => {
  const f = fake(), host = createMemoryHost({ memoryService: f.service, getCharacter: f.current });
  bad(await host.createAdapter({ channel: 'local', principal: {} }).capture({ conversationKey: 'owner:thread:1' }), 'MEMORY_IDENTITY_REQUIRED');
  for (const key of ['characterId', 'capturedEpoch', 'audiencePolicyId', 'processingGrantId', 'deletionRevision', 'purpose', 'inputManifest']) bad(await f.adapter.capture({ conversationKey: 'login:private:a', [key]: 'admin' }), 'MEMORY_FIELD_FORBIDDEN');
  const request = good(await f.adapter.capture({ conversationKey: 'login:private:a' }));
  assert.equal(request.context, undefined); assert.equal(f.calls[0][1].conversationKey, 'qq:login:private:a');
  assert.equal(f.calls[0][1].sourceAccountKey, 'qq:login:actor:a'); assert.equal(f.calls[0][1].requesterAccountKey, 'qq:login:actor:a');
  bad(await f.adapter.capture({ conversationKey: 'all' }), 'MEMORY_IDENTITY_REQUIRED');
  f.deny(); bad(await f.adapter.capture({ conversationKey: 'login:private:a' }), 'MEMORY_POLICY_DENIED');
});
await test('role is frozen before resolver await and checked after service awaits', async () => {
  const f = fake(), host = createMemoryHost({ memoryService: f.service, getCharacter: f.current, resolveIdentity: async (input) => { f.setRole({ id: 'beta', epoch: 2 }); return f.identity(input); } });
  bad(await host.createAdapter({ channel: 'qq', principal: {} }).capture({ conversationKey: 'login:private:a' }), 'CHARACTER_EPOCH_STALE');
  assert.equal(f.calls.length, 0);
  const g = fake(); g.onResolve = () => g.setRole({ id: 'beta', epoch: 2 });
  bad(await g.adapter.capture({ conversationKey: 'login:private:a' }), 'CHARACTER_EPOCH_STALE');
  const h = fake(), request = good(await h.adapter.capture({ conversationKey: 'login:private:a' }));
  h.onSearch = () => h.setRole({ id: 'beta', epoch: 2 }); bad(await h.adapter.search(request.handle, 'current'), 'CHARACTER_EPOCH_STALE');
  const i = fake(), captured = good(await i.adapter.capture({ conversationKey: 'login:private:a' }));
  i.onIngest = () => i.setRole({ id: 'beta', epoch: 2 });
  const result = bad(await i.adapter.ingest(captured.handle, [], 'original-operation'), 'CHARACTER_EPOCH_STALE'); assert.equal(result.retry, 'query_receipt'); assert.equal(result.sourceState, 'committed'); assert.equal(result.operationState, 'completed_before_cancel');
  const readonly = fake(), read = good(await readonly.adapter.capture({ conversationKey: 'login:private:a' }));
  readonly.service.ingestEvents = async () => ({ ok: false, code: 'MEMORY_STORE_READONLY', error: 'SECRET_SOURCE /private/db', retry: 'query_receipt', operationState: 'unknown' });
  const rejected = bad(await readonly.adapter.ingest(read.handle, [], 'original-readonly-operation'), 'MEMORY_STORE_READONLY'); assert.equal(rejected.retry, 'query_receipt'); assert.match(rejected.hint, /original operation/);
});
await test('handles expire, revisions invalidate, scopes isolate and restart retires capabilities', async () => {
  const f = fake(), request = good(await f.adapter.capture({ conversationKey: 'login:private:a' }));
  const other = f.host.createAdapter({ channel: 'qq', principal: {} }); bad(await other.search(request.handle, 'q'), 'MEMORY_HANDLE_STALE');
  f.bump(); bad(await f.adapter.validate(request.handle), 'MEMORY_CONTEXT_STALE'); bad(await f.adapter.validate(request.handle), 'MEMORY_HANDLE_STALE');
  const g = fake(), expired = good(await g.adapter.capture({ conversationKey: 'login:private:a' })); g.advance(); bad(await g.adapter.validate(expired.handle), 'MEMORY_HANDLE_STALE');
  const h = fake(), retired = good(await h.adapter.capture({ conversationKey: 'login:private:a' })); h.host.retireAll(); bad(await h.adapter.validate(retired.handle), 'MEMORY_HANDLE_STALE');
});
await test('actual manifest unions all prepared and trusted inputs, rejects forged references and no narrowing', async () => {
  const f = fake(), request = good(await f.adapter.capture({ conversationKey: 'login:private:a' }));
  good(await f.adapter.bindActualInput(request.handle, [ref('opening')]));
  const prepared = good(await f.adapter.prepare(request.handle, 'current'));
  assert.deepEqual(prepared.inputManifest.map((r) => r.id).sort(), ['opening', 'prepared']);
  good(await f.adapter.bindActualInput(request.handle, [])); good(await f.adapter.bindActualInput(request.handle, [ref('history')]));
  assert.deepEqual(f.bound.at(-1).map((r) => r.id).sort(), ['history', 'opening', 'prepared']);
  bad(await f.adapter.bindActualInput(request.handle, [ref('forbidden')]), 'MEMORY_EVIDENCE_DENIED');
  good(await f.adapter.bindActualInput(request.handle, [])); assert.equal(f.bound.at(-1).some((r) => r.id === 'forbidden'), false);
  good(await f.adapter.validate(request.handle, prepared.preparedHandle)); bad(await f.adapter.validate(request.handle, { ...prepared.prepared }), 'MEMORY_PREPARED_UNTRUSTED');
  good(f.adapter.verifyPrepared(request.handle, prepared.preparedHandle, structuredClone(prepared.prepared)));
  bad(f.adapter.verifyPrepared(request.handle, prepared.preparedHandle, { ...prepared.prepared, text: 'tampered source' }), 'MEMORY_PREPARED_UNTRUSTED');
  bad(f.adapter.verifyPrepared(request.handle, prepared.preparedHandle, { ...prepared.prepared, inputManifest: [] }), 'MEMORY_PREPARED_UNTRUSTED');
  const stranger = f.host.createAdapter({ channel: 'qq', principal: {} }); bad(stranger.verifyPrepared(request.handle, prepared.preparedHandle, prepared.prepared), 'MEMORY_HANDLE_STALE');
  const search = f.host.createAdapter({ channel: 'local', principal: {} }), local = good(await search.capture({ conversationKey: 'owner:thread:1' }));
  bad(await search.bindActualInput(local.handle, []), 'MEMORY_ADAPTER_REQUIRED');
  bad(await f.adapter.ingest(request.handle, [{ content: 'x', policyId: 'public' }], 'op'), 'MEMORY_FIELD_FORBIDDEN');
});
await test('loopback HTTP uses channel-scoped ephemeral credentials and denies origin/admin/scope upgrades', async () => {
  const f = fake(); let base;
  const api = createMemoryApiService({ host: f.host, stateDir: path.join(root, 'http'), currentDshUrl: () => base, scopes: [{ id: 'qq-bridge', channel: 'qq', principal: { login: 'login' }, canBindInput: true }, { id: 'local-search', channel: 'local', principal: { owner: 'one' } }] });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, base)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  try {
    good(api.writeHostFiles());
    const discovery = JSON.parse(fs.readFileSync(api.discoveryFiles['qq-bridge'], 'utf8'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(api.discoveryFiles['qq-bridge']).mode & 0o777, 0o600);
    const raw = async (body, headers = {}) => { const response = await fetch(`${base}${api.prefix}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-v2-token': discovery.token, ...headers }, body: JSON.stringify(body) }); return response.json(); };
    bad(await raw({ action: 'capture', conversationKey: 'login:private:a' }, { 'x-memory-v2-token': 'wrong' }), 'MEMORY_AUTH_REQUIRED');
    bad(await raw({ action: 'capture', conversationKey: 'login:private:a' }, { origin: 'http://evil.invalid' }), 'MEMORY_ORIGIN_REJECTED');
    bad(await raw({ action: 'capture', conversationKey: 'login:private:a', purpose: 'admin' }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await raw({ action: 'configurePolicy', policy: {} }), 'MEMORY_FIELD_FORBIDDEN');
    for (const action of ['constructor', 'toString', '__proto__']) bad(await raw({ action }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await raw({ action: 'withNetworkAdmission', handle: 'forged', dispatch: 'function' }), 'MEMORY_FIELD_FORBIDDEN');
    for (const key of ['dispatch', 'dispatchFunction', 'function']) bad(await raw({ action: 'capture', conversationKey: 'login:private:a', [key]: 'call' }), 'MEMORY_FIELD_FORBIDDEN');
    const client = createMemoryClient({ discoveryFile: api.discoveryFiles['qq-bridge'] });
    assert.equal(good(await client.status()).activeBackend, 'v2');
    const request = good(await client.capture('login:private:a')), prepared = good(await client.prepare(request.handle, 'current'));
    good(await client.validate(request.handle, prepared.preparedHandle)); good(await client.ingest(request.handle, [], 'op-one')); good(await client.receipt(request.handle, 'op-one'));
    const local = createMemoryClient({ discoveryFile: api.discoveryFiles['local-search'], scope: 'local-search' });
    bad(await local.search(request.handle, 'current'), 'MEMORY_HANDLE_STALE');
    const own = good(await local.capture('owner:thread:1')); bad(await local.bindActualInput(own.handle, []), 'MEMORY_ADAPTER_REQUIRED');
    bad(await raw({ action: 'validate', handle: request.handle, prepared: prepared.prepared }), 'MEMORY_FIELD_FORBIDDEN');
    api.close(); bad(await client.validate(request.handle), 'MEMORY_AUTH_REQUIRED');
  } finally { api.close(); f.host.close(); await new Promise((resolve) => server.close(resolve)); }
});
await test('real kernel policy resolution, durable ingestion, input binding, prepared validation and revoke', async () => {
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const current = { id: 'alpha', epoch: 1 }, management = Symbol('authenticated settings'), dir = path.join(root, 'kernel');
  const service = createMemoryService({ stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => current, authorizeManagement: (auth) => auth === management });
  try {
    good(await service.initialize());
    const base = { channel: 'qq', conversationKey: 'qq:login:private:a', sourceAccountKey: 'qq:login:actor:a', requesterAccountKey: 'qq:login:actor:a', providerRouteId: 'local:test', purpose: 'conversation', audiencePolicyId: 'private', processingGrantId: 'grant' };
    const action = async (value, operationId) => { const admin = good(await service.host.captureAdminContext(base, management)).context; return service.applyMemoryAction(admin, value, admin.controlRevision, operationId); };
    good(await action({ type: 'configure_policy', policy: { policyId: 'private', approved: true, audiences: [['qq', base.conversationKey, base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] } }, 'configure'));
    good(await action({ type: 'enable_shadow', enabled: true }, 'shadow'));
    const host = createMemoryHost({ memoryService: service, getCharacter: () => current, resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: base.sourceAccountKey, requesterAccountKey: base.requesterAccountKey, providerRouteId: base.providerRouteId }) });
    const adapter = host.createAdapter({ channel: 'qq', principal: {}, canBindInput: true }), request = good(await adapter.capture({ conversationKey: 'login:private:a' }));
    good(await adapter.ingest(request.handle, [{ eventId: 'event-one', operationId: 'source-one', sourceKey: 'source-one', producerId: 'fixture', segmentId: 'segment', producerSeq: 1, content: '记住小明没有答应见面，只是提出计划。' }], 'batch-one'));
    const prepared = good(await adapter.prepare(request.handle, '小明见面'));
    assert.ok(prepared.prepared.text.includes('小明')); assert.equal(prepared.inputManifest.length, 1);
    good(await adapter.bindActualInput(request.handle, [])); good(await adapter.validate(request.handle, prepared.preparedHandle));
    good(adapter.verifyPrepared(request.handle, prepared.preparedHandle, prepared.prepared));
    bad(adapter.verifyPrepared(request.handle, prepared.preparedHandle, { ...prepared.prepared, text: 'tampered' }), 'MEMORY_PREPARED_UNTRUSTED');
    good(await action({ type: 'revoke_policy', policyId: 'private' }, 'revoke'));
    bad(await adapter.validate(request.handle), 'MEMORY_CONTEXT_STALE');
    bad(await adapter.capture({ conversationKey: 'login:private:a' }), 'MEMORY_POLICY_DENIED'); host.close();
  } finally { await service.close(); }
});
await test('QQ sensor facts require Host login and allowlists; private inbound/outbound actors cannot impersonate a third party', async () => {
  const state = { accountId: '100', allowedGroups: ['900'], allowedPrivates: ['200'], providerRouteId: 'local:test' };
  const sourceFacts = { loginAccountId: '100', actorAccountId: '200', conversationType: 'group', conversationId: '900', objectId: '-812345' };
  const derived = resolveQQMemoryIdentity(state, sourceFacts);
  assert.equal(derived.sourceAccountKey, 'qq:200'); assert.equal(derived.conversationKey, 'qq:100:group:900');
  const privateFacts = { ...sourceFacts, conversationType: 'private', conversationId: '200' };
  assert.equal(resolveQQMemoryIdentity(state, privateFacts).requesterAccountKey, 'qq:200');
  const outbound = resolveQQMemoryIdentity(state, { ...privateFacts, actorAccountId: '100', direction: 'outbound' });
  assert.equal(outbound.sourceAccountKey, 'qq:100'); assert.equal(outbound.requesterAccountKey, 'qq:200');
  for (const facts of [{ ...sourceFacts, loginAccountId: '101' }, { ...sourceFacts, conversationId: '901' }, { ...privateFacts, actorAccountId: '201' }, { ...privateFacts, actorAccountId: '201', direction: 'outbound' }, { ...sourceFacts, actorAccountId: '201', direction: 'outbound' }]) bad(resolveQQMemoryIdentity(state, facts), 'MEMORY_IDENTITY_REQUIRED');
  for (const facts of [{ ...sourceFacts, objectId: '' }, { ...sourceFacts, actorAccountId: 200 }, { ...sourceFacts, objectId: '../message' }, { ...sourceFacts, objectId: 'random message' }, { ...sourceFacts, direction: 'admin' }, ...['characterId', 'policyId', 'providerRouteId', 'admin', 'inputManifest', 'deletionRevision'].map((key) => ({ ...sourceFacts, [key]: 'upgrade' }))]) bad(validateQQSourceFacts(facts), 'MEMORY_SOURCE_FACTS_INVALID');
  const f = fake(); bad(await f.adapter.capture({ conversationKey: '100:group:900', sourceFacts }), 'MEMORY_ADAPTER_REQUIRED');
  const host = createMemoryHost({ memoryService: f.service, getCharacter: f.current, now: f.clock, resolveIdentity: ({ sourceFacts: facts }) => resolveQQMemoryIdentity(state, facts) });
  const trusted = host.createAdapter({ channel: 'qq', principal: {}, canSubmitSourceFacts: true });
  const captured = good(await trusted.capture({ conversationKey: '100:group:900', sourceFacts }));
  assert.equal(captured.sourceStamp.sourceAccountKey, 'qq:200'); assert.ok(Object.keys(captured.sourceStamp).every((key) => CONTEXT_FIELDS.includes(key)));
  assert.equal(captured.sourceStamp.admin, undefined); assert.equal(captured.sourceStamp.workerMac, undefined); assert.equal((await f.service.validateContext(captured.sourceStamp)).code, 'MEMORY_CONTEXT_UNTRUSTED');
  bad(await trusted.capture({ conversationKey: '100:group:901', sourceFacts }), 'MEMORY_IDENTITY_REQUIRED');
  bad(await trusted.capture({ conversationKey: '100:group:900', sourceStamp: captured.sourceStamp }), 'MEMORY_FIELD_FORBIDDEN');
  host.close();
});
await test('real HTTP and kernel retain group actors, separate logins and atomically replay complete spool cursor receipts', async () => {
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const current = { id: 'alpha', epoch: 1 }, management = Symbol('authenticated identity settings'), dir = path.join(root, 'identity');
  let login = '100', base;
  const service = createMemoryService({ stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => current, authorizeManagement: (auth) => auth === management });
  let host, api, server;
  try {
    good(await service.initialize());
    const initial = { channel: 'qq', conversationKey: 'qq:100:group:900', sourceAccountKey: 'qq:200', requesterAccountKey: 'qq:200', providerRouteId: 'local:test', purpose: 'conversation', audiencePolicyId: 'group100', processingGrantId: 'grant' };
    const action = async (value, operationId) => { const admin = good(await service.host.captureAdminContext(initial, management)).context; return service.applyMemoryAction(admin, value, admin.controlRevision, operationId); };
    for (const account of ['100', '101']) good(await action({ type: 'configure_policy', policy: { policyId: `group${account}`, approved: true, audiences: [['qq', `qq:${account}:group:900`, '*']], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] } }, `policy-group-${account}`));
    good(await action({ type: 'configure_policy', policy: { policyId: 'private100', approved: true, audiences: [['qq', 'qq:100:private:200', 'qq:200']], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] } }, 'policy-private'));
    good(await action({ type: 'enable_shadow', enabled: true }, 'identity-shadow'));
    host = createMemoryHost({ memoryService: service, getCharacter: () => current, resolveIdentity: ({ sourceFacts }) => resolveQQMemoryIdentity({ accountId: login, allowedGroups: ['900'], allowedPrivates: ['200'], providerRouteId: 'local:test' }, sourceFacts) });
    api = createMemoryApiService({ host, stateDir: path.join(dir, 'transport'), currentDshUrl: () => base, scopes: [{ id: 'qq-bridge', channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true }, { id: 'qq-search', channel: 'qq', principal: { process: 'ordinary-search' } }] });
    server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, base)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; good(api.writeHostFiles());
    const client = createMemoryClient({ discoveryFile: api.discoveryFiles['qq-bridge'], getCharacter: () => current });
    const search = createMemoryClient({ discoveryFile: api.discoveryFiles['qq-search'], scope: 'qq-search' });
    const facts = (actor, extra = {}) => ({ loginAccountId: login, actorAccountId: actor, conversationType: 'group', conversationId: '900', objectId: `message-${actor}`, ...extra });
    bad(await search.capture('100:group:900', { sourceFacts: facts('200') }), 'MEMORY_ADAPTER_REQUIRED');
    bad(await client.capture('100:group:900', { sourceFacts: { ...facts('200'), policyId: 'upgrade' } }), 'MEMORY_SOURCE_FACTS_INVALID');
    bad(await client.capture('100:group:900', { sourceFacts: facts('200', { loginAccountId: '101' }) }), 'MEMORY_IDENTITY_REQUIRED');
    const first = good(await client.capture('100:group:900', { sourceFacts: facts('200') }));
    const second = good(await client.capture('100:group:900', { sourceFacts: facts('201') }));
    assert.equal(first.sourceStamp.sourceAccountKey, 'qq:200'); assert.equal(second.sourceStamp.sourceAccountKey, 'qq:201');
    assert.notEqual(first.sourceStamp.sourceAccountKey, 'qq:100'); assert.equal(first.sourceStamp.audiencePolicyId, 'group100');
    bad(await service.validateContext(first.sourceStamp), 'MEMORY_CONTEXT_UNTRUSTED');
    const importOne = async (captured, suffix, content) => {
      const spool = createSpool({ directory: path.join(dir, `spool-${suffix}`), producerId: `producer-${suffix}`, segmentId: `segment-${suffix}`, context: captured.sourceStamp }); good(spool);
      good(spool.append({ eventId: `event-${suffix}`, operationId: `source-${suffix}`, sourceKey: `source-${suffix}`, content })); good(spool.seal());
      const batch = good(readSpool({ file: spool.file }));
      assert.equal(batch.events[0].actorAccountKey, captured.sourceStamp.sourceAccountKey);
      const imported = good(await client.ingest(captured.handle, batch, `batch-${suffix}`)); assert.equal(imported.nextOffset, batch.nextOffset);
      assert.deepEqual(good(await client.ingest(captured.handle, batch, `batch-${suffix}`)), imported);
      assert.deepEqual(good(await client.receipt(captured.handle, `batch-${suffix}`)), imported);
      bad(await client.ingest(captured.handle, { ...batch, file: spool.file }, `bad-file-${suffix}`), 'MEMORY_FIELD_FORBIDDEN');
      bad(await client.ingest(captured.handle, batch, `bad-offset-${suffix}`), 'MEMORY_OFFSET_GAP');
      return batch;
    };
    const original = await importOne(first, 'member200', '群聊咖啡话题来自成员甲');
    await importOne(second, 'member201', '群聊咖啡话题来自成员乙');
    assert.deepEqual(good(await client.search(second.handle, '咖啡')).records.map((item) => item.id).sort(), ['event-member200', 'event-member201']);
    const forgedEvent = { ...original.events[0], actorAccountKey: 'qq:201' }; forgedEvent.payloadDigest = eventDigest(forgedEvent);
    bad(await client.ingest(first.handle, { ...original, events: [forgedEvent] }, 'forged-actor'), 'MEMORY_EVENT_CONTEXT_MISMATCH');
    const privateRequest = good(await client.capture('100:private:200', { sourceFacts: facts('200', { conversationType: 'private', conversationId: '200' }) }));
    const selfReply = good(await client.capture('100:private:200', { sourceFacts: facts('100', { conversationType: 'private', conversationId: '200', direction: 'outbound', objectId: 'stable-send-operation' }) }));
    assert.equal(privateRequest.sourceStamp.sourceAccountKey, 'qq:200'); assert.equal(selfReply.sourceStamp.sourceAccountKey, 'qq:100'); assert.equal(selfReply.sourceStamp.requesterAccountKey, 'qq:200');
    await importOne(selfReply, 'self-reply', '私聊确认发出的伙伴回复');
    bad(await client.capture('100:private:200', { sourceFacts: facts('201', { conversationType: 'private', conversationId: '200', direction: 'outbound' }) }), 'MEMORY_IDENTITY_REQUIRED');
    login = '101';
    const otherLogin = good(await client.capture('101:group:900', { sourceFacts: facts('200') }));
    assert.equal(otherLogin.sourceStamp.sourceAccountKey, first.sourceStamp.sourceAccountKey); assert.notEqual(otherLogin.sourceStamp.conversationKey, first.sourceStamp.conversationKey);
    assert.equal(good(await client.search(otherLogin.handle, '咖啡')).records.length, 0);
    bad(await client.capture('100:group:900', { sourceFacts: facts('200', { loginAccountId: '100' }) }), 'MEMORY_IDENTITY_REQUIRED');
  } finally { api?.close(); host?.close(); if (server?.listening) await new Promise((resolve) => server.close(resolve)); await service.close(); }
});
await test('real producer registry survives Host restart and replays original role through private scoped RPC only', async () => {
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const dir = path.join(root, 'producer-recovery'), management = Symbol('fixture management');
  let current = { id: 'alpha', epoch: 1 }, proof = Symbol('official QQ replay'), login = '100', groups = ['900'], authMode = 'allow', onReplayAuthorized = null, dropRegistrationResponse = false, droppedRegistrationResponse, service, host, api, server, base;
  const initial = { channel: 'qq', conversationKey: 'qq:100:group:900', sourceAccountKey: 'qq:200', requesterAccountKey: 'qq:200', providerRouteId: 'local:test', purpose: 'conversation', audiencePolicyId: 'producer-group', processingGrantId: 'producer-grant' };
  const identity = ({ sourceFacts }) => resolveQQMemoryIdentity({ accountId: login, allowedGroups: groups, allowedPrivates: [], providerRouteId: 'local:test' }, sourceFacts);
  const authorize = (authorization, registration) => {
    if (authMode === 'async-false') return Promise.resolve(false);
    const scopeAllowed = registration.kind === 'registration_receipt_lookup' ? (assert.deepEqual(Object.keys(registration).sort(), ['kind', 'operationId']), typeof registration.operationId === 'string') : registration.channel === 'qq' && registration.conversationKey === initial.conversationKey && registration.sourceAccountKey === initial.sourceAccountKey && registration.requesterAccountKey === initial.requesterAccountKey && registration.providerRouteId === initial.providerRouteId;
    const allowed = authMode === 'allow' && authorization === proof && login === '100' && groups.includes('900') && scopeAllowed;
    if (allowed) { const hook = onReplayAuthorized; onReplayAuthorized = null; hook?.(); } return allowed;
  };
  const factory = ({ channel, principal }) => channel === 'qq' && principal.process === 'official-bridge' ? proof : null;
  async function start() {
    service = createMemoryService({ stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => current, authorizeManagement: (value) => value === management, authorizeProducerReplay: authorize, retireForLifecycle: async (challenge) => {
      host?.retireAll(); current = { id: challenge.characterId, epoch: current.epoch + 1 };
      return { ok: true, nonce: challenge.nonce, characterId: current.id, epoch: current.epoch, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true };
    } }); good(await service.initialize());
    assert.equal(typeof service.host.registerProducer, 'function'); assert.equal(typeof service.host.replayProducer, 'function'); assert.equal(typeof service.host.queryProducerReceipt, 'function');
    host = createMemoryHost({ memoryService: service, getCharacter: () => current, resolveIdentity: identity, getProducerReplayAuthorization: factory });
    api = createMemoryApiService({ host, stateDir: path.join(dir, 'transport'), currentDshUrl: () => base, scopes: [{ id: 'qq-bridge', channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true }, { id: 'qq-search', channel: 'qq', principal: { process: 'ordinary-search' } }, { id: 'local-search', channel: 'local', principal: { process: 'local-search' } }] });
    server = http.createServer((req, res) => {
      const end = res.end.bind(res);
      res.end = (body, ...args) => {
        if (dropRegistrationResponse && req.method === 'POST' && body) {
          const result = JSON.parse(String(body));
          if (result.ok && result.registrationState === 'durable' && result.operationId === 'original-register') { droppedRegistrationResponse = result; dropRegistrationResponse = false; res.destroy(); return res; }
        }
        return end(body, ...args);
      };
      return api.handle(req, res, new URL(req.url, base));
    }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; good(api.writeHostFiles());
  }
  async function stop() { api?.close(); host?.close(); if (server?.listening) await new Promise((resolve) => server.close(resolve)); await service?.close(); }
  const admin = async () => good(await service.host.captureAdminContext(initial, management)).context;
  const action = async (value, id) => { const ctx = await admin(); return service.applyMemoryAction(ctx, value, ctx.controlRevision, id); };
  const sourceFacts = { loginAccountId: '100', actorAccountId: '200', conversationType: 'group', conversationId: '900', objectId: 'durable-original' };
  try {
    await start();
    good(await action({ type: 'configure_policy', policy: { policyId: initial.audiencePolicyId, approved: true, audiences: [['qq', initial.conversationKey, '*']], processingGrants: [{ grantId: initial.processingGrantId, providerRouteId: initial.providerRouteId }] } }, 'producer-policy'));
    good(await action({ type: 'enable_shadow', enabled: true }, 'producer-shadow'));
    const client = createMemoryClient({ discoveryFile: api.discoveryFiles['qq-bridge'], getCharacter: () => current });
    const captured = good(await client.capture('100:group:900', { sourceFacts }));
    const lateContext = good(await service.captureContext(initial)).context;
    bad(await service.captureContext({ ...initial, purpose: 'producer_replay' }), 'MEMORY_SCHEMA_INVALID');
    const producer = { producerId: 'original-qq-producer', segmentId: 'original-alpha-segment' };
    dropRegistrationResponse = true;
    const lostRegistration = bad(await client.registerProducer(captured.handle, producer, 'original-register'), 'MEMORY_HOST_UNAVAILABLE');
    assert.equal(lostRegistration.operationId, 'original-register'); assert.equal(lostRegistration.operationState, 'unknown'); assert.equal(lostRegistration.sourceState, 'pending'); assert.equal(lostRegistration.retry, 'query_receipt'); assert.equal(lostRegistration.registrationId, undefined);
    assert.equal(droppedRegistrationResponse.registrationState, 'durable');
    const spool = good(createSpool({ directory: path.join(dir, 'durable-spool'), ...producer, context: captured.sourceStamp }));
    for (const suffix of ['one', 'two']) { const queued = good(spool.append({ eventId: `producer-event-${suffix}`, operationId: `producer-source-${suffix}`, sourceKey: `producer-key-${suffix}`, content: `原始角色的咖啡消息 ${suffix}` })); assert.equal(queued.acceptance, 'queued_durable'); }
    good(spool.seal()); const firstBatch = good(readSpool({ file: spool.file, maxEvents: 1 })), nextBatch = good(readSpool({ file: spool.file, offset: firstBatch.nextOffset, maxEvents: 1 }));
    assert.equal(firstBatch.incompleteTail, true); assert.equal(nextBatch.incompleteTail, false);
    const oldToken = JSON.parse(fs.readFileSync(api.discoveryFiles['qq-bridge'], 'utf8')).token, oldHost = host;
    current = { id: 'beta', epoch: 3 };
    bad(await service.proposeMemory(lateContext, {}, 'late-model-proposal'), 'CHARACTER_EPOCH_STALE');
    await stop(); proof = Symbol('new Host official QQ proof'); await start();
    const recovery = createMemoryClient({ discoveryFile: api.discoveryFiles['qq-bridge'], getCharacter: () => current });
    const registered = good(await recovery.queryProducerReceipt({ operationId: 'original-register' })); assert.deepEqual(registered, droppedRegistrationResponse);
    assert.equal(registered.registrationState, 'durable'); assert.equal(registered.characterId, 'alpha'); assert.equal(registered.capturedEpoch, 1); assert.equal(registered.context, undefined); assert.equal(registered.authorization, undefined);
    assert.deepEqual(good(await recovery.queryProducerReceipt({ operationId: 'original-register' })), registered);
    assert.deepEqual(good(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: 'original-register' })), registered);
    bad(await recovery.queryProducerReceipt({ registrationId: 'wrong-registration', operationId: 'original-register' }), 'MEMORY_PRODUCER_SCOPE_CONFLICT');
    const absent = good(await recovery.queryProducerReceipt({ operationId: 'registry-never-committed' })); assert.equal(absent.operationState, 'not_found'); assert.equal(absent.registrationId, undefined); assert.equal(absent.characterId, undefined); assert.equal(absent.capturedEpoch, undefined); assert.equal(absent.context, undefined);
    const request = { registrationId: registered.registrationId, batch: firstBatch, operationId: 'original-replay-one' };
    const raw = async (body, token = JSON.parse(fs.readFileSync(api.discoveryFiles['qq-bridge'], 'utf8')).token) => { const response = await fetch(`${base}${api.prefix}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-v2-token': token }, body: JSON.stringify(body) }); return response.json(); };
    bad(await raw({ action: 'replayProducer', ...request }, oldToken), 'MEMORY_AUTH_REQUIRED');
    bad(await recovery.registerProducer(captured.handle, producer, 'late-register'), 'MEMORY_HANDLE_STALE');
    bad(await oldHost.createAdapter({ channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true }).replayProducer(request), 'MEMORY_HANDLE_STALE');
    bad(await service.proposeMemory(lateContext, {}, 'late-after-restart'), 'MEMORY_CONTEXT_UNTRUSTED');
    const before = good(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId })); assert.equal(before.operationState, 'not_found'); assert.equal(before.characterId, 'alpha'); assert.equal(before.capturedEpoch, 1);
    for (const scope of ['qq-search', 'local-search']) {
      const unrelated = createMemoryClient({ discoveryFile: api.discoveryFiles[scope], scope });
      bad(await unrelated.registerProducer('irrelevant', producer, 'scope-register'), 'MEMORY_ADAPTER_REQUIRED'); bad(await unrelated.replayProducer(request), 'MEMORY_ADAPTER_REQUIRED'); bad(await unrelated.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId }), 'MEMORY_ADAPTER_REQUIRED');
    }
    for (const getProducerReplayAuthorization of [undefined, () => false, async () => proof]) {
      const unprivileged = createMemoryHost({ memoryService: service, getCharacter: () => current, resolveIdentity: identity, ...(getProducerReplayAuthorization ? { getProducerReplayAuthorization } : {}) });
      const adapter = unprivileged.createAdapter({ channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true });
      bad(await adapter.replayProducer(request), 'MEMORY_PRODUCER_REPLAY_DENIED'); bad(await adapter.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId }), 'MEMORY_PRODUCER_REPLAY_DENIED'); unprivileged.close();
    }
    const forged = createMemoryHost({ memoryService: service, getCharacter: () => current, getProducerReplayAuthorization: () => Symbol('same scope forged proof') });
    bad(await forged.createAdapter({ channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true }).replayProducer(request), 'MEMORY_PRODUCER_REPLAY_DENIED'); forged.close();
    for (const mode of ['false', 'async-false']) { authMode = mode; bad(await recovery.replayProducer(request), 'MEMORY_PRODUCER_REPLAY_DENIED'); bad(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId }), 'MEMORY_PRODUCER_REPLAY_DENIED'); bad(await recovery.queryProducerReceipt({ operationId: 'original-register' }), 'MEMORY_PRODUCER_REPLAY_DENIED'); bad(await recovery.queryProducerReceipt({ operationId: 'registry-never-committed' }), 'MEMORY_PRODUCER_REPLAY_DENIED'); } authMode = 'allow';
    login = '101'; bad(await recovery.replayProducer(request), 'MEMORY_PRODUCER_REPLAY_DENIED'); login = '100'; groups = []; bad(await recovery.replayProducer(request), 'MEMORY_PRODUCER_REPLAY_DENIED'); groups = ['900'];
    for (const key of ['authorization', 'principal', 'characterId', 'capturedEpoch', 'purpose', 'context']) bad(await raw({ action: 'replayProducer', ...request, [key]: 'forged' }), 'MEMORY_FIELD_FORBIDDEN');
    for (const key of ['file', 'path', 'sql', 'authorization']) bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, [key]: 'SECRET_SOURCE' } }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await recovery.replayProducer({ ...request, batch: firstBatch.events }), 'MEMORY_FIELD_FORBIDDEN');
    bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, events: [{ ...firstBatch.events[0], content: 'tampered without original digest' }] } }), 'MEMORY_DIGEST_CONFLICT');
    bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, events: [{ ...firstBatch.events[0], authorization: 'forged' }] } }), 'MEMORY_FIELD_FORBIDDEN');
    for (const registrationId of ['', 'x'.repeat(257), null]) bad(await recovery.replayProducer({ ...request, registrationId }), 'MEMORY_IDENTITY_REQUIRED');
    bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, segmentDigest: 'a'.repeat(64) } }), 'MEMORY_DIGEST_CONFLICT');
    bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, nextOffset: firstBatch.nextOffset + 1 } }), 'MEMORY_OFFSET_GAP');
    for (const [key, value] of [['characterId', 'beta'], ['capturedEpoch', 3], ['channel', 'local'], ['conversationKey', 'qq:100:group:901'], ['actorAccountKey', 'qq:201'], ['policyId', 'forged-policy'], ['processingGrantId', 'forged-grant']]) {
      const event = { ...firstBatch.events[0], [key]: value }; event.payloadDigest = eventDigest(event);
      bad(await recovery.replayProducer({ ...request, batch: { ...firstBatch, events: [event] } }), 'MEMORY_PRODUCER_SCOPE_CONFLICT');
    }
    bad(await raw({ action: 'searchProducer', registrationId: registered.registrationId, query: '咖啡' }), 'MEMORY_FIELD_FORBIDDEN');
    const imported = good(await recovery.replayProducer(request)); assert.equal(imported.characterId, 'alpha'); assert.equal(imported.capturedEpoch, 1); assert.equal(imported.sourceState, 'committed'); assert.equal(imported.nextOffset, firstBatch.nextOffset); assert.equal(imported.context, undefined);
    assert.deepEqual(good(await recovery.replayProducer(request)), imported);
    assert.deepEqual(good(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId })), imported);
    const noRoleScan = good(await recovery.queryProducerReceipt({ operationId: request.operationId })); assert.equal(noRoleScan.operationState, 'not_found'); assert.equal(noRoleScan.registrationId, undefined); assert.equal(noRoleScan.characterId, undefined);
    const secondRequest = { registrationId: registered.registrationId, batch: nextBatch, operationId: 'original-replay-two' };
    const second = good(await recovery.replayProducer(secondRequest)); assert.equal(second.nextOffset, nextBatch.nextOffset); assert.equal(second.capturedEpoch, 1);
    assert.deepEqual(good(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId })), imported);
    bad(await recovery.replayProducer({ ...request, operationId: 'new-id-must-not-reset-cursor' }), 'MEMORY_OFFSET_GAP');
    const retiringHost = createMemoryHost({ memoryService: service, getCharacter: () => current, getProducerReplayAuthorization: () => proof });
    const retiringAdapter = retiringHost.createAdapter({ channel: 'qq', principal: { process: 'official-bridge' }, canSubmitSourceFacts: true });
    onReplayAuthorized = () => retiringHost.close();
    const interrupted = bad(await retiringAdapter.replayProducer(request), 'MEMORY_HANDLE_STALE'); assert.equal(interrupted.sourceState, 'committed'); assert.equal(interrupted.operationState, 'completed_before_cancel'); assert.equal(interrupted.operationId, request.operationId); assert.equal(interrupted.retry, 'query_receipt');
    assert.deepEqual(good(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId })), imported);
    const beta = good(await recovery.capture('100:group:900', { sourceFacts })); assert.equal(good(await recovery.search(beta.handle, '咖啡')).records.length, 0);
    current = { id: 'alpha', epoch: 4 }; const alpha = good(await recovery.capture('100:group:900', { sourceFacts }));
    assert.deepEqual(good(await recovery.search(alpha.handle, '咖啡')).records.map((item) => item.id).sort(), ['producer-event-one', 'producer-event-two']);
    const deleteContext = await admin(), deletion = good(await service.host.lifecycle.previewDelete(deleteContext, { roots: ['producer-event-one'] }));
    const deleted = good(await service.host.lifecycle.requestDelete(deleteContext, { roots: ['producer-event-one'], previewDigest: deletion.previewDigest }, deleteContext.controlRevision, 'producer-delete-root'));
    assert.equal(deleted.accessState, 'access_revoked'); assert.equal(deleted.phase, 'completed');
    bad(await recovery.replayProducer(request), 'MEMORY_SOURCE_DELETED');
    good(await action({ type: 'revoke_policy', policyId: initial.audiencePolicyId }, 'producer-revoke'));
    bad(await recovery.replayProducer(secondRequest), 'MEMORY_POLICY_DENIED'); bad(await recovery.queryProducerReceipt({ registrationId: registered.registrationId, operationId: request.operationId }), 'MEMORY_POLICY_DENIED');
  } finally { await stop(); }
});
await test('private network admission denies absent hooks, forged/foreign/released/expired handles and invalid callbacks', async () => {
  const f = fake(), request = good(await f.adapter.capture({ conversationKey: 'login:private:a' })); let calls = 0;
  await admissionDenied(f.adapter.withNetworkAdmission(request.handle, () => calls++), 'MEMORY_NETWORK_ADMISSION_UNSUPPORTED');
  await admissionDenied(f.adapter.withNetworkAdmission(request.handle, null), 'MEMORY_NETWORK_DISPATCH_REQUIRED');
  await admissionDenied(f.adapter.withNetworkAdmission(request.handle, () => calls++, { signal: {} }), 'MEMORY_ADMISSION_SIGNAL_INVALID');
  const other = f.host.createAdapter({ channel: 'qq', principal: { other: true } });
  await admissionDenied(other.withNetworkAdmission(request.handle, () => calls++), 'MEMORY_HANDLE_STALE');
  await admissionDenied(f.adapter.withNetworkAdmission(request.sourceStamp, () => calls++), 'MEMORY_HANDLE_STALE');
  good(f.adapter.release(request.handle)); await admissionDenied(f.adapter.withNetworkAdmission(request.handle, () => calls++), 'MEMORY_HANDLE_STALE');
  const expiring = good(await f.adapter.capture({ conversationKey: 'login:private:a' })); f.advance(); await admissionDenied(f.adapter.withNetworkAdmission(expiring.handle, () => calls++), 'MEMORY_HANDLE_STALE');
  assert.equal(calls, 0); f.host.close();
});
await test('real Host admission validates full actual manifest, source expiry and ordinary WeakMap context', async () => {
  const f = await networkFixture('network-manifest'); let calls = 0;
  try {
    const request = good(await f.capture());
    good(await f.adapter.ingest(request.handle, [{ eventId: 'amber', operationId: 'source-amber', sourceKey: 'source-amber', producerId: 'network-fixture', segmentId: 'segment-amber', producerSeq: 1, content: 'exclusive amberzebra history' }, { eventId: 'violet', operationId: 'source-violet', sourceKey: 'source-violet', producerId: 'network-fixture', segmentId: 'segment-violet', producerSeq: 1, content: 'exclusive violetbadger history', expiresAt: new Date(f.time + 2000).toISOString() }], 'source-pair'));
    good(await f.adapter.prepare(request.handle, 'violetbadger'));
    const selected = good(await f.adapter.prepare(request.handle, 'amberzebra')); assert.equal(selected.prepared.inputManifest.length, 1); assert.equal(selected.inputManifest.length, 2);
    f.time += 2500;
    await admissionDenied(f.adapter.withNetworkAdmission(request.handle, () => calls++), 'MEMORY_SOURCE_STALE');
    const fresh = good(await f.capture());
    const adminHost = f.makeHost({ ...f.service, captureContext: (facts) => f.service.host.captureAdminContext(facts, f.management) }), adminAdapter = adminHost.createAdapter({ channel: 'qq', principal: {} });
    const admin = good(await adminAdapter.capture({ conversationKey: 'login:private:a' })); await admissionDenied(adminAdapter.withNetworkAdmission(admin.handle, () => calls++), 'MEMORY_ADMIN_REQUIRED'); adminHost.close();
    const forgedHost = f.makeHost({ ...f.service, captureContext: async (facts) => { const captured = await f.service.captureContext(facts); return { ...captured, context: structuredClone(captured.context) }; } }), forgedAdapter = forgedHost.createAdapter({ channel: 'qq', principal: {} });
    const forged = good(await forgedAdapter.capture({ conversationKey: 'login:private:a' })); await admissionDenied(forgedAdapter.withNetworkAdmission(forged.handle, () => calls++), 'MEMORY_CONTEXT_UNTRUSTED'); forgedHost.close();
    const revokeContext = good(await f.service.host.captureAdminContext(f.base, f.management)).context;
    const revoke = f.service.applyMemoryAction(revokeContext, { type: 'revoke_policy', policyId: 'private' }, revokeContext.controlRevision, 'network-revoke-first');
    const blocked = f.adapter.withNetworkAdmission(fresh.handle, () => calls++); good(await revoke); await admissionDenied(blocked, 'MEMORY_CONTEXT_STALE');
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
await test('real admission releases the fence before network response and preserves raw usage-bearing outcomes', async () => {
  const f = await networkFixture('network-usage'), reached = deferred(), responseGate = deferred(); let base, calls = 0, rawResult, settled = false;
  const server = http.createServer(async (_req, res) => { reached.resolve(); await responseGate.promise; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { inputTokens: 7, outputTokens: 3 }, requestId: 'fixture-provider-request', text: 'fixture output' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  try {
    const request = good(await f.capture());
    const response = f.adapter.withNetworkAdmission(request.handle, () => { calls++; return fetch(base).then((res) => res.json()).then((value) => { rawResult = value; return value; }); }); response.then(() => { settled = true; });
    await bounded(reached.promise); good(await bounded(f.action({ type: 'revoke_policy', policyId: 'private' }, 'network-revoke-while-inflight'))); assert.equal(settled, false);
    f.current = { id: 'beta', epoch: 3 }; responseGate.resolve(); const result = await bounded(response); assert.strictEqual(result, rawResult); assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 }); assert.equal(calls, 1);
    f.current = { id: 'alpha', epoch: 4 }; good(await f.action({ type: 'configure_policy', policy: { policyId: 'private-2', approved: true, audiences: [['qq', f.base.conversationKey, f.base.requesterAccountKey]], processingGrants: [{ grantId: 'grant-2', providerRouteId: 'local:test' }] } }, 'network-new-policy'));
    const next = good(await f.capture()), syncError = Object.assign(new Error('fixture synchronous provider failure'), { usage: { inputTokens: 2 }, requestId: 'fixture-sync' });
    await assert.rejects(f.adapter.withNetworkAdmission(next.handle, () => { calls++; throw syncError; }), (error) => error === syncError);
    const rawError = Object.assign(new Error('fixture provider rejection'), { usage: { inputTokens: 5 }, requestId: 'fixture-rejected' });
    await assert.rejects(f.adapter.withNetworkAdmission(next.handle, () => { calls++; f.current = { id: 'beta', epoch: 5 }; return Promise.reject(rawError); }), (error) => error === rawError);
    assert.equal(calls, 3);
  } finally { responseGate.resolve(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await f.close(); }
});
await test('real queued admission checks release/close, aborts pending input and breaks lifecycle job-idle deadlocks', async () => {
  const f = await networkFixture('network-queued'); let calls = 0; const bindEntered = deferred(), bindGate = deferred(), retireEntered = deferred(), jobIdle = deferred();
  try {
    const request = good(await f.capture()), originalBind = f.service.host.bindInputManifest;
    const bindHost = f.makeHost({ ...f.service, host: { ...f.service.host, bindInputManifest: async (...args) => { bindEntered.resolve(); await bindGate.promise; return originalBind(...args); } } }), binding = bindHost.createAdapter({ channel: 'qq', principal: {}, canBindInput: true }), bound = good(await binding.capture({ conversationKey: 'login:private:a' }));
    const bind = binding.bindActualInput(bound.handle, []); await bounded(bindEntered.promise);
    const inputAbort = new AbortController(), waitingInput = binding.withNetworkAdmission(bound.handle, () => calls++, { signal: inputAbort.signal }); inputAbort.abort(); await admissionDenied(bounded(waitingInput, 300), 'MEMORY_ADMISSION_ABORTED');
    bindGate.resolve(); good(await bind); bindHost.close();
    for (const closeQueued of [false, true]) {
      const admitted = good(await f.capture()), writer = good(await f.capture()), held = f.hold('ingestEvents');
      const mutation = f.adapter.ingest(writer.handle, [{ eventId: `queued-${closeQueued}`, operationId: `queued-source-${closeQueued}`, sourceKey: `queued-source-${closeQueued}`, producerId: 'network-fixture', segmentId: `segment-${closeQueued}`, producerSeq: 1, content: 'fixture admission fence blocker' }], `queued-ingest-${closeQueued}`);
      await bounded(held.entered.promise);
      const hookEntered = deferred(), originalAdmission = f.service.host.withNetworkAdmission;
      const queuedHost = closeQueued ? f.makeHost({ ...f.service, host: { ...f.service.host, withNetworkAdmission: (...args) => { const result = originalAdmission(...args); hookEntered.resolve(); return result; } } }) : f.host;
      const queuedAdapter = closeQueued ? queuedHost.createAdapter({ channel: 'qq', principal: {} }) : f.adapter;
      const handle = closeQueued ? good(await queuedAdapter.capture({ conversationKey: 'login:private:a' })).handle : admitted.handle;
      let waiting;
      if (closeQueued) { waiting = queuedAdapter.withNetworkAdmission(handle, () => calls++); await bounded(hookEntered.promise); queuedHost.close(); }
      else { waiting = queuedAdapter.withNetworkAdmission(handle, () => calls++); await new Promise((resolve) => setImmediate(resolve)); good(queuedAdapter.release(handle)); }
      held.release(); good(await mutation); await admissionDenied(bounded(waiting), 'MEMORY_HANDLE_STALE');
    }
    const source = good(await f.capture()); good(await f.adapter.ingest(source.handle, [{ eventId: 'lifecycle-root', operationId: 'lifecycle-source', sourceKey: 'lifecycle-source', producerId: 'network-fixture', segmentId: 'segment-lifecycle', producerSeq: 1, content: 'fixture lifecycle source' }], 'lifecycle-source-ingest'));
    const admin = good(await f.service.host.captureAdminContext(f.base, f.management)).context, preview = good(await f.service.host.lifecycle.previewDelete(admin, { roots: ['lifecycle-root'] }));
    const queueEntered = deferred(), originalAdmission = f.service.host.withNetworkAdmission;
    const lifecycleHost = f.makeHost({ ...f.service, host: { ...f.service.host, withNetworkAdmission: (...args) => { const result = originalAdmission(...args); queueEntered.resolve(); return result; } } }), lifecycleAdapter = lifecycleHost.createAdapter({ channel: 'qq', principal: {} });
    const lifecycleRequest = good(await lifecycleAdapter.capture({ conversationKey: 'login:private:a' }));
    f.retire = async () => { retireEntered.resolve(); await jobIdle.promise; };
    const deletion = f.service.host.lifecycle.requestDelete(admin, { roots: ['lifecycle-root'], previewDigest: preview.previewDigest }, admin.controlRevision, 'network-lifecycle-delete'); await bounded(retireEntered.promise);
    const controller = new AbortController(), waiting = lifecycleAdapter.withNetworkAdmission(lifecycleRequest.handle, () => calls++, { signal: controller.signal });
    await bounded(queueEntered.promise);
    const rejected = admissionDenied(bounded(waiting, 300), 'MEMORY_ADMISSION_ABORTED').finally(() => jobIdle.resolve()); controller.abort(); await rejected; good(await bounded(deletion)); lifecycleHost.close(); assert.equal(calls, 0);
  } finally { bindGate.resolve(); jobIdle.resolve(); await f.close(); }
});
console.log(`Memory Host: ${count} security groups passed on ${process.version}; fixture ${path.basename(root)}`);
