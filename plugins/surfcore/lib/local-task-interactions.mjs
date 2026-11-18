// Bridge DSH in-turn interactive requests (user-questions/request & approval/request)
// for SurfCore-owned local task sessions to Owner QQ private chat and Settings UI.
// Non-owned sessions immediately pass through via next(), leaving native DSH UI untouched.
import { randomBytes } from 'node:crypto'

function fail(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
}

function makeInteractionId(pending) {
  for (let i = 0; i < 8; i++) {
    const id = `t${randomBytes(4).toString('hex').slice(0, 7)}`
    if (!pending.has(id)) return id
  }
  return `t${Date.now().toString(16).slice(-7).padStart(7, '0')}`
}

function createCancelledQuestionError(message = 'The confirmation request was cancelled.') {
  const err = new Error(message)
  err.name = 'UserQuestionError'
  err.code = 'ASK_CANCELLED'
  return err
}

function formatQuestionSummary(entry) {
  const header = entry.taskId ? `任务 ${entry.taskId}` : '本机任务'
  if (entry.kind === 'approval') {
    const lines = [
      `【需要授权 ${entry.id}】${header}`,
      `工具：${entry.toolName || '未知工具'}`,
    ]
    if (entry.detail) lines.push(`说明：${entry.detail}`)
    lines.push(`请回复：\`通过 ${entry.id}\` 或 \`拒绝 ${entry.id}\``)
    return lines.join('\n')
  }

  if (entry.approvalIntent) {
    const intent = entry.approvalIntent
    const subject = intent.subject?.name || entry.title
    const lines = [
      `【需要确认 ${entry.id}】${header}`,
      subject ? `对象：${subject}` : entry.title,
    ]
    if (entry.detail) lines.push(`说明：${entry.detail}`)
    const actions = [`\`通过 ${entry.id}\`（本会话允许）`]
    if (entry.allowAlways) actions.push(`\`始终允许 ${entry.id}\`（以后记住）`)
    actions.push(`\`拒绝 ${entry.id}\``)
    lines.push(`请回复：${actions.join(' / ')}`)
    return lines.join('\n')
  }

  const lines = [`【任务提问 ${entry.id}】${header}`]
  entry.questions.forEach((q, idx) => {
    const prefix = entry.questions.length > 1 ? `${idx + 1}. ` : ''
    lines.push(`${prefix}${q.question || q.id}`)
    if (q.detail) lines.push(`   ${q.detail}`)
    if (Array.isArray(q.options) && q.options.length > 0) {
      q.options.forEach((opt, optIdx) => {
        lines.push(`   [${optIdx + 1}] ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
      })
    }
  })
  lines.push(`请回复：\`${entry.id} 你的回答\`${entry.questions.length === 1 ? '（可填序号、选项名或自由文本）' : ''}`)
  return lines.join('\n')
}

function matchSingleQuestionReply(question, decision, answerText) {
  const raw = String(answerText ?? '').trim()
  const options = Array.isArray(question.options) ? question.options : []
  if (decision === 'allow' || decision === 'always' || decision === 'reject') {
    const intent = question.intent
    if (intent?.kind === 'approval') {
      const target = decision === 'always'
        ? intent.always
        : decision === 'allow'
          ? intent.approve
          : intent.reject
      if (target && options.some((o) => o.label === target)) {
        return { ok: true, item: { id: question.id, selected: [target] } }
      }
    }
  }
  if (!raw) {
    return fail('TASK_INTERACTION_ANSWER_EMPTY', '缺少回答内容', `请回复「${question.id} 你的回答」或在设置页填写`)
  }
  if (/^\d+$/.test(raw) && options.length > 0) {
    const idx = Number.parseInt(raw, 10) - 1
    if (idx >= 0 && idx < options.length) {
      return { ok: true, item: { id: question.id, selected: [options[idx].label] } }
    }
  }
  const exact = options.find((o) => o.label.toLowerCase() === raw.toLowerCase())
  if (exact) return { ok: true, item: { id: question.id, selected: [exact.label] } }
  return { ok: true, item: { id: question.id, selected: [], custom: raw } }
}

export function createLocalTaskInteractions({
  scoped,
  service,
  ownsSession,
  callBridge,
  log = () => {},
} = {}) {
  const pending = new Map()
  let disposed = false

  function removeEntry(id) {
    const entry = pending.get(id)
    if (!entry) return null
    pending.delete(id)
    try { entry.cleanupAbort?.() } catch {}
    return entry
  }

  function settleQuestionError(entry, error) {
    try { entry.reject(error) } catch {}
  }

  function settleApprovalOutcome(entry, outcome) {
    try { entry.resolve(outcome) } catch {}
  }

  async function notifyOwner(entry) {
    if (typeof callBridge !== 'function') return
    const text = formatQuestionSummary(entry)
    try {
      const res = await callBridge('/api/notify/owner', {
        method: 'POST',
        body: { message: text },
        timeoutMs: 15000,
      })
      if (!res || res.status >= 400 || res.data?.ok === false) {
        log(`[local-task-interactions] failed to notify owner for ${entry.id}: status=${res?.status ?? 'none'}`)
      }
    } catch (error) {
      log(`[local-task-interactions] notify owner error for ${entry.id}:`, error?.message ?? error)
    }
  }

  function attachAbort(entry, signal) {
    if (!signal) return
    const onAbort = () => {
      const removed = removeEntry(entry.id)
      if (!removed) return
      if (removed.kind === 'approval') settleApprovalOutcome(removed, 'cancelled')
      else settleQuestionError(removed, createCancelledQuestionError('Confirmation aborted'))
    }
    if (signal.aborted) {
      queueMicrotask(onAbort)
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.cleanupAbort = () => signal.removeEventListener('abort', onAbort)
  }

  function isOwnedAgent(agent) {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return false
    if (typeof ownsSession === 'function' && ownsSession(sessionId)) return true
    if (typeof service?.isTaskSession === 'function' && service.isTaskSession(sessionId)) return true
    return false
  }

  const offApproval = scoped?.on?.('approval/request', (req, next) => {
    if (!isOwnedAgent(req?.agent)) return next()
    if (disposed || req?.signal?.aborted) return Promise.resolve('cancelled')

    const sessionId = req.agent.session.id
    const task = service?.findBySessionId?.(sessionId) ?? null
    const id = makeInteractionId(pending)

    return new Promise((resolve) => {
      const entry = {
        id,
        kind: 'approval',
        taskId: task?.taskId ?? null,
        sessionId,
        toolName: String(req.toolName || ''),
        title: `允许执行工具 ${req.toolName || ''}`,
        detail: typeof req.reason === 'string' ? req.reason : '',
        options: ['Allow once', 'Reject'],
        allowAlways: false,
        isBinaryApproval: true,
        approvalIntent: null,
        questions: [],
        createdAt: new Date().toISOString(),
        resolve,
        reject: () => resolve('unavailable'),
        cleanupAbort: null,
      }
      pending.set(id, entry)
      attachAbort(entry, req.signal)
      void notifyOwner(entry)
    })
  }, { prepend: true })

  const offQuestions = scoped?.on?.('user-questions/request', (req, next) => {
    if (!isOwnedAgent(req?.agent)) return next()
    if (disposed || req?.signal?.aborted) {
      return Promise.reject(createCancelledQuestionError())
    }

    const sessionId = req.agent.session.id
    const task = service?.findBySessionId?.(sessionId) ?? null
    const questions = Array.isArray(req?.questions) ? req.questions : []
    if (!questions.length) {
      return Promise.reject(createCancelledQuestionError('Empty question batch'))
    }

    const first = questions[0]
    const intent = questions.length === 1 && first?.intent?.kind === 'approval' ? first.intent : null
    const options = Array.isArray(first?.options) ? first.options : []
    const allowAlways = Boolean(intent?.always && options.some((o) => o.label === intent.always))
    const id = makeInteractionId(pending)

    return new Promise((resolve, reject) => {
      const entry = {
        id,
        kind: 'user-question',
        taskId: task?.taskId ?? null,
        sessionId,
        toolName: first?.id === 'cua-app-access' || first?.id === 'cua-mouse-control' ? 'cua' : 'ask_user_question',
        title: String(first?.question || first?.id || '等待确认'),
        detail: typeof first?.detail === 'string' ? first.detail : '',
        options: options.map((o) => o.label),
        allowAlways,
        isBinaryApproval: Boolean(intent),
        approvalIntent: intent,
        questions,
        createdAt: new Date().toISOString(),
        resolve,
        reject,
        cleanupAbort: null,
      }
      pending.set(id, entry)
      attachAbort(entry, req.signal)
      void notifyOwner(entry)
    })
  }, { prepend: true })

  function listPending({ taskId } = {}) {
    const items = []
    for (const entry of pending.values()) {
      if (taskId && entry.taskId !== taskId) continue
      items.push({
        id: entry.id,
        kind: entry.kind,
        taskId: entry.taskId,
        toolName: entry.toolName,
        title: entry.title,
        detail: entry.detail,
        options: entry.options,
        allowAlways: entry.allowAlways,
        isBinaryApproval: entry.isBinaryApproval,
        createdAt: entry.createdAt,
      })
    }
    return items
  }

  function answer({ id, decision = '', answerText = '', actor = null } = {}) {
    const cleanId = String(id ?? '').trim()
    if (!cleanId) return fail('TASK_INTERACTION_ID_REQUIRED', '缺少确认编号', '请带上编号（如 t1a2b3c4）')
    const entry = pending.get(cleanId)
    if (!entry) {
      return fail('TASK_INTERACTION_NOT_FOUND', `确认请求 ${cleanId} 不存在或已过期`, '发「本机任务列表」或在设置页刷新查看当前等待项')
    }
    const task = entry.taskId ? service?.queryTask?.({ taskId: entry.taskId })?.task : null
    if (actor?.userId && task?.trustedActor?.userId && task.trustedActor.userId !== actor.userId) {
      return fail('TASK_ACTOR_FORBIDDEN', '只有任务发起人可回应这个确认', '请让原发送人操作')
    }

    const cleanDecision = String(decision ?? '').trim().toLowerCase()
    if (entry.kind === 'approval') {
      const outcome = cleanDecision === 'allow' || cleanDecision === 'approve' || cleanDecision === 'always' || cleanDecision === 'allow-once'
        ? 'allowed-once'
        : (cleanDecision === 'reject' || cleanDecision === 'deny' || cleanDecision === 'cancel')
          ? 'rejected'
          : null
      if (!outcome) {
        return fail('TASK_INTERACTION_DECISION_INVALID', `无法识别授权决定：${cleanDecision || '空'}`, `请回复「通过 ${cleanId}」或「拒绝 ${cleanId}」`)
      }
      removeEntry(cleanId)
      settleApprovalOutcome(entry, outcome)
      return {
        ok: true,
        id: cleanId,
        taskId: entry.taskId,
        decision: outcome === 'allowed-once' ? 'allow' : 'reject',
        text: `已${outcome === 'allowed-once' ? '通过' : '拒绝'}授权 ${cleanId}`,
      }
    }

    if (entry.approvalIntent) {
      const intent = entry.approvalIntent
      if (cleanDecision === 'always' && !entry.allowAlways) {
        return fail('TASK_INTERACTION_ALWAYS_UNAVAILABLE', `确认项 ${cleanId} 不支持永久记住`, `请回复「通过 ${cleanId}」或「拒绝 ${cleanId}」`)
      }
      const chosen = cleanDecision === 'always'
        ? intent.always
        : (cleanDecision === 'allow' || cleanDecision === 'approve')
          ? intent.approve
          : (cleanDecision === 'reject' || cleanDecision === 'deny' || cleanDecision === 'cancel')
            ? intent.reject
            : null
      if (!chosen) {
        return fail(
          'TASK_INTERACTION_DECISION_INVALID',
          `无法识别确认选择：${cleanDecision || '空'}`,
          `请回复「通过 ${cleanId}」${entry.allowAlways ? `、「始终允许 ${cleanId}」` : ''}或「拒绝 ${cleanId}」`,
        )
      }
      removeEntry(cleanId)
      entry.resolve({ answers: [{ id: entry.questions[0].id, selected: [chosen] }] })
      return {
        ok: true,
        id: cleanId,
        taskId: entry.taskId,
        decision: cleanDecision,
        text: `已提交确认 ${cleanId}：${chosen}`,
      }
    }

    const rawText = String(answerText ?? '').trim()
    if (entry.questions.length === 1) {
      const matched = matchSingleQuestionReply(entry.questions[0], cleanDecision, rawText)
      if (!matched.ok) return matched
      removeEntry(cleanId)
      entry.resolve({ answers: [matched.item] })
      return { ok: true, id: cleanId, taskId: entry.taskId, text: `已把你的回答交给任务（${cleanId}）` }
    }

    if (!rawText) {
      return fail('TASK_INTERACTION_ANSWER_EMPTY', '缺少回答内容', `请回复「${cleanId} 你的回答」`)
    }
    const answers = entry.questions.map((q) => ({ id: q.id, selected: [], custom: rawText }))
    removeEntry(cleanId)
    entry.resolve({ answers })
    return { ok: true, id: cleanId, taskId: entry.taskId, text: `已把你的回答交给任务（${cleanId}）` }
  }

  function disposeAll() {
    disposed = true
    for (const id of [...pending.keys()]) {
      const entry = removeEntry(id)
      if (!entry) continue
      if (entry.kind === 'approval') settleApprovalOutcome(entry, 'cancelled')
      else settleQuestionError(entry, createCancelledQuestionError('Host unloaded'))
    }
    try { typeof offApproval === 'function' && offApproval() } catch {}
    try { typeof offQuestions === 'function' && offQuestions() } catch {}
  }

  scoped?.effect?.(() => () => disposeAll())

  return Object.freeze({
    listPending,
    answer,
    disposeAll,
  })
}
