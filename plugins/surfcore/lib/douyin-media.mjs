import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { runProcess } from '../../../src/perception/process.js';
import { measurePcm16 } from '../../../src/perception/media.js';

const ALLOWED_HOST_SUFFIXES = Object.freeze([
  'douyinvod.com',
]);

const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const blockedAddresses = new BlockList();

for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(range, prefix, 'ipv4');

for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockedAddresses.addSubnet(range, prefix, 'ipv6');

function problem(code, error, hint) {
  return Object.assign(new Error(error), { code, hint });
}

function cancelled() {
  return problem('DOUYIN_MEDIA_CANCELLED', '媒体读取已取消。', '确认当前角色后重新读取这条推荐。');
}

function isPublicAddress(address) {
  const value = String(address ?? '').split('%')[0];
  const family = isIP(value);
  if (family === 0) return false;
  if (family === 6 && /^::ffff:(?:[0-9.]+|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i.test(value)) return false;
  return !blockedAddresses.check(value, family === 4 ? 'ipv4' : 'ipv6');
}

export function validateDouyinMediaUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); }
  catch { throw problem('DOUYIN_MEDIA_URL_INVALID', '首页推荐没有有效的视频地址。', '刷新当前首页推荐后重试。'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowedCdn = ALLOWED_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
  const allowedSignedRedirect = hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/play/';
  if (url.protocol !== 'https:' || (!allowedCdn && !allowedSignedRedirect) || url.username || url.password || url.port || url.hash || !url.pathname.startsWith('/')) {
    throw problem('DOUYIN_MEDIA_URL_REJECTED', '视频地址不属于允许的抖音 HTTPS 媒体 CDN。', '返回固定首页推荐重新读取；不要改用其它来源。');
  }
  url.hostname = hostname;
  return url.toString();
}

async function resolvePublicAddresses(hostname, lookupImpl, signal) {
  if (signal?.aborted) throw cancelled();
  const lookup = Promise.resolve().then(() => lookupImpl(hostname, { all: true, verbatim: true }));
  // Observe rejections even when abort wins and the DNS lookup settles later.
  lookup.catch(() => {});
  let addresses;
  let onAbort;
  try {
    const aborted = signal ? new Promise((_, reject) => {
      onAbort = () => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }) : null;
    addresses = await (aborted ? Promise.race([lookup, aborted]) : lookup);
  } catch {
    if (signal?.aborted) throw cancelled();
    throw problem('DOUYIN_MEDIA_DNS_FAILED', '视频 CDN 地址解析失败。', '检查网络后重新读取这条首页推荐。');
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw cancelled();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(record => !isPublicAddress(record?.address))) {
    throw problem('DOUYIN_MEDIA_DNS_REJECTED', '视频 CDN 解析到了非公网地址，已阻止连接。', '重新读取首页推荐；若问题持续，请检查本机 DNS 设置。');
  }
  return addresses.map(record => ({ address: record.address, family: record.family ?? isIP(record.address) }));
}

function requestPinned(url, addresses, { requestImpl, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    let settled = false;
    let req;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => { try { req?.destroy(); } catch {} finish(reject, cancelled()); };
    const pinnedLookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    try {
      req = requestImpl(url, {
        method: 'GET',
        lookup: pinnedLookup,
        headers: { 'user-agent': 'SurfCore local media observer', accept: 'video/*,application/octet-stream' },
      }, response => finish(resolve, { req, response }));
    } catch {
      finish(reject, problem('DOUYIN_MEDIA_REQUEST_FAILED', '无法连接视频 CDN。', '检查网络后重新读取这条首页推荐。'));
      return;
    }
    req.once('error', () => finish(reject, signal?.aborted ? cancelled() : problem('DOUYIN_MEDIA_REQUEST_FAILED', '视频 CDN 请求失败。', '检查网络后重新读取这条首页推荐。')));
    if (typeof req.setTimeout === 'function') req.setTimeout(timeoutMs, () => req.destroy());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try { req.end(); } catch { finish(reject, problem('DOUYIN_MEDIA_REQUEST_FAILED', '视频 CDN 请求失败。', '检查网络后重新读取这条首页推荐。')); }
  });
}

function contentLength(response) {
  const value = response.headers?.['content-length'];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function parseExactDuration(stream) {
  const ticks = /^\d+$/.exec(String(stream?.duration_ts ?? ''));
  const timebase = /^(\d+)\/(\d+)$/.exec(String(stream?.time_base ?? ''));
  if (ticks && timebase && BigInt(timebase[2]) > 0n) {
    const denominator = BigInt(timebase[2]);
    const numerator = BigInt(ticks[0]) * BigInt(timebase[1]) * 1000n;
    return numerator > 0n ? { numerator, denominator } : null;
  }
  const decimal = /^(\d+)(?:\.(\d+))?$/.exec(String(stream?.duration ?? ''));
  if (!decimal) return null;
  const fraction = decimal[2] ?? '';
  const denominator = 10n ** BigInt(fraction.length);
  const whole = BigInt(decimal[1]) * denominator + BigInt(fraction || '0');
  const numerator = whole * 1000n;
  return numerator > 0n ? { numerator, denominator } : null;
}

function ceilDurationMs(duration) {
  return Number((duration.numerator + duration.denominator - 1n) / duration.denominator);
}

function floorDurationMs(duration) {
  return Number(duration.numerator / duration.denominator);
}

function durationMsNumber(duration) {
  return Number(duration.numerator) / Number(duration.denominator);
}

function parseProbe(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw problem('DOUYIN_MEDIA_PROBE_FAILED', '无法读取本地媒体时长。', '跳过这条视频并检查本机 FFprobe。'); }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find(stream => stream?.codec_type === 'video');
  const audio = streams.find(stream => stream?.codec_type === 'audio');
  const videoDuration = parseExactDuration(video);
  const audioDuration = parseExactDuration(audio);
  if (!video || !videoDuration || !audio || !audioDuration) {
    throw problem('DOUYIN_MEDIA_DURATION_UNKNOWN', '视频或音轨的实际时长无法确认。', '跳过这条视频；不要用首页显示时长替代媒体探测结果。');
  }
  return {
    videoStream: Number.isInteger(video.index) ? video.index : 0,
    audioStream: Number.isInteger(audio.index) ? audio.index : 0,
    videoDuration,
    audioDuration,
    videoDurationMs: ceilDurationMs(videoDuration),
    audioDurationMs: ceilDurationMs(audioDuration),
    videoDurationMsExact: durationMsNumber(videoDuration),
    audioDurationMsExact: durationMsNumber(audioDuration),
  };
}

async function probeStreams(mediaPath, ffprobePath, { signal, runProcessImpl = runProcess, stage = 'probe' } = {}) {
  let result;
  try {
    result = await runProcessImpl(ffprobePath, [
      '-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,duration,duration_ts,time_base,width,height', '-of', 'json', mediaPath,
    ], { signal, timeoutMs: 30_000, outputLimit: 2 * 1024 * 1024, stage });
  } catch (error) {
    if (signal?.aborted || error?.code === 'ASR_CANCELLED') throw cancelled();
    throw problem('DOUYIN_MEDIA_PROBE_FAILED', '无法探测本地媒体。', '检查本机 FFprobe 后重试这条首页推荐。');
  }
  if (result?.code !== 0) throw problem('DOUYIN_MEDIA_PROBE_FAILED', 'FFprobe 未能读取本地媒体。', '跳过这条视频并检查本机 FFprobe。');
  return result.stdout;
}

export async function probeDouyinMedia(mediaPath, ffprobePath, options = {}) {
  return parseProbe(await probeStreams(mediaPath, ffprobePath, options));
}

async function exactWavDurationMs(file, ffprobePath, { signal, runProcessImpl = runProcess } = {}) {
  const stdout = await probeStreams(file, ffprobePath, { signal, runProcessImpl, stage: 'probe-audio' });
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', '无法读取提取后音轨的实际时长。', '检查 FFprobe 后重试这条首页推荐。'); }
  const audio = Array.isArray(parsed?.streams) ? parsed.streams.find(stream => stream?.codec_type === 'audio') : null;
  const audioDuration = parseExactDuration(audio);
  if (!audio || !audioDuration) throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', '无法读取提取后音轨的实际时长。', '检查 FFprobe 后重试这条首页推荐。');
  const measured = measurePcm16(file);
  if (!Number.isFinite(measured.durationMs) || measured.durationMs <= 0) {
    throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', '本地音轨解码结果无效。', '检查 FFmpeg 安装后重试这条首页推荐。');
  }
  return audioDuration;
}

export async function extractDouyinAudio({ mediaPath, outputPath, ffmpegPath, ffprobePath, mediaInfo, signal, runProcessImpl = runProcess } = {}) {
  const seconds = (durationMsNumber(mediaInfo.videoDuration) / 1000).toPrecision(15);
  let result;
  try {
    result = await runProcessImpl(ffmpegPath, [
      '-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', mediaPath,
      '-map', `0:${mediaInfo.audioStream}`, '-vn', '-t', seconds,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', outputPath,
    ], { signal, timeoutMs: 90_000, outputLimit: 64 * 1024, stage: 'extract-audio' });
  } catch (error) {
    if (signal?.aborted || error?.code === 'ASR_CANCELLED') throw cancelled();
    throw problem('DOUYIN_AUDIO_EXTRACT_FAILED', 'FFmpeg 未能提取本地音轨。', '检查 FFmpeg 安装后重试这条首页推荐。');
  }
  if (result?.code !== 0) throw problem('DOUYIN_AUDIO_EXTRACT_FAILED', 'FFmpeg 未能提取本地音轨。', '检查 FFmpeg 安装后重试这条首页推荐。');
  let stat;
  try { stat = fs.lstatSync(outputPath); } catch {}
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 44) {
    throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', 'FFmpeg 没有生成有效的本地音轨。', '检查 FFmpeg 输出后重试这条首页推荐。');
  }
  try { fs.chmodSync(outputPath, 0o600); } catch { throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', '无法保护本地临时音轨权限。', '检查本地感知资产目录权限后重试。'); }
  let audioDuration;
  try { audioDuration = await exactWavDurationMs(outputPath, ffprobePath, { signal, runProcessImpl }); }
  catch (error) {
    if (signal?.aborted || error?.code === 'DOUYIN_MEDIA_CANCELLED') throw cancelled();
    throw problem('DOUYIN_AUDIO_OUTPUT_INVALID', '无法确认提取后音轨的实际时长。', '检查 FFmpeg 输出后重试这条首页推荐。');
  }
  const wavDurationMs = ceilDurationMs(audioDuration);
  const acquiredEndMs = Math.min(
    mediaInfo.videoDurationMs,
    floorDurationMs(mediaInfo.audioDuration),
    floorDurationMs(audioDuration),
  );
  if (acquiredEndMs < 1 || wavDurationMs < 1) {
    throw problem('DOUYIN_AUDIO_RANGE_EMPTY', '本地音轨没有可识别的有效范围。', '跳过这条视频或选择另一条首页推荐。');
  }
  const statAgain = fs.lstatSync(outputPath);
  return {
    path: outputPath,
    sizeBytes: statAgain.size,
    contentSha256: crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'),
    durationMs: wavDurationMs,
    acquiredEndMs,
  };
}

async function inspectJpeg(file, ffprobePath, { signal, runProcessImpl }) {
  let header;
  try {
    const fd = fs.openSync(file, 'r');
    try { header = Buffer.alloc(2); if (fs.readSync(fd, header, 0, 2, 0) !== 2) throw new Error('short'); }
    finally { fs.closeSync(fd); }
  } catch { throw problem('DOUYIN_FRAME_INVALID', 'FFmpeg 输出的关键帧不是有效 JPEG。', '检查 FFmpeg 图像编码后重试。'); }
  if (header[0] !== 0xff || header[1] !== 0xd8) throw problem('DOUYIN_FRAME_INVALID', 'FFmpeg 输出的关键帧不是有效 JPEG。', '检查 FFmpeg 图像编码后重试。');
  const stdout = await probeStreams(file, ffprobePath, { signal, runProcessImpl, stage: 'probe-frame' });
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw problem('DOUYIN_FRAME_INVALID', '无法读取关键帧尺寸。', '检查 FFprobe 后重试。'); }
  const stream = Array.isArray(parsed?.streams) ? parsed.streams.find(value => value?.codec_type === 'video') : null;
  if (stream?.codec_name !== 'mjpeg' || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width < 1 || stream.height < 1 || stream.width > 512 || stream.height > 512) {
    throw problem('DOUYIN_FRAME_INVALID', '关键帧未通过 JPEG 或 512 像素尺寸校验。', '检查 FFmpeg 缩放与图像编码后重试。');
  }
}

export async function extractDouyinFrames({ mediaPath, outputDir, ffmpegPath, ffprobePath, mediaInfo, signal, runProcessImpl = runProcess } = {}) {
  const duration = mediaInfo.videoDurationMsExact;
  const timestamps = [...new Set([0.1, 0.5, 0.9].map(fraction => Math.min(Math.max(0, Math.floor(duration * fraction)), Math.max(0, Math.ceil(duration) - 1))))].slice(0, 3);
  const frames = [], warnings = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    if (signal?.aborted) throw cancelled();
    const atMs = timestamps[i], outputPath = path.join(outputDir, `frame-${i}.jpg`);
    const seconds = (atMs / 1000).toFixed(3);
    let result;
    try {
      result = await runProcessImpl(ffmpegPath, [
        '-nostdin', '-hide_banner', '-v', 'error', '-ss', seconds, '-i', mediaPath,
        '-frames:v', '1', '-an', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
        '-q:v', '4', '-f', 'image2', '-vcodec', 'mjpeg', '-y', outputPath,
      ], { signal, timeoutMs: 30_000, outputLimit: 64 * 1024, stage: 'extract-frame' });
      if (signal?.aborted) throw cancelled();
      if (result?.code !== 0) throw problem('DOUYIN_FRAME_FAILED', 'FFmpeg 未能提取关键帧。', '检查 FFmpeg 视频解码后重试。');
      const stat = fs.lstatSync(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4 || stat.size > 2 * 1024 * 1024) throw problem('DOUYIN_FRAME_INVALID', '关键帧文件大小无效。', '检查 FFmpeg 图像输出后重试。');
      try { fs.chmodSync(outputPath, 0o600); } catch { throw problem('DOUYIN_FRAME_INVALID', '无法保护关键帧临时文件权限。', '检查本地感知资产目录权限后重试。'); }
      await inspectJpeg(outputPath, ffprobePath, { signal, runProcessImpl });
      frames.push({ atMs, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(outputPath).toString('base64')}` });
    } catch (error) {
      if (signal?.aborted || error?.code === 'DOUYIN_MEDIA_CANCELLED') throw cancelled();
      warnings.push({ code: error?.code || 'DOUYIN_FRAME_FAILED', error: error?.error || '关键帧提取失败。', hint: error?.hint || '检查本机视频解码后重试。' });
    }
  }
  if (!frames.length && !warnings.length) warnings.push({ code: 'DOUYIN_FRAMES_EMPTY', error: '没有提取到可用关键帧。', hint: '检查这条视频的画面轨道后重试。' });
  return { frames: frames.slice(0, 3), warnings };
}

export async function downloadDouyinMedia(value, outputPath, {
  signal,
  maxBytes = MAX_VIDEO_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = 20_000,
  totalTimeoutMs = DEFAULT_TIMEOUT_MS,
  lookupImpl = dnsLookup,
  requestImpl = httpsRequest,
} = {}) {
  if (!path.isAbsolute(String(outputPath ?? '')) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw problem('DOUYIN_MEDIA_PATH_INVALID', '媒体临时路径无效。', '重新发起本轮视频读取。');
  }
  let parent;
  try {
    parent = path.dirname(path.resolve(outputPath));
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('unsafe parent');
    if (fs.existsSync(outputPath)) throw new Error('exists');
  } catch {
    throw problem('DOUYIN_MEDIA_PATH_INVALID', '媒体临时目录不可安全使用。', '检查本地感知资产目录权限后重试。');
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), totalTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let current;
  try { current = validateDouyinMediaUrl(value); }
  catch (error) { clearTimeout(timeout); throw error; }

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (combinedSignal.aborted) throw signal?.aborted ? cancelled() : problem('DOUYIN_MEDIA_TIMEOUT', '视频下载超过时间限制。', '检查网络后重新读取这条首页推荐。');
      const url = new URL(current);
      const addresses = await resolvePublicAddresses(url.hostname, lookupImpl, combinedSignal);
      if (combinedSignal.aborted) throw signal?.aborted ? cancelled() : problem('DOUYIN_MEDIA_TIMEOUT', '视频下载超过时间限制。', '检查网络后重新读取这条首页推荐。');
      const { response } = await requestPinned(url, addresses, { requestImpl, signal: combinedSignal, timeoutMs });
      const status = Number(response.statusCode ?? 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers?.location;
        response.destroy?.();
        if (hop >= maxRedirects || typeof location !== 'string' || !location) {
          throw problem('DOUYIN_MEDIA_REDIRECT_REJECTED', '视频 CDN 重定向无效或超过限制。', '刷新当前首页推荐后重试。');
        }
        try { current = validateDouyinMediaUrl(new URL(location, url).toString()); }
        catch { throw problem('DOUYIN_MEDIA_REDIRECT_REJECTED', '视频 CDN 重定向目标不在允许范围内。', '刷新当前首页推荐后重试。'); }
        continue;
      }
      if (status !== 200) {
        response.destroy?.();
        throw problem('DOUYIN_MEDIA_HTTP_FAILED', '视频 CDN 未返回完整视频文件。', '刷新当前首页推荐后重试。');
      }
      const announced = contentLength(response);
      if (announced === -1 || (announced !== null && announced > maxBytes)) {
        response.destroy?.();
        throw problem('DOUYIN_MEDIA_TOO_LARGE', '视频文件超过本地读取上限。', '跳过这条视频并继续下一条推荐。');
      }
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) callback(problem('DOUYIN_MEDIA_TOO_LARGE', '视频文件超过本地读取上限。', '跳过这条视频并继续下一条推荐。'));
        else callback(null, chunk);
      } });
      try {
        await pipeline(response, limiter, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal: combinedSignal });
      } catch (error) {
        if (combinedSignal.aborted) throw signal?.aborted ? cancelled() : problem('DOUYIN_MEDIA_TIMEOUT', '视频下载超过时间限制。', '检查网络后重新读取这条首页推荐。');
        if (error?.code === 'DOUYIN_MEDIA_TOO_LARGE') throw error;
        throw problem('DOUYIN_MEDIA_DOWNLOAD_FAILED', '视频下载未能完整写入本地临时文件。', '检查网络和本地磁盘空间后重试。');
      }
      let stat;
      try { stat = fs.lstatSync(outputPath); } catch {}
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size !== bytes) {
        throw problem('DOUYIN_MEDIA_DOWNLOAD_FAILED', '本地视频文件未通过完整性检查。', '重新读取这条首页推荐。');
      }
      return { path: outputPath, sizeBytes: stat.size };
    }
    throw problem('DOUYIN_MEDIA_REDIRECT_REJECTED', '视频 CDN 重定向超过限制。', '刷新当前首页推荐后重试。');
  } catch (error) {
    try { fs.rmSync(outputPath, { force: true }); } catch {}
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw problem('DOUYIN_MEDIA_TIMEOUT', '视频下载超过时间限制。', '检查网络后重新读取这条首页推荐。');
    }
    if (error?.code?.startsWith('DOUYIN_MEDIA_')) throw error;
    throw problem('DOUYIN_MEDIA_DOWNLOAD_FAILED', '视频下载失败。', '检查网络后重新读取这条首页推荐。');
  } finally {
    clearTimeout(timeout);
  }
}

export const DOUYIN_MEDIA_LIMITS = Object.freeze({ maxDurationMs: 120_000, maxBytes: MAX_VIDEO_BYTES, maxRedirects: DEFAULT_MAX_REDIRECTS });
