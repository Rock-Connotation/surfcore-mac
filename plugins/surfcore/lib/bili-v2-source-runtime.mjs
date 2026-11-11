import { createHash } from 'node:crypto';
import { biliV2InputDigest } from './bili-v2-agent.mjs';
import { redactContent } from '../../../src/core/memory-v2-contract.js';

const fail = (code, hint) => Object.assign(new Error('Bili source proof was refused.'), { ok: false, code, error: 'Bili source proof was refused.', hint });
const requireProof = (condition, code = 'BILI_SOURCE_UNPROVEN', hint = 'Capture the complete original source under the current Host identity before retrying.') => { if (!condition) throw fail(code, hint); };
const good = (value) => { if (value?.ok !== true) throw fail(value?.code || 'BILI_SOURCE_UNPROVEN', value?.hint || 'Restore the original source context; do not retry under another role.'); return value; };
const hash = (value) => biliV2InputDigest({ value });
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value);
const numeric = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && !Object.getOwnPropertySymbols(value).length && Object.keys(Object.getOwnPropertyDescriptors(value)).every(key => keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key));
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = (value) => structuredClone(value);
const semantic = (message) => { requireProof(exact(message, ['id', 'role', 'source', 'content', 'toolCallId', 'isError']) && typeof message.id === 'string', 'MEMORY_NATIVE_INPUT_UNPROVEN'); const copy = { ...message }; delete copy.id; return copy; };
const credentialKey = /(?:token|password|passwd|secret|cookie|authorization|bearer|api[_-]?key|access[_-]?key)/i;
function redacted(value, key = '') {
  if (credentialKey.test(key)) return '[已隐藏]';
  if (typeof value === 'string') return redactContent(value);
  if (Array.isArray(value)) return value.map(item => redacted(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redacted(item, name)]));
  return value;
}
const string = { type: 'string', required: true };
const toolSpecs = [
  { name: 'surfcore_bili_read', description: 'Read a fixed Bili source; results are captured before returning.', parameters: { kind: { type: 'string', enum: ['feed', 'debrief'], required: true }, bv: { type: 'string' } } },
  { name: 'surfcore_bili_comment', description: 'Comment on an explicitly authorized actual Bili target.', parameters: { oid: string, type: { type: 'string', enum: ['1', '11', '17'], required: true }, text: string, bvid: { type: 'string' }, root: { type: 'string' }, parent: { type: 'string' } } },
  { name: 'surfcore_bili_dynamic', description: 'Publish one text dynamic using this job original action ID.', parameters: { text: string } },
  { name: 'surfcore_bili_dm', description: 'Reply to an authorized actual Bili private-message target.', parameters: { mid: string, text: string } },
];
const approvedRequestTools = Object.freeze([...toolSpecs].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
function safeText(text) {
  const harmlessFormatting = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim() : undefined;
  requireProof(typeof text === 'string' && redactContent(text) === harmlessFormatting && !/\b(?:token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b["']?\s*[:=：]/i.test(text), 'MEMORY_NATIVE_UNSAFE_CONTENT', 'An immutable native message contains bytes requiring redaction. Stop it before another provider request.');
}
function targetValid(target) {
  if (!target || !['public', 'private'].includes(target.audience)) return false;
  if (target.kind === 'dynamic') return exact(target, ['audience', 'kind']) && target.audience === 'public';
  if (target.kind === 'dm') return exact(target, ['audience', 'kind', 'mid']) && target.audience === 'private' && numeric(target.mid);
  if (target.kind === 'video') return exact(target, ['audience', 'kind', 'bvid', 'aid']) && Object.keys(target).length === 4 && target.audience === 'public' && typeof target.bvid === 'string' && /^BV[A-Za-z0-9]{10}$/.test(target.bvid) && typeof target.aid === 'string' && /^[1-9][0-9]{0,29}$/.test(target.aid);
  return exact(target, ['audience', 'kind', 'type', 'oid', 'root', 'parent']) && target.audience === 'public' && target.kind === 'comment' && ['1', '11', '17'].includes(target.type) && ['oid', 'root', 'parent'].every(key => numeric(target[key]));
}

export function createBiliV2SourceRuntime({ memoryV2, getCharacter, corePersona, nativeRoot, nativeCodec, getNativeConfig, getIdentity, sourceTransport, now = Date.now } = {}) {
  const adapter = memoryV2?.adapter, states = new Map();
  let closed = false, lastFailure;
  const retired = { sourceCount: 0, admittedInputs: 0, committedOutputs: 0 };
  const codecKeys = ['AssistantStreamAccumulator', 'BlockAssembler', 'createUserMessage', 'createAssistantMessage', 'createSystemMessage', 'createToolResultMessage'];
  requireProof(adapter && ['capture', 'ingest', 'bindActualInput', 'prepare', 'verifyPrepared', 'validate', 'release'].every(key => typeof adapter[key] === 'function') && typeof getCharacter === 'function' && typeof corePersona === 'string' && corePersona.length > 0 && typeof getNativeConfig === 'function' && typeof getIdentity === 'function' && typeof sourceTransport?.hydrate === 'function' && typeof sourceTransport?.revalidate === 'function' && codecKeys.every(key => typeof nativeCodec?.[key] === 'function'), 'BILI_SOURCE_UNSUPPORTED', 'Connect the real memory adapter, actual public native codecs and private fixed-action source transport.');
  safeText(corePersona);
  function current(state, signal) {
    const role = getCharacter();
    requireProof(states.get(state.job.jobId) === state && !state.releasing, 'BILI_SOURCE_JOB_UNBOUND', 'Use a live private Host job; released source proof cannot be reused.');
    requireProof(!closed && !signal?.aborted && role?.id === state.job.characterId && role?.epoch === state.job.characterEpoch, 'CHARACTER_EPOCH_STALE', 'Keep the original job cancelled; capture a new job under the new role.');
  }
  function stateFor(job, signal) {
    const state = states.get(job?.jobId);
    requireProof(state && hash(job) === state.jobHash, 'BILI_SOURCE_JOB_UNBOUND', 'Use the original private Host job; never rebind old source bytes.'); current(state, signal); return state;
  }
  function callFor(state, options) {
    const call = nativeRoot?.getCurrentCall?.();
    requireProof(call && nativeRoot.ownsAgent(call.agent) && nativeRoot.ownsRequest(options) && call.request === options && call.agent.session.id === state.job.sessionId, 'MEMORY_NATIVE_INPUT_UNPROVEN', 'Only the actual retained agent and original branded request may use source proof.');
    requireProof(!state.agent || state.agent === call.agent, 'MEMORY_NATIVE_INPUT_UNPROVEN'); state.agent = call.agent; return call;
  }
  async function identity(state, action, target, signal, sourceSelector) {
    const value = good(await getIdentity({ job: state.job, action, ...(target ? { target } : {}), signal, ...(sourceSelector || {}) })); current(state, signal);
    requireProof(exact(value, ['ok', 'accountMid', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'audience', 'target']) && numeric(value.accountMid) && id(value.conversationKey) && id(value.sourceAccountKey) && id(value.requesterAccountKey) && value.providerRouteId === state.job.providerRouteId && ['public', 'private'].includes(value.audience), 'BILI_SOURCE_IDENTITY_UNPROVEN');
    if (target) requireProof(targetValid(target) && value.audience === target.audience && hash(value.target) === hash(target), 'BILI_SOURCE_TARGET_UNPROVEN');
    if (state.accountMid) requireProof(state.accountMid === value.accountMid, 'BILI_SOURCE_IDENTITY_CHANGED'); else state.accountMid = value.accountMid;
    const captured = good(await adapter.capture({ conversationKey: value.conversationKey }));
    try { current(state, signal); } catch (error) { await adapter.release(captured.handle); throw error; }
    state.handles.add(captured.handle);
    const stamp = captured.sourceStamp;
    requireProof(stamp?.characterId === state.job.characterId && stamp.capturedEpoch === state.job.characterEpoch && stamp.channel === 'bili' && stamp.conversationKey === (value.conversationKey.startsWith('bili:') ? value.conversationKey : 'bili:' + value.conversationKey) && stamp.sourceAccountKey === value.sourceAccountKey && stamp.requesterAccountKey === value.requesterAccountKey && stamp.providerRouteId === value.providerRouteId, 'BILI_SOURCE_IDENTITY_UNPROVEN');
    return { ...value, handle: captured.handle };
  }
  async function valid(state, signal) {
    current(state, signal);
    const liveIdentity = good(await getIdentity({ job: state.job, action: 'prompt', signal })); current(state, signal);
    requireProof(exact(liveIdentity, ['ok', 'accountMid', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'audience', 'target']) && state.context && ['accountMid', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'audience'].every(key => liveIdentity[key] === state.context[key]), 'BILI_SOURCE_IDENTITY_CHANGED', 'The active Host account or source scope changed. Keep the original job cancelled.');
    if (state.preparation) good(adapter.verifyPrepared(state.context.handle, state.preparation.handle, state.preparation.prepared));
    for (const handle of state.handles) { good(await adapter.validate(handle, handle === state.context.handle ? state.preparation?.handle : undefined)); current(state, signal); }
    if (state.preparation) good(adapter.verifyPrepared(state.context.handle, state.preparation.handle, state.preparation.prepared));
    if (state.sources.size) { const checked = good(await sourceTransport.revalidate({ job: state.job, sources: [...state.sources.values()].map(source => clone(source.proof)), signal })); current(state, signal); requireProof(exact(checked, ['ok', 'unchanged']) && checked.unchanged === true, 'BILI_SOURCE_CHANGED'); }
    if (state.preparation) { good(await adapter.validate(state.context.handle, state.preparation.handle)); current(state, signal); good(adapter.verifyPrepared(state.context.handle, state.preparation.handle, state.preparation.prepared)); }
    return true;
  }
  async function hydrate(state, selection, identityValue, signal) {
    const hydrated = good(await sourceTransport.hydrate({ job: state.job, selector: selection, signal })); current(state, signal);
    requireProof(exact(hydrated, ['ok', 'conversationKey', 'records']) && hydrated.conversationKey === identityValue.conversationKey && Array.isArray(hydrated.records) && hydrated.records.length > 0 && hydrated.records.length <= 32, 'BILI_SOURCE_COVERAGE_UNPROVEN');
    const rendered = [];
    for (const record of hydrated.records) {
      requireProof(exact(record, ['sourceKey', 'revision', 'kind', 'objectId', 'authorMid', 'occurredAt', 'audience', 'target', 'coverage', 'wire']) && id(record.sourceKey) && id(record.revision) && id(record.objectId) && numeric(record.authorMid) && ['comment', 'dynamic', 'dm', 'notification', 'telemetry', 'video'].includes(record.kind) && record.audience === identityValue.audience && targetValid(record.target) && record.target.audience === record.audience && (record.occurredAt === null || typeof record.occurredAt === 'string' && Number.isFinite(Date.parse(record.occurredAt))) && record.wire && Object.getPrototypeOf(record.wire) === Object.prototype, 'BILI_SOURCE_COVERAGE_UNPROVEN');
      const original = ['comment', 'dynamic', 'dm'].includes(record.kind), video = record.kind === 'video';
      requireProof(video ? (record.coverage === 'text-only' && record.audience === 'public') : (record.coverage === (original ? 'full' : 'observed-receiver') && (original || record.authorMid === state.accountMid)), 'BILI_SOURCE_COVERAGE_UNPROVEN', video ? 'Video text metadata must be public, text-only and carry the exact accepted wire.' : 'Notifications and receiver telemetry cannot stand in for a third party complete original.');
      const wire = record.wire;
      if (record.kind === 'comment') requireProof(String(wire.rpid_str ?? wire.rpid) === record.objectId && String(wire.member?.mid) === record.authorMid && record.target.kind === 'comment' && String(wire.oid) === record.target.oid && String(wire.type) === record.target.type && String(wire.root) === record.target.root && String(wire.parent) === record.target.parent && wire.content && typeof wire.content.message === 'string' && (!wire.content.pictures || Array.isArray(wire.content.pictures) && wire.content.pictures.length === 0) && typeof wire.root !== 'undefined' && typeof wire.parent !== 'undefined', 'BILI_SOURCE_COVERAGE_UNPROVEN');
      if (record.kind === 'dynamic') requireProof(record.target.kind === 'dynamic' && String(wire.id_str) === record.objectId && String(wire.modules?.module_author?.mid) === record.authorMid && typeof wire.modules?.module_dynamic?.desc?.text === 'string' && wire.modules.module_dynamic.major == null && wire.modules.module_dynamic.additional == null, 'BILI_SOURCE_COVERAGE_UNPROVEN');
      if (record.kind === 'dm') requireProof(record.target.kind === 'dm' && record.target.mid === record.authorMid && String(wire.msg_key) === record.objectId && String(wire.sender_uid) === record.authorMid && String(wire.receiver_id) === state.accountMid && Number(wire.msg_type) === 1 && typeof wire.content === 'string' && typeof JSON.parse(wire.content).content === 'string', 'BILI_SOURCE_COVERAGE_UNPROVEN');
      if (record.kind === 'video') {
        requireProof(record.target.kind === 'video' && exact(wire, ['bvid', 'aid', 'title', 'desc', 'owner', 'pubdate']) && Object.keys(wire).length === 6 && typeof wire.bvid === 'string' && /^BV[A-Za-z0-9]{10}$/.test(wire.bvid) && wire.bvid === record.target.bvid && typeof wire.aid === 'string' && /^[1-9][0-9]{0,29}$/.test(wire.aid) && wire.aid === record.target.aid && wire.aid === record.objectId && wire.owner && Object.getPrototypeOf(wire.owner) === Object.prototype && exact(wire.owner, ['mid', 'name']) && Object.keys(wire.owner).length === 2 && typeof wire.owner.mid === 'string' && /^[1-9][0-9]{0,29}$/.test(wire.owner.mid) && wire.owner.mid === record.authorMid && typeof wire.owner.name === 'string' && typeof wire.title === 'string' && wire.title.trim().length > 0 && typeof wire.desc === 'string' && Number.isSafeInteger(wire.pubdate) && wire.pubdate > 0 && wire.pubdate <= 8640000000000 && record.occurredAt === new Date(wire.pubdate * 1000).toISOString(), 'BILI_SOURCE_COVERAGE_UNPROVEN', 'Video text metadata must be the exact accepted public wire with matching IDs, owner and pubdate; no media or API fields.');
      }
      const wireDigest = hash(record.wire), proof = Object.fromEntries(['sourceKey', 'revision', 'objectId', 'authorMid', 'audience', 'target'].map(key => [key, clone(record[key])])); proof.wireDigest = wireDigest;
      const prior = state.sources.get(record.sourceKey);
      if (prior) requireProof(hash(prior.proof) === hash(proof), 'BILI_SOURCE_CHANGED');
      const safe = redacted(record.wire), content = JSON.stringify(safe);
      requireProof(Buffer.byteLength(content) <= 128 * 1024 && content.length > 2, 'BILI_SOURCE_COVERAGE_UNPROVEN');
      if (!prior) {
        const sourceSelector = record.kind === 'comment'
          ? { kind: 'comment', rpid: record.objectId, type: record.target.type, oid: record.target.oid, root: record.target.root, parent: record.target.parent, authorMid: record.authorMid }
          : record.kind === 'video'
            ? { kind: 'video', bvid: record.target.bvid, aid: record.target.aid, authorMid: record.authorMid }
            : undefined;
        const sourceContext = await identity(state, 'read', record.target, signal, sourceSelector);
        const key = createHash('sha256').update(JSON.stringify([state.job.characterId, state.job.characterEpoch, state.accountMid, record.sourceKey, record.revision, sourceContext.conversationKey])).digest('hex');
        const receipt = good(await adapter.ingest(sourceContext.handle, [{ eventId: 'bili-event:' + key, operationId: 'bili-event-op:' + key, sourceKey: 'bili-source:' + key, producerId: 'bili-producer:' + state.accountMid, segmentId: 'bili-segment:' + key, producerSeq: 1, occurredAt: record.occurredAt, observedAt: record.occurredAt, timePrecision: record.occurredAt ? 'exact' : 'unknown', subject: record.kind, speaker: record.authorMid, certainty: 'observed', attribution: 'statement', content, evidenceRefs: [], coverage: { kind: record.kind, completeness: record.coverage } }], state.job.jobId + ':source:' + key)); current(state, signal);
        requireProof(receipt.sourceState === 'committed' && Array.isArray(receipt.eventRefs) && receipt.eventRefs.length > 0, 'BILI_SOURCE_RECEIPT_UNPROVEN');
        state.sources.set(record.sourceKey, { proof: freeze(proof), refs: clone(receipt.eventRefs) });
        for (const ref of receipt.eventRefs) state.refs.set(hash(ref), clone(ref));
      }
      rendered.push({ sourceKey: record.sourceKey, kind: record.kind, coverage: record.coverage, content: safe });
    }
    return rendered;
  }
  async function bind(state, handle, signal) { good(await adapter.bindActualInput(handle, [...state.refs.values()])); current(state, signal); good(await adapter.validate(handle)); return handle; }
  function safeBlocks(blocks) {
    requireProof(Array.isArray(blocks), 'MEMORY_NATIVE_INPUT_UNPROVEN');
    for (const block of blocks) {
      if (block.type === 'text' || block.type === 'reasoning') { requireProof(exact(block, ['type', 'text']), 'MEMORY_NATIVE_INPUT_UNPROVEN'); safeText(block.text); }
      else if (block.type === 'tool-call') {
        requireProof(exact(block, ['type', 'id', 'name', 'arguments']) && toolSpecs.some(spec => spec.name === block.name) && typeof block.id === 'string' && typeof block.arguments === 'string', 'MEMORY_NATIVE_INPUT_UNPROVEN');
        const args = JSON.parse(block.arguments), spec = toolSpecs.find(spec => spec.name === block.name);
        requireProof(args && Object.getPrototypeOf(args) === Object.prototype && Object.keys(args).every(key => Object.hasOwn(spec.parameters, key) && typeof args[key] === 'string') && Object.entries(spec.parameters).every(([key, parameter]) => !parameter.required || Object.hasOwn(args, key)), 'MEMORY_NATIVE_INPUT_UNPROVEN');
        const keys = [...block.arguments.matchAll(/"(?:\\.|[^"\\])*"/g)].filter(match => /^\s*:/.test(block.arguments.slice(match.index + match[0].length))).map(match => JSON.parse(match[0]));
        requireProof(keys.length === new Set(keys).size, 'MEMORY_NATIVE_INPUT_UNPROVEN');
        for (const [key, value] of Object.entries(args)) {
          if (key === 'text') safeText(value);
          else if (key === 'bv' || key === 'bvid') requireProof(/^BV[A-Za-z0-9]{10}$/.test(value), 'MEMORY_NATIVE_INPUT_UNPROVEN');
          else if (['oid', 'mid', 'root', 'parent'].includes(key)) requireProof(numeric(value), 'MEMORY_NATIVE_INPUT_UNPROVEN');
          else requireProof(spec.parameters[key].enum?.includes(value), 'MEMORY_NATIVE_INPUT_UNPROVEN');
        }
      } else throw fail('MEMORY_NATIVE_INPUT_UNPROVEN', 'Unknown attachments, images, files or message block types require an explicit source adapter.');
    }
  }
  function inspectChunk(candidate, chunk) {
    const fields = { 'block-end': ['type', 'index', 'block'], 'block-start': ['type', 'index', 'blockType'], 'text-delta': ['type', 'index', 'text'], 'reasoning-delta': ['type', 'index', 'text'], 'tool-call-delta': ['type', 'index', 'id', 'name', 'argumentsDelta'], usage: ['type', 'usage'], finish: ['type', 'reason', 'replayState'] }[chunk.type];
    requireProof(fields && exact(chunk, fields), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
    if (chunk.type === 'block-end') safeBlocks([chunk.block]);
    else if (['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(chunk.type)) {
      const key = chunk.type + ':' + chunk.index, fragment = chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : chunk.text;
      requireProof(typeof fragment === 'string', 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      const text = (candidate.partial.get(key) ?? '') + fragment; candidate.partial.set(key, text);
      if (chunk.type === 'tool-call-delta') requireProof(!/\b(?:token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b["']?\s*[:=：]/i.test(text), 'MEMORY_NATIVE_UNSAFE_CONTENT'); else safeText(text);
    } else if (chunk.type === 'usage') requireProof(chunk.usage && Object.getPrototypeOf(chunk.usage) === Object.prototype && Object.keys(chunk.usage).every(key => ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].includes(key)) && Object.values(chunk.usage).every(value => Number.isSafeInteger(value) && value >= 0), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
    else if (chunk.type === 'finish') { requireProof(exact(chunk.reason, ['kind']) && ['stop', 'tool-calls'].includes(chunk.reason.kind) && !candidate.finish, 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); if (chunk.replayState !== undefined) requireProof(hash(redacted(chunk.replayState)) === hash(chunk.replayState), 'MEMORY_NATIVE_UNSAFE_CONTENT'); candidate.finish = true; }
    else requireProof(chunk.type === 'block-start' && ['text', 'reasoning', 'tool-call'].includes(chunk.blockType), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
  }
  function matchMessages(state, options) {
    requireProof(Array.isArray(options.messages) && options.messages.length === state.expected.length, 'MEMORY_NATIVE_INPUT_UNPROVEN', 'The complete actual history does not match the private ordered native source ledger.');
    const seen = new Set();
    for (let index = 0; index < state.expected.length; index++) {
      const actual = options.messages[index], expected = state.expected[index];
      requireProof(hash(semantic(actual)) === expected.semantic && !seen.has(actual.id) && (!expected.id || expected.id === actual.id), 'MEMORY_NATIVE_INPUT_UNPROVEN', 'Unknown, copied, reordered or forged messages cannot enter the next provider request.');
      seen.add(actual.id);
    }
    for (let index = 0; index < state.expected.length; index++) state.expected[index].id ??= options.messages[index].id;
  }
  function appendExpected(state, message) { state.expected.push({ semantic: hash(semantic(message)), id: undefined }); }
  function execFor(state, execution) {
    requireProof(execution && execution.agent === state.agent && nativeRoot?.ownsAgent?.(execution.agent), 'BILI_SOURCE_EXECUTION_UNPROVEN');
    requireProof(execution.agent.session.id === state.job.sessionId && execution.token && typeof execution.callId === 'string', 'BILI_SOURCE_EXECUTION_UNPROVEN');
    const calls = state.calls.get(execution.callId); requireProof(calls && calls.name === execution.name && hash(JSON.parse(calls.arguments)) === hash(execution.arguments), 'BILI_SOURCE_EXECUTION_UNPROVEN', 'A tool result must answer an actual accepted native tool call.'); return calls;
  }
  const api = {
    async preparePrompt({ job, input, signal }) {
      requireProof(states.size < 64 && !states.has(job?.jobId) && job && id(job.jobId) && id(job.requestId) && id(job.sessionId), 'BILI_SOURCE_JOB_UNBOUND');
      const state = { job: freeze(clone(job)), jobHash: hash(job), handles: new Set(), sources: new Map(), refs: new Map(), expected: [], calls: new Map(), candidates: new Map(), requests: new WeakMap(), sends: new Set() };
      states.set(job.jobId, state); current(state, signal);
      const context = await identity(state, 'prompt', undefined, signal); state.context = context;
      const sources = await hydrate(state, { kind: 'trigger', input: clone(input) }, context, signal);
      await bind(state, context.handle, signal);
      const issued = good(await adapter.prepare(context.handle, JSON.stringify(sources).slice(0, 6000), { memory: 1800, total: 6000 })); current(state, signal);
      requireProof(typeof issued.preparedHandle === 'string' && issued.prepared && typeof issued.prepared.text === 'string' && issued.prepared.text.length <= 1800 && Array.isArray(issued.prepared.inputManifest), 'MEMORY_PREPARED_UNTRUSTED');
      good(adapter.verifyPrepared(context.handle, issued.preparedHandle, issued.prepared));
      state.preparation = { handle: issued.preparedHandle, prepared: freeze(issued.prepared) };
      for (const ref of issued.prepared.inputManifest) state.refs.set(hash(ref), clone(ref));
      const recall = redactContent(issued.prepared.text).replace(/\b(?:token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b(?=["']?\s*[:=：])/gi, '[已隐藏]');
      if (recall) safeText(recall);
      const content = [{ type: 'text', text: 'Bili task sources (receiver notifications are not third-party originals):\n' + JSON.stringify(sources) }, ...(recall ? [{ type: 'text', text: 'Authorized recalled memory:\n' + recall }] : [])];
      appendExpected(state, nativeCodec.createSystemMessage(corePersona)); appendExpected(state, nativeCodec.createUserMessage({ source: { kind: 'user-rpc', requestId: job.requestId }, content }));
      await bind(state, context.handle, signal); await valid(state, signal);
      return { ok: true, content: freeze(content), handle: context.handle, accountMid: state.accountMid };
    },
    async prepareInput({ job, options, request, signal }) {
      const state = stateFor(job, signal), call = callFor(state, options);
      requireProof(request?.sessionId === job.sessionId && request.inputDigest === biliV2InputDigest(options), 'MEMORY_NATIVE_INPUT_UNPROVEN');
      const config = getNativeConfig({ job });
      requireProof(config && typeof config.then !== 'function' && Object.getPrototypeOf(config) === Object.prototype && call.preparedConfig === config && config.provider === job.provider && config.model === job.model && Object.keys(config).every(key => ['provider', 'model', 'maxTokens', 'reasoningEffort'].includes(key)) && (config.maxTokens === undefined || Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0) && (config.reasoningEffort === undefined || id(config.reasoningEffort)), 'MEMORY_NATIVE_INPUT_UNPROVEN', 'Use the original actual pinned prepared.config from the owning native call.');
      const configCopy = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(options))) if (!['messages', 'tools', 'toolHistory', 'sessionId', 'signal'].includes(key)) { requireProof('value' in descriptor && Object.hasOwn(config, key), 'MEMORY_NATIVE_INPUT_UNPROVEN'); configCopy[key] = descriptor.value; }
      requireProof(hash(configCopy) === hash(config), 'MEMORY_NATIVE_INPUT_UNPROVEN');
      const definitions = call.agent.ctx.tools.schemas(call.agent);
      requireProof(hash(definitions) === hash(toolSpecs), 'MEMORY_NATIVE_INPUT_UNPROVEN', 'The actual native tool definitions must match the four approved Bili schemas.');
      const history = options.toolHistory;
      requireProof(exact(history, ['tools', 'updates']) && Array.isArray(history.tools) && Array.isArray(history.updates) && history.updates.length === 0 && (history.tools.length === 0 || hash(history.tools) === hash(approvedRequestTools)) && (options.tools === undefined ? hash(history.tools) === hash(approvedRequestTools) : hash(options.tools) === hash(approvedRequestTools)), 'MEMORY_NATIVE_INPUT_UNPROVEN');
      matchMessages(state, options); await valid(state, signal);
      const handle = await bind(state, state.context.handle, signal);
      state.requests.set(options, { request, digest: biliV2InputDigest(options), handle }); state.admittedInputs = (state.admittedInputs ?? 0) + 1; return { ok: true, handle };
    },
    async validate({ job, options, request, signal }) {
      const state = stateFor(job, signal);
      if (options) { callFor(state, options); const retained = state.requests.get(options); requireProof(retained && retained.request === request && retained.digest === biliV2InputDigest(options), 'MEMORY_NATIVE_INPUT_UNPROVEN'); matchMessages(state, options); }
      await valid(state, signal); return { ok: true };
    },
    async captureModelOutput({ job, options, request, dispatchId, phase, chunk, signal }) {
      const retained = states.get(job?.jobId);
      if (phase === 'failed' && retained && hash(job) === retained.jobHash) { const abandoned = retained.candidates.get(dispatchId); requireProof(abandoned && abandoned.options === options && abandoned.request === request, 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); abandoned.done = true; abandoned.chunks.length = 0; abandoned.accumulator = undefined; abandoned.assembler = undefined; abandoned.partial.clear(); return { ok: true }; }
      const state = stateFor(job, signal), nativeCall = callFor(state, options);
      requireProof(typeof dispatchId === 'string' && dispatchId.length > 0, 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      if (phase === 'start') { requireProof(state.candidates.size < 8 && !state.candidates.has(dispatchId), 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); state.candidates.set(dispatchId, { options, request, nativeCall, bytes: 0, partial: new Map(), accumulator: new nativeCodec.AssistantStreamAccumulator(), assembler: new nativeCodec.BlockAssembler(), chunks: [], done: false }); return { ok: true }; }
      const candidate = state.candidates.get(dispatchId);
      requireProof(candidate && candidate.options === options && candidate.request === request && candidate.nativeCall === nativeCall && !candidate.done, 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      if (phase === 'failed') { candidate.done = true; candidate.chunks.length = 0; return { ok: true }; }
      requireProof(state.requests.get(options)?.request === request, 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      if (phase === 'chunk') { requireProof(chunk && typeof chunk === 'object', 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); hash(chunk); inspectChunk(candidate, chunk); candidate.bytes += Buffer.byteLength(JSON.stringify(chunk)); requireProof(candidate.chunks.length < 4096 && candidate.bytes <= 8 * 1024 * 1024, 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); const timed = candidate.accumulator.push({ time: now(), chunk }); candidate.assembler.push(timed.chunk); candidate.chunks.push({ original: chunk, digest: hash(chunk) }); freeze(chunk); return { ok: true }; }
      requireProof(phase === 'complete', 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      requireProof(candidate.finish === true, 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      for (const item of candidate.chunks) requireProof(item.digest === hash(item.original), 'MEMORY_NATIVE_OUTPUT_UNPROVEN');
      const blocks = candidate.assembler.blocks(); safeBlocks(blocks);
      const source = { provider: options.provider, model: options.model, ...(candidate.assembler.replayState === undefined ? {} : { replayState: candidate.assembler.replayState }) };
      if (source.replayState !== undefined) requireProof(hash(redacted(source.replayState)) === hash(source.replayState), 'MEMORY_NATIVE_UNSAFE_CONTENT');
      const message = nativeCodec.createAssistantMessage({ content: blocks, source });
      appendExpected(state, message); for (const block of blocks.filter(block => block.type === 'tool-call')) { requireProof(!state.calls.has(block.id), 'MEMORY_NATIVE_OUTPUT_UNPROVEN'); state.calls.set(block.id, { name: block.name, arguments: block.arguments }); }
      candidate.done = true; candidate.committed = true; candidate.chunks.length = 0; candidate.accumulator = undefined; candidate.assembler = undefined; candidate.partial.clear(); return { ok: true };
    },
    async captureToolResult({ job, execution, action, result, signal }) {
      const state = stateFor(job, signal); execFor(state, execution); requireProof(!state.calls.get(execution.callId).answered, 'BILI_SOURCE_EXECUTION_UNPROVEN');
      let payload;
      if (result?.derived === false && ['feed', 'debrief'].includes(action)) {
        const context = await identity(state, 'read', undefined, signal);
        payload = { sources: await hydrate(state, { kind: 'tool', action, args: clone(execution.arguments), stdout: result.stdout }, context, signal) };
      } else {
        requireProof(result?.derived === true && state.sends.has(execution.callId) && ['comment', 'dynamic', 'dm'].includes(action), 'BILI_SOURCE_RECEIPT_UNPROVEN');
        payload = { derived: true, action, receipt: redactContent(result.stdout) };
      }
      await bind(state, state.context.handle, signal); await valid(state, signal);
      const content = [{ type: 'text', text: JSON.stringify({ ok: true, result: payload }) }];
      appendExpected(state, nativeCodec.createToolResultMessage({ callId: execution.callId, content, isError: false })); state.calls.get(execution.callId).answered = true;
      return { ok: true, result: freeze(payload) };
    },
    async prepareSend({ job, execution, action, target, payload, signal }) {
      const state = stateFor(job, signal); const call = execFor(state, execution);
      requireProof(!state.sends.has(execution.callId) && ['comment', 'dynamic', 'dm'].includes(action) && call.name === 'surfcore_bili_' + action && targetValid(target), 'BILI_SOURCE_TARGET_UNPROVEN');
      const args = JSON.parse(call.arguments);
      const actualText = action === 'dynamic' ? payload.body?.content?.contents?.map(part => { requireProof(part.type === 1 && typeof part.raw_text === 'string', 'BILI_SOURCE_TARGET_UNPROVEN'); return part.raw_text; }).join('') : payload.text;
      requireProof(actualText === args.text, 'BILI_SOURCE_TARGET_UNPROVEN'); safeText(actualText);
      if (action === 'dm') requireProof(target.mid === args.mid, 'BILI_SOURCE_TARGET_UNPROVEN');
      if (action === 'comment') requireProof(target.oid === args.oid && target.type === args.type && target.root === (args.root ?? '0') && target.parent === (args.parent ?? '0'), 'BILI_SOURCE_TARGET_UNPROVEN');
      const context = await identity(state, action, target, signal); await bind(state, context.handle, signal); await valid(state, signal); state.sends.add(execution.callId);
      return { ok: true, handle: context.handle };
    },
    async releaseJob({ job } = {}) {
      const state = states.get(job?.jobId);
      if (!state) return { ok: true, released: false };
      requireProof(hash(job) === state.jobHash, 'BILI_SOURCE_JOB_UNBOUND', 'Only the original private job may release its source context.');
      if (state.releasePromise) return state.releasePromise;
      state.releasing = true;
      state.releasePromise = (async () => {
        for (const handle of state.handles) { const result = await adapter.release(handle); if (result?.ok === false) good(result); }
        retired.sourceCount += state.sources.size; retired.admittedInputs += state.admittedInputs ?? 0;
        retired.committedOutputs += [...state.candidates.values()].filter(candidate => candidate.committed).length;
        states.delete(job.jobId); return { ok: true, released: true };
      })().catch(error => { state.releasePromise = undefined; throw error; });
      return state.releasePromise;
    },
    getStatus() { return Object.freeze({ ok: !lastFailure && !closed, closed, jobs: states.size, activeSourceCount: [...states.values()].reduce((sum, state) => sum + state.sources.size, 0), sourceCount: retired.sourceCount + [...states.values()].reduce((sum, state) => sum + state.sources.size, 0), admittedInputs: retired.admittedInputs + [...states.values()].reduce((sum, state) => sum + (state.admittedInputs ?? 0), 0), committedOutputs: retired.committedOutputs + [...states.values()].reduce((sum, state) => sum + [...state.candidates.values()].filter(candidate => candidate.committed).length, 0), derivedPersisted: false, ...(lastFailure ? { failure: lastFailure } : {}) }); },
    close() { closed = true; for (const state of states.values()) for (const handle of state.handles) adapter.release(handle); states.clear(); retired.sourceCount = retired.admittedInputs = retired.committedOutputs = 0; return { ok: true }; },
  };
  for (const key of ['releaseJob', 'preparePrompt', 'prepareInput', 'validate', 'captureModelOutput', 'captureToolResult', 'prepareSend']) { const original = api[key]; api[key] = async args => { try { return await original(args); } catch (error) { lastFailure = { ok: false, code: error?.code || 'BILI_SOURCE_UNPROVEN', error: 'Bili source proof was refused.', hint: error?.hint || 'Keep the original request blocked and restore its trusted source context.' }; return lastFailure; } }; }
  return Object.freeze(api);
}
