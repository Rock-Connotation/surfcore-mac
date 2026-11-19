// 任务额度（契约默认值）：窗口内任一上限达到就禁止继续派发并停掉当前会话。
//
// 为什么计数放在这里而不是账本里：额度是"运行期节流"，不是任务历史；
// 写进 storageDomain 只会让每次工具调用都变成一次落盘。重启后窗口自然重置，
// 而重启本身已经把在途任务标成 needs_reconciliation（不会继续烧额度）。
export const TASK_BUDGET = Object.freeze({
  windowMs: 30 * 60 * 1000, // 活跃 30 分钟
  modelRequests: 30,        // 30 次模型请求
  toolCalls: 120,           // 120 次工具调用
})

export function createTaskBudget({ now = Date.now, limits = TASK_BUDGET } = {}) {
  const counters = new Map()

  function slot(taskId) {
    let entry = counters.get(taskId)
    if (!entry) {
      entry = { startedAt: now(), modelRequests: 0, toolCalls: 0 }
      counters.set(taskId, entry)
    }
    return entry
  }

  function over(entry) {
    if (!entry) return null
    if (now() - entry.startedAt > limits.windowMs) return { reason: 'window', limit: limits.windowMs }
    if (entry.modelRequests > limits.modelRequests) return { reason: 'model-requests', limit: limits.modelRequests }
    if (entry.toolCalls > limits.toolCalls) return { reason: 'tool-calls', limit: limits.toolCalls }
    return null
  }

  function check(taskId) {
    const hit = over(counters.get(taskId))
    if (!hit) return { ok: true }
    const text = hit.reason === 'window'
      ? `任务已超过活跃时限（${Math.round(hit.limit / 60000)} 分钟）`
      : hit.reason === 'model-requests'
        ? `任务已用完模型请求额度（${hit.limit} 次）`
        : `任务已用完工具调用额度（${hit.limit} 次）`
    return {
      ok: false,
      code: 'TASK_BUDGET_EXCEEDED',
      error: text,
      hint: '结果可能已部分落盘：先看工作区再决定要不要重发同一目标',
      reason: hit.reason,
    }
  }

  return {
    begin(taskId) { counters.set(taskId, { startedAt: now(), modelRequests: 0, toolCalls: 0 }) },
    noteModelRequest(taskId) { slot(taskId).modelRequests += 1; return check(taskId) },
    noteToolCall(taskId) { slot(taskId).toolCalls += 1; return check(taskId) },
    check,
    forget(taskId) { counters.delete(taskId) },
    limits,
  }
}
