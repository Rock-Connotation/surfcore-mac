// T02 + P0-1 契约测试：真正异步的 storageDomain 语义（延迟成功、Promise rejection、
// unknown-state 隔离与恢复、写入期间重复入站、取消/完成写失败回滚与不释出执行席位、FIFO 队列）。
import assert from 'node:assert/strict'
import { createLocalTaskService, LOCAL_TASK_DOMAIN, QUEUE_LIMIT, sourceKeyOf } from '../lib/local-task-service.mjs'

function makeAsyncDomain({ delayMs = 0, failPut = null, unknownState = false, onPut = null } = {}) {
  const store = new Map()
  let quarantinedError = null
  let closed = false
  return {
    store,
    putCalls: 0,
    setFailPut(err) { failPut = err },
    setUnknownState(val) { unknownState = val },
    setDelay(ms) { delayMs = ms },
    async close() { closed = true },
    get isClosed() { return closed },
    table() {
      return {
        get: (key) => {
          if (quarantinedError) throw quarantinedError
          return store.get(key)
        },
        keys: () => {
          if (quarantinedError) throw quarantinedError
          return [...store.keys()]
        },
        entries: () => {
          if (quarantinedError) throw quarantinedError
          return [...store.entries()]
        },
        get size() {
          if (quarantinedError) throw quarantinedError
          return store.size
        },
        async put(key, value) {
          this._parent.putCalls += 1
          if (onPut) await onPut(key, value, this._parent.putCalls)
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          if (quarantinedError) throw quarantinedError
          if (unknownState) {
            const err = new Error('backend durable write outcome unknown')
            err.code = 'unknown-state'
            quarantinedError = err
            throw err
          }
          if (failPut) {
            const err = typeof failPut === 'function' ? failPut(key, value) : failPut
            if (err) throw err instanceof Error ? err : new Error(String(err))
          }
          LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(value)
          store.set(key, value)
        },
        _parent: null,
        delete: async (key) => store.delete(key),
      }
    },
  }
}

function wrapDomain(options = {}) {
  const d = makeAsyncDomain(options)
  const origTable = d.table.bind(d)
  d.table = () => {
    const t = origTable()
    t._parent = d
    return t
  }
  return d
}

const actor = { platform: 'qq', botId: 'bot-1', channel: 'private', conversationId: 'owner', userId: 'owner-1' }
const source = (messageId, extra = {}) => ({ botId: 'bot-1', channel: 'private', conversationId: 'owner', messageId, ...extra })
const text = '读取项目A的会议纪要，整理成周报'

function makeService(options = {}) {
  let n = 0
  const domain = options.domain ?? wrapDomain(options)
  const service = createLocalTaskService({
    domain,
    now: () => new Date(2026, 10, 17, 12, 0, n).toISOString(),
    newId: () => `t${++n}`,
  })
  return { service, domain }
}

const issue = (value, code) => {
  assert.equal(value.ok, false, `expected failure ${code}`)
  assert.equal(value.code, code)
  assert.ok(value.error, 'error 文案必填')
  assert.ok(value.hint, 'hint 下一步必填')
}

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

// 1. 同一入站事件重复到达 → 只登记一次
{
  const { service } = makeService()
  const first = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  assert.equal(first.ok, true)
  const again = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  assert.equal(again.duplicate, true)
  assert.equal(again.task.taskId, first.task.taskId)
  assert.equal(service.queryTask({}).tasks.length, 1)
  pass('重复的同一 OneBot 事件只登记一次')
}

// 2. 同一来源键携带不同内容 → 冲突，不执行
{
  const { service } = makeService()
  await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  issue(await service.submitTask({ trustedActor: actor, source: source('m1'), text: '别的内容', workspaceId: 'w1' }), 'TASK_SOURCE_CONFLICT')
  pass('同键不同内容判冲突')
}

// 3. 不同消息 ID 的相同文本 → 新命令（排队），不是重复
{
  const { service } = makeService()
  const a = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const b = await service.submitTask({ trustedActor: actor, source: source('m2'), text, workspaceId: 'w1' })
  assert.equal(b.ok, true)
  assert.equal(b.queued, true)
  assert.notEqual(a.task.taskId, b.task.taskId)
  assert.equal(b.task.executionStatus, 'queued')
  pass('同文本不同消息 ID 是新命令（并发 1 → 排队）')
}

// 4. 异步 Promise rejection → 不许回"已接收"，且正确回滚内存态与 activeTaskId
{
  const { service, domain } = makeService({ failPut: new Error('disk io timeout') })
  issue(await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' }), 'TASK_STORE_UNAVAILABLE')
  assert.equal(domain.store.size, 0, '写失败必须回滚内存状态')
  assert.equal(service.queryTask({}).tasks.length, 0)
  assert.equal(service.queryTask({}).activeTaskId, null, '写失败必须回滚 activeTaskId')
  pass('异步 Promise rejection 不外报已接收且状态回滚')
}

// 5. 队列上限
{
  const { service } = makeService()
  await service.submitTask({ trustedActor: actor, source: source('m0'), text, workspaceId: 'w1' })
  for (let i = 1; i <= QUEUE_LIMIT; i++) {
    assert.equal((await service.submitTask({ trustedActor: actor, source: source(`q${i}`), text, workspaceId: 'w1' })).ok, true)
  }
  issue(await service.submitTask({ trustedActor: actor, source: source('overflow'), text, workspaceId: 'w1' }), 'TASK_QUEUE_FULL')
  pass(`队列上限 ${QUEUE_LIMIT} 生效`)
}

// 6. 取消：他人无权、发起人可停、迟到完成不覆盖停止意图
{
  const { service } = makeService()
  const created = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const taskId = created.task.taskId
  issue(await service.cancelTask({ actor: { userId: 'stranger' }, taskId }), 'TASK_ACTOR_FORBIDDEN')
  const cancelled = await service.cancelTask({ actor, taskId })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.task.executionStatus, 'cancelled')
  assert.equal(cancelled.task.stopRequest.by, 'owner-1')
  const late = await service.finish({ taskId, status: 'succeeded', resultRefs: ['file:///tmp/x.md'] })
  assert.equal(late.ignored, 'stop-request')
  assert.equal(service.queryTask({ taskId }).task.executionStatus, 'cancelled')
  pass('取消写停止屏障且迟到完成不覆盖')
}

// 7. 终态封闭：不能再绑会话 / 再执行
{
  const { service } = makeService()
  const created = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const taskId = created.task.taskId
  await service.finish({ taskId, status: 'succeeded' })
  issue(await service.attachSession({ taskId, sessionId: 's-new', requestId: 'r1' }), 'TASK_CLOSED')
  assert.equal((await service.finish({ taskId, status: 'running' })).ignored, 'terminal')
  assert.equal(service.queryTask({ taskId }).task.executionStatus, 'succeeded')
  pass('终态任务不可复活（绑会话拒绝、迟到完成被忽略）')
}

// 8. 会话绑定：记录 DSH 实际返回的 sessionId，冲突不覆盖
{
  const { service } = makeService()
  const taskId = (await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })).task.taskId
  assert.equal((await service.attachSession({ taskId, sessionId: 'sess-a', requestId: 'req-a' })).ok, true)
  issue(await service.attachSession({ taskId, sessionId: 'sess-b', requestId: 'req-b' }), 'TASK_SESSION_CONFLICT')
  assert.equal(service.queryTask({ taskId }).task.dshSessionId, 'sess-a')
  pass('保存真实 sessionId 且拒绝改绑')
}

// 9. 域 schema 拒绝非法记录
{
  assert.throws(() => LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse({ taskId: '', executionStatus: 'running', commands: [], deliveries: [], controlEpoch: 0 }), /taskId/)
  assert.throws(() => LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse({ taskId: 't', executionStatus: 'bogus', commands: [], deliveries: [], controlEpoch: 0 }), /executionStatus/)
  pass('域 schema 拒绝非法记录')
}

// 10. 重启后从同一域恢复（新实例读回旧记录与活跃任务）
{
  const domain = wrapDomain()
  const first = makeService({ domain })
  const created = await first.service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const second = makeService({ domain })
  const restored = second.service.queryTask({ taskId: created.task.taskId })
  assert.equal(restored.ok, true)
  assert.equal(restored.task.executionStatus, 'running')
  assert.equal(second.service.queryTask({}).activeTaskId, created.task.taskId)
  pass('重启从同一域表恢复任务与活跃席位')
}

// 11. 来源键必填项缺失 → 拒绝登记
{
  assert.throws(() => sourceKeyOf({ botId: 'b', channel: 'private', conversationId: 'c' }), /messageId/)
  const { service } = makeService()
  issue(await service.submitTask({ trustedActor: actor, source: { botId: 'b' }, text, workspaceId: 'w1' }), 'TASK_SOURCE_INVALID')
  pass('来源键缺失拒绝登记')
}

// 12. P0-1 异步：延迟成功（未落盘前不对外报告成功，也不提前占内存态）
{
  let releasePut
  const gate = new Promise((r) => { releasePut = r })
  const domain = wrapDomain({ onPut: async () => { await gate } })
  const { service } = makeService({ domain })
  let settled = false
  const pending = service.submitTask({ trustedActor: actor, source: source('m-delay'), text, workspaceId: 'w1' }).then((r) => {
    settled = true
    return r
  })
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(settled, false, '后端 put 未确认前不得向外报告成功')
  assert.equal(service.queryTask({}).tasks.length, 0, '未落盘前不得提前暴露成功记录')
  assert.equal(service.queryTask({}).activeTaskId, null, '未落盘前不得提前占席位')
  releasePut()
  const res = await pending
  assert.equal(res.ok, true)
  assert.equal(settled, true)
  assert.equal(service.queryTask({}).activeTaskId, res.task.taskId)
  pass('P0-1 异步延迟成功：确认后才返回成功并提交状态')
}

// 13. P0-1 异步：写入期间重复入站（同 sourceKey 并发到达）
{
  const domain = wrapDomain({ delayMs: 25 })
  const { service } = makeService({ domain })
  const [first, second] = await Promise.all([
    service.submitTask({ trustedActor: actor, source: source('m-dup'), text, workspaceId: 'w1' }),
    service.submitTask({ trustedActor: actor, source: source('m-dup'), text, workspaceId: 'w1' }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.duplicate, true, '写入期间第二条相同入站应串行判为 duplicate')
  assert.equal(second.task.taskId, first.task.taskId)
  assert.equal(domain.putCalls, 1, '相同入站不得重复写后端')
  pass('P0-1 写入期间重复入站串行去重')
}

// 14. P0-1 异步：写入期间重复入站若第一条失败，第二条不得假装 duplicate
{
  let count = 0
  const domain = wrapDomain({
    delayMs: 20,
    failPut: () => { count += 1; return count === 1 ? new Error('first transient error') : null },
  })
  const { service } = makeService({ domain })
  const [first, second] = await Promise.all([
    service.submitTask({ trustedActor: actor, source: source('m-dup-fail'), text, workspaceId: 'w1' }),
    service.submitTask({ trustedActor: actor, source: source('m-dup-fail'), text, workspaceId: 'w1' }),
  ])
  issue(first, 'TASK_STORE_UNAVAILABLE')
  assert.equal(second.ok, true)
  assert.notEqual(second.duplicate, true, '第一条失败后第二条不得误判 duplicate')
  pass('P0-1 首条写入失败时并发第二条不误判 duplicate')
}

// 15. P0-1 异步：写入结果不明（unknown-state）进入隔离，禁止派发，并支持关闭重开核对
{
  const domain = wrapDomain()
  const { service } = makeService({ domain })
  const first = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  assert.equal(first.ok, true)

  // 下一次写入触发 unknown-state
  domain.setUnknownState(true)
  const failed = await service.submitTask({ trustedActor: actor, source: source('m2'), text: '第二个', workspaceId: 'w1' })
  issue(failed, 'TASK_STORE_QUARANTINED')
  assert.equal(service.isQuarantined(), true)
  assert.equal(service.requireRunning(first.task.taskId).failure?.code, 'TASK_STORE_QUARANTINED', 'unknown-state 时禁止继续派发')
  issue(await service.submitTask({ trustedActor: actor, source: source('m3'), text: '第三个', workspaceId: 'w1' }), 'TASK_STORE_QUARANTINED')
  assert.equal(service.queryTask({}).quarantined, true, '查询应如实暴露隔离态')

  // 重开新域执行核对恢复：旧域被关闭，在途任务标为 needs_reconciliation 且释放席位
  const reopened = wrapDomain()
  for (const [k, v] of domain.store.entries()) reopened.store.set(k, v)
  const recovered = await service.recoverWithDomain(reopened)
  assert.equal(recovered.ok, true)
  assert.equal(domain.isClosed, true, '隔离核对必须关闭旧域')
  assert.equal(service.isQuarantined(), false)
  assert.equal(service.queryTask({ taskId: first.task.taskId }).task.executionStatus, 'needs_reconciliation')
  assert.equal(service.queryTask({}).activeTaskId, null)
  pass('P0-1 unknown-state 进入隔离禁止派发，重开后核对恢复')
}

// 16. P0-1 + P1-4 异步：写入失败时取消任务（不能改 cancelled，也不能释放 activeTaskId）
{
  const domain = wrapDomain()
  const { service } = makeService({ domain })
  const created = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const queued = await service.submitTask({ trustedActor: actor, source: source('m2'), text: '排队任务', workspaceId: 'w1' })
  assert.equal(queued.task.executionStatus, 'queued')

  domain.setFailPut(new Error('backend locked'))
  issue(await service.cancelTask({ actor, taskId: created.task.taskId }), 'TASK_STORE_UNAVAILABLE')
  assert.equal(service.queryTask({ taskId: created.task.taskId }).task.executionStatus, 'running', '取消持久化失败不得假装 cancelled')
  assert.equal(service.queryTask({}).activeTaskId, created.task.taskId, '取消持久化失败不得释放执行席位')
  issue(await service.promoteNext(), 'TASK_CONCURRENCY_BUSY', '席位未释放时队列任务不得越过旧任务')
  pass('P0-1/P1-4 取消持久化失败保留运行态与执行席位')
}

// 17. P0-1 + P1-4 异步：写入失败时完成任务（不能改 succeeded，也不能释放 activeTaskId）
{
  const domain = wrapDomain()
  const { service } = makeService({ domain })
  const created = await service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  await service.submitTask({ trustedActor: actor, source: source('m2'), text: '排队任务', workspaceId: 'w1' })

  domain.setFailPut(new Error('disk full'))
  issue(await service.finish({ taskId: created.task.taskId, status: 'succeeded' }), 'TASK_STORE_UNAVAILABLE')
  assert.equal(service.queryTask({ taskId: created.task.taskId }).task.executionStatus, 'running', '完成持久化失败不得假装 succeeded')
  assert.equal(service.queryTask({}).activeTaskId, created.task.taskId, '完成持久化失败不得释放执行席位')
  issue(await service.promoteNext(), 'TASK_CONCURRENCY_BUSY')
  pass('P0-1/P1-4 完成持久化失败保留运行态与执行席位')
}

// 18. P1-1 FIFO 顺序晋升
{
  const { service } = makeService()
  const t1 = (await service.submitTask({ trustedActor: actor, source: source('m1'), text: '第一', workspaceId: 'w1' })).task
  const t2 = (await service.submitTask({ trustedActor: actor, source: source('m2'), text: '第二', workspaceId: 'w1' })).task
  const t3 = (await service.submitTask({ trustedActor: actor, source: source('m3'), text: '第三', workspaceId: 'w1' })).task
  assert.equal(t1.executionStatus, 'running')
  assert.equal(t2.executionStatus, 'queued')
  assert.equal(t3.executionStatus, 'queued')
  // queued 任务禁止直接 requireRunning
  assert.equal(service.requireRunning(t2.taskId).failure?.code, 'TASK_QUEUED_NOT_ACTIVE')
  await service.finish({ taskId: t1.taskId, status: 'succeeded' })
  const p1 = await service.promoteNext()
  assert.equal(p1.task.taskId, t2.taskId)
  assert.equal(p1.task.executionStatus, 'running')
  await service.finish({ taskId: t2.taskId, status: 'succeeded' })
  const p2 = await service.promoteNext()
  assert.equal(p2.task.taskId, t3.taskId)
  pass('FIFO 队列晋升顺序正确且 queued 禁止直派')
}

console.log(`\n${checks} checks passed`)
