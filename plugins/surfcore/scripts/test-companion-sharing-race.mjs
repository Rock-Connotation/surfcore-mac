import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, opening, context, request, jobId } from './sharing-fixture.mjs';
import { createSharingV2Fixture } from './sharing-v2-fixture.mjs';

if (process.argv[2] === '--child') {
  // V2-only：同一安装根上第二个 MemoryService worker 会被 writer lock 拒绝
  // （MEMORY_WRITER_LOCKED，生产语义：一台机器一个记忆写入者）。子进程因此不建
  // 自己的记忆服务，只落「另一实例已经完成同一 requestId」的持久终态：
  // request+answer 带主进程已提交的来源证明（v2.proof 从 ledger 里读，不再开库）。
  // 这正是跨进程幂等依赖的 durable reconciliation 输入。主进程随后在锁内重放
  // reply，必须返回已保存的回复且零次模型调用。
  const root = process.argv[3];
  const { createSharingStore } = await import('../lib/companion-sharing-store.mjs');
  const { createDouyinCompanionStore } = await import('../lib/douyin-companion-ledger.mjs');
  const stateDir = path.join(root, 'surfcore');
  const v2 = { stateDir };
  const store = createSharingStore(stateDir);
  const ledger = createDouyinCompanionStore(stateDir, () => new Date('2026-11-07T06:00:00Z').toISOString());
  const data = ledger.readLedger();
  const job = data.jobs[jobId];
  job.calls = 3; data.acceptanceCalls = 9;
  ledger.writeLedger(data);
  const at = new Date('2026-11-07T06:00:00Z').toISOString();
  // 来源证明直接取自已落盘的 opening 行（主进程提交的真实 refs/receipts），
  // 不需要、也不允许子进程再开自己的记忆库。
  const openingRow = store.read('alpha').find(row => row.kind === 'opening');
  assert.ok(openingRow && openingRow.memoryV2Refs && openingRow.memoryV2Receipts, '子进程必须能读到主实例的来源证明');
  const proof = { memoryV2Refs: openingRow.memoryV2Refs, memoryV2Receipts: openingRow.memoryV2Receipts };
  // 账本契约：request 的 owner 必须是 "pid:uuid" 且属于一个活进程（跨实例归属检查）。
  const owner = `${process.pid}:00000000-0000-4000-8000-000000000000`;
  store.append('alpha', { version: 1, kind: 'request', id: `request:${request.requestId}`, epoch: 1, at,
    requestId: request.requestId, openingId: request.openingId, text: request.text, owner, pid: process.pid,
    ...proof, sourceState: 'committed', modelState: 'not_started' });
  store.append('alpha', { version: 1, kind: 'answer', id: `answer:${request.requestId}`, epoch: 1, at,
    requestId: request.requestId, openingId: request.openingId, text: '另一实例已完成这条回复。',
    ...proof, sourceState: 'committed', modelState: 'completed' });
  console.log(JSON.stringify({ seeded: true, requestId: request.requestId }));
  process.exit(0);
}
const f = await fixture(); assert.equal((await opening(f)).ok, true);
const read = fs.readFileSync;
let raced = false, child;
fs.readFileSync = function (file, ...args) {
  const bytes = read.call(this, file, ...args);
  if (!raced && typeof file === 'number' && bytes.includes(Buffer.from('"kind":"opening"'))) {
    raced = true;
    // f.root 在 testHome 下，本身已隔离；把 DSH_HOME 固定成 f.root，
    // 子进程的 isolate-test-home 会复用它而不是新建目录。
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', f.root], { encoding: 'utf8', env: { ...process.env, DSH_HOME: f.root } });
    assert.equal(child.status, 0, `child exit ${child.status}: ${String(child.stderr||'').slice(0,600)}`);
  }
  return bytes;
};
try {
  const result = await f.service.reply(context, request);
  assert.ok(raced, 'race 钩子必须被触发（fd 读取带 opening 记录）');
  const childOut = String(child.stdout || '').trim();
  assert.ok(childOut, '子进程必须有自己的输出');
  const other = JSON.parse(childOut), ledger = f.ledger.readLedger();
  assert.equal(other.seeded, true);
  // 跨进程幂等（V2 语义）：主进程读到的是子进程落盘的持久终态，同一 requestId
  // 不再发起第二次模型调用，账本只记一次消费。
  assert.equal(f.calls.length, 0, 'stale pre-lock history must not dispatch another paid request');
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true, '同一请求必须返回子实例已保存的回复');
  assert.equal(ledger.acceptanceCalls, 9); assert.equal(ledger.jobs[jobId].calls, 3);
  assert.equal((await f.service.status(context)).messages.length, 2);
  console.log('Sharing cross-process request race: one paid call, one durable reply');
} finally { fs.readFileSync = read; await f.service.dispose(); await f.v2.close(); }
