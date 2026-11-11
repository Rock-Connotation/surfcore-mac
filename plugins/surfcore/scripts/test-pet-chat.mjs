/**
 * 桌宠对话的纯逻辑回归（不连模型、不发消息、不读用户数据）：
 *   · 语音文本截断 / 去旁白；
 *   · 模型回复清理；
 *   · 本地令牌与事件水位（插件重启后旧游标不回放、也不卡死）。
 *
 * 运行：node plugins/surfcore/scripts/test-pet-chat.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Bind module-level paths before importing the service; never read the user's profile.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-chat-test-'));
process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
const qqRoot = path.join(tmp, 'qq-fixture');
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '');
const qqConfig = path.join(qqRoot, 'config.json');
fs.writeFileSync(qqConfig, JSON.stringify({ socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'volc' } } } }));
process.env.SURFCORE_ROOT = qqRoot;
fs.mkdirSync(path.join(tmp, 'surfcore'), {recursive:true});
fs.writeFileSync(path.join(tmp,'surfcore','config.json'),JSON.stringify({pet:{chat:{enabled:true}}}));
const {
  clipForVoice,
  cleanReply,
  stripStageDirections,
  buildPetMemoryEvents,
  createPetChatService,
} = await import('../lib/pet-chat.js');
const { withVolcBudgetLock } = await import('../../../src/voice-volc-budget.js');

// ── 语音文本 ────────────────────────────────────────────────────────────────
assert.equal(clipForVoice('你好呀', 120), '你好呀');
const long = '第一句话很长很长很长。第二句话也很长很长很长。第三句话更长更长更长更长。';
const clipped = clipForVoice(long, 18);
assert.ok(clipped.length <= 19, `截断后应不超过上限：${clipped.length}`);
assert.ok(clipped.endsWith('。') || clipped.endsWith('…'), `应在句号处截断：${clipped}`);
assert.equal(clipForVoice('啊'.repeat(50), 20).length <= 21, true);
assert.equal(stripStageDirections('（笑）在呀 (挥挥手) 弥叭'), '在呀 弥叭');

// ── 回复清理 ────────────────────────────────────────────────────────────────
assert.equal(cleanReply('小肥鱼：在呢'), '在呢');
assert.equal(cleanReply('“在呢”'), '在呢');
assert.equal(cleanReply('**在呢**'), '在呢');
assert.equal(cleanReply('```\n在呢\n```'), '在呢');

// ── 记忆卡事件：和 QQ / B站 同一张卡，但 platform=pet ─────────────────────
{
  const now = Date.now();
  const pair = buildPetMemoryEvents({ userText: '在干嘛呀', replyText: '在陪你呀', at: now, roleName: '小咪' });
  assert.equal(pair.length, 2, '一问一答 = 两条 inbox 事件');
  assert.equal(pair[0].platform, 'pet');
  assert.equal(pair[0].isOwner, true);
  assert.equal(pair[0].text, '在干嘛呀');
  assert.equal(pair[1].isSelf, true);
  assert.equal(pair[1].sender, '小咪');
  assert.equal(pair[1].text, '在陪你呀');
  const proactive = buildPetMemoryEvents({ replyText: '突然想跟你说句话', at: now, roleName: '小咪' });
  assert.equal(proactive.length, 1, '主动搭话只有她自己那条');
  assert.equal(proactive[0].isSelf, true);
  assert.equal(proactive[0].platform, 'pet');
}

// ── 令牌 + 事件水位 ─────────────────────────────────────────────────────────

try {
  const service = createPetChatService({
    ctx: { get: () => undefined },
    stateDir: tmp,
    pluginLog: () => {},
  });
  const token = service.token();
  assert.match(token, /^[a-f0-9]{32,80}$/, '令牌必须是随机 hex');
  assert.equal(service.token(), token, '令牌要稳定复用');

  const first = await service.poll({ since: null, waitMs: 0 });
  assert.equal(first.events.length, 0, '首次连接不重放历史事件');
  assert.equal(first.cursor, 0);

  service.emit({ type: 'proactive', text: '在吗', modality: 'text' });
  const got = await service.poll({ since: 0, waitMs: 0 });
  assert.equal(got.events.length, 1, '新事件应该被取到');
  assert.equal(got.events[0].text, '在吗');
  assert.equal(got.cursor, 1);

  // 插件重启 / 老客户端带着更大的游标来：直接回到新水位，不能死等。
  const stale = await service.poll({ since: 99, waitMs: 0 });
  assert.equal(stale.events.length, 0);
  assert.equal(stale.cursor, 1);

  // 专注模式：单一真相在 pet/focus.json；事件要能立刻唤醒长轮询。
  assert.equal(service.focusEnabled(), false);
  const focus = service.setFocus(true, 'test');
  assert.equal(focus.enabled, true);
  assert.equal(service.focusEnabled(), true);
  assert.equal(service.publicConfig().focus.enabled, true);
  assert.equal(service.status().focus.enabled, true);
  const focusEvent = await service.poll({ since: 1, waitMs: 0 });
  assert.equal(focusEvent.events.length, 1);
  assert.equal(focusEvent.events[0].type, 'focus');
  assert.equal(focusEvent.events[0].enabled, true);
  assert.equal(service.setFocus(false, 'test').enabled, false);
  assert.equal(service.focusEnabled(), false);

  // 没连模型时聊天必须给可读错误，而不是抛异常。
  const chat = await service.chat({ text: '在吗', modality: 'text' });
  assert.equal(chat.ok, false);
  assert.match(chat.error, /模型服务|就绪/);

  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => {
    requests++; assert.throws(() => withVolcBudgetLock(qqConfig, () => {}), e => e.code === 'VOICE_VOLC_BUDGET_BUSY');
    return new Response(Buffer.alloc(48));
  };
  try {
    const before = await service.poll({ since: null, waitMs: 0 });
    const blocked = await service.proactive({ text: '你好', modality: 'voice' });
    assert.equal(blocked.ok, true); assert.equal(blocked.voice.code, 'VOICE_PET_VOLC_UNSUPPORTED'); assert.ok(blocked.voice.hint);
    assert.equal(requests, 0, '火山选择时桌宠不得调用旧云');
    const event = await service.poll({ since: before.cursor, waitMs: 0 });
    assert.equal(event.events.at(-1).voice.code, 'VOICE_PET_VOLC_UNSUPPORTED'); assert.ok(event.events.at(-1).voice.hint);
    assert.match(service.status().lastError, /桌宠暂不支持火山语音/);
    const cfg = JSON.parse(fs.readFileSync(qqConfig)); cfg.socialV2.voice.tts.cloudProvider = 'voxd';
    fs.writeFileSync(qqConfig, JSON.stringify(cfg));
    const allowed = await service.proactive({ text: '旧云测试', modality: 'voice' });
    assert.equal(allowed.voice.ok, true); assert.equal(requests, 1); assert.equal(service.status().lastError, '');
  } finally { globalThis.fetch = originalFetch; }
  console.log('pet-chat tests OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
