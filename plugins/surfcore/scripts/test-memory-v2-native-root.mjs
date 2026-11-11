import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createIsolatedNativeRoot } from '../lib/memory-v2-native-root.mjs';

export async function runNativeRootProbe(outer, moduleRoot) {
  const load = (name) => import(pathToFileURL(path.join(moduleRoot, '@deepseek-ai', name, 'lib/index.js')).href);
  const packages = ['cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'cordis-plugin-loader', 'dsh-agent-loop', 'dsh-agent-preset-registry', 'dsh-tool-executor-native', 'dsh-llm'];
  const [cordis, projections, sessions, agents, prompt, tools, loader, loop, presets, executor, llmModule] = await Promise.all(packages.map(load));
  const nativeModules = {
    Context: cordis.Context, SessionProjectionRegistry: projections.default, SessionStore: sessions.default,
    AgentRegistry: agents.default, SystemPrompt: prompt.default, ToolsService: tools.default,
    Loader: loader.default, AgentLoop: loop.default, AgentPresetRegistry: presets.default,
    nativeExecutor: executor, isAgentLoopRequest: llmModule.isAgentLoopRequest,
  };
  const checks = [], providerRequests = [], hookRequests = [], inferenceErrors = [];
  const outerFibers = [], hookDisposers = [];
  let root, privateHandle;
  const mountOuter = async (plugin) => { const fiber = outer.plugin(plugin); outerFibers.push(fiber); await fiber; return fiber; };
  const deadline = async (promise) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native root activity deadline exceeded')), 12000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await assert.rejects(createIsolatedNativeRoot(), (error) => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED' && !!error.error && !!error.hint);
    checks.push('structured-unsupported-keeps-V1');
    await mountOuter(prompt.default); await mountOuter(tools.default); await mountOuter(llmModule.default);
    outer.get('systemPrompt').section({ name: 'unsafe-ancestor-section', text: 'UNSAFE_ANCESTOR_SECTION', order: 0 });
    outer.get('systemPrompt').context({ name: 'unsafe-required-context', text: 'UNSAFE_ANCESTOR_REQUIRED_CONTEXT', required: true, order: 0 });
    const makeTool = (name) => tools.defineTool({ name, description: `Controlled fixture ${name}`, parameters: { key: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async (args) => args.key });
    outer.get('tools').register(makeTool('unsafe_ancestor_tool'));
    hookDisposers.push(outer.on('agent/pre-step', async (state, next) => next({ ...state, messages: [llmModule.createDeveloperMessage({ content: [{ type: 'text', text: 'UNSAFE_ANCESTOR_AGENTS_MD' }] }), ...state.messages] })));
    class FixtureAdapter extends llmModule.LlmAdapter {
      async *stream(options) {
        providerRequests.push(JSON.parse(JSON.stringify(options)));
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'FAKE_PROVIDER_OWNED_OUTPUT' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const removeAdapter = outer.get('llm').registerAdapter(['memory-fixture-provider'], new FixtureAdapter());
    hookDisposers.push(removeAdapter);
    const owned = makeTool('owned_lookup');
    root = await createIsolatedNativeRoot({ nativeModules, llm: outer.get('llm'), getLlmHookContext: () => outer, corePersona: 'APPROVED_MEMORY_CORE_PERSONA', tools: [owned], onStream: (options, next, call) => {
      assert.equal(root.ownsRequest(options), true);
      assert.equal(root.ownsRequest({ ...options }), false);
      assert.equal(call.preparedConfig.provider, 'memory-fixture-provider');
      assert.equal(call.preparedConfig.model, 'exact-fixture-model');
      assert.equal(root.getCurrentCall(), call);
      assert.equal(root.ownsAgent(call.agent), true);
      assert.equal(llmModule.isAgentLoopRequest(call.request), true);
      assert.equal(call.agent, privateHandle.agent);
      hookRequests.push({ request: options, original: call.request, callId: call.callId });
      if (providerRequests.length !== 0) throw Object.assign(new Error('Assistant history needs captured-output provenance before another dispatch.'), { code: 'MEMORY_NATIVE_INPUT_UNPROVEN', error: 'Assistant input is unproven.', hint: 'Keep V1 active and attach the trusted captured-output sidecar before another request.' });
      return next(options);
    } });
    root.ctx.on('agent/error', ({ error }) => inferenceErrors.push({ code: error?.code, message: error?.message, stack: error?.stack }));
    assert.notEqual(root.ctx.root, outer.root);
    assert.equal(root.getLlmHookContext(), outer);
    hookDisposers.push(root.getLlmHookContext().on('llm/stream', (options, next) => {
      if (root.getCurrentCall()) assert.equal(root.ownsRequest(options), true);
      return next(options);
    }));
    privateHandle = await root.createAgent({ provider: 'memory-fixture-provider', model: 'exact-fixture-model' });
    const agent = privateHandle.agent;
    assert.equal(root.ctx.agents.get(agent.id), agent);
    assert.equal(root.ownsAgent({ ...agent }), false);
    assert.ok(root.ctx.agentPresets.composedPreset(agent.ctx).startsWith('memory-native-'));
    assert.ok(root.ctx.tools.selectExecutor(agent) instanceof executor.NativeToolExecutor);
    assert.deepEqual(root.ctx.tools.definitions(agent), [owned]);
    assert.deepEqual(agent.model.current(), { provider: 'memory-fixture-provider', model: 'exact-fixture-model' });
    checks.push('actual-registry-preset-native-executor-session-model');
    const admittedTools = await root.ctx.tools.resolve({ agent, scope: agent, signal: new AbortController().signal });
    assert.equal(root.ctx.tools.checkGuards({ agent, name: 'owned_lookup', toolSet: admittedTools }), undefined);
    assert.ok(root.ctx.tools.checkGuards({ agent, name: 'unsafe_ancestor_tool', toolSet: admittedTools }));
    checks.push('exact-owned-typed-tools-and-monotonic-guard');
    const dynamic = makeTool('owned_scoped_probe');
    assert.throws(() => root.registerTool(dynamic, outer), error => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED');
    assert.throws(() => root.registerTool(owned, agent.ctx), error => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED');
    const releaseDynamic = root.registerTool(dynamic, agent.ctx);
    const scopedTools = await root.ctx.tools.resolve({ agent, scope: agent, signal: new AbortController().signal });
    assert.equal(root.ctx.tools.checkGuards({ agent, name: dynamic.name, toolSet: scopedTools }), undefined);
    assert.ok(root.ctx.tools.definitions(agent, scopedTools).includes(dynamic));
    releaseDynamic(); releaseDynamic();
    assert.ok(root.ctx.tools.checkGuards({ agent, name: dynamic.name, toolSet: scopedTools }));
    checks.push('private-dynamic-scoped-tools-register-revoke-and-reject-foreign-context');
    agent.followup(llmModule.createUserMessage({ source: { kind: 'user-rpc', requestId: 'memory-fixture-first' }, content: [{ type: 'text', text: 'OWNED_FIRST_CALL_PROMPT' }] }));
    await deadline(agent.activityDone);
    assert.equal(providerRequests.length, 1, JSON.stringify(inferenceErrors));
    assert.equal(hookRequests.length, 1);
    const request = providerRequests[0], original = hookRequests[0].original;
    const body = JSON.stringify(request);
    assert.equal(llmModule.isAgentLoopRequest(original), true);
    assert.equal(llmModule.isAgentLoopRequest({ ...original }), false);
    assert.equal(request.provider, 'memory-fixture-provider'); assert.equal(request.model, 'exact-fixture-model');
    assert.equal(request.sessionId, agent.session.id);
    assert.ok(body.includes('APPROVED_MEMORY_CORE_PERSONA')); assert.ok(body.includes('OWNED_FIRST_CALL_PROMPT'));
    assert.ok(!body.includes('UNSAFE_ANCESTOR')); assert.ok(!body.includes('unsafe_ancestor_tool'));
    assert.deepEqual(request.tools.map((tool) => tool.name), ['owned_lookup']);
    assert.deepEqual(request.tools[0].parameters, owned.parameters);
    assert.ok(!request.messages.some((message) => message.role === 'assistant'));
    assert.ok(agent.session.deriveMessages().some((message) => message.role === 'assistant' && JSON.stringify(message).includes('FAKE_PROVIDER_OWNED_OUTPUT')));
    checks.push('actual-agent-loop-branded-first-request', 'actual-borrowed-llm-owner-hook-intercepts', 'approved-first-input-no-ancestor-instructions-context-or-tools', 'actual-native-assistant-settlement');
    agent.session.append('assistant/message', { turn: 0, step: 0, message: llmModule.createAssistantMessage({ source: { provider: 'memory-fixture-provider', model: 'exact-fixture-model' }, content: [{ type: 'text', text: 'FORGED_CALLER_ASSISTANT' }] }), stream: [] }, { surfaceOp: 'append' });
    assert.ok(agent.session.deriveMessages().some((message) => JSON.stringify(message).includes('FORGED_CALLER_ASSISTANT')));
    agent.followup(llmModule.createUserMessage({ source: { kind: 'user-rpc', requestId: 'memory-fixture-second' }, content: [{ type: 'text', text: 'SECOND_REQUEST_MUST_NOT_DISPATCH_WITHOUT_PROVENANCE' }] }));
    await deadline(agent.activityDone);
    assert.equal(providerRequests.length, 1, JSON.stringify(inferenceErrors));
    assert.ok(hookRequests.length >= 2);
    assert.ok(JSON.stringify(hookRequests.at(-1).request).includes('FORGED_CALLER_ASSISTANT'));
    checks.push('caller-assistant-append-still-not-authority', 'unproven-followup-default-denied-zero-second-provider-dispatch');
    assert.deepEqual(globalThis.memoryGateDenied, []);
    await deadline(root.close());
    assert.equal(root.ownsAgent(agent), false);
    await assert.rejects(root.createAgent({ provider: 'memory-fixture-provider', model: 'exact-fixture-model' }), (error) => error.code === 'MEMORY_NATIVE_ROOT_UNSUPPORTED' && !!error.hint);
    checks.push('owned-root-teardown');
    return { ok: true, node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, checks, providerRequests, callerAppendAccepted: true, hookCount: hookRequests.length, externalNetworkAttempts: globalThis.memoryGateDenied, fullOutputProvenanceImplemented: false, packagedHost: true };
  } finally {
    if (root) await deadline(root.close());
    for (const dispose of hookDisposers.reverse()) dispose();
    for (const fiber of outerFibers.reverse()) await deadline(fiber.dispose());
  }
}

async function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const evidenceRoot = path.join(repo, '_backups/memory-v2-native-root');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  let harness = fs.readFileSync(path.join(repo, 'scripts/test-memory-v2-host-runtime.mjs'), 'utf8');
  const replace = (from, to) => { assert.equal(harness.split(from).length, 2, 'P0 packaged Host fixture seam changed; update the explicit fixture adaptation.'); harness = harness.replace(from, to); };
  replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-host-runtime');", `const root = ${JSON.stringify(evidenceRoot)};`);
  const start = harness.indexOf("create('project/probe.mjs', `");
  const end = harness.indexOf('\nconst env = {', start);
  assert.ok(start > 0 && end > start);
  const payload = `import { runNativeRootProbe } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\nexport const name='memory-runtime-probe';\nexport const inject=['webServer','connection'];\nexport async function apply(ctx,config){\nconst profile=ctx.get('profileContext');\nif(profile.dir!==config.project||profile.home!==config.dshHome)throw new Error('Host profile escaped owned fixture');\nconst result=await runNativeRootProbe(ctx,${JSON.stringify('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules')});\nprocess.send?.({type:'memory-runtime-probe',ok:result.ok,pid:process.pid,execPath:process.execPath,native:result,loaderAck:{registered:[...ctx.loader.entries()].some(entry=>entry.options.id==='memory-runtime-probe'),applyContext:true},denied:globalThis.memoryGateDenied});\n}`;
  harness = harness.slice(0, start) + `create('project/probe.mjs', ${JSON.stringify(payload)});\n` + harness.slice(end);
  replace('assert.equal(message.worker.ok, true);', 'assert.equal(message.native.ok, true); assert.equal(message.loaderAck.registered, true);');
  const filename = path.join(evidenceRoot, `host-harness-${randomUUID()}.mjs`);
  fs.writeFileSync(filename, harness, { flag: 'wx' });
  await import(pathToFileURL(filename).href);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
