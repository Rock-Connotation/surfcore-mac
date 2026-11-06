// Bili acquisition belongs to the Host; recognition remains in the shared ASR service.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createBiliApi, createFrameSheet, normalizeBiliPartTimeline, parseBiliReference, prepareBiliMedia, resolveBiliPart, structuredError } from '../tools/lib/bili-media.mjs'
import { buildBiliTranscriptionRequest } from '../tools/lib/perception-client.mjs'
import { shotsPath } from '../tools/lib/shots-cache.mjs'
import { appendWatch } from '../tools/lib/watch-history.mjs'
import { config } from '../tools/lib/config.mjs'

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted'])
function problem(code, message, hint) { return Object.assign(new Error(message), { code, hint }) }
function publicJob(job) { return JSON.parse(JSON.stringify(job)) }
function publicJobSummary(job) {
  const out = {}
  for (const key of ['jobId', 'state', 'stage', 'characterId', 'characterEpoch', 'activityId', 'createdAt', 'updatedAt', 'progress', 'part', 'frames', 'coverage', 'memoryState', 'memoryError', 'history', 'code', 'error', 'hint', 'warnings']) if (job[key] !== undefined) out[key] = job[key]
  return publicJob(out)
}
function redact(value) { let text = String(value ?? ''), owner = {}; try { owner = config().owner ?? {} } catch {} for (const [item, minimum, label] of [[owner.name, 2, '「主人昵称·已打码」'], [owner.mid, 4, '「主人mid·已打码」']]) if (String(item ?? '').length >= minimum) text = text.split(String(item)).join(label); return text }
function safeResult(value) { if (!value || typeof value !== 'object') return null; const result = publicJob(value); if (result.provenance) delete result.provenance.sourceUrl; if (Array.isArray(result.segments)) result.segments = result.segments.map(item => ({ ...item, text: redact(item.text) })); return result }
export function createBiliPerceptionService({ asrService, stateDir, getCharacter, onExperience, createApi = createBiliApi, prepareMedia = prepareBiliMedia, makeFrames = createFrameSheet, pollMs = 1000 } = {}) {
  if (!asrService || !path.isAbsolute(String(stateDir ?? '')) || typeof getCharacter !== 'function') throw problem('bili.host.invalid', 'B 站感知服务配置无效。', '检查 Host 服务及角色配置。')
  const directory = path.join(stateDir, 'perception', 'bili-jobs'), assetsRoot = path.join(stateDir, 'perception', 'assets')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const jobs = new Map(), controllers = new Map(), runners = new Map()
  let disposed = false, mediaBusy = false
  const pendingMedia = []
  function save(job) {
    const target = path.join(directory, `${job.jobId}.json`), temp = `${target}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, target)
  }
  for (const name of fs.readdirSync(directory)) {
    if (!/^bili-[0-9a-f-]+\.json$/.test(name)) continue
    try { const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); if (name !== `${job.jobId}.json`) continue; if (['queued', 'running'].includes(job.state)) { job.state = 'interrupted'; job.error = { code: 'bili.job.interrupted', error: 'Host 重启中断了媒体作业。', hint: '确认当前角色后恢复作业。' }; save(job) } jobs.set(job.jobId, job) } catch { /* preserve unreadable records */ }
  }
  function current(job) { const role = getCharacter(); return Boolean(role && String(role.id) === job.characterId && Number(role.epoch) === job.characterEpoch) }
  function update(job, patch) { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); save(job) }
  function recordHistory(job) {
    if (job.request.recordHistory === false || !current(job) || !job.part || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(job.characterId)) return { status: 'skipped' }
    const result = appendWatch({ at: new Date().toISOString(), observationId: job.activityId, bvid: job.part.bvid, cid: job.part.cid, page: job.part.page, pageCount: job.part.pageCount, title: job.part.title, duration: job.part.durationMs / 1000, mode: 'full', source: 'debrief', frames: !!job.frames?.sheet, frameStatus: job.frames?.status ?? 'skipped', sheet: job.frames?.sheet ?? '', jobId: job.jobId, transcriptId: job.result?.transcriptId ?? '', speechStatus: job.request.asr ? job.state : 'none', speechSource: job.request.asr ? 'asr' : 'none', speechState: job.result?.speechState ?? 'unknown', coverage: job.coverage, error: job.error }, { file: path.join(stateDir, 'characters', job.characterId, 'bili', 'watch-history.jsonl') })
    return { status: result.ok ? 'recorded' : result.reason === 'duplicate' ? 'duplicate' : 'failed' }
  }
  async function projectExperience(job) {
    if (job.request.recordExperience === false || job.request.recordHistory === false) { update(job, { memoryState: 'skipped', memoryError: null }); return }
    if (!current(job)) { update(job, { memoryState: 'failed', memoryError: { code: 'STALE_CHARACTER', error: '角色已切换，未写入经历。', hint: '切回原角色和 epoch 后重试。' } }); return }
    const hasSpeech = Boolean(job.result && (job.coverage?.processedRanges?.length || job.result.coverage?.processedRanges?.length))
    const hasFrames = ['completed', 'partial'].includes(job.frames?.status) && Boolean(job.frames?.sheet)
    if (!hasSpeech && !hasFrames) { update(job, { memoryState: 'skipped' }); return }
    const ranges = job.coverage?.processedRanges ?? job.result?.coverage?.processedRanges ?? []
    const event = { schemaVersion: 1, eventId: `bili-observation:${job.jobId}`, characterId: job.characterId, characterEpoch: job.characterEpoch, activityId: job.activityId, occurredAt: job.completedAt, observedAt: job.completedAt, source: { channel: 'bili', objectId: `${job.part.bvid}:cid:${job.part.cid}` }, kind: 'content_observed', visibility: { classification: 'restricted', allowedContexts: ['bili'], legacyScope: 'bili' }, content: { summary: `取得 B 站 ${job.part.bvid} P${job.part.page} 的${hasSpeech ? `语音转写（${job.coverage?.complete ? '处理范围完整' : '处理范围部分'}）` : ''}${hasSpeech && hasFrames ? '和' : ''}${hasFrames ? `画面采样（${job.frames.status}）` : ''}。`, title: job.part.title }, attribution: { subject: 'external', certainty: 'observed' }, evidenceRefs: ranges.slice(0, 16).map(range => ({ assetId: `bili:${job.part.bvid}:p${job.part.page}:${job.part.cid}`, startMs: range.startMs, endMs: range.endMs })) }
    update(job, { memoryState: 'pending', memoryError: null })
    try {
      if (typeof onExperience !== 'function') throw problem('EXPERIENCE_SERVICE_UNAVAILABLE', '经历服务尚未接入。', '启动 Host 记忆维护服务后重试经历投影。')
      const result = await onExperience(event)
      if (result?.ok !== true) throw problem(result?.code ?? 'EXPERIENCE_FAILED', result?.error ?? '经历写入失败。', result?.hint ?? '检查记忆维护状态后重试。')
      update(job, { memoryState: 'completed', memoryError: null })
    } catch (error) { update(job, { memoryState: 'failed', memoryError: structuredError(error, 'EXPERIENCE_FAILED') }) }
  }
  async function finish(job) {
    const history = recordHistory(job)
    update(job, { completedAt: job.completedAt ?? new Date().toISOString(), history })
    if (history.status === 'failed') { update(job, { memoryState: 'failed', memoryError: { code: 'bili.history.failed', error: '观看历史未能保存，经历尚未投影。', hint: '检查角色目录后重试经历保存。' } }); return }
    await projectExperience(job)
  }
  async function run(job, releaseMedia) {
    const controller = new AbortController(); controllers.set(job.jobId, controller)
    try {
      if (job.state === 'cancelled') return
      if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '切回原角色并确认 epoch 后再恢复。')
      update(job, { state: 'running', progress: { stage: 'view' }, error: null })
      const api = createApi(), view = await api.fetchView(job.request.bvid, { signal: controller.signal })
      const part = resolveBiliPart(view, { page: job.request.page, cid: job.request.cid })
      if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '切回原角色并确认 epoch 后再恢复。')
      const playurl = await api.fetchPlayurl(part, { signal: controller.signal })
      const precisePart = normalizeBiliPartTimeline(part, playurl)
      update(job, { part: { bvid: precisePart.bvid, cid: precisePart.cid, page: precisePart.page, pageCount: precisePart.pageCount, durationMs: precisePart.durationMs, declaredDurationMs: precisePart.declaredDurationMs, durationSource: precisePart.durationSource, title: redact(precisePart.title) }, progress: { stage: 'acquire' } })
      const media = await prepareMedia({ part: precisePart, playurl, dataRoot: assetsRoot, needAudio: job.request.asr, needVideo: job.request.frames, signal: controller.signal })
      if (controller.signal.aborted) throw problem('bili.job.cancelled', '作业已取消。', '如需处理，请恢复或重新提交。')
      if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '切回原角色并确认 epoch 后再恢复。')
      let frames = { status: 'skipped' }, frameError = null
      if (job.request.frames) {
        try { if (!media.video?.path || media.video.status === 'failed') throw problem('media.video.unavailable', '没有可用于抽帧的视频。', '检查播放权限和媒体依赖。'); frames = await makeFrames({ mediaPath: media.video.path, timelineMap: media.video.timelineMap, sourceDurationMs: precisePart.durationMs, bvid: precisePart.bvid, page: precisePart.page, outputDir: shotsPath('video'), grid: job.request.grid, uniform: job.request.uniform, subtitleEvery: job.request.subtitleEvery, signal: controller.signal }) }
        catch (error) { frameError = structuredError(error); frames = { status: 'failed', ...frameError } }
      }
      if (controller.signal.aborted) throw problem('bili.job.cancelled', '作业已取消。', '如需处理，请恢复或重新提交。')
      if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '切回原角色并确认 epoch 后再恢复。')
      update(job, { frames, progress: { stage: job.request.asr ? 'submit-asr' : 'frames' } })
      releaseMedia()
      if (!job.request.asr) { update(job, { state: frameError ? 'failed' : frames.status === 'partial' ? 'partial' : 'completed', error: frameError, memoryState: 'pending', progress: { stage: 'finished' } }); await finish(job); return }
      if (!media.audio?.path || media.audio.status === 'failed') throw problem('media.audio.unavailable', '没有可用音轨。', '检查播放权限与媒体依赖后恢复。')
      const request = buildBiliTranscriptionRequest({ part: precisePart, media: media.audio, character: { id: job.characterId, epoch: job.characterEpoch }, activityId: job.activityId, languageHint: job.request.languageHint, assetsRoot })
      if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '切回原角色并确认 epoch 后再恢复。')
      const child = await asrService.submit(request)
      update(job, { childJobId: child.jobId, progress: { stage: 'asr' } })
      if (controller.signal.aborted) { await asrService.cancel(child.jobId); throw problem('bili.job.cancelled', '作业已取消。', '如需处理，请恢复或重新提交。') }
      while (!controller.signal.aborted) {
        const result = await asrService.getJob(child.jobId)
        if (controller.signal.aborted) { await asrService.cancel(child.jobId); throw problem('bili.job.cancelled', '作业已取消。', '如需处理，请恢复或重新提交。') }
        if (terminal.has(result.state)) {
          if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已切换。', '原作业结果保留在共享服务中，不写入当前角色。')
          const state = result.state === 'completed' && frameError ? 'partial' : result.state
          update(job, { state, result: safeResult(result.result), coverage: result.coverage ?? result.result?.coverage ?? null, error: result.error ?? frameError, memoryState: 'pending', progress: { stage: 'finished' } }); await finish(job); return
        }
        await new Promise(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }; const timer = setTimeout(done, pollMs); timer.unref?.(); controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done() })
      }
      await asrService.cancel(child.jobId)
      throw problem('bili.job.cancelled', '作业已取消。', '如需处理，请恢复或重新提交。')
    } catch (error) {
      const cancelled = controller.signal.aborted || error.code === 'bili.job.cancelled'
      const stopped = disposed && cancelled
      update(job, { state: stopped ? 'interrupted' : cancelled ? 'cancelled' : error.code === 'STALE_CHARACTER' ? 'interrupted' : 'failed', error: stopped ? { code: 'bili.host.stopped', error: 'Host 已停止。', hint: '重新启动 Host 后恢复作业。' } : structuredError(error), progress: { stage: 'finished' } })
    } finally { releaseMedia(); controllers.delete(job.jobId) }
  }
  function pumpMedia() {
    if (disposed || mediaBusy) return
    const entry = pendingMedia.shift()
    if (!entry) return
    mediaBusy = true
    let released = false
    const release = () => { if (released) return; released = true; mediaBusy = false; pumpMedia() }
    void run(entry.job, release).catch(() => {}).finally(() => { runners.delete(entry.job.jobId); entry.resolve() })
  }
  function start(job) {
    let resolve
    const promise = new Promise(done => { resolve = done })
    runners.set(job.jobId, promise)
    pendingMedia.push({ job, resolve })
    queueMicrotask(pumpMedia)
  }
  const service = {
    ready: asrService.ready ?? Promise.resolve(),
    submit: (...args) => asrService.submit(...args),
    async submitBili(input) {
      if (disposed) throw problem('bili.host.stopped', 'Host 已停止。', '重新启动 Host 后提交作业。')
      const parsed = parseBiliReference(input?.bvid, { page: input?.page })
      const role = getCharacter(), characterId = String(input?.characterId ?? ''), characterEpoch = Number(input?.characterEpoch), activityId = String(input?.activityId ?? '')
      if (!role || role.id !== characterId || Number(role.epoch) !== characterEpoch) throw problem('STALE_CHARACTER', '提交时角色已改变。', '确认当前角色后重新提交。')
      if (!activityId || !/^[a-zA-Z0-9_-]{1,80}$/.test(activityId)) throw problem('bili.activity.invalid', '活动标识无效。', '重新发起视频活动。')
      const cid = input?.cid == null || input.cid === '' ? '' : String(input.cid)
      if (cid && !/^\d{1,24}$/.test(cid)) throw problem('bili.cid.invalid', 'cid 格式无效。', '使用视频分 P 的数字 cid。')
      const recordHistory = input?.recordHistory !== false, recordExperience = recordHistory && input?.recordExperience !== false
      const asr = input?.asr === true, frames = input?.frames === true
      if (!asr && !frames) throw problem('bili.job.empty', '作业没有需要处理的材料。', '选择转写或抽帧。')
      const grid = String(input.grid ?? '3x3'), dimensions = /^(\d{1,2})x(\d{1,2})$/i.exec(grid); if (!dimensions || Number(dimensions[1]) * Number(dimensions[2]) < 1 || Number(dimensions[1]) * Number(dimensions[2]) > 64) throw problem('media.grid.invalid', '网格格式无效。', '使用最多 64 格的 3x3 或 4x4。')
      if (input.subtitleEvery != null && (!Number.isFinite(Number(input.subtitleEvery)) || Number(input.subtitleEvery) < 1)) throw problem('media.substrip.invalid', '字幕条间隔无效。', '使用至少 1 秒的间隔。')
      if (!['auto', 'zh'].includes(String(input.languageHint ?? 'auto'))) throw problem('bili.language.invalid', '语音语言参数无效。', '使用 auto 或 zh。')
      const job = { jobId: `bili-${crypto.randomUUID()}`, state: 'queued', characterId, characterEpoch, activityId, request: { bvid: parsed.bvid, page: parsed.page, cid, asr, frames, recordHistory, recordExperience, grid, uniform: input.uniform === true, subtitleEvery: input.subtitleEvery == null ? null : Number(input.subtitleEvery), languageHint: String(input.languageHint ?? 'auto') }, createdAt: new Date().toISOString(), progress: { stage: 'queued' } }
      jobs.set(job.jobId, job); save(job); start(job); return { jobId: job.jobId }
    },
    async getJob(id) { if (!jobs.has(id)) return await asrService.getJob(id); return publicJob(jobs.get(id)) },
    async listJobs(options = {}) {
      const limit = Number.isSafeInteger(options.limit) ? Math.min(500, Math.max(1, options.limit)) : 100
      const own = [...jobs.values()].filter(j => (!options.characterId || j.characterId === options.characterId) && (!options.state || j.state === options.state))
      // The ASR service sorts by time, so request active states separately: an old
      // running child must not disappear behind hundreds of completed jobs.
      const query = { ...options, limit: 500 }
      const batches = options.state ? [await asrService.listJobs(query)] : await Promise.all([asrService.listJobs(query), asrService.listJobs({ ...query, state: 'queued' }), asrService.listJobs({ ...query, state: 'running' })])
      const unique = new Map()
      for (const job of [...own, ...batches.flat()]) if (job?.jobId && !unique.has(job.jobId)) unique.set(job.jobId, job)
      const active = job => ['queued', 'running'].includes(job.state) ? 1 : 0
      return [...unique.values()].sort((a, b) => active(b) - active(a) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.jobId).localeCompare(String(b.jobId))).slice(0, limit).map(publicJobSummary)
    },
    async cancel(id) {
      if (!jobs.has(id)) return await asrService.cancel(id)
      const job = jobs.get(id)
      if (terminal.has(job.state)) return publicJob(job)
      const queuedIndex = pendingMedia.findIndex(entry => entry.job.jobId === id)
      if (queuedIndex >= 0) {
        const [entry] = pendingMedia.splice(queuedIndex, 1)
        update(job, { state: 'cancelled', error: { code: 'bili.job.cancelled', error: '作业已取消。', hint: '如需处理，请恢复或重新提交。' }, progress: { stage: 'finished' } })
        runners.delete(id); entry.resolve(); return publicJob(job)
      }
      const runner = runners.get(id)
      controllers.get(id)?.abort()
      if (runner) await runner
      return publicJob(job)
    },
    async resume(id) { if (!jobs.has(id)) return await asrService.resume(id); const job = jobs.get(id); if (!current(job)) throw problem('STALE_CHARACTER', '作业所属角色已改变。', '确认原角色及 epoch 后再恢复。'); if (controllers.has(id)) throw problem('bili.job.resume-invalid', '作业仍在收尾。', '等待作业收尾后重试。'); if (terminal.has(job.state) && ['failed', 'pending'].includes(job.memoryState)) { await finish(job); return { jobId: id, memoryState: job.memoryState } } if (!['interrupted', 'failed', 'cancelled', 'partial'].includes(job.state) || controllers.has(id)) throw problem('bili.job.resume-invalid', '该作业当前不能恢复。', '先查询作业状态。'); update(job, { state: 'queued', childJobId: null, error: null, progress: { stage: 'queued' } }); start(job); return { jobId: id } },
    listModels: (...args) => asrService.listModels(...args), doctor: (...args) => asrService.doctor(...args), getStatus: (...args) => asrService.getStatus(...args), async configure(...args) { if ([...jobs.values()].some(job => ['queued', 'running'].includes(job.state))) throw problem('ASR_CONFIG_BUSY', 'B 站媒体作业正在运行，不能更改 ASR 配置。', '等待作业完成或取消后重试。'); return await asrService.configure(...args) },
    async dispose() { disposed = true; for (const entry of pendingMedia.splice(0)) { update(entry.job, { state: 'interrupted', error: { code: 'bili.host.stopped', error: 'Host 已停止。', hint: '重新启动 Host 后恢复作业。' } }); runners.delete(entry.job.jobId); entry.resolve() } for (const controller of controllers.values()) controller.abort(); await Promise.allSettled([...runners.values()]); await asrService.dispose() },
  }
  return service
}
