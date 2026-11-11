import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createAgentBudgetMiddleware } from '../lib/memory-v2-agent-budget.mjs';

const root = fileURLToPath(new URL('../../../_backups/memory-v2-agent-budget/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, `run-${process.version}-${process.pid}-`));
const initialTime = new Date(2026, 10, 9, 12).getTime();
const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } };
const text = { type: 'text-delta', text: 'fixture output' };
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const errorCode = (error, code) => { assert.equal(error.code, code); assert.ok(error.error); assert.ok(error.hint); return true; };
const collect = async (source) => { const chunks = []; while (true) { const step = await source.next(); if (step.done) return { chunks, result: step.value }; chunks.push(step.value); } };
const event = (time, seq = 1, tokens = 30) => ({ type: 'assistant/message', seq, time, data: { turn: 1, step: seq, usage: { inputTokens: tokens, outputTokens: 0 } } });
let checks = 0;
async function fixture(name, check) {
  const home = fs.mkdtempSync(path.join(evidence, 'fixture-'));
  let time = initialTime, role = { id: 'whale', epoch: 4 }, budget;
  const open = (ctx = {}) => { budget = createTokenBudgetService({ ctx, dshHome: home, qqStateDir: path.join(home, 'qq'), now: () => time }); return budget; };
  open();
  const scopes = new WeakMap(), brands = new WeakSet(), managed = new Set();
  let gates = 0, calls = 0, permitted = true;
  const make = (extra = {}) => createAgentBudgetMiddleware({ tokenBudget: budget, getCharacter: () => role, isAgentLoopRequest: (value) => brands.has(value), getScope: (value) => scopes.get(value), isManagedSession: (id) => managed.has(id), ...extra });
  const bind = (id = 'first', extra = {}) => {
    const options = Object.freeze({ sessionId: extra.sessionId ?? 'bili-whale-native', provider: 'fixture-provider', model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }], ...(extra.options ?? {}) });
    const request = { requestId: id, jobId: `job-${id}`, category: 'bili', purpose: 'conversation', role: role.id, epoch: role.epoch,
      providerRouteId: 'fixture-route', model: options.model, estimatedTokens: 100, sessionId: options.sessionId,
      inputDigest: createHash('sha256').update(JSON.stringify(options.messages)).digest('hex'), ...(extra.request ?? {}) };
    const scope = { request, prepareInput: async () => true, validate: async () => permitted,
      admitNetwork: async (dispatch) => { gates++; try { return await dispatch(); } finally { gates--; } }, ...(extra.scope ?? {}) };
    brands.add(options); scopes.set(options, scope); managed.add(options.sessionId);
    return { options, scope };
  };
  const provider = () => { assert.ok(gates, 'next(options) must run under the critical callback'); calls++; return (async function* () { assert.ok(gates, 'first iterator.next() must run under the critical callback'); yield usage; yield text; })(); };
  try { await check({ home, open, get budget() { return budget; }, make, bind, provider, scopes, brands, managed,
    calls: () => calls, setRole: (value) => { role = value; }, setAllowed: (value) => { permitted = value; }, advanceDay: () => { time += 86400000; }, now: () => time }); checks++; console.log(`PASS ${name}`); }
  finally { budget.dispose(); }
}

await fixture('per-inference stable IDs, first-next critical gate, repeated ID never sends', async (f) => {
  const a = f.bind(); const middleware = f.make();
  const result = await collect(middleware.stream(a.options, f.provider));
  assert.deepEqual(result.chunks, [usage, text]); assert.equal(result.result.receipt.actualTokens, 30);
  assert.equal((await collect(middleware.stream(a.options, f.provider))).result.reused, true);
  const b = f.bind('step-two'); await collect(middleware.stream(b.options, f.provider));
  assert.equal(f.calls(), 2); assert.equal((await f.budget.status()).usage.total.tokens, 60);
  assert.equal(f.budget.isManagedAgentSession(a.options.sessionId), true);
  const canonical = JSON.parse(fs.readFileSync(f.budget.stateFile));
  assert.equal(canonical.modelCalls.requests.first.nativeAgentSession, true);
});
await fixture('concurrent same ID sends once and gives a known admitted receipt', async (f) => {
  const started = defer(), release = defer(), a = f.bind(); const middleware = f.make(); let calls = 0;
  const first = collect(middleware.stream(a.options, () => (async function* () { calls++; started.resolve(); await release.promise; yield usage; })()));
  await started.promise;
  const duplicate = await collect(middleware.stream(a.options, f.provider));
  assert.equal(duplicate.result.receipt.state, 'admitted'); assert.equal(duplicate.result.reused, true);
  release.resolve(); await first; assert.equal(calls, 1); assert.equal(f.calls(), 0);
});
await fixture('explicit unmanaged usage passes unchanged; brand alone is not authority', async (f) => {
  const options = Object.freeze({ sessionId: 'third-party', model: 'fixture-model' }); f.brands.add(options);
  const source = () => (async function* () { yield text; })();
  assert.deepEqual((await collect(f.make().stream(options, source))).chunks, [text]);
  f.managed.add(options.sessionId);
  await assert.rejects(collect(f.make().stream(options, source)), (error) => errorCode(error, 'MEMORY_SESSION_UNBOUND'));
  assert.equal((await f.budget.status()).usage.total.tokens, 0);
});
await fixture('unbranded lookalike, missing brand/membership and invalid scope fail closed', async (f) => {
  const a = f.bind(); const clone = { ...a.options };
  await assert.rejects(collect(f.make().stream(clone, f.provider)), (e) => errorCode(e, 'MEMORY_AGENT_REQUEST_UNTRUSTED'));
  for (const extra of [{ isAgentLoopRequest: undefined }, { isManagedSession: () => ({ ok: false, code: 'offline' }) }]) {
    await assert.rejects(collect(f.make(extra).stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_BUDGET_NOT_READY'));
  }
  f.scopes.delete(a.options);
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_SESSION_UNBOUND'));
  assert.equal(f.calls(), 0);
});
await fixture('scope callbacks default deny and unsupported critical callback never dispatches', async (f) => {
  for (const key of ['prepareInput', 'validate', 'admitNetwork']) {
    const a = f.bind(`unsupported-${key}`, { scope: { [key]: undefined } });
    await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_BUDGET_NOT_READY'));
    assert.equal(f.budget.getModelCallReceipt(a.scope.request.requestId).code, 'BUDGET_REQUEST_MISSING');
  }
  assert.equal(f.calls(), 0);
});
await fixture('reserved native metadata is not managed and ordinary reserve cannot claim it', async (f) => {
  await f.budget.ensureReady(); const a = f.bind();
  assert.equal(f.budget.reserveModelCall({ ...a.scope.request, nativeAgentSession: true }).code, 'BUDGET_NATIVE_AUTHORITY_REQUIRED');
  assert.equal(f.budget.reserveNativeAgentModelCall(a.scope.request).ok, true);
  assert.equal(f.budget.isManagedAgentSession(a.options.sessionId), false);
  const session = { id: a.options.sessionId, header: { id: a.options.sessionId, agentPreset: 'standard' } };
  assert.equal(f.budget.ingestEvent(session, event(f.now())), true);
  assert.equal((await f.budget.status()).usage.total.tokens, 130);
  assert.equal(f.budget.admitModelCall('first').code, 'BUDGET_NATIVE_SESSION_USED');
});
await fixture('used legacy sessions cannot be adopted to suppress prior observations', async (f) => {
  await f.budget.ensureReady(); const a = f.bind();
  f.budget.ingestEvent({ id: a.options.sessionId, header: { id: a.options.sessionId } }, event(f.now()));
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'BUDGET_NATIVE_SESSION_USED'));
  assert.equal(f.budget.isManagedAgentSession(a.options.sessionId), false); assert.equal(f.calls(), 0);
  assert.equal((await f.budget.status()).usage.total.tokens, 30);
});
await fixture('cancellation before reserve or during reserved authorization never invokes', async (f) => {
  const controller = new AbortController(); controller.abort(); const a = f.bind('early', { options: { signal: controller.signal } });
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MODEL_CANCELLED'));
  const c = new AbortController(); const b = f.bind('reserved', { scope: { signal: c.signal, validate: async () => { c.abort(); return true; } } });
  await assert.rejects(collect(f.make().stream(b.options, f.provider)), (e) => errorCode(e, 'MODEL_CANCELLED'));
  assert.equal(f.budget.getModelCallReceipt('reserved').receipt.state, 'cancelled'); assert.equal(f.calls(), 0);
});
await fixture('role changes during prepare are caught before admission', async (f) => {
  const a = f.bind('prepare', { scope: { prepareInput: async () => { f.setRole({ id: 'other', epoch: 5 }); return true; } } });
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MODEL_CHARACTER_STALE'));
  assert.equal(f.budget.getModelCallReceipt('prepare').receipt.state, 'cancelled'); assert.equal(f.calls(), 0);
});
for (const kind of ['abort', 'role', 'revoke']) await fixture(`usage captured before ${kind} checks and output is discarded`, async (f) => {
  const controller = new AbortController(); const a = f.bind(kind, { options: { signal: controller.signal } });
  const source = () => (async function* () {
    if (kind === 'abort') controller.abort();
    if (kind === 'role') f.setRole({ id: 'other', epoch: 5 });
    if (kind === 'revoke') f.setAllowed(false);
    yield usage; yield text;
  })();
  await assert.rejects(collect(f.make().stream(a.options, source)), (e) => errorCode(e, kind === 'abort' ? 'MODEL_CANCELLED' : kind === 'role' ? 'MODEL_CHARACTER_STALE' : 'MODEL_NOT_AUTHORIZED'));
  const receipt = f.budget.getModelCallReceipt(kind).receipt;
  assert.equal(receipt.state, 'settled'); assert.equal(receipt.actualTokens, 30);
});
await fixture('provider error retains private cause, known charge, and no provider text diagnostics', async (f) => {
  const a = f.bind(); const secret = new Error('private provider response fixture');
  await assert.rejects(collect(f.make().stream(a.options, () => (async function* () { yield usage; throw secret; })())), (e) => {
    errorCode(e, 'MODEL_INVOKE_FAILED'); assert.equal(e.cause, secret); assert.equal(JSON.stringify(e).includes(secret.message), false); return true;
  });
  assert.equal(f.budget.getModelCallReceipt('first').receipt.actualTokens, 30);
});
await fixture('unknown usage holds across midnight, restart and duplicate retry', async (f) => {
  const a = f.bind();
  await assert.rejects(collect(f.make().stream(a.options, () => (async function* () { yield text; })())), (e) => errorCode(e, 'MODEL_USAGE_UNKNOWN'));
  f.advanceDay(); assert.equal((await f.budget.status()).usage.total.tokens, 100);
  f.budget.dispose(); f.open();
  const duplicate = await collect(f.make().stream(a.options, f.provider));
  assert.equal(duplicate.result.receipt.state, 'usage_unknown'); assert.equal(duplicate.result.invoked, false); assert.equal(f.calls(), 0);
});
await fixture('consumer return settles before done and applies one-chunk backpressure', async (f) => {
  const a = f.bind(); let progressed = false;
  const stream = f.make().stream(a.options, () => (async function* () { yield usage; progressed = true; yield text; })());
  const first = await stream.next(); assert.deepEqual(first.value, usage); assert.equal(progressed, false);
  await stream.return(); assert.equal(progressed, false);
  assert.equal(f.budget.getModelCallReceipt('first').receipt.state, 'settled');
});
await fixture('real watcher and bootstrap/restart never count native usage twice', async (f) => {
  const a = f.bind(); await collect(f.make().stream(a.options, f.provider));
  f.budget.ingestEvent({ id: a.options.sessionId, header: { id: a.options.sessionId } }, event(f.now()));
  assert.equal((await f.budget.status()).usage.total.tokens, 30);
  f.budget.dispose();
  const item = (sessionId, tokens) => ({ sessionId, updatedAt: f.now(), projections: { values: { agentPreset: 'standard', tokenUsage: { inputTokens: tokens } } } });
  const ctx = { sessionController: { list: async () => ({ items: [item(a.options.sessionId, 30), item('bili-whale-old-legacy', 11)] }), inspect: async (id) => {
    assert.notEqual(id, a.options.sessionId, 'native sessions need no usage replay');
    return { events: [event(f.now(), 1, 11)], meta: { id, agentPreset: 'standard' } };
  } } };
  f.open(ctx); await f.budget.ensureReady();
  assert.equal(f.budget.isManagedAgentSession(a.options.sessionId), true);
  f.scopes.delete(a.options); f.managed.clear();
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_SESSION_UNBOUND'));
  f.budget.ingestEvent({ id: a.options.sessionId, header: { id: a.options.sessionId } }, event(f.now(), 2));
  f.budget.ingestEvent({ id: 'bili-whale-legacy', header: { id: 'bili-whale-legacy' } }, event(f.now(), 3, 17));
  assert.equal((await f.budget.status()).usage.total.tokens, 58);
});
await fixture('failed reserve flush never invokes and unknown membership stays closed', async (f) => {
  const a = f.bind(), original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Object.assign(new Error('fixture fsync'), { code: 'EIO' }); };
    await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'BUDGET_COMMIT_UNKNOWN'));
  } finally { fs.fsyncSync = original; }
  assert.equal(f.calls(), 0);
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_BUDGET_NOT_READY'));
});
await fixture('settlement failure is returned visibly after streamed usage', async (f) => {
  const a = f.bind(), original = fs.fsyncSync;
  try {
    await assert.rejects(collect(f.make().stream(a.options, () => (async function* () { yield usage; fs.fsyncSync = () => { throw Object.assign(new Error('settle fsync'), { code: 'EIO' }); }; })())), (e) => errorCode(e, 'BUDGET_COMMIT_UNKNOWN'));
  } finally { fs.fsyncSync = original; }
});
await fixture('one-shot network callback cannot dispatch after returning or retry automatically', async (f) => {
  let leaked; const a = f.bind('closed', { scope: { admitNetwork: async (dispatch) => { leaked = dispatch; return false; } } });
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MODEL_INVOKE_FAILED'));
  assert.throws(leaked, (e) => errorCode(e, 'MODEL_NETWORK_CLOSED')); assert.equal(f.calls(), 0);
  assert.equal(f.budget.getModelCallReceipt('closed').receipt.state, 'usage_unknown');
});
await fixture('actual overrun is recorded whole and pauses the next native inference', async (f) => {
  const a = f.bind(); await collect(f.make().stream(a.options, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 400 } }; })()));
  assert.equal(f.budget.getModelCallReceipt('first').receipt.actualTokens, 400);
  const b = f.bind('blocked'); await assert.rejects(collect(f.make().stream(b.options, f.provider)), (e) => errorCode(e, 'BUDGET_ACTUAL_EXCEEDED')); assert.equal(f.calls(), 0);
});
await fixture('cross-role native organize and expand share the six-call installation limit', async (f) => {
  for (let i = 0; i < 6; i++) { f.setRole({ id: `role-${i}`, epoch: i }); const a = f.bind(`extra-${i}`, { request: { purpose: i % 2 ? 'expand' : 'organize', category: i % 2 ? 'other' : 'bili' } }); await collect(f.make().stream(a.options, f.provider)); }
  const last = f.bind('extra-last', { request: { purpose: 'organize' } });
  await assert.rejects(collect(f.make().stream(last.options, f.provider)), (e) => errorCode(e, 'BUDGET_MEMORY_LIMIT'));
  assert.equal(f.calls(), 6);
});
await fixture('native input digest participates in idempotence and corrupted markers never authorize', async (f) => {
  const a = f.bind(); await collect(f.make().stream(a.options, f.provider));
  const conflict = f.bind('first', { request: { inputDigest: 'b'.repeat(64) } });
  await assert.rejects(collect(f.make().stream(conflict.options, f.provider)), (e) => errorCode(e, 'BUDGET_REQUEST_CONFLICT'));
  assert.equal(f.calls(), 1);
  const stateFile = f.budget.stateFile; f.budget.dispose();
  const state = JSON.parse(fs.readFileSync(stateFile)); state.modelCalls.requests.first.inputDigest = 'bad';
  fs.copyFileSync(stateFile, stateFile + '.before-corruption'); fs.writeFileSync(stateFile, JSON.stringify(state)); f.open();
  assert.equal(f.budget.isManagedAgentSession(a.options.sessionId).code, 'BUDGET_LEDGER_INVALID');
  await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => errorCode(e, 'MEMORY_BUDGET_NOT_READY'));
});
await fixture('consumer return reports a settlement flush failure before completing', async (f) => {
  const a = f.bind(); const stream = f.make().stream(a.options, f.provider), original = fs.fsyncSync;
  await stream.next();
  try {
    fs.fsyncSync = () => { throw Object.assign(new Error('return settle fixture'), { code: 'EIO' }); };
    await assert.rejects(stream.return(), (e) => errorCode(e, 'BUDGET_COMMIT_UNKNOWN'));
  } finally { fs.fsyncSync = original; }
});
await fixture('critical callback failure and double dispatch preserve known usage without replay', async (f) => {
  for (const mode of ['throw', 'double']) {
    const a = f.bind(mode, { scope: { admitNetwork: async (dispatch) => {
      const step = await dispatch();
      if (mode === 'throw') throw new Error('private critical callback fixture');
      try { dispatch(); } catch {}
      return step;
    } } });
    let calls = 0;
    await assert.rejects(collect(f.make().stream(a.options, () => { calls++; return (async function* () { yield usage; })(); })), (e) => errorCode(e, 'MODEL_INVOKE_FAILED'));
    assert.equal(calls, 1); assert.equal(f.budget.getModelCallReceipt(mode).receipt.actualTokens, 30);
  }
});
await fixture('usage in generator cleanup is charged and cleanup drains before consumer return', async (f) => {
  const a = f.bind(); let closed = false;
  const stream = f.make().stream(a.options, () => (async function* () { try { yield text; } finally { yield usage; closed = true; } })());
  await stream.next(); await stream.return();
  assert.equal(closed, true); assert.equal(f.budget.getModelCallReceipt('first').receipt.actualTokens, 30);
});
await fixture('revocation and settlement failure both remain actionable', async (f) => {
  const original = fs.fsyncSync;
  const a = f.bind('revoke-flush', { scope: { validate: async ({ phase }) => {
    if (phase !== 'chunk') return true;
    fs.fsyncSync = () => { throw Object.assign(new Error('fixture revoke settle'), { code: 'EIO' }); }; return false;
  } } });
  try {
    await assert.rejects(collect(f.make().stream(a.options, f.provider)), (e) => {
      errorCode(e, 'BUDGET_COMMIT_UNKNOWN'); assert.equal(e.operationFailure.code, 'MODEL_NOT_AUTHORIZED'); return true;
    });
  } finally { fs.fsyncSync = original; }
});
await fixture('provider and settlement failures retain both actionable status and private original cause', async (f) => {
  const a = f.bind(), original = fs.fsyncSync, privateError = new Error('private provider plus settle fixture');
  try {
    await assert.rejects(collect(f.make().stream(a.options, () => (async function* () {
      yield usage; fs.fsyncSync = () => { throw Object.assign(new Error('fixture flush'), { code: 'EIO' }); }; throw privateError;
    })())), (e) => {
      errorCode(e, 'BUDGET_COMMIT_UNKNOWN'); assert.equal(e.operationFailure.code, 'MODEL_INVOKE_FAILED');
      assert.equal(e.cause, privateError); assert.equal(JSON.stringify(e).includes(privateError.message), false); return true;
    });
  } finally { fs.fsyncSync = original; }
});
await fixture('invalid first usage still closes and drains provider cleanup without leaking diagnostics', async (f) => {
  const a = f.bind(); let closed = false;
  await assert.rejects(collect(f.make().stream(a.options, () => (async function* () {
    try { yield { type: 'usage', usage: { inputTokens: -1 } }; yield text; }
    finally { yield usage; closed = true; }
  })())), (e) => errorCode(e, 'MODEL_USAGE_INVALID'));
  assert.equal(closed, true); assert.equal(f.budget.getModelCallReceipt('first').receipt.state, 'usage_unknown');
});
console.log(`PASS native agent admission: ${checks} isolated scenarios (${process.version}); evidence ${evidence}`);
