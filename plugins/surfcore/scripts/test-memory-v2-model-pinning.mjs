import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = path.resolve('_backups/memory-v2-model-pinning', `fixtures-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
process.env.DSH_HOME = path.join(root, 'dsh');
const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');
const { createCompanionModel, COMPANION_ROUTE } = await import('../lib/douyin-companion-model.mjs');
const { createCompanionMemory } = await import('../lib/douyin-companion-memory.mjs');
const { createTokenBudgetService } = await import('../lib/token-budget.js');
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const image = { atMs: 123, dataUrl: 'data:image/jpeg;base64,YWJj' };
const routeId = good(deriveMemoryProviderRouteId(COMPANION_ROUTE)).providerRouteId;
let count = 0;
const terminalCodes = new Set();
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }
async function denied(pending, code) {
  let caught;
  try { await pending; } catch (error) { caught = error; }
  assert.ok(caught, 'must reject'); assert.ok(caught.code && caught.hint, 'structured actionable denial'); terminalCodes.add(caught.code);
  if (code) assert.equal(caught.code, code);
  return caught;
}
async function fixture(name, run) {
  const dir = path.join(root, name), authority = Symbol('isolated settings');
  let role = { id: `pin-${name}`, epoch: 1 }, actionNumber = 0;
  const service = createMemoryService({ stateDir: path.join(dir, 'state'), charactersDir: path.join(dir, 'characters'), getCharacter: () => role, authorizeManagement: value => value === authority });
  good(await service.initialize());
  const facts = { channel: 'douyin', conversationKey: 'douyin:pinning', sourceAccountKey: 'douyin:account', requesterAccountKey: 'douyin:owner', providerRouteId: routeId, purpose: 'conversation', audiencePolicyId: 'private', processingGrantId: 'fixed' };
  const action = async value => { const admin = good(await service.host.captureAdminContext(facts, authority)).context; return good(await service.applyMemoryAction(admin, value, admin.controlRevision, `${name}:${++actionNumber}`)); };
  await action({ type: 'configure_policy', policy: { policyId: 'private', approved: true, audiences: [[facts.channel, facts.conversationKey, facts.requesterAccountKey]], processingGrants: [{ grantId: 'fixed', providerRouteId: routeId }] } });
  await action({ type: 'enable_shadow', enabled: true });
  const host = createMemoryHost({ memoryService: service, getCharacter: () => role, handleTtlMs: 300000, resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: facts.sourceAccountKey, requesterAccountKey: facts.requesterAccountKey, providerRouteId: facts.providerRouteId }) });
  const adapter = host.createAdapter({ channel: 'douyin', principal: {}, canBindInput: true });
  const captured = good(await adapter.capture({ conversationKey: facts.conversationKey }));
  const source = good(await adapter.ingest(captured.handle, [{ eventId: `${name}:source`, operationId: `${name}:source`, sourceKey: `${name}:source`, producerId: 'pin-fixture', segmentId: 'source', producerSeq: 1, content: '海洋小鱼实际观察与完整音轨覆盖记录。' }], `${name}:ingest`));
  good(await adapter.bindActualInput(captured.handle, source.eventRefs));
  const packet = good(await adapter.prepare(captured.handle, '海洋小鱼', { memory: 1000, total: 3000 }));
  const budget = createTokenBudgetService({ ctx: {}, dshHome: path.join(dir, 'budget'), qqStateDir: path.join(dir, 'qq') });
  const stats = { prepared: 0, networks: 0, plain: 0, attachments: 0, gates: 0, externalUsage: 0, old: 0, replacement: 0 }, hooks = {}, sent = deferred();
  const originalReserve = budget.reserveModelCall;
  const reservations = [];
  budget.reserveModelCall = request => { reservations.push(request); return originalReserve(request); };
  budget.recordExternalUsage = () => { stats.externalUsage++; throw Error('admitted calls must not double record'); };
  let registration = 'old';
  const llm = {
    listModels: async () => [{ id: COMPANION_ROUTE.model, inputModalities: ['text', 'image'] }],
    stream: () => { stats.plain++; throw Error('V2 cannot use plain stream'); },
    async prepareCall(config, signal) {
      stats.prepared++; const pinned = registration;
      await hooks.prepare?.({ config, signal });
      if (hooks.prepareError) throw hooks.prepareError;
      const actual = Object.freeze({ ...config, ...(hooks.config ?? {}) });
      let used = false;
      return Object.freeze({ config: actual, stream(options) {
        assert.equal(used, false); used = true;
        assert.equal(options.provider, actual.provider); assert.equal(options.model, actual.model);
        assert.equal(options.maxTokens, actual.maxTokens); assert.equal(options.reasoningEffort, actual.reasoningEffort);
        assert.ok(options.signal instanceof AbortSignal); stats.options = options;
        const stream = (async function* () {
          stats.networks++; stats[pinned]++; sent.resolve();
          await hooks.response?.(options);
          if (hooks.unknown) throw Object.assign(Error('isolated provider disconnected'), { code: 'PROVIDER_DISCONNECTED' });
          if (hooks.errorUsage) throw Object.assign(Error('isolated provider error with known usage'), { usage: { inputTokens: 14, outputTokens: 9 } });
          if (hooks.cleanup) {
            try { yield { type: 'text-delta', text: '尚未采纳的文本' }; }
            finally {
              stats.cleanupEntries = (stats.cleanupEntries || 0) + 1;
              if (hooks.cleanup === 'hang') await new Promise(() => {});
              if (hooks.cleanup === 'error') throw Object.assign(Error('cleanup usage'), { usage: { inputTokens: 14, outputTokens: 9 } });
              if (hooks.cleanup === 'absent') return;
              while (hooks.cleanup === 'no-progress') { stats.cleanupSteps = (stats.cleanupSteps || 0) + 1; yield { type: 'text-delta', text: 'discarded finalizer text' }; }
              yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 9 } };
            }
            stats.businessAfterCleanup = (stats.businessAfterCleanup || 0) + 1;
          }
          hooks.onUsage?.();
          yield { type: 'usage', usage: { inputTokens: 14, outputTokens: 9 } };
          yield { type: 'text-delta', text: '海洋小鱼观察完成。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
        const step = (kind, value) => {
          assert.equal(stats.inflight || 0, 0, 'cleanup cannot overlap a pending iterator operation');
          stats.inflight = 1; stats[`${kind}Calls`] = (stats[`${kind}Calls`] || 0) + 1;
          return stream[kind](value).finally(() => { stats.inflight = 0; });
        };
        return { [Symbol.asyncIterator]() { return this; }, next: value => step('next', value), return: value => step('return', value) };
      } });
    },
  };
  const attachments = { saveImages: async inputs => { stats.attachments++; assert.equal(inputs[0].data.toString(), 'abc'); await hooks.attachments?.(); return ['exact-attachment-ref']; } };
  const model = createCompanionModel({ ctx: { get: key => key === 'llm' ? llm : attachments }, tokenBudget: budget, getCharacter: () => role });
  const metadata = { requestId: name, jobId: name, category: 'other', purpose: 'organize', role: role.id, epoch: role.epoch, providerRouteId: routeId, model: COMPANION_ROUTE.model, estimatedTokens: 100 };
  const options = { system: 'trusted role', prompt: 'actual 海洋小鱼', requestMetadata: metadata,
    beforeSend: ({ phase } = {}) => adapter.validate(captured.handle, phase === 'completion' ? undefined : packet.preparedHandle),
    admitNetwork: (dispatch, options) => { stats.gates++; return adapter.withNetworkAdmission(captured.handle, () => { const value = dispatch(); assert.equal(stats.networks, 1, 'first next starts synchronously inside the real kernel fence'); return value; }, options); } };
  const f = { model, llm, options, metadata, budget, reservations, service, adapter, captured, packet, action, stats, hooks, sent,
    replaceRegistration: () => { registration = 'replacement'; }, changeRole: () => { role = { id: 'retired-new-role', epoch: 2 }; },
    revoke: () => action({ type: 'revoke_policy', policyId: 'private' }), usage: async () => (await budget.status()).usage.total.tokens };
  try { await run(f); assert.equal(stats.plain, 0); assert.equal(stats.externalUsage, 0); }
  finally { budget.dispose(); host.close(); await service.close(); }
}
await test('exact route hashes keep provider/model boundaries and reject unknown route values', async () => {
  assert.notEqual(good(deriveMemoryProviderRouteId({ provider: 'a/b', model: 'c' })).providerRouteId, good(deriveMemoryProviderRouteId({ provider: 'a', model: 'b/c' })).providerRouteId);
  for (const route of [{}, { provider: 'x', model: '' }, { provider: ' x', model: 'm' }]) assert.equal(deriveMemoryProviderRouteId(route).ok, false);
});
await test('prepare and exact attachments finish before paid reservation; one gate starts first next', () => fixture('fixed', async f => {
  f.hooks.prepare = async () => { assert.equal(f.reservations.length, 0); assert.equal(f.stats.attachments, 1); };
  const value = await f.model.call({ ...f.options, images: [image] });
  assert.equal(value.admissionReceipt.actualTokens, 23); assert.equal(value.admissionReceipt.actualCostCny, null);
  assert.equal(f.stats.networks, 1); assert.equal(f.stats.gates, 1); assert.equal(f.stats.options.messages[0].content[2].attachment, 'exact-attachment-ref');
  delete f.hooks.prepare;
  await denied(f.model.call({ ...f.options, images: [image] }), 'COMPANION_REQUEST_REUSED'); assert.equal(f.stats.networks, 1); assert.equal(await f.usage(), 23);
}));
for (const kind of ['revoke', 'role']) await test(`public prepare await ${kind} prevents paid reservation and network`, () => fixture(`prepare-${kind}`, async f => {
  f.hooks.prepare = async () => { if (kind === 'role') f.changeRole(); else await f.revoke(); };
  await denied(f.model.reply(f.options)); assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
await test('cancellation during public preparation aborts its linked signal before payment', () => fixture('prepare-cancel', async f => {
  const entered = deferred(), release = deferred(), controller = new AbortController(); let preparedSignal;
  f.hooks.prepare = async ({ signal }) => { preparedSignal = signal; entered.resolve(); await release.promise; };
  const pending = f.model.reply({ ...f.options, signal: controller.signal }); void pending.catch(() => {});
  await entered.promise; controller.abort(); await denied(pending, 'COMPANION_MODEL_CANCELLED'); release.resolve();
  assert.equal(preparedSignal.aborted, true); assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
await test('saveImages await revocation prevents preparation and paid admission', () => fixture('attachments-revoke', async f => {
  f.hooks.attachments = f.revoke; await denied(f.model.call({ ...f.options, images: [image] }));
  assert.equal(f.stats.prepared, 0); assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
await test('captured public prepared registration survives registry drift without plain-stream fallback', () => fixture('registration', async f => {
  f.hooks.prepare = async () => { f.replaceRegistration(); };
  await f.model.reply(f.options); assert.equal(f.stats.old, 1); assert.equal(f.stats.replacement, 0); assert.equal(f.stats.networks, 1);
}));
await test('prepared model mismatch, metadata mismatch and provider alias each deny before payment', () => fixture('mismatch', async f => {
  f.hooks.config = { model: 'different-model' }; await denied(f.model.reply(f.options), 'COMPANION_ROUTE_MISMATCH');
  f.hooks.config = {};
  for (const patch of [{ model: 'different-model' }, { providerRouteId: COMPANION_ROUTE.provider }, { providerRouteId: good(deriveMemoryProviderRouteId({ provider: 'another-provider', model: COMPANION_ROUTE.model })).providerRouteId }]) {
    await denied(f.model.reply({ ...f.options, requestMetadata: { ...f.metadata, ...patch } }), 'COMPANION_ROUTE_MISMATCH');
  }
  assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
await test('missing public preparation or trusted network hook never falls back or reserves', () => fixture('unsupported', async f => {
  await denied(f.model.reply({ ...f.options, admitNetwork: undefined }), 'MODEL_NETWORK_UNSUPPORTED');
  delete f.llm.prepareCall; await denied(f.model.reply(f.options), 'MODEL_PREPARE_UNSUPPORTED');
  assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
await test('prepare failure has no synthetic paid receipt', () => fixture('prepare-error', async f => {
  f.hooks.prepareError = Error('isolated metadata lookup failed');
  const failure = await denied(f.model.reply(f.options)); assert.equal(failure.receipt, undefined); assert.equal(f.reservations.length, 0); assert.equal(f.stats.networks, 0);
}));
for (const kind of ['revoke', 'role']) await test(`control commits while response waits; usage23 precedes ${kind} output rejection`, () => fixture(`pending-${kind}`, async f => {
  const release = deferred(); f.hooks.response = () => release.promise;
  const pending = f.model.reply(f.options); void pending.catch(() => {}); await f.sent.promise;
  await f.revoke(); if (kind === 'role') f.changeRole();
  release.resolve(); const failure = await denied(pending);
  assert.equal(failure.receipt.actualTokens, 23); assert.equal(await f.usage(), 23); assert.equal(f.stats.networks, 1);
}));
await test('provider error carrying usage settles before role and privacy checks', () => fixture('error-usage', async f => {
  f.hooks.errorUsage = true; f.hooks.response = async () => { await f.revoke(); f.changeRole(); };
  const failure = await denied(f.model.reply(f.options)); assert.equal(failure.receipt.actualTokens, 23); assert.equal(await f.usage(), 23);
}));
const withinCleanupDeadline = async pending => {
  let timer;
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cleanup did not finish within 1000ms')), 1000); })]); }
  finally { clearTimeout(timer); }
};
for (const mode of ['usage', 'error', 'absent', 'hang', 'no-progress']) await test(`same-iterator ${mode} cleanup settles before rejected output`, () => fixture(`cleanup-${mode}`, async f => {
  f.hooks.cleanup = mode; let completion = 0;
  const failure = await denied(withinCleanupDeadline(f.model.reply({ ...f.options, beforeSend: async options => {
    if (options?.phase === 'completion' && ++completion === 2) await f.revoke();
    return f.options.beforeSend(options);
  } })));
  const known = mode === 'usage' || mode === 'error';
  assert.equal(failure.receipt.state, known ? 'settled' : 'usage_unknown');
  if (known) { assert.equal(failure.receipt.actualTokens, 23); assert.equal(failure.receipt.actualCostCny, null); }
  else assert.equal(failure.receipt.estimatedTokens, 100);
  assert.equal(await f.usage(), known ? 23 : 100); assert.equal(f.stats.returnCalls, 1); assert.equal(f.stats.cleanupEntries, 1);
  assert.equal(f.stats.businessAfterCleanup || 0, 0); assert.equal(f.stats.networks, 1); assert.equal(f.stats.options.signal.aborted, true);
  if (mode === 'no-progress') assert.equal(f.stats.cleanupSteps, 4, 'cleanup cannot spin indefinitely');
}));
await test('an abort-ignoring first flight is not overlapped or reconciled by late usage', () => fixture('cleanup-first-flight', async f => {
  const release = deferred(), controller = new AbortController(); f.hooks.response = () => release.promise;
  const pending = f.model.reply({ ...f.options, signal: controller.signal }); void pending.catch(() => {});
  await f.sent.promise; controller.abort(); const failure = await denied(withinCleanupDeadline(pending));
  assert.equal(failure.receipt.state, 'usage_unknown'); assert.equal(await f.usage(), 100);
  assert.equal(f.stats.nextCalls, 1); assert.equal(f.stats.returnCalls || 0, 0, 'cannot queue return behind an unresolved provider next');
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(await f.usage(), 100); assert.equal(f.stats.networks, 1);
}));
await test('unknown response retains original hold and duplicate never resends', () => fixture('unknown', async f => {
  f.hooks.unknown = true; const failure = await denied(f.model.reply(f.options));
  assert.equal(failure.receipt.state, 'usage_unknown'); assert.equal(failure.receipt.estimatedTokens, 100); assert.equal(await f.usage(), 100);
  await denied(f.model.reply(f.options), 'COMPANION_REQUEST_REUSED'); assert.equal(f.stats.networks, 1);
}));
await test('network guard final revoke after paid admission never dispatches or refunds', () => fixture('final-gate', async f => {
  const original = f.options.admitNetwork;
  const failure = await denied(f.model.reply({ ...f.options, admitNetwork: async (...args) => { await f.revoke(); return original(...args); } }));
  assert.equal(f.stats.networks, 0); assert.equal(failure.receipt.state, 'usage_unknown'); assert.equal(failure.receipt.estimatedTokens, 100); assert.equal(await f.usage(), 100);
}));
await test('a source capture from another provider grant cannot be silently rewritten', () => fixture('source-route', async f => {
  const otherRoute = good(deriveMemoryProviderRouteId({ provider: 'other', model: COMPANION_ROUTE.model })).providerRouteId;
  await f.action({ type: 'configure_policy', policy: { policyId: 'other-route', approved: true, audiences: [['douyin', 'douyin:other-route', 'douyin:owner']], processingGrants: [{ grantId: 'other', providerRouteId: otherRoute }] } });
  const getCharacter = () => ({ id: f.metadata.role, epoch: 1 });
  const otherHost = createMemoryHost({ memoryService: f.service, getCharacter, resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: 'douyin:account', requesterAccountKey: 'douyin:owner', providerRouteId: otherRoute }) });
  const adapter = otherHost.createAdapter({ channel: 'douyin', principal: {}, canBindInput: true });
  let released = 0;
  const memory = createCompanionMemory({ getCharacter, memoryV2: { adapter: { ...adapter, release: handle => { released++; return adapter.release(handle); } }, getRouting: () => ({ ok: true, backend: 'v2' }) } });
  try { await denied(memory.capture({ characterId: f.metadata.role, characterEpoch: 1 }, 'douyin:other-route'), 'COMPANION_ROUTE_MISMATCH'); assert.equal(released, 1); assert.equal(f.stats.networks, 0); } finally { otherHost.close(); }
}));
console.log(`PASS model pinning: ${count} scenarios; real worker and real Host network fence, fake public LLM adapter (not installed DSH composition); terminal codes ${[...terminalCodes].sort().join(',')}; evidence ${root}`);
