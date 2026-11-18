// 真实 DSH 原生包集成与攻击验证：直接加载本机 DeepSeek Harness.app/Contents/Resources/app.asar
// 内的真实 @deepseek-ai/dsh-* 包，验证 P0-1 / P0-2 / P0-3 在真实宿主组件下的行为。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs'
import { createLocalTaskGate, taskGateDenyReason } from '../lib/local-task-gate.mjs'
import { mountLocalTasks, getLocalTasks } from '../lib/local-task-host.mjs'

const DSH_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const ASAR_MODULES = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'

if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
  if (!fs.existsSync(DSH_BIN)) {
    console.log('SKIP: DeepSeek Harness.app not installed on this host')
    process.exit(0)
  }
  const child = spawnSync(DSH_BIN, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  })
  process.exit(child.status ?? 1)
}

const require = createRequire(import.meta.url)
const cordis = require(path.join(ASAR_MODULES, 'cordis/lib/index.js'))
const { Context, Service } = cordis
const { DomainFacility } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-storage-domain/lib/index.js')).href)
const { StorageError } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-storage/lib/index.js')).href)
const { LocalFileSystem } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-fs-local/lib/index.js')).href)
const { apply: applyObservationPolicy } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-fs-observation-policy/lib/index.js')).href)
const { ToolsService } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-tools/lib/index.js')).href)
const { ToolExecutionPipeline } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-tools/lib/pipeline.js')).href)
const { apply: applyToolFs, Config: toolFsConfig } = await import(pathToFileURL(path.join(ASAR_MODULES, 'dsh-tool-fs/lib/index.js')).href)

let checks = 0
const pass = (name) => { checks++; console.log(`PASS ${name}`) }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dsh-native-'))

// ── 1. P0-1: 真实 DomainFacility + async 持久化 + unknown-state 隔离与恢复 ──
{
  const backing = new Map()
  let mode = 'ok'
  const ctx = new Context()
  ctx.provide('storage', {
    mount: () => () => {},
    backend: {
      get: () => ({
        kv: {
          async open() {
            return {
              async loadAll() { return { tables: { tasks: Object.fromEntries(backing) }, global: null } },
              async putRecord(_t, key, value) {
                await new Promise((r) => setTimeout(r, 15))
                if (mode === 'reject') throw new StorageError('io-error', 'simulated disk fault')
                if (mode === 'unknown') throw new StorageError('unknown-state', 'simulated ambiguous write')
                backing.set(key, value)
              },
              async deleteRecord(_t, key) { backing.delete(key) },
              async deleteRecords(_t, keys) { for (const k of keys) backing.delete(k) },
              async close() {},
            }
          },
        },
      }),
    },
  })
  const facility = new DomainFacility(ctx, { backend: 'mock', routes: {} })
  const domain = await facility.open(LOCAL_TASK_DOMAIN)
  let seq = 0
  const service = createLocalTaskService({ domain, newId: () => `dt-${++seq}` })
  const actor = { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'o', userId: 'o' }

  // 延迟成功
  const r1 = await service.submitTask({ trustedActor: actor, source: { botId: 'b', channel: 'private', conversationId: 'o', messageId: 'm1' }, text: '真实域测试', workspaceId: 'w' })
  assert.equal(r1.ok, true)
  assert.equal(backing.size, 1)

  // rejection 回滚
  mode = 'reject'
  const r2 = await service.submitTask({ trustedActor: actor, source: { botId: 'b', channel: 'private', conversationId: 'o', messageId: 'm2' }, text: '失败测试', workspaceId: 'w' })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'TASK_STORE_UNAVAILABLE')
  assert.equal(backing.size, 1)

  // unknown-state 隔离：真实 DomainImpl 隔离读写，service 阻止继续派发
  mode = 'unknown'
  const r3 = await service.submitTask({ trustedActor: actor, source: { botId: 'b', channel: 'private', conversationId: 'o', messageId: 'm3' }, text: '不明测试', workspaceId: 'w' })
  assert.equal(r3.ok, false)
  assert.equal(r3.code, 'TASK_STORE_QUARANTINED')
  assert.equal(service.isQuarantined(), true)
  assert.equal(service.requireRunning(r1.task.taskId).failure?.code, 'TASK_STORE_QUARANTINED')
  assert.throws(() => domain.table('tasks').get(r1.task.taskId), /ambiguous/)

  // 关闭并重开后核对恢复
  mode = 'ok'
  await domain.close()
  const reopened = await facility.open(LOCAL_TASK_DOMAIN)
  const rec = await service.recoverWithDomain(reopened)
  assert.equal(rec.ok, true)
  assert.equal(service.isQuarantined(), false)
  assert.equal(service.queryTask({ taskId: r1.task.taskId }).task.executionStatus, 'needs_reconciliation')
  await reopened.close()
  await ctx.fiber.dispose()
  pass('P0-1 真实 DSH DomainFacility 异步持久化、rejection 回滚、unknown-state 隔离与恢复')
}

// ── 2. P0-3: 真实 DSH LocalFileSystem + fs-observation-policy + dsh-tool-fs + 并发竞争 ──
{
  const ws = path.join(tmpRoot, 'ws-p03')
  fs.mkdirSync(ws, { recursive: true })
  const existingPath = path.join(ws, 'existing.txt')
  fs.writeFileSync(existingPath, 'ORIGINAL_CONTENT', { mode: 0o640 })
  const existingStatBefore = fs.statSync(existingPath)

  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  const tools = new ToolsService(ctx)
  ctx.provide('workingDirectory', {
    ensure: () => ws,
    forSession: () => ws,
  })
  const raceFile = path.join(ws, 'race.txt')
  let injectRaceOnTemp = false
  const localFs = new LocalFileSystem(ctx, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 })
  localFs.internals = {
    async inspectTemp() {
      if (!injectRaceOnTemp) return
      injectRaceOnTemp = false
      // 模拟：门禁检查通过且 temp 文件已写好，另一个进程抢先创建了目标文件！
      spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(raceFile)}, 'COMPETING_WINNER', { mode: 0o640 })`], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    },
  }
  ctx.provide('agentPresets', { composedPreset: (c) => c?.preset })

  // 先挂载真实 fs-observation-policy（一旦 read 过文件，它会尝试发 replaceIfVersion 允许覆盖）
  const obsFork = ctx.plugin({ name: 'fs-observation-policy', apply: applyObservationPolicy })
  // 挂载真实 dsh-tool-fs（启用 read 与 write）
  const toolFsFork = ctx.plugin({ name: 'tool-fs', inject: ['tools', 'fs', 'systemPrompt', 'workingDirectory'], apply: (c) => applyToolFs(c, toolFsConfig({ read: true, write: true, edit: false, applyPatch: false, readImage: false })) })
  // 挂载我们的 local-task-gate
  const gateFork = ctx.plugin(createLocalTaskGate({ root: ws, presetId: 'local-task' }))
  await obsFork.await()
  await toolFsFork.await()
  await gateFork.await()

  const taskAgent = { id: 'a-task', ctx: { preset: 'local-task', get: (k) => ctx.get(k) }, session: { id: 'sess-task', header: { cwd: ws } } }
  const pipeline = new ToolExecutionPipeline(ctx)

  async function runTool(name, args, agent = taskAgent) {
    const controller = new AbortController()
    const prepared = await pipeline.prepare({ callId: `c-${Math.random()}`, name, arguments: args, agent, signal: controller.signal })
    if (prepared.kind !== 'dispatch') return await pipeline.complete(prepared.exec, prepared)
    const outcome = await pipeline.dispatch(prepared.exec)
    return await pipeline.complete(prepared.exec, outcome)
  }

  // (a) 目标不存在时创建成功
  const createdRes = await runTool('write', { file_path: 'fresh.txt', content: 'HELLO_NEW' })
  assert.equal(createdRes.isError, false, JSON.stringify(createdRes))
  assert.equal(fs.readFileSync(path.join(ws, 'fresh.txt'), 'utf8'), 'HELLO_NEW')

  // (b) 目标已存在时拒绝，且先 read 过 existing.txt 仍无法获得覆盖权限！
  const readRes = await runTool('read', { file_path: 'existing.txt' })
  assert.equal(readRes.isError, false)
  const overwriteRes = await runTool('write', { file_path: 'existing.txt', content: 'OVERWRITTEN!' })
  assert.equal(overwriteRes.isError, true, '即使已经 read 过文件，write 仍必须被拒绝')
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'ORIGINAL_CONTENT')
  assert.equal(fs.statSync(existingPath).ino, existingStatBefore.ino)

  // (c) 直接绕过 guard 校验底层 write-intent + createIfAbsent（证明不是只靠 existsSync！）
  const targetObj = await localFs.resolve('existing.txt', { cwd: ws })
  const intent = await ctx.waterfall('fs/write-intent', targetObj, { agent: taskAgent }, () => undefined)
  assert.deepEqual(intent, { kind: 'createIfAbsent' }, '已读过的文件在 fs/write-intent 下仍必须拿到 createIfAbsent')
  await assert.rejects(() => localFs.writeText(targetObj, 'BYPASS', intent), (e) => e.code === 'FS_NOT_OBSERVED')
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'ORIGINAL_CONTENT')

  // (d) 并发竞争：gate 检查时 race.txt 不存在，writeText 写完 temp 后、link 发布前另一进程抢先创建 race.txt
  injectRaceOnTemp = true
  const raceOutcome = await runTool('write', { file_path: 'race.txt', content: 'MY_CONTENT' })
  assert.equal(raceOutcome.isError, true, '并发竞争创建必须被底层 createIfAbsent 硬链接原子拒绝')
  const raceStat = fs.statSync(raceFile)
  assert.equal(fs.readFileSync(raceFile, 'utf8'), 'COMPETING_WINNER', '竞争创建的文件内容不得被覆盖')
  assert.equal(raceStat.mode & 0o777, 0o640, '竞争创建的文件权限元数据必须保持不变')

  // (e) 普通 DSH 会话不受影响（read 后仍可由 fs-observation-policy 覆写）
  const normalFile = path.join(ws, 'normal.txt')
  fs.writeFileSync(normalFile, 'V1')
  const normalAgent = { id: 'a-norm', ctx: { preset: 'standard', get: (k) => ctx.get(k) }, session: { id: 'sess-norm', header: { cwd: ws } } }
  assert.equal((await runTool('read', { file_path: 'normal.txt' }, normalAgent)).isError, false)
  assert.equal((await runTool('write', { file_path: 'normal.txt', content: 'V2' }, normalAgent)).isError, false)
  assert.equal(fs.readFileSync(normalFile, 'utf8'), 'V2')

  await ctx.fiber.dispose()
  pass('P0-3 真实 DSH LocalFileSystem + fs-observation-policy + 并发创建竞争与元数据保护')
}

// ── 3. P0-2: 真实 Cordis + ToolsService + ToolExecutionPipeline 在途卸载攻击测试 ──
{
  const ws = path.join(tmpRoot, 'ws-p02')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'ok.txt'), 'safe')

  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
  const tools = new ToolsService(ctx)
  const localFs = new LocalFileSystem(ctx, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 })
  ctx.provide('workingDirectory', { ensure: () => ws, forSession: () => ws })

  const cancelled = []
  const taskAgent = { id: 's-live', ctx: { preset: 'local-task', get: (k) => ctx.get(k) }, session: { id: 's-live', header: { cwd: ws } } }
  const normalAgent = { id: 's-norm', ctx: { preset: 'standard', get: (k) => ctx.get(k) }, session: { id: 's-norm', header: { cwd: ws } } }
  ctx.provide('agents', { get: (id) => (id === 's-live' ? taskAgent : normalAgent) })
  ctx.provide('agentPresets', { composedPreset: (c) => c?.preset })
  ctx.provide('sessionController', {
    create: async () => ({ sessionId: 's-live' }),
    prompt: async () => ({ accepted: true }),
    cancel: async (req) => { cancelled.push(req); return { accepted: true } },
  })
  const store = new Map()
  ctx.provide('storageDomain', {
    async open(spec) {
      return {
        spec,
        table: () => ({
          get: (k) => store.get(k),
          keys: () => [...store.keys()],
          entries: () => [...store.entries()],
          get size() { return store.size },
          put: async (k, v) => { store.set(k, v) },
          delete: async (k) => store.delete(k),
        }),
        close: async () => {},
      }
    },
  })

  const toolFsFork = ctx.plugin({ name: 'tool-fs', inject: ['tools', 'fs', 'systemPrompt', 'workingDirectory'], apply: (c) => applyToolFs(c, toolFsConfig({ read: true, write: true, edit: false, applyPatch: false, readImage: false })) })
  const gateFork = ctx.plugin(createLocalTaskGate({ root: ws, presetId: 'local-task' }))
  mountLocalTasks(ctx, { workspaceRoot: ws, log: () => {} })
  await toolFsFork.await()
  await gateFork.await()
  await new Promise((r) => setTimeout(r, 20))

  const runtime = getLocalTasks()
  assert.equal(runtime.ok, true)
  const sub = await runtime.service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'o', userId: 'o' },
    source: { botId: 'b', channel: 'private', conversationId: 'o', messageId: 'm-live' },
    text: '攻击测试',
    workspaceId: 'w',
  })
  assert.equal((await runtime.runner.dispatch(sub.task.taskId)).ok, true)

  const pipeline = new ToolExecutionPipeline(ctx)
  // 闸门在册时，工作区内 read 放行
  const okPrep = await pipeline.prepare({ callId: 'c1', name: 'read', arguments: { file_path: 'ok.txt' }, agent: taskAgent, signal: new AbortController().signal })
  assert.equal(okPrep.kind, 'dispatch')

  // 卸载 gate
  await gateFork.dispose()
  await new Promise((r) => setTimeout(r, 20))

  // 尝试执行工作区外 read
  const attackPrep = await pipeline.prepare({ callId: 'c2', name: 'read', arguments: { file_path: '/etc/passwd' }, agent: taskAgent, signal: new AbortController().signal })
  assert.equal(attackPrep.kind, 'post-result', 'gate 卸载后真实 ToolExecutionPipeline 必须拒绝执行')
  assert.equal(attackPrep.result.isError, true)
  assert.equal(cancelled.length, 1, '运行中任务会话必须被取消')
  assert.equal(runtime.service.queryTask({ taskId: sub.task.taskId }).task.executionStatus, 'failed')

  // 普通 DSH 会话不受影响
  const normPrep = await pipeline.prepare({ callId: 'c3', name: 'read', arguments: { file_path: '/etc/hosts' }, agent: normalAgent, signal: new AbortController().signal })
  assert.equal(normPrep.kind, 'dispatch', '普通 DSH 会话不受影响')

  await ctx.fiber.dispose()
  pass('P0-2 真实 DSH ToolsService + ToolExecutionPipeline 卸载攻击测试与普通会话零影响')
}

// ── 4. Preset 配置不泄露宿主服务（leakedServices 检查） ──
{
  const patchPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../presets/local-task.patch.yml')
  const doc = yaml.load(fs.readFileSync(patchPath, 'utf8'))
  const plugins = doc[0].insert[0].config.plugins
  const names = plugins.map((p) => p.name)
  assert.equal(names.includes('@deepseek-ai/dsh-sandbox-policy'), false, 'preset 不得重复挂载宿主服务 sandbox-policy')
  assert.equal(names.includes('@deepseek-ai/dsh-fs-sandbox'), false, 'preset 不得重复挂载宿主服务 fs-sandbox')
  pass('local-task preset 不泄露宿主服务')
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n${checks} native DSH checks passed`)
