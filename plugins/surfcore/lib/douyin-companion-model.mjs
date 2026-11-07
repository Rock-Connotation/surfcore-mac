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

export function createCompanionModel({ ctx, tokenBudget, route = COMPANION_ROUTE } = {}) {
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
  async function request({ system, prompt, images = null, signal, beforeSend = null, maxTokens = 8192, timeoutMs = 180000 }) {
    if (String(system).length + String(prompt).length > 24000) throw issue('COMPANION_INPUT_TOO_LARGE', '本次材料超过输入长度上限。', '选择更短视频或检查异常转写；不会截断后宣称完整理解。');
    const { llm, attachments } = services();
    const local = new AbortController(), abort = () => local.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const duration = Math.min(180000, Math.max(100, timeoutMs)), deadline = Date.now() + duration;
    const timer = setTimeout(abort, duration);
    const check = () => { if (local.signal.aborted) throw issue('COMPANION_MODEL_CANCELLED', '模型请求已取消或超时。', '查看已有用量和活动状态；不会自动重试。'); };
    const guard = () => {
      if (typeof beforeSend !== 'function') return;
      const result = beforeSend();
      if (result && typeof result.then === 'function') throw issue('COMPANION_REPLY_GUARD_INVALID', '回复角色校验必须同步完成。', '检查本机分享服务接线后再手动重试。');
    };
    let iterator, usage = null, text = '', finishReason = '', failed = false;
    try {
      check(); guard();
      const ready = await readiness({ signal: local.signal }); check(); guard();
      if (!ready.ok) throw issue(ready.code, ready.error, ready.hint);
      const gate = await bounded(() => tokenBudget?.block?.('other'), { signal: local.signal }); check(); guard();
      if (!gate || gate.blocked !== false || !tokenBudget?.recordExternalUsage) throw issue('COMPANION_TOKEN_BLOCKED', '总额度检查未通过。', '检查 SurfCore 的其他渠道及总额度后再开始。');
      const content = [{ type: 'text', text: prompt }];
      if (Array.isArray(images)) {
        if (!images.length || images.length > 3) throw issue('COMPANION_IMAGES_REQUIRED', '本次活动缺少有效的稀疏关键帧。', '检查媒体作业后重新发起。');
        const inputs = images.map((frame, index) => {
          const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(frame.dataUrl));
          if (!match || match[1].length > 700000) throw issue('COMPANION_IMAGE_INVALID', '关键帧格式或大小不符合要求。', '检查媒体作业后重新生成关键帧。');
          return { data: Buffer.from(match[1], 'base64'), mediaType: 'image/jpeg', name: `douyin-frame-${index + 1}.jpg` };
        });
        const refs = await bounded(() => attachments.saveImages(inputs), { signal: local.signal }); check(); guard();
        for (let i = 0; i < refs.length; i++) {
          content.push({ type: 'text', text: `稀疏画面 ${i + 1}，视频时刻 ${images[i].atMs}ms；只代表该取样时刻。` });
          content.push({ type: 'image', attachment: refs[i] });
        }
      }
      check(); guard();
      iterator = llm.stream({ ...route, system, messages: [{ role: 'user', content }], maxTokens: Math.min(8192, Math.max(1, Math.trunc(Number(maxTokens) || 8192))), reasoningEffort: 'low', signal: local.signal })[Symbol.asyncIterator]();
      for (;;) {
        const next = await new Promise((resolve, reject) => {
          const stop = () => { cleanup(); reject(issue('COMPANION_MODEL_CANCELLED', '模型请求已取消或超时。', '核对用量后再手动发起；不会自动重试。')); };
          const cleanup = () => local.signal.removeEventListener('abort', stop);
          if (local.signal.aborted) return stop();
          local.signal.addEventListener('abort', stop, { once: true });
          Promise.resolve().then(() => { check(); guard(); return iterator.next(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        });
        if (!next.done && next.value?.type === 'usage') usage = next.value.usage;
        check(); guard(); if (next.done) break;
        const chunk = next.value;
        if (chunk?.type === 'text-delta') text += String(chunk.text ?? '');
        if (text.length > 12000) throw issue('COMPANION_MODEL_OUTPUT_LIMIT', '模型输出超出保存上限。', '检查模型响应；本次用量仍计入账本。');
        if (chunk?.type === 'usage') usage = chunk.usage;
        if (chunk?.type === 'finish') finishReason = chunk.reason?.kind ?? '';
        if (['tool-call', 'tool-call-delta', 'tool-call-start'].includes(chunk?.type) || chunk?.blockType === 'tool-call' || chunk?.block?.type === 'tool-call') throw issue('COMPANION_TOOLS_REJECTED', '本轮返回了不允许的工具调用。', '检查模型配置；活动只生成日记与草稿。');
      }
      if (finishReason !== 'stop' || !usage) throw issue('COMPANION_MODEL_INCOMPLETE', '模型未正常结束或缺少用量回执。', '查看模型连接和用量记录，不自动重试。');
      return { text, usage, finishReason };
    } catch (error) {
      failed = true;
      throw /^(?:COMPANION|DOUYIN)_/.test(error?.code ?? '') ? error : issue('COMPANION_MODEL_FAILED', 'WorkBuddy HY3 请求未完成。', '检查 Magpie 路由与上游尝试账本后再手动发起。');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failed) { local.abort(); try { const returned = iterator?.return?.(); if (returned?.catch) void returned.catch(() => {}); } catch {} }
      if (usage) {
        let recorded = false;
        try { recorded = await bounded(() => tokenBudget.recordExternalUsage({ category: 'other', sessionId: 'douyin-companion', model: route.model, usage, label: '抖音陪伴观察', durable: true }), { timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())) }); } catch {}
        if (recorded !== true) throw issue('COMPANION_USAGE_PERSIST_FAILED', '本次模型用量未确认入账。', '核对 Magpie 与 SurfCore 额度，恢复记账后再手动操作。');
      }
    }
  }
  async function call({ images, beforeSend: _ignored, ...options } = {}) {
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
