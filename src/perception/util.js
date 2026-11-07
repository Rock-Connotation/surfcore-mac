import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.js';

export const TERMINAL_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);
export const JOB_STATES = new Set(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
export const CHANNELS = new Set(['bili', 'qq', 'douyin', 'local']);

export function nowIso() {
  return new Date().toISOString();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    try {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch {}
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function sha256File(file, { createReadStream = fs.createReadStream, signal } = {}) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file, signal ? { signal } : undefined);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export function isPathWithin(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function requireString(value, field, { max = 512, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) {
    throw fail('REQUEST_INVALID', `Invalid ${field}.`, `Provide a non-empty ${field} within ${max} characters.`, { stage: 'validate' });
  }
  return value.trim();
}

function requireInteger(value, field, { min = 0, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < min) {
    throw fail('REQUEST_INVALID', `Invalid ${field}.`, `Provide ${field} as an integer at or above ${min}.`, { stage: 'validate' });
  }
  return value;
}

export function normalizeRanges(ranges, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(ranges) || (!allowEmpty && !ranges.length)) {
    throw fail('TIMELINE_INVALID', `Invalid ${field}.`, `Provide one or more ${field} intervals in integer milliseconds.`, { stage: 'validate' });
  }
  const normalized = ranges.map((range) => {
    if (!range || typeof range !== 'object') {
      throw fail('TIMELINE_INVALID', `Invalid ${field}.`, `Each ${field} interval needs integer startMs and endMs values.`, { stage: 'validate' });
    }
    const startMs = requireInteger(range.startMs, `${field}.startMs`);
    const endMs = requireInteger(range.endMs, `${field}.endMs`, { min: 1 });
    if (startMs >= endMs) {
      throw fail('TIMELINE_INVALID', `Invalid ${field}.`, `${field} intervals must have startMs < endMs.`, { stage: 'validate' });
    }
    return { startMs, endMs };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

export function normalizeTimelineMap(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw fail('TIMELINE_INVALID', 'The asset has no source timeline map.', 'Provide a map from each local audio interval to its original media interval.', { stage: 'validate' });
  }
  const map = entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw fail('TIMELINE_INVALID', 'The source timeline map is invalid.', 'Each map entry needs integer local and source start/end values.', { stage: 'validate' });
    }
    const localStartMs = requireInteger(entry.localStartMs, 'timelineMap.localStartMs');
    const localEndMs = requireInteger(entry.localEndMs, 'timelineMap.localEndMs', { min: 1 });
    const sourceStartMs = requireInteger(entry.sourceStartMs, 'timelineMap.sourceStartMs');
    const sourceEndMs = requireInteger(entry.sourceEndMs, 'timelineMap.sourceEndMs', { min: 1 });
    if (localStartMs >= localEndMs || sourceStartMs >= sourceEndMs) {
      throw fail('TIMELINE_INVALID', 'The source timeline map contains an empty interval.', 'Each local and source interval must have startMs < endMs.', { stage: 'validate' });
    }
    if (Math.abs((localEndMs - localStartMs) - (sourceEndMs - sourceStartMs)) > 25) {
      throw fail('TIMELINE_INVALID', 'The source timeline map changes playback speed.', 'Use a 1:1 time map; split edited or sped-up media into separately mapped intervals.', { stage: 'validate' });
    }
    return { localStartMs, localEndMs, sourceStartMs, sourceEndMs };
  }).sort((a, b) => a.localStartMs - b.localStartMs || a.sourceStartMs - b.sourceStartMs);
  for (let i = 1; i < map.length; i += 1) {
    if (map[i].localStartMs < map[i - 1].localEndMs || map[i].sourceStartMs < map[i - 1].sourceEndMs) {
      throw fail('TIMELINE_INVALID', 'The source timeline map overlaps.', 'Use sorted, non-overlapping local and source intervals.', { stage: 'validate' });
    }
  }
  return map;
}

function cleanUrl(value) {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const url = new URL(requireString(value, 'provenance.sourceUrl', { max: 4096 }));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    throw fail('REQUEST_INVALID', 'The source URL is invalid.', 'Use a stable http or https page URL without temporary credentials.', { stage: 'validate' });
  }
}

function normalizeVisibility(value) {
  const scope = value && typeof value === 'object' ? value : { classification: 'restricted' };
  const classification = ['public', 'private', 'restricted'].includes(scope.classification) ? scope.classification : 'restricted';
  const allowedContexts = Array.isArray(scope.allowedContexts)
    ? [...new Set(scope.allowedContexts.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 128)))].sort()
    : [];
  return {
    classification,
    ...(allowedContexts.length ? { allowedContexts } : {}),
    ...(typeof scope.legacyScope === 'string' && scope.legacyScope.trim() ? { legacyScope: scope.legacyScope.trim().slice(0, 256) } : {}),
  };
}

export function normalizeRequest(input, { getCharacter, now = Date.now, id = crypto.randomUUID } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('REQUEST_INVALID', 'The ASR request is invalid.', 'Submit an object containing asset, source, provenance, visibility, and requestedRanges.', { stage: 'validate' });
  }

  // Capture synchronously before the first await: a later character switch cannot rebind this work.
  let current = null;
  try { current = typeof getCharacter === 'function' ? getCharacter() : null; } catch (error) {
    throw fail('CHARACTER_UNAVAILABLE', 'The current character could not be read.', 'Reload the SurfCore Host and retry after the active character is available.', { retryable: true, stage: 'validate', cause: error });
  }
  const characterId = input.characterId ?? current?.id;
  const characterEpoch = input.characterEpoch ?? current?.epoch;
  const activityId = input.activityId ?? current?.activityId ?? id();
  const capturedAtMs = now();
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) {
    throw fail('REQUEST_INVALID', 'The local clock returned an invalid timestamp.', 'Correct the local clock and retry.', { stage: 'validate' });
  }
  const normalizedCharacterId = requireString(characterId, 'characterId', { max: 256 });
  const normalizedCharacterEpoch = requireInteger(characterEpoch, 'characterEpoch');
  const normalizedActivityId = requireString(activityId, 'activityId', { max: 256 });
  if (current && (normalizedCharacterId !== current.id || normalizedCharacterEpoch !== current.epoch)) {
    throw fail('STALE_CHARACTER', 'The request belongs to a character that is no longer active.', 'Refresh the character snapshot and submit a new job; the old job record remains available for inspection.', { stage: 'validate' });
  }

  const assetIn = input.asset;
  if (!assetIn || typeof assetIn !== 'object') {
    throw fail('REQUEST_INVALID', 'The ASR request has no media asset.', 'Provide the registered local audio asset and its content hash.', { stage: 'validate' });
  }
  const contentSha256 = requireString(assetIn.contentSha256, 'asset.contentSha256', { max: 64 }).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw fail('REQUEST_INVALID', 'The asset SHA-256 is invalid.', 'Provide the 64-character SHA-256 from the asset registration record.', { stage: 'validate' });
  }
  const localPath = requireString(assetIn.localPath, 'asset.localPath', { max: 4096 });
  if (!path.isAbsolute(localPath)) {
    throw fail('ASSET_UNAVAILABLE', 'The registered media path is not absolute.', 'Register the asset under the Host perception asset directory and retry.', { stage: 'validate' });
  }
  const sourceDurationMs = requireInteger(assetIn.sourceDurationMs, 'asset.sourceDurationMs', { nullable: true });
  const asset = {
    assetId: requireString(assetIn.assetId, 'asset.assetId', { max: 256 }),
    contentSha256,
    localPath: path.resolve(localPath),
    durationMs: requireInteger(assetIn.durationMs, 'asset.durationMs', { min: 1 }),
    sourceDurationMs,
    acquiredRanges: normalizeRanges(assetIn.acquiredRanges, 'asset.acquiredRanges', { allowEmpty: true }),
    timelineMap: normalizeTimelineMap(assetIn.timelineMap),
  };
  const provenanceIn = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  const channel = requireString(provenanceIn.channel, 'provenance.channel', { max: 32 });
  if (!CHANNELS.has(channel)) throw fail('REQUEST_INVALID', 'The source channel is not supported.', 'Use one of bili, qq, douyin, or local.', { stage: 'validate' });
  const sourceUrl = cleanUrl(provenanceIn.sourceUrl);
  const provenance = {
    channel,
    sourceId: requireString(provenanceIn.sourceId, 'provenance.sourceId', { max: 512 }),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(provenanceIn.partId === undefined ? {} : { partId: requireString(provenanceIn.partId, 'provenance.partId', { max: 256 }) }),
    acquiredAtMs: requireInteger(provenanceIn.acquiredAtMs, 'provenance.acquiredAtMs'),
  };
  const sourceIn = input.source && typeof input.source === 'object' ? input.source : { channel };
  const source = {
    channel: requireString(sourceIn.channel ?? channel, 'source.channel', { max: 32 }),
    ...(sourceIn.accountId === undefined ? {} : { accountId: requireString(String(sourceIn.accountId), 'source.accountId', { max: 256 }) }),
    ...(sourceIn.objectId === undefined ? {} : { objectId: requireString(String(sourceIn.objectId), 'source.objectId', { max: 512 }) }),
    ...(sourceIn.conversationId === undefined ? {} : { conversationId: requireString(String(sourceIn.conversationId), 'source.conversationId', { max: 512 }) }),
  };
  if (!CHANNELS.has(source.channel) || source.channel !== channel) {
    throw fail('REQUEST_INVALID', 'The acquisition channel and ownership source disagree.', 'Use the same supported channel in provenance and source.', { stage: 'validate' });
  }
  const requestedRanges = normalizeRanges(input.requestedRanges, 'requestedRanges');
  const languageHint = input.languageHint === undefined ? 'auto' : requireString(input.languageHint, 'languageHint', { max: 32 }).toLowerCase();
  if (!['auto', 'zh'].includes(languageHint)) {
    throw fail('LANGUAGE_UNSUPPORTED', 'The requested ASR language is not supported yet.', 'Choose auto or zh for this local Whisper provider.', { stage: 'validate' });
  }
  const options = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
  if (Object.keys(options).length) {
    throw fail('OPTIONS_UNSUPPORTED', 'The local ASR provider does not support the submitted recognition options.', 'Remove unsupported recognition options and submit with the configured model and language.', { stage: 'validate' });
  }
  const request = {
    ...(input.jobId ? { jobId: requireString(input.jobId, 'jobId', { max: 100 }) } : {}),
    characterId: normalizedCharacterId,
    characterEpoch: normalizedCharacterEpoch,
    activityId: normalizedActivityId,
    capturedAtMs,
    asset,
    provenance,
    source,
    visibility: normalizeVisibility(input.visibility),
    requestedRanges,
    languageHint,
    ...(Object.keys(options).length ? { options } : {}),
  };
  if (request.jobId && !/^[A-Za-z0-9_-]{1,100}$/.test(request.jobId)) {
    throw fail('REQUEST_INVALID', 'The job ID is invalid.', 'Use letters, digits, underscores, or hyphens only.', { stage: 'validate' });
  }
  return request;
}

export function rangeIntersection(a, b) {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  return startMs < endMs ? { startMs, endMs } : null;
}

export function intersectRanges(left, right) {
  const out = [];
  for (const a of left) for (const b of right) {
    const overlap = rangeIntersection(a, b);
    if (overlap) out.push(overlap);
  }
  return normalizeRanges(out, 'intersections', { allowEmpty: true });
}

export function subtractRanges(target, coverage) {
  let remaining = target.map((range) => ({ ...range }));
  for (const cover of coverage) {
    const next = [];
    for (const range of remaining) {
      if (cover.endMs <= range.startMs || cover.startMs >= range.endMs) {
        next.push(range);
        continue;
      }
      if (cover.startMs > range.startMs) next.push({ startMs: range.startMs, endMs: cover.startMs });
      if (cover.endMs < range.endMs) next.push({ startMs: cover.endMs, endMs: range.endMs });
    }
    remaining = next;
  }
  return normalizeRanges(remaining, 'missingRanges', { allowEmpty: true });
}

export function makeCacheKey(request, execution) {
  let runtimeStamp = null;
  const executable = execution.engine?.executable ?? execution.engine?.exe ?? null;
  if (typeof executable === 'string') {
    try {
      const stat = fs.statSync(executable);
      runtimeStamp = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return crypto.createHash('sha256').update(stableStringify({
    characterId: request.characterId,
    characterEpoch: request.characterEpoch,
    assetSha256: request.asset.contentSha256,
    assetDurationMs: request.asset.durationMs,
    sourceDurationMs: request.asset.sourceDurationMs,
    requestedRanges: request.requestedRanges,
    acquiredRanges: request.asset.acquiredRanges,
    timelineMap: request.asset.timelineMap,
    normalizer: 'pcm-s16le-16000-mono-v1',
    processingAlgorithmVersion: 'strict-core-retry-boundary-exact-zero-v3',
    chunking: { coreMs: 240000, overlapMs: 1500 },
    provider: execution.engine?.provider || 'whisper.cpp',
    runtimeVersion: execution.engine?.runtimeVersion || null,
    runtimeStamp,
    modelId: execution.engine?.model?.id || null,
    modelDigest: execution.engine?.model?.sha256 || null,
    backend: execution.engine?.backend || 'default',
    language: request.languageHint,
    options: request.options || {},
    visibility: request.visibility,
    source: request.source,
  })).digest('hex');
}

export function sanitizeProvenance(provenance) {
  return {
    channel: provenance.channel,
    sourceId: provenance.sourceId,
    ...(provenance.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {}),
    ...(provenance.partId ? { partId: provenance.partId } : {}),
    acquiredAtMs: provenance.acquiredAtMs,
  };
}

export function publicJob(job) {
  const safe = structuredClone(job);
  if (safe.request?.asset) delete safe.request.asset.localPath;
  delete safe.execution;
  if (safe.error) {
    safe.error = {
      code: safe.error.code,
      error: safe.error.error,
      hint: safe.error.hint,
      retryable: Boolean(safe.error.retryable),
      stage: safe.error.stage || null,
      ...(safe.error.reason ? { reason: safe.error.reason } : {}),
    };
  }
  if (safe.diagnostics) {
    safe.diagnostics = { ...safe.diagnostics };
    delete safe.diagnostics.stderr;
    delete safe.diagnostics.stdout;
  }
  return safe;
}

export function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
    throw fail('JOB_NOT_FOUND', 'The ASR job ID is invalid.', 'Copy a job ID returned by the local ASR service.', { stage: 'lookup' });
  }
  return jobId;
}
