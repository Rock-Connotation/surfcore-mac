import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createQQV2NativeOwner } from '../lib/qq-v2-native-owner.mjs';

function fixture() {
  const brands = new WeakSet(), all = [], counts = { provider: 0, reserve: 0, gate: 0, tokens: 0 }, errors = [];
  const guards = []; let preparedConfig = Object.freeze({ provider: "fake", model: "one", maxTokens: 10 });
  let hook, failHook = false, deny = false, lastRequest, role = { id: 'whale', epoch: 1 }, currentAgent, privateContext;
  class Context {
    static is(value) { return value instanceof Context; }
    constructor() { this.root = this; this.reflect = { provide: (key, value) => { this[key] = value; } }; this.fiber = { dispose() {} }; all.push(this); }
    get(key) { return this[key]; }
    plugin(plugin) { privateContext = this; plugin(this); return { state: 2, dispose() {} }; }
    on(name, fn) { if (name === 'llm/stream') { hook = fn; return () => { if (failHook) { failHook = false; throw Error('fixture hook'); } hook = undefined; }; } return () => {}; }
  }
  const outer = new Context();
  const nativeModules = {
    Context, SessionProjectionRegistry() {}, SessionStore() {},
    AgentRegistry(ctx) { const registry = new Map(); ctx.agents = { get: id => registry.get(id), create: async ({ sessionId, setup }) => {
      const model = { value: null, select(value) { this.value = value; }, current() { return this.value; } };
      const agent = { id: sessionId, session: { id: sessionId }, ctx: { tools: ctx.tools }, model, async whenIdle() { await this.running; }, followup(message) {
        const request = { sessionId, ...model.current(), messages: [message], toolHistory: [], tools: ctx.tools.schemas(agent) }; brands.add(request);
        this.running = (async () => { const prepared = await ctx.llm.prepareCall(); for await (const item of prepared.stream(request)) if (item.type === 'usage') counts.tokens += item.usage.inputTokens + item.usage.outputTokens; })(); return this.running;
      } };
      await setup(agent.ctx, agent); registry.set(sessionId, agent); currentAgent = agent;
      return { agent, dispose: async () => registry.delete(sessionId) };
    } }; },
    SystemPrompt(ctx) { ctx.systemPrompt = { section() {} }; },
    ToolsService(ctx) { const definitions = []; ctx.tools = { register: d => { definitions.push(d); return () => definitions.splice(definitions.indexOf(d), 1); }, guard(fn) { guards.push(fn); }, checkGuards(exec) { for (const guard of guards) { const result = guard(exec); if (result !== undefined) return result; } }, definitions: () => [...definitions], schemas: () => definitions.map(({ name, description, parameters }) => structuredClone({ name, description, parameters })) }; },
    Loader(ctx) { ctx.loader = { builtins: {} }; }, AgentLoop() {},
    AgentPresetRegistry(ctx) { let preset; ctx.agentPresets = { register({ id }) { preset = id; return () => {}; }, mount() {}, composedPreset() { return preset; } }; },
    nativeExecutor: { apply() {} }, isAgentLoopRequest: options => brands.has(options),
  };
  const llm = { async prepareCall() { return { config: preparedConfig, stream: options => llm.stream(options) }; }, stream(options) { return hook(options, () => (async function* () { counts.provider++; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; })()); } };
  const budget = { isManagedAgentSession: () => false, async ensureReady() {}, reserveNativeAgentModelCall(request) { lastRequest = request; counts.reserve++; return { ok: true }; }, admitModelCall() { return deny ? { ok: false, code: 'BUDGET_DENIED', error: 'Denied.', hint: 'Inspect the budget.' } : { ok: true, send: true }; }, settleModelCall() { return { ok: true }; }, reconcileModelCall() { return { ok: true }; } };
  let approve = true;
  const sourceAuthority = { async prepareInput({ options }) { return approve && options.messages ? { ok: true, handle: {} } : { ok: false }; }, async validate() { return approve; }, async admitNetwork({ dispatch }) { counts.gate++; return dispatch(); } };
  const tool = { name: 'qq_read', description: 'fixture', parameters: { id: { type: 'string' } }, output: { render() {} }, async execute() {} };
  return { counts, errors, tool, sourceAuthority, budget, lastRequest: () => lastRequest, create: (override = {}) => createQQV2NativeOwner({ nativeModules, llm, getLlmHookContext: () => outer, corePersona: 'Fixture.', tools: [tool], tokenBudget: budget, getCharacter: () => role, provider: 'fake', model: 'one', estimatedTokens: 10, sourceAuthority, onAgentError: e => errors.push(e), ...override }),
    agent: () => currentAgent, config: () => preparedConfig, configValue: value => { preparedConfig = value; },
    checkGuards: exec => privateContext.tools.checkGuards(exec),
    async stream(message = { role: 'user', content: 'hello' }) { const agent = currentAgent; const request = { sessionId: agent.session.id, ...agent.model.current(), messages: [message], toolHistory: [], tools: privateContext.tools.schemas(agent) }; brands.add(request); const prepared = await privateContext.llm.prepareCall(); return prepared.stream(request); },
    role(value) { role = value; }, deny() { deny = true; }, revoke() { approve = false; }, failClose() { failHook = true; }, mutateRoute() { currentAgent.model.select({ provider: 'fake', model: 'other' }); }, addForeign() { privateContext.tools.register({ ...tool, name: 'foreign' }); }, failInspection() { privateContext.tools.definitions = () => { throw new Error('fixture native inspection failed'); }; }, isHookActive: () => !!hook };
}

async function runOrdinary() {
const checks = [], failures = [];
async function test(name, run) { try { await run(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); } }
const rejectOutput = error => error?.code === 'QQ_NATIVE_OUTPUT_UNPROVEN' && !!error.error && !!error.hint && !JSON.stringify({ error: error.error, hint: error.hint }).includes('SECRET');
function execution(f, owner) { return { agent: f.agent(), name: f.tool.name, callId: 'call-1', token: Symbol('native'), arguments: { id: 'one' }, signal: new AbortController().signal }; }
await test('observes complete actual stream in sequence with original config', async () => {
  const f = fixture(), events = []; f.sourceAuthority.captureModelOutput = async event => { events.push(event); return true; };
  const owner = await f.create(); await owner.followup({ role: 'user', content: 'x' });
  assert.deepEqual(events.map(e => e.phase), ['start', 'chunk', 'complete']);
  assert.equal(new Set(events.map(e => e.dispatchId)).size, 1); assert.ok(events[0].dispatchId);
  assert.ok(events.every(e => e.options === events[0].options && e.request === events[0].request && e.preparedConfig === f.config()));
  await owner.followup({ role: 'user', content: 'y' }); assert.notEqual(events[0].dispatchId, events[3].dispatchId); await owner.retire();
});
for (const mode of ['denial', 'throw']) await test(`chunk ${mode} hides chunk and normalizes errors`, async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase }) => { phases.push(phase); if (phase === 'chunk') { if (mode === 'throw') throw Error('SECRET'); return false; } return { ok: true }; };
  const owner = await f.create(); const iterator = (await f.stream())[Symbol.asyncIterator](); await assert.rejects(iterator.next(), rejectOutput);
  assert.deepEqual(phases, ['start', 'chunk', 'failed']); await owner.retire();
});
await test('iterator return fails once without false completion', async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase }) => { phases.push(phase); return true; };
  const owner = await f.create(); const iterator = (await f.stream())[Symbol.asyncIterator](); assert.equal((await iterator.next()).done, false); await iterator.return();
  assert.deepEqual(phases, ['start', 'chunk', 'failed']); await owner.retire();
});
await test('start and complete denial are structured with single failed callback', async () => {
  for (const denied of ['start', 'complete']) { const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase }) => { phases.push(phase); return phase !== denied; }; const owner = await f.create();
    await assert.rejects(owner.followup({ role: 'user' }), rejectOutput); assert.equal(phases.filter(x => x === 'failed').length, 1); await owner.retire(); }
});
await test('prepared config is original across authority callbacks and mutation blocks provider', async () => {
  const f = fixture(), seen = []; f.sourceAuthority.prepareInput = async ({ preparedConfig }) => { seen.push(preparedConfig); preparedConfig.maxTokens = 11; return { ok: true, handle: {} }; };
  const owner = await f.create(); await assert.rejects(owner.followup({ role: 'user' })); assert.equal(seen[0], f.config()); assert.equal(f.counts.provider, 0); await owner.retire();
});
await test('tool witness rejects unknown, copied, mutations, and after retirement', async () => {
  const f = fixture(), owner = await f.create(), exec = execution(f, owner); assert.equal(owner.validateOwnedToolContext(exec).ok, false);
  assert.equal(f.checkGuards(exec), undefined); assert.equal(owner.validateOwnedToolContext(exec).ok, true);
  const copy = { ...exec }; assert.equal(owner.validateOwnedToolContext(copy).ok, false);
  const original = exec.callId; exec.callId = 'other'; assert.equal(owner.validateOwnedToolContext(exec).ok, false); exec.callId = original;
  exec.arguments.id = 'changed'; assert.equal(owner.validateOwnedToolContext(exec).ok, false); exec.arguments.id = 'one';
  const originalAgent = exec.agent; exec.agent = {}; assert.equal(owner.validateOwnedToolContext(exec).ok, false); exec.agent = originalAgent;
  await owner.retire(); const failure = owner.validateOwnedToolContext(exec); assert.equal(failure.code, 'QQ_NATIVE_TOOL_EXECUTION_UNPROVEN'); assert.ok(failure.error && failure.hint);
});
await test('privileged checkGuards copy illustrates explicitly limited claim', async () => {
  const f = fixture(), owner = await f.create(), exec = execution(f, owner); assert.equal(f.checkGuards(exec), undefined); const copy = { ...exec };
  assert.equal(owner.validateOwnedToolContext(copy).ok, false); assert.equal(f.checkGuards(copy), undefined); assert.equal(owner.validateOwnedToolContext(copy).ok, true); await owner.retire();
});
await test('observer mutation of actual chunk fails before yield', async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase, chunk }) => { phases.push(phase); if (phase === 'chunk') chunk.type = 'tampered'; return true; };
  const owner = await f.create(); const iterator = (await f.stream())[Symbol.asyncIterator](); await assert.rejects(iterator.next(), rejectOutput); assert.deepEqual(phases, ['start', 'chunk', 'failed']); await owner.retire();
});
await test('input mutation reports failed once and never reaches provider', async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase }) => { phases.push(phase); return true; };
  f.sourceAuthority.prepareInput = async ({ options }) => { options.messages.push({ role: 'user', content: 'tampered' }); return { ok: true, handle: {} }; };
  const owner = await f.create(); await assert.rejects(owner.followup({ role: 'user' })); assert.deepEqual(phases, ['start', 'failed']); assert.equal(f.counts.provider, 0); await owner.retire();
});
await test('observer configuration mutation is denied without exposing secrets', async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase, preparedConfig }) => { phases.push(phase); if (phase === 'chunk') preparedConfig.maxTokens = 12; return true; };
  const owner = await f.create(); const iterator = (await f.stream())[Symbol.asyncIterator](); await assert.rejects(iterator.next(), rejectOutput); assert.deepEqual(phases, ['start', 'chunk', 'failed']); await owner.retire();
});
await test('iterator cancellation sends one failed phase', async () => {
  const f = fixture(), phases = []; f.sourceAuthority.captureModelOutput = async ({ phase }) => { phases.push(phase); return true; };
  const owner = await f.create(), iterator = (await f.stream())[Symbol.asyncIterator](); await iterator.next(); await assert.rejects(iterator.throw(Error('cancel'))); assert.deepEqual(phases, ['start', 'chunk', 'failed']); await owner.retire();
});
await test('invalidated witness remains denied after restoration', async () => {
  const f = fixture(), owner = await f.create(), exec = execution(f, owner); f.checkGuards(exec); assert.equal(owner.validateOwnedToolContext(exec).ok, true); const token = exec.token; exec.token = Symbol('different'); assert.equal(owner.validateOwnedToolContext(exec).ok, false); exec.token = token; assert.equal(owner.validateOwnedToolContext(exec).ok, false); await owner.retire();
});
await test('authority receives original config during validation and gate', async () => {
  const f = fixture(), seen = []; f.sourceAuthority.prepareInput = async ({ preparedConfig }) => { seen.push(preparedConfig); return { ok: true, handle: {} }; }; f.sourceAuthority.validate = async ({ preparedConfig }) => { seen.push(preparedConfig); return true; }; f.sourceAuthority.admitNetwork = async ({ preparedConfig, dispatch }) => { seen.push(preparedConfig); return dispatch(); };
  const owner = await f.create(); await owner.followup({ role: 'user' }); assert.ok(seen.length >= 3); assert.ok(seen.every(config => config === f.config())); await owner.retire();
});
await test('mutable prepared config is locked before source work', async () => {
  const f = fixture(); f.configValue({ provider: 'fake', model: 'one', nested: { limit: 5 } }); let seen; f.sourceAuthority.prepareInput = async ({ preparedConfig }) => { seen = preparedConfig; assert.ok(Object.isFrozen(preparedConfig)); assert.ok(Object.isFrozen(preparedConfig.nested)); return { ok: true, handle: {} }; }; const owner = await f.create(); await owner.followup({ role: 'user' }); assert.equal(seen, f.config()); await owner.retire();
});
if (failures.length) throw new Error(`${failures.length} observation scenarios failed: ${failures.join(', ')}`);
console.log(`PASS ${checks.length} QQ observation ordinary scenarios`);
}

export async function runNativeQQObservationProbe(outer, moduleRoot, dshHome) {
  const load = (name) => import(pathToFileURL(path.join(moduleRoot, '@deepseek-ai', name, 'lib/index.js')).href);
  const names = ['cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'cordis-plugin-loader', 'dsh-agent-loop', 'dsh-agent-preset-registry', 'dsh-tool-executor-native', 'dsh-llm'];
  const [cordis, projections, sessions, agents, prompt, tools, loader, loop, presets, executor, llmModule] = await Promise.all(names.map(load));
  const privateRoots = [], fibers = [], owners = [], errors = [], calls = [], checks = [];
  class CapturingContext extends cordis.Context { constructor() { super(); privateRoots.push(this); } }
  const nativeModules = { Context: CapturingContext, SessionProjectionRegistry: projections.default, SessionStore: sessions.default, AgentRegistry: agents.default, SystemPrompt: prompt.default, ToolsService: tools.default, Loader: loader.default, AgentLoop: loop.default, AgentPresetRegistry: presets.default, nativeExecutor: executor, isAgentLoopRequest: llmModule.isAgentLoopRequest };
  const mount = async plugin => { const fiber = outer.plugin(plugin); fibers.push(fiber); await fiber; };
  let role = { id: 'whale', epoch: 1 }, allow = true, gates = 0, hookRegistrations = 0, hookRemovals = 0, owner, executions = 0; const observed = [];
  const originalOn = outer.on;
  outer.on = function(name, callback, ...rest) { const off = originalOn.call(this, name, callback, ...rest); if (name !== 'llm/stream') return off; hookRegistrations++; return () => { const result = off(); hookRemovals++; return result; }; };
  const budget = createTokenBudgetService({ ctx: {}, dshHome, qqStateDir: path.join(dshHome, 'qq-fixture') });
  const limits = tokens => ({ qq: { cny: null, tokens }, bili: { cny: null, tokens: null }, other: { cny: null, tokens: null }, total: { cny: null, tokens: null } });
  const sourceAuthority = { async prepareInput({ options }) { assert.equal(llmModule.isAgentLoopRequest(options), true); return allow ? { ok: true, handle: {} } : { ok: false }; }, async validate() { return allow; }, async admitNetwork({ dispatch }) { gates++; return dispatch(); }, async captureModelOutput(event) { assert.equal(llmModule.isAgentLoopRequest(event.options), true); assert.ok(event.preparedConfig); observed.push({ phase: event.phase, id: event.dispatchId }); return true; } };
  try {
    await mount(prompt.default); await mount(tools.default); await mount(llmModule.default);
    class FakeAdapter extends llmModule.LlmAdapter { async *stream(options) { calls.push({ provider: options.provider, model: options.model }); yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; if (calls.length === 1) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'native-call-1', name: 'qq_owned_test', arguments: JSON.stringify({ key: 'value' }) } }; else yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fake reply' } }; yield { type: 'finish', reason: { kind: 'stop' } }; } }
    const off = outer.get('llm').registerAdapter(['qq-fixture-provider'], new FakeAdapter());
    try {
      budget.saveLimits(limits(100));
      const tool = tools.defineTool({ name: 'qq_owned_test', description: 'fixture', parameters: { key: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async (args, exec) => { executions++; assert.equal(owner.validateOwnedToolContext(exec).ok, true); const copy = { ...exec }; assert.equal(owner.validateOwnedToolContext(copy).ok, false); exec.agent.ctx.tools.checkGuards(copy); assert.equal(owner.validateOwnedToolContext(copy).ok, true); return args.key; } });
      const make = async () => { const owner = await createQQV2NativeOwner({ nativeModules, llm: outer.get('llm'), getLlmHookContext: () => outer, corePersona: 'Owned QQ fixture.', tools: [tool], tokenBudget: budget, getCharacter: () => role, provider: 'qq-fixture-provider', model: 'exact-model', estimatedTokens: 20, sourceAuthority, onAgentError: error => errors.push(error) }); owners.push(owner); return owner; };
      const send = async (owner, text) => { owner.followup(llmModule.createUserMessage({ source: { kind: 'user-rpc', requestId: randomUUID() }, content: [{ type: 'text', text }] })); await owner.whenIdle(); };
      owner = await make(); const root = privateRoots.find(ctx => ctx.get('agents')?.get(owner.sessionId));
      assert.ok(root, 'actual owned registry must be present'); const registry = root.get('agents'), agent = registry.get(owner.sessionId);
      assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), true);
      assert.equal(owner.getSessionMemorySafety({ sessionId: 'foreign', preset: owner.preset }), false);
      await send(owner, 'one'); assert.equal(calls.length, 2, JSON.stringify(errors)); assert.equal(gates, 2); assert.equal(executions, 1); assert.deepEqual(calls[0], { provider: 'qq-fixture-provider', model: 'exact-model' }); assert.equal(observed.filter(e => e.phase === 'start').length, 2); assert.equal(observed.filter(e => e.phase === 'complete').length, 2); assert.equal(new Set(observed.filter(e => e.phase === 'start').map(e => e.id)).size, 2); checks.push('actual-tool-execution-private-context-and-guard-probe-limitation');
      assert.equal((await budget.status()).usage.total.tokens, 30); checks.push('actual-owned-branded-request-route-budget-gate-and-30-tokens');
      allow = false; await send(owner, 'unproved'); assert.equal(calls.length, 2); allow = true; checks.push('source-authority-denial-before-provider');
      role = { id: 'whale', epoch: 2 }; assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); role = { id: 'whale', epoch: 1 }; checks.push('role-epoch-mismatch');
      agent.model.select({ provider: 'qq-fixture-provider', model: 'wrong-model' }); assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); agent.model.select({ provider: 'qq-fixture-provider', model: 'exact-model' }); checks.push('actual-selected-route-mismatch');
      const foreign = tools.defineTool({ name: 'foreign_scoped', description: 'foreign', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' });
      const release = agent.ctx.tools.register(foreign); assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); release(); checks.push('foreign-scoped-definition-denied');
      await owner.retire(); assert.equal(registry.get(owner.sessionId), undefined); assert.equal(owner.getStatus().retired, true); assert.equal(owner.getStatus().pendingCleanup, 0); checks.push('native-unload-root-hook-ack');
      budget.saveLimits(limits(31)); const denied = await make(); await send(denied, 'budget-denied'); assert.equal(calls.length, 2, JSON.stringify(errors)); assert.equal(gates, 2); assert.ok(errors.some(error => error.code === 'BUDGET_LIMIT'), JSON.stringify(errors)); await denied.retire(); checks.push('real-budget-denial-before-gate-and-provider');
      assert.equal(hookRegistrations, hookRemovals); assert.deepEqual(globalThis.memoryGateDenied, []);
      return { ok: true, checks, fakeProviderCalls: calls.length, tokens: 30, gates, hookRegistrations, hookRemovals, sourceIntegration: false, bridgeIntegration: false };
    } finally { off(); }
  } finally {
    for (const owner of owners) await owner.retire();
    budget.dispose(); outer.on = originalOn;
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}

async function runNativeFixture() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const evidence = path.join(repo, '_backups/memory-v2-qq-native-observation');
  fs.mkdirSync(evidence, { recursive: true });
  let harness = fs.readFileSync(path.join(repo, 'scripts/test-memory-v2-host-runtime.mjs'), 'utf8');
  const replace = (from, to) => { assert.equal(harness.split(from).length, 2); harness = harness.replace(from, to); };
  replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-host-runtime');", `const root = ${JSON.stringify(evidence)};`);
  const start = harness.indexOf("create('project/probe.mjs', `"), end = harness.indexOf('\nconst env = {', start); assert.ok(start > 0 && end > start);
  const payload = `import { runNativeQQObservationProbe } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\nexport const name='memory-runtime-probe';\nexport const inject=['webServer','connection'];\nexport async function apply(ctx,config){const profile=ctx.get('profileContext');if(profile.dir!==config.project||profile.home!==config.dshHome)throw new Error('fixture profile mismatch');const result=await runNativeQQObservationProbe(ctx,${JSON.stringify('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules')},config.dshHome);process.send?.({type:'memory-runtime-probe',ok:result.ok,pid:process.pid,execPath:process.execPath,worker:result,denied:globalThis.memoryGateDenied});}`;
  harness = harness.slice(0, start) + `create('project/probe.mjs', ${JSON.stringify(payload)});\n` + harness.slice(end);
  const file = path.join(evidence, `host-harness-${randomUUID()}.mjs`); fs.writeFileSync(file, harness, { flag: 'wx' }); await import(pathToFileURL(file).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--native')) await runNativeFixture(); else await runOrdinary();
}
