import { createModelCallAdmission } from './model-call-admission.mjs';

const issue = (code, error, hint = 'Restore the trusted Host session/job binding before starting another inference; do not replay this request.') => ({ ok: false, code, error, hint });
const reject = (result) => Object.assign(new Error(result.error), result);
const freeze = (value) => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const approved = (value) => value === true || value?.ok === true;

/** Host-only: callbacks own actual input provenance and the serialized dispatch gate. */
export function createAgentBudgetMiddleware({ tokenBudget, getCharacter, isAgentLoopRequest, getScope, isManagedSession } = {}) {
  async function* stream(options, next) {
    const sessionId = options?.sessionId;
    let membership, persisted;
    try {
      if (typeof isManagedSession !== 'function' || typeof tokenBudget?.isManagedAgentSession !== 'function') throw new Error();
      membership = isManagedSession(sessionId);
      persisted = tokenBudget.isManagedAgentSession(sessionId);
    } catch { throw reject(issue('MEMORY_BUDGET_NOT_READY', 'Trusted native session membership is unavailable.')); }
    if (typeof membership !== 'boolean' || typeof persisted !== 'boolean') {
      throw reject(issue('MEMORY_BUDGET_NOT_READY', 'Native session membership cannot be proved.', 'Resolve the budget owner/state or Host membership failure; leave this session blocked.'));
    }
    if (!membership && !persisted) { yield* next(options); return; }
    if (typeof isAgentLoopRequest !== 'function') throw reject(issue('MEMORY_BUDGET_NOT_READY', 'The actual Host agent-request brand checker is unavailable.'));
    let branded = false;
    try { branded = isAgentLoopRequest(options) === true; } catch {}
    if (!branded) throw reject(issue('MEMORY_AGENT_REQUEST_UNTRUSTED', 'This managed session request lacks the Host agent-loop brand.'));
    let scope, captured;
    try { const role = getCharacter(); captured = Object.freeze({ id: role.id, epoch: role.epoch }); scope = getScope?.(options); }
    catch { throw reject(issue('MEMORY_SESSION_UNBOUND', 'The trusted native session/job binding is unavailable.')); }
    if (!scope || typeof scope !== 'object' || typeof scope.then === 'function') throw reject(issue('MEMORY_SESSION_UNBOUND', 'This native session has no current trusted job scope.'));
    if (['prepareInput', 'validate', 'admitNetwork'].some((key) => typeof scope[key] !== 'function')) {
      throw reject(issue('MEMORY_BUDGET_NOT_READY', 'The input validation or serialized network capability is unavailable.'));
    }
    let request;
    try { request = freeze(structuredClone(scope.request)); } catch { throw reject(issue('MEMORY_AGENT_REQUEST_INVALID', 'Native request metadata must be a Host snapshot.')); }
    if (!captured || typeof captured.then === 'function' || !request || request.sessionId !== sessionId || typeof sessionId !== 'string' || !sessionId
      || request.role !== captured.id || request.epoch !== captured.epoch || options.model !== request.model
      || !/^[a-f0-9]{64}$/.test(request.inputDigest ?? '')) {
      throw reject(issue('MEMORY_AGENT_REQUEST_INVALID', 'The native request does not match its actual session, model, input digest or role.'));
    }
    const prepareInput = scope.prepareInput, validate = scope.validate, admitNetwork = scope.admitNetwork;
    const signal = options.signal && scope.signal ? AbortSignal.any([options.signal, scope.signal]) : options.signal ?? scope.signal;
    const guard = () => {
      const current = getCharacter();
      if (!current || current.id !== captured.id || current.epoch !== captured.epoch) throw reject(issue('MODEL_CHARACTER_STALE', 'The native job character changed.'));
      if (signal?.aborted) throw reject(issue('MODEL_CANCELLED', 'The native inference was cancelled.'));
    };
    const check = async (callback, phase, context) => {
      let result, thrown;
      try { result = await callback(Object.freeze({ ...context, options, request, phase })); } catch (error) { thrown = error; }
      guard();
      if (thrown || !approved(result)) return false;
      return true;
    };
    const nativeBudget = {
      ensureReady: () => tokenBudget.ensureReady(),
      reserveModelCall: (metadata) => tokenBudget.reserveNativeAgentModelCall(metadata),
      admitModelCall: (id) => tokenBudget.admitModelCall(id),
      settleModelCall: (id, result) => tokenBudget.settleModelCall(id, result),
      reconcileModelCall: (id, result) => tokenBudget.reconcileModelCall(id, result),
    };
    const runner = createModelCallAdmission({ tokenBudget: nativeBudget, getCharacter, authorize: async (context) => {
      guard();
      if (context.phase === 'reserve' && !await check(prepareInput, 'prepare', context)) return false;
      guard();
      return check(validate, context.phase, context);
    } });
    guard();
    return yield* runner.stream({ request, signal, invoke: () => next(options), admitNetwork: (dispatch) => admitNetwork(dispatch) });
  }
  return Object.freeze({ stream });
}
