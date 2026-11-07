import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createDouyinService } from '../lib/douyin-service.mjs';
import { createDouyinPerception } from '../lib/douyin-perception.mjs';
import { downloadDouyinMedia, validateDouyinMediaUrl } from '../lib/douyin-media.mjs';
import { runProcess } from '../../../src/perception/process.js';

const SELF = '/aweme/v1/web/user/profile/self/';
const FEED = '/aweme/v1/web/tab/feed/';
const RUNTIME = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-companion-media-test-'));
const fixtureDir = path.join(stateDir, 'fixtures');
fs.mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });

const locate = (name) => {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};
const ffmpegPath = process.env.SURFCORE_TEST_FFMPEG || locate('ffmpeg');
const ffprobePath = process.env.SURFCORE_TEST_FFPROBE || locate('ffprobe');
assert.ok(path.isAbsolute(RUNTIME) && fs.existsSync(RUNTIME), 'official Node 24 runtime is required');
assert.ok(ffmpegPath && path.isAbsolute(ffmpegPath), 'local FFmpeg fixture encoder is required');
assert.ok(ffprobePath && path.isAbsolute(ffprobePath), 'local FFprobe is required');
assert.match(execFileSync(RUNTIME, ['--version'], { encoding: 'utf8' }), /v24\./);

function makeFixture(name, audioSeconds) {
  const file = path.join(fixtureDir, name);
  execFileSync(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${audioSeconds}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-t', '2', '-movflags', '+faststart', file,
  ]);
  return file;
}

const partialFixture = makeFixture('partial.mp4', '1.2');
const fullFixture = makeFixture('full.mp4', '2');

function makeLongFixture() {
  const file = path.join(fixtureDir, 'long.mp4');
  execFileSync(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=121',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=121',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '8', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '16k', '-t', '121', '-movflags', '+faststart', file,
  ]);
  return file;
}

function makeUnknownDurationFixture() {
  const file = path.join(fixtureDir, 'unknown.mkv');
  execFileSync(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=2:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '8', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-t', '2', '-f', 'matroska', file,
  ]);
  return file;
}

const longFixture = makeLongFixture();
const unknownDurationFixture = makeUnknownDurationFixture();

function assertFailure(result, code) {
  assert.equal(result?.ok, false);
  assert.equal(result.code, code);
  assert.ok(result.error, `${code} must include a user-readable error`);
  assert.ok(result.hint, `${code} must include an actionable hint`);
}

function createRequestHarness(plans, lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }]) {
  let calls = 0;
  const requestImpl = (_url, _options, callback) => {
    calls += 1;
    const plan = plans.shift();
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const response = Readable.from(plan.chunks ?? []);
      response.statusCode = plan.status ?? 200;
      response.headers = plan.headers ?? {};
      callback(response);
    });
    return req;
  };
  return { requestImpl, lookupImpl, get calls() { return calls; } };
}

const safeUrl = 'https://v26-web.douyinvod.com/path/video.mp4?auth_key=fixture-secret';
assert.equal(validateDouyinMediaUrl(safeUrl), safeUrl);
assert.equal(validateDouyinMediaUrl('https://www.douyin.com/aweme/v1/play/?video_id=1&auth_key=signed'), 'https://www.douyin.com/aweme/v1/play/?video_id=1&auth_key=signed');
for (const value of [
  'http://v26-web.douyinvod.com/video.mp4',
  'https://user@v26-web.douyinvod.com/video.mp4',
  'https://douyinvod.com.evil.example/video.mp4',
  'https://v3.example.snssdk.com/video.mp4',
  'https://example.com/video.mp4',
  'https://www.douyin.com/video/123',
]) {
  assert.throws(() => validateDouyinMediaUrl(value), error => /^DOUYIN_MEDIA_URL_/.test(error.code) && !!error.hint);
}

{
  for (const [address, family] of [['127.0.0.1', 4], ['10.0.0.5', 4], ['::1', 6], ['fc00::5', 6]]) {
    const plan = createRequestHarness([], async () => [{ address, family }]);
    const out = path.join(fixtureDir, `private-dns-${family}-${address.includes(':') ? 'v6' : 'v4'}.mp4`);
    await assert.rejects(downloadDouyinMedia(safeUrl, out, plan), error => error.code === 'DOUYIN_MEDIA_DNS_REJECTED' && !!error.hint);
    assert.equal(plan.calls, 0, 'private DNS answers must be rejected before any request');
    assert.equal(fs.existsSync(out), false);
  }
}

{
  const plan = createRequestHarness([{ status: 302, headers: { location: 'http://127.0.0.1/private.mp4' }, chunks: [] }]);
  const out = path.join(fixtureDir, 'redirect.mp4');
  await assert.rejects(downloadDouyinMedia(safeUrl, out, plan), error => error.code === 'DOUYIN_MEDIA_REDIRECT_REJECTED' && !!error.hint);
  assert.equal(plan.calls, 1, 'an unsafe redirect target must not receive a request');
  assert.equal(fs.existsSync(out), false);
}

{
  let resolutions = 0;
  const plan = createRequestHarness([{ status: 302, headers: { location: 'https://v11-web-prime.douyinvod.com/second.mp4' }, chunks: [] }], async () => {
    resolutions += 1;
    return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  });
  const out = path.join(fixtureDir, 'redirect-private-dns.mp4');
  await assert.rejects(downloadDouyinMedia(safeUrl, out, plan), error => error.code === 'DOUYIN_MEDIA_DNS_REJECTED' && !!error.hint);
  assert.equal(plan.calls, 1, 'every redirect must be resolved and checked before its request');
  assert.equal(resolutions, 2);
  assert.equal(fs.existsSync(out), false);
}

{
  const controller = new AbortController();
  let lateRejected = false;
  const plan = createRequestHarness([], () => new Promise((_resolve, reject) => {
    setTimeout(() => { lateRejected = true; reject(new Error('late DNS rejection')); }, 100);
  }));
  const out = path.join(fixtureDir, 'dns-cancelled.mp4');
  const startedAt = Date.now();
  const pending = downloadDouyinMedia(safeUrl, out, { ...plan, signal: controller.signal, totalTimeoutMs: 1000 });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => error.code === 'DOUYIN_MEDIA_CANCELLED' && !!error.hint);
  assert.ok(Date.now() - startedAt < 80, 'abort must release a stalled DNS lookup promptly');
  assert.equal(plan.calls, 0, 'an aborted DNS lookup must never start a network request');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(lateRejected, true, 'the ignored DNS operation must settle after the caller has stopped waiting');
  assert.equal(fs.existsSync(out), false);
}

{
  const plan = createRequestHarness([{ headers: { 'content-length': '4' }, chunks: [Buffer.from('data')] }]);
  const out = path.join(fixtureDir, 'oversized.mp4');
  await assert.rejects(downloadDouyinMedia(safeUrl, out, { ...plan, maxBytes: 3 }), error => error.code === 'DOUYIN_MEDIA_TOO_LARGE' && !!error.hint);
  assert.equal(fs.existsSync(out), false);
}

{
  const plan = createRequestHarness([{ headers: { 'content-length': '8' }, chunks: [Buffer.from('fixture')] }]);
  const out = path.join(fixtureDir, 'download.mp4');
  const downloaded = await downloadDouyinMedia(safeUrl, out, plan);
  assert.equal(downloaded.sizeBytes, 7);
  assert.doesNotMatch(JSON.stringify(downloaded), /auth_key|fixture-secret|douyinvod/);
  fs.unlinkSync(out);
}

const role = { id: 'role1', epoch: 1 };
let browserCount = 0;
const rawItems = Array.from({ length: 5 }, (_, index) => ({
  aweme_id: String(index + 1),
  desc: `fixture ${index + 1}`,
  video: { duration: 2000, play_addr: { url_list: [`https://v26-web.douyinvod.com/${index + 1}.mp4?auth_key=fixture-secret`] } },
}));
const selfPayload = { status_code: 0, user: { uid: '123456', sec_uid: 'sec', nickname: 'fixture account' } };
let feedSelfPayload = selfPayload, delayFeedResponse = false, stickyMismatchScenario = false;
const otherAccountSelfPayload = { status_code: 0, user: { uid: '999999', sec_uid: 'other-sec', nickname: 'other account' } };
const otherAccountFeed = { status_code: 0, aweme_list: Array.from({ length: 5 }, (_, index) => ({
  aweme_id: String(90 + index), desc: `other account ${index}`,
  video: { duration: 2000, play_addr: { url_list: [`https://v26-web-prime.douyinvod.com/${90 + index}.mp4?auth_key=other-secret`] } },
})) };

function browserFactory(options) {
  browserCount += 1;
  let sequence = 0, running = false;
  const emit = (payload, pathname) => {
    sequence += 1;
    options.onResponse(payload, { pathname, status: 200, requestSeq: sequence, sessionId: 'fixture-session', requestId: `request-${sequence}` });
  };
  return {
    status: () => ({ ok: true, running, requestSeq: sequence }),
    async start() { running = true; emit(selfPayload, SELF); return { ok: true }; },
    async loadRecommendations() {
      if (stickyMismatchScenario) {
        emit(selfPayload, SELF);
        emit(otherAccountSelfPayload, SELF);
        emit(otherAccountFeed, FEED);
        emit(selfPayload, SELF);
      } else if (delayFeedResponse) setTimeout(() => { emit({ status_code: 0, aweme_list: rawItems }, FEED); emit(feedSelfPayload, SELF); }, 5);
      else { emit({ status_code: 0, aweme_list: rawItems }, FEED); emit(feedSelfPayload, SELF); }
      return { ok: true };
    },
    async reload() { emit(selfPayload, SELF); return { ok: true }; },
    async snapshot() { return { ok: true, url: 'https://www.douyin.com/', title: '', text: '' }; },
    async close() { running = false; return { ok: true }; },
  };
}

const douyinState = path.join(stateDir, 'douyin-service');
fs.mkdirSync(douyinState, { recursive: true, mode: 0o700 });
const douyin = createDouyinService({ stateDir: douyinState, getCharacter: () => role, browserFactory, waitMs: 50 });
const context = () => ({ characterId: role.id, characterEpoch: role.epoch });
assert.equal((await douyin.setEnabled(true, context())).ok, true);
const login = await douyin.beginLogin(context());
assert.equal(login.ok, true);
assert.equal((await douyin.confirmAccount({ ...context(), candidateId: login.candidate.candidateId })).ok, true);
const publicFeed = await douyin.readFeed(context());
assert.equal(publicFeed.ok, true);
assert.equal(publicFeed.items.length, 5);
assert.doesNotMatch(JSON.stringify(publicFeed), /mediaSource|douyinvod|fixture-secret|play_addr/);
const privateFeed = await douyin.readFeedForCompanion(context());
assert.equal(privateFeed.ok, true);
assert.equal(privateFeed.source, 'homepage-recommendation');
assert.equal(privateFeed.items.length, 5);
assert.equal(privateFeed.items[0].mediaSource, rawItems[0].video.play_addr.url_list[0]);
assert.doesNotMatch(JSON.stringify(await douyin.status()), /douyinvod|fixture-secret/);
assert.equal(browserCount, 3);
delayFeedResponse = true;
const delayedFeed = await douyin.readFeedForCompanion(context());
delayFeedResponse = false;
assert.equal(delayedFeed.ok, true);
assert.equal(delayedFeed.items[0].mediaSource, rawItems[0].video.play_addr.url_list[0], 'the raw fixed-feed response arriving during findEvent wait must remain available internally');
stickyMismatchScenario = true;
const stickyPublicMismatch = await douyin.readFeed(context());
assertFailure(stickyPublicMismatch, 'DOUYIN_ACCOUNT_CHANGED');
assert.doesNotMatch(JSON.stringify(stickyPublicMismatch), /other-secret|other account|mediaSource/);
const stickyCompanionMismatch = await douyin.readFeedForCompanion(context());
assertFailure(stickyCompanionMismatch, 'DOUYIN_ACCOUNT_CHANGED');
assert.doesNotMatch(JSON.stringify(stickyCompanionMismatch), /other-secret|other account|mediaSource|90/);
stickyMismatchScenario = false;
feedSelfPayload = { status_code: 0, user: { uid: '999999', sec_uid: 'other', nickname: 'other account' } };
const wrongAccount = await douyin.readFeedForCompanion(context());
assertFailure(wrongAccount, 'DOUYIN_ACCOUNT_CHANGED');
assert.doesNotMatch(JSON.stringify(wrongAccount), /douyinvod|fixture-secret|play_addr/);
feedSelfPayload = selfPayload;

const copyFixture = fixture => async (_source, outputPath, { signal } = {}) => {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'DOUYIN_MEDIA_CANCELLED', hint: 'cancelled' });
  fs.copyFileSync(fixture, outputPath, fs.constants.COPYFILE_EXCL);
  return { path: outputPath, sizeBytes: fs.statSync(outputPath).size };
};
const mediaFixture = copyFixture(partialFixture);

function asrHarness({ state = 'completed', gateCancel = false } = {}) {
  let request, jobCalls = 0, cancelCalls = 0, releaseCancel;
  const service = {
    async submit(value) { request = value; return { jobId: `douyin-asr-${++jobCalls}` }; },
    async getJob() {
      if (state === 'running') return { state: 'running' };
      const range = request.asset.acquiredRanges[0] ?? null;
      const requested = request.requestedRanges[0];
      const processedRanges = range ? [range] : [];
      const missingRanges = range && range.endMs < requested.endMs ? [{ startMs: range.endMs, endMs: requested.endMs }] : [];
      const complete = !missingRanges.length && range?.endMs === requested.endMs;
      return {
        state,
        coverage: { requestedRanges: request.requestedRanges, acquiredRanges: request.asset.acquiredRanges, processedRanges, missingRanges, complete },
        result: { segments: [{ startMs: 0, endMs: Math.min(900, requested.endMs), text: 'fixture transcript' }], speechState: 'speech', coverage: { requestedRanges: request.requestedRanges, acquiredRanges: request.asset.acquiredRanges, processedRanges, missingRanges, complete } },
      };
    },
    async cancel() {
      cancelCalls += 1;
      if (gateCancel) return await new Promise(resolve => { releaseCancel = resolve; });
      return { state: 'cancelled' };
    },
    get request() { return request; },
    get cancelCalls() { return cancelCalls; },
    get jobCalls() { return jobCalls; },
    releaseCancel(value = { state: 'cancelled' }) { releaseCancel?.(value); },
  };
  return service;
}

const asr = asrHarness();
const perception = createDouyinPerception({ stateDir, asrService: asr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: mediaFixture, pollMs: 50 });
const result = await perception.perceive(privateFeed.items[0], context(), { activityId: 'activity1' });
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.source, 'homepage-recommendation');
assert.equal(result.transcript.text, 'fixture transcript');
assert.equal(result.transcript.coverage.complete, false, 'the shorter ffprobe audio track must remain partial');
assert.ok(result.transcript.coverage.missingRanges.length > 0);
assert.equal(result.frames.length, 3);
assert.ok(result.frames.every(frame => /^data:image\/jpeg;base64,/.test(frame.dataUrl)));
assert.deepEqual(result.frames.map(frame => frame.atMs), [200, 1000, 1800]);
assert.ok(result.warnings.some(warning => warning.code === 'DOUYIN_AUDIO_PARTIAL' && warning.error && warning.hint));
assert.doesNotMatch(JSON.stringify(result), /mediaSource|douyinvod|fixture-secret|localPath|assetId/);
assert.equal(asr.request.provenance.sourceUrl, undefined, 'signed CDN URLs must never enter the ASR job');
assert.equal(asr.request.provenance.channel, 'douyin');
assert.equal(asr.request.source.channel, 'douyin');
assert.equal(fs.existsSync(asr.request.asset.localPath), false, 'transient audio is removed after the ASR job completes');
assert.deepEqual(fs.readdirSync(path.join(stateDir, 'perception', 'assets', 'douyin-transient')), []);

const fullAsr = asrHarness();
const fullPerception = createDouyinPerception({ stateDir, asrService: fullAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: copyFixture(fullFixture), pollMs: 50 });
const fullResult = await fullPerception.perceive(privateFeed.items[0], context(), { activityId: 'activity-full' });
assert.equal(fullResult.ok, true, JSON.stringify(fullResult));
assert.equal(fullResult.durationMs, 2000, 'duration uses actual ffprobe stream duration');
assert.equal(fullResult.transcript.coverage.complete, true);
assert.deepEqual(fullResult.transcript.coverage.missingRanges, []);
assert.equal(fullResult.warnings.some(warning => warning.code === 'DOUYIN_AUDIO_PARTIAL'), false);
assert.equal(fs.existsSync(fullAsr.request.asset.localPath), false);

for (const frame of result.frames) {
  const file = path.join(fixtureDir, `frame-${frame.atMs}.jpg`);
  fs.writeFileSync(file, Buffer.from(frame.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'), { mode: 0o600 });
  const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].codec_name, 'mjpeg');
  assert.ok(probe.streams[0].width <= 512 && probe.streams[0].height <= 512);
  fs.unlinkSync(file);
}

const frameFailAsr = asrHarness();
const frameFailPerception = createDouyinPerception({
  stateDir,
  asrService: frameFailAsr,
  getCharacter: () => role,
  ffmpegPath,
  ffprobePath,
  downloadMedia: mediaFixture,
  runProcessImpl: async (executable, args, options) => options?.stage === 'extract-frame'
    ? { code: 1, stdout: '', stderr: '' }
    : await runProcess(executable, args, options),
});
const noFrames = await frameFailPerception.perceive(privateFeed.items[0], context(), { activityId: 'frame-failure' });
assert.equal(noFrames.ok, true);
assert.deepEqual(noFrames.frames, []);
assert.equal(noFrames.visualCoverage, 'sparse');
assert.ok(noFrames.warnings.length >= 3 && noFrames.warnings.every(warning => warning.code && warning.error && warning.hint));

let downloads = 0;
const noDownload = async () => { downloads += 1; throw new Error('must not download'); };
const strictPerception = createDouyinPerception({ stateDir, asrService: asrHarness(), getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: noDownload });
const unknownDuration = await strictPerception.perceive({ ...privateFeed.items[0], durationMs: undefined }, context(), { activityId: 'unknown' });
assertFailure(unknownDuration, 'DOUYIN_MEDIA_DURATION_UNKNOWN');
const longDuration = await strictPerception.perceive({ ...privateFeed.items[0], durationMs: 120001 }, context(), { activityId: 'long' });
assertFailure(longDuration, 'DOUYIN_MEDIA_DURATION_TOO_LONG');
const unsafeHost = await strictPerception.perceive({ ...privateFeed.items[0], mediaSource: 'https://evil.example/video.mp4' }, context(), { activityId: 'unsafe' });
assertFailure(unsafeHost, 'DOUYIN_MEDIA_URL_REJECTED');
assert.equal(downloads, 0);

const unknownProbeAsr = asrHarness();
const unknownProbePerception = createDouyinPerception({ stateDir, asrService: unknownProbeAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: copyFixture(unknownDurationFixture) });
const unknownProbe = await unknownProbePerception.perceive(privateFeed.items[0], context(), { activityId: 'unknown-probe' });
assertFailure(unknownProbe, 'DOUYIN_MEDIA_DURATION_UNKNOWN');
assert.equal(unknownProbeAsr.jobCalls, 0, 'unknown actual probe duration must not submit ASR');

const overlongAsr = asrHarness();
const overlongPerception = createDouyinPerception({ stateDir, asrService: overlongAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: copyFixture(longFixture) });
const overlong = await overlongPerception.perceive({ ...privateFeed.items[0], durationMs: 2000 }, context(), { activityId: 'overlong-actual' });
assertFailure(overlong, 'DOUYIN_MEDIA_DURATION_TOO_LONG');
assert.equal(overlongAsr.jobCalls, 0, 'actual media above 120 seconds must not submit ASR');

const cancelAsr = asrHarness({ state: 'running', gateCancel: true });
const cancelPerception = createDouyinPerception({ stateDir, asrService: cancelAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: mediaFixture, pollMs: 50 });
const abortController = new AbortController();
let finished = false;
const cancelling = cancelPerception.perceive(privateFeed.items[0], context(), { signal: abortController.signal, activityId: 'cancel-asr' }).finally(() => { finished = true; });
for (let i = 0; i < 500 && cancelAsr.jobCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(cancelAsr.jobCalls, 1, 'ASR submission belongs to this perception round');
abortController.abort();
for (let i = 0; i < 100 && cancelAsr.cancelCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(cancelAsr.cancelCalls, 1);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(finished, false, 'perceive waits for the owned ASR cancellation to finish');
cancelAsr.releaseCancel();
assertFailure(await cancelling, 'DOUYIN_PERCEPTION_CANCELLED');
assert.equal(finished, true);

const unconfirmedAsr = asrHarness({ state: 'running' });
unconfirmedAsr.cancel = async () => { throw Object.assign(new Error('persist EIO'), { code: 'EIO' }); };
const unconfirmedPerception = createDouyinPerception({ stateDir, asrService: unconfirmedAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: mediaFixture, pollMs: 50 });
const unconfirmedController = new AbortController();
const unconfirmedRound = unconfirmedPerception.perceive(privateFeed.items[0], context(), { signal: unconfirmedController.signal, activityId: 'cancel-unconfirmed' });
for (let i = 0; i < 500 && unconfirmedAsr.jobCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(unconfirmedAsr.jobCalls, 1, 'the unconfirmed cancellation belongs to this ASR job');
unconfirmedController.abort();
const unconfirmedResult = await unconfirmedRound;
assertFailure(unconfirmedResult, 'DOUYIN_ASR_CANCEL_FAILED');
assert.match(unconfirmedResult.hint, /确认已停止后.*不要删除/);
assert.equal((await unconfirmedAsr.getJob('douyin-asr-1')).state, 'running', 'a failed cancel persistence leaves the simulated owned ASR job running');
const retainedAudioPath = unconfirmedAsr.request.asset.localPath;
const retainedWorkDirectory = path.dirname(retainedAudioPath);
assert.equal(fs.existsSync(retainedAudioPath), true, 'audio must remain available while ASR cancellation is unconfirmed');
assert.equal(fs.existsSync(path.join(retainedWorkDirectory, 'source.mp4')), true, 'the media work directory must remain intact until ASR stops');
assert.equal(fs.readdirSync(retainedWorkDirectory).length, 5, 'video, audio and sparse frames remain isolated together');
fs.rmSync(retainedWorkDirectory, { recursive: true, force: true });

const staleAsr = asrHarness({ state: 'running' });
const stalePerception = createDouyinPerception({ stateDir, asrService: staleAsr, getCharacter: () => role, ffmpegPath, ffprobePath, downloadMedia: mediaFixture, pollMs: 25 });
const staleRound = stalePerception.perceive(privateFeed.items[0], context(), { activityId: 'stale-round' });
for (let i = 0; i < 500 && staleAsr.jobCalls === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
role.epoch += 1;
assertFailure(await staleRound, 'DOUYIN_PERCEPTION_STALE');
assert.equal(staleAsr.cancelCalls, 1, 'role epoch change cancels the owned ASR job');
role.epoch -= 1;

{
  const controller = new AbortController();
  let child;
  const running = runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=512x512:rate=25:duration=5', '-f', 'null', '-',
  ], { signal: controller.signal, timeoutMs: 10_000, stage: 'test-cancel', spawnImpl: (executable, args, options) => { child = spawn(executable, args, options); return child; } });
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort();
  await assert.rejects(running, error => error.code === 'ASR_CANCELLED');
  assert.ok(child.signalCode || child.exitCode !== null, 'cancelled FFmpeg child must terminate before perceive unwinds');
}

await douyin.dispose();
fs.rmSync(stateDir, { recursive: true, force: true });
console.log('douyin companion media: ok');
