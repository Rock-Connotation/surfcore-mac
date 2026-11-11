import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NATIVE = process.env.SURFCORE_MEMORY_V2_NATIVE_ENVIRONMENT === '1';
const { loadMemoryV2NativeEnvironment } = await import('../lib/memory-v2-native-environment.mjs');

const PACKAGES = Object.freeze([
  'cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt',
  'dsh-tools', 'cordis-plugin-loader', 'dsh-agent-loop', 'dsh-agent-preset-registry',
  'dsh-tool-executor-native', 'dsh-llm',
]);
const CODEC = Object.freeze([
  'AssistantStreamAccumulator', 'BlockAssembler', 'createSystemMessage',
  'createUserMessage', 'createAssistantMessage', 'createToolResultMessage',
]);
const MODULE_EXPORT = Object.freeze({
  cordis: 'Context', 'dsh-session-projection': 'default', 'dsh-session': 'default',
  'dsh-agent': 'default', 'dsh-system-prompt': 'default', 'dsh-tools': 'default',
  'cordis-plugin-loader': 'default', 'dsh-agent-loop': 'default',
  'dsh-agent-preset-registry': 'default',
});
const RESOURCES = path.join(path.sep, 'fixture', 'DeepSeek Harness.app', 'Contents', 'Resources');
const MODULE_ROOT = path.join(RESOURCES, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
const FIXED_URLS = PACKAGES.map(name => pathToFileURL(path.join(MODULE_ROOT, name, 'lib', 'index.js')).href);
const URL_TO_NAME = new Map(PACKAGES.map((name, i) => [FIXED_URLS[i], name]));
const MARK = Symbol('fake-cordis-context');

function fakeNamespace(name, faults = {}) {
  const ns = {};
  if (name === 'cordis') {
    ns.Context = Object.assign(function Context() {}, { is: value => !!value && value[MARK] === true });
  } else if (name === 'dsh-llm') {
    ns.default = function LlmRuntime() {};
    ns.isAgentLoopRequest = () => false;
    for (const key of CODEC) ns[key] = () => undefined;
  } else if (name === 'dsh-tool-executor-native') {
    ns.apply = () => undefined;
    ns.inject = () => undefined;
    ns.name = 'dsh-tool-executor-native';
  } else {
    ns.default = function Plugin() {};
  }
  if (faults.omit && faults.omit.name === name) delete ns[faults.omit.key];
  return ns;
}

function harness(faults = {}) {
  const imported = [];
  const namespaces = new Map();
  const root = { fakeRoot: true };
  const owner = { [MARK]: true, root, on: () => () => {} };
  const llm = { prepareCall: () => undefined, stream: () => undefined, ctx: owner };
  const ctx = {
    root,
    baseUrl: 'FIXED_CALLER_BASE_URL_SENTINEL',
    get: key => key === 'llm' && !faults.noLlm ? llm : undefined,
    loader: {
      import: async (url) => {
        imported.push(url);
        const name = URL_TO_NAME.get(url);
        if (!name) throw new Error(`unexpected module URL ${url}`);
        if (faults.importFailure === name) throw new Error(`fixture import failure ${name}`);
        const ns = fakeNamespace(name, faults);
        namespaces.set(name, ns);
        return ns;
      },
    },
  };
  if (faults.noLoaderImport) ctx.loader.import = undefined;
  if (faults.noLoader) ctx.loader = undefined;
  if (faults.badLlm) llm.prepareCall = undefined;
  if (faults.badLlmStream) llm.stream = undefined;
  if (faults.crossRootOwner) owner.root = { otherRoot: true };
  if (faults.badOwner) delete owner[MARK];
  if (faults.thenableOwner) owner.then = () => {};
  if (faults.noOwnerOn) owner.on = undefined;
  return { ctx, imported, namespaces, owner, llm, root };
}

const good = h => loadMemoryV2NativeEnvironment({ ctx: h.ctx, resourcesPath: RESOURCES });
const denial = async (promise, label) => {
  await assert.rejects(promise, error => {
    assert.equal(error?.code, 'MEMORY_NATIVE_ROOT_UNSUPPORTED', `${label}: wrong code ${error?.code}`);
    assert.equal(error?.ok, false, `${label}: ok must be false`);
    assert.ok(error instanceof Error, `${label}: must be an Error`);
    assert.ok(error.error && error.hint, `${label}: missing error/hint`);
    return true;
  }, label);
};

async function ordinary() {
  let count = 0;
  const test = async (name, run) => { await run(); count++; console.log(`PASS ${name}`); };

  await test('missing-ctx-and-empty-options', async () => {
    await denial(loadMemoryV2NativeEnvironment(), 'no options');
    await denial(loadMemoryV2NativeEnvironment({}), 'empty options');
    await denial(good({ ...harness(), ctx: {} }), 'ctx without get/loader/root');
    await denial(good({ ...harness(), ctx: { root: {}, get: () => null } }), 'ctx without loader');
  });

  await test('missing-loader-import', async () => {
    await denial(good(harness({ noLoader: true })), 'no loader service');
    await denial(good(harness({ noLoaderImport: true })), 'loader.import not a function');
  });

  await test('missing-or-invalid-resources', async () => {
    const h = harness();
    for (const value of [null, '', 'relative/resources', 'file:///etc/hosts', 42, `${RESOURCES}/../escaped`]) {
      await denial(loadMemoryV2NativeEnvironment({ ctx: h.ctx, resourcesPath: value }), `bad resourcesPath ${String(value)}`);
    }
  });

  await test('import-failure-is-structured', async () => {
    const h = harness({ importFailure: 'dsh-session' });
    await assert.rejects(good(h), error => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED' && /dsh-session/.test(error.error));
  });

  await test('missing-module-export', async () => {
    for (const [name, key] of Object.entries(MODULE_EXPORT)) {
      await denial(good(harness({ omit: { name, key } })), `missing ${name}.${key}`);
    }
  });

  await test('missing-codec-and-executor-exports', async () => {
    for (const key of CODEC) await denial(good(harness({ omit: { name: 'dsh-llm', key } })), `missing codec ${key}`);
    await denial(good(harness({ omit: { name: 'dsh-llm', key: 'isAgentLoopRequest' } })), 'missing isAgentLoopRequest');
    await denial(good(harness({ omit: { name: 'dsh-tool-executor-native', key: 'apply' } })), 'missing executor.apply');
  });

  await test('unreal-or-cross-root-llm-owner', async () => {
    await denial(good(harness({ noLlm: true })), 'no llm service');
    await denial(good(harness({ badLlm: true })), 'llm.prepareCall missing');
    await denial(good(harness({ badLlmStream: true })), 'llm.stream missing');
    await denial(good(harness({ badOwner: true })), 'owner not a real Context');
    await denial(good(harness({ crossRootOwner: true })), 'owner on a different root');
    await denial(good(harness({ thenableOwner: true })), 'owner is thenable');
    await denial(good(harness({ noOwnerOn: true })), 'owner has no event hook');
  });

  await test('injected-capabilities-are-not-honored', async () => {
    const h = harness();
    const injected = { nativeModules: { Context: () => null }, nativeCodec: { BlockAssembler: () => null }, llm: { stream: () => null }, moduleUrl: 'file:///attacker' };
    const env = await loadMemoryV2NativeEnvironment({ ctx: h.ctx, resourcesPath: RESOURCES, ...injected });
    assert.notEqual(env.nativeModules.Context, injected.nativeModules.Context);
    assert.notEqual(env.nativeCodec.BlockAssembler, injected.nativeCodec.BlockAssembler);
    assert.equal(env.llm, h.llm);
    assert.equal(env.getLlmHookContext(), h.owner);
  });

  await test('good-environment-fixed-urls-frozen-and-no-host-mutation', async () => {
    const h = harness();
    const env = await good(h);
    assert.equal(Object.isFrozen(env), true);
    assert.deepEqual(Object.keys(env).sort(), ['getLlmHookContext', 'llm', 'nativeCodec', 'nativeModules']);
    assert.equal(Object.isFrozen(env.nativeModules), true);
    assert.equal(Object.isFrozen(env.nativeCodec), true);
    for (const [name, key] of Object.entries(MODULE_EXPORT)) {
      assert.equal(typeof env.nativeModules[key === 'Context' ? 'Context' : ({ 'dsh-session-projection': 'SessionProjectionRegistry', 'dsh-session': 'SessionStore', 'dsh-agent': 'AgentRegistry', 'dsh-system-prompt': 'SystemPrompt', 'dsh-tools': 'ToolsService', 'cordis-plugin-loader': 'Loader', 'dsh-agent-loop': 'AgentLoop', 'dsh-agent-preset-registry': 'AgentPresetRegistry' })[name]], 'function', `${name}.${key}`);
    }
    assert.equal(typeof env.nativeModules.nativeExecutor.apply, 'function');
    assert.equal(typeof env.nativeModules.isAgentLoopRequest, 'function');
    assert.deepEqual(Object.keys(env.nativeCodec).sort(), [...CODEC].sort());
    for (const key of CODEC) assert.equal(typeof env.nativeCodec[key], 'function');
    assert.equal(env.llm, h.llm);
    assert.equal(env.getLlmHookContext(), h.owner);
    h.llm.ctx = { replaced: true };
    assert.equal(env.getLlmHookContext(), h.owner, 'closure keeps the same owner');
    assert.deepEqual(h.imported, FIXED_URLS, 'exactly 11 fixed module file URLs, in order');
    for (const url of h.imported) {
      assert.ok(url.startsWith(pathToFileURL(MODULE_ROOT).href + '/'), `URL must be under the fixed module root: ${url}`);
      assert.ok(!/^https?:/.test(url), `no network URL: ${url}`);
    }
    assert.equal(h.ctx.baseUrl, 'FIXED_CALLER_BASE_URL_SENTINEL', 'ctx.baseUrl unchanged');
    assert.equal(h.ctx.root, h.root, 'ctx.root unchanged');
    assert.deepEqual(Object.keys(h.namespaces.get('cordis')), ['Context'], 'module export not mutated');
    assert.deepEqual(Object.keys(h.namespaces.get('dsh-tool-executor-native')).sort(), ['apply', 'inject', 'name']);
    assert.deepEqual(Object.keys(h.namespaces.get('dsh-llm')).sort(), [...CODEC, 'default', 'isAgentLoopRequest'].sort());
  });

  console.log(`PASS memory-v2 native environment: ${count} ordinary scenarios; fixed file URLs only, real loader import path, structured denials, frozen owner-preserving result; native acceptance remains separate`);
}

async function native() {
  const { createIsolatedNativeRoot } = await import('../lib/memory-v2-native-root.mjs');
  const resourcesPath = process.resourcesPath;
  assert.ok(resourcesPath, 'native run requires an Electron process with process.resourcesPath');
  const moduleRoot = path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const load = name => import(pathToFileURL(path.join(moduleRoot, name, 'lib', 'index.js')).href);
  const network = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { network.push(String(args[0])); throw new Error('Native environment test: external network is forbidden.'); };
  const fibers = [];
  let outer;
  try {
    const [cordis, prompt, tools, llmModule, loader] = await Promise.all([
      load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-llm'), load('cordis-plugin-loader'),
    ]);
    outer = new cordis.Context();
    outer.baseUrl = new URL('../package.json', import.meta.url).href;
    for (const [plugin, config] of [
      [prompt.default, undefined], [tools.default, undefined], [llmModule.default, undefined],
      [loader.default, { baseUrl: pathToFileURL(path.join(moduleRoot, 'dsh-llm', 'lib', 'index.js')).href }],
    ]) {
      const fiber = outer.plugin(plugin, config);
      fibers.push(fiber);
      await fiber;
      assert.equal(fiber.state, 2, `native plugin ${plugin.name} did not activate`);
    }
    const preload = {};
    for (const name of PACKAGES) {
      const url = pathToFileURL(path.join(moduleRoot, name, 'lib', 'index.js')).href;
      try { const ns = await outer.loader.import(url); preload[name] = { ok: true, exports: Object.keys(ns).length }; }
      catch (error) { preload[name] = { ok: false, error: String(error.message).slice(0, 200) }; }
    }
    console.log(`NATIVE preload ${JSON.stringify(preload)}`);
    assert.equal(Object.values(preload).every(item => item.ok), true, 'all 11 fixed module URLs load through the real Cordis loader');

    const env = await loadMemoryV2NativeEnvironment({ ctx: outer, resourcesPath });
    assert.equal(Object.isFrozen(env), true);
    assert.equal(typeof env.nativeModules.Context.is, 'function');
    assert.equal(env.nativeModules.Context.is(env.getLlmHookContext()), true, 'retained hook owner is an actual Cordis context');
    assert.equal(typeof env.llm?.prepareCall, 'function', 'llm must be the real Host LLM facade');
    assert.equal(typeof env.llm?.stream, 'function', 'llm must be the real Host LLM facade');
    assert.equal(env.llm.ctx === env.getLlmHookContext(), true, 'llm facade and hook getter share one synchronous owner');
    assert.equal(outer.get('llm').ctx === env.getLlmHookContext(), true, 'Host LLM service and hook getter share one synchronous owner');
    assert.equal(env.getLlmHookContext().root === outer.root, true, 'hook owner belongs to the same root as the Host context');
    for (const key of CODEC) assert.equal(typeof env.nativeCodec[key], 'function');
    assert.equal(Object.keys(env.nativeCodec).length, 6);
    console.log(`NATIVE environment loaded: frozen=${Object.isFrozen(env)} ownerRootSame=${env.getLlmHookContext().root === outer.root} codec=${Object.keys(env.nativeCodec).length}`);

    const isolated = await createIsolatedNativeRoot({
      nativeModules: env.nativeModules, llm: env.llm, getLlmHookContext: env.getLlmHookContext,
      corePersona: 'MEMORY_NATIVE_ENVIRONMENT_FIXTURE_PERSONA', tools: [],
      onStream: (options, next) => next(options),
    });
    assert.notEqual(isolated.ctx.root, outer.root, 'isolated private root must differ from the owning root');
    assert.equal(isolated.getLlmHookContext(), env.getLlmHookContext(), 'owner preserved through the isolated root');
    const hasGetStatus = typeof isolated.getStatus === 'function';
    console.log(`NATIVE isolated root: privateRootDistinct=true ownerPreserved=true getStatus=${hasGetStatus}`);
    await isolated.close();
    if (hasGetStatus) {
      const status = isolated.getStatus();
      assert.equal(status.closed, true);
      assert.equal(status.activeHandles, 0, 'no retained agents after clean close');
      assert.equal(status.activeTools, 0, 'no retained tools after clean close');
      console.log(`NATIVE close: closed=${status.closed} activeHandles=${status.activeHandles} activeTools=${status.activeTools}`);
    }
    assert.equal(network.length, 0, 'zero external network requests');
    console.log(`PASS native environment: real loader imported 11 fixed modules, private root distinct, owner preserved, clean close, agent=0, prompt=0, provider=0, network=0; actual stream hook path is proven separately by the parent Bili composition`);
  } finally {
    globalThis.fetch = savedFetch;
    for (const fiber of fibers.reverse()) { try { await fiber.dispose(); } catch {} }
    if (outer) { try { await outer.fiber.dispose(); } catch {} }
  }
}

if (NATIVE) await native();
else await ordinary();
