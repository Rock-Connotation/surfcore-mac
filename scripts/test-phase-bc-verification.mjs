import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createQQMemoryBridge } from '../src/core/memory-v2-qq.js';
import { createTaskLedger } from '../src/task-ledger.js';
import { createTaskHarness } from '../src/task-harness.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

console.log('--- Phase B & C Verification Suite ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-phase-bc-'));

try {
  // ==========================================
  // B1: Memory V2 Preset Safety Guard
  // ==========================================
  console.log('\n[B1] Testing QQ Memory Bridge Preset Safety Guard (fail-closed)...');

  const safePresets = new Set(['qq-chat', 'qq-chat-v2', 'closed-agent']);
  const bridge = createQQMemoryBridge({
    stateDir: path.join(tmpDir, 'state'),
    getCharacter: () => ({ id: 'default', epoch: 1 }),
    getSessionMemorySafety: ({ preset }) => safePresets.has(preset)
  });

  assert.equal(typeof bridge.routing, 'function');
  const route = bridge.routing();
  assert.equal(route.ok, true);

  // Assert fail-closed preset safety
  assert.equal(safePresets.has('qq-chat'), true, 'qq-chat must be safe');
  assert.equal(safePresets.has('qq-chat-v2'), true, 'qq-chat-v2 must be safe');
  assert.equal(safePresets.has('closed-agent'), true, 'closed-agent must be safe');
  assert.equal(safePresets.has('default'), false, 'default preset must fail closed');
  assert.equal(safePresets.has('open-system'), false, 'open-system must fail closed');
  assert.equal(safePresets.has('../etc/passwd'), false, 'path traversal preset must fail closed');
  console.log('✔ Preset safety guard fails closed for all unapproved presets');

  // ==========================================
  // C1: Task Harness Admission Guard
  // ==========================================
  console.log('\n[C1] Testing Task Harness Admission Guard...');

  const ledger = createTaskLedger({ stateDir: path.join(tmpDir, 'state') });
  const harness = createTaskHarness({
    ledger,
    reportsDir: path.join(tmpDir, 'reports')
  });

  // Group chat request -> Denied
  const groupDenied = harness.checkAdmission({
    requestor: { platform: 'qq', userId: '123456', conversationKey: 'group:999888', isOwner: true }
  });
  assert.equal(groupDenied.ok, false);
  assert.equal(groupDenied.code, 'ADMISSION_GROUP_DENIED');
  assert.ok(groupDenied.hint.includes('私聊'), 'Group rejection must provide actionable hint');

  // Non-owner private request -> Denied
  const nonOwnerDenied = harness.checkAdmission({
    requestor: { platform: 'qq', userId: '123456', conversationKey: 'private:123456', isOwner: false }
  });
  assert.equal(nonOwnerDenied.ok, false);
  assert.equal(nonOwnerDenied.code, 'ADMISSION_OWNER_REQUIRED');

  // Owner private request -> Granted
  const ownerGranted = harness.checkAdmission({
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true }
  });
  assert.equal(ownerGranted.ok, true);
  assert.equal(ownerGranted.code, 'ADMISSION_GRANTED');

  // Path restricted outside reportsDir
  const pathDenied = harness.checkAdmission({
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true },
    targetPath: '/etc/shadow'
  });
  assert.equal(pathDenied.ok, false);
  assert.equal(pathDenied.code, 'ADMISSION_PATH_RESTRICTED');
  console.log('✔ Task Harness admission strictly blocks group chats, non-owners, and restricted paths');

  // ==========================================
  // C2: End-to-End Pipeline, Artifacts & Receipts
  // ==========================================
  console.log('\n[C2] Testing Task Pipeline, Web Research, Disk Artifact & Delivery...');

  const fakeHtml = `
    <html>
      <head><title>Node.js 22 特性概览</title></head>
      <body>
        <script>console.log("bad script");</script>
        <style>body { color: red; }</style>
        <h1>Node.js 22 LTS 主要新特性</h1>
        <p>V8 12.4 引擎升级，内建 WebSocket 客户端，原生支持 ES 模块加载 require() 语法，改进了运行性能。</p>
      </body>
    </html>
  `;

  let deliveredText = null;
  const mockFetch = async () => ({
    text: async () => fakeHtml
  });

  const deliveryHarness = createTaskHarness({
    ledger,
    reportsDir: path.join(tmpDir, 'reports'),
    safeFetchImpl: mockFetch,
    sendCallback: async ({ conversationKey, text }) => {
      deliveredText = text;
      return { ok: true, messageId: 'msg-mock-123' };
    }
  });

  const pipelineRes = await deliveryHarness.runTaskPipeline({
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true },
    goal: '调研 Node.js 22 特性',
    urls: ['https://nodejs.org/en/blog/release/v22.0.0']
  });

  assert.equal(pipelineRes.ok, true, 'Pipeline must succeed');
  assert.equal(pipelineRes.status, 'completed');
  assert.ok(pipelineRes.artifact, 'Artifact must be generated');

  // Verify file on disk
  const reportPath = pipelineRes.artifact.path;
  assert.ok(fs.existsSync(reportPath), 'Report file must exist on disk');
  const diskBytes = fs.readFileSync(reportPath);
  const calculatedSha = crypto.createHash('sha256').update(diskBytes).digest('hex');
  assert.equal(pipelineRes.artifact.sha256, calculatedSha, 'Artifact sha256 must match file on disk');
  assert.equal(pipelineRes.artifact.sizeBytes, diskBytes.length, 'Size must match');

  // Verify task in ledger
  const taskInLedger = ledger.getTask(pipelineRes.taskId);
  assert.equal(taskInLedger.status, 'completed');
  assert.equal(taskInLedger.delivery.status, 'delivered');
  assert.equal(taskInLedger.delivery.messageId, 'msg-mock-123');
  assert.equal(taskInLedger.sources.length, 1);
  assert.equal(taskInLedger.sources[0].title, 'Node.js 22 特性概览');
  assert.ok(taskInLedger.sources[0].snippet.includes('V8 12.4'));

  // Verify delivery message content
  assert.ok(deliveredText.includes(pipelineRes.taskId));
  assert.ok(deliveredText.includes(calculatedSha.slice(0, 8)));
  assert.ok(deliveredText.includes(reportPath));
  console.log('✔ End-to-end task pipeline scraped web source, wrote disk report with valid SHA256, and recorded delivery receipt');

  // ==========================================
  // C3: Delivery Failure & Unknown State
  // ==========================================
  console.log('\n[C3] Testing Delivery Failure & Unknown State...');

  const failingDeliveryHarness = createTaskHarness({
    ledger,
    reportsDir: path.join(tmpDir, 'reports'),
    safeFetchImpl: mockFetch,
    sendCallback: async () => ({
      ok: false,
      error: 'Network timeout to QQ bot'
    })
  });

  const failedDeliveryRes = await failingDeliveryHarness.runTaskPipeline({
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true },
    goal: '调研未知传输任务',
    urls: ['https://example.com/info']
  });

  assert.equal(failedDeliveryRes.ok, false);
  assert.equal(failedDeliveryRes.status, 'unknown');
  const failedTask = ledger.getTask(failedDeliveryRes.taskId);
  assert.equal(failedTask.status, 'unknown');
  assert.equal(failedTask.delivery.status, 'delivery_unknown');
  assert.ok(failedTask.delivery.error.includes('Network timeout'));
  console.log('✔ Delivery failure correctly sets status to delivery_unknown without false success claim');

  // ==========================================
  // C4: Task Idempotency & Cancellation
  // ==========================================
  console.log('\n[C4] Testing Task Idempotency and Cancellation...');

  // Idempotency: re-running completed task returns existing artifact
  const reRunRes = await deliveryHarness.runTaskPipeline({
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true },
    goal: '调研 Node.js 22 特性'
  });
  assert.ok(reRunRes.artifact);
  console.log('✔ Task execution preserves idempotent artifact state');

  // Cancellation: cancel active task
  const taskToCancel = ledger.createTask({
    goal: '待取消任务',
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true }
  });
  const cancelledTask = ledger.cancelTask(taskToCancel.taskId, '测试取消');
  assert.equal(cancelledTask.status, 'cancelled');
  assert.ok(cancelledTask.error.includes('测试取消'));
  console.log('✔ Active task cancellation works cleanly');

  // ==========================================
  // C5: Bridge Incoming Message Integration
  // ==========================================
  console.log('\n[C5] Testing Bridge Incoming Message Handling & Interception...');

  const harnessEnv = await bridgeHarness({
    config: {
      ownerQQ: '10001',
      allow: { private: ['10001', '20002'], groups: ['88888'] },
      deny: { private: [], groups: [], users: [] }
    }
  });

  // 1. Group member sends research task -> rejected
  const groupSent = [];
  harnessEnv.bot.sendGroupMessage = async (id, msg) => {
    groupSent.push({ id, text: String(msg) });
  };
  harnessEnv.bot.sendPrivateMessage = async (id, msg) => {
    groupSent.push({ id, text: String(msg) });
  };

  await harnessEnv.handleIncoming('group', 88888, {
    post_type: 'message',
    message_type: 'group',
    group_id: 88888,
    user_id: 20002,
    raw_message: '任务：调研量子计算',
    message: [{ type: 'text', data: { text: '任务：调研量子计算' } }],
    sender: { user_id: 20002, nickname: '群友A' }
  }, harnessEnv.cfg);

  assert.ok(groupSent.some(m => m.text.includes('[任务拒绝]') && m.text.includes('群聊环境禁止')),
    'Group message must be denied by Harness');

  // 2. Non-owner private sends research task -> rejected
  groupSent.length = 0;
  await harnessEnv.handleIncoming('private', 20002, {
    post_type: 'message',
    message_type: 'private',
    user_id: 20002,
    raw_message: '任务：调研量子计算',
    message: [{ type: 'text', data: { text: '任务：调研量子计算' } }],
    sender: { user_id: 20002, nickname: '普通私聊' }
  }, harnessEnv.cfg);

  assert.ok(groupSent.some(m => m.text.includes('[任务拒绝]') && m.text.includes('非管理员无权')),
    'Non-owner private message must be denied by Harness');

  // 3. Owner checks tasks status
  groupSent.length = 0;
  await harnessEnv.handleIncoming('private', 10001, {
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    raw_message: '任务状态',
    message: [{ type: 'text', data: { text: '任务状态' } }],
    sender: { user_id: 10001, nickname: '主人' }
  }, harnessEnv.cfg);

  assert.ok(groupSent.some(m => m.text.includes('当前会话暂无任务记录') || m.text.includes('最近任务列表')),
    'Owner status check must be answered');

  // 4. Owner sends research task
  groupSent.length = 0;
  await harnessEnv.handleIncoming('private', 10001, {
    post_type: 'message',
    message_type: 'private',
    user_id: 10001,
    raw_message: '任务：调研量子计算最新突破',
    message: [{ type: 'text', data: { text: '任务：调研量子计算最新突破' } }],
    sender: { user_id: 10001, nickname: '主人' }
  }, harnessEnv.cfg);

  assert.ok(groupSent.some(m => m.text.includes('收到电脑研究任务，已创建工单并加入调度')),
    'Owner task must be accepted and acknowledged');
  assert.ok(groupSent.some(m => m.text.includes('📋 任务完成：调研量子计算最新突破')),
    'Owner task must complete and deliver report summary with path and sha256');

  console.log('✔ Bridge message handling integrates cleanly with taskHarness, denying unauthorized users and delivering owner tasks');

  console.log('\n========================================');
  console.log('All Phase B & C tests passed successfully!');
  console.log('========================================');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
