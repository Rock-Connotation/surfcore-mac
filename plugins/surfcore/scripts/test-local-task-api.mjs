// 本机任务通道的契约测试：令牌/来源校验、submit 去重与 queued 禁直派、query 文案、cancel 语义、redeliver 补发。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createLocalTaskApi, LOCAL_TASK_API_PREFIX } from '../lib/local-task-api.mjs'
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs'

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

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

function fakeReq({ method = 'POST', body = {}, token, host = '127.0.0.1:5500', origin } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host, 'content-type': 'application/json', ...(token ? { 'x-local-task-token': token } : {}), ...(origin ? { origin } : {}) }
  req.socket = { remoteAddress: '127.0.0.1' }
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  return req
}

function fakeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (code) => { res.status = code }
  res.end = (text) => { res.body = JSON.parse(text) }
  return res
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-api-'))
let dispatchCalls = []
let cancelCount = 0
let redeliverCalls = []
const service = createLocalTaskService({ domain: makeDomain(), newId: (() => { let n = 0; return () => `t${++n}` })() })
const runtime = {
  ok: true,
  service,
  runner: {
    presetId: 'local-task',
    dispatch: async (taskId) => {
      dispatchCalls.push(taskId)
      await service.attachSession({ taskId, sessionId: `s-${taskId}`, requestId: `req-${taskId}` })
      return { ok: true }
    },
    cancel: async (taskId) => {
      cancelCount++
      await service.cancelTask({ actor: service.queryTask({ taskId }).task.trustedActor, taskId })
      return { ok: true, cancelledTurn: true }
    },
  },
  redeliver: async (taskId) => {
    redeliverCalls.push(taskId)
    const view = service.queryTask({ taskId })
    if (!view.ok) return view
    return { ok: true, taskId, text: `已补发任务 ${taskId} 的结果` }
  },
}
const api = createLocalTaskApi({ stateDir: root, currentDshUrl: () => 'http://127.0.0.1:5500', getRuntime: () => runtime })
const discovery = api.writeDiscovery()
assert.equal(discovery.ok, true)
const token = JSON.parse(fs.readFileSync(path.join(root, 'local-task', 'qq.json'), 'utf8')).token
assert.equal(fs.statSync(path.join(root, 'local-task', 'qq.json')).mode & 0o077, 0, '发现文件权限必须是 0600')

async function call(body, options = {}) {
  const res = fakeRes()
  await api.handle(fakeReq({ ...options, body }), res, new URL(LOCAL_TASK_API_PREFIX, 'http://127.0.0.1:5500'))
  return res
}

// 1. 没有令牌 → 403，且不产生任务
{
  const res = await call({ action: 'submit', text: 'x', source: { botId: 'b', channel: 'private', conversationId: 'o', userId: 'o', messageId: 'm1' } })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'LOCAL_TASK_AUTH_REQUIRED')
  assert.equal(dispatchCalls.length, 0)
  pass('无令牌被拒')
}

// 2. 跨源 Host 头 → 403
{
  const res = await call({ action: 'query' }, { token, host: 'evil.example:5500' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'LOCAL_TASK_ORIGIN_REJECTED')
  pass('非回环 Host 被拒')
}

// 3. submit 正常受理并派发
{
  const res = await call({ action: 'submit', text: '整理周报', source: { botId: 'b', channel: 'private', conversationId: 'owner', userId: 'owner', messageId: 'm1' } }, { token })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.match(res.body.text, /已接收/)
  assert.equal(res.body.queued, false)
  assert.equal(dispatchCalls.length, 1)
  pass('提交受理并派发')
}

// 3b. P1-2 已有任务在跑时第二条 submit 进入 queued，绝不直接调用 runner.dispatch
{
  const res = await call({ action: 'submit', text: '第二条任务', source: { botId: 'b', channel: 'private', conversationId: 'owner', userId: 'owner', messageId: 'm2' } }, { token })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.queued, true)
  assert.match(res.body.text, /已排队/)
  assert.equal(dispatchCalls.length, 1, 'queued 任务不得直接调用 runner.dispatch')
  assert.equal(service.queryTask({ taskId: res.body.taskId }).task.executionStatus, 'queued')
  pass('P1-2 queued 任务只入队不直接调用 runner.dispatch')
}

// 4. 同消息号重复 submit → duplicate，不重复派发
{
  const res = await call({ action: 'submit', text: '整理周报', source: { botId: 'b', channel: 'private', conversationId: 'owner', userId: 'owner', messageId: 'm1' } }, { token })
  assert.equal(res.body.duplicate, true)
  assert.equal(dispatchCalls.length, 1)
  pass('重复消息不重复派发')
}

// 5. 同消息号不同内容 → 冲突
{
  const res = await call({ action: 'submit', text: '改别的东西', source: { botId: 'b', channel: 'private', conversationId: 'owner', userId: 'owner', messageId: 'm1' } }, { token })
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'TASK_SOURCE_CONFLICT')
  pass('同号不同内容报冲突')
}

// 6. query 返回人话状态
{
  const res = await call({ action: 'query' }, { token })
  assert.equal(res.status, 200)
  assert.match(res.body.text, /任务 t1/)
  pass('查询返回任务')
}

// 7. query 未知任务 → 失败带 hint
{
  const res = await call({ action: 'query', taskId: 'nope' }, { token })
  assert.equal(res.body.ok, false)
  assert.equal(res.body.code, 'TASK_NOT_FOUND')
  assert.ok(res.body.hint)
  pass('查询未知任务给下一步')
}

// 8. cancel 走停止语义
{
  const res = await call({ action: 'cancel', taskId: 't1' }, { token })
  assert.equal(res.body.ok, true)
  assert.equal(cancelCount, 1)
  assert.equal(service.queryTask({ taskId: 't1' }).task.executionStatus, 'cancelled')
  pass('取消落到停止态')
}

// 8b. P1-8 redeliver 补发接口：调用 runtime.redeliver，不触发 runner.dispatch
{
  const bad = await call({ action: 'redeliver' }, { token })
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'TASK_ID_REQUIRED')
  assert.ok(bad.body.hint)

  const res = await call({ action: 'redeliver', taskId: 't1' }, { token })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.match(res.body.text, /已补发/)
  assert.deepEqual(redeliverCalls, ['t1'])
  assert.equal(dispatchCalls.length, 1, 'redeliver 不得触发 dispatch')
  pass('P1-8 redeliver 通道接口直达补发且不触发执行')
}

// 9. 未知动作 → 明确拒绝
{
  const res = await call({ action: 'promote' }, { token })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'LOCAL_TASK_ACTION_INVALID')
  pass('未知动作被拒')
}

// 10. Runtime 未就绪 → 503 且带 hint
{
  const down = createLocalTaskApi({ stateDir: root, currentDshUrl: () => 'http://127.0.0.1:5500', getRuntime: () => ({ ok: false, code: 'LOCAL_TASK_NOT_READY', error: '没装好', hint: '重启 DSH' }) })
  down.writeDiscovery()
  const res = fakeRes()
  await down.handle(fakeReq({ body: { action: 'query' }, token: JSON.parse(fs.readFileSync(path.join(root, 'local-task', 'qq.json'), 'utf8')).token }), res, new URL(LOCAL_TASK_API_PREFIX, 'http://127.0.0.1:5500'))
  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'LOCAL_TASK_NOT_READY')
  pass('未就绪时 503')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`${checks} checks passed`)
