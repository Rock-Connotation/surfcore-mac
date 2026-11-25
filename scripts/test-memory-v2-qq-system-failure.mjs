import assert from 'node:assert/strict';
import { createSystemFailureQueue, formatSystemFailureNotice, normalizeSystemFailure } from '../src/core/memory-v2-qq-system-failure.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let now = 1000;
const queue = createSystemFailureQueue({
  now: () => now,
  redact: (value) => String(value ?? '').replace(/SECRET_[a-z0-9]+/gi, '********'),
});

const first = queue.add({ key: 'group:1135502130', code: 'MEMORY_SOURCE_PENDING', error: '输入未提交 SECRET_abc123', hint: '检查原始回执 SECRET_abc123' });
assert.ok(first);
assert.equal(first.code, 'MEMORY_SOURCE_PENDING');
assert.ok(first.error && first.hint);
const notice = formatSystemFailureNotice(first);
assert.match(notice, /【系统提示】MEMORY_SOURCE_PENDING/);
assert.match(notice, /这不是角色回复/);
assert.ok(!notice.includes('SECRET_abc123'));
assert.equal(queue.add({ ...first }), null);
now += 11 * 60 * 1000;
assert.ok(queue.add({ ...first }));

const fallback = queue.add({ key: 'private:2125387192', code: 'lowercase', error: '', hint: '' });
assert.equal(fallback.code, 'MEMORY_QQ_FAILED');
assert.ok(fallback.error && fallback.hint);
assert.equal(normalizeSystemFailure({ key: 'purpose', code: 'MEMORY_X' }), null);
assert.equal(queue.list('group:1135502130').length, 1);
queue.ack('group:1135502130', first);
assert.equal(queue.list('group:1135502130').length, 0);
assert.deepEqual(queue.keys(), ['private:2125387192']);

// 桥接真链路回归：系统提示走管理通道（managementSendTickets），绝不触发 MEMORY_PRESET_UNSAFE 或清空 qqMemory；
// 发送失败时保留队列，重连后补发；普通群聊 15 条消息不自动触发已退役的 MEMORY_DERIVATION_UNAVAILABLE。
{
  const sent = [];
  let failSend = false;
  let retireCalls = 0;
  class StubBot {
    async sendPrivateMessage(id, text) {
      if (failSend) throw new Error('transport down');
      sent.push({ kind: 'private', id, text });
      return { status: 'ok', retcode: 0, data: { message_id: 9100 + sent.length } };
    }
    async sendGroupMessage(id, text) {
      if (failSend) throw new Error('transport down');
      sent.push({ kind: 'group', id, text });
      return { status: 'ok', retcode: 0, data: { message_id: 9200 + sent.length } };
    }
    onPrivateMessage() {}
    onGroupMessage() {}
    onNotice() {}
    onEvent() {}
  }
  const h = await bridgeHarness({
    config: { ownerQQ: 2125387192, sendDelayMs: 0, allow: { groups: ['1135502130'], private: ['2125387192'] }, slang: { enabled: true, extractMinMessages: 10, extractCooldownMs: 0 } },
    globals: {
      SnowLumaWebSocketClient: StubBot,
      createQQMemoryBridge: () => ({
        routing: () => ({ ok: true, backend: 'v2' }),
        captureSource: async () => ({ ok: true, sourceState: 'committed' }),
        validateSessionSafety: async () => ({ ok: false, code: 'MEMORY_PRESET_UNSAFE', error: 'no session', hint: 'native only' }),
        retire: async (_key, opts) => { retireCalls++; if (!opts?.preserveSources) throw new Error('retire wiped committed sources'); },
        status: () => ({ sourceState: 'committed', active: false, failure: null }),
      }),
    },
  });
  try {
    h.setMode('reserved2');
    h.setReady(true);
    h.setSelfIdentity('红豆', '787661104');
    h.setSnowlumaHealth({ connected: true, everConnected: true, downNotified: false });

    // 1) 成功路径：发送系统提示不得撞 MEMORY_PRESET_UNSAFE、不得调用 qqMemory.retire、不记失败连击
    h.memoryV2Failure('group:1135502130', { code: 'MEMORY_POLICY_DENIED', error: '模型许可未确认', hint: '打开记忆页确认。' });
    await h.flushSystemFailures('group:1135502130');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'group');
    assert.match(String(sent[0].text), /【系统提示】MEMORY_POLICY_DENIED/);
    assert.equal(h.systemFailureQueue.list('group:1135502130').length, 0);
    assert.equal(retireCalls, 0, '系统提示不得触发 qqMemory.retire 清空已提交来源');
    assert.equal(h.memoryV2Failures.get('group:1135502130')?.code, 'MEMORY_POLICY_DENIED', '不得被 MEMORY_PRESET_UNSAFE 覆盖');
    assert.equal(h.getSocialV2State('group:1135502130').sendFailureStreak || 0, 0);

    // 2) 失败与重连补发路径：通道异常时留队且不清空 qqMemory；重连后补发并 ack
    failSend = true;
    h.memoryV2Failure('private:2125387192', { code: 'MEMORY_SOURCE_PENDING', error: '输入待提交', hint: '检查原回执。' });
    await new Promise((r) => setTimeout(r, 30));
    await h.flushSystemFailures('private:2125387192');
    assert.equal(h.systemFailureQueue.list('private:2125387192').length, 1, '发送失败时必须保留待补发队列');
    assert.equal(retireCalls, 0);

    failSend = false;
    h.notifySendChannelUp();
    await new Promise((r) => setTimeout(r, 30));
    await h.flushSystemFailures('private:2125387192');
    assert.equal(h.systemFailureQueue.list('private:2125387192').length, 0, '重连后必须补发并 ack');
    assert.equal(sent.length, 2);
    assert.match(String(sent[1].text), /【系统提示】MEMORY_SOURCE_PENDING/);
    assert.equal(retireCalls, 0);

    // 3) 已退役黑话提炼：普通群聊 15 条消息不自动触发 MEMORY_DERIVATION_UNAVAILABLE，但显式调用仍返回 code+hint
    h.memoryV2Failures.delete('group:1135502130');
    for (let i = 0; i < 15; i++) h.feedSlangWindow('group:1135502130', '群友', `普通聊天消息 ${i}`);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.memoryV2Failures.get('group:1135502130'), undefined, '群聊消息不得自动触发退役黑话阻断');
    assert.equal(sent.length, 2, '群聊消息不得向群内刷系统提示');
    const direct = await h.runSlangExtraction('group:1135502130');
    assert.equal(direct.code, 'MEMORY_DERIVATION_UNAVAILABLE');
    assert.ok(direct.hint);

    // 4) 桥接确定性斜杠命令（/status）在 V2 Native 无旧会话时走管理直发通道：不撞 MEMORY_PRESET_UNSAFE、不清空 qqMemory、不计通道连败
    const beforeCmd = sent.length;
    await h.handleIncoming('private', '2125387192', {
      user_id: 2125387192, self_id: 787661104, message_id: 9901, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: '/status' } }],
    }, h.cfg);
    assert.equal(sent.length, beforeCmd + 1);
    assert.match(String(sent.at(-1).text), /白名单 通过/);
    assert.equal(retireCalls, 0);
    assert.equal(h.getSocialV2State('private:2125387192').sendFailureStreak || 0, 0);

    // 5) 非传输层 MEMORY_* 错误不得计入通道熔断连败，且旧会话安全失败不得擦除已提交来源
    await h.sendToQQ('group:1135502130', '触发旧会话安全拒绝');
    await h.sendToQQ('group:1135502130', '触发旧会话安全拒绝2');
    await h.sendToQQ('group:1135502130', '触发旧会话安全拒绝3');
    assert.equal(h.getSocialV2State('group:1135502130').sendFailureStreak || 0, 0, 'MEMORY_PRESET_UNSAFE 非通道故障，不得计入连败');
    assert.equal(h.getSocialV2State('group:1135502130').wakeSuspendedUntil || 0, 0, 'MEMORY_PRESET_UNSAFE 不得触发 30 分钟唤醒暂停');
    assert.ok(retireCalls >= 1, '旧路径 retire 应执行且带 preserveSources:true（否则上面桩函数会抛错）');
  } finally {
    await h.close();
  }
}

console.log('PASS QQ system failures: structured, redacted, deduped, management-sent and replayable');
