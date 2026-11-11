import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { recoverBudgetOwnership } from '../lib/token-budget-admission.mjs';
import { localDayKey } from '../../../src/token-budget.js';

const baseTime = new Date(2026, 10, 9, 12).getTime();
const request = (requestId, extra = {}) => ({ requestId, category: 'other', purpose: 'organize', jobId: 'job', role: 'whale', epoch: 4,
  providerRouteId: 'fixture-route', model: 'fixture-model', estimatedTokens: 100, ...extra });
const priceSnapshot = { reliable: true, currency: 'CNY', version: 'fixture-v1', rates: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0.1, cacheWriteTokens: 1 } };
const issue = (value, code) => { assert.equal(value.ok, false); assert.equal(value.code, code); assert.ok(value.error); assert.ok(value.hint); };
const make = (home, extra = {}) => createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq'), now: () => baseTime, ...extra });

if (process.argv[2] === 'owner-child') {
  const service = make(process.argv[3]);
  await service.ensureReady();
  const reserve = service.reserveModelCall(request('crashed'));
  const admit = service.admitModelCall('crashed');
  process.send({ reserve, admit });
  process.on('message', () => { service.dispose(); process.exit(0); });
} else {
  let checks = 0;
  async function fixture(name, run) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-admission-'));
    const services = [];
    const open = async (extra = {}) => { const service = make(home, extra); services.push(service); await service.ensureReady(); return service; };
    try { await run({ home, open }); checks++; console.log(`PASS ${name}`); }
    finally { for (const service of services) service.dispose(); }
  }

  await fixture('idempotent reserve digest, single concurrent send, metadata snapshots, unknown reconciliation', async ({ open }) => {
    const service = await open();
    const original = request('stable', { priceSnapshot });
    assert.equal(service.reserveModelCall(original).receipt.state, 'reserved');
    const reordered = { ...priceSnapshot, rates: Object.fromEntries(Object.entries(priceSnapshot.rates).reverse()) };
    assert.equal(service.reserveModelCall({ ...original, priceSnapshot: reordered }).reused, true);
    issue(service.reserveModelCall({ ...original, model: 'other-model' }), 'BUDGET_REQUEST_CONFLICT');
    const results = await Promise.all([Promise.resolve().then(() => service.admitModelCall('stable')), Promise.resolve().then(() => service.admitModelCall('stable'))]);
    assert.equal(results.filter((r) => r.send).length, 1);
    assert.equal(service.settleModelCall('stable', { usageUnknown: true }).receipt.state, 'usage_unknown');
    issue(service.reconcileModelCall('stable', { cancelled: true }), 'BUDGET_REFUND_FORBIDDEN');
    assert.equal(service.admitModelCall('stable').send, false);
    issue(service.settleModelCall('stable', { actualTokens: 20, actualCostCny: 0.00002 }), 'BUDGET_RECONCILE_REQUIRED');
    const result = { usage: { uncachedInputTokens: 10, outputTokens: 10 } };
    const settled = service.reconcileModelCall('stable', result);
    assert.equal(settled.receipt.actualTokens, 20);
    assert.ok(Math.abs(settled.receipt.actualCostCny - 0.00003) < 1e-12);
    assert.equal(settled.receipt.estimatedTokens, 100);
    assert.deepEqual(settled.receipt.priceSnapshot, priceSnapshot);
    assert.equal(settled.receipt.role, 'whale');
    assert.equal(settled.receipt.epoch, 4);
    assert.equal(service.reconcileModelCall('stable', result).reused, true);
    issue(service.reconcileModelCall('stable', { actualTokens: 30, actualCostCny: 0.00003 }), 'BUDGET_RESULT_CONFLICT');
    assert.equal((await service.status()).usage.total.tokens, 20);
    assert.equal(service.recordExternalUsage({ budgetRequestId: 'stable', usage: { outputTokens: 20 } }), false);
    assert.equal((await service.status()).usage.total.tokens, 20);
  });

  await fixture('actual underestimate fully charged, overestimate released, next calls fail closed', async ({ open }) => {
    const service = await open();
    service.reserveModelCall(request('small'));
    service.admitModelCall('small');
    service.settleModelCall('small', { actualTokens: 20 });
    assert.equal((await service.status()).usage.total.tokens, 20);
    service.reserveModelCall(request('large', { purpose: 'conversation' }));
    service.admitModelCall('large');
    const result = service.settleModelCall('large', { actualTokens: 900 });
    assert.equal(result.receipt.actualTokens, 900);
    assert.equal(result.receipt.overrun, true);
    assert.equal((await service.status()).usage.total.tokens, 920);
    issue(service.reserveModelCall(request('next')), 'BUDGET_ACTUAL_EXCEEDED');
    assert.equal((await service.block('other')).blocked, true);
    assert.equal((await service.status()).blocked.other, true);
  });

  await fixture('cross-purpose and cross-role global limits include legacy usage and holds', async ({ open }) => {
    const service = await open();
    service.saveLimits({ qq: {}, bili: {}, other: {}, total: { tokens: 200 } });
    service.recordExternalUsage({ category: 'qq', usage: { outputTokens: 40 } });
    assert.equal(service.reserveModelCall(request('org', { estimatedTokens: 100 })).ok, true);
    issue(service.reserveModelCall(request('conv', { purpose: 'conversation', category: 'bili', role: 'different', epoch: 9, estimatedTokens: 61 })), 'BUDGET_LIMIT');
    assert.equal(service.reserveModelCall(request('conv', { purpose: 'conversation', category: 'bili', role: 'different', epoch: 9, estimatedTokens: 60 })).ok, true);
    assert.equal((await service.status()).usage.total.tokens, 200);
    assert.equal((await service.block('qq')).blocked, true);
    assert.equal(service.reconcileModelCall('org', { cancelled: true }).receipt.state, 'cancelled');
    assert.equal((await service.status()).usage.total.tokens, 100);
    assert.equal(service.admitModelCall('org').send, false);
    assert.equal(service.reconcileModelCall('org', { cancelled: true }).reused, true);
  });

  await fixture('six shared extra calls, token threshold and one extra in flight', async ({ open }) => {
    const service = await open();
    for (let i = 0; i < 6; i++) {
      assert.equal(service.reserveModelCall(request(`extra-${i}`, { purpose: i % 2 ? 'expand' : 'organize', role: `role-${i}` })).ok, true);
    }
    issue(service.reserveModelCall(request('seventh')), 'BUDGET_MEMORY_LIMIT');
    assert.equal(service.admitModelCall('extra-0').send, true);
    issue(service.admitModelCall('extra-1'), 'BUDGET_USAGE_UNKNOWN');
    service.settleModelCall('extra-0', { actualTokens: 20 });
    assert.equal(service.admitModelCall('extra-1').send, true);
    service.settleModelCall('extra-1', { usageUnknown: true });
    issue(service.admitModelCall('extra-2'), 'BUDGET_USAGE_UNKNOWN');
    service.reconcileModelCall('extra-1', { actualTokens: 20 });
    assert.equal(service.admitModelCall('extra-2').send, true);
  });

  await fixture('shared estimated token threshold and reliable-price-only money gating', async ({ open }) => {
    const service = await open();
    issue(service.reserveModelCall(request('too-many', { estimatedTokens: 30_001 })), 'BUDGET_MEMORY_LIMIT');
    const unreliable = request('unpriced', { priceSnapshot: { reliable: false, version: 'unknown' } });
    assert.equal(service.reserveModelCall(unreliable).ok, true);
    service.reconcileModelCall('unpriced', { cancelled: true });
    service.saveLimits({ qq: {}, bili: {}, other: { cny: 0.5 }, total: {} });
    issue(service.reserveModelCall(request('unknown-price')), 'BUDGET_PRICE_REQUIRED');
    assert.equal(service.reserveModelCall(request('priced', { priceSnapshot })).ok, true);
    issue(service.reserveModelCall(request('costly', { priceSnapshot, estimatedTokens: 300_000, purpose: 'conversation' })), 'BUDGET_LIMIT');
  });

  await fixture('restart after admission, midnight unknown retention, original-day settlement, clock rollback', async ({ open }) => {
    let clock = baseTime;
    let service = await open({ now: () => clock });
    service.reserveModelCall(request('yesterday'));
    service.admitModelCall('yesterday');
    service.dispose();
    clock += 24 * 3600_000;
    service = await open({ now: () => clock });
    assert.equal(service.getModelCallReceipt('yesterday').receipt.quotaDay, localDayKey(baseTime));
    assert.equal(service.admitModelCall('yesterday').send, false);
    assert.equal((await service.status()).usage.total.tokens, 100);
    service.settleModelCall('yesterday', { usageUnknown: true });
    issue(service.reserveModelCall(request('today')), 'BUDGET_USAGE_UNKNOWN');
    service.dispose();
    service = await open({ now: () => clock });
    assert.equal(service.getModelCallReceipt('yesterday').receipt.state, 'usage_unknown');
    assert.equal((await service.status()).admission.held.total.tokens, 100);
    service.reconcileModelCall('yesterday', { actualTokens: 50 });
    assert.equal((await service.status()).usage.total.tokens, 0);
    assert.equal(service.getModelCallReceipt('yesterday').receipt.actualTokens, 50);
    assert.equal(service.reserveModelCall(request('today')).ok, true);
    clock -= 24 * 3600_000;
    issue(service.reserveModelCall(request('rollback')), 'BUDGET_CLOCK_ROLLBACK');
  });

  await fixture('pre-rename and fsync failures never authorize sending or silently retry', async ({ open }) => {
    let service = await open();
    service.reserveModelCall(request('failed-admit'));
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === service.stateFile) throw new Error('fixture rename failure'); return rename(from, to); };
      issue(service.admitModelCall('failed-admit'), 'BUDGET_COMMIT_UNKNOWN');
    } finally { fs.renameSync = rename; }
    assert.equal(service.admitModelCall('failed-admit').ok, false);
    service.dispose();
    service = await open();
    assert.equal(service.getModelCallReceipt('failed-admit').receipt.state, 'reserved');
    const sync = fs.fsyncSync;
    try {
      fs.fsyncSync = () => { throw new Error('fixture fsync failure'); };
      issue(service.admitModelCall('failed-admit'), 'BUDGET_COMMIT_UNKNOWN');
    } finally { fs.fsyncSync = sync; }
    service.dispose();
    service = await open();
    assert.equal(service.getModelCallReceipt('failed-admit').receipt.state, 'reserved');
    assert.equal(service.admitModelCall('failed-admit').send, true);
  });

  await fixture('post-rename sync failure reopens admitted receipt without authorizing a duplicate', async ({ open }) => {
    let service = await open();
    service.reserveModelCall(request('post-rename'));
    const sync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture directory sync failure'); return sync(fd); };
      issue(service.admitModelCall('post-rename'), 'BUDGET_COMMIT_UNKNOWN');
    } finally { fs.fsyncSync = sync; }
    service.dispose();
    service = await open();
    assert.equal(service.getModelCallReceipt('post-rename').receipt.state, 'admitted');
    assert.equal(service.admitModelCall('post-rename').send, false);
    assert.equal((await service.status()).usage.total.tokens, 100);
  });

  await fixture('daily projection failure is visible, canonical charge survives and projection rebuilds', async ({ open }) => {
    const service = await open();
    service.reserveModelCall(request('projection'));
    service.admitModelCall('projection');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === service.dailyFile) throw new Error('fixture projection failure'); return rename(from, to); };
      assert.equal(service.settleModelCall('projection', { actualTokens: 40 }).ok, true);
      assert.equal((await service.status()).admission.projectionError.code, 'BUDGET_PROJECTION_FAILED');
      assert.equal(JSON.parse(fs.readFileSync(service.stateFile)).modelCalls.requests.projection.actualTokens, 40);
    } finally { fs.renameSync = rename; }
    assert.equal((await service.status()).admission.projectionError, null);
    assert.equal(JSON.parse(fs.readFileSync(service.dailyFile)).other.tokens, 40);
  });

  await fixture('event observation and restart bootstrap charge admitted usage exactly once', async ({ open }) => {
    const session = { id: 'qq-controlled', header: { id: 'qq-controlled', agentPreset: 'qq-chat-v2' } };
    const event = { seq: 1, time: baseTime, type: 'assistant/message', data: { budgetRequestId: 'observed', turn: 1, step: 1,
      usage: { inputTokens: 20, outputTokens: 20 } } };
    const ctx = { sessionController: { list: async () => ({ items: [{ sessionId: session.id, updatedAt: baseTime, projections: { values: { agentPreset: 'qq-chat-v2', tokenUsage: { uncachedInputTokens: 20, outputTokens: 20 } } } }] }),
      inspect: async () => ({ meta: session.header, events: [event] }) } };
    let service = await open();
    service.reserveModelCall(request('observed', { category: 'qq', purpose: 'conversation', priceSnapshot }));
    service.admitModelCall('observed');
    service.settleModelCall('observed', { actualTokens: 40, actualCostCny: 0.00006 });
    assert.equal(service.ingestEvent(session, event), false);
    assert.equal((await service.status()).usage.total.tokens, 40);
    service.dispose();
    service = await open({ ctx });
    assert.equal((await service.status()).usage.total.tokens, 40);
  });

  await fixture('invalid canonical JSON and corrupted ledger cannot reset the budget', async ({ home, open }) => {
    let service = await open();
    service.reserveModelCall(request('preserved'));
    service.dispose();
    const original = fs.readFileSync(service.stateFile, 'utf8');
    fs.writeFileSync(service.stateFile, '{broken');
    service = await open();
    issue(service.reserveModelCall(request('reset')), 'BUDGET_STATE_INVALID');
    service.dispose();
    assert.equal(fs.readFileSync(service.stateFile, 'utf8'), '{broken');
    const damaged = JSON.parse(original);
    damaged.modelCalls.requests.preserved.estimatedTokens = -1;
    fs.writeFileSync(service.stateFile, JSON.stringify(damaged));
    service = await open();
    issue(service.reserveModelCall(request('reset')), 'BUDGET_LEDGER_INVALID');
    issue(await service.status(), 'BUDGET_LEDGER_INVALID');
    service.dispose();
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'surfcore', 'token-usage-state.json'))).modelCalls.requests.preserved.estimatedTokens, -1);
  });

  await fixture('settled extra calls retain their estimated subbudget', async ({ open }) => {
    const service = await open();
    assert.equal(service.reserveModelCall(request('estimate', { estimatedTokens: 30_000 })).ok, true);
    service.admitModelCall('estimate');
    service.settleModelCall('estimate', { actualTokens: 1 });
    assert.equal((await service.status()).usage.total.tokens, 1);
    assert.equal((await service.status()).admission.memory.tokens, 30_000);
    issue(service.reserveModelCall(request('next-estimate', { estimatedTokens: 1 })), 'BUDGET_MEMORY_LIMIT');
  });

  await fixture('admit requires bootstrap; malformed price and incomplete provider usage fail visibly', async ({ home, open }) => {
    let service = await open();
    service.reserveModelCall(request('await-bootstrap'));
    service.dispose();
    service = make(home);
    issue(service.admitModelCall('await-bootstrap'), 'BUDGET_NOT_READY');
    await service.ensureReady();
    issue(service.reserveModelCall(request('bad-price', { priceSnapshot: { reliable: 'false' } })), 'BUDGET_REQUEST_INVALID');
    assert.equal(service.admitModelCall('await-bootstrap').send, true);
    issue(service.settleModelCall('await-bootstrap', { usage: {} }), 'BUDGET_RESULT_INVALID');
    issue(service.settleModelCall('await-bootstrap', { usage: { inputTokens: 100 } }), 'BUDGET_RESULT_INVALID');
    service.settleModelCall('await-bootstrap', { usageUnknown: true });
    assert.equal((await service.status()).admission.held.total.tokens, 100);
    service.dispose();
  });

  await fixture('failed observation bootstrap cannot authorize a model call', async ({ open }) => {
    const ctx = { sessionController: { list: async () => ({ items: [{ sessionId: 'qq-unreadable', updatedAt: baseTime,
      projections: { values: { agentPreset: 'qq-chat-v2', tokenUsage: { outputTokens: 100 } } } }] }),
    inspect: async () => { throw new Error('fixture inspect unavailable'); } } };
    const service = await open({ ctx });
    issue(service.reserveModelCall(request('unready')), 'BUDGET_NOT_READY');
    assert.equal(service._peek().bootstrapped, false);
  });

  await fixture('competing instance and process reject; crash owner recovers only after proven exit', async ({ home, open }) => {
    const child = fork(fileURLToPath(import.meta.url), ['owner-child', home], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await once(child, 'message');
    assert.equal(message.admit.send, true);
    let contender = await open();
    issue(contender.reserveModelCall(request('competing')), 'BUDGET_OWNER_UNAVAILABLE');
    assert.throws(() => contender.saveLimits({}), (error) => {
      issue(error, 'BUDGET_OWNER_UNAVAILABLE');
      assert.equal(error.message, error.error);
      return true;
    });
    contender.dispose();
    const dir = path.join(home, 'surfcore');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'token-budget-owner.lock')));
    issue(recoverBudgetOwnership({ dir, token: 'wrong-token' }), 'BUDGET_RECOVERY_IDENTITY');
    issue(recoverBudgetOwnership({ dir, token: lock.token }), 'BUDGET_OWNER_ALIVE');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.equal(recoverBudgetOwnership({ dir, token: lock.token }).ok, true);
    const service = await open();
    assert.equal(service.getModelCallReceipt('crashed').receipt.state, 'admitted');
    assert.equal(service.admitModelCall('crashed').send, false);
    assert.equal((await service.status()).usage.total.tokens, 100);
    const second = await open();
    issue(second.reserveModelCall(request('second-instance')), 'BUDGET_OWNER_UNAVAILABLE');
    assert.equal(second.recordExternalUsage({ usage: { outputTokens: 1 } }), false);
  });
  for (const failOrphanSync of [false, true]) await fixture(`simulated Windows recovery: directory EPERM, orphan sync failure=${failOrphanSync}`, async ({ home, open }) => {
    const child = fork(fileURLToPath(import.meta.url), ['owner-child', home], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await once(child, 'message');
    assert.equal(message.admit.send, true);
    const dir = path.join(home, 'surfcore');
    const ownerFile = path.join(dir, 'token-budget-owner.lock');
    const lock = JSON.parse(fs.readFileSync(ownerFile));
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    let orphanFd;
    let orphanSyncs = 0;
    let directoryAttempts = 0;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      fs.openSync = (file, flags, ...args) => {
        if (path.resolve(String(file)) === dir && flags === 'r') {
          directoryAttempts++;
          throw Object.assign(new Error('fixture Windows directory open denied'), { code: 'EPERM' });
        }
        const fd = originalOpen(file, flags, ...args);
        if (String(file).endsWith('.orphan')) orphanFd = fd;
        return fd;
      };
      fs.fsyncSync = (fd) => {
        if (fd === orphanFd) {
          orphanSyncs++;
          if (failOrphanSync) throw Object.assign(new Error('fixture orphan flush failed'), { code: 'EIO' });
        }
        return originalSync(fd);
      };
      const recovered = recoverBudgetOwnership({ dir, token: lock.token });
      if (failOrphanSync) issue(recovered, 'BUDGET_RECOVERY_FAILED');
      else assert.equal(recovered.ok, true);
      assert.equal(orphanSyncs, 1, 'the preserved orphan file must be flushed before successful recovery');
      assert.equal(directoryAttempts, 0, 'Windows follows existing file-only sync strategy');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      fs.openSync = originalOpen;
      fs.fsyncSync = originalSync;
    }
    assert.equal(fs.existsSync(ownerFile), false);
    assert.equal(JSON.parse(fs.readFileSync(`${ownerFile}.${lock.token}.orphan`)).token, lock.token);
    const service = await open();
    assert.equal(service.getModelCallReceipt('crashed').receipt.state, 'admitted');
    assert.equal(service.admitModelCall('crashed').send, false);
    assert.equal((await service.status()).usage.total.tokens, 100);
  });
  console.log(`PASS token budget admission: ${checks} isolated scenarios (${process.version})`);
}
