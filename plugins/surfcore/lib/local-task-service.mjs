// 本机任务（QQ 电脑任务）的权威存储与状态机 —— Host 唯一写入者。
//
// 为什么是这里：`src/` 是桥接进程，`plugins/surfcore/lib/` 是 Host 插件（跑在 DSH 进程内，
// 能拿到 `ctx.storageDomain`）。契约要求 Task/Grant/投递全部由 Host 持有，桥接只发不写，
// 所以这个模块只被 Host 侧引用，导入它是唯一的写入入口。
//
// 持久化用 DSH 的 storageDomain 域表（串行写、写完才算数、unknown-state 隔离），
// 这里不自己造 JSON 文件：旧账本 `src/task-ledger.js` 的 tmp+rename 只是"尽力"，
// 拿不到"durable 之后才回执"的语义，两套会打架，所以新路径不复用它。
//
// 域规格故意不 import `@deepseek-ai/dsh-storage-domain`：插件没有 dependencies，
// 跨包解析会落到仓库 node_modules（不存在）。`open()` 只用到 spec 的
// name/version/tables[*].valueSchema.parse，所以手写一个 parse 即满足契约。

export const LOCAL_TASK_DOMAIN = Object.freeze({
  name: 'surfcore_local_task',
  version: 1,
  layout: 'single',
  tables: {
    tasks: { valueSchema: { parse: assertTaskRecord } },
  },
})

export const EXECUTION_STATES = Object.freeze([
  'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'needs_reconciliation',
])
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
// 进程崩溃时「还在跑」的状态集合：重启后只能标 needs_reconciliation。
const IN_FLIGHT = new Set(['queued', 'running', 'waiting'])
const DELIVERY_STATES = new Set(['pending', 'sending', 'delivered', 'uncertain', 'failed', 'suppressed'])

export const CONCURRENCY = 1
export const QUEUE_LIMIT = 20

function fail(code, error, hint) {
  return { ok: false, code, error, hint }
}

function bad(error, hint) {
  return new TypeError(`local-task: ${error}${hint ? ` — ${hint}` : ''}`)
}

function assertTaskRecord(task) {
  if (!task || typeof task !== 'object') throw bad('task record must be an object')
  if (typeof task.taskId !== 'string' || !task.taskId) throw bad('taskId must be a non-empty string')
  if (!EXECUTION_STATES.includes(task.executionStatus)) throw bad(`unknown executionStatus: ${task.executionStatus}`)
  if (!Array.isArray(task.commands) || !Array.isArray(task.deliveries)) throw bad('commands and deliveries must be arrays')
  for (const delivery of task.deliveries) {
    if (!DELIVERY_STATES.has(delivery.state)) throw bad(`unknown delivery state: ${delivery.state}`)
  }
  if (typeof task.controlEpoch !== 'number') throw bad('controlEpoch must be a number')
  return task
}

function fingerprint(text) {
  // 与来源键分开：同键同指纹=同一条命令，同键不同指纹=冲突。用长度+内容哈希，
  // 避免把用户原文塞进领域记录（原文另存 goal，便于原生会话与查询展示）。
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(String(text), 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${String(text).length}:${hash.toString(16)}`
}

export function sourceKeyOf({ botId, channel, conversationId, messageId }) {
  const missing = ['botId', 'channel', 'conversationId', 'messageId'].filter((k) => !arguments[0]?.[k])
  if (missing.length) throw bad(`source key is missing ${missing.join(', ')}`)
  return `${botId}|${channel}|${conversationId}|${messageId}`
}

/**
 * @param domain 已打开的 storageDomain 句柄（`domain.table('tasks')`）
 * @param now    注入时钟，测试用
 * @param newId  taskId 生成器
 */
export function createLocalTaskService({ domain, now = () => new Date().toISOString(), newId }) {
  if (!domain || typeof domain.table !== 'function') throw bad('a storageDomain handle is required')
  if (typeof newId !== 'function') throw bad('newId is required')
  const table = domain.table('tasks')
  let activeTaskId = null

  // 一次性把磁盘记录读进内存：域表读取是同步的，之后的判定都基于同一份快照，
  // 避免"查到一半状态变了"。任务量按契约是几十条级别，全量持有足够。
  const tasks = new Map()

  function loadAll() {
    // KvTable 的读接口是 get/entries/keys/size（同步、来自已校验的内存态）。
    for (const [key, value] of table.entries()) tasks.set(key, value)
    for (const task of tasks.values()) {
      if (task.executionStatus === 'running' || task.executionStatus === 'waiting') activeTaskId = task.taskId
    }
  }

  function persist(task) {
    // 写完才算成功：put 抛错（含 unknown-state 隔离）时把内存状态回滚，
    // 让调用方拿到失败而不是"看起来已接收"。
    const previous = tasks.get(task.taskId)
    tasks.set(task.taskId, task)
    try {
      table.put(task.taskId, task)
      return { ok: true }
    } catch (error) {
      if (previous) tasks.set(task.taskId, previous)
      else tasks.delete(task.taskId)
      return fail('TASK_STORE_UNAVAILABLE', `任务未能持久写入：${error?.message || error}`, '检查 DSH 存储域是否可用；本次操作未生效，请重试或联系主人查看 ~/.dsh/storages')
    }
  }

  function findBySourceKey(sourceKey) {
    for (const task of tasks.values()) if (task.sourceKey === sourceKey) return task
    return null
  }

  function terminal(task) {
    return TERMINAL.has(task.executionStatus)
  }

  function submitTask({ trustedActor, source, text, workspaceId, grantId = null, grantVersion = null }) {
    if (!trustedActor || typeof trustedActor.userId !== 'string' || !trustedActor.userId) {
      return fail('TASK_ACTOR_UNTRUSTED', '缺少可信发起人', '身份只能来自桥接的 OneBot 上下文；请检查主人 QQ 配置')
    }
    if (typeof text !== 'string' || !text.trim()) return fail('TASK_TEXT_EMPTY', '任务内容为空', '换一条带具体要求的消息')
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return fail('TASK_WORKSPACE_MISSING', '没有可用的工作区', '先在「设置 → SurfCore → 本机任务」指定一个工作区')
    }
    let sourceKey
    try {
      sourceKey = sourceKeyOf(source)
    } catch (error) {
      return fail('TASK_SOURCE_INVALID', error.message, '入站消息缺少机器人账号/渠道/会话/消息 ID，拒绝登记')
    }

    const existing = findBySourceKey(sourceKey)
    const print = fingerprint(text)
    if (existing) {
      if (existing.textFingerprint === print) return { ok: true, duplicate: true, task: existing }
      return fail('TASK_SOURCE_CONFLICT', '同一消息 ID 携带了不同内容', '丢弃这条入站消息并记录异常，不执行')
    }

    const queued = [...tasks.values()].filter((t) => t.executionStatus === 'queued').length
    if (activeTaskId && queued >= QUEUE_LIMIT) {
      return fail('TASK_QUEUE_FULL', `队列已满（${QUEUE_LIMIT}）`, '等当前任务结束后再发，或先取消/查询排队任务')
    }

    const at = now()
    const task = {
      taskId: newId(),
      createdAt: at,
      updatedAt: at,
      trustedActor,
      sourceKey,
      textFingerprint: print,
      goal: text,
      workspaceId,
      grantId,
      grantVersion,
      dshSessionId: null,
      requestId: null,
      executionStatus: activeTaskId ? 'queued' : 'running',
      stopRequest: null,
      controlEpoch: 0,
      lastEventPosition: null,
      commands: [{ commandId: newId(), sourceKey, textHash: print, requestId: null, accepted: 'unknown', at }],
      deliveries: [],
      resultRefs: [],
      error: null,
    }
    if (!activeTaskId) activeTaskId = task.taskId
    const written = persist(task)
    // 契约：持久成功之后才能回"已接收"。persist 失败时上面已回滚，这里直接返回失败。
    return written.ok ? { ok: true, task } : written
  }

  function queryTask({ taskId } = {}) {
    if (taskId) {
      const task = tasks.get(taskId)
      return task ? { ok: true, task } : fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「任务列表」确认任务号')
    }
    return {
      ok: true,
      activeTaskId,
      tasks: [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    }
  }

  /**
   * 重启对账：把「进程崩溃时还在跑」的任务标成 needs_reconciliation，**不重放**任何写入。
   * 契约要求：重启后既不能假装它还在跑，也不能自动重发 prompt（会重复落文件）。
   */
  function reconcileOnBoot({ reason = 'host-restarted', at = now() } = {}) {
    const touched = []
    for (const task of [...tasks.values()]) {
      if (!IN_FLIGHT.has(task.executionStatus)) continue
      const next = { ...task, executionStatus: 'needs_reconciliation', reconciledAt: at, reconcileReason: reason, updatedAt: at }
      if (!persist(next).ok) continue
      // 席位要立刻让出来：复核不等于在跑，否则一条崩溃任务会永久占住并发 1。
      if (activeTaskId === task.taskId) activeTaskId = null
      touched.push({ taskId: task.taskId, from: task.executionStatus })
    }
    return { ok: true, reconciled: touched }
  }

  /** 用户可读的一行状态（QQ 回执与设置页共用，避免两处措辞漂移）。 */
  function describeTask(task) {
    if (!task) return null
    const label = {
      queued: '排队中', running: '执行中', waiting: '等待确认', succeeded: '已完成',
      failed: '失败', cancelled: '已取消', needs_reconciliation: '需要复核',
    }[task.executionStatus] ?? task.executionStatus
    const lines = [`任务 ${task.taskId}：${label}`]
    if (task.goal) lines.push(`目标：${task.goal}`)
    if (task.executionStatus === 'needs_reconciliation') lines.push('DSH 在任务执行中重启过，不知道文件写没写：先看工作区，再决定重发')
    if (task.executionStatus === 'failed' && task.error?.error) lines.push(`原因：${task.error.error}`)
    if (task.resultRefs?.length) lines.push(`产物：${task.resultRefs.join(', ')}`)
    return lines.join('\n')
  }

  function cancelTask({ actor, taskId, reason = 'owner' }) {
    const task = tasks.get(taskId)
    if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「任务列表」确认任务号')
    if (task.trustedActor?.userId !== actor?.userId) {
      return fail('TASK_ACTOR_FORBIDDEN', '只有任务的发起人可以取消', '请让发起人自己发取消，或由主人授权')
    }
    if (terminal(task)) return fail('TASK_CLOSED', `任务已是 ${task.executionStatus} 终态`, '查看来查看结果；要重做请新建任务')
    // 停止屏障先落地：迟到的完成事件不能把它清掉（清只能由 reconcile 显式做）。
    const next = {
      ...task,
      stopRequest: { at: now(), by: actor.userId, reason },
      controlEpoch: task.controlEpoch + 1,
      executionStatus: 'cancelled',
      updatedAt: now(),
    }
    if (activeTaskId === taskId) activeTaskId = null
    const written = persist(next)
    return written.ok ? { ok: true, task: next } : written
  }

  function requireRunning(taskId) {
    const task = tasks.get(taskId)
    if (!task) return { failure: fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「任务列表」确认任务号') }
    if (terminal(task)) return { failure: fail('TASK_CLOSED', `任务已是 ${task.executionStatus} 终态`, '原生会话可查看，但不能继续执行') }
    if (task.stopRequest) return { failure: fail('TASK_STOPPED', '任务已被请求停止', '等停止处理完，或新建任务') }
    return { task }
  }

  function attachSession({ taskId, sessionId, requestId }) {
    const { failure, task } = requireRunning(taskId)
    if (failure) return failure
    if (task.dshSessionId && task.dshSessionId !== sessionId) {
      return fail('TASK_SESSION_CONFLICT', '任务已绑定另一个 DSH 会话', '核对 session.create 的响应，不要盲目再建会话')
    }
    const next = { ...task, dshSessionId: sessionId, requestId, updatedAt: now() }
    const written = persist(next)
    return written.ok ? { ok: true, task: next } : written
  }

  /** 记录已投影到的事件位置（只前进不后退），用于重启后不重放同一批事件。 */
  function noteEvent({ taskId, seq }) {
    const task = tasks.get(taskId)
    if (!task) return fail("TASK_NOT_FOUND", `任务 ${taskId} 不存在`, "用「任务列表」确认任务号")
    if (typeof seq !== "number" || !Number.isFinite(seq)) return fail("TASK_EVENT_INVALID", "事件位置不是数字", "检查 session/event 的 seq 字段")
    if (task.lastEventPosition !== null && seq <= task.lastEventPosition) return { ok: true, task, ignored: "stale" }
    const next = { ...task, lastEventPosition: seq, updatedAt: now() }
    const written = persist(next)
    return written.ok ? { ok: true, task: next } : written
  }

  function recordDelivery({ taskId, delivery }) {
    const task = tasks.get(taskId)
    if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「任务列表」确认任务号')
    const next = { ...task, deliveries: [...task.deliveries, delivery], updatedAt: now() }
    const written = persist(next)
    return written.ok ? { ok: true, task: next } : written
  }

  function finish({ taskId, status, resultRefs = [], error = null }) {
    const task = tasks.get(taskId)
    if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「任务列表」确认任务号')
    // 迟到完成不得抹掉停止意图：已 cancel 的任务保持 cancelled。
    if (task.stopRequest && task.executionStatus === 'cancelled') {
      return { ok: true, task, ignored: 'stop-request', lateStatus: status }
    }
    if (terminal(task)) return { ok: true, task, ignored: 'terminal' }
    const next = { ...task, executionStatus: status, resultRefs, error, updatedAt: now() }
    if (activeTaskId === taskId) activeTaskId = null
    const written = persist(next)
    return written.ok ? { ok: true, task: next } : written
  }

  loadAll()
  return {
    spec: LOCAL_TASK_DOMAIN,
    submitTask,
    queryTask,
    cancelTask,
    attachSession,
    recordDelivery,
    noteEvent,
    reconcileOnBoot,
    describeTask,
    finish,
    requireRunning,
    // 仅供测试/调试观察，不对外暴露写入口
    _snapshot: () => ({ activeTaskId, tasks: new Map(tasks) }),
  }
}
