/**
 * R2/F04：scheduler 真实退役生命周期回归。
 *
 * 反例（修复前）：
 *   · closed 后二次 retire 立即 {ok:true,alreadyRetired}，跳过 drain/Host ACK；
 *   · Host 首次失败 → 第二次 retire 假成功（总调用数仍 1）；
 *   · 首次在途 timeout → 第二次立即成功（Host 调用数 0）；
 *   · 并发 retire 各自跑，不共享同一 Promise；
 *   · signal 未传真实 execFile；abort 后旧 CLI 仍能继续写状态；
 *   · 成功 ACK 后 invalidate/迟到回调仍可写。
 *
 * 全程本测试自建隔离根 + shareTestRoot()；不碰真实 ~/.dsh、不联网、不发消息、不起服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareTestRoot, testHome } from './isolate-test-home.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BILI_MJS = path.join(HERE, '..', 'tools', 'bili.mjs');
const OWNER = '22000', SELF = '9', TS = 1700000000;
fs.mkdirSync(path.join(testHome, 'surfcore', 'bili'), { recursive: true });
const cfgPath = path.join(testHome, 'surfcore', 'bili.config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  owner: { mid: OWNER, name: 'SYNTHETIC_OWNER' }, self: { mid: SELF },
  listen: { dm: true, dmScope: 'owner', comment: false, live: false },
  night: { windows: [] },
}));
fs.writeFileSync(path.join(testHome, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({
  sessdata: 'SYNTHETIC', bili_jct: 'SYNTHETIC', buvid3: 'SYNTHETIC',
}));

const env = {
  ...process.env, ...shareTestRoot(), DSH_HOME: testHome,
  SURFCORE_BILI_CONFIG: cfgPath, DSH_NODE: process.execPath,
};
for (const key of Object.keys(env)) if (key.startsWith('SURFCORE_EXPECTED_CHARACTER')) delete env[key];
Object.assign(process.env, env);

const { startScheduler } = await import('../lib/scheduler.js');
const created = [];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise((r) => setImmediate(r));
function gateBudget() {
  const gate = deferred();
  let calls = 0;
  return { gate, calls: () => calls, tokenBudget: { block: async () => { calls += 1; await gate.promise; return { blocked: false }; } } };
}
function fixture({ hostRetire, waitHost, tokenBudget } = {}) {
  let hostCalls = 0;
  const ctx = { get: () => null, sessionController: { cancel: async () => ({ ok: true }) } };
  const scheduler = startScheduler(ctx, {
    dshHome: testHome, biliMjs: BILI_MJS, cwd: testHome,
    sessionId: 'bili-whale', memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }) },
    biliV2Agent: {
      enqueue: async () => ({ ok: true }),
      retire: async (...args) => {
        hostCalls += 1;
        if (hostRetire) return hostRetire(hostCalls, ...args);
        if (waitHost) await waitHost.promise;
        return { ok: true, retired: true };
      },
    },
    onMemoryBlocked: () => {}, log: () => {},
    ...(tokenBudget ? { tokenBudget } : {}),
  });
  created.push(scheduler);
  return { scheduler, hostCalls: () => hostCalls };
}

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); console.log('FAIL ' + name + ': ' + String(error?.message ?? error)); }
};

try {
  await test('Host 首次失败后二次 retire 必须重试且不得假成功', async () => {
    const { scheduler, hostCalls } = fixture({ hostRetire: (n) => n === 1 ? { ok: false, code: 'BILI_V2_RETIRE_UNCONFIRMED', error: 'pending', hint: 'retry' } : ({ ok: true, retired: true }) });
    const first = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(first.ok, false, '首次 Host 失败必须返回失败');
    assert.equal(hostCalls(), 1);
    const second = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(second.ok, true, '第二次必须真正重试成功');
    assert.equal(hostCalls(), 2, 'Host 必须被重新确认（不能靠 closed 跳过）');
  });

  await test('并发 retire 共享同一结果；首次 timeout 时第二笔不得提前成功', async () => {
    const { tokenBudget, gate } = gateBudget();
    const { scheduler, hostCalls } = fixture({ tokenBudget });
    const running = scheduler.tick().catch(() => {});
    await flush();
    const a = scheduler.retire({ timeoutMs: 40 });
    const b = scheduler.retire({ timeoutMs: 40 });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, false, '在途未退出时首次必须 timeout 失败');
    assert.equal(rb.ok, false, '并发的第二次不得提前成功');
    assert.equal(hostCalls(), 0, 'timeout 前不应声称 Host 已 ACK');
    gate.resolve();
    await running;
    await flush();
  });

  await test('timeout 后同一实例可 retry：资源退出→Host ACK→幂等成功', async () => {
    const { tokenBudget, gate } = gateBudget();
    const { scheduler, hostCalls } = fixture({ tokenBudget });
    const running = scheduler.tick().catch(() => {});
    await flush();
    const timedOut = await scheduler.retire({ timeoutMs: 40 });
    assert.equal(timedOut.ok, false);
    gate.resolve();
    await running;
    await flush();
    const retried = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(retried.ok, true, '资源退出后同实例必须能重试成功');
    assert.equal(hostCalls(), 1, '第一次 timeout 不算 Host ACK，重试才真正调用');
    const again = await scheduler.retire({ timeoutMs: 200 });
    assert.equal(again.ok, true, '真正 ACK 后才可幂等成功');
    assert.equal(hostCalls(), 1, '幂等成功不得重复调用 Host');
  });

  await test('Host 永不返回：一个有界 deadline 覆盖全部阶段并清理计时器', async () => {
    const never = deferred();
    const { scheduler } = fixture({ waitHost: never });
    const start = Date.now();
    // 外层看门狗：修复前 retire 无 deadline 会无限等待，用有界 race 把「假成功/死等」变成可见失败。
    const watchdog = new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'WATCHDOG_HANG', error: 'retire 未在有界时间内返回', hint: 'deadline 必须覆盖 Host ACK 阶段' }), 1500));
    const result = await Promise.race([scheduler.retire({ timeoutMs: 60 }), watchdog]);
    assert.equal(result.ok, false, 'Host 不返回时不得假成功');
    assert.notEqual(result.code, 'WATCHDOG_HANG', 'retire 必须自己有界返回，不能靠测试看门狗');
    assert.equal(result.code, 'BILI_SCHEDULER_RETIRE_TIMEOUT');
    assert.ok(Date.now() - start < 2000, 'deadline 必须有界，不得无限等待 Host');
    // 释放挂起 Promise，避免测试进程被吊住。
    never.resolve();
  });

  await test('真实 CLI signal：retire 必须终止/确认子进程退出，abort 不等于已退出', async () => {
    // 真实 bili.mjs dm-await 子进程卡在假 GET（NODE_OPTIONS shim 返回永不 resolve 的 Promise）。
    const shim = path.join(testHome, 'hang-shim.mjs');
    fs.writeFileSync(shim, [
      "globalThis.fetch = () => new Promise(() => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n') + '\n');
    const shimEnv = { ...env, NODE_OPTIONS: '--import ' + shim };
    // 用独立 scheduler：把 shim 注入本进程 env 后，其 execFile 子进程会继承。
    const savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--import ' + shim;
    const { scheduler } = fixture();
    // 用一个不经过 budget gate 的真实 dmTick 启动子进程。
    const dmRunning = scheduler.dmTick().catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    const status = scheduler.status();
    assert.equal(status.inflight, 1, '真实 CLI 轮询必须在途');
    const retired = await scheduler.retire({ timeoutMs: 300 });
    assert.equal(retired.ok, true, 'signal 必须传到 execFile，子进程退出后完成退役');
    await dmRunning;
    process.env.NODE_OPTIONS = savedNodeOptions;
    void shimEnv;
  });

  await test('成功 ACK 后 invalidate / 迟到回调不得再写状态', async () => {
    const { scheduler } = fixture();
    assert.equal((await scheduler.retire({ timeoutMs: 200 })).ok, true);
    const stateFile = path.join(testHome, 'surfcore', 'bili', 'whale-night.json');
    const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
    // invalidate 与所有公开 tick 在退役后都必须拒绝写，不得复活旧副作用。
    try { scheduler.invalidate(); } catch {}
    for (const call of [scheduler.tick(), scheduler.listenTick(), scheduler.liveTick(), scheduler.dmTick()]) {
      await assert.rejects(() => call, (error) => error.code === 'BILI_SCHEDULER_CLOSED');
    }
    const after = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
    assert.equal(after, before, '成功退役后不得有迟到写入');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`F04 scheduler retire r2: ${results.length - failed.length}/${results.length} cases`);
  if (failed.length) process.exitCode = 1;
} finally {
  for (const scheduler of created) { try { scheduler.stop(); } catch {} }
  setTimeout(() => process.exit(process.exitCode ?? 0), 60).unref?.();
}
