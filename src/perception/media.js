import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.js';
import { runProcess } from './process.js';

function parseProbe(stdout, stage) {
  let data;
  try { data = JSON.parse(stdout); } catch (error) {
    throw fail('OUTPUT_INVALID', 'FFprobe returned invalid JSON.', 'Verify the registered media file and the configured FFprobe build.', { retryable: true, stage, cause: error });
  }
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  if (!audio) throw fail('AUDIO_TRACK_MISSING', 'No audio track was found in the registered media.', 'Choose a media asset with an audio track or reacquire the correct part.', { stage: 'probe' });
  const rawDuration = audio.duration ?? data?.format?.duration;
  const seconds = Number(rawDuration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
    throw fail('DURATION_UNKNOWN', 'FFprobe could not determine the audio duration.', 'Reacquire the media file or provide a valid audio container with duration metadata.', { retryable: true, stage });
  }
  const durationMs = Math.round(seconds * 1000);
  return {
    durationMs,
    streamIndex: Number.isInteger(audio.index) ? audio.index : 0,
    sampleRate: Number(audio.sample_rate) || null,
    channels: Number(audio.channels) || null,
    codec: typeof audio.codec_name === 'string' ? audio.codec_name : null,
  };
}

export async function probeAudio(file, ffprobePath, { signal, spawnImpl, cwd } = {}) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index,codec_type,codec_name,duration,sample_rate,channels:format=duration',
    '-of', 'json',
    file,
  ], { signal, spawnImpl, cwd, timeoutMs: 60_000, outputLimit: 2 * 1024 * 1024, stage: 'probe' });
  if (result.code !== 0) {
    throw fail('PROBE_FAILED', 'FFprobe could not read the media file.', 'Check the file integrity or reacquire the media asset before retrying.', { retryable: true, stage: 'probe' });
  }
  return parseProbe(result.stdout, 'probe');
}

export async function normalizeAudio(file, outputFile, ffmpegPath, { signal, spawnImpl, cwd } = {}) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error', '-xerror',
    '-i', file,
    '-map', '0:a:0', '-vn',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-y', outputFile,
  ], { signal, spawnImpl, cwd, timeoutMs: 30 * 60_000, outputLimit: 64 * 1024, stage: 'normalize' });
  if (result.code !== 0) {
    throw fail('DECODE_FAILED', 'FFmpeg could not normalize the audio.', 'Check the source media or reacquire it before retrying the ASR job.', { retryable: true, stage: 'normalize' });
  }
  let stat;
  try { stat = fs.statSync(outputFile); } catch {}
  if (!stat?.isFile() || stat.size < 44) {
    throw fail('OUTPUT_INVALID', 'FFmpeg did not produce a valid normalized audio file.', 'Check the FFmpeg installation and source media, then retry.', { retryable: true, stage: 'normalize' });
  }
  return { path: outputFile, sizeBytes: stat.size };
}

export async function extractChunk(normalizedFile, outputFile, ffmpegPath, localStartMs, durationMs, { signal, spawnImpl, cwd } = {}) {
  const result = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-ss', (localStartMs / 1000).toFixed(3),
    '-i', normalizedFile,
    '-t', (durationMs / 1000).toFixed(3),
    '-map', '0:a:0', '-vn',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-y', outputFile,
  ], { signal, spawnImpl, cwd, timeoutMs: 10 * 60_000, outputLimit: 64 * 1024, stage: 'chunk' });
  if (result.code !== 0) throw fail('DECODE_FAILED', 'FFmpeg could not extract an ASR chunk.', 'Retry this job after checking the normalized audio and FFmpeg path.', { retryable: true, stage: 'chunk' });
  let stat;
  try { stat = fs.statSync(outputFile); } catch {}
  if (!stat?.isFile() || stat.size < 44) throw fail('OUTPUT_INVALID', 'FFmpeg returned an empty ASR chunk.', 'Retry after checking the media duration and requested ranges.', { retryable: true, stage: 'chunk' });
  return outputFile;
}

export function measurePcm16(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(12);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw fail('OUTPUT_INVALID', 'The normalized audio is not a WAV file.', 'Verify the FFmpeg output and retry the ASR job.', { stage: 'normalize' });
    }
    let offset = 12;
    let dataOffset = -1;
    let dataBytes = 0;
    const size = fs.fstatSync(descriptor).size;
    const invalid = () => fail('OUTPUT_INVALID', 'The normalized WAV is incomplete or has an unsupported PCM format.', 'Verify the FFmpeg output is complete 16 kHz mono 16-bit PCM, then retry.', { stage: 'normalize' });
    if (header.readUInt32LE(4) + 8 !== size) throw invalid();
    let formatValid = false, sawFormat = false;
    while (offset + 8 <= size) {
      const chunkHeader = Buffer.alloc(8);
      if (fs.readSync(descriptor, chunkHeader, 0, 8, offset) !== 8) throw invalid();
      const name = chunkHeader.toString('ascii', 0, 4);
      const length = chunkHeader.readUInt32LE(4);
      if (offset + 8 + length + (length % 2) > size) throw invalid();
      if (name === 'fmt ') {
        if (sawFormat || length < 16) throw invalid();
        const fmt = Buffer.alloc(16);
        if (fs.readSync(descriptor, fmt, 0, 16, offset + 8) !== 16) throw invalid();
        sawFormat = true;
        formatValid = fmt.readUInt16LE(0) === 1 && fmt.readUInt16LE(2) === 1 && fmt.readUInt32LE(4) === 16000 && fmt.readUInt32LE(8) === 32000 && fmt.readUInt16LE(12) === 2 && fmt.readUInt16LE(14) === 16;
      }
      if (name === 'data') { if (dataOffset >= 0) throw invalid(); dataOffset = offset + 8; dataBytes = length; }
      offset += 8 + length + (length % 2);
    }
    if (offset !== size || !formatValid || dataOffset < 0 || dataBytes < 2 || dataBytes % 2 !== 0) throw invalid();
    const buffer = Buffer.alloc(64 * 1024);
    let position = dataOffset;
    let remaining = dataBytes;
    let maxAbs = 0;
    let sumSquares = 0;
    let samples = 0;
    while (remaining > 0) {
      const wanted = Math.min(buffer.length, remaining);
      const read = fs.readSync(descriptor, buffer, 0, wanted - (wanted % 2), position);
      if (read <= 0 || read % 2 !== 0) throw invalid();
      for (let i = 0; i + 1 < read; i += 2) {
        const sample = buffer.readInt16LE(i);
        const absolute = Math.abs(sample);
        if (absolute > maxAbs) maxAbs = absolute;
        sumSquares += sample * sample;
        samples += 1;
      }
      position += read;
      remaining -= read;
    }
    return {
      exactSilence: maxAbs === 0,
      peak: maxAbs / 32768,
      rms: samples ? Math.sqrt(sumSquares / samples) / 32768 : 0,
      durationMs: Math.round((dataBytes / 2 / 16000) * 1000),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensureJobDirectory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
}
