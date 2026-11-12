/**
 * 自主生物钟（2026-10-18 加，主人要求）——
 *
 * 为什么要有它：以前"醒来"要靠**有人在对话框里挂 clock** ✗ —— 那不是"她活在过日子"，
 * 是"你戳一下她动一下" ✗。主人明确要求：**计划要她自己执行，改配置要立刻生效** ✓。
 *
 * 做法（不需要任何外部 CLI）：
 *   · 插件宿主**常驻在 DSH 里** → 自己每 60 秒 tick 一次 ✓
 *   · tick 里跑 `bili.mjs night plan` 算出今天下一次醒来的时刻（结果写在 whale-night.json）
 *   · 到点了 → **biliV2Agent.enqueue**（V2 Host；V1 退役后 sessionController.prompt 路径已删除）
 *     往她自己的会话里塞一个"你醒了"的回合 ✓ → agent 真的醒来干活 ✓
 *   · 醒来后立刻标记 `woke` → 下一次 tick 自动排下一趟（多窗口 × 多次 ✓）
 *   · 设置页一保存 → 调 `invalidate()` 清掉旧计划 → 下一次 tick 按新配置重算 ✓（改完立刻生效 ✓）
 *
 * V1 为什么用"她自己的会话"：`sessionId` 固定（默认 bili-whale）→ 跨天保留她的上下文，
 *   而不是每天开一个新会话、每天忘光 ✗。V2-only（2026-11-12）：会话与权限由 V2 Host 管理。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readMemoryRouting } from '../../../src/core/memory-v2-routing.js'
import { execFile } from 'node:child_process'
// 收件箱读取复用工具链的实现（避免在插件里再抄一份 B站 接口 ✓）
import { pullFeed, makeHeaders } from '../tools/lib/msgfeed.mjs'
import { kindsNow, dynamicsEnabled, dynamicsGapMin, slotOf, CATCHUP_DAY } from '../tools/lib/kinds.mjs'
import { freeLimits } from '../tools/lib/limits.mjs'
import { config } from '../tools/lib/config.mjs'
import { pendingCount as attackPending } from '../tools/lib/attacks.mjs'
import { pinOf, noteOf } from '../tools/lib/pins.mjs'
import { markScheduleSlot } from '../tools/lib/night-schedule.mjs'
import { normalizeWindow, windowContains } from '../tools/lib/time-window.mjs'
import {
  BILI_ALIGNMENT_FILE, BILI_CONFIG, QQ_STATE_DIR, nodeRuntimeCommand, resolveNodeRuntime,
} from './paths.js'
import { resolvePersonaFile } from './persona.js'
import { readUnified } from './store.js'
import { memoryCardPromptBlock } from './memory-card.js'
import { buildSelfIdentityBlock, readQqSelfIdentity } from '../../../src/self-identity.js'
import { adminFromSources, adminPromptBlock } from '../../../src/admin-identity.js'
import { activeMemoryPaths, activePlatformStateDir, readPersonaLayerText } from '../../../src/character-persona.js'
import { composePersonaLayers } from '../../../src/persona-layers.js'
import { buildCharacterContext } from '../../../src/core/context.js'
import { buildPersonaIdentity, personaNameFromCard } from '../../../src/persona-identity.js'
import { interactEnabled } from '../tools/lib/interact.mjs'

// 当前角色的 B站 行为目录（角色系统未启用时回退旧目录）。
function platformDir() {
  const home = process.env.USERPROFILE || os.homedir()
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
  return activePlatformStateDir(path.join(dshHome, 'surfcore', 'bili'))
}

// ── 合体后的统一上下文：一张人设卡 + 身份对齐 + QQ 脱敏记忆 ────────────────────
// 旧版只注入 persona.name/ownerTitle/selfClaim 三行，B站这边其实看不到完整人设；
// 合体后统一从当前人格卡（unified persona.file）取同一张卡，QQ 和 B站不再各活各的。
function readTextFile(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

/** 人设卡里给 QQ 用的“称呼表/QQ 号”段落不能带进 B站：认人靠对齐表，不靠 QQ 号。 */
export function sanitizePersonaForBili(card) {
  const lines = String(card ?? '').split('\n');
  const kept = [];
  let skipSection = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      skipSection = /称呼|QQ\s*号|群友.*QQ|按\s*QQ/i.test(line);
    }
    if (skipSection) continue;
    kept.push(line);
  }
  return kept.join('\n')
    .replace(/（\s*QQ\s*\d{5,12}\s*）/gi, '')
    .replace(/\b\d{5,12}\b/g, '[号码已隐藏]');
}

/** 人设卡：取身份/性格/说话方式相关段落，别把整张卡塞进每一次唤醒。 */
function personaCardBlock() {
  const unified = readUnified().config
  if (unified.persona?.injectInBili === false) return ''
  const file = resolvePersonaFile()
  const card = readTextFile(file)
  if (!card) {
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'surfcore', 'bili.config.json'), 'utf8')) } catch { return {} } })()
    const p = cfg.persona ?? {}
    const bits = []
    if (p.name) bits.push(`你是「${p.name}」`)
    if (p.ownerTitle) bits.push(`称用户「${p.ownerTitle}」`)
    if (p.selfClaim) bits.push(`自称「${p.selfClaim}」`)
    return bits.length ? `［身份］${bits.join('，')}。（以此为准，别用别的称呼 ✓）` : ''
  }
  const max = Math.max(600, Math.min(6000, Number(unified.persona?.compactChars) || 2200))
  const composed = composePersonaLayers({
    core: card,
    // 身份底座：B站 也必须知道“我是谁、主人是谁”，不能只靠日常层里的那一行。
    identity: buildPersonaIdentity({
      name: personaNameFromCard(card),
      owner: String(unified?.admin?.displayName || '').trim() || '主人',
    }),
    // 语气层：B站 也要按同一个说话方式，不能只 QQ 有。
    tone: readPersonaLayerText('tone'),
    scene: readPersonaLayerText('scene', 'bili'),
    daily: readPersonaLayerText('daily'),
    maxChars: max,
    sceneId: 'bili',
  })
  const context = buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' }, budget: { maxChars: max }, includeMemory: false })
  const safeCard = sanitizePersonaForBili(context.ok ? context.text : (context.code === 'CHARACTER_CONTEXT_REQUIRED' ? composed.text || card : ''))
  const compact = composed.truncated ? `${safeCard}\n（人设卡按预算省略；完整卡在 ${file}）` : safeCard
  return [
    '［统一人设卡 · QQ 和 B站是同一个人］',
    compact,
    '',
    '以上人设对 QQ 与 B站两边同时生效；AGENTS.md 只写日子/流程，不另立人格。',
    '（人设卡里的 QQ 称呼表不会带进 B站；认人只按身份对齐表，且不得公开对方 QQ 号/群号。）',
  ].join('\n')
}

/** 身份对齐：高于记忆同步开关，单独读文件。 */
function alignmentBlockForBili() {
  const unified = readUnified().config
  if (unified.alignment?.enabled === false) return ''
  if (unified.alignment?.injectInBili === false) return ''
  return readTextFile(BILI_ALIGNMENT_FILE)
}

/**
 * 跨平台自我锚点（2026-10-23 用户要求）：B站 这边的她也要认得出**自己的 QQ 资料卡**。
 *
 * 以前 B站 侧只知道自己叫「小咪」、B站账号是谁，完全不知道 QQ 上的自己长什么样；
 * 于是别人把她的 QQ 主页截图甩过来，她只会当陌生人。锚点来源：
 *   · QQ 昵称 / QQ 号 ← 桥接登录时落的 `state/self-identity.json`（B站 进程拿不到网关）；
 *   · B站 昵称 / UID / 人格名 ← `bili.config.json` 的 self / persona。
 * 隐私：QQ 号在这里**打码**（328****288），够认人，又不至于被她写进公开评论。
 */
function selfIdentityBlockForBili() {
  const qqSelf = readQqSelfIdentity(QQ_STATE_DIR)
  let bili = {}
  try { bili = JSON.parse(fs.readFileSync(BILI_CONFIG, 'utf8')) } catch { bili = {} }
  return buildSelfIdentityBlock({
    qqNickname: qqSelf.nickname,
    qqUin: qqSelf.userId,
    biliName: bili?.self?.name,
    biliMid: bili?.self?.mid,
    personaName: bili?.persona?.name,
  }, { platform: 'bili' })
}

/**
 * 管理员（主人）身份 + 温柔规则。
 * QQ 和 B站 共用合体层的 admin 身份：B站 侧只读 B站 昵称/mid（不把 QQ 号带进 B站 提示词）。
 */
export function adminBlockForBili() {
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
  const cfgPath = process.env.SURFCORE_BILI_CONFIG || path.join(dshHome, 'surfcore', 'bili.config.json')
  let bili = {}
  try { bili = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch {}
  // 合体层还没写过 admin 时不能把默认空串当成"显式清空"，否则 B站 的 owner.mid 会被覆盖掉。
  const unifiedState = readUnified()
  const unified = unifiedState.hasAdmin ? unifiedState.config : { ...unifiedState.config, admin: undefined }
  return adminPromptBlock('bili', adminFromSources({ unified, bili, qq: {} }))
}

/** QQ → B站 的脱敏记忆（默认关闭；开启后才注入）。 */
function qqMemoryBlockForBili() {
  const unified = readUnified().config
  if (unified.memory?.qqToBili?.enabled !== true) return ''
  const text = readTextFile(activeMemoryPaths().qqForBili)
  if (!text) return ''
  return `［QQ 群里的近况（已脱敏；不含私信/联系方式）］\n${text}`
}

/** 记忆卡（B站侧）：只拿公开冲浪记忆 + 共享锚点，不含 QQ 私事（隐私边界）。 */
function memoryCardBlockForBili() {
  const unified = readUnified().config
  if (unified.memoryCard?.enabled === false) return ''
  const context = buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' }, includePersona: false, includeLife: false })
  return context.ok ? context.memoryText : (context.code === 'CHARACTER_CONTEXT_REQUIRED' ? memoryCardPromptBlock('bili') : '')
}

/** 每次唤醒都放在最前面的合体上下文（顺序：人设 → 自我锚点 → 管理员 → 对齐 → QQ 记忆 → 记忆卡）。 */
function identityContextLines() {
  return [
    personaCardBlock(),
    selfIdentityBlockForBili(),
    adminBlockForBili(),
    alignmentBlockForBili(),
    qqMemoryBlockForBili(),
    memoryCardBlockForBili(),
  ].filter(Boolean)
}

/** Same Bili persona/memory composition, bound to one role revision. V2-only：本入口不再组装旧记忆上下文。 */
export function biliContextForRound(request) {
  const routing = readMemoryRouting({ stateDir: QQ_STATE_DIR })
  if (!routing.ok) return {
    ok: false, code: routing.code || 'BILI_V2_ROUTING_UNAVAILABLE',
    error: '当前单轮入口不能使用旧记忆上下文。',
    hint: '打开记忆页核对当前V2来源审批和受管理任务；此入口不会降级读取V1记忆。', text: '', sections: [],
  }
  if (!request?.v2 && !request?.biliMemoryHost && !request?.memoryContext && !request?.preparedMemory) {
    return {
      ok: false, code: 'BILI_V2_MANAGED_ROUND_REQUIRED',
      error: '当前单轮入口不能使用旧记忆上下文。',
      hint: '打开记忆页核对当前V2来源审批和受管理任务；此入口不会降级读取V1记忆。', text: '', sections: [],
    }
  }
  const includeMemory = request?.includeMemory ?? Boolean(request?.memoryContext && request?.preparedMemory);
  const checked = buildCharacterContext({ ...request, scene: 'bili', audience: { channel: 'bili', ...(request?.audience || {}) }, memoryBackend: 'v2', includeMemory })
  if (!checked.ok) return checked
  return { ...checked, text: checked.text || (Array.isArray(checked.sections) ? checked.sections.map(s => s.text).join('\n\n') : '') }
}

/** 今天已经搭了几条话（读账本，给唤醒提示看进度） */
function taToday() {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(platformDir(), 'quota.json'), 'utf8'))
    const t = new Date().toLocaleDateString('sv-SE')
    return (q.log ?? []).filter((x) => x?.ta && new Date(x.at).toLocaleDateString('sv-SE') === t).length
  } catch { return 0 }
}

const TICK_MS = 60_000
const LISTEN_STATE = 'whale-listen.json'
/** 实时额度：设置页改完下一轮生效（config() 按 mtime 缓存）。 */
const limitsNow = () => freeLimits(config())

/**
 * 监听失败的日志文本：ReferenceError / TypeError 是程序错误，必须带类型和 stack，
 * 否则会被 catch 吞成一句“监听失败”，像网络故障一样难查。
 * 只截断，不写 token/cookie；stack 仅进 plugin.log。
 */
export function formatListenError(error) {
  const isProgrammerError = error instanceof ReferenceError || error instanceof TypeError
  const text = isProgrammerError
    ? String(error?.stack || error?.message || error)
    : String(error?.message || error);
  return text.slice(0, 800);
}

/** 叫醒她时塞进去的那段话已随 V1 prompt 闭包删除（V2-only：提示词由 V2 Host 按 kind 构造）。 */

export function startScheduler(ctx, opts) {
  const {
    dshHome,
    biliMjs,          // 指向 tools/bili.mjs（绝对路径）
    cwd,              // bili.mjs 子进程的工作目录
    sessionId = 'bili-whale',
    memoryV2 = null,
    biliV2Agent = null,
    onMemoryBlocked = () => {},
    tokenBudget = null, // 每日 token 额度服务（插件注入；单测可不传）
    log = () => {},
  } = opts

  const ACCOUNT_DIR = path.join(dshHome, 'surfcore', 'bili')
  const PLATFORM_DIR = activePlatformStateDir(ACCOUNT_DIR)
  const STATE = path.join(PLATFORM_DIR, 'whale-night.json')
  const CFG_FILE_REF = path.join(dshHome, 'surfcore', 'bili.config.json')     // 监听循环每次重读（改配置立刻生效 ✓）
  const CRED_REF = path.join(ACCOUNT_DIR, 'credentials.json')                // 账号凭证全局共用，不进角色包
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return null } }
  const writeState = (o) => {
    try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') } catch {}
  }
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
  const today = () => new Date().toLocaleDateString('sv-SE')

  // ── 每日 token 额度闸门（2026-10-23）──────────────────────────────────
  // 额度不是「少发几条」，而是「今天 B站 不再叫醒」：到 100% 后所有 prompt 都不投，
  // 等第二天 0 点或用户调高额度。监听类 tick 也直接跳过，避免把消息读掉却没回。
  let lastBudgetLogAt = 0
  function logBudgetBlocked(where, message) {
    if (Date.now() - lastBudgetLogAt < 10 * 60_000) return
    lastBudgetLogAt = Date.now()
    log(`[bili-whale] 今日 token 额度已到上限，跳过${where}${message ? `：${message}` : ''}`)
  }
  async function budgetBlockedNow(where = '叫醒') {
    if (!tokenBudget?.block) return false
    try {
      const gate = await tokenBudget.block('bili')
      if (gate?.blocked) { logBudgetBlocked(where, gate.message); return true }
    } catch (error) {
      // 额度服务异常不能把 B站 整条链路弄瘫；记一笔后按原逻辑继续（下次再判）。
      log(`[bili-whale] token 额度检查失败（${where}）：${String(error?.message ?? error).slice(0, 120)}`)
    }
    return false
  }
  function v2Unsupported() {
    const error = Object.assign(new Error('B站 V2 原生适配未就绪。'), { ok: false, code: 'BILI_V2_UNSUPPORTED', error: 'B站 V2 原生适配未就绪。', hint: '连接可信来源、模型路由及原生工具适配后重试；不会复用旧会话。' })
    onMemoryBlocked(error)
    throw error
  }
  function memoryRouting() {
    let route
    try { route = memoryV2?.getRouting ? memoryV2.getRouting() : readMemoryRouting({ stateDir: QQ_STATE_DIR }) } catch { route = { ok: false } }
    if (!route?.ok || route.backend !== 'v2') {
      const error = Object.assign(new Error('B站记忆路由不可用。'), { ok: false, code: route?.code || 'BILI_V2_ROUTING_UNAVAILABLE', error: 'B站记忆路由不可用。', hint: route?.hint || '恢复 Host 记忆路由后重试；不会切回旧上下文。' })
      onMemoryBlocked(error)
      throw error
    }
    return route.backend
  }
  /**
   * 推给 B站 会话一轮任务。
   * V2-only（V1 退役）：唯一路径是 biliV2Agent.enqueue —— 记忆路由不是 v2 直接 throw（fail-closed），
   * 旧的 sessionController.prompt 路径已随 V1 删除。
   * @param {object} input 交给 V2 agent 的本轮输入（含 requestId / kind / snapshot）
   */
  async function promptBili(input, signal, where = '叫醒') {
    memoryRouting();
    if (!biliV2Agent?.enqueue || !input) v2Unsupported()
    const requestId = 'bili-v2-' + crypto.createHash('sha256').update(JSON.stringify({ quotaDay: today(), where, input })).digest('hex')
    try {
      const result = await biliV2Agent.enqueue({ requestId, input, signal })
      if (result?.ok !== true) throw Object.assign(new Error(result?.error || 'B站 V2 已拒绝本轮。'), result)
      return result
    } catch (error) {
      const failure = Object.assign(new Error('B站 V2 本轮未获准。'), { ok: false, code: error?.code || 'BILI_V2_JOB_FAILED', error: 'B站 V2 本轮未获准。', hint: error?.hint || '检查 Host 来源、当前角色与原作业回执；不要自动重试发送。', unknown: error?.unknown === true })
      onMemoryBlocked(failure)
      throw failure
    }
  }

  // ⚠️ 2026-10-18 大坑：插件跑在 DSH 的 **Electron** 里，`process.execPath` = DeepSeek Harness.exe ✗
  //   用主程序跑脚本时，B站 的 `gethistory` 返回**空数组**（nav 之类却正常 ✗）→ 直播间永远"听不见" ✗
  //   实测对照：真 node.exe 5 秒命中；主程序 25 秒 0 行 ✗
  //   → 必须找到 **真正的 node.exe**（DSH 自带的运行时）✓
  let NODE_RUNTIME = null
  let NODE_RUNTIME_ERROR = null
  try {
    NODE_RUNTIME = resolveNodeRuntime()
  } catch (error) {
    NODE_RUNTIME_ERROR = error
    log(`[运行时] Node 不可用${error?.code ? `（${error.code}）` : ''}：${String(error?.message ?? error)}；下一步：${String(error?.hint ?? '检查 DSH_NODE 与 DSH 内置 Node')}`)
  }
  const NODE_ENV = NODE_RUNTIME ? { ...process.env, ...NODE_RUNTIME.envPatch } : null

  // 每次调用都重读 config：设置页把 agent.sandbox 改成 workspace-write 后，下一 tick 生效。
  // （V1 退役：ensurePermission/applySessionPermission/权限自动校正已随 sessionController 会话链路删除，
  //  B站 会话由 V2 Host（biliV2Agent）管理。）

  const runBili = (args) => new Promise((resolve) => {
    if (!NODE_RUNTIME) {
      resolve({
        ok: false, out: '', err: String(NODE_RUNTIME_ERROR?.message ?? 'Node runtime unavailable'),
        code: String(NODE_RUNTIME_ERROR?.code ?? 'NODE_RUNTIME_NOT_FOUND'),
        error: String(NODE_RUNTIME_ERROR?.message ?? 'Node runtime unavailable'),
        hint: String(NODE_RUNTIME_ERROR?.hint ?? '检查 DSH_NODE 与 DSH 内置 Node'),
      })
      return
    }
    execFile(NODE_RUNTIME.executable, [...NODE_RUNTIME.argvPrefix, biliMjs, ...args], {
      timeout: 120_000, windowsHide: true, env: NODE_ENV,
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '')
      const errorText = String(stderr ?? err?.message ?? '')
      resolve({
        ok: !err,
        out,
        err: errorText,
        ...(err ? {
          code: err.code === 'ENOENT' ? 'NODE_RUNTIME_EXEC_FAILED' : 'BILI_COMMAND_FAILED',
          error: errorText,
          hint: err.code === 'ENOENT'
            ? '确认所选 Node runtime 仍可执行，然后重载 SurfCore。'
            : '检查上面的 bili.mjs 错误信息，再重试对应命令。',
        } : {}),
      })
    })
  })

  /**
   * 确保本轮可以投递。V2-only（V1 退役）：B站 会话由 V2 Host（biliV2Agent）管理，
   * 旧的 sessionController.inspect/create + workspace/preset 装配 + 权限校正已全部删除；
   * 这里只保留 V2 可用性检查（路由校验在 promptBili 里做，fail-closed）。
   */
  async function ensureSession() {
    if (!biliV2Agent?.enqueue) v2Unsupported()
  }

  let waking = false
  async function tick() {
    if (waking) return
    if (!ctx.sessionController) return           // 服务还没就绪 → 下一 tick 再来
    if (await budgetBlockedNow('生物钟叫醒')) return
    const st = readState()
    const t = today()
    const currentSlot = (Array.isArray(st?.slots) ? st.slots : []).find((s) => s.id === st?.slotId)
    // C（2026-10-23）：窗口过了就记 missed，不补醒；也不让旧计划在窗口外迟到叫醒。
    if (currentSlot && !st.fired && currentSlot.status === 'pending' && Number(currentSlot.end) <= nowMin()) {
      markScheduleSlot(st, currentSlot.id, 'missed', nowMin())
      writeState({ ...st, slots: st.slots })
      log(`[bili-whale] 错过窗口 ${currentSlot.window}（${currentSlot.atText}）→ 记 missed，排下一趟`)
      await runBili(['night', 'plan'])
      return
    }

    // ①-0 掷到「不看」→ **也要叫醒她**（2026-10-18 主人定：醒或不醒都要写日记 ✓）
    //    以前这个分支只是被重算掉 ✗ → 那一趟等于什么都没发生、日记也没有 ✗
    // 2026-10-20 诊断：把 skip 的判定输入写进 dm-tick-err.log（每次 tick 都记）
    if (st && st.date === t && st.action === 'skip') {
      try {
        fs.appendFileSync(path.join(platformDir(), 'dm-tick-err.log'),
          `[skip-check] ${new Date().toISOString()} fired=${st.fired} at=${st.at} endAt=${st.endAt} nowMin=${nowMin()} pass=${!st.fired && nowMin() >= Number(st.at ?? st.endAt ?? 0)}\n`)
      } catch {}
    }
    if (st && st.date === t && st.action === 'skip' && !st.fired && nowMin() >= Number(st.at ?? st.endAt ?? 0)) {
      waking = true
      try {
        // V2-only：提示词由 V2 Host 侧按 kind='night-skip' 构造（V1 的手抄 prompt 闭包已删）
        await promptBili({ kind: 'night-skip', snapshot: structuredClone(st) }, new AbortController().signal, '叫醒')
        const slots = Array.isArray(st.slots) ? st.slots : []
        if (st.slotId) markScheduleSlot(st, st.slotId, 'skipped', nowMin())
        writeState({
          ...st,
          slots,
          fired: true,
          done: st.slotId ? false : true,   // 新排程只结束当前 slot；旧格式才结束全天
          wakes: Number(st.wakes ?? 0) + 1,
        })
        log(`[bili-whale] 这次轻醒 → 已叫醒她写日记 · ${st.reason ?? ''}${st.slotId ? '（继续下一趟）' : ''}`)
      } catch (e) {
        log(`[bili-whale] 不看那晚叫醒失败：${String(e.message).slice(0, 120)}`)
      } finally {
        waking = false
      }
      return
    }

    // ① 该重算的情形：没计划 / 跨天 / 上次已醒 / 排程走完 / 上一次轻醒已投递
    if (!st || st.date !== t || st.woke === true || st.done === true || !st.action
      || (st.action === 'skip' && st.fired === true)) {
      if (st && st.date === t && st.action === 'done') return   // 今天的次数用完了，别反复算
      const r = await runBili(['night', 'plan'])
      if (!r.ok) log(`[bili-whale] plan 失败：${(r.err || r.out).slice(0, 160)}`)
      return
    }

    if (st.action === 'wake' && !st.fired && nowMin() >= Number(st.at)) {
      waking = true
      try {
        // V2-only：提示词由 V2 Host 侧按 kind='night-wake' 构造（V1 的手抄 prompt 闭包已删）
        await promptBili({ kind: 'night-wake', snapshot: structuredClone(st) }, new AbortController().signal, '叫醒')
        const slots = Array.isArray(st.slots) ? st.slots : []
        if (st.slotId) markScheduleSlot(st, st.slotId, 'fired', nowMin())
        writeState({
          ...st,
          slots,
          fired: true,
          woke: true,
          done: false,
          wakes: Number(st.wakes ?? 0) + 1,
          watchWakes: (Number(st.watchWakes ?? 0) || 0) + 1,
          wokeAt: new Date().toISOString(),
        })
        log(`[bili-whale] 生物钟叫醒 · ${st.atText ?? ''}${st.window ? '（' + st.window + '）' : ''} · 第 ${Number(st.wakes ?? 0) + 1} 次`)
      } catch (e) {
        log(`[bili-whale] 叫醒失败：${String(e.message).slice(0, 160)}（下一 tick 重试）`)
      } finally {
        waking = false
      }
    }
  }

  // ── 全天监听（2026-10-18 加）：插件自己轮询收件箱，有人找她就叫醒她 ────────────────
  // 为什么放这里：`listen.allDay` 只控制"守多久" ✓，但**没人启动 listener** ✗ —— 跟生物钟当初的病一样。
  // 现在插件每 listen.commentIntervalSec 秒看一眼「回复我的 / @我的」；有新东西就 prompt 她一次。
  const LSTATE = path.join(PLATFORM_DIR, LISTEN_STATE)
  const readL = () => { try { return JSON.parse(fs.readFileSync(LSTATE, 'utf8')) } catch { return null } }
  const writeL = (o) => { try { fs.mkdirSync(path.dirname(LSTATE), { recursive: true }); fs.writeFileSync(LSTATE, JSON.stringify(o, null, 2) + '\n') } catch {} }
  const inWindow = (cfg) => {
    const wins = Array.isArray(cfg?.night?.windows) ? cfg.night.windows : []
    const d = new Date(); const m = d.getHours() * 60 + d.getMinutes()
    return wins.some((w) => {
      const normalized = normalizeWindow(w)
      return normalized.ok && windowContains(normalized, m)
    })
  }

  let listening = false
  let lastListenAt = 0
  // 直播间监听（2026-10-18 加）：插件替主人管着 `danmaku await` ✓
  let liveProc = null
  let liveRetryAt = 0
  let liveWaking = false
  let liveStopping = false   // 主动停（关开关）→ 退出回调不要当成"异常退出" ✗
  // 2026-10-26：danmaku-await 目前是「未实现」（退出码 3）。看到一次就不再重试，
  // 免得每分钟白拉子进程、日志刷屏（要恢复：实现脚本后删掉这个开关，见 RISK R30）。
  let liveUnimplemented = false
  let liveRoomNow = ''       // 当前在听的房间号（用于检测"主人换了房间" ✓）
    // ── 私信监听（2026-10-19）──────────────────────────────────────
    //   只认主人那一个会话 ✓ 系统通知/陌生人一律忽略 ✗
    //   你不说话 = 没有新私信 = 不叫醒 = 零 token ✓（主人设计的低风险互动 ✓）
    let dmBusy = false
    let lastDmAt = 0

    async function dmTick() {
      if (!interactEnabled()) return
      if (dmBusy) return
      if (await budgetBlockedNow('私信叫醒')) return
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, "utf8")) } catch { cfg = {} }
      const L = cfg.listen ?? {}
      if (!L.dm) return
      if (Date.now() - lastDmAt < 5_000) return   // 2026-10-19：原来 60s 和定时器叠成双层节流 → 最坏 2 分钟 ✗ 改成 5s
      lastDmAt = Date.now()
      dmBusy = true
      try {
        // 2026-10-20（用户定）：listen.dmScope = 'all' 时**谁找她都叫醒她**（不只主人）
        const any = String(L.dmScope ?? "owner") === "all"
        const r = await runBili(["dm-await", "--once", "--json", ...(any ? ["--any"] : [])])
        const line = String(r.out ?? "").trim().split("\n").pop() ?? ""
        let j = null
        try { j = JSON.parse(line) } catch { j = null }
        if (!j?.hit) return
        const items = any
          ? (j.items ?? [])
          : [{ mid: j.mid, name: j.name, text: j.text, ts: j.ts }]
        if (!items.length) return
        // V2-only：提示词由 V2 Host 侧按 kind='dm-notification' 构造
        await promptBili({ kind: 'dm-notification', snapshot: structuredClone(j), items: structuredClone(items), coverage: 'notification-only' }, new AbortController().signal, '叫醒')
      } catch (e) {
        try { fs.appendFileSync(path.join(platformDir(), "dm-tick-err.log"), new Date().toISOString() + " " + (e?.stack ?? e) + "\n") } catch {}
      }
      finally { dmBusy = false }
    }

  async function listenTick() {
    if (!interactEnabled()) return
    if (listening) return
    if (await budgetBlockedNow('评论区倾听')) return
    let cfg
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch { cfg = {} }
    const listenerCfg = cfg.listen ?? {}
    if (listenerCfg.comment === false) return                    // 评论区监听关掉了 ✓
    // 下限 60 秒（2026-10-18 测试期曾临时放宽到 2 秒 ✓ 已还原 ✓ —— B站 接口经不起每 2 秒锤 ✗）
    const interval = Math.max(60, Number(listenerCfg.commentIntervalSec ?? 300)) * 1000
    if (Date.now() - lastListenAt < interval) return
    lastListenAt = Date.now()
    // 「全天」关掉时：只在她醒着的窗口里听（省 token / 更自然 ✓）
    if (!listenerCfg.allDay && !inWindow(cfg)) return
    listening = true
    try {
      const cred = JSON.parse(fs.readFileSync(CRED_REF, 'utf8'))
      const H = makeHeaders(cred)
      const since = Number(readL()?.lastSeen ?? 0)
      const items = []
      items.push(...(await pullFeed('reply', { headers: H, pages: 1 })).items)
      if (String(listenerCfg.scope ?? 'both') !== 'reply') {
        try { items.push(...(await pullFeed('at', { headers: H, pages: 1 })).items) } catch {}
      }
      // 第一次跑：只把"现在"当基线，不把历史回复全倒一遍 ✓
      if (!since) { writeL({ lastSeen: Math.floor(Date.now() / 1000) }); listening = false; return }
      const fresh = items.filter((x) => Number(x.t) > since && (!listenerCfg.onlyOwner || String(x.mid) === String(cfg.owner?.mid ?? '')))
      if (!fresh.length) { listening = false; return }
      fresh.sort((a, b) => a.t - b.t)
      const who = fresh.map((x) => `${x.who}（${x.kind === 'at' ? '@' : '回复'}）`).join('、')
      // V2-only：提示词由 V2 Host 侧按 kind='comment-notification' 构造（V1 的手抄倾听步骤已删）
      await promptBili({ kind: 'comment-notification', items: structuredClone(fresh), coverage: 'notification-only' }, new AbortController().signal, '叫醒')
      writeL({ lastSeen: Math.max(...fresh.map((x) => Number(x.t))) })
      log(`[bili-whale] 监听命中 ${fresh.length} 条（${who}）→ 已叫醒`)
    } catch (e) {
      log(`[bili-whale] 监听失败：${formatListenError(e)}`)
    } finally {
      listening = false
    }
  }

  // ── 直播间监听：起一个 `danmaku await` 子进程；它命中就退出（自带契约）→ 叫醒她 → 再挂上 ──
  // 为什么放独立循环：tick() 会在"今天 done"时提前 return ✗，直播间不能跟着停 ✓
  async function liveTick() {
    if (!interactEnabled()) {
      if (liveProc !== null) {
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log('[bili-whale] 直播间监听已停（沉默逛开启 ✓）')
      }
      return
    }
    // ⚠️ 2026-10-18 主人定：直播间是**独立开关** —— 点开就开始、关掉就停（不受作息影响 ✓）
    if (ctx.sessionController) {
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
      if (!cur.listen?.live && liveProc !== null) {           // 开关被关掉 → 立刻停子进程 ✓
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log('[bili-whale] 直播间监听已停（开关关掉了 ✓）')
        return
      }
      // 2026-10-18 加：**换了房间号** → 也要立刻换线（以前只认开关 ✗ 换房间还在听老房间 ✗）
      const wantRoom = String(cur.listen?.liveRoom ?? '').trim()
      if (liveProc !== null && wantRoom && liveRoomNow && wantRoom !== liveRoomNow) {
        liveStopping = true
        try { liveProc.kill() } catch {}
        liveProc = null
        liveRetryAt = 0
        log(`[bili-whale] 直播间换房间：${liveRoomNow} → ${wantRoom}（立刻重挂 ✓）`)
        liveRoomNow = ''
        return
      }
    }
    if (liveProc !== null || liveWaking || liveRetryAt > Date.now()) return
    if (!ctx.sessionController) return
    if (await budgetBlockedNow('直播间叫醒')) return
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(CFG_FILE_REF, 'utf8')) } catch {}
    const L = cfg.listen ?? {}
    const room = String(L.liveRoom ?? '').trim()
    if (!L.live || !room) return
    if (liveUnimplemented) return

    // ⚠️ `danmaku-await.mjs` 是独立脚本（不走 bili.mjs 的 danmaku 子命令 ✗ —— 那是 pre/send/live ✓）
    const awaitScript = path.join(path.dirname(biliMjs), 'commands', 'danmaku-await.mjs')
    const args = [awaitScript, '--room', room]
    if (String(L.liveScope ?? 'owner') === 'owner' && cfg.owner?.mid) args.push('--operator-uid', String(cfg.owner.mid))
    if (!NODE_RUNTIME) {
      liveRetryAt = Date.now() + 30_000
      log(`[scheduler] 直播间监听启动失败（${String(NODE_RUNTIME_ERROR?.code ?? 'NODE_RUNTIME_NOT_FOUND')}）：${String(NODE_RUNTIME_ERROR?.message ?? '没有可用的 Node runtime')}；下一步：${String(NODE_RUNTIME_ERROR?.hint ?? '检查 DSH_NODE 与 DSH 内置 Node')}`)
      return
    }
    liveProc = execFile(NODE_RUNTIME.executable, [...NODE_RUNTIME.argvPrefix, ...args], {   // ⚠️ 必须使用已验证的 Node runtime
      // ⚠️ 千万不要写 `timeout: 0` ✗ —— 实测它会把子进程立刻 SIGTERM 掉（探针验过 ✓）；
      //   直播间监听本来就是长驻的，**不设 timeout** 才对 ✓
      windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: NODE_ENV,
      cwd: path.dirname(biliMjs),   // 脚本按相对路径找 lib/，必须给 cwd ✓
    }, (err, stdout, stderr) => {
      liveProc = null
      if (liveStopping) { liveStopping = false; return }   // 那是我们主动停的 ✓ 不算异常 ✗
      // 退出码 3 = 脚本自己声明「未实现」：记一条日志后不再重试（RISK R30）。
      if (err?.code === 3 || /未实现/.test(String(stderr ?? ''))) {
        liveUnimplemented = true
        console.error('[scheduler] 直播间监听未实现（danmaku-await 退出 3）：已停止重试；实现后再打开 listen.live')
        return
      }
      const out = String(stdout ?? '')
      // ⚠️ 2026-10-18 修真 bug：`danmaku-await` 命中时打印的是 **AWAIT_HIT** ✗
      //   我原来等的是 DANMAKU_HIT ✗ → 听见了也认不出 → 一直"退出/重挂"
      if (/AWAIT_HIT|DANMAKU_HIT/.test(out)) {
        liveWaking = true
        const lines = out.split('\n').map((s) => s.trim()).filter((s) => /AWAIT_HIT|DANMAKU_HIT|@/.test(s)).slice(-3).join(' / ').slice(0, 300)
        ;(async () => {
          try {
            await ensureSession()
            // V2-only：提示词由 V2 Host 侧按 kind='live-notification' 构造
            await promptBili({ kind: 'live-notification', room: structuredClone(room), stdout: out, coverage: 'transport-output' }, new AbortController().signal, '叫醒')
            log(`[bili-whale] 直播间命中 → 已叫醒 · ${lines.slice(0, 80)}`)
          } catch (e) {
            log(`[bili-whale] 直播间叫醒失败：${String(e.message).slice(0, 120)}`)
          } finally {
            liveWaking = false
            // 2026-10-18 主人定：**监听到就回（实时）** ✓ —— 回复完 2 秒就重新挂上 ✗ 不再冷却 2 分钟
            liveRetryAt = Date.now() + 2_000
          }
        })()
      } else {
        // 退出但没命中 → 把"怎么退的"记全（2026-10-18：以前只记一句话，排不动 ✗）
        // 退避 12 秒（2026-10-18 改：原来 60 秒，外部误杀一次要等一分钟以上才回来 ✗）
        const tail = String(out ?? '').trim().split('\n').slice(-2).join(' | ').slice(-200)
        const why = [
          err ? `code=${err.code ?? '?'} signal=${err.signal ?? '?'}` : 'code=0',
          String(stderr ?? '').trim().slice(0, 150),
          tail,
        ].filter(Boolean).join(' · ')
        log(`[bili-whale] 直播间监听退出：${why}（12 秒后重挂）`)
        liveRetryAt = Date.now() + 12_000
      }
    })
    liveRoomNow = room   // 记下"现在听的是哪个房间" → 主人换房间时靠它检测 ✓
    log(`[bili-whale] 直播间监听已挂上（房间 ${room} · ${String(L.liveScope ?? 'owner') === 'owner' ? '只回主人' : '只回@她的'}）✓`)
  }

  // ── 四类动态的定点提醒 + 补发（2026-10-21 加，当晚扩成"错过就补"）──────
  //   正常：按设置页的 slot 到点提醒（默认 08/12/16/20）
  //   补发：重启后发现今天有类错过了时段 → **一次只提醒一类**，两条之间隔 dynamics.gapMin
  //   （`daily-nudge.json` 记每类最近一次提醒，gapMin 内不重复吵她 ✓）
  async function dynTick() {
    if (!interactEnabled()) return
    if (!ctx.sessionController) return
    if (await budgetBlockedNow('动态提醒')) return
    const cfgNow = config()
    const KINDS_NOW = kindsNow(cfgNow)
    const gapMs = Math.max(5, dynamicsGapMin(cfgNow)) * 60_000
    const L = limitsNow()
    const now = new Date()
    const h = now.getHours() + now.getMinutes() / 60
    const NUDGE = path.join(dshHome, 'daily-nudge.json')
    let ns = {}
    try { ns = JSON.parse(fs.readFileSync(NUDGE, 'utf8')) } catch {}
    let dstate = {}
    try { dstate = JSON.parse(fs.readFileSync(path.join(PLATFORM_DIR, 'daily-dynamic.json'), 'utf8')) } catch {}
    // 最近一次真发出去的动态（用来保证补发之间有 30 分钟）
    const lastPost = Object.values(dstate ?? {})
      .map((s) => new Date(s?.at ?? 0).getTime())
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => b - a)[0] ?? 0
    if (lastPost && Date.now() - lastPost < gapMs) return

    // ── 23:00 待审清单（2026-10-21 用户定：晚上回来审"疑似攻击/阴阳"那些）────
    if (h >= 23 && h < 23.2) {
      const akey = `${today()}:attack-review`
      if (!ns[akey]) {
        const n = attackPending()
        ns[akey] = new Date().toISOString()
        try { fs.writeFileSync(NUDGE, JSON.stringify(ns, null, 2)) } catch {}
        if (n > 0) {
          try {
            await ensureSession()
            // V2-only：提示词由 V2 Host 侧按 kind='attack-review' 构造
            await promptBili({ kind: 'attack-review', pendingCount: n }, new AbortController().signal, '叫醒')
            log(`[bili-whale] 23:00 待审提醒（${n} 条）`)
          } catch (e) { log(`[bili-whale] 待审提醒失败：${String(e.message).slice(0, 100)}`) }
          return
        }
      }
    }

    // ── 搭话额度"催进度"（2026-10-21 用户要"每天用完"）──────────────
    //   16:00 之后如果还没搭够，每 90 分钟提醒她一次，直到用完 ✓
    if (h >= 16) {
      const used = taToday()
      const left = L.taDaily - used
      if (left > 0) {
        const tkey = `${today()}:ta-nudge`
        const last = ns[tkey] ? new Date(ns[tkey]).getTime() : 0
        if (!last || Date.now() - last > 90 * 60_000) {
          ns[tkey] = new Date().toISOString()
          try { fs.writeFileSync(NUDGE, JSON.stringify(ns, null, 2)) } catch {}
          try {
            await ensureSession()
            // V2-only：提示词由 V2 Host 侧按 kind='ta-nudge' 构造
            await promptBili({ kind: 'ta-nudge', used, limit: L.taDaily }, new AbortController().signal, '叫醒')
            log(`[bili-whale] 搭话催进度：${used}/${L.taDaily}`)
          } catch (e) { log(`[bili-whale] 搭话提醒失败：${String(e.message).slice(0, 100)}`) }
          return
        }
      }
    }

    if (!dynamicsEnabled(cfgNow)) return
    for (const [kind, k] of Object.entries(KINDS_NOW)) {
      if (k.enabled === false) continue                     // 设置页关掉这一类
      if (dstate?.[kind]?.date === today()) continue      // 今天已发
      if (h < Number(k.slot)) continue                    // 还没到点
      // 2026-10-21 用户定：**过了本类时段只有上线日才补**，明天起照常（错过就等明天）
      const inSlotNow = slotOf(kind, now, KINDS_NOW)
      if (!inSlotNow && today() !== CATCHUP_DAY) continue
      const key = `${today()}:${kind}`
      const lastNudge = ns[key] ? new Date(ns[key]).getTime() : 0
      if (lastNudge && Date.now() - lastNudge < gapMs) continue
      ns[key] = new Date().toISOString()
      try { fs.writeFileSync(NUDGE, JSON.stringify(ns, null, 2)) } catch {}

      // 还在本类时段里 → 正常提醒；已经过了（只有上线日）→ 补发口吻（必须带 --catchup）
      const inSlot = inSlotNow
      try {
        await ensureSession()
        // V2-only：提示词由 V2 Host 侧按 kind='daily-nudge' 构造
        await promptBili({ kind: 'daily-nudge', kindKey: kind, inSlot, definition: structuredClone(k), pin: pinOf(kind), note: noteOf(kind) }, new AbortController().signal, '叫醒')
        log(`[bili-whale] 动态提醒 · ${kind}（${inSlot ? '到点' : '补发'}）`)
      } catch (e) {
        log(`[bili-whale] 动态提醒失败：${String(e.message).slice(0, 120)}`)
      }
      return   // 一次只提醒一类 ✓
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, TICK_MS)
  // 一次性启动定时器单独收好：stop() 必须把它们也清掉，否则测试/卸载后进程
  // 仍被 8~25 秒后的回调吊着（Node 24 下强制 exit 还会撞 libuv 断言）。
  const startupTimers = [
    setTimeout(() => { tick().catch(() => {}) }, 8000),          // 启动 8 秒后先跑一次
    setTimeout(() => { dynTick().catch(() => {}) }, 12_000),
    setTimeout(() => { listenTick().catch(() => {}) }, 15_000),
    setTimeout(() => { dmTick().catch(() => {}) }, 25_000),
    setTimeout(() => { liveTick().catch(() => {}) }, 20_000),
  ]
  // 2026-10-21（用户定）：四类动态各有固定发布点 —— 到点叫她一次（08/12/16/20）
  const timerDyn = setInterval(() => { dynTick().catch(() => {}) }, 60_000)
  // 30 秒看一眼"到点没"（2026-10-18 测试期曾改 2.5 秒 ✓ 已还原 ✓），真正间隔由配置定 ✓
  const timer2 = setInterval(() => { listenTick().catch(() => {}) }, 30_000)
  const timerDm = setInterval(() => { dmTick().catch(() => {}) }, 20_000)   // 2026-10-19: 60s -> 20s, 私信要像聊天; 每次只是一个 get_sessions 请求 很轻
  const timer3 = setInterval(() => { liveTick().catch(() => {}) }, 60_000)     // 直播间：挂了就一直跑，断了自动重挂 ✓
  log(`[bili-whale] 自主生物钟已启动（每 ${TICK_MS / 1000}s tick · 会话 ${sessionId}）；监听 + 直播间监看都挂上了 ✓`)

  return {
    /** 设置页一保存就调它：清掉旧计划，下一次 tick 按新配置重算 ✓ */
    invalidate() {
      // ⚠️ 2026-10-18 修：以前直接删状态文件 → 把「今天已醒几次」也抹了 ✗
      //   现在只清**计划**，保留 `{ date, wakes }` ✓（tick 里 `!st.action` 会触发重算 ✓）
      try {
        const old = readState()
        if (old && old.date === today()) writeState({ date: old.date, wakes: Number(old.wakes ?? 0) })
        else fs.rmSync(STATE, { force: true })
      } catch {}
      lastListenAt = 0            // 监听间隔也立刻重读 ✓（改完全天/间隔马上生效）
      writeL({})                  // 重置基线 → 下次按"现在"重新算，不会把旧的倒出来 ✓
      tick().catch(() => {})
      listenTick().catch(() => {})
      dmTick().catch(() => {})
      // ⭐ 直播间是**单独开关**：保存设置就立刻生效（点开就跑 ✓ 关掉就停 ✓），不等下一轮定时器
      liveTick().catch(() => {})
    },
    stop() { clearInterval(timer); clearInterval(timer2); clearInterval(timer3); clearInterval(timerDyn); clearInterval(timerDm); for (const t of startupTimers) clearTimeout(t); try { liveProc?.kill() } catch {} try { permissionListenerOff?.() } catch {} },
    /** 切角色时用：停定时器 + 取消当前 DSH 会话的在途回合，避免旧人格继续跑。 */
    async retire() {
      this.stop();
      let v2Retired = { ok: true, retired: true };
      if (biliV2Agent?.retire) v2Retired = await biliV2Agent.retire();
      try { await ctx.sessionController?.cancel?.({ sessionId }) } catch (error) { log(`[bili-whale] 取消旧会话失败：${error?.message ?? error}`) }
      return v2Retired;
    },
    tick,
    listenTick,
    liveTick,
  }
}
