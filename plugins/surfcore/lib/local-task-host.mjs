// 本机任务（T04 接线）：把 storageDomain 里的 Task 服务、专用会话 runner、
// 宿主兜底权限守卫和结果投递/补发挂到 Host 上。只在这一处创建实例——上层
// （QQ 入口、设置页）通过 getLocalTasks() 拿同一个句柄，避免第二套状态。
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from './local-task-service.mjs'
import { createLocalTaskRunner, TASK_PRESET_ID, extractTaskImagePaths } from './local-task-runner.mjs'
import { createLocalTaskApi } from './local-task-api.mjs'
import { createLocalTaskInteractions } from './local-task-interactions.mjs'
import { createTaskBudget } from './local-task-budget.mjs'
import { mountDesktopGate, taskGateDenyReason, taskGateIsLive } from './local-task-gate.mjs'

let runtime = null

const SETTLED_FOR_DELIVERY = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation'])

function fail(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
}

export function getLocalTasks() {
  if (!runtime) {
    return fail(
      'LOCAL_TASK_NOT_READY',
      '本机任务服务还没装好',
      '若持续出现：重启 DSH；仍不行就是宿主缺少 storageDomain / sessionController',
    )
  }
  return { ok: true, ...runtime }
}

export function mountLocalTasks(ctx, { workspaceRoot, stateDir, currentDshUrl, callBridge, getDefaultMode = () => 'files-only', log = () => {} } = {}) {
  if (typeof ctx?.inject !== 'function') return () => {}
  return ctx.inject(['storageDomain', 'agents', 'agentPresets', 'tools', 'sessionController'], (scoped) => {
    let closed = false
    let domain = null
    let runner = null
    let service = null
    let api = null

    scoped.effect(() => async () => {
      closed = true
      runtime = null
      try { api?.close?.() } catch {}
      try { await runner?.handleHostUnloading?.() } catch (error) { log('本机任务卸载停机失败：', error?.message ?? error) }
      try { await domain?.close?.() } catch (error) { log('本机任务域关闭失败：', error?.message ?? error) }
    })

    ;(async () => {
      try {
        domain = await scoped.storageDomain.open(LOCAL_TASK_DOMAIN, { owner: 'surfcore-local-task' })
        if (closed) { try { await domain.close?.() } catch {} ; return }

        const budget = createTaskBudget()
        service = createLocalTaskService({
          domain,
          newId: () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        })

        // 投递顺序刚性：先持久化 sending，再发往桥接，最后更新 delivered / uncertain。
        const deliver = async (task, status) => {
          const text = service.describeTask({ ...task, executionStatus: status })
          const deliveryId = `dlv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const sending = {
            deliveryId,
            kind: 'result',
            recipient: { channel: 'private', userId: task.trustedActor?.userId ?? '' },
            payload: text,
            state: 'sending',
            attemptedAt: new Date().toISOString(),
          }
          const pre = await service.recordDelivery({ taskId: task.taskId, delivery: sending })
          if (!pre.ok) return fail(pre.code, pre.error, pre.hint, { state: 'failed' })

          const images = Array.isArray(task.resultImages) && task.resultImages.length
            ? task.resultImages
            : extractTaskImagePaths(task.resultSummary, { workspaceRoot })

          try {
            const response = await callBridge?.('/api/notify/owner', {
              method: 'POST',
              body: {
                message: text,
                taskResult: {
                  taskId: task.taskId,
                  status,
                  mode: task.mode ?? 'files-only',
                  origin: task.origin ?? 'command',
                  goal: task.goal,
                  resultSummary: task.resultSummary ?? null,
                  ...(images.length ? { images } : {}),
                  error: task.error ? { code: task.error.code, error: task.error.error } : null,
                },
              },
              timeoutMs: 20000,
            })
            const delivered = Boolean(response && response.status >= 200 && response.status < 400 && response.data?.ok !== false)
            let patch
            if (delivered) {
              patch = {
                state: 'delivered',
                completedAt: new Date().toISOString(),
                platformReceipt: response?.data?.receipt ?? null,
              }
            } else {
              const hasStructuredCode = typeof response?.data?.code === 'string' && response.data.code.length > 0
              const errCode = hasStructuredCode ? response.data.code : 'LOCAL_TASK_DELIVERY_UNCERTAIN'
              const errMsg = hasStructuredCode && typeof response?.data?.error === 'string' && response.data.error
                ? response.data.error
                : '桥接未确认发送成功'
              const errHint = hasStructuredCode && typeof response?.data?.hint === 'string' && response.data.hint
                ? response.data.hint
                : '先核对 QQ 私聊是否收到，再决定是否补发；补发只发旧结果'
              const rawBridgeMsg = typeof response?.data?.error === 'string' ? response.data.error : ''
              log(`[local-task] 结果回传未确认 ${task.taskId} (HTTP ${response?.status ?? 'ERR'}): ${errCode} ${rawBridgeMsg || errMsg} | ${errHint}`)
              patch = {
                state: 'uncertain',
                completedAt: new Date().toISOString(),
                platformReceipt: response?.data?.receipt ?? null,
                error: { code: errCode, error: errMsg, hint: errHint },
              }
            }
            await service.updateDelivery({ taskId: task.taskId, deliveryId, patch })
            if (delivered) return { ok: true, deliveryId, state: 'delivered' }
            return fail(patch.error.code, patch.error.error, patch.error.hint, { deliveryId, state: 'uncertain', errorDetail: patch.error })
          } catch (error) {
            const errInfo = {
              code: 'LOCAL_TASK_DELIVERY_FAILED',
              error: String(error?.message ?? error),
              hint: '核对 QQ 私聊是否收到；补发只发旧结果',
            }
            log(`[local-task] 结果回传异常 ${task.taskId}: ${errInfo.code} ${errInfo.error}`)
            await service.updateDelivery({
              taskId: task.taskId,
              deliveryId,
              patch: { state: 'uncertain', completedAt: new Date().toISOString(), error: errInfo },
            })
            return fail(errInfo.code, errInfo.error, errInfo.hint, { deliveryId, state: 'uncertain', errorDetail: errInfo })
          }
        }

        // 真实结果补发接口：只读取已有任务记录并重新走投递状态机，绝不再建会话或再执行文件工具。
        const redeliver = async (taskId) => {
          const view = service.queryTask({ taskId })
          if (!view.ok) return view
          const task = view.task
          if (!SETTLED_FOR_DELIVERY.has(task.executionStatus)) {
            return fail('TASK_NOT_SETTLED', '任务尚未结束，不能补发结果', '等任务完成或先停止后再补发')
          }
          const last = task.deliveries.slice(-1)[0]
          if (last?.state === 'sending') {
            return fail('TASK_DELIVERY_IN_FLIGHT', '已有回传正在发送中', '稍候再查询任务状态，不要重复并发发送')
          }
          if (last?.state === 'delivered') {
            return {
              ok: true,
              alreadyDelivered: true,
              task,
              delivery: last,
              text: `任务 ${task.taskId} 的结果已确认送达，无需重复补发`,
            }
          }
          const outcome = await deliver(task, task.executionStatus)
          const updated = service.queryTask({ taskId }).task ?? task
          if (!outcome.ok) {
            return fail(
              outcome.code ?? 'LOCAL_TASK_DELIVERY_UNCERTAIN',
              typeof outcome.error === 'string' ? outcome.error : (outcome.error?.error ?? '补发结果未确认送达'),
              outcome.hint ?? '先核对 QQ 私聊是否收到，再决定是否再次补发',
              { task: updated, deliveryId: outcome.deliveryId, uncertain: outcome.state === 'uncertain' },
            )
          }
          return {
            ok: true,
            task: updated,
            deliveryId: outcome.deliveryId,
            text: `已补发任务 ${task.taskId} 的结果`,
          }
        }

        const desktopPolicy = mountDesktopGate(scoped, {
          ownsSession: (sessionId) => {
            if (typeof sessionId !== 'string' || !sessionId) return false
            const task = service.findBySessionId(sessionId)
            if (task) return task.mode === 'desktop'
            return Boolean(runner?.ownsSession?.(sessionId))
          },
          isHealthy: () => !closed && !service.isQuarantined(),
        })

        const interactions = createLocalTaskInteractions({
          scoped,
          service,
          ownsSession: (sessionId) => Boolean(runner?.ownsSession?.(sessionId) || service.isTaskSession(sessionId)),
          callBridge,
          log,
        })

        runner = createLocalTaskRunner({
          service,
          sessionController: scoped.sessionController,
          agents: scoped.agents,
          agentPresets: scoped.agentPresets,
          tools: scoped.tools,
          budget,
          workspaceRoot,
          onSessionCreated: ({ task, sessionId }) => {
            if (task?.mode === 'desktop') desktopPolicy.prepareSessionAgent(sessionId)
          },
          onFinished: (task, status) => deliver(task, status),
          newRequestId: () => `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        })

        // 严格判定是否属于仅文件本机任务会话，绝不影响普通 DSH 会话或桌面任务会话的编辑能力。
        const isLocalTaskExec = (exec) => {
          const sessionId = exec?.agent?.session?.id
          if (typeof sessionId === 'string' && sessionId) {
            const task = service.findBySessionId(sessionId)
            if (task) return task.mode !== 'desktop'
          }
          const agentCtx = exec?.agent?.ctx
          if (agentCtx && scoped.agentPresets?.composedPreset?.(agentCtx) === TASK_PRESET_ID) return true
          return false
        }

        const isSessionHealthy = (exec) => {
          if (closed || !taskGateIsLive(TASK_PRESET_ID) || service.isQuarantined()) return false
          const sessionId = exec?.agent?.session?.id
          const task = typeof sessionId === 'string' && sessionId ? service.findBySessionId(sessionId) : null
          if (!task) return true
          if (task.stopRequest) return false
          if (['cancelled', 'failed', 'succeeded', 'needs_reconciliation'].includes(task.executionStatus)) return false
          if (budget.check(task.taskId).ok === false) return false
          return true
        }

        // P0-2 宿主兜底守卫：即使 preset 内的 local-task-gate 被热重载或卸载，
        // 正在途中的本机任务工具调用仍会被 Host 守卫单调拒绝；普通 DSH 会话直接放行。
        if (typeof scoped.tools?.guard === 'function') {
          const disposeGuard = scoped.tools.guard((exec) => {
            if (!isLocalTaskExec(exec)) return undefined
            return taskGateDenyReason(exec, { root: workspaceRoot, healthy: isSessionHealthy(exec) })
          })
          scoped.effect(() => () => disposeGuard?.())
        }

        // P0-3 宿主兜底 write-intent：对本机任务会话同样强制返回 createIfAbsent。
        const offWriteIntent = scoped.on?.('fs/write-intent', (_target, actor, next) => {
          if (!isLocalTaskExec(actor)) return next()
          if (!isSessionHealthy(actor)) {
            throw new Error('本机任务策略未确认在册或任务已停止，拒绝文件写入')
          }
          return { kind: 'createIfAbsent' }
        }, { prepend: true })
        if (offWriteIntent) scoped.effect(() => () => offWriteIntent?.())

        // P1-9 兜底：拦截宿主所有 ctx.llm.stream（涵盖未知未来辅助模型调用），在请求发出前扣减并阻断超额调用。
        const offLlmStream = scoped.on?.('llm/stream', (options, next) => {
          const sessionId = options?.sessionId
          if (typeof sessionId !== 'string' || !sessionId || !service.isTaskSession(sessionId)) {
            return next()
          }
          return (async function* () {
            const decision = await runner.admitLlmStream(options)
            if (!decision.ok) {
              const err = new Error(`${decision.code}: ${decision.error}`)
              err.code = decision.code
              throw err
            }
            yield* next()
          })()
        }, { prepend: true })
        if (offLlmStream) scoped.effect(() => () => offLlmStream?.())

        // 重启对账：上一进程崩溃时还在跑的任务只能标 needs_reconciliation，绝不重放写入。
        const reconciled = await service.reconcileOnBoot({ reason: 'host-started' })
        if (!reconciled.ok) {
          log('本机任务启动对账失败：', reconciled.error)
        }
        if (closed) return

        runner.attach()
        scoped.effect(() => () => runner.detach())

        // 会话事件在这里统一投影；别的会话 id 由 observe 自己过滤。
        const off = scoped.on('session/event', (session, event) => {
          void Promise.resolve(runner.observe(session, event)).catch((error) => log('本机任务事件投影失败：', error?.message ?? error))
        })
        scoped.effect(() => () => off?.())

        const recoverQuarantine = async () => {
          const reopened = await scoped.storageDomain.open(LOCAL_TASK_DOMAIN, { owner: 'surfcore-local-task' })
          domain = reopened
          return service.recoverWithDomain(reopened, { reason: 'quarantine-recovered' })
        }

        api = stateDir && currentDshUrl ? createLocalTaskApi({ stateDir, currentDshUrl, getRuntime: getLocalTasks, getDefaultMode }) : null
        const discovery = api?.writeDiscovery?.()
        if (discovery && !discovery.ok) log('本机任务通道发现文件写入失败：', discovery.error)

        runtime = {
          service,
          runner,
          domain,
          api,
          interactions,
          desktopPolicy,
          deliver,
          redeliver,
          recoverQuarantine,
          presetId: runner.presetId,
        }
        log(`本机任务服务已就绪（工作区 ${workspaceRoot}）`)
      } catch (error) {
        runtime = null
        log('本机任务服务装配失败：', error?.message ?? error)
      }
    })()
  })
}
