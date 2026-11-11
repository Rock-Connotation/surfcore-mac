import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createModelCallAdmission } from '../lib/model-call-admission.mjs';

const root = fileURLToPath(new URL('../../../_backups/memory-v2-model-admission/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, `run-${process.version}-${process.pid}-`));
const time = new Date(2026, 10, 9, 12).getTime();
const request = (requestId, extra = {}) => ({ requestId, category: 'other', purpose: 'organize', jobId: 'fixture-job', role: 'whale', epoch: 4,
  providerRouteId: 'fixture-route', model: 'fixture-model', estimatedTokens: 100, ...extra });
const issue = (result, code) => { assert.equal(result.ok, false); assert.equal(result.code, code); assert.ok(result.error); assert.ok(result.hint); assert.equal(Object.hasOwn(result, 'value'), false); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
async function fixture(name, check) {
  const home = fs.mkdtempSync(path.join(evidence, 'fixture-'));
  const budget = createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq'), now: () => time });
  let role = { id: 'whale', epoch: 4 };
  const make = (extra = {}) => createModelCallAdmission({ tokenBudget: budget, getCharacter: () => role, authorize: async () => true, now: () => time, ...extra });
  try { await check({ budget, make, setRole: (next) => { role = next; }, home }); checks++; console.log(`PASS ${name}`); }
  finally { budget.dispose(); }
}

await fixture('one invocation for concurrent/repeated IDs and immutable request snapshot', async ({ make, budget }) => {
  const started = deferred(), release = deferred(), phases = [];
  const runner = make({ authorize: async ({ phase, request: snapshot }) => { phases.push(phase); assert.ok(Object.isFrozen(snapshot)); return { ok: true }; } });
  let calls = 0;
  const original = request('one');
  const invoke = async ({ requestId, onUsage }) => { calls++; assert.equal(requestId, 'one'); started.resolve(); await release.promise; onUsage({ inputTokens: 10, outputTokens: 10 }); onUsage({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }); return 'approved output'; };
  const first = runner.run({ request: original, invoke });
  await started.promise;
  original.estimatedTokens = 999;
  const duplicate = await runner.run({ request: request('one'), invoke });
  assert.equal(duplicate.reused, true); assert.equal(duplicate.invoked, false); assert.equal(duplicate.receipt.state, 'admitted');
  release.resolve();
  const result = await first;
  assert.equal(result.ok, true); assert.equal(result.value, 'approved output'); assert.equal(result.receipt.actualTokens, 30); assert.equal(result.receipt.estimatedTokens, 100);
  assert.equal((await runner.run({ request: request('one'), invoke })).receipt.state, 'settled');
  issue(await runner.run({ request: request('one', { model: 'conflict' }), invoke }), 'BUDGET_REQUEST_CONFLICT');
  assert.equal(calls, 1); assert.deepEqual(phases, ['reserve', 'dispatch', 'completion']); assert.equal((await budget.status()).usage.total.tokens, 30);
});

await fixture('stable ID is required and an existing reservation is never auto-resumed', async ({ make, budget }) => {
  const runner = make(); let calls = 0;
  const invoke = () => { calls++; };
  issue(await runner.run({ request: request(undefined), invoke }), 'BUDGET_REQUEST_INVALID');
  assert.equal(calls, 0);
  budget.reserveModelCall(request('pending'));
  const result = await runner.run({ request: request('pending'), invoke });
  assert.equal(result.ok, true); assert.equal(result.reused, true); assert.equal(result.invoked, false); assert.equal(result.receipt.state, 'reserved'); assert.equal(calls, 0);
});

await fixture('default authorization denies and cancels only the new reservation', async ({ make, budget }) => {
  let calls = 0;
  const result = await make({ authorize: undefined }).run({ request: request('deny'), invoke: () => { calls++; } });
  issue(result, 'MODEL_NOT_AUTHORIZED'); assert.equal(result.receipt.state, 'cancelled'); assert.equal(calls, 0);
  assert.equal((await budget.status()).usage.total.tokens, 0);
});

await fixture('authorization exceptions preserve private cause without provider text', async ({ make }) => {
  const secret = new Error('fixture-private-provider-token');
  const result = await make({ authorize: async () => { throw secret; } }).run({ request: request('auth-throw'), invoke: () => assert.fail('must not invoke') });
  issue(result, 'MODEL_AUTHORIZATION_FAILED'); assert.equal(result.cause, secret); assert.equal(result.receipt.state, 'cancelled');
  assert.equal(JSON.stringify(result).includes(secret.message), false);
});

await fixture('pre-aborted signal creates no reservation', async ({ make, budget }) => {
  const controller = new AbortController(); controller.abort();
  issue(await make().run({ request: request('cancel-before'), signal: controller.signal, invoke: () => assert.fail('must not invoke') }), 'MODEL_CANCELLED');
  issue(budget.getModelCallReceipt('cancel-before'), 'BUDGET_REQUEST_MISSING');
});

for (const phase of ['reserve', 'dispatch', 'completion']) await fixture(`cancellation during ${phase} authorization`, async ({ make, budget }) => {
  const controller = new AbortController(); let calls = 0;
  const result = await make({ authorize: async ({ phase: current }) => { if (current === phase) controller.abort(); return true; } }).run({
    request: request(`cancel-${phase}`), signal: controller.signal,
    invoke: async ({ onUsage }) => { calls++; onUsage({ outputTokens: 17 }); return 'discard me'; }
  });
  issue(result, 'MODEL_CANCELLED');
  assert.equal(result.receipt.state, phase === 'reserve' ? 'cancelled' : phase === 'dispatch' ? 'usage_unknown' : 'settled');
  assert.equal(calls, phase === 'completion' ? 1 : 0);
  assert.equal((await budget.status()).usage.total.tokens, phase === 'reserve' ? 0 : phase === 'dispatch' ? 100 : 17);
});

for (const phase of ['ready', 'reserve', 'dispatch', 'invoke', 'completion']) await fixture(`role change across awaited ${phase} never releases output`, async ({ make, budget, setRole }) => {
  let calls = 0;
  const change = () => setRole({ id: 'other', epoch: 5 });
  const originalReady = budget.ensureReady;
  if (phase === 'ready') budget.ensureReady = async () => { await originalReady(); change(); };
  const result = await make({ authorize: async ({ phase: current }) => { await Promise.resolve(); if (current === phase) change(); return true; } }).run({
    request: request(`role-${phase}`),
    invoke: async ({ onUsage }) => { calls++; await Promise.resolve(); onUsage({ inputTokens: 5, outputTokens: 7 }); if (phase === 'invoke') change(); return 'old role output'; }
  });
  issue(result, 'MODEL_CHARACTER_STALE');
  assert.equal(calls, ['invoke', 'completion'].includes(phase) ? 1 : 0);
  if (phase === 'ready') issue(budget.getModelCallReceipt(`role-${phase}`), 'BUDGET_REQUEST_MISSING');
  else assert.equal(result.receipt.state, phase === 'reserve' ? 'cancelled' : phase === 'dispatch' ? 'usage_unknown' : 'settled');
});

await fixture('usage before cancellation on an awaited stream chunk is fully charged', async ({ make, budget }) => {
  const controller = new AbortController();
  const result = await make().run({ request: request('chunk-cancel'), signal: controller.signal, invoke: async ({ onUsage }) => {
    await Promise.resolve(); controller.abort(); onUsage({ inputTokens: 9, outputTokens: 11 }); controller.signal.throwIfAborted();
  } });
  issue(result, 'MODEL_CANCELLED'); assert.equal(result.receipt.actualTokens, 20); assert.equal((await budget.status()).usage.total.tokens, 20);
});

await fixture('known usage on throw settles once; raw exception stays non-enumerable', async ({ make, budget }) => {
  const original = new Error('fixture-sensitive-provider-response');
  let savedOnUsage;
  const result = await make().run({ request: request('throw-known'), invoke: async ({ onUsage }) => { savedOnUsage = onUsage; onUsage({ cacheReadTokens: 3, inputTokens: 10, outputTokens: 12 }); throw original; } });
  issue(result, 'MODEL_INVOKE_FAILED'); assert.equal(result.cause, original); assert.equal(result.receipt.actualTokens, 25);
  assert.equal(JSON.stringify(result).includes(original.message), false); assert.equal((await budget.status()).usage.total.tokens, 25);
  assert.throws(() => savedOnUsage({ outputTokens: 1 }), (error) => error.code === 'MODEL_USAGE_CLOSED');
});

await fixture('missing response usage remains unknown and duplicate cannot retry or refund', async ({ make, budget }) => {
  const runner = make(); let calls = 0;
  const input = { request: request('unknown'), invoke: async () => { calls++; throw new Error('fixture network loss'); } };
  const result = await runner.run(input);
  issue(result, 'MODEL_INVOKE_FAILED'); assert.equal(result.receipt.state, 'usage_unknown'); assert.equal((await budget.status()).usage.total.tokens, 100);
  const duplicate = await runner.run(input); assert.equal(duplicate.invoked, false); assert.equal(duplicate.receipt.state, 'usage_unknown'); assert.equal(calls, 1);
  issue(budget.reconcileModelCall('unknown', { cancelled: true }), 'BUDGET_REFUND_FORBIDDEN');
  assert.equal(budget.reconcileModelCall('unknown', { usage: { outputTokens: 15 } }).receipt.actualTokens, 15);
});

await fixture('successful output without usage is visibly unknown and withheld', async ({ make }) => {
  const result = await make().run({ request: request('empty-usage'), invoke: async () => 'unaccounted output' });
  issue(result, 'MODEL_USAGE_UNKNOWN'); assert.equal(result.receipt.state, 'usage_unknown');
});

await fixture('completion authorization denial withholds output but charges known usage', async ({ make }) => {
  const result = await make({ authorize: async ({ phase }) => phase !== 'completion' }).run({ request: request('completion-deny'), invoke: async ({ onUsage }) => { onUsage({ outputTokens: 23 }); return 'private output'; } });
  issue(result, 'MODEL_NOT_AUTHORIZED'); assert.equal(result.receipt.state, 'settled'); assert.equal(result.receipt.actualTokens, 23);
});

await fixture('usage aliases normalize and reliable snapshot alone prices canonical buckets', async ({ make }) => {
  const priceSnapshot = { reliable: true, currency: 'CNY', version: 'fixture', rates: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0.1, cacheWriteTokens: 1 } };
  const result = await make().run({ request: request('priced', { priceSnapshot }), invoke: async ({ onUsage }) => {
    onUsage({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 4, totalTokens: 37 });
    return 'priced';
  } });
  assert.equal(result.ok, true); assert.equal(result.receipt.actualTokens, 37); assert.ok(Math.abs(result.receipt.actualCostCny - 0.0000525) < 1e-12);
});

for (const invalid of [{}, { totalTokens: 5 }, { outputTokens: -1 }, { outputTokens: 1.5 }]) await fixture(`invalid usage ${JSON.stringify(invalid)} never becomes zero charge`, async ({ make }) => {
  const result = await make().run({ request: request('invalid'), invoke: async ({ onUsage }) => { onUsage(invalid); return 'discard'; } });
  issue(result, 'MODEL_USAGE_INVALID'); assert.equal(result.receipt.state, 'usage_unknown');
});

for (const when of ['reserve', 'admit', 'settle']) await fixture(`fsync failure during ${when} is visible and never authorizes an extra invocation`, async ({ make, budget }) => {
  await budget.ensureReady();
  const originalSync = fs.fsyncSync; let failSync = when === 'reserve', calls = 0;
  const runner = make({ authorize: async ({ phase }) => { if (when === 'admit' && phase === 'reserve') failSync = true; return true; } });
  fs.fsyncSync = (fd) => { if (failSync) throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); return originalSync(fd); };
  let result;
  const providerError = new Error('fixture-private-failed-invoke');
  try { result = await runner.run({ request: request(`sync-${when}`), invoke: async ({ onUsage }) => { calls++; onUsage({ outputTokens: 20 }); failSync = true; throw providerError; } }); }
  finally { fs.fsyncSync = originalSync; }
  issue(result, 'BUDGET_COMMIT_UNKNOWN'); assert.equal(calls, when === 'settle' ? 1 : 0); assert.equal(result.budgetFailure.code, 'BUDGET_COMMIT_UNKNOWN');
  if (when === 'settle') { assert.equal(result.operationFailure.code, 'MODEL_INVOKE_FAILED'); assert.equal(result.cause, providerError); assert.equal(JSON.stringify(result).includes(providerError.message), false); }
});

await fixture('six installation-wide extra calls are shared across roles/categories/purposes', async ({ make, setRole, budget }) => {
  const runner = make(); let calls = 0;
  for (let i = 0; i < 7; i++) {
    const role = { id: i % 2 ? 'other' : 'whale', epoch: i + 4 }; setRole(role);
    const result = await runner.run({ request: request(`global-${i}`, { role: role.id, epoch: role.epoch, category: i % 2 ? 'bili' : 'other', purpose: i % 2 ? 'expand' : 'organize' }),
      invoke: async ({ onUsage }) => { calls++; onUsage({ outputTokens: 10 }); return 'ok'; } });
    if (i < 6) assert.equal(result.ok, true); else issue(result, 'BUDGET_MEMORY_LIMIT');
  }
  assert.equal(calls, 6); assert.equal((await budget.status()).usage.total.tokens, 60);
});

console.log(`PASS common model admission: ${checks} isolated scenarios (${process.version}); evidence ${evidence}`);
