// DSH 交互生命周期、取消回执与状态跟踪
// 负责处理与 DSH 的 question / approval 交互的取消、超时、回执判定和历史状态记录。

export function assertInteractionReceipt(receipt) {
  if (receipt?.result?.ok === false || receipt?.ok === false) {
    const error = new Error('DSH 明确拒绝回执');
    error.outcomeKnown = true;
    error.code = 'DSH_CANCEL_REJECTED';
    throw error;
  }
  if (receipt?.result?.ok !== true && receipt?.ok !== true) {
    const error = new Error('DSH 未确认回执');
    error.code = 'DSH_CANCEL_UNCONFIRMED';
    throw error;
  }
  return receipt;
}

export function createHistoricalInteractionRegistry({ maxSize = 2000 } = {}) {
  const map = new Map();

  function record(entry, status, code = '', error = '') {
    if (!entry) return;
    const identity = String(entry.eventId || entry.rpcId || entry.interactionId || '');
    if (!identity) return;
    if (map.size >= maxSize) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    const item = {
      identity,
      requestId: entry.requestId || '',
      rpcId: entry.rpcId || '',
      kind: entry.kind || '',
      status,
      code,
      error,
      at: Date.now()
    };
    map.set(identity, item);
    if (entry.requestId) map.set(entry.requestId, item);
  }

  function get(key) {
    if (!key) return undefined;
    return map.get(String(key));
  }

  function has(key) {
    if (!key) return false;
    return map.has(String(key));
  }

  function clear() {
    map.clear();
  }

  return {
    record,
    get,
    has,
    clear,
    get size() { return map.size; }
  };
}

export async function cancelPendingInteraction(entry, api, {
  timeoutMs = 5000,
  reason = 'cancel',
  historyRegistry = null,
  log = () => {}
} = {}) {
  if (!entry) {
    return { ok: false, status: 'invalid_entry', code: 'INVALID_ENTRY', error: '缺少 entry' };
  }
  if (entry.responding) {
    return { ok: false, status: 'in_flight', code: 'ALREADY_RESPONDING', error: '正在处理中' };
  }
  entry.responding = true;

  try {
    let respondPromise;
    if (entry.kind === 'approval') {
      respondPromise = api.respond({
        clientId: entry.clientId,
        eventId: entry.eventId,
        outcome: { kind: 'result', value: 'rejected' }
      });
    } else if (entry.kind === 'question') {
      respondPromise = api.respond({
        clientId: entry.clientId,
        eventId: entry.eventId,
        outcome: { kind: 'result', value: { answers: [] } }
      });
    } else {
      respondPromise = api.respond({
        clientId: entry.clientId,
        eventId: entry.eventId,
        outcome: { kind: 'result', value: 'canceled' }
      });
    }

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`取消挂起回执超时（>${timeoutMs}ms）`);
        err.code = 'CANCEL_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });

    let receipt;
    try {
      receipt = await Promise.race([respondPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    assertInteractionReceipt(receipt);
    log(`已取消挂起交互（确认回执）: ${entry.eventId ?? entry.rpcId}`);
    const result = { ok: true, status: 'confirmed', receipt };
    historyRegistry?.record(entry, 'confirmed');
    return result;
  } catch (error) {
    log('取消挂起请求回执失败:', error?.message ?? error);
    const isTimeout = error?.code === 'CANCEL_TIMEOUT' || /timeout|超时/i.test(error?.message ?? '');
    const code = error?.code || (error?.outcomeKnown ? 'DSH_CANCEL_REJECTED' : (isTimeout ? 'CANCEL_TIMEOUT' : 'DSH_CANCEL_UNKNOWN'));
    const status = error?.outcomeKnown ? 'rejected' : (isTimeout ? 'timeout' : 'unknown');
    const result = { ok: false, status, code, error: error?.message ?? String(error) };
    historyRegistry?.record(entry, status, code, error?.message ?? String(error));
    return result;
  }
}
