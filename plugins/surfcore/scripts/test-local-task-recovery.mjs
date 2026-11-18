// T05 契约测试：查询只读不开回合、重启对账只标不复算、停止意图不被迟到完成覆盖。
import assert from 'node:assert/strict'
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs'
import { createLocalTaskRunner, TASK_PRESET_ID } from '../lib/local-task-runner.mjs'
import { apply as applyGate } from '../lib/local-task-gate.mjs'

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
const ROOT = '/tmp/local-task-workspace'

function harness() {
  let n = 0
  const domain = makeDomain()
  const service = createLocalTaskService({ domain, now: () => new Date(2026, 10, 17, 12, 0, n).toISOString(), newId: () => `t${++n}` })
  const created = []
  const prompted = []
  const cancelled = []
  const sessionController = {
    create: async (request) => { created.push(request); return { sessionId: `s${created.length}` } },
    prompt: async (request) => { prompted.push(request); return { accepted: true } },
    cancel: async (request) => { cancelled.push(request); return { accepted: true } },
  }
  const listeners = []
  const runner = createLocalTaskRunner({
    service,
    sessionController,
    agents: { get: (id) => ({ id, ctx: {} }) },
    agentPresets: { composedPreset: () => TASK_PRESET_ID },
    tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
    subscribe: (fn) => { listeners.push(fn); return () => { listeners.length = 0 } },
    isGateLive: () => true,
    subscribeGate: () => () => {},
    workspaceRoot: ROOT,
    newRequestId: () => `r${++n}`,
  })
  runner.attach()
  const submit = (messageId, text) => service.submitTask({
    trustedActor: actor,
    source: { botId: 'bot-1', channel: 'private', conversationId: 'owner', messageId },
    text,
    workspaceId: 'w1',
  })
  const emit = async (sessionId, event) => {
    for (const fn of [...listeners]) await fn({ id: sessionId }, event)
  }
  return { service, runner, created, prompted, cancelled, submit, emit, domain }
}

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

applyGate({ tools: { guard: () => {} }, effect: () => {} })

// 1. 查询：返回任务与可读文案，且不建会话、不送 prompt
{
  const h = harness()
  const { task } = await h.submit('m1', '整理周报')
  await h.runner.dispatch(task.taskId)
  const before = h.prompted.length
  const view = h.service.queryTask({ taskId: task.taskId })
  assert.equal(view.ok, true)
  const text = h.service.describeTask(view.task)
  assert.ok(text.includes(task.taskId), '文案要带任务号')
  assert.ok(text.includes('执行中'), `文案要说人话：${text}`)
  assert.equal(h.prompted.length, before, '查询不得触发新回合')
  assert.equal(h.created.length, 1, '查询不得新建会话')
  pass('查询只读不开回合')
}

// 2. 查询未知任务 → TASK_NOT_FOUND + hint
{
  const h = harness()
  const view = h.service.queryTask({ taskId: 'nope' })
  assert.equal(view.ok, false)
  assert.equal(view.code, 'TASK_NOT_FOUND')
  assert.ok(view.hint)
  pass('查询未知任务给出下一步')
}

// 3. 重启对账：在途任务标 needs_reconciliation，且不重放 prompt
{
  const h = harness()
  const { task } = await h.submit('m1', '整理周报')
  await h.runner.dispatch(task.taskId)
  const before = h.prompted.length
  const result = await h.service.reconcileOnBoot()
  assert.equal(result.ok, true)
  assert.equal(result.reconciled.length, 1)
  assert.equal(result.reconciled[0].from, 'running')
  const stored = h.service.queryTask({ taskId: task.taskId }).task
  assert.equal(stored.executionStatus, 'needs_reconciliation')
  assert.equal(stored.reconcileReason, 'host-restarted')
  assert.equal(h.prompted.length, before, '重启不得自动重发 prompt')
  assert.ok(h.service.describeTask(stored).includes('重启'), '文案要说明为什么需要复核')
  pass('重启对账只标状态不重放')
}

// 4. 对账后并发席位释放：新任务可以立刻接
{
  const h = harness()
  const first = (await h.submit('m1', '任务一')).task
  await h.runner.dispatch(first.taskId)
  await h.service.reconcileOnBoot()
  const second = (await h.submit('m2', '任务二')).task
  assert.equal(second.executionStatus, 'running', '对账后席位应释放')
  pass('对账释放并发席位')
}

// 5. 终态任务不被对账改写
{
  const h = harness()
  const { task } = await h.submit('m1', '整理周报')
  await h.runner.dispatch(task.taskId)
  await h.emit('s1', { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } })
  const result = await h.service.reconcileOnBoot()
  assert.equal(result.reconciled.length, 0)
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'succeeded')
  pass('终态不受对账影响')
}

// 6. 取消后重启：仍是 cancelled，不被对账改回 needs_reconciliation
{
  const h = harness()
  const { task } = await h.submit('m1', '整理周报')
  await h.runner.dispatch(task.taskId)
  await h.runner.cancel(task.taskId, actor)
  const result = await h.service.reconcileOnBoot()
  assert.equal(result.reconciled.length, 0)
  assert.equal(h.service.queryTask({ taskId: task.taskId }).task.executionStatus, 'cancelled')
  pass('已取消的任务不被对账改写')
}

// 7. 取消优先于排队：queued 也能被停止
{
  const h = harness()
  const first = (await h.submit('m1', '任务一')).task
  await h.runner.dispatch(first.taskId)
  const second = (await h.submit('m2', '任务二')).task
  assert.equal(second.executionStatus, 'queued')
  const stopped = await h.runner.cancel(second.taskId, actor)
  assert.equal(stopped.ok, true)
  assert.equal(stopped.cancelledTurn, false, '没有会话就没什么可取消的回合')
  assert.equal(h.service.queryTask({ taskId: second.taskId }).task.executionStatus, 'cancelled')
  pass('排队中的任务可停止')
}

// 8. 别人的任务取消被拒
{
  const h = harness()
  const { task } = await h.submit('m1', '整理周报')
  await h.runner.dispatch(task.taskId)
  const stopped = await h.runner.cancel(task.taskId, { ...actor, userId: 'stranger' })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.code, 'TASK_ACTOR_FORBIDDEN')
  pass('非发起人不能取消')
}

console.log(`${checks} checks passed`)
