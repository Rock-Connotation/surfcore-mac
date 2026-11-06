#!/usr/bin/env node
import crypto from 'node:crypto'
import { readCurrentCharacter } from '../../../../src/character-persona.js'
import { SURFCORE_DIR } from '../lib/state-paths.mjs'
import {
  createBiliApi, parseBiliReference, prepareBiliMedia, resolveBiliPart, structuredError,
} from '../lib/bili-media.mjs'
import {
  buildBiliTranscriptionRequest, createPerceptionClient, normalizeTranscriptionResult,
} from '../lib/perception-client.mjs'

const VALUE_OPTIONS = new Set(['page', 'cid', 'lang', 'status', 'cancel', 'resume'])
const BOOLEAN_OPTIONS = new Set(['json', 'help', 'no-history'])

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { positional.push(value); continue }
    const key = value.slice(2)
    if (BOOLEAN_OPTIONS.has(key)) { options[key] = true; continue }
    if (!VALUE_OPTIONS.has(key)) throw Object.assign(new Error(`未知参数 --${key}`), { code: 'bili.argument.unknown', hint: '运行 `node bili.mjs transcribe --help` 查看支持的参数。' })
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Object.assign(new Error(`--${key} 缺少参数值。`), { code: 'bili.argument.value-missing', hint: `为 --${key} 提供参数值后重试。` })
    options[key] = argv[++index]
  }
  if (['status', 'cancel', 'resume'].includes(positional[0])) {
    if (positional[1] && !options[positional[0]]) options[positional[0]] = positional[1]
    positional.splice(0, 2)
  }
  const actions = ['status', 'cancel', 'resume'].filter((key) => options[key])
  if (actions.length > 1) throw Object.assign(new Error('status、cancel、resume 只能选择一种操作。'), { code: 'bili.argument.conflict', hint: '每次只查询、取消或恢复一个作业。' })
  return { positional, options, action: actions[0] ?? 'submit' }
}

function writeOutput(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
  else if (value.ok === false) process.stderr.write(`${value.code}: ${value.error}\n建议：${value.hint}\n`)
  else {
    const part = value.part ? ` ${value.part.page}/${value.part.pageCount}P cid=${value.part.cid}` : ''
    if (value.action === 'cancel') process.stdout.write(`转写作业 ${value.jobId}：已提交取消请求。\n`)
    else if (value.action === 'resume') process.stdout.write(`转写作业 ${value.jobId}：已提交恢复请求。\n`)
    else if (value.action === 'status') {
      process.stdout.write(`转写作业 ${value.jobId}：${value.job?.state ?? '状态未知'}${part}\n`)
      if (value.job?.error?.code) process.stdout.write(`${value.job.error.code}: ${value.job.error.error} 建议：${value.job.error.hint}\n`)
      if (value.job?.memoryError?.code) process.stdout.write(`经历保存 ${value.job.memoryState}: ${value.job.memoryError.error} 建议：${value.job.memoryError.hint}\n`)
      if (value.job?.frames?.stripError) process.stdout.write(`字幕条: ${value.job.frames.stripError.error} 建议：${value.job.frames.stripError.hint}\n`)
      if (value.job?.frames?.sheet) process.stdout.write(`SHEET: ${value.job.frames.sheet}\n${value.job.frames.subtitleStrip ? `SUBS: ${value.job.frames.subtitleStrip}\n` : ''}`)
      if (value.job?.coverage) process.stdout.write(`覆盖：${value.job.coverage.complete ? '完整' : '部分'}，处理 ${value.job.coverage.processedRanges?.length ?? 0} 个区间\n`)
      for (const segment of (value.job?.segments ?? []).slice(0, 30)) process.stdout.write(`[${(segment.startMs / 1000).toFixed(1)}s] ${segment.text}\n`)
      if ((value.job?.segments?.length ?? 0) > 30) process.stdout.write(`（共 ${value.job.segments.length} 段；JSON 模式输出完整结果）\n`)
    } else {
      process.stdout.write(`已提交 B 站 ${value.part?.page}/${value.part?.pageCount}P 转写：${value.jobId}（${value.job?.state ?? 'queued'}）\n`)
      if (value.job?.segments?.length) for (const segment of value.job.segments.slice(0, 30)) process.stdout.write(`[${(segment.startMs / 1000).toFixed(1)}s] ${segment.text}\n`)
      if (value.history?.status) process.stdout.write(`观看历史：${value.history.status}\n`)
    }
  }
}

async function main() {
  const { positional, options, action } = parseArgs(process.argv.slice(2))
  const json = options.json === true
  if (options.help) {
    writeOutput({ ok: true, usage: 'transcribe <BV|URL> [--page N] [--cid N] [--lang auto|zh] [--no-history] [--json]; transcribe --status <jobId>|--cancel <jobId>|--resume <jobId>' }, json)
    return
  }
  const client = createPerceptionClient({ stateDir: SURFCORE_DIR })
  if (action === 'cancel') {
    const result = await client.cancel(options.cancel)
    writeOutput({ ok: true, action: 'cancel', jobId: options.cancel, result }, json)
    return
  }
  if (action === 'resume') {
    const result = await client.resume(options.resume)
    const resumedId = result.jobId || result.job?.jobId || options.resume
    const job = await client.getJob(resumedId).catch(() => null)
    const history = job?.history ?? { status: 'pending' }
    writeOutput({ ok: true, action: 'resume', jobId: resumedId, result, job: job ? normalizeTranscriptionResult(job) ?? { state: job.state } : null, history }, json)
    return
  }
  if (action === 'status') {
    const raw = await client.getJob(options.status)
    const job = normalizeTranscriptionResult(raw) ?? { state: raw.state, jobId: raw.jobId }
    const history = raw.history ?? { status: 'pending' }
    if (raw.frames) job.frames = raw.frames
    if (raw.error) job.error = raw.error
    if (raw.memoryState) job.memoryState = raw.memoryState
    if (raw.memoryError) job.memoryError = raw.memoryError
    writeOutput({ ok: true, action: 'status', jobId: options.status, part: { cid: raw.provenance?.partId ?? raw.result?.provenance?.partId ?? raw.part?.cid ?? '', page: Number(raw.part?.page) || Number(String(raw.result?.assetId ?? '').match(/:p(\d+):/)?.[1]) || null, pageCount: null }, job, history }, json)
    return
  }
  const reference = positional[0]
  if (!reference) throw Object.assign(new Error('缺少 BV 号或 B 站视频链接。'), { code: 'bili.reference.missing', hint: '传入 BV 号或包含 BV 号的 B 站视频链接。' })

  // Freeze role, epoch, paths and activity identity synchronously, before the first await.
  const current = readCurrentCharacter()
  if (!current?.id) throw Object.assign(new Error('当前角色不可用，不能创建可追溯的转写作业。'), { code: 'character.unavailable', hint: '在 SurfCore 角色页确认当前角色后重试。' })
  const character = { id: String(current.id), epoch: Number(current.epoch) || 1 }
  const activityId = crypto.randomUUID()
  const parsed = parseBiliReference(reference, { page: options.page })
  const { jobId } = await client.submitBili({ bvid: parsed.bvid, page: parsed.page, cid: options.cid ?? '', characterId: character.id, characterEpoch: character.epoch, activityId, asr: true, frames: false, recordHistory: !options['no-history'], recordExperience: !options['no-history'], languageHint: options.lang ?? 'auto' })
  writeOutput({ ok: true, action: 'submit', bvid: parsed.bvid, part: { page: parsed.page, pageCount: null, cid: options.cid ?? '' }, jobId, job: { state: 'queued' }, history: { status: options['no-history'] ? 'skipped' : 'pending' } }, json)

}

main().catch((error) => {
  const result = structuredError(error)
  const json = process.argv.includes('--json')
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, ...result })}\n`)
  else process.stderr.write(`${result.code}: ${result.error}\n建议：${result.hint}\n`)
  process.exitCode = 1
})
