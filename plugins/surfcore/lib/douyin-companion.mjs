import path from 'node:path';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { createCompanionMemory } from './douyin-companion-memory.mjs';
import { COMPANION_ROUTE } from './douyin-companion-model.mjs';
import crypto from 'node:crypto';
import { createDouyinCompanionStore } from './douyin-companion-ledger.mjs';
import { buildDouyinReflectionSystem, parseDouyinReflection } from './douyin-companion-reflection.mjs';
import {
  CompanionError, problem, check, isRecord, safeCode as legacySafeCode, safeDisplayText, scrubPromptText,
  normalizeRole, roleKey, timestamp, safeSourceUrl, safeSourceId, frameImage, cleanCoverage, shanghaiParts,
} from './douyin-companion-utils.mjs';

const safeCode = (value, fallback) => /^(?:MEMORY|MODEL|COMPANION|CHARACTER|BUDGET)_[A-Z0-9_]{1,72}$/.test(String(value ?? '')) ? value : legacySafeCode(value, fallback);
const MAX_ACCEPTANCE_CALLS = 12;
const MAX_DAILY_ROUNDS = 2;
const MAX_DAILY_CALLS = 8;
const MAX_ROUND_CALLS = 4;
const MAX_ITEMS = 2;
const MAX_FRAME_SAMPLES = 3;
const MODEL_TIMEOUT_MS = 180_000;
const MODEL_MAX_TOKENS = 8192;
const ACTIVE = new Set(['queued', 'running']);
const JOB_STATES = new Set(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const JOB_PHASES = new Set(['queued', 'readiness', 'feed', 'context', 'perceive', 'model', 'memory', 'finished', 'failed', 'cancelled', 'interrupted']);
const ITEM_STATES = new Set(['skipped', 'partial', 'completed']);

function contextSection(built, kind) {
  const sections = built?.sections;
  const value = isRecord(sections) ? sections[kind] : Array.isArray(sections) ? sections.find(section => section?.kind === kind) : null;
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'value']) if (typeof value[key] === 'string') return value[key];
  }
  return null;
}
export function createDouyinCompanion({
  stateDir, getCharacter, readFeed, perceive, modelCall, buildContext, recordMemory, recordSharing = null, readiness,
  memoryV2, getModelRequest, now = () => new Date(), callbackTimeoutMs = 180_000,
} = {}) {
  const v2 = createCompanionMemory({ stateDir, getCharacter, memoryV2 });
  if (!path.isAbsolute(String(stateDir ?? '')) || typeof getCharacter !== 'function' || typeof readFeed !== 'function' ||
      typeof perceive !== 'function' || typeof modelCall !== 'function' || typeof buildContext !== 'function' ||
      typeof recordMemory !== 'function' || (recordSharing !== null && typeof recordSharing !== 'function') || typeof readiness !== 'function') {
    throw problem('DOUYIN_CONFIG_INVALID', '抖音陪伴服务配置不完整。', '检查本地 Host 回调接线后再试。');
  }
  const store = createDouyinCompanionStore(stateDir, () => nowIso());
  const operationTimeout = Math.max(1_000, Math.min(180_000, Number(callbackTimeoutMs) || 180_000));
  let localLedger = null;
  let activeJob = null;
  let runnerPromise = null;
  const runtimes = new Map();
  let disposed = false;
  let transitionDepth = 0;
  let transitionQueue = Promise.resolve();

  function nowValue() { return now(); }
  function nowIso() { return timestamp(nowValue()); }
  function readLedger() {
    const ledger = store.readLedger();
    localLedger = ledger;
    return ledger;
  }
  function writeLedger(ledger) { store.writeLedger(ledger); localLedger = ledger; }
  const acquireLock = () => store.acquireLock();
  const releaseLock = () => { store.releaseLock(); localLedger = null; };
  function serialize(action) {
    const result = transitionQueue.then(action, action);
    transitionQueue = result.catch(() => {});
    return result;
  }
  function currentRole(context) {
    let raw;
    try { raw = getCharacter(context); } catch { raw = null; }
    const role = normalizeRole(raw);
    if (!role || context === undefined || context === null) return role;
    if (!isRecord(context)) return null;
    const hasId = Object.hasOwn(context, 'characterId');
    const hasEpoch = Object.hasOwn(context, 'characterEpoch');
    if (hasId !== hasEpoch) return null;
    if (!hasId) return role;
    return context.characterId === role.id && context.characterEpoch === role.epoch ? role : null;
  }
  function requireCurrentRole(context) {
    if (!isRecord(context) || !Object.hasOwn(context, 'characterId') || !Object.hasOwn(context, 'characterEpoch')) {
      throw problem('DOUYIN_STALE_CHARACTER', '请求没有包含当前角色世代标识。', '刷新当前角色后重新发起；过期上下文不会绑定到新角色。');
    }
    const role = currentRole(context);
    if (!role) throw problem('DOUYIN_STALE_CHARACTER', '请求中的角色或世代已过期。', '刷新当前角色后重新发起；过期上下文不会绑定到新角色。');
    return role;
  }
  function contextStamp(context, role) {
    return { ...(isRecord(context) ? context : {}), characterId: role.id, characterEpoch: role.epoch };
  }
  function getRoleState(ledger, role, create = false) {
    const key = roleKey(role.id);
    let record = ledger.roles[key];
    if (!record && create) {
      record = { characterId: role.id, acceptedEpoch: null, enabled: false, paused: false, lastError: null, days: {} };
      ledger.roles[key] = record;
    }
    return record ?? null;
  }
  function getDayState(roleState, date, create = false) {
    let day = roleState?.days?.[date];
    if (!day && create && roleState) {
      day = { calls: 0, rounds: 0, windows: {} };
      roleState.days[date] = day;
    }
    return day ?? null;
  }
  function saveJob(ledger, job) {
    job.updatedAt = nowIso();
    ledger.jobs[job.jobId] = job;
    writeLedger(ledger);
  }
  function failObject(error, fallback = 'DOUYIN_COMPANION_FAILED') {
    if (error instanceof CompanionError) return { code: error.code, error: error.message, hint: error.hint };
    const code = safeCode(error?.code, fallback);
    return {
      code,
      error: safeDisplayText(error?.message, 240) || '陪伴活动未能完成。',
      hint: safeDisplayText(error?.hint, 300) || '查看状态中的失败阶段，检查本机依赖后再手动操作；不会自动重试。',
    };
  }
  function callbackFailure(value, defaults) {
    const code = safeCode(value?.code, defaults.code);
    const error = safeDisplayText(value?.error, 240) || defaults.error;
    const hint = safeDisplayText(value?.hint, 300) || defaults.hint;
    return problem(code, error, hint);
  }
  function assertRole(job, context, signal) {
    const runtime = runtimes.get(job.jobId);
    signal ??= runtime?.controller?.signal;
    const current = currentRole(context);
    if (!current || current.id !== job.characterId || current.epoch !== job.characterEpoch) {
      if (runtime) runtime.cancelReason = problem('DOUYIN_STALE_CHARACTER', '活动期间角色已切换。', '已停止后续模型和记忆写入；以当前角色重新验收。');
      runtime?.controller?.abort();
      throw runtime?.cancelReason ?? problem('DOUYIN_STALE_CHARACTER', '活动期间角色已切换。', '已停止后续模型和记忆写入；以当前角色重新验收。');
    }
    if (signal?.aborted) throw runtime?.cancelReason ?? problem('DOUYIN_CANCELLED', '陪伴活动已取消。', '检查作业与用量后再决定是否手动重试。');
    if (disposed) throw runtime?.cancelReason ?? problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '重新打开服务后查看保留的活动状态。');
  }
  function abortable(job, operation, timeoutMs, timeoutProblem) {
    const runtime = runtimes.get(job.jobId);
    const signal = runtime?.controller?.signal;
    if (!signal || signal.aborted) return Promise.reject(runtime?.cancelReason ?? problem('DOUYIN_CANCELLED', '陪伴活动已取消。', '检查活动状态后再决定是否重试。'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, runtime.cancelReason ?? problem('DOUYIN_CANCELLED', '陪伴活动已取消。', '检查活动状态后再决定是否重试。'));
      const timer = setTimeout(() => {
        runtime.cancelReason = timeoutProblem;
        runtime.controller.abort();
        finish(reject, timeoutProblem);
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => {
        if (settled || signal.aborted) return undefined;
        return operation();
      }).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async function guarded(job, context, operation, timeoutMs = operationTimeout, timeoutProblem = null) {
    assertRole(job, context);
    let value;
    try { value = await abortable(job, operation, timeoutMs, timeoutProblem ?? problem('DOUYIN_OPERATION_TIMEOUT', '本地依赖等待超时，活动已停止。', '检查本机依赖与网络状态后再手动验收。')); }
    catch (error) {
      assertRole(job, context);
      throw error;
    }
    assertRole(job, context);
    return value;
  }
  function projectedItem(item) {
    const coverage = isRecord(item.coverage) ? item.coverage : {};
    const failure = (item.code || item.error || item.hint) ? {
      code: item.code ? safeCode(item.code) : null,
      error: safeDisplayText(item.error, 240) || null,
      hint: safeDisplayText(item.hint, 300) || null,
    } : { code: null, error: null, hint: null };
    return {
      ...(item.memoryV2Refs ? { memoryV2Refs: item.memoryV2Refs, memoryV2Receipts: item.memoryV2Receipts, memoryV2Receipt: item.memoryV2Receipt } : {}),
      id: safeSourceId(item.id) || '',
      url: safeSourceUrl(item.url) || '',
      title: safeDisplayText(item.title, 240),
      durationMs: Number.isSafeInteger(item.durationMs) && item.durationMs > 0 && item.durationMs <= 120_000 ? item.durationMs : null,
      occurredAt: validIso(item.occurredAt),
      state: ITEM_STATES.has(item.state) ? item.state : 'skipped',
      memorySaved: item.memorySaved === true,
      partial: item.partial === true,
      coverage: {
        status: 'partial',
        transcriptComplete: coverage.transcriptComplete === true,
        missingRanges: Number.isSafeInteger(coverage.missingRanges) ? Math.max(0, coverage.missingRanges) : 0,
        visualCoverage: coverage.visualCoverage === 'sparse' ? 'sparse' : 'none',
        frameSamples: Number.isSafeInteger(coverage.frameSamples) ? Math.min(MAX_FRAME_SAMPLES, Math.max(0, coverage.frameSamples)) : 0,
        warningCount: Number.isSafeInteger(coverage.warningCount) ? Math.min(100, Math.max(0, coverage.warningCount)) : 0,
        acceptanceQualified: coverage.acceptanceQualified === true,
      },
      feeling: ['like', 'mixed', 'neutral', 'dislike'].includes(item.feeling) ? item.feeling : null,
      reason: safeDisplayText(item.reason, 240) || null,
      summary: safeDisplayText(item.summary, 500) || null,
      draft: safeDisplayText(item.draft, 300) || null,
      ...failure,
    };
  }
  function validIso(value) {
    if (typeof value !== 'string' || !value || value.length > 40) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  function projectJob(job) {
    if (!job) return null;
    const failure = (job.code || job.error || job.hint) ? {
      code: job.code ? safeCode(job.code) : null,
      error: safeDisplayText(job.error, 240) || null,
      hint: safeDisplayText(job.hint, 300) || null,
    } : { code: null, error: null, hint: null };
    return {
      ok: true,
      jobId: /^douyin-[0-9a-f-]{36}$/.test(String(job.jobId)) ? job.jobId : '',
      ...(job.memoryV2Refs ? { memoryV2Refs: job.memoryV2Refs, memoryV2Receipts: job.memoryV2Receipts, memoryV2Receipt: job.memoryV2Receipt } : {}),
      mode: ['acceptance', 'daily'].includes(job.mode) ? job.mode : 'acceptance',
      state: JOB_STATES.has(job.state) ? job.state : 'failed',
      phase: JOB_PHASES.has(job.phase) ? job.phase : 'failed',
      characterId: safeSourceId(job.characterId) || '',
      characterEpoch: Number.isSafeInteger(job.characterEpoch) ? Math.max(0, job.characterEpoch) : 0,
      createdAt: validIso(job.createdAt),
      updatedAt: validIso(job.updatedAt),
      completedAt: validIso(job.completedAt),
      calls: Number.isSafeInteger(job.calls) ? Math.min(MAX_ROUND_CALLS, Math.max(0, job.calls)) : 0,
      acceptanceQualified: job.acceptanceQualified === true,
      items: job.items.map(projectedItem),
      ...failure,
    };
  }
  function projectRecoverableJob(job, lockActive) {
    const projected = projectJob(job);
    if (!ACTIVE.has(job.state) || lockActive !== false) return projected;
    return {
      ...projected,
      state: 'interrupted',
      phase: 'interrupted',
      code: 'DOUYIN_INTERRUPTED',
      error: '进程重启打断了这轮陪伴活动。',
      hint: '已预留请求不会返还；检查保留结果后手动决定是否重新验收。',
    };
  }
  function publicError(value) {
    if (!value) return null;
    return { code: safeCode(value.code), error: safeDisplayText(value.error, 240) || '陪伴活动未能完成。', hint: safeDisplayText(value.hint, 300) || '查看失败阶段并检查本地依赖后再手动操作。' };
  }
  function getCurrentWindow(value) {
    const parts = shanghaiParts(value);
    const window = (parts.hour === '12' && parts.minute === '30') ? '12:30' : (parts.hour === '20' && parts.minute === '30') ? '20:30' : '';
    return window ? { ...parts, window } : null;
  }
  function callIssue(error) {
    const fields = failObject(error);
    return { ok: false, state: 'failed', phase: 'failed', ...fields };
  }
  function interruptedJobs(ledger) {
    let changed = false;
    for (const job of Object.values(ledger.jobs)) {
      if (!ACTIVE.has(job.state)) continue;
      const issue = problem('DOUYIN_INTERRUPTED', '进程重启打断了这轮陪伴活动。', '已预留请求不会返还；检查保留结果后手动决定是否重新验收。');
      job.state = 'interrupted'; job.phase = 'interrupted'; job.code = issue.code; job.error = issue.message; job.hint = issue.hint; job.completedAt = nowIso(); job.updatedAt = job.completedAt;
      if (job.mode === 'daily') {
        const role = getRoleState(ledger, { id: job.characterId, epoch: job.characterEpoch }, true);
        role.enabled = false; role.paused = true; role.lastError = publicError(issue);
        const day = getDayState(role, job.scheduleDate, true);
        if (day.windows?.[job.scheduleWindow]) day.windows[job.scheduleWindow] = { state: 'failed', jobId: job.jobId, startedAt: day.windows[job.scheduleWindow].startedAt, error: role.lastError };
      }
      changed = true;
    }
    if (changed) writeLedger(ledger);
  }
  function newJob(mode, role, schedule) {
    const nowAt = nowIso();
    return {
      jobId: `douyin-${crypto.randomUUID()}`,
      mode,
      state: 'queued',
      phase: 'queued',
      characterId: role.id,
      characterEpoch: role.epoch,
      createdAt: nowAt,
      updatedAt: nowAt,
      completedAt: null,
      calls: 0,
      acceptanceQualified: false,
      scheduleDate: schedule?.date ?? null,
      scheduleWindow: schedule?.window ?? null,
      items: [],
    };
  }
  function ensureReadiness(result) {
    if (!result || result.ok !== true) throw callbackFailure(result, {
      code: 'DOUYIN_NOT_READY', error: '抖音陪伴当前不可用。', hint: '查看依赖状态并按提示恢复后再手动启动。',
    });
  }
  function maybeAbortForRole(job, context) {
    const runtime = runtimes.get(job.jobId);
    const role = currentRole(context);
    if (!role || role.id !== job.characterId || role.epoch !== job.characterEpoch) {
      runtime.cancelReason = problem('DOUYIN_STALE_CHARACTER', '活动期间角色已切换。', '已停止后续模型和记忆写入；以当前角色重新验收。');
      runtime.controller.abort();
    }
  }
  function startRoleWatch(job, context) {
    const runtime = runtimes.get(job.jobId);
    runtime.roleWatch = setInterval(() => maybeAbortForRole(job, context), 50);
    runtime.roleWatch.unref?.();
  }
  function clearRoleWatch(job) { const runtime = runtimes.get(job.jobId); if (runtime?.roleWatch) clearInterval(runtime.roleWatch); if (runtime) runtime.roleWatch = null; }
  function reservationDate(job) { return job.scheduleDate || shanghaiParts(nowValue()).date; }
  function reserveCall(job) {
    const runtime = runtimes.get(job.jobId);
    assertRole(job, runtime?.context);
    check(job.calls < MAX_ROUND_CALLS, 'DOUYIN_ROUND_CALL_LIMIT', '本轮模型调用次数已用尽。', '检查已有活动结果；不会自动重试。');
    const ledger = localLedger;
    check(ledger, 'DOUYIN_STATE_UNAVAILABLE', '陪伴账本未锁定，无法安全预留模型请求。', '重新取得全局实例锁后再手动启动。');
    if (job.mode === 'acceptance') {
      check(ledger.acceptanceCalls < MAX_ACCEPTANCE_CALLS, 'DOUYIN_ACCEPTANCE_BUDGET_EXHAUSTED', '本轮手动验收的12次客户端请求额度已用尽。', '查看已保存的活动结果；需要新额度时由主线明确授权。');
      ledger.acceptanceCalls += 1;
    } else {
      const role = getRoleState(ledger, { id: job.characterId, epoch: job.characterEpoch }, true);
      const day = getDayState(role, reservationDate(job), true);
      check(day.calls < MAX_DAILY_CALLS, 'DOUYIN_DAILY_CALL_LIMIT', '该角色今日8次日常客户端请求额度已用尽。', '检查本日活动账本；额度不会因重启或角色快照回档重置。');
      day.calls += 1;
    }
    job.calls += 1;
    saveJob(ledger, job);
  }
  function retainProvenance(job, item, saved, phase) {
    const receipt = { ...saved.receipt, phase };
    for (const target of [job, item]) {
      target.memoryV2Refs = [...(target.memoryV2Refs ?? []), ...saved.refs];
      target.memoryV2Receipts = [...(target.memoryV2Receipts ?? []), receipt];
      target.memoryV2Receipt = receipt;
    }
  }
  async function processOne(job, context, entry, index, sharedContext, trustedPersona = '') {
    const activityId = `${job.jobId}-${index + 1}`;
    const runtime = runtimes.get(job.jobId);
    const item = {
      id: entry.id,
      url: entry.url,
      title: entry.title,
      durationMs: entry.durationMs,
      occurredAt: null,
      state: 'skipped',
      memorySaved: false,
      partial: true,
      coverage: { status: 'partial', transcriptComplete: false, missingRanges: 0, visualCoverage: 'none', frameSamples: 0, warningCount: 0, acceptanceQualified: false },
    };
    let session;
    job.items.push(item);
    saveJob(localLedger, job);
    try {
      const routing = v2.routing();
      check(routing.ok, routing.code, routing.error, routing.hint);
      session = await v2.capture(context, 'douyin:homepage-recommendation');
      const input = { id: entry.id, url: entry.url, title: entry.title, durationMs: entry.durationMs, mediaSource: entry.mediaSource, mediaUserAgent: entry.mediaUserAgent };
      job.phase = 'perceive'; saveJob(localLedger, job);
      let perceived;
      try {
        perceived = await guarded(job, context, () => perceive(input, context, { signal: runtime.controller.signal, activityId }));
      } catch (error) {
        if (runtime.controller.signal.aborted) throw error;
        throw problem('DOUYIN_PERCEPTION_FAILED', '无法读取这条推荐的音轨与画面采样。', '检查本机感知状态后重新手动验收。');
      }
      check(isRecord(perceived) && perceived.ok === true, safeCode(perceived?.code, 'DOUYIN_PERCEPTION_FAILED'), safeDisplayText(perceived?.error, 240) || '无法读取这条推荐的音轨与画面采样。', safeDisplayText(perceived?.hint, 300) || '检查本机感知状态后重新手动验收。');
      const perceivedId = safeSourceId(perceived.id);
      const perceivedUrl = safeSourceUrl(perceived.url);
      const actualDuration = perceived.durationMs;
      check(Number.isSafeInteger(actualDuration) && actualDuration > 0 && actualDuration <= 120_000, 'DOUYIN_ACTUAL_DURATION_INVALID', '本机媒体识别出的实际视频时长不在安全范围内。', '确认本机视频时长与媒体解析结果后再重新验收。');
      check(perceivedId === entry.id && perceivedUrl === entry.url && perceived.source === 'homepage-recommendation', 'DOUYIN_PERCEPTION_IDENTITY_MISMATCH', '感知结果与本轮首页推荐来源不一致。', '保留活动状态并检查首页来源后再手动验收。');
      const observedAt = timestamp(perceived.observedAt);
      item.durationMs = actualDuration;
      item.occurredAt = observedAt;
      const transcriptText = typeof perceived.transcript?.text === 'string' ? perceived.transcript.text.trim() : '';
      const coverage = cleanCoverage(perceived.transcript, actualDuration);
      const images = (Array.isArray(perceived.frames) ? perceived.frames : []).map(frame => frameImage(frame, actualDuration)).filter(Boolean).slice(0, MAX_FRAME_SAMPLES);
      const visualCoverage = images.length ? 'sparse' : 'none';
      const warnings = Array.isArray(perceived.warnings) ? perceived.warnings.length : 0;
      const partial = !coverage.complete || coverage.missingRanges.length > 0 || visualCoverage !== 'complete';
      item.coverage = { status: 'partial', transcriptComplete: coverage.complete, missingRanges: coverage.missingRanges.length, visualCoverage, frameSamples: images.length, warningCount: Math.min(100, warnings), acceptanceQualified: false };
      saveJob(localLedger, job);
      if (session) {
        const saved = await v2.observe(session, { jobId: job.jobId, activityId, entry, perceived, images });
        retainProvenance(job, item, saved, 'source'); saveJob(localLedger, job);
        const built = await v2.prepareStep(session, JSON.stringify({ objectId: entry.id, transcript: transcriptText }));
        sharedContext = built.memoryText; trustedPersona = built.personaText;
      }
      check(transcriptText.length <= 50_000, 'DOUYIN_TRANSCRIPT_TOO_LARGE', '转写内容超过本地单条输入上限，未提交模型。', '选择更短的推荐视频或调整本地转写长度限制。');
      check(images.length > 0, 'DOUYIN_FRAMES_UNAVAILABLE', '没有可用的稀疏画面采样，未调用模型。', '补齐本机画面采样后再手动验收；音频单独不足以完成本轮。');
      check(transcriptText.length > 0 && coverage.speechState === 'speech', 'DOUYIN_TRANSCRIPT_EMPTY', '没有可确认的语音转写用于解释这条推荐。', '选择含可辨语音的推荐视频后再手动验收。');
      assertRole(job, context);
      const inputPayload = {
        source: { type: 'homepage recommendation', title: entry.title || '[标题已隐藏]' },
        durationMs: actualDuration,
        transcript: transcriptText,
        transcriptCoverage: coverage,
        visualCoverage: 'sparse image samples only; full-video visual coverage is not available',
        frameTimesMs: images.map(frame => frame.atMs),
        context: scrubPromptText(sharedContext, 12_000),
      };
      if (trustedPersona.trim()) inputPayload.persona = scrubPromptText(trustedPersona, 4_000);
      const system = buildDouyinReflectionSystem({ sharingEnabled: typeof recordSharing === 'function', trustedPersonaIncluded: Boolean(trustedPersona.trim()) });
      const prompt = JSON.stringify(inputPayload);
      let requestMetadata;
      if (session) {
        const bound = await v2.bindStep(session, { system, prompt, images });
        retainProvenance(job, item, bound, 'model-input');
        check(typeof getModelRequest === 'function', 'DOUYIN_MODEL_METADATA_REQUIRED', 'V2缺少可信逐步预算请求元数据。', '接入Host稳定请求编号、真实路由与估计量；不会猜测价格或编号。');
      }
      if (typeof getModelRequest === 'function') {
        requestMetadata = getModelRequest({ jobId: job.jobId, activityId, step: index + 1, characterId: context.characterId, characterEpoch: context.characterEpoch,
          providerRouteId: deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId, model: COMPANION_ROUTE.model, system, prompt, images });
        check(requestMetadata && typeof requestMetadata.then !== 'function', 'DOUYIN_MODEL_METADATA_REQUIRED', '预算请求元数据必须由可信同步回调提供。', '按实际步骤提供稳定请求编号与路由。');
      }
      if (session) check(requestMetadata.providerRouteId === session.sourceStamp.providerRouteId && requestMetadata.model === COMPANION_ROUTE.model && requestMetadata.role === context.characterId && requestMetadata.epoch === context.characterEpoch, 'COMPANION_ROUTE_MISMATCH', '逐步模型元数据与原始上下文授权不一致。', '核对固定provider/model与旧句柄授权后重新开始，不会改写旧grant。');
      const beforeSend = async ({ phase } = {}) => {
        assertRole(job, context);
        if (session) await v2.validate(session, phase !== 'completion');
        else { const route = v2.routing(); check(route.ok, route.code || 'MEMORY_ROUTING_CHANGED', route.error || '活动期间记忆路由已变化。', route.hint || '以当前可信路由重新开始。'); }
        return { ok: true };
      };
      await beforeSend();
      reserveCall(job);
      job.phase = 'model'; saveJob(localLedger, job);
      let result;
      try {
        result = await guarded(job, context, () => modelCall({
          system, prompt, images, requestMetadata, beforeSend, ...(session ? { admitNetwork: (dispatch, options) => v2.admitNetwork(session, dispatch, options) } : {}), signal: runtime.controller.signal, maxTokens: MODEL_MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS,
        }), MODEL_TIMEOUT_MS, problem('DOUYIN_MODEL_TIMEOUT', '模型调用超过180秒上限，活动已取消。', '检查模型连接与已用请求数；失败请求仍计入额度，不会自动重试。'));
      } catch (error) {
        if (runtime.controller.signal.aborted) throw error;
        if (session && error?.code) throw error;
        throw problem('DOUYIN_MODEL_FAILED', '模型调用失败。', '检查模型连接和请求账本；不会自动客户端重试。');
      }
      check(isRecord(result) && typeof result.text === 'string' && ['stop', 'end_turn', 'completed'].includes(String(result.finishReason ?? '')), 'DOUYIN_MODEL_INCOMPLETE', '模型没有正常完成并返回文本。', '检查模型服务状态；失败请求仍计入额度，不会自动重试。');
      if (session) await v2.validate(session);
      const review = parseDouyinReflection(result.text, { sharingEnabled: typeof recordSharing === 'function' });
      item.state = partial ? 'partial' : 'completed';
      item.feeling = review.feeling;
      item.reason = review.reason;
      item.summary = review.summary;
      item.draft = review.draft;
      saveJob(localLedger, job);
      const qualified = coverage.complete && coverage.missingRanges.length === 0 && coverage.speechState === 'speech' && images.length > 0 && transcriptText.length > 0;
      job.phase = 'memory'; saveJob(localLedger, job);
      const memoryPayload = {
        activityId,
        id: entry.id,
        title: entry.title,
        occurredAt: observedAt,
        summary: review.summary,
        reason: review.reason,
        coverage: { ...coverage, visualCoverage: 'sparse', frameSamples: images.length, status: 'partial' },
      };
      let memory;
      try {
        assertRole(job, context);
        memory = await guarded(job, context, () => session ? v2.reflect(session, memoryPayload) : recordMemory(context, memoryPayload, { signal: runtime.controller.signal }), operationTimeout,
          problem('DOUYIN_MEMORY_TIMEOUT', '记忆写入等待超时，活动已停止。', '检查Host记忆服务与请求状态；不会自动重复写入。'));
      } catch (error) {
        if (runtime.controller.signal.aborted) throw error;
        if (session && error?.code) throw error;
        throw problem('DOUYIN_MEMORY_FAILED', '模型结果未能写入当前角色记忆。', '检查Host记忆服务与角色归属；原始草稿仍在本机作业状态中。');
      }
      check(memory?.ok === true, safeCode(memory?.code, 'DOUYIN_MEMORY_FAILED'), safeDisplayText(memory?.error, 240) || '模型结果未能写入当前角色记忆。', safeDisplayText(memory?.hint, 300) || '检查Host记忆服务与角色归属后再手动恢复。');
      if (session) { retainProvenance(job, item, memory, 'reflection'); await v2.validate(session); }
      item.state = partial ? 'partial' : 'completed';
      item.partial = partial;
      item.memorySaved = true;
      item.coverage = { ...item.coverage, acceptanceQualified: qualified };
      job.acceptanceQualified ||= qualified;
      saveJob(localLedger, job);
      if (typeof recordSharing === 'function') {
        try {
          assertRole(job, context);
          const saved = await guarded(job, context, () => recordSharing(context, {
            jobId: job.jobId,
            mode: job.mode,
            id: entry.id,
            title: entry.title,
            occurredAt: observedAt,
            share: review.share,
            question: review.question,
            coverage: item.coverage,
            ...(session ? { memoryV2Refs: job.memoryV2Refs, memoryV2Receipts: job.memoryV2Receipts, memoryV2Receipt: job.memoryV2Receipt } : {}),
          }, { signal: runtime.controller.signal }), operationTimeout,
          problem('DOUYIN_SHARING_SAVE_FAILED', '自然开场没有保存到本机日记。', '观看记忆已保存；检查本地分享记录服务后手动恢复，不会自动重试。'));
          check(saved?.ok === true, 'DOUYIN_SHARING_SAVE_FAILED', '自然开场没有保存到本机日记。', '观看记忆已保存；检查本地分享记录服务后手动恢复，不会自动重试。');
        } catch (error) {
          if (runtime.controller.signal.aborted || ['DOUYIN_STALE_CHARACTER', 'DOUYIN_CANCELLED', 'DOUYIN_CLOSED', 'DOUYIN_CHANNEL_DISABLED', 'DOUYIN_TRANSITION_CANCELLED'].includes(error?.code)) throw error;
          throw problem('DOUYIN_SHARING_SAVE_FAILED', '自然开场没有保存到本机日记。', '观看记忆已保存；检查本地分享记录服务后手动恢复，不会自动重试。');
        }
      }
    } catch (error) {
      if (session || memoryV2 || /^(?:MEMORY|CHARACTER)_/.test(error?.code ?? '')) {
        const blocked = await v2.blocked(session, error, { jobId: job.jobId, characterId: context.characterId, characterEpoch: context.characterEpoch });
        error = Object.assign(new Error(blocked.error), blocked);
        const runtime = runtimes.get(job.jobId);
        if (runtime) { runtime.cancelReason = error; runtime.controller.abort(); }
        delete item.feeling; delete item.reason; delete item.summary; delete item.draft;
      }
      const failure = failObject(error);
      item.state = item.feeling ? 'partial' : 'skipped';
      item.partial = true;
      item.code = failure.code;
      item.error = failure.error;
      item.hint = failure.hint;
      saveJob(localLedger, job);
      throw error;
    } finally { v2.release(session); }
  }
  async function runJob(job, context) {
    startRoleWatch(job, context);
    try {
      assertRole(job, context);
      job.state = 'running'; job.phase = 'readiness'; saveJob(localLedger, job);
      const ready = await guarded(job, context, () => readiness(context));
      ensureReadiness(ready);
      job.phase = 'feed'; saveJob(localLedger, job);
      let feed;
      try { feed = await guarded(job, context, () => readFeed(context)); }
      catch (error) { if (runtimes.get(job.jobId).controller.signal.aborted) throw error; throw problem('DOUYIN_FEED_FAILED', '读取抖音首页推荐失败。', '检查登录账号和推荐页状态后重新手动验收。'); }
      check(feed?.ok === true && Array.isArray(feed.items), safeCode(feed?.code, 'DOUYIN_FEED_FAILED'), safeDisplayText(feed?.error, 240) || '读取抖音首页推荐失败。', safeDisplayText(feed?.hint, 300) || '检查登录账号和推荐页状态后重新手动验收。');
      const candidates = [];
      const seen = new Set();
      for (const raw of feed.items) {
        if (candidates.length >= MAX_ITEMS) break;
        if (!isRecord(raw)) continue;
        const id = safeSourceId(raw.id);
        const url = safeSourceUrl(raw.url);
        const durationMs = raw.durationMs;
        if (!id || !url || seen.has(id) || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 120_000) continue;
        seen.add(id);
        candidates.push({ id, url, title: safeDisplayText(raw.title, 240) || '', durationMs, mediaSource: raw.mediaSource, mediaUserAgent: raw.mediaUserAgent });
      }
      if (!candidates.length) throw problem('DOUYIN_NO_QUALIFIED_MATERIAL', '首页推荐中没有时长合规且来源可验证的素材。', '检查首页推荐是否可用；没有合格素材时不会调用模型或记为观看。');
      job.phase = 'context'; saveJob(localLedger, job);
      const route = v2.routing();
      check(route.ok, route.code, route.error, route.hint);
      let built;
      try { built = { ok: true, text: '', memoryText: '', personaText: '' }; }
      catch (error) { if (runtimes.get(job.jobId).controller.signal.aborted) throw error; throw problem('DOUYIN_CONTEXT_FAILED', '无法读取当前角色的记忆上下文。', '检查当前角色和Host记忆服务后重新手动验收。'); }
      check(built?.ok === true && typeof built.text === 'string', safeCode(built?.code, 'DOUYIN_CONTEXT_FAILED'), safeDisplayText(built?.error, 240) || '无法读取当前角色的记忆上下文。', safeDisplayText(built?.hint, 300) || '检查当前角色和Host记忆服务后重新手动验收。');
      const trustedPersona = contextSection(built, 'persona') ?? (typeof built.personaText === 'string' ? built.personaText : '');
      const memoryContext = contextSection(built, 'memory') ?? (typeof built.memoryText === 'string' ? built.memoryText : built.text);
      for (let index = 0; index < candidates.length; index++) {
        assertRole(job, context);
        await processOne(job, context, candidates[index], index, memoryContext, trustedPersona);
      }
      check(job.items.some(item => item.state === 'partial' || item.state === 'completed'), 'DOUYIN_NO_QUALIFIED_MATERIAL', '没有足够完整的音轨与画面采样可供解释。', '补齐素材后重新手动验收；未合格素材不记为观看。');
      job.state = job.items.some(item => item.state === 'skipped' || item.partial) ? 'partial' : 'completed';
      job.phase = 'finished'; job.code = null; job.error = null; job.hint = null;
      if (job.mode === 'acceptance' && job.acceptanceQualified) {
        const role = getRoleState(localLedger, { id: job.characterId, epoch: job.characterEpoch }, true);
        role.acceptedEpoch = job.characterEpoch;
      }
      if (job.mode === 'daily') {
        const role = getRoleState(localLedger, { id: job.characterId, epoch: job.characterEpoch }, true);
        const day = getDayState(role, reservationDate(job), true);
        day.windows[job.scheduleWindow] = { state: 'completed', jobId: job.jobId, startedAt: day.windows[job.scheduleWindow]?.startedAt ?? job.createdAt, completedAt: nowIso() };
      }
    } catch (error) {
      if (!runtimes.get(job.jobId)?.cancelReason && /^(?:MEMORY|CHARACTER)_/.test(error?.code ?? '')) {
        const blocked = await v2.blocked(null, error, { jobId: job.jobId, characterId: context.characterId, characterEpoch: context.characterEpoch });
        error = Object.assign(new Error(blocked.error), blocked);
      }
      const issue = runtimes.get(job.jobId)?.cancelReason ?? (error instanceof CompanionError ? error : failObject(error));
      const failure = failObject(issue);
      job.code = failure.code; job.error = failure.error; job.hint = failure.hint;
      const cancelled = ['DOUYIN_CANCELLED', 'DOUYIN_CLOSED', 'DOUYIN_CHANNEL_DISABLED', 'DOUYIN_TRANSITION_CANCELLED', 'DOUYIN_STALE_CHARACTER'].includes(failure.code);
      job.state = cancelled ? 'cancelled' : job.items.some(item => item.memorySaved || item.feeling) ? 'partial' : 'failed';
      job.phase = cancelled ? 'cancelled' : 'failed';
      if (job.mode === 'daily') {
        const role = getRoleState(localLedger, { id: job.characterId, epoch: job.characterEpoch }, true);
        const day = getDayState(role, reservationDate(job), true);
        role.enabled = false;
        if (failure.code !== 'DOUYIN_CHANNEL_DISABLED') {
          role.paused = true;
          role.lastError = publicError(failure);
        }
        day.windows[job.scheduleWindow] = { state: 'failed', jobId: job.jobId, startedAt: day.windows[job.scheduleWindow]?.startedAt ?? job.createdAt, error: publicError(failure) };
      }
    } finally {
      clearRoleWatch(job);
      job.completedAt = nowIso();
      try { saveJob(localLedger, job); }
      catch (error) {
        const failure = failObject(error, 'DOUYIN_STATE_WRITE_FAILED');
        job.state = 'failed'; job.phase = 'failed'; job.code = failure.code; job.error = failure.error; job.hint = failure.hint;
      }
      activeJob = null;
      runnerPromise = null;
      runtimes.delete(job.jobId);
      releaseLock();
    }
  }
  function launch(job, context) {
    runtimes.set(job.jobId, { context, controller: new AbortController(), cancelReason: null, roleWatch: null });
    activeJob = job;
    runnerPromise = Promise.resolve().then(async () => {
      try { await runJob(job, context); }
      catch {
        // runJob owns public failures; this catch only prevents a detached rejection.
      }
    });
  }
  function startJob(context, mode, windowKey = '') {
    return serialize(() => {
      if (disposed) return callIssue(problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '重新打开服务后查看保留的活动状态。'));
      if (transitionDepth) return callIssue(problem('DOUYIN_TRANSITION_ACTIVE', '角色或渠道正在切换。', '等待切换完成后再手动启动。'));
      if (!['acceptance', 'daily'].includes(mode)) return callIssue(problem('DOUYIN_MODE_INVALID', '陪伴活动模式无效。', '使用手动验收或已启用的日常模式。'));
      if (mode === 'daily' && !windowKey) return callIssue(problem('DOUYIN_DAILY_TICK_REQUIRED', '日常活动只能由当前上海时间窗口触发。', '在12:30或20:30窗口调用本地tick；不会补跑错过的窗口。'));
      if (activeJob) return callIssue(problem('DOUYIN_COMPANION_BUSY', '当前已有一轮陪伴活动。', '轮询当前作业或取消后再操作。'));
      let role;
      try { role = requireCurrentRole(context); }
      catch (error) { return callIssue(error); }
      try {
        acquireLock();
        const ledger = readLedger();
        interruptedJobs(ledger);
        localLedger = ledger;
        const scheduled = mode === 'daily' ? getCurrentWindow(nowValue()) : null;
        if (mode === 'daily' && (!scheduled || scheduled.window !== windowKey)) throw problem('DOUYIN_WINDOW_MISSED', '当前时间不在预定日常窗口内。', '等待下一个12:30或20:30窗口；不会补跑。');
        const roleState = getRoleState(ledger, role, true);
        if (mode === 'daily') {
          if (!roleState.enabled || roleState.paused) throw problem(roleState.paused ? 'DOUYIN_DAILY_PAUSED' : 'DOUYIN_DAILY_DISABLED', roleState.paused ? '日常活动因上次失败已暂停。' : '日常活动当前未启用。', roleState.paused ? '查看daily.lastError并通过configure显式恢复。' : '手动验收成功后通过configure显式启用。');
          if (roleState.acceptedEpoch !== role.epoch) throw problem('DOUYIN_ACCEPTANCE_REQUIRED', '当前角色世代尚未完成手动验收。', '对当前角色完成可解释的手动验收后再启用日常活动。');
        }
        if (mode === 'acceptance' && ledger.acceptanceCalls >= MAX_ACCEPTANCE_CALLS) throw problem('DOUYIN_ACCEPTANCE_BUDGET_EXHAUSTED', '本轮手动验收的12次客户端请求额度已用尽。', '查看已保存的活动结果；需要新额度时由主线明确授权。');
        const job = newJob(mode, role, scheduled);
        if (mode === 'daily') {
          const day = getDayState(roleState, scheduled.date, true);
          check(day.calls < MAX_DAILY_CALLS, 'DOUYIN_DAILY_CALL_LIMIT', '该角色今日8次日常客户端请求额度已用尽。', '检查本日活动账本；额度不会因重启或角色快照回档重置。');
          check(day.rounds < MAX_DAILY_ROUNDS, 'DOUYIN_DAILY_ROUND_LIMIT', '该角色今日两轮日常额度已用尽。', '等待上海时间次日；不会因重启或角色快照回档重置。');
          check(!day.windows[scheduled.window], 'DOUYIN_WINDOW_ALREADY_USED', '该上海时间窗口已经尝试过。', '检查已保留的窗口结果；失败后需手动恢复，不自动补跑。');
          day.rounds += 1;
          day.windows[scheduled.window] = { state: 'running', jobId: job.jobId, startedAt: nowIso() };
        }
        ledger.jobs[job.jobId] = job;
        writeLedger(ledger);
        localLedger = ledger;
        launch(job, contextStamp(context, role));
        return projectJob(job);
      } catch (error) {
        const failure = failObject(error);
        if (store.locked && !activeJob) releaseLock();
        return { ok: false, state: 'failed', phase: 'start', ...failure };
      }
    });
  }
  function start(context, options = {}) {
    if (!isRecord(options)) return Promise.resolve(callIssue(problem('DOUYIN_MODE_INVALID', '陪伴活动模式参数无效。', '使用手动验收模式启动。')));
    const mode = options.mode ?? 'acceptance';
    if (mode !== 'acceptance') return Promise.resolve(callIssue(problem(mode === 'daily' ? 'DOUYIN_DAILY_TICK_REQUIRED' : 'DOUYIN_MODE_INVALID', mode === 'daily' ? '日常活动只能由本地tick触发。' : '陪伴活动模式无效。', '等待上海时间12:30或20:30窗口，或使用手动验收模式。')));
    return startJob(context, 'acceptance').then(value => response(context, value));
  }
  const responseLeases = new Map();
  const responseDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const hasProof = value => Array.isArray(value?.memoryV2Refs) && value.memoryV2Refs.length > 0 && Array.isArray(value.memoryV2Receipts) && value.memoryV2Receipts.length > 0;
  function releaseResponse(value) {
    const lease = responseLeases.get(value);
    if (lease) { v2.release(lease.session); responseLeases.delete(value); }
  }
  async function validateResponse(context, value) {
    try {
      const role = requireCurrentRole(context), route = v2.routing();
      check(route.ok, route.code, route.error, route.hint);
      const lease = responseLeases.get(value);
      check(lease && lease.role.id === role.id && lease.role.epoch === role.epoch && lease.digest === responseDigest(value),
        'MEMORY_RESPONSE_UNTRUSTED', '本次日记响应没有完整的当前授权凭据。', '刷新当前角色日记；不要复用或改写旧响应。');
      await v2.validate(lease.session);
      const latestRoute = v2.routing(); check(latestRoute.ok, 'MEMORY_ROUTING_CHANGED', '响应期间记忆后端已变化。', '以当前可信路由刷新日记。');
      requireCurrentRole(context);
      check(lease.digest === responseDigest(value), 'MEMORY_RESPONSE_UNTRUSTED', '等待期间日记响应已变化。', '重新读取日记后再展示。');
      return { ok: true };
    } catch (error) { return callIssue(error); }
  }
  async function response(context, value) {
    let session;
    try {
      const route = v2.routing(); check(route.ok, route.code, route.error, route.hint);
      if (value?.ok !== true) return value;
      const role = requireCurrentRole(context), stamp = contextStamp(context, role);
      const safeJob = job => {
        if (!job) return null;
        if (hasProof(job) && job.items.every(hasProof)) return job;
        if (activeJob?.jobId === job.jobId && ACTIVE.has(job.state)) {
          const items = job.items.filter(hasProof);
          return { ...job, items };
        }
        return null;
      };
      if (Array.isArray(value.recentJobs)) {
        value = { ...value, recentJobs: value.recentJobs.map(safeJob).filter(Boolean), activeJob: safeJob(value.activeJob) };
        const visible = new Set(value.recentJobs.map(job => job.jobId));
        value.daily = { ...value.daily, windows: Object.fromEntries(Object.entries(value.daily.windows).filter(([, entry]) => visible.has(entry.jobId))) };
      } else if (value.jobId && !safeJob(value)) return callIssue(problem('MEMORY_RESPONSE_PROVENANCE_REQUIRED', '旧活动缺少完整来源授权，已停止展示。', '保留原账本并完成来源迁移后再查看；不会回退旧记忆。'));
      else if (value.jobId) value = safeJob(value);
      const jobs = Array.isArray(value.recentJobs) ? [...value.recentJobs, value.activeJob].filter(Boolean) : value.jobId ? [value] : [];
      const refs = [...new Map(jobs.flatMap(job => [...(job.memoryV2Refs ?? []), ...job.items.flatMap(item => item.memoryV2Refs ?? [])]).map(ref => [JSON.stringify(ref), ref])).values()];
      session = await v2.capture(stamp, 'douyin:homepage-recommendation');
      const bound = await memoryV2.adapter.bindActualInput(session.handle, refs);
      check(bound?.ok === true, bound?.code || 'MEMORY_RESPONSE_DENIED', bound?.error || '日记来源未获当前展示授权。', bound?.hint || '核对当前来源权限后刷新日记。');
      await v2.validate(session);
      responseLeases.set(value, { session, role, digest: responseDigest(value) });
      session = null;
      return value;
    } catch (error) { return callIssue(error); }
    finally { v2.release(session); }
  }
  async function status(context) {
    const role = context ?? currentRole();
    return response(context ?? { characterId: role?.id, characterEpoch: role?.epoch }, await statusValue(context));
  }
  async function statusValue(context) {
    let role;
    try {
      role = context === undefined || context === null ? currentRole() : requireCurrentRole(context);
      if (!role) throw problem('DOUYIN_CHARACTER_UNAVAILABLE', '无法确认当前角色及世代。', '切换到有效角色后刷新状态。');
    } catch (error) { return callIssue(error); }
    let ledger;
    try { ledger = readLedger(); }
    catch (error) { return callIssue(error); }
    const roleState = getRoleState(ledger, role, false);
    let shanghai;
    try { shanghai = shanghaiParts(nowValue()); }
    catch (error) { return callIssue(error); }
    const today = getDayState(roleState, shanghai.date, false);
    const isAccepted = roleState?.acceptedEpoch === role.epoch;
    const lockActive = store.lockOwnerActive;
    if (lockActive === null) return callIssue(problem('DOUYIN_LOCK_INVALID', '无法确认陪伴账本锁状态，已停止展示可操作状态。', '检查本机状态目录和锁文件权限；保留数据并确认实例归属后再操作。'));
    const interruptedDaily = lockActive === false ? Object.values(ledger.jobs).find(job => job.characterId === role.id && job.mode === 'daily' && ACTIVE.has(job.state)) : null;
    const visibleJobs = Object.values(ledger.jobs)
      .filter(job => job.characterId === role.id && job.characterEpoch === role.epoch)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 8)
      .map(job => projectRecoverableJob(job, lockActive));
    const localActive = activeJob && activeJob.characterId === role.id && activeJob.characterEpoch === role.epoch ? projectJob(activeJob) : null;
    const paused = roleState?.paused === true || !!interruptedDaily;
    const lastError = publicError(roleState?.lastError) ?? (interruptedDaily ? publicError({ code: 'DOUYIN_INTERRUPTED', error: '进程重启打断了日常活动。', hint: '已预留请求不会返还；查看保留结果并通过configure显式恢复。' }) : null);
    return {
      ok: true,
      characterId: role.id,
      characterEpoch: role.epoch,
      daily: {
        enabled: roleState?.enabled === true && !paused && isAccepted,
        paused,
        calls: today?.calls ?? 0,
        rounds: today?.rounds ?? 0,
        lastError,
        windows: today?.windows ? Object.fromEntries(Object.entries(today.windows).filter(([key]) => ['12:30', '20:30'].includes(key)).map(([key, value]) => {
          const stale = value.state === 'running' && lockActive === false;
          return [key, { state: stale ? 'failed' : (['running', 'completed', 'failed'].includes(value.state) ? value.state : 'failed'), jobId: /^douyin-[0-9a-f-]{36}$/.test(String(value.jobId)) ? value.jobId : null, error: publicError(value.error) ?? (stale ? lastError : null) }];
        })) : {},
      },
      acceptance: {
        callsUsed: ledger.acceptanceCalls,
        remaining: Math.max(0, MAX_ACCEPTANCE_CALLS - ledger.acceptanceCalls),
        manualAccepted: isAccepted,
      },
      activeJob: localActive ?? visibleJobs.find(job => ACTIVE.has(job.state)) ?? null,
      recentJobs: visibleJobs,
    };
  }
  async function cancel(context) { return response(context, await cancelValue(context)); }
  async function cancelValue(context) {
    return serialize(async () => {
      let role;
      try { role = requireCurrentRole(context); }
      catch (error) { return callIssue(error); }
      if (!activeJob || activeJob.characterId !== role.id || activeJob.characterEpoch !== role.epoch) return callIssue(problem('DOUYIN_NO_ACTIVE_JOB', '当前角色没有可取消的陪伴活动。', '刷新状态并确认作业所属角色。'));
      const runtime = runtimes.get(activeJob.jobId);
      if (runtime) { runtime.cancelReason = problem('DOUYIN_CANCELLED', '陪伴活动已取消。', '检查已保留的结果与请求额度后再决定是否手动重试。'); runtime.controller.abort(); }
      const job = activeJob;
      const pending = runnerPromise;
      if (pending) await pending;
      const current = currentRole(context);
      if (!current || current.id !== role.id || current.epoch !== role.epoch) return callIssue(problem('DOUYIN_STALE_CHARACTER', '取消等待期间角色已切换。', '刷新当前角色状态；旧活动只保留在其原角色账本中。'));
      let latest;
      try { latest = readLedger().jobs[job.jobId]; }
      catch (error) { return callIssue(error); }
      return projectJob(latest ?? job);
    });
  }
  function configureCore(context, enabled, transitioning = false) {
    if (disposed) return callIssue(problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '重新打开服务后查看保留的状态。'));
    if (transitionDepth && !transitioning) return callIssue(problem('DOUYIN_TRANSITION_ACTIVE', '角色或渠道正在切换。', '等待切换完成后再修改日常开关。'));
    if (typeof enabled !== 'boolean') return callIssue(problem('DOUYIN_CONFIG_INVALID', '日常开关值无效。', '明确设置enabled为true或false。'));
    let role;
    try { role = requireCurrentRole(context); }
    catch (error) { return callIssue(error); }
    if (activeJob) return callIssue(problem('DOUYIN_COMPANION_BUSY', '活动进行中，无法修改日常开关。', '等待当前作业结束或先取消当前作业。'));
    try {
      acquireLock();
      const ledger = readLedger();
      interruptedJobs(ledger);
      localLedger = ledger;
      const roleState = getRoleState(ledger, role, true);
      if (enabled && roleState.acceptedEpoch !== role.epoch) throw problem('DOUYIN_ACCEPTANCE_REQUIRED', '当前角色世代尚未完成成功的手动验收。', '先完成至少一条语音覆盖完整且含有效稀疏画面的手动点评，再启用日常活动。');
      roleState.enabled = enabled;
      if (enabled) { roleState.paused = false; }
      writeLedger(ledger);
      return { ok: true, enabled: roleState.enabled && !roleState.paused, paused: roleState.paused, lastError: publicError(roleState.lastError) };
    } catch (error) { return callIssue(error); }
    finally { if (store.locked && !activeJob) releaseLock(); }
  }
  function configure(context, options = {}) {
    const enabled = isRecord(options) ? options.enabled : undefined;
    if (enabled !== false) return serialize(() => configureCore(context, enabled)).then(value => response(context, value));
    return transition(() => configureCore(context, false, true), {
      beforeAbort: () => {
        if (disposed) return callIssue(problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '重新打开服务后查看保留的状态。'));
        if (transitionDepth) return callIssue(problem('DOUYIN_TRANSITION_ACTIVE', '角色或渠道正在切换。', '等待切换完成后再修改日常开关。'));
        try { requireCurrentRole(context); return null; }
        catch (error) { return callIssue(error); }
      },
      cancelReason: problem('DOUYIN_CHANNEL_DISABLED', '抖音陪伴已关闭，当前活动已停止。', '查看已保留结果；重新启用日常活动前确认当前角色验收状态。'),
    }).then(value => response(context, value));
  }
  async function tick() {
    if (disposed) return callIssue(problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '重新打开服务后再运行本地tick。'));
    const role = currentRole();
    if (!role) return callIssue(problem('DOUYIN_CHARACTER_UNAVAILABLE', '无法确认当前角色及世代。', '切换到有效角色后再运行本地tick。'));
    let scheduled;
    try { scheduled = getCurrentWindow(nowValue()); }
    catch (error) { return callIssue(error); }
    if (!scheduled) return { ok: true, state: 'idle', phase: 'schedule', code: 'DOUYIN_WINDOW_NOT_DUE', error: '当前不在日常活动窗口内。', hint: '本地tick只在上海时间12:30或20:30启动；错过的窗口不会补跑。' };
    const context = { characterId: role.id, characterEpoch: role.epoch };
    const result = await startJob(context, 'daily', scheduled.window);
    const after = currentRole();
    if (!after || after.id !== role.id || after.epoch !== role.epoch) return callIssue(problem('DOUYIN_STALE_CHARACTER', '日常窗口触发期间角色已切换。', '已停止后续模型和记忆写入；以当前角色重新验收。'));
    return response(context, result);
  }
  async function transition(action, { beforeAbort = null, cancelReason = null } = {}) {
    if (typeof action !== 'function') return callIssue(problem('DOUYIN_TRANSITION_INVALID', '角色切换操作无效。', '传入本地切换操作后重试。'));
    if (typeof beforeAbort === 'function') {
      const issue = beforeAbort();
      if (issue) return issue;
    }
    transitionDepth += 1;
    if (activeJob) {
      const runtime = runtimes.get(activeJob.jobId);
      if (runtime) {
        runtime.cancelReason = cancelReason ?? problem('DOUYIN_TRANSITION_CANCELLED', '角色或渠道切换已取消当前活动。', '检查已保留结果；切换完成后以当前角色重新验收。');
        runtime.controller.abort();
      }
    }
    const pending = runnerPromise;
    if (pending) { try { await pending; } catch {} }
    try { return await serialize(action); }
    finally { transitionDepth = Math.max(0, transitionDepth - 1); }
  }
  async function withTransition(action) { return transition(action); }
  async function dispose() {
    if (disposed) return { ok: true };
    disposed = true;
    for (const value of responseLeases.keys()) releaseResponse(value);
    if (activeJob) {
      const runtime = runtimes.get(activeJob.jobId);
      if (runtime) { runtime.cancelReason = problem('DOUYIN_CLOSED', '陪伴服务已关闭。', '查看已保留的活动状态后再决定是否重启。'); runtime.controller.abort(); }
    }
    const pending = runnerPromise;
    if (pending) { try { await pending; } catch {} }
    releaseLock();
    return { ok: true };
  }

  return { start, status, cancel, configure, tick, withTransition, dispose, validateResponse, releaseResponse };
}
