// 一个 Task = 一个专用 DSH 会话（T04）：装配在册 → 送首条 prompt → 按事件投影状态。
//
// 只调用宿主公开的 `ctx.sessionController`（create / prompt / cancel），不自己
// 造执行器、不直接跑 agent loop：契约明确"不复用就不算完成"。所有调用都是
// "接受"语义（`accepted:true` = 消息已入队），完成与否只由会话事件判定。
import { taskGateIsLive, TASK_ALLOWED_TOOLS } from './local-task-gate.mjs'

export const TASK_PRESET_ID = 'local-task'

const TURN_END_CANCEL = new Set(['aborted', 'cancelled'])

function failure(code, error, hint) {
  return { ok: false, code, error, hint }
}

export function taskPromptText({ goal, workspaceRoot }) {
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
 * @param service          TaskService（唯一写入者）
 * @param sessionController 宿主 ctx.sessionController
 * @param subscribe        (fn) => dispose，接 `session/event`
 * @param isGateLive       闸门存活判定（默认查 local-task-gate 的登记表）
 * @param workspaceRoot    任务工作区（canonicalRoot）
 * @param newRequestId     requestId 生成器（持久化后重发同一 requestId 才算幂等）
 */
export function createLocalTaskRunner({ onFinished = () => {},
  service,
  sessionController,
  agents,
  agentPresets,
  tools,
  allowedTools = new Set(TASK_ALLOWED_TOOLS),
  subscribe,
  isGateLive = taskGateIsLive,
  presetId = TASK_PRESET_ID,
  workspaceRoot,
  newRequestId,
}) {
  if (!service || !sessionController) throw new TypeError('local-task-runner: service 与 sessionController 必填')
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new TypeError('local-task-runner: workspaceRoot 必填')
  if (typeof newRequestId !== 'function') throw new TypeError('local-task-runner: newRequestId 必填')
  let dispose = null

  function observe(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !sessionId) return
    const found = service.queryTask({}).tasks.find((task) => task.dshSessionId === sessionId)
    if (!found) return
    if (typeof event?.seq === 'number') {
      const noted = service.noteEvent({ taskId: found.taskId, seq: event.seq })
      if (noted.ignored === 'stale') return
    }
    if (event?.type !== 'turn/end') return
    const reason = event?.data?.reason
    // 停止意图优先：取消后迟到的 turn/end 不得把任务改回成功（T02 已保证 cancelled 不被覆盖，
    // 这里不进 finish 分支，避免产生无意义的 ignored 记录）。
    if (found.stopRequest) return
    const status = TURN_END_CANCEL.has(reason) ? 'cancelled' : reason === 'error' ? 'failed' : 'succeeded'
    const result = service.finish({
      taskId: found.taskId,
      status,
      resultRefs: [`dsh-session:${sessionId}`],
      error: status === 'failed' ? { code: 'TASK_TURN_FAILED', error: `会话回合失败（${reason}）`, hint: '打开原生会话看工具调用，或重发任务' } : null,
    })
    // 执行状态收敛后立刻交给投递层：状态和投递是两件事，投递失败不能改回执行结果。
    if (result?.ok && !result.ignored) {
      try { onFinished(result.task ?? found, status) } catch {}
    }
    return result
  }

  /** 装配是否真的落地：靠这一层的证据，不靠"创建时校验过一次"。 */
  function verifySurface(sessionId) {
    const agent = agents?.get?.(sessionId)
    if (!agent) return failure("TASK_SESSION_MISSING", "刚创建的会话取不到 agent", "重启 DSH 后重试；期间不要派发新任务")
    const preset = agentPresets?.composedPreset?.(agent.ctx)
    if (preset !== presetId) {
      // 回落到别的 preset = 工具面不受本任务约束，绝不能把 prompt 送进去。
      return failure("TASK_POLICY_MISMATCH", `会话装配的是「${preset ?? "未知"}」而不是「${presetId}」`, "检查 dsh.bundle.patch 是否装了 local-task 预设，重启 DSH 后重试")
    }
    let names = []
    try { names = (tools?.schemas?.(agent) ?? []).map((item) => item?.name).filter((name) => typeof name === "string") } catch (error) {
      return failure("TASK_SURFACE_UNREADABLE", `读不到会话工具面：${error?.message || error}`, "重启 DSH 后重试；期间不要派发新任务")
    }
    const foreign = names.filter((name) => !(allowedTools.has(name)))
    if (foreign.length) return failure("TASK_TOOL_SURFACE_UNSAFE", `会话里出现了本任务不该有的工具：${foreign.join(",")}`, "改回 local-task 预设的装配行后重启 DSH；这条任务不要重试")
    // 闸门是本进程内注册的守卫：它的存活计数为 0 说明策略插件没挂上或已被卸载。
    if (!isGateLive(presetId)) return failure("TASK_POLICY_UNMOUNTED", `本机任务策略「${presetId}」当前不在册`, "重启 DSH 让 SurfCore 重新装配策略，再重试；期间不要派发新任务")
    return { ok: true }
  }

  async function dispatch(taskId, { goal } = {}) {
    const { failure: blocked, task } = service.requireRunning(taskId)
    if (blocked) return blocked
    if (task.dshSessionId) return failure("TASK_SESSION_EXISTS", "任务已绑定会话", "不要重复派发；用查询看状态")
    const requestId = task.requestId ?? newRequestId()

    let created
    try {
      created = await sessionController.create({ cwd: workspaceRoot, agentPreset: presetId })
    } catch (error) {
      return failAndClose(taskId, "TASK_SESSION_CREATE_FAILED", `创建任务会话失败：${error?.message || error}`)
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== "string" || !sessionId) return failAndClose(taskId, "TASK_SESSION_CREATE_FAILED", "会话创建没有返回 sessionId")

    // 先装配好策略再送首条 prompt：装配不合格就把会话取消掉，绝不送入。
    const verified = verifySurface(sessionId)
    if (!verified.ok) {
      try { await sessionController.cancel({ sessionId }) } catch {}
      return failAndClose(taskId, verified.code, verified.error)
    }

    const attached = service.attachSession({ taskId, sessionId, requestId })
    if (!attached.ok) return attached
    try {
      // requestId 落在持久记录里：重试同一个 requestId 时宿主返回原接受结果，不会重复入队。
      await sessionController.prompt(
        { sessionId, requestId, content: [{ type: "text", text: taskPromptText({ goal: goal ?? task.goal, workspaceRoot }) }] },
        { kind: "user", rpcId: requestId },
      )
    } catch (error) {
      try { await sessionController.cancel({ sessionId }) } catch {}
      return failAndClose(taskId, "TASK_PROMPT_REJECTED", `会话拒绝接收任务：${error?.message || error}`)
    }
    // accepted 只代表"已入队"，完成与否要等 turn/end。
    return { ok: true, sessionId, requestId }
  }

  function failAndClose(taskId, code, error) {
    service.finish({ taskId, status: 'failed', error: { code, error, hint: '看原生会话日志定位；这条任务不会自动重试' } })
    return failure(code, error, '看原生会话日志定位；这条任务不会自动重试')
  }

  async function cancel(taskId, actor) {
    const stopped = service.cancelTask({ actor, taskId })
    if (!stopped.ok) return stopped
    const sessionId = stopped.task.dshSessionId
    if (!sessionId) return { ok: true, task: stopped.task, cancelledTurn: false }
    try {
      // 只取消这个任务自己的活跃回合；keepInbox 由宿主保证，不影响别的会话。
      await sessionController.cancel({ sessionId })
      return { ok: true, task: stopped.task, cancelledTurn: true }
    } catch (error) {
      // 取消 ACK 失败不等于没停：任务状态已是 cancelled，但要把不确定报出去。
      return { ok: true, task: stopped.task, cancelledTurn: false, uncertain: true, error: String(error?.message || error) }
    }
  }

  function attach() {
    if (dispose || typeof subscribe !== 'function') return dispose
    dispose = subscribe(observe)
    return dispose
  }

  function detach() {
    if (typeof dispose === 'function') dispose()
    dispose = null
  }

  return { dispatch, cancel, observe, attach, detach, presetId }
}
