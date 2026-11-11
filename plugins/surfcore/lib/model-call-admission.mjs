import { normalizeUsage } from '../../../src/model-prices.js';

const fail = (code, error, hint = 'Check the trusted Host context and the original budget receipt before starting new work.') => ({ ok: false, code, error, hint });
const usageKeys = ['cacheMiss', 'uncachedInputTokens', 'inputTokens', 'cacheHit', 'cacheReadTokens', 'cacheWrite', 'cacheWriteTokens', 'output', 'outputTokens'];
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonicalUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !usageKeys.some((key) => Object.hasOwn(value, key))
    || usageKeys.some((key) => Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key]) || value[key] < 0))) {
    throw fail('MODEL_USAGE_INVALID', 'The model returned invalid token usage.', 'Retain the original reservation and reconcile complete provider usage through the Host.');
  }
  const buckets = normalizeUsage(value);
  return { uncachedInputTokens: buckets.cacheMiss, outputTokens: buckets.output, cacheReadTokens: buckets.cacheHit, cacheWriteTokens: buckets.cacheWrite };
}

/** Host-only admission; run controls direct calls, stream additionally requires a serialized network gate. */
export function createModelCallAdmission({ tokenBudget, getCharacter, authorize = () => false, now = Date.now } = {}) {
  if (!tokenBudget || ['ensureReady', 'reserveModelCall', 'admitModelCall', 'settleModelCall', 'reconcileModelCall'].some((key) => typeof tokenBudget[key] !== 'function')
    || typeof getCharacter !== 'function' || typeof authorize !== 'function' || typeof now !== 'function') throw new TypeError('A trusted budget service, synchronous character reader and authorization callback are required.');

  function character() {
    const value = getCharacter();
    if (!value || typeof value.then === 'function' || typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
      throw fail('MODEL_CHARACTER_REQUIRED', 'The trusted current role and epoch are unavailable.');
    }
    return Object.freeze({ id: value.id, epoch: value.epoch });
  }

  async function run({ request, invoke, signal } = {}) {
    let captured, snapshot, requestId, receipt, value, usage, problem, originalError, budgetFailure;
    let reserved = false, admitted = false, invoked = false, acceptingUsage = false, invalidUsage = false;
    const guard = () => {
      const current = character();
      if (current.id !== captured.id || current.epoch !== captured.epoch) throw fail('MODEL_CHARACTER_STALE', 'The character changed while model work was in flight.', 'Discard this output; start separately authorized work under the current role and reconcile the original receipt.');
      if (signal?.aborted) throw fail('MODEL_CANCELLED', 'The controlled model call was cancelled.', 'Discard this output and inspect the original receipt; admitted calls are never automatically retried or refunded.');
    };
    const checked = async (call, fallback) => {
      let output, thrown;
      try { output = await call(); } catch (error) { thrown = error; }
      try { guard(); } catch (error) { if (thrown) originalError ??= thrown; throw error; }
      if (thrown) { originalError ??= thrown; throw fallback; }
      return output;
    };
    const authorized = async (phase) => {
      const result = await checked(() => authorize(Object.freeze({ phase, request: snapshot, character: captured, signal })),
        fail('MODEL_AUTHORIZATION_FAILED', 'The trusted model authorization check failed.', 'Revalidate privacy, role and processing permission through the Host before starting new work.'));
      guard();
      if (result !== true && result?.ok !== true) throw fail('MODEL_NOT_AUTHORIZED', 'The Host did not authorize this model call.', 'Obtain current processing permission through the Host; budget admission alone grants no permission.');
    };
    const budget = (result) => {
      if (result?.ok !== true) {
        budgetFailure = result?.ok === false && result.code && result.error && result.hint ? result : fail('MODEL_BUDGET_FAILED', 'The shared budget operation failed.');
        throw budgetFailure;
      }
      receipt = result.receipt ?? receipt;
      return result;
    };
    const onUsage = (chunkUsage) => {
      if (!acceptingUsage) throw fail('MODEL_USAGE_CLOSED', 'Usage arrived outside the controlled invocation.', 'Report usage synchronously while consuming the invocation stream.');
      try { usage = canonicalUsage(chunkUsage); }
      catch (error) { invalidUsage = true; throw error; }
    };
    try {
      captured = character();
      if (!request || typeof request !== 'object' || typeof invoke !== 'function') throw fail('MODEL_REQUEST_INVALID', 'A trusted request and invocation callback are required.');
      try { snapshot = freeze(structuredClone(request)); } catch { throw fail('MODEL_REQUEST_INVALID', 'The request metadata must be a cloneable immutable snapshot.'); }
      requestId = snapshot.requestId;
      if (snapshot.role !== captured.id || snapshot.epoch !== captured.epoch) throw fail('MODEL_CHARACTER_STALE', 'The request role and epoch do not match the current Host character.');
      guard();
      await checked(() => tokenBudget.ensureReady(), fail('MODEL_BUDGET_NOT_READY', 'The shared budget service could not become ready.'));
      guard();
      const reservation = budget(tokenBudget.reserveModelCall(snapshot));
      if (reservation.reused) return { ok: true, requestId, invoked: false, reused: true, receipt };
      reserved = true;
      await authorized('reserve');
      guard();
      const admission = budget(tokenBudget.admitModelCall(requestId));
      if (admission.send !== true) return { ok: true, requestId, invoked: false, reused: true, receipt };
      admitted = true;
      await authorized('dispatch');
      guard();
      invoked = true; acceptingUsage = true;
      try {
        value = await checked(() => invoke(Object.freeze({ requestId, onUsage, signal })),
          fail('MODEL_INVOKE_FAILED', 'The controlled model invocation failed.', 'Inspect the original receipt; known usage is charged and missing usage requires explicit reconciliation.'));
        guard();
      } catch (error) { problem = error; }
      finally { acceptingUsage = false; }
      try { await authorized('completion'); guard(); } catch (error) { problem ??= error; }
    } catch (error) { problem = error; if (error?.ok !== false) originalError ??= error; }
    finally {
      acceptingUsage = false;
      try {
        if (admitted) budget(tokenBudget.settleModelCall(requestId, usage && !invalidUsage ? { usage } : { usageUnknown: true }));
        else if (reserved && problem) budget(tokenBudget.reconcileModelCall(requestId, { cancelled: true }));
      } catch (error) { budgetFailure ??= fail('MODEL_BUDGET_FAILED', 'The shared budget settlement failed.'); originalError ??= error; }
    }
    const operationFailure = budgetFailure && problem && problem !== budgetFailure ? problem : null;
    if (budgetFailure) problem = budgetFailure;
    else if (invalidUsage) problem = fail('MODEL_USAGE_INVALID', 'The model returned invalid token usage.', 'Retain the original reservation and reconcile complete provider usage through the Host.');
    else if (admitted && !usage && !problem) problem = fail('MODEL_USAGE_UNKNOWN', 'The model completed without authoritative usage.', 'Query the provider and explicitly reconcile this requestId; do not resend or refund the admitted call.');
    if (problem) {
      const safe = problem?.ok === false && problem.code && problem.error && problem.hint ? problem : fail('MODEL_CALL_FAILED', 'The controlled model call could not complete.');
      const output = { ...safe, requestId, invoked, ...(receipt ? { receipt } : {}), ...(budgetFailure ? { budgetFailure } : {}), ...(operationFailure?.ok === false ? { operationFailure } : {}), completedAt: now() };
      // The original exception remains Host-only; enumerable diagnostics never contain provider text.
      if (originalError) Object.defineProperty(output, 'cause', { value: originalError });
      return output;
    }
    return { ok: true, requestId, invoked, receipt, value, completedAt: now() };
  }
  async function* stream({ request, invoke, signal, admitNetwork } = {}) {
    if (typeof admitNetwork !== 'function') throw fail('MODEL_NETWORK_UNSUPPORTED', 'The Host serialized network gate is unavailable.');
    const captured = character();
    let snapshot;
    try { snapshot = freeze(structuredClone(request)); } catch { throw fail('MODEL_REQUEST_INVALID', 'The stream request metadata must be cloneable.'); }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let item, wake, acknowledge, finished = false, outcome, deliveryFailure;
    const guard = () => {
      const current = character();
      if (current.id !== captured.id || current.epoch !== captured.epoch) throw fail('MODEL_CHARACTER_STALE', 'The character changed during the controlled stream.');
      if (combined.aborted) throw fail('MODEL_CANCELLED', 'The controlled stream was cancelled.');
    };
    const failure = (result) => {
      const error = Object.assign(new Error(result.error), result);
      if (result.cause) Object.defineProperty(error, 'cause', { value: result.cause });
      return error;
    };
    const task = run({ request: snapshot, signal: combined, invoke: async ({ requestId, onUsage }) => {
      let iterator, firstFlight, dispatches = 0, thrown, gateOpen = true;
      const remember = (step) => { if (step?.value?.type === 'usage') onUsage(step.value.usage); return step; };
      const dispatch = () => {
        if (!gateOpen) throw fail('MODEL_NETWORK_CLOSED', 'The serialized dispatch capability has expired.');
        if (++dispatches !== 1) throw fail('MODEL_NETWORK_REUSED', 'The network gate attempted more than one dispatch.');
        guard();
        const source = invoke(Object.freeze({ requestId, onUsage, signal: combined }));
        if (typeof source?.[Symbol.asyncIterator] !== 'function') throw fail('MODEL_STREAM_INVALID', 'The provider did not return an async stream.');
        iterator = source[Symbol.asyncIterator]();
        firstFlight = Promise.resolve(iterator.next()).then(remember);
        return firstFlight;
      };
      try {
        let permitted;
        try { permitted = await admitNetwork(dispatch); } finally { gateOpen = false; }
        if (dispatches !== 1) throw fail('MODEL_NETWORK_DENIED', 'The Host did not dispatch this inference.');
        let step = await firstFlight;
        guard();
        if (dispatches !== 1 || permitted !== step) throw fail('MODEL_NETWORK_DENIED', 'The Host network gate did not return the dispatched result.');
        while (!step.done) {
          guard();
          await new Promise((resolve) => { acknowledge = resolve; item = { chunk: step.value }; wake?.(); });
          guard();
          step = remember(await iterator.next());
          guard();
        }
      } catch (error) { thrown = error; throw error; }
      finally {
        gateOpen = false;
        if (firstFlight) { try { await firstFlight; } catch {} }
        try {
          if (iterator?.return) {
            let closed = remember(await iterator.return());
            while (closed && !closed.done) closed = remember(await iterator.next());
          }
        }
        catch (error) { if (!thrown) throw error; }
      }
    } }).then((result) => { outcome = result; finished = true; wake?.(); });
    try {
      while (true) {
        if (!item) { if (finished) break; await new Promise((resolve) => { wake = resolve; }); }
        if (!item) continue;
        const chunk = item.chunk; item = undefined;
        guard();
        let approved;
        try { approved = await authorize(Object.freeze({ phase: 'chunk', request: snapshot, character: captured, signal: combined })); }
        catch { throw fail('MODEL_AUTHORIZATION_FAILED', 'The trusted stream authorization check failed.'); }
        guard();
        if (approved !== true && approved?.ok !== true) throw fail('MODEL_NOT_AUTHORIZED', 'The Host revoked this stream before delivery.');
        yield chunk;
        guard(); acknowledge?.(); acknowledge = undefined;
      }
    } catch (error) { deliveryFailure = error; }
    finally {
      if (!finished) controller.abort();
      acknowledge?.();
      await task;
      if (outcome?.budgetFailure) {
        const result = { ...outcome, ...(deliveryFailure?.ok === false ? { operationFailure: deliveryFailure } : {}) };
        if (outcome.cause) Object.defineProperty(result, 'cause', { value: outcome.cause });
        throw failure(result);
      }
    }
    if (deliveryFailure) {
      const safe = deliveryFailure?.ok === false && deliveryFailure.code && deliveryFailure.error && deliveryFailure.hint ? deliveryFailure : fail('MODEL_STREAM_FAILED', 'The controlled stream could not deliver output.');
      const result = { ...safe, requestId: outcome.requestId, receipt: outcome.receipt, invoked: outcome.invoked };
      if (safe !== deliveryFailure) Object.defineProperty(result, 'cause', { value: deliveryFailure });
      throw failure(result);
    }
    if (outcome.ok !== true) throw failure(outcome);
    return outcome;
  }
  return Object.freeze({ run, stream });
}
