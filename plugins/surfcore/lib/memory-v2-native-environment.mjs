import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGES = Object.freeze([
  'cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt',
  'dsh-tools', 'cordis-plugin-loader', 'dsh-agent-loop', 'dsh-agent-preset-registry',
  'dsh-tool-executor-native', 'dsh-llm',
]);
const CODEC = Object.freeze([
  'AssistantStreamAccumulator', 'BlockAssembler', 'createSystemMessage',
  'createUserMessage', 'createAssistantMessage', 'createToolResultMessage',
]);
const MODULE_FUNCTIONS = Object.freeze({
  Context: 'cordis.Context',
  SessionProjectionRegistry: 'dsh-session-projection.default',
  SessionStore: 'dsh-session.default',
  AgentRegistry: 'dsh-agent.default',
  SystemPrompt: 'dsh-system-prompt.default',
  ToolsService: 'dsh-tools.default',
  Loader: 'cordis-plugin-loader.default',
  AgentLoop: 'dsh-agent-loop.default',
  AgentPresetRegistry: 'dsh-agent-preset-registry.default',
  isAgentLoopRequest: 'dsh-llm.isAgentLoopRequest',
});

const unsupported = (error) => Object.assign(new Error(error), {
  ok: false, code: 'MEMORY_NATIVE_ROOT_UNSUPPORTED', error,
  hint: 'Keep V1 active; verify the packaged desktop Host resources, the real Cordis loader, the actual LLM owner and every fixed native export before enabling private execution.',
});

export async function loadMemoryV2NativeEnvironment({ ctx, resourcesPath = process.resourcesPath } = {}) {
  if (!ctx || typeof ctx !== 'object' || typeof ctx.get !== 'function' || !ctx.loader || typeof ctx.loader.import !== 'function' || !ctx.root) {
    throw unsupported('The packaged Host Cordis context with an active loader and root is required.');
  }
  if (typeof resourcesPath !== 'string' || !resourcesPath.trim() || !path.isAbsolute(resourcesPath) || /^[a-z][a-z0-9+.-]*:\/\//i.test(resourcesPath) || resourcesPath.split(/[\\/]/).includes('..')) {
    throw unsupported('A concrete absolute local resourcesPath is required; URLs, relative paths and traversal are not accepted.');
  }
  const moduleRoot = path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const modules = {};
  for (const name of PACKAGES) {
    const url = pathToFileURL(path.join(moduleRoot, name, 'lib', 'index.js')).href;
    let namespace;
    try { namespace = await ctx.loader.import(url); }
    catch (error) { throw unsupported(`Fixed native module ${name} could not be loaded: ${error instanceof Error ? error.message : String(error)}`); }
    if (!namespace || typeof namespace !== 'object') throw unsupported(`Fixed native module ${name} returned no module namespace.`);
    modules[name] = namespace;
  }
  const nativeModules = {};
  for (const [key, source] of Object.entries(MODULE_FUNCTIONS)) {
    const [name, exportName] = source.split('.');
    const value = modules[name]?.[exportName];
    if (typeof value !== 'function') throw unsupported(`Fixed native module ${name} is missing its ${exportName} export (${key}).`);
    nativeModules[key] = value;
  }
  const executor = modules['dsh-tool-executor-native'];
  if (!executor || typeof executor.apply !== 'function') throw unsupported('The built-in native executor namespace is missing its apply export.');
  nativeModules.nativeExecutor = executor;
  const dshLlm = modules['dsh-llm'];
  const nativeCodec = {};
  for (const key of CODEC) {
    if (typeof dshLlm[key] !== 'function') throw unsupported(`Fixed native module dsh-llm is missing its ${key} codec export.`);
    nativeCodec[key] = dshLlm[key];
  }
  const llm = ctx.get('llm');
  if (!llm || typeof llm.prepareCall !== 'function' || typeof llm.stream !== 'function') {
    throw unsupported('The actual Host LLM facade with prepareCall and stream is required.');
  }
  const owner = llm.ctx;
  if (!owner || !nativeModules.Context.is(owner) || typeof owner.on !== 'function' || owner.then || owner.root !== ctx.root) {
    throw unsupported('The LLM hook owner must be the real synchronous Cordis context on the same root as the Host context.');
  }
  return Object.freeze({
    nativeModules: Object.freeze(nativeModules),
    nativeCodec: Object.freeze(nativeCodec),
    llm,
    getLlmHookContext: () => owner,
  });
}
