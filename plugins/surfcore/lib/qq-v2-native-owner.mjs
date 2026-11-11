import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { createIsolatedNativeRoot } from './memory-v2-native-root.mjs';
import { createAgentBudgetMiddleware } from './memory-v2-agent-budget.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const ownProblems = new WeakSet();
const problem = (code, error, hint = 'Keep this session blocked and restore its trusted owner and source authority before retrying.') => { const result = Object.assign(new Error(error), { ok: false, code, error, hint }); ownProblems.add(result); return result; };
const digestInput = (options) => createHash('sha256').update(JSON.stringify({ messages: options.messages, toolHistory: options.toolHistory, tools: options.tools ?? [] })).digest('hex');
const yes = (result) => result === true || result?.ok === true;
function lockPreparedConfig(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
  if (types.isProxy(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  const safe = Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && lockPreparedConfig(descriptor.value, seen);
  });
  if (!safe) return false;
  Object.freeze(value);
  return Object.isFrozen(value);
}
const toolCallbacks = (definition) => [definition.execute, definition.finalizeContent, definition.projectContent, definition.presentCall, definition.presentResult, definition.isConcurrencySafe, definition.output?.render, definition.output?.presentationMeta];
function snapshotDefinition(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if ('value' in descriptor) descriptor.value = snapshotDefinition(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

/** Host-private owner; sourceAuthority must independently validate the actual complete input. */
export async function createQQV2NativeOwner({ nativeModules, llm, getLlmHookContext, corePersona, tools = [], tokenBudget, getCharacter, provider, model, estimatedTokens, priceSnapshot, sourceAuthority, onAgentError } = {}) {
  const route = deriveMemoryProviderRouteId({ provider, model });
  if (!route.ok || !Array.isArray(tools) || typeof getCharacter !== 'function' || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1
    || !tokenBudget || ['isManagedAgentSession', 'ensureReady', 'reserveNativeAgentModelCall', 'admitModelCall', 'settleModelCall', 'reconcileModelCall'].some((key) => typeof tokenBudget[key] !== 'function')
    || !sourceAuthority || ['prepareInput', 'validate', 'admitNetwork'].some((key) => typeof sourceAuthority[key] !== 'function')
    || sourceAuthority.captureModelOutput !== undefined && typeof sourceAuthority.captureModelOutput !== 'function'
    || onAgentError !== undefined && typeof onAgentError !== 'function') throw problem('QQ_NATIVE_OWNER_INVALID', 'The exact route, token budget and trusted source authority are required.');
  let character;
  try { const value = getCharacter(); character = { id: value.id, epoch: value.epoch }; } catch { throw problem('QQ_NATIVE_OWNER_INVALID', 'A synchronous current character is required.'); }
  if (typeof character.id !== 'string' || !character.id || !Number.isSafeInteger(character.epoch) || character.epoch < 1) throw problem('QQ_NATIVE_OWNER_INVALID', 'A synchronous current character is required.');
  let pricing;
  try { pricing = priceSnapshot === undefined ? undefined : structuredClone(priceSnapshot); } catch { throw problem('QQ_NATIVE_OWNER_INVALID', 'The trusted price snapshot must be cloneable.'); }
  let approvedDefinitions, definitionSnapshots, approvedCallbacks;
  try { approvedDefinitions = [...tools]; definitionSnapshots = approvedDefinitions.map((definition) => snapshotDefinition(definition)); approvedCallbacks = approvedDefinitions.map(toolCallbacks); }
  catch { throw problem('QQ_NATIVE_OWNER_INVALID', 'The owned tool definitions cannot be inspected.'); }
  const sessionId = `qq-v2-native-${randomUUID()}`, controller = new AbortController();
  let root, agent, handle, preset, approvedSchemas, state = 'creating', retired = false, cleanupTask;
  const assertLive = () => {
    try {
      const role = getCharacter(), status = root?.getStatus(), selection = agent?.model.current();
      if (state !== 'active' || !root?.ownsAgent(agent) || status.closed || role?.id !== character.id || role?.epoch !== character.epoch
        || root.ctx.agents.get(sessionId) !== agent || agent.session.id !== sessionId || root.ctx.agentPresets.composedPreset(agent.ctx) !== preset
        || selection?.provider !== provider || selection?.model !== model) throw problem('QQ_NATIVE_SESSION_UNSAFE', 'The owned session, role, preset or selected route is no longer current.');
      const definitions = root.ctx.tools.definitions(agent);
      if (definitions.length !== approvedDefinitions.length || definitions.some((item, i) => item !== approvedDefinitions[i] || !isDeepStrictEqual(item, definitionSnapshots[i]) || !isDeepStrictEqual(toolCallbacks(item), approvedCallbacks[i])) || !isDeepStrictEqual(root.ctx.tools.schemas(agent), approvedSchemas)) throw problem('QQ_NATIVE_TOOLS_UNSAFE', 'The live native tool definitions or schemas changed.');
    } catch (error) {
      if (ownProblems.has(error)) throw error;
      throw problem('QQ_NATIVE_SESSION_UNSAFE', 'The owned session cannot be inspected safely.');
    }
  };
  const checkRequest = (options, call, inputDigest) => {
    assertLive();
    if (!root.ownsRequest(options) || root.getCurrentCall() !== call || call.agent !== agent || call.request !== options || !nativeModules.isAgentLoopRequest(options)
      || options.sessionId !== sessionId || options.provider !== provider || options.model !== model
      || call.preparedConfig?.provider !== provider || call.preparedConfig?.model !== model
      || !isDeepStrictEqual(options.tools ?? [], approvedSchemas) || (inputDigest && digestInput(options) !== inputDigest)) throw problem('QQ_NATIVE_REQUEST_UNSAFE', 'The actual native request or its tool surface does not match the owned session.');
  };
  const scopes = new WeakMap(), toolWitnesses = new WeakMap();
  const captureOutput = sourceAuthority.captureModelOutput;
  const middleware = createAgentBudgetMiddleware({ tokenBudget, getCharacter, isAgentLoopRequest: nativeModules?.isAgentLoopRequest,
    isManagedSession: (id) => id === sessionId && state === 'active', getScope: (options) => scopes.get(options) });
  const onStream = (options, next, call) => {
    checkRequest(options, call);
    let preparedConfigSnapshot;
    const preparedConfig = call.preparedConfig;
    try { if (!preparedConfig || typeof preparedConfig !== 'object' || !lockPreparedConfig(preparedConfig)) throw Error(); preparedConfigSnapshot = structuredClone(preparedConfig); } catch { throw problem('QQ_NATIVE_REQUEST_UNSAFE', 'The native prepared configuration cannot be inspected safely.'); }
    const inputDigest = digestInput(options);
    const request = Object.freeze({ requestId: `qq-native-call:${randomUUID()}`, jobId: sessionId, category: 'qq', purpose: 'conversation', role: character.id, epoch: character.epoch, sessionId, providerRouteId: route.providerRouteId, model, estimatedTokens, inputDigest, ...(pricing === undefined ? {} : { priceSnapshot: structuredClone(pricing) }) });
    let sourceHandle;
    const verify = () => {
      checkRequest(options, call, inputDigest);
      try { if (call.preparedConfig !== preparedConfig || !isDeepStrictEqual(preparedConfig, preparedConfigSnapshot)) throw Error(); }
      catch { throw problem('QQ_NATIVE_REQUEST_UNSAFE', 'The native prepared configuration changed or cannot be inspected safely.'); }
    };
    const scope = Object.freeze({ request, signal: controller.signal,
      prepareInput: async () => { verify(); const result = await sourceAuthority.prepareInput({ options, request, preparedConfig, signal: controller.signal }); verify(); if (!result?.ok || !result.handle) return false; sourceHandle = result.handle; return true; },
      validate: async (details) => { verify(); if (!sourceHandle) return false; const result = await sourceAuthority.validate({ ...details, options, request, preparedConfig, handle: sourceHandle, signal: controller.signal }); verify(); return yes(result); },
      admitNetwork: async (dispatch) => { verify(); if (!sourceHandle) throw problem('QQ_NATIVE_SOURCE_UNPROVEN', 'The trusted source authority did not prepare this input.'); const result = await sourceAuthority.admitNetwork({ options, request, preparedConfig, handle: sourceHandle, signal: controller.signal, dispatch: () => { verify(); return dispatch(); } }); verify(); return result; },
    });
    scopes.set(options, scope);
    const stream = middleware.stream(options, next);
    const dispatchId = `qq-native-dispatch:${randomUUID()}`;
    const verifyFailureIdentity = () => {
      if (!root.ownsAgent(agent) || root.getCurrentCall() !== call || call.agent !== agent || call.request !== options || !nativeModules.isAgentLoopRequest(options)) throw Error();
    };
    const observe = async (phase, chunk) => {
      if (!captureOutput) return;
      try {
        const verifyObservation = phase === 'failed' ? verifyFailureIdentity : verify;
        verifyObservation();
        const originalChunk = phase === 'chunk' ? structuredClone(chunk) : undefined;
        const result = await captureOutput.call(sourceAuthority, { options, request, preparedConfig, dispatchId, phase, ...(phase === 'chunk' ? { chunk } : {}), signal: controller.signal });
        verifyObservation();
        if (!yes(result) || phase === 'chunk' && !isDeepStrictEqual(chunk, originalChunk)) throw Error();
      } catch { throw problem('QQ_NATIVE_OUTPUT_UNPROVEN', 'The native model output could not be verified.', 'Keep this session blocked and restore the trusted output authority before retrying.'); }
    };
    return (async function* () {
      let complete = false, failure;
      try {
        await observe('start');
        for await (const chunk of stream) { await observe('chunk', chunk); yield chunk; }
        await observe('complete'); complete = true;
      } catch (error) { failure = error; throw error; }
      finally {
        try { if (!complete) await observe('failed'); }
        catch (error) { if (!failure) throw error; }
        finally { scopes.delete(options); }
      }
    })();
  };
  try {
    root = await createIsolatedNativeRoot({ nativeModules, llm, getLlmHookContext, corePersona, tools: approvedDefinitions, onStream });
    if (onAgentError) root.ctx.on('agent/error', ({ error }) => { try { onAgentError({ code: typeof error?.code === 'string' ? error.code : 'QQ_NATIVE_INFERENCE_FAILED', error: 'The owned native inference failed.', hint: 'Inspect the trusted Host diagnostics and retain the original receipt.' }); } catch {} });
    handle = await root.createAgent({ provider, model, sessionId }); agent = handle.agent;
    preset = root.ctx.agentPresets.composedPreset(agent.ctx);
    approvedSchemas = structuredClone(root.ctx.tools.schemas(agent));
    state = 'active'; assertLive();
    root.ctx.tools.guard((exec) => {
      try {
        assertLive();
        const definition = root.ctx.tools.definitions(exec.agent, exec.toolSet).find((tool) => tool.name === exec.name);
        if (exec.agent !== agent || !approvedDefinitions.includes(definition) || typeof exec.callId !== 'string' || !exec.callId || typeof exec.token !== 'symbol') return 'The QQ native tool is not owned.';
        toolWitnesses.set(exec, { agent: exec.agent, definition, name: exec.name, callId: exec.callId, token: exec.token, toolSet: exec.toolSet, args: structuredClone(exec.arguments) });
      } catch { return 'The QQ native session or tool surface is no longer safe.'; }
    });
  } catch (error) {
    state = 'retiring'; controller.abort();
    if (root) {
      try { await root.close(); } catch { Object.defineProperty(error, 'retryCleanup', { value: () => root.close(), configurable: true }); }
    }
    throw error;
  }
  return Object.freeze({
    sessionId, preset, providerRouteId: route.providerRouteId,
    getSessionMemorySafety({ sessionId: requested, preset: requestedPreset } = {}) { try { assertLive(); return requested === sessionId && requestedPreset === preset; } catch { return false; } },
    validateOwnedToolContext(execution) {
      try {
        assertLive();
        const witness = toolWitnesses.get(execution);
        if (!witness || execution.agent !== witness.agent || execution.agent !== agent || execution.name !== witness.name || execution.callId !== witness.callId || execution.token !== witness.token || execution.toolSet !== witness.toolSet
          || !isDeepStrictEqual(execution.arguments, witness.args) || root.ctx.tools.definitions(agent, execution.toolSet).find((item) => item.name === execution.name) !== witness.definition) throw Error();
        return { ok: true };
      } catch { if (execution && typeof execution === 'object') toolWitnesses.delete(execution); return problem('QQ_NATIVE_TOOL_EXECUTION_UNPROVEN', 'The native tool execution context could not be verified.', 'Keep the tool blocked and restore the trusted owned session before retrying.'); }
    },
    followup(message) { assertLive(); return agent.followup(message); },
    async whenIdle() { await agent.whenIdle(); },
    getStatus() { return Object.freeze({ state, retired, ...root.getStatus() }); },
    async retire() {
      if (retired) return;
      state = 'retiring'; controller.abort();
      if (!cleanupTask) cleanupTask = (async () => { if (captureOutput) { if (typeof agent.cancel === 'function') await agent.cancel(); try { await agent.whenIdle(); } catch {} } await root.close(); })();
      const task = cleanupTask;
      try { await task; const status = root.getStatus(); if (!status.retired || status.pendingCleanup !== 0) throw problem('QQ_NATIVE_RETIRE_FAILED', 'Native disposal has not been acknowledged.'); retired = true; state = 'retired'; }
      finally { if (cleanupTask === task) cleanupTask = undefined; }
    },
  });
}
