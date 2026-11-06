import fs from 'node:fs';
import { fail } from './errors.js';
import { runProcess } from './process.js';

function normalizeText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function parseWhisperJson(jsonFile, chunkDurationMs) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(jsonFile)).replace(/^\uFEFF/, '')); } catch (error) {
    throw fail('OUTPUT_INVALID', 'Whisper did not produce valid JSON output.', 'Retry the job after checking the local Whisper runtime and job output directory.', { retryable: true, stage: 'transcribe', cause: error });
  }
  if (!Array.isArray(value?.transcription)) {
    throw fail('OUTPUT_INVALID', 'Whisper JSON does not contain transcription segments.', 'Check that the configured CLI supports `-oj` and `-of`, then retry.', { stage: 'transcribe' });
  }
  const segments = [];
  for (const item of value.transcription) {
    const from = Number(item?.offsets?.from);
    const to = Number(item?.offsets?.to);
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || !text) {
      throw fail('OUTPUT_INVALID', 'Whisper returned an invalid segment offset or text value.', 'Keep the failed job evidence and verify the runtime JSON format before retrying.', { stage: 'transcribe' });
    }
    const startMs = Math.round(from);
    const endMs = Math.min(Math.round(to), chunkDurationMs);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || to > chunkDurationMs + 25 || startMs >= endMs) {
      throw fail('OUTPUT_INVALID', 'Whisper returned a segment outside the requested audio chunk.', 'Retry with a valid runtime build; the result was not attached to the source timeline.', { stage: 'transcribe' });
    }
    segments.push({ startMs, endMs, text });
  }
  return segments;
}

export async function transcribeChunk({ executable, modelPath, runtimeVersion, language, backend, audioPath, outputBase, durationMs, signal, spawnImpl, cwd }) {
  if (!executable || !modelPath || !runtimeVersion) {
    throw fail('MODEL_NOT_READY', 'The local Whisper engine or model is not configured.', 'Install or select a verified local Whisper runtime and model, then retry.', { stage: 'transcribe' });
  }
  const args = ['-m', modelPath, '-f', audioPath, '-l', language || 'auto', '-oj', '-of', outputBase];
  if (backend === 'cpu') args.push('--no-gpu');
  const processResult = await runProcess(executable, args, {
    signal,
    spawnImpl,
    cwd,
    timeoutMs: 30 * 60_000,
    outputLimit: 64 * 1024,
    stage: 'transcribe',
  });
  if (processResult.code !== 0) {
    throw fail('WHISPER_FAILED', 'The local Whisper process did not finish successfully.', 'Check the selected runtime, model, and local resource availability before retrying.', { retryable: true, stage: 'transcribe' });
  }
  return parseWhisperJson(`${outputBase}.json`, durationMs);
}

export function deduplicateBoundarySegments(segments, overlapMs = 1500) {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const segment of sorted) {
    const normalized = normalizeText(segment.text);
    const previous = out.at(-1);
    if (previous && previous.chunkIndex !== segment.chunkIndex && previous.boundaryKey && previous.boundaryKey === segment.boundaryKey) {
      const previousText = normalizeText(previous.text);
      const overlap = Math.max(0, Math.min(previous.endMs, segment.endMs) - Math.max(previous.startMs, segment.startMs));
      const shortest = Math.max(1, Math.min(previous.endMs - previous.startMs, segment.endMs - segment.startMs));
      const close = Math.abs(previous.startMs - segment.startMs) <= Math.min(overlapMs, 750);
      if (normalized && normalized === previousText && overlap / shortest >= 0.6 && close) {
        if ((segment.endMs - segment.startMs) > (previous.endMs - previous.startMs)) out[out.length - 1] = segment;
        continue;
      }
    }
    out.push(segment);
  }
  return out.map(({ chunkIndex, boundaryKey, ...segment }) => segment);
}
