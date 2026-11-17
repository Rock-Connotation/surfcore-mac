// 本机任务会话的工具闸门（T03）：能力天花板 + 路径围栏 + 只新建。
//
// 放在这层的原因：DSH 的 `tools.restrict` 只隐藏工具（注册期），`tools.guard`
// 才能拒绝执行，而且 guard 的拒绝是**单调**的——后面的监听器不能把它改回允许。
// 契约要求「Shell/PTC/别名/MCP/子任务都不能绕过」，所以白名单必须在 guard 里，
// 不能只靠 preset 少装几个包。
//
// 另一条硬约束：`fs-sandbox` 的 workspace-write 只限制**写入**，读取不受围栏
// （见 T01 矩阵）。所以 read/glob/grep 的路径必须由这里自己判，不能指望沙箱。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'local-task-gate'

export const inject = ['tools']

/**
 * 任务会话允许的工具集合。刻意只有文件类 + todo：
 * 没有 bash/pwsh（执行）、没有 subagent 家族/ralph/workflow（派生）、
 * 没有 mcp__*（外部副作用）、没有 tool-web（外发）、没有 present/goal。
 */
export const TASK_ALLOWED_TOOLS = Object.freeze(['read', 'write', 'glob', 'grep', 'todo_write'])

// 各工具的路径参数名（来自 dsh-tool-fs / dsh-tool-fs-search 的 schema）：
// `write` 用 file_path；read 用 file_path；glob/grep 用 path。
const PATH_ARGS = Object.freeze({
  read: ['file_path'],
  write: ['file_path'],
  glob: ['path'],
  grep: ['path'],
})

export function taskGateDenyReason(exec, { root, healthy = true, exists = (p) => fs.existsSync(p) } = {}) {
  if (!healthy) return '本机任务策略未确认在册（闸门已卸载或未通过自检），拒绝任何工具调用'
  const tool = exec?.name
  if (typeof tool !== 'string' || !tool) return '工具名无效，已拒绝'
  if (!TASK_ALLOWED_TOOLS.includes(tool)) {
    return `工具 "${tool}" 不在本机任务白名单内（只允许 ${TASK_ALLOWED_TOOLS.join('/')}）`
  }
  const args = exec.arguments ?? {}
  // 模型不得自行升权：守卫直接拒绝带 sandbox_permissions 的调用。
  if (args.sandbox_permissions !== undefined) return '本机任务不允许自行提升文件权限（sandbox_permissions）'
  for (const key of PATH_ARGS[tool] ?? []) {
    const raw = args[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || !raw) return `参数 ${key} 必须是非空字符串`
    const inside = resolveInsideRoot(root, raw)
    if (!inside.ok) return inside.reason
  }
  // 只新建：write 命中已存在的目标一律拒绝（模型"读过"不算覆盖授权）。
  if (tool === 'write') {
    const target = resolveInsideRoot(root, args.file_path)
    if (target.ok && exists(target.path)) {
      return `目标已存在，本阶段只允许新建：${path.relative(root, target.path)}`
    }
  }
  return undefined
}

/**
 * 把候选路径规范化后判断是否落在 root 内。
 * 不能只用 startsWith：`/w/a` 与 `/w/ab` 前缀相同但不是一个目录。
 * 符号链接要按真实路径判，否则 `/w/link -> /etc` 会绕过。
 */
export function resolveInsideRoot(root, candidate) {
  if (typeof root !== 'string' || !root) return { ok: false, reason: '任务没有确定的工作区根目录' }
  const absolute = path.resolve(root, candidate)
  // 不存在的目标：取最深的已存在祖先做 realpath，再把剩余片段接回去。
  let existing = absolute
  const rest = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    rest.unshift(path.basename(existing))
    existing = parent
  }
  let canonicalExisting
  try {
    canonicalExisting = fs.realpathSync(existing)
  } catch {
    return { ok: false, reason: `无法解析路径：${candidate}` }
  }
  let canonicalRoot
  try {
    canonicalRoot = fs.realpathSync(root)
  } catch {
    return { ok: false, reason: `工作区根目录不可访问：${root}` }
  }
  const resolved = rest.length ? path.join(canonicalExisting, ...rest) : canonicalExisting
  const rel = path.relative(canonicalRoot, resolved)
  if (rel === '') return { ok: true, path: resolved }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `路径越出工作区：${candidate}（工作区：${canonicalRoot}）` }
  }
  return { ok: true, path: resolved }
}

/**
 * @param root         任务工作区（canonicalRoot）
 * @param isHealthy    闸门健康位：策略不在册/自检失败时必须返回 false
 * @param exists       注入给测试
 */
export function createLocalTaskGate({ root, isHealthy = () => true, exists } = {}) {
  return {
    name,
    inject,
    apply(ctx) {
      ctx.tools.guard((exec) => taskGateDenyReason(exec, { root, healthy: isHealthy(), exists }))
    },
  }
}
