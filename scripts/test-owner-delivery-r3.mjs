import { newCaseRoot, createRealV2Factory, inbound, assert, fs, path, testHome, OWNER, KEY, GROUP_KEY, LOGIN } from './r2-v2-fixture.mjs';
const { root, stateDir } = newCaseRoot('owner-delivery');
import { bridgeHarness } from './audit-bridge-harness.mjs';
process.env.DSH_HOME = root;
process.env.R2_CASE_ROOT = root;
process.env.R2_CASE_STATE_DIR = stateDir;
let reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
const f = await createRealV2Factory({ platformReply: () => typeof reply === 'function' ? reply() : reply });
const h = f.harness;
let failures = 0;
async function test(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures++; console.error('FAIL', name, e.message); } }
const requestor = { platform: 'qq', userId: OWNER, conversationKey: KEY, isOwner: true };
try {
  await test('status reaches platform', async () => {
    const text = '任务状态'; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sent = f.platformSends.slice(before);
    console.log('platform sends=' + JSON.stringify(sent));
    console.log('memoryV2Failures.code=' + JSON.stringify(h.memoryV2Failures.get(KEY)?.code ?? null));
    assert.ok(sent.length >= 1, 'owner task status must reach the platform');
  });
  await test('cancel reaches platform', async () => {
    const task = h.taskLedger.createTask({ goal: 'cancel fixture', requestor });
    const text = `取消任务 ${task.taskId}`; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    console.log('cancel=' + JSON.stringify({ status: h.taskLedger.getTask(task.taskId).status, sends: f.platformSends.length - before, failure: h.memoryV2Failures.get(KEY)?.code ?? null }));
    assert.ok(f.platformSends.length > before, 'cancel receipt must reach platform');
  });
  await test('start and failure reach platform', async () => {
    fs.writeFileSync(path.join(h.temp, 'state', 'reports'), 'block report directory');
    const text = '任务：failure fixture http://127.0.0.1:1/failure'; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sends = f.platformSends.slice(before);
    console.log('start/failure=' + JSON.stringify({ sends, failure: h.memoryV2Failures.get(KEY)?.code ?? null }));
    assert.ok(sends.some(s => JSON.stringify(s.text).includes('收到电脑研究任务')), 'start receipt must reach platform');
    assert.ok(sends.some(s => JSON.stringify(s.text).includes('任务失败')), 'failure receipt must reach platform');
  });
  await test('unknown remains queryable and undelivered', async () => {
    const task = h.taskLedger.createTask({ goal: 'unknown receipt', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    reply = { status: 'ok', retcode: 0, data: {} };
    const before = f.platformSends.length;
    const result = await h.taskHarness.executeDeliveryStep(task);
    const saved = h.taskLedger.getTask(task.taskId);
    console.log('unknown receipt=' + JSON.stringify({ result, status: saved.status, delivery: saved.delivery, sends: f.platformSends.length - before }));
    assert.equal(saved.delivery.status, 'delivery_unknown');
    assert.equal(saved.delivery.messageId ?? null, null);
    assert.equal(f.platformSends.length - before, 1);
    assert.ok(result.code && result.hint);
    assert.equal(h.taskLedger.getTask(task.taskId).goal, 'unknown receipt');
    const again = await h.taskHarness.executeDeliveryStep(task);
    assert.equal(again.status, 'delivery_unknown');
    assert.ok(again.code && again.hint);
    assert.equal(f.platformSends.length - before, 1);
    console.log('unknown retry sends=' + (f.platformSends.length - before));
  });
  await test('ack id is persisted', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const task = h.taskLedger.createTask({ goal: 'known receipt', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    const result = await h.taskHarness.executeDeliveryStep(task);
    const saved = h.taskLedger.getTask(task.taskId);
    console.log('ack ledger=' + JSON.stringify({result, status: saved.status, delivery: saved.delivery}));
    assert.equal(saved.delivery.status, 'delivered'); assert.equal(saved.delivery.messageId, 9001);
  });
  await test('rejection is structured', async () => {
    reply = { status: 'failed', retcode: 100, data: {} };
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '拒绝测试', phase: 'status' });
    console.log('rejected=' + JSON.stringify(result));
    assert.equal(result.ok, false); assert.equal(result.delivery, 'rejected'); assert.ok(result.code && result.error && result.hint);
  });
  await test('all long reply segments acknowledged', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const before = f.platformSends.length;
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: 'x'.repeat(5000), phase: 'status' });
    console.log('long reply=' + JSON.stringify({ result, sends: f.platformSends.length - before }));
    assert.equal(result.delivery, 'delivered');
    assert.equal(f.platformSends.length - before, 2);
  });
  await test('cancel during delivery retains cancellation', async () => {
    const task = h.taskLedger.createTask({ goal: 'cancel race', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    let resolveReply, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pendingReply = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { entered(); return pendingReply; };
    const send = h.taskHarness.executeDeliveryStep(task);
    await started;
    h.taskLedger.cancelTask(task.taskId);
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    const result = await send; const saved = h.taskLedger.getTask(task.taskId);
    console.log('cancel race=' + JSON.stringify({ result, status: saved.status, delivery: saved.delivery }));
    assert.equal(saved.status, 'cancelled'); assert.equal(result.code, 'TASK_CANCELLED'); assert.ok(result.hint);
    assert.equal(saved.delivery.status, 'delivered'); assert.equal(saved.delivery.messageId, 9001);
  });
  await test('blocked mode permits owner management send', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'reserved' } }] } } });
    await h.checkDsh(); assert.ok(h.getModeBlocked());
    const before = f.platformSends.length;
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '模式阻断通知', phase: 'status' });
    console.log('blocked send=' + JSON.stringify({ result, sends: f.platformSends.length - before }));
    assert.equal(result.delivery, 'delivered'); assert.equal(f.platformSends.length - before, 1);
    h.clearModeBlock(); h.setMode('chat');
  });
  await test('wrong target and cancelled delivery fail closed', async () => {
    const bad = await h.sendOwnerManagementReply({ conversationKey: 'private:42', text: '禁止', phase: 'status' });
    const task = h.taskLedger.createTask({ goal: 'cancelled', requestor }); h.taskLedger.cancelTask(task.taskId);
    const cancelled = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '禁止', taskId: task.taskId, phase: 'delivery' });
    console.log('denials=' + JSON.stringify({ bad, cancelled }));
    for (const result of [bad, cancelled]) { assert.equal(result.ok, false); assert.equal(result.delivery, 'rejected'); assert.ok(result.code && result.error && result.hint); }
  });
  await test('unknown delivery does not send failure notice', async () => {
    // 直接测投递步骤：未知回执只记 delivery_unknown，不得再额外发“任务失败”。
    // 不再走无网址的研究路径（审查 03 后那条路径会按 RESEARCH_URLS_REQUIRED 失败）。
    reply = { status: 'ok', retcode: 0, data: {} };
    const task = h.taskLedger.createTask({ goal: 'unknown delivery notice', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    const before = f.platformSends.length;
    const result = await h.taskHarness.executeDeliveryStep(task);
    const sent = f.platformSends.slice(before);
    const saved = h.taskLedger.getTask(task.taskId);
    console.log('unknown delivery notice=' + JSON.stringify({ sends: sent, result, delivery: saved.delivery }));
    assert.equal(sent.length, 1, 'unknown receipt must produce exactly one platform send');
    assert.ok(!sent.some(item => JSON.stringify(item.text).includes('任务失败')), 'unknown receipt must not emit a failure notice');
    assert.equal(saved.delivery.status, 'delivery_unknown');
    assert.equal(saved.delivery.messageId ?? null, null);
    assert.ok(result.code && result.hint);
  });
  await test('cancellation during start keeps task cancelled', async () => {
    let enter, resolveReply;
    const started = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { enter(); return pending; };
    const before = f.platformSends.length;
    const text = '任务：cancel start http://127.0.0.1:1/cancel-start';
    const running = h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    await started;
    const task = h.taskLedger.listTasks({ conversationKey: KEY, limit: 1 })[0];
    const cancelled = h.taskLedger.cancelTask(task.taskId);
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    await running;
    const final = h.taskLedger.getTask(task.taskId);
    console.log('start cancellation=' + JSON.stringify({ before: cancelled.status, after: final.status, sends: f.platformSends.length - before }));
    assert.equal(cancelled.status, 'cancelled'); assert.equal(final.status, 'cancelled'); assert.equal(f.platformSends.length - before, 1);
  });
  await test('new failure codes include actionable hints', async () => {
    const empty = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '', phase: 'status' });
    assert.equal(empty.code, 'OWNER_REPLY_EMPTY'); assert.ok(empty.hint);
    const task = h.taskLedger.createTask({ goal: 'original goal', requestor });
    const mismatch = await h.taskHarness.runTaskPipeline({ taskId: task.taskId, requestor, goal: 'different goal' });
    assert.equal(mismatch.code, 'TASK_OWNER_MISMATCH'); assert.ok(mismatch.hint);
    let enter, resolveReply;
    const started = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { enter(); return pending; };
    const first = h.sendOwnerManagementReply({ conversationKey: KEY, text: '排队首条', phase: 'status' });
    await started;
    const second = h.sendOwnerManagementReply({ conversationKey: KEY, text: '排队第二条', phase: 'status' });
    h.cfg.ownerQQ = '99999';
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    await first;
    const changed = await second;
    h.cfg.ownerQQ = OWNER;
    assert.equal(changed.code, 'OWNER_REPLY_CONTEXT_CHANGED'); assert.ok(changed.hint);
    console.log('failure codes=' + JSON.stringify({ empty, mismatch, changed }));
  });
  await test('foreign task details are not disclosed', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const foreign = h.taskLedger.createTask({ goal: 'FOREIGN_PRIVATE_GOAL', requestor: { platform: 'qq', userId: '42', conversationKey: 'private:42', isOwner: true } });
    const text = `任务状态 ${foreign.taskId}`; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sent = f.platformSends.slice(before);
    console.log('foreign status=' + JSON.stringify(sent));
    assert.ok(!JSON.stringify(sent).includes('FOREIGN_PRIVATE_GOAL'), 'foreign task contents must not be disclosed');
  });
  await test('foreign task cancellation has no side effect', async () => {
    const foreign = h.taskLedger.createTask({ goal: 'foreign cancel', requestor: { platform: 'qq', userId: '42', conversationKey: 'private:42', isOwner: true } });
    const beforeTask = h.taskLedger.getTask(foreign.taskId); const before = f.platformSends.length;
    const text = `取消任务 ${foreign.taskId}`;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const afterTask = h.taskLedger.getTask(foreign.taskId); const sent = f.platformSends.slice(before);
    console.log('foreign cancel=' + JSON.stringify({ before: beforeTask.status, after: afterTask.status, sends: sent }));
    assert.deepEqual(afterTask, beforeTask, 'foreign task ledger must remain unchanged');
  });
  await test('terminal task cancellation reports actual status', async () => {
    const results = [];
    for (const status of ['completed', 'failed']) {
      const task = h.taskLedger.createTask({ goal: `terminal ${status}`, requestor });
      h.taskLedger.updateTask(task.taskId, { status });
      const before = f.platformSends.length; const text = `取消任务 ${task.taskId}`;
      await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
      const sent = f.platformSends.slice(before); const actual = h.taskLedger.getTask(task.taskId).status;
      console.log('terminal cancel=' + JSON.stringify({ actual, sends: sent }));
      results.push({ status, actual, sent });
    }
    for (const item of results) { assert.equal(item.actual, item.status); assert.ok(!JSON.stringify(item.sent).includes('状态已置为 cancelled'), 'terminal task must not claim cancellation'); }
  });
  await test('non-owner rejection uses system reply', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const admission = h.taskHarness.checkAdmission({ requestor: { platform: 'qq', userId: '42', conversationKey: GROUP_KEY, isOwner: false } });
    console.log('non-owner admission=' + JSON.stringify(admission));
    assert.equal(admission.ok, false); assert.ok(admission.code && admission.error && admission.hint);
    const text = '任务状态'; const before = f.platformSends.length;
    await h.handleIncoming('group', 90001, inbound({ user_id: 42, group_id: 90001, self_id: Number(LOGIN), raw_message: text, message: [{ type: 'text', data: { text } }], sender: { user_id: 42, nickname: '访客' } }), h.cfg);
    console.log('non-owner sends=' + JSON.stringify(f.platformSends.slice(before)));
    assert.ok(f.platformSends.length > before, 'non-owner must receive restricted system rejection');
  });
  const makeAuditOwner = async (options = {}) => {
    const auditConfig = {
      ownerQQ: OWNER,
      allow: { private: [OWNER], groups: [] },
      deny: { private: [], groups: [], users: [] },
      slang: { enabled: false },
      socialV2: { tokenGuard: { enabled: false } }
    };
    const audit = await bridgeHarness({ config: auditConfig, ...options });
    audit.setReady(true);
    audit.setSelfUserId(100);
    audit.setMode('chat');
    audit.bot.sendPrivateMessage = async (id, text) => {
      audit.calls.sent.push({ kind: 'private', id, text });
      return { message_id: 9001 };
    };
    const send = async raw => {
      const beforeAudit = audit.calls.sent.length;
      await audit.handleIncoming('private', Number(OWNER), inbound({ raw_message: raw, message: [{ type: 'text', data: { text: raw } }] }), audit.cfg);
      return audit.calls.sent.slice(beforeAudit);
    };
    return { h: audit, send };
  };
  await test('ack survives later ledger write failure', async () => {
    const fetchCalls = [];
    const { h: auditH, send: auditSend } = await makeAuditOwner({
      globals: {
        safeFetch: async (url, maxChars) => {
          fetchCalls.push({ url, maxChars });
          return { url, statusCode: 200, body: '<html>送达测试正文可以复现。</html>', truncated: false };
        }
      }
    });
    try {
      const originalUpdate = auditH.taskLedger.updateTask.bind(auditH.taskLedger);
      let failedTaskId = null;
      auditH.taskLedger.updateTask = (id, patch) => {
        if (patch && patch.status === 'completed' && patch.delivery && patch.delivery.status === 'delivered') {
          failedTaskId = id;
          throw Object.assign(new Error('模拟账本写入失败'), { code: 'TASK_LEDGER_UNAVAILABLE' });
        }
        return originalUpdate(id, patch);
      };
      const beforeAudit = auditH.calls.sent.length;
      const raw = '任务：送达写入失败 https://source.example/delivery';
      const sends = await auditSend(raw);
      const allSends = auditH.calls.sent.slice(beforeAudit);
      const report = allSends.find(s => String(s.text).includes('任务完成'));
      assert.ok(failedTaskId, 'must reach the final ledger write');
      assert.ok(report, 'delivered report must reach the platform');
      assert.ok(String(report.text).includes(failedTaskId), 'delivered report must include task number');
      assert.ok(!allSends.some(s => /未发送|任务失败/.test(String(s.text))), 'must never claim the acknowledged message was not sent');
      assert.equal(fetchCalls.length, 1, 'the source must be fetched exactly once');
      const saved = auditH.taskLedger.getTask(failedTaskId);
      console.log('ack ledger failure=' + JSON.stringify({ status: saved.status, delivery: saved.delivery, sends: allSends.length }));
      assert.notEqual(saved.status, 'failed', 'acknowledged delivery must not be rewritten as failed');
      assert.notEqual(saved.delivery && saved.delivery.status, 'delivery_unknown', 'acknowledged delivery must not be rewritten as unknown');
      auditH.taskLedger.updateTask = originalUpdate;
      const repeat = await auditH.taskHarness.runTaskPipeline({ taskId: failedTaskId, requestor, goal: '送达写入失败 https://source.example/delivery', urls: ['https://source.example/delivery'] });
      assert.equal(repeat.ok, false);
      assert.equal(repeat.code, 'OWNER_REPLY_UNKNOWN', 'delivering task must block rerun');
      assert.equal(auditH.calls.sent.length - beforeAudit, allSends.length, 'same task must not resend');
      assert.equal(fetchCalls.length, 1, 'same task must not refetch');
    } finally { await auditH.close(); }
  });
  await test('delivery_unknown task number never auto-resends', async () => {
    const fetchCalls = [];
    const { h: auditH, send: auditSend } = await makeAuditOwner({
      globals: {
        safeFetch: async (url, maxChars) => {
          fetchCalls.push({ url, maxChars });
          return { url, statusCode: 200, body: '<html>不应重发</html>', truncated: false };
        }
      }
    });
    try {
      const task = auditH.taskLedger.createTask({ goal: 'unknown same id', requestor });
      auditH.taskLedger.updateTask(task.taskId, { status: 'unknown', delivery: { platform: 'qq', targetKey: KEY, status: 'delivery_unknown', at: Date.now() } });
      const beforeAudit = auditH.calls.sent.length;
      const statusSends = await auditSend('任务状态 ' + task.taskId);
      assert.equal(statusSends.length, 1);
      assert.ok(String(statusSends[0].text).includes('- 交付：delivery_unknown'));
      const repeat = await auditH.taskHarness.runTaskPipeline({ taskId: task.taskId, requestor, goal: 'unknown same id', urls: ['https://source.example/unknown'] });
      assert.equal(repeat.ok, false);
      assert.equal(repeat.code, 'OWNER_REPLY_UNKNOWN');
      assert.ok(repeat.code && repeat.hint);
      assert.equal(auditH.calls.sent.length - beforeAudit, 1, 'delivery_unknown task must not resend');
      assert.equal(fetchCalls.length, 0, 'delivery_unknown task must not refetch');
    } finally { await auditH.close(); }
  });
  await test('ack survives post-send ledger file corruption without claiming undelivered', async () => {
    const fetchCalls = [];
    const { h: auditH, send: auditSend } = await makeAuditOwner({
      globals: {
        safeFetch: async (url, maxChars) => {
          fetchCalls.push({ url, maxChars });
          return { url, statusCode: 200, body: '<html>送达后账本损坏复现正文。</html>', truncated: false };
        }
      }
    });
    try {
      const originalSend = auditH.bot.sendPrivateMessage;
      auditH.bot.sendPrivateMessage = async (id, text) => {
        const res = await originalSend(id, text);
        if (String(text).includes('任务完成')) {
          fs.writeFileSync(auditH.taskLedger.filePath, '{CORRUPTED_AFTER_SEND');
        }
        return res;
      };
      const beforeAudit = auditH.calls.sent.length;
      await auditSend('任务：送达后读账本损坏 https://source.example/post-send-corrupt');
      const allSends = auditH.calls.sent.slice(beforeAudit);
      assert.ok(allSends.some(s => String(s.text).includes('任务完成')), 'report must reach platform');
      assert.ok(!allSends.some(s => /未投递报告|未发送|任务失败/.test(String(s.text))), 'must never claim report was undelivered after platform ACK: ' + JSON.stringify(allSends));
      assert.equal(fetchCalls.length, 1);
    } finally { await auditH.close(); }
  });
  await test('direct executeDeliveryStep refuses delivering task without resending', async () => {
    const task = h.taskLedger.createTask({ goal: 'delivering guard', requestor });
    h.taskLedger.updateTask(task.taskId, {
      artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' },
      delivery: { platform: 'qq', targetKey: KEY, status: 'delivering', at: Date.now() }
    });
    const before = f.platformSends.length;
    const res = await h.taskHarness.executeDeliveryStep(task);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'OWNER_REPLY_UNKNOWN');
    assert.ok(res.hint);
    assert.equal(f.platformSends.length - before, 0, 'delivering task must never be resent by direct executeDeliveryStep');
  });} finally {
  await f.close();
  assert.ok(fs.realpathSync(root).startsWith(testHome + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
