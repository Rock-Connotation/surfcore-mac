// T03 闸门契约测试：白名单、路径围栏（含符号链接与前缀陷阱）、只新建、健康位。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { taskGateDenyReason, resolveInsideRoot, TASK_ALLOWED_TOOLS, createLocalTaskGate } from '../lib/local-task-gate.mjs'

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

// 2. 非白名单工具一律拒绝（Shell / 派生 / MCP）
deny({ name: 'bash', arguments: { command: 'ls' } }, /不在本机任务白名单/)
deny({ name: 'pwsh', arguments: {}, }, /不在本机任务白名单/)
deny({ name: 'subagent', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'mcp__snowluma__qq_send_message', arguments: {} }, /不在本机任务白名单/)
deny({ name: 'tool_web', arguments: {} }, /不在本机任务白名单/)
pass('Shell/派生/MCP 全部拒绝')

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

// 9. glob/grep 的 path 同样受围栏
allow({ name: 'glob', arguments: { pattern: '**/*.md', path: 'sub' } })
deny({ name: 'grep', arguments: { pattern: 'x', path: '../work-other' } }, /路径越出工作区/)
pass('glob/grep 的 path 同受围栏')

// 10. resolveInsideRoot 直接调用：不存在的深层目标按祖先 realpath 归属
assert.equal(resolveInsideRoot(root, 'deep/not/yet.md').ok, true)
assert.equal(resolveInsideRoot(root, 'out/whatever.md').ok, false)
pass('不存在目标的祖先归属判定')

// 11. 插件形状：apply 注册 guard
{
  const reasons = []
  createLocalTaskGate({ root }).apply({ tools: { guard: (fn) => { reasons.push(fn) } } })
  assert.equal(reasons.length, 1)
  assert.equal(reasons[0]({ name: 'read', arguments: { file_path: 'a.md' } }), undefined)
  assert.match(reasons[0]({ name: 'bash', arguments: {} }), /白名单/)
  pass('createLocalTaskGate 注册单个 guard')
}

assert.deepEqual([...TASK_ALLOWED_TOOLS], ['read', 'write', 'glob', 'grep', 'todo_write'])
fs.rmSync(base, { recursive: true, force: true })
console.log(`\n${checks} checks passed`)
