import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDouyinCompanion } from '../lib/douyin-companion.mjs';

const roots = [];
const makeRoot = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-companion-test-')); roots.push(root); return root; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mediaSource = 'https://cdn.private.invalid/video.mp4?signature=PRIVATE_MEDIA_SECRET';
const frame = { atMs: 500, dataUrl: 'data:image/png;base64,YWJj' };
const output = (overrides = {}) => JSON.stringify({ feeling: 'like', reason: '节奏清楚，表达有意思。', summary: '一段轻松的经验分享。', draft: '这段讲法挺有意思。', ...overrides });
const sharingOutput = (overrides = {}) => output({ share: '这段把复杂的想法讲得很轻巧，我喜欢这个节奏。', question: '你觉得这种讲法适合什么场景？', ...overrides });
const recommendation = (id = 'video-1', durationMs = 1000) => ({
  id,
  url: `https://www.douyin.com/video/${id}?tracking=PRIVATE_MEDIA_SECRET`,
  title: `推荐 ${id}`,
  durationMs,
  mediaSource,
  mediaUserAgent: 'Mozilla/5.0 SurfCore-ephemeral-browser-UA',
});

function fixture(options = {}) {
  const stateDir = options.stateDir ?? makeRoot();
  const context = { characterId: 'role-a', characterEpoch: 1 };
  const role = options.role ?? { id: 'role-a', epoch: 1 };
  const time = options.time ?? { value: new Date('2026-11-07T03:00:00.000Z') };
  const calls = { models: [], memory: [], memoryWrites: [], shares: [], perceived: [], ready: 0, feeds: 0 };
  const api = createDouyinCompanion({
    stateDir,
    getCharacter: () => role,
    now: () => time.value,
    callbackTimeoutMs: options.callbackTimeoutMs ?? 180_000,
    readiness: async () => { calls.ready++; return options.readiness ? options.readiness(calls) : { ok: true }; },
    readFeed: async ctx => {
      calls.feeds++;
      assert.equal(ctx.characterId, role.id);
      assert.equal(ctx.characterEpoch, role.epoch);
      if (options.readFeed) return options.readFeed(calls, ctx);
      return { ok: true, items: options.feedItems ?? [recommendation('video-1'), recommendation('video-2'), recommendation('video-3')] };
    },
    perceive: async (item, ctx, { signal, activityId }) => {
      calls.perceived.push({ item, ctx, activityId });
      if (options.perceiveFailureId === item.id) throw new Error('media processing failed');
      if (options.perceive) return options.perceive(item, ctx, { signal, activityId, calls });
      return {
        ok: true, id: item.id, url: item.url, title: item.title, durationMs: options.actualDurationMs ?? item.durationMs,
        observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
        transcript: {
          text: '这段视频分享了一个简单做法。',
          coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: options.actualDurationMs ?? item.durationMs }], processedRanges: [{ startMs: 0, endMs: options.actualDurationMs ?? item.durationMs }], missingRanges: [] },
          speechState: 'speech',
        },
        frames: [frame], visualCoverage: 'sparse', warnings: [],
      };
    },
    buildContext: async ctx => options.buildContext ? options.buildContext(ctx) : ({ ok: true, text: `角色${ctx.characterId}的记忆。` }),
    modelCall: async args => {
      calls.models.push(args);
      assert.equal(args.maxTokens, 8192);
      assert.equal(args.timeoutMs, 180_000);
      assert.ok(args.signal instanceof AbortSignal);
      assert.ok(args.images.length > 0 && args.images.length <= 3);
      assert.ok(args.system.includes('外部数据'));
      assert.ok(args.system.includes('绝不发送'));
      if (options.modelCall) return options.modelCall(args, calls);
      return { text: output(), usage: { inputTokens: 99, outputTokens: 22 }, finishReason: 'stop' };
    },
    recordMemory: async (ctx, value, { signal }) => {
      calls.memory.push({ ctx, value });
      if (options.recordMemory) return options.recordMemory(ctx, value, { signal }, calls);
      if (signal.aborted) throw new Error('aborted');
      calls.memoryWrites.push(value);
      return { ok: true };
    },
    recordSharing: options.recordSharing ? async (ctx, value, { signal }) => {
      calls.shares.push({ ctx, value, signal });
      return options.recordSharing(ctx, value, { signal }, calls);
    } : undefined,
  });
  return { api, stateDir, context, role, time, calls, options };
}

async function finish(api, context, jobId, tries = 500) {
  for (let i = 0; i < tries; i++) {
    const status = await api.status(context);
    const job = status.recentJobs?.find(item => item.jobId === jobId);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await wait(5);
  }
  assert.fail(`job did not finish: ${jobId}`);
}
async function finishStored(stateDir, jobId, tries = 500) {
  const file = path.join(stateDir, 'douyin-companion', 'ledger.json');
  for (let i = 0; i < tries; i++) {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    const job = ledger.jobs[jobId];
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await wait(5);
  }
  assert.fail(`stored job did not finish: ${jobId}`);
}
function assertIssue(value, code) {
  assert.equal(value?.ok, false);
  assert.equal(value.code, code);
  assert.ok(typeof value.error === 'string' && value.error.length, `${code} error missing`);
  assert.ok(typeof value.hint === 'string' && value.hint.length, `${code} hint missing`);
  return value;
}
async function startAndFinish(f, options) {
  const started = await f.api.start(f.context, options);
  if (started.ok === false) return started;
  return finish(f.api, f.context, started.jobId);
}

// A successful manual run stores only safe projections, keeps true source/time,
// and daily runs are tick-only, once per Shanghai window.
{
  const f = fixture();
  const manual = await startAndFinish(f);
  assert.equal(manual.state, 'partial'); // Sparse frames never claim full-video visual coverage.
  assert.equal(manual.acceptanceQualified, true);
  assert.equal(manual.items.length, 2);
  assert.equal(f.calls.models.length, 2);
  assert.equal(f.calls.perceived[0].item.mediaUserAgent, 'Mozilla/5.0 SurfCore-ephemeral-browser-UA');
  assert.equal(f.calls.memory.length, 2);
  assert.equal(manual.items[0].url, 'https://www.douyin.com/video/video-1');
  assert.equal(manual.items[0].occurredAt, '2026-11-07T03:01:02.000Z');
  assert.equal(manual.items[0].coverage.visualCoverage, 'sparse');
  assert.equal(manual.items[0].memorySaved, true);
  assert.match(f.calls.models[0].system, /仅有 feeling、reason、summary、draft 四个字段/);
  assert.doesNotMatch(f.calls.models[0].system, /share、question/);
  assert.equal(f.calls.memory[0].value.id, 'video-1');
  assert.equal(Object.hasOwn(f.calls.memory[0].value, 'url'), false);
  assert.equal(f.calls.memory[0].value.occurredAt, manual.items[0].occurredAt);
  assert.equal(f.calls.memory[0].value.coverage.complete, true);
  assert.equal(f.calls.memory[0].ctx.characterEpoch, 1);
  const configured = await f.api.configure(f.context, { enabled: true });
  assert.equal(configured.ok, true);
  f.time.value = new Date('2026-11-07T04:30:00.000Z'); // Shanghai 12:30.
  const dailyStarted = await f.api.tick();
  assert.equal(dailyStarted.ok, true);
  const dailyJob = await finish(f.api, f.context, dailyStarted.jobId);
  assert.equal(dailyJob.mode, 'daily');
  assert.equal(dailyJob.calls, 2);
  const status = await f.api.status(f.context);
  assert.equal(status.daily.enabled, true);
  assert.equal(status.daily.paused, false);
  assert.equal(status.daily.calls, 2);
  assert.equal(status.daily.rounds, 1);
  assert.equal(status.daily.windows['12:30'].state, 'completed');
  assert.equal(status.acceptance.callsUsed, 2);
  assert.equal(status.acceptance.remaining, 10);
  const duplicate = assertIssue(await f.api.tick(), 'DOUYIN_WINDOW_ALREADY_USED');
  assert.ok(duplicate.hint.includes('不自动补跑'));
  f.time.value = new Date('2026-11-07T04:31:00.000Z');
  const missed = await f.api.tick();
  assert.equal(missed.state, 'idle');
  assert.equal(missed.code, 'DOUYIN_WINDOW_NOT_DUE');
  assert.ok(missed.error && missed.hint);
  const data = fs.readFileSync(path.join(f.stateDir, 'douyin-companion', 'ledger.json'), 'utf8');
  assert.ok(!data.includes('PRIVATE_MEDIA_SECRET'));
  assert.ok(!data.includes('data:image'));
  assert.ok(!data.includes('mediaSource'));
  assert.ok(!data.includes('mediaUserAgent') && !data.includes('SurfCore-ephemeral-browser-UA'));
  assert.ok(!data.includes('system') && !data.includes('prompt'));
  await f.api.dispose();
  const restarted = fixture({ stateDir: f.stateDir, time: f.time });
  const afterRestart = await restarted.api.status(restarted.context);
  assert.equal(afterRestart.acceptance.callsUsed, 2);
  assert.equal(afterRestart.daily.calls, 2);
  await restarted.api.dispose();
}

// Unknown/overlong duration does not count as watched or call the model.
{
  const f = fixture({ feedItems: [recommendation('unknown', 0), recommendation('long', 120_001)] });
  const job = await startAndFinish(f);
  assert.equal(job.state, 'failed');
  assert.equal(job.code, 'DOUYIN_NO_QUALIFIED_MATERIAL');
  assert.ok(job.hint);
  assert.equal(f.calls.models.length, 0);
  assert.equal((await f.api.status(f.context)).acceptance.callsUsed, 0);
  await f.api.dispose();
}

// Transcript coverage must span the actual video; no speech and tiny claimed ranges cannot unlock daily mode.
{
  const tiny = fixture({ feedItems: [recommendation('tiny-range')], perceive: async item => ({
    ok: true, id: item.id, url: item.url, title: item.title, durationMs: 1000,
    observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
    transcript: { text: '有一小段转写', coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: 1 }], processedRanges: [{ startMs: 0, endMs: 1 }], missingRanges: [] }, speechState: 'speech' },
    frames: [frame], visualCoverage: 'sparse', warnings: [],
  }) });
  const tinyJob = await startAndFinish(tiny);
  assert.equal(tinyJob.items[0].coverage.transcriptComplete, false);
  assert.equal(tinyJob.acceptanceQualified, false);
  assertIssue(await tiny.api.configure(tiny.context, { enabled: true }), 'DOUYIN_ACCEPTANCE_REQUIRED');
  await tiny.api.dispose();

  const noSpeech = fixture({ feedItems: [recommendation('no-speech')], perceive: async item => ({
    ok: true, id: item.id, url: item.url, title: item.title, durationMs: 1000,
    observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
    transcript: { text: '不可信的非空文本', coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: 1000 }], processedRanges: [{ startMs: 0, endMs: 1000 }], missingRanges: [] }, speechState: 'no-speech' },
    frames: [frame], visualCoverage: 'sparse', warnings: [],
  }) });
  const noSpeechJob = await startAndFinish(noSpeech);
  assert.equal(noSpeechJob.code, 'DOUYIN_TRANSCRIPT_EMPTY');
  assert.ok(noSpeechJob.error && noSpeechJob.hint);
  assert.equal(noSpeechJob.items[0].state, 'skipped');
  assert.equal(noSpeechJob.items[0].coverage.acceptanceQualified, false);
  assert.equal(noSpeechJob.items[0].code, 'DOUYIN_TRANSCRIPT_EMPTY');
  assert.ok(noSpeechJob.items[0].error && noSpeechJob.items[0].hint);
  assert.equal(noSpeech.calls.models.length, 0);
  assertIssue(await noSpeech.api.configure(noSpeech.context, { enabled: true }), 'DOUYIN_ACCEPTANCE_REQUIRED');
  await noSpeech.api.dispose();
}

// Feed duration is only a prefilter; accepted coverage and saved duration use the media parser's actual duration.
{
  const f = fixture({ feedItems: [recommendation('duration-mismatch', 1001)], actualDurationMs: 1000 });
  const job = await startAndFinish(f);
  assert.equal(job.acceptanceQualified, true);
  assert.equal(job.items[0].durationMs, 1000);
  assert.equal(JSON.parse(f.calls.models[0].prompt).durationMs, 1000);
  assert.equal(f.calls.memory[0].value.coverage.requestedRanges[0].endMs, 1000);
  await f.api.dispose();

  const invalid = fixture({ feedItems: [recommendation('actual-too-long')], actualDurationMs: 120_001 });
  const invalidJob = await startAndFinish(invalid);
  assert.equal(invalidJob.code, 'DOUYIN_ACTUAL_DURATION_INVALID');
  assert.ok(invalidJob.error && invalidJob.hint);
  assert.equal(invalidJob.items[0].code, 'DOUYIN_ACTUAL_DURATION_INVALID');
  assert.ok(invalidJob.items[0].error && invalidJob.items[0].hint);
  assert.equal(invalidJob.items[0].durationMs, 1000);
  assert.equal(invalid.calls.models.length, 0);
  await invalid.api.dispose();
}

// Memory callback timeout is bounded and leaves a visible item failure without a retry.
{
  const f = fixture({ feedItems: [recommendation()], callbackTimeoutMs: 1000, recordMemory: async () => new Promise(() => {}) });
  const job = await startAndFinish(f);
  assert.equal(job.state, 'partial');
  assert.equal(job.code, 'DOUYIN_MEMORY_TIMEOUT');
  assert.ok(job.error && job.hint);
  assert.equal(job.items[0].memorySaved, false);
  assert.equal(job.items[0].code, 'DOUYIN_MEMORY_TIMEOUT');
  assert.ok(job.items[0].error && job.items[0].hint);
  assert.equal(f.calls.models.length, 1);
  await f.api.dispose();
}

// Four sampled frames are clamped to the Host's maximum of three before model and ledger projection.
{
  const fourFrames = [100, 200, 300, 400].map(atMs => ({ atMs, dataUrl: frame.dataUrl }));
  const f = fixture({ feedItems: [recommendation('frame-cap')], perceive: async item => ({
    ok: true, id: item.id, url: item.url, title: item.title, durationMs: 1000,
    observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
    transcript: { text: '有语音', coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: 1000 }], processedRanges: [{ startMs: 0, endMs: 1000 }], missingRanges: [] }, speechState: 'speech' },
    frames: fourFrames, visualCoverage: 'sparse', warnings: [],
  }) });
  const job = await startAndFinish(f);
  assert.equal(f.calls.models[0].images.length, 3);
  assert.equal(job.items[0].coverage.frameSamples, 3);
  await f.api.dispose();
}

// Missing frames or speech skips the item; no audio-only model call is allowed.
{
  for (const missing of ['frames', 'transcript']) {
    const f = fixture({ feedItems: [recommendation()] , perceive: async item => ({
      ok: true, id: item.id, url: item.url, title: item.title, durationMs: item.durationMs,
      observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
      transcript: { text: missing === 'transcript' ? '' : '有语音', coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: item.durationMs }], processedRanges: [{ startMs: 0, endMs: item.durationMs }], missingRanges: [] }, speechState: missing === 'transcript' ? 'no-speech' : 'speech' },
      frames: missing === 'frames' ? [] : [frame], visualCoverage: 'sparse', warnings: [],
    }) });
    const job = await startAndFinish(f);
    assert.equal(job.state, 'failed');
    assert.equal(job.code, missing === 'frames' ? 'DOUYIN_FRAMES_UNAVAILABLE' : 'DOUYIN_TRANSCRIPT_EMPTY');
    assert.ok(job.error && job.hint);
    assert.equal(job.items[0].state, 'skipped');
    assert.equal(job.items[0].code, missing === 'frames' ? 'DOUYIN_FRAMES_UNAVAILABLE' : 'DOUYIN_TRANSCRIPT_EMPTY');
    assert.equal(f.calls.models.length, 0);
    assert.equal(f.calls.memory.length, 0);
    await f.api.dispose();
  }
}

// Model privacy, format, and failures consume the pre-reserved request and never retry.
{
  const f = fixture({ feedItems: [recommendation()], modelCall: async () => ({ text: output({ draft: '请看 https://example.invalid/secret' }), usage: {}, finishReason: 'stop' }) });
  const job = await startAndFinish(f);
  assert.equal(job.code, 'DOUYIN_MODEL_OUTPUT_PRIVACY');
  assert.ok(job.error && job.hint);
  assert.equal(f.calls.models.length, 1);
  assert.equal(f.calls.memory.length, 0);
  assert.equal((await f.api.status(f.context)).acceptance.callsUsed, 1);
  await f.api.dispose();

  const failed = fixture({ feedItems: [recommendation()], modelCall: async () => { throw new Error('upstream failed'); } });
  const failedJob = await startAndFinish(failed);
  assert.equal(failedJob.code, 'DOUYIN_MODEL_FAILED');
  assert.ok(failedJob.error && failedJob.hint);
  assert.equal(failed.calls.models.length, 1);
  assert.equal((await failed.api.status(failed.context)).acceptance.callsUsed, 1);
  await failed.api.dispose();
  const restarted = fixture({ stateDir: failed.stateDir, feedItems: [recommendation()] });
  assert.equal((await restarted.api.status(restarted.context)).acceptance.callsUsed, 1);
  await restarted.api.dispose();
}

// Callbacks that ignore the cancellation signal cannot trigger late model or memory work.
{
  const f = fixture({ feedItems: [recommendation()], modelCall: async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = await f.api.start(f.context);
  while (!f.calls.models.length) await wait(5);
  const cancelled = await f.api.cancel(f.context);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.code, 'DOUYIN_CANCELLED');
  assert.ok(cancelled.error && cancelled.hint);
  const job = await finishStored(f.stateDir, started.jobId);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.calls, 1);
  assert.equal(f.calls.memory.length, 0);
  assert.equal(f.calls.models.length, 1);
  await f.api.dispose();
}

// A delayed memory callback receives the job signal and cancellation returns without a late write.
{
  const f = fixture({ feedItems: [recommendation()], recordMemory: async (_ctx, _value, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = await f.api.start(f.context);
  while (!f.calls.memory.length) await wait(5);
  const cancelled = await f.api.cancel(f.context);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.code, 'DOUYIN_CANCELLED');
  assert.ok(cancelled.error && cancelled.hint);
  const job = await finishStored(f.stateDir, started.jobId);
  assert.equal(job.items[0].memorySaved, false);
  assert.equal(job.items[0].code, 'DOUYIN_CANCELLED');
  assert.equal(f.calls.memoryWrites.length, 0);
  await f.api.dispose();
}

// Role epochs are checked while an async model call is pending.
{
  const role = { id: 'role-a', epoch: 1 };
  const f = fixture({ role, feedItems: [recommendation()], modelCall: async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = await f.api.start(f.context);
  while (!f.calls.models.length) await wait(5);
  role.epoch = 2;
  const job = await finishStored(f.stateDir, started.jobId);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.code, 'DOUYIN_STALE_CHARACTER');
  assert.ok(job.error && job.hint);
  assert.equal(f.calls.memory.length, 0);
  assert.equal(f.calls.models.length, 1);
  await f.api.dispose();
}

// A queued request with an old role stamp cannot be rebound to the newly active character.
{
  const f = fixture({ feedItems: [recommendation()] });
  const pending = f.api.start(f.context);
  f.role.id = 'role-b'; f.role.epoch = 2;
  assertIssue(await pending, 'DOUYIN_STALE_CHARACTER');
  assertIssue(await f.api.status(f.context), 'DOUYIN_STALE_CHARACTER');
  assertIssue(await f.api.configure(f.context, { enabled: false }), 'DOUYIN_STALE_CHARACTER');
  assertIssue(await f.api.cancel(f.context), 'DOUYIN_STALE_CHARACTER');
  assert.equal(f.calls.models.length, 0);
  assert.equal(f.calls.memory.length, 0);
  await f.api.dispose();
}

// Stale status/configure/cancel calls fail closed and cannot abort the active current-character job.
{
  const role = { id: 'role-b', epoch: 2 };
  const f = fixture({ role, feedItems: [recommendation()], modelCall: async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  f.context.characterId = 'role-b'; f.context.characterEpoch = 2;
  const started = await f.api.start(f.context);
  while (!f.calls.models.length) await wait(5);
  const stale = { characterId: 'role-a', characterEpoch: 1 };
  assertIssue(await f.api.status(stale), 'DOUYIN_STALE_CHARACTER');
  assertIssue(await f.api.configure(stale, { enabled: false }), 'DOUYIN_STALE_CHARACTER');
  assertIssue(await f.api.cancel(stale), 'DOUYIN_STALE_CHARACTER');
  assert.equal(f.calls.models[0].signal.aborted, false);
  const cancelled = await f.api.cancel(f.context);
  assert.equal(cancelled.jobId, started.jobId);
  await finishStored(f.stateDir, started.jobId);
  await f.api.dispose();
}

// Role-transition wrapper waits for the active request to stop before changing epoch.
{
  const role = { id: 'role-a', epoch: 1 };
  const f = fixture({ role, feedItems: [recommendation()], modelCall: async ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = await f.api.start(f.context);
  while (!f.calls.models.length) await wait(5);
  let transitionFinished = false;
  await f.api.withTransition(async () => { role.epoch = 2; transitionFinished = true; });
  assert.equal(transitionFinished, true);
  const job = await finishStored(f.stateDir, started.jobId);
  assert.equal(job.code, 'DOUYIN_TRANSITION_CANCELLED');
  assert.equal(f.calls.memory.length, 0);
  await f.api.dispose();
}

// Only a qualified manual acceptance unlocks daily mode; a failed daily request pauses persistently.
{
  const f = fixture({ feedItems: [recommendation()], modelCall: async (_args, calls) => {
    if (calls.models.length > 1) throw new Error('daily model failed');
    return { text: output(), usage: {}, finishReason: 'stop' };
  } });
  const preEnable = assertIssue(await f.api.configure(f.context, { enabled: true }), 'DOUYIN_ACCEPTANCE_REQUIRED');
  assert.ok(preEnable.hint);
  const manual = await startAndFinish(f);
  assert.equal(manual.acceptanceQualified, true);
  assert.equal((await f.api.configure(f.context, { enabled: true })).ok, true);
  f.time.value = new Date('2026-11-07T04:30:00.000Z');
  const started = await f.api.tick();
  const job = await finish(f.api, f.context, started.jobId);
  assert.equal(job.state, 'failed');
  assert.equal(job.code, 'DOUYIN_MODEL_FAILED');
  assert.ok(job.error && job.hint);
  const paused = await f.api.status(f.context);
  assert.equal(paused.daily.enabled, false);
  assert.equal(paused.daily.paused, true);
  assert.equal(paused.daily.calls, 1);
  assert.equal(paused.daily.rounds, 1);
  assert.equal(paused.daily.lastError.code, 'DOUYIN_MODEL_FAILED');
  assert.ok(paused.daily.lastError.hint);
  const retry = assertIssue(await f.api.tick(), 'DOUYIN_DAILY_PAUSED');
  assert.ok(retry.hint);
  assert.equal((await f.api.configure(f.context, { enabled: true })).enabled, true); // explicit recovery
  const usedWindow = assertIssue(await f.api.tick(), 'DOUYIN_WINDOW_ALREADY_USED');
  assert.ok(usedWindow.error && usedWindow.hint);
  assert.equal(f.calls.models.length, 2);
  await f.api.dispose();
}

// Perception failure on a later daily item is persisted, stops the round, and pauses daily across status reads.
{
  const f = fixture({ feedItems: [recommendation('video-1')] });
  const manual = await startAndFinish(f);
  assert.equal(manual.acceptanceQualified, true);
  assert.equal((await f.api.configure(f.context, { enabled: true })).ok, true);
  f.options.feedItems = [recommendation('video-1'), recommendation('video-2')];
  f.options.perceiveFailureId = 'video-2';
  f.time.value = new Date('2026-11-07T04:30:00.000Z');
  const started = await f.api.tick();
  const job = await finish(f.api, f.context, started.jobId);
  assert.equal(job.state, 'partial');
  assert.equal(job.code, 'DOUYIN_PERCEPTION_FAILED');
  assert.ok(job.error && job.hint);
  assert.equal(job.items.length, 2);
  assert.equal(job.items[0].memorySaved, true);
  assert.equal(job.items[1].state, 'skipped');
  assert.equal(job.items[1].code, 'DOUYIN_PERCEPTION_FAILED');
  assert.ok(job.items[1].error && job.items[1].hint);
  assert.equal(f.calls.models.length, 2); // Manual + first daily video; no second daily model call.
  const status = await f.api.status(f.context);
  assert.equal(status.daily.enabled, false);
  assert.equal(status.daily.paused, true);
  assert.equal(status.daily.lastError.code, 'DOUYIN_PERCEPTION_FAILED');
  assert.equal(status.daily.windows['12:30'].state, 'failed');
  assert.equal(status.daily.windows['12:30'].error.code, 'DOUYIN_PERCEPTION_FAILED');
  await f.api.dispose();
}

// configure(false) cancels and awaits an active daily job before persisting disabled state.
{
  const f = fixture({ feedItems: [recommendation('video-1')], modelCall: async (args, calls) => {
    if (calls.models.length > 1) return new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return { text: output(), usage: {}, finishReason: 'stop' };
  } });
  const manual = await startAndFinish(f);
  assert.equal(manual.acceptanceQualified, true);
  assert.equal((await f.api.configure(f.context, { enabled: true })).ok, true);
  f.time.value = new Date('2026-11-07T04:30:00.000Z');
  const started = await f.api.tick();
  while (f.calls.models.length < 2) await wait(5);
  const disabled = await f.api.configure(f.context, { enabled: false });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  const job = await finishStored(f.stateDir, started.jobId);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.code, 'DOUYIN_CHANNEL_DISABLED');
  const status = await f.api.status(f.context);
  assert.equal(status.daily.enabled, false);
  assert.equal(status.daily.paused, false);
  assert.equal(status.daily.windows['12:30'].state, 'failed');
  await f.api.dispose();
}

// Local dependency timeout is visible; no model request follows it.
{
  const f = fixture({ feedItems: [recommendation()], callbackTimeoutMs: 1000, readFeed: async () => new Promise(() => {}) });
  const job = await startAndFinish(f);
  assert.equal(job.code, 'DOUYIN_OPERATION_TIMEOUT');
  assert.ok(job.error && job.hint);
  assert.equal(f.calls.models.length, 0);
  await f.api.dispose();
}

// Exclusive lock and corrupt ledger both fail closed and preserve existing bytes.
{
  let releaseFeed;
  let feedEntered;
  const entered = new Promise(resolve => { feedEntered = resolve; });
  const hold = new Promise(resolve => { releaseFeed = resolve; });
  const first = fixture({ feedItems: [recommendation()], readFeed: async () => { feedEntered(); await hold; return { ok: true, items: [recommendation()] }; } });
  const started = await first.api.start(first.context);
  await entered;
  const second = fixture({ stateDir: first.stateDir, feedItems: [recommendation()] });
  const busy = assertIssue(await second.api.start(second.context), 'DOUYIN_COMPANION_BUSY');
  assert.ok(busy.hint.includes('不要删除锁文件'));
  releaseFeed();
  await finish(first.api, first.context, started.jobId);
  await first.api.dispose(); await second.api.dispose();

  const damaged = fixture();
  const dir = path.join(damaged.stateDir, 'douyin-companion');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, '{broken');
  const before = fs.readFileSync(file, 'utf8');
  assertIssue(await damaged.api.status(damaged.context), 'DOUYIN_STATE_UNAVAILABLE');
  assertIssue(await damaged.api.start(damaged.context), 'DOUYIN_STATE_UNAVAILABLE');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await damaged.api.dispose();

  const badLock = fixture();
  const lockDir = path.join(badLock.stateDir, 'douyin-companion');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'engine.lock'), '{}');
  const lockError = assertIssue(await badLock.api.start(badLock.context), 'DOUYIN_LOCK_INVALID');
  assert.ok(lockError.hint);
  await badLock.api.dispose();
}

// The manual acceptance ceiling is global and cannot be restored by another engine instance.
{
  const f = fixture();
  const dir = path.join(f.stateDir, 'douyin-companion');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ version: 1, acceptanceCalls: 12, roles: {}, jobs: {} }));
  const limit = assertIssue(await f.api.start(f.context), 'DOUYIN_ACCEPTANCE_BUDGET_EXHAUSTED');
  assert.ok(limit.hint.includes('主线明确授权'));
  assert.equal(f.calls.models.length, 0);
  assert.equal((await f.api.status(f.context)).acceptance.remaining, 0);
  await f.api.dispose();
}

// Sharing is opt-in, uses the same review request, and is recorded only after memorySaved is durable.
{
  const f = fixture({ feedItems: [recommendation('video-share')], modelCall: async () => ({ text: sharingOutput(), usage: {}, finishReason: 'stop' }),
    recordSharing: async (_ctx, payload, { signal }) => {
      assert.ok(signal instanceof AbortSignal);
      const ledger = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'douyin-companion', 'ledger.json'), 'utf8'));
      const item = ledger.jobs[payload.jobId].items.find(value => value.id === payload.id);
      assert.equal(item.memorySaved, true, 'sharing append starts after the durable memorySaved marker');
      assert.equal(Object.hasOwn(item, 'share'), false);
      assert.equal(Object.hasOwn(item, 'question'), false);
      assert.equal(payload.mode, 'acceptance');
      assert.equal(payload.title, '推荐 video-share');
      assert.equal(payload.occurredAt, '2026-11-07T03:01:02.000Z');
      assert.equal(payload.coverage.transcriptComplete, true);
      assert.equal(typeof payload.share, 'string');
      assert.equal(typeof payload.question, 'string');
      return { ok: true };
    } });
  const job = await startAndFinish(f);
  assert.equal(job.state, 'partial');
  assert.equal(job.items[0].memorySaved, true);
  assert.equal(f.calls.models.length, 1, 'share and question use the existing image-review request');
  assert.equal(f.calls.shares.length, 1);
  assert.equal(f.calls.shares[0].value.jobId, job.jobId);
  const status = await f.api.status(f.context);
  assert.equal(Object.hasOwn(status.recentJobs[0].items[0], 'share'), false);
  assert.equal(Object.hasOwn(status.recentJobs[0].items[0], 'question'), false);
  await f.api.dispose();
}

// The current persona section is a trusted style input; other context remains external memory data.
{
  const f = fixture({ feedItems: [recommendation('video-persona-share')],
    buildContext: async () => ({ ok: true, text: 'flattened text is not used when sections are available', sections: [
      { kind: 'persona', text: '这是当前角色自己选择的冷静、简洁表达方式。' },
      { kind: 'memory', text: '过去记忆：用户喜欢海洋纪录片。' },
    ] }),
    modelCall: async args => {
      const payload = JSON.parse(args.prompt);
      assert.equal(payload.persona, '这是当前角色自己选择的冷静、简洁表达方式。');
      assert.equal(payload.context, '过去记忆：用户喜欢海洋纪录片。');
      assert.match(args.system, /persona字段来自本机当前角色/);
      assert.doesNotMatch(args.system, /少女鲸鱼娘伙伴/);
      return { text: sharingOutput({ share: '海洋纪录片里那些慢慢游过的镜头确实挺舒服。', question: '你最喜欢哪类海洋生物？' }), usage: {}, finishReason: 'stop' };
    },
    recordSharing: async () => ({ ok: true }) });
  const job = await startAndFinish(f);
  assert.equal(job.items[0].memorySaved, true);
  assert.equal(f.calls.shares.length, 1);
  await f.api.dispose();
}

// Partial transcript coverage and sparse images stay explicit in the prompt and cannot qualify daily mode.
{
  const f = fixture({ feedItems: [recommendation('video-partial-share')],
    perceive: async item => ({ ok: true, id: item.id, url: item.url, title: item.title, durationMs: 1000,
      observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
      transcript: { text: '我只听到前半段在讲整理步骤。', speechState: 'speech', coverage: { complete: false,
        requestedRanges: [{ startMs: 0, endMs: 1000 }], processedRanges: [{ startMs: 0, endMs: 400 }], missingRanges: [{ startMs: 400, endMs: 1000 }] } },
      frames: [frame], visualCoverage: 'sparse', warnings: [] }),
    modelCall: async args => {
      const material = JSON.parse(args.prompt);
      assert.equal(material.transcriptCoverage.complete, false);
      assert.deepEqual(material.transcriptCoverage.missingRanges, [{ startMs: 400, endMs: 1000 }]);
      assert.equal(material.visualCoverage, 'sparse image samples only; full-video visual coverage is not available');
      assert.match(args.system, /转写或画面覆盖不完整时/);
      return { text: sharingOutput({ share: '我只听懂前半段提到整理步骤，后面的画面和内容还不完整。', question: '你会先整理哪一部分？' }), usage: {}, finishReason: 'stop' };
    },
    recordSharing: async (_ctx, payload) => { assert.equal(payload.coverage.transcriptComplete, false); return { ok: true }; } });
  const job = await startAndFinish(f);
  assert.equal(job.items[0].state, 'partial');
  assert.equal(job.items[0].coverage.acceptanceQualified, false);
  assert.equal((await f.api.configure(f.context, { enabled: true })).code, 'DOUYIN_ACCEPTANCE_REQUIRED');
  await f.api.dispose();
}

// Memory failure prevents any opening from being appended.
{
  const f = fixture({ feedItems: [recommendation('video-no-memory')], modelCall: async () => ({ text: sharingOutput(), usage: {}, finishReason: 'stop' }),
    recordMemory: async () => ({ ok: false, code: 'COMPANION_MEMORY_FAILED', error: 'memory unavailable', hint: 'restore memory' }),
    recordSharing: async () => ({ ok: true }) });
  const job = await startAndFinish(f);
  assert.equal(job.items[0].memorySaved, false);
  assert.equal(f.calls.shares.length, 0);
  await f.api.dispose();
}

// A failed opening keeps the already-saved memory and produces an actionable error; daily mode pauses.
{
  const f = fixture({ feedItems: [recommendation('video-sharing-error')], modelCall: async () => ({ text: sharingOutput(), usage: {}, finishReason: 'stop' }),
    recordSharing: async (_ctx, payload) => payload.mode === 'daily' ? { ok: false } : { ok: true } });
  const acceptance = await startAndFinish(f);
  assert.equal(acceptance.acceptanceQualified, true);
  assert.equal((await f.api.configure(f.context, { enabled: true })).ok, true);
  f.time.value = new Date('2026-11-07T04:30:00.000Z');
  const started = await f.api.tick();
  const daily = await finish(f.api, f.context, started.jobId);
  assert.equal(daily.code, 'DOUYIN_SHARING_SAVE_FAILED');
  assert.ok(daily.error && daily.hint);
  assert.equal(daily.items[0].memorySaved, true);
  assert.equal(daily.items[0].code, 'DOUYIN_SHARING_SAVE_FAILED');
  const status = await f.api.status(f.context);
  assert.equal(status.daily.enabled, false);
  assert.equal(status.daily.paused, true);
  assert.equal(status.daily.lastError.code, 'DOUYIN_SHARING_SAVE_FAILED');
  assert.ok(status.daily.lastError.hint);
  await f.api.dispose();
}

// Cancellation while the append callback is pending aborts it and cannot start a late follow-up.
{
  let entered;
  const sharingEntered = new Promise(resolve => { entered = resolve; });
  let appended = 0;
  const f = fixture({ feedItems: [recommendation('video-cancel-share')], modelCall: async () => ({ text: sharingOutput(), usage: {}, finishReason: 'stop' }),
    recordSharing: async (_ctx, _payload, { signal }) => new Promise((resolve, reject) => {
      entered();
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DOUYIN_CANCELLED' })), { once: true });
      setTimeout(() => { if (!signal.aborted) { appended++; resolve({ ok: true }); } }, 25);
    }) });
  const started = await f.api.start(f.context);
  await sharingEntered;
  assert.equal((await f.api.cancel(f.context)).ok, true);
  await finishStored(f.stateDir, started.jobId);
  await wait(35);
  assert.equal(appended, 0);
  const status = await f.api.status(f.context);
  assert.equal(status.recentJobs[0].items[0].memorySaved, true);
  assert.equal(status.recentJobs[0].items[0].code, 'DOUYIN_CANCELLED');
  await f.api.dispose();
}

// A role epoch change during the append callback aborts the opening and keeps the original memory marker.
{
  let entered;
  const sharingEntered = new Promise(resolve => { entered = resolve; });
  let appended = 0;
  const f = fixture({ feedItems: [recommendation('video-role-share')], modelCall: async () => ({ text: sharingOutput(), usage: {}, finishReason: 'stop' }),
    recordSharing: async (_ctx, _payload, { signal }) => new Promise((resolve, reject) => {
      entered();
      signal.addEventListener('abort', () => reject(Object.assign(new Error('role changed'), { code: 'DOUYIN_STALE_CHARACTER' })), { once: true });
      setTimeout(() => { if (!signal.aborted) { appended++; resolve({ ok: true }); } }, 250);
    }) });
  const started = await f.api.start(f.context);
  await sharingEntered;
  f.role.epoch = 2;
  const stored = await finishStored(f.stateDir, started.jobId);
  await wait(260);
  assert.equal(appended, 0);
  assert.equal(stored.items[0].memorySaved, true);
  assert.equal(stored.code, 'DOUYIN_STALE_CHARACTER');
  await f.api.dispose();
}

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
console.log('Douyin companion engine offline fixtures passed');
