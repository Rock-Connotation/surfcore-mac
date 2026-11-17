// T04 接线测试：Host 装配只建一份服务、事件订阅转发到 runner、卸载后句柄失效。
import assert from 'node:assert/strict'
import { mountLocalTasks, getLocalTasks } from '../lib/local-task-host.mjs'

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

function fakeCtx({ withDomain = true, seed = [] } = {}) {
  const effects = []
  const listeners = []
  const opened = []
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
              put: (k, v) => { spec.tables.tasks.valueSchema.parse(v); store.set(k, v) },
              delete: (k) => store.delete(k),
            }
          },
          close: () => { opened.closed = true },
        }
      },
    } : undefined,
    sessionController: { create: async () => ({ sessionId: 's1' }), prompt: async () => ({ accepted: true }), cancel: async () => ({ accepted: true }) },
    agents: { get: () => ({ id: 's1', ctx: {}, session: { header: { cwd: '/tmp/w' } } }) },
    agentPresets: { composedPreset: () => 'local-task' },
    tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] },
  }
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { effects.push(fn()) },
    on: (name, fn) => { listeners.push({ name, fn }); return () => { const i = listeners.findIndex((l) => l.fn === fn); if (i >= 0) listeners.splice(i, 1) } },
    inject(deps, cb) {
      const missing = deps.filter((d) => !services[d])
      if (missing.length) return () => {}
      const scoped = { ...ctx, ...services }
      cb(scoped)
      return () => {}
    },
  }
  return { ctx, effects, listeners, opened }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// 1. 装配成功 → 句柄可用，域按 spec 打开
{
  const h = fakeCtx()
  mountLocalTasks(h.ctx, { workspaceRoot: '/tmp/w', log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  assert.equal(runtime.ok, true)
  assert.equal(runtime.presetId, 'local-task')
  assert.equal(h.opened.length, 1)
  assert.equal(h.opened[0].name, 'surfcore_local_task')
  pass('装配成功并可取到句柄')
}

// 2. 会话事件被转发到 runner（同一 session 的 turn/end 落到任务上）
{
  // 闸门必须真的在册，否则派发会被 fail-closed 拦住（这正是它的职责）。
  const { apply: applyGate } = await import('../lib/local-task-gate.mjs')
  applyGate({ tools: { guard: () => {} }, effect: () => {} })
  const h = fakeCtx()
  mountLocalTasks(h.ctx, { workspaceRoot: '/tmp/w', log: () => {} })
  await tick()
  const { service } = getLocalTasks()
  const submitted = service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'c', userId: 'u' },
    source: { botId: 'b', channel: 'private', conversationId: 'c', messageId: 'm1' },
    text: '整理周报',
    workspaceId: 'w1',
  })
  const dispatched = await getLocalTasks().runner.dispatch(submitted.task.taskId)
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  const listener = h.listeners.find((l) => l.name === 'session/event')
  assert.ok(listener, '必须订阅 session/event')
  listener.fn({ id: dispatched.sessionId }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'completed' } })
  assert.equal(service.queryTask({ taskId: submitted.task.taskId }).task.executionStatus, 'succeeded')
  pass('会话事件转发到任务投影')
}

// 3. 卸载 → 句柄失效，域被关闭
{
  const h = fakeCtx()
  mountLocalTasks(h.ctx, { workspaceRoot: '/tmp/w', log: () => {} })
  await tick()
  assert.equal(getLocalTasks().ok, true)
  for (const dispose of h.effects) dispose()
  assert.equal(getLocalTasks().ok, false)
  assert.equal(getLocalTasks().code, 'LOCAL_TASK_NOT_READY')
  assert.equal(h.opened.closed, true)
  pass('卸载后句柄失效且域关闭')
}

// 4. 宿主缺 storageDomain → 句柄保持未就绪，不抛错
{
  const h = fakeCtx({ withDomain: false })
  mountLocalTasks(h.ctx, { workspaceRoot: '/tmp/w', log: () => {} })
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
  mountLocalTasks(h.ctx, { workspaceRoot: '/tmp/w', log: () => {} })
  await tick()
  const runtime = getLocalTasks()
  assert.equal(runtime.ok, true)
  const stored = runtime.service.queryTask({ taskId: 'task-crashed' }).task
  assert.equal(stored.executionStatus, 'needs_reconciliation')
  assert.equal(stored.reconcileReason, 'host-started')
  assert.equal(prompted, 0, '对账不得重放 prompt')
  for (const dispose of h.effects) dispose()
  pass('装配即对账且不重放')
}

console.log(`${checks} checks passed`)
