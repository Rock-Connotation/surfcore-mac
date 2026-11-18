// 私信监听 —— V2 退役 R2/F03：稳定身份、pending 重放、持久接管回执、分域 ACK。
//
// 状态模型（单文件、原子写 + 跨进程锁；复用 Host registry 的 fsync/rename/同 ID 查询语义）：
//   version 2，scopes.owner / scopes.all 各自持有 { cursor, seen, pending, receipts, initialized }。
//   一条通知的 ID = sha256([账号, 角色id, epoch, mid, msgKey, ts])，
//   不含 observedAt / quotaDay / 批次顺序 / 数组下标。
//   pending 保存第一次观察到的不可变原件（original），--once 优先重放它。
//   accepted（Host 持久接管）/ terminal（作业或平台完成）/ 游标 ACK 分开记录，不合并成一个布尔。
//
// 用法：
//   --once --json [--any]                 轮询；输出重放 pending + 新通知（只登记 pending，不推进游标）
//   --baseline [--any]                   只初始化对应 scope 的基线，保留其它 scope 的 pending/回执
//   --query <requestId> --json           只读查询同 ID 的当前状态与持久接管回执（未知状态不新建 ID）
//   --transition <requestId> --receipt <json>  写持久接管/终态回执（不推进游标）
//   --ack <requestId> [--receipt <json>] 推进对应 scope 游标、移 pending、落终态回执
//
// 失败一律结构化：{ ok:false, code, error, hint } + 非 0 退出码。
// 状态读错/损坏/不可读一律 blocked，绝不伪装 fresh、不重置真实游标、不覆盖其它 scope。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountBili, biliState, currentCharacter, SURFCORE_DIR } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const BASE = !!opt.baseline
const ONCE = !!opt.once || BASE
const JSONOUT = !!opt.json
const ANY = !!opt.any
const ACK = typeof opt.ack === 'string' ? opt.ack : ''
const TRANSITION = typeof opt.transition === 'string' ? opt.transition : ''
const QUERY = typeof opt.query === 'string' ? opt.query : ''
const RECEIPT_RAW = typeof opt.receipt === 'string' ? opt.receipt : ''
// 两个作用域可能持有同一官方消息的 pending；调度器显式传 --scope，避免 owner 的 ACK
// 误消费 all 的 pending（或反之）。不传时保持旧的“先 owner 后 all”查找。
const SCOPE_OPT = typeof opt.scope === 'string' ? opt.scope : ''
if (SCOPE_OPT && !['owner', 'all'].includes(SCOPE_OPT)) {
  const error = Object.assign(new Error(`未知的 scope：${SCOPE_OPT}`), { exit: 6 })
  if (JSONOUT) console.log(JSON.stringify({ ok: false, code: 'BILI_DM_SCOPE_INVALID', error: `未知的 scope：${SCOPE_OPT}`, hint: '只接受 owner 或 all。' }))
  console.error(`✗ [BILI_DM_SCOPE_INVALID] 未知的 scope：${SCOPE_OPT} · 只接受 owner 或 all。`)
  process.exit(error.exit)
}

const STATE = biliState('dm-await-state.json')
const LOCK = STATE + '.lock'
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')
const SELF = String(cfg.self?.mid ?? '').trim()
const CHARACTER = currentCharacter()
const ACCOUNT = SELF
const ROLE_ID = String(CHARACTER?.id ?? '')
const ROLE_EPOCH = Number(CHARACTER?.epoch ?? 0)

const CREDENTIALS = (() => { try { return JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8')) } catch { return {} } })()
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${CREDENTIALS.sessdata ?? ''}; bili_jct=${CREDENTIALS.bili_jct ?? ''}; buvid3=${CREDENTIALS.buvid3 ?? ''}`,
}

// ── 会话历史读取（R2 批次 B）────────────────────────────────────────────────
// 平台能力（隔离验证；真实账号另列）：get_sessions 只返回每个会话最后一条，
// 因此它只用于“发现哪个会话有变化”。待处理范围必须再用会话历史接口补齐：
//   · 分页：size + end_seqno（取比 end_seqno 更旧的一页），has_more 终止；
//   · 方向：接口通常“最新在前”，本文件统一按平台 msg_seqno 升序归一化；
//   · 编号精度：msg_key / msg_seqno 一律按不透明十进制字符串处理（禁止 Number 强转）；
//   · 终止：遇到旧采集边界、已知消息重叠、has_more=false 或页数上限。
// 没有 msg_seqno 的消息只能按分页边界解释，且不推进 ACK 连续游标（见下）。
const HISTORY_URL = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
const HISTORY_PAGE_SIZE = 50
const HISTORY_MAX_PAGES = 20
const HISTORY_HINT = '检查网络与 B站 会话历史接口；已持久化的本地待处理消息不会丢，恢复后自动重试。'

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const fail = (code, error, hint, exit = 6) => Object.assign(new Error(error), { ok: false, code, error, hint, exit })
const blocked = (code, error) => fail(code, error, '检查该角色目录的 dm-await-state.json 权限与内容；本进程不会重置游标或重新初始化。')

// ── 原子持久写（open wx → fsync → rename → 目录 fsync），与 Host registry 同一提交方式 ──
function fsyncDir(dir) {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch {}
}
function atomicWrite(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const tmp = `${STATE}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, STATE)
    fsyncDir(path.dirname(STATE))
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch {}
    throw blocked('BILI_DM_STATE_WRITE_FAILED', `状态原子写入失败：${String(error?.message ?? error)}`)
  }
}

// ── 跨进程所有权锁：获取失败返回 blocked；孤儿锁（owner 已退出）才释放后重试 ──
function acquireLock() {
  fs.mkdirSync(path.dirname(STATE), { recursive: true })
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return () => { try { fs.unlinkSync(LOCK) } catch {} }
    } catch (error) {
      if (error.code !== 'EEXIST') throw blocked('BILI_DM_STATE_LOCK_FAILED', `无法创建状态锁：${String(error?.message ?? error)}`)
      try {
        const rec = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
        if (Number.isSafeInteger(rec?.pid) && rec.pid > 0) {
          try { process.kill(rec.pid, 0) } catch (e) { if (e.code === 'ESRCH') fs.unlinkSync(LOCK) }
        }
      } catch {}
      Atomics.wait(wait, 0, 0, 25)
    }
  }
  throw blocked('BILI_DM_STATE_LOCKED', '另一进程正持有本角色私信状态锁；本轮不读不写。')
}

function emptyScope() {
  return {
    cursor: 0, seen: {}, pending: {}, receipts: {}, initialized: false,
    // 采集位置（每个对端一条）：上一次“整页已落盘”的边界；与 ACK 进度分开。
    collect: {},
    // 已确认（Host 回执验证后）的连续处理高水位，值为本 scope 的本地 seq。
    ackThrough: {},
    // 本地观察序号（只用于“连续已处理”判定，不参与平台身份/排序）。
    seq: 0,
    // 无法补齐的历史范围：{ [mid]: { code, error, hint, at } }；恢复后清除。
    historyIncomplete: {},
  }
}
function emptyState() { return { version: 2, scopes: { owner: emptyScope(), all: emptyScope() } } }
const SCOPE_KEYS = ['cursor', 'seen', 'pending', 'receipts', 'initialized', 'at', 'collect', 'ackThrough', 'seq', 'historyIncomplete']
function isOrderToken(value) { return value === null || value === undefined || typeof value === 'string' }
function normalizeCollect(raw) {
  if (raw === undefined) return {}
  if (!isObj(raw)) throw blocked('BILI_DM_STATE_CORRUPT', 'scope.collect 损坏。')
  const out = {}
  for (const [mid, row] of Object.entries(raw)) {
    if (!mid || !isObj(row) || row.lastKey !== undefined && row.lastKey !== null && typeof row.lastKey !== 'string' || row.lastTs !== undefined && (typeof row.lastTs !== 'number' || !Number.isFinite(row.lastTs) || row.lastTs < 0) || !isOrderToken(row.order) || row.updatedAt != null && typeof row.updatedAt !== 'string') {
      throw blocked('BILI_DM_STATE_CORRUPT', 'scope.collect 边界损坏。')
    }
    out[String(mid)] = { lastKey: row.lastKey ?? null, lastTs: Number(row.lastTs ?? 0) || 0, order: row.order ?? null, updatedAt: row.updatedAt ?? null }
  }
  return out
}
function normalizeNumberMap(raw, name, { allowMinus = false } = {}) {
  if (raw === undefined) return {}
  if (!isObj(raw)) throw blocked('BILI_DM_STATE_CORRUPT', `scope.${name} 损坏。`)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const min = allowMinus ? -1 : 0
    if (!key || typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw blocked('BILI_DM_STATE_CORRUPT', `scope.${name} 损坏。`)
    out[String(key)] = value
  }
  return out
}
function normalizeHistoryIncomplete(raw) {
  if (raw === undefined) return {}
  if (!isObj(raw)) throw blocked('BILI_DM_STATE_CORRUPT', 'scope.historyIncomplete 损坏。')
  const out = {}
  for (const [mid, row] of Object.entries(raw)) {
    if (!mid || !isObj(row) || typeof row.code !== 'string' || !row.code || typeof row.error !== 'string' || typeof row.hint !== 'string') throw blocked('BILI_DM_STATE_CORRUPT', 'scope.historyIncomplete 损坏。')
    out[String(mid)] = { code: row.code, error: row.error, hint: row.hint, at: typeof row.at === 'string' ? row.at : null }
  }
  return out
}
function normalizeRows(rows, startSeq) {
  const out = {}
  let seq = startSeq
  for (const [id, row] of Object.entries(rows)) {
    let next = row
    if (row.seq === undefined || row.seq === null) { seq += 1; next = { ...row, seq, order: row.order ?? null } }
    else {
      if (!Number.isSafeInteger(row.seq) || row.seq <= 0) throw blocked('BILI_DM_STATE_CORRUPT', '待处理项 seq 损坏。')
      if (!isOrderToken(row.order)) throw blocked('BILI_DM_STATE_CORRUPT', '待处理项 order 损坏。')
      seq = Math.max(seq, row.seq)
    }
    out[id] = next
  }
  return { rows: out, seq }
}
function normalizeScope(raw) {
  if (!isObj(raw) || Object.keys(raw).some(key => !SCOPE_KEYS.includes(key)) || typeof raw.initialized !== 'boolean') throw blocked('BILI_DM_STATE_CORRUPT', 'scope 状态形状损坏。')
  const cursor = raw.cursor
  if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0 || !isObj(raw.seen) || !isObj(raw.pending) || !isObj(raw.receipts) || raw.at !== undefined && typeof raw.at !== 'string' || Object.values(raw.seen).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0) || [raw.pending, raw.receipts].some(rows => Object.entries(rows).some(([id, row]) => !id || !isObj(row) || row.requestId !== id || !isObj(row.original)))) {
    throw blocked('BILI_DM_STATE_CORRUPT', 'scope 游标/seen/pending/receipts 损坏。')
  }
  if (raw.seq !== undefined && (!Number.isSafeInteger(raw.seq) || raw.seq < 0)) throw blocked('BILI_DM_STATE_CORRUPT', 'scope.seq 损坏。')
  const pending = normalizeRows(raw.pending, Number.isSafeInteger(raw.seq) ? raw.seq : 0)
  const receipts = normalizeRows(raw.receipts, pending.seq)
  return {
    ...raw,
    seen: { ...raw.seen }, pending: pending.rows, receipts: receipts.rows,
    collect: normalizeCollect(raw.collect), ackThrough: normalizeNumberMap(raw.ackThrough, 'ackThrough'),
    seq: receipts.seq, historyIncomplete: normalizeHistoryIncomplete(raw.historyIncomplete),
  }
}
function pickOriginal(row) {
  const { requestId, observedAt, state, receipt, original, scope, ackedAt, ...rest } = row
  void requestId; void observedAt; void state; void receipt; void original; void scope; void ackedAt
  return rest
}
// 旧格式 {lastSeen, seen, pending:[...]} 无损迁移：保留每个真实游标、旧 requestId 与 pending 原件。
function migrate(raw) {
  if (raw?.version === 2 && isObj(raw.scopes) && raw.scopes.owner && raw.scopes.all && Object.keys(raw).every(key => ['version', 'scopes'].includes(key)) && Object.keys(raw.scopes).every(key => ['owner', 'all'].includes(key))) {
    return { version: 2, scopes: { owner: normalizeScope(raw.scopes.owner), all: normalizeScope(raw.scopes.all) } }
  }
  if (!isObj(raw) || raw.version !== undefined || Object.keys(raw).some(key => !['lastSeen', 'seen', 'pending', 'at'].includes(key)) || raw.pending !== undefined && !Array.isArray(raw.pending) || raw.seen !== undefined && !isObj(raw.seen) || raw.lastSeen !== undefined && (!Number.isFinite(Number(raw.lastSeen)) || Number(raw.lastSeen) < 0)) throw blocked('BILI_DM_STATE_CORRUPT', '未知或损坏的状态 schema。')
  const oldPending = Array.isArray(raw?.pending) ? raw.pending : []
  const seen = isObj(raw?.seen) ? { ...raw.seen } : {}
  if (raw.at !== undefined && typeof raw.at !== 'string' || Object.values(seen).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0) || oldPending.some(row => !isObj(row) || typeof row.requestId !== 'string' || !row.requestId || row.original !== undefined && !isObj(row.original) || row.state !== undefined && !['observed', 'accepted', 'terminal'].includes(row.state)) || new Set(oldPending.map(row => row.requestId)).size !== oldPending.length) throw blocked('BILI_DM_STATE_CORRUPT', '旧版状态的待处理项或 seen 已损坏。')
  const owner = emptyScope(), all = emptyScope()
  owner.cursor = Number(raw?.lastSeen ?? 0) || 0
  owner.seen = { ...seen }
  owner.initialized = Boolean(raw && (raw.lastSeen !== undefined || 'seen' in raw || oldPending.length))
  // 旧 pending 没有本地 seq：按原数组顺序补一个，保证“连续已处理”仍可判定；
  // 不把时间戳当业务顺序，seq 只表达“本条第一次被观察到的本地顺序”。
  for (const row of oldPending) {
    owner.seq += 1
    owner.pending[row.requestId] = { ...row, seq: owner.seq, order: row.order ?? null, scope: 'owner', state: row.state ?? 'observed', original: row.original ?? pickOriginal(row) }
  }
  all.seen = { ...seen }
  all.initialized = Boolean(raw && ('seen' in raw || Object.keys(seen).length))
  return { version: 2, scopes: { owner, all } }
}
function readStateFile() {
  let text
  try { text = fs.readFileSync(STATE, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { fresh: true, value: emptyState() }
    throw blocked('BILI_DM_STATE_UNREADABLE', `状态不可读：${String(error?.message ?? error)}`)
  }
  try { return { fresh: false, value: migrate(JSON.parse(text)) } }
  catch { throw blocked('BILI_DM_STATE_CORRUPT', '状态 JSON 损坏，拒绝当作新状态重新初始化。') }
}
// 收件需要在同一把跨进程锁内完成“读状态 → 拉历史 → 落 pending → 推进采集位置”；
// 允许异步 mutator，锁覆盖整个网络读取，避免两个进程同时补拉同一会话。
async function withState(mutator) {
  const release = acquireLock()
  try {
    const { value } = readStateFile()
    const result = await mutator(value)
    if (result?.write !== false) atomicWrite(result?.state ?? value)
    return result?.out
  } finally { release() }
}

// ── 稳定身份：账号 + 角色 + 精确消息坐标；scope 只管理各自游标；不含时间/日期/批次顺序 ──
function requestIdOf(row) {
  const coord = [ACCOUNT, ROLE_ID, ROLE_EPOCH, String(row.mid), String(row.msgKey ?? ''), String(row.ts)]
  return 'bili-dm-' + crypto.createHash('sha256').update(JSON.stringify(coord)).digest('hex')
}
function parseReceipt(id) {
  if (!RECEIPT_RAW) return null
  if (RECEIPT_RAW.length > 4096) throw fail('BILI_DM_RECEIPT_INVALID', '接管回执过大。', '只提交精简的持久接管事实。', 7)
  let receipt
  try { receipt = JSON.parse(RECEIPT_RAW) } catch { throw fail('BILI_DM_RECEIPT_INVALID', '接管回执不是 JSON。', '提交结构化 receipt。', 7) }
  if (!isObj(receipt) || receipt.requestId !== id || receipt.durable !== true || !['accepted', 'terminal'].includes(receipt.state)) {
    throw fail('BILI_DM_RECEIPT_INVALID', '接管回执缺少 requestId/durable/state。', '只有可证明的持久接管/完成回执才能推进 ACK。', 7)
  }
  if (receipt.source !== 'bili-v2-registry' || !Array.isArray(receipt.jobs) || !receipt.jobs.length || new Set(receipt.jobs.map(job => job?.sessionId)).size !== receipt.jobs.length) throw fail('BILI_DM_RECEIPT_INVALID', '回执缺少 Host 作业坐标。', '查询原 Host 持久注册表。', 7)
  let registry
  try { registry = JSON.parse(fs.readFileSync(path.join(SURFCORE_DIR, 'bili-v2-managed-sessions.json'), 'utf8')) } catch { throw fail('BILI_DM_RECEIPT_INVALID', 'Host 持久注册表不可读。', '恢复 Host 后查询原作业。', 7) }
  if (registry?.version !== 1 || !isObj(registry.sessions) || receipt.jobs.some(job => {
    const saved = registry.sessions[job?.sessionId]
    return !saved || JSON.stringify(saved.receipt) !== JSON.stringify(receipt) || saved.requestId !== job.requestId || saved.originalRequestId !== id || saved.jobId !== job.jobId || saved.groupCount !== receipt.jobs.length || (ROLE_ID && saved.characterId !== ROLE_ID) || (ROLE_ID && saved.characterEpoch !== ROLE_EPOCH) || (receipt.state === 'terminal' ? saved.phase !== 'terminal' : !['accepted', 'terminal'].includes(saved.phase))
  })) throw fail('BILI_DM_RECEIPT_INVALID', '回执与 Host 原作业不匹配。', '只使用 Host 对原 ID 的查询回执。', 7)
  return receipt
}
function sameOccurrence(a, b) {
  return String(a?.mid ?? '') === String(b?.mid ?? '') && String(a?.msgKey ?? '') === String(b?.msgKey ?? '') && String(a?.ts ?? '') === String(b?.ts ?? '')
}
function findOccurrence(state, item, onlyScope = '') {
  const entries = onlyScope ? [[onlyScope, state.scopes[onlyScope]]] : Object.entries(state.scopes)
  for (const [name, scope] of entries) {
    for (const row of [...Object.values(scope.pending), ...Object.values(scope.receipts)]) {
      const original = row.original ?? row
      if (!sameOccurrence(original, item)) continue
      if (!original.account) throw blocked('BILI_DM_IDENTITY_UNPROVEN', '已有通知缺少账号坐标，不能推断是否为同一消息。')
      if (String(original.account) === String(ACCOUNT)) return { name, row }
    }
  }
  return null
}
function scopeKey(row) { return row?.scope === 'all' ? 'all' : 'owner' }
// 平台序号/官方编号一律按不透明十进制字符串处理：19 位以上不经过 Number。
function exactDecimal(value) {
  if (typeof value === 'string') return /^[1-9][0-9]*$/.test(value) ? value : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  return undefined
}
function exactMsgKey(message) { return exactDecimal(message?.msg_key) }
function orderOfWire(message) {
  const seq = exactDecimal(message?.msg_seqno ?? message?.seqno)
  return seq ? `p:${seq}` : null
}
// 仅同一前缀（平台序号）可比较；null 表示无法给出顺序，不得退回时间戳。
function compareOrder(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.startsWith('p:') || !b.startsWith('p:')) return null
  const x = a.slice(2), y = b.slice(2)
  if (x.length !== y.length) return x.length < y.length ? -1 : 1
  return x === y ? 0 : (x < y ? -1 : 1)
}
function rowIsAcked(row) { return Boolean(row?.ackedAt) }
function rowPeer(row) { return String(row?.original?.mid ?? row?.mid ?? '') }
function rowTs(row) { return Number(row?.original?.ts ?? row?.ts ?? 0) || 0 }
// 沿“连续已处理”推进：只统计本 scope 内、同一对端、Host 回执验证后已 ACK 的前缀。
// 前面还有未 ACK 的项时，后面的 ACK 不得把游标/seen 推过去。
function recomputeAckThrough(scope, peer) {
  const rows = [...Object.values(scope.pending), ...Object.values(scope.receipts)]
    .filter((row) => rowPeer(row) === String(peer) && Number.isSafeInteger(row.seq) && row.seq > 0)
    .sort((a, b) => a.seq - b.seq)
  let high = Number(scope.ackThrough?.[String(peer)] ?? 0) || 0
  let contiguousTs = 0
  for (const row of rows) {
    if (row.seq <= high) { if (rowIsAcked(row)) contiguousTs = Math.max(contiguousTs, rowTs(row)); continue }
    if (!rowIsAcked(row)) break
    high = row.seq
    contiguousTs = Math.max(contiguousTs, rowTs(row))
  }
  if (!scope.ackThrough || typeof scope.ackThrough !== 'object') scope.ackThrough = {}
  scope.ackThrough[String(peer)] = high
  if (contiguousTs > 0) {
    // cursor/lastSeen 保留为旧读者兼容的数值镜像，但只取连续前缀里的最大 ts；
    // 权威进度是 ackThrough（本地 seq）与 collect（采集边界）。
    scope.cursor = Math.max(Number(scope.cursor ?? 0) || 0, contiguousTs)
    scope.seen[String(peer)] = Math.max(Number(scope.seen[String(peer)] ?? 0) || 0, contiguousTs)
  }
  return { high, cursorTs: contiguousTs }
}

const parsed = (content) => {
  try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
}
async function fetchSessions() {
  const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web'
  const r = await fetch(u, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, why: `get_sessions code=${j.code} ${j.message ?? ''}` }
  return { ok: true, list: j.data?.session_list ?? [] }
}

// ── 只读查询：同 ID 可恢复、可核对；未知状态不生成新 ID ──
async function queryCommand() {
  const out = await withState((state) => {
    let found = null, key = null
    const entries = SCOPE_OPT ? [[SCOPE_OPT, state.scopes[SCOPE_OPT]]] : Object.entries(state.scopes)
    for (const [name, scope] of entries) {
      if (scope.pending[QUERY]) { found = scope.pending[QUERY]; key = name; break }
      if (scope.receipts[QUERY]) { found = scope.receipts[QUERY]; key = name; break }
    }
    const stillPending = SCOPE_OPT ? Boolean(state.scopes[SCOPE_OPT].pending[QUERY]) : Boolean(state.scopes.owner.pending[QUERY] || state.scopes.all.pending[QUERY])
    const receipt = found?.receipt ?? (found && isObj(found) && found.state ? found : null)
    return { write: false, out: { ok: true, found: Boolean(found), id: QUERY, scope: key,
      state: found?.state ?? 'unknown', pending: stillPending,
      acked: Boolean(found?.ackedAt) || Boolean(found?.state === 'terminal'),
      receipt: isObj(receipt) ? receipt : null } }
  })
  return { code: 0, stdout: JSON.stringify(out) }
}

// ── 写持久接管/终态回执（accepted / terminal / platformAck 分层），不推进游标 ──
async function transitionCommand() {
  const receipt = parseReceipt(TRANSITION)
  if (!receipt) throw fail('BILI_DM_RECEIPT_REQUIRED', '写接管回执必须提供 --receipt。', '只有确认 Host 持久接管后才调用。', 7)
  const out = await withState((state) => {
    const key = SCOPE_OPT || scopeKey(findRow(state, TRANSITION, SCOPE_OPT)?.row)
    const scope = state.scopes[key]
    const row = scope.pending[TRANSITION]
    if (!row) throw fail('BILI_DM_NOTICE_UNKNOWN', `未知通知编号：${TRANSITION}`, '只查询同 ID，不要新建 ID 重试。', 4)
    if (row.state === 'terminal' && receipt.state !== 'terminal') {
      return { write: false, out: { ok: true, transitioned: TRANSITION, state: row.state, unchanged: true } }
    }
    row.receipt = receipt
    row.state = receipt.state
    row.transitionedAt = new Date().toISOString()
    return { out: { ok: true, transitioned: TRANSITION, state: row.state, pending: Object.keys(scope.pending).length } }
  })
  return { code: 0, stdout: JSON.stringify(out) }
}

function findRow(state, id, onlyScope = '') {
  const entries = onlyScope ? [[onlyScope, state.scopes[onlyScope]]] : Object.entries(state.scopes)
  for (const [name, scope] of entries) {
    if (scope.pending[id]) return { name, row: scope.pending[id] }
    if (scope.receipts[id]) return { name, row: scope.receipts[id] }
  }
  return null
}

// ── ACK：只有持久注册表中存在匹配回执后才能推进游标 ──
// 保护（dev ef30eb5 语义保持）：无回执 / 回执与 Host 原作业不匹配一律拒绝；
// 回执验证通过后，游标只沿“该对端连续已 ACK 的前缀”推进，前面有未 ACK 项时不得跳过。
async function ackCommand() {
  const receipt = parseReceipt(ACK)
  if (!receipt) throw fail('BILI_DM_RECEIPT_REQUIRED', '确认通知必须提供 Host 接管回执。', '查询原 Host 作业并提交匹配回执。', 7)
  const out = await withState((state) => {
    const hit = findRow(state, ACK, SCOPE_OPT)
    if (!hit || !state.scopes[hit.name].pending[ACK]) {
      throw fail('BILI_DM_NOTICE_UNKNOWN', `未知或已确认的通知编号：${ACK}`, '只查询同 ID，不要新建 ID 重试。', 4)
    }
    const scope = state.scopes[hit.name]
    const row = scope.pending[ACK]
    row.receipt = receipt
    row.state = receipt.state
    row.transitionedAt = new Date().toISOString()
    const proven = Boolean(row.receipt && ['accepted', 'terminal'].includes(row.state))
    row.state = proven ? (row.state === 'terminal' ? 'terminal' : 'acked') : 'acked'
    row.ackedAt = new Date().toISOString()
    row.takeover = proven ? 'proven' : 'unproven'
    scope.receipts[ACK] = { ...row, terminal: row.state === 'terminal' }
    delete scope.pending[ACK]
    const peer = rowPeer(row)
    const progress = recomputeAckThrough(scope, peer)
    return { out: { ok: true, acked: ACK, scope: hit.name, takeover: row.takeover, peer,
      pending: Object.keys(scope.pending).length, cursor: scope.cursor, lastSeen: scope.cursor,
      ackThrough: progress.high } }
  })
  return { code: 0, stdout: JSON.stringify(out) }
}

// ── 轮询：pending 优先重放首次不可变原件，再按会话历史补齐新通知 ──────────────
// 会话列表只负责“发现变化”；真正的待处理范围来自会话历史。命中只登记 pending，
// 不推进 ACK 进度；采集边界（collect）与 ACK 进度（ackThrough）是两套独立事实。

/** 取本 scope 对某会话的采集边界；旧状态只有 seen/cursor 时间戳时作为有界重叠回读边界。 */
function boundaryOf(scope, talker, scopeName) {
  const saved = scope.collect?.[String(talker)]
  if (saved) return saved
  // owner 旧语义用 cursor（lastSeen）判定；全员作用域旧语义用 seen[mid]。
  const ts = Number(scope.seen?.[String(talker)] ?? 0) || (scopeName === 'owner' ? Number(scope.cursor ?? 0) || 0 : 0)
  if (ts > 0) return { lastKey: null, lastTs: ts, order: null, updatedAt: null }
  return null
}

/** 读一页会话历史（隔离验证：真实账号的分页方向/精度需另行确认）。 */
async function fetchSessionHistory(talker, { beforeOrder = null } = {}) {
  const u = new URL(HISTORY_URL)
  u.searchParams.set('talker_id', String(talker))
  u.searchParams.set('session_type', '1')
  u.searchParams.set('size', String(HISTORY_PAGE_SIZE))
  u.searchParams.set('mobi_app', 'web')
  if (beforeOrder && beforeOrder.startsWith('p:')) u.searchParams.set('end_seqno', beforeOrder.slice(2))
  let j
  try {
    const r = await fetch(u.toString(), { headers: H, signal: AbortSignal.timeout(15_000) })
    j = await r.json().catch(() => ({}))
  } catch (error) {
    return { ok: false, code: 'BILI_DM_HISTORY_FAILED', error: String(error?.message ?? error), hint: HISTORY_HINT }
  }
  if (j.code !== 0) {
    return { ok: false, code: 'BILI_DM_HISTORY_FAILED', error: `fetch_session_msgs code=${j.code} ${j.message ?? ''}`.trim(), hint: HISTORY_HINT }
  }
  const raw = Array.isArray(j.data?.messages) ? j.data.messages : []
  const messages = []
  let missingIdentity = 0
  for (const m of raw) {
    const msgKey = exactMsgKey(m)
    if (!msgKey) { missingIdentity += 1; continue }   // 无官方编号不能伪造身份
    const ts = Number(m.timestamp ?? 0)
    messages.push({
      msgKey, sender: String(m.sender_uid ?? ''), text: parsed(m.content),
      ts: Number.isFinite(ts) && ts >= 0 ? ts : 0, order: orderOfWire(m),
    })
  }
  return {
    ok: true, messages, missingIdentity,
    hasMore: Number(j.data?.has_more) === 1 || j.data?.has_more === true,
  }
}

/** 接口可能正序或倒序；有平台序号时统一按序号升序，否则按“最新在前”翻成最旧在前。 */
function normalizeHistoryPage(messages) {
  if (messages.length && messages.every((m) => m.order)) return [...messages].sort((a, b) => compareOrder(a.order, b.order))
  return [...messages].reverse()
}

/**
 * 发现一个会话的新消息。返回：
 *   items      本次发现、尚未持久化到 pending 的不可变原件（按平台顺序）
 *   failure    会话历史读取失败（不推进采集边界）
 *   incomplete 历史未补齐（记录范围/原因/重试入口）
 *   nextBoundary 新的采集边界（只有在页已完整读取时才前移）
 */
async function discoverSession(session, scope, scopeName, { emitFirst = true } = {}) {
  const talker = String(session.talker_id ?? '')
  if (!talker || talker === SELF || Number(talker) < 1000) return { items: [] }
  if (scopeName === 'owner' && talker !== OWNER) return { items: [] }
  const last = session.last_msg ?? {}
  const lastKey = exactMsgKey(last) ?? null
  const lastOrder = orderOfWire(last)
  const lastTs = Number(last.timestamp ?? 0) || 0
  const boundary = boundaryOf(scope, talker, scopeName)
  const retrying = Boolean(scope.historyIncomplete?.[talker])
  // 旧边界只有时间戳时按时间推进；新边界有官方编号时按编号身份判断，避免同秒漏信。
  const lastChanged = boundary
    ? (boundary.lastKey && lastKey ? boundary.lastKey !== lastKey : Number(boundary.lastTs ?? 0) < lastTs)
    : true
  if (!lastChanged && !retrying) return { items: [] }
  const name = String(session.account_info?.name ?? session.talker_name ?? '')
  const directItem = () => {
    const sender = String(last.sender_uid ?? '')
    if (sender === SELF || (scopeName === 'owner' && sender !== OWNER)) return null
    return {
      mid: talker, name: scopeName === 'owner' ? OWNER_NAME : name, text: parsed(last.content), ts: lastTs,
      unread: Number(session.unread_count ?? 0), isOwner: talker === OWNER,
      ...(lastKey === null ? {} : { msgKey: lastKey }), order: lastOrder,
    }
  }
  // 只有“确有新末条”时才拉历史；首次基线或旧状态（无 lastKey）的普通推进沿用原末条语义，
  // 避免对不提供历史接口的既有夹具/受限账号发起额外请求。
  const needsHistory = Boolean(boundary) && (boundary.lastKey
    ? (lastChanged || retrying)
    : Number(boundary.lastTs ?? 0) < lastTs)
  if (!needsHistory) {
    const item = directItem()
    return {
      items: item ? [item] : [],
      nextBoundary: { lastKey: lastKey ?? boundary?.lastKey ?? null, lastTs: Math.max(Number(boundary?.lastTs ?? 0) || 0, lastTs), order: lastOrder ?? boundary?.order ?? null, updatedAt: new Date().toISOString() },
      talker, reached: true,
    }
  }

  let page = await fetchSessionHistory(talker)
  if (!page.ok) {
    // 历史不可用时仍交付会话列表给出的官方末条；不推进既有边界，下一轮继续补历史。
    const item = directItem()
    const info = { mid: talker, code: page.code, error: page.error, hint: page.hint, at: new Date().toISOString() }
    return {
      items: item ? [item] : [],
      failure: info,
      historyIncomplete: info,
      nextBoundary: boundary ? null : { lastKey: lastKey ?? null, lastTs, order: lastOrder, updatedAt: new Date().toISOString() },
      talker, reached: false,
    }
  }

  const pages = []
  let reached = false
  let incomplete = null
  let pageMin = null
  let pagesRead = 0
  let missingIdentity = 0
  while (true) {
    pagesRead += 1
    missingIdentity += page.missingIdentity || 0
    const asc = normalizeHistoryPage(page.messages)
    if (asc.length) pages.unshift(asc)
    const min = asc[0] ?? null
    if (min) pageMin = min
    if (!boundary) { reached = true; break }   // 首次遇到该会话：只看最新一页，不回溯更早历史
    if (min) {
      if (boundary.order && min.order && compareOrder(min.order, boundary.order) <= 0) { reached = true; break }
      if (!boundary.order && boundary.lastKey && asc.some((m) => m.msgKey === boundary.lastKey)) { reached = true; break }
      if (!boundary.order && !boundary.lastKey && min.ts <= Number(boundary.lastTs ?? 0)) { reached = true; break }
    }
    if (!page.hasMore) { reached = true; break }
    if (!min?.order) {
      incomplete = { code: 'BILI_DM_HISTORY_PAGINATION_UNSUPPORTED', error: '会话历史缺少平台序号，无法继续向后分页。', hint: HISTORY_HINT }
      break
    }
    if (pagesRead >= HISTORY_MAX_PAGES) {
      incomplete = { code: 'BILI_DM_HISTORY_INCOMPLETE', error: `历史超过 ${HISTORY_MAX_PAGES} 页仍未到达上一采集边界。`, hint: HISTORY_HINT }
      break
    }
    page = await fetchSessionHistory(talker, { beforeOrder: min.order })
    if (!page.ok) { incomplete = { code: page.code, error: page.error, hint: page.hint }; break }
  }
  if (missingIdentity > 0 && !incomplete) {
    incomplete = { code: 'BILI_DM_HISTORY_IDENTITY_UNPROVEN', error: `有 ${missingIdentity} 条历史消息缺少官方编号，不能推断身份。`, hint: '保留原状态；核对平台返回的 msg_key 后重试。' }
  }

  // 相邻页重叠、正序/倒序统一在这里去重；官方编号是不透明身份，不使用时间戳排序。
  const byKey = new Map()
  for (const m of pages.flat()) if (!byKey.has(m.msgKey)) byKey.set(m.msgKey, m)
  // 历史页没有会话最后一条（接口为空、权限受限或该消息刚被删除）时，用会话列表里
  // 已经官方给出的 last_msg 兜底——它同样是官方原件，不是猜测；仅用于收信，不补历史。
  if (lastKey && !byKey.has(lastKey) && String(last.sender_uid ?? '') !== SELF) {
    byKey.set(lastKey, { msgKey: lastKey, sender: String(last.sender_uid ?? ''), text: parsed(last.content), ts: lastTs, order: lastOrder })
  }
  const unique = [...byKey.values()]
  const inbound = unique
    .filter((m) => m.sender !== SELF)
    .filter((m) => scopeName !== 'owner' || m.sender === OWNER)
  let candidates = inbound
  if (!boundary) {
    // 首次遇到该会话：只交付最新一条（会话列表已给出）；不回溯整段历史。
    const listed = lastKey ? inbound.find((m) => m.msgKey === lastKey) : null
    const newest = inbound[inbound.length - 1] ?? null
    const only = !emitFirst ? null : (listed ?? newest)
    candidates = only ? [only] : []
  } else if (boundary.order) {
    candidates = inbound.filter((m) => !m.order || compareOrder(m.order, boundary.order) > 0)
  } else if (boundary.lastKey) {
    // 无平台序号：用页边界解释位置——只取边界消息之后（更新）的部分。
    const index = unique.findIndex((m) => m.msgKey === boundary.lastKey)
    candidates = index >= 0 ? unique.slice(index + 1).filter((m) => inbound.includes(m)) : inbound
  } else {
    const bts = Number(boundary.lastTs ?? 0) || 0
    candidates = inbound.filter((m) => m.ts > bts || (m.ts === bts && m.msgKey !== boundary.lastKey))
  }
  candidates.sort((a, b) => {
    const c = compareOrder(a.order, b.order)
    return c === null ? 0 : c
  })

  // 采集位置：只有“页已完整读取”（到达旧边界或历史尽头）才前移到会话最新；
  // 未补齐时只前移到最后一个完整页的最旧项，下一页继续补，不丢中间消息。
  let nextBoundary
  if (!boundary) {
    // 基线锚点优先用会话最后一条在历史中的精确位置；找不到就用历史里最新的一条。
    const anchor = (lastKey ? unique.find((m) => m.msgKey === lastKey) : null) ?? unique[unique.length - 1] ?? null
    nextBoundary = {
      lastKey: anchor?.msgKey ?? lastKey,
      lastTs: anchor?.ts ?? lastTs,
      order: anchor?.order ?? lastOrder,
      updatedAt: new Date().toISOString(),
    }
  } else if (reached) {
    const maxOrder = unique.map((m) => m.order).filter(Boolean).sort((a, b) => compareOrder(a, b)).pop() ?? null
    nextBoundary = {
      lastKey: lastKey ?? unique[unique.length - 1]?.msgKey ?? boundary.lastKey,
      lastTs: Math.max(Number(boundary.lastTs ?? 0) || 0, lastTs),
      order: lastOrder ?? maxOrder ?? boundary.order,
      updatedAt: new Date().toISOString(),
    }
  } else {
    nextBoundary = {
      lastKey: pageMin?.msgKey ?? boundary.lastKey,
      lastTs: Math.max(Number(boundary.lastTs ?? 0) || 0, pageMin?.ts ?? 0),
      order: pageMin?.order ?? boundary.order,
      updatedAt: new Date().toISOString(),
    }
  }

  const items = candidates.map((m) => ({
    mid: talker, name: scopeName === 'owner' ? OWNER_NAME : name, text: m.text, ts: m.ts,
    unread: Number(session.unread_count ?? 0), isOwner: talker === OWNER,
    msgKey: m.msgKey, order: m.order,
  }))
  return {
    items, failure: null, incomplete, nextBoundary, talker, boundary, reached,
    historyIncomplete: incomplete ? { mid: talker, ...incomplete, at: new Date().toISOString() } : null,
  }
}

/** 远端会话列表都拿不到时：仍然交付已持久化 pending，并单独报告采集失败。 */
async function replayOnly(scopeName, failure) {
  const out = await withState((state) => {
    const scope = state.scopes[scopeName]
    const items = Object.values(scope.pending)
      .filter((row) => row && ['observed', 'accepted'].includes(row.state ?? 'observed'))
      .map((row) => ({ ...(row.original ?? row), requestId: row.requestId, scope: scopeName, state: row.state ?? 'observed' }))
    const collect = { ok: false, code: failure.code ?? 'BILI_DM_COLLECT_FAILED', error: failure.error ?? failure.why ?? '会话列表读取失败。', hint: failure.hint ?? '检查网络与 B站 会话接口；本地待处理消息仍会交付，恢复后自动补齐新消息。', peers: [] }
    return {
      write: false,
      out: {
        ok: items.length > 0, degraded: true, hit: items.length > 0, items,
        replay: items.length, localPending: items.length, baseline: false, scope: scopeName,
        pending: Object.keys(scope.pending).length, collect,
        historyIncomplete: Object.entries(scope.historyIncomplete ?? {}).map(([mid, row]) => ({ mid, ...row })),
      },
    }
  })
  if (JSONOUT) return { code: out.hit ? 0 : 3, stdout: JSON.stringify(out) }
  if (out.hit) {
    return {
      code: 0,
      stdout: out.items.map((it) => `DM_HIT mid=${it.mid} ts=${it.ts} requestId=${it.requestId}`).join('\n'),
      stderr: `! [${out.collect.code}] ${out.collect.error} · ${out.collect.hint}（已交付 ${out.items.length} 条本地待处理）`,
    }
  }
  return { code: 3, stderr: `✗ [${out.collect.code}] ${out.collect.error} · ${out.collect.hint}` }
}

async function pollCommand() {
  if (!OWNER) return { code: 2, stderr: '配置里 owner.mid 为空' }
  const scopeName = ANY ? 'all' : 'owner'
  let list
  try {
    const r = await fetchSessions()
    if (!r.ok) return replayOnly(scopeName, { code: 'BILI_DM_COLLECT_FAILED', error: r.why, hint: HISTORY_HINT })
    list = Array.isArray(r.list) ? r.list : []
  } catch (error) {
    return replayOnly(scopeName, { code: 'BILI_DM_COLLECT_FAILED', error: String(error?.message ?? error), hint: HISTORY_HINT })
  }

  const out = await withState(async (state) => {
    const scope = state.scopes[scopeName]
    const now = new Date().toISOString()
    const replay = Object.values(scope.pending)
      .filter((row) => row && ['observed', 'accepted'].includes(row.state ?? 'observed'))
      .map((row) => ({ ...(row.original ?? row), requestId: row.requestId, scope: scopeName, state: row.state ?? 'observed' }))

    // 首次基线 / 显式 --baseline：只记录“现在”的会话边界，不回灌历史，也不清其它 scope。
    if (BASE || (ANY && !scope.initialized)) {
      for (const s of list) {
        const t = String(s.talker_id ?? '')
        if (!t) continue
        const last = s.last_msg ?? {}
        const ts = Number(last.timestamp ?? 0) || 0
        scope.collect[t] = { lastKey: exactMsgKey(last) ?? null, lastTs: ts, order: orderOfWire(last), updatedAt: now }
        scope.seen[t] = Math.max(Number(scope.seen[t] ?? 0) || 0, ts)
        if (BASE) scope.cursor = Math.max(scope.cursor, ts)
      }
      scope.initialized = true
      if (BASE) scope.historyIncomplete = {}   // 显式基线重置本 scope 的历史缺口重试入口
      const firstAny = !BASE
      return {
        out: {
          ok: true, hit: replay.length > 0, items: replay, replay: replay.length, localPending: replay.length,
          baseline: firstAny, scope: scopeName, pending: Object.keys(scope.pending).length,
          collect: { ok: true, peers: list.length, fetched: 0 },
          historyIncomplete: Object.entries(scope.historyIncomplete ?? {}).map(([mid, row]) => ({ mid, ...row })),
        },
      }
    }

    const failures = []
    const discovered = []
    for (const session of list) {
      const result = await discoverSession(session, scope, scopeName, { emitFirst: true })
      if (result.failure) failures.push(result.failure)
      if (result.historyIncomplete && scope.historyIncomplete) scope.historyIncomplete[result.historyIncomplete.mid] = {
        code: result.historyIncomplete.code, error: result.historyIncomplete.error, hint: result.historyIncomplete.hint, at: result.historyIncomplete.at,
      }
      if (result.nextBoundary && result.talker) scope.collect[result.talker] = result.nextBoundary
      // 只有“完整到达边界且没有未补齐说明”才清除历史缺口；缺编号/页数上限要保留重试入口。
      if (result.reached && result.talker && !result.historyIncomplete) delete scope.historyIncomplete?.[result.talker]
      if (result.items?.length) discovered.push(...result.items)
    }

    const emitted = []
    for (const item of discovered) {
      const id = requestIdOf(item)
      // 只在“本作用域”内去重：owner 与 all 可各自持有同一官方消息的 pending（同一 requestId），
      // 由 --scope 的 ACK 各自推进；Host 同 ID 查询保证不会产生第二次业务效果。
      const existing = scope.pending[id] ?? scope.receipts[id] ?? findOccurrence(state, item, scopeName)?.row
      if (existing) continue
      scope.seq = Math.max(Number(scope.seq ?? 0) || 0, 0) + 1
      const row = { ...item, account: ACCOUNT, scope: scopeName, requestId: id, observedAt: now, state: 'observed', seq: scope.seq }
      row.original = pickOriginal(row)
      scope.pending[id] = row
      emitted.push(row)
    }

    const items = [...replay, ...emitted]
    scope.at = now
    const gaps = Object.entries(scope.historyIncomplete ?? {}).map(([mid, row]) => ({ mid, ...row }))
    // 历史缺口（页数上限/缺官方编号/读取失败）也算“采集未完成”，让上层能显示“历史未补齐”；
    // 已持久化的 pending 与本次已发现的消息仍然照常交付。
    const collect = failures.length
      ? { ok: false, code: failures[0].code ?? 'BILI_DM_HISTORY_FAILED', error: failures[0].error, hint: failures[0].hint, peers: failures }
      : (gaps.length
        ? { ok: false, code: gaps[0].code, error: gaps[0].error, hint: gaps[0].hint, peers: gaps }
        : { ok: true, peers: list.length, fetched: discovered.length })
    return {
      out: {
        ok: items.length > 0 || collect.ok, hit: items.length > 0, items,
        replay: replay.length, localPending: replay.length, baseline: false, scope: scopeName,
        pending: Object.keys(scope.pending).length, collect,
        historyIncomplete: Object.entries(scope.historyIncomplete ?? {}).map(([mid, row]) => ({ mid, ...row })),
      },
    }
  })

  const degraded = out.collect?.ok === false
  if (JSONOUT) return { code: out.hit ? 0 : (degraded ? 3 : 1), stdout: JSON.stringify(out) }
  if (out.hit) {
    const text = out.items.map((it) => `DM_HIT mid=${it.mid} ts=${it.ts} requestId=${it.requestId}`).join('\n')
    return {
      code: 0, stdout: text,
      ...(degraded ? { stderr: `! [${out.collect.code}] ${out.collect.error} · ${out.collect.hint}（已交付 ${out.items.length} 条，其中本地重放 ${out.replay} 条）` } : {}),
    }
  }
  if (degraded) return { code: 3, stderr: `✗ [${out.collect.code}] ${out.collect.error} · ${out.collect.hint}` }
  return { code: 1, stderr: out.baseline ? '首次运行：已把现有会话记为基线 ✓' : '无新私信' }
}

function main() {
  if (QUERY) return queryCommand()
  if (TRANSITION) return transitionCommand()
  if (ACK) return ackCommand()
  return pollCommand()
}

let result
try { result = await main() }
catch (error) {
  const code = typeof error?.exit === 'number' ? error.exit : 6
  const envelope = { ok: false, code: error?.code ?? 'BILI_DM_FAILED', error: error?.error ?? String(error?.message ?? error), hint: error?.hint ?? '检查本角色私信状态后重试；不要重置游标。' }
  if (JSONOUT) console.log(JSON.stringify(envelope))
  console.error(`✗ [${envelope.code}] ${envelope.error} · ${envelope.hint}`)
  process.exit(code)
}
if (result?.stdout) console.log(result.stdout)
if (result?.stderr) console.error(result.stderr)
process.exit(result?.code ?? 0)
