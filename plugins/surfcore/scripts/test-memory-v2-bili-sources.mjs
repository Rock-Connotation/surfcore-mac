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

const rootDir = path.resolve('_backups/memory-v2-bili-sources', 'run-' + process.version + '-' + randomUUID());
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
async function test(name, body, options) {
  if (only && !name.includes(only)) return;
  const f = await fixture(options);
  try { await body(f); count++; console.log('PASS ' + name); } finally { await f.close(); }
}

await test('a capture finishing after release cannot retain a new opaque handle', async f => {
  let reached, resume; const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  const capture = f.adapter.capture.bind(f.adapter), release = f.adapter.release.bind(f.adapter); let releases = 0;
  f.sources.close();
  f.adapter = { ...f.adapter, capture: async (...args) => { const value = await capture(...args); reached(); await gate; return value; }, release: (...args) => { releases++; return release(...args); } };
  f.sources = f.makeSources();
  const pending = f.prompt(); await ready; good(await f.sources.releaseJob({ job: f.job })); resume();
  bad(await pending, 'BILI_SOURCE_JOB_UNBOUND'); assert.equal(releases, 1); assert.equal(f.sources.getStatus().jobs, 0);
});
await test('per-job release revokes source proof and clears live state while retaining content-free counters', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  bad(await f.sources.releaseJob({ job: { ...f.job, sessionId: 'forged-session' } }), 'BILI_SOURCE_JOB_UNBOUND');
  assert.equal(f.sources.getStatus().jobs, 1);
  await Promise.all([f.sources.releaseJob({ job: f.job }), f.sources.releaseJob({ job: f.job })]).then(results => results.forEach(good));
  const status = f.sources.getStatus(); assert.equal(status.jobs, 0); assert.equal(status.activeSourceCount, 0);
  assert.equal(status.sourceCount, 1); assert.equal(status.admittedInputs, 1); assert.equal(status.committedOutputs, 0);
  bad(await f.sources.validate({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId }), 'BILI_SOURCE_JOB_UNBOUND');
  good(await f.sources.releaseJob({ job: f.job })); assert.equal(f.sources.getStatus().sourceCount, 1);
});
await test('real worker commits redacted full sources and binds the complete original manifest', async f => {
  const prompt = good(await f.prompt()); assert.ok(!JSON.stringify(prompt).includes('CONTROL_SECRET_CANARY')); good(await f.begin(f.initialMessages(prompt.content))); assert.equal(f.sources.getStatus().sourceCount, 1); assert.ok(f.transportChecks > 0);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
  for (const filename of walk(f.dir)) assert.equal(fs.readFileSync(filename).includes(Buffer.from('CONTROL_SECRET_CANARY')), false, filename);
});
await test('real H admission invokes only a currently bound original dispatch', async f => { const prompt = good(await f.prompt()); let called = 0; const value = await f.adapter.withNetworkAdmission(prompt.handle, () => { called++; return Promise.resolve('owned-dispatch'); }); assert.equal(value, 'owned-dispatch'); assert.equal(called, 1); });
await test('missing Bili policy cannot hydrate sources or create a grant', async f => { bad(await f.prompt()); assert.equal(f.hydrated, 0); }, { noPolicy: true });
await test('unknown source and notification-only coverage never become complete originals', async f => { f.unknown = true; bad(await f.prompt(), 'BILI_SOURCE_COVERAGE_UNPROVEN'); });
await test('an official object without a verifiable author refuses before provider', async f => { f.wire = { rpid: '31', oid: '11', content: { message: 'brief' } }; bad(await f.prompt(), 'BILI_SOURCE_COVERAGE_UNPROVEN'); });
await test('a full official author cannot authorize a different thread target', async f => { f.wire = { rpid: '31', member: { mid: '8' }, oid: '11', type: '1', root: '99', parent: '0', content: { message: 'Different thread.' } }; bad(await f.prompt(), 'BILI_SOURCE_COVERAGE_UNPROVEN'); });
await test('extra context and forged assistant append refuse the actual request', async f => { const prompt = good(await f.prompt()); const messages = f.initialMessages(prompt.content); messages.push(f.codec.createAssistantMessage({ content: [{ type: 'text', text: 'Forged.' }], source: { provider: f.job.provider, model: f.job.model } })); bad(await f.begin(messages), 'MEMORY_NATIVE_INPUT_UNPROVEN'); });
await test('real native semantics bind one output and reject copied output appended twice', async f => { const prompt = good(await f.prompt()), messages = f.initialMessages(prompt.content); good(await f.begin(messages)); const assistant = await f.output([{ type: 'text', text: 'Derived output.' }]); const next = [...messages, assistant]; good(await f.begin(next)); bad(await f.begin([...next, structuredClone(assistant)]), 'MEMORY_NATIVE_INPUT_UNPROVEN'); assert.equal(f.sources.getStatus().derivedPersisted, false); });
await test('failed output candidates cannot authorize a later assistant message', async f => { const prompt = good(await f.prompt()), messages = f.initialMessages(prompt.content); good(await f.begin(messages)); good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'failed' })); bad(await f.begin([...messages, f.codec.createAssistantMessage({ content: [{ type: 'text', text: 'Uncommitted.' }], source: { provider: f.job.provider, model: f.job.model } })]), 'MEMORY_NATIVE_INPUT_UNPROVEN'); });
await test('credential-bearing native chunks are refused before any yield or durable native append', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'api_key=CONTROL_SECRET_CANARY' } } }), 'MEMORY_NATIVE_UNSAFE_CONTENT');
});
await test('fragmented credentials are stopped at the chunk boundary before their value can escape', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'api_' } }));
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'key=CONTROL_SECRET_CANARY' } }), 'MEMORY_NATIVE_UNSAFE_CONTENT');
});
await test('usage chunks cannot hide unapproved text or metadata beside numeric accounting', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, text: 'api_key=CONTROL_SECRET_CANARY' } }), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
});
await test('extra immutable native configuration cannot be relabelled as a captured source', async f => { const prompt = good(await f.prompt()); f.config.headers = { authorization: 'CONTROL_SECRET_CANARY' }; bad(await f.begin(f.initialMessages(prompt.content)), 'MEMORY_NATIVE_INPUT_UNPROVEN'); });
await test('unrecognized prepared config strings remain unknown input even when they match the actual envelope', async f => { const prompt = good(await f.prompt()); f.config.extraContext = 'An unapproved private instruction.'; bad(await f.begin(f.initialMessages(prompt.content)), 'MEMORY_NATIVE_INPUT_UNPROVEN'); });
await test('copied prepared config cannot replace the actual private pointer', async f => { const prompt = good(await f.prompt()); f.nativeRoot.getCurrentCall = () => ({ ...f.call, preparedConfig: { ...f.config } }); bad(await f.begin(f.initialMessages(prompt.content)), 'MEMORY_NATIVE_INPUT_UNPROVEN'); });
await test('failed output is discarded even after role cancellation and an aborted signal', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content))); const controller = new AbortController(); controller.abort(); f.role = { id: 'beta', epoch: 2 };
  good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'failed', signal: controller.signal })); assert.equal(f.sources.getStatus().committedOutputs, 0);
});
await test('private original references cannot be laundered into a public dynamic target', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content))); await f.output([{ type: 'tool-call', id: 'call-1', name: 'surfcore_bili_dynamic', arguments: JSON.stringify({ text: 'Private material.' }) }]);
  const execution = { agent: f.agent, token: {}, callId: 'call-1', name: 'surfcore_bili_dynamic', arguments: { text: 'Private material.' } };
  bad(await f.sources.prepareSend({ job: f.job, execution, action: 'dynamic', target: { audience: 'public', kind: 'dynamic' }, payload: { body: { content: { contents: [{ type: 1, raw_text: 'Private material.' }] } } } }));
}, { privateSource: true });
await test('revision changes and role changes invalidate sources without rebinding old bytes', async f => { good(await f.prompt()); f.revision = 'revision-2'; bad(await f.sources.validate({ job: f.job }), 'BILI_SOURCE_CHANGED'); f.role = { id: 'beta', epoch: 2 }; bad(await f.sources.validate({ job: f.job }), 'CHARACTER_EPOCH_STALE'); });
await test('retained source grants cannot cross a live Host account switch', async f => { good(await f.prompt()); f.accountSwitched = true; bad(await f.sources.validate({ job: f.job }), 'BILI_SOURCE_IDENTITY_CHANGED'); });
await test('worker loss is visible and cannot become a provider fallback', async f => { good(await f.prompt()); await f.worker.terminate(); bad(await f.sources.validate({ job: f.job })); });
await test('accepted native tool call captures a separate full source before its result is authorized', async f => {
  const prompt = good(await f.prompt()), messages = f.initialMessages(prompt.content); good(await f.begin(messages)); const assistant = await f.output([{ type: 'tool-call', id: 'call-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) }]);
  const value = good(await f.sources.captureToolResult({ job: f.job, execution: { agent: f.agent, token: {}, callId: 'call-read', name: 'surfcore_bili_read', arguments: { kind: 'feed' } }, action: 'feed', result: { stdout: 'Untrusted CLI summary.', derived: false } }));
  const tool = f.codec.createToolResultMessage({ callId: 'call-read', content: [{ type: 'text', text: JSON.stringify({ ok: true, result: value.result }) }], isError: false });
  good(await f.begin([...messages, assistant, tool])); assert.equal(f.sources.getStatus().sourceCount, 2);
});
await test('actual Host canonical tool order with a complete non-empty tool history is admitted', async f => {
  const prompt = good(await f.prompt());
  good(await f.begin(f.initialMessages(prompt.content), randomUUID(), { tools: canonicalSpecs, toolHistory: { tools: canonicalSpecs, updates: [] } }));
});
await test('Host registration order is refused for request tools', async f => {
  const prompt = good(await f.prompt());
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { tools: specs }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('an unknown request tool cannot join the canonical Host tool list', async f => {
  const prompt = good(await f.prompt());
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { tools: [...canonicalSpecs, { name: 'bash', description: 'Unapproved shell.', parameters: {} }] }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('an unknown tool cannot hide inside a non-empty Host tool history', async f => {
  const prompt = good(await f.prompt());
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { toolHistory: { tools: [...canonicalSpecs, { name: 'bash', description: 'Unapproved shell.', parameters: {} }], updates: [] } }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('a changed description on an approved tool is refused in both request tools and history', async f => {
  const prompt = good(await f.prompt());
  const altered = canonicalSpecs.map(spec => spec.name === 'surfcore_bili_read' ? { ...spec, description: 'Forged Bili read.' } : spec);
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { tools: altered, toolHistory: { tools: altered, updates: [] } }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('a duplicated canonical tool is refused', async f => {
  const prompt = good(await f.prompt());
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { tools: [...canonicalSpecs, canonicalSpecs[0]] }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('a non-empty Host tool history carrying any update is refused', async f => {
  const prompt = good(await f.prompt());
  bad(await f.begin(f.initialMessages(prompt.content), randomUUID(), { toolHistory: { tools: canonicalSpecs, updates: [{ messageId: 'extra', additions: [] }] } }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
});
await test('retired today kind cannot enter native source provenance', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  const hydrated = f.hydrated, sourceCount = f.sources.getStatus().sourceCount;
  const block = { type: 'tool-call', id: 'call-today', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'today' }) };
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'block-end', index: 0, block } }), 'MEMORY_NATIVE_INPUT_UNPROVEN');
  assert.equal(f.hydrated, hydrated, 'today must not hydrate a source');
  assert.equal(f.sources.getStatus().sourceCount, sourceCount, 'today must not commit a source');
});
await test('retired today action cannot be captured as a read source while feed still can', async f => {
  const prompt = good(await f.prompt()); good(await f.begin(f.initialMessages(prompt.content)));
  await f.output([{ type: 'tool-call', id: 'call-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) }]);
  const hydrated = f.hydrated, sourceCount = f.sources.getStatus().sourceCount;
  const execution = { agent: f.agent, token: {}, callId: 'call-read', name: 'surfcore_bili_read', arguments: { kind: 'feed' } };
  bad(await f.sources.captureToolResult({ job: f.job, execution, action: 'today', result: { stdout: 'Untrusted CLI summary.', derived: false } }), 'BILI_SOURCE_RECEIPT_UNPROVEN');
  assert.equal(f.hydrated, hydrated, 'today must not hydrate a source');
  assert.equal(f.sources.getStatus().sourceCount, sourceCount, 'today must not commit a source');
  const feed = good(await f.sources.captureToolResult({ job: f.job, execution, action: 'feed', result: { stdout: 'Untrusted CLI summary.', derived: false } }));
  assert.ok(feed.result.sources);
});

await test('video text-only source admitted with the exact public wire', async f => {
  f.records = () => [videoRecord()];
  const prompt = good(await f.prompt());
  const rendered = JSON.stringify(prompt.content);
  assert.ok(rendered.includes('text-only'));
  const body = prompt.content[0].text, sources = JSON.parse(body.slice(body.indexOf('\n') + 1));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, 'video');
  assert.equal(sources[0].coverage, 'text-only');
  assert.ok(rendered.includes('A raw video title'));
  assert.equal(f.sources.getStatus().sourceCount, 1);
  assert.equal(f.ingests.length, 1);
  assert.equal(f.ingests[0].ok, true);
  assert.equal(f.ingests[0].refs.length, 1);
  const reads = f.identityCalls.filter(call => call.action === 'read' && call.target?.kind === 'video');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].selector, { kind: 'video', bvid: VIDEO_BV, aid: VIDEO_AID, authorMid: VIDEO_AUTHOR });
  const prompts = f.identityCalls.filter(call => call.action === 'prompt');
  assert.ok(prompts.length > 0 && prompts.every(call => Object.keys(call.selector).length === 0), 'prompt/live/send identity must carry no sourceSelector');
  good(await f.begin(f.initialMessages(prompt.content)));
  console.log('VIDEO-EVIDENCE positive ' + JSON.stringify({ eventId: f.ingests[0].eventIds[0], refs: f.ingests[0].refs, coverage: 'text-only' }));
});
await test('video text-only source refuses incomplete, private and extended wires', async f => {
  const base = videoRecord(), otherBv = 'BV9Zz8Yy7Xx6';
  const variants = [
    ['extra wire field', { wire: { ...base.wire, duration: 120 } }],
    ['missing wire field', { wire: { bvid: VIDEO_BV, aid: VIDEO_AID, title: 'T', desc: '', owner: { mid: VIDEO_AUTHOR, name: 'Author' } } }],
    ['extra owner field', { wire: { ...base.wire, owner: { mid: VIDEO_AUTHOR, name: 'Author', face: 'x' } } }],
    ['extra media stats field', { wire: { ...base.wire, stat: { view: 1 } } }],
    ['wire BV mismatch', { wire: { ...base.wire, bvid: otherBv } }],
    ['malformed BV', { wire: { ...base.wire, bvid: 'BVshort' } }],
    ['wire aid mismatch', { wire: { ...base.wire, aid: '170002' } }],
    ['objectId mismatch', { objectId: '170002' }],
    ['author mismatch', { wire: { ...base.wire, owner: { mid: '9', name: 'Author' } } }],
    ['full coverage', { coverage: 'full' }],
    ['observed receiver coverage', { coverage: 'observed-receiver' }],
    ['private target', { target: { audience: 'private', kind: 'video', bvid: VIDEO_BV, aid: VIDEO_AID } }],
    ['private audience', { audience: 'private' }],
    ['target extra field', { target: { audience: 'public', kind: 'video', bvid: VIDEO_BV, aid: VIDEO_AID, duration: 1 } }],
    ['pubdate beyond Date bound', { pubdate: 8640000000001, occurredAt: '2023-11-14T22:13:20.000Z' }],
    ['zero pubdate', { pubdate: 0, occurredAt: '1970-01-01T00:00:00.000Z' }],
    ['string pubdate', { pubdate: '1700000000', occurredAt: '2023-11-14T22:13:20.000Z' }],
    ['occurredAt mismatch', { occurredAt: '2023-11-14T22:13:21.000Z' }],
    ['blank title', { wire: { ...base.wire, title: '   ' } }],
    ['non-string title', { wire: { ...base.wire, title: 5 } }],
    ['non-string desc', { wire: { ...base.wire, desc: null } }],
    ['non-string owner name', { wire: { ...base.wire, owner: { mid: VIDEO_AUTHOR, name: null } } }],
  ];
  const seen = [];
  for (const [label, overrides] of variants) {
    f.records = () => [videoRecord(overrides)];
    const denied = bad(await f.sources.preparePrompt({ job: otherJob(f), input: VIDEO_INPUT }), 'BILI_SOURCE_COVERAGE_UNPROVEN');
    seen.push({ label, code: denied.code });
  }
  assert.equal(seen.length, variants.length);
  console.log('VIDEO-EVIDENCE negatives ' + JSON.stringify(seen));
});
await test('video text-only source accepts boundary pubdate', async f => {
  f.records = () => [videoRecord({ pubdate: 8640000000000 })];
  good(await f.prompt());
  assert.deepEqual(f.ingests[0].occurredAts, ['+275760-09-13T00:00:00.000Z']);
  assert.equal(f.ingests.length, 1);
  assert.equal(f.ingests[0].ok, true);
  console.log('VIDEO-EVIDENCE maxDate ' + JSON.stringify({ occurredAt: '+275760-09-13T00:00:00.000Z', eventId: f.ingests[0].eventIds[0] }));
});
await test('video text-only source admits a typed read result', async f => {
  f.records = selector => [videoRecord(selector.kind === 'tool' ? { sourceKey: 'bili:video:tool:32' } : {})];
  const prompt = good(await f.prompt()), messages = f.initialMessages(prompt.content);
  good(await f.begin(messages));
  const assistant = await f.output([{ type: 'tool-call', id: 'call-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) }]);
  const execution = { agent: f.agent, token: {}, callId: 'call-read', name: 'surfcore_bili_read', arguments: { kind: 'feed' } };
  const value = good(await f.sources.captureToolResult({ job: f.job, execution, action: 'feed', result: { stdout: 'Untrusted CLI summary.', derived: false } }));
  assert.equal(f.sources.getStatus().sourceCount, 2);
  assert.equal(f.ingests.length, 2);
  assert.ok(f.ingests.every(item => item.ok === true));
  assert.notEqual(f.ingests[0].eventIds[0], f.ingests[1].eventIds[0]);
  const tool = f.codec.createToolResultMessage({ callId: 'call-read', content: [{ type: 'text', text: JSON.stringify({ ok: true, result: value.result }) }], isError: false });
  good(await f.begin([...messages, assistant, tool]));
  console.log('VIDEO-EVIDENCE typedRead ' + JSON.stringify({ eventIds: f.ingests.map(item => item.eventIds[0]) }));
});
await test('one physical source ingests separately in two approved conversations', async f => {
  f.records = () => [videoRecord()];
  f.conversation = 'bili:9:public:11';
  good(await f.sources.preparePrompt({ job: f.job, input: VIDEO_INPUT }));
  f.conversation = 'bili:9:public:33';
  good(await f.sources.preparePrompt({ job: otherJob(f), input: VIDEO_INPUT }));
  assert.equal(f.ingests.length, 2);
  assert.ok(f.ingests.every(item => item.ok === true));
  assert.notEqual(f.ingests[0].eventIds[0], f.ingests[1].eventIds[0]);
  assert.notEqual(f.ingests[0].sourceKeys[0], f.ingests[1].sourceKeys[0]);
  assert.notEqual(f.ingests[0].operationId, f.ingests[1].operationId);
  assert.equal(new Set(f.captures.map(item => item.stampConversationKey)).size, 2);
  assert.equal(f.sources.getStatus().sourceCount, 2);
  console.log('VIDEO-EVIDENCE conversations ' + JSON.stringify({ eventIds: f.ingests.map(item => item.eventIds[0]), conversations: f.captures.map(item => item.stampConversationKey) }));
}, { publicAudiences: ['bili:9:public:11', 'bili:9:public:33'] });
await test('two same-target comment originals reach Host with distinct complete selectors', async f => {
  f.selectorConversations = { '31': 'bili:9:public:11', '32': 'bili:9:public:33' };
  f.records = () => ['31', '32'].map(rpid => ({
    sourceKey: 'bili:reply:' + rpid, revision: 'revision-1', kind: 'comment', objectId: rpid, authorMid: '8',
    occurredAt: '2026-11-10T00:00:00.000Z', audience: 'public', target, coverage: 'full',
    wire: { rpid, member: { mid: '8' }, oid: '11', type: '1', root: '0', parent: '0', content: { message: 'Complete official original.' } },
  }));
  const prompt = good(await f.prompt());
  good(await f.begin(f.initialMessages(prompt.content)));
  const reads = f.identityCalls.filter(call => call.action === 'read' && call.selector.kind === 'comment');
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map(call => call.selector.rpid), ['31', '32']);
  for (const call of reads) assert.deepEqual(Object.keys(call.selector).sort(), ['authorMid', 'kind', 'oid', 'parent', 'root', 'rpid', 'type']);
  assert.deepEqual(reads.map(call => call.conversationKey), ['bili:9:public:11', 'bili:9:public:33']);
  assert.equal(f.ingests.length, 2);
  assert.ok(f.ingests.every(item => item.ok === true));
  assert.notEqual(f.ingests[0].eventIds[0], f.ingests[1].eventIds[0]);
  assert.equal(f.sources.getStatus().sourceCount, 2);
  console.log('VIDEO-EVIDENCE selectors ' + JSON.stringify({ selectors: reads.map(call => call.selector), eventIds: f.ingests.map(item => item.eventIds[0]) }));
}, { publicAudiences: ['bili:9:public:11', 'bili:9:public:33'] });

await test('ordinary comment source proves real Worker ingest collision across two approved conversations', async f => {
  f.records = () => [{ sourceKey: 'bili:reply:31', revision: 'revision-1', kind: 'comment', objectId: '31', authorMid: '8', occurredAt: '2026-11-10T00:00:00.000Z', audience: 'public', target, coverage: 'full', wire: { rpid: '31', member: { mid: '8' }, oid: '11', type: '1', root: '0', parent: '0', content: { message: 'Complete official original.' } } }];
  f.conversation = 'bili:9:public:11';
  good(await f.sources.preparePrompt({ job: f.job, input: { kind: 'comment-notification', coverage: 'notification-only', items: [{ id: '31' }] } }));
  f.conversation = 'bili:9:public:33';
  const second = await f.sources.preparePrompt({ job: otherJob(f), input: { kind: 'comment-notification', coverage: 'notification-only', items: [{ id: '31' }] } });
  console.log('VIDEO-EVIDENCE collisionProbe ' + JSON.stringify({ ok: second?.ok, code: second?.code, ingests: f.ingests.map(item => ({ ok: item.ok, code: item.code ?? null, eventId: item.eventIds[0] })) }));
  good(second);
  assert.equal(f.ingests.length, 2);
  assert.notEqual(f.ingests[0].eventIds[0], f.ingests[1].eventIds[0]);
}, { publicAudiences: ['bili:9:public:11', 'bili:9:public:33'] });

await test('finish chunk is required and aborted or error finishes fail closed', async f => {
  const prompt = good(await f.prompt());
  good(await f.begin(f.initialMessages(prompt.content)));
  good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'candidate text' } } }));
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'complete' }), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
  for (const kind of ['error', 'aborted', 'max-tokens']) {
    bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'finish', reason: { kind } } }), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
  }
  good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }));
  bad(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
  good(await f.sources.captureModelOutput({ job: f.job, options: f.options, request: f.request, dispatchId: f.dispatchId, phase: 'complete' }));
});

async function nativeSourceCycle() {
  const f = await fixture(), require = createRequire(import.meta.url), base = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/', load = name => require(base + name + '/lib/index.js');
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
        if (providerCalls === 1) {
          const blocked = await owned.ctx.tools.execute({ calls: [{ id: 'unknown-shell', name: 'bash', arguments: '{}' }], agent: retained, signal: options.signal }); assert.equal(blocked.results[0].result.isError, true); shellDenied = true;
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'real-read', name: 'surfcore_bili_read', arguments: JSON.stringify({ kind: 'feed' }) } };
          yield { type: 'finish', reason: { kind: 'stop' } };
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
    const commandsDir = path.join(f.dir, 'commands'); fs.mkdirSync(commandsDir); fs.writeFileSync(path.join(commandsDir, 'feed.mjs'), 'console.log(JSON.stringify({summary:"selector only, not an original"}))');
    runtime = createBiliV2AgentRuntime({ nativeRoot: owned, memoryV2: { adapter: f.adapter, getRouting: () => ({ ok: true, backend: 'v2' }) }, getCharacter: () => f.role, tokenBudget: budget, isAgentLoopRequest: actual.isAgentLoopRequest, sourceRuntime: f.sources, modelRequest: () => ({ estimatedTokens: 100 }), getModelRoute: () => ({ provider: 'fixture-source', model: 'fixture-model', providerRouteId: route }), transport: { send() { throw new Error('Platform write forbidden.'); } }, registryPath: path.join(f.dir, 'native-registry.json'), nodeRuntime: process.execPath, commandsDir, onBlocked: error => errors.push(error) });
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
    const result = { ok: true, actualNativeCodecs: true, actualEnvironmentLoader: true, actualWorkerPrivateHost: true, providerCalls, matchedNativeInputs: status.admittedInputs, committedOutputs: status.committedOutputs, sourceCount: status.sourceCount, legalNextStepToolResult: sawBoundTool, unknownShellDenied: shellDenied, lateRevocationStopsOutput: status.failure?.code === 'BILI_SOURCE_CHANGED', tokens, derivedPersisted: false, externalNetwork: network, platformWrites: 0, nativeCycle: 1 };
    assert.equal(result.lateRevocationStopsOutput, true, JSON.stringify(errors)); fs.writeFileSync(path.join(f.dir, 'native-result.json'), JSON.stringify(result, null, 2)); console.log('PASS actual native Bili source proof ' + JSON.stringify(result));
  } finally {
    await deadline(runtime?.close()).catch(() => {}); await deadline(owned?.close()).catch(() => {}); budget.dispose(); for (const fiber of fibers.reverse()) await deadline(fiber.dispose()).catch(() => {}); await outer.fiber.dispose(); globalThis.fetch = savedFetch; await f.close();
  }
}
if (process.env.SURFCORE_BILI_SOURCES_NATIVE === '1') await nativeSourceCycle();

console.log(`PASS Bili real source proof: ${count} ordinary cases; evidence ${rootDir}`);
