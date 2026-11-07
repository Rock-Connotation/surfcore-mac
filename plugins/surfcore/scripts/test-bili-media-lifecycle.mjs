import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createBiliPerceptionService } from '../lib/bili-perception.js'
import { verifyMediaDecode } from '../tools/lib/bili-media.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-lifecycle-'))
const role = { id: 'role', epoch: 1 }
const view = { bvid: 'BV1234567890', aid: 1, owner: {}, pages: [{ page: 1, cid: 1, duration: 1 }] }
const createApi = () => ({ async fetchView() { return view }, async fetchPlayurl() {} })
const asr = { async submit() { return { jobId: 'child' } }, async getJob() { return { state: 'completed' } }, async listJobs() { return [] }, async cancel() {}, async dispose() {} }
const request = { bvid: view.bvid, characterId: role.id, characterEpoch: role.epoch, activityId: 'a', asr: true }
let started, exited = false, calls = 0
const ready = new Promise(resolve => { started = resolve })
const prepareMedia = async ({ signal }) => {
  calls++
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250)); process.stdout.write('READY\\n'); setInterval(()=>{},1000)"])
  child.stdout.once('data', () => started())
  signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
  await new Promise((resolve, reject) => { child.once('close', () => { exited = true; resolve() }); child.once('error', reject) })
  throw Object.assign(new Error('cancelled'), { code: 'media.cancelled', hint: '重试' })
}
const service = createBiliPerceptionService({ asrService: asr, stateDir: root, getCharacter: () => role, createApi, prepareMedia })
const first = await service.submitBili(request); await ready
const second = await service.submitBili({ ...request, activityId: 'b' })
assert.equal((await service.getJob(second.jobId)).state, 'queued')
const before = Date.now(); assert.equal((await service.cancel(second.jobId)).state, 'cancelled'); assert.ok(Date.now() - before < 200, 'queued cancel must not await other job')
assert.equal(calls, 1); assert.equal((await service.cancel(first.jobId)).state, 'cancelled'); assert.equal(exited, true, 'cancel must wait for helper exit')
await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(calls, 1, 'cancelled queue item must never run')
let releaseResult, queryStarted, childCancelled = 0
const queryReady = new Promise(resolve => { queryStarted = resolve })
const lateAsr = { ...asr, async getJob() { queryStarted(); return await new Promise(resolve => { releaseResult = resolve }) }, async cancel() { childCancelled++ } }
const lateService = createBiliPerceptionService({ asrService: lateAsr, stateDir: path.join(root, 'late'), getCharacter: () => role, createApi, prepareMedia: async ({ dataRoot }) => { fs.mkdirSync(dataRoot, { recursive: true }); const asset = path.join(dataRoot, 'asset'); fs.writeFileSync(asset, 'a'); return { audio: { path: asset, status: 'completed', contentSha256: 'a'.repeat(64), durationMs: 1000, acquiredRanges: [{ startMs: 0, endMs: 1000 }], timelineMap: [] } } } })
const late = await lateService.submitBili(request); await queryReady
let cancelDone = false; const cancel = lateService.cancel(late.jobId).then(result => { cancelDone = true; return result })
await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(cancelDone, false)
releaseResult({ state: 'completed', result: { segments: [], coverage: { complete: true } } })
assert.equal((await cancel).state, 'cancelled'); assert.equal((await lateService.getJob(late.jobId)).state, 'cancelled'); assert.ok(childCancelled >= 1)
// A slow playurl lookup must not start acquisition after role/cancel changes.
for (const boundary of ['role', 'cancel']) {
  let activeRole = { ...role }, releasePlayurl, markPlayurl, prepares = 0;
  const playurlStarted = new Promise(resolve => { markPlayurl = resolve });
  const guardedService = createBiliPerceptionService({ asrService: asr, stateDir: path.join(root, `playurl-${boundary}`), getCharacter: () => activeRole,
    createApi: () => ({ async fetchView() { return view }, async fetchPlayurl() { markPlayurl(); return await new Promise(resolve => { releasePlayurl = resolve }) } }),
    prepareMedia: async () => { prepares++; throw new Error('acquisition must not start after boundary') } });
  const job = await guardedService.submitBili(request); await playurlStarted;
  let cancellation;
  if (boundary === 'role') activeRole = { ...role, epoch: 2 };
  else cancellation = guardedService.cancel(job.jobId);
  releasePlayurl({});
  if (cancellation) await cancellation;
  let result;
  for (let i = 0; i < 100; i++) { result = await guardedService.getJob(job.jobId); if (!['queued', 'running'].includes(result.state)) break; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.equal(prepares, 0, `late playurl must not acquire after ${boundary}`);
  assert.equal(result.state, boundary === 'role' ? 'interrupted' : 'cancelled');
  if (boundary === 'role') assert.equal(result.error.code, 'STALE_CHARACTER');
  await guardedService.dispose();
}
if (process.platform !== 'win32') {
// A GUI Host can have an empty PATH. The executable fixture must use the
// same Node as the test runner, including when its absolute path has spaces.
const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`
function makeHelper(name, source) {
  const script = path.join(root, `${name}.mjs`), wrapper = path.join(root, `${name}.sh`)
  fs.writeFileSync(script, source, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o755, flag: 'wx' })
  return wrapper
}
const readyFile = path.join(root, 'helper-ready'), exitFile = path.join(root, 'helper-exit')
const helper = makeHelper('helper', `import fs from 'node:fs'; process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(exitFile)}, 'exited');process.exit(0)}, 200)); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(()=>{},1000);\n`)
const controller = new AbortController()
let earlyFailure = null, helperSettled = false
const decode = verifyMediaDecode(path.join(root, 'fixture'), { ffmpegPath: helper, signal: controller.signal }).then(() => { helperSettled = true; return null }, error => { helperSettled = true; earlyFailure = error; return error })
const readyDeadline = Date.now() + 15_000
while (!fs.existsSync(readyFile) && !helperSettled && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 25))
const helperReady = fs.existsSync(readyFile), settledAtReadiness = helperSettled, failureAtReadiness = earlyFailure
if (!helperReady) { controller.abort(); await decode } // Reap our child even when readiness fails.
assert.ok(helperReady, `helper 未就绪：${failureAtReadiness?.code ?? (settledAtReadiness ? '提前退出' : '等待超时')} ${failureAtReadiness?.message ?? ''}`)
controller.abort(); const failure = await decode
assert.equal(failure.code, 'media.tool.cancelled'); assert.ok(fs.existsSync(exitFile), 'FFmpeg wrapper must wait for the child to exit')
const timeoutExit = path.join(root, 'timeout-exit'), timeoutReady = path.join(root, 'timeout-ready')
const timeoutHelper = makeHelper('timeout-helper', `import fs from 'node:fs'; process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(timeoutExit)}, 'exited');process.exit(0)}, 100)); fs.writeFileSync(${JSON.stringify(timeoutReady)}, 'ready'); setInterval(()=>{},1000);\n`)
const timeoutFailure = await verifyMediaDecode(path.join(root, 'fixture'), { ffmpegPath: timeoutHelper, timeoutMs: 5000 }).then(() => null, error => error)
assert.equal(timeoutFailure.code, 'media.tool.timeout'); assert.ok(fs.existsSync(timeoutReady), 'timeout helper exited before its signal handler became ready'); assert.ok(fs.existsSync(timeoutExit), 'timeout must wait for helper exit')
}
await service.dispose(); await lateService.dispose()
console.log('serialized media, queued cancellation, helper reaping and late ASR result cancellation passed')
