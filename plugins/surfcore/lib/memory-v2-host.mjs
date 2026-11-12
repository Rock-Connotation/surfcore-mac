import { randomBytes } from 'node:crypto';
import { CONTEXT_FIELDS, canonical, digest, validateEvent } from '../../../src/core/memory-v2-contract.js';
import { validateQQSourceFacts } from './memory-v2-identity.mjs';

const CHANNELS = new Set(['qq', 'bili', 'douyin', 'local']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/;
const fail = (code, error, hint = 'Capture a fresh trusted context after checking the current account and approved policy.') => ({ ok: false, code, error, hint });
function phase(result) {
  const out = {}, allowed = { sourceState: ['pending', 'committed', 'not_applicable', 'commit_unknown'], operationState: ['pending', 'completed', 'completed_before_cancel', 'unknown', 'not_found'], acceptance: ['volatile', 'queued_durable', 'rejected'], selectionState: ['not_selected', 'selected', 'pending'], indexState: ['pending', 'ready', 'not_applicable'], registrationState: ['durable', 'pending'] };
  for (const [key, values] of Object.entries(allowed)) if (values.includes(result?.[key])) out[key] = result[key];
  if (typeof result?.operationId === 'string' && ID.test(result.operationId)) out.operationId = result.operationId;
  return out;
}
const denied = (result) => ({ ...fail(/^(MEMORY|CHARACTER)_[A-Z_]+$/.test(result?.code) ? result.code : 'MEMORY_HOST_FAILED', result?.code === 'MEMORY_IDENTITY_BUSY' ? '平台身份核验正忙。' : 'The memory Host could not authorize or complete this operation.', result?.retry === 'query_receipt' ? 'Query the original operation receipt; do not retry with a new operation ID.' : result?.code === 'MEMORY_IDENTITY_BUSY' ? '等待当前平台操作结束后重试。' : undefined), ...phase(result), ...(result?.retry === 'query_receipt' ? { retry: 'query_receipt', operationState: phase(result).operationState ?? 'unknown' } : {}) });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) { return object(value) && Object.keys(value).every((key) => keys.includes(key)); }
function stable(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('MEMORY_IDENTITY_REQUIRED', 'A bounded authoritative identity is required.'); return value; }
function namespace(channel, value) { value = stable(value); return stable(value.startsWith(`${channel}:`) ? value : `${channel}:${value}`); }
function manifestUnion(left, right) {
  if (!Array.isArray(right) || right.length > 100) throw fail('MEMORY_MANIFEST_INVALID', 'Actual input must be a bounded list of V2 references.');
  const out = new Map(left.map((ref) => [`${ref.type}:${ref.id}:${ref.revision}`, ref]));
  for (const ref of right) {
    if (!exact(ref, ['type', 'id', 'revision', 'payloadDigest']) || !['event', 'memory'].includes(ref.type) || !ID.test(ref.id ?? '') || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || !/^[a-f0-9]{64}$/.test(ref.payloadDigest ?? '')) throw fail('MEMORY_MANIFEST_INVALID', 'Actual input references require exact IDs, revisions and digests.');
    const key = `${ref.type}:${ref.id}:${ref.revision}`, old = out.get(key);
    if (old && old.payloadDigest !== ref.payloadDigest) throw fail('MEMORY_SOURCE_STALE', 'An actual input digest changed during this request.');
    out.set(key, { ...ref });
  }
  if (out.size > 100) throw fail('MEMORY_MANIFEST_INVALID', 'The full actual input manifest exceeds its bounded capacity.');
  return [...out.values()];
}

function sourceBatch(batch, spoolOnly = false) {
  const rawKeys = ['eventId', 'operationId', 'sourceKey', 'producerId', 'segmentId', 'producerSeq', 'occurredAt', 'observedAt', 'timePrecision', 'subject', 'speaker', 'certainty', 'attribution', 'content', 'evidenceRefs', 'coverage', 'expiresAt', 'payloadDigest'];
  if (Buffer.byteLength(canonical(batch)) > 256 * 1024) throw fail('MEMORY_REQUEST_TOO_LARGE', 'A source batch must fit within 256 KiB.');
  if (Array.isArray(batch) && !spoolOnly) {
    if (batch.length > 100 || batch.some((event) => !exact(event, rawKeys))) throw fail('MEMORY_FIELD_FORBIDDEN', 'Ingestion accepts bounded source events, not authorization or file fields.');
    return;
  }
  const eventKeys = [...rawKeys, 'schemaVersion', 'characterId', 'capturedEpoch', 'channel', 'conversationKey', 'actorAccountKey', 'policyId', 'processingGrantId', 'textCompleteness', 'rootEventId', 'wholeDigest', 'partIndex', 'partCount'];
  if (!exact(batch, ['ok', 'events', 'producerId', 'segmentId', 'startOffset', 'nextOffset', 'positions', 'incompleteTail', 'segmentDigest']) || (batch.ok !== undefined && batch.ok !== true) || !Array.isArray(batch.events) || !batch.events.length || batch.events.length > 100 || !Array.isArray(batch.positions) || batch.positions.length !== batch.events.length || batch.positions.some((position) => !exact(position, ['start', 'end'])) || batch.events.some((event) => !exact(event, eventKeys))) throw fail('MEMORY_FIELD_FORBIDDEN', 'A spool import requires the complete typed source batch and byte positions, never filesystem paths.');
  stable(batch.producerId); stable(batch.segmentId);
  if (batch.segmentDigest !== digest([batch.producerId, batch.segmentId]) || typeof batch.incompleteTail !== 'boolean') throw fail('MEMORY_DIGEST_CONFLICT', 'A source batch requires its original segment digest and complete-prefix state.');
  if (!Number.isSafeInteger(batch.startOffset) || batch.startOffset < 0 || !Number.isSafeInteger(batch.nextOffset) || batch.nextOffset <= batch.startOffset) throw fail('MEMORY_OFFSET_GAP', 'A spool batch requires contiguous complete byte offsets.');
  let cursor = batch.startOffset;
  for (let i = 0; i < batch.events.length; i++) {
    const event = validateEvent(batch.events[i]), position = batch.positions[i];
    if (position.start !== cursor || !Number.isSafeInteger(position.end) || position.end <= cursor || event.producerId !== batch.producerId || event.segmentId !== batch.segmentId) throw fail('MEMORY_OFFSET_GAP', 'A spool batch contains a byte gap or mixed producer identity.');
    cursor = position.end;
  }
  if (cursor !== batch.nextOffset) throw fail('MEMORY_OFFSET_GAP', 'The final source byte cursor does not match the supplied batch.');
}

/** Fact resolution and adapter creation are trusted Host closures, never RPC body fields. */
export function createMemoryHost({ memoryService, getCharacter, resolveIdentity = () => null, getProducerReplayAuthorization = () => null, now = Date.now, handleTtlMs = 30_000, maxHandles = 256 } = {}) {
  if (!memoryService || typeof getCharacter !== 'function' || typeof resolveIdentity !== 'function' || typeof getProducerReplayAuthorization !== 'function' || !Number.isInteger(handleTtlMs) || handleTtlMs < 1 || handleTtlMs > 300_000 || !Number.isInteger(maxHandles) || maxHandles < 1 || maxHandles > 4096) throw new TypeError('Invalid memory Host configuration.');
  const handles = new Map();
  let closed = false;
  function role() {
    const value = getCharacter();
    if (!value || typeof value.then === 'function' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value.id ?? '') || !Number.isSafeInteger(value.epoch) || value.epoch < 1) throw fail('CHARACTER_CONTEXT_REQUIRED', 'The current trusted role and epoch are unavailable.');
    return { id: value.id, epoch: value.epoch };
  }
  function current(captured) {
    const fresh = role();
    if (closed || fresh.id !== captured.id || fresh.epoch !== captured.epoch) throw fail('CHARACTER_EPOCH_STALE', 'The character changed while memory work was in flight.', 'Cancel old work, retire its session and capture a new context.');
  }
  function prune() { for (const [key, value] of handles) if (value.expiresAt <= now()) handles.delete(key); }
  async function status() {
    try {
      const result = await memoryService.getStatus();
      // V2-only：`shadowEnabled` 已退出准入（R01）。状态只区分「后端」与「是否就绪」，
      // 不再用影子期开关表示可用性，避免出现 backend=v2 却显示「未启用」的矛盾。
      const ready = result?.ok !== false;
      return { ok: true, activeBackend: result?.activeBackend ?? 'v2',
        readiness: ready ? 'ready' : 'blocked',
        ...(ready ? {} : { reason: { code: result?.code || 'MEMORY_WORKER_UNAVAILABLE', hint: result?.hint || 'Check the isolated memory service status, then capture a new trusted context.' } }),
        shadowEnabled: result?.shadowEnabled === 1 || result?.shadowEnabled === true };
    } catch { return { ok: true, activeBackend: 'v2', readiness: 'blocked', reason: { code: 'MEMORY_WORKER_UNAVAILABLE', hint: 'Keep the current control state and check the isolated memory service status.' } }; }
  }
  function createAdapter({ channel, principal, purpose = 'conversation', canBindInput = false, canSubmitSourceFacts = false } = {}) {
    if (!CHANNELS.has(channel) || !['conversation', 'organize'].includes(purpose) || !object(principal) || (canSubmitSourceFacts && channel !== 'qq')) throw new TypeError('A trusted channel, principal and ordinary purpose are required.');
    const owner = Object.freeze({}), trustedPrincipal = structuredClone(principal);
    let replayAuthorization = null;
    if (channel === 'qq' && canSubmitSourceFacts === true) {
      try {
        const proof = getProducerReplayAuthorization({ channel, principal: structuredClone(trustedPrincipal) });
        if (proof && typeof proof.then === 'function') Promise.resolve(proof).catch(() => {});
        else if (proof !== null && proof !== undefined && proof !== false) replayAuthorization = proof;
      } catch {}
    }
    function producerAccess(method) {
      if (closed) throw fail('MEMORY_HANDLE_STALE', 'The memory Host has been retired.');
      if (channel !== 'qq' || canSubmitSourceFacts !== true) throw fail('MEMORY_ADAPTER_REQUIRED', 'Only the trusted QQ source adapter may register or recover durable producers.');
      if (replayAuthorization === null) throw fail('MEMORY_PRODUCER_REPLAY_DENIED', 'A synchronous private Host producer authorization is required.');
      if (typeof memoryService.host?.[method] !== 'function') throw fail('MEMORY_PRODUCER_UNAVAILABLE', 'The kernel producer recovery interface is unavailable.', 'Keep the original spool and operation ID; wait for the verified kernel interface before replay.');
    }
    async function producerOperation(method, request) {
      let submitted = false;
      try {
        producerAccess(method);
        if (!exact(request, method === 'replayProducer' ? ['registrationId', 'batch', 'operationId'] : ['registrationId', 'operationId'])) throw fail('MEMORY_FIELD_FORBIDDEN', 'Producer recovery accepts only the registered source ID, original batch and operation ID.');
        if (method === 'replayProducer' || request.registrationId !== undefined) stable(request.registrationId); stable(request.operationId);
        if (method === 'replayProducer') sourceBatch(request.batch, true);
        submitted = true;
        const output = await memoryService.host[method](structuredClone(request), replayAuthorization);
        if (closed) return denied({ ...output, code: 'MEMORY_HANDLE_STALE', ...(method === 'replayProducer' ? { retry: 'query_receipt', operationState: output?.ok ? 'completed_before_cancel' : output?.operationState ?? 'unknown' } : {}) });
        return output?.ok ? output : denied(output?.retry === 'query_receipt' ? { ...output, operationId: output.operationId ?? request.operationId } : output);
      } catch (error) { return denied(submitted && method === 'replayProducer' ? { ...error, retry: 'query_receipt', operationState: 'unknown', sourceState: 'pending', operationId: request.operationId } : error); }
    }
    function entry(handle) {
      prune(); const value = handles.get(handle);
      if (!value || value.owner !== owner) throw fail('MEMORY_HANDLE_STALE', 'This memory handle is absent, expired or belongs to another adapter.', 'Capture a new handle through this channel; handles do not survive Host restart.');
      current(value.role); return value;
    }
    function operation(handle, run, mutation = false) {
      let value;
      try { value = entry(handle); } catch (error) { return Promise.resolve(denied(error)); }
      const result = value.pending.then(async () => {
        let submitted = false, output;
        try {
          entry(handle);
          const valid = await memoryService.validateContext(value.context); current(value.role);
          if (!valid?.ok) { handles.delete(handle); return denied(valid); }
          submitted = true;
          output = await run(value); entry(handle);
          if (!output?.ok) return denied(output);
          const after = await memoryService.validateContext(value.context); entry(handle);
          if (!after?.ok) { handles.delete(handle); return denied(mutation ? { ...output, ...after, retry: 'query_receipt', operationState: 'completed_before_cancel' } : after); }
          return output;
        } catch (error) { return denied(mutation && submitted ? { ...output, ...error, retry: 'query_receipt', operationState: output?.ok ? 'completed_before_cancel' : 'unknown' } : error); }
      });
      value.pending = result.then(() => {}); return result;
    }
    async function withNetworkAdmission(handle, dispatchFunction, options = {}) {
      let value, signal;
      const reject = (error) => {
        const result = denied(error);
        if (error?.code === 'MEMORY_NETWORK_ADMISSION_UNSUPPORTED') result.hint = 'Do not dispatch. Verify the installed Host admission hook before capturing a new request.';
        return Object.assign(new Error(result.error), result);
      };
      try {
        value = entry(handle);
        if (typeof dispatchFunction !== 'function') throw fail('MEMORY_NETWORK_DISPATCH_REQUIRED', 'A trusted synchronous dispatch callback is required.');
        if (!exact(options, ['signal'])) throw fail('MEMORY_ADMISSION_SIGNAL_INVALID', 'Admission accepts only an optional abort signal.');
        signal = options.signal;
        if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw fail('MEMORY_ADMISSION_SIGNAL_INVALID', 'Use an actual abort signal for cancellable admission.');
        if (typeof memoryService.host?.withNetworkAdmission !== 'function') throw fail('MEMORY_NETWORK_ADMISSION_UNSUPPORTED', 'The private kernel network admission hook is unavailable.', 'Do not dispatch. Verify the installed Host admission hook before capturing a new request.');
        if (!signal) await value.pending;
        else await new Promise((resolve, rejectWait) => {
          const abort = () => { signal.removeEventListener('abort', abort); rejectWait(fail('MEMORY_ADMISSION_ABORTED', 'The pending actual-input wait was cancelled.', 'Keep this request cancelled; no network call was started.')); };
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
          value.pending.then(() => { signal.removeEventListener('abort', abort); resolve(); }, (error) => { signal.removeEventListener('abort', abort); rejectWait(error); });
        });
        entry(handle);
      } catch (error) { throw reject(error); }
      return memoryService.host.withNetworkAdmission(value.context, () => {
        try { entry(handle); } catch (error) { throw reject(error); }
        return dispatchFunction();
      }, { signal });
    }
    async function bind(value, refs) {
      const union = manifestUnion(value.manifest, refs);
      const result = await memoryService.host.bindInputManifest(value.context, union); current(value.role);
      if (result?.ok) value.manifest = union;
      return result;
    }
    return Object.freeze({
      async capture(request = {}) {
        let captured;
        try {
          captured = role(); current(captured);
          if (!exact(request, ['conversationKey', 'sourceFacts']) || typeof request.conversationKey !== 'string') return fail('MEMORY_FIELD_FORBIDDEN', 'Capture accepts only a specific conversation selector and scoped source facts.');
          stable(request.conversationKey);
          let sourceFacts;
          if (request.sourceFacts !== undefined) {
            if (canSubmitSourceFacts !== true) return fail('MEMORY_ADAPTER_REQUIRED', 'This adapter cannot submit platform source facts.');
            const checked = validateQQSourceFacts(request.sourceFacts);
            if (!checked.ok) return checked;
            sourceFacts = checked.sourceFacts;
          }
          const resolved = await resolveIdentity({ channel, principal: structuredClone(trustedPrincipal), conversationKey: request.conversationKey, purpose, ...(sourceFacts ? { sourceFacts } : {}) }); current(captured);
          if (!exact(resolved, ['channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'purpose']) || resolved.channel !== channel || (resolved.purpose !== undefined && resolved.purpose !== purpose)) return fail('MEMORY_IDENTITY_REQUIRED', 'The trusted identity resolver did not authorize this channel and conversation.');
          const conversationKey = namespace(channel, resolved.conversationKey);
          if (conversationKey !== namespace(channel, request.conversationKey) || /(^|:)(all|any|shared|\*)$/i.test(conversationKey)) return fail('MEMORY_IDENTITY_REQUIRED', 'Memory requires the exact authorized conversation.');
          const facts = { channel, conversationKey, sourceAccountKey: namespace(channel, resolved.sourceAccountKey), requesterAccountKey: namespace(channel, resolved.requesterAccountKey), providerRouteId: stable(resolved.providerRouteId), purpose };
          const audience = await memoryService.host.resolveAudience(facts); current(captured);
          if (!audience?.ok) return denied(audience);
          const result = await memoryService.captureContext({ ...facts, audiencePolicyId: audience.audiencePolicyId, processingGrantId: audience.processingGrantId }); current(captured);
          if (!result?.ok) return denied(result);
          if (result.context?.characterId !== captured.id || result.context?.capturedEpoch !== captured.epoch) return fail('CHARACTER_EPOCH_STALE', 'The kernel captured a different role or epoch.');
          prune(); if (handles.size >= maxHandles) return fail('MEMORY_HANDLE_CAPACITY', 'The Host memory handle limit has been reached.', 'Finish or expire existing requests before capturing more handles.');
          const handle = randomBytes(32).toString('hex'), expiresAt = now() + handleTtlMs;
          handles.set(handle, { owner, role: captured, context: result.context, manifest: [], prepared: new Map(), pending: Promise.resolve(), expiresAt });
          return { ok: true, handle, expiresAt, sourceStamp: Object.fromEntries(CONTEXT_FIELDS.filter((key) => result.context[key] !== undefined).map((key) => [key, structuredClone(result.context[key])])) };
        } catch (error) { return denied(error); }
      },
      ingest: (handle, batch, operationId) => operation(handle, (value) => {
        sourceBatch(batch); return memoryService.ingestEvents(value.context, batch, operationId);
      }, true),
      registerProducer: (handle, producer, operationId) => operation(handle, (value) => {
        producerAccess('registerProducer');
        if (!exact(producer, ['producerId', 'segmentId'])) return fail('MEMORY_FIELD_FORBIDDEN', 'Producer registration accepts only stable producer and segment IDs.');
        stable(producer.producerId); stable(producer.segmentId); stable(operationId);
        return memoryService.host.registerProducer(value.context, structuredClone(producer), operationId);
      }, true),
      replayProducer: (request) => producerOperation('replayProducer', request),
      queryProducerReceipt: (request) => producerOperation('queryProducerReceipt', request),
      receipt: (handle, operationId) => operation(handle, (value) => memoryService.getMemoryReceipt(value.context, operationId)),
      prepare: (handle, query, budget = {}) => operation(handle, async (value) => {
        if (typeof query !== 'string' || query.length > 6000 || !exact(budget, ['memory', 'total'])) return fail('MEMORY_QUERY_INVALID', 'Preparation requires bounded current text and a memory/total budget.');
        const result = await memoryService.prepareMemoryContext(value.context, query, budget); current(value.role);
        if (!result?.ok) return result;
        const attached = await bind(value, result.prepared.inputManifest);
        if (!attached?.ok) return attached;
        if (value.prepared.size >= 8) return fail('MEMORY_PREPARED_CAPACITY', 'This request has reached its preparation limit.', 'Capture a new request handle before another inference.');
        const preparedHandle = randomBytes(24).toString('hex'); value.prepared.set(preparedHandle, { original: result.prepared, issuedDigest: digest(result.prepared) });
        return { ok: true, preparedHandle, prepared: structuredClone(result.prepared), inputManifest: structuredClone(value.manifest) };
      }),
      search: (handle, query, options = {}) => operation(handle, (value) => {
        if (typeof query !== 'string' || query.length > 6000 || !exact(options, ['limit'])) return fail('MEMORY_QUERY_INVALID', 'Search requires bounded current text and an ordinary result limit.');
        return memoryService.searchMemory(value.context, query, options);
      }),
      validate: (handle, preparedHandle) => operation(handle, (value) => {
        const retained = preparedHandle === undefined ? undefined : value.prepared.get(preparedHandle);
        if (preparedHandle !== undefined && !retained) return fail('MEMORY_PREPARED_UNTRUSTED', 'The preparation does not belong to this request.');
        return memoryService.validateContext(value.context, retained?.original);
      }),
      verifyPrepared(handle, preparedHandle, preparedCopy) {
        try {
          const value = entry(handle), retained = value.prepared.get(preparedHandle);
          if (!retained || digest(preparedCopy) !== retained.issuedDigest) return fail('MEMORY_PREPARED_UNTRUSTED', 'The prepared copy differs from the Host-issued package.');
          const result = memoryService.host.verifyPrepared(value.context, retained.original); current(value.role);
          if (result && typeof result.then === 'function') return fail('MEMORY_PREPARED_UNTRUSTED', 'Prepared issuance verification must be synchronous.');
          return result?.ok ? { ok: true, admission: 'issued-package-only' } : denied(result);
        } catch (error) { return denied(error); }
      },
      withNetworkAdmission,
      bindActualInput: (handle, refs) => operation(handle, (value) => canBindInput ? bind(value, refs) : fail('MEMORY_ADAPTER_REQUIRED', 'Only a trusted input-building adapter may attach actual inputs.')),
      release(handle) { try { entry(handle); handles.delete(handle); return { ok: true }; } catch (error) { return denied(error); } },
    });
  }
  return Object.freeze({ createAdapter, status, retireAll() { handles.clear(); }, close() { closed = true; handles.clear(); } });
}
