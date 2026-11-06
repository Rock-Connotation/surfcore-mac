import fs from 'node:fs'
import path from 'node:path'
import { BiliMediaError } from './bili-media.mjs'
import { config } from './config.mjs'

const JOB_STATES = new Set(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])

function fail(code, error, hint) {
  return new BiliMediaError(code, error, hint)
}

function loopbackBaseUrl(value) {
  let url
  try { url = new URL(String(value ?? '')) } catch {
    throw fail('perception.discovery.invalid', 'Host 感知服务发现文件无效。', '检查 SurfCore Host 是否已启动并重新创建服务发现文件。')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw fail('perception.discovery.invalid', 'Host 感知服务必须使用受保护的本机地址。', '检查 Host 的 perception/host.json；不要配置远端服务地址。')
  }
  return url.toString().replace(/\/$/, '')
}

function readDiscovery(file) {
  let discovery
  try { discovery = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    throw fail('perception.discovery.missing', '找不到 Host 感知服务发现文件。', '启动 SurfCore Host 并检查 state/perception/host.json。')
  }
  const baseUrl = loopbackBaseUrl(discovery.baseUrl)
  const api = String(discovery.api ?? '')
  const token = String(discovery.token ?? '')
  if (api !== '/dsh-surfcore/perception-api' || !token || token.length > 512) {
    throw fail('perception.discovery.invalid', 'Host 感知服务发现文件缺少有效 API 或令牌。', '重新启动 SurfCore Host 后重试。')
  }
  return { version: String(discovery.version ?? ''), baseUrl, api, token }
}

function safeHostError(payload, status) {
  const code = String(payload?.code ?? `perception.http-${status}`)
  const error = String(payload?.error ?? `Host 感知服务返回 HTTP ${status}。`).slice(0, 240)
  let hint = String(payload?.hint ?? '检查 Host 感知服务状态后重试。').slice(0, 300)
  if (/https?:\/\/|x-perception-token|token=|cookie|SESSDATA|bili_jct|auth_key|w_rid/i.test(hint)) hint = '检查服务状态后重试。'
  if (/https?:\/\//i.test(error) || /x-perception-token|token=|cookie|SESSDATA|bili_jct|auth_key|w_rid/i.test(error)) {
    return fail(code, 'Host 感知服务失败，详细内容已隐藏以保护访问凭据。', '检查服务状态后重试。')
  }
  return fail(code, error, hint)
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw fail('perception.response.invalid', 'Host 感知服务没有返回作业信息。', '查询作业状态后重试。')
  const state = String(job.state ?? job.status ?? '')
  if (state && !JOB_STATES.has(state)) throw fail('perception.response.invalid', 'Host 感知服务返回了未知作业状态。', '检查 Host 版本后重试。')
  return { ...job, ...(state ? { state } : {}) }
}

export function assertManagedAsset(localPath, assetsRoot) {
  let root
  let target
  try {
    root = fs.realpathSync(assetsRoot)
    target = fs.realpathSync(localPath)
  } catch {
    throw fail('perception.asset.unavailable', 'ASR 素材文件不可读取。', '重新获取所选 B 站分 P 的音轨后重试。')
  }
  const relative = path.relative(root, target)
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail('perception.asset.outside-managed-root', 'ASR 素材必须位于 Host 管理的感知资产目录内。', '重新准备 B 站媒体到 state/perception/assets 后重试。')
  }
  let stat
  try { stat = fs.statSync(target) } catch {}
  if (!stat?.isFile() || stat.size < 1) throw fail('perception.asset.invalid', 'ASR 素材不是有效的本地文件。', '重新获取并校验所选分 P 的音轨。')
  return target
}

export function buildBiliTranscriptionRequest({ part, media, character, activityId, languageHint = 'auto', acquiredAtMs = Date.now(), assetsRoot } = {}) {
  if (!part?.bvid || !part?.cid || !character?.id || !Number.isFinite(Number(character.epoch)) || !activityId) {
    throw fail('perception.request.invalid', '转写任务缺少分 P 或角色归属信息。', '重新运行命令；角色 ID、epoch 与 activityId 必须在提交前冻结。')
  }
  if (!media?.path || !/^[a-f0-9]{64}$/i.test(String(media.contentSha256 ?? ''))) {
    throw fail('perception.asset.invalid', '转写任务缺少经过摘要校验的媒体文件。', '重新获取所选分 P 的音轨。')
  }
  const localPath = assertManagedAsset(media.path, assetsRoot)
  const requestedRanges = [{ startMs: 0, endMs: Number(part.durationMs) }]
  return {
    characterId: String(character.id),
    characterEpoch: Number(character.epoch),
    activityId: String(activityId),
    asset: {
      assetId: `bili:${part.bvid}:p${Number(part.page)}:${part.cid}:${media.contentSha256}`,
      contentSha256: String(media.contentSha256).toLowerCase(),
      localPath,
      durationMs: Math.round(Number(media.durationMs) || Number(part.durationMs)),
      sourceDurationMs: Math.round(Number(part.durationMs)),
      acquiredRanges: Array.isArray(media.acquiredRanges) ? media.acquiredRanges.map((range) => ({ startMs: Number(range.startMs), endMs: Number(range.endMs) })) : [],
      timelineMap: Array.isArray(media.timelineMap) ? media.timelineMap.map((item) => ({
        localStartMs: Number(item.localStartMs),
        localEndMs: Number(item.localEndMs),
        sourceStartMs: Number(item.sourceStartMs),
        sourceEndMs: Number(item.sourceEndMs),
      })) : [],
    },
    provenance: {
      channel: 'bili',
      sourceId: String(part.bvid),
      sourceUrl: `https://www.bilibili.com/video/${part.bvid}?p=${Number(part.page)}`,
      partId: String(part.cid),
      acquiredAtMs: Math.round(Number(acquiredAtMs)),
    },
    source: { channel: 'bili', objectId: String(part.bvid) },
    visibility: { classification: 'public', allowedContexts: ['bili'], legacyScope: 'bili' },
    requestedRanges,
    languageHint: String(languageHint || 'auto'),
  }
}

export function createPerceptionClient({ stateDir, discoveryFile, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw fail('perception.fetch.unavailable', '当前 Node 环境没有 fetch。', '使用 DSH 支持的 Node 运行时后重试。')
  const file = discoveryFile ?? path.join(stateDir ?? '', 'perception', 'host.json')
  if (!path.isAbsolute(file)) throw fail('perception.discovery.path-invalid', 'Host 感知服务发现路径无效。', '检查 SurfCore Host 数据目录。')

  async function request({ method = 'GET', query = '', body = null, signal } = {}) {
    const discovery = readDiscovery(file)
    const controller = new AbortController()
    let timer
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetchImpl(`${discovery.baseUrl}${discovery.api}${query}`, {
        method,
        headers: {
          'x-perception-token': discovery.token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      let payload
      try { payload = await response.json() } catch { throw fail('perception.response.invalid', 'Host 感知服务返回的内容不是有效 JSON。', '检查 Host 版本和服务状态后重试。') }
      if (!response.ok || payload?.ok === false) throw safeHostError(payload, response.status)
      return payload
    } catch (error) {
      if (error instanceof BiliMediaError) throw error
      if (controller.signal.aborted) throw fail('perception.request.timeout', 'Host 感知服务请求超时或已取消。', '查询现有 jobId 后再决定是否重试，避免重复提交。')
      throw fail('perception.host.unavailable', '无法连接本机 Host 感知服务。', '启动 SurfCore Host 并确认 perception/host.json 后重试。')
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    async status({ signal } = {}) { return await request({ signal }) },
    async listJobs({ signal } = {}) {
      const payload = await request({ signal })
      return Array.isArray(payload.jobs) ? payload.jobs : []
    },
    async getJob(jobId, { signal } = {}) {
      const id = encodeURIComponent(String(jobId ?? '').trim())
      if (!id) throw fail('perception.job-id.missing', '缺少转写 jobId。', '传入 `transcribe --status <jobId>` 后重试。')
      const payload = await request({ query: `?jobId=${id}`, signal })
      return validateJob(payload.job)
    },
    async submit(transcriptionRequest, { signal } = {}) {
      const payload = await request({ method: 'POST', body: { action: 'submit', request: transcriptionRequest }, signal })
      const jobId = String(payload.jobId ?? payload.job?.jobId ?? '').trim()
      if (!jobId) throw fail('perception.submit.invalid', 'Host 感知服务没有返回 jobId。', '检查 Host 服务状态；不要直接重复提交。')
      return { jobId }
    },
    async submitBili(biliRequest, { signal } = {}) {
      const payload = await request({ method: 'POST', body: { action: 'submit-bili', request: biliRequest }, signal })
      const jobId = String(payload.jobId ?? payload.job?.jobId ?? '').trim()
      if (!jobId) throw fail('perception.submit.invalid', 'Host 没有返回 B 站作业 ID。', '先查询作业列表，避免重复提交。')
      return { jobId }
    },
    async cancel(jobId, { signal } = {}) {
      const id = String(jobId ?? '').trim()
      if (!id) throw fail('perception.job-id.missing', '缺少转写 jobId。', '传入要取消的 jobId 后重试。')
      return await request({ method: 'POST', body: { action: 'cancel', jobId: id }, signal })
    },
    async resume(jobId, { signal } = {}) {
      const id = String(jobId ?? '').trim()
      if (!id) throw fail('perception.job-id.missing', '缺少转写 jobId。', '传入要恢复的 jobId 后重试。')
      return await request({ method: 'POST', body: { action: 'resume', jobId: id }, signal })
    },
  }
}

export function normalizeTranscriptionResult(job) {
  let owner = {}; try { owner = config().owner ?? {} } catch {}
  const clean = value => { let text = String(value ?? ''); for (const [secret, minimum, label] of [[owner.name, 2, '「主人昵称·已打码」'], [owner.mid, 4, '「主人mid·已打码」']]) if (String(secret ?? '').length >= minimum) text = text.split(String(secret)).join(label); return text }
  const value = validateJob(job)
  if (!value.result || typeof value.result !== 'object') return null
  const result = value.result
  const segments = Array.isArray(result.segments) ? result.segments.map((segment) => ({
    startMs: Math.max(0, Math.round(Number(segment.startMs) || 0)),
    endMs: Math.max(0, Math.round(Number(segment.endMs) || 0)),
    text: clean(segment.text).trim(),
  })).filter((segment) => segment.endMs >= segment.startMs && segment.text) : []
  const coverage = result.coverage && typeof result.coverage === 'object' ? result.coverage : {}
  const ranges = (items) => Array.isArray(items) ? items.map((range) => ({
    startMs: Math.max(0, Math.round(Number(range.startMs) || 0)),
    endMs: Math.max(0, Math.round(Number(range.endMs) || 0)),
  })).filter((range) => range.endMs > range.startMs) : []
  return {
    transcriptId: String(result.transcriptId ?? ''),
    jobId: String(value.jobId ?? result.jobId ?? ''),
    state: String(value.state ?? ''),
    characterId: String(result.characterId ?? value.characterId ?? ''),
    characterEpoch: Number(result.characterEpoch ?? value.characterEpoch) || 0,
    language: result.language == null ? null : String(result.language),
    speechState: ['speech', 'no_speech', 'unknown'].includes(result.speechState) ? result.speechState : 'unknown',
    engine: result.engine && typeof result.engine === 'object' ? {
      provider: String(result.engine.provider ?? ''),
      runtimeVersion: String(result.engine.runtimeVersion ?? ''),
      modelId: String(result.engine.modelId ?? ''),
      modelDigest: String(result.engine.modelDigest ?? ''),
    } : null,
    segments,
    coverage: {
      requestedRanges: ranges(coverage.requestedRanges),
      acquiredRanges: ranges(coverage.acquiredRanges),
      processedRanges: ranges(coverage.processedRanges),
      missingRanges: ranges(coverage.missingRanges),
      complete: coverage.complete === true && value.state === 'completed',
    },
    warnings: Array.isArray(result.warnings) ? result.warnings.map((warning) => ({ code: String(warning.code ?? 'warning'), message: String(warning.message ?? '').slice(0, 240) })) : [],
  }
}
