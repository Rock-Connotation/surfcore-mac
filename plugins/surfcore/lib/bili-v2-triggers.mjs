import { replyCoordinates } from '../tools/lib/msgfeed.mjs';

const failure = (code, error, hint) => ({ ok: false, code, error, hint });
const unproven = () => failure('BILI_V2_TRIGGER_UNPROVEN', 'B站触发缺少精确的原始消息坐标。', '保留官方通知的 sourceRoot/sourceId/targetId 或私信 msgKey，再重新核对来源；不要用摘要补原文。');
function id(value, zero = false) {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return (zero ? /^(0|[1-9][0-9]{0,29})$/ : /^[1-9][0-9]{0,29}$/).test(text) ? text : null;
}
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

export function projectBiliV2Trigger({ input, providerRouteId } = {}) {
  if (typeof providerRouteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(providerRouteId)) return unproven();
  if (!input || !['comment-notification', 'dm-notification'].includes(input.kind)) {
    return failure('BILI_V2_TRIGGER_UNSUPPORTED', '此B站触发尚未注册可验证的原始来源。', '先注册对应的官方来源或Host事件证明；保持失败可见，不回退旧历史或伪造 full 覆盖。');
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 32) return unproven();
  const groups = new Map();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return unproven();
    let target, locator;
    if (input.kind === 'comment-notification') {
      const rpid = id(item.sourceId), type = id(item.business), oid = id(item.oid), root = id(item.sourceRoot, true), parent = id(item.targetId, true), authorMid = id(item.mid);
      if (!rpid || !['1', '11', '17'].includes(type) || !oid || root === null || parent === null || !authorMid) return unproven();
      const reply = replyCoordinates({ root, sourceId: rpid, targetId: parent });
      target = { audience: 'public', kind: 'comment', type, oid, root: reply.root, parent: reply.parent };
      locator = { kind: 'comment', rpid, type, oid, root, parent, authorMid };
    } else {
      const mid = id(item.mid), msgKey = id(item.msgKey);
      if (!mid || !msgKey) return unproven();
      target = { audience: 'private', kind: 'dm', mid };
      locator = { kind: 'dm', mid, msgKey };
    }
    const key = JSON.stringify(target);
    let group = groups.get(key);
    if (!group) {
      group = { scope: { audience: target.audience, target, providerRouteId }, input: { kind: input.kind, items: [] } };
      groups.set(key, group);
    }
    const serialized = JSON.stringify(locator);
    if (!group.input.items.some(previous => JSON.stringify(previous) === serialized)) group.input.items.push(locator);
  }
  return freeze({ ok: true, groups: [...groups.values()] });
}
