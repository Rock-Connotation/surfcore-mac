// 本机任务会话的工具闸门（T03）：能力天花板 + 路径围栏 + 原生只新建。
//
// 放在这层的原因：DSH 的 `tools.restrict` 只隐藏工具（注册期），`tools.guard`
// 才能拒绝执行，而且 guard 的拒绝是**单调**的——后面的监听器不能把它改回允许。
//
// 仅新建的双重保护：
//   1. `taskGateDenyReason` 在 pre-execute 阶段先做存在性快速拒绝；
//   2. `fs/write-intent` 瀑布流以 `{ prepend: true }` 抢占返回 `{ kind: 'createIfAbsent' }`
//      （不调用 `next()`，从而使已读过文件的 session 也无法从 fs-observation-policy 拿到
//      replaceIfVersion），由 DSH `fs-local` 通过硬链接原子发布（`EEXIST` 不覆盖竞争文件）。
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

export const DESKTOP_PRESET_ID = 'ptc'
export const DESKTOP_ALLOWED_TOOLS = Object.freeze([
  'run_code', 'read', 'read_image', 'write', 'edit', 'apply_patch',
  'glob', 'grep', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill',
  'cua', 'ask_user_question', 'todo_write', 'web_search', 'web_fetch',
  'skill', 'present',
])
export const DESKTOP_ALLOWED_PREFIXES = Object.freeze(['mcp__surfcore-chrome__'])

export function isDesktopToolAllowed(tool) {
  if (typeof tool !== 'string' || !tool) return false
  return DESKTOP_ALLOWED_TOOLS.includes(tool) || DESKTOP_ALLOWED_PREFIXES.some((p) => tool.startsWith(p))
}

export function taskDesktopDenyReason(exec, { healthy = true } = {}) {
  if (!healthy) return '桌面任务策略未确认在册（宿主已卸载或任务已停止），拒绝任何工具调用'
  const tool = exec?.name
  if (typeof tool !== 'string' || !tool) return '工具名无效，已拒绝'
  if (isDesktopToolAllowed(tool)) return undefined
  return `工具 "${tool}" 不在桌面任务白名单内，已拒绝`
}

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
  // 没有工作区根 = 无法判围栏，一律拒绝（fail-closed）。
  if (typeof root !== 'string' || !root) return '本机任务会话没有工作区根，无法判定路径围栏，已拒绝'
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
  // 这里只是前置快速拒绝；底层并发竞态由 fs/write-intent -> createIfAbsent 原子硬链接兜底。
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
  if (typeof root !== 'string' || !root) return { ok: false, reason: '任务没有确定的工作区根目录' } // failure-lint:ignore 内部路径判定返回给 guard 拒绝文案
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
    return { ok: false, reason: `无法解析路径：${candidate}` } // failure-lint:ignore 内部路径判定返回给 guard 拒绝文案
  }
  let canonicalRoot
  try {
    canonicalRoot = fs.realpathSync(root)
  } catch {
    return { ok: false, reason: `工作区根目录不可访问：${root}` } // failure-lint:ignore 内部路径判定返回给 guard 拒绝文案
  }
  const resolved = rest.length ? path.join(canonicalExisting, ...rest) : canonicalExisting
  const rel = path.relative(canonicalRoot, resolved)
  if (rel === '') return { ok: true, path: resolved }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `路径越出工作区：${candidate}（工作区：${canonicalRoot}）` } // failure-lint:ignore 内部路径判定返回给 guard 拒绝文案
  }
  return { ok: true, path: resolved }
}

/** 会话自己的工作区（preset 行没有 root 参数时用它）。 */
function sessionRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

// 闸门存活登记与生命周期监听：任务派发前和在途期间都必须知道闸门是否卸载。
const liveGates = new Map()
const gateListeners = new Map()

function notifyGateListeners(presetId, live) {
  const set = gateListeners.get(presetId)
  if (!set) return
  for (const listener of [...set]) {
    try { listener(live) } catch {}
  }
}

export function onGateLivenessChange(presetId, listener) {
  if (typeof listener !== 'function') return () => {}
  let set = gateListeners.get(presetId)
  if (!set) {
    set = new Set()
    gateListeners.set(presetId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) gateListeners.delete(presetId)
  }
}

export function taskGateIsLive(presetId) {
  return (liveGates.get(presetId) ?? 0) > 0
}

export function _gateLivenessCount(presetId) {
  return liveGates.get(presetId) ?? 0
}

function defaultMatchesActor(ctx, { root, presetId }) {
  return (actor) => {
    const agentCtx = actor?.agent?.ctx
    const agentPresets = agentCtx?.get?.('agentPresets') ?? ctx?.get?.('agentPresets')
    if (agentPresets?.composedPreset) {
      return agentPresets.composedPreset(agentCtx) === presetId
    }
    if (typeof root === 'string' && root) {
      const cwd = sessionRoot(actor)
      if (!cwd) return actor?.agent === undefined
      return path.resolve(cwd) === path.resolve(root)
    }
    return false
  }
}

function mount(ctx, { root, presetId, isHealthy, exists, matchesActor }) {
  const prev = liveGates.get(presetId) ?? 0
  liveGates.set(presetId, prev + 1)
  if (prev === 0) notifyGateListeners(presetId, true)

  const matchActor = matchesActor ?? defaultMatchesActor(ctx, { root, presetId })

  // 真实 DSH Host 会把全局层工具与 MCP（snowluma / web-search / team_task 等）继承进 preset 作用域；
  // 不能用 `allow: []`（agent.ctx 是 presetScope 的子域，会把同在 presetScope 里的 read/write 也一并掩盖），
  // 而是动态把当前与后续新增的、且不在 TASK_ALLOWED_TOOLS 内的全局工具逐一放入 deny，保留 read / write 给子会话。
  const restrictDisposers = []
  const deniedGlobalTools = new Set()
  const trackedAgents = new Set()
  let offToolsChange = null
  let offAgentCreated = null
  let offAgentDisposed = null
  function denyForeignGlobalTools() {
    if (typeof ctx.tools?.restrict !== 'function') return
    const candidates = new Set()
    for (const scopeArg of [undefined, ctx]) {
      let list = []
      try { list = ctx.tools.schemas?.(scopeArg) ?? [] } catch { list = [] }
      for (const item of list) {
        const toolName = item?.name
        if (typeof toolName === 'string' && toolName && toolName !== 'run_code' && !TASK_ALLOWED_TOOLS.includes(toolName)) {
          candidates.add(toolName)
        }
      }
    }
    for (const toolName of candidates) {
      if (deniedGlobalTools.has(toolName)) continue
      deniedGlobalTools.add(toolName)
      try {
        const disp = ctx.tools.restrict({ deny: [toolName] })
        if (typeof disp === 'function') restrictDisposers.push(disp)
      } catch (error) {
        deniedGlobalTools.delete(toolName)
        if (!String(error?.message ?? '').includes('requires a scoped context')) {
          // 若是工具尚不在当前 preset 作用域的 restrictableNames 里，忽略单条；其余真实错误保留上抛。
          if (!String(error?.message ?? '').includes('unknown global tool')) throw error
        }
      }
    }
  }
  // 第三方全局插件（如 clutch-dsh-worktree）会监听 agent/created 并直接向子会话的 agent.ctx
  // 注册工具（own.tools）。DSH 的 tools.restrict() 按设计只过滤继承来的全局/祖先工具，
  // 对 agent.ctx 自己的 layer 豁免，且 restrict() 对 own.tools 会报 unknown global tool。
  // 因此这里在 preset 作用域内同时清理属于本 preset 的 agent layer 中的越界工具，
  // 确保任何第三方插件注入的 agent-scoped 工具既不会出现在 schemas/resolve 中，也不能被模型看到。
  function purgeForeignAgentTools(extraAgents = []) {
    const layers = ctx.tools?.layers
    if (typeof layers?.peek !== 'function') return
    const ap = ctx.get?.('agentPresets')
    const candidates = new Set([...trackedAgents, ...extraAgents, ...(ctx.get?.('agents')?.list?.() ?? [])])
    for (const agent of candidates) {
      if (!agent?.ctx) continue
      if (ap?.composedPreset && ap.composedPreset(agent.ctx) !== presetId) continue
      purgeLayerTools(layers, agent, (toolName) => toolName === 'run_code' || TASK_ALLOWED_TOOLS.includes(toolName))
    }
  }
  denyForeignGlobalTools()
  purgeForeignAgentTools()
  offToolsChange = ctx.on?.('tools/change', () => {
    denyForeignGlobalTools()
    purgeForeignAgentTools()
  })
  offAgentCreated = ctx.on?.('agent/created', ({ agent } = {}) => {
    if (!agent?.ctx) return
    const ap = ctx.get?.('agentPresets')
    if (ap?.composedPreset && ap.composedPreset(agent.ctx) !== presetId) return
    trackedAgents.add(agent)
    purgeForeignAgentTools([agent])
  }, { global: true })
  offAgentDisposed = ctx.on?.('agent/disposed', ({ agent } = {}) => {
    if (agent) trackedAgents.delete(agent)
  }, { global: true })

  const disposeGuard = ctx.tools.guard((exec) => {
    if (typeof matchesActor === 'function' && !matchesActor(exec)) return undefined
    if (exec?.agent?.ctx) {
      const ap = exec.agent.ctx.get?.('agentPresets') ?? ctx?.get?.('agentPresets')
      if (ap?.composedPreset && ap.composedPreset(exec.agent.ctx) !== presetId) return undefined
    }
    const base = root ?? sessionRoot(exec)
    return taskGateDenyReason(exec, { root: base, healthy: isHealthy() && taskGateIsLive(presetId), exists })
  })

  // P0-3：DSH write 工具通过 `fs/write-intent` 决定覆盖还是 createIfAbsent。
  // 这里以 prepend:true 抢在 fs-observation-policy 之前返回 createIfAbsent 且不调 next()，
  // 确保即便模型刚 read 过已有文件，也绝不会获得 replaceIfVersion 覆盖权限。
  const offWriteIntent = ctx.on?.('fs/write-intent', (_target, actor, next) => {
    if (!matchActor(actor)) return next()
    if (!isHealthy() || !taskGateIsLive(presetId)) {
      throw new Error('本机任务策略未确认在册（闸门已卸载或未通过自检），拒绝文件写入')
    }
    return { kind: 'createIfAbsent' }
  }, { prepend: true })

  // 卸载/热重载时递减并清理注册：计数归零后立即通知 runner/host 停掉在途任务。
  ctx.effect?.(() => () => {
    try { typeof offToolsChange === 'function' && offToolsChange() } catch {}
    try { typeof offAgentCreated === 'function' && offAgentCreated() } catch {}
    try { typeof offAgentDisposed === 'function' && offAgentDisposed() } catch {}
    trackedAgents.clear()
    for (const disp of restrictDisposers.splice(0)) { try { disp() } catch {} }
    try { typeof disposeGuard === 'function' && disposeGuard() } catch {}
    try { typeof offWriteIntent === 'function' && offWriteIntent() } catch {}
    const left = (liveGates.get(presetId) ?? 1) - 1
    if (left > 0) liveGates.set(presetId, left)
    else {
      liveGates.delete(presetId)
      notifyGateListeners(presetId, false)
    }
  })
}

function purgeLayerTools(layers, agent, isAllowedFn) {
  if (typeof layers?.peek !== 'function' || !agent?.ctx) return
  for (const scope of new Set([agent, agent.ctx])) {
    const layer = layers.peek(scope)
    const data = layer?.tools?.data
    if (!(data instanceof Map)) continue
    for (const toolName of [...data.keys()]) {
      if (!isAllowedFn(toolName)) data.delete(toolName)
    }
  }
}

/**
 * Isolate SurfCore-owned `ptc` desktop task sessions without touching ordinary user `ptc` sessions.
 * Blocks SurfCore QQ/Bili MCPs, subagent delegation, background scheduling, and third-party global injections.
 */
export function mountDesktopGate(ctx, { ownsSession = () => false, isHealthy = () => true, presetId = DESKTOP_PRESET_ID } = {}) {
  const prev = liveGates.get(presetId) ?? 0
  liveGates.set(presetId, prev + 1)
  if (prev === 0) notifyGateListeners(presetId, true)

  const restrictedByAgent = new WeakMap()
  const trackedOwnedAgents = new Set()

  function lockDownAgent(agent) {
    if (!agent?.ctx) return
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !ownsSession(sessionId)) return
    trackedOwnedAgents.add(agent)
    let denied = restrictedByAgent.get(agent)
    if (!denied) {
      denied = new Set()
      restrictedByAgent.set(agent, denied)
    }
    const candidates = new Set()
    for (const list of [
      () => ctx.tools?.definitions?.(agent),
      () => ctx.tools?.schemas?.(agent),
      () => ctx.tools?.schemas?.(undefined),
    ]) {
      let items = []
      try { items = list() ?? [] } catch { items = [] }
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (typeof item?.name === 'string' && item.name && !isDesktopToolAllowed(item.name)) {
          candidates.add(item.name)
        }
      }
    }
    if (typeof agent.ctx?.tools?.restrict === 'function') {
      for (const toolName of candidates) {
        if (denied.has(toolName)) continue
        denied.add(toolName)
        try {
          agent.ctx.tools.restrict({ deny: [toolName] })
        } catch {
          denied.delete(toolName)
        }
      }
    }
    purgeLayerTools(ctx.tools?.layers, agent, isDesktopToolAllowed)
  }

  function prepareSessionAgent(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return
    const agent = ctx.get?.('agents')?.get?.(sessionId) ?? ctx.agents?.get?.(sessionId)
    if (agent) lockDownAgent(agent)
  }

  const offToolsChange = ctx.on?.('tools/change', () => {
    for (const agent of trackedOwnedAgents) lockDownAgent(agent)
  })
  const offAgentCreated = ctx.on?.('agent/created', ({ agent } = {}) => {
    if (agent) lockDownAgent(agent)
  }, { global: true })
  const offAgentDisposed = ctx.on?.('agent/disposed', ({ agent } = {}) => {
    if (agent) trackedOwnedAgents.delete(agent)
  }, { global: true })
  const disposeGuard = typeof ctx.tools?.guard === 'function'
    ? ctx.tools.guard((exec) => {
        const sessionId = exec?.agent?.session?.id
        if (typeof sessionId !== 'string' || !ownsSession(sessionId)) return undefined
        return taskDesktopDenyReason(exec, { healthy: isHealthy() && taskGateIsLive(presetId) })
      })
    : null

  ctx.effect?.(() => () => {
    try { typeof offToolsChange === 'function' && offToolsChange() } catch {}
    try { typeof offAgentCreated === 'function' && offAgentCreated() } catch {}
    try { typeof offAgentDisposed === 'function' && offAgentDisposed() } catch {}
    try { typeof disposeGuard === 'function' && disposeGuard() } catch {}
    trackedOwnedAgents.clear()
    const left = (liveGates.get(presetId) ?? 1) - 1
    if (left > 0) liveGates.set(presetId, left)
    else {
      liveGates.delete(presetId)
      notifyGateListeners(presetId, false)
    }
  })

  return Object.freeze({ prepareSessionAgent })
}

/** preset 行入口：root 按会话 cwd 解析。 */
export function apply(ctx) {
  mount(ctx, { presetId: 'local-task', isHealthy: () => true })
}

export function createLocalTaskGate({ root, presetId = 'local-task', isHealthy = () => true, exists, matchesActor } = {}) {
  return { name, inject, apply: (ctx) => mount(ctx, { root, presetId, isHealthy, exists, matchesActor }) }
}
