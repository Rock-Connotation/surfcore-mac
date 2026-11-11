import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const unsupported = (error) => Object.assign(new Error(error), {
  ok: false, code: 'MEMORY_NATIVE_ROOT_UNSUPPORTED', error,
  hint: 'Keep V1 active; inject the verified native modules, actual LLM hook owner and trusted full-input admission hook before dispatch.',
});

export async function createIsolatedNativeRoot({ nativeModules, llm, getLlmHookContext, corePersona, tools = [], attachments, storage, onStream } = {}) {
  const required = ['Context', 'SessionProjectionRegistry', 'SessionStore', 'AgentRegistry', 'SystemPrompt', 'ToolsService', 'Loader', 'AgentLoop', 'AgentPresetRegistry', 'isAgentLoopRequest'];
  if (!nativeModules || required.some((key) => typeof nativeModules[key] !== 'function') || typeof nativeModules.nativeExecutor?.apply !== 'function') throw unsupported('Actual native modules and the built-in native executor are required.');
  if (typeof llm?.prepareCall !== 'function' || typeof llm.stream !== 'function' || typeof getLlmHookContext !== 'function' || typeof onStream !== 'function') throw unsupported('The actual public LLM facade, owning hook context and trusted admission hook are required.');
  if (typeof corePersona !== 'string' || !corePersona.trim() || Buffer.byteLength(corePersona) > 64 * 1024 || !Array.isArray(tools) || tools.length > 32) throw unsupported('Use a bounded approved core persona and explicitly owned typed tools.');
  const definitions = new Set(tools);
  if (tools.some((tool) => !tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function' || typeof tool.output?.render !== 'function') || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw unsupported('Every owned tool must have an exact unique definition, typed output and renderer.');
  let hookContext;
  try { hookContext = getLlmHookContext(); } catch { throw unsupported('The LLM owning hook context is unavailable.'); }
  if (!nativeModules.Context.is(hookContext) || typeof hookContext.on !== 'function' || hookContext?.then) throw unsupported('The LLM hook owner must be an actual synchronous native Cordis context.');
  const ctx = new nativeModules.Context();
  if (ctx.root === hookContext.root) throw unsupported('The isolated native runtime must have a distinct Cordis root.');
  const calls = new AsyncLocalStorage();
  const ownedAgents = new WeakSet();
  const handles = new Set(), creations = new Set();
  const fibers = [], toolDisposers = new Set();
  const presetId = `memory-native-${randomUUID()}`;
  let closed = false, retired = false, closeTask, unregisterPreset, removeHook;
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber;
    if (fiber.state !== 2) throw unsupported('A required actual native plugin did not activate.');
    return fiber;
  };
  const getCurrentCall = () => calls.getStore();
  const ownsAgent = (agent) => !closed && !!agent && ownedAgents.has(agent) && ctx.get('agents')?.get(agent.id) === agent;
  const ownsRequest = (options) => {
    const call = getCurrentCall();
    return !!call && call.request === options && ownsAgent(call.agent) && nativeModules.isAgentLoopRequest(call.request) && options?.sessionId === call.agent.session.id;
  };
  function wrapStream(makeStream, request, preparedConfig) {
    const agent = ctx.get('agents')?.get(request?.sessionId);
    if (!ownsAgent(agent) || !nativeModules.isAgentLoopRequest(request)) throw unsupported('Only a retained actual agent request may enter this isolated LLM facade.');
    const call = Object.freeze({ agent, request, preparedConfig, callId: randomUUID(), presetId });
    const iterable = calls.run(call, makeStream);
    const iterator = iterable[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() { return this; },
      next(value) { return calls.run(call, () => iterator.next(value)); },
      return(value) { return calls.run(call, () => iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value })); },
      throw(error) { return calls.run(call, () => iterator.throw ? iterator.throw(error) : Promise.reject(error)); },
    };
  }
  const facade = Object.freeze({
    async prepareCall(...args) {
      const prepared = await llm.prepareCall(...args);
      if (!prepared || typeof prepared.stream !== 'function' || !prepared.config) throw unsupported('The actual LLM did not return a public prepared call.');
      return Object.freeze({ ...prepared, stream: (request) => wrapStream(() => prepared.stream(request), request, prepared.config) });
    },
    stream(request) { return wrapStream(() => llm.stream(request), request); },
  });
  function registerTool(definition, scope = ctx) {
    const ownedScope = scope === ctx || [...handles].some(handle => handle.agent.ctx === scope && ownsAgent(handle.agent));
    if (closed || !ownedScope || definitions.size >= 32 || definitions.has(definition) || !definition || typeof definition.name !== 'string' || typeof definition.execute !== 'function' || typeof definition.output?.render !== 'function') throw unsupported('Register a distinct bounded typed definition in this root or an actual retained agent scope.');
    const unregister = scope.tools.register(definition);
    definitions.add(definition);
    let released = false, releasing;
    const finish = () => { released = true; definitions.delete(definition); toolDisposers.delete(release); };
    const release = () => {
      if (released) return;
      if (releasing) return releasing;
      const result = unregister();
      if (!result?.then) return finish();
      releasing = Promise.resolve(result).then(finish).finally(() => { releasing = undefined; });
      return releasing;
    };
    toolDisposers.add(release);
    return release;
  }
  async function releaseAgent(handle) {
    if (!handles.has(handle)) throw unsupported('Only a retained handle from this private root can be released.');
    await handle.dispose();
    if (ctx.agents.get(handle.agent.id) === handle.agent) throw unsupported('The actual agent registry did not acknowledge unload.');
    handles.delete(handle); ownedAgents.delete(handle.agent);
  }
  async function close() {
    closed = true;
    if (retired) return;
    if (!closeTask) closeTask = Promise.resolve().then(async () => {
      const failed = () => Object.assign(unsupported('An isolated native resource did not close cleanly; retain the original root and retry retirement.'), { hint: '原 Native 资源尚未确认卸载；保持 V1，保留原 Root 并重试退役，成功后再切换角色或账号。' });
      await Promise.allSettled([...creations]);
      for (const handle of [...handles]) {
        try { await releaseAgent(handle); } catch { throw failed(); }
      }
      for (const release of [...toolDisposers]) {
        try { await release(); } catch { throw failed(); }
      }
      try { if (unregisterPreset) { await unregisterPreset(); unregisterPreset = undefined; } } catch { throw failed(); }
      try { if (removeHook) { await removeHook(); removeHook = undefined; } } catch { throw failed(); }
      while (fibers.length) {
        try { await fibers.at(-1).dispose(); fibers.pop(); } catch { throw failed(); }
      }
      try { await ctx.fiber.dispose(); } catch { throw failed(); }
      calls.disable(); retired = true;
    });
    const task = closeTask;
    try { await task; } finally { if (closeTask === task) closeTask = undefined; }
  }

  try {
    ctx.reflect.provide('llm', facade);
    if (attachments !== undefined) ctx.reflect.provide('attachments', attachments);
    if (storage !== undefined) ctx.reflect.provide('sessionPersistence', storage);
    removeHook = hookContext.on('llm/stream', (options, next) => {
      if (!getCurrentCall()) return next(options);
      if (!ownsRequest(options)) throw unsupported('The borrowed LLM hook could not prove the isolated native caller.');
      return onStream(options, next, getCurrentCall());
    });
    await mount(nativeModules.SessionProjectionRegistry);
    await mount(nativeModules.SessionStore);
    await mount(nativeModules.AgentRegistry);
    await mount(nativeModules.SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    ctx.systemPrompt.section({ name: 'memory-approved-core-persona', order: 0, text: corePersona, interpolate: false, complete: true });
    await mount(nativeModules.ToolsService);
    for (const definition of tools) ctx.tools.register(definition);
    ctx.tools.guard((exec) => {
      const definition = ctx.tools.definitions(exec.agent, exec.toolSet).find((tool) => tool.name === exec.name);
      return ownsAgent(exec.agent) && definitions.has(definition) ? undefined : 'This private native scope only permits its exact owned tool definitions.';
    });
    await mount(nativeModules.Loader);
    ctx.loader.builtins['memory-owned-native-executor'] = nativeModules.nativeExecutor;
    await mount(nativeModules.AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await mount(nativeModules.AgentPresetRegistry, { default: presetId });
    unregisterPreset = await ctx.agentPresets.register({ id: presetId, name: 'Owned isolated memory agent', plugins: [{ id: 'memory-native-executor', name: 'cordis:memory-owned-native-executor', config: {} }] });
    return Object.freeze({
      ctx, getCurrentCall, ownsAgent, ownsRequest, registerTool, getLlmHookContext: () => hookContext,
      async createAgent({ provider, model, sessionId = `memory-native-${randomUUID()}`, setup } = {}) {
        if (closed || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model || typeof sessionId !== 'string' || !sessionId || setup !== undefined && typeof setup !== 'function') throw unsupported('Use a live isolated root and explicit exact session-local provider/model.');
        const creation = (async () => {
          const handle = await ctx.agents.create({ sessionId, agentOptions: { provider, model }, setup: async (agentCtx, agent) => {
            await ctx.agentPresets.mount(agentCtx, presetId);
            agent.model.select({ provider, model });
            if (setup) await setup(agentCtx, agent);
          } });
          handles.add(handle);
          if (closed || ctx.agents.get(handle.agent.id) !== handle.agent || ctx.agentPresets.composedPreset(handle.agent.ctx) !== presetId) {
            await releaseAgent(handle);
            throw unsupported('The isolated root closed during creation or its actual registry/private preset did not match.');
          }
          ownedAgents.add(handle.agent);
          return handle;
        })();
        creations.add(creation);
        try { return await creation; } finally { creations.delete(creation); }
      },
      releaseAgent, getStatus: () => ({ closed, retired, pendingCreations: creations.size, activeHandles: handles.size, activeTools: toolDisposers.size, pendingCleanup: retired ? 0 : creations.size + handles.size + toolDisposers.size + fibers.length + Number(!!unregisterPreset) + Number(!!removeHook) + 1 }), close,
    });
  } catch (error) {
    const failure = error?.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED' ? error : unsupported(`The isolated native graph failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
    try { await close(); } catch { Object.defineProperty(failure, 'retryCleanup', { value: close }); }
    throw failure;
  }
}
