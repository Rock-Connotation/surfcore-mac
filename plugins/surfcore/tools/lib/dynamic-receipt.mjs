import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const failure = (code, error, hint, extra = {}) => ({ ok: false, code, error, hint, ...extra })
const unknown = (error) => failure('BILI_DYNAMIC_UNKNOWN', error, '不要重发；先在账号空间核对动态，确认结果后再处理。')

function syncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (!(process.platform === 'win32' && ['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code))) throw error
  }
}

function ensureDirectory(dir) {
  if (fs.existsSync(dir)) return
  const parent = path.dirname(dir)
  if (parent === dir) throw new Error('无法创建回执目录')
  ensureDirectory(parent)
  try { fs.mkdirSync(dir) } catch (error) { if (error.code !== 'EEXIST') throw error }
  syncDirectory(parent)
}

// File and directory synchronization matters: a printed success must survive a crash.
function atomicJson(file, value) {
  const dir = path.dirname(file)
  ensureDirectory(dir)
  const temp = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
    syncDirectory(dir)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function platformId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return ''
  const id = String(value ?? '')
  return /^[1-9]\d*$/.test(id) ? id : ''
}

function replayIntent(file, actionId, expectedBinding = null) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (expectedBinding && ((expectedBinding.accountMid != null && saved.binding?.accountMid !== expectedBinding.accountMid) || (saved.binding && (JSON.stringify(saved.binding.character) !== JSON.stringify(expectedBinding.character) || saved.binding.credentialHash !== expectedBinding.credentialHash)))) {
      return failure('BILI_DYNAMIC_IDENTITY_CHANGED', '该操作属于另一角色或账号。', '切回原角色和账号后核对；不要重复发送。', { actionId, replayed: true })
    }
    if (saved.actionId !== actionId || !saved.result || typeof saved.result.ok !== 'boolean') throw Error('pending')
    return { ...saved.result, actionId, replayed: true }
  } catch {
    return { ...unknown('该操作已有未完成记录，发布结果未知。'), actionId, replayed: true }
  }
}

export function existingDynamicAction(dir, actionId, binding = null) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(actionId ?? ''))) return null
  const file = path.join(dir, `${actionId}.json`)
  return fs.existsSync(file) ? replayIntent(file, actionId, binding) : null
}

function reserveIntent(dir, actionId, binding) {
  ensureDirectory(dir)
  const file = path.join(dir, `${actionId}.json`)
  let fd
  try { fd = fs.openSync(file, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') return { file, replay: replayIntent(file, actionId, binding) }
    throw error
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, actionId, state: 'pending', binding }) + '\n')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  syncDirectory(dir)
  return { file }
}

/** Commit a confirmed ID to the captured role directory; an existing ID is idempotent. */
export function persistDynamicReceipt({ stateDir, id, auto, now = new Date().toISOString() }) {
  const receiptFile = path.join(stateDir, 'dynamic-receipts', `${id}.json`)
  const quotaFile = path.join(stateDir, 'quota.json')
  atomicJson(receiptFile, { version: 1, id, at: now, type: 'dynamic', auto: !!auto })
  let quota = { log: [] }
  try { quota = JSON.parse(fs.readFileSync(quotaFile, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!quota || !Array.isArray(quota.log)) throw new Error('quota.json 格式无效')
  if (!quota.log.some((entry) => entry.type === 'dynamic' && entry.dynamicId === id)) {
    quota.log.push({ at: now, type: 'dynamic', auto: !!auto, share: false, target: 'dynamic', note: null, dynamicId: id })
    atomicJson(quotaFile, { log: quota.log })
  }
  return receiptFile
}

/** Dependencies are injected so the real decision path can be tested without network. */
export async function publishDynamic({ dry, text, auto, stateDir, intentDir, actionId, binding = null, interaction, identity, quota, expectedIdentity = () => {}, send, persist = persistDynamicReceipt }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(actionId ?? ''))) return failure('BILI_DYNAMIC_ACTION_ID_INVALID', '操作 ID 无效。', '使用固定的字母、数字、连字符或下划线作为操作 ID。')
  if (!dry) {
    const existing = existingDynamicAction(intentDir, actionId, binding)
    if (existing) return existing
  }
  if (!interaction()) return failure('BILI_INTERACT_DISABLED', '互动已关闭，不能发布动态。', '检查 B站互动设置；保持关闭时只读浏览。')
  try { identity(text) } catch {
    return failure('BILI_DYNAMIC_IDENTITY_UNSAFE', '动态包含受保护的身份信息。', '移除身份信息后重新检查正文。')
  }
  if (!quota()) return failure('BILI_DYNAMIC_QUOTA_BLOCKED', '动态额度检查未通过。', '检查额度账本和互动设置后重新检查。')
  if (dry) return { ok: true, dry: true, actionId }
  let intent
  try { intent = reserveIntent(intentDir, actionId, binding) } catch {
    return failure('BILI_DYNAMIC_INTENT_FAILED', '无法持久保存发布意图，未发送。', '检查本地目录权限和磁盘后再处理。', { actionId })
  }
  if (intent.replay) return intent.replay
  const finish = (result) => {
    const final = { ...result, actionId }
    try { atomicJson(intent.file, { version: 1, actionId, state: 'finished', binding, result: final }) } catch {
      if (result.id) return failure('BILI_DYNAMIC_RECONCILE', '平台已确认发布，但操作记录保存失败。', '不要重发；使用动态 ID 核对并修复本地记录。', { id: result.id, actionId })
      return { ...unknown('操作结果无法持久保存。'), actionId }
    }
    return final
  }
  try { expectedIdentity() } catch (error) {
    return finish(failure('BILI_DYNAMIC_IDENTITY_CHANGED', '角色或账号身份已改变，未发送。', error?.hint || '检查当前角色和账号后，使用新的操作 ID 重新准备。'))
  }
  let response
  try { response = await send() } catch { return finish(unknown('发布请求结果未知。')) }
  if (!response.ok) return finish(unknown(`平台返回 HTTP ${response.status}，发布结果未知。`))
  let body
  try { body = await response.json() } catch { return finish(unknown('平台响应无法解析，发布结果未知。')) }
  if (!body || typeof body.code !== 'number') return finish(unknown('平台响应缺少有效状态，发布结果未知。'))
  if (body.code !== 0) return finish(failure('BILI_DYNAMIC_REJECTED', `平台拒绝动态（code=${body.code}）。`, '检查平台返回状态与账号后再决定下一步。', { platformCode: body.code }))
  const id = platformId(body.data?.dyn_id_str ?? body.data?.dyn_id)
  if (!id) return finish(unknown('平台响应没有可靠的动态 ID，发布结果未知。'))
  try {
    const receiptFile = await persist({ stateDir, id, auto })
    return finish({ ok: true, id, receiptFile })
  } catch {
    return finish(failure('BILI_DYNAMIC_RECONCILE', '平台已确认发布，但本地回执或额度记账失败。', '不要重发；使用动态 ID 核对并修复本地回执和额度账。', { id }))
  }
}
