import { createMemoryService } from '../../../src/core/memory-v2-service.js';
import { readMemoryRouting, writeMemoryRouting, deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { digest } from '../../../src/core/memory-v2-contract.js';
import { createMemoryHost } from './memory-v2-host.mjs';
import { createMemoryApiService } from './memory-v2-api.mjs';
import { resolveQQMemoryIdentity } from './memory-v2-identity.mjs';
import { createMemoryManagementController } from './memory-v2-management.mjs';
import { COMPANION_ROUTE } from './douyin-companion-model.mjs';
import { deriveBiliV2PublicSourceSet } from './bili-v2-public-source-set.mjs';

const failure = (code, error, hint = '在记忆页核对当前角色、权限和原操作回执；不要切回旧历史绕过失败。') => ({ ok: false, code, error, hint });
const stable = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value);
const sameRole = (a, b) => a?.id === b?.id && a?.epoch === b?.epoch;
const routeId = route => deriveMemoryProviderRouteId(route).providerRouteId;

/** Host-owned composition. None of the returned capabilities belong in a model tool registry. */
export function createMemoryV2Runtime({ stateDir, charactersDir, getCharacter, currentDshUrl,
  getManagementAuthorization = () => false, getQQState = () => null, getQQRoute = () => null,
  getPlatformState = () => null, retireForLifecycle, lifecycleInventory, onControlChanged = () => {},
  onBlocked = () => null, onQQReply, organizer, migrator, now = Date.now } = {}) {
  const adminAuthorization = Symbol('memory settings owner'), producerAuthorization = Symbol('official QQ producer');
  let initialized = false, closed = false, initialization, diagnostic = null;
  const role = () => {
    const current = getCharacter();
    if (!current || current.then || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(current.id ?? '') || !Number.isSafeInteger(current.epoch) || current.epoch < 1) throw Object.assign(new Error('当前角色尚未就绪。'), failure('CHARACTER_CONTEXT_REQUIRED', '当前角色尚未就绪。'));
    return { id: current.id, epoch: current.epoch };
  };
  const checked = value => {
    if (value?.ok !== true) throw Object.assign(new Error(value?.error || '记忆宿主操作未完成。'), value?.ok === false ? value : failure('MEMORY_RUNTIME_FAILED', '记忆宿主操作未完成。'));
    return value;
  };
  function routing() {
    if (closed) return failure('MEMORY_RUNTIME_CLOSED', '记忆宿主已关闭。');
    return diagnostic ?? readMemoryRouting({ stateDir });
  }
  async function qqState() {
    const value = await getQQState();
    if (!value || value.verified !== true || !/^[1-9][0-9]{0,19}$/.test(value.accountId ?? '') || !Array.isArray(value.allowedGroups) || !Array.isArray(value.allowedPrivates) || [...value.allowedGroups, ...value.allowedPrivates].some(id => !/^[1-9][0-9]{0,19}$/.test(id))) return null;
    return value;
  }
  async function biliState() {
    const state = await getPlatformState('bili');
    if (state?.verified !== true || !/^[1-9][0-9]{0,29}$/.test(state.accountId ?? '') || !Array.isArray(state.targets) || state.targets.length > 32) return null;
    const providerRouteId = routeId(state.route ?? {});
    if (!providerRouteId || state.route.providerRouteId !== undefined && state.route.providerRouteId !== providerRouteId) return null;
    const conversations = new Set();
    for (const target of state.targets) {
      if (!target || typeof target !== 'object') continue;
      const exact = keys => Object.keys(target).length === keys.length && keys.every(key => Object.hasOwn(target, key));
      const id = key => typeof target[key] === 'string' && /^[0-9]{1,30}$/.test(target[key]);
      if (target.audience === 'private' && target.kind === 'dm' && exact(['audience', 'kind', 'mid']) && id('mid')) conversations.add(`bili:${state.accountId}:private:${target.mid}`);
      if (target.audience === 'public' && target.kind === 'dynamic' && exact(['audience', 'kind'])) conversations.add(`bili:${state.accountId}:public:dynamic`);
      if (target.audience === 'public' && target.kind === 'comment' && exact(['audience', 'kind', 'type', 'oid', 'root', 'parent']) && ['1', '11', '17'].includes(target.type) && ['oid', 'root', 'parent'].every(id)) conversations.add(`bili:${state.accountId}:public:${target.oid}`);
    }
    const legacyConversations = new Set(conversations), publicSourceSets = [], current = role();
    if (state.publicSourceSets !== undefined && (!Array.isArray(state.publicSourceSets) || state.publicSourceSets.length > 8)) return null;
    for (const candidate of state.publicSourceSets ?? []) {
      const derived = deriveBiliV2PublicSourceSet({ characterId: current.id, characterEpoch: current.epoch, accountMid: state.accountId, providerRouteId,
        selectors: candidate?.selectors, outputTarget: candidate?.outputTarget });
      if (!derived.ok || candidate.id !== derived.id || candidate.outputConversationKey !== derived.outputConversationKey || !Array.isArray(candidate.sourceConversations) || digest(candidate.sourceConversations) !== digest(derived.sourceConversations)) continue;
      if (publicSourceSets.some(set => set.id === derived.id)) continue;
      publicSourceSets.push(derived);
      conversations.add(derived.outputConversationKey);
      for (const source of derived.sourceConversations) conversations.add(source.conversationKey);
    }
    return { accountId: state.accountId, route: state.route, providerRouteId, conversations, legacyConversations, publicSourceSets };
  }
  async function producerAllowed(authorization, registration) {
    if (authorization !== producerAuthorization || closed) return false;
    const state = await qqState();
    if (!state) return false;
    if (registration?.kind === 'registration_receipt_lookup') return true;
    const match = /^qq:([1-9][0-9]{0,19}):(group|private):([1-9][0-9]{0,19})$/.exec(registration?.conversationKey ?? '');
    if (!match || match[1] !== state.accountId || !/^qq:[1-9][0-9]{0,19}$/.test(registration.sourceAccountKey ?? '')) return false;
    return (match[2] === 'group' ? state.allowedGroups : state.allowedPrivates).includes(match[3]);
  }
  const service = createMemoryService({ stateDir, charactersDir, getCharacter, now,
    authorizeManagement: authorization => authorization === adminAuthorization,
    authorizeProducerReplay: producerAllowed, ...(retireForLifecycle ? { retireForLifecycle } : {}),
    ...(lifecycleInventory ? { lifecycleInventory } : {}) });
  async function resolveIdentity({ channel, conversationKey, purpose, sourceFacts }) {
    const before = role();
    let result;
    if (channel === 'qq') {
      const state = await qqState(), selected = await getQQRoute(state);
      const resolved = state && resolveQQMemoryIdentity({ ...state, providerRouteId: routeId(selected ?? {}) }, sourceFacts);
      if (resolved?.channel === 'qq' && resolved.conversationKey === conversationKey) result = resolved;
    } else if (channel === 'bili') {
      const state = await biliState();
      if (state?.conversations.has(conversationKey)) {
        const account = `bili:${state.accountId}:actor:${state.accountId}`;
        result = { channel, conversationKey, sourceAccountKey: account, requesterAccountKey: account, providerRouteId: state.providerRouteId, purpose };
      }
    } else if (channel === 'local' && conversationKey === `local:companion-sharing:${before.id}`) {
      result = { channel, conversationKey, sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', providerRouteId: routeId(COMPANION_ROUTE), purpose };
    } else if (channel === 'douyin') {
      const state = await getPlatformState(channel);
      if (state?.ok === false && state.code === 'DOUYIN_BUSY') throw Object.assign(new Error('平台身份核验正忙。'), failure('MEMORY_IDENTITY_BUSY', '平台身份核验正忙。', '等待当前平台操作结束后重试。'));
      if (state?.verified === true && stable(state.accountId) && conversationKey === 'douyin:homepage-recommendation') {
        const accountKey = `douyin:${state.accountId}`;
        result = { channel, conversationKey, sourceAccountKey: accountKey, requesterAccountKey: accountKey, providerRouteId: routeId(COMPANION_ROUTE), purpose };
      }
    }
    if (!sameRole(before, role())) return null;
    return result ?? null;
  }
  const host = createMemoryHost({ memoryService: service, getCharacter, resolveIdentity, now, handleTtlMs: 300000,
    getProducerReplayAuthorization: ({ channel }) => channel === 'qq' ? producerAuthorization : null });
  const adapters = Object.fromEntries(['local', 'douyin', 'bili', 'qq'].map(channel => [channel, host.createAdapter({ channel, principal: { source: 'surfcore-host' }, canBindInput: true, ...(channel === 'qq' ? { canSubmitSourceFacts: true } : {}) })]));
  const api = createMemoryApiService({ host, stateDir, currentDshUrl, onQQReply,
    scopes: [{ id: 'qq', channel: 'qq', principal: { source: 'surfcore-qq-bridge' }, canBindInput: true, canSubmitSourceFacts: true }] });
  const adminRunner = Object.freeze({
    preview: ({ context, action, payload, expectedRevision }) => service.host.admin?.preview(context, { action, payload }, expectedRevision) ?? failure('MEMORY_ADMIN_UNSUPPORTED', '角色记忆管理模块尚未就绪。'),
    commit: ({ context, action, payload, expectedRevision, previewDigest, operationId }) => service.host.admin?.commit(context, { action, payload, previewDigest }, expectedRevision, operationId) ?? failure('MEMORY_ADMIN_UNSUPPORTED', '角色记忆管理模块尚未就绪。'),
    receipt: ({ context, operationId }) => service.getMemoryReceipt(context, operationId),
  });
  async function approvedConversations() {
    const before = role(), result = [];
    const add = (id, label, channel, conversationKey, requester, route, extraAudiences = [], sourceSetPreview) => {
      const providerRouteId = routeId(route ?? {});
      if (!providerRouteId) return;
      const policy = { policyId: `policy-${digest({ characterId: before.id, id, conversationKey, requester, providerRouteId, extraAudiences }).slice(0, 32)}`, approved: true,
        audiences: [[channel, conversationKey, requester], ...extraAudiences], processingGrants: [{ grantId: 'approved-route', providerRouteId }] };
      result.push({ id, label, ...(sourceSetPreview ? { sourceSetPreview } : {}), processorScopes: [{ id: 'exact-model', label: sourceSetPreview ? '仅此来源集合与所示精确模型' : '仅此会话与所示精确模型', policy }] });
    };
    const local = `local:companion-sharing:${before.id}`;
    add('local-sharing', '本机伙伴对话', 'local', local, 'local:owner', COMPANION_ROUTE);
    const state = await qqState(), selected = await getQQRoute(state);
    if (state) {
      for (const id of state.allowedGroups) add(`qq-group-${id}`, `QQ群 ${id}`, 'qq', `qq:${state.accountId}:group:${id}`, '*', selected);
      for (const id of state.allowedPrivates) add(`qq-private-${id}`, `QQ私聊 ${id}`, 'qq', `qq:${state.accountId}:private:${id}`, `qq:${id}`, selected);
    }
    const bili = await biliState();
    if (bili) {
      const account = `bili:${bili.accountId}:actor:${bili.accountId}`;
      for (const conversationKey of bili.legacyConversations) add(`bili-${digest(conversationKey).slice(0, 24)}`, `B站 ${conversationKey.includes(':private:') ? '私信' : '公开来源'} ${conversationKey.split(':').at(-1)}`, 'bili', conversationKey, account, bili.route);
      for (const set of bili.publicSourceSets) add(`bili-public-set-${set.id}`, set.label, 'bili', set.outputConversationKey, account, bili.route,
        set.sourceConversations.map(source => ['bili', source.conversationKey, account]),
        { id: set.id, characterId: before.id, characterEpoch: before.epoch, accountMid: bili.accountId, providerRouteId: bili.providerRouteId,
          provider: bili.route.provider, model: bili.route.model, selectors: set.selectors, outputTarget: set.outputTarget });
    }
    const douyin = await getPlatformState('douyin');
    if (douyin?.verified === true && stable(douyin.accountId)) {
      const account = `douyin:${douyin.accountId}`;
      add('douyin-private', '抖音处理经历', 'douyin', 'douyin:homepage-recommendation', account, COMPANION_ROUTE);
      add('douyin-local-sharing', '抖音经历与本机伙伴对话共享', 'douyin', 'douyin:homepage-recommendation', account, COMPANION_ROUTE, [['local', local, 'local:owner']]);
    }
    if (!sameRole(before, role())) throw Object.assign(new Error('角色已变化。'), failure('CHARACTER_EPOCH_STALE', '角色已变化。'));
    return result;
  }
  const manager = createMemoryManagementController({ memoryService: service, getCharacter, now,
    getAuthorization: req => getManagementAuthorization(req) === true ? adminAuthorization : null,
    getRuntimeStatus: async ({ context }) => {
      const route = checked(routing());
      const current = service.host.admin ? checked(await service.host.admin.status(context)) : {};
      return { ...current, characterId: context.characterId, backend: route.backend,
        policies: (current.policies ?? []).map(row => ({ id: row.policyId, label: row.approved ? '已批准' : '已撤销' })),
        backups: (current.backups ?? []).map(row => ({ id: row.backupId, verified: row.state === 'verified' })),
        approvedConversations: await approvedConversations() };
    },
    inspectMemory: async ({ context, ...options }) => {
      if (!service.host.admin) return failure('MEMORY_INSPECTION_UNSUPPORTED', '角色来源检视尚未就绪。');
      const inspected = await service.host.admin.inspect(context, options);
      return inspected?.ok && options.recordId ? { ...inspected, record: inspected.records?.[0] } : inspected;
    },
    identityManager: adminRunner, corrector: adminRunner, hotManager: adminRunner, organizer, migrator,
    adminResumer: typeof service.host.admin?.resume === 'function' ? { resume: ({ context, ...request }) => service.host.admin.resume(context, request) } : null,
    onControlChanged: async information => {
      const status = checked(await service.getStatus());
      const published = writeMemoryRouting({ stateDir, status });
      if (!published.ok) { diagnostic = published; throw Object.assign(new Error(published.error), published); }
      await onControlChanged(information);
    },
  });
  async function initialize() {
    if (closed) return failure('MEMORY_RUNTIME_CLOSED', '记忆宿主已关闭。');
    if (initialized) return { ok: true };
    if (initialization) return initialization;
    initialization = (async () => {
      const before = readMemoryRouting({ stateDir });
      if (!before.ok) return (diagnostic = before);
      const result = await service.initialize();
      if (!result.ok) return (diagnostic = result);
      const status = await service.getStatus();
      const published = writeMemoryRouting({ stateDir, status });
      if (!published.ok) return (diagnostic = published);
      const discovered = api.writeHostFiles();
      if (!discovered.ok) return (diagnostic = discovered);
      diagnostic = null; initialized = true; return { ok: true, backend: status.activeBackend };
    })();
    try { return await initialization; } finally { initialization = null; }
  }
  function channelMemory(channel) {
    const adapter = adapters[channel];
    if (!adapter) throw new TypeError('Unsupported private memory channel.');
    return Object.freeze({ adapter, getRouting: routing, onBlocked });
  }
  function modelRequest({ jobId, step, characterId, characterEpoch, providerRouteId, model, system, prompt, images = [] }) {
    const expected = routeId(COMPANION_ROUTE);
    if (!sameRole({ id: characterId, epoch: characterEpoch }, role()) || providerRouteId !== expected || model !== COMPANION_ROUTE.model || !stable(jobId)) throw Object.assign(new Error('逐步请求与当前角色或精确模型不一致。'), failure('COMPANION_ROUTE_MISMATCH', '逐步请求与当前角色或精确模型不一致。'));
    const estimatedTokens = Buffer.byteLength(String(system) + String(prompt), 'utf8') + 8192 + images.length * 4096;
    return Object.freeze({ requestId: step === 'reply' ? jobId : `${jobId}:step:${step}`, jobId, category: 'other', purpose: 'conversation', role: characterId, epoch: characterEpoch, providerRouteId, model, estimatedTokens });
  }
  async function close() { closed = true; api.close(); manager.dispose(); host.close(); await service.close(); }
  async function handleApi(req, res, url) {
    if (url.pathname !== api.prefix) return false;
    await api.handle(req, res, url); return true;
  }
  async function handleManagement(req, res, url) {
    if (!url.pathname.startsWith('/dsh-surfcore/api/memory-v2/')) return false;
    await manager.handle(req, res, url); return true;
  }
  return Object.freeze({ initialize, close, routing, channelMemory, modelRequest, handleApi, handleManagement,
    apiPrefix: api.prefix, service, host, approvedConversations });
}
