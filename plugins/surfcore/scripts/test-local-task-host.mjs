// T04 + P0-2 + P1-7/8 接线与攻击测试：
// Host 装配、事件投影、P0-2 闸门卸载在途攻击测试（不伤普通 DSH 会话）、
// P1-7 先持久 sending 再发送再落 delivered/uncertain、P1-8 真实结果补发且不重跑文件操作。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mountLocalTasks, getLocalTasks } from '../lib/local-task-host.mjs'
import { createLocalTaskGate } from '../lib/local-task-gate.mjs'

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-host-ws-'))
fs.writeFileSync(path.join(workspaceRoot, 'note.txt'), 'hello')

function fakeCtx({ withDomain = true, seed = [], onPut = null, callBridgeResult = null } = {}) {
  const effects = []
  const listeners = []
  const guards = []
  const writeIntentHooks = []
  const llmStreamHooks = []
  const opened = []
  const cancelledSessions = []
  const createdSessions = []
  const promptedSessions = []
  const services = {
    storageDomain: withDomain ? {
      async open(spec) {
        const store = new Map()
        for (const record of seed) store.set(record.taskId, record)
        opened.push(spec)
        return {
          spec,
          table() {
            return {
              get: (k) => store.get(k),
              keys: () => [...store.keys()],
              entries: () => [...store.entries()],
              get size() { return store.size },
              put: async (k, v) => {
                spec.tables.tasks.valueSchema.parse(v)
                if (onPut) await onPut(k, structuredClone(v))
                store.set(k, v)
              },
              delete: async (k) => store.delete(k),
            }
          },
          close: async () => { opened.closed = true },
        }
      },
    } : undefined,
    sessionController: {
      create: async (req) => {
        createdSessions.push(req)
        return { sessionId: `s${createdSessions.length}` }
      },
      prompt: async (req) => {
        promptedSessions.push(req)
        return { accepted: true }
      },
      cancel: async (req) => {
        cancelledSessions.push(req)
        return { accepted: true }
      },
    },
    agents: { get: (id) => ({ id, ctx: { preset: 'local-task' }, session: { id, header: { cwd: workspaceRoot } } }) },
    agentPresets: { composedPreset: (c) => c?.preset ?? 'local-task' },
    tools: {
      schemas: () => [{ name: 'read' }, { name: 'write' }],
      guard(fn) {
        guards.push(fn)
        return () => {
          const i = guards.indexOf(fn)
          if (i >= 0) guards.splice(i, 1)
        }
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { effects.push(fn()) },
    on: (name, fn, opts) => {
      if (name === 'fs/write-intent') {
        const entry = { fn, prepend: Boolean(opts?.prepend) }
        if (entry.prepend) writeIntentHooks.unshift(entry)
        else writeIntentHooks.push(entry)
        return () => {
          const i = writeIntentHooks.indexOf(entry)
          if (i >= 0) writeIntentHooks.splice(i, 1)
        }
      }
      if (name === 'llm/stream') {
        const entry = { fn, prepend: Boolean(opts?.prepend) }
        if (entry.prepend) llmStreamHooks.unshift(entry)
        else llmStreamHooks.push(entry)
        return () => {
          const i = llmStreamHooks.indexOf(entry)
          if (i >= 0) llmStreamHooks.splice(i, 1)
        }
      }
      listeners.push({ name, fn })
      return () => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1) }
    },
    inject(deps, cb) {
      const missing = deps.filter((d) => !services[d])
      if (missing.length) return () => {}
      const scoped = { ...ctx, ...services }
      cb(scoped)
      return () => {}
    },
  }
  const checkAllGuards = (exec) => {
    for (const g of [...guards]) {
      const reason = g(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
  const runWriteIntent = (target, actor) => {
    let i = 0
    const next = () => {
      const entry = writeIntentHooks[i++]
      return entry ? entry.fn(target, actor, next) : undefined
    }
    return next()
  }
  const runLlmStream = (options, upstream) => {
    let i = 0
    const next = () => {
      const entry = llmStreamHooks[i++]
      return entry ? entry.fn(options, next) : upstream()
    }
    return next()
  }
  return {
    ctx,
    effects,
    listeners,
    guards,
    opened,
    cancelledSessions,
    createdSessions,
    promptedSessions,
    checkAllGuards,
    runWriteIntent,
    runLlmStream,
  }
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. 装配成功 → 句柄可用，域按 spec 打开
{
  const h = fakeCtx()
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  assert.equal(runtime.ok, true)
  assert.equal(runtime.presetId, 'local-task')
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].name, 'surfcore_local_task')
  for (const dispose of h.effects) await dispose()
  pass('装配成功并可取到句柄')
}

// 2. 会话事件被转发到 runner（同一 session 的 turn/end 落到任务上）
{
  let disposeGate
  const h = fakeCtx()
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const { service } = getLocalTasks()
  const submitted = await service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm1' },
    text: '整理周报',
    workspaceId: 'w1',
  })
  const dispatched = await getLocalTasks().runner.dispatch(submitted.task.taskId)
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const listener = h.listeners.find((l) => l.name === 'session/event')
  assert.ok(listener, '必须订阅 session/event')
  await listener.fn({ id: dispatched.sessionId }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(20)
  assert.equal(service.queryTask({ taskId: submitted.task.taskId }).task.executionStatus, 'succeeded')
  for (const dispose of h.effects) await dispose()
  disposeGate()
  pass('会话事件转发到任务投影')
}

// 3. 卸载 → 句柄失效，域被关闭，在途任务标记 needs_reconciliation
{
  const h = fakeCtx()
  let disposeGate
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-unload' },
    text: '卸载测试',
    workspaceId: 'w1',
  })
  await runtime.runner.dispatch(sub.task.taskId)
  assert.equal(getLocalTasks().ok, true)
  for (const dispose of h.effects) await dispose()
  assert.equal(getLocalTasks().ok, false)
  assert.equal(getLocalTasks().code, 'LOCAL_TASK_NOT_READY')
  assert.equal(h.opened.closed, true)
  assert.equal(h.cancelledSessions.length, 1, 'Host 卸载时必须尝试停止在途会话')
  disposeGate()
  pass('卸载后句柄失效、取消在途会话并关闭域')
}

// 4. 宿主缺 storageDomain → 句柄保持未就绪，不抛错
{
  const h = fakeCtx({ withDomain: false })
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  assert.equal(getLocalTasks().ok, false)
  pass('缺 storageDomain 时保持未就绪')
}

// 5. 装配即对账：上一进程崩溃时还在跑的任务被标 needs_reconciliation，且不重发 prompt
{
  const seed = [{
    taskId: 'task-crashed', trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm1', key: 'b|private|c|m1', textHash: 'h' },
    goal: '整理周报', workspaceId: 'w1', grantId: null, grantVersion: 0, dshSessionId: 's-crashed',
    executionStatus: 'running', stopRequest: null, controlEpoch: 1, lastEventPosition: 3,
    commands: [], deliveries: [], resultRefs: [], createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
  }]
  const h = fakeCtx({ seed })
  let prompted = 0
  h.ctx.get('sessionController').prompt = async () => { prompted++; return { accepted: true } }
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  assert.equal(runtime.ok, true)
  const stored = runtime.service.queryTask({ taskId: 'task-crashed' }).task
  assert.equal(stored.executionStatus, 'needs_reconciliation')
  assert.equal(stored.reconcileReason, 'host-started')
  assert.equal(prompted, 0, '对账不得重放 prompt')
  for (const dispose of h.effects) await dispose()
  pass('装配即对账且不重放')
}

// 6. P0-2 攻击测试：启动运行任务 → 卸载 gate → 尝试工作区外 read → 拒绝工具调用且原任务已停止不可派发，同时不影响普通 DSH Session
{
  const h = fakeCtx()
  let disposeGate
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const runtime = getLocalTasks()

  // (1) 启动一个运行中的任务
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-p02' },
    text: '在途权限攻击测试',
    workspaceId: 'w1',
  })
  const dispatched = await runtime.runner.dispatch(sub.task.taskId)
  assert.equal(dispatched.ok, true)

  // 运行期间普通 DSH Session 与工作区内 read 都正常
  const ordinaryExec = {
    name: 'read',
    arguments: { file_path: '/etc/hosts' },
    agent: { ctx: { preset: 'standard' }, session: { id: 'ordinary-session-1', header: { cwd: '/tmp/other' } } },
  }
  assert.equal(h.checkAllGuards(ordinaryExec), undefined, '普通 DSH Session 不受本机任务守卫影响')
  const validLocalExec = {
    name: 'read',
    arguments: { file_path: 'note.txt' },
    agent: { ctx: { preset: 'local-task' }, session: { id: dispatched.sessionId, header: { cwd: workspaceRoot } } },
  }
  assert.equal(h.checkAllGuards(validLocalExec), undefined)

  // (2) 卸载 gate（模拟热重载 / 正常停用 / 异常卸载）
  disposeGate()
  await tick(20)

  // (3) 在途工具尝试执行工作区外 read（以及工作区内 read）
  const attackOutsideExec = {
    name: 'read',
    arguments: { file_path: '/etc/passwd' },
    agent: { ctx: { preset: 'local-task' }, session: { id: dispatched.sessionId, header: { cwd: workspaceRoot } } },
  }
  const denialOutside = h.checkAllGuards(attackOutsideExec)
  assert.equal(typeof denialOutside, 'string', 'gate 卸载后工作区外 read 必须被宿主守卫拒绝')
  assert.match(denialOutside, /策略未确认在册/)

  const denialInside = h.checkAllGuards(validLocalExec)
  assert.equal(typeof denialInside, 'string', 'gate 卸载后连工作区内 read 也必须 fail-closed 拒绝')

  // (4) 原任务已停止且不能继续派发
  const taskAfter = runtime.service.queryTask({ taskId: sub.task.taskId }).task
  assert.equal(taskAfter.executionStatus, 'failed')
  assert.equal(taskAfter.error?.code, 'TASK_POLICY_UNMOUNTED')
  assert.equal(h.cancelledSessions.length, 1, 'gate 卸载时必须中止运行中的 DSH 会话')
  const second = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-p02-2' },
    text: '再派一个',
    workspaceId: 'w1',
  })
  const blocked = await runtime.runner.dispatch(second.task.taskId)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'TASK_POLICY_UNMOUNTED')

  // 普通 DSH Session 在 gate 卸载后依然完全不受影响
  assert.equal(h.checkAllGuards(ordinaryExec), undefined, 'gate 卸载后普通 DSH Session 仍不受影响')

  for (const dispose of h.effects) await dispose()
  pass('P0-2 攻击测试：卸载 gate 后在途越界 read 被拒、原任务中止且不影响普通 DSH Session')
}

// 7. P1-7 & P1-8：Delivery 先持久化 sending 再发送再落 uncertain/delivered；redeliver 只补发旧结果不重跑会话
{
  const putTrace = []
  let bridgeCalls = []
  let failSend = true
  let disposeGate
  const h = fakeCtx({
    onPut: (_k, val) => {
      if (val.deliveries?.length) {
        putTrace.push(val.deliveries.map((d) => d.state))
      }
    },
  })
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, {
    workspaceRoot,
    log: () => {},
    callBridge: async (endpoint, opts) => {
      bridgeCalls.push({ endpoint, opts, traceLenAtSend: putTrace.length, statesAtSend: putTrace.slice(-1)[0] })
      if (failSend) throw new Error('bridge 503')
      return { status: 200, data: { ok: true, receipt: { messageId: 888 } } }
    },
  })
  await tick()
  const runtime = getLocalTasks()
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-dlv' },
    text: '投递测试',
    workspaceId: 'w1',
  })
  const dispatched = await runtime.runner.dispatch(sub.task.taskId)
  const listener = h.listeners.find((l) => l.name === 'session/event')
  await listener.fn({ id: dispatched.sessionId }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(20)

  assert.equal(bridgeCalls.length, 1)
  assert.deepEqual(bridgeCalls[0].statesAtSend, ['sending'], '发送前必须已持久化 state=sending')
  let afterFirst = runtime.service.queryTask({ taskId: sub.task.taskId }).task
  assert.equal(afterFirst.deliveries[0].state, 'uncertain')

  // 现在恢复桥接，调用真实 redeliver 接口补发
  failSend = false
  const sessionsBeforeRedeliver = h.createdSessions.length
  const promptsBeforeRedeliver = h.promptedSessions.length
  const redelivered = await runtime.redeliver(sub.task.taskId)
  assert.equal(redelivered.ok, true)
  assert.equal(h.createdSessions.length, sessionsBeforeRedeliver, '补发绝不能新建会话')
  assert.equal(h.promptedSessions.length, promptsBeforeRedeliver, '补发绝不能再发 prompt 或重跑文件操作')
  assert.equal(bridgeCalls.length, 2)
  assert.deepEqual(bridgeCalls[1].statesAtSend, ['uncertain', 'sending'], '补发前也必须先持久化 sending')

  afterFirst = runtime.service.queryTask({ taskId: sub.task.taskId }).task
  assert.equal(afterFirst.deliveries[1].state, 'delivered')
  assert.deepEqual(afterFirst.deliveries[1].platformReceipt, { messageId: 888 })

  // 已送达后再调用 redeliver 幂等不重复外发
  const dupRedeliver = await runtime.redeliver(sub.task.taskId)
  assert.equal(dupRedeliver.ok, true)
  assert.equal(dupRedeliver.alreadyDelivered, true)
  assert.equal(bridgeCalls.length, 2)

  for (const dispose of h.effects) await dispose()
  disposeGate()
  pass('P1-7/P1-8 投递先落 sending 再发再落终态，真实补发不重跑文件任务')
}

// 8. Risk-1 闭环：llm/stream 兜底拦截所有模型请求（含不发 session/event 的辅助调用），第 31 次在发往上游前被拦截
{
  let disposeGate
  const h = fakeCtx()
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, { workspaceRoot, log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-llm' },
    text: '辅助模型拦截测试',
    workspaceId: 'w1',
  })
  const dispatched = await runtime.runner.dispatch(sub.task.taskId)
  const listener = h.listeners.find((l) => l.name === 'session/event')

  let upstreamCount = 0
  const drain = async (gen) => { for await (const _chunk of gen) {} }

  // 15 次正常对话（llm/stream + assistant/message 不重复计次）+ 15 次未知辅助调用（只走 llm/stream 不发 session/event）= 30 次
  for (let i = 0; i < 15; i++) {
    await drain(h.runLlmStream({ sessionId: dispatched.sessionId }, async function* () { upstreamCount++; yield { type: 'finish' } }))
    await listener.fn({ id: dispatched.sessionId }, { type: 'assistant/message', seq: i + 1, data: { attemptId: i + 1 } })
  }
  for (let i = 0; i < 15; i++) {
    await drain(h.runLlmStream({ sessionId: dispatched.sessionId, purpose: 'future-aux' }, async function* () { upstreamCount++; yield { type: 'finish' } }))
  }
  await tick(20)
  assert.equal(upstreamCount, 30)
  assert.equal(runtime.service.queryTask({ taskId: sub.task.taskId }).task.executionStatus, 'running')

  // 第 31 次在发往上游前被抛错拦截，upstreamCount 不增！
  await assert.rejects(
    () => drain(h.runLlmStream({ sessionId: dispatched.sessionId, purpose: 'future-aux' }, async function* () { upstreamCount++; yield { type: 'finish' } })),
    (err) => err.code === 'TASK_BUDGET_EXCEEDED',
  )
  assert.equal(upstreamCount, 30, '第 31 次必须在发往上游模型前被阻断')
  assert.equal(runtime.service.queryTask({ taskId: sub.task.taskId }).task.executionStatus, 'failed')

  // 普通 DSH 会话完全不受影响
  let ordinaryUpstream = 0
  await drain(h.runLlmStream({ sessionId: 'ordinary-session' }, async function* () { ordinaryUpstream++; yield { type: 'finish' } }))
  assert.equal(ordinaryUpstream, 1)

  for (const dispose of h.effects) await dispose()
  disposeGate()
  pass('Risk-1 llm/stream 兜底拦截未知辅助模型请求且不重复计次、不影响普通会话')
}

// 9. Failure visibility: HTTP 403 NOTIFY_SENSITIVE 等结构化拒绝不得被吞成 LOCAL_TASK_DELIVERY_UNCERTAIN
{
  let disposeGate
  const logs = []
  const h = fakeCtx()
  const callBridge403 = async () => ({
    ok: false,
    status: 403,
    data: {
      ok: false,
      code: 'NOTIFY_SENSITIVE',
      error: '通知正文疑似含敏感信息，已阻止发送',
      hint: '任务结果含密钥、凭据或受限系统路径；去掉敏感内容后再补发',
    },
  })
  createLocalTaskGate({ root: workspaceRoot }).apply({
    tools: h.ctx.get('tools'),
    effect: (fn) => { disposeGate = fn() },
    on: h.ctx.on,
    get: h.ctx.get,
  })
  mountLocalTasks(h.ctx, { workspaceRoot, callBridge: callBridge403, log: (m) => logs.push(String(m)) })
  await tick()
  const runtime = getLocalTasks()
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm-403' },
    text: '结构化拒绝透传测试',
    workspaceId: 'w1',
  })
  const dispatched = await runtime.runner.dispatch(sub.task.taskId)
  const listener = h.listeners.find((l) => l.name === 'session/event')
  await listener.fn({ id: dispatched.sessionId }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await tick(20)

  const after = runtime.service.queryTask({ taskId: sub.task.taskId }).task
  assert.equal(after.deliveries[0].state, 'uncertain')
  assert.equal(after.deliveries[0].error.code, 'NOTIFY_SENSITIVE')
  assert.ok(after.deliveries[0].error.hint)
  assert.ok(logs.some((line) => line.includes('NOTIFY_SENSITIVE')), '插件日志必须记录桥接拒绝原因')

  const retry = await runtime.redeliver(sub.task.taskId)
  assert.equal(retry.ok, false)
  assert.equal(retry.code, 'NOTIFY_SENSITIVE')
  assert.ok(retry.hint)

  for (const dispose of h.effects) await dispose()
  disposeGate()
  pass('投递遇 403 结构化错误时保留 code/hint 并写入日志，不再被吞成通用错误')
}

fs.rmSync(workspaceRoot, { recursive: true, force: true })
console.log(`${checks} checks passed`)
