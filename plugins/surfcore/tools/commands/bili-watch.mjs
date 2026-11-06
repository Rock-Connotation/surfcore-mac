#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readCurrentCharacter, characterPaths } from '../../../../src/character-persona.js'
import { SURFCORE_DIR, biliState, biliStateDir } from '../lib/state-paths.mjs'
import { appendWatch } from '../lib/watch-history.mjs'
import { formatShotsStats, pruneShots, shotsPath } from '../lib/shots-cache.mjs'
import {
  createBiliApi, createFrameSheet, parseBiliReference, prepareBiliMedia, resolveBiliPart, structuredError,
} from '../lib/bili-media.mjs'

const VALUE_OPTIONS = new Set(['page', 'cid', 'grid', 'out'])
function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    if (['uniform', 'keep-mp4', 'no-history', 'json', 'help'].includes(key)) { options[key] = true; continue }
    if (!VALUE_OPTIONS.has(key)) throw Object.assign(new Error(`未知参数 --${key}`), { code: 'bili.argument.unknown', hint: '运行 `node bili.mjs watch-video --help` 查看支持的参数。' })
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Object.assign(new Error(`--${key} 缺少参数值。`), { code: 'bili.argument.value-missing', hint: `为 --${key} 提供参数值后重试。` })
    options[key] = argv[++index]
  }
  return { positional, options }
}

function render(value, json) {
  if (json) { process.stdout.write(`${JSON.stringify(value)}\n`); return }
  if (value.ok === false) { process.stderr.write(`${value.code}: ${value.error}\n建议：${value.hint}\n`); return }
  process.stdout.write(`标题：${value.part.title}\n`)
  process.stdout.write(`分 P：${value.part.page}/${value.part.pageCount}  cid=${value.part.cid}  时长=${(value.part.durationMs / 1000).toFixed(1)}s\n`)
  process.stdout.write(`媒体：${value.media.status} (${value.media.strategy})\n`)
  if (value.media?.path) process.stdout.write(`原片保留：${value.media.path}\n`)
  if (value.frames?.sheet) process.stdout.write(`SHEET: ${value.frames.sheet}\n`)
  if (value.frames?.subtitleStrip) process.stdout.write(`SUBS: ${value.frames.subtitleStrip}\n`)
  process.stdout.write(`画面覆盖：${value.frames?.status ?? 'failed'}，${value.frames?.samples?.length ?? 0} 个采样点\n`)
  if (value.history?.status) process.stdout.write(`观看历史：${value.history.status}\n`)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const json = options.json === true
  if (options.help) {
    render({ ok: true, usage: 'watch-video <BV|URL> [3x3|4x4] [outDir] [--page N] [--cid N] [--grid CxR] [--uniform] [--keep-mp4] [--json]' }, json)
    return
  }
  const reference = positional[0]
  if (!reference) throw Object.assign(new Error('缺少 BV 号或 B 站视频链接。'), { code: 'bili.reference.missing', hint: '传入 BV 号或包含 BV 号的 B 站视频链接。' })
  const grid = String(options.grid ?? positional[1] ?? '3x3')
  const outputDir = String(options.out ?? positional[2] ?? shotsPath('video'))

  // Capture the selected role path before network or media work can yield.
  const current = readCurrentCharacter()
  const historyFile = current?.id
    ? path.join(characterPaths(current.id).biliDir, 'watch-history.jsonl')
    : biliState('watch-history.jsonl')
  const parsed = parseBiliReference(reference, { page: options.page })
  const api = createBiliApi()
  const view = await api.fetchView(parsed.bvid)
  const part = resolveBiliPart(view, { page: parsed.page, cid: options.cid, urlPage: parsed.urlPage })
  const media = await prepareBiliMedia({
    part,
    fetchPlayurl: api.fetchPlayurl,
    dataRoot: path.join(SURFCORE_DIR, 'perception', 'assets'),
    needAudio: false,
    needVideo: true,
  })
  if (!media.video?.path || media.video.status === 'failed') {
    const reason = media.video?.error ?? media.warnings?.[0]
    throw Object.assign(new Error(reason?.error ?? '没有可用于抽帧的视频素材。'), {
      code: reason?.code ?? 'media.video.unavailable',
      hint: reason?.hint ?? '检查该分 P 的播放权限与 FFmpeg/FFprobe 状态后重试。',
    })
  }
  let frames
  let frameError = null
  try {
    frames = await createFrameSheet({
      mediaPath: media.video.path,
      timelineMap: media.video.timelineMap,
      sourceDurationMs: part.durationMs,
      bvid: part.bvid,
      page: part.page,
      outputDir,
      grid,
      uniform: options.uniform === true,
      keepMedia: options['keep-mp4'] === true || process.env.SURFCORE_KEEP_MP4 === '1' || Boolean(process.env.SURFCORE_WATCH_PARENT),
    })
  } catch (error) { frameError = structuredError(error) }
  if (!frames && !options['keep-mp4'] && !process.env.SURFCORE_WATCH_PARENT) {
    try { fs.rmSync(media.destinationDir, { recursive: true, force: true }) } catch {}
  }
  if (frames && !options['keep-mp4'] && process.env.SURFCORE_KEEP_MP4 !== '1' && !process.env.SURFCORE_WATCH_PARENT) {
    try { fs.rmSync(media.destinationDir, { recursive: true, force: true }) } catch {}
  }
  let history = { status: 'skipped' }
  if (!options['no-history'] && !process.env.SURFCORE_WATCH_PARENT) {
    const recorded = appendWatch({
      at: new Date().toISOString(),
      observationId: crypto.randomUUID(),
      bvid: part.bvid,
      aid: part.aid,
      cid: part.cid,
      page: part.page,
      pageCount: part.pageCount,
      title: part.partTitle || part.title,
      up: part.owner.name,
      upMid: part.owner.mid,
      duration: part.durationMs / 1000,
      tname: part.tname,
      mode: 'frames',
      frames: Boolean(frames?.sheet),
      frameStatus: frames?.status ?? 'failed',
      source: 'watch',
      sheet: frames?.sheet ?? '',
      subs: frames?.subtitleStrip ?? '',
      error: frameError,
    }, { file: historyFile })
    history = { status: recorded.ok ? 'recorded' : recorded.reason === 'duplicate' ? 'duplicate' : 'failed' }
  }
  try { if (path.resolve(outputDir) === path.resolve(shotsPath('video'))) formatShotsStats(pruneShots()) } catch {}
  render({
    ok: Boolean(frames),
    code: frameError?.code,
    error: frameError?.error,
    hint: frameError?.hint,
    bvid: part.bvid,
    part: { page: part.page, pageCount: part.pageCount, cid: part.cid, durationMs: part.durationMs, title: part.partTitle || part.title },
    media: { status: media.video.status, strategy: media.video.strategy, ...(options['keep-mp4'] || process.env.SURFCORE_KEEP_MP4 === '1' ? { path: media.video.path } : {}), acquiredRanges: media.video.acquiredRanges, missingRanges: media.video.missingRanges },
    frames: frames ?? { status: 'failed', source: 'video-frames', samples: [] },
    history,
  }, json)
  if (!frames) process.exitCode = 1
}

main().catch((error) => {
  const result = structuredError(error)
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, ...result })}\n`)
  else process.stderr.write(`${result.code}: ${result.error}\n建议：${result.hint}\n`)
  process.exitCode = 1
})
