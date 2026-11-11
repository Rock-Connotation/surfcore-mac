import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { createModelCallAdmission } from './model-call-admission.mjs';
// A single exact route; catalog declarations and real upstream validation are separate evidence.
const fail = (code, error, hint) => ({ ok: false, code, error, hint });
const issue = (code, error, hint) => Object.assign(new Error(error), { code, hint });
function bounded(operation, { signal, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); error ? reject(error) : resolve(value); };
    const stop = () => finish(issue('COMPANION_MODEL_CANCELLED', '模型准备或请求已取消、超时。', '核对活动与用量后再手动发起；不会自动重试。'));
    const timer = setTimeout(stop, Math.max(1, timeoutMs));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { stop(); return; }
    Promise.resolve().then(() => { if (done || signal?.aborted) throw issue('COMPANION_MODEL_CANCELLED', '模型准备已取消。', '刷新活动状态。'); return operation(); }).then(value => finish(null, value), error => finish(error));
  });
}
export const COMPANION_ROUTE = Object.freeze({ provider: 'surfcore-companion-hy3', model: 'workbuddy/hy3' });

export function createCompanionModel({ ctx, tokenBudget, getCharacter, route = COMPANION_ROUTE } = {}) {
  route = Object.freeze({ provider: route.provider, model: route.model });
  function services() {
    let llm, attachments;
    try { llm = ctx.get('llm'); attachments = ctx.get('attachments'); } catch {}
    return { llm, attachments };
  }
  async function readiness({ signal } = {}) {
    const { llm, attachments } = services();
    if (!llm?.stream || !llm?.listModels || !attachments?.saveImages) return fail('COMPANION_MODEL_UNAVAILABLE', '多模态模型或附件服务尚未就绪。', '在 DSH 连接模型与附件服务后刷新状态。');
    let models;
    try { models = await bounded(() => llm.listModels(route.provider), { signal }); } catch { return fail('COMPANION_ROUTE_UNAVAILABLE', 'WorkBuddy HY3 专用路由未连接或查询已超时。', '连接 SurfCore 陪伴专用 Magpie 路由后刷新；不会切换到其他模型。'); }
    const model = models?.find(item => item.id === route.model);
    if (!model?.inputModalities?.includes('image')) return fail('COMPANION_IMAGE_UNAVAILABLE', 'HY3 路由没有声明图像输入能力。', '核验当前模型目录与图像输入后再开始；标题分析不能代替画面。');
    return { ok: true, ...route, reasoningEffort: 'low', declaredImage: true };
  }
  async function streamRequest({ system, prompt, images = null, signal, beforeSend = null, maxTokens = 8192, timeoutMs = 180000, admitted = false, requestMetadata, admitNetwork }) {
    if (String(system).length + String(prompt).length > 24000) throw issue('COMPANION_INPUT_TOO_LARGE', '本次材料超过输入长度上限。', '选择更短视频或检查异常转写；不会截断后宣称完整理解。');
    const { llm, attachments } = services();
    const local = new AbortController(), abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const duration = Math.min(180000, Math.max(100, timeoutMs)), deadline = Date.now() + duration;
    const timer = setTimeout(abort, duration);
    const check = () => { if (local.signal.aborted) throw issue('COMPANION_MODEL_CANCELLED', '模型请求已取消或超时。', '查看已有用量和活动状态；不会自动重试。'); };
    const guard = async (phase = 'dispatch') => {
      if (typeof beforeSend !== 'function') {
        if (admitted) throw issue('COMPANION_REPLY_GUARD_REQUIRED', '受控调用缺少实际输入与角色校验。', '接入Host beforeSend后重新发起。');
        return;
      }
      const result = await beforeSend({ phase });
      if (result?.ok === false || (admitted && result !== true && result?.ok !== true)) throw issue(result?.code || (admitted ? 'MODEL_NOT_AUTHORIZED' : 'COMPANION_REPLY_GUARD_DENIED'), result?.error || '本次模型调用未获授权。', result?.hint || '检查Host权限后重新发起。');
    };
    let iterator, usage = null, text = '', finishReason = '', failed = false, onUsage, pendingFlight = null, cleanupTask;
    const remember = value => { if (value?.usage) { usage = value.usage; onUsage?.(usage); } };
    const flight = pending => {
      const current = Promise.resolve(pending).then(step => { remember(step?.value); return step; }, error => { remember(error); throw error; }).finally(() => { if (pendingFlight === current) pendingFlight = null; });
      pendingFlight = current; void current.catch(() => {}); return current;
    };
    const cleanupInvocation = () => cleanupTask ??= (async () => {
      local.abort();
      const cleanupDeadline = Date.now() + 100;
      const wait = pending => bounded(() => pending, { timeoutMs: Math.max(1, cleanupDeadline - Date.now()) });
      if (pendingFlight) {
        try { await wait(pendingFlight); } catch {}
        if (pendingFlight) return;
      }
      try {
        for (let step = 0; iterator && step < 4 && Date.now() < cleanupDeadline; step++) {
          const next = await wait(flight(step === 0 ? iterator.return?.() : iterator.next()));
          if (next?.done !== false) break;
        }
      } catch (error) { try { remember(error); } catch {} }
    })();
    try {
      check(); await guard();
      const ready = await readiness({ signal: local.signal }); check(); await guard();
      if (!ready.ok) throw issue(ready.code, ready.error, ready.hint);
      if (!admitted) {
        const gate = await bounded(() => tokenBudget?.block?.('other'), { signal: local.signal }); check(); await guard();
        if (!gate || gate.blocked !== false || !tokenBudget?.recordExternalUsage) throw issue('COMPANION_TOKEN_BLOCKED', '总额度检查未通过。', '检查 SurfCore 的其他渠道及总额度后再开始。');
      }
      const content = [{ type: 'text', text: prompt }];
      if (Array.isArray(images)) {
        if (!images.length || images.length > 3) throw issue('COMPANION_IMAGES_REQUIRED', '本次活动缺少有效的稀疏关键帧。', '检查媒体作业后重新发起。');
        const inputs = images.map((frame, index) => {
          const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(frame.dataUrl));
          if (!match || match[1].length > 700000) throw issue('COMPANION_IMAGE_INVALID', '关键帧格式或大小不符合要求。', '检查媒体作业后重新生成关键帧。');
          return { data: Buffer.from(match[1], 'base64'), mediaType: 'image/jpeg', name: `douyin-frame-${index + 1}.jpg` };
        });
        const refs = await bounded(() => attachments.saveImages(inputs), { signal: local.signal }); check(); await guard();
        if (!Array.isArray(refs) || refs.length !== inputs.length || refs.some(ref => ref === null || ref === undefined)) throw issue('COMPANION_IMAGE_INVALID', '附件服务未返回每张实际关键帧的完整引用。', '检查附件保存结果后重新发起，不会以缺图请求继续。');
        for (let i = 0; i < refs.length; i++) {
          content.push({ type: 'text', text: `稀疏画面 ${i + 1}，视频时刻 ${images[i].atMs}ms；只代表该取样时刻。` });
          content.push({ type: 'image', attachment: refs[i] });
        }
      }
      check(); await guard();
      const config = { ...route, maxTokens: Math.min(8192, Math.max(1, Math.trunc(Number(maxTokens) || 8192))), reasoningEffort: 'low' };
      let prepared;
      if (admitted) {
        prepared = await bounded(() => llm.prepareCall(config, local.signal), { signal: local.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
        check(); await guard();
        const actual = deriveMemoryProviderRouteId(prepared?.config ?? {});
        if (!Object.isFrozen(prepared?.config) || typeof prepared?.stream !== 'function' || !actual.ok || prepared.config.provider !== route.provider || prepared.config.model !== route.model || actual.providerRouteId !== requestMetadata.providerRouteId || prepared.config.model !== requestMetadata.model) {
          throw issue('COMPANION_ROUTE_MISMATCH', '实际准备的固定模型与原始授权路由不一致。', '核对可信provider/model并以新的授权上下文重新发起；不会修改旧grant或切换模型。');
        }
      }
      const options = { ...(prepared?.config ?? config), system, messages: [{ role: 'user', content }], signal: local.signal };
      const consume = async () => {
        let firstNext;
        if (admitted) {
          let open = true, dispatches = 0, box;
          const dispatch = () => {
            if (!open || ++dispatches !== 1) throw issue('MODEL_NETWORK_REUSED', '网络准入能力已经使用或过期。', '查询原请求回执；不会再次发送。');
            check();
            iterator = prepared.stream(options)[Symbol.asyncIterator]();
            firstNext = flight(iterator.next());
            void firstNext.catch(() => {});
            return (box = Object.freeze({ firstNext }));
          };
          let returned;
          try { returned = await admitNetwork(dispatch, { signal: local.signal }); } finally { open = false; }
          if (dispatches !== 1 || returned !== box) throw issue('MODEL_NETWORK_DENIED', 'Host未确认这一次实际网络发起。', '检查私有Host网络准入接线；不会重发。');
        } else iterator = llm.stream(options)[Symbol.asyncIterator]();
      for (;;) {
        const next = await new Promise((resolve, reject) => {
          let settled = false;
          // Drain an already returning usage chunk before cancellation closes accounting.
          const stop = () => { cleanup(); setImmediate(() => { if (!settled) { settled = true; reject(issue('COMPANION_MODEL_CANCELLED', '模型请求已取消或超时。', '核对用量后再手动发起；不会自动重试。')); } }); };
          const cleanup = () => local.signal.removeEventListener('abort', stop);
          if (local.signal.aborted) return stop();
          local.signal.addEventListener('abort', stop, { once: true });
          const pending = firstNext; firstNext = undefined;
          Promise.resolve().then(async () => { if (pending) return pending; check(); await guard('completion'); if (admitted) check(); return flight(iterator.next()); }).then(value => {
            if (settled) return;
            settled = true; cleanup(); resolve(value);
          }, error => { if (!settled) { settled = true; cleanup(); reject(error); } }).catch(error => { if (!settled) { settled = true; cleanup(); reject(error); } });
        });
        check(); await guard('completion'); if (next.done) break;
        const chunk = next.value;
        if (chunk?.type === 'text-delta') text += String(chunk.text ?? '');
        if (text.length > 12000) throw issue('COMPANION_MODEL_OUTPUT_LIMIT', '模型输出超出保存上限。', '检查模型响应；本次用量仍计入账本。');
        if (chunk?.type === 'usage') usage = chunk.usage;
        if (chunk?.type === 'finish') finishReason = chunk.reason?.kind ?? '';
        if (['tool-call', 'tool-call-delta', 'tool-call-start'].includes(chunk?.type) || chunk?.blockType === 'tool-call' || chunk?.block?.type === 'tool-call') throw issue('COMPANION_TOOLS_REJECTED', '本轮返回了不允许的工具调用。', '检查模型配置；活动只生成日记与草稿。');
      }
      if (finishReason !== 'stop' || !usage) throw issue('COMPANION_MODEL_INCOMPLETE', '模型未正常结束或缺少用量回执。', '查看模型连接和用量记录，不自动重试。');
      return { text, usage, finishReason };
      };
      if (!admitted) return await consume();
      const admission = createModelCallAdmission({ tokenBudget, getCharacter, authorize: async info => { await guard(info.phase); return { ok: true }; } });
      const result = await admission.run({ request: requestMetadata, signal: local.signal, invoke: info => { onUsage = info.onUsage; return consume().catch(async error => { try { remember(error); } finally { await cleanupInvocation(); } throw error; }); } });
      if (!result.ok) throw Object.assign(new Error(result.error), result);
      if (result.invoked !== true) throw issue('COMPANION_REQUEST_REUSED', '该请求已经处理或状态未知，未再次发送。', '查询原请求回执；不会自动重试或生成替代请求编号。');
      return { ...result.value, admissionReceipt: result.receipt };
    } catch (error) {
      failed = true;
      throw /^(?:COMPANION|DOUYIN|MEMORY|MODEL|CHARACTER)_/.test(error?.code ?? '') ? error : issue('COMPANION_MODEL_FAILED', 'WorkBuddy HY3 请求未完成。', '检查 Magpie 路由与上游尝试账本后再手动发起。');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failed) { local.abort(); if (!admitted) { try { const returned = iterator?.return?.(); if (returned?.catch) void returned.catch(() => {}); } catch {} } }
      if (usage && !admitted) {
        let recorded = false;
        try { recorded = await bounded(() => tokenBudget.recordExternalUsage({ category: 'other', sessionId: 'douyin-companion', model: route.model, usage, label: '抖音陪伴观察', durable: true }), { timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())) }); } catch {}
        if (recorded !== true) throw issue('COMPANION_USAGE_PERSIST_FAILED', '本次模型用量未确认入账。', '核对 Magpie 与 SurfCore 额度，恢复记账后再手动操作。');
      }
    }
  }
  async function request(options) {
    if (!options.requestMetadata) return streamRequest(options);
    if (typeof getCharacter !== 'function' || typeof options.beforeSend !== 'function') throw issue('COMPANION_ADMISSION_REQUIRED', '受控模型调用缺少可信角色或实际输入校验。', '接入Host角色读取与beforeSend后重新发起。');
    if (typeof options.admitNetwork !== 'function') throw issue('MODEL_NETWORK_UNSUPPORTED', '缺少私有Host串行网络准入接口。', '接入原始记忆句柄的withNetworkAdmission；不会回退普通stream。');
    if (typeof services().llm?.prepareCall !== 'function') throw issue('MODEL_PREPARE_UNSUPPORTED', 'Host没有提供公开固定注册的prepareCall能力。', '先核验安装的Host能力；V2不会回退普通stream。');
    let metadata;
    try { metadata = Object.freeze(structuredClone(options.requestMetadata)); } catch { throw issue('MODEL_REQUEST_INVALID', '可信预算元数据不能复制。', '提供稳定的逐步请求元数据。'); }
    const expected = deriveMemoryProviderRouteId(route);
    if (!expected.ok || metadata.providerRouteId !== expected.providerRouteId || metadata.model !== route.model) throw issue('COMPANION_ROUTE_MISMATCH', '预算请求与固定provider/model授权不一致。', '按可信实际路由提供请求元数据；不会更新旧授权。');
    return streamRequest({ ...options, admitted: true, requestMetadata: metadata });
  }

  async function call({ images, ...options } = {}) {
    if (!Array.isArray(images) || !images.length || images.length > 3) throw issue('COMPANION_IMAGES_REQUIRED', '本次活动缺少有效的稀疏关键帧。', '检查媒体作业后重新发起。');
    return request({ ...options, images });
  }
  async function reply({ images, beforeSend = null, maxTokens = 8192, timeoutMs = 180_000, ...options } = {}) {
    if (images !== undefined && images !== null) throw issue('COMPANION_REPLY_IMAGES_FORBIDDEN', '文字回复不接收图片。', '使用本机对话文字继续；图像点评仍通过已验收的活动生成。');
    if (beforeSend !== null && typeof beforeSend !== 'function') throw issue('COMPANION_REPLY_GUARD_INVALID', '回复角色校验配置无效。', '检查本机分享服务接线后再手动重试。');
    return request({ ...options, beforeSend, maxTokens: Math.min(8192, Math.max(1, Math.trunc(Number(maxTokens) || 8192))), timeoutMs: Math.min(180_000, Math.max(100, Number(timeoutMs) || 180_000)) });
  }
  return { readiness, call, reply };
}
