import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { accountBili } from './state-paths.mjs'
import * as mediaRuntime from './ffmpeg.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const DEFAULT_TIMEOUT_MS = 30_000
const DURATION_TOLERANCE_MS = 1_500

export class BiliMediaError extends Error {
  constructor(code, error, hint, details = {}) {
    super(error)
    this.name = 'BiliMediaError'
    this.code = String(code || 'bili.media.failed')
    this.hint = String(hint || '检查参数和媒体状态后重试。')
    this.details = details && typeof details === 'object' ? details : {}
  }

  toJSON() {
    return { code: this.code, error: this.message, hint: this.hint, ...this.details }
  }
}

function fail(code, error, hint, details) {
  return new BiliMediaError(code, error, hint, details)
}

function positiveInt(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null
  if (!/^\d+$/.test(String(value))) throw fail('bili.part.invalid', `${label} 必须是正整数。`, `检查 ${label} 参数后重试。`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw fail('bili.part.invalid', `${label} 必须是正整数。`, `检查 ${label} 参数后重试。`)
  return number
}

export function parseBiliReference(input, { page } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw fail('bili.reference.missing', '缺少 B 站视频 BV 号。', '传入 BV 号或包含 BV 号的 B 站视频链接。')
  let urlPage = null
  let bvid = ''
  if (/^https?:\/\//i.test(raw)) {
    let url
    try { url = new URL(raw) } catch { throw fail('bili.reference.invalid', 'B 站视频链接格式无效。', '复制包含 BV 号的标准视频链接后重试。') }
    const host = url.hostname.toLowerCase()
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host)
      && !host.endsWith('.bilibili.com')) {
      throw fail('bili.reference.invalid', '只接受 B 站视频链接。', '传入 BV 号或 bilibili.com 视频链接。')
    }
    bvid = (url.pathname.match(/BV[0-9A-Za-z]{10}/i) ?? [])[0] ?? ''
    if (url.searchParams.has('p')) urlPage = positiveInt(url.searchParams.get('p'), 'URL 的 p')
  } else {
    bvid = (raw.match(/BV[0-9A-Za-z]{10}/i) ?? [])[0] ?? ''
  }
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    throw fail('bili.reference.invalid', '无法从输入中识别 BV 号。', '传入完整 BV 号或包含 BV 号的 B 站视频链接。')
  }
  const explicitPage = positiveInt(page, '--page', { optional: true })
  if (urlPage && explicitPage && urlPage !== explicitPage) {
    throw fail('bili.part.conflict', 'URL 的 p 与 --page 指向不同分 P。', '保留一个一致的分 P 选择后重试。')
  }
  return { bvid, page: explicitPage ?? urlPage ?? null, urlPage }
}

export function resolveBiliPart(viewData, { page = null, cid = null, urlPage = null } = {}) {
  const pages = viewData?.pages
  if (!Array.isArray(pages) || pages.length < 1) {
    throw fail('bili.parts.missing', 'B 站视频没有可验证的分 P 列表。', '刷新视频信息后重试；不要使用顶层 cid 代替分 P。')
  }
  const normalized = pages.map((item, index) => {
    const p = Number(item?.page)
    const partCid = String(item?.cid ?? '').trim()
    if (!Number.isSafeInteger(p) || p < 1 || !partCid) {
      throw fail('bili.parts.invalid', 'B 站分 P 列表缺少有效页码或 cid。', '重新读取视频信息；当前分 P 无法安全处理。')
    }
    const declaredDurationMs = Number(item.duration) * 1000
    return { page: p, cid: partCid, title: String(item.part ?? ''), durationMs: declaredDurationMs, declaredDurationMs, durationSource: 'view.pages', index }
  })
  const selectedPage = positiveInt(page ?? urlPage, '分 P', { optional: true })
  const selectedCid = cid == null || String(cid).trim() === '' ? '' : String(cid).trim()
  let byPage = null
  let byCid = null
  if (selectedPage != null) {
    byPage = normalized.find((item) => item.page === selectedPage) ?? null
    if (!byPage) throw fail('bili.part.out-of-range', `分 P ${selectedPage} 不存在。`, `选择 1 到 ${normalized.length} 之间的页码。`, { pageCount: normalized.length })
  }
  if (selectedCid) {
    byCid = normalized.find((item) => item.cid === selectedCid) ?? null
    if (!byCid) throw fail('bili.part.cid-mismatch', '指定的 cid 不属于这个视频。', '使用该视频 pages 列表中的 cid 后重试。')
  }
  if (byPage && byCid && (byPage.page !== byCid.page || byPage.cid !== byCid.cid)) {
    throw fail('bili.part.conflict', '指定的 page 与 cid 指向不同分 P。', '修正 --page 或 --cid，使两者指向同一分 P。')
  }
  const selected = byPage ?? byCid ?? normalized.find((item) => item.page === 1) ?? null
  if (!selected) throw fail('bili.part.invalid', '无法选出有效分 P。', '检查视频 pages 列表后重试。')
  const durationMs = Number.isFinite(selected.durationMs) && selected.durationMs > 0
    ? Math.round(selected.durationMs)
    : 0
  if (!durationMs) throw fail('bili.duration.missing', '所选分 P 没有可验证的时长。', '刷新视频信息后重试。')
  return {
    bvid: String(viewData.bvid ?? ''),
    aid: String(viewData.aid ?? ''),
    cid: selected.cid,
    page: selected.page,
    pageCount: normalized.length,
    partTitle: selected.title,
    title: String(viewData.title ?? ''),
    durationMs,
    declaredDurationMs: durationMs,
    durationSource: 'view.pages',
    owner: {
      name: String(viewData.owner?.name ?? ''),
      mid: String(viewData.owner?.mid ?? ''),
    },
    tname: String(viewData.tname ?? ''),
    stat: viewData.stat && typeof viewData.stat === 'object' ? viewData.stat : {},
    pic: String(viewData.pic ?? ''),
    desc: String(viewData.desc ?? ''),
    pubdate: Number(viewData.pubdate) || 0,
  }
}

export function normalizeBiliPartTimeline(part, playurl) {
  const declaredDurationMs = Number(part?.declaredDurationMs ?? part?.durationMs)
  if (!Number.isSafeInteger(declaredDurationMs) || declaredDurationMs < 1) throw fail('bili.duration.missing', '所选分 P 没有可验证的声明时长。', '刷新视频信息后重试。')
  const raw = playurl?.timelength
  if (raw === undefined) return { ...part, durationMs: declaredDurationMs, declaredDurationMs, durationSource: 'view.pages' }
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw fail('bili.duration.precise.invalid', '播放信息的精确时长无效。', '刷新播放地址后重试。')
  const preciseDurationMs = Number(raw)
  if (preciseDurationMs !== declaredDurationMs && Math.ceil(preciseDurationMs / 1000) * 1000 !== declaredDurationMs) throw fail('bili.duration.precise.inconsistent', '播放信息与分 P 声明时长不一致。', '刷新视频信息和播放地址后重试。', { declaredDurationMs, preciseDurationMs })
  return { ...part, durationMs: preciseDurationMs, declaredDurationMs, durationSource: 'playurl.timelength' }
}

function credentialCookie(credential) {
  if (!credential?.sessdata || !credential?.bili_jct) {
    throw fail('bili.credentials.missing', 'B 站登录凭据不完整。', '在 SurfCore 设置里重新完成 B 站登录，再重试。')
  }
  return `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 ?? ''}`
}

function getCredential(credentialPath) {
  try { return JSON.parse(fs.readFileSync(credentialPath, 'utf8')) } catch {
    throw fail('bili.credentials.unavailable', '无法读取 B 站登录凭据。', '检查设置页中的 B 站登录状态后重试。')
  }
}

function withTimeout(signal, timeoutMs, code, errorText) {
  const controller = new AbortController()
  let timer = null
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  if (timeoutMs > 0) timer = setTimeout(() => controller.abort(fail(code, errorText, '网络或媒体工具超时；检查连接后重试。')), timeoutMs)
  return {
    signal: controller.signal,
    close() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

function safeApiError(json, endpoint) {
  if (json?.code === 0) return
  const raw = String(json?.message ?? json?.msg ?? 'B 站接口拒绝请求。').slice(0, 180)
  const message = /https?:\/\//i.test(raw) || /SESSDATA|bili_jct|buvid3|auth_key|w_rid/i.test(raw)
    ? '详细错误已隐藏以保护登录信息和媒体访问地址。' : raw
  throw fail('bili.api.failed', `${endpoint} 请求失败（code=${String(json?.code ?? 'unknown')}）：${message}`, '确认视频可访问且账号状态正常后重试。', { apiCode: Number(json?.code) || null })
}

export function createBiliApi({ credentialPath = accountBili('credentials.json'), fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw fail('bili.fetch.unavailable', '当前 Node 环境没有 fetch。', '使用 DSH 支持的 Node 运行时后重试。')
  const credential = getCredential(credentialPath)
  const cookie = credentialCookie(credential)
  const baseHeaders = (bvid = '') => ({
    'user-agent': UA,
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
    cookie,
  })
  async function requestJson(url, { signal, authenticated = true, bvid = '' } = {}) {
    const timeout = withTimeout(signal, timeoutMs, 'bili.request.timeout', 'B 站请求超时。')
    try {
      const response = await fetchImpl(url, {
        headers: authenticated ? baseHeaders(bvid) : { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
        signal: timeout.signal,
      })
      if (!response.ok) throw fail('bili.http.failed', `B 站接口返回 HTTP ${response.status}。`, '检查账号状态和视频访问权限后重试。', { status: response.status })
      let json
      try { json = await response.json() } catch { throw fail('bili.response.invalid', 'B 站接口没有返回有效 JSON。', '稍后重试；如果持续发生，请检查接口状态。') }
      safeApiError(json, 'B 站')
      return json
    } catch (error) {
      if (error instanceof BiliMediaError) throw error
      if (timeout.signal.aborted) throw fail('bili.request.cancelled', 'B 站请求已取消或超时。', '重试前确认当前任务已结束。')
      throw fail('bili.request.failed', 'B 站请求失败。', '检查网络连接后重试。')
    } finally { timeout.close() }
  }
  let mixinKey = ''
  async function getMixinKey(signal) {
    if (mixinKey) return mixinKey
    const nav = await requestJson('https://api.bilibili.com/x/web-interface/nav', { signal })
    const keyOf = (url) => String(url ?? '').slice(String(url ?? '').lastIndexOf('/') + 1, String(url ?? '').lastIndexOf('.'))
    const raw = keyOf(nav.data?.wbi_img?.img_url) + keyOf(nav.data?.wbi_img?.sub_url)
    mixinKey = MIXIN_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32)
    if (mixinKey.length !== 32) throw fail('bili.wbi.unavailable', '无法生成 B 站 WBI 签名。', '重新读取登录状态后重试。')
    return mixinKey
  }
  async function signedUrl(endpoint, params, signal) {
    const mixin = await getMixinKey(signal)
    const wts = Math.round(Date.now() / 1000)
    const clean = (value) => String(value).replace(/[!'()*]/g, '')
    const query = Object.keys({ ...params, wts }).sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(clean(key === 'wts' ? wts : params[key]))}`).join('&')
    const sign = crypto.createHash('md5').update(query + mixin).digest('hex')
    return `https://api.bilibili.com${endpoint}?${query}&w_rid=${sign}`
  }
  return {
    async fetchView(bvid, { signal } = {}) {
      const json = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { signal, bvid })
      if (!json.data || !Array.isArray(json.data.pages)) throw fail('bili.parts.missing', 'B 站视频响应缺少分 P 列表。', '刷新视频信息后重试。')
      return { ...json.data, bvid }
    },
    async fetchPlayurl(part, { signal, qn = 80 } = {}) {
      const url = await signedUrl('/x/player/wbi/playurl', {
        bvid: part.bvid,
        cid: part.cid,
        qn,
        fnval: 4048,
        platform: 'pc',
        high_quality: 1,
      }, signal)
      const json = await requestJson(url, { signal, bvid: part.bvid })
      return json.data ?? {}
    },
    async fetchSubtitle(part, { signal, language = 'ai-zh' } = {}) {
      const url = await signedUrl('/x/player/wbi/v2', { bvid: part.bvid, cid: part.cid }, signal)
      const json = await requestJson(url, { signal, bvid: part.bvid })
      const returnedCid = json?.data?.cid
      if (returnedCid != null && String(returnedCid) !== String(part.cid)) {
        throw fail('bili.subtitle.cid-mismatch', '字幕接口返回的 cid 与所选分 P 不一致。', '本次不使用该字幕；改用共享 ASR。')
      }
      const tracks = Array.isArray(json?.data?.subtitle?.subtitles) ? json.data.subtitle.subtitles : []
      const selected = tracks.find((track) => track.lan === language)
        ?? tracks.find((track) => track.lan === 'zh-CN')
        ?? tracks.find((track) => String(track.lan ?? '').startsWith('zh'))
        ?? tracks[0]
      if (!selected) return { status: 'missing', source: 'platform-subtitle', cid: String(part.cid), segments: [], language: null, aiStatus: json?.data?.subtitle?.ai_status ?? null }
      const signedSubtitleUrl = String(selected.subtitle_url ?? '')
      if (!/^https?:\/\//i.test(signedSubtitleUrl) && !/^\/\//.test(signedSubtitleUrl)) {
        throw fail('bili.subtitle.url-invalid', '字幕轨道没有有效下载地址。', '本次改用共享 ASR。')
      }
      const subtitleUrl = /^https?:\/\//i.test(signedSubtitleUrl) ? signedSubtitleUrl : `https:${signedSubtitleUrl}`
      const timeout = withTimeout(signal, timeoutMs, 'bili.subtitle.timeout', '下载 B 站字幕超时。')
      try {
        const response = await fetchImpl(subtitleUrl, {
          headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${part.bvid}/` },
          signal: timeout.signal,
        })
        if (!response.ok) throw fail('bili.subtitle.download-failed', `下载 B 站字幕失败（HTTP ${response.status}）。`, '字幕链接可能已过期；重新读取字幕后重试。', { status: response.status })
        let data
        try { data = await response.json() } catch { throw fail('bili.subtitle.invalid', '字幕响应不是有效 JSON。', '本次改用共享 ASR。') }
        const body = Array.isArray(data?.body) ? data.body : []
        const segments = body.map((line) => ({
          startMs: Math.max(0, Math.round(Number(line.from) * 1000)),
          endMs: Math.max(0, Math.round(Number(line.to ?? line.from) * 1000)),
          text: String(line.content ?? '').trim(),
        })).filter((line) => Number.isFinite(line.startMs) && Number.isFinite(line.endMs) && line.endMs >= line.startMs && line.text)
        if (!segments.length) return { status: 'missing', source: 'platform-subtitle', cid: String(part.cid), segments: [], language: String(selected.lan ?? ''), aiStatus: json?.data?.subtitle?.ai_status ?? null }
        return {
          status: 'completed',
          source: 'platform-subtitle',
          cid: String(part.cid),
          language: String(selected.lan ?? ''),
          languageLabel: String(selected.lan_doc ?? ''),
          aiStatus: json?.data?.subtitle?.ai_status ?? null,
          segments,
          coverage: {
            requestedRanges: [{ startMs: 0, endMs: part.durationMs }],
            acquiredRanges: [{ startMs: 0, endMs: part.durationMs }],
            processedRanges: [{ startMs: 0, endMs: part.durationMs }],
            missingRanges: [],
            complete: false, // A subtitle track does not prove speech coverage.
          },
        }
      } catch (error) {
        if (error instanceof BiliMediaError) throw error
        if (timeout.signal.aborted) throw fail('bili.subtitle.cancelled', '字幕下载已取消或超时。', '重试前确认当前任务已结束。')
        throw fail('bili.subtitle.download-failed', '下载 B 站字幕失败。', '本次改用共享 ASR。')
      } finally { timeout.close() }
    },
  }
}

function asUrlList(item) {
  return [item?.baseUrl, item?.base_url, item?.url, ...(Array.isArray(item?.backupUrl) ? item.backupUrl : []), ...(Array.isArray(item?.backup_url) ? item.backup_url : [])]
    .filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value))
}

function chooseDashAudio(dash) {
  const rows = Array.isArray(dash?.audio) ? dash.audio : []
  return [...rows].filter((item) => asUrlList(item).length)
    .sort((a, b) => {
      const aAac = /mp4a|aac/i.test(String(a.mimeType ?? a.codecs ?? '')) ? 1 : 0
      const bAac = /mp4a|aac/i.test(String(b.mimeType ?? b.codecs ?? '')) ? 1 : 0
      return bAac - aAac || Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0)
    })[0] ?? null
}

function chooseDashVideo(dash) {
  const rows = Array.isArray(dash?.video) ? dash.video : []
  return [...rows].filter((item) => asUrlList(item).length)
    .sort((a, b) => Number(b.id ?? b.bandwidth ?? 0) - Number(a.id ?? a.bandwidth ?? 0))[0] ?? null
}

function contentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? '').trim())
  return match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) } : null
}

async function downloadOne(urls, destination, { fetchImpl, signal, timeoutMs, expectedBytes = 0, bvid, partTitle = '' } = {}) {
  let lastError = null
  for (const url of urls) {
    const timeout = withTimeout(signal, timeoutMs, 'media.download.timeout', '媒体分段下载超时。')
    const temporary = `${destination}.${crypto.randomUUID()}.part`
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` },
        signal: timeout.signal,
      })
      if (response.status !== 200 && response.status !== 206) {
        throw fail(`media.http-${response.status}`, `媒体分段下载失败（HTTP ${response.status}）。`, '刷新 playurl 后重试；仅处理仍可访问的媒体。', { status: response.status })
      }
      const headerBytes = Number(response.headers.get('content-length'))
      const range = response.status === 206 ? contentRange(response.headers.get('content-range')) : null
      if (response.status === 206 && (!range || range.start !== 0 || range.end < 0 || !range.total || range.end !== range.total - 1)) {
        throw fail('media.range.invalid', '媒体服务器只返回了部分字节范围。', '重新获取完整媒体资源后重试。')
      }
      if (response.status === 206 && Number.isFinite(headerBytes) && range && headerBytes !== range.total) {
        throw fail('media.range.truncated', 'HTTP 206 返回长度与完整资源范围不一致。', '重新获取完整媒体资源后重试。')
      }
      if (!response.body) throw fail('media.body.missing', '媒体响应没有内容。', '刷新播放地址后重试。')
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const hash = createHash('sha256')
      let bytes = 0
      const count = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        callback(null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(temporary, { flags: 'wx' }), { signal: timeout.signal })
      if (headerBytes > 0 && bytes !== headerBytes) {
        throw fail('media.truncated', '媒体实际字节数与 Content-Length 不一致。', '重新获取该媒体分段后重试。', { expectedBytes: headerBytes, actualBytes: bytes })
      }
      if (expectedBytes > 0 && bytes !== expectedBytes) {
        throw fail('media.truncated', '媒体实际字节数与 playurl 分段大小不一致。', '重新获取该媒体分段后重试。', { expectedBytes, actualBytes: bytes })
      }
      if (response.status === 206 && range && bytes !== range.total) {
        throw fail('media.range.truncated', 'HTTP 206 没有覆盖完整媒体资源。', '重新获取完整媒体资源后重试。', { expectedBytes: range.total, actualBytes: bytes })
      }
      fs.renameSync(temporary, destination)
      return { path: destination, bytes, sha256: hash.digest('hex'), contentLength: headerBytes > 0 ? headerBytes : null, source: 'bili-cdn' }
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch {}
      lastError = error instanceof BiliMediaError ? error : timeout.signal.aborted
        ? fail('media.download.cancelled', '媒体下载已取消或超时。', '重试前确认当前任务已结束。')
        : fail('media.download.failed', '媒体分段下载失败。', '检查网络后重新获取播放地址。')
      // A second CDN URL is a same-resource fallback; do not print either signed URL.
      if (timeout.signal.aborted || error?.code === 'media.range.invalid' || error?.code === 'media.range.truncated' || error?.code === 'media.truncated') break
    } finally { timeout.close() }
  }
  throw lastError ?? fail('media.download.failed', `无法下载${partTitle ? `「${partTitle}」` : '媒体'}。`, '刷新播放地址后重试。')
}

async function runTool(executable, args, { signal, timeoutMs = 5 * 60_000, maxStderr = 16_384 } = {}) {
  if (!executable || !path.isAbsolute(executable)) throw fail('media.runtime.missing', '缺少 FFmpeg 或 FFprobe。', '在运行环境中配置可执行的 FFmpeg 与 FFprobe 后重试。')
  if (signal?.aborted) throw fail('media.tool.cancelled', '媒体工具任务已取消。', '重试前确认当前任务已结束。')
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const close = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value) }
    const onAbort = () => { child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL') }, 1500).unref?.() }
    const timer = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { if (stderr.length < maxStderr) stderr += chunk.toString('utf8') })
    child.on('error', () => close(reject, fail('media.tool.start-failed', '媒体工具无法启动。', '检查 FFmpeg/FFprobe 路径和执行权限。')))
    child.on('close', (code, signalName) => {
      if (timedOut) return close(reject, fail('media.tool.timeout', '媒体校验或转换超时。', '缩短任务范围或检查 FFmpeg 后重试。'))
      if (signal?.aborted) return close(reject, fail('media.tool.cancelled', '媒体工具任务已取消。', '当前素材可能不完整；重新运行任务可重建。'))
      if (code !== 0) return close(reject, fail('media.tool.failed', `媒体工具执行失败（exit=${code ?? signalName ?? 'unknown'}）。`, '检查媒体兼容性和 FFmpeg/FFprobe 依赖。'))
      return close(resolve, { stdout, stderr })
    })
  })
}

function runtimePath(kind) {
  const direct = kind === 'ffprobe' ? mediaRuntime.ffprobePath?.() : mediaRuntime.ffmpegPath?.()
  if (direct) return path.resolve(direct)
  if (kind === 'ffprobe') {
    const ffmpeg = mediaRuntime.ffmpegPath?.()
    if (ffmpeg) {
      const candidate = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      if (fs.existsSync(candidate)) return path.resolve(candidate)
    }
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      if (directory && fs.existsSync(candidate)) return path.resolve(candidate)
    }
    return null
  }
  try { return path.resolve(mediaRuntime.requireFfmpeg()) } catch { return null }
}

export async function probeMedia(file, { signal, probeImpl, timeoutMs = 60_000 } = {}) {
  if (typeof probeImpl === 'function') return await probeImpl(file, { signal })
  const executable = runtimePath('ffprobe')
  if (!executable) throw fail('media.ffprobe.unavailable', '找不到 FFprobe，无法验证下载媒体。', '安装或配置 FFprobe 后重新运行；未验证的媒体不会提交给 ASR。')
  const result = await runTool(executable, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { signal, timeoutMs })
  let data
  try { data = JSON.parse(result.stdout) } catch { throw fail('media.probe.invalid', 'FFprobe 没有返回有效媒体信息。', '检查媒体文件是否完整后重试。') }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const duration = Number(data.format?.duration)
  return {
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
    streams: streams.map((stream) => ({ codecType: String(stream.codec_type ?? ''), codec: String(stream.codec_name ?? '') })),
  }
}

export async function verifyMediaDecode(file, { signal, ffmpegPath, timeoutMs = 5 * 60_000, decodeImpl } = {}) {
  if (typeof decodeImpl === 'function') return await decodeImpl(file, { signal })
  const executable = ffmpegPath ?? runtimePath('ffmpeg')
  if (!executable) throw fail('media.ffmpeg.unavailable', '找不到 FFmpeg，无法完整解码校验媒体。', '安装或配置 FFmpeg 后重新运行。')
  await runTool(executable, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { signal, timeoutMs })
  return true
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function sourceRangesToCoverage(sourceDurationMs, entries) {
  const acquired = entries
    .filter((entry) => entry.acquiredMs > 0)
    .map((entry) => ({ startMs: entry.sourceStartMs, endMs: Math.min(sourceDurationMs, entry.sourceStartMs + entry.acquiredMs) }))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const merged = []
  for (const range of acquired) {
    const previous = merged.at(-1)
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs)
    else merged.push({ ...range })
  }
  const missing = []
  let cursor = 0
  for (const range of merged) {
    if (range.startMs > cursor) missing.push({ startMs: cursor, endMs: range.startMs })
    cursor = Math.max(cursor, range.endMs)
  }
  if (cursor < sourceDurationMs) missing.push({ startMs: cursor, endMs: sourceDurationMs })
  return { acquiredRanges: merged, missingRanges: missing, complete: missing.length === 0 }
}

async function concatParts(paths, output, { signal, concatImpl, ffmpegPath, timeoutMs = 5 * 60_000 } = {}) {
  if (paths.length === 1) return paths[0]
  if (typeof concatImpl === 'function') return await concatImpl(paths, output, { signal })
  const executable = ffmpegPath ?? runtimePath('ffmpeg')
  if (!executable) throw fail('media.concat.unavailable', '多段媒体需要 FFmpeg 才能合成。', '安装或配置 FFmpeg 后重新运行。')
  const manifest = `${output}.${crypto.randomUUID()}.ffconcat`
  const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "'\\''")
  try {
    fs.writeFileSync(manifest, `ffconcat version 1.0\n${paths.map((file) => `file '${quote(file)}'`).join('\n')}\n`, { flag: 'wx' })
    try {
      await runTool(executable, ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', manifest, '-c', 'copy', output], { signal, timeoutMs })
    } catch {
      if (signal?.aborted) throw fail('media.concat.cancelled', '多段媒体合成已取消。', '重试前确认当前任务已结束。')
      // Some durl chunks are not stream-copy compatible. Decode/re-encode as a fallback;
      // never byte-concatenate container files.
      const args = ['-nostdin', '-y', '-v', 'error']
      for (const file of paths) args.push('-i', file)
      const labels = paths.map((_, index) => `[${index}:v:0][${index}:a:0]`).join('')
      args.push('-filter_complex', `${labels}concat=n=${paths.length}:v=1:a=1[v][a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', output)
      await runTool(executable, args, { signal, timeoutMs })
    }
    return output
  } finally { try { fs.rmSync(manifest, { force: true }) } catch {} }
}

function resolveRemoteSegments(playurlData, kind, part) {
  const dashItem = kind === 'audio' ? chooseDashAudio(playurlData?.dash) : chooseDashVideo(playurlData?.dash)
  if (dashItem) {
    const urls = asUrlList(dashItem)
    return [{
      strategy: `dash.${kind}`,
      urls,
      order: 1,
      sourceStartMs: 0,
      expectedDurationMs: part.durationMs,
      expectedBytes: 0,
      codec: String(dashItem.codecs ?? dashItem.mimeType ?? ''),
      segmentId: `dash-${kind}`,
    }]
  }
  const durl = Array.isArray(playurlData?.durl) ? [...playurlData.durl] : []
  if (!durl.length) return []
  durl.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
  let sourceStartMs = 0
  const segments = durl.map((item, index) => {
    const expectedDurationMs = Number(item.length)
    const value = {
      strategy: 'durl',
      urls: asUrlList(item),
      order: Number(item.order) || index + 1,
      sourceStartMs,
      expectedDurationMs: Number.isFinite(expectedDurationMs) && expectedDurationMs > 0 ? Math.round(expectedDurationMs) : 0,
      expectedBytes: Number(item.size) > 0 ? Number(item.size) : 0,
      codec: String(item.mimeType ?? ''),
      segmentId: `durl-${Number(item.order) || index + 1}`,
    }
    sourceStartMs += value.expectedDurationMs
    return value
  })
  if (segments.some((segment) => !segment.expectedDurationMs || !segment.urls.length)) {
    throw fail('media.timeline.unknown', 'durl 分段缺少可验证的时长或播放地址。', '不提交无法映射到原视频时间轴的媒体。')
  }
  return segments.map((segment) => ({ ...segment, sourceDurationMs: part.durationMs }))
}

async function acquireKind(kind, segments, part, destinationDir, options) {
  if (!segments.length) return null
  const rows = []
  const usable = []
  for (const segment of segments) {
    if (options.signal?.aborted) throw fail('media.cancelled', '媒体准备已取消。', '重试前确认当前任务已结束。')
    const file = path.join(destinationDir, `${kind}-${String(segment.order).padStart(3, '0')}-${crypto.randomUUID()}.media`)
    try {
      const downloaded = await downloadOne(segment.urls, file, { ...options, bvid: part.bvid, partTitle: part.partTitle, expectedBytes: segment.expectedBytes })
      const probe = await probeMedia(downloaded.path, options)
      const streamExists = kind === 'audio' ? probe.hasAudio : probe.hasVideo
      if (!streamExists) throw fail(kind === 'audio' ? 'media.audio.missing' : 'media.video.missing', `所选媒体分段没有可用${kind === 'audio' ? '音轨' : '视频流'}。`, '刷新播放地址并选择平台提供的可解码媒体。')
      await verifyMediaDecode(downloaded.path, options)
      const actualMs = Number(probe.durationMs)
      if (!Number.isFinite(actualMs) || actualMs <= 0) throw fail('media.duration.invalid', 'FFprobe 无法验证媒体时长。', '不提交未经时长校验的媒体。')
      const expectedMs = segment.expectedDurationMs
      if (actualMs > expectedMs + DURATION_TOLERANCE_MS) throw fail('media.duration.mismatch', '媒体时长明显超过该分段的 playurl 时长。', '刷新播放地址并重新获取该分段。')
      const acquiredMs = Math.min(actualMs, expectedMs)
      const row = {
        path: downloaded.path,
        order: segment.order,
        sourceStartMs: segment.sourceStartMs,
        expectedDurationMs: expectedMs,
        actualDurationMs: actualMs,
        acquiredMs,
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        probe: { hasAudio: probe.hasAudio, hasVideo: probe.hasVideo, durationMs: actualMs },
      }
      rows.push(row)
      usable.push(row)
    } catch (error) {
      try { fs.rmSync(file, { force: true }) } catch {}
      const safe = error instanceof BiliMediaError ? error : fail('media.segment.failed', '媒体分段校验失败。', '该分段未进入处理；稍后重新获取。')
      rows.push({
        order: segment.order,
        sourceStartMs: segment.sourceStartMs,
        expectedDurationMs: segment.expectedDurationMs,
        actualDurationMs: 0,
        acquiredMs: 0,
        bytes: 0,
        sha256: '',
        error: { code: safe.code, error: safe.message, hint: safe.hint },
      })
      if (options.signal?.aborted) throw safe
    }
  }
  if (!usable.length) return { kind, strategy: segments[0].strategy, status: 'failed', segments: rows, path: '', timelineMap: [], ...sourceRangesToCoverage(part.durationMs, rows) }
  const localMap = []
  let localStartMs = 0
  for (const row of usable) {
    localMap.push({
      localStartMs,
      localEndMs: localStartMs + row.acquiredMs,
      sourceStartMs: row.sourceStartMs,
      sourceEndMs: row.sourceStartMs + row.acquiredMs,
    })
    localStartMs += row.acquiredMs
  }
  const output = path.join(destinationDir, `${kind}-joined-${crypto.randomUUID()}.mkv`)
  let mediaPath
  try { mediaPath = await concatParts(usable.map((row) => row.path), output, options) } catch (error) {
    const safe = error instanceof BiliMediaError ? error : fail('media.concat.failed', '多段媒体无法合成。', '分段保留在感知资产目录；检查 FFmpeg 后重试。')
    return { kind, strategy: segments[0].strategy, status: 'partial', segments: rows, path: '', timelineMap: localMap, ...sourceRangesToCoverage(part.durationMs, rows), error: { code: safe.code, error: safe.message, hint: safe.hint } }
  }
  let finalProbe
  try {
    finalProbe = await probeMedia(mediaPath, options)
    if (kind === 'audio' && !finalProbe.hasAudio) throw fail('media.audio.missing', '合并结果没有可用音轨。', '重新获取并校验全部音频分段。')
    if (kind === 'video' && !finalProbe.hasVideo) throw fail('media.video.missing', '合并结果没有可用视频流。', '重新获取并校验全部视频分段。')
    await verifyMediaDecode(mediaPath, options)
  } catch (error) {
    const safe = error instanceof BiliMediaError ? error : fail('media.concat.invalid', '合并媒体无法通过解码校验。', '检查 FFmpeg 兼容性并重新获取媒体。')
    return { kind, strategy: segments[0].strategy, status: 'partial', segments: rows, path: '', timelineMap: localMap, ...sourceRangesToCoverage(part.durationMs, rows), error: { code: safe.code, error: safe.message, hint: safe.hint } }
  }
  const contentSha256 = await sha256File(mediaPath)
  const totalSegmentMs = localMap.at(-1)?.localEndMs ?? 0
  const durationMismatch = Math.abs(Number(finalProbe.durationMs) - totalSegmentMs) > DURATION_TOLERANCE_MS
  const coverage = sourceRangesToCoverage(part.durationMs, rows)
  const rangeCoverage = { ...coverage, complete: coverage.complete && !durationMismatch }
  return {
    kind,
    strategy: segments[0].strategy,
    status: rangeCoverage.complete ? 'completed' : 'partial',
    path: mediaPath,
    contentSha256,
    durationMs: Number(finalProbe.durationMs) || totalSegmentMs,
    sourceDurationMs: part.durationMs,
    timelineMap: localMap,
    segments: rows,
    ...rangeCoverage,
    warnings: durationMismatch ? [{ code: 'media.duration.partial', message: '合并媒体时长与原始分 P 存在差异。' }] : [],
  }
}

export async function prepareBiliMedia({
  part,
  playurl,
  fetchPlayurl,
  dataRoot,
  needAudio = true,
  needVideo = false,
  fetchImpl = globalThis.fetch,
  probeImpl,
  decodeImpl,
  concatImpl,
  ffmpegPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (!part?.bvid || !part?.cid || !Number.isFinite(Number(part.durationMs)) || Number(part.durationMs) <= 0) {
    throw fail('media.part.invalid', '媒体请求缺少已验证的分 P 信息。', '先从 view.pages 解析 BV、cid、page 与时长。')
  }
  if (!dataRoot) throw fail('media.root.missing', '没有配置感知资产目录。', '确认 SurfCore Host 的数据目录已就绪。')
  const playurlData = playurl ?? await fetchPlayurl?.(part, { signal })
  if (!playurlData || typeof playurlData !== 'object') throw fail('media.playurl.missing', '没有取得 B 站媒体播放信息。', '刷新视频播放信息后重试。')
  part = normalizeBiliPartTimeline(part, playurlData)
  const destinationDir = path.join(dataRoot, 'bili', `${part.bvid}-${part.cid}-${crypto.randomUUID()}`)
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 })
  const options = { fetchImpl, probeImpl, decodeImpl, concatImpl, ffmpegPath, timeoutMs, signal }
  const audioDash = needAudio ? chooseDashAudio(playurlData.dash) : null
  const videoDash = needVideo ? chooseDashVideo(playurlData.dash) : null
  const durlSegments = Array.isArray(playurlData.durl) && playurlData.durl.length
    ? resolveRemoteSegments({ durl: playurlData.durl }, 'video', part)
    : []
  let audio = null
  let video = null
  if (audioDash) {
    audio = await acquireKind('audio', resolveRemoteSegments({ dash: { audio: [audioDash] } }, 'audio', part), part, destinationDir, options)
  } else if (needAudio && durlSegments.length) {
    audio = await acquireKind('audio', durlSegments, part, destinationDir, options)
  }
  if (needVideo && videoDash) {
    video = await acquireKind('video', resolveRemoteSegments({ dash: { video: [videoDash] } }, 'video', part), part, destinationDir, options)
  } else if (needVideo && durlSegments.length) {
    // If durl is the audio fallback, this re-downloads it as video; reuse the existing
    // acquired rows where possible so one debrief does not download the same segments twice.
    if (audio?.strategy === 'durl' && audio.path && audio.segments?.every((row) => row.probe?.hasVideo)) {
      video = { ...audio, kind: 'video' }
    } else if (audio?.strategy === 'durl' && audio.path) {
      video = {
        kind: 'video', strategy: 'durl', status: 'failed', path: '', segments: audio.segments ?? [],
        timelineMap: audio.timelineMap ?? [], acquiredRanges: [], missingRanges: [{ startMs: 0, endMs: part.durationMs }], complete: false,
        error: { code: 'media.video.missing', error: 'durl 媒体没有可用视频流。', hint: '使用有视频流的播放表示后重试。' },
      }
    }
    else video = await acquireKind('video', durlSegments, part, destinationDir, options)
  }
  return {
    bvid: part.bvid,
    aid: String(part.aid ?? ''),
    cid: String(part.cid),
    page: Number(part.page),
    pageCount: Number(part.pageCount) || 1,
    durationMs: Number(part.durationMs),
    destinationDir,
    audio,
    video,
    status: needAudio && (!audio || audio.status === 'failed') || needVideo && (!video || video.status === 'failed') ? 'failed'
      : [audio, video].filter(Boolean).some((item) => item.status === 'partial') ? 'partial' : 'completed',
    warnings: [audio?.error, video?.error].filter(Boolean),
  }
}

export async function createFrameSheet({
  mediaPath,
  timelineMap,
  sourceDurationMs,
  bvid,
  page,
  outputDir,
  grid = '3x3',
  uniform = false,
  subtitleEvery = null,
  sceneDetector,
  keepMedia = false,
  ffmpegPath,
  probeImpl,
  signal,
} = {}) {
  if (!mediaPath) throw fail('media.video.unavailable', '没有可用的视频素材用于抽帧。', '检查视频下载状态后重试；字幕或 ASR 可独立保留。')
  const match = /^(\d{1,2})x(\d{1,2})$/i.exec(String(grid))
  if (!match) throw fail('media.grid.invalid', '九宫格参数格式无效。', '使用 3x3 或 4x4 这样的列 x 行格式。')
  const cols = Number(match[1]), rows = Number(match[2]), count = cols * rows
  if (count < 1 || count > 64) throw fail('media.grid.invalid', '抽帧格子数必须在 1 到 64 之间。', '减少 --grid 的行列数后重试。')
  const ffmpeg = ffmpegPath ?? runtimePath('ffmpeg')
  if (!ffmpeg) throw fail('media.ffmpeg.unavailable', '找不到 FFmpeg，无法抽取画面。', '安装或配置 FFmpeg；字幕和 ASR 状态不受影响。')
  const probe = await probeMedia(mediaPath, { signal, probeImpl })
  if (!probe.hasVideo || !probe.durationMs) throw fail('media.video.invalid', '所选素材没有可验证的视频流。', '重新取得所选分 P 的视频素材。')
  const duration = Number(sourceDurationMs) || probe.durationMs
  const ranges = Array.isArray(timelineMap) && timelineMap.length
    ? timelineMap
    : [{ localStartMs: 0, localEndMs: probe.durationMs, sourceStartMs: 0, sourceEndMs: Math.min(duration, probe.durationMs) }]
  const targetTimes = Array.from({ length: count }, (_, index) => Math.round(((index + 0.5) * duration) / count))
  const mapTarget = (sourceMs) => {
    const range = ranges.find((item) => sourceMs >= item.sourceStartMs && sourceMs < item.sourceEndMs)
    if (!range) return null
    return Number(range.localStartMs) + (sourceMs - Number(range.sourceStartMs))
  }
  let selected = targetTimes.map((sourceMs) => ({ sourceMs, localMs: mapTarget(sourceMs) })).filter((item) => item.localMs != null)
  if (!selected.length) throw fail('media.frames.coverage-empty', '已取得的视频范围没有覆盖抽帧采样点。', '补齐视频分段后重试抽帧。')
  if (!uniform) {
    let scenes = []
    for (const threshold of [0.3, 0.15, 0.08]) {
      try {
        const output = sceneDetector ? await sceneDetector(mediaPath, threshold, { signal }) : (await runTool(ffmpeg, ['-nostdin', '-hide_banner', '-i', mediaPath, '-vf', `select='gt(scene,${threshold})',metadata=print:file=-`, '-an', '-f', 'null', '-'], { signal })).stdout
        const localTimes = Array.isArray(output) ? output : [...output.matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1]) * 1000)
        scenes = localTimes.map(localMs => { const range = ranges.find(r => localMs >= r.localStartMs && localMs < r.localEndMs); return range ? Number(range.sourceStartMs) + localMs - Number(range.localStartMs) : null }).filter(x => x != null && x > 200)
        if (scenes.length >= count) break
      } catch (error) { if (signal?.aborted) throw error }
    }
    const half = duration / count / 2
    selected = selected.map(item => {
      const nearby = scenes.filter(time => Math.abs(time - item.sourceMs) <= half && mapTarget(time) != null)
      if (!nearby.length) return { ...item, snapped: false }
      const sourceMs = nearby.reduce((a, b) => Math.abs(b - item.sourceMs) < Math.abs(a - item.sourceMs) ? b : a)
      return { sourceMs, localMs: mapTarget(sourceMs), snapped: true }
    })
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(outputDir, { recursive: true })
  const safePage = Number.isInteger(Number(page)) && Number(page) > 0 ? `-p${Number(page)}` : ''
  const base = `${bvid}${safePage}-${stamp}`
  const framesDir = path.join(outputDir, `.frames-${base}`)
  const sheet = path.join(outputDir, `${base}-${cols}x${rows}.jpg`)
  const strips = path.join(outputDir, `${base}-subs.jpg`)
  fs.mkdirSync(framesDir, { recursive: true })
  fs.writeFileSync(path.join(framesDir, '.lease.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  let stripError = null
  try {
    for (const [index, item] of selected.entries()) {
      if (signal?.aborted) throw fail('media.frames.cancelled', '抽帧任务已取消。', '重试前确认当前任务已结束。')
      await runTool(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-ss', (item.localMs / 1000).toFixed(3), '-i', mediaPath,
        '-frames:v', '1', path.join(framesDir, `f${String(index).padStart(2, '0')}.jpg`)], { signal, timeoutMs: 90_000 })
    }
    const missingCount = count - selected.length
    const finalGrid = missingCount ? `1x${selected.length}` : `${cols}x${rows}`
    await runTool(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', path.join(framesDir, 'f%02d.jpg'), '-vf', `scale=480:-1,tile=${finalGrid}`, '-frames:v', '1', sheet], { signal, timeoutMs: 90_000 })
    if (!fs.existsSync(sheet)) throw fail('media.frames.output-missing', '九宫格图片没有生成。', '检查 FFmpeg 执行结果后重试。')
    try {
      let stripCount = selected.length
      let stripInput = path.join(framesDir, 'f%02d.jpg')
      if (subtitleEvery != null) {
        const everyMs = Number(subtitleEvery) * 1000
        if (!Number.isFinite(everyMs) || everyMs < 1000) throw fail('media.substrip.invalid', '字幕条采样间隔无效。', '使用至少 1 秒的 --substrip 间隔。')
        const times = Array.from({ length: Math.max(1, Math.min(20, Math.ceil(duration / everyMs))) }, (_, i) => i * everyMs)
          .map(sourceMs => ({ sourceMs, localMs: mapTarget(sourceMs) })).filter(item => item.localMs != null)
        if (!times.length) throw fail('media.substrip.coverage-empty', '已取得的视频没有覆盖字幕条采样点。', '补齐视频后重试。')
        for (const [index, item] of times.entries()) {
          await runTool(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-ss', (item.localMs / 1000).toFixed(3), '-i', mediaPath, '-frames:v', '1', path.join(framesDir, `s${String(index).padStart(2, '0')}.jpg`)], { signal, timeoutMs: 90_000 })
        }
        stripCount = times.length
        stripInput = path.join(framesDir, 's%02d.jpg')
      }
      await runTool(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-i', stripInput, '-vf', `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${stripCount}`, '-frames:v', '1', strips], { signal, timeoutMs: 90_000 })
    } catch (error) {
      try { fs.rmSync(strips, { force: true }) } catch {}
      if (subtitleEvery != null) stripError = structuredError(error, 'media.substrip.failed')
    }
  } finally { try { fs.rmSync(framesDir, { recursive: true, force: true }) } catch {} }
  const result = {
    status: selected.length === count && !stripError ? 'completed' : 'partial',
    ...(stripError ? { stripError } : {}),
    source: 'video-frames',
    sheet,
    subtitleStrip: fs.existsSync(strips) ? strips : '',
    samples: selected.map((item, index) => ({ index: index + 1, sourceTimeMs: item.sourceMs, localTimeMs: Math.round(item.localMs), snapped: item.snapped === true })),
    missingSamples: count - selected.length,
  }
  // Caller owns source lifetime; never delete a source merely because it shares an output directory.
  return result
}

export function structuredError(error, fallback = 'bili.command.failed') {
  if (error instanceof BiliMediaError) return error.toJSON()
  const code = String(error?.code ?? fallback)
  const message = String(error?.message ?? '处理失败。').slice(0, 240)
  // Never forward raw tool/fetch messages: they may contain media query tokens or paths.
  if (/https?:\/\//i.test(message) || /SESSDATA|bili_jct|buvid3|cookie|auth_key|w_rid/i.test(message)) {
    return { code, error: '处理失败，详细错误已隐藏以保护登录信息和媒体访问地址。', hint: '检查任务状态后重试。' }
  }
  return {
    code,
    error: message,
    hint: /https?:\/\//i.test(String(error?.hint ?? '')) || /cookie|SESSDATA|bili_jct|buvid3|auth_key|w_rid|token=/i.test(String(error?.hint ?? ''))
      ? '检查任务参数与依赖状态后重试.'
      : String(error?.hint ?? '检查任务参数与依赖状态后重试。').slice(0, 300),
  }
}

export const biliMediaConstants = Object.freeze({ durationToleranceMs: DURATION_TOLERANCE_MS })
