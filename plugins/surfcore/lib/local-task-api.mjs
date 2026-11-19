// 桥接进程 ↔ Host 的本机任务通道。
//
// 为什么需要它：QQ 消息只能由桥接收到（OneBot 在桥接里），而 Task 只能由 Host 持有
// （storageDomain 在 Host 里）。契约禁止桥接写账本，所以中间必须有一条只走回环、
// 带一次性令牌的 RPC——和 `memory-v2-api.mjs` 同一套做法（发现文件 + 令牌 + 同源校验），
// 不新造认证方式。
//
// 只开四个动作：submit / query / cancel / redeliver。没有"改任务""改状态"这类口子，
// 桥接拿不到比"发一条消息"更多的权限。

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { isLoopbackReq, sameOrigin, safeEqual, json, readBody } from './http-guard.js'

export const LOCAL_TASK_API_PREFIX = '/dsh-surfcore/local-task-api'

const fail = (code, error, hint) => ({ ok: false, code, error, hint })

function localOrigin(raw) {
  const value = new URL(raw)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) || !['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw new Error('Invalid local origin.')
  return value
}

export function createLocalTaskApi({ stateDir, currentDshUrl, getRuntime, getDefaultMode = () => 'files-only', maxBodyBytes = 64 * 1024 } = {}) {
  if (!path.isAbsolute(stateDir ?? '') || typeof currentDshUrl !== 'function' || typeof getRuntime !== 'function') throw new TypeError('Invalid local task transport configuration.')
  const token = randomBytes(32).toString('hex')
  const root = path.join(stateDir, 'local-task')
  const file = path.join(root, 'qq.json')
  let closed = false

  function writeDiscovery() {
    if (closed) return fail('LOCAL_TASK_TRANSPORT_CLOSED', '本机任务通道已关闭', '重启 DSH 后重试')
    try {
      const base = localOrigin(currentDshUrl())
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      const temporary = path.join(root, `.qq-${randomBytes(12).toString('hex')}.tmp`)
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, baseUrl: base.origin, api: LOCAL_TASK_API_PREFIX, scope: 'qq', token }))
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, file)
      try { fs.chmodSync(file, 0o600) } catch {}
      return { ok: true }
    } catch {
      return fail('LOCAL_TASK_DISCOVERY_FAILED', '本机任务发现文件写不出来', '检查 ~/.dsh 权限与当前 Host 回环地址')
    }
  }

  function reply(text, extra = {}) {
    return { ok: true, text, ...extra }
  }

  async function dispatch(runtime, input) {
    const source = input?.source
    const created = await runtime.service.submitTask({
      trustedActor: {
        platform: 'qq',
        botId: String(source?.botId ?? ''),
        channel: String(source?.channel ?? ''),
        conversationId: String(source?.conversationId ?? ''),
        userId: String(source?.userId ?? ''),
      },
      source: {
        botId: String(source?.botId ?? ''),
        channel: String(source?.channel ?? ''),
        conversationId: String(source?.conversationId ?? ''),
        messageId: String(source?.messageId ?? ''),
      },
      text: String(input?.text ?? ''),
      workspaceId: String(input?.workspaceId ?? 'default'),
      mode: typeof input?.mode === 'string' && input.mode ? input.mode : (getDefaultMode?.() || 'files-only'),
      origin: typeof input?.origin === 'string' && input.origin ? input.origin : 'command',
    })
    if (!created.ok) return created
    const taskId = created.task.taskId
    if (created.duplicate) return reply(`这条已经接过了，任务号 ${taskId}`, { taskId, duplicate: true, queued: created.task.executionStatus === 'queued' })
    // P1-2：queued 任务绝不得直接调 runner.dispatch()；必须等当前任务结束由 FIFO 队列派发。
    if (created.task.executionStatus === 'queued' || created.queued) {
      return reply(`已排队（前面还有任务在执行），任务号 ${taskId}`, { taskId, queued: true })
    }
    const started = await runtime.runner.dispatch(taskId)
    if (!started.ok) return { ...started, taskId }
    return reply(`已接收，任务号 ${taskId}`, { taskId, queued: false })
  }

  function formatPendingSummary(item, includeTaskId = false) {
    const base = includeTaskId ? `${item.id} [${item.taskId ?? '-'}] ${item.title}` : `${item.id} (${item.title})`
    if (!item?.notifyError) return base
    return `${base}（QQ通知未送达:${item.notifyError.code}，请到设置页确认）`
  }

  function describeAll(runtime, taskId) {
    const pendingInteractions = runtime.interactions?.listPending?.(taskId ? { taskId } : {}) ?? []
    if (taskId) {
      const one = runtime.service.queryTask({ taskId })
      if (!one.ok) return one
      const extra = pendingInteractions.length
        ? `\n等待确认：${pendingInteractions.map((i) => formatPendingSummary(i, false)).join('; ')}`
        : ''
      return reply(runtime.service.describeTask(one.task) + extra, { taskId, pendingInteractions })
    }
    const all = runtime.service.queryTask({})
    const prefix = all.quarantined ? '⚠️ 存储域已隔离核对，当前暂停派发新任务。\n' : ''
    const tasks = all.tasks.slice(0, 10)
    const pendingLine = pendingInteractions.length
      ? `\n等待确认：${pendingInteractions.map((i) => formatPendingSummary(i, true)).join('；')}`
      : ''
    if (!tasks.length && !pendingInteractions.length) return reply(prefix ? prefix.trim() : '还没有任务', { pendingInteractions })
    const lines = tasks.map((task) => runtime.service.describeTask(task).split('\n')[0])
    return reply((prefix + lines.join('\n') + pendingLine).trim(), { pendingInteractions })
  }

  async function handle(req, res, url) {
    if (url?.pathname !== LOCAL_TASK_API_PREFIX || url.search) { json(res, 404, fail('LOCAL_TASK_ROUTE_INVALID', '本机任务接口不存在', '用设置页查看任务')); return }
    if (closed || !safeEqual(req.headers?.['x-local-task-token'], token)) { json(res, 403, fail('LOCAL_TASK_AUTH_REQUIRED', '本机任务令牌无效', '重启 DSH 让桥接重新读取发现文件')); return }
    if (!isLoopbackReq(req)) { json(res, 403, fail('LOCAL_TASK_ORIGIN_REJECTED', '本机任务接口只接受本机回环 Host', '从这个机器上的 QQ 桥接调用')); return }
    let base
    try { base = localOrigin(currentDshUrl()) } catch { json(res, 403, fail('LOCAL_TASK_ORIGIN_REJECTED', '当前 Host 地址不可用', '重启 DSH 后重试')); return }
    if (!sameOrigin(req) || String(req.headers.host).toLowerCase() !== base.host.toLowerCase()) { json(res, 403, fail('LOCAL_TASK_ORIGIN_REJECTED', '本机任务请求来源被拒绝', '只允许同源回环调用')); return }
    if (req.method !== 'POST') { json(res, 405, fail('LOCAL_TASK_METHOD_INVALID', '本机任务接口只接受 POST', '改用 POST')) ; return }
    let body
    try { body = JSON.parse((await readBody(req, maxBodyBytes)) || '{}') } catch { json(res, 400, fail('LOCAL_TASK_JSON_INVALID', '请求体不是合法 JSON', '重发一次；不要手工拼请求')) ; return }
    const runtime = getRuntime()
    if (!runtime?.ok) { json(res, 503, runtime ?? fail('LOCAL_TASK_NOT_READY', '本机任务还没装配好', '重启 DSH 后重试')); return }
    try {
      if (body.action === 'submit') { json(res, 200, await dispatch(runtime, body)); return }
      if (body.action === 'query') { json(res, 200, describeAll(runtime, String(body.taskId ?? ''))); return }
      if (body.action === 'cancel') {
        const taskId = String(body.taskId ?? '')
        const actor = runtime.service.queryTask({ taskId }).task?.trustedActor ?? null
        const stopped = await runtime.runner.cancel(taskId, actor)
        json(res, 200, stopped.ok ? reply(`已停止 ${taskId}`, { taskId, uncertain: stopped.uncertain === true }) : stopped)
        return
      }
      if (body.action === 'redeliver') {
        const taskId = String(body.taskId ?? '').trim()
        if (!taskId) { json(res, 200, fail('TASK_ID_REQUIRED', '缺少要补发的任务号', '先发「本机任务列表」确认任务号')); return }
        if (typeof runtime.redeliver !== 'function') {
          json(res, 503, fail('LOCAL_TASK_REDELIVER_UNSUPPORTED', '当前运行时未装配结果补发接口', '重启 DSH 后重试'))
          return
        }
        json(res, 200, await runtime.redeliver(taskId))
        return
      }
      if (body.action === 'answer') {
        if (typeof runtime.interactions?.answer !== 'function') {
          json(res, 503, fail('LOCAL_TASK_ANSWER_UNSUPPORTED', '当前运行时未装配交互确认接口', '重启 DSH 后重试'))
          return
        }
        json(res, 200, runtime.interactions.answer({
          id: body.interactionId ?? body.id,
          decision: body.decision,
          answerText: body.answerText ?? body.text,
          actor: body.source ?? null,
        }))
        return
      }
      json(res, 400, fail('LOCAL_TASK_ACTION_INVALID', `不认识的动作：${String(body.action ?? '')}`, '只支持 submit / query / cancel / redeliver / answer'))
    } catch (error) {
      json(res, 500, fail('LOCAL_TASK_HANDLER_FAILED', `本机任务接口出错：${String(error?.message ?? error)}`, '重启 DSH 后重试；已落盘的任务不会丢'))
    }
  }

  function close() { closed = true }

  return Object.freeze({ prefix: LOCAL_TASK_API_PREFIX, writeDiscovery, handle, close })
}
