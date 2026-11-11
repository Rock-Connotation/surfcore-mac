import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { canonical, characterId, digest, fail, identifier, normalizeEvent, redactContent, requireThat, stamp, validateEvent, validatePrepared } from './memory-v2-contract.js';
import { releaseWriterLock } from './memory-v2-worker.js';

const clone = (value) => JSON.parse(canonical(value));
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const errorResult = (error) => fail(error.code?.startsWith('MEMORY_') || error.code?.startsWith('CHARACTER_') ? error.code : 'MEMORY_SERVICE_FAILED', error.code?.startsWith('MEMORY_') || error.code?.startsWith('CHARACTER_') ? error.message : 'The memory Host operation failed.', error.hint);

// This object belongs to trusted Host code. Never export capture/host methods through a model-controlled RPC.
export function createMemoryService({ stateDir, charactersDir, getCharacter, now = Date.now, workerFactory = (url, options) => new Worker(url, options), authorizeManagement = () => false, retireForLifecycle, authorizeProducerReplay = () => false, lifecycleInventory = () => ({ complete: false, sealedSpool: [], externalCopies: [], quotaSnapshot: null }) }) {
  requireThat(typeof getCharacter === 'function' && typeof authorizeManagement === 'function', 'MEMORY_HOST_CONFIG_INVALID', 'Trusted character and management callbacks are required.');
  const stateRoot = path.resolve(stateDir), characterRoot = path.resolve(charactersDir);
  let worker, live = false, initialized = false, initializing, generation, secret, ownerToken, sequence = 0, diagnostic = null, closing=false, closingPromise, dispatching=false, fenceActive=null;
  const fenceQueue=[];
  const pending = new Map(), contexts = new WeakMap(), preparations = new WeakMap();
  const admissionError=(code,error,hint='Refresh the trusted context and complete pending privacy or lifecycle work before retrying.')=>Object.assign(new Error(error),{code,error,hint});
  function drainFence() {
    if(fenceActive) return;
    const item=fenceQueue.shift(); if(!item) return; fenceActive=item;
    Promise.resolve().then(()=>{ if(item.cancelled) throw admissionError('MEMORY_ADMISSION_ABORTED','The queued admission was cancelled.'); return item.task(); }).then(item.resolve,item.reject).finally(()=>{ item.signal?.removeEventListener('abort',item.abort); fenceActive=null; drainFence(); });
  }
  function fenced(task,{signal,admission=false,critical=false}={}) {
    if(dispatching) return Promise.reject(admissionError('MEMORY_NETWORK_DISPATCH_REENTRANT','A network dispatch callback cannot recursively mutate memory or enter lifecycle.'));
    if(signal?.aborted) return Promise.reject(admissionError('MEMORY_ADMISSION_ABORTED','The queued admission was cancelled.','Keep the request cancelled; no network call was started.'));
    if(!critical && fenceQueue.length+(fenceActive?1:0)>=64) return Promise.reject(admissionError('MEMORY_ADMISSION_BUSY','The bounded memory admission queue is full.','Wait for current privacy/lifecycle work to finish, then retry with a fresh context.'));
    return new Promise((resolve,reject)=>{
      const item={task,signal,admission,cancelled:false,resolve,reject};
      item.abort=()=>{item.cancelled=true;const i=fenceQueue.indexOf(item);if(i>=0){fenceQueue.splice(i,1);signal?.removeEventListener('abort',item.abort);}reject(admissionError('MEMORY_ADMISSION_ABORTED','The queued admission was cancelled.','Keep the request cancelled; no network call was started.'));};
      signal?.addEventListener('abort',item.abort,{once:true}); fenceQueue.push(item); drainFence();
    });
  }
  function waitForAdmissionInput(promise,signal) {
    if(!signal) return promise;
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(admissionError('MEMORY_ADMISSION_ABORTED','The actual-input wait was cancelled.','Keep the request cancelled; no network call was started.'));};
      if(signal.aborted){abort();return;} signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then((value)=>{signal.removeEventListener('abort',abort);resolve(value);},(error)=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  function cancelQueuedAdmissions(code,error) {
    for(const item of [...fenceQueue]) if(item.admission){fenceQueue.splice(fenceQueue.indexOf(item),1);item.cancelled=true;item.signal?.removeEventListener('abort',item.abort);item.reject(admissionError(code,error));}
  }
  function lockFile() { return path.join(fs.existsSync(stateRoot) ? fs.realpathSync(stateRoot) : stateRoot, 'memory-v2.writer.lock'); }
  function dead(code, error) {
    live = false; initialized = false; cancelQueuedAdmissions(code,error);
    diagnostic = fail(code, error, 'Keep V1 active. Close and reopen the shadow service, query original operation receipts, and capture new contexts; retire old sessions.');
    for (const request of pending.values()) request.resolve({ ...diagnostic, operationState: 'unknown', retry: 'query_receipt' });
    pending.clear();
  }
  function rpc(method, args = []) {
    if (!live) return Promise.resolve(diagnostic ?? fail('MEMORY_WORKER_UNAVAILABLE', 'The memory worker is not running.'));
    const id = ++sequence, body = { id, method, args, now: now() };
    try { canonical(body); } catch (error) { return Promise.resolve(errorResult(error)); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { dead('MEMORY_WORKER_UNAVAILABLE', 'The memory worker did not acknowledge the request.'); void worker.terminate(); }, method === 'lifecycle' ? 120000 : 15000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
      try { worker.postMessage({ ...body, signature: stamp(body, secret) }); }
      catch { dead('MEMORY_WORKER_UNAVAILABLE', 'The memory request could not reach its worker.'); }
    });
  }
  async function initialize() {
    if(closingPromise) return fail('MEMORY_SERVICE_CLOSING','The memory service is closing.','Wait for close to complete before explicitly initializing a new worker.');
    closing=false;
    if (live && initialized) return getStatus();
    if (initializing) return initializing;
    if (worker) await worker.terminate();
    generation = randomUUID(); secret = randomBytes(32).toString('hex'); ownerToken = randomUUID();
    diagnostic = null;
    initializing = new Promise((resolve) => {
      try {
        worker = workerFactory(new URL('./memory-v2-worker.js', import.meta.url), { workerData: { stateDir: stateRoot, charactersDir: characterRoot, generation, secret, ownerToken }, execArgv: process.execArgv.filter((value) => ['--experimental-sqlite', '--expose-internals'].includes(value)) });
        const currentWorker = worker, currentToken = ownerToken;
        const timer = setTimeout(() => { dead('MEMORY_WORKER_UNAVAILABLE', 'The memory worker startup timed out.'); void currentWorker.terminate(); resolve(diagnostic); }, 15000);
        worker.on('message', (packet) => {
          if (packet.type === 'ready') {
            clearTimeout(timer);
            live = packet.result.ok; initialized = live; diagnostic = live ? null : packet.result;
            resolve(packet.result); return;
          }
          const request = pending.get(packet.id);
          if (request) { pending.delete(packet.id); request.resolve(packet.result); }
        });
        worker.on('error', () => { clearTimeout(timer); if (worker === currentWorker) dead('MEMORY_WORKER_CRASHED', 'The memory worker crashed.'); resolve(diagnostic); });
        worker.on('exit', () => {
          clearTimeout(timer); releaseWriterLock(lockFile(), currentToken);
          if (worker === currentWorker) dead('MEMORY_WORKER_EXITED', 'The memory worker has exited; previous contexts and preparations are retired.');
          resolve(diagnostic);
        });
      } catch (error) { dead('MEMORY_BACKEND_UNSUPPORTED', 'A compatible memory worker could not be started.'); resolve(errorResult(error)); }
    });
    try { return await initializing; } finally { initializing = null; }
  }
  function currentCharacter() {
    const value = getCharacter();
    requireThat(value && typeof value.then !== 'function', 'MEMORY_HOST_CONFIG_INVALID', 'getCharacter must synchronously capture the trusted role and epoch.');
    characterId(value.id);
    requireThat(Number.isSafeInteger(value.epoch) && value.epoch >= 1, 'CHARACTER_EPOCH_REQUIRED', 'The trusted Host character epoch is missing.');
    return value;
  }
  function check(ctx, admin = false) {
    const record = contexts.get(ctx);
    requireThat(record && record.generation === generation && live && initialized, 'MEMORY_CONTEXT_UNTRUSTED', 'The context was not minted by this live Host service.', 'Capture a new context through the trusted channel adapter; do not supply model authorization fields.');
    const current = currentCharacter();
    requireThat(current.id === ctx.characterId && current.epoch === ctx.capturedEpoch, 'CHARACTER_EPOCH_STALE', 'The character changed while this request was in flight.', 'Cancel the old task, retire its session, and capture the current character again.');
    requireThat(!record.bindingError, 'MEMORY_MANIFEST_BINDING_FAILED', 'An actual input attachment failed; this request is no longer admissible.', 'Cancel this request and capture a new context with its complete authorized input manifest.');
    if (admin) requireThat(record.admin === true, 'MEMORY_ADMIN_REQUIRED', 'The context does not carry a management capability.');
    return record;
  }
  function serialized(ctx) { const record = check(ctx); return { ...ctx, admin: record.admin }; }
  async function capture(input, admin = false, authorization) {
    try {
      requireThat(live && initialized, 'MEMORY_WORKER_UNAVAILABLE', 'Initialize the shadow service before capturing contexts.');
      requireThat(admin || (input.purpose ?? 'conversation') !== 'admin', 'MEMORY_ADMIN_REQUIRED', 'Ordinary context capture cannot create management authority.');
      const current = currentCharacter();
      if (admin) {
        const decision = authorizeManagement(authorization, input);
        if (decision && typeof decision.then === 'function') Promise.resolve(decision).catch(() => {});
        requireThat(decision === true, 'MEMORY_ADMIN_REQUIRED', 'The authenticated settings transport did not authorize this management request.');
        const authorizedCharacter = currentCharacter();
        requireThat(current.id === authorizedCharacter.id && current.epoch === authorizedCharacter.epoch, 'CHARACTER_EPOCH_STALE', 'The character changed during management authorization.');
      }
      const result = await rpc('metadata', [{ characterId: current.id, admin }]);
      if (result.ok === false) return result;
      const again = currentCharacter();
      requireThat(current.id === again.id && current.epoch === again.epoch, 'CHARACTER_EPOCH_STALE', 'The character changed during context capture.');
      const ctx = {
        characterId: current.id, capturedEpoch: current.epoch, requestId: randomUUID(),
        channel: identifier(input.channel, 'channel'), conversationKey: identifier(input.conversationKey, 'conversationKey'),
        sourceAccountKey: identifier(input.sourceAccountKey, 'sourceAccountKey'), requesterAccountKey: identifier(input.requesterAccountKey, 'requesterAccountKey'),
        audiencePolicyId: identifier(input.audiencePolicyId, 'audiencePolicyId'), providerRouteId: identifier(input.providerRouteId, 'providerRouteId'), processingGrantId: identifier(input.processingGrantId, 'processingGrantId'),
        purpose: admin ? 'admin' : (input.purpose ?? 'conversation'), policyRevision: result.policyRevision, bindingRevision: result.bindingRevision, deletionRevision: result.deletionRevision, controlRevision: result.revision, storeGeneration: generation,
      };
      requireThat(['conversation', 'organize', 'admin'].includes(ctx.purpose), 'MEMORY_SCHEMA_INVALID', 'Unknown memory purpose.');
      freeze(ctx); contexts.set(ctx, { admin, generation, manifest: [] });
      if (!admin) {
        const valid = await rpc('validateContext', [{ ...ctx, admin: false }]);
        if (!valid.ok) return valid;
      }
      return { ok: true, context: ctx };
    } catch (error) { return errorResult(error); }
  }
  async function invokeInternal(ctx, method, rest = [], { admin = false, manifest = false, mutation = false } = {}) {
    try {
      const record = check(ctx, admin);
      if (manifest && record.binding) {
        const attached = await record.binding;
        if (!attached.ok) return fail('MEMORY_MANIFEST_BINDING_FAILED', 'An actual input attachment failed; the request cannot continue.', 'Cancel this request and capture a new context with its complete authorized input manifest.');
      }
      const wire = serialized(ctx);
      const args = [wire, ...rest];
      if (manifest) args.push(clone(record.manifest));
      const result = await rpc(method, args);
      try { check(ctx, admin); }
      catch (error) { return { ...errorResult(error), operationId: result.operationId ?? null, ...(mutation && result.ok ? { operationState: 'completed_before_cancel', sourceState: result.sourceState ?? 'committed', retry: 'query_receipt' } : {}) }; }
      return result;
    } catch (error) { return errorResult(error); }
  }
  function invoke(ctx,method,rest=[],options={}) { return options.mutation ? fenced(()=>invokeInternal(ctx,method,rest,options)).catch(errorResult) : invokeInternal(ctx,method,rest,options); }
  async function withNetworkAdmission(ctx,dispatchFunction,{signal}={}) {
    let dispatched=false;
    try {
      requireThat(typeof dispatchFunction==='function','MEMORY_NETWORK_DISPATCH_REQUIRED','A trusted Host dispatch callback is required.');
      requireThat(!closing && live && initialized,'MEMORY_WORKER_UNAVAILABLE','The memory service cannot admit new network calls.');
      requireThat(!signal || (typeof signal.addEventListener==='function' && typeof signal.removeEventListener==='function'),'MEMORY_ADMISSION_SIGNAL_INVALID','Use an actual abort signal for cancellable admission.');
      const record=check(ctx), binding=record.binding; requireThat(!record.admin,'MEMORY_ADMIN_REQUIRED','Management capabilities cannot authorize model network dispatch.');
      if(binding){const attached=await waitForAdmissionInput(binding,signal);requireThat(attached.ok,'MEMORY_MANIFEST_BINDING_FAILED','An actual input attachment failed.');}
      const admitted=await fenced(async()=>{
        requireThat(!closing && live && initialized,'MEMORY_WORKER_UNAVAILABLE','The memory service cannot admit new network calls.');
        check(ctx); requireThat(record.binding===binding,'MEMORY_MANIFEST_CHANGED','The actual input manifest changed while admission was queued.');
        const valid=await rpc('validateContext',[serialized(ctx),null,clone(record.manifest)]);
        if(!valid.ok) throw admissionError(valid.code,valid.error,valid.hint);
        check(ctx); requireThat(record.binding===binding,'MEMORY_MANIFEST_CHANGED','The actual input manifest changed during final admission.');
        requireThat(!signal?.aborted && !fenceActive?.cancelled,'MEMORY_ADMISSION_ABORTED','The network request was cancelled before dispatch.');
        requireThat(valid.validUntil===null || valid.validUntil===undefined || valid.validUntil>now(),'MEMORY_SOURCE_STALE','An actual input expired before immediate network dispatch.');
        requireThat(!record.preparedDeadline || record.preparedDeadline>now(),'MEMORY_PREPARED_STALE','An issued input package expired before network dispatch.');
        signal?.removeEventListener('abort',fenceActive.abort);
        dispatching=true; dispatched=true;
        try { return {response:dispatchFunction()}; } finally {dispatching=false;}
      },{signal,admission:true});
      return await admitted.response;
    } catch(error) {
      if(dispatched) throw error;
      const result=errorResult(error); throw admissionError(result.code,result.error,result.hint);
    }
  }
  function verifyPrepared(ctx, prepared) {
    try {
      check(ctx);
      const known = preparations.get(prepared);
      requireThat(known?.context === ctx && known.digest === digest(prepared) && known.queryDigest === prepared.queryDigest, 'MEMORY_PREPARED_UNTRUSTED', 'This package was not issued for this exact live Host request.');
      validatePrepared(prepared, ctx, now());
      return { ok: true, admission: 'issued-package-only' };
    } catch (error) { return errorResult(error); }
  }
  async function getStatus() { return live && initialized ? rpc('getStatus') : diagnostic ?? fail('MEMORY_WORKER_UNAVAILABLE', 'The shadow memory service has not been initialized.'); }
  async function applyMemoryAction(ctx, action, expectedRevision, operationId) {
    try {
      check(ctx, true);
      // Control actions contain only typed IDs and references; all content belongs to evidence-backed role transactions.
      return await invoke(ctx, 'applyMemoryAction', [clone(action), expectedRevision, operationId], { admin: true, mutation: true });
    } catch (error) { return errorResult(error); }
  }
  async function producerCall(method, request, authorization) {
    try {
      requireThat(!dispatching || method!=='replayProducer','MEMORY_NETWORK_DISPATCH_REENTRANT','A network callback cannot recursively replay a producer mutation.');
      const operationId = identifier(request?.operationId,'operationId');
      if(method === 'queryProducerReceipt') {
        const registered = await rpc('producerRegistrationReceipt',[operationId]); if(!registered.ok) return registered;
        if(registered.found) {
          const decision = await authorizeProducerReplay(authorization,freeze(clone(registered.registration)));
          requireThat(decision === true || decision?.ok === true,'MEMORY_PRODUCER_REPLAY_DENIED','The trusted adapter did not authorize this actual original registration scope.');
          requireThat(!request.registrationId || request.registrationId === registered.registration.registrationId,'MEMORY_PRODUCER_SCOPE_CONFLICT','The supplied registration ID differs from the original durable operation receipt.');
          return registered.receipt;
        }
        if(!request.registrationId) {
          const decision=await authorizeProducerReplay(authorization,freeze({kind:'registration_receipt_lookup',operationId}));
          requireThat(decision === true || decision?.ok === true,'MEMORY_PRODUCER_REPLAY_DENIED','The trusted adapter did not authorize a content-free registration receipt lookup.');
          return {ok:true,operationId,operationState:'not_found',registrationState:'not_found',sourceState:'pending',retry:'same_operation_id',hint:'No durable registration receipt exists. Preserve original queued bytes; do not recapture the old epoch under a new role.'};
        }
      }
      const registrationId = identifier(request.registrationId,'registrationId');
      const loaded = await rpc('producerRegistration',[registrationId]); if(!loaded.ok) return loaded;
      const decision = await authorizeProducerReplay(authorization,freeze(clone(loaded.registration)));
      requireThat(decision === true || decision?.ok === true,'MEMORY_PRODUCER_REPLAY_DENIED','The trusted source adapter did not authorize this original producer scope.');
      if(method === 'queryProducerReceipt') return await fenced(()=>rpc('queryProducerReceipt',[registrationId,operationId]));
      const batch=clone(request.batch); requireThat(Array.isArray(batch?.events) && batch.events.length>0,'MEMORY_SCHEMA_INVALID','A canonical original durable spool batch is required.'); batch.events.forEach(validateEvent);
      return await fenced(()=>rpc('replayProducer',[registrationId,batch,operationId]));
    } catch(error) { return errorResult(error); }
  }
  async function lifecycleInternal(ctx, method, request = {}, expectedRevision, operationId) {
    try {
      const authority = check(ctx, true);
      requireThat(typeof lifecycleInventory === 'function', 'MEMORY_HOST_CONFIG_INVALID', 'The lifecycle inventory callback is unavailable.');
      const inventory = method === 'progress' ? {} : clone(await lifecycleInventory({ characterId: ctx.characterId, purpose: method }));
      check(ctx, true);
      let result = await rpc('lifecycle', [serialized(ctx), method, clone(request), expectedRevision ?? null, operationId ?? null, inventory]);
      if (!result.ok || !result.retirement || method === 'progress' || method.startsWith('preview')) return result;
      if (typeof retireForLifecycle !== 'function') return { ...result, complete: false, code: 'MEMORY_RETIREMENT_REQUIRED', error: 'Lifecycle controls committed; Host retirement is not configured.', hint: 'Configure the trusted lifecycle retirement callback and resume the original operation. Keep affected history/model/send admission blocked.' };
      let proof;
      try { proof = await retireForLifecycle(freeze(clone(result.retirement))); }
      catch { return { ...result, complete: false, code: 'MEMORY_RETIREMENT_REQUIRED', error: 'Host retirement failed after the durable lifecycle safety barrier.', hint: 'Inspect the Host session retirement failure and resume the original operation; do not bypass the safety barrier.' }; }
      const current = currentCharacter();
      requireThat(authority.admin && proof?.ok === true && current.id === ctx.characterId && current.epoch === proof.epoch && current.epoch > result.retirement.previousEpoch, 'MEMORY_RETIREMENT_REQUIRED', 'The Host did not advance the actual native character epoch.', 'Complete real session/in-flight retirement, then resume the original lifecycle operation.');
      const acknowledged = await rpc('lifecycle', [{ ...ctx, admin: true }, 'acknowledge', { operationId: result.retirement.operationId, proof: clone(proof) }, null, null, inventory]);
      if (!acknowledged.ok || !acknowledged.restartRequired) return acknowledged;
      const closing = worker; await rpc('close'); await closing.terminate(); releaseWriterLock(lockFile(), ownerToken); live = false; initialized = false;
      const reopened = await initialize(); if (!reopened.ok) return reopened;
      const wire = { ...ctx, capturedEpoch: current.epoch, storeGeneration: generation, admin: true };
      result = await rpc('lifecycle', [wire, 'progress', { operationId: result.operationId }, null, null, inventory]);
      return result;
    } catch (error) { return errorResult(error); }
  }
  function lifecycleCall(...args) { return fenced(()=>lifecycleInternal(...args)).catch(errorResult); }
  async function adminInternal(ctx, method, request = {}, expectedRevision, operationId) {
    try {
      const authority = check(ctx, true), wire = serialized(ctx);
      if (method === 'commit') {
        const prior = await rpc('admin', [wire, 'progress', { operationId }, null, null]);
        if (!prior.ok) return prior;
        if (prior.operationState === 'not_found') requireThat(authority.adminPreviews?.get(request.previewDigest) === digest({ action:request.action, payload:request.payload, expectedRevision }), 'MEMORY_PREVIEW_UNTRUSTED', 'Confirm a preview issued to this exact live management context.');
      }
      let result = await rpc('admin', [wire, method, clone(request), expectedRevision ?? null, operationId ?? null]);
      if (method === 'preview' && result.ok) { check(ctx, true); authority.adminPreviews ??= new Map(); if(authority.adminPreviews.size>=32) authority.adminPreviews.delete(authority.adminPreviews.keys().next().value); authority.adminPreviews.set(result.previewDigest,digest({ action:request.action,payload:request.payload,expectedRevision })); }
      if (!result.ok || !result.retirement || !['commit','resume'].includes(method)) { check(ctx,true); return result; }
      if (typeof retireForLifecycle !== 'function') return { ...result, complete:false, code:'MEMORY_RETIREMENT_REQUIRED', error:'The management intent and role effects require actual Host retirement.', hint:'Configure the trusted retirement callback and explicitly resume this original operation.' };
      let proof;
      try { proof = await retireForLifecycle(freeze(clone(result.retirement))); }
      catch { return { ...result, complete:false, code:'MEMORY_RETIREMENT_REQUIRED', error:'Host session retirement failed after the durable control barrier.', hint:'Inspect native session retirement and resume the original operation; admission remains blocked.' }; }
      const current = currentCharacter();
      requireThat(authority.admin && proof?.ok === true && current.id === ctx.characterId && current.epoch === proof.epoch && current.epoch > result.retirement.previousEpoch, 'MEMORY_RETIREMENT_REQUIRED', 'The actual current native character epoch did not advance.');
      const acknowledged = await rpc('admin', [{ ...ctx, admin:true }, 'acknowledge', { operationId:result.operationId, proof:clone(proof) }, null, null]);
      if (!acknowledged.ok || !acknowledged.restartRequired) return acknowledged;
      const retiring = worker; await rpc('close'); await retiring.terminate(); releaseWriterLock(lockFile(),ownerToken); live=false; initialized=false;
      const reopened = await initialize(); if(!reopened.ok) return reopened;
      const again=currentCharacter(); requireThat(again.id===current.id && again.epoch===current.epoch,'CHARACTER_EPOCH_STALE','The native role changed during management recovery.');
      result = await rpc('admin', [{ ...ctx, capturedEpoch:current.epoch, storeGeneration:generation, admin:true }, 'progress', { operationId:result.operationId }, null, null]);
      return result;
    } catch(error) { return errorResult(error); }
  }
  const adminHost = Object.freeze(Object.fromEntries(['status','inspect','preview','commit','resume','bindRequest'].map((method)=>[method,(ctx,request={},expectedRevision,operationId)=>['commit','resume','bindRequest'].includes(method) ? fenced(()=>adminInternal(ctx,method,request,expectedRevision,operationId)).catch(errorResult) : adminInternal(ctx,method,request,expectedRevision,operationId)])));
  const lifecycleHost = Object.freeze(Object.fromEntries(['previewBackup', 'backup', 'previewRestore', 'restore', 'previewDelete', 'requestDelete', 'continueDelete', 'resume'].map((method) => [method, (ctx, request = {}, expectedRevision, operationId) => lifecycleCall(ctx, method, request, expectedRevision, operationId)]).concat([['progress', (ctx, operationId) => lifecycleCall(ctx, 'progress', { operationId })]])));
  return {
    initialize, getStatus,
    close() {
      if(closingPromise) return closingPromise;
      if(dispatching) return Promise.resolve(fail('MEMORY_NETWORK_DISPATCH_REENTRANT','A network callback cannot close memory.'));
      closing=true; cancelQueuedAdmissions('MEMORY_SERVICE_CLOSING','The memory service is closing.');
      closingPromise=fenced(async()=>{
        if(!worker) return {ok:true}; const retiring=worker, result=live?await rpc('close'):{ok:true}; await retiring.terminate(); releaseWriterLock(lockFile(),ownerToken); if(worker===retiring){live=false;initialized=false;} return result;
      },{critical:true}).catch(errorResult).finally(()=>{closingPromise=null;});
      return closingPromise;
    },
    captureContext: (input) => capture(input),
    ingestEvents(ctx, batch, operationId) {
      try {
        check(ctx);
        let normalized;
        if (Array.isArray(batch)) normalized = { events: batch.flatMap((raw) => normalizeEvent(raw, ctx)) };
        else {
          requireThat(batch?.ok !== false && Array.isArray(batch?.events), 'MEMORY_BATCH_INVALID', 'Only a complete validated spool batch may be imported.');
          normalized = { events: batch.events.map(validateEvent) };
          for (const key of ['producerId', 'segmentId', 'startOffset', 'nextOffset', 'positions']) if (batch[key] !== undefined) normalized[key] = clone(batch[key]);
        }
        return invoke(ctx, 'ingestEvents', [normalized, operationId], { manifest: true, mutation: true });
      } catch (error) { return Promise.resolve(errorResult(error)); }
    },
    getMemoryReceipt: (ctx, operationId) => invoke(ctx, 'getMemoryReceipt', [operationId]),
    searchMemory: (ctx, query, options = {}) => invoke(ctx, 'searchMemory', [query, clone(options)]),
    async prepareMemoryContext(ctx, query, budget = {}) {
      try {
        requireThat(typeof query === 'string', 'MEMORY_QUERY_INVALID', 'Use current authorized text as the query.');
        const result = await invoke(ctx, 'prepareMemoryContext', [query, clone(budget)]);
        if (result.ok) {
          freeze(result.prepared);
          const record=check(ctx); record.preparedDeadline=Math.min(record.preparedDeadline ?? Infinity,result.prepared.expiresAt);
          preparations.set(result.prepared, { context: ctx, digest: digest(result.prepared), queryDigest: digest(query) });
        }
        return result;
      } catch (error) { return errorResult(error); }
    },
    proposeMemory(ctx, proposal) {
      try {
        check(ctx);
        const normalized = clone(proposal);
        if (typeof normalized.content === 'string') normalized.content = redactContent(normalized.content, { scope: ctx.channel === 'qq' ? 'qq' : 'shared' });
        if (typeof normalized.subject === 'string') normalized.subject = redactContent(normalized.subject, { scope: ctx.channel === 'qq' ? 'qq' : 'shared' });
        if (normalized.evidenceRefs) normalized.evidenceRefs = normalized.evidenceRefs.map((ref) => ({ ...ref, text: redactContent(ref.text, { scope: ctx.channel === 'qq' ? 'qq' : 'shared' }) }));
        return invoke(ctx, 'proposeMemory', [normalized], { manifest: true, mutation: true });
      } catch (error) { return Promise.resolve(errorResult(error)); }
    },
    applyMemoryAction,
    validateContext(ctx, prepared) {
      try {
        check(ctx);
        if (prepared) {
          const known = preparations.get(prepared);
          requireThat(known?.context === ctx && known.digest === digest(prepared) && known.queryDigest === prepared.queryDigest, 'MEMORY_PREPARED_UNTRUSTED', 'This prepared package was not issued for this exact live Host request.');
        }
        return invoke(ctx, 'validateContext', [prepared ?? null], { manifest: true });
      } catch (error) { return Promise.resolve(errorResult(error)); }
    },
    host: Object.freeze({
      verifyPrepared,
      lifecycle: lifecycleHost,
      admin: adminHost,
      async registerProducer(ctx, producer, operationId) {
        try {
          check(ctx); const registration = Object.fromEntries(['characterId','capturedEpoch','channel','conversationKey','sourceAccountKey','requesterAccountKey','audiencePolicyId','processingGrantId','providerRouteId'].map((key)=>[key,ctx[key]])); Object.assign(registration,{producerId:producer.producerId,segmentId:producer.segmentId});
          const registrationId = `producer-${digest(registration).slice(0,32)}`;
          return { ...await invoke(ctx,'registerProducer',[clone(producer),operationId],{mutation:true}), registrationId, characterId:ctx.characterId, capturedEpoch:ctx.capturedEpoch };
        } catch(error) { return errorResult(error); }
      },
      replayProducer: (request, authorization) => producerCall('replayProducer', request, authorization),
      queryProducerReceipt: (request, authorization) => producerCall('queryProducerReceipt', request, authorization),
      finishOrganizeBatch: (ctx, request, operationId) => invoke(ctx, 'finishOrganizeBatch', [clone(request), operationId], { mutation: true }),
      readOrganizeBatch: (ctx, options = {}) => invoke(ctx, 'readOrganizeBatch', [clone(options)],{mutation:true}),
      withNetworkAdmission,
      async resolveAudience(facts) {
        try {
          requireThat(live && initialized, 'MEMORY_WORKER_UNAVAILABLE', 'Initialize the shadow service before resolving audience permissions.');
          requireThat(facts && Object.keys(facts).every((key) => ['channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'purpose'].includes(key)), 'MEMORY_FIELD_FORBIDDEN', 'Audience resolution accepts trusted facts, not policy IDs, grant IDs or revisions.');
          const current = currentCharacter(), input = { characterId: current.id, purpose: facts.purpose ?? 'conversation' };
          for (const key of ['channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId']) input[key] = identifier(facts[key], key);
          requireThat(['conversation', 'organize'].includes(input.purpose), 'MEMORY_ADMIN_REQUIRED', 'Audience resolution cannot mint management authority.');
          const result = await rpc('resolveAudience', [input]), again = currentCharacter();
          requireThat(current.id === again.id && current.epoch === again.epoch, 'CHARACTER_EPOCH_STALE', 'The character changed during audience resolution.');
          return result;
        } catch (error) { return errorResult(error); }
      },
      captureAdminContext: (input, authorization) => capture(input, true, authorization),
      configurePolicy: (ctx, policy, expectedRevision, operationId) => applyMemoryAction(ctx, { type: 'configure_policy', policy }, expectedRevision, operationId),
      async bindInputManifest(ctx, refs) {
        let record;
        try {
          record = check(ctx);
          requireThat(Array.isArray(refs), 'MEMORY_MANIFEST_INVALID', 'The Host must attach the complete actual input manifest.');
          const additions = clone(refs);
          record.binding = (record.binding ?? Promise.resolve()).then(async () => {
            const union = [...new Map([...record.manifest, ...additions].map((ref) => [canonical(ref), ref])).values()];
            const valid = await invoke(ctx, 'validateManifest', [union]);
            if (valid.ok) record.manifest = freeze(union);
            else record.bindingError ??= valid;
            return valid;
          });
          return await record.binding;
        } catch (error) {
          const failure = errorResult(error);
          if (record) record.bindingError ??= failure;
          return failure;
        }
      },
    }),
  };
}
