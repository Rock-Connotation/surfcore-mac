// T04 + P0-2 + P1 契约测试：一 Task 一专用 Session、先装配后送首条 prompt、requestId 持久复用、
// 在途闸门卸载阻断与复核、并发 1 + FIFO 队列、取消失败锁席位、保守 turn/end 原因、DSH 全事件额度统计。
import assert from 'node:assert/strict'
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs'
import { createLocalTaskRunner, taskPromptText, TASK_PRESET_ID, classifyTurnEndReason } from '../lib/local-task-runner.mjs'
import { createLocalTaskGate, _gateLivenessCount } from '../lib/local-task-gate.mjs'

function makeDomain() {
  const store = new Map()
  return {
    table() {
      return {
        get: (key) => store.get(key),
        keys: () => [...store.keys()],
        entries: () => [...store.entries()],
        get size() { return store.size },
        async put(key, value) { LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(value); store.set(key, value) },
        async delete(key) { return store.delete(key) },
      }
    },
  }
}

const actor = { platform: 'qq', botId: 'bot-1', channel: 'private', conversationId: 'owner', userId: 'owner-1' }
const source = (messageId) => ({ botId: 'bot-1', channel: 'private', conversationId: 'owner', messageId })
const ROOT = '/tmp/local-task-workspace'
const text = '读取项目A的会议纪要，整理成周报'

function harness({ gateLive = true, presetId = TASK_PRESET_ID } = {}) {
  let n = 0
  let currentGateLive = gateLive
  const gateListeners = new Set()
  const finishedEvents = []
  const service = createLocalTaskService({
    domain: makeDomain(),
    now: () => new Date(2026, 10, 17, 12, 0, n).toISOString(),
    newId: () => `t${++n}`,
  })
  const created = []
  const prompted = []
  const cancelled = []
  let createError = null
  let createHook = null
  let promptError = null
  let cancelError = null
  let cancelAck = { accepted: true }
  const sessionController = {
    async create(request) {
      if (createHook) await createHook(request)
      if (createError) throw createError
      created.push(request)
      return { sessionId: `s${created.length}` }
    },
    async prompt(request, signal) {
      signal.throwIfAborted()
      if (promptError) throw promptError
      prompted.push({ request, signal })
      return { accepted: true }
    },
    async cancel(request) {
      if (cancelError) throw cancelError
      cancelled.push(request)
      return cancelAck
    },
  }
  const listeners = []
  const surface = { preset: presetId, toolNames: ['read', 'write'], agentMissing: false }
  const agents = { get: (id) => (surface.agentMissing ? undefined : { id, ctx: { id } }) }
  const agentPresets = { composedPreset: () => surface.preset }
  const tools = { schemas: () => surface.toolNames.map((name) => ({ name })) }
  const runner = createLocalTaskRunner({
    service,
    sessionController,
    agents,
    agentPresets,
    tools,
    presetId,
    subscribe: (fn) => { listeners.push(fn); return () => { listeners.length = 0 } },
    isGateLive: () => currentGateLive,
    subscribeGate: (fn) => { gateListeners.add(fn); return () => gateListeners.delete(fn) },
    workspaceRoot: ROOT,
    newRequestId: () => `r${++n}`,
    onFinished: (task, status) => { finishedEvents.push({ taskId: task.taskId, status }) },
  })
  runner.attach()
  const submit = (msgId = 'm1', goalText = text) => service.submitTask({ trustedActor: actor, source: source(msgId), text: goalText, workspaceId: 'w1' })
  return {
    service,
    runner,
    created,
    prompted,
    cancelled,
    listeners,
    surface,
    finishedEvents,
    submit,
    setGateLive: async (val) => {
      currentGateLive = val
      for (const fn of [...gateListeners]) fn(val)
      await new Promise((r) => setTimeout(r, 0))
    },
    setCreateHook: (fn) => { createHook = fn },
    failCreate: (error) => { createError = error },
    failPrompt: (error) => { promptError = error },
    failCancel: (error) => { cancelError = error },
    setCancelAck: (ack) => { cancelAck = ack },
    emit: async (sessionId, event) => {
      for (const fn of [...listeners]) await fn({ id: sessionId }, event)
    },
  }
}

const issue = (value, code) => {
  assert.equal(value.ok, false, `expected failure ${code}`)
  assert.equal(value.code, code)
  assert.ok(value.error, 'error 文案必填')
  assert.ok(value.hint, 'hint 下一步必填')
}

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

// 1. 闸门不在册 → 拒绝派发，且绝不建会话；若 create 期间卸载则取消会话
{
  const h = harness({ gateLive: false })
  const { task } = await h.submit()
  const result = await h.runner.dispatch(task.taskId)
  issue(result, 'TASK_POLICY_UNMOUNTED')
  assert.equal(h.created.length, 0, '闸门不在册时绝不建会话')
  assert.equal(h.prompted.length, 0, '闸门不在册时绝不能送 prompt')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.dshSessionId, null)

  const h2 = harness({ gateLive: true })
  const { task: task2 } = await h2.submit('m2')
  h2.setCreateHook(async () => { await h2.setGateLive(false) })
  const r2 = await h2.runner.dispatch(task2.taskId)
  issue(r2, 'TASK_POLICY_UNMOUNTED')
  assert.equal(h2.prompted.length, 0)
  assert.equal(h2.cancelled.length, 1, 'create 期间闸门卸载必须取消已建会话')
  pass('闸门不在册：绝不建会话；建会话期间卸载则取消')
}

// 2. 正常派发：cwd + agentPreset，prompt 带持久 requestId，且只送一条
{
  const h = harness()
  const { task } = await h.submit()
  const result = await h.runner.dispatch(task.taskId)
  assert.equal(result.ok, true)
  assert.deepEqual(h.created[0], { cwd: ROOT, agentPreset: TASK_PRESET_ID })
  assert.equal(h.prompted.length, 1)
  const { request, signal } = h.prompted[0]
  assert.equal(request.sessionId, 's1')
  assert.equal(request.requestId, result.requestId)
  assert.equal(signal instanceof AbortSignal, true)
  assert.equal(signal.aborted, false)
  assert.ok(request.content[0].text.includes(ROOT), 'prompt 必须写明工作区')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.dshSessionId, 's1')
  assert.equal(stored.requestId, result.requestId)
  pass('派发建专用会话并送带 requestId 的首条 prompt')
}

// 3. 同一任务重复派发 → 拒绝，不建第二个会话
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_EXISTS')
  assert.equal(h.created.length, 1)
  pass('重复派发被拒')
}

// 4. turn/end 成功（含 DSH 对象 { kind: 'completed' } 与字符串） → succeeded，并推进 lastEventPosition
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.emit('s1', { type: 'turn/start', seq: 3, data: { turn: 1 } })
  await h.emit('s1', { type: 'tool/result', seq: 4, data: { turn: 1 } })
  await h.emit('s1', { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } })
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'succeeded')
  assert.equal(stored.lastEventPosition, 5)
  pass('回合结束（DSH 对象 reason）投影为 succeeded')
}

// 5. 乱序/重复事件不倒退
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.emit('s1', { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'completed' } })
  await h.emit('s1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.lastEventPosition, 5)
  pass('迟到事件不倒退事件位')
}

// 6. 别家会话的事件不投影到自己任务
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.emit('s9', { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'completed' } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'running')
  pass('按会话归属投影')
}

// 7. 取消意图的 turn/end（DSH 对象 { kind: 'aborted' }） → cancelled
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'cancelled')
  pass('DSH aborted 原因投影为 cancelled')
}

// 8. 出错回合（DSH { kind: 'error' } / { kind: 'blocked' } / { kind: 'max-tokens' }） → failed，带 code/hint
{
  for (const reason of [{ kind: 'error', error: { message: 'upstream 500' } }, { kind: 'blocked' }, { kind: 'max-tokens' }]) {
    const h = harness()
    const { task } = await h.submit()
    await h.runner.dispatch(task.taskId)
    await h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason } })
    const stored = h.service.queryTask({ taskId: task.taskId }).task
    assert.equal(stored.executionStatus, 'failed', `reason=${JSON.stringify(reason)}`)
    assert.equal(stored.error.code, 'TASK_TURN_FAILED')
    assert.ok(stored.error.hint)
  }
  pass('DSH error/blocked/max-tokens 回合投影为 failed')
}

// 8b. P1-6 未知 turn/end reason 禁止默认成功，保守标为 needs_reconciliation
{
  for (const reason of [undefined, null, 'something-new', { kind: 'interrupted' }, { kind: 'mystery' }, {}]) {
    const h = harness()
    const { task } = await h.submit()
    await h.runner.dispatch(task.taskId)
    await h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason } })
    const stored = h.service.queryTask({ taskId: task.taskId }).task
    assert.equal(stored.executionStatus, 'needs_reconciliation', `未知 reason=${JSON.stringify(reason)} 不得默认成功`)
    assert.ok(stored.error?.code)
    assert.ok(stored.error?.hint)
  }
  assert.equal(classifyTurnEndReason(undefined).status, 'needs_reconciliation')
  pass('P1-6 未知/interrupted turn/end reason 保守标 needs_reconciliation，绝不默认成功')
}

// 9. 已停止的任务收到迟到 turn/end 不被复活
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.runner.cancel(task.taskId, actor)
  await h.emit('s1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'cancelled')
  assert.equal(stored.lastEventPosition, 9)
  pass('迟到完成不覆盖停止意图')
}

// 10. 取消：先写停止屏障再取消回合
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  const result = await h.runner.cancel(task.taskId, actor)
  assert.equal(result.ok, true)
  assert.equal(result.cancelledTurn, true)
  assert.equal(h.cancelled[0].sessionId, 's1')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'cancelled')
  assert.ok(stored.stopRequest, '停止意图必须持久')
  pass('取消先持久停止意图再取消回合')
}

// 11. P1-5 取消 ACK 失败 → 绝不假装 cancelled，标 needs_reconciliation，且保留席位禁止新任务越过旧任务
{
  const h = harness()
  const { task } = await h.submit('m1', '旧任务')
  const { task: queued } = await h.submit('m2', '新排队任务')
  assert.equal(queued.executionStatus, 'queued')
  await h.runner.dispatch(task.taskId)

  h.failCancel(new Error('session/not-found'))
  const result = await h.runner.cancel(task.taskId, actor)
  issue(result, 'TASK_CANCEL_UNCONFIRMED')
  assert.equal(result.uncertain, true)
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'needs_reconciliation', '取消失败绝不能假装已停止')
  assert.ok(stored.stopRequest, '必须保留停止屏障')
  assert.equal(h.service.queryTask({}).activeTaskId, task.taskId, '旧会话未确认停止前不得释放并发席位')
  assert.equal(h.service.queryTask({ taskId: queued.taskId }).task.executionStatus, 'queued', '新任务不得越过仍在执行的旧任务')
  issue(await h.runner.dispatch(queued.taskId), 'TASK_QUEUED_NOT_ACTIVE')
  assert.equal(h.created.length, 1, '绝不能为新任务建第二个会话')

  // 当旧会话稍后真正发来 turn/end 时，释放席位并自动按 FIFO 派发 queued 任务，同时旧任务保持 needs_reconciliation
  await h.emit('s1', { type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'aborted' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'needs_reconciliation')
  assert.equal(h.service.queryTask({ taskId: queued.taskId }).task.executionStatus, 'running')
  assert.equal(h.created.length, 2, '旧会话真正结束后才派发下一个 FIFO 任务')
  pass('P1-5 取消失败不假装已停且不让新任务越过，turn/end 到来后才释放席位')
}

// 12. 建会话失败 → 任务落到 failed，不留在 running
{
  const h = harness()
  const { task } = await h.submit()
  h.failCreate(new Error('preset missing'))
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_CREATE_FAILED')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'failed')
  assert.equal(stored.error.code, 'TASK_SESSION_CREATE_FAILED')
  pass('建会话失败落 failed')
}

// 13. 会话拒收 prompt → failed
{
  const h = harness()
  const { task } = await h.submit()
  h.failPrompt(new Error('session/not-found'))
  issue(await h.runner.dispatch(task.taskId), 'TASK_PROMPT_REJECTED')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'failed')
  pass('prompt 拒收落 failed')
}

// 14. 终态任务不再派发
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  await h.runner.cancel(task.taskId, actor)
  const again = await h.runner.dispatch(task.taskId)
  assert.equal(again.ok, false)
  assert.ok(['TASK_CLOSED', 'TASK_SESSION_EXISTS'].includes(again.code))
  pass('终态任务不再派发')
}

// 15. attach/detach 只挂一次订阅
{
  const h = harness()
  h.runner.attach()
  h.runner.attach()
  assert.equal(h.listeners.length, 1)
  h.runner.detach()
  assert.equal(h.listeners.length, 0)
  pass('attach 幂等、detach 可回收')
}

// 16. prompt 文案带三条硬规则
{
  const prompt = taskPromptText({ goal: '整理周报', workspaceRoot: ROOT })
  assert.ok(prompt.includes('只能新建'))
  assert.ok(prompt.includes('不许执行命令'))
  assert.ok(prompt.includes('整理周报'))
  pass('prompt 文案含只新建与禁命令规则')
}

// 17. P0-2 闸门卸载后：真实登记表归零，且运行中任务被立即中止（若取消失败则标 needs_reconciliation）
{
  const h = harness()
  const gate = createLocalTaskGate({ root: ROOT, presetId: 'lt-runner-p02' })
  let dispose = null
  const ctx = { tools: { guard: () => {} }, effect: (fn) => { dispose = fn() } }
  gate.apply(ctx)
  assert.equal(_gateLivenessCount('lt-runner-p02'), 1)
  dispose()
  assert.equal(_gateLivenessCount('lt-runner-p02'), 0)

  // 运行中任务在 gate 卸载时被立即撤会话并停掉
  const { task } = await h.submit('m1', '运行中任务')
  await h.runner.dispatch(task.taskId)
  await h.setGateLive(false)
  assert.equal(h.cancelled.length, 1, 'gate 卸载时必须立即取消在途会话')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'failed')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.error?.code, 'TASK_POLICY_UNMOUNTED')

  // 若 gate 卸载时取消会话失败 → 必须标 needs_reconciliation 并锁席位
  const hFail = harness()
  const { task: tFail } = await hFail.submit('m2', '撤不掉的任务')
  await hFail.runner.dispatch(tFail.taskId)
  hFail.failCancel(new Error('transport dead'))
  await hFail.setGateLive(false)
  assert.equal(hFail.service.queryTask({ taskId: tFail.taskId }).task.executionStatus, 'needs_reconciliation')
  assert.equal(hFail.service.queryTask({}).activeTaskId, tFail.taskId)
  pass('P0-2 闸门卸载立即中止运行任务，无法确认停止则标 needs_reconciliation')
}

// 18. 会话装配到别的 preset → 拒绝送 prompt
{
  const h = harness()
  h.surface.preset = 'qq-chat-v2'
  const { task } = await h.submit()
  issue(await h.runner.dispatch(task.taskId), 'TASK_POLICY_MISMATCH')
  assert.equal(h.prompted.length, 0)
  assert.equal(h.cancelled.length, 1)
  pass('装配到别的 preset 时拒绝派发')
}

// 19. 工具面出现 bash/subagent → 拒绝派发
{
  const h = harness()
  h.surface.toolNames = ['read', 'write', 'bash']
  const { task } = await h.submit()
  const result = await h.runner.dispatch(task.taskId)
  issue(result, 'TASK_TOOL_SURFACE_UNSAFE')
  assert.ok(result.error.includes('bash'))
  assert.equal(h.prompted.length, 0)
  pass('工具面越界时拒绝派发并点名工具')
}

// 20. 取不到 agent → 拒绝派发
{
  const h = harness()
  h.surface.agentMissing = true
  const { task } = await h.submit()
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_MISSING')
  assert.equal(h.prompted.length, 0)
  pass('取不到 agent 时拒绝派发')
}

// 21. P1-9 真实 DSH 模型请求事件（assistant/message + assistant/attempt + session/title-llm-request）覆盖额度
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  // 28 次正常成功模型调用（assistant/message）+ 2 次辅助/重试（session/title-llm-request + assistant/attempt）= 30 次允许
  for (let i = 0; i < 28; i += 1) {
    const r = await h.runner.observe({ id: 's1' }, { type: 'assistant/message', seq: 10 + i, data: { attemptId: i + 1 } })
    assert.notEqual(r?.code, 'TASK_BUDGET_EXCEEDED')
  }
  await h.runner.observe({ id: 's1' }, { type: 'session/title-llm-request', seq: 50, data: {} })
  await h.runner.observe({ id: 's1' }, { type: 'assistant/attempt', seq: 51, data: { attemptId: 99 } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'running')

  // 第 31 次正常 assistant/message 立即触达上限并撤会话
  const over = await h.runner.observe({ id: 's1' }, { type: 'assistant/message', seq: 52, data: { attemptId: 100 } })
  assert.equal(over.code, 'TASK_BUDGET_EXCEEDED')
  const after = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(after.executionStatus, 'failed')
  assert.equal(after.error?.code, 'TASK_BUDGET_EXCEEDED')
  assert.ok(after.error?.hint)
  assert.equal(h.cancelled.length, 1)
  pass('P1-9 真实 DSH assistant/message + title-llm + assistant/attempt 额度不能绕过')
}

// 22. P1-9 工具调用额度：tool/call 与 tool/result 按 callId 去重，120 次以内照常，第 121 次在 tool/call 即收口
{
  const h = harness()
  const { task } = await h.submit()
  await h.runner.dispatch(task.taskId)
  for (let i = 0; i < 120; i += 1) {
    const c = await h.runner.observe({ id: 's1' }, { type: 'tool/call', seq: i * 2 + 1, data: { callId: `c-${i}` } })
    assert.notEqual(c?.code, 'TASK_BUDGET_EXCEEDED')
    // 对应的 tool/result 不得重复计次（否则 61 次工具就超 120）
    const r = await h.runner.observe({ id: 's1' }, { type: 'tool/result', seq: i * 2 + 2, data: { message: { callId: `c-${i}` } } })
    assert.notEqual(r?.code, 'TASK_BUDGET_EXCEEDED')
  }
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'running')
  const over = await h.runner.observe({ id: 's1' }, { type: 'tool/call', seq: 500, data: { callId: 'c-over' } })
  assert.equal(over.code, 'TASK_BUDGET_EXCEEDED')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'failed')
  pass('P1-9 tool/call + tool/result 去重计数与第 121 次即时截停')
}

// 23. P1-1/2/3 FIFO 队列：queued 禁直派，当前任务完成后自动按顺序派发下一条
{
  const h = harness()
  const t1 = (await h.submit('m1', '第一条')).task
  const t2 = (await h.submit('m2', '第二条')).task
  const t3 = (await h.submit('m3', '第三条')).task
  assert.equal(t2.executionStatus, 'queued')
  issue(await h.runner.dispatch(t2.taskId), 'TASK_QUEUED_NOT_ACTIVE')
  assert.equal((await h.runner.dispatch(t1.taskId)).ok, true)
  assert.equal(h.created.length, 1)

  await h.emit('s1', { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.service.queryTask({ taskId: t1.taskId }).task.executionStatus, 'succeeded')
  assert.equal(h.service.queryTask({ taskId: t2.taskId }).task.executionStatus, 'running')
  assert.equal(h.service.queryTask({ taskId: t3.taskId }).task.executionStatus, 'queued')
  assert.equal(h.created.length, 2, 't1 完成后只自动派发 t2')

  await h.emit('s2', { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.service.queryTask({ taskId: t3.taskId }).task.executionStatus, 'running')
  assert.equal(h.created.length, 3, 't2 完成后按 FIFO 自动派发 t3')
  pass('P1-1/2/3 并发 1 与 FIFO 自动派发')
}

console.log(`${checks} checks passed`)
