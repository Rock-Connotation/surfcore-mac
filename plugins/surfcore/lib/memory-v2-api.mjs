import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isLoopbackReq, sameOrigin, safeEqual, json } from './http-guard.js';

const PREFIX = '/dsh-surfcore/memory-v2-api';
const failure = (code, error, hint = 'Read the current channel discovery file and capture a fresh authorized request.') => ({ ok: false, code, error, hint });
const fields = {
  capture: ['conversationKey', 'sourceFacts'], ingest: ['handle', 'events', 'operationId'], receipt: ['handle', 'operationId'],
  prepare: ['handle', 'query', 'budget'], search: ['handle', 'query', 'options'], validate: ['handle', 'preparedHandle'],
  bindActualInput: ['handle', 'refs'], release: ['handle'],
  registerProducer: ['handle', 'producerId', 'segmentId', 'operationId'], replayProducer: ['registrationId', 'batch', 'operationId'], queryProducerReceipt: ['registrationId', 'operationId'],
};
function localOrigin(raw) {
  const value = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) || !['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw new Error('Invalid local origin.');
  return value;
}
function readJson(req, maxBodyBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [], finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(failure('MEMORY_REQUEST_TIMEOUT', 'The memory request body timed out.')), timeoutMs);
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) { chunks.length = 0; finish(failure('MEMORY_REQUEST_TOO_LARGE', 'The memory request exceeds its byte budget.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(failure('MEMORY_JSON_INVALID', 'The memory request is not valid JSON.')); } } });
    req.on('error', () => finish(failure('MEMORY_REQUEST_FAILED', 'The memory request body could not be read.')));
    req.on('aborted', () => finish(failure('MEMORY_REQUEST_FAILED', 'The memory request was cancelled.')));
  });
}

/** Each discovery credential is bound to one trusted adapter closure. No management RPC exists. */
export function createMemoryApiService({ host, stateDir, currentDshUrl, scopes = [], maxBodyBytes = 256 * 1024, maxResponseBytes = 512 * 1024, bodyTimeoutMs = 5000 } = {}) {
  if (!host || typeof currentDshUrl !== 'function' || !path.isAbsolute(stateDir ?? '') || !Array.isArray(scopes) || !scopes.length || scopes.length > 8 || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024 || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 30_000) throw new TypeError('Invalid memory transport configuration.');
  const root = path.join(stateDir, 'memory-v2'), ids = new Set();
  const entries = scopes.map((scope) => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(scope.id ?? '') || ids.has(scope.id)) throw new TypeError('Memory scopes require distinct bounded IDs.');
    ids.add(scope.id);
    return { id: scope.id, token: randomBytes(32).toString('hex'), adapter: host.createAdapter(scope), canBindInput: scope.canBindInput === true, canSubmitSourceFacts: scope.canSubmitSourceFacts === true, canRecoverProducer: scope.channel === 'qq' && scope.canSubmitSourceFacts === true, file: path.join(root, `${scope.id}.json`) };
  });
  let closed = false;
  function writeHostFiles() {
    if (closed) return failure('MEMORY_TRANSPORT_CLOSED', 'The memory transport is closed.');
    try {
      const base = localOrigin(currentDshUrl());
      if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory())) throw new Error();
      fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
      for (const entry of entries) {
        const temporary = path.join(root, `.${entry.id}-${randomBytes(12).toString('hex')}.tmp`);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ version: 1, baseUrl: base.origin, api: PREFIX, scope: entry.id, token: entry.token, maxBodyBytes, maxResponseBytes })); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, entry.file); fs.chmodSync(entry.file, 0o600);
      }
      return { ok: true };
    } catch { return failure('MEMORY_DISCOVERY_FAILED', 'The scoped memory discovery files could not be written.', 'Check the isolated state directory and current loopback Host origin.'); }
  }
  async function handle(req, res, url) {
    const respond = (status, value) => {
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > maxResponseBytes) { json(res, 413, failure('MEMORY_RESPONSE_TOO_LARGE', 'The memory response exceeds its byte budget.', 'Request a smaller event batch, result limit or preparation budget.')); return; }
        json(res, status, value);
      } catch { json(res, 500, failure('MEMORY_RESPONSE_FAILED', 'The memory response could not be serialized.')); }
    };
    if (url?.pathname !== PREFIX || url.search) { respond(404, failure('MEMORY_ROUTE_INVALID', 'This memory RPC route is unavailable.')); return; }
    const entry = entries.find((candidate) => safeEqual(req.headers?.['x-memory-v2-token'], candidate.token));
    if (closed || !entry || !isLoopbackReq(req)) { respond(403, failure('MEMORY_AUTH_REQUIRED', 'The channel memory credential is invalid.')); return; }
    let base;
    try { base = localOrigin(currentDshUrl()); } catch { respond(403, failure('MEMORY_ORIGIN_REJECTED', 'The memory Host origin is unavailable.')); return; }
    if (!sameOrigin(req) || String(req.headers.host).toLowerCase() !== base.host.toLowerCase() || (req.headers.origin && req.headers.origin !== base.origin)) { respond(403, failure('MEMORY_ORIGIN_REJECTED', 'The memory request origin was rejected.')); return; }
    if (req.method === 'GET') { respond(200, await host.status()); return; }
    if (req.method !== 'POST') { respond(405, failure('MEMORY_METHOD_INVALID', 'Use GET for status or POST for ordinary memory operations.')); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) { respond(415, failure('MEMORY_JSON_REQUIRED', 'The memory RPC requires application/json.')); return; }
    try {
      const body = await readJson(req, maxBodyBytes, bodyTimeoutMs), allowed = typeof body?.action === 'string' && Object.hasOwn(fields, body.action) ? fields[body.action] : null;
      if (!allowed || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'action' && !allowed.includes(key))) { respond(400, failure('MEMORY_FIELD_FORBIDDEN', 'The RPC accepts only typed ordinary operations; authorization fields are forbidden.')); return; }
      if (body.action === 'bindActualInput' && !entry.canBindInput) { respond(403, failure('MEMORY_ADAPTER_REQUIRED', 'This channel credential cannot attach actual inputs.')); return; }
      if (body.action === 'capture' && body.sourceFacts !== undefined && !entry.canSubmitSourceFacts) { respond(403, failure('MEMORY_ADAPTER_REQUIRED', 'This channel credential cannot submit platform source facts.')); return; }
      if (['registerProducer', 'replayProducer', 'queryProducerReceipt'].includes(body.action) && !entry.canRecoverProducer) { respond(403, failure('MEMORY_ADAPTER_REQUIRED', 'This channel credential cannot register or recover durable QQ producers.')); return; }
      const args = {
        capture: () => [{ conversationKey: body.conversationKey, ...(body.sourceFacts !== undefined ? { sourceFacts: body.sourceFacts } : {}) }], ingest: () => [body.handle, body.events, body.operationId], receipt: () => [body.handle, body.operationId],
        prepare: () => [body.handle, body.query, body.budget], search: () => [body.handle, body.query, body.options], validate: () => [body.handle, body.preparedHandle],
        bindActualInput: () => [body.handle, body.refs], release: () => [body.handle],
        registerProducer: () => [body.handle, { producerId: body.producerId, segmentId: body.segmentId }, body.operationId],
        replayProducer: () => [{ registrationId: body.registrationId, batch: body.batch, operationId: body.operationId }], queryProducerReceipt: () => [{ registrationId: body.registrationId, operationId: body.operationId }],
      };
      const result = await entry.adapter[body.action](...args[body.action]());
      respond(result?.ok ? 200 : 400, result);
    } catch (error) {
      respond(400, failure(/^(MEMORY|CHARACTER)_[A-Z_]+$/.test(error?.code) ? error.code : 'MEMORY_RPC_FAILED', 'The memory RPC could not complete.', 'Check memory status; for uncertain writes query the original receipt before retrying.'));
    }
  }
  return Object.freeze({ prefix: PREFIX, handle, writeHostFiles, close() { closed = true; }, discoveryFiles: Object.freeze(Object.fromEntries(entries.map((entry) => [entry.id, entry.file]))) });
}
