// 本机任务（T04 接线）：把 storageDomain 里的 Task 服务、专用会话 runner
// 和会话事件订阅挂到 Host 上。只在这一处创建实例——上层（QQ 入口、设置页）
// 通过 getLocalTasks() 拿同一个句柄，避免第二套状态。
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from './local-task-service.mjs'
import { createLocalTaskRunner } from './local-task-runner.mjs'

let runtime = null

export function getLocalTasks() {
  if (!runtime) {
    return {
      ok: false,
      code: 'LOCAL_TASK_NOT_READY',
      error: '本机任务服务还没装好',
      hint: '若持续出现：重启 DSH；仍不行就是宿主缺少 storageDomain / sessionController',
    }
  }
  return { ok: true, ...runtime }
}

export function mountLocalTasks(ctx, { workspaceRoot, log = () => {} } = {}) {
  if (typeof ctx?.inject !== 'function') return () => {}
  return ctx.inject(['storageDomain', 'agents', 'agentPresets', 'tools', 'sessionController'], (scoped) => {
    let closed = false
    let domain = null
    scoped.effect(() => () => {
      closed = true
      runtime = null
      try { domain?.close?.() } catch (error) { log('本机任务域关闭失败：', error?.message ?? error) }
    })
    ;(async () => {
      try {
        domain = await scoped.storageDomain.open(LOCAL_TASK_DOMAIN, { owner: 'surfcore-local-task' })
        if (closed) { try { domain.close?.() } catch {} ; return }
        const service = createLocalTaskService({ domain, newId: () => `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` })
        const runner = createLocalTaskRunner({
          service,
          sessionController: scoped.sessionController,
          agents: scoped.agents,
          agentPresets: scoped.agentPresets,
          tools: scoped.tools,
          workspaceRoot,
          newRequestId: () => `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        })
        // 重启对账：上一进程崩溃时还在跑的任务只能标 needs_reconciliation，绝不重放写入。
        service.reconcileOnBoot({ reason: 'host-started' })
        runner.attach()
        scoped.effect(() => () => runner.detach())
        // 会话事件在这里统一投影；别的会话 id 由 observe 自己过滤。
        const off = scoped.on('session/event', (session, event) => {
          try { runner.observe(session, event) }
          catch (error) { log('本机任务事件投影失败：', error?.message ?? error) }
        })
        scoped.effect(() => () => off?.())
        runtime = { service, runner, domain, presetId: runner.presetId }
        log(`本机任务服务已就绪（工作区 ${workspaceRoot}）`)
      } catch (error) {
        runtime = null
        log('本机任务服务装配失败：', error?.message ?? error)
      }
    })()
  })
}
