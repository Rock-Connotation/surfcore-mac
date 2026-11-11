import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { redactContent } from '../../../src/core/memory-v2-contract.js';
import { buildQQV2SourcePacket } from './qq-v2-source-packet.mjs';
import { createQQV2NativeLedger } from './qq-v2-native-ledger.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const fail = (code, error = 'QQ V2 source operation was refused.', hint = 'Keep the original request blocked and verify the trusted QQ Host identity and source context.') => ({
  ok: false,
  code,
  error,
  hint,
});

const requireValue = (condition, code, error, hint) => {
  if (!condition) {
    const err = new Error(error || 'Validation failed');
    err.code = code || 'QQ_SOURCE_RUNTIME_INVALID';
    err.hint = hint || 'Check QQ source runtime dependencies.';
    throw err;
  }
};

const safeText = text => {
  requireValue(typeof text === 'string' && !/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text), 'MEMORY_NATIVE_UNSAFE_CONTENT', 'Unsafe control characters in text.');
  return text;
};

const exact = (obj, fields) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === fields.length && fields.every(k => Object.hasOwn(obj, k));

export function createQQV2SourceRuntime({
  bridge,
  adapter,
  getCharacter,
  getQQIdentity,
  corePersona,
  nativeCodec,
  toolSpecs = [],
  validateOwnedToolContext,
  now = Date.now,
} = {}) {
  requireValue(bridge && typeof bridge.exportNativeSources === 'function' && typeof bridge.authorizeSend === 'function' && typeof bridge.recordSent === 'function' && typeof bridge.retire === 'function', 'QQ_SOURCE_UNSUPPORTED', 'Valid QQ memory bridge instance is required.');
  requireValue(adapter && typeof adapter.capture === 'function' && typeof adapter.bindActualInput === 'function' && typeof adapter.prepare === 'function' && typeof adapter.verifyPrepared === 'function' && typeof adapter.validate === 'function' && typeof adapter.release === 'function' && typeof adapter.withNetworkAdmission === 'function', 'QQ_SOURCE_UNSUPPORTED', 'Private QQ Host adapter with network admission is required.');
  requireValue(typeof getCharacter === 'function', 'QQ_SOURCE_UNSUPPORTED', 'Synchronous getCharacter callback is required.');
  requireValue(typeof getQQIdentity === 'function', 'QQ_SOURCE_UNSUPPORTED', 'getQQIdentity callback is required.');
  requireValue(typeof corePersona === 'string' && corePersona.length > 0, 'QQ_SOURCE_UNSUPPORTED', 'Core persona string is required.');
  requireValue(nativeCodec && typeof nativeCodec.createSystemMessage === 'function' && typeof nativeCodec.createUserMessage === 'function' && typeof nativeCodec.createAssistantMessage === 'function' && typeof nativeCodec.createToolResultMessage === 'function', 'QQ_SOURCE_UNSUPPORTED', 'Native codecs are required.');
  requireValue(typeof validateOwnedToolContext === 'function', 'QQ_SOURCE_UNSUPPORTED', 'validateOwnedToolContext witness check is required.');

  safeText(corePersona);

  const states = new Map();
  let closed = false;
  let lastFailure = null;
  const metrics = { admittedInputs: 0, committedOutputs: 0, activeJobs: 0, retiredJobs: 0, sentLeases: 0 };

  async function checkLiveIdentity(expectedSnapshot, key) {
    const role = getCharacter();
    requireValue(role && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(role.id) && Number.isSafeInteger(role.epoch) && role.epoch > 0, 'CHARACTER_CONTEXT_REQUIRED', 'Valid synchronous character context is required.');
    if (expectedSnapshot) {
      requireValue(role.id === expectedSnapshot.role.id && role.epoch === expectedSnapshot.role.epoch, 'CHARACTER_EPOCH_STALE', 'The character epoch changed during the QQ session.');
    }

    const live = await getQQIdentity();
    requireValue(live && live.ok === true && live.verified === true, 'MEMORY_QQ_IDENTITY_UNVERIFIED', 'QQ live identity is unverified or offline.');
    requireValue(/^[1-9][0-9]{0,19}$/.test(String(live.accountId)), 'MEMORY_QQ_IDENTITY_INVALID', 'Invalid QQ account ID.');

    const match = /^(group|private):([1-9][0-9]{0,19})$/.exec(key || '');
    requireValue(match, 'MEMORY_AUDIENCE_DENIED', 'Invalid QQ conversation key format.');
    const type = match[1], id = match[2];
    const allowed = type === 'group' ? (live.allowedGroups || []).map(String).includes(id) : (live.allowedPrivates || []).map(String).includes(id);
    requireValue(allowed, 'MEMORY_AUDIENCE_DENIED', 'This QQ conversation is not on the live allowlist.');

    const routeCheck = deriveMemoryProviderRouteId(live.route);
    requireValue(routeCheck.ok === true, 'MEMORY_PROVIDER_ROUTE_REQUIRED', 'No valid provider route configured for QQ.');

    if (expectedSnapshot) {
      requireValue(String(live.accountId) === String(expectedSnapshot.accountId), 'MEMORY_IDENTITY_CHANGED', 'Active QQ account switched during request.');
      requireValue(live.route.provider === expectedSnapshot.route.provider && live.route.model === expectedSnapshot.route.model, 'MEMORY_PROVIDER_ROUTE_MISMATCH', 'Active provider route changed during request.');
    }

    return { role, accountId: String(live.accountId), allowedGroups: [...(live.allowedGroups || [])], allowedPrivates: [...(live.allowedPrivates || [])], route: { ...live.route }, conversationType: type, conversationId: id };
  }

  const api = {
    async prepareReplyPrompt({ key, job, signal } = {}) {
      requireValue(!closed, 'QQ_SOURCE_RUNTIME_CLOSED', 'QQ source runtime is closed.');
      requireValue(key && typeof key === 'string', 'QQ_SOURCE_INVALID', 'Conversation key is required.');
      requireValue(job && typeof job.jobId === 'string' && typeof job.sessionId === 'string' && typeof job.requestId === 'string', 'QQ_SOURCE_INVALID', 'Valid job structure is required.');

      const identitySnapshot = await checkLiveIdentity(null, key);
      const exported = await bridge.exportNativeSources(key);
      requireValue(exported && exported.ok === true && exported.packet, exported?.code || 'MEMORY_SOURCE_EXPORT_FAILED', exported?.error || 'Failed to export QQ native sources.');
      const exportedPacket = exported.packet;
      requireValue(exportedPacket.character.id === identitySnapshot.role.id && exportedPacket.character.epoch === identitySnapshot.role.epoch, 'CHARACTER_EPOCH_STALE', 'Exported source character epoch mismatch.');

      const built = buildQQV2SourcePacket(exportedPacket);
      requireValue(built && built.ok === true && Array.isArray(built.content) && built.content[0]?.text, built?.code || 'QQ_SOURCE_PACKET_UNPROVEN', 'Failed to build validated QQ source packet.');
      const packetText = built.content[0].text;
      const sourceRefs = built.eventRefs || [];

      const conversationKey = `qq:${identitySnapshot.accountId}:${identitySnapshot.conversationType}:${identitySnapshot.conversationId}`;
      requireValue(built.conversationKey === conversationKey, 'MEMORY_SOURCE_CONTEXT_MISMATCH', 'Built source packet conversationKey mismatch.');

      const firstSourceFacts = exportedPacket.sources[0]?.sourceFacts || {
        loginAccountId: identitySnapshot.accountId,
        actorAccountId: identitySnapshot.accountId,
        conversationType: identitySnapshot.conversationType,
        conversationId: identitySnapshot.conversationId,
        objectId: job.requestId,
        direction: 'inbound',
      };

      const captured = await adapter.capture({ conversationKey, sourceFacts: firstSourceFacts });
      requireValue(captured && captured.ok === true && typeof captured.handle === 'string', captured?.code || 'MEMORY_CAPTURE_FAILED', captured?.error || 'Host refused to capture QQ context.');
      const handle = captured.handle;

      try {
        const bound = await adapter.bindActualInput(handle, sourceRefs);
        requireValue(bound && bound.ok === true, bound?.code || 'MEMORY_MANIFEST_BINDING_FAILED', 'Failed to bind source references.');

        const issued = await adapter.prepare(handle, packetText.slice(0, 6000), { memory: 1800, total: 6000 });
        requireValue(issued && issued.ok === true && typeof issued.preparedHandle === 'string' && issued.prepared && typeof issued.prepared.text === 'string' && Array.isArray(issued.prepared.inputManifest), issued?.code || 'MEMORY_PREPARATION_FAILED', 'Memory preparation failed.');
        const verified = adapter.verifyPrepared(handle, issued.preparedHandle, issued.prepared);
        requireValue(verified && verified.ok === true, verified?.code || 'MEMORY_PREPARED_UNTRUSTED', 'Prepared memory verification failed.');

        const recallText = redactContent(issued.prepared.text, { scope: 'qq' });
        const content = [
          { type: 'text', text: safeText(packetText) },
          ...(recallText ? [{ type: 'text', text: safeText('Authorized recalled memory:\n' + recallText) }] : []),
        ];

        const ledger = createQQV2NativeLedger({
          nativeCodec,
          corePersona,
          toolSpecs,
          validateOwnedToolContext,
        });

        const seedResult = ledger.seed({
          sessionId: job.sessionId,
          requestId: job.requestId,
          content,
        });
        requireValue(seedResult && seedResult.ok === true, seedResult?.code || 'QQ_NATIVE_LEDGER_INVALID', 'Failed to seed Native ledger.');

        const state = {
          job: { ...job },
          key,
          handle,
          preparedHandle: issued.preparedHandle,
          preparation: { handle: issued.preparedHandle, prepared: structuredClone(issued.prepared) },
          liveIdentitySnapshot: identitySnapshot,
          ledger,
          content,
          admitted: false,
          sent: false,
        };

        states.set(job.jobId, state);
        metrics.activeJobs = states.size;

        return {
          ok: true,
          handle,
          preparedHandle: issued.preparedHandle,
          content,
          sessionId: job.sessionId,
          requestId: job.requestId,
        };
      } catch (err) {
        await adapter.release(handle).catch(() => {});
        throw err;
      }
    },

    async prepareInput({ job, options, request, signal, preparedConfig } = {}) {
      requireValue(!closed, 'QQ_SOURCE_RUNTIME_CLOSED', 'QQ source runtime is closed.');
      const jobId = job?.jobId || request?.jobId || request?.sessionId;
      requireValue(jobId && states.has(jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(jobId);

      await checkLiveIdentity(state.liveIdentitySnapshot, state.key);

      state.preparedConfig = preparedConfig || Object.freeze({
        provider: state.liveIdentitySnapshot.route.provider,
        model: state.liveIdentitySnapshot.route.model,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });

      const ledgerResult = state.ledger.validateInput({ options, request, preparedConfig: state.preparedConfig });
      requireValue(ledgerResult && ledgerResult.ok === true, ledgerResult?.code || 'MEMORY_NATIVE_INPUT_UNPROVEN', ledgerResult?.error || 'Native ledger rejected input.');

      const prepVerified = state.ledger.validateOwnedToolContext ? adapter.verifyPrepared(state.handle, state.preparedHandle, state.preparation.prepared) : { ok: true };
      requireValue(prepVerified && prepVerified.ok === true, prepVerified?.code || 'MEMORY_PREPARED_UNTRUSTED', 'Prepared verification failed during input validation.');

      const validated = await adapter.validate(state.handle, state.preparedHandle);
      requireValue(validated && validated.ok === true, validated?.code || 'MEMORY_VALIDATION_FAILED', validated?.error || 'Core context validation failed.');

      state.admitted = true;
      metrics.admittedInputs++;
      return { ok: true, handle: state.handle };
    },

    async validate({ job, request, handle, preparedHandle, signal } = {}) {
      requireValue(!closed, 'QQ_SOURCE_RUNTIME_CLOSED', 'QQ source runtime is closed.');
      const jobId = job?.jobId || request?.jobId || request?.sessionId;
      requireValue(jobId && states.has(jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(jobId);
      const targetHandle = handle || state.handle;
      const targetPreparedHandle = preparedHandle || state.preparedHandle;
      return adapter.validate(targetHandle, targetPreparedHandle);
    },

    async admitNetwork({ job, request, dispatch, signal } = {}) {
      requireValue(!closed, 'QQ_SOURCE_RUNTIME_CLOSED', 'QQ source runtime is closed.');
      const jobId = job?.jobId || request?.jobId || request?.sessionId;
      requireValue(jobId && states.has(jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(jobId);

      await checkLiveIdentity(state.liveIdentitySnapshot, state.key);
      requireValue(typeof dispatch === 'function', 'MEMORY_NETWORK_DISPATCH_REQUIRED', 'Dispatch function is required.');

      return adapter.withNetworkAdmission(state.handle, async () => {
        await checkLiveIdentity(state.liveIdentitySnapshot, state.key);
        return dispatch();
      }, { signal });
    },

    async captureModelOutput({ job, options, request, dispatchId, phase, chunk, signal, preparedConfig } = {}) {
      const jobId = job?.jobId || request?.jobId || request?.sessionId;
      requireValue(jobId && states.has(jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(jobId);

      const resolvedConfig = preparedConfig || state.preparedConfig || Object.freeze({
        provider: state.liveIdentitySnapshot.route.provider,
        model: state.liveIdentitySnapshot.route.model,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });

      const result = state.ledger.captureModelOutput({
        options,
        request,
        preparedConfig: resolvedConfig,
        dispatchId,
        phase,
        chunk,
        signal,
      });

      if (phase === 'complete' && result.ok) {
        metrics.committedOutputs++;
      }
      return result;
    },

    async captureToolResult({ job, request, execution, content, isError = false } = {}) {
      const jobId = job?.jobId || request?.jobId || request?.sessionId;
      requireValue(jobId && states.has(jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(jobId);
      requireValue(execution && typeof execution.callId === 'string', 'QQ_NATIVE_EXECUTION_UNPROVEN', 'Valid tool execution context is required.');

      const witness = validateOwnedToolContext(execution);
      requireValue(witness && witness.ok === true, 'QQ_NATIVE_OWNER_UNPROVEN', 'Tool execution context witness was refused.');

      return state.ledger.captureToolResult({ execution, content, isError });
    },

    async prepareSend({ job, key, loginAccountId } = {}) {
      requireValue(!closed, 'QQ_SOURCE_RUNTIME_CLOSED', 'QQ source runtime is closed.');
      requireValue(job?.jobId && states.has(job.jobId), 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job.');
      const state = states.get(job.jobId);
      requireValue(key === state.key, 'MEMORY_AUDIENCE_DENIED', 'Send conversation key must match active session.');

      await checkLiveIdentity(state.liveIdentitySnapshot, key);
      const authorized = await bridge.authorizeSend({ key, loginAccountId });
      requireValue(authorized && authorized.ok === true && authorized.lease, authorized?.code || 'MEMORY_SEND_UNAUTHORIZED', authorized?.error || 'Send authorization refused.');

      state.sendLease = authorized.lease;
      metrics.sentLeases++;
      return { ok: true, lease: authorized.lease };
    },

    async recordSent({ job, lease, text, messageId = null, deliveryState = 'delivered' } = {}) {
      const state = job?.jobId ? states.get(job.jobId) : Array.from(states.values()).find(s => s.sendLease === lease);
      requireValue(state, 'QQ_SOURCE_JOB_UNBOUND', 'No active state for job or lease.');
      requireValue(lease && lease === state.sendLease, 'MEMORY_SOURCE_LEASE_REQUIRED', 'Send lease mismatch or already consumed.');

      state.sendLease = null;
      const recorded = await bridge.recordSent(lease, { text, messageId, deliveryState });
      requireValue(recorded && recorded.ok === true, recorded?.code || 'MEMORY_RECORD_SENT_FAILED', 'Failed to record sent message.');
      state.sent = true;
      return { ok: true };
    },

    async retireJob({ job, reason } = {}) {
      const state = states.get(job?.jobId);
      if (!state) return { ok: true, retired: false };

      states.delete(job.jobId);
      metrics.activeJobs = states.size;
      metrics.retiredJobs++;

      if (state.handle) {
        await adapter.release(state.handle).catch(() => {});
      }
      if (state.ledger) {
        state.ledger.retire();
      }
      if (state.key) {
        await bridge.retire(state.key).catch(() => {});
      }

      return { ok: true, retired: true };
    },

    getStatus() {
      return Object.freeze({
        ok: !lastFailure && !closed,
        closed,
        activeJobs: states.size,
        admittedInputs: metrics.admittedInputs,
        committedOutputs: metrics.committedOutputs,
        retiredJobs: metrics.retiredJobs,
        sentLeases: metrics.sentLeases,
        ...(lastFailure ? { failure: lastFailure } : {}),
      });
    },

    async close() {
      closed = true;
      for (const state of states.values()) {
        if (state.handle) await adapter.release(state.handle).catch(() => {});
        if (state.ledger) state.ledger.retire();
        if (state.key) await bridge.retire(state.key).catch(() => {});
      }
      states.clear();
      metrics.activeJobs = 0;
      return { ok: true };
    },
  };

  // Structured fail-closed guard for external async API calls
  for (const method of ['prepareReplyPrompt', 'prepareInput', 'admitNetwork', 'captureModelOutput', 'captureToolResult', 'prepareSend', 'recordSent', 'retireJob']) {
    const original = api[method];
    api[method] = async function(...args) {
      try {
        return await original.apply(this, args);
      } catch (err) {
        lastFailure = {
          ok: false,
          code: err?.code || 'QQ_SOURCE_RUNTIME_ERROR',
          error: err?.message || 'QQ source runtime operation failed.',
          hint: err?.hint || 'Check QQ live identity and source validity; restore trusted context before retrying.',
        };
        return lastFailure;
      }
    };
  }

  return Object.freeze(api);
}
