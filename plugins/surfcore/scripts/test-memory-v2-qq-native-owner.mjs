import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createQQV2NativeOwner } from '../lib/qq-v2-native-owner.mjs';

function fixture() {
  const brands = new WeakSet(), all = [], counts = { provider: 0, reserve: 0, gate: 0, tokens: 0 }, errors = [];
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
    ToolsService(ctx) { const definitions = []; ctx.tools = { register: d => { definitions.push(d); return () => definitions.splice(definitions.indexOf(d), 1); }, guard() {}, definitions: () => [...definitions], schemas: () => definitions.map(({ name, description, parameters }) => structuredClone({ name, description, parameters })) }; },
    Loader(ctx) { ctx.loader = { builtins: {} }; }, AgentLoop() {},
    AgentPresetRegistry(ctx) { let preset; ctx.agentPresets = { register({ id }) { preset = id; return () => {}; }, mount() {}, composedPreset() { return preset; } }; },
    nativeExecutor: { apply() {} }, isAgentLoopRequest: options => brands.has(options),
  };
  const llm = { async prepareCall() { return { config: { provider: 'fake', model: 'one' }, stream: options => llm.stream(options) }; }, stream(options) { return hook(options, () => (async function* () { counts.provider++; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } }; })()); } };
  const budget = { isManagedAgentSession: () => false, async ensureReady() {}, reserveNativeAgentModelCall(request) { lastRequest = request; counts.reserve++; return { ok: true }; }, admitModelCall() { return deny ? { ok: false, code: 'BUDGET_DENIED', error: 'Denied.', hint: 'Inspect the budget.' } : { ok: true, send: true }; }, settleModelCall() { return { ok: true }; }, reconcileModelCall() { return { ok: true }; } };
  let approve = true;
  const sourceAuthority = { async prepareInput({ options }) { return approve && options.messages ? { ok: true, handle: {} } : { ok: false }; }, async validate() { return approve; }, async admitNetwork({ dispatch }) { counts.gate++; return dispatch(); } };
  const tool = { name: 'qq_read', description: 'fixture', parameters: { id: { type: 'string' } }, output: { render() {} }, async execute() {} };
  return { counts, errors, tool, sourceAuthority, budget, lastRequest: () => lastRequest, create: (override = {}) => createQQV2NativeOwner({ nativeModules, llm, getLlmHookContext: () => outer, corePersona: 'Fixture.', tools: [tool], tokenBudget: budget, getCharacter: () => role, provider: 'fake', model: 'one', estimatedTokens: 10, sourceAuthority, onAgentError: e => errors.push(e), ...override }),
    role(value) { role = value; }, deny() { deny = true; }, revoke() { approve = false; }, failClose() { failHook = true; }, mutateRoute() { currentAgent.model.select({ provider: 'fake', model: 'other' }); }, addForeign() { privateContext.tools.register({ ...tool, name: 'foreign' }); }, failInspection() { privateContext.tools.definitions = () => { throw new Error('fixture native inspection failed'); }; }, isHookActive: () => !!hook };
}
async function runOrdinary() {
const checks = [], failures = [];
async function test(name, run) { try { await run(); checks.push(name); console.log('PASS', name); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); } }
await test('exact owned session and preset are required', async () => { const f = fixture(), o = await f.create(); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: o.preset }), true); assert.equal(o.getSessionMemorySafety({ sessionId: 'fake', preset: o.preset }), false); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: 'fake' }), false); await o.retire(); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: o.preset }), false); });
await test('real middleware wraps owned request and serialized gate', async () => { const f = fixture(), o = await f.create(); await o.followup({ role: 'user', content: 'hello' }); assert.deepEqual(f.counts, { provider: 1, reserve: 1, gate: 1, tokens: 5 }); await o.retire(); });
await test('source authority denies before provider', async () => { const f = fixture(), o = await f.create(); f.revoke(); await assert.rejects(o.followup({ role: 'user' })); assert.equal(f.counts.provider, 0); await o.retire(); });
await test('budget denial prevents provider', async () => { const f = fixture(), o = await f.create(); f.deny(); await assert.rejects(o.followup({ role: 'user' })); assert.equal(f.counts.provider, 0); assert.equal(f.counts.gate, 0); await o.retire(); });
await test('role epoch and route changes fail closed', async () => { for (const mutate of [f => f.role({ id: 'whale', epoch: 2 }), f => f.mutateRoute()]) { const f = fixture(), o = await f.create(); mutate(f); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: o.preset }), false); assert.throws(() => o.followup({ role: 'user' })); assert.equal(f.counts.provider, 0); await o.retire(); } });
await test('foreign tool and schema mutations fail before provider', async () => { for (const mutate of [f => f.addForeign(), f => { f.tool.parameters.id.type = 'number'; }, f => { f.tool.execute = async () => 'replaced'; }, f => { f.tool.output.render = () => []; }]) { const f = fixture(), o = await f.create(); mutate(f); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: o.preset }), false); assert.throws(() => o.followup({ role: 'user' })); assert.equal(f.counts.provider, 0); await o.retire(); } });
await test('failed retirement remains blocked and retry acknowledges hook', async () => { const f = fixture(), o = await f.create(); f.failClose(); await assert.rejects(o.retire()); assert.equal(o.getStatus().retired, false); assert.ok(o.getStatus().pendingCleanup); assert.equal(f.isHookActive(), true); assert.equal(o.getSessionMemorySafety({ sessionId: o.sessionId, preset: o.preset }), false); assert.throws(() => o.followup({})); await o.retire(); assert.equal(o.getStatus().retired, true); assert.equal(o.getStatus().pendingCleanup, 0); assert.equal(f.isHookActive(), false); });
await test('changed actual input is denied after source preparation', async () => { const f = fixture(); f.sourceAuthority.prepareInput = async ({ options }) => { options.messages.push({ role: 'user', content: 'tampered' }); return { ok: true, handle: {} }; }; const o = await f.create(); await assert.rejects(o.followup({ role: 'user' })); assert.equal(f.counts.provider, 0); await o.retire(); });
await test('pricing is an isolated trusted snapshot', async () => { const f = fixture(), priceSnapshot = { reliable: true, rates: { input: 1 } }, o = await f.create({ priceSnapshot }); priceSnapshot.rates.input = 900; await o.followup({ role: 'user' }); assert.equal(f.lastRequest().priceSnapshot.rates.input, 1); await o.retire(); });
await test('missing source authority or explicit route is refused', async () => { const f = fixture(); for (const x of [{ sourceAuthority: null }, { provider: '' }, { estimatedTokens: 0 }]) await assert.rejects(f.create(x), e => e.code === 'QQ_NATIVE_OWNER_INVALID' && !!e.hint); });
for (const tools of [null, {}]) await test(`malformed tool list ${String(tools)} is structured`, async () => { const f = fixture(); await assert.rejects(f.create({ tools }), error => error.code === 'QQ_NATIVE_OWNER_INVALID' && !!error.error && !!error.hint); assert.equal(f.counts.provider, 0); });
for (const kind of ['character', 'inspection']) await test(`${kind} inspection exceptions are normalized`, async () => { const f = fixture(); let failing = false; const owner = await f.create(kind === 'character' ? { getCharacter: () => { if (failing) throw Error('fixture character unavailable'); return { id: 'whale', epoch: 1 }; } } : {}); try { if (kind === 'character') failing = true; else f.failInspection(); assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({}), error => error.code === 'QQ_NATIVE_SESSION_UNSAFE' && !!error.error && !!error.hint); assert.equal(f.counts.provider, 0); } finally { await owner.retire(); } });
for (const kind of ['execute', 'render']) await test(`inherited ${kind} change invalidates owner`, async () => { const f = fixture(); const executeProto = { async execute() {} }, renderProto = { render() {} }; const tool = Object.assign(Object.create(executeProto), { name: 'qq_read', description: 'fixture', parameters: { id: { type: 'string' } }, output: Object.create(renderProto) }); const owner = await f.create({ tools: [tool] }); try { assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), true); if (kind === 'execute') executeProto.execute = async () => 'changed'; else renderProto.render = () => []; assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({}), error => error.code === 'QQ_NATIVE_TOOLS_UNSAFE' && !!error.error && !!error.hint); assert.equal(f.counts.provider, 0); } finally { await owner.retire(); } });
if (failures.length) throw new Error(`${failures.length} ordinary scenarios failed: ${failures.join(', ')}`);
console.log(`PASS ${checks.length} QQ owner ordinary scenarios`);
}

export async function runNativeQQOwnerProbe(outer, moduleRoot, dshHome) {
  const load = (name) => import(pathToFileURL(path.join(moduleRoot, '@deepseek-ai', name, 'lib/index.js')).href);
  const names = ['cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'cordis-plugin-loader', 'dsh-agent-loop', 'dsh-agent-preset-registry', 'dsh-tool-executor-native', 'dsh-llm'];
  const [cordis, projections, sessions, agents, prompt, tools, loader, loop, presets, executor, llmModule] = await Promise.all(names.map(load));
  const privateRoots = [], fibers = [], owners = [], errors = [], calls = [], checks = [];
  class CapturingContext extends cordis.Context { constructor() { super(); privateRoots.push(this); } }
  const nativeModules = { Context: CapturingContext, SessionProjectionRegistry: projections.default, SessionStore: sessions.default, AgentRegistry: agents.default, SystemPrompt: prompt.default, ToolsService: tools.default, Loader: loader.default, AgentLoop: loop.default, AgentPresetRegistry: presets.default, nativeExecutor: executor, isAgentLoopRequest: llmModule.isAgentLoopRequest };
  const mount = async plugin => { const fiber = outer.plugin(plugin); fibers.push(fiber); await fiber; };
  let role = { id: 'whale', epoch: 1 }, allow = true, gates = 0, hookRegistrations = 0, hookRemovals = 0;
  const originalOn = outer.on;
  outer.on = function(name, callback, ...rest) { const off = originalOn.call(this, name, callback, ...rest); if (name !== 'llm/stream') return off; hookRegistrations++; return () => { const result = off(); hookRemovals++; return result; }; };
  const budget = createTokenBudgetService({ ctx: {}, dshHome, qqStateDir: path.join(dshHome, 'qq-fixture') });
  const limits = tokens => ({ qq: { cny: null, tokens }, bili: { cny: null, tokens: null }, other: { cny: null, tokens: null }, total: { cny: null, tokens: null } });
  const sourceAuthority = { async prepareInput({ options }) { assert.equal(llmModule.isAgentLoopRequest(options), true); return allow ? { ok: true, handle: {} } : { ok: false }; }, async validate() { return allow; }, async admitNetwork({ dispatch }) { gates++; return dispatch(); } };
  try {
    await mount(prompt.default); await mount(tools.default); await mount(llmModule.default);
    class FakeAdapter extends llmModule.LlmAdapter { async *stream(options) { calls.push({ provider: options.provider, model: options.model }); yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fake reply' } }; yield { type: 'finish', reason: { kind: 'stop' } }; } }
    const off = outer.get('llm').registerAdapter(['qq-fixture-provider'], new FakeAdapter());
    try {
      budget.saveLimits(limits(100));
      const tool = tools.defineTool({ name: 'qq_owned_test', description: 'fixture', parameters: { key: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => args.key });
      const make = async () => { const owner = await createQQV2NativeOwner({ nativeModules, llm: outer.get('llm'), getLlmHookContext: () => outer, corePersona: 'Owned QQ fixture.', tools: [tool], tokenBudget: budget, getCharacter: () => role, provider: 'qq-fixture-provider', model: 'exact-model', estimatedTokens: 20, sourceAuthority, onAgentError: error => errors.push(error) }); owners.push(owner); return owner; };
      const send = async (owner, text) => { owner.followup(llmModule.createUserMessage({ source: { kind: 'user-rpc', requestId: randomUUID() }, content: [{ type: 'text', text }] })); await owner.whenIdle(); };
      const owner = await make(), root = privateRoots.find(ctx => ctx.get('agents')?.get(owner.sessionId));
      assert.ok(root, 'actual owned registry must be present'); const registry = root.get('agents'), agent = registry.get(owner.sessionId);
      assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), true);
      assert.equal(owner.getSessionMemorySafety({ sessionId: 'foreign', preset: owner.preset }), false);
      await send(owner, 'one'); assert.equal(calls.length, 1, JSON.stringify(errors)); assert.equal(gates, 1); assert.deepEqual(calls[0], { provider: 'qq-fixture-provider', model: 'exact-model' });
      assert.equal((await budget.status()).usage.total.tokens, 15); checks.push('actual-owned-branded-request-route-budget-gate-and-15-tokens');
      allow = false; await send(owner, 'unproved'); assert.equal(calls.length, 1); allow = true; checks.push('source-authority-denial-before-provider');
      role = { id: 'whale', epoch: 2 }; assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); role = { id: 'whale', epoch: 1 }; checks.push('role-epoch-mismatch');
      agent.model.select({ provider: 'qq-fixture-provider', model: 'wrong-model' }); assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); agent.model.select({ provider: 'qq-fixture-provider', model: 'exact-model' }); checks.push('actual-selected-route-mismatch');
      const foreign = tools.defineTool({ name: 'foreign_scoped', description: 'foreign', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' });
      const release = agent.ctx.tools.register(foreign); assert.equal(owner.getSessionMemorySafety({ sessionId: owner.sessionId, preset: owner.preset }), false); assert.throws(() => owner.followup({})); release(); checks.push('foreign-scoped-definition-denied');
      await owner.retire(); assert.equal(registry.get(owner.sessionId), undefined); assert.equal(owner.getStatus().retired, true); assert.equal(owner.getStatus().pendingCleanup, 0); checks.push('native-unload-root-hook-ack');
      budget.saveLimits(limits(16)); const denied = await make(); await send(denied, 'budget-denied'); assert.equal(calls.length, 1, JSON.stringify(errors)); assert.equal(gates, 1); assert.ok(errors.some(error => error.code === 'BUDGET_LIMIT'), JSON.stringify(errors)); await denied.retire(); checks.push('real-budget-denial-before-gate-and-provider');
      assert.equal(hookRegistrations, hookRemovals); assert.deepEqual(globalThis.memoryGateDenied, []);
      return { ok: true, checks, fakeProviderCalls: calls.length, tokens: 15, gates, hookRegistrations, hookRemovals, sourceIntegration: false, bridgeIntegration: false };
    } finally { off(); }
  } finally {
    for (const owner of owners) await owner.retire();
    budget.dispose(); outer.on = originalOn;
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}

async function runNativeFixture() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const evidence = path.join(repo, '_backups/memory-v2-qq-native-owner');
  fs.mkdirSync(evidence, { recursive: true });
  let harness = fs.readFileSync(path.join(repo, 'scripts/test-memory-v2-host-runtime.mjs'), 'utf8');
  const replace = (from, to) => { assert.equal(harness.split(from).length, 2); harness = harness.replace(from, to); };
  replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-host-runtime');", `const root = ${JSON.stringify(evidence)};`);
  const start = harness.indexOf("create('project/probe.mjs', `"), end = harness.indexOf('\nconst env = {', start); assert.ok(start > 0 && end > start);
  const payload = `import { runNativeQQOwnerProbe } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\nexport const name='memory-runtime-probe';\nexport const inject=['webServer','connection'];\nexport async function apply(ctx,config){const profile=ctx.get('profileContext');if(profile.dir!==config.project||profile.home!==config.dshHome)throw new Error('fixture profile mismatch');const result=await runNativeQQOwnerProbe(ctx,${JSON.stringify('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules')},config.dshHome);process.send?.({type:'memory-runtime-probe',ok:result.ok,pid:process.pid,execPath:process.execPath,worker:result,denied:globalThis.memoryGateDenied});}`;
  harness = harness.slice(0, start) + `create('project/probe.mjs', ${JSON.stringify(payload)});\n` + harness.slice(end);
  const file = path.join(evidence, `host-harness-${randomUUID()}.mjs`); fs.writeFileSync(file, harness, { flag: 'wx' }); await import(pathToFileURL(file).href);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--native')) await runNativeFixture(); else await runOrdinary();
}
