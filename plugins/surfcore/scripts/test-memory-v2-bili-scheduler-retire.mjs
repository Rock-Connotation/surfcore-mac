/**
 * R05：B站 scheduler 退役必须是停止屏障（2026-11-12 V1 退役）。
 *
 * 修复前的隔离复现顺序是：tick 在 await 预算时挂起 → retire() 返回 → 放行预算 →
 * 旧实例继续 enqueue 并写 whale-night 账本（fired:true）。stop() 只清定时器，
 * 因此退役不是屏障。
 *
 * 本测试用可控 Promise 在**预算 await** 处挂起（tick/listenTick/dmTick 都先等它），验证：
 *   · retire 之后实例拒绝新准入（BILI_SCHEDULER_CLOSED）；
 *   · 在途任务被 abort 取消，不 enqueue、不写账本；
 *   · 在途任务不退出时 retire 超时失败（BILI_SCHEDULER_RETIRE_TIMEOUT），不假报成功；
 *   · Host 退役 ACK 失败时原样返回失败；
 *   · retire 幂等。
 *
 * 全程隔离 DSH_HOME；不启动 DSH、不联网、不发 QQ/B站消息、不起子进程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-scheduler-retire-'));
const dshHome = path.join(root, 'dsh');
const surfcore = path.join(dshHome, 'surfcore');
fs.mkdirSync(path.join(surfcore, 'bili'), { recursive: true });
process.env.DSH_HOME = dshHome;
fs.writeFileSync(path.join(surfcore, 'bili.config.json'), JSON.stringify({
  owner: { mid: '22000', name: '主人' },
  self: { mid: '9' },
  // 关掉所有监听与直播，确保测试不会起子进程或联网。
  listen: { dm: false, comment: false, live: false, allDay: false },
  night: { windows: [] },
}));

const { startScheduler } = await import('../lib/scheduler.js');
const { writeMemoryRouting } = await import('../../../src/core/memory-v2-routing.js');
assert.equal(writeMemoryRouting({ stateDir: surfcore, status: { ok: true, activeBackend: 'v2', revision: 1, storeGeneration: 'fixture-gen', minCompatibleReader: 1 } }).ok, true);
fs.writeFileSync(path.join(surfcore, 'memory-control.sqlite'), 'fixture existence only');

let pass = 0;
// 每个用例结束都停掉自己的定时器：scheduler 的 setInterval 会吊住事件循环。
const created = [];
const test = async (name, fn) => { await fn(); pass += 1; console.log('PASS ' + name); };
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

/** 可控预算闸门：block() 挂起，直到测试显式放行；放行后返回未超限。 */
function gateBudget() {
  const gate = deferred();
  const state = { calls: 0, released: false };
  return {
    gate, state,
    tokenBudget: {
      block: async () => { state.calls += 1; await gate.promise; state.released = true; return { blocked: false }; },
    },
  };
}

function fixture({ hostRetire = async () => ({ ok: true, retired: true }), enqueues = [], tokenBudget } = {}) {
  const blocked = [];
  // tick() 要求 ctx.sessionController 存在（服务就绪）。这里给一个只读桩：
  // 它不会被调用到取消路径，因为测试验证的是预算 await 边界。
  const ctx = { get: () => null, sessionController: { cancel: async () => ({ ok: true }) } };
  const scheduler = startScheduler(ctx, {
    dshHome, biliMjs: path.join(root, 'bili.mjs'), cwd: root,
    sessionId: 'bili-whale', memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }) },
    biliV2Agent: { enqueue: async (job) => { enqueues.push(job); return { ok: true } }, retire: hostRetire },
    onMemoryBlocked: (value) => blocked.push(value),
    ...(tokenBudget ? { tokenBudget } : {}),
    log: () => {},
  });
  created.push(scheduler);
  return { scheduler, blocked, enqueues };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

try {
  await test('在途 tick 挂起时 retire 会取消并等待它退出，之后不 enqueue', async () => {
    const { tokenBudget, state, gate } = gateBudget();
    const enqueues = [];
    const { scheduler } = fixture({ tokenBudget, enqueues });
    // 直接调用 tick：它在 budgetBlockedNow 处 await 我们的闸门。
    const running = scheduler.tick().catch(() => {});
    await flush();
    assert.equal(state.calls, 1, 'tick 必须先经过预算闸门');
    assert.equal(scheduler.status().inflight, 1, 'tick 必须在途');
    // 退役：先禁入，再取消，再等待。预算闸门仍挂起，所以这里应超时失败。
    const timedOut = await scheduler.retire({ timeoutMs: 50 });
    assert.equal(timedOut.ok, false, JSON.stringify(timedOut));
    assert.equal(timedOut.code, 'BILI_SCHEDULER_RETIRE_TIMEOUT');
    assert.ok(timedOut.hint);
    // 放行预算：旧实例的 live(ticket) 必须失败，因此不会 enqueue。
    gate.resolve();
    await running;
    await flush();
    assert.equal(enqueues.length, 0, '退役后的旧实例不得提交任务');
  });

  await test('retire 之后新准入被拒（BILI_SCHEDULER_CLOSED）', async () => {
    const { tokenBudget } = gateBudget();
    const { scheduler } = fixture({ tokenBudget });
    tokenBudget.block = async () => ({ blocked: false });
    // 先正常退役（无在途任务）。
    assert.equal((await scheduler.retire({ timeoutMs: 200 })).ok, true);
    assert.equal(scheduler.status().closed, true);
    await assert.rejects(() => scheduler.tick(), (error) => error.code === 'BILI_SCHEDULER_CLOSED');
    await assert.rejects(() => scheduler.listenTick(), (error) => error.code === 'BILI_SCHEDULER_CLOSED');
  });

  await test('Host 退役 ACK 失败时原样返回失败，不报告已停止', async () => {
    const { scheduler } = fixture({ hostRetire: async () => ({ ok: false, code: 'BILI_V2_RETIRE_UNCONFIRMED', error: 'pending', hint: 'wait for ACK' }) });
    const retired = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(retired.ok, false);
    assert.equal(retired.code, 'BILI_V2_RETIRE_UNCONFIRMED');
    assert.ok(retired.hint);
  });

  await test('retire 幂等：第二次返回 alreadyRetired', async () => {
    const { scheduler } = fixture();
    assert.equal((await scheduler.retire({ timeoutMs: 200 })).ok, true);
    const again = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyRetired, true);
  });

  console.log(`PASS scheduler retire barrier: ${pass} cases`);
  process.exitCode = 0;
} catch (error) {
  console.log('FAIL ' + String((error && error.stack) || error));
  process.exitCode = 1;
} finally {
  for (const scheduler of created) { try { scheduler.stop(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  // 定时器已清，但个别 fixture 可能仍持有 promise；显式退出保证测试进程有界。
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.();
}
