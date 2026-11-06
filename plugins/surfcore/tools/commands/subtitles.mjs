#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountBili } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { formatShotsStats, pruneShots, shotsPath } from '../lib/shots-cache.mjs'
import {
  createBiliApi, parseBiliReference, resolveBiliPart, structuredError,
} from '../lib/bili-media.mjs'

const VALUE_OPTIONS = new Set(['page', 'cid', 'lan', 'out', 'print'])
function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    if (key === 'json' || key === 'help') { options[key] = true; continue }
    if (!VALUE_OPTIONS.has(key)) throw Object.assign(new Error(`未知参数 --${key}`), { code: 'bili.argument.unknown', hint: '运行 `node bili.mjs subtitles --help` 查看支持的参数。' })
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw Object.assign(new Error(`--${key} 缺少参数值。`), { code: 'bili.argument.value-missing', hint: `为 --${key} 提供参数值后重试。` })
    options[key] = argv[++index]
  }
  return { positional, options }
}

function render(value, json) {
  if (json) { process.stdout.write(`${JSON.stringify(value)}\n`); return }
  if (value.ok === false) { process.stderr.write(`${value.code}: ${value.error}\n建议：${value.hint}\n`); return }
  process.stdout.write(`标题：${value.part.title || value.part.partTitle}\n`)
  process.stdout.write(`分 P：${value.part.page}/${value.part.pageCount}  cid=${value.part.cid}  时长=${(value.part.durationMs / 1000).toFixed(1)}s\n`)
  if (value.status === 'missing') { process.stdout.write('所选分 P 没有可用字幕轨；可用 `transcribe` 运行共享 ASR。\n'); return }
  process.stdout.write(`字幕来源：B 站 ${value.languageLabel || value.language}（${value.segments.length} 行）\n`)
  process.stdout.write(`JSON：${value.files.json}\nTXT：${value.files.text}\n`)
  for (const line of value.segments.slice(0, value.printCount)) process.stdout.write(`[${Math.floor(line.startMs / 60_000)}:${String(Math.floor(line.startMs / 1000) % 60).padStart(2, '0')}] ${line.text}\n`)
  if (value.segments.length > value.printCount) process.stdout.write(`（共 ${value.segments.length} 行；完整内容在文件中）\n`)
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const json = options.json === true
  if (options.help) {
    render({ ok: true, usage: 'subtitles <BV|URL> [--page N] [--cid N] [--lan ai-zh] [--out 目录] [--print N] [--json]' }, json)
    return
  }
  const reference = positional[0]
  if (!reference) throw Object.assign(new Error('缺少 BV 号或 B 站视频链接。'), { code: 'bili.reference.missing', hint: '传入 BV 号或包含 BV 号的 B 站视频链接。' })
  const parsed = parseBiliReference(reference, { page: options.page })
  const api = createBiliApi()
  const view = await api.fetchView(parsed.bvid)
  const part = resolveBiliPart(view, { page: parsed.page, cid: options.cid, urlPage: parsed.urlPage })
  const subtitles = await api.fetchSubtitle(part, { language: options.lan ?? 'ai-zh' })
  let owner = {}; try { owner = config().owner ?? {} } catch {}
  const clean = value => { let text = String(value ?? ''); for (const [secret, minimum, label] of [[owner.name, 2, '「主人昵称·已打码」'], [owner.mid, 4, '「主人mid·已打码」']]) if (String(secret ?? '').length >= minimum) text = text.split(String(secret)).join(label); return text }
  part.title = clean(part.title); part.partTitle = clean(part.partTitle)
  if (Array.isArray(subtitles.segments)) subtitles.segments = subtitles.segments.map(segment => ({ ...segment, text: clean(segment.text) }))
  if (subtitles.status === 'missing') {
    render({ ok: true, status: 'missing', bvid: part.bvid, part: { page: part.page, pageCount: part.pageCount, cid: part.cid, title: part.title, partTitle: part.partTitle, durationMs: part.durationMs }, language: subtitles.language, segments: [] }, json)
    return
  }
  const outputDir = typeof options.out === 'string' ? options.out : shotsPath('subs')
  fs.mkdirSync(outputDir, { recursive: true })
  const language = String(subtitles.language || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
  const base = path.join(outputDir, `${part.bvid}-p${part.page}-${part.cid}-${language}-${crypto.randomUUID()}`)
  const fmt = (ms) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
  fs.writeFileSync(`${base}.json`, `${JSON.stringify({ source: 'platform-subtitle', channel: 'bili', bvid: part.bvid, page: part.page, cid: part.cid, language: subtitles.language, coverage: subtitles.coverage, segments: subtitles.segments }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(`${base}.txt`, `${part.title}\nP${part.page}/${part.pageCount}  ${part.bvid}  cid=${part.cid}  ${(part.durationMs / 1000).toFixed(1)}s\n\n${subtitles.segments.map((line) => `[${fmt(line.startMs)}] ${line.text}`).join('\n')}\n`, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(`${base}-plain.txt`, `${subtitles.segments.map((line) => line.text).join('\n')}\n`, { mode: 0o600, flag: 'wx' })
  const printCount = Math.max(0, Math.min(200, Number(options.print ?? 12) || 0))
  const value = {
    ok: true,
    status: 'completed',
    bvid: part.bvid,
    part: { page: part.page, pageCount: part.pageCount, cid: part.cid, title: part.title, partTitle: part.partTitle, durationMs: part.durationMs },
    source: subtitles.source,
    language: subtitles.language,
    languageLabel: subtitles.languageLabel,
    aiStatus: subtitles.aiStatus,
    coverage: subtitles.coverage,
    segments: subtitles.segments,
    files: { json: `${base}.json`, text: `${base}.txt`, plain: `${base}-plain.txt` },
    printCount,
  }
  if (typeof options.out !== 'string') {
    try { value.cache = formatShotsStats(pruneShots()) } catch {}
  }
  render(value, json)
}

main().catch((error) => {
  const result = structuredError(error)
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, ...result })}\n`)
  else process.stderr.write(`${result.code}: ${result.error}\n建议：${result.hint}\n`)
  process.exitCode = 1
})
