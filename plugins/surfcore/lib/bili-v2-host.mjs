import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileV2Persona } from '../../../src/core/persona-v2-compile.js';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { createBiliV2AgentRuntime, biliV2InputDigest } from './bili-v2-agent.mjs';
import { createBiliV2OfficialTransport } from './bili-v2-official-transport.mjs';
import { createBiliV2SourceRuntime } from './bili-v2-source-runtime.mjs';
import { projectBiliV2Trigger } from './bili-v2-triggers.mjs';
import { deriveBiliV2PublicSourceSet } from './bili-v2-public-source-set.mjs';
import { loadMemoryV2NativeEnvironment } from './memory-v2-native-environment.mjs';
import { createIsolatedNativeRoot } from './memory-v2-native-root.mjs';

const issue = (code, hint) => Object.assign(new Error('Bili V2 Host refused the operation.'), { ok: false, code, error: 'Bili V2 Host refused the operation.', hint });
const checked = value => { if (value?.ok !== true) throw issue(value?.code ?? 'BILI_V2_UNSUPPORTED', value?.hint ?? 'Restore the original approved Host context before retrying.'); return value; };
const sameRole = (a, b) => a.id === b.id && a.epoch === b.epoch;
const sameSelection = (a, b) => a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function createBiliV2Host({ ctx, stateDir, memoryV2, tokenBudget, getCharacter, getCredentials, getFeedCandidates, fetchImpl = globalThis.fetch, resourcesPath = process.resourcesPath, onBlocked = () => {} } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || !path.isAbsolute(stateDir ?? '') || typeof getCharacter !== 'function' || typeof getCredentials !== 'function') throw issue('BILI_V2_HOST_UNSUPPORTED', 'Connect the actual Host services and protected state directory.');
  const pending = new Map(), byJob = new Map(), bySignal = new WeakMap(), targets = new Map();
  let generation = 0, transitions = 0, closed = false, closing = false, transitioning = false, fault, lastFailure, instance, creating, retiring, probe;
  const publicSets = new Map(), preflights = new Set(), preflightHandles = new Set();
  const report = error => {
    const code = /^(BILI|MEMORY|CHARACTER)_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'BILI_V2_HOST_FAILED';
    lastFailure = { ok: false, code, error: 'Bili V2 Host refused the operation.', hint: code === 'BILI_V2_PUBLIC_SET_APPROVAL_REQUIRED' ? '打开记忆卡的「身份与权限」，核对当前角色、账号、模型和完整公开来源集合，单独预览并批准后再发起此作业。新增来源须重新批准，私信保持隔离。' : 'Inspect the current role, exact model route and original operation receipt, then start a newly approved job.' };
    try { onBlocked(lastFailure); } catch {}
    return lastFailure;
  };
  const role = () => {
    const current = getCharacter(), result = { id: current?.id, epoch: Number(current?.epoch) };
    if (typeof result.id !== 'string' || !result.id || !Number.isSafeInteger(result.epoch) || result.epoch < 1) throw issue('CHARACTER_EPOCH_STALE', 'Select a current role before capturing platform state.');
    return Object.freeze(result);
  };
  function live(ticket, capturedRole) {
    if (closed || closing) throw issue('BILI_V2_HOST_CLOSED', 'Reopen the Host before starting a new operation.');
    if (transitioning || transitions > 0 || fault || ticket !== generation) throw issue('BILI_V2_HOST_CHANGED', 'Finish the original retirement before starting a new job.');
    if (!sameRole(role(), capturedRole) || instance && !sameRole(instance.role, capturedRole)) throw issue('CHARACTER_EPOCH_STALE', 'Retire the previous role and capture the current role again.');
  }
  async function resolveRoute(ticket, capturedRole, signal) {
    live(ticket, capturedRole);
    const selector = ctx.get('agentDefaultModel'), llm = ctx.get('llm');
    if (typeof selector?.currentSelection !== 'function' || typeof llm?.resolveModelInfo !== 'function') throw issue('BILI_V2_ROUTE_UNPROVEN', 'Select an explicit actual Host model; no fallback route is permitted.');
    const selected = selector.currentSelection(), route = checked(deriveMemoryProviderRouteId(selected));
    let info;
    try { info = await llm.resolveModelInfo(selected.provider, selected.model, signal); }
    catch { throw issue('BILI_V2_ROUTE_UNPROVEN', 'Restore the exact selected provider and model before retrying.'); }
    live(ticket, capturedRole);
    if (!sameSelection(selected, selector.currentSelection())) throw issue('BILI_V2_ROUTE_CHANGED', 'Capture the newly selected route before starting a new job.');
    if (info?.provider !== selected.provider || info?.id !== selected.model) throw issue('BILI_V2_ROUTE_UNPROVEN', 'Resolve metadata for the exact selected provider and model.');
    return Object.freeze({ provider: selected.provider, model: selected.model, providerRouteId: route.providerRouteId });
  }
  function assertRoute(route) {
    const selected = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selected?.provider !== route.provider || selected?.model !== route.model) throw issue('BILI_V2_ROUTE_CHANGED', 'Capture the newly selected model route before resuming this operation.');
  }
  function accountReader() {
    return probe ??= createBiliV2OfficialTransport({ getCredentials, getScope: () => undefined, fetchImpl });
  }
  async function platformState() {
    const ticket = generation, capturedRole = role(), route = await resolveRoute(ticket, capturedRole);
    const account = checked(await accountReader().getAccount());
    live(ticket, capturedRole); assertRoute(route);
    const sets = [...publicSets.values()].filter(value => sameRole(value.role, capturedRole) && value.accountMid === account.accountMid && value.routeId === route.providerRouteId);
    return freeze({ ok: true, verified: true, accountId: account.accountMid, route, targets: [...targets.values()].map(value => structuredClone(value)), publicSourceSets: sets.map(value => structuredClone(value.set)) });
  }
  function entryFor(job) {
    const entry = byJob.get(job?.jobId);
    if (!entry || entry.job !== job || entry.controller.signal.aborted) throw issue('BILI_V2_SESSION_UNBOUND', 'Use the original live job and its private Host scope.');
    live(entry.generation, entry.role); assertRoute(entry.job);
    return entry;
  }
  function sourceRequest(request) {
    const entry = byJob.get(request.job?.jobId);
    if (!entry || biliV2InputDigest({ value: request.job }) !== biliV2InputDigest({ value: entry.job })) throw issue('BILI_V2_SESSION_UNBOUND', 'Keep the complete original private source job binding.');
    entryFor(entry.job);
    return { ...request, job: entry.job };
  }
  function releasePreflight(handle) {
    const released = memoryV2.adapter.release(handle);
    if (released !== true && released?.ok !== true) throw issue('BILI_V2_RETIRE_UNCONFIRMED', 'Retry retirement until the original preflight context is released.');
    preflightHandles.delete(handle);
  }
  async function publicGroup(input, route, ticket, capturedRole, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
    const entry = { controller };
    entry.task = Promise.resolve().then(async () => {
      live(ticket, capturedRole); assertRoute(route);
      if (controller.signal.aborted) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Start a new request with a live signal.');
      let locators;
      if (input.kind === 'debrief') {
        if (!/^BV[A-Za-z0-9]{10}$/.test(input.bv ?? '') || Object.keys(input).some(key => !['kind', 'bv'].includes(key))) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Provide one exact video BV for debrief.');
        locators = [{ kind: 'video', bvid: input.bv }];
      } else {
        if (Object.keys(input).some(key => key !== 'kind') || typeof getFeedCandidates !== 'function') throw issue('BILI_V2_SOURCE_UNPROVEN', 'Restore the Host fixed feed candidate reader.');
        locators = await getFeedCandidates({ signal: controller.signal });
      }
      live(ticket, capturedRole); assertRoute(route);
      if (controller.signal.aborted) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Start a new request with a live signal.');
      const inspected = checked(await accountReader().inspectVideos({ locators, signal: controller.signal }));
      live(ticket, capturedRole); assertRoute(route);
      if (controller.signal.aborted) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Start a new request with a live signal.');
      const set = checked(deriveBiliV2PublicSourceSet({ characterId: capturedRole.id, characterEpoch: capturedRole.epoch, accountMid: inspected.accountMid, providerRouteId: route.providerRouteId, selectors: inspected.selectors, outputTarget: { audience: 'public', kind: 'dynamic' } }));
      for (const [id, value] of publicSets) if (!sameRole(value.role, capturedRole) || value.accountMid !== inspected.accountMid || value.routeId !== route.providerRouteId) publicSets.delete(id);
      if (!publicSets.has(set.id) && publicSets.size >= 8) throw issue('BILI_V2_BUSY', 'Retire previous source-set candidates before discovering more.');
      publicSets.set(set.id, { role: capturedRole, accountMid: inspected.accountMid, routeId: route.providerRouteId, set });
      if (typeof memoryV2?.adapter?.capture !== 'function' || typeof memoryV2?.adapter?.release !== 'function') throw issue('BILI_V2_SOURCE_UNPROVEN', 'Restore the actual Memory policy preflight adapter.');
      const captured = await memoryV2.adapter.capture({ conversationKey: set.outputConversationKey });
      if (captured?.ok !== true) {
        if (captured?.code === 'MEMORY_POLICY_DENIED') throw issue('BILI_V2_PUBLIC_SET_APPROVAL_REQUIRED', 'Preview and approve this exact public source set.');
        checked(captured);
      }
      if (!captured.handle) throw issue('BILI_V2_SOURCE_UNPROVEN', 'Capture the original approved source-set output context.');
      preflightHandles.add(captured.handle);
      try { live(ticket, capturedRole); assertRoute(route); if (controller.signal.aborted) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Start a new request with a live signal.'); }
      finally { try { releasePreflight(captured.handle); } catch (error) { fault = error; throw error; } }
      return { scope: { audience: 'public', target: set.outputTarget, providerRouteId: route.providerRouteId, publicSourceSet: set }, input: { kind: 'public-source-set', items: set.selectors } };
    });
    preflights.add(entry);
    try { return await entry.task; }
    finally { preflights.delete(entry); signal?.removeEventListener('abort', abort); }
  }
  function observation(input) {
    let value;
    try { const encoded = JSON.stringify(input); if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error(); value = JSON.parse(encoded); }
    catch { throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Restore a bounded JSON scheduler observation before retrying.'); }
    return freeze({ event: 'bili-scheduler-receiver', receivedAt: new Date().toISOString(), payload: value });
  }
  async function hydrateSource(request) {
    const bound = sourceRequest(request), entry = entryFor(bound.job);
    if (!entry.observation || bound.selector?.kind !== 'trigger') return entry.official.sourceTransport.hydrate(bound);
    const identity = checked(await entry.official.getIdentity({ job: bound.job, action: 'read', target: entry.scope.target, signal: bound.signal }));
    entryFor(bound.job);
    const hydrated = entry.scope.publicSourceSet ? checked(await entry.official.sourceTransport.hydrate(bound)) : { ok: true, conversationKey: identity.conversationKey, records: [] };
    const wireDigest = biliV2InputDigest({ value: entry.observation }), objectId = biliV2InputDigest({ value: [bound.job.jobId, entry.observation] });
    const record = freeze({ sourceKey: 'bili:telemetry:' + objectId, revision: 'r-' + wireDigest.slice(0, 16), kind: 'telemetry', objectId,
      authorMid: identity.accountMid, occurredAt: entry.observation.receivedAt, audience: entry.scope.audience, target: entry.scope.target,
      coverage: 'observed-receiver', wire: entry.observation });
    entry.observationProof = freeze({ sourceKey: record.sourceKey, revision: record.revision, objectId, authorMid: record.authorMid,
      audience: record.audience, target: record.target, wireDigest });
    entryFor(bound.job);
    return { ok: true, conversationKey: hydrated.conversationKey, records: [...hydrated.records, record] };
  }
  async function revalidateSources(request) {
    const bound = sourceRequest(request), entry = entryFor(bound.job);
    if (!entry.observationProof) return entry.official.sourceTransport.revalidate(bound);
    if (!Array.isArray(bound.sources)) throw issue('BILI_SOURCE_CHANGED', 'Rehydrate the original scheduler observation.');
    const official = []; let observed = 0;
    for (const proof of bound.sources) {
      if (proof.sourceKey !== entry.observationProof.sourceKey) official.push(proof);
      else {
        observed++;
        if (biliV2InputDigest({ value: proof }) !== biliV2InputDigest({ value: entry.observationProof })) throw issue('BILI_SOURCE_CHANGED', 'Rehydrate the unchanged original scheduler observation.');
      }
    }
    if (observed !== 1) throw issue('BILI_SOURCE_CHANGED', 'Revalidate exactly one original scheduler observation proof.');
    const identity = checked(await entry.official.getIdentity({ job: bound.job, action: 'read', target: entry.scope.target, signal: bound.signal }));
    entryFor(bound.job);
    if (identity.accountMid !== entry.observationProof.authorMid) throw issue('BILI_SOURCE_IDENTITY_CHANGED', 'Restore the original official receiving account.');
    return official.length ? entry.official.sourceTransport.revalidate({ ...bound, sources: official }) : { ok: true, unchanged: true };
  }
  async function ensureInstance(ticket, capturedRole) {
    live(ticket, capturedRole);
    if (instance) return instance;
    if (creating) return creating;
    creating = (async () => {
      let root, runtime, source;
      try {
        const environment = await loadMemoryV2NativeEnvironment({ ctx, resourcesPath });
        live(ticket, capturedRole);
        // R09：与 QQ Reply Host 共用同一 V2 人格编译入口（排除〔一代〕小节与旧协议行）。
        // 原 persona 文件只读不改；这里得到的字符串同时用于 Native root 与 Source 证明。
        const compiled = compileV2Persona({ roleId: capturedRole.id, scene: 'bili', maxChars: 6000 });
        if (compiled?.ok !== true) throw issue('BILI_V2_CORE_UNPROVEN', compiled?.hint || 'Restore the current approved core persona file.');
        const corePersona = compiled.text;
        if (!corePersona || Buffer.byteLength(corePersona) > 64 * 1024) throw issue('BILI_V2_CORE_UNPROVEN', 'Restore the current approved core persona file.');
        root = await createIsolatedNativeRoot({ ...environment, corePersona, onStream: (options, next) => {
          if (!runtime?.getScope(options)) throw issue('BILI_V2_SESSION_UNBOUND', 'Wait for the retained runtime to bind this original native request.');
          return next(options);
        } });
        live(ticket, capturedRole);
        const raw = createBiliV2SourceRuntime({
          memoryV2, getCharacter, corePersona, nativeRoot: root, nativeCodec: environment.nativeCodec,
          getNativeConfig: ({ job }) => { entryFor(job); return root.getCurrentCall()?.preparedConfig; },
          getIdentity: request => { const bound = sourceRequest(request); return entryFor(bound.job).official.getIdentity(bound); },
          sourceTransport: {
            hydrate: hydrateSource,
            revalidate: revalidateSources,
          },
        });
        source = Object.freeze({ ...raw,
          preparePrompt: async args => {
            const entry = pending.get(args.job.requestId);
            if (!entry || entry.job || args.job.providerRouteId !== entry.scope.providerRouteId || biliV2InputDigest({ value: args.input }) !== entry.inputDigest || args.signal?.aborted) throw issue('BILI_V2_SESSION_UNBOUND', 'Bind only the original pending trigger to its actual frozen job.');
            live(ticket, capturedRole);
            entry.job = args.job; byJob.set(args.job.jobId, entry); bySignal.set(args.signal, entry); entry.nativeSignal = args.signal;
            entry.official = createBiliV2OfficialTransport({
              getCredentials: async () => { entryFor(entry.job); const credentials = await getCredentials(); entryFor(entry.job); return credentials; },
              fetchImpl, getScope: job => entryFor(job).scope,
            });
            return raw.preparePrompt(args);
          },
          releaseJob: async args => {
            const result = checked(await raw.releaseJob(args)), entry = byJob.get(args.job.jobId);
            if (entry) {
              entry.official.close(); byJob.delete(args.job.jobId); pending.delete(args.job.requestId);
              if (entry.nativeSignal) bySignal.delete(entry.nativeSignal);
              entry.removeCaller?.();
            }
            return result;
          },
        });
        runtime = createBiliV2AgentRuntime({
          nativeRoot: root, memoryV2, getCharacter, tokenBudget, sourceRuntime: source,
          isAgentLoopRequest: environment.nativeModules.isAgentLoopRequest,
          registryPath: path.join(stateDir, 'bili-v2-managed-sessions.json'),
          getModelRoute: () => resolveRoute(ticket, capturedRole),
          modelRequest: ({ job, options }) => {
            entryFor(job);
            const input = Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'signal'));
            return { estimatedTokens: Buffer.byteLength(JSON.stringify(input), 'utf8') + 8192 };
          },
          transport: { read: request => {
            const entry = entryFor(request.job);
            if (bySignal.get(request.signal) !== entry) throw issue('BILI_V2_SESSION_UNBOUND', 'Use the original native job and private signal for this read.');
            return entry.official.transport.read(request);
          }, send: request => {
            const entry = bySignal.get(request.signal);
            if (!entry || entryFor(entry.job) !== entry) throw issue('BILI_V2_SESSION_UNBOUND', 'Use the retained native job signal for this dispatch.');
            return entry.official.transport.send(request);
          } }, onBlocked: report,
        });
        if (!runtime.getStatus().ok) throw issue('BILI_V2_GUARD_UNAVAILABLE', 'Restore the isolated native guards before enabling this Host.');
        live(ticket, capturedRole);
        return instance = { role: capturedRole, root, runtime, source };
      } catch (error) {
        if (!root && typeof error?.retryCleanup === 'function') root = Object.freeze({ close: error.retryCleanup });
        try {
          if (runtime) await runtime.close();
          if (source && source.getStatus().jobs !== 0) throw issue('BILI_V2_RETIRE_UNCONFIRMED', 'Retry retirement of the original retained initialization.');
          source?.close();
          if (root) await root.close();
        } catch (cleanupError) {
          instance = { role: capturedRole, root, runtime, source }; fault = cleanupError;
          throw cleanupError;
        }
        throw error;
      }
    })();
    try { return await creating; } finally { creating = undefined; }
  }
  async function enqueue({ requestId, input, signal } = {}) {
    try {
      const receiver = ['night-skip', 'night-wake', 'live-notification', 'attack-review', 'ta-nudge', 'daily-nudge'].includes(input?.kind);
      if (!receiver && !['comment-notification', 'dm-notification', 'feed', 'debrief'].includes(input?.kind)) throw issue('BILI_V2_TRIGGER_UNSUPPORTED', 'Provide the supported original notification selector; summaries and retired reads are not accepted.');
      if (typeof requestId !== 'string' || !requestId || requestId.length > 200 || signal?.aborted) throw issue('BILI_V2_TRIGGER_UNPROVEN', 'Use a bounded current Host request identifier and live signal.');
      const routing = checked(memoryV2?.getRouting?.());
      if (routing.backend !== 'v2') throw issue('BILI_V2_ROUTING_CHANGED', 'This Host starts jobs only under the approved V2 route.');
      const ticket = generation, capturedRole = role(), route = await resolveRoute(ticket, capturedRole, signal);
      let projection;
      if (receiver) {
        const received = observation(input);
        const group = input.kind === 'daily-nudge' ? await publicGroup({ kind: 'feed' }, route, ticket, capturedRole, signal)
          : { scope: { audience: 'public', target: { audience: 'public', kind: 'dynamic' }, providerRouteId: route.providerRouteId }, input: { kind: 'host-receiver-event' } };
        projection = { groups: [{ ...group, observation: received }] };
      } else projection = ['feed', 'debrief'].includes(input.kind) ? { groups: [await publicGroup(input, route, ticket, capturedRole, signal)] } : checked(projectBiliV2Trigger({ input, providerRouteId: route.providerRouteId }));
      if (pending.size + projection.groups.length > 32) throw issue('BILI_V2_BUSY', 'Wait for the original jobs to retire before enqueuing another batch.');
      const active = await ensureInstance(ticket, capturedRole), results = [];
      for (const [index, group] of projection.groups.entries()) {
        live(ticket, capturedRole);
        const id = 'bili-host-' + createHash('sha256').update(JSON.stringify([requestId, index, group.scope])).digest('hex');
        if (pending.has(id)) { results.push({ ok: true, accepted: false, duplicate: true }); continue; }
        const controller = new AbortController(), entry = { generation: ticket, role: capturedRole, scope: group.scope, observation: group.observation, inputDigest: biliV2InputDigest({ value: group.input }), controller };
        if (signal) {
          const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
          entry.removeCaller = () => signal.removeEventListener('abort', abort); if (signal.aborted) abort();
        }
        pending.set(id, entry);
        if (!group.scope.publicSourceSet) {
          const key = JSON.stringify(group.scope.target); targets.delete(key); targets.set(key, group.scope.target);
          while (targets.size > 32) targets.delete(targets.keys().next().value);
        }
        let result;
        try { result = await active.runtime.enqueue({ requestId: id, input: group.input, signal: controller.signal }); }
        finally { if (!entry.job) { pending.delete(id); entry.removeCaller?.(); } }
        results.push(checked(result));
      }
      return { ok: true, accepted: results.some(result => result.accepted === true), jobs: results };
    } catch (error) { return report(error); }
  }
  async function retire() {
    if (retiring) return retiring;
    transitioning = true; generation++;
    for (const entry of pending.values()) entry.controller.abort();
    for (const entry of preflights) entry.controller.abort();
    retiring = (async () => {
      try {
        await Promise.allSettled([...preflights].map(entry => entry.task));
        for (const handle of [...preflightHandles]) releasePreflight(handle);
        if (creating) { try { await creating; } catch {} }
        if (instance) {
          await instance.runtime?.retire();
          if (instance.source && instance.source.getStatus().jobs !== 0) throw issue('BILI_V2_RETIRE_UNCONFIRMED', 'Wait for every actual job and source release acknowledgement.');
          await instance.runtime?.close(); instance.source?.close(); await instance.root?.close(); instance = undefined;
        }
        for (const entry of pending.values()) { entry.official?.close(); entry.removeCaller?.(); }
        pending.clear(); byJob.clear(); targets.clear(); publicSets.clear(); probe?.close(); probe = undefined; fault = undefined;
        return { ok: true, retired: true };
      } catch (error) { fault = error; return report(error); }
      finally { transitioning = false; }
    })();
    try { return await retiring; } finally { retiring = undefined; }
  }
  async function withTransition(operation) {
    if (typeof operation !== 'function') throw issue('BILI_V2_TRANSITION_INVALID', 'Provide the original lifecycle operation before retrying.');
    if (closed || closing) throw issue('BILI_V2_HOST_CLOSED', 'Reopen the Host before changing its lifecycle.');
    transitions++;
    try { checked(await retire()); return await operation(); }
    finally { transitions--; }
  }
  async function close() {
    if (closed) return { ok: true, closed: true };
    closing = true;
    const result = await retire();
    if (result.ok) closed = true;
    return result.ok ? { ok: true, closed: true } : result;
  }
  // F05：受控单轮的正式 V2 写回会话。只取当前 Host 已核验的公开来源集合，
  // 不新建授权、不回退旧卡；没有已批准集合时返回显式不可用。
  async function roundMemoryScope() {
    try {
      const ticket = generation, capturedRole = role(), route = await resolveRoute(ticket, capturedRole);
      const account = checked(await accountReader().getAccount());
      live(ticket, capturedRole);
      const sets = [...publicSets.values()].filter(value => sameRole(value.role, capturedRole) && value.accountMid === account.accountMid && value.routeId === route.providerRouteId);
      if (sets.length !== 1) return { ok: false, code: 'BILI_V2_ROUND_SCOPE_UNAPPROVED',
        error: '当前单轮没有唯一已核验的 B站公开来源集合。', hint: '在记忆页按当前角色、账号、精确模型与完整公开来源集合预览并批准后再发起单轮。' };
      const set = sets[0].set;
      return freeze({ ok: true, conversationKey: set.outputConversationKey, providerRouteId: route.providerRouteId,
        characterId: capturedRole.id, characterEpoch: capturedRole.epoch, accountMid: account.accountMid, publicSourceSetId: set.id,
        hostVersion: roundScopeVersion() });
    } catch (error) { return report(error?.code ? error : issue('BILI_V2_ROUND_SCOPE_UNPROVEN', 'Restore the approved Host public source set.')); }
  }
  // 本地版本戳：让装配方判断已缓存的单轮会话是否仍属于同一代 Host/角色，
  // 不需要每次 readiness 都重新打官方账号接口。
  function roundScopeVersion() {
    let currentRole = null;
    try { currentRole = role(); } catch {}
    return freeze({ generation, closed, transitioning: transitioning || transitions > 0,
      publicSourceSetCount: publicSets.size, characterId: currentRole?.id ?? null, characterEpoch: currentRole?.epoch ?? null });
  }
  return Object.freeze({ enqueue, retire, withTransition, close, roundMemoryScope, roundScopeVersion,
    getPlatformState: async () => { try { return await platformState(); } catch (error) { return report(error?.code ? error : issue('BILI_V2_ROUTE_UNPROVEN', 'Restore the actual selected Host model.')); } },
    getStatus: () => Object.freeze({ ok: !closed && !closing && !fault, closed, transitioning: transitioning || transitions > 0, activeJobs: pending.size, registeredSources: instance?.source?.getStatus().activeSourceCount ?? 0, targetCount: targets.size, publicSourceSetCount: publicSets.size, activePreflights: preflights.size, preflightHandles: preflightHandles.size, ...(lastFailure ? { lastFailure } : {}) }),
  });
}
