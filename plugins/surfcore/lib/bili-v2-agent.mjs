import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireBudgetOwnership } from './token-budget-admission.mjs';
import { syncBudgetFiles } from './token-budget-sync.mjs';
import { createAgentBudgetMiddleware } from './memory-v2-agent-budget.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { attachBiliV2Worker } from '../tools/lib/bili-v2-dispatch.mjs';

const issue = (code, hint, unknown = false) => Object.assign(new Error('Bili V2 operation was refused.'), { ok: false, code, error: 'Bili V2 operation was refused.', hint, unknown });
const pass = (value) => value === true || value?.ok === true;
const requiredSources = ['preparePrompt', 'prepareInput', 'validate', 'captureToolResult', 'prepareSend', 'captureModelOutput'];
const nativeNames = ['surfcore_bili_read', 'surfcore_bili_comment', 'surfcore_bili_dynamic', 'surfcore_bili_dm'];
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] };

function canonical(value, seen = new WeakSet()) {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return typeof value + ':' + JSON.stringify(value);
  if (!value || typeof value !== 'object' || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length || seen.has(value)) throw issue('BILI_V2_INPUT_UNSUPPORTED', 'A cyclic, symbol-bearing or non-JSON model input needs a trusted source adapter.');
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (Array.isArray(value) ? 'array' : 'object') + '{' + Object.keys(descriptors).sort().map((key) => { if (!('value' in descriptors[key])) throw issue('BILI_V2_INPUT_UNSUPPORTED', 'A model input getter cannot be approved.'); return JSON.stringify(key) + ':' + canonical(descriptors[key].value, seen); }).join(',') + '}';
  } finally { seen.delete(value); }
}
export function biliV2InputDigest(options) {
  const input = Object.create(null);
  if (Object.getOwnPropertySymbols(options).length) throw issue('BILI_V2_INPUT_UNSUPPORTED', 'A symbol-bearing model input needs a trusted source adapter.');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) if (key !== 'signal') {
    if (!('value' in descriptor)) throw issue('BILI_V2_INPUT_UNSUPPORTED', 'A model input getter cannot be approved.');
    input[key] = descriptor.value;
  }
  const bytes = canonical(input);
  if (bytes.length > 8 * 1024 * 1024) throw issue('BILI_V2_INPUT_UNSUPPORTED', 'Prepare oversized inputs through the source adapter first.');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function createBiliV2AgentRuntime({ ctx, nativeRoot, memoryV2, getCharacter, tokenBudget, isAgentLoopRequest, sourceRuntime, modelRequest, getModelRoute, transport, registryPath, nodeRuntime = process.execPath, commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/commands'), onBlocked = () => {} } = {}) {
  if (nativeRoot) ctx = nativeRoot.ctx;
  const jobs = new Map(), triggers = new Map(), scopes = new WeakMap();
  let owner, registry = { version: 1, sessions: {} }, fault, closed = false, shuttingDown = false, closeTask = null, guardOff, hookOff, presetOff, presetReady, lastFailure;
  const presetId = 'surfcore-bili-v2-' + crypto.randomUUID();
  const report = (error) => { lastFailure = { ok: false, code: error?.code || 'BILI_V2_UNSUPPORTED', error: 'Bili V2 operation was refused.', hint: error?.hint || 'Check the native Bili Host adapters before retrying.', unknown: error?.unknown === true }; try { onBlocked(lastFailure); } catch {} return lastFailure; };
  try {
    if (!path.isAbsolute(registryPath ?? '')) throw issue('BILI_V2_REGISTRY_UNAVAILABLE', 'Configure a Host-owned registry outside role backups.');
    owner = acquireBudgetOwnership(registryPath + '.owner');
    if (owner.issue()) throw owner.issue();
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (data?.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions) || Object.keys(data).some((k) => !['version', 'sessions'].includes(k))) throw new Error('registry');
      for (const [id, entry] of Object.entries(data.sessions)) {
        if (!entry || id !== entry.sessionId || typeof entry.jobId !== 'string' || !entry.jobId || typeof entry.requestId !== 'string' || !entry.requestId || typeof entry.characterId !== 'string' || !entry.characterId || !Number.isSafeInteger(entry.characterEpoch) || entry.characterEpoch < 0 || Object.keys(entry).some((k) => !['sessionId', 'jobId', 'requestId', 'characterId', 'characterEpoch'].includes(k))) throw new Error('registry');
        triggers.set(entry.requestId, { historical: true, sessionId: id });
      }
      registry = data;
    }
  } catch { fault = issue('BILI_V2_REGISTRY_UNAVAILABLE', 'Repair the protected managed-session registry; V2 remains blocked.'); }
  function base() {
    if (fault) throw fault;
    if (nativeRoot && (!ctx || !['createAgent', 'registerTool', 'ownsAgent', 'ownsRequest', 'getCurrentCall', 'getLlmHookContext'].every((key) => typeof nativeRoot[key] === 'function'))) throw issue('MEMORY_NATIVE_ROOT_UNSUPPORTED', 'Provide the verified isolated root and actual LLM owner subscription.');
    if (closed || shuttingDown || owner?.issue()) throw issue('BILI_V2_UNAVAILABLE', 'Restore the native Bili runtime before retrying.');
    const route = memoryV2?.getRouting?.();
    if (!pass(route) || route.backend !== 'v2') throw issue('BILI_V2_ROUTING_CHANGED', 'Check the current memory routing; this job cannot fall back to V1.');
    if (typeof sourceRuntime?.captureModelOutput !== 'function') throw issue('MEMORY_NATIVE_INPUT_UNPROVEN', 'Connect the private native output provenance validator before running Bili V2.');
    if (typeof getCharacter !== 'function' || typeof isAgentLoopRequest !== 'function' || typeof modelRequest !== 'function' || typeof getModelRoute !== 'function' || !requiredSources.every((key) => typeof sourceRuntime?.[key] === 'function') || typeof memoryV2?.adapter?.withNetworkAdmission !== 'function' || typeof transport?.send !== 'function') throw issue('BILI_V2_UNSUPPORTED', 'Connect the trusted source, route, budget and fixed transport adapters.');
  }
  function check(state) {
    base();
    const current = getCharacter();
    if (state.stopped || state.controller.signal.aborted || String(current?.id) !== state.job.characterId || Number(current?.epoch) !== state.job.characterEpoch) throw issue('BILI_V2_JOB_REVOKED', 'The original role or job changed; start a newly authorized job.');
    if (state.agent && (ctx.agents?.get(state.job.sessionId) !== state.agent || nativeRoot && !nativeRoot.ownsAgent(state.agent))) throw issue('BILI_V2_SESSION_CHANGED', 'The actual agent binding was lost.');
  }
  function persist(job) {
    if (owner.issue()) throw issue('BILI_V2_REGISTRY_UNAVAILABLE', 'Restore the protected registry owner.');
    const next = { version: 1, sessions: { ...registry.sessions, [job.sessionId]: { sessionId: job.sessionId, jobId: job.jobId, requestId: job.requestId, characterId: job.characterId, characterEpoch: job.characterEpoch } } };
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const temp = registryPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, registryPath);
      syncBudgetFiles([registryPath], path.dirname(registryPath));
      registry = next;
    } catch { fault = issue('BILI_V2_REGISTRY_UNAVAILABLE', 'Repair the protected registry before submitting any new job.'); throw fault; }
  }
  function isManagedSession(id) { if (closed) return Object.hasOwn(registry.sessions, id) || jobs.has(id); if (fault || owner?.issue()) return { ok: false, code: 'BILI_V2_REGISTRY_UNAVAILABLE', error: 'Managed session membership is unknown.', hint: 'Repair the protected registry before running models.' }; return Object.hasOwn(registry.sessions, id) || jobs.has(id); }
  const guard = (exec) => {
    const id = exec?.agent?.session?.id ?? exec?.agent?.id;
    if (fault) return 'BILI_V2_REGISTRY_UNAVAILABLE';
    if (!Object.hasOwn(registry.sessions, id) && !jobs.has(id)) return;
    const state = jobs.get(id);
    try { if (!state || exec.agent !== state.agent || !state.active) return 'BILI_V2_SESSION_UNBOUND'; check(state); if (!state.definitions.has(exec.name) || ctx.tools.get(exec.name, state.agent, exec.toolSet) !== state.definitions.get(exec.name)) return 'BILI_V2_TOOL_DENIED'; }
    catch { return 'BILI_V2_JOB_REVOKED'; }
  };
  function getSessionSafety(id) {
    const state = jobs.get(id);
    try {
      if (!state || !state.active || !state.promptHandle || !guardOff || !hookOff || !state.masked || !state.pinned) throw issue('BILI_V2_SESSION_UNBOUND', 'A fresh native session with source and route proofs is required.');
      check(state);
      const denial = ctx.tools.checkGuards?.({ agent: state.agent, name: '__surfcore_bili_guard_probe__', token: {}, signal: state.controller.signal });
      if (nativeRoot ? typeof denial !== 'string' || !denial : denial !== 'BILI_V2_TOOL_DENIED') throw issue('BILI_V2_GUARD_UNAVAILABLE', 'Restore the actual native tool guard before any model or send.');
      return Object.freeze({ ok: true, sessionId: id, jobId: state.job.jobId, characterId: state.job.characterId, characterEpoch: state.job.characterEpoch, providerRouteId: state.job.providerRouteId, nativeGuard: true, sourceBound: true, routePinned: true });
    } catch (error) { return report(error); }
  }
  async function validate(state, details) {
    check(state);
    if (details.options && biliV2InputDigest(details.options) !== details.request?.inputDigest) throw issue('BILI_V2_INPUT_CHANGED', 'The full actual input changed; prepare a new authorized request.');
    if (!getSessionSafety(state.job.sessionId).ok) throw issue('BILI_V2_GUARD_UNAVAILABLE', 'Restore the actual native session guard.');
    const result = await sourceRuntime.validate({ job: state.job, ...details, signal: state.controller.signal });
    check(state);
    if (details.options && biliV2InputDigest(details.options) !== details.request?.inputDigest) throw issue('BILI_V2_INPUT_CHANGED', 'The full actual input changed during validation.');
    if (!pass(result)) throw issue(result?.code || 'BILI_V2_SOURCE_CHANGED', result?.hint || 'Prepare the actual sources and grants again.');
    return true;
  }
  function stop(state) {
    if (state.stopped) return;
    state.stopped = true; state.active = false; state.controller.abort();
    try { state.agent?.cancel({ kind: 'user' }); } catch {}
    for (const child of state.children) { try { child.kill(); } catch {} }
  }
  async function releaseState(state) {
    const result = await sourceRuntime.releaseJob?.({ job: state.job });
    if (result?.ok === false) throw issue(result.code || 'BILI_V2_RETIRE_FAILED', result.hint || 'Keep the private source context blocked until release is acknowledged.');
    for (const request of state.requests ?? []) scopes.delete(request);
    state.requests?.clear(); jobs.delete(state.job.sessionId);
  }
  async function finish(state) {
    if (state.finishing) return state.finishing;
    stop(state);
    state.finishing = (async () => {
      if (state.creating) await state.creating.catch(() => {});
      if (!state.agent) { await releaseState(state); return; }
      if (nativeRoot) {
        state.agent.cancel({ kind: 'user' });
        await state.agent.whenIdle();
        const inbox = state.agent.inbox;
        if (!Array.isArray(inbox?.nextTurn) || inbox.nextTurn.length || !Array.isArray(inbox?.nextStep) || inbox.nextStep.length || typeof state.nativeHandle?.dispose !== 'function') throw issue('BILI_V2_RETIRE_FAILED', 'The isolated actual inbox or unload handle is unproven.');
        if (typeof nativeRoot.releaseAgent === 'function') await nativeRoot.releaseAgent(state.nativeHandle);
        else await state.nativeHandle.dispose();
        if (ctx.agents.get(state.job.sessionId) === state.agent) throw issue('BILI_V2_RETIRE_FAILED', 'The original isolated agent did not acknowledge unload.');
        for (const dispose of state.disposers) await dispose();
        await releaseState(state); return;
      }
      const cleanupSignal = new AbortController().signal;
      const inspection = await ctx.sessionController.state({ sessionId: state.job.sessionId }, cleanupSignal);
      if (!Array.isArray(inspection?.queue)) throw issue('BILI_V2_RETIRE_FAILED', 'The Host did not provide an authoritative queue snapshot.');
      for (const item of inspection.queue) await ctx.sessionController.updateQueue({ sessionId: state.job.sessionId, itemId: item.id, action: { kind: 'remove' } });
      const cancelled = await ctx.sessionController.cancel({ sessionId: state.job.sessionId });
      if (cancelled?.accepted !== true) throw issue('BILI_V2_RETIRE_FAILED', 'The Host did not acknowledge cancellation; keep the session blocked.');
      state.agent.cancel({ kind: 'user' });
      const archived = await ctx.workspaceController.archiveSession({ sessionId: state.job.sessionId });
      if (!archived?.archivedSessionIds?.includes(state.job.sessionId)) throw issue('BILI_V2_RETIRE_FAILED', 'The original session did not acknowledge archive.');
      await state.agent.whenIdle();
      const final = await ctx.sessionController.state({ sessionId: state.job.sessionId }, cleanupSignal);
      const heldInbox = state.agent.inbox;
      if (!(Array.isArray(final?.queue) ? final.queue.length === 0 : final?.active === false && final.queue === null) || !Array.isArray(heldInbox?.nextTurn) || heldInbox.nextTurn.length || !Array.isArray(heldInbox?.nextStep) || heldInbox.nextStep.length) throw issue('BILI_V2_RETIRE_FAILED', 'The original queue is not authoritatively empty; keep the session blocked.');
      for (const dispose of state.disposers) await dispose();
      await releaseState(state);
    })().catch((error) => { state.finishing = undefined; report(error); throw error; });
    return state.finishing;
  }
  function getScope(options) {
    if (scopes.has(options)) return scopes.get(options);
    const state = jobs.get(options?.sessionId);
    if (!state) return;
    check(state);
    if (nativeRoot && (!nativeRoot.ownsRequest(options) || nativeRoot.getCurrentCall()?.agent !== state.agent || nativeRoot.getCurrentCall()?.request !== options)) throw issue('BILI_V2_ROUTE_UNPROVEN', 'Only the actual retained isolated agent request can enter its budget scope.');
    if (!isAgentLoopRequest(options) || options.provider !== state.job.provider || options.model !== state.job.model || !getSessionSafety(state.job.sessionId).ok) throw issue('BILI_V2_ROUTE_UNPROVEN', 'The actual branded model request does not match the pinned route.');
    const inputDigest = biliV2InputDigest(options);
    const estimate = modelRequest({ job: state.job, options, inputDigest });
    if (!estimate || typeof estimate !== 'object' || typeof estimate.then === 'function') throw issue('BILI_V2_BUDGET_UNSUPPORTED', 'Provide synchronous trusted inference estimates.');
    const request = Object.freeze({ ...structuredClone(estimate), requestId: state.job.jobId + ':inference:' + (++state.inferences), jobId: state.job.jobId, category: 'bili', purpose: 'conversation', role: state.job.characterId, epoch: state.job.characterEpoch, sessionId: state.job.sessionId, providerRouteId: state.job.providerRouteId, model: state.job.model, inputDigest });
    let handle;
    const scope = Object.freeze({ request, signal: state.controller.signal,
      prepareInput: async () => {
        check(state);
        const prepared = await sourceRuntime.prepareInput({ job: state.job, options, request, signal: state.controller.signal });
        check(state);
        if (!pass(prepared) || !prepared.handle || biliV2InputDigest(options) !== inputDigest) throw issue(prepared?.code || 'BILI_V2_INPUT_UNPROVEN', prepared?.hint || 'Prepare every actual input block, history, attachment and tool result.');
        handle = prepared.handle; state.lastRequest = request;
        return true;
      },
      validate: (details) => validate(state, { ...details, options, request }),
      admitNetwork: (dispatch) => {
        check(state);
        if (!handle) throw issue('BILI_V2_INPUT_UNPROVEN', 'Prepare the complete actual model input.');
        return memoryV2.adapter.withNetworkAdmission(handle, () => { check(state); if (biliV2InputDigest(options) !== inputDigest) throw issue('BILI_V2_INPUT_CHANGED', 'The actual input changed before provider dispatch.'); return dispatch(); }, { signal: state.controller.signal });
      },
    });
    scopes.set(options, scope); (state.requests ??= new Set()).add(options);
    return scope;
  }
  try {
    if (typeof ctx?.tools?.guard !== 'function' || typeof ctx?.on !== 'function') throw issue('BILI_V2_GUARD_UNAVAILABLE', 'This Host does not expose the native tool and LLM middleware APIs.');
    guardOff = ctx.tools.guard(guard);
    const facade = { ...tokenBudget, isManagedAgentSession: (id) => isManagedSession(id) === true ? tokenBudget.isManagedAgentSession(id) : false };
    const budgetMiddleware = createAgentBudgetMiddleware({ tokenBudget: facade, getCharacter, isAgentLoopRequest, getScope, isManagedSession });
    const hookContext = nativeRoot ? nativeRoot.getLlmHookContext() : ctx;
    if (typeof hookContext?.on !== 'function' || nativeRoot && hookContext.root === ctx.root) throw issue('MEMORY_NATIVE_ROOT_UNSUPPORTED', 'Subscribe on the verified actual borrowed LLM owner.');
    hookOff = hookContext.on('llm/stream', async function* (options, next) {
      if (nativeRoot && !nativeRoot.ownsRequest(options)) {
        if (Object.hasOwn(registry.sessions, options?.sessionId) || jobs.has(options?.sessionId) || fault && String(options?.sessionId).startsWith('bili-v2-')) throw issue('BILI_V2_SESSION_UNBOUND', 'The persistent Bili session cannot resume outside its original isolated binding.');
        yield* next(options); return;
      }
      const state = jobs.get(options?.sessionId);
      if (!state || typeof isAgentLoopRequest !== 'function' || !isAgentLoopRequest(options)) { yield* budgetMiddleware.stream(options, next); return; }
      const dispatchId = crypto.randomUUID();
      let request, started = false, complete = false, failure;
      const capture = async (phase, chunk) => {
        check(state);
        let result;
        try { result = await sourceRuntime.captureModelOutput({ job: state.job, options, request, dispatchId, phase, chunk, signal: state.controller.signal }); }
        catch { throw issue('MEMORY_NATIVE_INPUT_UNPROVEN', 'Restore native output provenance before preparing subsequent input.'); }
        check(state);
        if (!pass(result)) throw issue('MEMORY_NATIVE_INPUT_UNPROVEN', result?.hint || 'The private source validator did not approve native output provenance.');
      };
      try {
        request = getScope(options).request;
        started = true;
        await capture('start');
        for await (const chunk of budgetMiddleware.stream(options, next)) { await capture('chunk', chunk); yield chunk; }
        await capture('complete'); complete = true;
      } catch (error) { failure = error; report(error); throw error; }
      finally {
        if (started && !complete) {
          try { await sourceRuntime.captureModelOutput({ job: state.job, options, request, dispatchId, phase: 'failed', error: failure, signal: state.controller.signal }); }
          catch (error) { report(error); }
          stop(state); queueMicrotask(() => { finish(state).catch(() => {}); });
        }
      }
    });
  } catch (error) { fault = issue('BILI_V2_GUARD_UNAVAILABLE', 'Install the actual native guards before enabling Bili V2.'); report(error); }
  async function startPreset() {
    if (nativeRoot) return;
    if (!presetReady) presetReady = (async () => {
      if (typeof ctx.agentPresets?.register !== 'function') throw issue('BILI_V2_PRESET_UNSUPPORTED', 'This Host cannot mount the private native agent preset.');
      presetOff = await ctx.agentPresets.register({ id: presetId, name: 'Bili V2 native', plugins: [{ name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 1 } }, { name: '@deepseek-ai/dsh-tool-executor-native', config: {} }] });
      const preset = await ctx.agentPresets.resolve(presetId);
      if (!preset || preset.broken || typeof presetOff !== 'function') throw issue('BILI_V2_PRESET_UNSUPPORTED', 'Repair the private native preset without using the old Bili preset.');
    })();
    return presetReady;
  }
  async function worker(state, exec, action, args) {
    await validate(state, { phase: 'tool', execution: exec, action });
    const write = ['comment', 'dynamic', 'dm'].includes(action);
    if (!write && transport.read !== undefined) {
      if (typeof transport.read !== 'function') throw issue('BILI_V2_TOOL_UNSUPPORTED', 'Restore the Host scoped read transport.');
      const read = await transport.read({ job: state.job, action, args, signal: state.controller.signal });
      check(state);
      if (!pass(read) || typeof read.stdout !== 'string' || !read.stdout || Buffer.byteLength(read.stdout, 'utf8') > 1048576) throw issue(read?.code || 'BILI_V2_SOURCE_UNPROVEN', read?.hint || 'Use the fixed approved source set and capture its official originals.');
      const captured = await sourceRuntime.captureToolResult({ job: state.job, execution: exec, action, result: { stdout: read.stdout, derived: false, requestId: state.lastRequest?.requestId }, signal: state.controller.signal });
      check(state);
      if (!pass(captured)) throw issue(captured?.code || 'BILI_V2_SOURCE_UNPROVEN', captured?.hint || 'Capture and bind the complete tool result before returning it.');
      return { ok: true, result: captured.result };
    }
    let argv, script;
    if (action === 'comment') { script = 'comment.mjs'; argv = ['--oid', String(args.oid), '--type', String(args.type), ...(args.bvid ? ['--bvid', args.bvid] : ['--referer', 'https://www.bilibili.com/opus/' + String(args.oid)]), '--message', args.text, '--root', String(args.root || '0'), '--parent', String(args.parent || '0'), '--auto', '--go']; }
    else if (action === 'dynamic') { if (typeof state.accountMid !== 'string' || !/^[1-9]\d{0,29}$/.test(state.accountMid)) throw issue('BILI_V2_IDENTITY_UNPROVEN', 'Restore the source-owned official account before preparing a dynamic.'); script = 'dynamic.mjs'; argv = ['post', '--text', args.text, '--json', '--action-id', state.job.jobId + '-dynamic', '--expected-mid', state.accountMid, '--auto', '--go']; }
    else if (action === 'dm') { script = 'dm.mjs'; argv = ['--to', String(args.mid), '--msg', args.text, '--auto', '--go']; }
    else if (action === 'feed') { script = 'feed.mjs'; argv = ['--json']; }
    else if (action === 'debrief') { script = 'debrief.mjs'; argv = [args.bv]; }
    else throw issue('BILI_V2_TOOL_UNSUPPORTED', 'This Bili action has not been migrated.');
    const controller = state.controller;
    const child = fork(path.join(commandsDir, script), argv, { execPath: nodeRuntime, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, SURFCORE_BILI_V2_WORKER: '1', SURFCORE_EXPECTED_CHARACTER_ID: state.job.characterId, SURFCORE_EXPECTED_CHARACTER_EPOCH: String(state.job.characterEpoch) } });
    state.children.add(child);
    let initiated = false, dispatched = false;
    const off = attachBiliV2Worker({ child, signal: controller.signal, dispatch: async (decoded) => {
      if (!write || decoded.request.action !== action || dispatched) throw issue('BILI_V2_DISPATCH_DENIED', 'This worker has no authority for that write.');
      dispatched = true;
      await validate(state, { phase: 'send', execution: exec, action });
      const prepared = await sourceRuntime.prepareSend({ job: state.job, execution: exec, action, target: decoded.target, payload: decoded.payload, signal: controller.signal });
      check(state);
      if (!pass(prepared) || !prepared.handle) throw issue(prepared?.code || 'BILI_V2_TARGET_UNPROVEN', prepared?.hint || 'Approve the actual target audience with all job source references.');
      try {
        const result = await memoryV2.adapter.withNetworkAdmission(prepared.handle, () => { check(state); initiated = true; return transport.send({ ...decoded.request, signal: state.controller.signal }); }, { signal: controller.signal });
        check(state);
        if (!result || !Number.isInteger(result.http) || result.http < 200 || result.http > 599 || !Number.isSafeInteger(result.body?.code)) throw issue('BILI_V2_RECEIPT_INVALID', 'Inspect the original platform action receipt.', true);
        const data = {};
        for (const key of ['dynamic_id', 'dynamic_id_str', 'dyn_id', 'dyn_id_str', 'rpid', 'rpid_str', 'msg_key']) {
          const value = result.body.data?.[key];
          if ((typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,128}$/.test(String(value))) data[key] = value;
        }
        return { http: result.http, body: { code: result.body.code, message: result.body.code === 0 ? 'ok' : 'Platform rejected the request; inspect the original receipt.', data } };
      } catch (error) { if (initiated) throw issue('BILI_V2_DISPATCH_UNKNOWN', 'Inspect the original action receipt; do not change action ID or retry.', true); throw error; }
    } });
    let stdout = '';
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(issue(initiated ? 'BILI_V2_DISPATCH_UNKNOWN' : 'BILI_V2_WORKER_TIMEOUT', 'Inspect the original job receipt before retrying.', initiated)); }, 60_000);
        child.stdout.on('data', (bytes) => { stdout += String(bytes); if (stdout.length > 1048576) child.kill(); });
        child.stderr.resume();
        child.once('error', () => { clearTimeout(timer); reject(issue('BILI_V2_WORKER_FAILED', 'Restore the fixed Bili command worker.')); });
        child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      check(state);
      if (code !== 0) throw issue(initiated ? 'BILI_V2_DISPATCH_UNKNOWN' : 'BILI_V2_WORKER_FAILED', 'Inspect the original action receipt; do not retry automatically.', initiated);
      const result = await sourceRuntime.captureToolResult({ job: state.job, execution: exec, action, result: { stdout, derived: write, requestId: state.lastRequest?.requestId }, signal: controller.signal });
      check(state);
      if (!pass(result)) throw issue(result?.code || 'BILI_V2_SOURCE_UNPROVEN', result?.hint || 'Capture and bind the complete tool result before returning it.');
      return { ok: true, result: result.result };
    } finally { off(); state.children.delete(child); }
  }
  function register(state) {
    const string = { type: 'string', required: true };
    const definitions = [
      { name: nativeNames[0], description: 'Read a fixed Bili source; results are captured before returning.', parameters: { kind: { type: 'string', enum: ['feed', 'debrief'], required: true }, bv: { type: 'string' } }, action: (args) => args.kind },
      { name: nativeNames[1], description: 'Comment on an explicitly authorized actual Bili target.', parameters: { oid: string, type: { type: 'string', enum: ['1', '11', '17'], required: true }, text: string, bvid: { type: 'string' }, root: { type: 'string' }, parent: { type: 'string' } }, action: () => 'comment' },
      { name: nativeNames[2], description: 'Publish one text dynamic using this job original action ID.', parameters: { text: string }, action: () => 'dynamic' },
      { name: nativeNames[3], description: 'Reply to an authorized actual Bili private-message target.', parameters: { mid: string, text: string }, action: () => 'dm' },
    ];
    for (const spec of definitions) {
      const definition = { name: spec.name, description: spec.description, parameters: spec.parameters, output, execute: async (args, exec) => {
        if (exec.agent !== state.agent || state.definitions.get(exec.name) !== definition || !exec.token || Object.keys(args).some((key) => !Object.hasOwn(spec.parameters, key))) throw issue('BILI_V2_TOOL_DENIED', 'Use the actual scoped native Bili tool.');
        check(state);
        for (const [key, parameter] of Object.entries(spec.parameters)) {
          const value = args[key];
          if (parameter.required && (typeof value !== 'string' || !value) || value !== undefined && (typeof value !== 'string' || value.length > 5000) || parameter.enum && value !== undefined && !parameter.enum.includes(value)) throw issue('BILI_V2_ARGS_INVALID', 'Use the declared typed Bili arguments.');
        }
        if (args.kind === 'debrief' && !/^BV[A-Za-z0-9]{10}$/.test(args.bv ?? '') || args.bvid && !/^BV[A-Za-z0-9]{10}$/.test(args.bvid) || ['oid', 'mid', 'root', 'parent'].some((key) => args[key] !== undefined && !/^\d{1,30}$/.test(args[key]))) throw issue('BILI_V2_ARGS_INVALID', 'Use exact platform IDs rather than shell flags or aliases.');
        try { return await worker(state, exec, spec.action(args), args); }
        catch (error) { report(error); stop(state); queueMicrotask(() => { finish(state).catch(() => {}); }); throw error; }
      } };
      state.definitions.set(definition.name, definition);
      state.disposers.push(nativeRoot ? nativeRoot.registerTool(definition, state.agent.ctx) : state.agent.ctx.tools.register(definition));
    }
  }
  async function enqueue({ requestId, input, signal } = {}) {
    let state;
    try {
      base();
      if (typeof requestId !== 'string' || !requestId || requestId.length > 200 || !input || typeof input.kind !== 'string') throw issue('BILI_V2_JOB_INVALID', 'Supply a trusted typed scheduler trigger.');
      if (triggers.has(requestId)) throw issue('BILI_V2_JOB_REUSED', 'This original job was already submitted; inspect its receipt.');
      const current = getCharacter();
      const role = { id: String(current?.id ?? ''), epoch: Number(current?.epoch) };
      if (!role.id || !Number.isSafeInteger(role.epoch) || role.epoch < 0) throw issue('BILI_V2_JOB_INVALID', 'Restore the current character identity.');
      const controller = new AbortController();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', () => { controller.abort(); if (state) stop(state); }, { once: true });
      triggers.set(requestId, { pending: true });
      const route = await getModelRoute();
      if (String(getCharacter()?.id) !== role.id || Number(getCharacter()?.epoch) !== role.epoch || controller.signal.aborted) throw issue('BILI_V2_JOB_REVOKED', 'The role changed while resolving the model route.');
      if (!deriveMemoryProviderRouteId(route).ok || typeof route?.provider !== 'string' || typeof route?.model !== 'string' || route.providerRouteId !== deriveMemoryProviderRouteId(route).providerRouteId) throw issue('BILI_V2_ROUTE_UNPROVEN', 'Select an explicit resolved model route.');
      const job = Object.freeze({ jobId: crypto.randomUUID(), requestId, characterId: role.id, characterEpoch: role.epoch, sessionId: 'bili-v2-' + crypto.randomUUID(), providerRouteId: route.providerRouteId, provider: route.provider, model: route.model });
      state = { job, controller, active: false, stopped: false, definitions: new Map(), disposers: [], children: new Set(), inferences: 0 };
      jobs.set(job.sessionId, state); persist(job);
      await startPreset(); check(state);
      const prepared = await sourceRuntime.preparePrompt({ job, input: structuredClone(input), signal: controller.signal });
      check(state);
      if (!pass(prepared) || !prepared.handle || !Array.isArray(prepared.content) || !prepared.content.length) throw issue(prepared?.code || 'BILI_V2_SOURCE_UNPROVEN', prepared?.hint || 'Prepare original sources, core persona and approved native instructions.');
      state.promptHandle = prepared.handle;
      state.accountMid = prepared.accountMid;
      if (nativeRoot) {
        state.creating = nativeRoot.createAgent({ sessionId: job.sessionId, provider: job.provider, model: job.model }).then(handle => { state.nativeHandle = handle; state.agent = handle?.agent; });
      } else {
        state.creating = (async () => {
          const created = await ctx.sessionController.create({ sessionId: job.sessionId, agentPreset: presetId });
          if (created?.sessionId !== job.sessionId) throw issue('BILI_V2_SESSION_CHANGED', 'The Host did not create the requested fresh native session.');
          state.agent = ctx.agents.get(job.sessionId);
        })();
      }
      await state.creating;
      check(state);
      const messages = state.agent?.session?.deriveMessages?.(), history = state.agent?.session?.toolHistory?.();
      const historyFields = history && typeof history === 'object' && !Array.isArray(history) && !Object.getOwnPropertySymbols(history).length ? Object.getOwnPropertyDescriptors(history) : undefined;
      const emptyHistory = !nativeRoot && Array.isArray(history) && history.length === 0 || historyFields && Object.keys(historyFields).length === 2 && Array.isArray(historyFields.tools?.value) && historyFields.tools.value.length === 0 && Array.isArray(historyFields.updates?.value) && historyFields.updates.value.length === 0;
      if (state.agent?.session?.id !== job.sessionId || !Array.isArray(messages) || messages.length || !emptyHistory || typeof state.agent.model?.select !== 'function' || typeof state.agent.cancel !== 'function' || typeof state.agent.whenIdle !== 'function') throw issue('BILI_V2_SESSION_UNSAFE', 'A new empty actual agent session with supported cancellation is required.');
      state.agent.model.select({ provider: job.provider, model: job.model }); state.pinned = true;
      state.disposers.push(state.agent.ctx.tools.restrict({ allow: [] })); state.masked = true;
      register(state); state.active = true;
      if (!getSessionSafety(job.sessionId).ok) throw issue('BILI_V2_GUARD_UNAVAILABLE', 'Restore the complete native session guard.');
      await validate(state, { phase: 'prompt' });
      if (nativeRoot) {
        if (typeof state.agent.followup !== 'function') throw issue('MEMORY_NATIVE_ROOT_UNSUPPORTED', 'Use the actual native inbox followup API.');
        const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
        state.agent.followup(freeze({ id: crypto.randomUUID(), role: 'user', source: { kind: 'user-rpc', requestId }, content: structuredClone(prepared.content) }));
      } else {
        const accepted = await ctx.sessionController.prompt({ sessionId: job.sessionId, requestId, mode: 'queue', content: prepared.content });
        if (accepted?.accepted !== true) throw issue('BILI_V2_PROMPT_FAILED', 'The fresh session did not acknowledge the prompt.');
      }
      check(state);
      state.agent.whenIdle().then(() => finish(state)).catch((error) => report(error));
      return { ok: true, accepted: true, sessionId: job.sessionId, jobId: job.jobId };
    } catch (error) { if (state) { stop(state); finish(state).catch(() => {}); } return report(error); }
  }
  async function retire() { const values = [...jobs.values()]; values.forEach(stop); return Promise.all(values.map(finish)); }
  async function close() {
    if (closed) return;
    if (closeTask) return closeTask;
    shuttingDown = true;
    closeTask = (async () => {
      await retire();
      if (hookOff) { await hookOff(); hookOff = undefined; }
      if (guardOff) { await guardOff(); guardOff = undefined; }
      if (presetOff) { await presetOff(); presetOff = undefined; }
      owner?.close();
      closed = true;
    })().catch((error) => {
      closeTask = null;
      const failure = issue(error?.code || 'BILI_V2_RETIRE_FAILED', error?.hint || 'The native Bili unload was not acknowledged; retry close on the same runtime.');
      report(failure);
      throw failure;
    });
    return closeTask;
  }
  return Object.freeze({ enqueue, getScope, isManagedSession, getSessionSafety, retire, close, getStatus: () => ({ ok: !fault && !closed && !shuttingDown, lastFailure, managedSessions: Object.keys(registry.sessions).length, activeJobs: jobs.size }) });
}
