// T02 契约测试：Task 聚合的唯一写入者、来源去重、持久失败不外报、停止屏障。
// 不依赖 DSH 运行时：用一个行为等价的假域表（同步读、写抛错即"未持久"）。
import assert from 'node:assert/strict'
import { createLocalTaskService, LOCAL_TASK_DOMAIN, QUEUE_LIMIT, sourceKeyOf } from '../lib/local-task-service.mjs'

function makeDomain({ failPut = false } = {}) {
  const store = new Map()
  return {
    store,
    table() {
      return {
        get: (key) => store.get(key),
        keys: () => [...store.keys()],
        entries: () => [...store.entries()],
        get size() { return store.size },
        put(key, value) {
          if (failPut) throw new Error('unknown-state: domain quarantined until close')
          LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(value)
          store.set(key, value)
        },
        delete: (key) => store.delete(key),
      }
    },
  }
}

const actor = { platform: 'qq', botId: 'bot-1', channel: 'private', conversationId: 'owner', userId: 'owner-1' }
const source = (messageId, extra = {}) => ({ botId: 'bot-1', channel: 'private', conversationId: 'owner', messageId, ...extra })
const text = '读取项目A的会议纪要，整理成周报'

function makeService(options = {}) {
  let n = 0
  const domain = options.domain ?? makeDomain(options)
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
  const first = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  assert.equal(first.ok, true)
  const again = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  assert.equal(again.duplicate, true)
  assert.equal(again.task.taskId, first.task.taskId)
  assert.equal(service.queryTask({}).tasks.length, 1)
  pass('重复的同一 OneBot 事件只登记一次')
}

// 2. 同一来源键携带不同内容 → 冲突，不执行
{
  const { service } = makeService()
  service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  issue(service.submitTask({ trustedActor: actor, source: source('m1'), text: '别的内容', workspaceId: 'w1' }), 'TASK_SOURCE_CONFLICT')
  pass('同键不同内容判冲突')
}

// 3. 不同消息 ID 的相同文本 → 新命令（排队），不是重复
{
  const { service } = makeService()
  const a = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const b = service.submitTask({ trustedActor: actor, source: source('m2'), text, workspaceId: 'w1' })
  assert.equal(b.ok, true)
  assert.notEqual(a.task.taskId, b.task.taskId)
  assert.equal(b.task.executionStatus, 'queued')
  pass('同文本不同消息 ID 是新命令（并发 1 → 排队）')
}

// 4. 持久失败 → 不许回"已接收"，且不留下半条记录
{
  const { service, domain } = makeService({ failPut: true })
  issue(service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' }), 'TASK_STORE_UNAVAILABLE')
  assert.equal(domain.store.size, 0, '写失败必须回滚内存状态')
  assert.equal(service.queryTask({}).tasks.length, 0)
  pass('持久失败不外报已接收且状态回滚')
}

// 5. 队列上限
{
  const { service } = makeService()
  service.submitTask({ trustedActor: actor, source: source('m0'), text, workspaceId: 'w1' })
  for (let i = 1; i <= QUEUE_LIMIT; i++) {
    assert.equal(service.submitTask({ trustedActor: actor, source: source(`q${i}`), text, workspaceId: 'w1' }).ok, true)
  }
  issue(service.submitTask({ trustedActor: actor, source: source('overflow'), text, workspaceId: 'w1' }), 'TASK_QUEUE_FULL')
  pass(`队列上限 ${QUEUE_LIMIT} 生效`)
}

// 6. 取消：他人无权、发起人可停、迟到完成不覆盖停止意图
{
  const { service } = makeService()
  const created = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const taskId = created.task.taskId
  issue(service.cancelTask({ actor: { userId: 'stranger' }, taskId }), 'TASK_ACTOR_FORBIDDEN')
  const cancelled = service.cancelTask({ actor, taskId })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.task.executionStatus, 'cancelled')
  assert.equal(cancelled.task.stopRequest.by, 'owner-1')
  const late = service.finish({ taskId, status: 'succeeded', resultRefs: ['file:///tmp/x.md'] })
  assert.equal(late.ignored, 'stop-request')
  assert.equal(service.queryTask({ taskId }).task.executionStatus, 'cancelled')
  pass('取消写停止屏障且迟到完成不覆盖')
}

// 7. 终态封闭：不能再绑会话 / 再执行
{
  const { service } = makeService()
  const created = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
  const taskId = created.task.taskId
  service.finish({ taskId, status: 'succeeded' })
  issue(service.attachSession({ taskId, sessionId: 's-new', requestId: 'r1' }), 'TASK_CLOSED')
  // 迟到/重复的完成事件是幂等 no-op，不报错也不改状态（报错会让桥接重试循环）。
  assert.equal(service.finish({ taskId, status: 'running' }).ignored, 'terminal')
  assert.equal(service.queryTask({ taskId }).task.executionStatus, 'succeeded')
  pass('终态任务不可复活（绑会话拒绝、迟到完成被忽略）')
}

// 8. 会话绑定：记录 DSH 实际返回的 sessionId，冲突不覆盖
{
  const { service } = makeService()
  const taskId = service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' }).task.taskId
  assert.equal(service.attachSession({ taskId, sessionId: 'sess-a', requestId: 'req-a' }).ok, true)
  issue(service.attachSession({ taskId, sessionId: 'sess-b', requestId: 'req-b' }), 'TASK_SESSION_CONFLICT')
  assert.equal(service.queryTask({ taskId }).task.dshSessionId, 'sess-a')
  pass('保存真实 sessionId 且拒绝改绑')
}

// 9. 域 schema 拒绝非法记录（防止写坏数据）
{
  assert.throws(() => LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse({ taskId: '', executionStatus: 'running', commands: [], deliveries: [], controlEpoch: 0 }), /taskId/)
  assert.throws(() => LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse({ taskId: 't', executionStatus: 'bogus', commands: [], deliveries: [], controlEpoch: 0 }), /executionStatus/)
  pass('域 schema 拒绝非法记录')
}

// 10. 重启后从同一域恢复（新实例读回旧记录与活跃任务）
{
  const domain = makeDomain()
  const first = makeService({ domain })
  const created = first.service.submitTask({ trustedActor: actor, source: source('m1'), text, workspaceId: 'w1' })
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
  issue(service.submitTask({ trustedActor: actor, source: { botId: 'b' }, text, workspaceId: 'w1' }), 'TASK_SOURCE_INVALID')
  pass('来源键缺失拒绝登记')
}

console.log(`\n${checks} checks passed`)
