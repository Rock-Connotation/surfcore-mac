import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createBiliV2AgentRuntime, biliV2InputDigest } from '../lib/bili-v2-agent.mjs';
import { createIsolatedNativeRoot } from '../lib/memory-v2-native-root.mjs';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { decodeBiliV2Request, BILI_V2_ENDPOINTS } from '../tools/lib/bili-v2-dispatch.mjs';

const root = fileURLToPath(new URL('../../../_backups/memory-v2-bili-agent/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, `run-${process.version}-${process.pid}-`));
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const coded = (error, code) => { assert.equal(error.code, code); assert.ok(error.error); assert.ok(error.hint); return true; };
const collect = async (source) => { const values = []; for await (const value of source) values.push(value); return values; };
const native = process.env.SURFCORE_BILI_ACTUAL_HOST_FIXTURE === '1';
const ordinaryOnly = process.argv.includes('--ordinary');
let actual;
if (native) {
  const require = createRequire(import.meta.url), base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/';
  actual = { ...require(base + '@deepseek-ai/cordis'), ...require(base + '@deepseek-ai/dsh-tools'), ...require(base + '@deepseek-ai/dsh-tools/lib/pipeline.js'), ...require(base + '@deepseek-ai/dsh-tool-executor-native'), ...require(base + '@deepseek-ai/dsh-scope'), ...require(base + '@deepseek-ai/dsh-llm') };
}

async function isolatedRootFixture() {
  const base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
  const require = createRequire(import.meta.url), load = (name) => require(base + name + '/lib/index.js');
  const nativeModules = { Context: actual.Context, SessionProjectionRegistry: load('dsh-session-projection').default, SessionStore: load('dsh-session').default, AgentRegistry: load('dsh-agent').default, SystemPrompt: load('dsh-system-prompt').default, ToolsService: actual.ToolsService, Loader: load('cordis-plugin-loader').default, AgentLoop: load('dsh-agent-loop').default, AgentPresetRegistry: load('dsh-agent-preset-registry').default, nativeExecutor: load('dsh-tool-executor-native'), isAgentLoopRequest: actual.isAgentLoopRequest };
  const dir = fs.mkdtempSync(path.join(evidence, 'isolated-root-')), commandsDir = path.join(dir, 'commands'); fs.mkdirSync(commandsDir);
  fs.writeFileSync(path.join(commandsDir, 'feed.mjs'), 'console.log(JSON.stringify({text:"owned fixture source"}))');
  const outer = new actual.Context(), fibers = [], providerRequests = [], phases = [], errors = [], deniedNetwork = [];
  let ownedRoot, runtime, retained, typedExecuted = false, ownerObserved = false, outerNetwork = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { deniedNetwork.push(String(args[0])); throw new Error('External network is forbidden in this fixture.'); };
  const budget = createTokenBudgetService({ ctx: {}, dshHome: dir, qqStateDir: path.join(dir, 'qq') });
  const deadline = async (promise) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('isolated Bili fixture deadline exceeded')), 12000); })]); } finally { clearTimeout(timer); } };
  try {
    for (const plugin of [nativeModules.SystemPrompt, nativeModules.ToolsService, load('dsh-llm').default]) { const fiber = outer.plugin(plugin); fibers.push(fiber); await fiber; }
    outer.systemPrompt.section({ name: 'bili-unsafe-ancestor', text: 'UNSAFE_BILI_ANCESTOR_AGENTS', order: 0 });
    outer.systemPrompt.context({ name: 'bili-unsafe-required', text: 'UNSAFE_BILI_ANCESTOR_HEADER', required: true, order: 0 });
    outer.on('agent/pre-step', async (state, next) => next({ ...state, messages: [actual.createDeveloperMessage({ content: [{ type: 'text', text: 'UNSAFE_BILI_ANCESTOR_PRESTEP' }] }), ...state.messages] }));
    class FakeProvider extends actual.LlmAdapter {
      async *stream(options) {
        providerRequests.push(JSON.parse(JSON.stringify(options)));
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CONTROLLED_BILI_PROVIDER_OUTPUT' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    outer.llm.registerAdapter(['bili-owned-fixture'], new FakeProvider());
    ownedRoot = await createIsolatedNativeRoot({ nativeModules, llm: outer.llm, getLlmHookContext: () => outer, corePersona: 'APPROVED_NATIVE_BILI_CORE', onStream: (options, next, call) => { assert.equal(ownedRoot.ownsRequest(options), true); assert.equal(ownedRoot.ownsAgent(call.agent), true); ownerObserved = true; return next(options); } });
    ownedRoot.ctx.on('agent/error', ({ error }) => errors.push({ code: error?.code, message: error?.message }));
    const route = { provider: 'bili-owned-fixture', model: 'exact-bili-model' }, providerRouteId = deriveMemoryProviderRouteId(route).providerRouteId;
    const sourceRuntime = {
      async preparePrompt() { return { ok: true, handle: {}, content: [{ type: 'text', text: 'OWNED_BILI_FIRST_PROMPT' }] }; },
      async prepareInput({ job, options, signal }) {
        const call = ownedRoot.getCurrentCall(); retained = call.agent;
        assert.equal(call.request, options); assert.equal(ownedRoot.ctx.agents.get(job.sessionId), retained); assert.notEqual(retained.ctx.root, outer.root);
        assert.equal(ownedRoot.getLlmHookContext(), outer); assert.deepEqual(retained.model.current(), route);
        assert.ok(!JSON.stringify(options).includes('UNSAFE_BILI_ANCESTOR'));
        const allowed = await ownedRoot.ctx.tools.execute({ calls: [{ id: 'owned-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) }], agent: retained, signal });
        assert.notEqual(allowed.results[0].result.isError, true, JSON.stringify(allowed));
        const blocked = await ownedRoot.ctx.tools.execute({ calls: [{ id: 'unknown-shell', name: 'bash', arguments: JSON.stringify({ command: 'must never run' }) }], agent: retained, signal });
        assert.equal(blocked.results[0].result.isError, true); typedExecuted = true;
        return { ok: true, handle: {} };
      },
      async validate() { return true; },
      async captureModelOutput({ options, phase }) { assert.equal(options, ownedRoot.getCurrentCall().request); phases.push(phase); if (phase === 'complete') assert.equal((await budget.status()).usage.total.tokens, 15); return true; },
      async captureToolResult({ result }) { assert.ok(result.stdout.includes('owned fixture source')); return { ok: true, result: { text: 'owned fake source result' } }; },
      async prepareSend() { throw new Error('No write is expected.'); },
    };
    runtime = createBiliV2AgentRuntime({ ctx: outer, nativeRoot: ownedRoot, memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }), adapter: { withNetworkAdmission: (_handle, dispatch) => dispatch() } }, getCharacter: () => ({ id: 'whale', epoch: 4 }), tokenBudget: budget, isAgentLoopRequest: actual.isAgentLoopRequest, sourceRuntime, modelRequest: () => ({ estimatedTokens: 100 }), getModelRoute: async () => ({ ...route, providerRouteId }), transport: { send() { outerNetwork++; throw new Error('No platform write is expected.'); } }, registryPath: path.join(dir, 'denial.json'), commandsDir, onBlocked: (error) => errors.push(error) });
    const accepted = await deadline(runtime.enqueue({ requestId: 'actual-root-first', input: { kind: 'comment-notification', items: [], coverage: 'notification-only' } }));
    assert.equal(accepted.ok, true, JSON.stringify({ accepted, errors }));
    const actualAgent = ownedRoot.ctx.agents.get(accepted.sessionId); assert.ok(actualAgent); await deadline(actualAgent.whenIdle());
    assert.equal(providerRequests.length, 1, JSON.stringify(errors)); assert.equal(actualAgent, retained); assert.equal(ownerObserved, true); assert.equal(typedExecuted, true);
    assert.ok(JSON.stringify(providerRequests[0]).includes('APPROVED_NATIVE_BILI_CORE')); assert.ok(!JSON.stringify(providerRequests[0]).includes('UNSAFE_BILI_ANCESTOR'));
    assert.deepEqual(providerRequests[0].tools.map((tool) => tool.name).sort(), ['surfcore_bili_comment', 'surfcore_bili_dm', 'surfcore_bili_dynamic', 'surfcore_bili_read']);
    assert.equal(phases[0], 'start'); assert.equal(phases.at(-1), 'complete'); assert.equal((await budget.status()).usage.total.tokens, 15);
    await deadline(runtime.retire()); assert.notEqual(ownedRoot.ctx.agents.get(accepted.sessionId), retained);
    await deadline(runtime.close()); await deadline(ownedRoot.close());
    let bypass = 0;
    await assert.rejects(collect(outer.waterfall(outer, 'llm/stream', { sessionId: accepted.sessionId }, () => { bypass++; return (async function* () {})(); })), (error) => coded(error, 'BILI_V2_SESSION_UNBOUND')); assert.equal(bypass, 0);
    await collect(outer.waterfall(outer, 'llm/stream', { sessionId: 'unrelated-qq' }, () => { bypass++; return (async function* () {})(); })); assert.equal(bypass, 1);
    assert.equal(outerNetwork, 0); assert.deepEqual(deniedNetwork, []);
    const result = { ok: true, providerCalls: providerRequests.length, actualSameRootAgent: actualAgent === retained, actualOwnerHook: ownerObserved, explicitRoute: route, typedRead: typedExecuted, shellDenied: true, tokens: 15, noInheritedCanary: true, externalNetworkAttempts: deniedNetwork, platformCalls: outerNetwork, closeDeniesOldSession: true, unrelatedOuterSessionPasses: true, fakeSourceValidatorOnly: true };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log('PASS isolated nativeRoot + actual Bili runtime ' + JSON.stringify(result));
  } finally {
    await deadline(runtime?.close()).catch(() => {}); await deadline(ownedRoot?.close()).catch(() => {}); budget.dispose();
    for (const fiber of fibers.reverse()) await deadline(fiber.dispose()).catch(() => {}); await outer.fiber.dispose(); globalThis.fetch = savedFetch;
  }
}

let cases = 0;
async function fixture(name, test, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(evidence, 'fixture-')), commandsDir = path.join(dir, 'commands');
  fs.mkdirSync(commandsDir);
  const helper = new URL('../tools/lib/bili-v2-dispatch.mjs', import.meta.url).href;
  for (const action of ['comment', 'dynamic', 'dm']) {
    const body = action === 'dynamic' ? JSON.stringify({ dyn_req: { scene: 1, content: { contents: [{ raw_text: 'fixture reply', type: 1 }] } } }) : action === 'comment' ? 'oid=12&type=1&root=0&parent=0&message=fixture+reply' : 'msg%5Breceiver_id%5D=99&msg%5Bcontent%5D=' + encodeURIComponent(JSON.stringify({ content: 'fixture reply' }));
    fs.writeFileSync(path.join(commandsDir, action + '.mjs'), `import {biliV2Fetch} from ${JSON.stringify(helper)}; const response=await biliV2Fetch(${JSON.stringify(action)},${JSON.stringify(BILI_V2_ENDPOINTS[action])},{method:'POST',headers:{},body:${JSON.stringify(body)}}); console.log(JSON.stringify(await response.json())); process.disconnect();`);
  }
  for (const action of ['feed', 'debrief']) fs.writeFileSync(path.join(commandsDir, action + '.mjs'), "console.log(JSON.stringify({platform:'bilibili',author:'fixture-author',objectId:'12',text:'complete fixture source'}));");
  let role = { id: 'whale', epoch: 4 }, allowed = true, sends = 0, gate = 0, route = { ok: true, backend: 'v2' };
  const trace = [], agents = new Map(), guards = [], hooks = new Map(), brand = new WeakSet(), definitions = new WeakMap();
  const unregistered = [], offFailures = new Set();
  const trackedOff = (name, dispose) => () => {
    if (offFailures.has(name)) throw new Error('fixture ' + name + ' unregister refused');
    unregistered.push(name);
    return dispose();
  };
  const ctx = native ? new actual.Context() : {};
  if (native) { ctx.provide('systemPrompt', { tools: () => () => {} }); new actual.ToolsService(ctx); ctx.tools.setExecutor(new actual.NativeToolExecutor(ctx)); }
  else {
    ctx.tools = {
      guard(fn) { guards.push(fn); return trackedOff('guard', () => guards.splice(guards.indexOf(fn), 1)); },
      get(name, agent) { return definitions.get(agent)?.get(name); },
      checkGuards(exec) { for (const fn of guards) { const result = fn(exec); if (result !== undefined) return result; } },
    };
    ctx.on = (name, hook) => { hooks.set(name, hook); return trackedOff('hook', () => hooks.delete(name)); };
  }
  const budget = createTokenBudgetService({ ctx: {}, dshHome: dir, qqStateDir: path.join(dir, 'qq') });
  const set = (key, value) => { if (native) ctx.provide(key, value); else ctx[key] = value; };
  set('agents', { get: (id) => agents.get(id) });
  const registryPath = path.join(dir, 'native-denial.json');
  if (overrides.registryBefore !== undefined) fs.writeFileSync(registryPath, overrides.registryBefore);
  set('sessionController', {
    async create({ sessionId, agentPreset }) {
      assert.ok(agentPreset.includes('surfcore-')); trace.push('create');
      const idle = defer(), selected = {};
      const agent = { id: sessionId, ctx: {}, session: { id: sessionId, deriveMessages: () => overrides.oldHistory ? [{ role: 'user', content: 'old private source' }] : [], toolHistory: () => overrides.toolHistory ?? [] }, model: { select: (value) => Object.assign(selected, value) }, selected,
        whenIdle: () => idle.promise, cancel: () => { trace.push('cancel'); idle.resolve(); }, inbox: { nextTurn: [], nextStep: [] } };
      if (native) agent.ctx = actual.createScope(ctx, agent).ctx;
      if (!native) agent.ctx.tools = { restrict: ({ allow }) => { assert.deepEqual(allow, []); trace.push('restrict'); return () => {}; }, register: (definition) => { definitions.get(agent).set(definition.name, definition); return () => definitions.get(agent).delete(definition.name); } };
      definitions.set(agent, new Map()); agents.set(sessionId, agent); return { sessionId, agentPreset };
    },
    async prompt(request) { const disk = JSON.parse(fs.readFileSync(registryPath)); assert.ok(disk.sessions[request.sessionId]); trace.push('prompt'); return { accepted: true }; },
    async state({ sessionId }) { if (agents.get(sessionId).archived) return { active: false, queue: null }; return { queue: [...agents.get(sessionId).inbox.nextTurn, ...agents.get(sessionId).inbox.nextStep] }; },
    async updateQueue({ sessionId, itemId }) { const a = agents.get(sessionId); a.inbox.nextTurn = a.inbox.nextTurn.filter((x) => x.id !== itemId); a.inbox.nextStep = a.inbox.nextStep.filter((x) => x.id !== itemId); trace.push('remove'); return { accepted: true }; },
    async cancel() { trace.push('controller-cancel'); return { accepted: true }; },
  });
  set('workspaceController', { async archiveSession({ sessionId }) { trace.push('archive'); agents.get(sessionId).archived = true; return { archivedSessionIds: [sessionId] }; } });
  set('agentPresets', { async register(definition) { assert.equal(Array.isArray(definition.plugins), true); assert.equal(definition.plugins.some((x) => x.name.includes('workspace')), false); return native ? () => {} : trackedOff('preset', () => {}); }, async resolve(id) { return { id }; } });
  const sourceRuntime = {
    async preparePrompt() { trace.push('source-prompt'); return { ok: true, handle: {}, accountMid: '9', content: [{ type: 'text', text: 'approved static persona plus full original source' }] }; },
    async prepareInput({ options }) { trace.push('source-input'); if (options.system === 'unknown system' || options.attachments || options.messages?.some((x) => x.content === 'unknown old source')) return { ok: false, code: 'BILI_V2_INPUT_UNPROVEN', hint: 'Unknown actual source.' }; return { ok: true, handle: {} }; },
    async validate() { return allowed; },
    async captureModelOutput({ phase }) { trace.push('model-' + phase); return true; },
    async prepareSend({ target }) { trace.push('target-' + target.audience); return { ok: allowed, handle: allowed ? {} : null }; },
    async captureToolResult({ result }) { trace.push('capture'); assert.ok(result.stdout); return { ok: true, result: { text: 'source-bound tool result' } }; },
    ...overrides.sources,
  };
  const memoryV2 = { getRouting: () => route, adapter: { withNetworkAdmission: async (_handle, dispatch) => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'BILI_V2_SOURCE_CHANGED', hint: 'Prepare again.', unknown: false }); gate++; let promise; try { promise = dispatch(); } finally { gate--; } return await promise; } } };
  const provider = { provider: 'fixture-provider', model: 'fixture-model' }; const binding = deriveMemoryProviderRouteId(provider);
  const runtimeOptions = { ctx, memoryV2, getCharacter: () => role, tokenBudget: budget, isAgentLoopRequest: native ? actual.isAgentLoopRequest : (options) => brand.has(options), sourceRuntime,
    modelRequest: () => ({ estimatedTokens: 100 }), getModelRoute: async () => ({ ...provider, providerRouteId: binding.providerRouteId }), transport: { send(request) { assert.ok(gate, 'actual POST initiation must occur under the shared gate'); assert.equal(request.method, 'POST'); sends++; return Promise.resolve({ http: 200, body: { code: 0, data: { dynamic_id: '123' } } }); } }, registryPath, commandsDir, nodeRuntime: process.env.SURFCORE_FIXTURE_NODE || process.execPath, onBlocked: (error) => { assert.ok(error.code); assert.ok(error.hint); }, ...overrides.runtime };
  const runtime = createBiliV2AgentRuntime(runtimeOptions);
  const start = async (id = 'trigger') => { const result = await runtime.enqueue({ requestId: id, input: { kind: 'comment-notification', items: [{ id: '12' }], coverage: 'notification-only' } }); return result; };
  const options = (id, extra = {}, trusted = true) => { const value = Object.freeze({ sessionId: id, ...provider, signal: new AbortController().signal, messages: [{ role: 'user', content: 'approved source' }], ...extra }); if (trusted) { if (native) actual.markAgentLoopRequest(value); else brand.add(value); } return value; };
  const stream = (value, invoke) => native ? ctx.waterfall(ctx, 'llm/stream', value, invoke) : hooks.get('llm/stream')(value, invoke);
  const invoke = async (id, name, args = {}) => {
    const agent = agents.get(id), exec = { agent, name, token: {}, signal: new AbortController().signal };
    if (native) {
      const batch = await ctx.tools.execute({ calls: [{ id: 'fixture-call', name, arguments: JSON.stringify(args) }], agent, signal: exec.signal });
      const result = batch.results[0].result;
      if (result.isError) { const text = JSON.stringify(result); const code = result.error?.info?.code || text.match(/BILI_V2_[A-Z_]+/)?.[0] || 'HOST_TOOL_FAILED'; throw Object.assign(new Error(code), { code, error: code, hint: 'Use the actual scoped native Bili tool.' }); }
      return JSON.parse(result.content[0].text);
    }
    const reason = ctx.tools.checkGuards(exec); if (reason) throw Object.assign(new Error(reason), { code: reason, error: reason, hint: 'Use the actual scoped native tool.' });
    return ctx.tools.get(name, agent).execute(args, exec);
  };
  try { await test({ runtime, budget, start, options, stream, invoke, ctx, agents, definitions, trace, registryPath, sourceRuntime, dir, commandsDir, unregistered, offFailures, guards, hooks, ownerLock: path.join(registryPath + '.owner', 'token-budget-owner.lock'), restart: () => createBiliV2AgentRuntime(runtimeOptions), setAllowed: (value) => { allowed = value; }, setRole: (value) => { role = value; }, setRoute: (value) => { route = value; }, sends: () => sends, inGate: () => gate }); cases++; console.log('PASS ' + name); }
  finally { await runtime.close().catch(() => {}); budget.dispose(); if (native) await ctx.fiber.dispose(); }
}

await fixture('retirement waits for an in-flight creation before releasing its real session', async f => {
  let reached, resume; const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  const create = f.ctx.sessionController.create.bind(f.ctx.sessionController); let released = 0;
  f.ctx.sessionController.create = async (...args) => { const result = await create(...args); reached(); await gate; return result; };
  f.sourceRuntime.releaseJob = async ({ job }) => { assert.equal(f.agents.get(job.sessionId)?.archived, true); released++; return { ok: true }; };
  const pending = f.start(); await ready; const retired = f.runtime.retire(); let finished = false; retired.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(released, 0); resume();
  const result = await pending; assert.equal(result.ok, false); assert.ok(result.code && result.hint);
  await retired; assert.equal(released, 1); assert.equal(f.runtime.getStatus().activeJobs, 0); assert.equal(f.trace.includes('prompt'), false);
});
await fixture('retirement releases source contexts only after real acknowledgement and retains old-ID denial', async f => {
  const released = [];
  f.sourceRuntime.releaseJob = async ({ job }) => { assert.equal(f.agents.get(job.sessionId)?.archived, true); released.push(job.jobId); return { ok: true }; };
  const accepted = await f.start(); assert.equal(accepted.ok, true);
  await f.runtime.retire();
  assert.equal(released.length, 1); assert.equal(f.runtime.getStatus().activeJobs, 0);
  assert.equal(f.runtime.isManagedSession(accepted.sessionId), true);
  await f.runtime.retire(); assert.equal(released.length, 1);
});
await fixture('unacknowledged retirement keeps private contexts blocked until explicit successful retry', async f => {
  let released = 0; f.sourceRuntime.releaseJob = async () => { released++; return { ok: true }; };
  const accepted = await f.start(); assert.equal(accepted.ok, true);
  const original = f.ctx.workspaceController.archiveSession;
  f.ctx.workspaceController.archiveSession = async () => ({ archivedSessionIds: [] });
  await assert.rejects(f.runtime.retire(), e => coded(e, 'BILI_V2_RETIRE_FAILED'));
  assert.equal(released, 0); assert.equal(f.runtime.getStatus().activeJobs, 1);
  assert.equal(f.runtime.getSessionSafety(accepted.sessionId).ok, false);
  f.ctx.workspaceController.archiveSession = original;
  await f.runtime.retire(); assert.equal(released, 1); assert.equal(f.runtime.getStatus().activeJobs, 0);
});
await fixture('fresh sessions persist denial markers before first prompt and retire queue/cancel/archive/idle', async (f) => {
  const result = await f.start(); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.runtime.getSessionSafety(result.sessionId).ok, true);
  const second = await f.start('another'); assert.equal(second.ok, true); assert.notEqual(second.sessionId, result.sessionId);
  f.agents.get(result.sessionId).inbox.nextTurn.push({ id: 'queued' });
  await f.runtime.retire(); assert.ok(f.trace.includes('remove')); assert.ok(f.trace.includes('archive'));
  assert.equal(f.runtime.getSessionSafety(result.sessionId).ok, false); assert.equal(f.runtime.isManagedSession(result.sessionId), true);
  assert.equal((await f.start('trigger')).code, 'BILI_V2_JOB_REUSED');
});
await fixture('actual native empty tool-history snapshot shape is accepted', async (f) => {
  const result = await f.start(); assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(f.trace.includes('prompt'));
}, { toolHistory: Object.freeze({ tools: Object.freeze([]), updates: Object.freeze([]) }) });
for (const history of [{ tools: [{}], updates: [] }, { tools: [], updates: [{}] }, { tools: [] }, { tools: [], updates: [], forged: true }, { get tools() { throw new Error('getter must not run'); }, updates: [] }]) await fixture('nonempty or forged native history snapshot refuses before prompt', async (f) => {
  const result = await f.start(); coded(result, 'BILI_V2_SESSION_UNSAFE'); assert.equal(f.trace.includes('prompt'), false);
}, { toolHistory: history });
await fixture('native brand and actual session/provider defeat forged fields and every inference gets canonical usage', async (f) => {
  const result = await f.start(); assert.equal(result.ok, true, JSON.stringify(result));
  let calls = 0;
  const provider = () => { assert.ok(f.inGate()); calls++; return (async function* () { assert.ok(f.inGate()); yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; yield { type: 'text-delta', text: 'fixture' }; })(); };
  await collect(f.stream(f.options(result.sessionId), provider)); assert.equal(calls, 1);
  await assert.rejects(collect(f.stream(f.options(result.sessionId, {}, false), provider)), (e) => coded(e, 'MEMORY_AGENT_REQUEST_UNTRUSTED'));
  await assert.rejects(collect(f.stream(f.options(result.sessionId, { model: 'fake' }), provider)));
  assert.equal(calls, 1); assert.equal((await f.budget.status()).usage.total.tokens, 15);
});
for (const extra of [{ system: 'unknown system' }, { attachments: ['unknown file'] }, { messages: [{ role: 'user', content: 'unknown old source' }] }]) await fixture('unknown full input never reaches provider: ' + Object.keys(extra)[0], async (f) => {
  const result = await f.start(); let calls = 0;
  await assert.rejects(collect(f.stream(f.options(result.sessionId, extra), () => { calls++; return (async function* () {})(); })));
  assert.equal(calls, 0);
});
await fixture('old history is rejected rather than reused', async (f) => { const result = await f.start(); coded(result, 'BILI_V2_SESSION_UNSAFE'); assert.equal(f.trace.includes('prompt'), false); }, { oldHistory: true });
await fixture('revoked source blocks both next native model and actual POST', async (f) => {
  const result = await f.start(); f.setAllowed(false); let calls = 0;
  await assert.rejects(collect(f.stream(f.options(result.sessionId), () => { calls++; return (async function* () {})(); })));
  assert.equal(calls, 0); await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture reply' })); assert.equal(f.sends(), 0);
});
await fixture('late response usage is charged before revoked output is discarded', async (f) => {
  const result = await f.start(); let calls = 0;
  await assert.rejects(collect(f.stream(f.options(result.sessionId), () => { calls++; return (async function* () { await Promise.resolve(); f.setAllowed(false); yield { type:'usage', usage:{inputTokens:10,outputTokens:5} }; yield { type:'text-delta',text:'must not escape' }; })(); })));
  assert.equal(calls, 1); assert.equal((await f.budget.status()).usage.total.tokens, 15);
});
await fixture('typed native read captures source before returning and denies raw/shell/admin paths', async (f) => {
  const result = await f.start();
  const read = await f.invoke(result.sessionId, 'surfcore_bili_read', { kind: 'feed' }); assert.equal(read.ok, true); assert.ok(f.trace.includes('capture'));
  for (const name of ['bash', 'pwsh', 'read', 'mcp_admin', 'surfcore_bili_danmaku', 'surfcore_bili_score']) await assert.rejects(f.invoke(result.sessionId, name), (e) => coded(e, 'BILI_V2_TOOL_DENIED'));
  await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'x', role: 'fake', sessionId: 'fake', grants: ['fake'] }), (e) => coded(e, native ? 'HOST_TOOL_FAILED' : 'BILI_V2_TOOL_DENIED'));
});
if (!native) await fixture('registered V2 read advertises only implemented kinds and refuses retired today before any fork', async (f) => {
  const result = await f.start();
  const readTool = f.definitions.get(f.agents.get(result.sessionId)).get('surfcore_bili_read');
  assert.deepEqual(readTool.parameters.kind.enum, ['feed', 'debrief']);
  assert.equal(fs.existsSync(path.join(f.commandsDir, 'today.mjs')), false, 'retired today has no worker script');
  const traceBefore = f.trace.length, sendsBefore = f.sends();
  await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_read', { kind: 'today' }), (e) => coded(e, 'BILI_V2_ARGS_INVALID'));
  assert.equal(f.trace.length, traceBefore, 'today is refused before any worker fork or source capture');
  assert.equal(f.sends(), sendsBefore, 'today is refused before any platform dispatch');
  const read = await f.invoke(result.sessionId, 'surfcore_bili_read', { kind: 'feed' }); assert.equal(read.ok, true); assert.ok(f.trace.includes('capture'));
});
let scopedReadCalls = 0;
await fixture('Host typed reads capture approved locator results without forking the CLI', async (f) => {
  const marker = path.join(f.dir, 'unexpected-read-worker');
  fs.writeFileSync(path.join(f.commandsDir, 'feed.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'forked');console.log('unapproved CLI output');`);
  const job = await f.start();
  const result = await f.invoke(job.sessionId, 'surfcore_bili_read', { kind: 'feed' });
  assert.equal(scopedReadCalls, 1); assert.equal(fs.existsSync(marker), false);
  assert.equal(result.ok, true); assert.equal(result.result.text, 'source-bound tool result');
  assert.equal(f.trace.filter(item => item === 'capture').length, 1);
}, { runtime: { transport: { async send() { throw new Error('No writes expected.'); }, async read({ job, action, args, signal }) {
  scopedReadCalls++; assert.ok(Object.isFrozen(job)); assert.equal(action, 'feed'); assert.deepEqual(args, { kind: 'feed' }); assert.ok(signal instanceof AbortSignal);
  return { ok: true, stdout: JSON.stringify({ items: [{ kind: 'video', bvid: 'BV1234567890' }] }) };
} } } });
await fixture('An unapproved Host read is visible and never falls back to a CLI worker', async (f) => {
  const marker = path.join(f.dir, 'unexpected-denied-worker');
  fs.writeFileSync(path.join(f.commandsDir, 'debrief.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'forked');console.log('unapproved CLI output');`);
  const job = await f.start();
  await assert.rejects(f.invoke(job.sessionId, 'surfcore_bili_read', { kind: 'debrief', bv: 'BV1234567890' }), error => coded(error, 'BILI_OFFICIAL_SCOPE_UNSUPPORTED') && Boolean(error.hint));
  assert.equal(fs.existsSync(marker), false); assert.equal(f.trace.includes('capture'), false);
}, { runtime: { transport: { async send() { throw new Error('No writes expected.'); }, async read() {
  return { ok: false, code: 'BILI_OFFICIAL_SCOPE_UNSUPPORTED', error: 'The video is outside this exact set.', hint: 'Preview and approve a new exact source set.' };
} } } });
await fixture('CLI dynamic final POST only occurs in Host fixed transport under the gate', async (f) => {
  const result = await f.start(); const sent = await f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture reply' }); assert.equal(sent.ok, true); assert.equal(f.sends(), 1); assert.ok(f.trace.includes('target-public'));
});
let officialDynamicReceipts = 0;
await fixture('official dyn_id_str survives Host receipt forwarding without becoming an observed source', async (f) => {
  const result = await f.start();
  const sent = await f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture reply' });
  assert.equal(sent.ok, true);
  assert.equal(officialDynamicReceipts, 1);
}, {
  sources: { async captureToolResult({ result }) {
    assert.equal(JSON.parse(result.stdout).data.dyn_id_str, '1234567890123456789');
    return { ok: true, result: { derived: true, receipt: { id: '1234567890123456789' } } };
  } },
  runtime: { transport: { async send() {
    officialDynamicReceipts++;
    return { http: 200, body: { code: 0, data: { dyn_id_str: '1234567890123456789', private_noise: 'DO_NOT_FORWARD' } } };
  } } },
});
await fixture('actual private target gets separate fresh target capability', async (f) => {
  const result = await f.start(); await f.invoke(result.sessionId, 'surfcore_bili_dm', { mid: '99', text: 'fixture reply' }); assert.equal(f.sends(), 1); assert.ok(f.trace.includes('target-private'));
});
await fixture('role change after await blocks provider and native tools', async (f) => {
  const result = await f.start(); f.setRole({ id: 'other', epoch: 5 }); let calls = 0;
  await assert.rejects(collect(f.stream(f.options(result.sessionId), () => { calls++; return (async function* () {})(); })));
  await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture' })); assert.equal(calls, 0); assert.equal(f.sends(), 0);
});
await fixture('V1 and routing errors cannot activate or fall back through native factory', async (f) => { f.setRoute({ ok: true, backend: 'v1' }); const result = await f.start(); coded(result, 'BILI_V2_ROUTING_CHANGED'); assert.equal(f.trace.includes('prompt'), false); });
await fixture('closed and restarted sessions keep denial markers without receiving fresh grants', async (f) => {
  const result = await f.start(); await f.runtime.close();
  assert.equal(f.runtime.isManagedSession(result.sessionId), true); assert.equal(f.runtime.isManagedSession('unrelated-qq'), false);
  await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture' }));
  const next = f.restart();
  try { assert.equal(next.isManagedSession(result.sessionId), true); assert.equal(next.getSessionSafety(result.sessionId).ok, false); assert.equal((await next.enqueue({ requestId: 'trigger', input: { kind: 'night-wake' } })).code, 'BILI_V2_JOB_REUSED'); }
  finally { await next.close(); }
});
await fixture('a missing actual cancel ACK leaves the session permanently denied', async (f) => {
  const result = await f.start(); f.ctx.sessionController.cancel = async () => ({ accepted: false });
  await assert.rejects(f.runtime.retire(), (e) => coded(e, 'BILI_V2_RETIRE_FAILED'));
  assert.equal(f.runtime.getSessionSafety(result.sessionId).ok, false); assert.equal(f.runtime.isManagedSession(result.sessionId), true);
});
if (!native) await fixture('an idle close unregisters both real subscriptions once and releases the owner last', async (f) => {
  assert.equal(fs.existsSync(f.ownerLock), true);
  await f.runtime.close();
  assert.deepEqual(f.unregistered, ['hook', 'guard']);
  assert.equal(f.guards.length, 0); assert.equal(f.hooks.size, 0);
  assert.equal(fs.existsSync(f.ownerLock), false); assert.equal(f.runtime.getStatus().ok, false);
  await f.runtime.close();
  assert.deepEqual(f.unregistered, ['hook', 'guard'], 'repeat close is idempotent');
  console.log('  CLOSE-EVIDENCE idle unregisterOrder=' + JSON.stringify(f.unregistered) + ' guards=' + f.guards.length + ' hooks=' + f.hooks.size + ' ownerHeld=' + fs.existsSync(f.ownerLock) + ' ok=' + f.runtime.getStatus().ok);
});
if (!native) await fixture('a refused retirement keeps the owner, active job and subscriptions until an explicit close retry', async (f) => {
  const result = await f.start(); assert.equal(result.ok, true, JSON.stringify(result));
  const archive = f.ctx.workspaceController.archiveSession;
  f.ctx.workspaceController.archiveSession = async () => ({ archivedSessionIds: [] });
  try {
    await assert.rejects(f.runtime.close(), (e) => coded(e, 'BILI_V2_RETIRE_FAILED'));
    assert.equal(fs.existsSync(f.ownerLock), true, 'owner must stay held while retirement is refused');
    assert.equal(f.runtime.getStatus().activeJobs, 1); assert.equal(f.runtime.getStatus().ok, false);
    assert.deepEqual(f.unregistered, [], 'no disposer is acknowledged before retirement succeeds');
    assert.equal(f.guards.length, 1); assert.equal(f.hooks.size, 1);
    coded(await f.start('another'), 'BILI_V2_UNAVAILABLE');
    await assert.rejects(collect(f.stream(f.options(result.sessionId), () => (async function* () {})())), (e) => coded(e, 'BILI_V2_UNAVAILABLE'));
    console.log('  CLOSE-EVIDENCE held activeJobs=' + f.runtime.getStatus().activeJobs + ' unregisterOrder=' + JSON.stringify(f.unregistered) + ' guards=' + f.guards.length + ' hooks=' + f.hooks.size + ' ownerHeld=' + fs.existsSync(f.ownerLock) + ' ok=' + f.runtime.getStatus().ok);
  } finally { f.ctx.workspaceController.archiveSession = archive; }
  await f.runtime.close();
  assert.equal(f.runtime.getStatus().activeJobs, 0);
  assert.deepEqual(f.unregistered, ['hook', 'guard', 'preset']);
  assert.equal(f.guards.length, 0); assert.equal(f.hooks.size, 0);
  assert.equal(fs.existsSync(f.ownerLock), false);
  console.log('  CLOSE-EVIDENCE retried unregisterOrder=' + JSON.stringify(f.unregistered) + ' activeJobs=' + f.runtime.getStatus().activeJobs + ' ownerHeld=' + fs.existsSync(f.ownerLock));
});
if (!native) await fixture('concurrent and repeated close share one unload and never double-unregister', async (f) => {
  assert.equal(fs.existsSync(f.ownerLock), true);
  await Promise.all([f.runtime.close(), f.runtime.close(), f.runtime.close()]);
  assert.deepEqual(f.unregistered, ['hook', 'guard']);
  assert.equal(f.guards.length, 0); assert.equal(f.hooks.size, 0);
  assert.equal(fs.existsSync(f.ownerLock), false);
  await f.runtime.close();
  assert.deepEqual(f.unregistered, ['hook', 'guard']);
  assert.equal(f.runtime.getStatus().ok, false);
  console.log('  CLOSE-EVIDENCE concurrent unregisterOrder=' + JSON.stringify(f.unregistered) + ' guards=' + f.guards.length + ' hooks=' + f.hooks.size + ' ownerHeld=' + fs.existsSync(f.ownerLock));
});
if (!native) await fixture('a refused unregister stays unacknowledged and remaining disposers finish only on explicit retry', async (f) => {
  const result = await f.start(); assert.equal(result.ok, true, JSON.stringify(result));
  f.offFailures.add('guard');
  try {
    await assert.rejects(f.runtime.close(), (e) => coded(e, 'BILI_V2_RETIRE_FAILED'));
    assert.equal(f.runtime.getStatus().ok, false);
    assert.equal(fs.existsSync(f.ownerLock), true, 'owner must stay held after a refused unregister');
    assert.equal(f.runtime.getStatus().activeJobs, 0);
    assert.deepEqual(f.unregistered, ['hook']);
    assert.equal(f.guards.length, 1); assert.equal(f.hooks.size, 0);
    coded(await f.start('another'), 'BILI_V2_UNAVAILABLE');
    console.log('  CLOSE-EVIDENCE refusedOff unregisterOrder=' + JSON.stringify(f.unregistered) + ' guards=' + f.guards.length + ' hooks=' + f.hooks.size + ' activeJobs=' + f.runtime.getStatus().activeJobs + ' ownerHeld=' + fs.existsSync(f.ownerLock));
  } finally { f.offFailures.delete('guard'); }
  await f.runtime.close();
  assert.deepEqual(f.unregistered, ['hook', 'guard', 'preset']);
  assert.equal(f.guards.length, 0); assert.equal(f.hooks.size, 0);
  assert.equal(fs.existsSync(f.ownerLock), false);
  console.log('  CLOSE-EVIDENCE refusedOff retried unregisterOrder=' + JSON.stringify(f.unregistered) + ' ownerHeld=' + fs.existsSync(f.ownerLock));
});
await fixture('full input digests cover nested own properties and reject symbols or cycles', async (f) => {
  const input = { messages: [] }, original = biliV2InputDigest(input);
  input.messages.extra = 'unapproved'; assert.notEqual(biliV2InputDigest(input), original);
  const nested = { messages: [{}] }; nested.messages[0][Symbol('hidden')] = 'unapproved';
  assert.throws(() => biliV2InputDigest(nested), (e) => coded(e, 'BILI_V2_INPUT_UNSUPPORTED'));
  const cycle = {}; cycle.self = cycle; assert.throws(() => biliV2InputDigest(cycle), (e) => coded(e, 'BILI_V2_INPUT_UNSUPPORTED'));
  const proto = {}; Object.defineProperty(proto, '__proto__', { value: null, configurable: true });
  const digest = biliV2InputDigest(proto); Object.defineProperty(proto, '__proto__', { value: 'changed' }); assert.notEqual(biliV2InputDigest(proto), digest);
  assert.equal(f.runtime.isManagedSession('constructor'), false); assert.equal(f.runtime.isManagedSession('toString'), false);
});
await fixture('native output lifecycle preserves chunk identity and commits only after budget settlement', async (f) => {
  const result = await f.start(), options = f.options(result.sessionId), phases = [], original = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
  let first;
  f.sourceRuntime.captureModelOutput = async (call) => {
    assert.equal(call.options, options); assert.equal(Object.isFrozen(call.job), true); assert.equal(Object.isFrozen(call.request), true);
    first ??= call; assert.equal(call.request, first.request); assert.equal(call.dispatchId, first.dispatchId); assert.match(call.dispatchId, /^[a-f0-9-]{36}$/);
    if (call.phase === 'chunk') assert.equal(call.chunk, original);
    if (call.phase === 'complete') assert.equal((await f.budget.status()).usage.total.tokens, 15);
    phases.push(call.phase); return true;
  };
  const chunks = await collect(f.stream(options, () => { assert.deepEqual(phases, ['start']); return (async function* () { yield original; })(); }));
  assert.equal(chunks[0], original); assert.deepEqual(phases, ['start', 'chunk', 'complete']);
});
await fixture('missing native output validator refuses before first prompt', async (f) => {
  const result = await f.start(); coded(result, 'MEMORY_NATIVE_INPUT_UNPROVEN'); assert.equal(f.trace.includes('prompt'), false);
}, { sources: { captureModelOutput: undefined } });
for (const refused of ['start', 'chunk', 'complete']) await fixture('output provenance refusal at ' + refused + ' abandons candidate and prevents continuation', async (f) => {
  const result = await f.start(), phases = []; let calls = 0;
  f.sourceRuntime.captureModelOutput = async ({ phase }) => { phases.push(phase); return phase !== refused; };
  await assert.rejects(collect(f.stream(f.options(result.sessionId), () => { calls++; return (async function* () { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; })(); })), (e) => coded(e, 'MEMORY_NATIVE_INPUT_UNPROVEN'));
  assert.equal(calls, refused === 'start' ? 0 : 1); assert.equal(phases.at(-1), 'failed');
  if (calls) assert.equal((await f.budget.status()).usage.total.tokens, 15);
  assert.equal(f.runtime.getSessionSafety(result.sessionId).ok, false);
});
await fixture('consumer return abandons native output after cleanup usage is durably settled', async (f) => {
  const result = await f.start(), phases = [];
  f.sourceRuntime.captureModelOutput = async ({ phase }) => { phases.push(phase); if (phase === 'failed') assert.equal((await f.budget.status()).usage.total.tokens, 15); return true; };
  const stream = f.stream(f.options(result.sessionId), () => (async function* () { try { yield { type: 'text-delta', text: 'partial' }; } finally { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }; } })());
  await stream.next(); await stream.return(); assert.deepEqual(phases, ['start', 'chunk', 'failed']);
});
await fixture('corrupt denial registry blocks before any prompt or model', async (f) => { coded(await f.start(), 'BILI_V2_REGISTRY_UNAVAILABLE'); assert.equal(f.trace.includes('prompt'), false); assert.equal(f.sends(), 0); }, { registryBefore: '{broken' });
await fixture('registry fsync failure is sticky and cannot acknowledge a first prompt', async (f) => {
  const original = fs.fsyncSync; fs.fsyncSync = () => { throw new Error('fixture EIO'); };
  try { coded(await f.start(), 'BILI_V2_REGISTRY_UNAVAILABLE'); } finally { fs.fsyncSync = original; }
  coded(await f.start('new-trigger'), 'BILI_V2_REGISTRY_UNAVAILABLE'); assert.equal(f.trace.includes('prompt'), false);
});
await fixture('source revision change after preparation blocks actual model dispatch', async (f) => {
  const result = await f.start(); let calls = 0;
  const before = f.sourceRuntime.prepareInput;
  f.sourceRuntime.prepareInput = async (input) => { const prepared = await before(input); f.setAllowed(false); return prepared; };
  await assert.rejects(collect(f.stream(f.options(result.sessionId), () => { calls++; return (async function* () {})(); }))); assert.equal(calls, 0);
});
await fixture('nested input mutation during validation invalidates the original inference digest', async (f) => {
  const result = await f.start(), messages = [{ role: 'user', content: 'approved source' }]; let calls = 0;
  f.sourceRuntime.validate = async ({ options }) => { if (options) messages[0].content = 'changed original'; return true; };
  await assert.rejects(collect(f.stream(f.options(result.sessionId, { messages }), () => { calls++; return (async function* () {})(); }))); assert.equal(calls, 0);
});
await fixture('worker disconnect during final dispatch stays unknown and cannot auto retry', async (f) => {
  const helper = new URL('../tools/lib/bili-v2-dispatch.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(f.commandsDir, 'dynamic.mjs'), `import {biliV2Fetch} from ${JSON.stringify(helper)};setTimeout(()=>process.disconnect(),50);try{await biliV2Fetch('dynamic',${JSON.stringify(BILI_V2_ENDPOINTS.dynamic)},{method:'POST',body:JSON.stringify({dyn_req:{scene:1,content:{contents:[{raw_text:'fixture',type:1}]}}})});}catch{process.exitCode=1;}`);
  const result = await f.start(); await assert.rejects(f.invoke(result.sessionId, 'surfcore_bili_dynamic', { text: 'fixture' })); assert.equal(f.runtime.getStatus().lastFailure.unknown, true); assert.equal((await f.start()).code, 'BILI_V2_JOB_REUSED');
}, { runtime: { transport: { send: () => new Promise((resolve) => setTimeout(() => resolve({ http: 200, body: { code: 0, data: { dynamic_id: '123' } } }), 150)) } } });
if (native) await fixture('actual Host PTC-style nested execution retains the native deny guard', async (f) => {
  const result = await f.start(), agent = f.agents.get(result.sessionId), pipeline = new actual.ToolExecutionPipeline(f.ctx), signal = new AbortController().signal;
  const parent = await pipeline.prepare({ agent, name: 'run_code', callId: 'ptc-root', arguments: {}, signal });
  assert.equal(parent.kind, 'post-result'); assert.equal(parent.result.isError, true);
  let bodies = 0;
  const hidden = { name: 'bash', description: 'Must remain denied', parameters: {}, output: { schema: {type:'object'}, render: () => [] }, execute: () => { bodies++; return {}; } };
  const toolSet = { view: () => new Map([['bash', hidden]]) };
  const nested = await pipeline.prepare({ agent, toolSet, parent: parent.exec, name: 'bash', callId: 'ptc-child', arguments: { command: 'untrusted' }, signal });
  assert.equal(nested.kind, 'post-result'); assert.equal(nested.exec.parent, parent.exec); assert.ok(nested.exec.token);
  assert.equal(nested.result.isError, true); assert.match(JSON.stringify(nested.result), /BILI_V2_TOOL_DENIED/); assert.equal(bodies, 0); assert.equal(f.sends(), 0);
});
assert.notEqual(biliV2InputDigest({ messages: ['a'], signal: {} }), biliV2InputDigest({ messages: ['b'], signal: {} }));
assert.equal(biliV2InputDigest({ messages: ['a'], signal: 1 }), biliV2InputDigest({ signal: 2, messages: ['a'] }));
assert.throws(() => decodeBiliV2Request({ action: 'comment', url: 'https://example.com/x/v2/reply/add', method: 'POST', body: 'oid=1&type=1&message=x' }), (e) => coded(e, 'BILI_V2_ENDPOINT_DENIED'));
const schedulerDir = fs.mkdtempSync(path.join(evidence, 'scheduler-'));
const schedulerScript = `import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=process.env.SURFCORE_ROOT,home=process.env.DSH_HOME,account=path.join(home,'surfcore','bili');fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.mkdirSync(account,{recursive:true});fs.writeFileSync(path.join(root,'config.json'),'{}');fs.writeFileSync(path.join(root,'src','bridge.js'),'// fixture');fs.writeFileSync(path.join(home,'surfcore','bili.config.json'),'{}');
const {startScheduler}=await import(${JSON.stringify(new URL('../lib/scheduler.js', import.meta.url).href)});let checked=0;
for(const mode of ['v2','v2-missing','bad','throws','v1']){let legacy=0,inspects=0,submitted=[],blocked=[];const state=path.join(account,'whale-night.json');fs.writeFileSync(state,JSON.stringify({date:new Date().toLocaleDateString('sv-SE'),action:'skip',at:0,fired:false,reason:'fixture'}));
const ctx={on:()=>()=>{},sessionController:{inspect:async()=>{inspects++;return{}},prompt:async(args)=>{legacy++;assert.ok(args.content[0].text);return{accepted:true}},cancel:async()=>({accepted:true})}};
const controller=startScheduler(ctx,{dshHome:home,biliMjs:path.join(root,'never-run.mjs'),memoryV2:{getRouting:()=>{if(mode==='throws')throw Error('fixture');return mode==='bad'?{ok:false,code:'MEMORY_ROUTING_CORRUPT',hint:'Repair fixture route'}:{ok:true,backend:mode==='v1'?'v1':'v2'}}},biliV2Agent:mode==='v2-missing'?null:{enqueue:async value=>{submitted.push(value);return{ok:true,sessionId:'native-fixture'}},retire:async()=>{}},onMemoryBlocked:value=>blocked.push(value)});
try{await controller.tick().catch(error=>{if(mode!=='bad'&&mode!=='throws')throw error;assert.ok(error.code);assert.ok(error.hint)});if(mode==='v2'){assert.equal(submitted.length,1);assert.equal(submitted[0].input.kind,'night-skip');assert.equal('content' in submitted[0].input,false);assert.equal(legacy,0);assert.equal(inspects,0)}else if(mode==='v1'){assert.equal(legacy,1);assert.equal(submitted.length,0)}else{assert.equal(legacy,0);assert.equal(inspects,0);assert.equal(submitted.length,0);assert.ok(blocked.length);assert.ok(blocked[0].code);assert.ok(blocked[0].hint)}checked++}finally{controller.stop()}}
console.log('PASS scheduler routing/lazy inputs '+checked);`;
const schedulerResult = spawnSync(process.env.SURFCORE_FIXTURE_NODE || process.execPath, ['--input-type=module', '-e', schedulerScript], { env: { ...process.env, DSH_HOME: path.join(schedulerDir, 'home'), SURFCORE_ROOT: path.join(schedulerDir, 'root'), DSH_NODE: process.env.SURFCORE_FIXTURE_NODE || process.execPath }, encoding: 'utf8', timeout: 15000 });
fs.writeFileSync(path.join(schedulerDir, 'result.log'), schedulerResult.stdout + schedulerResult.stderr);assert.equal(schedulerResult.status,0, schedulerResult.stderr);assert.match(schedulerResult.stdout,/PASS scheduler routing/);
const helperUrl = new URL('../tools/lib/bili-v2-dispatch.mjs', import.meta.url).href;
const plainNode = process.env.SURFCORE_FIXTURE_NODE || process.execPath;
const ordinary = spawnSync(plainNode, ['--input-type=module', '-e', `globalThis.fetch=async()=>({ordinary:true});const {biliV2Fetch}=await import(${JSON.stringify(helperUrl)});console.log(JSON.stringify(await biliV2Fetch('comment','https://fixture.invalid/',{})));`], { env: { ...process.env, SURFCORE_BILI_V2_WORKER: '0' }, encoding: 'utf8' });
assert.equal(ordinary.status, 0); assert.match(ordinary.stdout, /"ordinary":true/);
const disconnected = spawnSync(plainNode, ['--input-type=module', '-e', `globalThis.fetch=()=>{throw Error('must never fetch')};const {biliV2Fetch}=await import(${JSON.stringify(helperUrl)});try{await biliV2Fetch('comment',${JSON.stringify(BILI_V2_ENDPOINTS.comment)},{method:'POST',body:'oid=1&type=1&message=x'})}catch(e){console.log(JSON.stringify({code:e.code,hint:e.hint}))}`], { env: { ...process.env, SURFCORE_BILI_V2_WORKER: '1' }, encoding: 'utf8' });
assert.equal(disconnected.status, 0); assert.match(disconnected.stdout, /BILI_V2_IPC_UNAVAILABLE/); assert.doesNotMatch(disconnected.stdout, /must never fetch/);
if (!native && !ordinaryOnly) {
  const electron = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  if (fs.existsSync(electron)) {
    const log = path.join(evidence, 'actual-host-pipeline.log'), fd = fs.openSync(log, 'w');
    const result = spawnSync(electron, ['--expose-internals', fileURLToPath(import.meta.url)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SURFCORE_BILI_ACTUAL_HOST_FIXTURE: '1', SURFCORE_FIXTURE_NODE: process.execPath }, stdio: ['ignore', fd, fd], timeout: 120000 });
    fs.closeSync(fd); assert.equal(result.status, 0, 'actual installed Host tool fixture: ' + log);
  }
}
if (native && process.env.SURFCORE_BILI_ISOLATED_ROOT_FIXTURE === '1') { await isolatedRootFixture(); cases++; }
console.log(`PASS Bili native runtime: ${cases} scenarios (${process.version}, actualHostTools=${native}); evidence ${evidence}`);
