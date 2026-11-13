// 私信监听 —— V2 退役 R2/F03：稳定身份、pending 重放、持久接管回执、分域 ACK。
//
// 状态模型（单文件、原子写 + 跨进程锁；复用 Host registry 的 fsync/rename/同 ID 查询语义）：
//   version 2，scopes.owner / scopes.all 各自持有 { cursor, seen, pending, receipts, initialized }。
//   一条通知的 ID = sha256([账号, 角色id, epoch, scope, mid, msgKey, ts])，
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
import { accountBili, biliState, currentCharacter } from '../lib/state-paths.mjs'
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

function emptyScope() { return { cursor: 0, seen: {}, pending: {}, receipts: {}, initialized: false } }
function emptyState() { return { version: 2, scopes: { owner: emptyScope(), all: emptyScope() } } }
function normalizeScope(raw) {
  if (!isObj(raw)) throw blocked('BILI_DM_STATE_CORRUPT', 'scope 状态形状损坏。')
  const cursor = Number(raw.cursor ?? 0)
  if (!Number.isFinite(cursor) || cursor < 0 || !isObj(raw.seen) || !isObj(raw.pending) || !isObj(raw.receipts)) {
    throw blocked('BILI_DM_STATE_CORRUPT', 'scope 游标/seen/pending/receipts 损坏。')
  }
  return { cursor, seen: { ...raw.seen }, pending: { ...raw.pending }, receipts: { ...raw.receipts }, initialized: Boolean(raw.initialized) }
}
function pickOriginal(row) {
  const { requestId, observedAt, state, receipt, original, scope, ackedAt, ...rest } = row
  void requestId; void observedAt; void state; void receipt; void original; void scope; void ackedAt
  return rest
}
// 旧格式 {lastSeen, seen, pending:[...]} 无损迁移：保留每个真实游标、旧 requestId 与 pending 原件。
function migrate(raw) {
  if (raw?.version === 2 && isObj(raw.scopes) && raw.scopes.owner && raw.scopes.all) {
    return { version: 2, scopes: { owner: normalizeScope(raw.scopes.owner), all: normalizeScope(raw.scopes.all) } }
  }
  const oldPending = Array.isArray(raw?.pending) ? raw.pending : []
  const seen = isObj(raw?.seen) ? { ...raw.seen } : {}
  const owner = emptyScope(), all = emptyScope()
  owner.cursor = Number(raw?.lastSeen ?? 0) || 0
  owner.seen = { ...seen }
  owner.initialized = Boolean(raw && (raw.lastSeen !== undefined || 'seen' in raw || oldPending.length))
  for (const row of oldPending) {
    if (!row || typeof row.requestId !== 'string') continue
    owner.pending[row.requestId] = { ...row, scope: 'owner', state: row.state ?? 'observed', original: row.original ?? pickOriginal(row) }
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
function withState(mutator) {
  const release = acquireLock()
  try {
    const { value } = readStateFile()
    const result = mutator(value)
    if (result?.write !== false) atomicWrite(result?.state ?? value)
    return result?.out
  } finally { release() }
}

// ── 稳定身份：账号 + 角色 + 精确消息坐标 + scope；不含时间/日期/批次顺序 ──
function requestIdOf(row) {
  const coord = [ACCOUNT, ROLE_ID, ROLE_EPOCH, row.scope ?? (ANY ? 'all' : 'owner'), String(row.mid), String(row.msgKey ?? ''), String(row.ts)]
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
  return receipt
}
function scopeKey(row) { return row?.scope === 'all' ? 'all' : 'owner' }
function advanceCursor(scope, row) {
  const ts = Number(row.ts ?? 0) || 0
  scope.cursor = Math.max(Number(scope.cursor ?? 0) || 0, ts)
  if (row.mid) scope.seen[String(row.mid)] = Math.max(Number(scope.seen[String(row.mid)] ?? 0) || 0, ts)
}

const parsed = (content) => {
  try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
}
const exactMsgKey = (last) => {
  const v = last?.msg_key
  if (typeof v === 'string') return /^[1-9][0-9]*$/.test(v) ? v : undefined
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : undefined
  return undefined
}
async function fetchSessions() {
  const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web'
  const r = await fetch(u, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, why: `get_sessions code=${j.code} ${j.message ?? ''}` }
  return { ok: true, list: j.data?.session_list ?? [] }
}

// ── 只读查询：同 ID 可恢复、可核对；未知状态不生成新 ID ──
function queryCommand() {
  const out = withState((state) => {
    let found = null, key = null
    for (const [name, scope] of Object.entries(state.scopes)) {
      if (scope.pending[QUERY]) { found = scope.pending[QUERY]; key = name; break }
      if (scope.receipts[QUERY]) { found = scope.receipts[QUERY]; key = name; break }
    }
    const stillPending = Boolean(state.scopes.owner.pending[QUERY] || state.scopes.all.pending[QUERY])
    const receipt = found?.receipt ?? (found && isObj(found) && found.state ? found : null)
    return { write: false, out: { ok: true, found: Boolean(found), id: QUERY, scope: key,
      state: found?.state ?? 'unknown', pending: stillPending,
      acked: Boolean(found?.ackedAt) || Boolean(found?.state === 'terminal'),
      receipt: isObj(receipt) ? receipt : null } }
  })
  return { code: 0, stdout: JSON.stringify(out) }
}

// ── 写持久接管/终态回执（accepted / terminal / platformAck 分层），不推进游标 ──
function transitionCommand() {
  const receipt = parseReceipt(TRANSITION)
  if (!receipt) throw fail('BILI_DM_RECEIPT_REQUIRED', '写接管回执必须提供 --receipt。', '只有确认 Host 持久接管后才调用。', 7)
  const out = withState((state) => {
    const key = scopeKey(findRow(state, TRANSITION)?.row)
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

function findRow(state, id) {
  for (const [name, scope] of Object.entries(state.scopes)) {
    if (scope.pending[id]) return { name, row: scope.pending[id] }
    if (scope.receipts[id]) return { name, row: scope.receipts[id] }
  }
  return null
}

// ── ACK：只有确认接管/完成后由 scheduler 调用；兼容旧「直接推进」语义但标注 unproven ──
function ackCommand() {
  const receipt = parseReceipt(ACK)
  const out = withState((state) => {
    const hit = findRow(state, ACK)
    if (!hit || !state.scopes[hit.name].pending[ACK]) {
      throw fail('BILI_DM_NOTICE_UNKNOWN', `未知或已确认的通知编号：${ACK}`, '只查询同 ID，不要新建 ID 重试。', 4)
    }
    const scope = state.scopes[hit.name]
    const row = scope.pending[ACK]
    if (receipt) { row.receipt = receipt; row.state = receipt.state; row.transitionedAt = new Date().toISOString() }
    const proven = Boolean(row.receipt && ['accepted', 'terminal'].includes(row.state))
    advanceCursor(scope, row.original ?? row)
    row.state = proven ? (row.state === 'terminal' ? 'terminal' : 'acked') : 'acked'
    row.ackedAt = new Date().toISOString()
    row.takeover = proven ? 'proven' : 'unproven'
    scope.receipts[ACK] = { ...row, terminal: row.state === 'terminal' }
    delete scope.pending[ACK]
    return { out: { ok: true, acked: ACK, scope: hit.name, takeover: row.takeover,
      pending: Object.keys(scope.pending).length, cursor: scope.cursor, lastSeen: scope.cursor } }
  })
  return { code: 0, stdout: JSON.stringify(out) }
}

// ── 轮询：pending 优先重放首次不可变原件，再采集新通知；命中只登记 pending，不推进游标 ──
function collectAny(list, scope) {
  const items = []
  const seen = { ...scope.seen }
  for (const s of list) {
    const talker = String(s.talker_id ?? '')
    const last = s.last_msg ?? {}
    const msgKey = exactMsgKey(last)
    const ts = Number(last.timestamp ?? 0)
    const sender = String(last.sender_uid ?? '')
    if (!talker || talker === SELF || Number(talker) < 1000) continue
    if (sender === SELF) { seen[talker] = Math.max(Number(seen[talker] ?? 0) || 0, ts); continue }
    if (ts <= Number(seen[talker] ?? 0)) continue
    items.push({ mid: talker, name: String(s.account_info?.name ?? s.talker_name ?? ''), text: parsed(last.content), ts,
      unread: Number(s.unread_count ?? 0), isOwner: talker === OWNER, ...(msgKey === undefined ? {} : { msgKey }) })
  }
  return { items, seen }
}
function collectOwner(list, scope) {
  const mine = list.find((s) => String(s.talker_id ?? '') === OWNER)
  if (!mine) return { items: [], cursor: scope.cursor }
  const last = mine.last_msg ?? {}
  const ts = Number(last.timestamp ?? 0)
  const sender = Number(last.sender_uid ?? 0)
  const msgKey = exactMsgKey(last)
  if (!(ts > scope.cursor) || String(sender) !== OWNER) return { items: [], cursor: scope.cursor }
  return { items: [{ mid: OWNER, name: OWNER_NAME, text: parsed(last.content), ts,
    ...(msgKey === undefined ? {} : { msgKey }) }], cursor: scope.cursor }
}
async function pollCommand() {
  if (!OWNER) return { code: 2, stderr: '配置里 owner.mid 为空' }
  let r
  try { r = await fetchSessions() } catch (error) { return { code: 3, stderr: `✗ ${String(error?.message ?? error)}` } }
  if (!r.ok) return { code: 3, stderr: `✗ ${r.why}` }
  const scopeName = ANY ? 'all' : 'owner'
  const out = withState((state) => {
    const scope = state.scopes[scopeName]
    const collected = ANY ? collectAny(r.list, scope) : collectOwner(r.list, scope)
    const now = new Date().toISOString()
    const replay = Object.values(scope.pending)
      .filter((row) => row && ['observed', 'accepted'].includes(row.state ?? 'observed'))
      .map((row) => ({ ...(row.original ?? row), requestId: row.requestId, scope: scopeName, state: row.state ?? 'observed' }))
    if (BASE) {
      // 只初始化本 scope；其它 scope 的 pending/receipts 原样保留。
      for (const s of r.list) {
        const t = String(s.talker_id ?? ''), ts = Number(s.last_msg?.timestamp ?? 0)
        if (t) scope.seen[t] = Math.max(Number(scope.seen[t] ?? 0) || 0, ts)
        scope.cursor = Math.max(scope.cursor, ts)
      }
      for (const it of collected.items) { scope.seen[String(it.mid)] = Math.max(Number(scope.seen[String(it.mid)] ?? 0) || 0, it.ts); scope.cursor = Math.max(scope.cursor, it.ts) }
      scope.initialized = true
      return { out: { ok: true, baseline: true, scope: scopeName, hit: false, items: [], pending: Object.keys(scope.pending).length } }
    }
    // 首次 --any：把当前会话当基线，但绝不覆盖其它 scope 的 pending/回执。
    const firstAny = ANY && !scope.initialized
    if (firstAny) {
      for (const s of r.list) {
        const t = String(s.talker_id ?? ''), ts = Number(s.last_msg?.timestamp ?? 0)
        if (t) scope.seen[t] = Math.max(Number(scope.seen[t] ?? 0) || 0, ts)
      }
      scope.initialized = true
    }
    const fresh = firstAny ? [] : collected.items
    const emitted = []
    const byId = new Map(replay.map((row) => [row.requestId, row]))
    for (const item of fresh) {
      const row = { ...item, scope: scopeName, requestId: requestIdOf({ ...item, scope: scopeName }), observedAt: now, state: 'observed' }
      row.original = pickOriginal(row)
      if (!byId.has(row.requestId)) { byId.set(row.requestId, row); scope.pending[row.requestId] = row; emitted.push(row) }
    }
    const items = [...replay, ...emitted]
    scope.at = now
    return { out: { hit: items.length > 0, items, baseline: firstAny, scope: scopeName,
      pending: Object.keys(scope.pending).length } }
  })
  const hit = out.hit
  if (JSONOUT) return { code: hit ? 0 : 1, stdout: JSON.stringify(out) }
  if (hit) return { code: 0, stdout: out.items.map((it) => `DM_HIT mid=${it.mid} ts=${it.ts} requestId=${it.requestId}`).join('\n') }
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
