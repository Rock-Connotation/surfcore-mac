/**
 * B站「看过什么」的观看历史（按角色隔离）。
 *
 * 为什么需要单独一份：
 *   原来的 `bili-memory.json` 是从评分/评论/日记反推出来的“记忆”，
 *   只保留有互动的视频；排在前面的 5 条初筛（debrief --no-frames）根本没记。
 *   设置页要回答的是“她今天到底看了什么”，所以这里在真正读视频时直接追加。
 *
 * 写入：`debrief`（浅看/深看都记）与直接调用的 `watch-video`。
 * 路径：`~/.dsh/surfcore/characters/<id>/bili/watch-history.jsonl`
 * 格式：一行一个 JSON，append-only；同一条视频 30 分钟内同模式只记一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import { biliState } from './state-paths.mjs'

export const WATCH_HISTORY_FILE = () => biliState('watch-history.jsonl')
export const WATCH_HISTORY_ROTATED = () => biliState('watch-history.1.jsonl')
const MAX_BYTES = 2 * 1024 * 1024
const DEDUPE_MS = 30 * 60 * 1000
const SPEECH_RANK = { none: 0, queued: 1, running: 2, interrupted: 3, failed: 3, cancelled: 3, partial: 4, completed: 5 }

const localDate = (value) => {
  const t = new Date(value)
  return Number.isFinite(t.getTime()) ? t.toLocaleDateString('sv-SE') : ''
}
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
const short = (text, n) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const safeId = (value) => /^[A-Za-z0-9._:-]{1,120}$/.test(String(value ?? '')) ? String(value) : ''

function normalizeCoverage(value) {
  if (!value || typeof value !== 'object') return null
  if (Number.isFinite(Number(value.requestedMs)) || Number.isFinite(Number(value.processedMs))) {
    const missingRanges = (Array.isArray(value.missingRanges) ? value.missingRanges : []).slice(0, 100).map((range) => ({
      startMs: clamp(range?.startMs, 0, 24 * 60 * 60 * 1000),
      endMs: clamp(range?.endMs, 0, 24 * 60 * 60 * 1000),
    })).filter((range) => range.endMs > range.startMs)
    return {
      complete: value.complete === true,
      requestedMs: clamp(value.requestedMs, 0, 24 * 60 * 60 * 1000),
      acquiredMs: clamp(value.acquiredMs, 0, 24 * 60 * 60 * 1000),
      processedMs: clamp(value.processedMs, 0, 24 * 60 * 60 * 1000),
      missingMs: clamp(value.missingMs, 0, 24 * 60 * 60 * 1000),
      missingRanges,
    }
  }
  const ranges = (items) => (Array.isArray(items) ? items : []).slice(0, 100).map((range) => ({
    startMs: clamp(range?.startMs, 0, 24 * 60 * 60 * 1000),
    endMs: clamp(range?.endMs, 0, 24 * 60 * 60 * 1000),
  })).filter((range) => range.endMs > range.startMs)
  const requestedRanges = ranges(value.requestedRanges)
  const acquiredRanges = ranges(value.acquiredRanges)
  const processedRanges = ranges(value.processedRanges)
  const missingRanges = ranges(value.missingRanges)
  const total = (items) => items.reduce((sum, range) => sum + range.endMs - range.startMs, 0)
  return {
    complete: value.complete === true,
    requestedMs: total(requestedRanges),
    acquiredMs: total(acquiredRanges),
    processedMs: total(processedRanges),
    missingMs: total(missingRanges),
    missingRanges,
  }
}

function normalizeFrameStatus(entry) {
  const value = String(entry.frameStatus ?? entry.framesStatus ?? '').trim()
  if (['skipped', 'completed', 'partial', 'failed'].includes(value)) return value
  return entry.frames === true ? 'completed' : 'skipped'
}

function normalizeSafeError(value) {
  if (!value || typeof value !== 'object') return null
  const code = safeId(value.code)
  if (!code) return null
  const error = short(value.error, 180)
  const hint = short(value.hint, 240)
  const sensitive = /https?:\/\//i.test(error) || /cookie|SESSDATA|bili_jct|buvid3|auth_key|w_rid|token=/i.test(error)
  return {
    code,
    error: sensitive ? '处理失败，详细错误已隐藏以保护访问凭据。' : error,
    hint: /https?:\/\//i.test(hint) || /cookie|SESSDATA|bili_jct|buvid3|auth_key|w_rid|token=/i.test(hint)
      ? '检查任务状态后重试。' : hint,
  }
}

function speechStatusRank(entry) {
  return SPEECH_RANK[entry.speechStatus] ?? 0
}

function observationKey(entry) {
  if (entry.observationId) return `observation:${entry.observationId}`
  if (entry.bvid && entry.cid) return `part:${entry.bvid}:${entry.cid}`
  if (entry.bvid) return `legacy:${entry.bvid}`
  return ''
}

function isUpgrade(previous, incoming) {
  if (speechStatusRank(incoming) > speechStatusRank(previous)) return true
  if (Number(incoming.coverage?.processedMs ?? 0) > Number(previous.coverage?.processedMs ?? 0)) return true
  if (incoming.coverage?.complete === true && previous.coverage?.complete !== true) return true
  if (incoming.frames === true && previous.frames !== true) return true
  if (incoming.jobId && incoming.jobId !== previous.jobId && speechStatusRank(incoming) >= speechStatusRank(previous)) return true
  return false
}

function mergeObservation(previous, incoming) {
  const deeper = speechStatusRank(incoming) >= speechStatusRank(previous)
  const merged = {
    ...previous,
    ...incoming,
    observationId: previous.observationId || incoming.observationId,
    revision: Math.max(1, Number(previous.revision) || 1) + 1,
    title: incoming.title || previous.title,
    up: incoming.up || previous.up,
    upMid: incoming.upMid || previous.upMid,
    page: incoming.page ?? previous.page,
    cid: incoming.cid || previous.cid,
    jobId: incoming.jobId || previous.jobId,
    transcriptId: incoming.transcriptId || previous.transcriptId,
    speechStatus: deeper ? incoming.speechStatus : previous.speechStatus,
    speechSource: incoming.speechSource === 'none' ? previous.speechSource : incoming.speechSource,
    speechState: incoming.speechState === 'unknown' ? previous.speechState : incoming.speechState,
    coverage: (Number(incoming.coverage?.processedMs ?? 0) >= Number(previous.coverage?.processedMs ?? 0))
      ? incoming.coverage ?? previous.coverage : previous.coverage,
    frames: previous.frames || incoming.frames,
    frameStatus: previous.frameStatus === 'completed' ? previous.frameStatus : incoming.frameStatus,
    sheet: incoming.sheet || previous.sheet,
    subs: incoming.subs || previous.subs,
    error: incoming.error || (deeper ? null : previous.error),
  }
  return merged
}

function readTail(file, maxBytes = MAX_BYTES) {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 只保留展示需要的字段；未知字段不落盘（避免把内部状态写进历史）。 */
export function normalizeWatchEntry(entry = {}) {
  const rawAt = String(entry.at ?? '').trim()
  const dateText = String(entry.date ?? '').trim()
  let at = ''
  let dateOnly = entry.dateOnly === true
  if (rawAt) {
    const t = new Date(rawAt)
    if (Number.isFinite(t.getTime())) at = t.toISOString()
  }
  if (!at && dateText) {
    const t = new Date(`${dateText}T12:00:00+08:00`)
    if (Number.isFinite(t.getTime())) { at = t.toISOString(); dateOnly = true }
  }
  const unknownDate = entry.unknownDate === true
  if (!at) at = unknownDate ? '1970-01-01T00:00:00.000Z' : new Date().toISOString()
  const speechStatus = ['none', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(entry.speechStatus ?? ''))
    ? String(entry.speechStatus) : 'none'
  const speechSource = ['none', 'platform-subtitle', 'asr'].includes(String(entry.speechSource ?? ''))
    ? String(entry.speechSource) : 'none'
  const speechState = ['speech', 'no_speech', 'unknown'].includes(String(entry.speechState ?? ''))
    ? String(entry.speechState) : 'unknown'
  const pageValue = Number(entry.page)
  return {
    at,
    unknownDate,
    dateOnly: dateOnly && !unknownDate,
    bvid: /^BV[0-9A-Za-z]{10}$/.test(String(entry.bvid ?? '')) ? String(entry.bvid) : '',
    aid: String(entry.aid ?? ''),
    cid: /^\d{1,24}$/.test(String(entry.cid ?? '').trim()) ? String(entry.cid).trim() : '',
    page: Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : null,
    pageCount: clamp(entry.pageCount, 0, 10_000),
    title: short(entry.title, 180),
    up: short(entry.up, 80),
    upMid: short(entry.upMid, 20),
    duration: clamp(entry.duration, 0, 24 * 3600),
    tname: short(entry.tname, 40),
    mode: ['meta', 'full', 'frames', 'memory'].includes(entry.mode) ? entry.mode : 'meta',
    frames: entry.frames === true,
    frameStatus: normalizeFrameStatus(entry),
    observationId: safeId(entry.observationId),
    revision: clamp(entry.revision, 1, 1_000_000) || 1,
    jobId: safeId(entry.jobId),
    transcriptId: safeId(entry.transcriptId),
    speechStatus,
    speechSource,
    speechState,
    coverage: normalizeCoverage(entry.coverage),
    error: normalizeSafeError(entry.error),
    source: short(entry.source ?? 'debrief', 24),
    sheet: short(entry.sheet, 400),
    subs: short(entry.subs, 400),
    score: entry.score == null || entry.score === '' || !Number.isFinite(Number(entry.score)) ? null : Number(entry.score),
  }
}

/** 追加一条观看记录；失败不抛（不能因为历史文件坏了就让看视频本身失败）。 */
export function appendWatch(entry = {}, { file = WATCH_HISTORY_FILE() } = {}) {
  try {
    const item = normalizeWatchEntry(entry)
    if (!item.bvid && !item.title) return { ok: false, reason: '缺少 bvid/title' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 去重：同一条视频、同一种读法、30 分钟内只记一次。
    const recent = readTail(file, 64 * 1024)
      .split('\n')
      .filter(Boolean)
      .slice(-80)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    const normalizedRecent = recent.map((x) => ({ raw: x, item: normalizeWatchEntry(x) }))
    const exactObservation = item.observationId
      ? [...normalizedRecent].reverse().find((x) => x.item.observationId === item.observationId)
      : null
    const itemTime = new Date(item.at).getTime()
    const recentPart = item.bvid && item.cid
      ? [...normalizedRecent].reverse().find((x) => x.item.bvid === item.bvid && x.item.cid === item.cid
        && itemTime - new Date(x.item.at).getTime() < DEDUPE_MS)
      : null
    const legacy = item.bvid && !item.cid
      ? [...normalizedRecent].reverse().find((x) => x.item.bvid === item.bvid && !x.item.cid
        && itemTime - new Date(x.item.at).getTime() < DEDUPE_MS)
      : null
    const match = exactObservation ?? recentPart ?? legacy
    const last = match?.raw ?? null
    if (last) {
      const prior = normalizeWatchEntry(last)
      const withinWindow = itemTime - new Date(prior.at).getTime() < DEDUPE_MS
      if (item.observationId && prior.observationId === item.observationId) {
        if (!isUpgrade(prior, item)) return { ok: false, reason: 'duplicate', file, item: prior }
        Object.assign(item, mergeObservation(prior, item))
      } else if (withinWindow) {
        if (!isUpgrade(prior, item)) return { ok: false, reason: 'duplicate', file, item: prior }
        item.observationId = prior.observationId || item.observationId
        Object.assign(item, mergeObservation(prior, item))
      }
    }
    // 简单轮转：超过 2MB 就把当前文件改名成 .1，再从空文件开始追加。
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        const rotated = file.replace(/\.jsonl$/, '.1.jsonl')
        if (fs.existsSync(rotated)) fs.renameSync(rotated, `${rotated}.${Date.now()}-${process.pid}`)
        fs.renameSync(file, rotated)
      }
    } catch {}
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`)
    return { ok: true, item, file }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

function parseLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

function scoreMap(scoresFile) {
  const all = readJson(scoresFile, {}) ?? {}
  const map = new Map()
  for (const [day, list] of Object.entries(all)) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item?.bv) continue
      map.set(`${day}|${item.bv}`, { score: Number(item.score) || 0, reason: String(item.reason ?? '').slice(0, 120) })
    }
  }
  return map
}

function memoryEntries(memoryFile) {
  const data = readJson(memoryFile, null)
  const entries = Array.isArray(data?.entries) ? data.entries : []
  return entries
    .filter((e) => e && (e.type === 'video' || e.bvid) && e.bvid)
    .map((e) => {
      // ⚠️ 2026-10-23 修：`at: ""` 是空字符串，`??` 不会回落到 date，
      //    new Date('') 无效 → 旧写法回落到 Date.now()，于是**每条无 at 的旧记忆
      //    每次刷新都变成“刚刚看过”**（原神/鸣潮那两条就属于这种）。这里按 date 回填；
      //    连 date 都没有的标 1970 + unknownDate，页面显示「日期未知」，不再冒充今天。
      const rawAt = String(e.at ?? '').trim()
      const dateText = String(e.date ?? '').trim()
      let at = ''
      let dateOnly = false
      if (rawAt) {
        const t = new Date(rawAt)
        if (Number.isFinite(t.getTime())) at = t.toISOString()
      }
      if (!at && dateText) {
        const t = new Date(`${dateText}T12:00:00+08:00`)
        if (Number.isFinite(t.getTime())) { at = t.toISOString(); dateOnly = true }
      }
      const unknownDate = !at
      if (!at) at = '1970-01-01T00:00:00.000Z'
      return {
        at,
        unknownDate,
        dateOnly,
        bvid: String(e.bvid ?? ''),
        title: short(e.title, 180),
        up: '',
        duration: 0,
        mode: 'memory',
        source: 'memory',
        // bili-memory 里没评分的条目 score 默认是 0；没有 reason 的 0 分不要当成“0/20”。
        score: (Number.isFinite(Number(e.score)) && (Number(e.score) > 0 || e.reason))
          ? Number(e.score) : null,
        reason: short(e.reason, 120),
        backfilled: true,
      }
    })
}

/**
 * 读取观看历史（新记录 + 从旧记忆补的历史），按时间倒序。
 * @param {{file?:string, memoryFile?:string, scoresFile?:string, limit?:number, q?:string, days?:number, now?:number}} opts
 */
export function readWatchHistory({
  file = WATCH_HISTORY_FILE(),
  memoryFile = biliState('bili-memory.json'),
  scoresFile = biliState('scores.json'),
  limit = 200,
  q = '',
  days = 0,
  now = Date.now(),
} = {}) {
  const rotated = file.replace(/\.jsonl$/, '.1.jsonl')
  const raw = [...parseLines(readTail(rotated)), ...parseLines(readTail(file))]
  const entries = raw
    .map((x) => normalizeWatchEntry(x))
    .filter((x) => x.bvid || x.title)
    .sort((a, b) => new Date(a.at) - new Date(b.at))

  // 展示去重：同一分 P 的 30 分钟内升级只留一行；不同 cid 永不合并。
  // 隔天重看（>30 分钟）仍会保留两条，历史里能看出“又刷了一遍”。
  const rank = { memory: 0, meta: 1, full: 2, frames: 3 }
  const compact = []
  for (const item of entries) {
    const prev = compact[compact.length - 1]
    const samePart = prev && prev.bvid === item.bvid && (
      (prev.cid && item.cid && prev.cid === item.cid) || (!prev.cid && !item.cid)
    )
    const sameObservation = prev && item.observationId && prev.observationId === item.observationId
    if (prev && (samePart || sameObservation)
      && new Date(item.at) - new Date(prev.at) < DEDUPE_MS) {
      const deeper = (rank[item.mode] ?? 0) >= (rank[prev.mode] ?? 0)
      const merged = {
        ...prev,
        ...(deeper ? item : {}),
        at: deeper ? item.at : prev.at,
        mode: deeper ? item.mode : prev.mode,
        unknownDate: prev.unknownDate === true || item.unknownDate === true,
        dateOnly: prev.dateOnly === true || item.dateOnly === true,
        frames: prev.frames || item.frames,
        sheet: (deeper ? item.sheet : prev.sheet) || prev.sheet || item.sheet,
        subs: (deeper ? item.subs : prev.subs) || prev.subs || item.subs,
        score: item.score ?? prev.score,
        observationId: item.observationId || prev.observationId,
        revision: Math.max(Number(prev.revision) || 1, Number(item.revision) || 1),
        jobId: item.jobId || prev.jobId,
        transcriptId: item.transcriptId || prev.transcriptId,
        speechStatus: speechStatusRank(item) >= speechStatusRank(prev) ? item.speechStatus : prev.speechStatus,
        speechSource: item.speechSource !== 'none' ? item.speechSource : prev.speechSource,
        speechState: item.speechState !== 'unknown' ? item.speechState : prev.speechState,
        coverage: (Number(item.coverage?.processedMs ?? 0) >= Number(prev.coverage?.processedMs ?? 0)) ? item.coverage ?? prev.coverage : prev.coverage,
        frameStatus: prev.frameStatus === 'completed' ? prev.frameStatus : item.frameStatus,
        error: item.error ?? prev.error,
      }
      compact[compact.length - 1] = merged
    } else {
      compact.push(item)
    }
  }

  const seenBv = new Set(compact.map((x) => x.bvid).filter(Boolean))
  for (const item of memoryEntries(memoryFile)) {
    if (seenBv.has(item.bvid)) continue
    seenBv.add(item.bvid)
    compact.push(item)
  }

  const scores = scoreMap(scoresFile)
  for (const item of compact) {
    const hit = scores.get(`${localDate(item.at)}|${item.bvid}`)
    if (!hit) continue
    if (item.score == null) item.score = hit.score
    if (!item.reason) item.reason = hit.reason
  }

  const cutoff = Number(days) > 0 ? now - Number(days) * 86400000 : 0
  const query = String(q ?? '').trim().toLowerCase()
  const all = compact
    .filter((x) => !cutoff || new Date(x.at).getTime() >= cutoff)
    .filter((x) => !query || `${x.title} ${x.up} ${x.bvid}`.toLowerCase().includes(query))
    .sort((a, b) => new Date(b.at) - new Date(a.at))

  const today = localDate(now)
  const weekAgo = now - 7 * 86400000
  return {
    file,
    memoryFile,
    items: all.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))),
    total: all.length,
    stats: {
      today: all.filter((x) => localDate(x.at) === today).length,
      last7d: all.filter((x) => new Date(x.at).getTime() >= weekAgo).length,
      deep: all.filter((x) => x.mode === 'full' || x.mode === 'frames').length,
      backfilled: all.filter((x) => x.backfilled).length,
      uniqueVideos: new Set(all.map((x) => x.bvid).filter(Boolean)).size,
    },
    generatedAt: new Date().toISOString(),
  }
}
