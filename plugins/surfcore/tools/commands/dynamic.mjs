// One-shot dynamic (动态) test: post -> list -> remove. Same boundary as the
// comment tool: credentials come from the local drop box, nothing is echoed.
//
//   node bili-dynamic.mjs list
//   node bili-dynamic.mjs post --text "..." --dry | --go
//   node bili-dynamic.mjs rm --id <dyn_id> --dry | --go
import { accountBili, biliState, biliStateDir, CURRENT_FILE, CHARACTERS_DIR } from '../lib/state-paths.mjs'
import * as statePaths from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
// 2026-10-21 补：line 99 用到 gate 却没 import，发动态会 ReferenceError
import { gate } from '../lib/quota-gate.mjs'
import { interactEnabled } from '../lib/interact.mjs'
import { assertOutboundIdentitySafe } from '../lib/outbound-guard.mjs'
import { publishDynamic, existingDynamicAction } from '../lib/dynamic-receipt.mjs'

const argv = process.argv.slice(2)
const mode = argv[0]
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const isDry = args.has('dry')
const isGo = args.has('go')
const jsonOutput = mode === 'post' && args.has('json')
if (jsonOutput) { console.log = () => {}; console.error = () => {} }
const report = (result, exitCode) => {
  const output = JSON.stringify(result)
  if (jsonOutput) process.stdout.write(output + '\n')
  else if (!result.ok) process.stderr.write(output + '\n')
  process.exit(exitCode)
}
const text = args.get('text')
const dynId = args.get('id')

const credPath = accountBili('credentials.json')
if (!fs.existsSync(credPath)) {
  if (mode === 'post') report({ ok: false, code: 'BILI_CREDENTIALS_MISSING', error: '缺少账号凭据。', hint: '检查 B站账号绑定。' }, 3)
  console.error(`缺少凭据文件: ${credPath}`); process.exit(3)
}
const credBytes = fs.readFileSync(credPath)
let cred
try { cred = JSON.parse(credBytes.toString('utf8')) } catch {
  if (mode === 'post') report({ ok: false, code: 'BILI_CREDENTIALS_INVALID', error: '账号凭据无法读取。', hint: '检查 B站账号绑定。' }, 3)
  throw new Error('凭据文件格式无效')
}
for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
  if (!cred[k] || String(cred[k]).trim() === '') {
    if (mode === 'post') report({ ok: false, code: 'BILI_CREDENTIALS_INVALID', error: '账号凭据不完整。', hint: '检查 B站账号绑定。' }, 3)
    console.error(`凭据文件缺少 ${k}`); process.exit(3)
  }
}
const cookieHeader = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://t.bilibili.com/'

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
async function wbi(params) {
  const d = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  const img = d?.data?.wbi_img?.img_url, sub = d?.data?.wbi_img?.sub_url
  if (!img || !sub) return ''
  const mixin = MIXIN_TAB.map((i) => (keyOf(img) + keyOf(sub))[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const q = Object.keys({ ...params, wts }).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}

async function whoami() {
  const d = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader },
  })).json()
  if (d.code !== 0) {
    if (mode === 'post') throw new Error('登录态不可用')
    console.log(`  登录态无效: code=${d.code} ${d.message}`); process.exit(4)
  }
  if (mode === 'post') console.log('  账号登录状态已确认。')
  else console.log(`  账号: ${d.data.uname} (mid ${d.data.mid})  手机绑定=${d.data.mobile_verified ? '是' : '否'}`)
  return d.data.mid
}

async function list(mid) {
  const u = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history?host_uid=${mid}&offset_dynamic_id=0&need_top=0`
  const d = await (await fetch(u, { headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader } })).json()
  console.log(`  space_history code=${d.code} ${d.message ?? ''}  卡片数=${(d.data?.cards ?? []).length}`)
  for (const c of (d.data?.cards ?? []).slice(0, 6)) {
    const desc = c.desc ?? {}
    let body = ''
    try { body = (JSON.parse(c.card).item?.description ?? JSON.parse(c.card).item?.content ?? '').slice(0, 60) } catch {}
    console.log(`    dyn_id=${desc.dynamic_id_str}  ${new Date((desc.timestamp ?? 0) * 1000).toLocaleTimeString('zh-CN')}  ${body}`)
  }
  return (d.data?.cards ?? []).map((c) => String(c.desc?.dynamic_id_str))
}

if (mode === 'list') {
  console.log('=== 当前空间动态 ===')
  const mid = await whoami()
  await list(mid)
  process.exit(0)
}

if (mode === 'post') {
  if (!text || isDry === isGo) report({ ok: false, code: 'BILI_DYNAMIC_INPUT', error: '必须提供正文并且只能指定 --dry 或 --go。', hint: '检查输入后重新准备。' }, 2)
  if (isGo && jsonOutput && !args.has('action-id')) report({ ok: false, code: 'BILI_DYNAMIC_ACTION_ID_REQUIRED', error: 'JSON 发布需要固定操作 ID。', hint: '生成操作 ID，并在查询或重试时沿用它。' }, 2)
  const expectedMid = args.get('expected-mid')
  if ((isGo && jsonOutput && !args.has('expected-mid')) || (args.has('expected-mid') && (typeof expectedMid !== 'string' || !/^[1-9]\d*$/.test(expectedMid) || !Number.isSafeInteger(Number(expectedMid))))) report({ ok: false, code: 'BILI_DYNAMIC_EXPECTED_ACCOUNT_REQUIRED', error: '缺少或无效的审批账号绑定。', hint: '重新确认审批账号后再次准备。' }, 2)
  const actionId = args.has('action-id') ? args.get('action-id') : crypto.randomUUID()
  if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actionId)) report({ ok: false, code: 'BILI_DYNAMIC_ACTION_ID_INVALID', error: '操作 ID 无效。', hint: '使用字母、数字、连字符或下划线。' }, 2)
  console.log(`操作 ID: ${actionId}（请保留以核对结果）`)
  const roleSnapshot = () => {
    let current
    try { current = JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    const id = String(current.id ?? ''), epoch = current.epoch == null ? 1 : Number(current.epoch)
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !Number.isSafeInteger(epoch) || epoch < 1 || !fs.existsSync(path.join(CHARACTERS_DIR, id, 'character.json'))) throw Error('invalid character')
    return { id, epoch }
  }
  let role
  try { role = roleSnapshot() } catch { report({ ok: false, code: 'STALE_CHARACTER', error: '无法确认当前角色。', hint: '检查当前角色后重新准备。', actionId }, 1) }
  const verifyRole = () => {
    const expectedId = process.env.SURFCORE_EXPECTED_CHARACTER_ID
    const expectedEpoch = process.env.SURFCORE_EXPECTED_CHARACTER_EPOCH
    if ((expectedId !== undefined || expectedEpoch !== undefined) && (!expectedId || !expectedEpoch || role?.id !== expectedId || role?.epoch !== Number(expectedEpoch))) throw Error('expected character mismatch')
    if (typeof statePaths.assertExpectedCharacter === 'function') statePaths.assertExpectedCharacter()
    if (JSON.stringify(roleSnapshot()) !== JSON.stringify(role)) throw Error('character changed')
    const latest = crypto.createHash('sha256').update(fs.readFileSync(credPath)).digest('hex')
    if (latest !== crypto.createHash('sha256').update(credBytes).digest('hex')) throw Error('account changed')
  }
  // Capture before network awaits, so a role switch cannot redirect the receipt.
  const stateDir = biliStateDir()
  console.log('=== 登录态 ===')
  try { verifyRole() } catch { report({ ok: false, code: 'BILI_DYNAMIC_IDENTITY_CHANGED', error: '角色或账号身份不匹配。', hint: '检查当前角色和账号后重新准备。', actionId }, 1) }
  const credentialHash = crypto.createHash('sha256').update(credBytes).digest('hex')
  if (!isDry) {
    const replay = existingDynamicAction(accountBili('dynamic-actions'), actionId, { character: role, credentialHash, accountMid: expectedMid })
    if (replay) report(replay, replay.ok ? 0 : 1)
  }
  let mid, qs
  try { mid = await whoami() } catch { report({ ok: false, code: 'BILI_DYNAMIC_AUTH_FAILED', error: '无法确认账号登录状态。', hint: '检查账号绑定后重新准备。', actionId }, 1) }
  if (!Number.isSafeInteger(mid) || mid < 1) report({ ok: false, code: 'BILI_DYNAMIC_AUTH_FAILED', error: '平台未提供可靠的账号身份。', hint: '检查账号绑定后重新准备。', actionId }, 1)
  if (expectedMid !== undefined && String(mid) !== expectedMid) report({ ok: false, code: 'BILI_DYNAMIC_IDENTITY_CHANGED', error: '当前账号与审批账号不一致，未发送。', hint: '切回审批时的账号后重新准备。', actionId }, 1)
  const body = JSON.stringify({
    dyn_req: {
      content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      scene: 1,
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
  })
  try { qs = await wbi({ csrf: String(cred.bili_jct) }) } catch { report({ ok: false, code: 'BILI_DYNAMIC_PREPARE_FAILED', error: '无法准备发布请求，未发送。', hint: '检查网络和账号绑定后重新准备。', actionId }, 1) }
  if (!qs) report({ ok: false, code: 'BILI_DYNAMIC_PREPARE_FAILED', error: '平台签名材料缺失，未发送。', hint: '检查网络和账号绑定后重新准备。', actionId }, 1)
  const url = `https://api.bilibili.com/x/dynamic/feed/create/dyn?${qs}`
  console.log('\n=== 将要发布 ===')
  console.log(`  POST ${url.replace(encodeURIComponent(String(cred.bili_jct)), '***csrf***').slice(0, 120)}…`)
  console.log(`  content-type: application/json    cookie: SESSDATA=***; bili_jct=***; buvid3=***`)
  console.log(`  正文(${text.length} 字): ${text}`)
  console.log(`  报文: ${body}`)
  const auto = process.argv.includes('--auto')
  const result = await publishDynamic({
    dry: isDry, text, auto, stateDir, actionId, intentDir: accountBili('dynamic-actions'), binding: { character: role, accountMid: String(mid), credentialHash },
    interaction: interactEnabled,
    identity: (value) => assertOutboundIdentitySafe(value, { surface: 'B站 动态' }),
    quota: () => biliStateDir() === stateDir && gate({ type: 'dynamic', target: 'dynamic', auto }),
    expectedIdentity: verifyRole,
    send: () => fetch(url, {
      method: 'POST',
      headers: { 'user-agent': UA, referer: REF, origin: 'https://t.bilibili.com', 'content-type': 'application/json', cookie: cookieHeader },
      body,
    }),
  })
  if (!result.ok) {
    report(result, 1)
  }
  if (result.dry) console.log('\n[dry] 闸门检查通过，未发布。')
  else {
    console.log(`\n[go] ✅ 已发布 dyn_id=${result.id}`)
    console.log(`  https://t.bilibili.com/${result.id}`)
    console.log(`  回执: ${result.receiptFile}`)
  }
  report(result, 0)
}

if (mode === 'check') {
  if (!dynId) { console.error('check 需要 --id <dyn_id>'); process.exit(2) }
  await whoami()
  const qs = await wbi({ id: String(dynId) })
  const r = await fetch(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?${qs}`, {
    headers: { 'user-agent': UA, referer: `${REF}${dynId}`, cookie: cookieHeader },
  })
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    console.log(`  detail 端点返回 ${ct || '未知类型'}，无法用它判定（不代表动态不存在）`)
    process.exit(0)
  }
  const d = await r.json()
  console.log(`  detail code=${d.code} ${d.message ?? d.msg ?? ''}`)
  if (d.code === 0) {
    const it = d.data?.item ?? {}
    console.log(`  存在 ✓  id=${it.id_str}  作者=${it.modules?.module_author?.name}  时间=${it.modules?.module_author?.pub_time}`)
    const t = it.modules?.module_dynamic?.desc?.text
    if (t) console.log(`  正文: ${t}`)
  } else {
    console.log('  未取到（删除后应当如此；若刚发完也没取到，多半是端点/权限问题）')
  }
  process.exit(0)
}

if (mode === 'rm') {
  if (!dynId) { console.error('rm 需要 --id <dyn_id>'); process.exit(2) }
  if (!isDry && !isGo) { console.error('必须显式 --dry 或 --go'); process.exit(2) }
  console.log('=== 登录态 ===')
  await whoami()
  console.log(`\n=== 将要删除 dyn_id=${dynId} ===`)
  console.log('  POST https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic  (multipart/form-data)')
  console.log('  fields: dynamic_id / csrf / csrf_token   cookie: SESSDATA=***; bili_jct=***')
  if (isDry) { console.log('\n[dry] 未删除。'); process.exit(0) }
  const fd = new FormData()
  fd.append('dynamic_id', String(dynId))
  fd.append('csrf', String(cred.bili_jct))
  fd.append('csrf_token', String(cred.bili_jct))
  const r = await fetch('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic', {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REF, cookie: cookieHeader },
    body: fd,
  })
  const out = await r.json()
  const hints = { 0: '成功', '-101': '账号未登录', 500404: '已经删除过该动态', 500406: '动态不是自己的' }
  console.log(`\n[go] HTTP ${r.status}  code=${out.code} ${out.message ?? out.msg ?? ''}`)
  console.log(`  ${hints[out.code] ?? ''}`)
  process.exit(0)
}

console.error('用法: list | post --text "..." --dry|--go | rm --id <dyn_id> --dry|--go')
process.exit(2)
