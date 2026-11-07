import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertManagedAsset } from '../tools/lib/perception-client.mjs';
import { downloadDouyinMedia, DOUYIN_MEDIA_LIMITS, extractDouyinAudio, extractDouyinFrames, probeDouyinMedia, validateDouyinMediaUrl, validateDouyinMediaUserAgent } from './douyin-media.mjs';

const TERMINAL_ASR = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

function problem(code, error, hint) {
  return { ok: false, code, error, hint };
}

function asError(code, error, hint) {
  return Object.assign(new Error(error), { code, hint });
}

function failFrom(error) {
  const message = typeof error?.error === 'string' ? error.error : error?.message;
  if (error?.code?.startsWith('DOUYIN_') && typeof message === 'string' && typeof error.hint === 'string') {
    return problem(error.code, message, error.hint);
  }
  return problem('DOUYIN_PERCEPTION_FAILED', '本地视频感知未完成。', '检查本机媒体依赖与当前角色后重试。');
}

function roleIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id ?? value.characterId ?? '');
  const epoch = Number(value.epoch ?? value.characterEpoch);
  return /^[A-Za-z0-9_-]{1,256}$/.test(id) && Number.isSafeInteger(epoch) && epoch >= 0 ? { id, epoch } : null;
}

function validContext(context) {
  return !!context && typeof context === 'object'
    && /^[A-Za-z0-9_-]{1,256}$/.test(String(context.characterId ?? ''))
    && Number.isSafeInteger(context.characterEpoch) && context.characterEpoch >= 0;
}

function validId(value) {
  const id = String(value ?? '');
  return /^[0-9]{1,32}$/.test(id) && !/^0+$/.test(id) ? id : '';
}

function validateItem(item) {
  const id = validId(item?.id);
  if (!id || String(item?.url ?? '') !== `https://www.douyin.com/video/${id}`) {
    throw asError('DOUYIN_MEDIA_ITEM_INVALID', '这条内容不是有效的抖音首页推荐。', '从固定首页推荐重新选择视频。');
  }
  const declaredDurationMs = item.durationMs;
  if (!Number.isSafeInteger(declaredDurationMs) || declaredDurationMs <= 0) {
    throw asError('DOUYIN_MEDIA_DURATION_UNKNOWN', '首页推荐没有可用的视频时长。', '跳过这条视频并选择时长明确的首页推荐。');
  }
  if (declaredDurationMs > DOUYIN_MEDIA_LIMITS.maxDurationMs) {
    throw asError('DOUYIN_MEDIA_DURATION_TOO_LONG', '视频超过 120 秒本地处理上限。', '跳过这条视频并选择更短的首页推荐。');
  }
  let mediaSource;
  try { mediaSource = validateDouyinMediaUrl(item.mediaSource); }
  catch (error) {
    if (error?.code === 'DOUYIN_MEDIA_URL_INVALID') throw asError('DOUYIN_MEDIA_SOURCE_MISSING', '首页推荐没有可用的视频播放地址。', '刷新固定首页推荐后重试。');
    throw error;
  }
  const mediaUserAgent = validateDouyinMediaUserAgent(item.mediaUserAgent);
  return { id, url: `https://www.douyin.com/video/${id}`, title: typeof item.title === 'string' ? item.title.slice(0, 2000) : '', declaredDurationMs, mediaSource, mediaUserAgent };
}

function ensureTransientDirectory(stateDirectory) {
  const root = path.resolve(stateDirectory);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe state directory');
  let cursor = root;
  for (const segment of ['perception', 'assets', 'douyin-transient']) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
    }
  }
  try { fs.chmodSync(cursor, 0o700); } catch {}
  return cursor;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(asError('DOUYIN_PERCEPTION_CANCELLED', '本轮视频感知已取消。', '确认当前角色后重新读取这条推荐。')); return; }
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(asError('DOUYIN_PERCEPTION_CANCELLED', '本轮视频感知已取消。', '确认当前角色后重新读取这条推荐。'));
    timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function normalizedRanges(value) {
  if (!Array.isArray(value)) return [];
  return value.map(range => ({ startMs: Number(range?.startMs), endMs: Number(range?.endMs) }))
    .filter(range => Number.isSafeInteger(range.startMs) && Number.isSafeInteger(range.endMs) && range.startMs >= 0 && range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function subtractRanges(requested, processed) {
  let remaining = requested.map(range => ({ ...range }));
  for (const cover of processed) {
    const next = [];
    for (const range of remaining) {
      if (cover.endMs <= range.startMs || cover.startMs >= range.endMs) { next.push(range); continue; }
      if (cover.startMs > range.startMs) next.push({ startMs: range.startMs, endMs: cover.startMs });
      if (cover.endMs < range.endMs) next.push({ startMs: cover.endMs, endMs: range.endMs });
    }
    remaining = next;
  }
  return remaining;
}

function transcriptResult(job, sourceDurationMs, audioCoveredEndMs, audioComplete) {
  const source = job?.result && typeof job.result === 'object' ? job.result : {};
  const rawCoverage = job?.coverage && typeof job.coverage === 'object'
    ? job.coverage
    : source.coverage && typeof source.coverage === 'object' ? source.coverage : {};
  const requestedRanges = normalizedRanges(rawCoverage.requestedRanges);
  const requested = requestedRanges.length ? requestedRanges : [{ startMs: 0, endMs: sourceDurationMs }];
  const processedRanges = normalizedRanges(rawCoverage.processedRanges);
  let missingRanges = normalizedRanges(rawCoverage.missingRanges);
  if (!missingRanges.length) missingRanges = subtractRanges(requested, processedRanges);
  if (!audioComplete && audioCoveredEndMs < sourceDurationMs && !missingRanges.some(range => range.startMs <= audioCoveredEndMs && range.endMs >= sourceDurationMs)) {
    missingRanges.push({ startMs: audioCoveredEndMs, endMs: sourceDurationMs });
    missingRanges = normalizedRanges(missingRanges);
  }
  const complete = job?.state === 'completed' && rawCoverage.complete === true
    && missingRanges.length === 0 && audioComplete && audioCoveredEndMs >= sourceDurationMs;
  const segments = Array.isArray(source.segments) ? source.segments : [];
  const text = typeof source.text === 'string'
    ? source.text
    : segments.map(segment => String(segment?.text ?? '').trim()).filter(Boolean).join('\n');
  const speechState = ['speech', 'no_speech', 'unknown'].includes(source.speechState) ? source.speechState : 'unknown';
  return { text, coverage: { complete, requestedRanges: requested, processedRanges, missingRanges }, speechState };
}

export function createDouyinPerception({
  stateDir,
  asrService,
  getCharacter,
  ffmpegPath,
  ffprobePath,
  downloadMedia = downloadDouyinMedia,
  runProcessImpl,
  pollMs = 500,
  asrTimeoutMs = 35 * 60_000,
  now = Date.now,
} = {}) {
  const baseDirectory = path.isAbsolute(String(stateDir ?? '')) ? String(stateDir) : '';
  const configured = !!baseDirectory && !!asrService
    && typeof asrService.submit === 'function' && typeof asrService.getJob === 'function' && typeof asrService.cancel === 'function'
    && typeof getCharacter === 'function'
    && path.isAbsolute(String(ffmpegPath ?? '')) && path.isAbsolute(String(ffprobePath ?? ''));
  const assetsRoot = baseDirectory ? path.join(baseDirectory, 'perception', 'assets') : '';

  async function perceive(item, context, { signal, activityId } = {}) {
    if (!configured) return problem('DOUYIN_PERCEPTION_UNAVAILABLE', '本地视频感知服务配置无效。', '检查 Host、ASR 服务和 FFmpeg/FFprobe 路径。');
    if (!validContext(context) || !/^[A-Za-z0-9_-]{1,80}$/.test(String(activityId ?? ''))) {
      return problem('DOUYIN_PERCEPTION_CONTEXT_INVALID', '本轮视频感知缺少有效角色或活动归属。', '从当前角色重新发起视频活动。');
    }
    let selected;
    try { selected = validateItem(item); }
    catch (error) { return failFrom(error); }
    let workDirectory = null, preserveWorkDirectory = false, asrJobId = null, asrTerminal = false, cancellationPromise = null, outcome = null;
    const staleFailure = () => asError('DOUYIN_PERCEPTION_STALE', '角色已切换，本轮视频结果已丢弃。', '切回当前角色后重新读取这条首页推荐。');
    const checkCurrent = () => {
      let current;
      try { current = roleIdentity(getCharacter()); } catch {}
      if (!current || current.id !== context.characterId || current.epoch !== context.characterEpoch) throw staleFailure();
      if (signal?.aborted) throw asError('DOUYIN_PERCEPTION_CANCELLED', '本轮视频感知已取消。', '确认当前角色后重新读取这条推荐。');
    };
    const cancelOwnedAsr = async () => {
      if (!asrJobId || asrTerminal) return null;
      if (!cancellationPromise) cancellationPromise = (async () => {
        let state;
        try { state = await asrService.cancel(asrJobId); }
        catch { throw asError('DOUYIN_ASR_CANCEL_FAILED', '本地 ASR 作业取消未确认。', '查询本地 ASR 作业并确认已停止后，再清理 douyin-transient 中保留的本轮音轨；确认前不要删除。'); }
        const deadline = Date.now() + 30_000;
        while (!TERMINAL_ASR.has(String(state?.state ?? ''))) {
          if (Date.now() >= deadline) throw asError('DOUYIN_ASR_CANCEL_UNCONFIRMED', '本地 ASR 作业仍未确认停止。', '查询本地 ASR 作业并确认已停止后，再清理 douyin-transient 中保留的本轮音轨；确认前不要删除。');
          await sleep(Math.min(Math.max(25, pollMs), 500));
          try { state = await asrService.getJob(asrJobId); }
          catch { throw asError('DOUYIN_ASR_CANCEL_UNCONFIRMED', '本地 ASR 作业仍未确认停止。', '查询本地 ASR 作业并确认已停止后，再清理 douyin-transient 中保留的本轮音轨；确认前不要删除。'); }
        }
        asrTerminal = true;
        return state;
      })();
      try { return await cancellationPromise; } catch (error) { return error; }
    };

    try {
      checkCurrent();
      const root = ensureTransientDirectory(baseDirectory);
      workDirectory = path.join(root, `round-${randomUUID()}`);
      fs.mkdirSync(workDirectory, { mode: 0o700 });
      const videoPath = path.join(workDirectory, 'source.mp4');
      const audioPath = path.join(workDirectory, 'audio.wav');
      await downloadMedia(selected.mediaSource, videoPath, { signal, userAgent: selected.mediaUserAgent });
      let videoStat;
      try { videoStat = fs.lstatSync(videoPath); } catch { throw asError('DOUYIN_MEDIA_DOWNLOAD_FAILED', '本地视频文件没有通过完整性检查。', '重新读取这条首页推荐。'); }
      if (!videoStat.isFile() || videoStat.isSymbolicLink() || videoStat.size < 1) throw asError('DOUYIN_MEDIA_DOWNLOAD_FAILED', '本地视频文件没有通过完整性检查。', '重新读取这条首页推荐。');
      try { fs.chmodSync(videoPath, 0o600); } catch { throw asError('DOUYIN_MEDIA_PERMISSION_FAILED', '无法保护本地视频临时文件权限。', '检查本地感知资产目录权限后重试。'); }
      checkCurrent();
      const mediaInfo = await probeDouyinMedia(videoPath, ffprobePath, { signal, ...(runProcessImpl ? { runProcessImpl } : {}) });
      checkCurrent();
      if (mediaInfo.videoDurationMsExact > DOUYIN_MEDIA_LIMITS.maxDurationMs) {
        throw asError('DOUYIN_MEDIA_DURATION_TOO_LONG', '视频实际时长超过 120 秒本地处理上限。', '跳过这条视频并选择更短的首页推荐。');
      }
      if (mediaInfo.videoDurationMs < 1) throw asError('DOUYIN_MEDIA_DURATION_UNKNOWN', '无法确认视频的实际播放时长。', '跳过这条视频并选择时长明确的首页推荐。');

      const frameResult = await extractDouyinFrames({
        mediaPath: videoPath,
        outputDir: workDirectory,
        ffmpegPath,
        ffprobePath,
        mediaInfo,
        signal,
        ...(runProcessImpl ? { runProcessImpl } : {}),
      });
      checkCurrent();
      const audio = await extractDouyinAudio({
        mediaPath: videoPath,
        outputPath: audioPath,
        ffmpegPath,
        ffprobePath,
        mediaInfo,
        signal,
        ...(runProcessImpl ? { runProcessImpl } : {}),
      });
      checkCurrent();
      const localAudioPath = assertManagedAsset(audio.path, assetsRoot);
      const requestedRanges = [{ startMs: 0, endMs: mediaInfo.videoDurationMs }];
      const acquiredRanges = audio.acquiredEndMs > 0 ? [{ startMs: 0, endMs: audio.acquiredEndMs }] : [];
      const request = {
        characterId: context.characterId,
        characterEpoch: context.characterEpoch,
        activityId: String(activityId),
        asset: {
          assetId: `douyin:${selected.id}:${audio.contentSha256}`,
          contentSha256: audio.contentSha256,
          localPath: localAudioPath,
          durationMs: audio.durationMs,
          sourceDurationMs: mediaInfo.videoDurationMs,
          acquiredRanges,
          timelineMap: acquiredRanges.length ? [{ localStartMs: 0, localEndMs: audio.acquiredEndMs, sourceStartMs: 0, sourceEndMs: audio.acquiredEndMs }] : [],
        },
        provenance: { channel: 'douyin', sourceId: selected.id, acquiredAtMs: now() },
        source: { channel: 'douyin', objectId: selected.id },
        visibility: { classification: 'restricted', allowedContexts: ['douyin'], legacyScope: 'douyin' },
        requestedRanges,
        languageHint: 'auto',
      };
      checkCurrent();
      const submitted = await asrService.submit(request);
      asrJobId = String(submitted?.jobId ?? '');
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(asrJobId)) {
        asrJobId = '';
        throw asError('DOUYIN_ASR_SUBMIT_FAILED', '本地 ASR 没有返回有效作业编号。', '检查本地 ASR 状态后再决定是否重试，避免重复提交。');
      }
      checkCurrent();
      const deadline = Date.now() + asrTimeoutMs;
      let child;
      while (true) {
        checkCurrent();
        if (Date.now() >= deadline) throw asError('DOUYIN_ASR_TIMEOUT', '本地语音识别超过时间限制。', '查询现有 ASR 作业状态，确认结束后再重试。');
        child = await asrService.getJob(asrJobId);
        checkCurrent();
        const state = String(child?.state ?? '');
        if (TERMINAL_ASR.has(state)) { asrTerminal = true; break; }
        if (!['queued', 'running'].includes(state)) throw asError('DOUYIN_ASR_STATE_INVALID', '本地 ASR 返回了无法识别的作业状态。', '查询本地 ASR 作业状态后重试。');
        await sleep(Math.min(Math.max(25, pollMs), 2_000), signal);
      }
      if (!['completed', 'partial'].includes(String(child?.state ?? '')) || !child?.result || typeof child.result !== 'object') {
        throw asError('DOUYIN_ASR_FAILED', '本地语音识别未能完成。', '查看本地 ASR 状态，修复后重新读取这条推荐。');
      }
      checkCurrent();
      const transcript = transcriptResult(child, mediaInfo.videoDurationMs, audio.acquiredEndMs, audio.acquiredEndMs >= mediaInfo.videoDurationMs);
      const warnings = [...frameResult.warnings];
      if (!transcript.coverage.complete) warnings.push({
        code: 'DOUYIN_AUDIO_PARTIAL',
        error: '音轨或 ASR 结果未覆盖视频全长，转写范围保持部分覆盖。',
        hint: '模型只应依据已处理范围回答，缺失范围不能按完整视频解释。',
      });
      const title = typeof selected.title === 'string' ? selected.title : '';
      outcome = {
        ok: true,
        id: selected.id,
        url: selected.url,
        title,
        durationMs: mediaInfo.videoDurationMs,
        observedAt: new Date(now()).toISOString(),
        source: 'homepage-recommendation',
        transcript,
        frames: frameResult.frames.slice(0, 3),
        visualCoverage: 'sparse',
        warnings,
      };
    } catch (error) {
      const safe = failFrom(error);
      if (asrJobId && !asrTerminal) {
        const cancellation = await cancelOwnedAsr();
        if (cancellation instanceof Error) {
          preserveWorkDirectory = true;
          outcome = problem(cancellation.code, cancellation.message, cancellation.hint);
        } else {
          outcome = safe;
        }
      } else {
        outcome = safe;
      }
    } finally {
      if (workDirectory && !preserveWorkDirectory) {
        try {
          fs.rmSync(workDirectory, { recursive: true, force: true });
          if (fs.existsSync(workDirectory)) throw new Error('temporary media remains');
        } catch {
          outcome = problem('DOUYIN_MEDIA_CLEANUP_FAILED', '本轮媒体临时文件未能清理。', '先停止本轮处理并检查本地感知资产目录，再重新读取。');
        }
      }
    }
    return outcome ?? problem('DOUYIN_PERCEPTION_FAILED', '本地视频感知未完成。', '检查本机媒体依赖与当前角色后重试。');
  }

  return { perceive };
}
