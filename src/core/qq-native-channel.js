import { randomUUID } from 'node:crypto';

const fail = (code, error, hint = '打开 SurfCore 概览检查当前角色、QQ 连接与记忆权限；确认原消息回执后再重试。') => ({ ok: false, code, error, hint });
const sameRole = (a, b) => a?.id === b?.characterId && a?.epoch === b?.characterEpoch;

/** Private Host transport. Model tools cannot acquire these single-use leases. */
export function createNativeQQChannel({ memory, getCharacter, getIdentity, isAllowed, send, getCapabilities = () => ({ ok: true, voice: { enabled: false } }), onComplete, now = Date.now }) {
  const jobs = new Map(), leases = new Map();
  function begin(key, role, throughSeq) {
    const old = jobs.get(key);
    if (old && !old.completed && sameRole(role, old)) return fail('MEMORY_QQ_BUSY', '该会话的上一条 Native 回复仍在处理中。', '等待原回复结束；不要重复提交同一条消息。');
    if (!role || !isAllowed(key) || jobs.size >= 256 && !jobs.has(key)) return fail('MEMORY_QQ_REQUEST_INVALID', '无法建立当前 QQ 回复。');
    const request = { key, requestId: randomUUID(), characterId: role.id, characterEpoch: role.epoch };
    old?.controller.abort();
    jobs.set(key, { ...request, throughSeq, at: now(), completed: false, controller: new AbortController() });
    return { ok: true, request };
  }
  async function request(body) {
    const job = jobs.get(body?.key);
    if (!job || body.requestId !== job.requestId || body.characterId !== job.characterId || body.characterEpoch !== job.characterEpoch || !sameRole(getCharacter(), job) || !isAllowed(job.key)) return fail('MEMORY_QQ_JOB_STALE', '该 QQ 回复不属于当前角色或已授权作业。');
    const actions = {
      sources: [], capabilities: [], authorize: ['loginAccountId'], send: ['lease', 'text', 'delivery'],
      record: ['lease', 'text', 'messageId', 'deliveryState', 'delivery'], retire: [], complete: ['ok', 'code', 'error', 'hint'],
    };
    if (!Object.hasOwn(actions, body.action) || Object.keys(body).some(key => !['action', 'key', 'requestId', 'characterId', 'characterEpoch', ...actions[body.action]].includes(key))) return fail('MEMORY_FIELD_FORBIDDEN', 'QQ Native 请求包含未授权字段。');
    if (body.action === 'complete') {
      if (typeof body.ok !== 'boolean') return fail('MEMORY_QQ_REQUEST_INVALID', 'QQ 回复终态无效。');
      if (!job.completed) {
        job.controller.abort();
        job.completing ??= Promise.resolve().then(() => onComplete(job, body)).then(() => { job.completed = true; });
        try { await job.completing; } finally { job.completing = null; }
      }
      return { ok: true };
    }
    if (body.action === 'retire') {
      job.retired = true;
      job.controller.abort();
      await memory.retire(job.key, { preserveSources: true });
      for (const [id, item] of leases) if (item.job === job && item.state === 'authorized') leases.delete(id);
      return { ok: true };
    }
    if (job.completed || job.retired || now() - job.at > 240_000) return fail('MEMORY_QQ_JOB_STALE', '该 QQ 回复已结束或过期。');
    const identity = await getIdentity();
    if (!identity?.ok || identity.verified !== true || !sameRole(getCharacter(), job) || !isAllowed(job.key)) return fail('MEMORY_QQ_IDENTITY_UNVERIFIED', '无法确认当前 QQ 身份与会话权限。');
    if (body.action === 'sources') return memory.exportNativeSources(job.key);
    if (body.action === 'capabilities') return getCapabilities(job.key);
    if (body.action === 'authorize') {
      if (String(body.loginAccountId) !== String(identity.accountId)) return fail('MEMORY_QQ_IDENTITY_CHANGED', 'QQ 登录账号已变化。');
      for (const [id, item] of leases) if (now() - item.at > 300_000) leases.delete(id);
      if (leases.size >= 256) return fail('MEMORY_QQ_BUSY', '待确认的 QQ 发送回执过多。');
      const authorized = await memory.authorizeSend({ key: job.key, loginAccountId: identity.accountId });
      if (!authorized.ok) return authorized;
      const id = randomUUID();
      leases.set(id, { job, accountId: identity.accountId, lease: authorized.lease, at: now(), state: 'authorized' });
      return { ok: true, lease: id };
    }
    const item = leases.get(body.lease);
    if (!item || item.job !== job || item.accountId !== identity.accountId) return fail('MEMORY_SOURCE_LEASE_REQUIRED', '缺少属于当前作业和 QQ 账号的发送租约。');
    if (body.action === 'record') {
      if (item.state !== 'recorded' || item.text !== body.text || item.delivery !== (body.delivery ?? 'text') || item.messageId !== body.messageId || item.deliveryState !== body.deliveryState) return fail('MEMORY_QQ_RECEIPT_MISMATCH', '回执与原发送结果不一致。');
      return item.receipt;
    }
    if (item.state !== 'authorized') return fail('MEMORY_SOURCE_LEASE_REQUIRED', '该发送租约已使用，不能重复发送。');
    const delivery = body.delivery ?? 'text';
    if (!['text', 'voice'].includes(delivery) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > (delivery === 'voice' ? 120 : 12000)) return fail('MEMORY_QQ_OUTPUT_INVALID', 'QQ 回复格式无效、为空或超过长度限制。');
    const validate = async () => {
      const current = await getIdentity();
      if (job.controller.signal.aborted || jobs.get(job.key) !== job || job.retired || job.completed || now() - job.at > 240000 || !sameRole(getCharacter(), job) || !isAllowed(job.key) || !current?.ok || !current.verified || current.accountId !== item.accountId) throw fail('MEMORY_QQ_JOB_STALE', '发送前作业、角色、QQ 账号或会话权限已变化。');
      const valid = await memory.validate(job.key, { prepared: true });
      if (!valid.ok) throw valid;
      if (job.controller.signal.aborted || !sameRole(getCharacter(), job) || !isAllowed(job.key)) throw fail('MEMORY_QQ_JOB_STALE', '授权核对期间作业已退役。');
    };
    try { await validate(); } catch (error) { return error; }
    // Consume before any async transport work, including TTS; never synthesize twice.
    if (item.state !== 'authorized') return fail('MEMORY_SOURCE_LEASE_REQUIRED', '该发送租约已使用。');
    item.state = 'sending'; item.text = body.text; item.delivery = delivery;
    let result;
    try { result = await send(job.key, body.text, { delivery, validate, signal: job.controller.signal }); }
    catch { result = fail('MEMORY_QQ_DELIVERY_UNKNOWN', 'QQ 发送结果未知。', '先检查原消息是否送达；不要自动重发。'); }
    item.messageId = result?.ok && result.messageId != null ? String(result.messageId) : null;
    item.deliveryState = item.messageId !== null ? 'delivered' : 'delivery_unknown';
    item.receipt = await memory.recordSent(item.lease, { text: body.text, messageId: item.messageId, deliveryState: item.deliveryState });
    item.state = 'recorded';
    if (item.deliveryState !== 'delivered') return result?.ok === false && result.code && result.hint ? result : fail('MEMORY_QQ_DELIVERY_UNKNOWN', 'QQ 发送结果未知。', '先检查原消息和原回执；不会自动重发。');
    if (!item.receipt.ok) return item.receipt;
    return { ok: true, messageId: item.messageId, deliveryState: item.deliveryState, ...(result?.warning?.code && result.warning.hint ? { warning: result.warning } : {}) };
  }
  return Object.freeze({ begin, request });
}
