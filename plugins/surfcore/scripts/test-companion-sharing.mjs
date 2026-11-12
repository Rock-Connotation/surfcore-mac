// V1 退役后（R10）：本机伙伴对话只走 V2。这里保留原有的业务断言
// （持久化对话、请求幂等、角色隔离、共享预算、取消不回滚），但运行在真实
// MemoryService/Host 上，而不是已删除的 v1 perform 分支。
// 必须第一行：在其它模块求值前隔离 DSH_HOME（见 isolate-test-home.mjs 的事故说明）。
import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createSharingController } from '../lib/companion-sharing-controller.mjs';
import { createDouyinCompanionStore } from '../lib/douyin-companion-ledger.mjs';
import { createCompanionSharing } from '../lib/companion-sharing.mjs';
import { createSharingV2Fixture } from './sharing-v2-fixture.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'companion-sharing-')));
let role = { id: 'alpha', epoch: 1, name: '小白鲸' }, modelCalls = 0;
const now = () => new Date('2026-11-07T06:00:00Z');
const jobId = 'douyin-11111111-1111-4111-8111-111111111111';
const item = { id: '123456', url: 'https://www.douyin.com/video/123456', title: '纸箱里的猫', durationMs: 17000,
  occurredAt: now().toISOString(), state: 'partial', memorySaved: true, partial: true,
  coverage: { status: 'partial', transcriptComplete: true, missingRanges: 0, visualCoverage: 'sparse', frameSamples: 3, warningCount: 0, acceptanceQualified: true },
  feeling: 'like', reason: '它把纸箱当成了小窝。', summary: '猫钻进纸箱。', draft: '' };
const ledgerStore = createDouyinCompanionStore(root, () => now().toISOString());
const v2 = await createSharingV2Fixture({ root, role: { id: 'alpha', epoch: 1 } });
ledgerStore.writeLedger({ version: 1, acceptanceCalls: 8, roles: { '"alpha"': { characterId: 'alpha', acceptedEpoch: 1, enabled: true, paused: false, lastError: null, days: {} } },
  jobs: { [jobId]: { jobId, mode: 'acceptance', state: 'partial', phase: 'finished', characterId: 'alpha', characterEpoch: 1,
    createdAt: now().toISOString(), updatedAt: now().toISOString(), completedAt: now().toISOString(), calls: 2, acceptanceQualified: true, scheduleDate: null, scheduleWindow: null,
    items: [{ ...item, ...v2.proof }], ...v2.proof } } });
const context = { characterId: 'alpha', characterEpoch: 1 };
const options = { stateDir: root, getCharacter: () => role, now,
  readiness: async () => ({ ok: true }), buildContext: async () => ({ ok: true, sections: [{ kind: 'persona', text: '温柔、有主见的小白鲸。' }], text: '只读到当前角色获准的记忆。' }),
  memoryV2: v2.memoryV2, getModelRequest: v2.getModelRequest,
  modelReply: async ({ system, prompt, beforeSend }) => { modelCalls++; await beforeSend?.(); assert.match(system, /不能|不得/); assert.match(prompt, /纸箱/); return { text: '原来你也喜欢这种小窝呀。', finishReason: 'stop' }; } };
let service = createCompanionSharing(options);
try {
  const recorded = await service.record(context, { jobId, id: item.id, share: '那只猫把纸箱当成家，认真得有点可爱。', question: '你也喜欢这种小动物吗？' });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  let state = await service.status(context);
  const openingRevision = state.revision;
  assert.equal(openingRevision, 1, 'revision counts committed current-epoch events');
  assert.equal(state.unread, 1); assert.equal(state.openings[0].question, '你也喜欢这种小动物吗？');
  const openingId = state.openings[0].id;
  assert.equal((await service.ack(context, { openingId })).ok, true);
  assert.equal((await service.status(context)).revision, openingRevision + 1);
  assert.equal((await service.status(context)).unread, 0);
  const request = { openingId, requestId: '22222222-2222-4222-8222-222222222222', text: '是的，我也喜欢纸箱里的猫。' };
  const result = await service.reply(context, request);
  assert.equal(result.ok, true); assert.equal(modelCalls, 1);
  assert.equal(result.value.revision, openingRevision + 3, 'request and answer advance the same durable revision');
  assert.equal(ledgerStore.readLedger().acceptanceCalls, 9);
  assert.equal((await service.reply(context, request)).ok, true); assert.equal(modelCalls, 1, 'same request must return the saved reply');
  assert.equal((await service.reply(context, { ...request, text: '不同的内容' })).code, 'DOUYIN_CHAT_REQUEST_CONFLICT');
  await service.dispose(); service = createCompanionSharing(options);
  state = await service.status(context);
  assert.equal(state.messages.length, 2, 'a fresh service reads the same conversation');
  assert.equal(state.messages[1].text, '原来你也喜欢这种小窝呀。');
  assert.equal((await service.reply(context, { ...request, requestId: '33333333-3333-4333-8333-333333333333' })).ok, true);
  const exhausted = await service.reply(context, { ...request, requestId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(exhausted.ok, false); assert.equal(exhausted.code, 'DOUYIN_ROUND_CALL_LIMIT'); assert.ok(exhausted.hint);
  assert.equal(modelCalls, 2); assert.equal(ledgerStore.readLedger().acceptanceCalls, 10);
  role = { id: 'beta', epoch: 2 };
  assert.equal((await service.status(context)).code, 'DOUYIN_STALE_CHARACTER');
  // V2-only：beta 没有任何已批准的 local 会话策略，capture 被 MEMORY_POLICY_DENIED 拒绝
  // （fail-closed），而不是静默显示别人的对话。这是一次真正的「权限拒绝」：生产语义里
  // 切到未批准角色后 Host 需要退役屏障确认才能继续（见 withTransition 的 retirementRequired）。
  const other = await service.status({ characterId: 'beta', characterEpoch: 2 });
  assert.equal(other.ok, false); assert.equal(other.code, 'MEMORY_POLICY_DENIED'); assert.ok(other.hint);
  // 生产装配切角色走 withTransition({retirementAcknowledged:true})；这里同样显式确认退役，
  // 清除 blocked 状态后回到 alpha 继续（与 switchCharacterEverywhere 的顺序一致）。
  const transitioned = await service.withTransition(() => ({ ok: true }), { retirementAcknowledged: true });
  assert.equal(transitioned.ok, true, JSON.stringify(transitioned));
  role = { id: 'alpha', epoch: 1 };
  let ledger = ledgerStore.readLedger(); ledger.jobs[jobId].calls = 0; ledger.acceptanceCalls = 12; ledgerStore.writeLedger(ledger);
  const cap = await service.reply(context, { ...request, requestId: crypto.randomUUID() });
  assert.equal(cap.code, 'DOUYIN_ACCEPTANCE_BUDGET_EXHAUSTED'); assert.ok(cap.hint); assert.equal(modelCalls, 2);
  const controller = createSharingController({ service, getCharacter: () => role });
  const server = http.createServer(async (req, res) => { if (!await controller.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = base + '/dsh-surfcore/api/douyin/companion-sharing';
  try {
    const viewed = await (await fetch(endpoint)).json(); assert.equal(viewed.character.id, 'alpha'); assert.equal(viewed.value.openings.length, 1);
    const cross = await fetch(endpoint, { headers: { origin: 'https://untrusted.example' } }); assert.equal(cross.status, 403);
    const late = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ action: 'ack', openingId, characterId: 'alpha', characterEpoch: 0 }) });
    assert.equal(late.status, 409); assert.equal((await late.json()).code, 'DOUYIN_STALE_CHARACTER');
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ action: 'reply', openingId, requestId: crypto.randomUUID(), text: '今天也想聊猫。', ...context }) });
    const error = await denied.json(); assert.equal(denied.status, 409); assert.equal(error.code, 'DOUYIN_ACCEPTANCE_BUDGET_EXHAUSTED'); assert.ok(error.error && error.hint);
    assert.equal(modelCalls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
  ledger = ledgerStore.readLedger();
  ledger.jobs[jobId].mode = 'daily'; ledger.jobs[jobId].calls = 0;
  ledger.jobs[jobId].scheduleDate = '2026-11-06'; ledger.jobs[jobId].scheduleWindow = '20:30';
  ledger.roles['"alpha"'].days = { '2026-11-07': { calls: 7, rounds: 0, windows: {} }, '2026-11-06': { calls: 0, rounds: 0, windows: {} } };
  ledgerStore.writeLedger(ledger);
  assert.equal((await service.reply(context, { ...request, requestId: crypto.randomUUID() })).ok, true);
  ledger = ledgerStore.readLedger(); assert.equal(ledger.roles['"alpha"'].days['2026-11-07'].calls, 8);
  assert.equal(ledger.roles['"alpha"'].days['2026-11-06'].calls, 0); assert.equal(ledger.acceptanceCalls, 12);
  const dailyCap = await service.reply(context, { ...request, requestId: crypto.randomUUID() });
  assert.equal(dailyCap.code, 'DOUYIN_DAILY_CALL_LIMIT'); assert.ok(dailyCap.hint); assert.equal(modelCalls, 3);
  await service.dispose();
  ledger.roles['"alpha"'].days['2026-11-07'].calls = 0; ledger.jobs[jobId].calls = 0; ledgerStore.writeLedger(ledger);
  let release, entered;
  const modelStarted = new Promise(resolve => { entered = resolve; });
  // 2026-11-12（R05 同类修复）：modelReply 必须尊重 signal——取消是生产契约。
  // 旧夹具的 modelReply 忽略 signal，靠「先 cancel 后 release」的时序碰巧通过；
  // 现在 cancel 的等待有界，夹具也改成监听 abort，模拟真实模型适配器行为。
  service = createCompanionSharing({ ...options, modelReply: ({ signal }) => new Promise((resolve, reject) => {
    entered();
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(Object.assign(new Error('这次回复已停止。'), { code: 'DOUYIN_CHAT_CANCELLED', hint: '查看已经保存的对话和用量；不会自动重发。' })); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    release = resolve;
  }) });
  // performV2 捕获到非白名单错误码会包装成 DOUYIN_CHAT_FAILED；真实模型适配器
  // 取消时走 cancelled() 的同款结构化错误（带 hint），与生产 cancel 路径一致。
  const beforeAnswers = (await service.status(context)).messages.filter(m => m.role === 'assistant').length;
  const cancelRequest = { ...request, requestId: crypto.randomUUID() };
  const pending = service.reply(context, cancelRequest); await modelStarted;
  const observer = createCompanionSharing(options), observed = await observer.status(context);
  assert.equal(observed.active.requestId, cancelRequest.requestId); assert.equal(observed.lastError, null);
  const foreignCancel = await observer.cancel(context, cancelRequest);
  assert.equal(foreignCancel.code, 'DOUYIN_CHAT_OTHER_INSTANCE'); assert.ok(foreignCancel.hint);
  await observer.dispose();
  assert.equal((await service.cancel(context, cancelRequest)).ok, true);
  const cancelled = await pending; assert.equal(cancelled.code, 'DOUYIN_CHAT_CANCELLED'); assert.ok(cancelled.hint);
  release({ text: '迟到的回复不得出现。', finishReason: 'stop' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await service.status(context)).messages.filter(m => m.role === 'assistant').length, beforeAnswers);
  assert.equal(ledgerStore.readLedger().roles['"alpha"'].days['2026-11-07'].calls, 1, 'cancel never refunds a reserved request');
  console.log('Companion sharing: persisted dialogue, dedupe, role and shared budget passed');
} finally {
  await Promise.race([service.dispose().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
  await Promise.race([v2.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
}
// 隔离 V2 测试会启动 MemoryService worker；某些 Node 版本下 worker 不随主流程退出。
// 断言已全部同步完成，限时后显式退出，保证完整插件链不被吊住。
setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref?.();
