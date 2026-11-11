import fs from 'node:fs';
import path from 'node:path';
import { digest } from './memory-v2-contract.js';

const PREFIX = '/dsh-surfcore/memory-v2-api';
const fail = (code, error, hint = 'Read current discovery, check Host memory status and capture a fresh channel request.') => ({ ok: false, code, error, hint });
function phase(result) {
  const out = {}, allowed = { sourceState: ['pending', 'committed', 'not_applicable', 'commit_unknown'], operationState: ['pending', 'completed', 'completed_before_cancel', 'unknown', 'not_found'], acceptance: ['volatile', 'queued_durable', 'rejected'], selectionState: ['not_selected', 'selected', 'pending'], indexState: ['pending', 'ready', 'not_applicable'], registrationState: ['durable', 'pending'] };
  for (const [key, values] of Object.entries(allowed)) if (values.includes(result?.[key])) out[key] = result[key];
  if (typeof result?.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(result.operationId)) out.operationId = result.operationId;
  return out;
}

function discovery(file, scope) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8')), base = new URL(value.baseUrl);
    if (value.version !== 1 || value.api !== PREFIX || value.scope !== scope || !/^[a-f0-9]{64}$/.test(value.token ?? '') || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base['pass' + 'word'] || base.pathname !== '/' || base.search || base.hash) throw new Error();
    return { url: `${base.origin}${PREFIX}`, token: value.token, descriptor: digest(value) };
  } catch { throw fail('MEMORY_DISCOVERY_INVALID', 'The protected channel memory discovery file is absent or invalid.', 'Start the official Host and regenerate this channel discovery file; do not use remote URLs or shared credentials.'); }
}
async function boundedJson(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw fail('MEMORY_RESPONSE_TOO_LARGE', 'The memory response exceeds its byte budget.');
  if (!response.body?.getReader) throw fail('MEMORY_RESPONSE_INVALID', 'The memory response has no bounded readable body.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw fail('MEMORY_RESPONSE_TOO_LARGE', 'The memory response exceeds its byte budget.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Discovery is read per request. Synchronous verification proves issuance, not fresh DB controls. */
export function createMemoryClient({ stateDir, discoveryFile, scope = 'qq-bridge', fetchImpl = globalThis.fetch, getCharacter, timeoutMs = 8000, maxRequestBytes = 256 * 1024, maxResponseBytes = 512 * 1024 } = {}) {
  const file = discoveryFile ?? path.join(stateDir ?? '', 'memory-v2', `${scope}.json`);
  if (!path.isAbsolute(file) || !/^[a-z][a-z0-9-]{0,39}$/.test(scope) || typeof fetchImpl !== 'function' || (getCharacter !== undefined && typeof getCharacter !== 'function') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 1024 * 1024 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024) throw new TypeError('Invalid memory client configuration.');
  const issued = new Map(), responses = new WeakMap();
  function role(required = false) {
    if (!getCharacter && !required) return null;
    const value = getCharacter?.();
    if (!value || typeof value.then === 'function' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value.id ?? '') || !Number.isSafeInteger(value.epoch) || value.epoch < 1) throw fail('CHARACTER_CONTEXT_REQUIRED', 'A trusted synchronous current role getter is required for package verification.');
    return { id: value.id, epoch: value.epoch };
  }
  function sameRole(captured) {
    if (!captured) return;
    const current = role(true);
    if (captured.id !== current.id || captured.epoch !== current.epoch) { issued.clear(); throw fail('CHARACTER_EPOCH_STALE', 'The current character changed during memory work.', 'Retire old work and capture a fresh context before continuing.'); }
  }
  function clearAck(handle) { for (const packet of issued.get(handle)?.prepared.values() ?? []) packet.ack = false; }
  function prune() { for (const [handle, entry] of issued) if (entry.expiresAt <= Date.now()) issued.delete(handle); }
  async function request(body, { signal } = {}) {
    let timer, onAbort, submitted = false;
    const controller = new AbortController();
    if (body?.handle && ['ingest', 'registerProducer', 'bindActualInput', 'prepare', 'validate'].includes(body.action)) clearAck(body.handle);
    if (body?.action === 'replayProducer') for (const handle of issued.keys()) clearAck(handle);
    try {
      const captured = ['replayProducer', 'queryProducerReceipt'].includes(body?.action) ? null : role(), target = discovery(file, scope), text = body === undefined ? undefined : JSON.stringify(body);
      if (text !== undefined && Buffer.byteLength(text) > maxRequestBytes) return fail('MEMORY_REQUEST_TOO_LARGE', 'The memory request exceeds its byte budget.', 'Split source batches with stable operation IDs before submitting them.');
      onAbort = () => controller.abort();
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, timeoutMs); submitted = true;
      const response = await fetchImpl(target.url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { 'x-memory-v2-token': target.token, ...(text === undefined ? {} : { 'content-type': 'application/json' }) }, ...(text === undefined ? {} : { body: text }), signal: controller.signal });
      sameRole(captured);
      const result = await boundedJson(response, maxResponseBytes, controller.signal); sameRole(captured);
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw fail('MEMORY_RESPONSE_INVALID', 'The Host returned an invalid memory response.');
      if (!response.ok || !result.ok) { clearAck(body?.handle); return { ...fail(/^(MEMORY|CHARACTER)_[A-Z_]+$/.test(result.code) ? result.code : 'MEMORY_HOST_REJECTED', 'The Host rejected this memory operation.', result.retry === 'query_receipt' ? 'Query the original operation receipt; do not submit another operation ID.' : undefined), ...phase({ ...result, operationId: result.operationId ?? body?.operationId }), ...(result.retry === 'query_receipt' ? { retry: 'query_receipt', operationState: phase(result).operationState ?? 'unknown' } : {}) }; }
      responses.set(result, { descriptor: target.descriptor, role: captured }); return result;
    } catch (error) {
      clearAck(body?.handle);
      let result;
      if (controller.signal.aborted) result = fail('MEMORY_REQUEST_TIMEOUT', 'The memory request timed out or was cancelled.', 'For a submitted write, query its original receipt before retrying; capture a new request if the old one expired.');
      else if (error?.ok === false) result = error;
      else result = fail('MEMORY_HOST_UNAVAILABLE', 'The local memory Host could not be reached or returned unreadable data.', 'Check official Host status and current discovery; do not retry uncertain writes with new IDs.');
      return submitted && ['ingest', 'registerProducer', 'replayProducer'].includes(body?.action) ? { ...result, retry: 'query_receipt', operationState: 'unknown', sourceState: 'pending', ...phase({ operationId: body.operationId }) } : result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  return Object.freeze({
    status: (options) => request(undefined, options),
    requestQQReply: (input, options) => request({ ...input, action: 'qqReply' }, options),
    async capture(conversationKey, { sourceFacts, ...options } = {}) {
      const result = await request({ action: 'capture', conversationKey, ...(sourceFacts !== undefined ? { sourceFacts } : {}) }, options); prune();
      if (result.ok && typeof result.handle === 'string' && Number.isFinite(result.expiresAt) && issued.size < 256) issued.set(result.handle, { ...responses.get(result), expiresAt: Math.min(result.expiresAt, Date.now() + 300_000), prepared: new Map() });
      return result;
    },
    ingest: (handle, events, operationId, options) => request({ action: 'ingest', handle, events, operationId }, options),
    receipt: (handle, operationId, options) => request({ action: 'receipt', handle, operationId }, options),
    registerProducer(handle, producer, operationId, options) {
      if (!producer || typeof producer !== 'object' || Array.isArray(producer) || Object.keys(producer).some((key) => !['producerId', 'segmentId'].includes(key))) { clearAck(handle); return Promise.resolve(fail('MEMORY_FIELD_FORBIDDEN', 'Producer registration accepts only producer and segment IDs.')); }
      return request({ action: 'registerProducer', handle, producerId: producer.producerId, segmentId: producer.segmentId, operationId }, options);
    },
    replayProducer: (input, options) => request({ ...input, action: 'replayProducer' }, options),
    queryProducerReceipt: (input, options) => request({ ...input, action: 'queryProducerReceipt' }, options),
    async prepare(handle, query, budget = {}, options) {
      const result = await request({ action: 'prepare', handle, query, budget }, options), entry = issued.get(handle), metadata = responses.get(result);
      if (result.ok && entry && entry.descriptor === metadata?.descriptor && result.prepared && typeof result.preparedHandle === 'string' && entry.prepared.size < 8) entry.prepared.set(result.preparedHandle, { digest: digest(result.prepared), expiresAt: result.prepared.expiresAt, role: { id: result.prepared.characterId, epoch: result.prepared.capturedEpoch }, ack: false });
      return result;
    },
    search: (handle, query, searchOptions = {}, options) => request({ action: 'search', handle, query, options: searchOptions }, options),
    async validate(handle, preparedHandle, options) {
      const result = await request({ action: 'validate', handle, preparedHandle }, options), entry = issued.get(handle), packet = entry?.prepared.get(preparedHandle);
      if (result.ok && packet && entry.descriptor === responses.get(result)?.descriptor) packet.ack = true;
      return result;
    },
    verifyPrepared(handle, preparedHandle, preparedCopy) {
      try {
        prune(); const current = role(true), entry = issued.get(handle), packet = entry?.prepared.get(preparedHandle);
        if (!entry || !packet || !packet.ack || !entry.role || entry.role.id !== current.id || entry.role.epoch !== current.epoch || packet.role.id !== current.id || packet.role.epoch !== current.epoch || !Number.isFinite(packet.expiresAt) || packet.expiresAt <= Date.now() || packet.digest !== digest(preparedCopy) || discovery(file, scope).descriptor !== entry.descriptor) { clearAck(handle); return fail('MEMORY_PREPARED_UNTRUSTED', 'The issued package, role, validation acknowledgement or Host instance is stale.', 'Capture and prepare again, then validate immediately before model, persistence and send.'); }
        return { ok: true, admission: 'issued-package-only' };
      } catch (error) { clearAck(handle); return error?.ok === false ? error : fail('MEMORY_PREPARED_UNTRUSTED', 'The prepared package could not be verified.'); }
    },
    bindActualInput: (handle, refs, options) => request({ action: 'bindActualInput', handle, refs }, options),
    release(handle, options) { issued.delete(handle); return request({ action: 'release', handle }, options); },
  });
}
