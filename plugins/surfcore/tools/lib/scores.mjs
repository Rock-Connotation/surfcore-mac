// 当天"评分账"（2026-10-21 加，为「每天一条动态」服务）
//
// 为什么单独一个文件：分享只看第一名且过没过线；动态要的是**当天评分最高的那条**，
//   哪怕它没到分享阈值（13）—— 所以得把每次打分都记下来，而不是只记发出去的。
//
// 数据：~/.dsh/surfcore/bili/scores.json
//   { "2026-10-21": [ { bv, score, reason, title, at } ] }
// 同一天同一个 BV 重复打分 → 取**最高分**（不重复堆条目 ✓）
import { accountBili, biliState, biliStateDir, assertExpectedCharacter } from './state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
export const FILE = biliState('scores.json')
export const today = () => new Date().toLocaleDateString('sv-SE')

function scoreError(code, message, hint) { return Object.assign(new Error(message), { code, hint }) }
export function loadScores() {
  let raw
  try { raw = fs.readFileSync(FILE, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw scoreError('SCORES_READ_FAILED', '评分账本无法读取。', '检查角色 B 站目录权限后重试；保留现有账本。')
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value
  } catch { throw scoreError('SCORES_INVALID', '评分账本格式损坏，已停止写入。', '保留原账本，从备份恢复后重试。') }
}
export function saveScores(all) {
  const directory = path.dirname(FILE), temp = `${FILE}.${crypto.randomUUID()}.tmp`
  const serialized = JSON.stringify(all, null, 2) + '\n'
  assertExpectedCharacter()
  try {
    fs.mkdirSync(directory, { recursive: true })
    const fd = fs.openSync(temp, 'wx', 0o600)
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (fs.existsSync(FILE)) {
      const backups = path.join(directory, '_backups', 'scores')
      fs.mkdirSync(backups, { recursive: true, mode: 0o700 })
      fs.copyFileSync(FILE, path.join(backups, `${Date.now()}-${crypto.randomUUID()}.json`), fs.constants.COPYFILE_EXCL)
    }
    assertExpectedCharacter()
    fs.renameSync(temp, FILE)
  } catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    if (error?.code === 'STALE_CHARACTER') throw error
    throw scoreError('SCORES_WRITE_FAILED', '评分账本未能保存。', '检查角色 B 站目录权限和空间，保留备份后重试。')
  }
  try {
    if (fs.readFileSync(FILE, 'utf8') !== serialized) throw new Error('mismatch')
  } catch { throw scoreError('SCORES_VERIFY_FAILED', '评分写入后无法确认内容。', '保留账本及备份，检查实际内容后再决定是否重试。') }
}

/** 记一次打分（同 BV 同日取最高） */
export function recordScore({ bv, score, reason = '', title = '' }) {
  assertExpectedCharacter()
  const all = loadScores()
  const day = today()
  const list = Array.isArray(all[day]) ? all[day] : []
  const prev = list.find((x) => x.bv === bv)
  if (prev) {
    if (Number(score) > Number(prev.score ?? 0)) Object.assign(prev, { score: Number(score), reason, at: new Date().toISOString() })
  } else {
    list.push({ bv, score: Number(score), reason: String(reason ?? '').slice(0, 120), title: String(title ?? '').slice(0, 120), at: new Date().toISOString() })
  }
  all[day] = list
  // 只留最近 14 天，别把文件养大
  const keep = Object.keys(all).sort().slice(-14)
  const trimmed = {}
  for (const k of keep) trimmed[k] = all[k]
  saveScores(trimmed)
  return trimmed[day]
}

/** 今天的全部评分（按分数从高到低） */
export function todayScores() {
  const list = loadScores()[today()]
  return Array.isArray(list) ? [...list].sort((a, b) => Number(b.score) - Number(a.score)) : []
}

/** 今天评分最高的那条（没有就 null） */
export function bestToday() {
  return todayScores()[0] ?? null
}
