import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { publishDynamic, persistDynamicReceipt } from '../tools/lib/dynamic-receipt.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-dynamic-receipt-'))
const intentDir = path.join(tmp, 'intents')
const attempt = (options) => publishDynamic({ intentDir, actionId: crypto.randomUUID(), ...options })
const stateDir = path.join(tmp, 'state')
const base = { text: '测试', stateDir, auto: false, interaction: () => true, identity: () => {}, quota: () => true }
let sends = 0
const send = (response) => async () => { sends++; return response }
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
for (const [overrides, code] of [
  [{ interaction: () => false }, 'BILI_INTERACT_DISABLED'],
  [{ identity: () => { throw Error('unsafe') } }, 'BILI_DYNAMIC_IDENTITY_UNSAFE'],
  [{ quota: () => false }, 'BILI_DYNAMIC_QUOTA_BLOCKED'],
]) {
  const result = await attempt({ ...base, ...overrides, dry: true, send: send(response({ code: 0 })) })
  assert.equal(result.code, code); assert.ok(result.error && result.hint)
}
assert.equal(sends, 0)
assert.equal((await attempt({ ...base, dry: true, send: send(response({ code: 0 })) })).dry, true)
assert.equal(sends, 0)
for (const [mock, code] of [
  [send(response({ code: -101 })), 'BILI_DYNAMIC_REJECTED'],
  [send(response({ code: 0 }, 503)), 'BILI_DYNAMIC_UNKNOWN'],
  [send({ ok: true, status: 200, json: async () => { throw Error('parse') } }), 'BILI_DYNAMIC_UNKNOWN'],
  [send(response({ code: 0, data: {} })), 'BILI_DYNAMIC_UNKNOWN'],
  [send(response({ code: 0, data: { dyn_id: 1234567890123456789 } })), 'BILI_DYNAMIC_UNKNOWN'],
  [async () => { sends++; throw Error('timeout') }, 'BILI_DYNAMIC_UNKNOWN'],
]) {
  const before = sends
  const result = await attempt({ ...base, dry: false, send: mock })
  assert.equal(result.code, code); assert.ok(result.error && result.hint)
  assert.equal(sends, before + 1, 'no automatic retry')
}
const id = '1234567890123456789'
const confirmed = await attempt({ ...base, actionId: 'confirmed', dry: false, send: send(response({ code: 0, data: { dyn_id_str: id } })) })
assert.equal(confirmed.id, id)
assert.equal(JSON.parse(fs.readFileSync(confirmed.receiptFile)).id, id)
assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'quota.json'))).log.length, 1)
persistDynamicReceipt({ stateDir, id, auto: false })
assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'quota.json'))).log.length, 1)
const brokenDir = path.join(tmp, 'broken')
fs.mkdirSync(brokenDir); fs.writeFileSync(path.join(brokenDir, 'quota.json'), '{')
const failed = await attempt({ ...base, stateDir: brokenDir, dry: false, send: send(response({ code: 0, data: { dyn_id_str: id } })) })
assert.equal(failed.code, 'BILI_DYNAMIC_RECONCILE'); assert.equal(failed.id, id); assert.ok(failed.error && failed.hint.includes('不要重发'))
assert.equal(JSON.parse(fs.readFileSync(path.join(brokenDir, 'dynamic-receipts', `${id}.json`))).id, id)
let beforeReplay = sends
const replay = await attempt({ ...base, actionId: 'confirmed', dry: false, send: send(response({ code: 0 })) })
assert.equal(replay.id, id); assert.equal(replay.replayed, true); assert.equal(sends, beforeReplay)
const unknownFirst = await attempt({ ...base, actionId: 'unknown', dry: false, send: async () => { sends++; throw Error('timeout') } })
assert.equal(unknownFirst.code, 'BILI_DYNAMIC_UNKNOWN')
beforeReplay = sends
const unknownReplay = await attempt({ ...base, actionId: 'unknown', dry: false, send: send(response({ code: 0 })) })
assert.equal(unknownReplay.code, 'BILI_DYNAMIC_UNKNOWN'); assert.equal(unknownReplay.replayed, true); assert.equal(sends, beforeReplay)
fs.writeFileSync(path.join(intentDir, 'crashed.json'), '{')
const crashedReplay = await attempt({ ...base, actionId: 'crashed', dry: false, send: send(response({ code: 0 })) })
assert.equal(crashedReplay.code, 'BILI_DYNAMIC_UNKNOWN'); assert.equal(sends, beforeReplay)
const changed = await attempt({ ...base, dry: false, expectedIdentity: () => { throw Error('switched') }, send: send(response({ code: 0 })) })
assert.equal(changed.code, 'BILI_DYNAMIC_IDENTITY_CHANGED'); assert.equal(sends, beforeReplay)
const blockedIntent = path.join(tmp, 'not-a-directory')
fs.writeFileSync(blockedIntent, 'fixture')
const failedIntent = await attempt({ ...base, intentDir: blockedIntent, actionId: 'no-intent', dry: false, send: send(response({ code: 0 })) })
assert.equal(failedIntent.code, 'BILI_DYNAMIC_INTENT_FAILED'); assert.equal(sends, beforeReplay)
let release
const inFlight = attempt({ ...base, actionId: 'concurrent', dry: false, send: () => { sends++; return new Promise((resolve) => { release = resolve }) } })
const duplicate = await attempt({ ...base, actionId: 'concurrent', dry: false, send: send(response({ code: 0 })) })
assert.equal(duplicate.code, 'BILI_DYNAMIC_UNKNOWN'); assert.equal(sends, beforeReplay + 1)
release(response({ code: 0, data: { dyn_id_str: '987654321' } }))
assert.equal((await inFlight).ok, true)

// Execute the actual CLI with fetch replaced in an isolated child process.
const dsh = path.join(tmp, 'dsh')
const surf = path.join(dsh, 'surfcore')
fs.mkdirSync(path.join(surf, 'bili'), { recursive: true })
fs.writeFileSync(path.join(surf, 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'fixture', bili_jct: 'fixture', buvid3: 'fixture' }))
const shim = path.join(tmp, 'fetch-shim.mjs')
fs.writeFileSync(shim, `import fs from 'node:fs'; let navCalls=0; globalThis.fetch = async (url, opts = {}) => { if (opts.method === 'POST' && String(url).startsWith('https://api.bilibili.com/x/dynamic/feed/create/dyn?')) { fs.appendFileSync(process.env.FIXTURE_POSTS, '1'); if (process.env.FIXTURE_RESULT === 'throw') throw Error('timeout'); return {ok:true,status:200,json:async()=>process.env.FIXTURE_RESULT === 'reject' ? {code:-101} : {code:0,data:{dyn_id_str:'1234567890123456789'}}} } if (String(url) !== 'https://api.bilibili.com/x/web-interface/nav' || opts.method === 'POST') { fs.writeFileSync(process.env.FIXTURE_UNEXPECTED, 'unexpected request'); throw Error('unexpected request') } navCalls++; if(navCalls===2 && process.env.FIXTURE_CHANGE_ROLE) fs.writeFileSync(process.env.FIXTURE_CHANGE_ROLE, JSON.stringify({id:'role',epoch:2})); if(navCalls===2 && process.env.FIXTURE_CHANGE_CRED) fs.writeFileSync(process.env.FIXTURE_CHANGE_CRED, JSON.stringify({sessdata:'different',bili_jct:'fixture',buvid3:'fixture'})); return { json: async () => process.env.FIXTURE_BAD_NAV ? {code:-101} : ({code:0,data:{uname:'fixture',mid:1,wbi_img:{img_url:'https://example.invalid/abcdefghijklmnopqrstuvwxyz.png',sub_url:'https://example.invalid/abcdefghijklmnopqrstuvwxyz.png'}}}) } }`)
const cli = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url))
const posts = path.join(tmp, 'posts')
const unexpected = path.join(tmp, 'unexpected')
const run = (value, mode = '--dry', result = 'ok', actionId = crypto.randomUUID(), extraEnv = {}, expectedMid = '1') => {
  const resultProcess = spawnSync(process.execPath, [cli, 'dynamic', 'post', '--text', value, mode, '--action-id', actionId, '--json', ...(expectedMid === null ? [] : ['--expected-mid', expectedMid])], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${shim}`, FIXTURE_POSTS: posts, FIXTURE_UNEXPECTED: unexpected, FIXTURE_RESULT: result, HOME: tmp, USERPROFILE: tmp, DSH_HOME: dsh, SURFCORE_BILI_CONFIG: path.join(surf, 'bili.config.json'), SURFCORE_EXPECTED_CHARACTER_ID: undefined, SURFCORE_EXPECTED_CHARACTER_EPOCH: undefined, ...extraEnv } })
  assert.equal(fs.existsSync(unexpected), false, 'unexpected network request')
  return resultProcess
}
fs.writeFileSync(path.join(surf, 'bili.config.json'), JSON.stringify({ interact: { enabled: false } }))
let invalidNav = run('fixture', '--go', 'ok', 'invalid-nav', { FIXTURE_BAD_NAV: '1' })
assert.notEqual(invalidNav.status, 0)
const invalidResult = JSON.parse(invalidNav.stdout)
assert.equal(invalidResult.code, 'BILI_DYNAMIC_AUTH_FAILED'); assert.ok(invalidResult.error && invalidResult.hint)
assert.equal(fs.existsSync(posts), false, 'invalid nav cannot POST')
const missingExpected = run('fixture', '--go', 'ok', 'missing-account', {}, null)
assert.equal(JSON.parse(missingExpected.stdout).code, 'BILI_DYNAMIC_EXPECTED_ACCOUNT_REQUIRED')
const differentAccount = run('fixture', '--go', 'ok', 'wrong-account', {}, '2')
const differentResult = JSON.parse(differentAccount.stdout)
assert.notEqual(differentAccount.status, 0); assert.equal(differentResult.code, 'BILI_DYNAMIC_IDENTITY_CHANGED'); assert.ok(differentResult.error && differentResult.hint)
assert.equal(JSON.parse(run('fixture', '--dry', 'ok', 'wrong-account-dry', {}, '2').stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
assert.equal(fs.existsSync(posts), false, 'approved account mismatch cannot POST')
let cliResult = run('fixture')
assert.notEqual(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_INTERACT_DISABLED')
fs.writeFileSync(path.join(surf, 'bili.config.json'), JSON.stringify({ interact: { enabled: true } }))
cliResult = run('QQ 123456789')
assert.notEqual(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_UNSAFE')
fs.writeFileSync(path.join(surf, 'bili', 'quota.json'), '{')
cliResult = run('fixture')
assert.notEqual(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_QUOTA_BLOCKED')
assert.equal(fs.existsSync(posts), false)
fs.writeFileSync(path.join(surf, 'bili', 'quota.json'), JSON.stringify({ log: [] }))
cliResult = run('fixture', '--go', 'reject', 'cli-rejected')
assert.notEqual(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_REJECTED')
cliResult = run('fixture', '--go', 'throw', 'cli-unknown')
assert.notEqual(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_UNKNOWN')
cliResult = run('fixture', '--go', 'ok', 'cli-confirmed')
assert.equal(cliResult.status, 0); assert.equal(JSON.parse(cliResult.stdout).id, id)
cliResult = run('fixture', '--go', 'ok', 'cli-confirmed')
assert.equal(JSON.parse(cliResult.stdout).replayed, true)
cliResult = run('fixture', '--go', 'ok', 'cli-confirmed', {}, '2')
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
const legacyFile = path.join(surf, 'bili', 'dynamic-actions', 'legacy-binding.json')
const legacy = JSON.parse(fs.readFileSync(path.join(surf, 'bili', 'dynamic-actions', 'cli-confirmed.json')))
legacy.actionId = 'legacy-binding'; delete legacy.binding.accountMid
fs.writeFileSync(legacyFile, JSON.stringify(legacy))
cliResult = run('fixture', '--go', 'ok', 'legacy-binding')
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
cliResult = run('fixture', '--go', 'ok', 'cli-unknown')
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_UNKNOWN')
assert.equal(fs.readFileSync(posts, 'utf8'), '111')
assert.equal(JSON.parse(fs.readFileSync(path.join(surf, 'bili', 'quota.json'))).log.length, 1)
const characters = path.join(surf, 'characters')
fs.mkdirSync(path.join(characters, 'role'), { recursive: true })
fs.writeFileSync(path.join(characters, 'role', 'character.json'), '{}')
const current = path.join(characters, 'current.json')
const credentials = path.join(surf, 'bili', 'credentials.json')
const writeRole = () => fs.writeFileSync(current, JSON.stringify({ id: 'role', epoch: 1 }))
writeRole()
const expected = { SURFCORE_EXPECTED_CHARACTER_ID: 'role', SURFCORE_EXPECTED_CHARACTER_EPOCH: '1' }
cliResult = run('fixture', '--go', 'ok', 'cli-confirmed', expected)
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
cliResult = run('fixture', '--go', 'ok', 'role-switch', { ...expected, FIXTURE_CHANGE_ROLE: current })
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
writeRole()
cliResult = run('fixture', '--go', 'ok', 'account-switch', { ...expected, FIXTURE_CHANGE_CRED: credentials })
assert.equal(JSON.parse(cliResult.stdout).code, 'BILI_DYNAMIC_IDENTITY_CHANGED')
assert.equal(fs.readFileSync(posts, 'utf8'), '111', 'identity switch must block POST')
assert.equal(JSON.parse(fs.readFileSync(path.join(surf, 'bili', 'dynamic-actions', 'role-switch.json'))).binding.character.epoch, 1)
console.log('dynamic receipt: helper and real CLI behavior passed (isolated fetch stub, no network)')
