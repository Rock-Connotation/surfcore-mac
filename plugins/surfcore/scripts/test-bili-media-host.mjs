import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBiliPerceptionService } from '../lib/bili-perception.js'
import { pruneShots } from '../tools/lib/shots-cache.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-host-'))
let role = { id: 'one', epoch: 2 }, submitted = 0, cancelled = 0
const asr = { ready: Promise.resolve(), async submit(request) { submitted++; assert.equal(request.characterEpoch, 2); return { jobId: 'child' } }, async getJob() { return { state: 'completed', result: { transcriptId: 't', segments: [], coverage: { complete: true, processedRanges: [{ startMs: 0, endMs: 3000 }] } } } }, async listJobs() { return [] }, async cancel() { cancelled++ }, async resume() {}, async doctor() {}, async getStatus() {}, async configure() {}, async dispose() {} }
const partView = { bvid: 'BV1234567890', aid: 1, owner: {}, pages: [{ page: 1, cid: 1, duration: 3 }, { page: 2, cid: 2, duration: 3 }] }
const createApi = () => ({ async fetchView() { return partView }, async fetchPlayurl() {} })
const prepareMedia = async ({ dataRoot, signal }) => { assert.equal(signal.aborted, false); fs.mkdirSync(dataRoot, { recursive: true }); const file = path.join(dataRoot, `test-${Date.now()}`); fs.writeFileSync(file, 'abc'); return { audio: { path: file, status: 'completed', contentSha256: 'a'.repeat(64), durationMs: 3000, acquiredRanges: [{ startMs: 0, endMs: 3000 }], timelineMap: [{ localStartMs: 0, localEndMs: 3000, sourceStartMs: 0, sourceEndMs: 3000 }] } } }
let eventCalls = [], failMemory = true
const service = createBiliPerceptionService({ asrService: asr, stateDir: root, getCharacter: () => role, createApi, prepareMedia, onExperience: async event => { eventCalls.push(event); return failMemory ? { ok: false, code: 'MEMORY_FAILED', error: '投影失败', hint: '重试' } : { ok: true } } })
const request = { bvid: partView.bvid, page: 2, cid: '2', characterId: 'one', characterEpoch: 2, activityId: 'activity', asr: true, frames: false }
const { jobId } = await service.submitBili(request)
for (let i = 0; i < 30 && !['completed','failed'].includes((await service.getJob(jobId)).state); i++) await new Promise(r => setTimeout(r, 10))
const job = await service.getJob(jobId)
assert.equal(job.state, 'completed'); assert.equal(job.part.cid, '2'); assert.equal(submitted, 1)
assert.equal(job.memoryState, 'failed'); assert.equal(job.memoryError.code, 'MEMORY_FAILED'); assert.equal(eventCalls[0].attribution.subject, 'external'); assert.equal(eventCalls[0].visibility.classification, 'restricted'); assert.deepEqual(eventCalls[0].visibility.allowedContexts, ['bili']); failMemory = false; await service.resume(jobId); assert.equal((await service.getJob(jobId)).memoryState, 'completed'); assert.equal(eventCalls[1].eventId, eventCalls[0].eventId); assert.equal(submitted, 1)
assert.ok(!JSON.stringify(job).includes(root), 'public job 不包含资产本地路径')
role = { id: 'two', epoch: 3 }
await assert.rejects(service.submitBili(request), e => e.code === 'STALE_CHARACTER' && !!e.hint)
let started
const pending = new Promise(resolve => { started = resolve })
const blocked = createBiliPerceptionService({ asrService: asr, stateDir: path.join(root, 'other'), getCharacter: () => ({ id: 'one', epoch: 2 }), createApi, prepareMedia: async ({ signal }) => { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(new Error('cancelled'), { code: 'media.cancelled', hint: '重试' }) } })
const other = await blocked.submitBili(request); await pending; await assert.rejects(blocked.configure({}), e => e.code === 'ASR_CONFIG_BUSY' && !!e.hint); await blocked.cancel(other.jobId)
for (let i = 0; i < 30 && (await blocked.getJob(other.jobId)).state !== 'cancelled'; i++) await new Promise(r => setTimeout(r, 10))
assert.equal((await blocked.getJob(other.jobId)).state, 'cancelled'); assert.equal(submitted, 1)
const restartRoot = path.join(root, 'restart'), restartJobs = path.join(restartRoot, 'perception', 'bili-jobs'); fs.mkdirSync(restartJobs, { recursive: true })
const oldId = 'bili-00000000-0000-4000-8000-000000000001'
fs.writeFileSync(path.join(restartJobs, `${oldId}.json`), JSON.stringify({ jobId: oldId, state: 'running', characterId: 'one', characterEpoch: 2, activityId: 'activity', request: { ...request } }))
const restarted = createBiliPerceptionService({ asrService: asr, stateDir: restartRoot, getCharacter: () => ({ id: 'one', epoch: 2 }), createApi, prepareMedia })
assert.equal((await restarted.getJob(oldId)).state, 'interrupted'); assert.equal((await restarted.resume(oldId)).jobId, oldId)
for (let i = 0; i < 30 && !['completed','failed'].includes((await restarted.getJob(oldId)).state); i++) await new Promise(r => setTimeout(r, 10))
assert.equal((await restarted.getJob(oldId)).state, 'completed'); assert.equal(submitted, 2)
const persisted = fs.readFileSync(path.join(restartJobs, `${oldId}.json`), 'utf8'); assert.ok(!persisted.includes('cookie') && !persisted.includes('https://') && !persisted.includes('localPath'))
const listRoot = path.join(root, 'list'), listDir = path.join(listRoot, 'perception', 'bili-jobs'); fs.mkdirSync(listDir, { recursive: true })
for (let i = 0; i < 41; i++) { const id = `bili-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`; fs.writeFileSync(path.join(listDir, `${id}.json`), JSON.stringify({ jobId: id, state: 'completed', characterId: 'one', characterEpoch: 2, activityId: `old${i}`, createdAt: `2025-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00.000Z`, request: { secret: 'must-not-appear' } })) }
const sharedJobs = [{ jobId: 'child-old-running', state: 'running', characterId: 'one', createdAt: '2020-01-01T00:00:00.000Z', request: { asset: { localPath: '/secret/local' } } }, { jobId: 'child-recent', state: 'completed', characterId: 'one', createdAt: '2026-01-01T00:00:00.000Z' }]
const listAsr = { ...asr, async listJobs(options) { return sharedJobs.filter(job => (!options.state || job.state === options.state) && (!options.characterId || options.characterId === job.characterId)) } }
let listStarted; const listReady = new Promise(resolve => { listStarted = resolve })
const listService = createBiliPerceptionService({ asrService: listAsr, stateDir: listRoot, getCharacter: () => ({ id: 'one', epoch: 2 }), createApi, prepareMedia: async ({ signal }) => { listStarted(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(new Error('cancelled'), { code: 'media.cancelled', hint: '重试' }) } })
const fresh = await listService.submitBili(request); await listReady
const listed = await listService.listJobs({ characterId: 'one', limit: 40 })
assert.equal(listed.length, 40); assert.ok(listed.slice(0, 2).some(job => job.jobId === fresh.jobId)); assert.ok(listed.slice(0, 2).some(job => job.jobId === 'child-old-running'))
assert.ok(!JSON.stringify(listed).includes('/secret/local') && !JSON.stringify(listed).includes('must-not-appear'))
assert.deepEqual((await listService.listJobs({ characterId: 'one', state: 'running', limit: 40 })).map(job => job.state), ['running', 'running'])
await listService.cancel(fresh.jobId); await listService.dispose()
const protectedRoot = path.join(root, 'protected'); fs.mkdirSync(path.join(protectedRoot, 'video'), { recursive: true }); const keep = path.join(protectedRoot, 'video', 'keep'); fs.writeFileSync(keep, 'x')
assert.equal(pruneShots({ root: protectedRoot, protectedRoots: [path.join(protectedRoot, 'video')], retentionDays: 0, maxMB: 0.0000001 }).errors[0].code, 'shots.protected-root'); assert.ok(fs.existsSync(keep))
const shots = path.join(root, 'shots'), active = path.join(shots, 'video', '.frames-active'); fs.mkdirSync(active, { recursive: true }); fs.writeFileSync(path.join(active, '.lease.json'), JSON.stringify({ pid: process.pid })); const old = new Date(Date.now() - 10 * 86400000); fs.utimesSync(active, old, old)
pruneShots({ root: shots, protectedRoots: [], retentionDays: 7 }); assert.ok(fs.existsSync(active), '活跃帧租约应保留')
await service.dispose(); await blocked.dispose(); await restarted.dispose()
console.log('bili Host parent job, cancellation, stale role, protected cache and active lease passed')
