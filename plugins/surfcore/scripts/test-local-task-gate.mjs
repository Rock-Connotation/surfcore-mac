// T03 + P0-2 + P0-3 闸门契约测试：白名单、路径围栏（符号链接/前缀陷阱）、
// 原生 fs/write-intent -> createIfAbsent 抢占（已读过也不给覆盖）、健康位与卸载事件。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  taskGateDenyReason,
  resolveInsideRoot,
  TASK_ALLOWED_TOOLS,
  createLocalTaskGate,
  onGateLivenessChange,
  taskGateIsLive,
} from '../lib/local-task-gate.mjs'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gate-'))
const root = path.join(base, 'work')
fs.mkdirSync(root)
fs.writeFileSync(path.join(root, 'a.md'), 'hello')
fs.mkdirSync(path.join(root, 'sub'))
fs.writeFileSync(path.join(root, 'sub', 'b.md'), 'world')
fs.mkdirSync(path.join(base, 'work-other'))
fs.writeFileSync(path.join(base, 'work-other', 'escape.md'), 'nope')
fs.symlinkSync(base, path.join(root, 'out')) // 指向工作区外层

let checks = 0
const pass = (name) => { checks++; console.log(`PASS ${name}`) }
const allow = (exec, opts = {}) => assert.equal(taskGateDenyReason(exec, { root, ...opts }), undefined)
const deny = (exec, pattern, opts = {}) => {
  const reason = taskGateDenyReason(exec, { root, ...opts })
  assert.equal(typeof reason, 'string', `预期拒绝：${JSON.stringify(exec)}`)
  assert.match(reason, pattern)
}

// 1. 工作区内读取放行
allow({ name: 'read', arguments: { file_path: 'a.md' } })
allow({ name: 'read', arguments: { file_path: path.join(root, 'sub', 'b.md') } })
pass('工作区内 read 放行')

// 2. 非白名单工具一律拒绝（Shell / 派生 / MCP / edit / apply_patch）
deny({ name: 'bash', arguments: { command: 'ls' } }, /不在本机任务白名单/)
deny({ name: 'pwsh', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'subagent', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'mcp__snowluma__qq_send_message', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'tool_web', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'edit', arguments: { file_path: 'a.md' } }, /不在本机任务白名单/)
deny({ name: 'apply_patch', arguments: {} }, /不在本机任务白名单/)
pass('Shell/派生/MCP/edit 全部拒绝')

// 3. 相对逃逸与绝对路径逃逸
deny({ name: 'read', arguments: { file_path: '../work-other/escape.md' } }, /路径越出工作区/)
deny({ name: 'read', arguments: { file_path: '/etc/passwd' } }, /路径越出工作区/)
pass('相对/绝对路径逃逸被拒')

// 4. 符号链接逃逸：work/out -> base
deny({ name: 'read', arguments: { file_path: 'out/work-other/escape.md' } }, /路径越出工作区/)
pass('符号链接逃逸被拒')

// 5. 前缀陷阱：work-other 与 work 前缀相同
deny({ name: 'read', arguments: { file_path: path.join(base, 'work-other', 'escape.md') } }, /路径越出工作区/)
pass('前缀相同的兄弟目录不被误判为内部')

// 6. 只新建：已存在目标拒绝，不存在的放行
deny({ name: 'write', arguments: { file_path: 'a.md', content: 'x' } }, /目标已存在/)
allow({ name: 'write', arguments: { file_path: 'new.md', content: 'x' } })
allow({ name: 'write', arguments: { file_path: 'sub/new2.md', content: 'x' } })
pass('write 只允许新建')

// 7. 不许自行升权
deny({ name: 'write', arguments: { file_path: 'new3.md', content: 'x', sandbox_permissions: 'danger-full-access' } }, /不允许自行提升文件权限/)
pass('sandbox_permissions 升权被拒')

// 8. 健康位为 false 时连正常读取都拒绝（fail-closed）
deny({ name: 'read', arguments: { file_path: 'a.md' } }, /策略未确认在册/, { healthy: false })
pass('闸门不健康时 fail-closed')

// 9. glob/grep 的 path 同受围栏
allow({ name: 'glob', arguments: { pattern: '**/*.md', path: 'sub' } })
deny({ name: 'grep', arguments: { pattern: 'x', path: '../work-other' } }, /路径越出工作区/)
pass('glob/grep 的 path 同受围栏')

// 10. resolveInsideRoot 直接调用：不存在的深层目标按祖先 realpath 归属
assert.equal(resolveInsideRoot(root, 'deep/not/yet.md').ok, true)
assert.equal(resolveInsideRoot(root, 'out/whatever.md').ok, false)
pass('不存在目标的祖先归属判定')

// 11. 插件形状：apply 注册 guard 与 fs/write-intent 抢占 createIfAbsent（压过 fs-observation-policy）
{
  const guards = []
  const hooks = []
  const disposes = []
  let healthy = true
  const ctx = {
    tools: { guard: (fn) => { guards.push(fn) } },
    effect: (fn) => { disposes.push(fn()) },
    on: (name, fn, opts) => {
      if (name === 'fs/write-intent') {
        if (opts?.prepend) hooks.unshift(fn)
        else hooks.push(fn)
      }
    },
    get: (serviceName) => serviceName === 'agentPresets'
      ? { composedPreset: (c) => c?.preset }
      : undefined,
  }
  // 模拟先挂载的 fs-observation-policy：读过文件后它会返回 replaceIfVersion
  ctx.on('fs/write-intent', () => ({ kind: 'replaceIfVersion', version: 'v1' }))

  createLocalTaskGate({ root, presetId: 'local-task-test', isHealthy: () => healthy }).apply(ctx)
  assert.equal(guards.length, 1)
  assert.equal(guards[0]({ name: 'read', arguments: { file_path: 'a.md' } }), undefined)
  assert.match(guards[0]({ name: 'bash', arguments: {} }), /白名单/)

  const runWaterfall = (actor) => {
    let i = 0
    const next = () => {
      const fn = hooks[i++]
      return fn ? fn({}, actor, next) : undefined
    }
    return next()
  }

  // 本机任务会话（即使已读过文件）强制返回 createIfAbsent，绝拿不到 replaceIfVersion
  const localIntent = runWaterfall({ agent: { ctx: { preset: 'local-task-test' }, session: { header: { cwd: root } } } })
  assert.deepEqual(localIntent, { kind: 'createIfAbsent' })

  // 普通 DSH 会话不被影响：穿透 next() 保留原来的 replaceIfVersion
  const normalIntent = runWaterfall({ agent: { ctx: { preset: 'standard' }, session: { header: { cwd: '/tmp/other' } } } })
  assert.deepEqual(normalIntent, { kind: 'replaceIfVersion', version: 'v1' })

  // 闸门不健康时拒绝 write-intent（fail-closed）
  healthy = false
  assert.throws(() => runWaterfall({ agent: { ctx: { preset: 'local-task-test' } } }), /闸门已卸载/)

  for (const d of disposes) d()
  pass('fs/write-intent 抢占 createIfAbsent 且不干扰普通 DSH 会话')
}

// 12. P0-2 闸门卸载事件同步通知监听方
{
  const seen = []
  const off = onGateLivenessChange('local-task-evt', (live) => seen.push(live))
  let dispose
  createLocalTaskGate({ root, presetId: 'local-task-evt' }).apply({
    tools: { guard: () => {} },
    effect: (fn) => { dispose = fn() },
  })
  assert.equal(taskGateIsLive('local-task-evt'), true)
  dispose()
  assert.equal(taskGateIsLive('local-task-evt'), false)
  assert.deepEqual(seen, [true, false])
  off()
  pass('闸门上线与卸载同步发射生命周期通知')
}

// 13. 第三方插件直接向 agent.ctx 注册的越界工具（如 clutch_*）必须从 local-task agent layer 清除，且不影响普通会话
{
  const listeners = new Map()
  const layerMap = new Map()
  const localAgent = { ctx: { preset: 'local-task-agent-test' } }
  const normalAgent = { ctx: { preset: 'standard' } }
  layerMap.set(localAgent, {
    tools: {
      data: new Map([
        ['read', { definition: { name: 'read' } }],
        ['clutch_new_worktree', { definition: { name: 'clutch_new_worktree' } }],
        ['clutch_report_result', { definition: { name: 'clutch_report_result' } }],
      ]),
    },
  })
  layerMap.set(normalAgent, {
    tools: {
      data: new Map([
        ['read', { definition: { name: 'read' } }],
        ['clutch_new_worktree', { definition: { name: 'clutch_new_worktree' } }],
      ]),
    },
  })
  let dispose
  createLocalTaskGate({ root, presetId: 'local-task-agent-test' }).apply({
    get: (k) => {
      if (k === 'agentPresets') return { composedPreset: (c) => c.preset }
      if (k === 'agents') return { list: () => [localAgent, normalAgent] }
      return undefined
    },
    on: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {}
    },
    tools: {
      guard: () => {},
      layers: { peek: (scope) => layerMap.get(scope) },
    },
    effect: (fn) => { dispose = fn() },
  })
  assert.deepEqual([...layerMap.get(localAgent).tools.data.keys()], ['read'])
  assert.deepEqual([...layerMap.get(normalAgent).tools.data.keys()], ['read', 'clutch_new_worktree'])

  // 模拟 agent/created 之后异步注册 tools/change
  layerMap.get(localAgent).tools.data.set('clutch_span_worktree', { definition: { name: 'clutch_span_worktree' } })
  for (const fn of listeners.get('tools/change') ?? []) fn()
  assert.deepEqual([...layerMap.get(localAgent).tools.data.keys()], ['read'])

  dispose()
  pass('agent-scoped 第三方越界工具被自动清除，普通会话保留不受影响')
}

assert.deepEqual([...TASK_ALLOWED_TOOLS], ['read', 'write', 'glob', 'grep', 'todo_write'])
fs.rmSync(base, { recursive: true, force: true })
console.log(`\n${checks} checks passed`)
