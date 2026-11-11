import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createMemoryService } from '../../../src/core/memory-v2-service.js';
import { createMemoryHost } from '../lib/memory-v2-host.mjs';
import { createBiliV2SourceRuntime } from '../lib/bili-v2-source-runtime.mjs';
import { biliV2InputDigest, createBiliV2AgentRuntime } from '../lib/bili-v2-agent.mjs';
import { createIsolatedNativeRoot } from '../lib/memory-v2-native-root.mjs';
import { loadMemoryV2NativeEnvironment } from '../lib/memory-v2-native-environment.mjs';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const rootDir = path.resolve('_backups/memory-v2-bili-native-recall', 'run-' + process.version + '-' + randomUUID());
fs.mkdirSync(rootDir, { recursive: true });
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value?.ok, false, JSON.stringify(value)); if (code) assert.equal(value.code, code); assert.ok(value.code && value.error && value.hint); return value; };
const route = good(deriveMemoryProviderRouteId({ provider: 'fixture-source', model: 'fixture-model' })).providerRouteId;
const persona = 'Approved Bili source persona.';
const target = { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' };
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
const VIDEO_BV = "BV1xx411c7mD", VIDEO_AID = '170001', VIDEO_AUTHOR = '8', VIDEO_PUBDATE = 1700000000;
const VIDEO_INPUT = { kind: 'comment-notification', coverage: 'notification-only', items: [{ id: VIDEO_AID }] };
const otherJob = f => ({ ...f.job, jobId: 'job:' + randomUUID(), requestId: 'request:' + randomUUID(), sessionId: 'session:' + randomUUID() });
const videoRecord = (overrides = {}) => {
  const pubdate = overrides.pubdate ?? VIDEO_PUBDATE;
  const record = {
    sourceKey: 'bili:video:170001', revision: 'revision-1', kind: 'video', objectId: VIDEO_AID,
    authorMid: VIDEO_AUTHOR, audience: 'public',
    target: { audience: 'public', kind: 'video', bvid: VIDEO_BV, aid: VIDEO_AID },
    coverage: 'text-only',
    wire: { bvid: VIDEO_BV, aid: VIDEO_AID, title: '  A raw video title  ', desc: '', owner: { mid: VIDEO_AUTHOR, name: 'Author' }, pubdate },
  };
  record.occurredAt = Object.hasOwn(overrides, 'occurredAt') ? overrides.occurredAt : new Date(pubdate * 1000).toISOString();
  for (const [key, value] of Object.entries(overrides)) if (key !== 'pubdate' && key !== 'occurredAt') record[key] = value;
  return record;
};
const parameter = { type: 'string', required: true };
const specs = [
  { name: 'surfcore_bili_read', description: 'Read a fixed Bili source; results are captured before returning.', parameters: { kind: { type: 'string', enum: ['feed', 'debrief'], required: true }, bv: { type: 'string' } } },
  { name: 'surfcore_bili_comment', description: 'Comment on an explicitly authorized actual Bili target.', parameters: { oid: parameter, type: { type: 'string', enum: ['1', '11', '17'], required: true }, text: parameter, bvid: { type: 'string' }, root: { type: 'string' }, parent: { type: 'string' } } },
  { name: 'surfcore_bili_dynamic', description: 'Publish one text dynamic using this job original action ID.', parameters: { text: parameter } },
  { name: 'surfcore_bili_dm', description: 'Reply to an authorized actual Bili private-message target.', parameters: { mid: parameter, text: parameter } },
];
const canonicalSpecs = Object.freeze([...specs].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const identified = value => Object.freeze({ ...structuredClone(value), id: randomUUID() });
const unitCodec = {
  AssistantStreamAccumulator: class { push(value) { return structuredClone(value); } snapshot() { return []; } },
  BlockAssembler: class { content = []; push(chunk) { if (chunk.type === 'block-end') this.content.push(chunk.block); if (chunk.type === 'finish') { this.finish = chunk.reason; this.replayState = chunk.replayState; } } blocks() { return this.content; } },
  createSystemMessage: text => identified({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
  createUserMessage: value => identified({ ...value, role: 'user' }),
  createAssistantMessage: value => identified({ role: 'assistant', content: value.content, source: { kind: 'model', ...value.source } }),
  createToolResultMessage: value => identified({ role: 'tool', source: { kind: 'tool', callId: value.callId }, toolCallId: value.callId, content: value.content, isError: value.isError }),
};
let count = 0;
async function fixture(options = {}) {
  const f = { dir: path.join(rootDir, randomUUID()), role: { id: 'alpha', epoch: 1 }, management: Symbol('management'), revision: 'revision-1', hydrated: 0, transportChecks: 0, privateSource: options.privateSource === true, conversation: null, records: null, selectorConversations: null, captures: [], ingests: [], identityCalls: [], codec: unitCodec };
  fs.mkdirSync(f.dir, { recursive: true });
  f.conversationKey = () => f.conversation ?? (f.privateSource ? 'bili:9:private:22' : 'bili:9:public:11');
  f.context = conversation => ({ channel: 'bili', conversationKey: conversation, sourceAccountKey: 'bili:9:actor:9', requesterAccountKey: 'bili:9:actor:9', providerRouteId: route, purpose: 'conversation', audiencePolicyId: conversation.includes('private') ? 'private-source' : 'public-source', processingGrantId: 'grant' });
  f.service = createMemoryService({ stateDir: path.join(f.dir, 'state'), charactersDir: path.join(f.dir, 'characters'), getCharacter: () => f.role, authorizeManagement: token => token === f.management, workerFactory: (url, args) => { const worker = new Worker(url, args); f.worker = worker; return worker; } });
  good(await f.service.initialize());
  f.action = async action => { const admin = good(await f.service.host.captureAdminContext(f.context('bili:9:public:11'), f.management)).context; return f.service.applyMemoryAction(admin, action, admin.controlRevision, 'admin:' + randomUUID()); };
  const publicAudiences = options.publicAudiences ?? ['bili:9:public:11'];
  if (!options.noPolicy) for (const [policyId, conversation] of [['public-source', 'bili:9:public:11'], ['private-source', 'bili:9:private:22']]) good(await f.action({ type: 'configure_policy', policy: { policyId, approved: true, audiences: (policyId === 'public-source' ? publicAudiences : [conversation]).map(item => ['bili', item, 'bili:9:actor:9']), processingGrants: [{ grantId: 'grant', providerRouteId: route }] } }));
  good(await f.action({ type: 'enable_shadow', enabled: true }));
  f.host = createMemoryHost({ memoryService: f.service, getCharacter: () => f.role, resolveIdentity: ({ conversationKey }) => { const base = f.context(conversationKey); return { channel: base.channel, conversationKey, sourceAccountKey: base.sourceAccountKey, requesterAccountKey: base.requesterAccountKey, providerRouteId: route }; } });
  const rawAdapter = f.host.createAdapter({ channel: 'bili', principal: { accountMid: '9' }, canBindInput: true });
  f.adapter = Object.freeze({
    ...rawAdapter,
    capture: async request => {
      const value = await rawAdapter.capture(request);
      f.captures.push({ conversationKey: request?.conversationKey, stampConversationKey: value?.sourceStamp?.conversationKey, handle: value?.handle, ok: value?.ok, code: value?.code });
      return value;
    },
    ingest: async (handle, batch, operationId) => {
      const value = await rawAdapter.ingest(handle, batch, operationId);
      f.ingests.push({ handle, operationId, eventIds: batch.map(item => item.eventId), sourceKeys: batch.map(item => item.sourceKey), occurredAts: batch.map(item => item.occurredAt), ok: value?.ok, code: value?.code, sourceState: value?.sourceState, refs: (value?.eventRefs ?? []).map(ref => ref.id ?? ref) });
      return value;
    },
  });
  f.identity = async ({ job, action, target: actualTarget, signal, ...selector }) => {
    f.latestJob = job;
    const selectorKey = selector.kind === 'comment' ? selector.rpid : selector.kind === 'video' ? selector.aid : undefined;
    const mapped = f.selectorConversations && selectorKey ? f.selectorConversations[selectorKey] : undefined;
    const privateConversation = action === 'prompt' || action === 'read' ? f.privateSource : actualTarget?.audience === 'private';
    const conversationKey = mapped ?? (f.conversation ?? (privateConversation ? 'bili:9:private:22' : 'bili:9:public:11'));
    const audience = privateConversation ? 'private' : 'public';
    f.identityCalls.push({ action, target: actualTarget, selector: { ...selector }, conversationKey, audience });
    return { ok: true, accountMid: f.accountSwitched ? '10' : '9', conversationKey, sourceAccountKey: 'bili:9:actor:9', requesterAccountKey: 'bili:9:actor:9', providerRouteId: route, audience, ...(actualTarget ? { target: actualTarget } : {}) };
  };
  f.defaultRecord = selector => {
    const privateSource = f.privateSource;
    return { sourceKey: selector.kind === 'tool' ? 'bili:read:32' : 'bili:reply:31', revision: f.revision, kind: privateSource ? 'dm' : 'comment', objectId: privateSource ? '31' : selector.kind === 'tool' ? '32' : '31', authorMid: privateSource ? '22' : '8', occurredAt: '2026-11-10T00:00:00.000Z', audience: privateSource ? 'private' : 'public', target: privateSource ? { audience: 'private', kind: 'dm', mid: '22' } : target, coverage: f.coverage ?? 'full', wire: f.wire ?? (privateSource ? { msg_key: '31', sender_uid: '22', receiver_id: '9', msg_type: 1, content: JSON.stringify({ content: 'Private original.' }) } : { rpid: selector.kind === 'tool' ? '32' : '31', member: { mid: '8' }, oid: '11', type: '1', root: '0', parent: '0', content: { message: 'Complete official original.' }, api_key: 'CONTROL_SECRET_CANARY' }) };
  };
  f.transport = {
    hydrate: async ({ selector }) => {
      f.hydrated++;
      if (f.unknown) return { ok: true, conversationKey: f.conversationKey(), records: [] };
      const records = f.records ? f.records(selector) : [f.defaultRecord(selector)];
      return { ok: true, conversationKey: f.conversationKey(), records };
    },
    revalidate: async ({ sources }) => { f.transportChecks++; return { ok: true, unchanged: sources.every(source => source.revision === f.revision) }; },
  };
  f.job = Object.freeze({ jobId: 'job:' + randomUUID(), requestId: 'request:' + randomUUID(), characterId: 'alpha', characterEpoch: 1, sessionId: 'session:' + randomUUID(), providerRouteId: route, provider: 'fixture-source', model: 'fixture-model' });
  f.config = { provider: f.job.provider, model: f.job.model };
  f.agent = { session: { id: f.job.sessionId }, ctx: { tools: { schemas: () => specs } } };
  f.nativeRoot = { getCurrentCall: () => f.call, ownsAgent: agent => agent === f.agent, ownsRequest: value => value === f.call?.request };
  f.makeSources = () => createBiliV2SourceRuntime({ memoryV2: { adapter: f.adapter }, getCharacter: () => f.role, corePersona: persona, nativeRoot: f.nativeRoot, nativeCodec: f.codec, getNativeConfig: () => f.call?.preparedConfig, getIdentity: f.identity, sourceTransport: f.transport });
  f.sources = f.makeSources();
  f.prompt = () => f.sources.preparePrompt({ job: f.job, input: { kind: 'comment-notification', coverage: 'notification-only', items: [{ id: '31' }] } });
  f.begin = async (messages, dispatchId = randomUUID(), requestOverride = {}) => {
    const options = { ...f.config, messages, tools: canonicalSpecs, toolHistory: { tools: [], updates: [] }, sessionId: f.job.sessionId, signal: new AbortController().signal, ...requestOverride };
    const request = { requestId: f.job.jobId + ':inference:1', sessionId: f.job.sessionId, inputDigest: biliV2InputDigest(options) };
    f.call = { agent: f.agent, request: options, preparedConfig: f.config, callId: randomUUID() }; f.options = options; f.request = request; f.dispatchId = dispatchId;
    good(await f.sources.captureModelOutput({ job: f.job, options, request, dispatchId, phase: 'start' }));
    return f.sources.prepareInput({ job: f.job, options, request });
  };
  f.initialMessages = content => [f.codec.createSystemMessage(persona), f.codec.createUserMessage({ source: { kind: 'user-rpc', requestId: f.job.requestId }, content })];
  f.output = async blocks => { for (const [index, block] of blocks.entries()) good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'block-end', index, block } })); good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'finish', reason: { kind: blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } } })); good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'complete' })); return f.codec.createAssistantMessage({ content: blocks, source: { provider: f.job.provider, model: f.job.model } }); };
  f.close = async () => { f.sources.close(); f.host.close(); await f.service.close(); };
  return f;
}

const marker = 'Complete original remembered amberzebra';
const f = await fixture();
try {
  const seed = good(await f.adapter.capture({ conversationKey: f.conversationKey() }));
  const receipt = good(await f.adapter.ingest(seed.handle, [{ eventId: 'old-memory-event', operationId: 'old-memory-operation', sourceKey: 'old-memory-source', producerId: 'fixture-old', segmentId: 'old-memory-segment', producerSeq: 1, content: marker }], 'old-memory-batch'));
  good(await f.adapter.release(seed.handle));
  let issued; const prepare = f.adapter.prepare.bind(f.adapter);
  f.sources.close(); f.adapter = { ...f.adapter, prepare: async (...args) => { issued = await prepare(...args); return issued; } }; f.sources = f.makeSources();
  const prompt = good(await f.prompt());
  assert.ok(JSON.stringify(prompt.content).includes(marker), 'Core-issued prior memory must reach the prompt');
  assert.ok(issued?.prepared.inputManifest.some(ref => ref.id === receipt.eventRefs[0].id), 'Core must issue the prior memory reference');
  good(await f.begin(f.initialMessages(prompt.content)));
  console.log('PASS real Worker recall in prepared prompt');
} finally { await f.close(); }
async function negativeCase(name, change, expected, afterPrompt = false) {
  const fixtureValue = await fixture();
  try {
    fixtureValue.sources.close();
    fixtureValue.adapter = change(fixtureValue.adapter, fixtureValue);
    fixtureValue.sources = fixtureValue.makeSources();
    const prompt = await fixtureValue.prompt();
    if (afterPrompt) {
      good(prompt);
      const result = await fixtureValue.begin(fixtureValue.initialMessages(prompt.content));
      bad(result, expected);
    } else bad(prompt, expected);
    assert.equal(fixtureValue.sources.getStatus().admittedInputs, 0);
    console.log('PASS ' + name);
  } finally { await fixtureValue.close(); }
}
await negativeCase('prepared failure cannot fall back to empty recall', adapter => ({ ...adapter, prepare: async () => ({ ok: false, code: 'MEMORY_PREPARED_STALE', error: 'Expired fixture.', hint: 'Retry safely.' }) }), 'MEMORY_PREPARED_STALE');
await negativeCase('foreign or changed issued copy is refused', adapter => ({ ...adapter, prepare: async (...args) => { const result = await adapter.prepare(...args); return result.ok ? { ...result, prepared: { ...result.prepared, text: result.prepared.text + ' forged' } } : result; } }), 'MEMORY_PREPARED_UNTRUSTED');
await negativeCase('foreign prepared handle is refused', adapter => ({ ...adapter, prepare: async (...args) => { const result = await adapter.prepare(...args); return result.ok ? { ...result, preparedHandle: 'foreign' } : result; } }), 'MEMORY_PREPARED_UNTRUSTED');
await negativeCase('prepared expiry blocks provider input', adapter => { let calls = 0; return { ...adapter, validate: async (...args) => { if (args[1] && ++calls >= 3) return { ok: false, code: 'MEMORY_PREPARED_STALE', error: 'Expired fixture.', hint: 'Retry safely.' }; return adapter.validate(...args); } }; }, 'MEMORY_PREPARED_STALE', true);
{
  const empty = await fixture();
  try {
    empty.wire = { rpid: '31', member: { mid: '8' }, oid: '11', type: '1', root: '0', parent: '0', content: { message: '无历史 '.repeat(150) } };
    let issued; const prepare = empty.adapter.prepare.bind(empty.adapter);
    empty.sources.close(); empty.adapter = { ...empty.adapter, prepare: async (...args) => (issued = await prepare(...args)) }; empty.sources = empty.makeSources();
    const prompt = good(await empty.prompt()); assert.equal(issued.prepared.text, ''); good(await empty.begin(empty.initialMessages(prompt.content)));
    console.log('PASS valid empty recall is admitted');
  } finally { await empty.close(); }
}

async function nativeSourceCycle() {
  const f = await fixture(), require = createRequire(import.meta.url), base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/', load = name => require(base + name + '/lib/index.js');
  const seed = good(await f.adapter.capture({ conversationKey: f.conversationKey() }));
  const seeded = good(await f.adapter.ingest(seed.handle, [{ eventId: 'actual-old-recall', operationId: 'actual-old-operation', sourceKey: 'actual-old-source', producerId: 'fixture-old-native', segmentId: 'old-native-segment', producerSeq: 1, content: marker }], 'actual-old-batch'));
  good(await f.adapter.release(seed.handle));
  let issued; const manifests = [], original = f.adapter;
  f.adapter = { ...original, prepare: async (...args) => (issued = await original.prepare(...args)), bindActualInput: async (handle, refs) => { const result = await original.bindActualInput(handle, refs); if (result.ok) manifests.push(structuredClone(refs)); return result; } };
  const actual = { ...require(base + 'cordis'), ...load('dsh-llm'), ...load('dsh-tools') };
  const bootstrapModules = { Context: actual.Context, SessionProjectionRegistry: load('dsh-session-projection').default, SessionStore: load('dsh-session').default, AgentRegistry: load('dsh-agent').default, SystemPrompt: load('dsh-system-prompt').default, ToolsService: actual.ToolsService, Loader: load('cordis-plugin-loader').default, AgentLoop: load('dsh-agent-loop').default, AgentPresetRegistry: load('dsh-agent-preset-registry').default, nativeExecutor: load('dsh-tool-executor-native'), isAgentLoopRequest: actual.isAgentLoopRequest };
  const outer = new actual.Context(), fibers = [], errors = [], network = [];
  const savedFetch = globalThis.fetch; globalThis.fetch = (...args) => { network.push(String(args[0])); throw new Error('External network disabled.'); };
  const budget = createTokenBudgetService({ ctx: {}, dshHome: f.dir, qqStateDir: path.join(f.dir, 'qq') });
  let owned, runtime, retained, providerCalls = 0, sawBoundTool = false, shellDenied = false;
  const deadline = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native source cycle deadline')), 15000); })]); } finally { clearTimeout(timer); } };
  try {
    outer.baseUrl = new URL('../package.json', import.meta.url).href;
    for (const plugin of [bootstrapModules.SystemPrompt, bootstrapModules.ToolsService, load('dsh-llm').default, bootstrapModules.Loader]) { const fiber = outer.plugin(plugin); fibers.push(fiber); await fiber; }
    const environment = await loadMemoryV2NativeEnvironment({ ctx: outer });
    outer.systemPrompt.section({ name: 'source-ancestor-canary', text: 'UNSAFE_SOURCE_ANCESTOR', order: 0 });
    class FakeOfficialModel extends actual.LlmAdapter {
      async *stream(options) {
        providerCalls++; retained = owned.getCurrentCall().agent;
        assert.equal(owned.getCurrentCall().request, options); assert.equal(owned.ctx.agents.get(options.sessionId), retained);
        assert.ok(!JSON.stringify(options).includes('CONTROL_SECRET_CANARY')); assert.ok(!JSON.stringify(options).includes('UNSAFE_SOURCE_ANCESTOR'));
        assert.ok(JSON.stringify(options.messages).includes(marker), 'actual SDK request must include earlier Core memory');
        assert.ok(issued?.prepared.inputManifest.some(ref => ref.id === seeded.eventRefs[0].id), 'Core must issue the old event reference');
        assert.ok(manifests.at(-1)?.some(ref => ref.id === seeded.eventRefs[0].id), 'actual input manifest must retain the old event reference');
        if (providerCalls === 1) {
          const blocked = await owned.ctx.tools.execute({ calls: [{ id: 'unknown-shell', name: 'bash', arguments: '{}' }], agent: retained, signal: options.signal }); assert.equal(blocked.results[0].result.isError, true); shellDenied = true;
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'real-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          assert.equal(providerCalls, 2); sawBoundTool = options.messages.some(message => message.role === 'tool' && message.toolCallId === 'real-read' && JSON.stringify(message.content).includes('Complete official original.'));
          assert.equal(sawBoundTool, true); f.revision = 'revoked-before-paid-usage';
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'MUST_NOT_ESCAPE_AFTER_REVOCATION' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    outer.llm.registerAdapter(['fixture-source'], new FakeOfficialModel());
    owned = await createIsolatedNativeRoot({ nativeModules: environment.nativeModules, llm: environment.llm, getLlmHookContext: environment.getLlmHookContext, corePersona: persona, onStream: (options, next) => next(options) });
    owned.ctx.on('agent/error', ({ error }) => errors.push({ code: error?.code, message: error?.message }));
    f.sources.close(); f.sources = createBiliV2SourceRuntime({ memoryV2: { adapter: f.adapter }, getCharacter: () => f.role, corePersona: persona, nativeRoot: owned, nativeCodec: environment.nativeCodec, getNativeConfig: () => owned.getCurrentCall()?.preparedConfig, getIdentity: f.identity, sourceTransport: f.transport });
    runtime = createBiliV2AgentRuntime({ nativeRoot: owned, memoryV2: { adapter: f.adapter, getRouting: () => ({ ok: true, backend: 'v2' }) }, getCharacter: () => f.role, tokenBudget: budget, isAgentLoopRequest: actual.isAgentLoopRequest, sourceRuntime: f.sources, modelRequest: () => ({ estimatedTokens: 100 }), getModelRoute: () => ({ provider: 'fixture-source', model: 'fixture-model', providerRouteId: route }), transport: { async read() { return { ok: true, stdout: JSON.stringify({ summary: 'selector only, not an original' }) }; }, send() { throw new Error('Platform write forbidden.'); } }, registryPath: path.join(f.dir, 'native-registry.json'), onBlocked: error => errors.push(error) });
    const accepted = good(await deadline(runtime.enqueue({ requestId: 'real-source-native', input: { kind: 'comment-notification', coverage: 'notification-only', items: [{ id: '31' }] } })));
    const sessionId = accepted.sessionId; retained = owned.ctx.agents.get(sessionId);
    await deadline(retained.whenIdle()); await deadline(runtime.retire());
    assert.equal(providerCalls, 2, JSON.stringify({ errors, sourceStatus: f.sources.getStatus() })); assert.equal(sawBoundTool, true); assert.equal(shellDenied, true);
    const status = f.sources.getStatus(); assert.equal(status.failure?.code, 'BILI_SOURCE_CHANGED'); assert.equal(status.jobs, 0); assert.equal(status.activeSourceCount, 0); assert.equal(runtime.getStatus().activeJobs, 0); assert.equal(owned.getStatus().activeHandles, 0); assert.equal(owned.getStatus().activeTools, 0); assert.equal(status.admittedInputs, 2); assert.equal(status.committedOutputs, 1); assert.equal(status.sourceCount, 2); assert.equal(status.derivedPersisted, false);
    const budgetStatus = await budget.status(); const tokens = budgetStatus.usage.total.tokens; assert.equal(tokens, 30, JSON.stringify(budgetStatus));
    bad(await f.sources.validate({ job: { ...f.job, jobId: 'unknown-job' } }), 'BILI_SOURCE_JOB_UNBOUND');
    bad(await f.sources.validate({ job: f.latestJob }), 'BILI_SOURCE_JOB_UNBOUND'); f.role = { id: 'beta', epoch: 2 }; bad(await f.sources.validate({ job: f.latestJob }), 'BILI_SOURCE_JOB_UNBOUND'); f.role = { id: 'alpha', epoch: 1 }; await f.worker.terminate(); bad(await f.sources.validate({ job: f.latestJob })); assert.equal((await budget.status()).usage.total.tokens, tokens);
    const capturedJob = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-registry.json'), 'utf8')).sessions[sessionId]; assert.ok(capturedJob);
    assert.equal(owned.ctx.agents.get(sessionId), undefined); assert.equal(owned.ctx.sessions.store.has(sessionId), false); assert.deepEqual(network, []);
    await deadline(runtime.close()); await deadline(owned.close());
    const result = { oldRecallInActualSdkInput: true, oldCoreReferenceInActualManifest: true, ok: true, actualNativeCodecs: true, actualEnvironmentLoader: true, actualWorkerPrivateHost: true, providerCalls, matchedNativeInputs: status.admittedInputs, committedOutputs: status.committedOutputs, sourceCount: status.sourceCount, legalNextStepToolResult: sawBoundTool, unknownShellDenied: shellDenied, lateRevocationStopsOutput: status.failure?.code === 'BILI_SOURCE_CHANGED', tokens, derivedPersisted: false, externalNetwork: network, platformWrites: 0, nativeCycle: 1 };
    assert.equal(result.lateRevocationStopsOutput, true, JSON.stringify(errors)); fs.writeFileSync(path.join(f.dir, 'native-result.json'), JSON.stringify(result, null, 2)); console.log('PASS actual native Bili source proof ' + JSON.stringify(result));
  } finally {
    await deadline(runtime?.close()).catch(() => {}); await deadline(owned?.close()).catch(() => {}); budget.dispose(); for (const fiber of fibers.reverse()) await deadline(fiber.dispose()).catch(() => {}); await outer.fiber.dispose(); globalThis.fetch = savedFetch; await f.close();
  }
}
if (process.env.SURFCORE_BILI_RECALL_NATIVE === '1') await nativeSourceCycle();
