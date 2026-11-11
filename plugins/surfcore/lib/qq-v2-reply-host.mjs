import fs from 'node:fs';
import { characterPaths } from '../../../src/character-persona.js';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { loadMemoryV2NativeEnvironment } from './memory-v2-native-environment.mjs';
import { createQQV2NativeOwner } from './qq-v2-native-owner.mjs';
import { createQQV2SourceRuntime } from './qq-v2-source-runtime.mjs';

const fail = (code, hint) => ({ ok: false, code, error: 'QQ Native 回复未完成。', hint });
const checked = value => { if (!value?.ok) throw Object.assign(new Error(value?.error || 'QQ reply refused'), value || fail('MEMORY_QQ_REPLY_FAILED', '检查宿主与原操作回执。')); return value; };
export async function resolveQQV2ModelRoute(ctx, state = {}) {
  const select = () => state?.route ?? ctx.get('agentDefaultModel')?.currentSelection?.();
  const selected = select(), derived = checked(deriveMemoryProviderRouteId(selected));
  const llm = ctx.get('llm');
  if (typeof llm?.resolveModelInfo !== 'function') throw Object.assign(new Error('Model resolver unavailable'), fail('MEMORY_PROVIDER_ROUTE_REQUIRED', '在宿主选择可用的精确模型。'));
  const info = await llm.resolveModelInfo(selected.provider, selected.model);
  const current = select();
  if (current?.provider !== selected.provider || current?.model !== selected.model || info?.provider !== selected.provider || info?.id !== selected.model) throw Object.assign(new Error('Model selection changed'), fail('MEMORY_PROVIDER_ROUTE_MISMATCH', '模型已变化或不可用；重新核对并批准当前精确模型。'));
  return { provider: selected.provider, model: selected.model, providerRouteId: derived.providerRouteId };
}

/** One private Native Owner per reply; no general Host tools or old DSH history. */
export function createQQV2ReplyHost({ ctx, memoryV2, tokenBudget, getCharacter, getQQIdentity, callBridge, onBlocked = () => {}, resourcesPath = process.resourcesPath,
  loadEnvironment = loadMemoryV2NativeEnvironment, createOwner = createQQV2NativeOwner, createSource = createQQV2SourceRuntime,
  readPersona = role => fs.readFileSync(characterPaths(role.id).persona, 'utf8'), timeoutMs = 180000 } = {}) {
  if (!ctx || !memoryV2?.adapter || typeof getCharacter !== 'function' || typeof getQQIdentity !== 'function' || typeof callBridge !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new TypeError('QQ reply Host dependencies are required.');
  const pending = new Map(), receipts = new Map();
  let closed = false, transition = null, generation = 0;
  function report(error) {
    const result = fail(/^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'MEMORY_QQ_REPLY_FAILED', error?.hint || '在概览检查当前连接、角色和记忆权限，再发送一条新消息。');
    try { onBlocked(result); } catch {}
    return result;
  }
  async function run(req, state) {
    const ticket = generation, role = { id: req.characterId, epoch: req.characterEpoch };
    let owner, source, job, timer, agentError, finished = false, completion = false;
    const blocks = new Map();
    const live = () => {
      const current = getCharacter();
      if (closed || transition || state.cancelled || ticket !== generation || current?.id !== role.id || current?.epoch !== role.epoch || memoryV2.getRouting?.().backend !== 'v2') throw Object.assign(new Error('QQ job retired'), fail('CHARACTER_EPOCH_STALE', '原作业已退役；用当前角色发送一条新消息。'));
    };
    const rpc = async (action, extra = {}) => {
      const response = await callBridge('/api/memory-v2/native', { method: 'POST', body: { ...req, action, ...extra }, timeoutMs: 25000 });
      return checked(response?.ok && response.status < 400 ? response.data : response?.data?.ok === false ? response.data : fail('MEMORY_QQ_RPC_FAILED', '恢复本机 QQ 桥接；发送结果未知时先核对原回执。'));
    };
    const identity = async () => {
      live(); const result = checked(await getQQIdentity()); live();
      if (!result.verified) throw Object.assign(new Error('QQ unverified'), fail('MEMORY_QQ_IDENTITY_UNVERIFIED', '恢复 QQ 登录后重试。'));
      const route = await resolveQQV2ModelRoute(ctx, result); live();
      return { ...result, route };
    };
    try {
      const account = await identity(), persona = readPersona(role);
      if (typeof persona !== 'string' || !persona.trim() || Buffer.byteLength(persona) > 65536) throw Object.assign(new Error('Invalid persona'), fail('MEMORY_QQ_PERSONA_INVALID', '恢复当前角色的人格卡后重试。'));
      const env = await loadEnvironment({ ctx, resourcesPath }); live();
      const bridge = {
        exportNativeSources: () => rpc('sources'),
        authorizeSend: input => rpc('authorize', { loginAccountId: input.loginAccountId }),
        recordSent: (lease, data) => rpc('record', { lease, ...data }),
        retire: () => rpc('retire'),
      };
      source = createSource({ bridge, adapter: memoryV2.adapter, getCharacter, getQQIdentity: identity, corePersona: persona, nativeCodec: env.nativeCodec,
        validateOwnedToolContext: execution => owner?.validateOwnedToolContext(execution) ?? fail('MEMORY_NATIVE_TOOL_UNPROVEN', '等待 Native Owner 就绪。') });
      const captureModelOutput = async args => {
        const result = await source.captureModelOutput(args);
        if (!result.ok) return result;
        if (args.phase === 'chunk') {
          const c = args.chunk;
          if (c?.type === 'block-end' && c.block?.type === 'text') blocks.set(c.index, c.block.text);
          if (c?.type === 'finish') finished = c.reason?.kind === 'stop';
        }
        if (args.phase === 'complete') completion = finished;
        return result;
      };
      owner = await createOwner({ nativeModules: env.nativeModules, llm: env.llm, getLlmHookContext: env.getLlmHookContext,
        corePersona: persona, tools: [], tokenBudget, getCharacter, provider: account.route.provider, model: account.route.model,
        estimatedTokens: Buffer.byteLength(persona) + 32768 + 8192, sourceAuthority: { ...source, captureModelOutput }, onAgentError: error => { agentError = error; } });
      state.owner = owner; live();
      job = { jobId: owner.sessionId, sessionId: owner.sessionId, requestId: req.requestId, characterId: role.id, characterEpoch: role.epoch, providerRouteId: account.route.providerRouteId };
      const prepared = checked(await source.prepareReplyPrompt({ key: req.key, job })); live();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('QQ timeout'), fail('MEMORY_QQ_TIMEOUT', '本次回复超时；先检查宿主原回执，不自动重试。'))), timeoutMs); });
      owner.followup(env.nativeCodec.createUserMessage({ source: { kind: 'user-rpc', requestId: req.requestId }, content: prepared.content }));
      await Promise.race([owner.whenIdle(), deadline]); clearTimeout(timer); live();
      if (agentError) throw Object.assign(new Error('QQ inference failed'), agentError);
      const output = [...blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('');
      if (!completion || !output.trim() || output.length > 12000) throw Object.assign(new Error('Incomplete QQ output'), fail('MEMORY_QQ_OUTPUT_UNPROVEN', '模型没有返回完整且有界的回复；本次没有发送。'));
      const authorized = checked(await source.prepareSend({ job, key: req.key, loginAccountId: account.accountId })); live();
      const delivered = await rpc('send', { lease: authorized.lease, text: output });
      if (delivered.deliveryState !== 'delivered' || delivered.messageId == null) throw Object.assign(new Error('Unknown QQ delivery'), fail('MEMORY_QQ_DELIVERY_UNKNOWN', '检查原消息是否送达；不会自动重发。'));
      checked(await source.recordSent({ job, lease: authorized.lease, text: output, messageId: delivered.messageId, deliveryState: delivered.deliveryState }));
      state.result = { ok: true, delivered: true, requestId: req.requestId };
    } catch (error) { state.result = report(error); }
    finally {
      clearTimeout(timer);
      try { if (owner) await owner.retire(); } catch (error) { state.result = report(error); state.cleanupFailed = true; }
      try { if (source && job) checked(await source.retireJob({ job, reason: 'complete' })); } catch (error) { state.result = report(error); state.cleanupFailed = true; }
      try { await rpc('complete', state.result?.ok ? { ok: true } : { ...state.result, ok: false }); } catch (error) { state.result = report(error); }
      if (!state.cleanupFailed) pending.delete(req.key);
    }
  }
  function submit(request) {
    if (closed || transition) return fail('MEMORY_QQ_HOST_UNAVAILABLE', '等待宿主完成退役后再发送新消息。');
    const current = getCharacter();
    if (!request || !/^(group|private):[1-9][0-9]{0,19}$/.test(request.key ?? '') || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(request.requestId ?? '') || request.characterId !== current?.id || request.characterEpoch !== current?.epoch) return fail('CHARACTER_EPOCH_STALE', '该请求不属于当前角色或有效的 QQ 会话。');
    const prior = receipts.get(request.requestId);
    if (prior) return JSON.stringify(prior.request) === JSON.stringify(request) ? prior.accepted : fail('MEMORY_QQ_REQUEST_REUSE', '该请求编号已属于另一作业。');
    if (pending.has(request.key) || pending.size >= 16) return fail('MEMORY_QQ_BUSY', '等待原回复结束，不要重复提交。');
    // Never evict a processed ID and then execute it again in this Host lifetime.
    if (receipts.size >= 4096) return fail('MEMORY_QQ_RECEIPTS_FULL', '本机作业回执已达上限；核对待处理作业后重启宿主。');
    const req = Object.freeze({ ...request }), accepted = { ok: true, accepted: true, requestId: req.requestId }, state = { request: req, accepted };
    receipts.set(req.requestId, state); pending.set(req.key, state);
    state.promise = run(req, state);
    return accepted;
  }
  async function retire() {
    if (transition) return transition;
    generation++;
    const states = [...pending.values()];
    states.forEach(state => { state.cancelled = true; });
    transition = (async () => {
      await Promise.all(states.map(async state => { if (state.owner) await state.owner.retire(); }));
      await Promise.all(states.map(state => state.promise));
      if (states.some(state => state.cleanupFailed)) return fail('MEMORY_QQ_RETIRE_FAILED', 'Native 资源退役尚未确认；暂不复用，检查宿主诊断。');
      return { ok: true };
    })();
    try { return await transition; } finally { transition = null; }
  }
  return Object.freeze({ submit, retire, async close() { closed = true; return retire(); }, async whenIdle() { await Promise.all([...pending.values()].map(state => state.promise)); }, getReceipt(id) { return receipts.get(id)?.result ?? null; } });
}
