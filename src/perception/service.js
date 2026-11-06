import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { fail, errorRecord } from './errors.js';
import { probeAudio, normalizeAudio, extractChunk, measurePcm16 } from './media.js';
import { runProcess } from './process.js';
import { transcribeChunk, deduplicateBoundarySegments } from './whisper.js';
import { resourceLimits, checkDuration, checkAssetSize, checkDiskSpace } from './resources.js';
import {
  atomicWriteJson,
  isPathWithin,
  JOB_STATES,
  makeCacheKey,
  normalizeRequest,
  nowIso,
  publicJob,
  readJson,
  sha256File,
  stableStringify,
  subtractRanges,
  intersectRanges,
  normalizeRanges,
  TERMINAL_STATES,
  validateJobId,
} from './util.js';

const SCHEMA_VERSION = 1;
const CHUNK_CORE_MS = 240_000;
const CHUNK_OVERLAP_MS = 1_500;
const CAPTURED_STAT_TOLERANCE_MS = 1_000;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizeExecution(raw = {}) {
  const engineIn = raw.engine && typeof raw.engine === 'object' ? raw.engine : null;
  let engine = null;
  if (engineIn) {
    const modelIn = engineIn.model && typeof engineIn.model === 'object' ? engineIn.model : null;
    engine = {
      provider: typeof engineIn.provider === 'string' && engineIn.provider.trim() ? engineIn.provider.trim() : 'whisper.cpp',
      executable: engineIn.executable || engineIn.exe || null,
      ...(typeof engineIn.runtimeVersion === 'string' && engineIn.runtimeVersion.trim() ? { runtimeVersion: engineIn.runtimeVersion.trim() } : {}),
      ...(engineIn.backend === 'cpu' ? { backend: 'cpu' } : {}),
      ...(modelIn ? {
        model: {
          id: typeof modelIn.id === 'string' ? modelIn.id.trim() : '',
          path: modelIn.path || null,
          sha256: typeof modelIn.sha256 === 'string' ? modelIn.sha256.trim().toLowerCase() : '',
        },
      } : {}),
    };
  }
  return {
    engine,
    ffmpegPath: raw.ffmpegPath || null,
    ffprobePath: raw.ffprobePath || null,
    ...(raw.ffmpeg && typeof raw.ffmpeg === 'object' ? { ffmpeg: clone(raw.ffmpeg) } : {}),
    ...(raw.ffprobe && typeof raw.ffprobe === 'object' ? { ffprobe: clone(raw.ffprobe) } : {}),
  };
}

function executableStatus(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function modelDescriptorValid(model) {
  return Boolean(model && typeof model.id === 'string' && model.id.trim() && typeof model.path === 'string' && path.isAbsolute(model.path) && /^[a-f0-9]{64}$/.test(model.sha256 || ''));
}

function versionFromText(text) {
  const match = String(text || '').match(/\b(?:whisper(?:\.cpp)?\s*)?(v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)\b/i);
  return match?.[1]?.replace(/^v/i, '') || null;
}

function statFingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function intervalIntersection(a, b) {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  return startMs < endMs ? { startMs, endMs } : null;
}

function clampRanges(ranges, endMs) {
  if (endMs == null) return normalizeRanges(ranges, 'ranges', { allowEmpty: true });
  return normalizeRanges(ranges.flatMap((range) => {
    const end = Math.min(range.endMs, endMs);
    return range.startMs < end ? [{ startMs: range.startMs, endMs: end }] : [];
  }), 'ranges', { allowEmpty: true });
}

function buildWorkIntervals(request, actualLocalDurationMs) {
  const validMap = [];
  for (const mapping of request.asset.timelineMap) {
    const localStartMs = mapping.localStartMs;
    const localEndMs = Math.min(mapping.localEndMs, actualLocalDurationMs, request.asset.durationMs);
    if (localStartMs >= localEndMs) continue;
    const sourceStartMs = mapping.sourceStartMs;
    const sourceEndMs = sourceStartMs + (localEndMs - localStartMs);
    validMap.push({ localStartMs, localEndMs, sourceStartMs, sourceEndMs });
  }
  const mapSourceRanges = validMap.map(({ sourceStartMs, sourceEndMs }) => ({ startMs: sourceStartMs, endMs: sourceEndMs }));
  const acquiredClaim = request.asset.sourceDurationMs == null
    ? request.asset.acquiredRanges
    : clampRanges(request.asset.acquiredRanges, request.asset.sourceDurationMs);
  const mappedAcquired = intersectRanges(acquiredClaim, mapSourceRanges);
  const requestedAcquired = intersectRanges(request.requestedRanges, mappedAcquired);
  const intervals = [];
  for (const mapping of validMap) {
    const sourceMap = { startMs: mapping.sourceStartMs, endMs: mapping.sourceEndMs };
    for (const sourceRange of requestedAcquired) {
      const overlap = intervalIntersection(sourceMap, sourceRange);
      if (!overlap) continue;
      intervals.push({
        sourceStartMs: overlap.startMs,
        sourceEndMs: overlap.endMs,
        localStartMs: mapping.localStartMs + (overlap.startMs - mapping.sourceStartMs),
        localEndMs: mapping.localStartMs + (overlap.endMs - mapping.sourceStartMs),
        mapSourceStartMs: mapping.sourceStartMs,
        mapLocalStartMs: mapping.localStartMs,
      });
    }
  }
  intervals.sort((a, b) => a.sourceStartMs - b.sourceStartMs || a.localStartMs - b.localStartMs);
  return {
    intervals,
    acquiredRanges: mappedAcquired,
  };
}

function planChunks(intervals) {
  const chunks = [];
  for (const interval of intervals) {
    let coreStart = interval.localStartMs;
    while (coreStart < interval.localEndMs) {
      const coreEnd = Math.min(interval.localEndMs, coreStart + CHUNK_CORE_MS);
      const inferStart = Math.max(interval.localStartMs, coreStart - CHUNK_OVERLAP_MS);
      const inferEnd = Math.min(interval.localEndMs, coreEnd + CHUNK_OVERLAP_MS);
      const sourceAt = (localMs) => interval.mapSourceStartMs + (localMs - interval.mapLocalStartMs);
      const chunk = {
        index: chunks.length,
        localStartMs: inferStart,
        localEndMs: inferEnd,
        durationMs: inferEnd - inferStart,
        sourceStartMs: sourceAt(inferStart),
        sourceEndMs: sourceAt(inferEnd),
        coreSourceStartMs: sourceAt(coreStart),
        coreSourceEndMs: sourceAt(coreEnd),
        processedRange: { startMs: sourceAt(coreStart), endMs: sourceAt(coreEnd) },
        boundaryBefore: coreStart > interval.localStartMs,
        boundaryAfter: coreEnd < interval.localEndMs,
        boundaryKey: coreStart > interval.localStartMs
          ? `${sourceAt(coreStart)}`
          : (coreEnd < interval.localEndMs ? `${sourceAt(coreEnd)}` : null),
      };
      chunks.push(chunk);
      coreStart = coreEnd;
    }
  }
  return chunks;
}

function mapChunkSegments(segments, chunk) {
  const out = [];
  for (const segment of segments) {
    const startMs = chunk.sourceStartMs + segment.startMs;
    const endMs = chunk.sourceStartMs + segment.endMs;
    if (startMs >= endMs || endMs > chunk.sourceEndMs + 1000) continue;
    const center = Math.floor((startMs + endMs) / 2);
    if (center < chunk.coreSourceStartMs || center > chunk.coreSourceEndMs) continue;
    out.push({
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text: segment.text,
      chunkIndex: chunk.index,
      boundaryKey: chunk.boundaryKey,
    });
  }
  return out;
}

function warning(code, message) {
  return { code, message };
}

function safeCachedResult(cache, cacheKey, modelDigest) {
  if (!cache || cache.schemaVersion !== SCHEMA_VERSION || cache.cacheKey !== cacheKey || cache.coverage?.complete !== true || cache.engine?.modelDigest !== modelDigest || !Array.isArray(cache.segments)) return null;
  const segments = [];
  for (const segment of cache.segments) {
    if (!segment || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs || typeof segment.text !== 'string') return null;
    segments.push({ startMs: segment.startMs, endMs: segment.endMs, text: segment.text });
  }
  return { ...cache, segments };
}

function makeResult(job, neutral, id) {
  return {
    transcriptId: id(),
    jobId: job.jobId,
    characterId: job.characterId,
    characterEpoch: job.characterEpoch,
    activityId: job.activityId,
    assetId: job.request.asset.assetId,
    provenance: clone(job.request.provenance),
    source: clone(job.request.source),
    visibility: clone(job.request.visibility),
    language: neutral.language,
    engine: clone(neutral.engine),
    segments: clone(neutral.segments),
    coverage: clone(neutral.coverage),
    speechState: neutral.speechState,
    warnings: clone(neutral.warnings || []),
  };
}

/**
 * Create the Host-owned, durable local perception queue. `dataRoot` is STATE_DIR;
 * all queue/model/cache paths are appended here so callers cannot select another root.
 */
export function createPerceptionService({
  dataRoot,
  engine,
  ffmpegPath,
  ffprobePath,
  ffmpeg,
  ffprobe,
  getCharacter,
  limits,
  dependencies = {},
} = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    throw fail('DATA_ROOT_INVALID', 'The Host data root must be an absolute path.', 'Pass the resolved SurfCore STATE_DIR to the perception service.', { stage: 'initialize' });
  }

  let canonicalDataRoot;
  try {
    fs.mkdirSync(path.resolve(dataRoot), { recursive: true, mode: 0o700 });
    canonicalDataRoot = fs.realpathSync(path.resolve(dataRoot));
  } catch (error) {
    throw fail('DATA_ROOT_UNAVAILABLE', 'The Host data root is not available.', 'Check that SurfCore can read and write its configured state directory.', { retryable: true, stage: 'initialize', cause: error });
  }
  const perceptionRoot = path.join(canonicalDataRoot, 'perception');
  const asrRoot = path.join(perceptionRoot, 'asr');
  const jobsRoot = path.join(asrRoot, 'jobs');
  const cacheRoot = path.join(asrRoot, 'cache');
  const modelsRoot = path.join(asrRoot, 'models');
  const assetsRoot = path.join(perceptionRoot, 'assets');
  const lockFile = path.join(asrRoot, 'host.lock');
  const spawnImpl = dependencies.spawn || dependencies.spawnImpl;
  const now = dependencies.now || Date.now;
  const makeId = dependencies.id || crypto.randomUUID;
  const hashFile = dependencies.hashFile || sha256File;
  const resourcePolicy = resourceLimits(limits);
  const TERM_WAIT_MS = Number.isSafeInteger(dependencies.termWaitMs) ? dependencies.termWaitMs : 1200;
  const KILL_WAIT_MS = Number.isSafeInteger(dependencies.killWaitMs) ? dependencies.killWaitMs : 1200;
  const LOCK_WAIT_MS = Number.isSafeInteger(dependencies.lockWaitMs) ? Math.max(0, dependencies.lockWaitMs) : 5000;
  const hashCache = new Map();
  const versionCache = new Map();
  const jobs = new Map();
  const runners = new Map();
  const queue = [];
  const instanceId = makeId();
  let execution = normalizeExecution({ engine, ffmpegPath, ffprobePath, ffmpeg, ffprobe });
  let lockOwned = false;
  let activationError = null;
  let disposed = false;
  let activeRunner = null;
  let pumpTimer = null;
  let pumping = false;

  function jobFile(jobId) {
    return path.join(jobsRoot, jobId, 'job.json');
  }

  function cacheFile(cacheKey) {
    return path.join(cacheRoot, `${cacheKey}.json`);
  }

  function checkpointFile(jobId, index) {
    return path.join(jobsRoot, jobId, `chunk-${String(index).padStart(5, '0')}.json`);
  }

  function persist(job) {
    job.updatedAt = nowIso();
    atomicWriteJson(jobFile(job.jobId), job);
  }

  function lockPayload() {
    return { schemaVersion: 1, pid: process.pid, instanceId, dataRoot: canonicalDataRoot, startedAt: nowIso() };
  }

  function preserveStaleLock() {
    let before;
    let payload;
    try {
      before = fs.lstatSync(lockFile);
      payload = readJson(lockFile);
    } catch {
      return false;
    }
    // An empty lock may belong to an instance between open and write.
    if (!payload || !Number.isSafeInteger(payload.pid) || !payload.instanceId || isAlive(payload.pid)) return false;
    let after;
    try { after = fs.lstatSync(lockFile); } catch { return true; }
    if (before.dev !== after.dev || before.ino !== after.ino) return false;
    const stalePath = path.join(asrRoot, `host.lock.stale-${now()}-${makeId()}`);
    try {
      fs.renameSync(lockFile, stalePath);
      const preserved = readJson(stalePath);
      if (payload && preserved?.instanceId !== payload.instanceId) {
        try { fs.renameSync(stalePath, lockFile); } catch {}
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function acquireLock() {
    fs.mkdirSync(asrRoot, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(asrRoot, 0o700); } catch {}
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let descriptor;
      try {
        descriptor = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(lockPayload())}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        lockOwned = true;
        return;
      } catch (error) {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch {}
        }
        if (error?.code !== 'EEXIST' || !preserveStaleLock()) {
          throw fail('ASR_HOST_ALREADY_RUNNING', 'Another SurfCore Host owns the local ASR queue.', 'Close the other Host instance or wait for its ASR jobs to finish before opening another one.', { retryable: true, stage: 'initialize', cause: error });
        }
      }
    }
    throw fail('ASR_HOST_ALREADY_RUNNING', 'Another SurfCore Host owns the local ASR queue.', 'Close the other Host instance or wait for its ASR jobs to finish before opening another one.', { retryable: true, stage: 'initialize' });
  }

  function releaseLock() {
    if (!lockOwned) return;
    const payload = readJson(lockFile);
    if (payload?.instanceId === instanceId && payload?.pid === process.pid) {
      try { fs.unlinkSync(lockFile); } catch {}
    }
    lockOwned = false;
  }

  function requireOwner() {
    if (disposed) throw fail('ASR_SERVICE_DISPOSED', 'The local ASR service has been disposed.', 'Reload the SurfCore Host before submitting another ASR job.', { retryable: true, stage: 'host' });
    if (activationError) throw errorRecord(activationError);
    if (!lockOwned) throw fail('ASR_HOST_ALREADY_RUNNING', 'This Host instance does not own the local ASR queue.', 'Close the other Host instance or use its scoped ASR API.', { retryable: true, stage: 'host' });
  }

  function schedulePump() {
    if (pumpTimer || disposed || !lockOwned) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      void pump();
    }, 0);
  }

  function createJob(request, executionSnapshot, { retryOf = null, checkpointFrom = null } = {}) {
    const jobId = request.jobId || makeId();
    validateJobId(jobId);
    if (jobs.has(jobId) || fs.existsSync(jobFile(jobId))) {
      throw fail('JOB_ID_CONFLICT', 'The ASR job ID is already in use.', 'Submit the request again without a caller-supplied jobId to create a new job.', { stage: 'persist' });
    }
    const job = {
      schemaVersion: SCHEMA_VERSION,
      jobId,
      state: 'queued',
      characterId: request.characterId,
      characterEpoch: request.characterEpoch,
      activityId: request.activityId,
      request,
      execution: clone(executionSnapshot),
      cacheKey: makeCacheKey(request, executionSnapshot),
      ...(retryOf ? { retryOf } : {}),
      ...(checkpointFrom ? { checkpointFrom } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      progress: { phase: 'queued', chunksDone: 0, chunksTotal: null, processedRanges: [] },
      processedRanges: [],
      result: null,
      error: null,
      warnings: [],
    };
    atomicWriteJson(jobFile(jobId), job);
    jobs.set(jobId, job);
    return job;
  }

  function addJobToRunner(job) {
    let runner = runners.get(job.cacheKey);
    if (!runner) {
      runner = {
        key: job.cacheKey,
        consumerIds: new Set(),
        state: 'queued',
        execution: clone(job.execution),
        controller: null,
        promise: null,
        progress: { phase: 'queued', chunksDone: 0, chunksTotal: null, processedRanges: [] },
        processedRanges: [],
        segments: [],
        warnings: [],
        checkpointFrom: job.checkpointFrom || null,
      };
      runners.set(job.cacheKey, runner);
      queue.push(runner);
    }
    runner.consumerIds.add(job.jobId);
    job.state = runner.state === 'running' ? 'running' : 'queued';
    job.progress = clone(runner.progress);
    persist(job);
    schedulePump();
    return runner;
  }

  function checkQueueCapacity(request, executionSnapshot) {
    const runner = runners.get(makeCacheKey(request, executionSnapshot));
    // A new consumer of already-running work does not take a waiting slot.
    if (runner?.state === 'running') {
      if (runner.controller?.signal.aborted || !activeConsumers(runner).length) throw fail('ASR_QUEUE_BUSY', 'The previous ASR execution is stopping.', 'Wait briefly for the existing process to exit, then submit again.', { retryable: true, stage: 'resources' });
      return;
    }
    const waiting = queue.reduce((sum, item) => sum + activeConsumers(item).length, 0);
    if (waiting >= resourcePolicy.maxQueuedConsumers) throw fail('ASR_QUEUE_FULL', 'The local ASR waiting queue is full.', 'Wait for a queued job to start or cancel one before submitting another.', { retryable: true, stage: 'resources' });
  }

  function failDeclaredDuration(job) {
    try { checkDuration(job.request.asset.durationMs, resourcePolicy); return false; } catch (error) {
      job.state = 'failed'; job.error = errorRecord(error); job.finishedAt = nowIso();
      job.progress = { ...job.progress, phase: 'failed' }; persist(job); return true;
    }
  }

  function saveJobProgress(job, runner) {
    if (job.state !== 'running') return;
    job.progress = clone(runner.progress);
    job.processedRanges = clone(runner.processedRanges);
    job.warnings = clone(runner.warnings);
    persist(job);
  }

  async function realAssetPath(request, signal) {
    const root = await fs.promises.realpath(assetsRoot).catch((error) => {
      throw fail('ASSET_UNAVAILABLE', 'The Host media asset directory is missing.', 'Register the acquired media under the SurfCore perception asset directory and retry.', { retryable: true, stage: 'asset', cause: error });
    });
    const realPath = await fs.promises.realpath(request.asset.localPath).catch((error) => {
      throw fail('ASSET_UNAVAILABLE', 'The registered media asset is not readable.', 'Reacquire the media asset and submit its current local path.', { retryable: true, stage: 'asset', cause: error });
    });
    if (!isPathWithin(root, realPath) || realPath === root) {
      throw fail('ASSET_OUTSIDE_ROOT', 'The media asset is outside the Host perception asset directory.', 'Copy or reacquire the media into STATE_DIR/perception/assets and submit that registered asset.', { stage: 'asset' });
    }
    const statBefore = await fs.promises.stat(realPath);
    if (!statBefore.isFile()) throw fail('ASSET_UNAVAILABLE', 'The registered media path is not a file.', 'Register a readable audio or video file under the Host perception asset directory.', { stage: 'asset' });
    checkAssetSize(statBefore.size, resourcePolicy);
    let digest;
    try { digest = await hashFile(realPath, { signal }); } catch (error) {
      if (signal?.aborted) throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage: 'asset' });
      throw fail('ASSET_UNAVAILABLE', 'The media asset could not be hashed.', 'Check that the asset is readable and retry the local job.', { retryable: true, stage: 'asset', cause: error });
    }
    const statAfter = await fs.promises.stat(realPath);
    if (statFingerprint(statBefore) !== statFingerprint(statAfter)) {
      throw fail('ASSET_CHANGED', 'The media asset changed while it was being verified.', 'Finish copying or downloading the asset, then submit it again.', { retryable: true, stage: 'asset' });
    }
    if (digest !== request.asset.contentSha256) {
      throw fail('ASSET_HASH_MISMATCH', 'The media asset does not match its registered SHA-256.', 'Re-register the asset using its current SHA-256 and retry.', { stage: 'asset' });
    }
    return { path: realPath, digest, statFingerprint: statFingerprint(statAfter) };
  }

  async function verifyModel(config, signal, { allowMissingForCache = false } = {}) {
    const descriptor = config?.engine;
    if (!descriptor || !descriptor.executable || !descriptor.model) {
      if (allowMissingForCache) return null;
      throw fail('MODEL_NOT_READY', 'The local Whisper engine or model is not configured.', 'Select a verified local runtime and model in SurfCore ASR settings, then retry.', { stage: 'model' });
    }
    const model = descriptor.model;
    if (!modelDescriptorValid(model)) {
      throw fail('MODEL_NOT_READY', 'The local model manifest is incomplete.', 'Configure a model ID, absolute model path, and expected SHA-256 before running ASR.', { stage: 'model' });
    }
    let stat;
    try { stat = await fs.promises.stat(model.path); } catch (error) {
      if (allowMissingForCache) return null;
      throw fail('MODEL_NOT_READY', 'The configured local model file is missing.', 'Install or reselect the model file whose SHA-256 appears in the configured manifest.', { retryable: true, stage: 'model', cause: error });
    }
    if (!stat.isFile()) throw fail('MODEL_NOT_READY', 'The configured model path is not a file.', 'Select a verified local Whisper model file and retry.', { stage: 'model' });
    const cacheKey = `${model.path}:${statFingerprint(stat)}:${model.sha256}`;
    let actual = hashCache.get(cacheKey);
    if (!actual) {
      try { actual = await hashFile(model.path, { signal }); } catch (error) {
        if (signal?.aborted) throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage: 'model' });
        throw fail('MODEL_NOT_READY', 'The configured local model could not be read.', 'Check the model file permissions and retry the ASR readiness check.', { retryable: true, stage: 'model', cause: error });
      }
      hashCache.set(cacheKey, actual);
    }
    if (actual !== model.sha256) {
      throw fail('MODEL_INTEGRITY_FAILED', 'The configured model SHA-256 does not match its manifest.', 'Restore or reimport the model with the expected SHA-256 before retrying.', { stage: 'model' });
    }
    return { descriptor, modelDigest: actual };
  }

  async function getRuntimeVersion(config, signal) {
    const engine = config?.engine;
    if (!engine || !executableStatus(engine.executable)) {
      throw fail('RUNTIME_UNAVAILABLE', 'The configured local Whisper executable is missing or not runnable.', 'Select a bundled or explicitly installed absolute Whisper executable for this Mac.', { retryable: true, stage: 'runtime' });
    }
    let fingerprint = '';
    try { fingerprint = statFingerprint(fs.statSync(engine.executable)); } catch {}
    const key = `${engine.executable}:${fingerprint}`;
    if (versionCache.has(key)) return versionCache.get(key);
    let output = '';
    let lastError = null;
    for (const flag of ['--version', '-version']) {
      try {
        const result = await runProcess(engine.executable, [flag], { signal, spawnImpl, timeoutMs: 10_000, outputLimit: 16 * 1024, stage: 'runtime-version', termWaitMs: TERM_WAIT_MS, killWaitMs: KILL_WAIT_MS });
        output = `${result.stdout}\n${result.stderr}`.trim();
        const detected = versionFromText(output);
        if (result.code === 0 && detected) {
          if (engine.runtimeVersion && engine.runtimeVersion.replace(/^v/i, '') !== detected) throw fail('RUNTIME_VERSION_MISMATCH', 'The Whisper runtime version does not match its configured version.', 'Select the verified runtime build matching the configured version.', { stage: 'runtime' });
          if (!['1.9.5', '1.9.5-dev'].includes(detected)) throw fail('RUNTIME_VERSION_UNSUPPORTED', 'This Whisper runtime version is not supported.', 'Select the verified whisper.cpp 1.9.5 runtime.', { stage: 'runtime' });
          versionCache.set(key, detected);
          return detected;
        }
        if (!lastError && result.code !== 0) lastError = output;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (['RUNTIME_VERSION_MISMATCH', 'RUNTIME_VERSION_UNSUPPORTED'].includes(error?.code)) throw error;
        lastError = error;
      }
    }
    throw fail('RUNTIME_VERSION_UNKNOWN', 'The local Whisper runtime did not report a version.', 'Use a verified whisper.cpp CLI build that reports its version.', { retryable: true, stage: 'runtime', cause: lastError });
  }

  async function mediaTools(config) {
    const ffmpeg = config.ffmpegPath;
    const ffprobe = config.ffprobePath;
    if (!executableStatus(ffmpeg)) throw fail('FFMPEG_UNAVAILABLE', 'The configured FFmpeg executable is missing or not runnable.', 'Install or select an absolute FFmpeg path in the local runtime settings.', { retryable: true, stage: 'media' });
    if (!executableStatus(ffprobe)) throw fail('FFPROBE_UNAVAILABLE', 'The configured FFprobe executable is missing or not runnable.', 'Install or select an absolute FFprobe path in the local runtime settings.', { retryable: true, stage: 'media' });
    return { ffmpegPath: ffmpeg, ffprobePath: ffprobe };
  }

  async function describe(config, { checkModel = true } = {}) {
    if (!config?.engine || !config.engine.model || !modelDescriptorValid(config.engine.model)) {
      return {
        ok: false,
        ready: false,
        code: 'MODEL_NOT_READY',
        error: 'No verified local Whisper model is configured.',
        hint: 'Select a local whisper.cpp executable and model with its expected SHA-256 in SurfCore ASR settings.',
        provider: config?.engine?.provider || 'whisper.cpp',
        model: config?.engine?.model?.id ? { id: config.engine.model.id, configured: true, verified: false } : null,
      };
    }
    try {
      const engine = config.engine;
      if (engine.provider !== 'whisper.cpp') throw fail('PROVIDER_UNSUPPORTED', 'The selected ASR provider is not supported.', 'Select the verified whisper.cpp provider.', { stage: 'runtime' });
      if (!executableStatus(engine.executable)) throw fail('RUNTIME_UNAVAILABLE', 'The configured local Whisper executable is missing or not runnable.', 'Select a bundled or explicitly installed absolute Whisper executable for this Mac.', { retryable: true, stage: 'runtime' });
      const version = await getRuntimeVersion(config);
      if (checkModel) await verifyModel(config);
      const media = await mediaTools(config);
      return {
        ok: true,
        ready: true,
        provider: engine.provider,
        runtimeVersion: version,
        backend: engine.backend || 'default',
        model: { id: engine.model.id, sha256: engine.model.sha256, verified: checkModel },
        media: {
          ffmpegVersion: config.ffmpeg?.version || null,
          ffprobeVersion: config.ffprobe?.version || null,
          available: Boolean(media.ffmpegPath && media.ffprobePath),
        },
      };
    } catch (error) {
      const record = errorRecord(error);
      return {
        ok: false,
        ready: false,
        code: record.code,
        error: record.error,
        hint: record.hint,
        provider: config?.engine?.provider || 'whisper.cpp',
        model: config?.engine?.model?.id ? { id: config.engine.model.id, sha256: config.engine.model.sha256, verified: false } : null,
      };
    }
  }

  async function verifyConsumer(job, signal) {
    try {
      return await realAssetPath(job.request, signal);
    } catch (error) {
      const current = jobs.get(job.jobId);
      if (current && current.state !== 'cancelled' && current.state !== 'interrupted') {
        current.state = 'failed';
        current.error = errorRecord(error);
        current.finishedAt = nowIso();
        persist(current);
      }
      return null;
    }
  }

  function activeConsumers(runner) {
    return [...runner.consumerIds].map((jobId) => jobs.get(jobId)).filter((job) => job && !TERMINAL_STATES.has(job.state) && job.state !== 'interrupted');
  }

  function updateRunnerProgress(runner, phase, extra = {}) {
    runner.progress = {
      phase,
      chunksDone: Number.isSafeInteger(extra.chunksDone) ? extra.chunksDone : (runner.progress.chunksDone || 0),
      chunksTotal: Number.isSafeInteger(extra.chunksTotal) ? extra.chunksTotal : runner.progress.chunksTotal,
      ...(extra.processedRanges ? { processedRanges: clone(extra.processedRanges) } : { processedRanges: clone(runner.processedRanges) }),
    };
    for (const job of activeConsumers(runner)) saveJobProgress(job, runner);
  }

  async function loadCheckpoint(job, chunk, cacheKey) {
    if (!job.checkpointFrom) return null;
    const checkpoint = readJson(checkpointFile(job.checkpointFrom, chunk.index));
    if (!checkpoint || checkpoint.schemaVersion !== SCHEMA_VERSION || checkpoint.cacheKey !== cacheKey || stableStringify(checkpoint.chunk) !== stableStringify(chunk) || !Array.isArray(checkpoint.segments)) return null;
    const digest = crypto.createHash('sha256').update(stableStringify({ cacheKey, chunk, segments: checkpoint.segments })).digest('hex');
    if (checkpoint.digest !== digest || !checkpoint.segments.every((segment) => Number.isSafeInteger(segment.startMs) && Number.isSafeInteger(segment.endMs) && segment.startMs >= chunk.sourceStartMs && segment.endMs <= chunk.sourceEndMs && segment.endMs > segment.startMs && typeof segment.text === 'string')) return null;
    return checkpoint;
  }

  async function completeWithNeutral(runner, neutral, { cached = false } = {}) {
    if (!cached && neutral.coverage.complete) {
      atomicWriteJson(cacheFile(runner.key), {
        schemaVersion: SCHEMA_VERSION,
        cacheKey: runner.key,
        createdAt: nowIso(),
        engine: neutral.engine,
        language: neutral.language,
        segments: neutral.segments,
        coverage: neutral.coverage,
        speechState: neutral.speechState,
        warnings: neutral.warnings,
      });
    }
    for (const job of activeConsumers(runner)) {
      const consumerInput = await verifyConsumer(job, runner.controller?.signal);
      if (!consumerInput || !activeConsumers(runner).some((item) => item.jobId === job.jobId)) continue;
      const result = makeResult(job, neutral, makeId);
      const current = jobs.get(job.jobId);
      if (!current || current.state !== 'running') continue;
      current.result = result;
      current.coverage = clone(result.coverage);
      current.state = result.coverage.complete ? 'completed' : (result.coverage.processedRanges.length ? 'partial' : 'failed');
      current.error = current.state === 'failed'
        ? errorRecord(fail('NO_RANGE_PROCESSED', 'No requested audio range was processed.', 'Reacquire the media or check the failed chunk details, then retry.', { retryable: true, stage: 'coverage' }))
        : null;
      current.finishedAt = nowIso();
      current.warnings = clone(result.warnings);
      current.progress = { phase: current.state, chunksDone: runner.progress.chunksDone, chunksTotal: runner.progress.chunksTotal, processedRanges: clone(result.coverage.processedRanges) };
      persist(current);
    }
  }

  async function failRunner(runner, error) {
    const failure = errorRecord(error);
    for (const job of activeConsumers(runner)) {
      const current = jobs.get(job.jobId);
      if (!current || current.state !== 'running') continue;
      current.state = 'failed';
      current.error = failure;
      current.finishedAt = nowIso();
      current.progress = { ...current.progress, phase: 'failed' };
      persist(current);
    }
  }

  async function runRunner(runner) {
    runner.controller = new AbortController();
    try {
      if (!activeConsumers(runner).length) return;
      runner.state = 'running';
      for (const job of activeConsumers(runner)) {
        job.state = 'running';
        job.startedAt ||= nowIso();
        job.progress = clone(runner.progress);
        persist(job);
      }
      updateRunnerProgress(runner, 'verify-asset');
      let verifiedJobs = [];
      for (const job of activeConsumers(runner)) {
        if (runner.controller.signal.aborted) throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage: 'asset' });
        const verified = await verifyConsumer(job, runner.controller.signal);
        if (verified) verifiedJobs.push({ job, verified });
      }
      if (!verifiedJobs.length) return;
      const lead = verifiedJobs[0].job;
      const request = lead.request;
      checkDuration(request.asset.durationMs, resourcePolicy);
      const config = lead.execution;
      const cacheKey = makeCacheKey(request, config);
      runner.key = cacheKey;
      for (const { job } of verifiedJobs) job.cacheKey = cacheKey;

      const model = await verifyModel(config, runner.controller.signal);
      if (config.engine.provider !== 'whisper.cpp') throw fail('PROVIDER_UNSUPPORTED', 'The selected ASR provider is not supported.', 'Select the verified whisper.cpp provider.', { stage: 'runtime' });
      const runtimeVersion = await getRuntimeVersion(config, runner.controller.signal);
      const tools = await mediaTools(config);
      const media = await probeAudio(verifiedJobs[0].verified.path, tools.ffprobePath, { signal: runner.controller.signal, spawnImpl, cwd: path.dirname(jobFile(lead.jobId)) });
      checkDuration(media.durationMs, resourcePolicy);
      const cachedRaw = readJson(cacheFile(cacheKey));
      const modelDigest = config.engine?.model?.sha256 || null;
      const cached = safeCachedResult(cachedRaw, cacheKey, modelDigest);
      if (cached) {
        const current = activeConsumers(runner);
        if (current.length) {
          await completeWithNeutral(runner, {
            language: cached.language,
            engine: cached.engine,
            segments: cached.segments,
            coverage: cached.coverage,
            speechState: cached.speechState,
            warnings: cached.warnings,
          }, { cached: true });
        }
        return;
      }

      const sourcePath = verifiedJobs[0].verified.path;
      const inputFingerprint = verifiedJobs[0].verified.statFingerprint;
      const jobDir = path.dirname(jobFile(lead.jobId));
      const normalizedFile = path.join(jobDir, 'normalized.wav');
      const planned = planChunks(buildWorkIntervals(request, Math.min(media.durationMs, request.asset.durationMs)).intervals);
      await checkDiskSpace(jobDir, media.durationMs, planned, resourcePolicy, dependencies.statfs);
      updateRunnerProgress(runner, 'normalize');
      await normalizeAudio(sourcePath, normalizedFile, tools.ffmpegPath, { signal: runner.controller.signal, spawnImpl, cwd: jobDir });
      const normalizedStats = measurePcm16(normalizedFile);
      const postNormalizePath = await realAssetPath(request, runner.controller.signal);
      if (postNormalizePath.statFingerprint !== inputFingerprint) throw fail('ASSET_CHANGED', 'The media asset changed during normalization.', 'Finish copying or downloading the asset, then submit it again.', { retryable: true, stage: 'normalize' });
      const actualDuration = Math.min(media.durationMs, normalizedStats.durationMs, request.asset.durationMs);
      const { intervals, acquiredRanges } = buildWorkIntervals(request, actualDuration);
      const chunks = planChunks(intervals);
      const initialWarnings = [];
      if (Math.abs(media.durationMs - request.asset.durationMs) > CAPTURED_STAT_TOLERANCE_MS) {
        initialWarnings.push(warning('MEDIA_DURATION_MISMATCH', 'The probed local audio duration differs from the registered duration; coverage was limited to verified audio.'));
      }
      if (normalizedStats.durationMs + 25 < media.durationMs) initialWarnings.push(warning('MEDIA_TRUNCATED', 'Decoded audio is shorter than the container duration; coverage is limited to decoded samples.'));
      if (request.asset.sourceDurationMs === null) {
        initialWarnings.push(warning('SOURCE_DURATION_UNKNOWN', 'The full source duration is unknown, so this job cannot claim complete source coverage.'));
      }
      const uncoveredAtStart = subtractRanges(request.requestedRanges, acquiredRanges);
      if (uncoveredAtStart.length) initialWarnings.push(warning('MEDIA_TRUNCATED', 'Some requested source ranges were not present in the verified local audio asset.'));
      runner.warnings = initialWarnings;
      runner.processedRanges = [];
      runner.segments = [];
      updateRunnerProgress(runner, 'transcribe', { chunksDone: 0, chunksTotal: chunks.length, processedRanges: [] });

      if (!chunks.length) {
        const result = {
          language: request.languageHint,
          engine: { provider: config.engine.provider, runtimeVersion, modelId: model.descriptor.model.id, modelDigest: model.modelDigest, ...(config.engine.backend ? { backend: config.engine.backend } : {}) },
          segments: [],
          coverage: { requestedRanges: request.requestedRanges, acquiredRanges, processedRanges: [], missingRanges: clone(request.requestedRanges), complete: false },
          speechState: 'unknown',
          warnings: [...initialWarnings, warning('NO_REQUESTED_AUDIO_AVAILABLE', 'No requested source range overlaps an acquired audio range.')],
        };
        await completeWithNeutral(runner, result);
        return;
      }

      let chunkErrors = [];
      let chunkDone = 0;
      for (const chunk of chunks) {
        if (runner.controller.signal.aborted) throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage: 'transcribe' });
        const chunkFile = path.join(jobDir, `chunk-${String(chunk.index).padStart(5, '0')}.wav`);
        const outputBase = path.join(jobDir, `chunk-${String(chunk.index).padStart(5, '0')}-transcript`);
        const checkpointFromJob = jobs.get(activeConsumers(runner)[0]?.jobId);
        const checkpoint = checkpointFromJob ? await loadCheckpoint(checkpointFromJob, chunk, cacheKey) : null;
        if (checkpoint) {
          runner.segments.push(...checkpoint.segments);
          runner.processedRanges = normalizeRanges([...runner.processedRanges, checkpoint.chunk.processedRange], 'processedRanges', { allowEmpty: true });
          chunkDone += 1;
          updateRunnerProgress(runner, 'transcribe', { chunksDone: chunkDone, chunksTotal: chunks.length });
          continue;
        }
        try {
          updateRunnerProgress(runner, 'extract', { chunksDone: chunkDone, chunksTotal: chunks.length });
          await extractChunk(normalizedFile, chunkFile, tools.ffmpegPath, chunk.localStartMs, chunk.durationMs, { signal: runner.controller.signal, spawnImpl, cwd: jobDir });
          updateRunnerProgress(runner, 'transcribe', { chunksDone: chunkDone, chunksTotal: chunks.length });
          const chunkSegments = await transcribeChunk({
            executable: config.engine.executable,
            modelPath: model.descriptor.model.path,
            runtimeVersion,
            language: request.languageHint,
            backend: config.engine.backend,
            audioPath: chunkFile,
            outputBase,
            durationMs: chunk.durationMs,
            signal: runner.controller.signal,
            spawnImpl,
            cwd: jobDir,
          });
          const mappedSegments = mapChunkSegments(chunkSegments, chunk);
          const checkpointPayload = { schemaVersion: SCHEMA_VERSION, cacheKey, chunk, segments: mappedSegments, digest: crypto.createHash('sha256').update(stableStringify({ cacheKey, chunk, segments: mappedSegments })).digest('hex') };
          for (const consumer of activeConsumers(runner)) atomicWriteJson(checkpointFile(consumer.jobId, chunk.index), checkpointPayload);
          runner.segments.push(...mappedSegments);
          runner.processedRanges = normalizeRanges([...runner.processedRanges, chunk.processedRange], 'processedRanges', { allowEmpty: true });
          chunkDone += 1;
          updateRunnerProgress(runner, 'transcribe', { chunksDone: chunkDone, chunksTotal: chunks.length });
        } catch (error) {
          if (runner.controller.signal.aborted) throw error;
          chunkErrors.push(errorRecord(error));
          runner.warnings.push(warning(error?.code || 'CHUNK_FAILED', `Audio range ${chunk.processedRange.startMs}-${chunk.processedRange.endMs} ms could not be processed.`));
          chunkDone += 1;
          updateRunnerProgress(runner, 'transcribe', { chunksDone: chunkDone, chunksTotal: chunks.length });
        }
      }

      const allSegments = deduplicateBoundarySegments(runner.segments, CHUNK_OVERLAP_MS);
      const processedRanges = normalizeRanges(runner.processedRanges, 'processedRanges', { allowEmpty: true });
      const effectiveProcessed = intersectRanges(processedRanges, acquiredRanges);
      const missingRanges = subtractRanges(request.requestedRanges, effectiveProcessed);
      const complete = missingRanges.length === 0 && request.asset.sourceDurationMs !== null;
      const warnings = [...runner.warnings];
      if (chunkErrors.length) warnings.push(warning('CHUNK_PROCESSING_FAILED', 'One or more audio chunks failed; the job contains explicit partial coverage.'));
      const speechState = allSegments.length ? 'speech' : (complete && normalizedStats.exactSilence && missingRanges.length === 0 ? 'no_speech' : 'unknown');
      const neutral = {
        language: request.languageHint,
        engine: {
          provider: config.engine.provider || 'whisper.cpp',
          runtimeVersion,
          modelId: model.descriptor.model.id,
          modelDigest: model.modelDigest,
          ...(config.engine.backend ? { backend: config.engine.backend } : {}),
        },
        segments: allSegments,
        coverage: {
          requestedRanges: request.requestedRanges,
          acquiredRanges,
          processedRanges,
          missingRanges,
          complete,
        },
        speechState,
        warnings,
      };
      if (!processedRanges.length && chunkErrors.length) throw fail(chunkErrors[0].code, chunkErrors[0].error, chunkErrors[0].hint, { retryable: chunkErrors[0].retryable, stage: chunkErrors[0].stage });
      await completeWithNeutral(runner, neutral);
    } catch (error) {
      if (runner.controller.signal.aborted && error?.code === 'ASR_CANCELLED') return;
      await failRunner(runner, error);
    }
  }

  async function pump() {
    if (pumping || activeRunner || disposed || !lockOwned) return;
    pumping = true;
    try {
      while (queue.length && !activeRunner && !disposed) {
        const runner = queue.shift();
        if (!runner || !activeConsumers(runner).length) {
          if (runner) runners.delete(runner.key);
          continue;
        }
        activeRunner = runner;
        runner.promise = runRunner(runner);
        try { await runner.promise; } catch {}
        runners.delete(runner.key);
        activeRunner = null;
      }
    } finally {
      pumping = false;
      if (queue.length && !activeRunner && !disposed) schedulePump();
    }
  }

  function loadPersistedJobs() {
    let dirs = [];
    try { dirs = fs.readdirSync(jobsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch {}
    const queued = [];
    for (const dir of dirs) {
      try {
        validateJobId(dir);
        const file = jobFile(dir);
        const job = readJson(file);
        if (!job || job.schemaVersion !== SCHEMA_VERSION || job.jobId !== dir || !JOB_STATES.has(job.state) || !job.request || !job.execution) continue;
        if (job.state === 'running') {
          job.state = 'interrupted';
          job.error = errorRecord(fail('ASR_HOST_RESTARTED', 'The Host stopped while this ASR job was running.', 'Call resume for this job to reverify the asset, model, and saved chunk checkpoints.', { retryable: true, stage: 'recovery' }));
          job.finishedAt = nowIso();
          job.progress = { ...job.progress, phase: 'interrupted' };
          persist(job);
        }
        jobs.set(job.jobId, job);
        if (job.state === 'queued') queued.push(job);
      } catch {}
    }
    for (const job of queued) addJobToRunner(job);
  }

  async function initialize() {
    try {
      for (const dir of [perceptionRoot, asrRoot, jobsRoot, cacheRoot, modelsRoot, assetsRoot]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (fs.realpathSync(dir) !== path.resolve(dir)) throw fail('DATA_ROOT_INVALID', 'The perception data directory resolves outside its managed location.', 'Remove the unexpected directory link and restart the Host with a trusted data root.', { stage: 'initialize' });
        try { fs.chmodSync(dir, 0o700); } catch {}
      }
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        if (disposed) return;
        try { acquireLock(); break; } catch (error) {
          if (error?.code !== 'ASR_HOST_ALREADY_RUNNING' || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
        }
      }
      if (disposed) { releaseLock(); return; }
      activationError = null;
      loadPersistedJobs();
      schedulePump();
    } catch (error) {
      if (lockOwned) releaseLock();
      activationError = errorRecord(error);
    }
  }

  const ready = initialize();
  let retryingActivation = null;
  async function ensureReady() {
    await ready;
    if (!disposed && activationError?.code === 'ASR_HOST_ALREADY_RUNNING') {
      if (!retryingActivation) retryingActivation = initialize().finally(() => { retryingActivation = null; });
      await retryingActivation;
    }
  }

  async function submit(input) {
    // Captures character/activity synchronously before any wait for Host initialization.
    const request = normalizeRequest(input, { getCharacter, now, id: makeId });
    await ensureReady();
    requireOwner();
    const executionSnapshot = clone(execution);
    if (request.asset.durationMs <= resourcePolicy.maxDurationMs) checkQueueCapacity(request, executionSnapshot);
    const job = createJob(request, executionSnapshot);
    if (!failDeclaredDuration(job)) addJobToRunner(job);
    return { jobId: job.jobId };
  }

  async function getJob(jobId) {
    await ensureReady();
    requireOwner();
    validateJobId(jobId);
    const job = jobs.get(jobId) || readJson(jobFile(jobId));
    if (!job) throw fail('JOB_NOT_FOUND', 'The ASR job could not be found.', 'Check the job ID and use the local ASR jobs list to find the current record.', { stage: 'lookup' });
    return publicJob(job);
  }

  async function listJobs({ characterId, state, limit = 100 } = {}) {
    await ensureReady();
    requireOwner();
    const max = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100;
    return [...jobs.values()]
      .filter((job) => (!characterId || job.characterId === characterId) && (!state || job.state === state))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max)
      .map(publicJob);
  }

  async function cancel(jobId) {
    await ensureReady();
    requireOwner();
    validateJobId(jobId);
    const job = jobs.get(jobId);
    if (!job) throw fail('JOB_NOT_FOUND', 'The ASR job could not be found.', 'Check the job ID and use the local ASR jobs list to find the current record.', { stage: 'cancel' });
    if (TERMINAL_STATES.has(job.state) || job.state === 'interrupted') return publicJob(job);
    const runner = runners.get(job.cacheKey);
    job.state = 'cancelled';
    job.error = errorRecord(fail('ASR_CANCELLED', 'The ASR job was cancelled.', 'Submit a new local ASR job if this audio is still needed.', { stage: 'cancel' }));
    job.finishedAt = nowIso();
    job.progress = { ...job.progress, phase: 'cancelled' };
    persist(job);
    runner?.consumerIds.delete(jobId);
    if (runner && !activeConsumers(runner).length) {
      if (runner.state === 'queued') {
        const index = queue.indexOf(runner);
        if (index >= 0) queue.splice(index, 1);
        runners.delete(runner.key);
      } else if (runner.state === 'running') {
        runner.controller?.abort();
        if (runner.promise) await runner.promise;
      }
    }
    return publicJob(job);
  }

  async function resume(jobId) {
    await ensureReady();
    requireOwner();
    validateJobId(jobId);
    const original = jobs.get(jobId);
    if (!original) throw fail('JOB_NOT_FOUND', 'The ASR job could not be found.', 'Check the job ID and use the local ASR jobs list to find the current record.', { stage: 'resume' });
    if (!['interrupted', 'partial', 'failed'].includes(original.state)) {
      throw fail('JOB_NOT_RESUMABLE', 'This ASR job is not interrupted or partial.', 'Only interrupted, partial, or failed jobs can be resumed as a new linked attempt.', { stage: 'resume' });
    }
    let current;
    try { current = typeof getCharacter === 'function' ? getCharacter() : null; } catch (error) {
      throw fail('CHARACTER_UNAVAILABLE', 'The current character could not be read.', 'Reload the SurfCore Host and retry after the active character is available.', { retryable: true, stage: 'resume', cause: error });
    }
    if (!current || current.id !== original.characterId || current.epoch !== original.characterEpoch) {
      throw fail('STALE_CHARACTER', 'The job belongs to a different character or an earlier character epoch.', 'Submit a new job for the current character; the old job remains available for inspection.', { stage: 'resume' });
    }
    const previousRequest = { ...clone(original.request) };
    delete previousRequest.jobId;
    const request = normalizeRequest(previousRequest, { getCharacter: () => current, now, id: makeId });
    const executionSnapshot = clone(original.execution);
    if (request.asset.durationMs <= resourcePolicy.maxDurationMs) checkQueueCapacity(request, executionSnapshot);
    const next = createJob(request, executionSnapshot, { retryOf: original.jobId, checkpointFrom: original.jobId });
    if (!failDeclaredDuration(next)) addJobToRunner(next);
    return { jobId: next.jobId, retryOf: original.jobId };
  }

  async function doctor() {
    await ensureReady();
    if (activationError) {
      const record = errorRecord(activationError);
      return { ok: false, ready: false, code: record.code, error: record.error, hint: record.hint, active: false };
    }
    if (!lockOwned) return { ok: false, ready: false, code: 'ASR_HOST_ALREADY_RUNNING', error: 'This Host instance does not own the local ASR queue.', hint: 'Use the existing Host instance or close it before opening another.', active: false };
    const readiness = await describe(execution);
    return { ...readiness, active: !disposed, busy: Boolean(activeRunner || queue.length), queuedJobs: queue.reduce((sum, runner) => sum + activeConsumers(runner).length, 0), runningJobs: activeRunner ? activeConsumers(activeRunner).length : 0 };
  }

  async function getStatus() {
    return await doctor();
  }

  async function listModels() {
    await ensureReady();
    if (activationError) {
      const record = errorRecord(activationError);
      return { ok: false, code: record.code, error: record.error, hint: record.hint, models: [] };
    }
    const manifestFile = path.join(modelsRoot, 'manifest.json');
    const manifest = readJson(manifestFile);
    const listed = Array.isArray(manifest?.models) ? manifest.models.filter((model) => model && typeof model.id === 'string').map((model) => ({
      id: model.id,
      ...(typeof model.sha256 === 'string' ? { sha256: model.sha256.toLowerCase() } : {}),
      configured: Boolean(execution.engine?.model?.id === model.id),
      verified: false,
    })) : [];
    if (execution.engine?.model?.id && !listed.some((model) => model.id === execution.engine.model.id)) {
      listed.push({ id: execution.engine.model.id, sha256: execution.engine.model.sha256, configured: true, verified: false });
    }
    const readiness = await doctor();
    return { ok: readiness.ok, ...(readiness.ok ? {} : { code: readiness.code, error: readiness.error, hint: readiness.hint }), configuredModelId: execution.engine?.model?.id || null, models: listed };
  }

  async function configure(next = {}) {
    await ensureReady();
    requireOwner();
    const active = [...jobs.values()].some((job) => job.state === 'queued' || job.state === 'running');
    if (active) throw fail('ASR_CONFIG_BUSY', 'ASR configuration cannot change while jobs are queued or running.', 'Wait for active jobs to finish, or cancel them before changing the runtime or model.', { retryable: true, stage: 'configure' });
    const allowed = {};
    if (Object.hasOwn(next, 'engine')) allowed.engine = next.engine;
    if (Object.hasOwn(next, 'ffmpegPath')) allowed.ffmpegPath = next.ffmpegPath;
    if (Object.hasOwn(next, 'ffprobePath')) allowed.ffprobePath = next.ffprobePath;
    if (Object.hasOwn(next, 'ffmpeg')) allowed.ffmpeg = next.ffmpeg;
    if (Object.hasOwn(next, 'ffprobe')) allowed.ffprobe = next.ffprobe;
    execution = normalizeExecution({ ...execution, ...allowed });
    hashCache.clear();
    versionCache.clear();
    return await doctor();
  }

  async function dispose() {
    if (disposed) return { disposed: true };
    disposed = true;
    await ready;
    if (retryingActivation) await retryingActivation;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    if (activeRunner) {
      const reason = errorRecord(fail('ASR_HOST_SHUTDOWN', 'The Host is stopping while this ASR job is running.', 'Resume this job after the Host restarts to reverify the asset and model.', { retryable: true, stage: 'shutdown' }));
      for (const job of activeConsumers(activeRunner)) {
        job.state = 'interrupted';
        job.error = reason;
        job.finishedAt = nowIso();
        job.progress = { ...job.progress, phase: 'interrupted' };
        persist(job);
      }
      activeRunner.controller?.abort();
      if (activeRunner.promise) await activeRunner.promise;
    }
    releaseLock();
    return { disposed: true };
  }

  return {
    ready,
    submit,
    getJob,
    listJobs,
    cancel,
    resume,
    doctor,
    listModels,
    getStatus,
    configure,
    dispose,
  };
}
