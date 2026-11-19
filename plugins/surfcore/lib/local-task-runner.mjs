// 一个 Task = 一个专用 DSH 会话（T04）：装配在册 → 送首条 prompt → 按事件投影状态。
//
// 只调用宿主公开的 `ctx.sessionController`（create / prompt / cancel），不自己
// 造执行器、不直接跑 agent loop。所有调用都是"接受"语义（`accepted:true` = 消息已入队），
// 完成与否只由会话事件判定。
//
// 生命周期与安全保障：
//   - 并发 1 + FIFO 队列：queued 任务禁止直接调用 dispatch()，由当前任务收敛后按 FIFO 晋升。
//   - 闸门卸载感知：gate 卸载时同步中止在途会话；无法确认停止则标 needs_reconciliation 并锁席位。
//   - 保守 turn/end 映射：兼容 DSH 对象 `{ kind }` 与字符串 reason，未知 reason 一律标 needs_reconciliation。
//   - 完整额度事件流：覆盖 DSH 真实 `assistant/message` / `assistant/attempt` / `session/title-llm-request`
//     与 `tool/call` / `tool/result`（按 callId 去重），确保模型与工具额度不能绕过。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  taskGateIsLive,
  onGateLivenessChange,
  TASK_ALLOWED_TOOLS,
  DESKTOP_PRESET_ID,
  isDesktopToolAllowed,
} from './local-task-gate.mjs'
import { createTaskBudget } from './local-task-budget.mjs'
import { looksLikeImageBuffer } from '../../../src/safe-fetch.js'
import { isUnsafeTaskFilePath } from '../../../src/sensitive.js'

export const TASK_PRESET_ID = 'local-task'

function failure(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
}

export function classifyTurnEndReason(rawReason) {
  const kind = typeof rawReason === 'string'
    ? rawReason
    : rawReason && typeof rawReason === 'object' && typeof rawReason.kind === 'string'
      ? rawReason.kind
      : null
  if (kind === 'completed') return { status: 'succeeded', kind }
  if (kind === 'aborted' || kind === 'cancelled') return { status: 'cancelled', kind }
  if (kind === 'error') {
    const msg = typeof rawReason === 'object' ? rawReason?.error?.message : undefined
    return {
      status: 'failed',
      kind,
      code: 'TASK_TURN_FAILED',
      detail: msg ? `会话回合失败（${msg}）` : '会话回合失败（error）',
    }
  }
  if (kind === 'blocked' || kind === 'max-tokens' || kind === 'forked') {
    return {
      status: 'failed',
      kind,
      code: 'TASK_TURN_FAILED',
      detail: `会话回合未正常完成（${kind}）`,
    }
  }
  if (kind === 'interrupted') {
    return {
      status: 'needs_reconciliation',
      kind,
      code: 'TASK_TURN_INTERRUPTED',
      detail: '会话回合被中断（interrupted），无法确认文件是否写入',
    }
  }
  return {
    status: 'needs_reconciliation',
    kind: kind ?? 'unknown',
    code: 'TASK_TURN_REASON_UNKNOWN',
    detail: `未知回合结束原因（${JSON.stringify(rawReason ?? null)}），禁止假定成功`,
  }
}

const QUOTED_IMAGE_RE = /[`"']([^`"'<>\n\r|]+?\.(?:png|jpe?g|webp|gif))[`"']/gi
const UNQUOTED_ABS_IMAGE_RE = /(?<![A-Za-z0-9])((?:\/[^\s"'`<>|()[\]{}，。；、！？）】》]+|[A-Za-z]:[\\/][^\s"'`<>|()[\]{}]+)\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`<>|()[\]{}，。；、！？）】》])/gi
const RELATIVE_IMAGE_TOKEN_RE = /(?:^|[\s:：=(["'`])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`<>|()[\]{}，。；、！？）】》])/gi

/**
 * 从任务摘要或工具输出中提取真实存在且格式合法的本地截图文件路径（最多 maxCount 张）。
 * 统一复用敏感路径与图片头校验，防止把系统/密钥目录或伪造后缀文件附带到 QQ 回执中。
 */
export function extractTaskImagePaths(inputs, { workspaceRoot = '', maxCount = 3, maxBytes = 8 * 1024 * 1024 } = {}) {
  const texts = (Array.isArray(inputs) ? inputs : [inputs]).filter((v) => typeof v === 'string' && v.trim())
  if (!texts.length) return []
  let realWorkspace = ''
  if (workspaceRoot) {
    try { realWorkspace = fs.realpathSync(workspaceRoot) } catch {}
  }
  const seenPaths = new Set()
  const seenHashes = new Set()
  const images = []

  const tryAdd = (rawCandidate, { relativeOnly = false } = {}) => {
    if (images.length >= maxCount) return
    const cleaned = String(rawCandidate ?? '').trim().replace(/[，。；、！？）】》"'.,;:)\]]+$/, '')
    if (!cleaned) return
    let candidate = cleaned
    if (relativeOnly || (!path.isAbsolute(cleaned) && !/^[A-Za-z]:[\\/]/.test(cleaned))) {
      if (!realWorkspace) return
      candidate = path.resolve(realWorkspace, cleaned)
    }
    if (isUnsafeTaskFilePath(candidate, { allowTempDir: true })) return
    let real
    try { real = fs.realpathSync(candidate) } catch { return }
    if (seenPaths.has(real)) return
    if (relativeOnly && realWorkspace && real !== realWorkspace && !real.startsWith(realWorkspace + path.sep)) return
    if (isUnsafeTaskFilePath(real, { allowTempDir: true }) || !/\.(?:png|jpe?g|webp|gif)$/i.test(real)) return
    let stat
    try { stat = fs.statSync(real) } catch { return }
    if (!stat.isFile() || stat.size < 12 || stat.size > maxBytes) return
    let buf
    try { buf = fs.readFileSync(real) } catch { return }
    if (!looksLikeImageBuffer(buf)) return
    const digest = crypto.createHash('sha256').update(buf).digest('hex')
    seenPaths.add(real)
    if (seenHashes.has(digest)) return
    seenHashes.add(digest)
    images.push(real)
  }

  for (const text of texts) {
    for (const m of text.matchAll(QUOTED_IMAGE_RE)) {
      const inner = m[1]
      const isAbs = path.isAbsolute(inner) || /^[A-Za-z]:[\\/]/.test(inner)
      tryAdd(inner, { relativeOnly: !isAbs })
    }
    for (const m of text.matchAll(UNQUOTED_ABS_IMAGE_RE)) tryAdd(m[1])
    for (const m of text.matchAll(RELATIVE_IMAGE_TOKEN_RE)) tryAdd(m[1], { relativeOnly: true })
    if (images.length >= maxCount) break
  }
  return images
}

export function taskPromptText({ goal, workspaceRoot, mode = 'files-only' }) {
  if (mode === 'desktop') {
    return [
      `你是这台 Mac/电脑上的本机与浏览器执行助手，主人通过 QQ 委托你完成这个任务。`,
      `默认工作区：${workspaceRoot}（保存文档/产出物优先放这里；跨目录读写、系统操作、应用控制和网页操作按任务需要正常进行）。`,
      `任务：${goal}`,
      '执行准则：',
      '1. 网页与浏览器：只要具备 `mcp__surfcore-chrome__*` 工具（如 `new_page`, `navigate_page`, `take_snapshot`, `click`, `fill`, `evaluate_script`），一律优先使用它们操作专属隔离 Chrome，不要用桌面点击去盲点网页内部控件。',
      '2. 桌面与应用：用 `cua` 操作系统界面与原生应用（优先 Accessibility 树定位，截图按需使用）；首次控制新应用或移动物理指针时宿主会向主人发 QQ 确认，若被拒绝就停止该动作并如实说明。',
      '3. 命令与文件：优先把文件/截图保存在默认工作区内（工作区内无需额外授权）；仅在主人明确要求放到桌面等工作区外路径时再申请越界写操作，并将同一目标的多步命令合并在一次调用中执行，避免连续弹窗。不要尝试启动或操控 SurfCore / DSH 自身进程。',
      '4. 严谨汇报：最后用简洁中文汇报完成情况、你亲自确认过的真实结果（如页面标题/关键内容/文件相对或绝对路径）或真实失败原因，严禁编造未验证的内容。',
    ].join('\n')
  }
  return [
    '你是这台 Mac 上的本机任务执行器，用户通过 QQ 派了这个任务。',
    `工作区：${workspaceRoot}`,
    `任务：${goal}`,
    '规则：',
    '1. 只在这个工作区内读、列、新建文件；越界路径一律不要尝试。',
    '2. 只能新建文件，不能覆盖或修改已存在的文件；要改内容就新建一个不同文件名。',
    '3. 不许执行命令、不许联网、不许派生子代理。',
    '4. 做完用一句话说明你新建了哪些文件（相对工作区的路径）。',
  ].join('\n')
}

/**
 * @param service           TaskService（唯一写入者，async 持久化）
 * @param sessionController 宿主 ctx.sessionController
 * @param subscribe         (fn) => dispose，接 `session/event`
 * @param isGateLive        闸门存活判定（默认查 local-task-gate 的登记表）
 * @param subscribeGate     (fn) => dispose，监听闸门卸载事件
 * @param workspaceRoot     任务工作区（canonicalRoot）
 * @param newRequestId      requestId 生成器（持久化后重发同一 requestId 才算幂等）
 */
export function createLocalTaskRunner({
  onFinished = () => {},
  onSessionCreated = null,
  service,
  sessionController,
  agents,
  agentPresets,
  tools,
  allowedTools = new Set(TASK_ALLOWED_TOOLS),
  subscribe,
  isGateLive = taskGateIsLive,
  subscribeGate = (fn) => onGateLivenessChange(presetId, fn),
  subscribeDesktopGate = (fn) => onGateLivenessChange(DESKTOP_PRESET_ID, fn),
  presetId = TASK_PRESET_ID,
  workspaceRoot,
  newRequestId,
  budget = createTaskBudget(),
}) {
  if (!service || !sessionController) throw new TypeError('local-task-runner: service 与 sessionController 必填')
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('local-task-runner: workspaceRoot 必填')
  if (typeof newRequestId !== 'function') throw new TypeError('local-task-runner: newRequestId 必填')

  let disposeEvents = null
  let disposeGate = null
  let disposeDesktopGate = null
  let detaching = false
  let pumping = false
  let pumpAgain = false
  const stoppingBudget = new Set()
  const seenToolCalls = new Map()
  const seenModelAttempts = new Map()
  const unmatchedStreamCount = new Map()
  const lastAssistantText = new Map()
  const lastToolTexts = new Map()
  const ownedSessions = new Set()

  function presetForTask(task) {
    return task?.mode === 'desktop' ? DESKTOP_PRESET_ID : presetId
  }

  function ownsSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false
    return ownedSessions.has(sessionId) || Boolean(service.findBySessionId(sessionId))
  }

  function forgetTaskTracking(taskId) {
    budget.forget(taskId)
    seenToolCalls.delete(taskId)
    seenModelAttempts.delete(taskId)
    unmatchedStreamCount.delete(taskId)
    stoppingBudget.delete(taskId)
    lastAssistantText.delete(taskId)
    lastToolTexts.delete(taskId)
  }

  function noteModelEvent(taskId, event) {
    const pendingStreams = unmatchedStreamCount.get(taskId) ?? 0
    if (pendingStreams > 0) {
      if (pendingStreams === 1) unmatchedStreamCount.delete(taskId)
      else unmatchedStreamCount.set(taskId, pendingStreams - 1)
      return null
    }
    const attemptId = event?.data?.attemptId ?? event?.data?.stream?.attemptId
    if (attemptId !== undefined) {
      let seen = seenModelAttempts.get(taskId)
      if (!seen) {
        seen = new Set()
        seenModelAttempts.set(taskId, seen)
      }
      if (seen.has(attemptId)) return null
      seen.add(attemptId)
    }
    return budget.noteModelRequest(taskId)
  }

  async function admitLlmStream(options) {
    const sessionId = options?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) return { ok: true, managed: false }
    const found = service.findBySessionId(sessionId)
    if (!found) return { ok: true, managed: false }
    if (service.isQuarantined()) {
      return failure('TASK_STORE_QUARANTINED', '存储域处于隔离核对状态，禁止发起模型请求', '先关闭并重开存储域后再核对')
    }
    if (found.stopRequest || ['cancelled', 'failed', 'succeeded', 'needs_reconciliation'].includes(found.executionStatus)) {
      return failure('TASK_STOPPED', '本机任务已停止或结束，禁止继续模型调用', '查看任务状态；需要重做请新建任务')
    }
    const counted = budget.noteModelRequest(found.taskId)
    if (counted.ok === false) {
      await stopForBudget(found, counted)
      return counted
    }
    unmatchedStreamCount.set(found.taskId, (unmatchedStreamCount.get(found.taskId) ?? 0) + 1)
    return { ok: true, managed: true, taskId: found.taskId }
  }

  function noteToolEvent(taskId, event) {
    const callId = event?.type === 'tool/call'
      ? event?.data?.callId
      : (event?.data?.message?.callId ?? event?.data?.callId)
    if (typeof callId === 'string' && callId) {
      let seen = seenToolCalls.get(taskId)
      if (!seen) {
        seen = new Set()
        seenToolCalls.set(taskId, seen)
      }
      if (seen.has(callId)) return null
      seen.add(callId)
    } else if (event?.type === 'tool/result') {
      // 没有 callId 且走的是成对事件时避免把未知匿名 tool/result 当作第二次；
      // 仅在单测直接发无 callId 的 tool/result 时按 1 次计入。
    }
    return budget.noteToolCall(taskId)
  }

  async function pumpQueue() {
    if (detaching) return
    if (pumping) {
      pumpAgain = true
      return
    }
    pumping = true
    try {
      do {
        pumpAgain = false
        if (detaching || service.isQuarantined()) break
        const snapshot = service.queryTask({})
        if (snapshot.activeTaskId !== null) break
        const nextQueued = snapshot.tasks
          .filter((t) => t.executionStatus === 'queued')
          .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0))[0]
        if (!nextQueued || !isGateLive(presetForTask(nextQueued))) break
        const promoted = await service.promoteNext()
        if (!promoted.ok || !promoted.task) break
        const dispatched = await dispatch(promoted.task.taskId)
        if (dispatched.ok) break
      } while (pumpAgain || service.queryTask({}).activeTaskId === null)
    } finally {
      pumping = false
    }
  }

  async function observe(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !sessionId) return
    const found = service.findBySessionId(sessionId)
    if (!found) return
    if (typeof event?.seq === 'number') {
      const noted = await service.noteEvent({ taskId: found.taskId, seq: event.seq })
      if (noted?.ok === false) return noted
      if (noted?.ignored === 'stale') return
    }

    // 额度：覆盖 DSH 真实模型调用事件与工具调用事件；一旦越界当场停会话。
    let counted = null
    if (event?.type === 'assistant/message') {
      const blocks = event?.data?.message?.content
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (text) lastAssistantText.set(found.taskId, text.slice(0, 2000))
      }
      counted = noteModelEvent(found.taskId, event)
    } else if (event?.type === 'assistant/attempt' || event?.type === 'session/title-llm-request') {
      counted = noteModelEvent(found.taskId, event)
    } else if (event?.type === 'tool/call' || event?.type === 'tool/result') {
      if (event.type === 'tool/result') {
        const rawContent = event?.data?.message?.content ?? event?.data?.content
        const toolText = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
            : ''
        if (toolText && /\.(?:png|jpe?g|webp|gif)/i.test(toolText)) {
          const list = lastToolTexts.get(found.taskId) ?? []
          list.push(toolText.slice(0, 2000))
          if (list.length > 10) list.shift()
          lastToolTexts.set(found.taskId, list)
        }
      }
      counted = noteToolEvent(found.taskId, event)
    } else if (event?.type === 'turn/start' || event?.type === 'step/start') {
      counted = budget.check(found.taskId)
    }
    if (counted && counted.ok === false) {
      await stopForBudget(found, counted)
      return counted
    }

    if (event?.type !== 'turn/end') return
    const latest = service.queryTask({ taskId: found.taskId }).task ?? found

    // 停止意图优先：取消后迟到的 turn/end 不得把任务改回成功。
    if (latest.stopRequest) {
      if (latest.executionStatus === 'needs_reconciliation') {
        // 先前取消未获确认而锁定席位；现在真实 turn/end 到达说明旧回合已真正结束，释放席位并维持 needs_reconciliation。
        const released = await service.finish({ taskId: latest.taskId, status: 'cancelled' })
        forgetTaskTracking(latest.taskId)
        if (released?.ok) void pumpQueue()
        return released
      }
      forgetTaskTracking(latest.taskId)
      return
    }

    const classified = classifyTurnEndReason(event?.data?.reason)
    let result
    if (classified.status === 'needs_reconciliation') {
      result = await service.markNeedsReconciliation({
        taskId: latest.taskId,
        reason: classified.kind,
        error: {
          code: classified.code,
          error: classified.detail,
          hint: '先检查工作区与原生会话日志，再决定是否重新发起',
        },
        keepActiveSeat: false,
      })
    } else {
      const assistantSummary = lastAssistantText.get(latest.taskId) ?? null
      const resultImages = classified.status === 'succeeded'
        ? extractTaskImagePaths(
            [assistantSummary ?? '', ...(lastToolTexts.get(latest.taskId) ?? [])],
            { workspaceRoot },
          )
        : []
      result = await service.finish({
        taskId: latest.taskId,
        status: classified.status,
        resultRefs: [`dsh-session:${sessionId}`],
        resultImages,
        resultSummary: classified.status === 'succeeded' ? assistantSummary : null,
        error: classified.status === 'failed'
          ? { code: classified.code ?? 'TASK_TURN_FAILED', error: classified.detail ?? '会话回合失败', hint: '打开原生会话看工具调用，或重发任务' }
          : null,
      })
    }
    forgetTaskTracking(latest.taskId)
    if (result?.ok && !result.ignored) {
      try { await onFinished(result.task ?? latest, result.task?.executionStatus ?? classified.status) } catch {}
      void pumpQueue()
    }
    return result
  }

  /** 额度用尽：先写停止屏障，再撤掉会话；若撤不掉则标记 needs_reconciliation 并锁住席位。 */
  async function stopForBudget(task, hit) {
    if (stoppingBudget.has(task.taskId)) return
    stoppingBudget.add(task.taskId)
    try {
      await service.requestStop({ actor: task.trustedActor, taskId: task.taskId, reason: 'budget-exceeded', allowSystem: true })
      let cancelConfirmed = !task.dshSessionId
      if (task.dshSessionId) {
        try {
          const ack = await sessionController.cancel({ sessionId: task.dshSessionId })
          cancelConfirmed = ack?.accepted !== false
        } catch {
          cancelConfirmed = false
        }
      }
      let result
      if (!cancelConfirmed) {
        result = await service.markNeedsReconciliation({
          taskId: task.taskId,
          reason: 'budget-cancel-unconfirmed',
          error: { code: hit.code, error: `${hit.error}（停止会话未获确认）`, hint: hit.hint },
          keepActiveSeat: true,
        })
      } else {
        result = await service.finish({
          taskId: task.taskId,
          status: 'failed',
          resultRefs: task.dshSessionId ? [`dsh-session:${task.dshSessionId}`] : [],
          error: { code: hit.code, error: hit.error, hint: hit.hint },
        })
      }
      forgetTaskTracking(task.taskId)
      if (result?.ok && !result.ignored) {
        try { await onFinished(result.task ?? task, result.task?.executionStatus ?? 'failed') } catch {}
        if (cancelConfirmed) void pumpQueue()
      }
      return result
    } finally {
      stoppingBudget.delete(task.taskId)
    }
  }

  /** 装配是否真的落地：靠这一层的证据，不靠"创建时校验过一次"。 */
  function verifySurface(sessionId, task = null) {
    const targetPreset = presetForTask(task)
    const agent = agents?.get?.(sessionId)
    if (!agent) return failure('TASK_SESSION_MISSING', '刚创建的会话取不到 agent', '重启 DSH 后重试；期间不要派发新任务')
    const preset = agentPresets?.composedPreset?.(agent.ctx)
    if (preset !== targetPreset) {
      return failure('TASK_POLICY_MISMATCH', `会话装配的是「${preset ?? '未知'}」而不是「${targetPreset}」`, `检查 profile 预设「${targetPreset}」是否生效，重启 DSH 后重试`)
    }
    let schemas = []
    let defs = null
    try {
      schemas = tools?.schemas?.(agent) ?? []
      if (typeof tools?.definitions === 'function') defs = tools.definitions(agent) ?? []
    } catch (error) {
      return failure('TASK_SURFACE_UNREADABLE', `读不到会话工具面：${error?.message || error}`, '重启 DSH 后重试；期间不要派发新任务')
    }
    const schemaNames = schemas.map((item) => item?.name).filter((name) => typeof name === 'string')
    if (task?.mode === 'desktop') {
      const defNames = (Array.isArray(defs) ? defs : schemas).map((item) => item?.name).filter((name) => typeof name === 'string')
      const foreign = [...new Set([
        ...defNames.filter((name) => !isDesktopToolAllowed(name)),
        ...schemaNames.filter((name) => name !== 'run_code' && !isDesktopToolAllowed(name)),
      ])]
      if (foreign.length) {
        return failure('TASK_TOOL_SURFACE_UNSAFE', `桌面会话里出现了禁止的工具：${foreign.join(',')}`, '检查桌面策略白名单后重启 DSH；这条任务不要重试')
      }
      if (!isGateLive(targetPreset)) return failure('TASK_POLICY_UNMOUNTED', `桌面任务策略「${targetPreset}」当前不在册`, '重启 DSH 让 SurfCore 重新装配策略，再重试；期间不要派发新任务')
      if (!defNames.includes('read') || (!defNames.includes('bash') && !defNames.includes('pwsh') && !defNames.includes('cua'))) {
        return failure('TASK_TOOL_SURFACE_INCOMPLETE', '桌面会话缺少核心本地执行/控制工具（read/bash/pwsh/cua）', '检查 DSH ptc 预设配置后重启 DSH')
      }
      return { ok: true }
    }
    const foreign = schemaNames.filter((name) => !allowedTools.has(name))
    if (foreign.length) return failure('TASK_TOOL_SURFACE_UNSAFE', `会话里出现了本任务不该有的工具：${foreign.join(',')}`, '改回 local-task 预设的装配行后重启 DSH；这条任务不要重试')
    if (!isGateLive(targetPreset)) return failure('TASK_POLICY_UNMOUNTED', `本机任务策略「${targetPreset}」当前不在册`, '重启 DSH 让 SurfCore 重新装配策略，再重试；期间不要派发新任务')
    const missingRequired = ['read', 'write'].filter((name) => !schemaNames.includes(name))
    if (missingRequired.length) return failure('TASK_TOOL_SURFACE_INCOMPLETE', `会话缺少必需的文件工具：${missingRequired.join(',')}`, '检查 local-task 预设的 tool-fs 与 restrict 配置，重启 DSH 后重试')
    return { ok: true }
  }

  async function failAndClose(taskId, code, error, hint = '看原生会话日志定位；这条任务不会自动重试') {
    const finished = await service.finish({ taskId, status: 'failed', error: { code, error, hint } })
    forgetTaskTracking(taskId)
    if (finished?.ok && !finished.ignored) {
      try { await onFinished(finished.task, 'failed') } catch {}
    }
    return failure(code, error, hint)
  }

  async function dispatch(taskId, { goal, background = false } = {}) {
    const { failure: blocked, task } = service.requireRunning(taskId)
    if (blocked) return blocked
    if (task.dshSessionId) return failure('TASK_SESSION_EXISTS', '任务已绑定会话', '不要重复派发；用查询看状态')
    const targetPreset = presetForTask(task)
    if (!isGateLive(targetPreset)) {
      return failAndClose(taskId, 'TASK_POLICY_UNMOUNTED', `本机任务策略「${targetPreset}」当前不在册`, '重启 DSH 让 SurfCore 重新装配策略，再重试；期间不要派发新任务')
    }

    const requestId = task.requestId ?? newRequestId()

    const startSession = async () => {
      let created
      try {
        created = await sessionController.create({ cwd: workspaceRoot, agentPreset: targetPreset })
      } catch (error) {
        return failAndClose(taskId, 'TASK_SESSION_CREATE_FAILED', `创建任务会话失败：${error?.message || error}`)
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        return failAndClose(taskId, 'TASK_SESSION_CREATE_FAILED', '会话创建没有返回 sessionId')
      }
      ownedSessions.add(sessionId)
      if (!isGateLive(targetPreset)) {
        try { await sessionController.cancel({ sessionId }) } catch {}
        ownedSessions.delete(sessionId)
        return failAndClose(taskId, 'TASK_POLICY_UNMOUNTED', `本机任务策略「${targetPreset}」在创建会话期间已卸载`, '恢复策略闸门后如有需要请重新发起')
      }
      const recheck = service.requireRunning(taskId)
      if (detaching || recheck.failure) {
        try { await sessionController.cancel({ sessionId }) } catch {}
        ownedSessions.delete(sessionId)
        const recordedErr = service.queryTask({ taskId }).task?.error
        if (recordedErr?.code) return failure(recordedErr.code, recordedErr.error, recordedErr.hint)
        return recheck.failure ?? failure('TASK_STOPPED', '宿主正在卸载，已取消刚创建的会话', '查看任务状态；如仍需要请重新发起')
      }
      try { await onSessionCreated?.({ task, sessionId }) } catch {}

      // 先装配好策略再送首条 prompt：装配不合格就把会话取消掉，绝不送入。
      const verified = verifySurface(sessionId, task)
      if (!verified.ok) {
        try { await sessionController.cancel({ sessionId }) } catch {}
        ownedSessions.delete(sessionId)
        return failAndClose(taskId, verified.code, verified.error, verified.hint)
      }

      const attached = await service.attachSession({ taskId, sessionId, requestId })
      if (!attached.ok) {
        try { await sessionController.cancel({ sessionId }) } catch {}
        ownedSessions.delete(sessionId)
        return attached
      }

      budget.begin(taskId)
      try {
        // requestId 落在持久记录里：重试同一个 requestId 时宿主返回原接受结果，不会重复入队。
        // 真实 DSH sessionController.prompt(request, signal) 的第二个参数是 AbortSignal（由宿主调用 signal.throwIfAborted()），
        // 调用元信息 source 由宿主从 request.requestId 内部构造，不能把普通对象作为第二参数传给 prompt。
        const promptSignal = new AbortController().signal
        await sessionController.prompt(
          { sessionId, requestId, content: [{ type: 'text', text: taskPromptText({ goal: goal ?? task.goal, workspaceRoot, mode: task.mode }) }] },
          promptSignal,
        )
      } catch (error) {
        try { await sessionController.cancel({ sessionId }) } catch {}
        return failAndClose(taskId, 'TASK_PROMPT_REJECTED', `会话拒绝接收任务：${error?.message || error}`)
      }
      // accepted 只代表"已入队"，完成与否要等 turn/end。
      return { ok: true, sessionId, requestId }
    }

    const guardedStart = () => startSession().catch((error) =>
      failAndClose(taskId, 'TASK_DISPATCH_FAILED', `派发本机任务失败：${error?.message || error}`),
    )

    if (background) {
      void guardedStart()
      return { ok: true, async: true, taskId, requestId }
    }
    return guardedStart()
  }

  async function cancel(taskId, actor) {
    const view = service.queryTask({ taskId })
    if (!view.ok) return view
    const task = view.task
    if (!task.dshSessionId) {
      const stopped = await service.cancelTask({ actor, taskId })
      if (!stopped.ok) return stopped
      forgetTaskTracking(taskId)
      return { ok: true, task: stopped.task, cancelledTurn: false }
    }

    // 先写停止屏障，但先不把状态假写成 cancelled、也不释放并发席位。
    const stopPending = await service.requestStop({ actor, taskId })
    if (!stopPending.ok) return stopPending

    let cancelError = null
    let accepted = false
    try {
      const ack = await sessionController.cancel({ sessionId: task.dshSessionId })
      accepted = ack?.accepted !== false
      if (!accepted) cancelError = new Error('宿主返回 accepted=false')
    } catch (error) {
      cancelError = error
    }

    if (!accepted) {
      // 取消失败：不能假装已停止，也不能让后续排队任务越过仍在执行的旧任务。
      const detail = String(cancelError?.message || cancelError || 'cancel rejected')
      const reconciled = await service.markNeedsReconciliation({
        taskId,
        reason: 'cancel-failed',
        error: {
          code: 'TASK_CANCEL_UNCONFIRMED',
          error: `停止会话未获确认：${detail}`,
          hint: '原会话可能仍在执行，已保留并发保护；先在原生会话确认停止或重启 DSH',
        },
        keepActiveSeat: true,
      })
      if (!reconciled.ok) return reconciled
      return failure(
        'TASK_CANCEL_UNCONFIRMED',
        `取消任务失败（宿主未确认停止）：${detail}`,
        '原任务可能仍在执行，已标为需要复核且不会派发下一条；请打开原生会话核对或重启 DSH',
        { uncertain: true, cancelledTurn: false, task: reconciled.task },
      )
    }

    const confirmed = await service.confirmCancelled({ taskId })
    if (!confirmed.ok) return confirmed
    forgetTaskTracking(taskId)
    void pumpQueue()
    return { ok: true, task: confirmed.task, cancelledTurn: true }
  }

  /** Gate 卸载时立即停掉对应模式的在途任务；无法确认停止则标记 needs_reconciliation。 */
  async function handleGateChange(live, gatePresetId = presetId) {
    if (live) {
      void pumpQueue()
      return
    }
    const snapshot = service.queryTask({})
    const inFlight = snapshot.tasks.filter((t) =>
      (t.executionStatus === 'running' || t.executionStatus === 'waiting')
      && presetForTask(t) === gatePresetId)
    for (const task of inFlight) {
      await service.requestStop({ actor: task.trustedActor, taskId: task.taskId, reason: 'gate-unmounted', allowSystem: true })
      let cancelConfirmed = !task.dshSessionId
      if (task.dshSessionId) {
        try {
          const ack = await sessionController.cancel({ sessionId: task.dshSessionId })
          cancelConfirmed = ack?.accepted !== false
        } catch {
          cancelConfirmed = false
        }
      }
      if (!cancelConfirmed) {
        const reconciled = await service.markNeedsReconciliation({
          taskId: task.taskId,
          reason: 'gate-unmounted-cancel-unconfirmed',
          error: {
            code: 'TASK_POLICY_UNMOUNTED',
            error: '权限闸门卸载时停止会话未获确认，可能仍有在途工具调用',
            hint: '先检查工作区与原生会话状态，确认已停止并恢复闸门后再重发',
          },
          keepActiveSeat: true,
        })
        if (reconciled?.ok && !reconciled.ignored) {
          try { await onFinished(reconciled.task, 'needs_reconciliation') } catch {}
        }
      } else {
        const finished = await service.finish({
          taskId: task.taskId,
          status: 'failed',
          resultRefs: task.dshSessionId ? [`dsh-session:${task.dshSessionId}`] : [],
          error: {
            code: 'TASK_POLICY_UNMOUNTED',
            error: '本机任务权限闸门已卸载，已中止当前执行',
            hint: '恢复闸门后如有需要请重新发起任务',
          },
        })
        forgetTaskTracking(task.taskId)
        if (finished?.ok && !finished.ignored) {
          try { await onFinished(finished.task, 'failed') } catch {}
        }
      }
    }
  }

  /** Host 卸载/重载时中止在途会话并标记 needs_reconciliation（关闭域前落盘）。 */
  async function handleHostUnloading() {
    const snapshot = service.queryTask({})
    const inFlight = snapshot.tasks.filter((t) => t.executionStatus === 'running' || t.executionStatus === 'waiting')
    for (const task of inFlight) {
      if (task.dshSessionId) {
        try { await sessionController.cancel({ sessionId: task.dshSessionId }) } catch {}
      }
      await service.markNeedsReconciliation({
        taskId: task.taskId,
        reason: 'host-unloading',
        error: {
          code: 'TASK_HOST_UNLOADED',
          error: '宿主插件卸载/热重载时任务仍在执行，无法确认是否完成',
          hint: '重新加载后先核对工作区与原生会话，再决定是否重发',
        },
        keepActiveSeat: false,
      })
      forgetTaskTracking(task.taskId)
    }
  }

  function attach() {
    detaching = false
    if (!disposeEvents && typeof subscribe === 'function') {
      disposeEvents = subscribe(observe)
    }
    if (!disposeGate && typeof subscribeGate === 'function') {
      disposeGate = subscribeGate((live) => { void handleGateChange(live, presetId) })
    }
    if (!disposeDesktopGate && typeof subscribeDesktopGate === 'function') {
      disposeDesktopGate = subscribeDesktopGate((live) => { void handleGateChange(live, DESKTOP_PRESET_ID) })
    }
    return () => detach()
  }

  function detach() {
    detaching = true
    if (typeof disposeEvents === 'function') disposeEvents()
    disposeEvents = null
    if (typeof disposeGate === 'function') disposeGate()
    disposeGate = null
    if (typeof disposeDesktopGate === 'function') disposeDesktopGate()
    disposeDesktopGate = null
    ownedSessions.clear()
  }

  return {
    dispatch,
    cancel,
    observe,
    admitLlmStream,
    pumpQueue,
    handleGateChange,
    handleHostUnloading,
    ownsSession,
    attach,
    detach,
    presetId,
  }
}
