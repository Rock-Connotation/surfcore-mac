import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { localDayKey, normalizeUsage } from '../../../src/token-budget.js';
import { syncBudgetFiles } from './token-budget-sync.mjs';

const categories = ['qq', 'bili', 'other'];
const buckets = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const states = ['reserved', 'admitted', 'usage_unknown', 'settled', 'cancelled'];
const clone = (v) => JSON.parse(JSON.stringify(v));
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, stable(v[key])])) : v;
const digest = (v) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const failure = (code, error, hint = 'Query the original request receipt; do not send or retry a model call.') => ({ ok: false, code, error, hint });
const owners = new Set();
process.once('exit', () => { for (const owner of owners) owner.close(); });

// No time-based stealing: an orphan lock requires explicit operator recovery after proving its owner exited.
export function acquireBudgetOwnership(dir) {
  const lock = path.join(dir, 'token-budget-owner.lock');
  const token = randomUUID();
  let issue = null;
  let owned = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(lock, 'wx', 0o600);
    owned = true;
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, installationRoot: fs.realpathSync(dir), startedAt: Date.now() - process.uptime() * 1000 })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch {
    issue = failure('BUDGET_OWNER_UNAVAILABLE', 'The installation budget writer could not acquire exclusive ownership.',
      'Stop the competing owner. A trusted Host can call recoverBudgetOwnership({dir,token}) only after proving the recorded owner has exited, then reopen the service.');
  }
  const owner = {
    issue: () => {
      if (!issue) {
        try {
          if (JSON.parse(fs.readFileSync(lock, 'utf8')).token !== token) throw new Error('owner changed');
        } catch { issue = failure('BUDGET_OWNER_LOST', 'Exclusive installation ownership was lost.', 'Stop this Host and inspect the installation owner before reopening the budget.'); }
      }
      return issue;
    },
    close() {
      if (owned) {
        try {
          const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
          if (current.token === token) fs.unlinkSync(lock);
        } catch { /* An uncertain lock stays closed to new writers. */ }
        owned = false;
      }
      owners.delete(owner);
      issue = failure('BUDGET_CLOSED', 'The budget service has been disposed.', 'Use the current Host budget service.');
    },
  };
  if (owned) owners.add(owner);
  return owner;
}

/** Host-only recovery: requires the exact orphan token and installation root; living/reused PIDs are refused. */
export function recoverBudgetOwnership({ dir, token }) {
  const lock = path.join(dir, 'token-budget-owner.lock');
  const guard = path.join(dir, 'token-budget-recovery.lock');
  let fd;
  try {
    fd = fs.openSync(guard, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(fd);
    const original = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (original.token !== token || original.installationRoot !== fs.realpathSync(dir)
      || !Number.isSafeInteger(original.pid) || original.pid <= 0 || !Number.isFinite(original.startedAt)) {
      return failure('BUDGET_RECOVERY_IDENTITY', 'The orphan token or installation identity does not match.', 'Inspect the installation lock through trusted Host management before recovery.');
    }
    try {
      process.kill(original.pid, 0);
      return failure('BUDGET_OWNER_ALIVE', 'The recorded PID is still alive or has been reused.', 'Stop that process and prove its exit before recovery.');
    } catch (error) {
      if (error.code !== 'ESRCH') return failure('BUDGET_OWNER_UNCERTAIN', 'The owner process exit could not be proved.', 'Resolve the owner identity through trusted Host management.');
    }
    // All recoverers share this exclusive guard; a dead owner cannot release or replace its lock.
    if (JSON.parse(fs.readFileSync(lock, 'utf8')).token !== token) return failure('BUDGET_RECOVERY_IDENTITY', 'The owner changed during recovery.');
    const orphan = `${lock}.${token}.orphan`;
    fs.renameSync(lock, orphan);
    syncBudgetFiles([orphan], dir);
    return { ok: true, recovered: true };
  } catch {
    return failure('BUDGET_RECOVERY_FAILED', 'Exclusive orphan recovery could not complete.', 'Inspect the preserved lock and recovery guard before restarting; never remove a live owner lock.');
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(guard); } catch {} }
  }
}

/**
 * Host-only capability; callers must already have processing authorization.
 * reserve -> admit (only send:true authorizes ONE send) -> settle/reconcile.
 * New callers must NOT also recordExternalUsage. Direct observations carry budgetRequestId;
 * dedicated native-agent sessions are excluded only after canonical native admission.
 * priceSnapshot: { reliable:true, currency:'CNY', version, rates:{ <usage bucket>: CNY/million } }.
 * Missing/unreliable price uses estimated tokens + client calls; a configured monetary cap rejects it.
 * Cancellation: reconcile(id,{cancelled:true}) only before admission.
 * Unknown: settle(id,{usageUnknown:true}); no retry/refund after admission, including across midnight.
 * Known result: {actualTokens, actualCostCny?} or {usage:{<usage buckets>}}.
 */
export function createModelCallAdmission({ initial, owner, now, getLimits, legacyUsage, persist }) {
  let ledger = initial === undefined ? { version: 1, requests: {} } : initial;
  let fault = null;
  if (ledger?.version !== 1 || !ledger.requests || typeof ledger.requests !== 'object' || Array.isArray(ledger.requests)) {
    fault = failure('BUDGET_LEDGER_INVALID', 'The canonical request ledger is invalid.', 'Restore a verified budget snapshot before admitting calls.');
    ledger = { version: 1, requests: {} };
  }
  for (const [id, entry] of Object.entries(ledger.requests)) {
    try {
      const normalized = normalizeRequest({ ...entry, quotaDay: entry.requestedQuotaDay });
      const priced = normalized.priceSnapshot?.reliable === true;
      const expectedCost = priced ? entry.estimatedTokens * Math.max(...buckets.map((key) => normalized.priceSnapshot.rates[key])) / 1_000_000 : null;
      if (id !== entry.requestId || !states.includes(entry.state) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.quotaDay ?? '')
        || digest(normalized) !== entry.digest || entry.reservedCostCny !== expectedCost
        || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)
        || (['admitted', 'usage_unknown', 'settled'].includes(entry.state) && !Number.isFinite(entry.admittedAt))
        || (['reserved', 'cancelled'].includes(entry.state) && entry.admittedAt != null)
        || (entry.state === 'settled' && (!Number.isSafeInteger(entry.actualTokens) || entry.actualTokens < 0
          || (priced ? !Number.isFinite(entry.actualCostCny) || entry.actualCostCny < 0 : entry.actualCostCny !== null)
          || entry.resultDigest !== digest({ state: 'settled', actualTokens: entry.actualTokens, actualCostCny: entry.actualCostCny })
          || entry.overrun !== (entry.actualTokens > entry.estimatedTokens || (priced && entry.actualCostCny > expectedCost))))
        || (entry.state === 'cancelled' && entry.resultDigest !== digest({ state: 'cancelled' }))) throw new Error('invalid receipt');
    } catch {
      fault = failure('BUDGET_LEDGER_INVALID', 'A canonical model-call receipt is invalid.', 'Restore a verified budget snapshot before admitting calls.');
    }
  }
  const problem = () => owner.issue() ?? fault;
  function receipt(entry, extra = {}) { return { ok: true, receipt: clone(entry), send: false, ...extra }; }
  function save(next, entry, extra) {
    ledger = next;
    if (!persist()) {
      fault = failure('BUDGET_COMMIT_UNKNOWN', 'The budget transition could not be durably acknowledged.',
        'Do not send. Restart the sole owner and query this requestId; an admitted receipt must never be resent.');
      return { ...fault, requestId: entry.requestId, state: entry.state };
    }
    return receipt(entry, extra);
  }
  function usage(day = localDayKey(now()), source = ledger) {
    const out = normalizeUsage(null);
    const held = normalizeUsage(null);
    const known = normalizeUsage(null);
    let unknown = 0;
    let overrun = false;
    const unpriced = new Set();
    const memory = { calls: 0, tokens: 0, cost: 0, estimated: true, overrun: false, unknown: 0 };
    if (fault?.code === 'BUDGET_LEDGER_INVALID') return { usage: out, held, known, unknown, memory, overrun, unpriced: [] };
    for (const entry of Object.values(source.requests)) {
      if (entry.state === 'cancelled') continue;
      const pending = entry.state !== 'settled';
      // Old-day unknowns remain conservative holds today; actual usage stays in its original quota day.
      if (entry.quotaDay !== day && !pending) continue;
      overrun ||= Boolean(entry.overrun);
      if (!entry.priceSnapshot?.reliable) unpriced.add(entry.category);
      const tokens = pending ? entry.estimatedTokens : entry.actualTokens;
      const cost = pending ? entry.reservedCostCny : entry.actualCostCny;
      out[entry.category].tokens += tokens;
      out[entry.category].cost += cost ?? 0;
      const component = pending ? held : known;
      component[entry.category].tokens += tokens;
      component[entry.category].cost += cost ?? 0;
      if (entry.state === 'usage_unknown' || entry.state === 'admitted') unknown++;
      if (entry.purpose !== 'conversation') {
        memory.calls++;
        memory.tokens += entry.estimatedTokens;
        memory.cost += cost ?? 0;
        memory.overrun ||= Boolean(entry.overrun);
        if (entry.state === 'usage_unknown' || entry.state === 'admitted') memory.unknown++;
      }
    }
    return { usage: normalizeUsage(out), held: normalizeUsage(held), known: normalizeUsage(known), unknown, memory, overrun, unpriced: [...unpriced] };
  }
  function gate(entry, source = ledger) {
    const tally = usage(localDayKey(now()), source);
    const current = legacyUsage();
    const limits = getLimits();
    const combined = normalizeUsage(Object.fromEntries(categories.map((cat) => [cat, {
      tokens: current[cat].tokens + tally.usage[cat].tokens,
      cost: current[cat].cost + tally.usage[cat].cost,
    }])));
    if (tally.overrun) return failure('BUDGET_ACTUAL_EXCEEDED', 'Actual usage exceeded a reservation; further calls are paused.', 'Review the overrun and retain the full recorded charge; do not retry with another requestId.');
    for (const scope of [entry.category, 'total']) {
      if (limits[scope].cny && (!entry.priceSnapshot?.reliable || (scope === 'total' ? tally.unpriced.length : tally.unpriced.includes(scope)))) return failure('BUDGET_PRICE_REQUIRED', 'A reliable price snapshot is required by the configured monetary limit.', 'Provide verified route prices or explicitly configure a token/call budget through Host settings.');
      if ((limits[scope].tokens && combined[scope].tokens > limits[scope].tokens)
        || (limits[scope].cny && combined[scope].cost > limits[scope].cny)) return failure('BUDGET_LIMIT', `The ${scope} shared budget has no room for this reservation.`, 'Wait for budget availability or review the configured limit; keep source events queued.');
    }
    if (entry.purpose !== 'conversation') {
      if (tally.memory.overrun || tally.memory.calls > 6 || tally.memory.tokens > 30_000
        || (entry.priceSnapshot?.reliable && tally.memory.cost > 1)) return failure('BUDGET_MEMORY_LIMIT', 'The installation-wide organize/expand budget is exhausted.', 'Keep the job queued; reconcile unknown usage before starting another extra call.');
      if (tally.memory.unknown) return failure('BUDGET_USAGE_UNKNOWN', 'An extra model call is admitted or awaiting usage reconciliation.', 'Settle or explicitly reconcile that request before admitting another extra call.');
    }
    return null;
  }
  function normalizeRequest(input) {
    if (!input || typeof input !== 'object') throw new Error('request must be an object');
    const text = (key) => {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 512) throw new Error(`${key} is required (1–512 characters)`);
      return input[key];
    };
    const entry = {
      requestId: text('requestId'), category: text('category'), purpose: text('purpose'), jobId: text('jobId'),
      role: text('role'), epoch: input.epoch, providerRouteId: text('providerRouteId'), model: text('model'),
      estimatedTokens: input.estimatedTokens, requestedQuotaDay: input.quotaDay ?? null,
      sessionId: input.sessionId ?? null, priceSnapshot: input.priceSnapshot == null ? null : clone(input.priceSnapshot),
    };
    if (!categories.includes(entry.category) || !['conversation', 'organize', 'expand'].includes(entry.purpose)
      || !Number.isSafeInteger(entry.epoch) || entry.epoch < 0 || !Number.isSafeInteger(entry.estimatedTokens) || entry.estimatedTokens <= 0
      || (entry.sessionId !== null && (typeof entry.sessionId !== 'string' || !entry.sessionId || entry.sessionId.length > 512))) throw new Error('invalid category, purpose, epoch, estimatedTokens or sessionId');
    if (input.inputDigest !== undefined) {
      if (typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputDigest)) throw new Error('inputDigest must be a SHA256 hex digest');
      entry.inputDigest = input.inputDigest;
    }
    if (input.nativeAgentSession !== undefined) {
      if (input.nativeAgentSession !== true || !entry.sessionId || !entry.inputDigest) throw new Error('native admission requires sessionId and inputDigest');
      entry.nativeAgentSession = true;
    }
    const p = entry.priceSnapshot;
    if (p !== null && (typeof p !== 'object' || Array.isArray(p) || typeof p.reliable !== 'boolean')) throw new Error('priceSnapshot requires an explicit reliable boolean');
    if (p?.reliable === true && (p.currency !== 'CNY' || typeof p.version !== 'string' || !p.version
      || !buckets.every((key) => typeof p.rates?.[key] === 'number' && Number.isFinite(p.rates[key]) && p.rates[key] >= 0))) throw new Error('reliable prices require CNY, version and four non-negative rates per million tokens');
    return entry;
  }
  function reserveModelCall(input) {
    if (problem()) return problem();
    let normalized;
    try { normalized = normalizeRequest(input); } catch (error) { return failure('BUDGET_REQUEST_INVALID', error.message, 'Supply the Host request metadata, a positive token estimate and verified pricing when required.'); }
    const hash = digest(normalized);
    const previous = Object.hasOwn(ledger.requests, normalized.requestId) ? ledger.requests[normalized.requestId] : null;
    if (previous) return previous.digest === hash ? receipt(previous, { reused: true }) : failure('BUDGET_REQUEST_CONFLICT', 'This requestId already belongs to a different request.', 'Query the original receipt; fix the conflicting caller metadata without resending the original call.');
    const day = localDayKey(now());
    if (normalized.requestedQuotaDay !== null && normalized.requestedQuotaDay !== day) return failure('BUDGET_DAY_INVALID', 'New reservations must use the current quota day.', 'Use the current Host budget day; existing requests retain their original quotaDay.');
    const rates = normalized.priceSnapshot?.reliable ? buckets.map((key) => normalized.priceSnapshot.rates[key]) : null;
    const entry = { ...normalized, digest: hash, quotaDay: day, state: 'reserved', createdAt: now(), updatedAt: now(),
      reservedCostCny: rates ? normalized.estimatedTokens * Math.max(...rates) / 1_000_000 : null };
    if (entry.reservedCostCny !== null && !Number.isFinite(entry.reservedCostCny)) return failure('BUDGET_REQUEST_INVALID', 'The price estimate exceeds numeric limits.');
    const next = clone(ledger);
    Object.defineProperty(next.requests, entry.requestId, { value: entry, enumerable: true, configurable: true, writable: true });
    const denied = gate(entry, next);
    return denied ?? save(next, entry);
  }
  function admitModelCall(id) {
    if (problem()) return problem();
    const entry = Object.hasOwn(ledger.requests, id) ? ledger.requests[id] : null;
    if (!entry) return failure('BUDGET_REQUEST_MISSING', 'No reservation exists for this requestId.');
    if (entry.state !== 'reserved') return receipt(entry, { reused: true });
    const denied = gate(entry);
    if (denied) return denied;
    const next = clone(ledger);
    const admitted = { ...entry, state: 'admitted', admittedAt: now(), updatedAt: now() };
    next.requests[id] = admitted;
    return save(next, admitted, { send: true });
  }
  function resultValue(entry, result) {
    if (result?.usageUnknown === true || result?.state === 'usage_unknown') return { state: 'usage_unknown' };
    let actualTokens = result?.actualTokens;
    let actualCostCny = result?.actualCostCny ?? null;
    if (result?.usage) {
      if (typeof result.usage !== 'object' || Array.isArray(result.usage) || !Object.keys(result.usage).length
        || Object.keys(result.usage).some((key) => !buckets.includes(key))) throw new Error('usage requires explicit canonical token buckets');
      if (!buckets.every((key) => Number.isSafeInteger(result.usage[key] ?? 0) && (result.usage[key] ?? 0) >= 0)) throw new Error('usage buckets must be non-negative safe integers');
      actualTokens = buckets.reduce((sum, key) => sum + (result.usage[key] ?? 0), 0);
      if (entry.priceSnapshot?.reliable) actualCostCny = buckets.reduce((sum, key) => sum + (result.usage[key] ?? 0) * entry.priceSnapshot.rates[key] / 1_000_000, 0);
    }
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || (actualCostCny !== null && (typeof actualCostCny !== 'number' || !Number.isFinite(actualCostCny) || actualCostCny < 0))) throw new Error('known settlement requires complete non-negative actual usage');
    if (!entry.priceSnapshot?.reliable) actualCostCny = null;
    if (entry.priceSnapshot?.reliable && actualCostCny === null) throw new Error('reliable-price settlement requires actualCostCny or complete usage buckets');
    return { state: 'settled', actualTokens, actualCostCny };
  }
  function finish(id, result, reconcile) {
    if (problem()) return problem();
    const entry = Object.hasOwn(ledger.requests, id) ? ledger.requests[id] : null;
    if (!entry) return failure('BUDGET_REQUEST_MISSING', 'No reservation exists for this requestId.');
    let value;
    try {
      if (result?.cancelled === true) {
        if (!reconcile || entry.admittedAt != null) return failure('BUDGET_REFUND_FORBIDDEN', 'An admitted call cannot be cancelled or refunded.', 'Record known usage or retain usage_unknown until reconciliation.');
        value = { state: 'cancelled' };
      } else {
        if (entry.admittedAt == null) return failure('BUDGET_NOT_ADMITTED', 'The request has not been admitted.');
        value = resultValue(entry, result);
      }
    } catch (error) { return failure('BUDGET_RESULT_INVALID', error.message, 'Supply complete actual usage, or mark usageUnknown:true and reconcile later.'); }
    const resultDigest = digest(value);
    if (entry.state === 'settled' || entry.state === 'cancelled') return entry.resultDigest === resultDigest
      ? receipt(entry, { reused: true }) : failure('BUDGET_RESULT_CONFLICT', 'This requestId already has a different final result.');
    if (entry.state === 'usage_unknown' && value.state === 'usage_unknown') return receipt(entry, { reused: true });
    if (entry.state === 'usage_unknown' && !reconcile) return failure('BUDGET_RECONCILE_REQUIRED', 'Unknown usage requires explicit reconciliation.');
    const next = clone(ledger);
    const finished = { ...entry, ...value, resultDigest, updatedAt: now(),
      overrun: value.state === 'settled' && (value.actualTokens > entry.estimatedTokens
        || (value.actualCostCny !== null && entry.reservedCostCny !== null && value.actualCostCny > entry.reservedCostCny)) };
    next.requests[id] = finished;
    return save(next, finished);
  }
  return {
    snapshot: () => clone(ledger), problem, usage,
    hasRequests: () => Object.keys(ledger.requests).length > 0,
    observes: (id) => typeof id === 'string' && Object.hasOwn(ledger.requests, id),
    managesAgentSession: (id) => typeof id === 'string' && Object.values(ledger.requests).some((entry) => entry.nativeAgentSession === true && entry.sessionId === id && entry.admittedAt != null),
    reserveModelCall: (input) => input?.nativeAgentSession !== undefined
      ? failure('BUDGET_NATIVE_AUTHORITY_REQUIRED', 'Native session ownership requires the trusted native admission API.') : reserveModelCall(input),
    reserveNativeAgentModelCall: (input) => reserveModelCall({ ...input, nativeAgentSession: true }),
    admitModelCall,
    settleModelCall: (id, result) => finish(id, result, false),
    reconcileModelCall: (id, result) => finish(id, result, true),
    getModelCallReceipt(id) {
      if (problem()) return problem();
      return Object.hasOwn(ledger.requests, id) ? receipt(ledger.requests[id]) : failure('BUDGET_REQUEST_MISSING', 'No reservation exists for this requestId.');
    },
  };
}
