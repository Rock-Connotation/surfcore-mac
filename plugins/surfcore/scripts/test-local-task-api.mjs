// 本机任务通道的契约测试：令牌/来源校验、submit 去重、query 文案、cancel 语义。
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
        put(key, value) { LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(value); store.set(key, value) },
        delete: (key) => store.delete(key),
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
let promptCount = 0
let cancelCount = 0
const service = createLocalTaskService({ domain: makeDomain(), newId: (() => { let n = 0; return () => `t${++n}` })() })
const runtime = {
  ok: true,
  service,
  runner: {
    presetId: 'local-task',
    dispatch: async (taskId) => { promptCount++; service.attachSession({ taskId, sessionId: `s-${taskId}` }); return { ok: true } },
    cancel: async (taskId) => { cancelCount++; service.cancelTask({ actor: service.queryTask({ taskId }).task.trustedActor, taskId }); return { ok: true, cancelledTurn: true } },
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
  assert.equal(promptCount, 0)
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
  assert.equal(promptCount, 1)
  pass('提交受理并派发')
}

// 4. 同消息号重复 submit → duplicate，不重复派发
{
  const res = await call({ action: 'submit', text: '整理周报', source: { botId: 'b', channel: 'private', conversationId: 'owner', userId: 'owner', messageId: 'm1' } }, { token })
  assert.equal(res.body.duplicate, true)
  assert.equal(promptCount, 1)
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
