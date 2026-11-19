// 本机任务（QQ 电脑任务）的权威存储与状态机 —— Host 唯一写入者。
//
// 为什么是这里：`src/` 是桥接进程，`plugins/surfcore/lib/` 是 Host 插件（跑在 DSH 进程内，
// 能拿到 `ctx.storageDomain`）。契约要求 Task/Grant/投递全部由 Host 持有，桥接只发不写，
// 所以这个模块只被 Host 侧引用，导入它是唯一的写入入口。
//
// 持久化用 DSH 的 storageDomain 域表：真实 `table.put()` 返回 Promise，在后端落盘前不 resolve，
// 发生 `unknown-state` 时会隔离读写直到域关闭重开。因此本服务的所有写操作一律 `async`、
// 通过单写者链串行、等后端确认后才提交内存态与并发席位，并在 `unknown-state` 时进入隔离与核对。

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
export const TASK_MODES = Object.freeze(['files-only', 'desktop'])
export const TASK_ORIGINS = Object.freeze(['command', 'chat'])
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
// 进程崩溃时「还在跑」的状态集合：重启后只能标 needs_reconciliation。
const IN_FLIGHT = new Set(['queued', 'running', 'waiting'])
const DELIVERY_STATES = new Set(['pending', 'sending', 'delivered', 'uncertain', 'failed', 'suppressed'])

export const CONCURRENCY = 1
export const QUEUE_LIMIT = 20

function fail(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
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

function isUnknownStateError(error) {
  if (!error) return false
  if (error.code === 'unknown-state') return true
  const msg = String(error?.message ?? error ?? '')
  return msg.includes('unknown-state')
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

  let currentDomain = domain
  let table = currentDomain.table('tasks')
  let activeTaskId = null
  let quarantined = null
  let writeChain = Promise.resolve()

  // 按创建顺序保存任务，保证 FIFO 队列和重开后的一致排序。
  const tasks = new Map()

  function loadAll() {
    tasks.clear()
    activeTaskId = null
    const entries = [...table.entries()].sort(([, a], [, b]) => {
      const seqA = typeof a.queueSeq === 'number' ? a.queueSeq : Number.MAX_SAFE_INTEGER
      const seqB = typeof b.queueSeq === 'number' ? b.queueSeq : Number.MAX_SAFE_INTEGER
      if (seqA !== seqB) return seqA - seqB
      return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    })
    for (const [key, value] of entries) tasks.set(key, value)
    for (const task of tasks.values()) {
      if (task.executionStatus === 'running' || task.executionStatus === 'waiting') {
        activeTaskId = task.taskId
        break
      }
      if (task.executionStatus === 'needs_reconciliation' && task.reconcileReason === 'cancel-failed' && task.dshSessionId) {
        activeTaskId = task.taskId
        break
      }
    }
  }

  let nextQueueSeq = 0
  function initQueueSeq() {
    let max = 0
    for (const task of tasks.values()) {
      if (typeof task.queueSeq === 'number' && task.queueSeq > max) max = task.queueSeq
    }
    nextQueueSeq = max
  }

  function enqueueWrite(fn) {
    const run = writeChain.then(fn, fn)
    writeChain = run.then(() => {}, () => {})
    return run
  }

  function quarantineFailure() {
    return fail(
      'TASK_STORE_QUARANTINED',
      `任务存储域处于隔离核对状态（${quarantined?.reason ?? 'unknown-state'}）`,
      '禁止继续派发或修改任务；先关闭并重开存储域，再核对工作区与原生会话状态',
      { quarantined: true, quarantine: quarantined },
    )
  }

  async function persist(task, { nextActiveTaskId } = {}) {
    if (quarantined) return quarantineFailure()
    const previous = tasks.get(task.taskId)
    const previousActiveTaskId = activeTaskId
    try {
      assertTaskRecord(task)
      await table.put(task.taskId, task)
      tasks.set(task.taskId, task)
      if (nextActiveTaskId !== undefined) activeTaskId = nextActiveTaskId
      return { ok: true, task }
    } catch (error) {
      if (previous !== undefined) tasks.set(task.taskId, previous)
      else tasks.delete(task.taskId)
      activeTaskId = previousActiveTaskId
      if (isUnknownStateError(error)) {
        quarantined = {
          at: now(),
          code: 'unknown-state',
          reason: String(error?.message || error),
          taskId: task.taskId,
        }
        return fail(
          'TASK_STORE_QUARANTINED',
          `任务持久化结果不明（${error?.message || error}），已隔离保护`,
          '停止继续派发；关闭并重开存储域后再核对工作区与任务状态',
          { quarantined: true, quarantine: quarantined },
        )
      }
      return fail(
        'TASK_STORE_UNAVAILABLE',
        `任务未能持久写入：${error?.message || error}`,
        '检查 DSH 存储域是否可用；本次操作未生效，请重试或联系主人查看 ~/.dsh/storages',
      )
    }
  }

  function findBySourceKey(sourceKey) {
    for (const task of tasks.values()) if (task.sourceKey === sourceKey) return task
    return null
  }

  function findBySessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null
    for (const task of tasks.values()) if (task.dshSessionId === sessionId) return task
    return null
  }

  function isTaskSession(sessionId) {
    return findBySessionId(sessionId) !== null
  }

  function terminal(task) {
    return TERMINAL.has(task.executionStatus)
  }

  async function submitTask({ trustedActor, source, text, workspaceId, grantId = null, grantVersion = null, mode = 'files-only', origin = 'command' }) {
    if (!trustedActor || typeof trustedActor.userId !== 'string' || !trustedActor.userId) {
      return fail('TASK_ACTOR_UNTRUSTED', '缺少可信发起人', '身份只能来自桥接的 OneBot 上下文；请检查主人 QQ 配置')
    }
    if (typeof text !== 'string' || !text.trim()) return fail('TASK_TEXT_EMPTY', '任务内容为空', '换一条带具体要求的消息')
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return fail('TASK_WORKSPACE_MISSING', '没有可用的工作区', '先在「设置 → SurfCore → 本机任务」指定一个工作区')
    }
    if (!TASK_MODES.includes(mode)) {
      return fail('TASK_MODE_INVALID', `不支持的任务模式：${String(mode)}`, '只在「files-only」与「desktop」之间切换')
    }
    const cleanOrigin = TASK_ORIGINS.includes(origin) ? origin : 'command'
    let sourceKey
    try {
      sourceKey = sourceKeyOf(source)
    } catch (error) {
      return fail('TASK_SOURCE_INVALID', error.message, '入站消息缺少机器人账号/渠道/会话/消息 ID，拒绝登记')
    }

    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()

      const existing = findBySourceKey(sourceKey)
      const print = fingerprint(text)
      if (existing) {
        if (existing.textFingerprint === print) {
          return { ok: true, duplicate: true, queued: existing.executionStatus === 'queued', task: existing }
        }
        return fail('TASK_SOURCE_CONFLICT', '同一消息 ID 携带了不同内容', '丢弃这条入站消息并记录异常，不执行')
      }

      const queuedCount = [...tasks.values()].filter((t) => t.executionStatus === 'queued').length
      if (activeTaskId && queuedCount >= QUEUE_LIMIT) {
        return fail('TASK_QUEUE_FULL', `队列已满（${QUEUE_LIMIT}）`, '等当前任务结束后再发，或先取消/查询排队任务')
      }

      const at = now()
      const isQueued = Boolean(activeTaskId)
      const task = {
        taskId: newId(),
        createdAt: at,
        updatedAt: at,
        queueSeq: ++nextQueueSeq,
        trustedActor,
        sourceKey,
        textFingerprint: print,
        goal: text,
        workspaceId,
        mode,
        origin: cleanOrigin,
        grantId,
        grantVersion,
        dshSessionId: null,
        requestId: null,
        executionStatus: isQueued ? 'queued' : 'running',
        stopRequest: null,
        controlEpoch: 0,
        lastEventPosition: null,
        commands: [{ commandId: newId(), sourceKey, textHash: print, requestId: null, accepted: 'unknown', at }],
        deliveries: [],
        resultSummary: null,
        resultRefs: [],
        error: null,
      }
      const nextActiveTaskId = isQueued ? activeTaskId : task.taskId
      const written = await persist(task, { nextActiveTaskId })
      if (!written.ok) return written
      return { ok: true, queued: isQueued, task }
    })
  }

  function queryTask({ taskId } = {}) {
    if (taskId) {
      const task = tasks.get(taskId)
      return task
        ? { ok: true, quarantined: Boolean(quarantined), quarantine: quarantined, task }
        : fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号', { quarantined: Boolean(quarantined), quarantine: quarantined })
    }
    return {
      ok: true,
      quarantined: Boolean(quarantined),
      quarantine: quarantined,
      activeTaskId,
      tasks: [...tasks.values()].sort((a, b) => {
        const cmp = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        if (cmp !== 0) return cmp
        return (b.queueSeq ?? 0) - (a.queueSeq ?? 0)
      }),
    }
  }

  /**
   * 严格 FIFO 晋升下一个排队任务：只有在当前没有占席任务且未隔离时才把最早一条 queued 转为 running。
   */
  async function promoteNext() {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      if (activeTaskId !== null) {
        return fail('TASK_CONCURRENCY_BUSY', '已有任务占用执行席位', '等当前任务结束或复核完再派发下一个')
      }
      const nextQueued = [...tasks.values()].find((t) => t.executionStatus === 'queued')
      if (!nextQueued) return { ok: true, task: null }
      const promoted = { ...nextQueued, executionStatus: 'running', updatedAt: now() }
      const written = await persist(promoted, { nextActiveTaskId: promoted.taskId })
      return written.ok ? { ok: true, task: promoted } : written
    })
  }

  /**
   * 重启对账：把「进程崩溃时还在跑」的任务标成 needs_reconciliation，**不重放**任何写入。
   * 若存在因 cancel-failed 滞留占席的任务，宿主已重启时旧进程不可能仍在跑，一并释放席位并保留 needs_reconciliation。
   */
  async function reconcileOnBoot({ reason = 'host-restarted', at = now() } = {}) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const touched = []
      for (const task of [...tasks.values()]) {
        if (IN_FLIGHT.has(task.executionStatus)) {
          const next = {
            ...task,
            executionStatus: 'needs_reconciliation',
            reconciledAt: at,
            reconcileReason: reason,
            updatedAt: at,
          }
          const nextActiveTaskId = activeTaskId === task.taskId ? null : activeTaskId
          const written = await persist(next, { nextActiveTaskId })
          if (!written.ok) return { ...written, reconciled: touched }
          touched.push({ taskId: task.taskId, from: task.executionStatus })
        } else if (task.executionStatus === 'needs_reconciliation' && activeTaskId === task.taskId) {
          activeTaskId = null
        }
      }
      return { ok: true, reconciled: touched }
    })
  }

  /**
   * 关闭隔离域后用新打开的 domain 恢复，并对在途任务执行一次只标不重放的对账。
   */
  async function recoverWithDomain(newDomain, { reason = 'unknown-state-recovery', at = now() } = {}) {
    if (!newDomain || typeof newDomain.table !== 'function') throw bad('a reopened storageDomain handle is required')
    return enqueueWrite(async () => {
      try { await currentDomain.close?.() } catch {}
      currentDomain = newDomain
      table = currentDomain.table('tasks')
      quarantined = null
      loadAll()
      initQueueSeq()
      const touched = []
      for (const task of [...tasks.values()]) {
        if (IN_FLIGHT.has(task.executionStatus)) {
          const next = {
            ...task,
            executionStatus: 'needs_reconciliation',
            reconciledAt: at,
            reconcileReason: reason,
            updatedAt: at,
          }
          const nextActiveTaskId = activeTaskId === task.taskId ? null : activeTaskId
          const written = await persist(next, { nextActiveTaskId })
          if (!written.ok) return { ...written, reconciled: touched }
          touched.push({ taskId: task.taskId, from: task.executionStatus })
        } else if (task.executionStatus === 'needs_reconciliation' && activeTaskId === task.taskId) {
          activeTaskId = null
        }
      }
      return { ok: true, reconciled: touched }
    })
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
    if (task.executionStatus === 'needs_reconciliation') {
      lines.push(task.error?.error
        ? `需要复核：${task.error.error}（先核对工作区与原生会话，再决定重发）`
        : 'DSH 在任务执行中重启过或状态不明，不知道文件写没写：先看工作区，再决定重发')
    }
    if (task.executionStatus === 'failed' && task.error?.error) lines.push(`原因：${task.error.error}`)
    if (typeof task.resultSummary === 'string' && task.resultSummary.trim()) {
      lines.push(`结果：${task.resultSummary.trim()}`)
    }
    if (task.resultRefs?.length) lines.push(`产物：${task.resultRefs.join(', ')}`)
    return lines.join('\n')
  }

  function authorizeStop(task, actor, allowSystem = false) {
    if (allowSystem) return true
    return task.trustedActor?.userId === actor?.userId
  }

  /**
   * 先持久写入 stopRequest（不提前把状态写成 cancelled，也不释放并发席位），
   * 等 DSH 会话真正停止后再调用 confirmCancelled。
   */
  async function requestStop({ actor, taskId, reason = 'owner', allowSystem = false }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      if (!authorizeStop(task, actor, allowSystem)) {
        return fail('TASK_ACTOR_FORBIDDEN', '只有任务的发起人可以取消', '请让发起人自己发取消，或由主人授权')
      }
      if (terminal(task)) return fail('TASK_CLOSED', `任务已是 ${task.executionStatus} 终态`, '查看结果即可；要重做请新建任务')
      const next = {
        ...task,
        stopRequest: task.stopRequest ?? { at: now(), by: actor?.userId ?? 'system', reason },
        controlEpoch: task.controlEpoch + 1,
        updatedAt: now(),
      }
      const written = await persist(next)
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function confirmCancelled({ taskId, error = null }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      if (terminal(task)) return { ok: true, task, ignored: 'terminal' }
      const next = {
        ...task,
        executionStatus: 'cancelled',
        ...(error ? { error } : {}),
        updatedAt: now(),
      }
      const nextActiveTaskId = activeTaskId === taskId ? null : activeTaskId
      const written = await persist(next, { nextActiveTaskId })
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function cancelTask({ actor, taskId, reason = 'owner', allowSystem = false }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      if (!authorizeStop(task, actor, allowSystem)) {
        return fail('TASK_ACTOR_FORBIDDEN', '只有任务的发起人可以取消', '请让发起人自己发取消，或由主人授权')
      }
      if (terminal(task)) return fail('TASK_CLOSED', `任务已是 ${task.executionStatus} 终态`, '查看结果即可；要重做请新建任务')
      const next = {
        ...task,
        stopRequest: task.stopRequest ?? { at: now(), by: actor?.userId ?? 'system', reason },
        controlEpoch: task.controlEpoch + 1,
        executionStatus: 'cancelled',
        updatedAt: now(),
      }
      const nextActiveTaskId = activeTaskId === taskId ? null : activeTaskId
      const written = await persist(next, { nextActiveTaskId })
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function markNeedsReconciliation({ taskId, reason, error = null, keepActiveSeat = false, at = now() }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      if (terminal(task)) return { ok: true, task, ignored: 'terminal' }
      const next = {
        ...task,
        executionStatus: 'needs_reconciliation',
        reconciledAt: at,
        reconcileReason: reason,
        ...(error ? { error } : {}),
        updatedAt: at,
      }
      const nextActiveTaskId = (!keepActiveSeat && activeTaskId === taskId) ? null : activeTaskId
      const written = await persist(next, { nextActiveTaskId })
      return written.ok ? { ok: true, task: next } : written
    })
  }

  function requireRunning(taskId) {
    if (quarantined) return { failure: quarantineFailure() }
    const task = tasks.get(taskId)
    if (!task) return { failure: fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号') }
    if (terminal(task)) return { failure: fail('TASK_CLOSED', `任务已是 ${task.executionStatus} 终态`, '原生会话可查看，但不能继续执行') }
    if (task.executionStatus === 'needs_reconciliation') {
      return { failure: fail('TASK_NEEDS_RECONCILIATION', '任务处于需要复核状态，禁止继续派发', '先检查工作区与原生会话，再决定是否重新发起') }
    }
    if (task.executionStatus === 'queued') {
      return { failure: fail('TASK_QUEUED_NOT_ACTIVE', '任务还在排队中，不得直接派发', '等待当前活跃任务完成后按 FIFO 自动派发') }
    }
    if (activeTaskId !== taskId) {
      return { failure: fail('TASK_CONCURRENCY_BUSY', '任务未持有唯一执行席位', '等待当前活跃任务完成') }
    }
    if (task.stopRequest) return { failure: fail('TASK_STOPPED', '任务已被请求停止', '等停止处理完，或新建任务') }
    return { task }
  }

  async function attachSession({ taskId, sessionId, requestId }) {
    return enqueueWrite(async () => {
      const { failure, task } = requireRunning(taskId)
      if (failure) return failure
      if (task.dshSessionId && task.dshSessionId !== sessionId) {
        return fail('TASK_SESSION_CONFLICT', '任务已绑定另一个 DSH 会话', '核对 session.create 的响应，不要盲目再建会话')
      }
      const next = { ...task, dshSessionId: sessionId, requestId, updatedAt: now() }
      const written = await persist(next)
      return written.ok ? { ok: true, task: next } : written
    })
  }

  /** 记录已投影到的事件位置（只前进不后退），用于重启后不重放同一批事件。 */
  async function noteEvent({ taskId, seq }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      if (typeof seq !== 'number' || !Number.isFinite(seq)) return fail('TASK_EVENT_INVALID', '事件位置不是数字', '检查 session/event 的 seq 字段')
      if (task.lastEventPosition !== null && seq <= task.lastEventPosition) return { ok: true, task, ignored: 'stale' }
      const next = { ...task, lastEventPosition: seq, updatedAt: now() }
      const written = await persist(next)
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function recordDelivery({ taskId, delivery }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      const next = { ...task, deliveries: [...task.deliveries, delivery], updatedAt: now() }
      const written = await persist(next)
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function updateDelivery({ taskId, deliveryId, patch }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      const index = task.deliveries.findIndex((d) => d.deliveryId === deliveryId)
      if (index < 0) return fail('TASK_DELIVERY_NOT_FOUND', `回传记录 ${deliveryId} 不存在`, '先查询任务回传状态')
      const deliveries = task.deliveries.slice()
      deliveries[index] = { ...deliveries[index], ...patch }
      const next = { ...task, deliveries, updatedAt: now() }
      const written = await persist(next)
      return written.ok ? { ok: true, task: next } : written
    })
  }

  async function finish({ taskId, status, resultRefs = [], resultImages = [], error = null, resultSummary = null }) {
    return enqueueWrite(async () => {
      if (quarantined) return quarantineFailure()
      const task = tasks.get(taskId)
      if (!task) return fail('TASK_NOT_FOUND', `任务 ${taskId} 不存在`, '用「本机任务列表」确认任务号')
      // 迟到完成不得抹掉停止意图：已 cancel 或带 stopRequest 的任务禁止回到 succeeded。
      if (task.stopRequest && task.executionStatus === 'cancelled') {
        return { ok: true, task, ignored: 'stop-request', lateStatus: status }
      }
      if (task.executionStatus === 'needs_reconciliation') {
        const nextActiveTaskId = activeTaskId === taskId ? null : activeTaskId
        if (nextActiveTaskId !== activeTaskId) {
          const next = { ...task, updatedAt: now() }
          const written = await persist(next, { nextActiveTaskId })
          return written.ok ? { ok: true, task: next, ignored: 'needs-reconciliation', lateStatus: status } : written
        }
        return { ok: true, task, ignored: 'needs-reconciliation', lateStatus: status }
      }
      if (task.stopRequest && status === 'succeeded') {
        const next = { ...task, executionStatus: 'cancelled', updatedAt: now() }
        const nextActiveTaskId = activeTaskId === taskId ? null : activeTaskId
        const written = await persist(next, { nextActiveTaskId })
        return written.ok ? { ok: true, task: next, ignored: 'stop-request', lateStatus: status } : written
      }
      if (terminal(task)) return { ok: true, task, ignored: 'terminal' }
      const cleanSummary = typeof resultSummary === 'string' && resultSummary.trim()
        ? resultSummary.trim().slice(0, 1200)
        : (task.resultSummary ?? null)
      const cleanImages = Array.isArray(resultImages)
        ? [...new Set(resultImages.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()))].slice(0, 3)
        : []
      const preservedImages = cleanImages.length ? cleanImages : (Array.isArray(task.resultImages) ? task.resultImages : [])
      const next = {
        ...task,
        executionStatus: status,
        resultRefs,
        ...(preservedImages.length ? { resultImages: preservedImages } : {}),
        resultSummary: cleanSummary,
        error,
        updatedAt: now(),
      }
      const nextActiveTaskId = activeTaskId === taskId ? null : activeTaskId
      const written = await persist(next, { nextActiveTaskId })
      return written.ok ? { ok: true, task: next } : written
    })
  }

  loadAll()
  initQueueSeq()

  return {
    spec: LOCAL_TASK_DOMAIN,
    submitTask,
    queryTask,
    promoteNext,
    requestStop,
    confirmCancelled,
    cancelTask,
    markNeedsReconciliation,
    attachSession,
    recordDelivery,
    updateDelivery,
    noteEvent,
    reconcileOnBoot,
    recoverWithDomain,
    describeTask,
    finish,
    requireRunning,
    findBySessionId,
    isTaskSession,
    isQuarantined: () => Boolean(quarantined),
    getQuarantine: () => quarantined,
    // 仅供测试/调试观察，不对外暴露写入口
    _snapshot: () => ({ activeTaskId, quarantined, tasks: new Map(tasks) }),
  }
}
