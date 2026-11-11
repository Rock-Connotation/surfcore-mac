import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryService } from '../../../src/core/memory-v2-service.js';
import { createMemoryHost } from '../lib/memory-v2-host.mjs';
import { createQQMemoryBridge } from '../../../src/core/memory-v2-qq.js';
import { createQQV2SourceRuntime } from '../lib/qq-v2-source-runtime.mjs';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createQQV2NativeOwner } from '../lib/qq-v2-native-owner.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { createQQV2ReplyHost } from '../lib/qq-v2-reply-host.mjs';
import { createNativeQQChannel } from '../../../src/core/qq-native-channel.js';

const rootDir = path.resolve('_backups/memory-v2-qq-source-runtime', 'run-' + process.version + '-' + randomUUID());
fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });

const good = value => {
  assert.equal(value?.ok, true, JSON.stringify(value));
  return value;
};

const bad = (value, expectedCode) => {
  assert.equal(value?.ok, false, JSON.stringify(value));
  if (expectedCode) assert.equal(value.code, expectedCode, JSON.stringify(value));
  assert.ok(value.code && value.error && value.hint, JSON.stringify(value));
  return value;
};

const route = { provider: 'fixture-provider', model: 'fixture-model' };
const providerRouteId = good(deriveMemoryProviderRouteId(route)).providerRouteId;
const persona = 'Approved QQ Host persona.';

const identified = value => Object.freeze({ ...structuredClone(value), id: randomUUID() });
const unitCodec = {
  AssistantStreamAccumulator: class { push(value) { return structuredClone(value); } snapshot() { return []; } },
  BlockAssembler: class { content = []; push(chunk) { if (chunk.type === 'block-end') this.content.push(chunk.block); if (chunk.type === 'finish') { this.finish = chunk.reason; this.replayState = chunk.replayState; } } blocks() { return this.content; } },
  createSystemMessage: text => identified({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
  createUserMessage: value => identified({ ...value, role: 'user' }),
  createAssistantMessage: value => identified({ role: 'assistant', content: value.content, source: { kind: 'model', ...value.source } }),
  createToolResultMessage: value => identified({ role: 'tool', source: { kind: 'tool', callId: value.callId }, toolCallId: value.callId, content: value.content, isError: value.isError }),
};

const specs = [
  { name: 'qq_reply', description: 'Reply to QQ conversation', parameters: { text: { type: 'string', required: true } } }
];

let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log('PASS', name);
}

async function fixture(options = {}) {
  const { createCharacter, switchCharacter, readCurrentCharacter } = await import('../../../src/character-persona.js');
  try { createCharacter({ name: 'Alpha character', id: 'alpha', personaText: 'Alpha persona' }); } catch {}
  switchCharacter('alpha');
  const currentRole = readCurrentCharacter();

  const f = {
    dir: path.join(rootDir, randomUUID()),
    role: { id: currentRole.id, epoch: currentRole.epoch },
    management: Symbol('management'),
    replayAuthority: Symbol('replayAuthority'),
    qqState: {
      verified: true,
      accountId: '100',
      allowedGroups: ['900'],
      allowedPrivates: ['200'],
      route: { ...route },
    },
    ownedTools: new WeakSet(),
  };
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });

  f.getCharacter = () => f.role;
  f.getQQIdentity = async () => ({
    ok: f.qqState.verified,
    verified: f.qqState.verified,
    accountId: f.qqState.accountId,
    allowedGroups: [...f.qqState.allowedGroups],
    allowedPrivates: [...f.qqState.allowedPrivates],
    route: { ...f.qqState.route },
  });

  f.service = createMemoryService({
    stateDir: path.join(f.dir, 'state'),
    charactersDir: path.join(f.dir, 'characters'),
    getCharacter: f.getCharacter,
    authorizeManagement: token => token === f.management,
    authorizeProducerReplay: token => token === f.replayAuthority,
  });
  good(await f.service.initialize());

  const base = {
    channel: 'qq',
    conversationKey: 'qq:100:group:900',
    sourceAccountKey: 'qq:200',
    requesterAccountKey: 'qq:200',
    providerRouteId,
    purpose: 'conversation',
    audiencePolicyId: 'qq-policy',
    processingGrantId: 'qq-grant',
  };

  const action = async act => {
    const admin = good(await f.service.host.captureAdminContext(base, f.management)).context;
    return f.service.applyMemoryAction(admin, act, admin.controlRevision, 'manage:' + randomUUID());
  };

  good(await action({
    type: 'configure_policy',
    policy: {
      policyId: 'qq-policy',
      approved: true,
      audiences: [['qq', base.conversationKey, '*']],
      processingGrants: [{ grantId: 'qq-grant', providerRouteId }],
    },
  }));
  good(await action({ type: 'enable_shadow', enabled: true }));

  const { writeMemoryRouting } = await import('../../../src/core/memory-v2-routing.js');
  good(writeMemoryRouting({
    stateDir: path.join(f.dir, 'state'),
    status: { ...good(await f.service.getStatus()), activeBackend: 'v2' },
  }));

  f.host = createMemoryHost({
    memoryService: f.service,
    getCharacter: f.getCharacter,
    handleTtlMs: 300000,
    resolveIdentity: ({ conversationKey, sourceFacts }) => {
      const match = /^qq:([1-9][0-9]{0,19}):(group|private):([1-9][0-9]{0,19})$/.exec(conversationKey);
      if (!match) return { ok: false, code: 'MEMORY_AUDIENCE_DENIED' };
      return {
        channel: 'qq',
        conversationKey,
        sourceAccountKey: sourceFacts ? `qq:${sourceFacts.actorAccountId}` : 'qq:200',
        requesterAccountKey: 'qq:200',
        providerRouteId,
        purpose: 'conversation',
      };
    },
    getProducerReplayAuthorization: () => f.replayAuthority,
  });

  const rawAdapter = f.host.createAdapter({
    channel: 'qq',
    principal: { accountId: '100' },
    canBindInput: true,
    canSubmitSourceFacts: true,
  });

  f.adapter = Object.freeze({
    ...rawAdapter,
    capture: async (...args) => {
      if (typeof args[0] === 'string') {
        return rawAdapter.capture({ conversationKey: args[0], sourceFacts: args[1]?.sourceFacts });
      }
      return rawAdapter.capture(args[0]);
    },
    release: async (...args) => rawAdapter.release(...args),
  });

  f.bridge = createQQMemoryBridge({
    stateDir: path.join(f.dir, 'state'),
    getCharacter: f.getCharacter,
    client: f.adapter,
  });

  f.validateOwnedToolContext = execution => ({ ok: f.ownedTools.has(execution) });

  f.runtime = createQQV2SourceRuntime({
    bridge: f.bridge,
    adapter: f.adapter,
    getCharacter: f.getCharacter,
    getQQIdentity: f.getQQIdentity,
    corePersona: persona,
    nativeCodec: unitCodec,
    toolSpecs: specs,
    validateOwnedToolContext: f.validateOwnedToolContext,
  });

  f.close = async () => {
    await f.runtime.close();
    f.host.close();
    await f.service.close();
  };

  return f;
}

// 1. Positive flow: capture, export, recall, ledger seed, input validation, network admission, output, send
await test('positive QQ V2 source runtime end-to-end flow with recall', async () => {
  const f = await fixture();
  try {
    const sourceData = {
      key: 'group:900',
      loginAccountId: '100',
      actorAccountId: '200',
      objectId: 'msg-1',
      text: 'Hello, this is a real QQ message for V2 memory.',
    };
    good(await f.bridge.captureSource(sourceData));
    good(await f.bridge.prepareReply({ key: 'group:900' }));

    const job = {
      jobId: 'job-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      providerRouteId,
      characterId: f.role.id,
      characterEpoch: f.role.epoch,
    };

    const prompt = good(await f.runtime.prepareReplyPrompt({ key: 'group:900', job }));
    assert.equal(prompt.sessionId, 'session-1');
    assert.equal(prompt.requestId, 'request-1');
    assert.ok(prompt.handle);
    assert.ok(prompt.preparedHandle);
    assert.ok(prompt.content.some(c => c.text.includes('Hello, this is a real QQ message')));

    const options = {
      provider: route.provider,
      model: route.model,
      maxTokens: 100,
      sessionId: 'session-1',
      messages: [
        unitCodec.createSystemMessage(persona),
        unitCodec.createUserMessage({ source: { kind: 'user-rpc', requestId: 'request-1' }, content: prompt.content })
      ],
      toolHistory: { tools: [], updates: [] },
      tools: specs.map(s => ({
        name: s.name,
        description: s.description,
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      })),
    };

    const crypto = await import('node:crypto');
    const inputDigest = crypto.createHash('sha256').update(JSON.stringify({ messages: options.messages, toolHistory: options.toolHistory, tools: options.tools })).digest('hex');
    const request = { sessionId: 'session-1', inputDigest };

    good(await f.runtime.prepareInput({ job, options, request }));

    let dispatched = false;
    const admissionResult = await f.runtime.admitNetwork({
      job,
      dispatch: async () => {
        dispatched = true;
        return 'network-dispatch-success';
      }
    });
    assert.equal(dispatched, true);
    assert.equal(admissionResult, 'network-dispatch-success');

    good(await f.runtime.captureModelOutput({
      job,
      options,
      request,
      dispatchId: 'disp-1',
      phase: 'start'
    }));

    good(await f.runtime.captureModelOutput({
      job,
      options,
      request,
      dispatchId: 'disp-1',
      phase: 'chunk',
      chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Assistant reply.' } }
    }));

    good(await f.runtime.captureModelOutput({
      job,
      options,
      request,
      dispatchId: 'disp-1',
      phase: 'chunk',
      chunk: { type: 'finish', reason: { kind: 'stop' } }
    }));

    good(await f.runtime.captureModelOutput({
      job,
      options,
      request,
      dispatchId: 'disp-1',
      phase: 'complete'
    }));

    const sendPrep = good(await f.runtime.prepareSend({ job, key: 'group:900', loginAccountId: '100' }));
    assert.ok(sendPrep.lease);

    good(await f.runtime.recordSent({
      job,
      lease: sendPrep.lease,
      text: 'Assistant reply.',
      messageId: 'onebot-99',
      deliveryState: 'delivered'
    }));

    good(await f.runtime.retireJob({ job }));
    assert.equal(f.runtime.getStatus().activeJobs, 0);
  } finally {
    await f.close();
  }
});

// 2. Identity and route drift negatives
await test('QQ live identity drift blocks admission and preparation', async () => {
  const f = await fixture();
  try {
    good(await f.bridge.captureSource({ key: 'group:900', loginAccountId: '100', actorAccountId: '200', objectId: 'msg-drift', text: 'Drift test' }));
    good(await f.bridge.prepareReply({ key: 'group:900' }));

    const job = { jobId: 'job-drift', sessionId: 'session-drift', requestId: 'req-drift' };
    good(await f.runtime.prepareReplyPrompt({ key: 'group:900', job }));

    // Drift 1: Account ID switch
    f.qqState.accountId = '101';
    bad(await f.runtime.prepareInput({ job, options: {}, request: {} }), 'MEMORY_IDENTITY_CHANGED');

    // Drift 2: Removed from allowlist
    f.qqState.accountId = '100';
    f.qqState.allowedGroups = [];
    bad(await f.runtime.prepareInput({ job, options: {}, request: {} }), 'MEMORY_AUDIENCE_DENIED');

    // Drift 3: Provider route changed
    f.qqState.allowedGroups = ['900'];
    f.qqState.route = { provider: 'different-provider', model: 'different-model' };
    bad(await f.runtime.prepareInput({ job, options: {}, request: {} }), 'MEMORY_PROVIDER_ROUTE_MISMATCH');

    // Drift 4: Character epoch changed
    f.qqState.route = { ...route };
    f.role = { id: 'alpha', epoch: 2 };
    bad(await f.runtime.prepareInput({ job, options: {}, request: {} }), 'CHARACTER_EPOCH_STALE');
  } finally {
    await f.close();
  }
});

// 3. Output finish integrity negative test
await test('model output without finish chunk or with error cannot complete', async () => {
  const f = await fixture();
  try {
    good(await f.bridge.captureSource({ key: 'group:900', loginAccountId: '100', actorAccountId: '200', objectId: 'msg-out', text: 'Output test' }));
    good(await f.bridge.prepareReply({ key: 'group:900' }));

    const job = { jobId: 'job-out', sessionId: 'session-out', requestId: 'req-out' };
    const prompt = good(await f.runtime.prepareReplyPrompt({ key: 'group:900', job }));

    const options = {
      provider: route.provider,
      model: route.model,
      sessionId: 'session-out',
      messages: [
        unitCodec.createSystemMessage(persona),
        unitCodec.createUserMessage({ source: { kind: 'user-rpc', requestId: 'req-out' }, content: prompt.content })
      ],
      toolHistory: { tools: [], updates: [] },
      tools: specs.map(s => ({
        name: s.name,
        description: s.description,
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
      })),
    };
    const crypto = await import('node:crypto');
    const inputDigest = crypto.createHash('sha256').update(JSON.stringify({ messages: options.messages, toolHistory: options.toolHistory, tools: options.tools })).digest('hex');
    const request = { sessionId: 'session-out', inputDigest };

    good(await f.runtime.prepareInput({ job, options, request }));

    good(await f.runtime.captureModelOutput({ job, options, request, dispatchId: 'disp-out', phase: 'start' }));
    good(await f.runtime.captureModelOutput({ job, options, request, dispatchId: 'disp-out', phase: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } }));

    // Complete without finish must fail closed
    bad(await f.runtime.captureModelOutput({ job, options, request, dispatchId: 'disp-out', phase: 'complete' }), 'QQ_NATIVE_LEDGER_OUTPUT_UNPROVEN');

    // Aborted or error finish must fail closed
    for (const kind of ['error', 'aborted', 'max-tokens']) {
      bad(await f.runtime.captureModelOutput({ job, options, request, dispatchId: 'disp-out', phase: 'chunk', chunk: { type: 'finish', reason: { kind } } }), 'QQ_NATIVE_LEDGER_OUTPUT_UNPROVEN');
    }
  } finally {
    await f.close();
  }
});

// 4. Tool witness rejection
await test('tool result requires owner execution witness proof', async () => {
  const f = await fixture();
  try {
    good(await f.bridge.captureSource({ key: 'group:900', loginAccountId: '100', actorAccountId: '200', objectId: 'msg-tool', text: 'Tool test' }));
    good(await f.bridge.prepareReply({ key: 'group:900' }));

    const job = { jobId: 'job-tool', sessionId: 'session-tool', requestId: 'req-tool' };
    await f.runtime.prepareReplyPrompt({ key: 'group:900', job });

    const unprovenExecution = { name: 'qq_reply', callId: 'call-x', arguments: { text: 'hi' } };
    bad(await f.runtime.captureToolResult({ job, execution: unprovenExecution, content: [{ type: 'text', text: 'done' }] }), 'QQ_NATIVE_OWNER_UNPROVEN');
  } finally {
    await f.close();
  }
});

console.log(`PASS ${checks} QQ V2 source runtime ordinary scenarios`);

async function nativeQQSourceCycle() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/';
  const load = name => require(base + name + '/lib/index.js');
  const actual = { ...require(base + 'cordis'), ...load('dsh-llm'), ...load('dsh-tools') };

  const bootstrapModules = {
    Context: actual.Context,
    SessionProjectionRegistry: load('dsh-session-projection').default,
    SessionStore: load('dsh-session').default,
    AgentRegistry: load('dsh-agent').default,
    SystemPrompt: load('dsh-system-prompt').default,
    ToolsService: actual.ToolsService,
    Loader: load('cordis-plugin-loader').default,
    AgentLoop: load('dsh-agent-loop').default,
    AgentPresetRegistry: load('dsh-agent-preset-registry').default,
    nativeExecutor: load('dsh-tool-executor-native'),
    isAgentLoopRequest: actual.isAgentLoopRequest,
  };

  const f = await fixture();
  const marker = 'Remember that the user favorite color is blue.';
  const seed = good(await f.adapter.capture({ conversationKey: 'qq:100:group:900' }));
  good(await f.adapter.ingest(seed.handle, [{
    eventId: 'actual-old-recall-qq',
    operationId: 'actual-old-op-qq',
    sourceKey: 'actual-old-source-qq',
    producerId: 'fixture-old-qq-native',
    segmentId: 'old-qq-segment',
    producerSeq: 1,
    content: marker,
  }], 'actual-old-batch-qq'));
  good(await f.adapter.release(seed.handle));

  const outer = new actual.Context(), fibers = [], errors = [], network = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { network.push(String(args[0])); throw new Error('External network disabled.'); };

  const budget = createTokenBudgetService({ ctx: {}, dshHome: f.dir, qqStateDir: path.join(f.dir, 'state') });
  budget.saveLimits({ qq: { cny: null, tokens: 100 }, bili: { cny: null, tokens: null }, other: { cny: null, tokens: null }, total: { cny: null, tokens: null } });

  let owner, providerCalls = 0, toolCalls = 0;
  const deadline = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native qq source cycle deadline')), 15000); })]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    outer.baseUrl = new URL('../package.json', import.meta.url).href;
    for (const plugin of [bootstrapModules.SystemPrompt, bootstrapModules.ToolsService, load('dsh-llm').default, bootstrapModules.Loader]) {
      const fiber = outer.plugin(plugin);
      fibers.push(fiber);
      await fiber;
    }

    class FakeOfficialModel extends actual.LlmAdapter {
      async *stream(options) {
        providerCalls++;
        assert.ok(JSON.stringify(options.messages).includes(marker), 'actual SDK request must include earlier Core memory');
        if (providerCalls === 1) {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-tool-qq-1', name: 'qq_reply', arguments: JSON.stringify({ text: 'Hello blue' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Confirmed blue response' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }

    outer.get('llm').registerAdapter([route.provider], new FakeOfficialModel());

    const qqTool = actual.defineTool({
      name: 'qq_reply',
      description: 'Reply to QQ conversation',
      parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, val) => [{ type: 'text', text: val }] },
      execute: async (args, execution) => {
        toolCalls++;
        const content = [{ type: 'text', text: 'sent-ack' }];
        const result = await f.runtime.captureToolResult({ job: { jobId: owner.sessionId }, execution, content });
        assert.equal(result.ok, true, JSON.stringify(result));
        return 'sent-ack';
      }
    });

    f.runtime = createQQV2SourceRuntime({
      bridge: f.bridge,
      adapter: f.adapter,
      getCharacter: f.getCharacter,
      getQQIdentity: f.getQQIdentity,
      corePersona: persona,
      nativeCodec: actual,
      toolSpecs: specs,
      validateOwnedToolContext: execution => owner.validateOwnedToolContext(execution),
    });

    owner = await createQQV2NativeOwner({
      nativeModules: bootstrapModules,
      llm: outer.get('llm'),
      getLlmHookContext: () => outer,
      corePersona: persona,
      tools: [qqTool],
      tokenBudget: budget,
      getCharacter: f.getCharacter,
      provider: route.provider,
      model: route.model,
      estimatedTokens: 20,
      sourceAuthority: f.runtime,
      onAgentError: error => errors.push(error),
    });

    good(await f.bridge.captureSource({ key: 'group:900', loginAccountId: '100', actorAccountId: '200', objectId: 'msg-native-1', text: 'What is my favorite color?' }));
    good(await f.bridge.prepareReply({ key: 'group:900' }));

    const prompt = good(await f.runtime.prepareReplyPrompt({
      key: 'group:900',
      job: {
        jobId: owner.sessionId,
        sessionId: owner.sessionId,
        requestId: 'native-req-1',
        providerRouteId,
        characterId: f.role.id,
        characterEpoch: f.role.epoch,
      }
    }));

    owner.followup(actual.createUserMessage({
      source: { kind: 'user-rpc', requestId: 'native-req-1' },
      content: prompt.content,
    }));

    await deadline(owner.whenIdle());

    const lease = good(await f.runtime.prepareSend({
      job: { jobId: owner.sessionId },
      key: 'group:900',
      loginAccountId: '100',
    })).lease;

    good(await f.runtime.recordSent({
      job: { jobId: owner.sessionId },
      lease,
      text: 'Confirmed blue response',
      messageId: 'qq-sent-1',
      deliveryState: 'confirmed',
    }));

    assert.equal(providerCalls, 2);
    assert.equal(toolCalls, 1);
    const status = f.runtime.getStatus();
    assert.equal(status.admittedInputs, 2);
    assert.equal(status.committedOutputs, 2);
    assert.equal(status.sentLeases, 1);
    const budgetStatus = await budget.status();
    const tokens = budgetStatus.usage.total.tokens;
    assert.equal(tokens, 30);
    assert.deepEqual(network, []);

    await deadline(owner.retire());
    await deadline(f.runtime.close());

    // Exercise the production Host composition with the installed SDK, real
    // Core and real source ledger. Only the model and QQ transport are fake.
    budget.saveLimits({ qq: { cny: null, tokens: 1000000 } });
    good(await f.bridge.captureSource({ key: 'group:900', loginAccountId: '100', actorAccountId: '200', objectId: 'native-host-composition', text: marker }));
    good(await f.bridge.prepareReply({ key: 'group:900' }));
    let nativeSends = 0;
    const channel = createNativeQQChannel({ memory: f.bridge, getCharacter: f.getCharacter, getIdentity: f.getQQIdentity,
      isAllowed: () => true, send: async (_key, text) => { assert.equal(text, 'Confirmed blue response'); nativeSends++; return { ok: true, messageId: '123' }; }, onComplete: () => {} });
    const request = good(channel.begin('group:900', f.getCharacter(), 1)).request;
    const replyHost = createQQV2ReplyHost({ ctx: outer, memoryV2: { adapter: f.adapter, getRouting: () => f.bridge.routing() }, tokenBudget: budget,
      getCharacter: f.getCharacter, getQQIdentity: f.getQQIdentity, readPersona: () => persona,
      loadEnvironment: async () => ({ nativeModules: bootstrapModules, nativeCodec: actual, llm: outer.get('llm'), getLlmHookContext: () => outer }),
      callBridge: async (_url, { body }) => { const data = await channel.request(body); return { ok: data.ok, status: data.ok ? 200 : 409, data }; } });
    good(replyHost.submit(request)); await deadline(replyHost.whenIdle());
    assert.equal(replyHost.getReceipt(request.requestId)?.delivered, true, JSON.stringify(replyHost.getReceipt(request.requestId)));
    assert.equal(nativeSends, 1); assert.equal(providerCalls, 3);
    good(await replyHost.close());
    assert.deepEqual(network, []);
    console.log('PASS production QQ reply Host + installed Native SDK + Core + private bridge: 1 complete reply, 1 fake QQ ACK, 0 external calls');

    const evidenceDir = path.resolve('_backups/memory-v2-coordinator/qq-source-runtime-independent');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidence = {
      ok: true,
      providerCalls,
      toolCalls,
      tokens: (await budget.status()).usage.total.tokens,
      gates: providerCalls,
      productionHostReplies: nativeSends,
      admittedInputs: status.admittedInputs,
      committedOutputs: status.committedOutputs,
      sentLeases: status.sentLeases,
      networkCalls: network.length,
      platformWrites: 0,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(evidenceDir, 'verification.json'), JSON.stringify(evidence, null, 2));
    console.log('PASS native QQ source runtime cycle ' + JSON.stringify(evidence));
  } catch (err) {
    console.error('NATIVE_CYCLE_ERROR', err);
    throw err;
  } finally {
    if (owner) await owner.retire().catch(() => {});
    budget.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {});
    await outer.fiber?.dispose().catch(() => {});
    globalThis.fetch = savedFetch;
    await f.close();
  }
}

if (process.env.SURFCORE_QQ_SOURCE_NATIVE === '1') await nativeQQSourceCycle();
