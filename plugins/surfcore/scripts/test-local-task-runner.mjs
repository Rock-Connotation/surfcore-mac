// T04 契约测试：一 Task 一专用 Session、先装配后送首条 prompt、requestId 持久复用、
// 事件按归属/顺序投影、取消先写停止屏障。不依赖 DSH 运行时。
import assert from 'node:assert/strict'
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs'
import { createLocalTaskRunner, taskPromptText, TASK_PRESET_ID } from '../lib/local-task-runner.mjs'
import { createLocalTaskGate } from '../lib/local-task-gate.mjs'

function makeDomain() {
  const store = new Map()
  return {
    table() {
      return {
        get: (key) => store.get(key),
        keys: () => [...store.keys()],
        entries: () => [...store.entries()],
        get size() { return store.size },
        put(key, value) { LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(value); store.set(key, value) },
        delete: (key) => store.delete(key),
      }
    },
  }
}

const actor = { platform: 'qq', botId: 'bot-1', channel: 'private', conversationId: 'owner', userId: 'owner-1' }
const source = (messageId) => ({ botId: 'bot-1', channel: 'private', conversationId: 'owner', messageId })
const ROOT = '/tmp/local-task-workspace'
const text = '读取项目A的会议纪要，整理成周报'

function harness({ gateLive = true } = {}) {
  let n = 0
  const service = createLocalTaskService({
    domain: makeDomain(),
    now: () => new Date(2026, 10, 17, 12, 0, n).toISOString(),
    newId: () => `t${++n}`,
  })
  const created = []
  const prompted = []
  const cancelled = []
  let createError = null
  let promptError = null
  let cancelError = null
  const sessionController = {
    async create(request) {
      if (createError) throw createError
      created.push(request)
      return { sessionId: `s${created.length}` }
    },
    async prompt(request, from) {
      if (promptError) throw promptError
      prompted.push({ request, from })
      return { accepted: true }
    },
    async cancel(request) {
      if (cancelError) throw cancelError
      cancelled.push(request)
      return { accepted: true }
    },
  }
  const listeners = []
  // 装配层的假体：preset 名、工具面、agent 查找都可按用例改写。
  const surface = { preset: TASK_PRESET_ID, toolNames: ["read", "write"], agentMissing: false }
  const agents = { get: (id) => (surface.agentMissing ? undefined : { id, ctx: { id } }) }
  const agentPresets = { composedPreset: () => surface.preset }
  const tools = { schemas: () => surface.toolNames.map((name) => ({ name })) }
  const runner = createLocalTaskRunner({
    service,
    sessionController,
    agents,
    agentPresets,
    tools,
    subscribe: (fn) => { listeners.push(fn); return () => { listeners.length = 0 } },
    isGateLive: () => gateLive,
    workspaceRoot: ROOT,
    newRequestId: () => `r${++n}`,
  })
  runner.attach()
  const submit = () => service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  return {
    service, runner, created, prompted, cancelled, listeners, surface,
    submit,
    failCreate: (error) => { createError = error },
    failPrompt: (error) => { promptError = error },
    failCancel: (error) => { cancelError = error },
    emit: (sessionId, event) => listeners.forEach((fn) => fn({ id: sessionId }, event)),
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


// 1. 闸门不在册 → 拒绝派发，且绝不建会话
{
  const h = harness({ gateLive: false })
  const { task } = h.submit()
  const result = await h.runner.dispatch(task.taskId)
  issue(result, 'TASK_POLICY_UNMOUNTED')
  assert.equal(h.prompted.length, 0, '闸门不在册时绝不能送 prompt')
  assert.equal(h.cancelled.length, 1, '不合格的会话必须取消掉')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.dshSessionId, null, '未送 prompt 就不绑定会话')
  pass('闸门不在册：不送 prompt 且取消会话')
}

// 2. 正常派发：cwd + agentPreset，prompt 带持久 requestId，且只送一条
{
  const h = harness()
  const { task } = h.submit()
  const result = await h.runner.dispatch(task.taskId)
  assert.equal(result.ok, true)
  assert.deepEqual(h.created[0], { cwd: ROOT, agentPreset: TASK_PRESET_ID })
  assert.equal(h.prompted.length, 1)
  const { request, from } = h.prompted[0]
  assert.equal(request.sessionId, 's1')
  assert.equal(request.requestId, result.requestId)
  assert.equal(from.kind, 'user')
  assert.equal(from.rpcId, result.requestId)
  assert.ok(request.content[0].text.includes(ROOT), 'prompt 必须写明工作区')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.dshSessionId, 's1')
  assert.equal(stored.requestId, result.requestId)
  pass('派发建专用会话并送带 requestId 的首条 prompt')
}

// 3. 同一任务重复派发 → 拒绝，不建第二个会话
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_EXISTS')
  assert.equal(h.created.length, 1)
  pass('重复派发被拒')
}

// 4. turn/end 成功 → succeeded，并推进 lastEventPosition
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.emit('s1', { type: 'turn/start', seq: 3, data: { turn: 1 } })
  h.emit('s1', { type: 'tool/result', seq: 4, data: { turn: 1 } })
  h.emit('s1', { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'completed' } })
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'succeeded')
  assert.equal(stored.lastEventPosition, 5)
  pass('回合结束投影为 succeeded')
}

// 5. 乱序/重复事件不倒退
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.emit('s1', { type: 'turn/end', seq: 5, data: { turn: 1, reason: 'completed' } })
  h.emit('s1', { type: 'turn/start', seq: 2, data: { turn: 1 } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.lastEventPosition, 5)
  pass('迟到事件不倒退事件位')
}

// 6. 别家会话的事件不投影到自己任务
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.emit('s9', { type: 'turn/end', seq: 1, data: { turn: 1, reason: 'completed' } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'running')
  pass('按会话归属投影')
}

// 7. 取消意图的 turn/end → cancelled
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'cancelled' } })
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'cancelled')
  pass('取消原因投影为 cancelled')
}

// 8. 出错回合 → failed，带 code/hint
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'error' } })
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'failed')
  assert.equal(stored.error.code, 'TASK_TURN_FAILED')
  assert.ok(stored.error.hint)
  pass('出错回合投影为 failed')
}

// 9. 已停止的任务收到迟到 turn/end 不被复活的证据：状态保持 cancelled
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  await h.runner.cancel(task.taskId, actor)
  h.emit('s1', { type: 'turn/end', seq: 9, data: { turn: 1, reason: 'completed' } })
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'cancelled')
  assert.equal(stored.lastEventPosition, 9, '事件位照常前进（留给重启对账），但状态不得复活')
  pass('迟到完成不覆盖停止意图')
}

// 10. 取消：先写停止屏障再取消回合
{
  const h = harness()
  const { task } = h.submit()
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

// 11. 取消 ACK 失败 → 仍报 cancelled，但标记 uncertain（不谎报已停）
{
  const h = harness()
  const { task } = h.submit()
  await h.runner.dispatch(task.taskId)
  h.failCancel(new Error('session/not-found'))
  const result = await h.runner.cancel(task.taskId, actor)
  assert.equal(result.ok, true)
  assert.equal(result.uncertain, true)
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'cancelled')
  pass('取消 ACK 失败标记 uncertain')
}

// 12. 建会话失败 → 任务落到 failed，不留在 running
{
  const h = harness()
  const { task } = h.submit()
  h.failCreate(new Error('preset missing'))
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_CREATE_FAILED')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'failed')
  assert.equal(stored.error.code, 'TASK_SESSION_CREATE_FAILED')
  pass('建会话失败落 failed')
}

// 13. 会话拒收 prompt → failed（accepted 才是"已入队"）
{
  const h = harness()
  const { task } = h.submit()
  h.failPrompt(new Error('session/not-found'))
  issue(await h.runner.dispatch(task.taskId), 'TASK_PROMPT_REJECTED')
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'failed')
  pass('prompt 拒收落 failed')
}

// 14. 终态任务不再派发
{
  const h = harness()
  const { task } = h.submit()
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

// 17. 闸门卸载后 runner 立刻拒绝派发（fail-closed 生命周期契约）
{
  const h = harness()
  const gate = createLocalTaskGate({ root: ROOT })
  let dispose = null
  const ctx = { tools: { guard: (fn) => { ctx.guard = fn } }, effect: (fn) => { dispose = fn() } }
  gate.apply(ctx)
  assert.equal(typeof ctx.guard, 'function', 'apply 必须注册执行期守卫')
  dispose()
  const { task } = h.submit()
  // harness 里 isGateLive 是注入的，这里直接验证登记表口径：卸载后为 0
  const { _gateLivenessCount } = await import('../lib/local-task-gate.mjs')
  assert.equal(_gateLivenessCount('local-task'), 0, '闸门卸载后存活计数必须归零')
  pass('闸门卸载后存活计数归零')
}

// 18. 会话装配到别的 preset → 拒绝送 prompt（工具面不受约束）
{
  const h = harness()
  h.surface.preset = 'qq-chat-v2'
  const { task } = h.submit()
  issue(await h.runner.dispatch(task.taskId), 'TASK_POLICY_MISMATCH')
  assert.equal(h.prompted.length, 0, '装配不对时绝不能送 prompt')
  assert.equal(h.cancelled.length, 1)
  pass('装配到别的 preset 时拒绝派发')
}

// 19. 工具面出现 bash/subagent → 拒绝派发
{
  const h = harness()
  h.surface.toolNames = ['read', 'write', 'bash']
  const { task } = h.submit()
  const result = await h.runner.dispatch(task.taskId)
  issue(result, 'TASK_TOOL_SURFACE_UNSAFE')
  assert.ok(result.error.includes('bash'), '错误文案要指出越界工具名')
  assert.equal(h.prompted.length, 0)
  pass('工具面越界时拒绝派发并点名工具')
}

// 20. 取不到 agent → 拒绝派发
{
  const h = harness()
  h.surface.agentMissing = true
  const { task } = h.submit()
  issue(await h.runner.dispatch(task.taskId), 'TASK_SESSION_MISSING')
  assert.equal(h.prompted.length, 0)
  pass('取不到 agent 时拒绝派发')
}

console.log(`${checks} checks passed`)
