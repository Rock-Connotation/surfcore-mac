import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createIsolatedNativeRoot } from '../lib/memory-v2-native-root.mjs';

function fixture(failStage, { asyncTool = false, failInit = false } = {}) {
  const attempts = new Map(), active = new Set();
  let hold, resume, creationHold, resumeCreation;
  const attempt = (stage) => {
    attempts.set(stage, (attempts.get(stage) ?? 0) + 1);
    if (stage === failStage && attempts.get(stage) === 1) throw new Error(`fixture ${stage} cleanup refused`);
    if (stage === 'hook' && hold) return hold.then(() => active.delete(stage));
    active.delete(stage);
  };
  class Context {
    static is(value) { return value instanceof Context; }
    constructor() {
      this.root = this;
      this.reflect = { provide: (name, value) => { this[name] = value; } };
      active.add('root');
      this.fiber = { dispose: () => attempt('root') };
    }
    get(name) { return this[name]; }
    plugin(plugin) {
      plugin(this);
      const stage = `fiber:${plugin.name}`;
      active.add(stage);
      return { state: 2, dispose: () => attempt(stage) };
    }
    on() { active.add('hook'); return () => attempt('hook'); }
  }
  const outer = new Context();
  active.clear();
  let preset;
  const nativeModules = {
    Context,
    SessionProjectionRegistry: function projections() {},
    SessionStore: function sessions() {},
    AgentRegistry: function agents(ctx) {
      const agents = new Map();
      ctx.agents = {
        get: id => agents.get(id),
        create: async ({ sessionId, setup }) => {
          const agent = { id: sessionId, session: { id: sessionId }, ctx: { tools: ctx.tools }, model: { select() {} } };
          await setup(agent.ctx, agent);
          if (creationHold) await creationHold;
          agents.set(sessionId, agent); active.add('agent');
          return { agent, dispose: async () => { attempt('agent'); agents.delete(sessionId); } };
        },
      };
    },
    SystemPrompt: function prompt(ctx) { ctx.systemPrompt = { section() {} }; },
    ToolsService: function tools(ctx) {
      if (failInit) throw new Error('fixture initialization refused');
      ctx.tools = {
        register: () => { active.add('tool'); return () => asyncTool ? Promise.resolve().then(() => attempt('tool')) : attempt('tool'); },
        guard() {},
      };
    },
    Loader: function loader(ctx) { ctx.loader = { builtins: {} }; },
    AgentLoop: function loop() {},
    AgentPresetRegistry: function presets(ctx) {
      ctx.agentPresets = {
        register: ({ id }) => { preset = id; active.add('preset'); return () => attempt('preset'); },
        mount() {}, composedPreset: () => preset,
      };
    },
    isAgentLoopRequest: () => false,
    nativeExecutor: { apply() {} },
  };
  return {
    attempts, active,
    blockHook() { hold = new Promise(resolve => { resume = resolve; }); },
    resumeHook() { resume(); },
    blockCreation() { creationHold = new Promise(resolve => { resumeCreation = resolve; }); },
    resumeCreation() { resumeCreation(); },
    create: () => createIsolatedNativeRoot({ nativeModules, llm: { prepareCall() {}, stream() {} }, getLlmHookContext: () => outer, corePersona: 'Fixture core.', onStream() {} }),
  };
}
const definition = () => ({ name: 'fixture_owned', execute() {}, output: { render() {} } });
for (const stage of ['agent', 'tool', 'preset', 'hook', 'fiber:presets', 'root']) {
  const f = fixture(stage), root = await f.create();
  await root.createAgent({ provider: 'fake', model: 'fake' });
  root.registerTool(definition());
  await assert.rejects(root.close(), error => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED' && !!error.error && !!error.hint);
  const pending = root.getStatus();
  assert.equal(pending.closed, true);
  await assert.rejects(root.createAgent({ provider: 'fake', model: 'fake' }));
  await root.close();
  assert.equal(f.active.size, 0, `${stage}: all owned resources acknowledged`);
  assert.equal(pending.retired, false);
  assert.ok(pending.pendingCleanup > 0);
  assert.equal(root.getStatus().retired, true);
  assert.equal(root.getStatus().pendingCleanup, 0);
  assert.equal(f.attempts.get(stage), 2);
  await root.close();
  assert.equal(f.attempts.get(stage), 2, 'completed cleanup does not repeat');
  console.log(`PASS retryable ${stage} teardown: blocked admission, retained cleanup and final ACK`);
}
for (const asyncTool of [false, true]) {
  const f = fixture('tool', { asyncTool }), root = await f.create();
  const release = root.registerTool(definition());
  if (asyncTool) await assert.rejects(release());
  else assert.throws(release);
  assert.equal(root.getStatus().activeTools, 1);
  await release();
  assert.equal(root.getStatus().activeTools, 0);
  await root.close(); assert.equal(f.active.size, 0);
  console.log(`PASS ${asyncTool ? 'async' : 'sync'} tool revocation retains the original disposer after failure`);
}
{
  const f = fixture(), root = await f.create(); f.blockHook();
  const first = root.close(), second = root.close();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(root.getStatus().closed, true);
  f.resumeHook(); await Promise.all([first, second]);
  assert.equal(f.attempts.get('hook'), 1);
  assert.equal(root.getStatus().retired, true); assert.equal(f.active.size, 0);
  console.log('PASS concurrent close coalesces cleanup and waits for actual hook ACK');
}
{
  const f = fixture('hook', { failInit: true });
  let failure;
  try { await f.create(); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'MEMORY_NATIVE_ROOT_UNSUPPORTED');
  assert.equal(typeof failure.retryCleanup, 'function');
  assert.ok(f.active.size > 0);
  assert.ok(!Object.keys(failure).includes('retryCleanup'), 'private cleanup capability is not a JSON field');
  await failure.retryCleanup(); assert.equal(f.active.size, 0);
  console.log('PASS initialization failure retains private cleanup capability until confirmed retirement');
}
{
  const source = fs.readFileSync(new URL('../lib/bili-v2-host.mjs', import.meta.url), 'utf8');
  const ensure = source.slice(source.indexOf('  async function ensureInstance('), source.indexOf('  async function enqueue('));
  const retire = source.slice(source.indexOf('  async function retire()'), source.indexOf('  async function withTransition('));
  const status = source.split('\n').find(line => line.includes('getStatus: () => Object.freeze')).trim().replace(/^getStatus: /, '').replace(/,$/, '');
  let attempts = 0;
  const cleanup = async () => { if (++attempts < 3) throw Object.assign(new Error('fixture cleanup pending'), { code: 'MEMORY_NATIVE_ROOT_UNSUPPORTED' }); };
  const failure = Object.assign(new Error('fixture failed initialization'), { code: 'MEMORY_NATIVE_ROOT_UNSUPPORTED' });
  Object.defineProperty(failure, 'retryCleanup', { value: cleanup });
  const create = vm.runInNewContext(`() => {
    let instance, creating, fault, retiring, probe, lastFailure, generation = 0;
    let closed = false, closing = false, transitioning = false, transitions = 0;
    const pending = new Map(), byJob = new Map(), targets = new Set(), publicSets = new Map();
    const preflights = new Set(), preflightHandles = new Set();
    function live() {} function releasePreflight() {}
    const report = error => ({ ok: false, code: error.code, error: error.message, hint: 'Retry the original retirement.' });
    ${ensure}\n${retire}
    return { ensureInstance, retire, getStatus: ${status} };
  }`, {
    ctx: {}, resourcesPath: '/synthetic', characterPaths: () => ({ persona: '/synthetic/core' }),
    fs: { readFileSync: () => 'Fixture approved core.' }, Buffer,
    // R09：ensureInstance 现在走共享 V2 人格编译入口；本用例只测初始化/退役
    // 清理状态机，桩掉编译结果，真实人格过滤由 test-v2-real-integration 覆盖。
    compileV2Persona: () => ({ ok: true, text: 'Fixture approved core.', digest: 'a'.repeat(64), chars: 24 }),
    loadMemoryV2NativeEnvironment: async () => ({}), createIsolatedNativeRoot: async () => { throw failure; },
  });
  const host = create();
  await assert.rejects(host.ensureInstance(0, { id: 'fixture', epoch: 1 }));
  assert.equal(host.getStatus().ok, false);
  assert.equal(host.getStatus().registeredSources, 0);
  assert.equal((await host.retire()).ok, false);
  assert.equal(host.getStatus().ok, false);
  assert.equal((await host.retire()).ok, true);
  assert.equal(host.getStatus().ok, true);
  assert.equal(attempts, 3);
  console.log('PASS actual Bili initialization/retire/status functions retain private Root cleanup until confirmed ACK');
}

{
  const f = fixture(), root = await f.create(); f.blockCreation();
  const creation = root.createAgent({ provider: 'fake', model: 'fake' }).then(value => ({ value }), error => ({ error }));
  let acknowledged = false;
  const closing = root.close().then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve));
  const early = acknowledged;
  f.resumeCreation();
  const result = await creation; await closing;
  assert.equal(early, false, 'retirement must await the original pending creation and unload');
  assert.ok(result.error, 'closing root refuses the pending new agent');
  assert.equal(root.getStatus().retired, true); assert.equal(f.active.size, 0);
  console.log('PASS close waits for pending agent creation and its unload before acknowledging retirement');
}
