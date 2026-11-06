import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBiliApi, normalizeBiliPartTimeline, parseBiliReference, resolveBiliPart, prepareBiliMedia } from '../tools/lib/bili-media.mjs'
import { createPerceptionClient, assertManagedAsset, buildBiliTranscriptionRequest } from '../tools/lib/perception-client.mjs'
import { appendWatch } from '../tools/lib/watch-history.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-media-test-'))
const view = { bvid: 'BV1234567890', aid: 42, title: 'test', owner: {}, pages: [{ page: 1, cid: 11, duration: 3 }, { page: 2, cid: 22, duration: 3 }] }
const ref = parseBiliReference('https://www.bilibili.com/video/BV1234567890?p=2')
const part = resolveBiliPart(view, { page: ref.page })
assert.equal(part.cid, '22')
assert.equal(normalizeBiliPartTimeline(resolveBiliPart({ ...view, pages: [{ page: 1, cid: 11, duration: 175 }] }, { page: 1 }), { timelength: 174613 }).durationMs, 174613)
assert.equal(normalizeBiliPartTimeline(resolveBiliPart({ ...view, pages: [{ page: 1, cid: 11, duration: 175 }] }, { page: 1 }), {}).durationMs, 175000)
assert.throws(() => normalizeBiliPartTimeline(resolveBiliPart({ ...view, pages: [{ page: 1, cid: 11, duration: 175 }] }, { page: 1 }), { timelength: 174000 }), error => error.code === 'bili.duration.precise.inconsistent' && Boolean(error.hint))
assert.throws(() => resolveBiliPart(view, { page: 2, cid: 11 }), { code: 'bili.part.conflict' })
assert.throws(() => resolveBiliPart({ ...view, pages: [view.pages[0], { ...view.pages[1], duration: 0 }] }, { page: 2 }), { code: 'bili.duration.missing' })
const history = path.join(root, 'history.jsonl')
const entry = { bvid: part.bvid, mode: 'full', at: new Date().toISOString(), speechSource: 'asr' }
assert.equal(appendWatch({ ...entry, cid: '11', page: 1, speechStatus: 'partial' }, { file: history }).ok, true)
assert.equal(appendWatch({ ...entry, cid: '22', page: 2, speechStatus: 'partial' }, { file: history }).ok, true)
assert.equal(appendWatch({ ...entry, cid: '22', page: 2, speechStatus: 'completed', coverage: { complete: true } }, { file: history }).ok, true)
const credential = path.join(root, 'credential.json'); fs.writeFileSync(credential, JSON.stringify({ sessdata: 'fixture', bili_jct: 'fixture' }))
const nav = { code: 0, data: { wbi_img: { img_url: 'https://x/abcdefghijklmnopqrstuvwxyzabcdef.png', sub_url: 'https://x/abcdefghijklmnopqrstuvwxyzabcdef.png' } } }
let requestedCid = ''
const api = createBiliApi({ credentialPath: credential, fetchImpl: async url => {
  const u = new URL(url)
  if (u.pathname.endsWith('/nav')) return Response.json(nav)
  requestedCid = u.searchParams.get('cid')
  return Response.json({ code: 0, data: { cid: 11, subtitle: { subtitles: [] } } })
} })
await assert.rejects(api.fetchSubtitle(part), { code: 'bili.subtitle.cid-mismatch' })
assert.equal(requestedCid, '22')
const opts = { part, dataRoot: root, needAudio: true, fetchImpl: async url => {
  if (url.endsWith('/2')) return new Response('', { status: 404 })
  return new Response('abc', { headers: { 'content-length': '3' } })
}, probeImpl: async file => ({ durationMs: path.basename(file).startsWith('audio-joined') ? 2000 : 1000, hasAudio: true, hasVideo: true }), decodeImpl: async () => true, concatImpl: async (paths, out) => { fs.writeFileSync(out, paths.map(p => fs.readFileSync(p)).join('')); return out } }
const durl = [1,2,3].map(order => ({ order, length: 1000, size: 3, url: `https://example.invalid/${order}` }))
const missing = await prepareBiliMedia({ ...opts, playurl: { durl } })
assert.equal(missing.audio.status, 'partial')
assert.deepEqual(missing.audio.missingRanges, [{ startMs: 1000, endMs: 2000 }])
assert.equal(missing.audio.timelineMap[1].sourceStartMs, 2000)
const dash = await prepareBiliMedia({ ...opts, playurl: { dash: { audio: [{ baseUrl: 'https://example.invalid/audio', codecs: 'mp4a' }] }, durl } , probeImpl: async () => ({ durationMs: 3000, hasAudio: true }) })
assert.equal(dash.audio.strategy, 'dash.audio')
const truncated = await prepareBiliMedia({ ...opts, playurl: { dash: { audio: [{ baseUrl: 'https://example.invalid/audio' }] } }, fetchImpl: async () => new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/10', 'content-length': '3' } }) })
assert.equal(truncated.audio.status, 'failed')
assert.equal(truncated.audio.segments[0].error.code, 'media.range.invalid')
const aborted = new AbortController(); aborted.abort()
await assert.rejects(prepareBiliMedia({ ...opts, signal: aborted.signal, playurl: { durl } }), { code: 'media.cancelled' })
const assets = path.join(root, 'perception', 'assets'); fs.mkdirSync(assets, { recursive: true })
const asset = path.join(assets, 'asset'); fs.writeFileSync(asset, 'abc')
assert.throws(() => assertManagedAsset(credential, assets), { code: 'perception.asset.outside-managed-root' })
const request = buildBiliTranscriptionRequest({ part, media: { path: asset, contentSha256: 'a'.repeat(64), durationMs: 3000, acquiredRanges: [{ startMs: 0, endMs: 3000 }], timelineMap: [] }, character: { id: 'one', epoch: 7 }, activityId: 'activity', assetsRoot: assets })
assert.equal(request.characterEpoch, 7); assert.equal(request.provenance.partId, '22'); assert.deepEqual(request.visibility.allowedContexts, ['bili'])
const discovery = path.join(root, 'perception', 'host.json'); fs.writeFileSync(discovery, JSON.stringify({ baseUrl: 'http://127.0.0.1:1234', api: '/dsh-surfcore/perception-api', token: 'fixture' }), { mode: 0o600 })
let calls = []
const client = createPerceptionClient({ stateDir: root, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(init.method === 'POST' ? { ok: true, jobId: 'j1' } : { ok: true, job: { state: 'queued' } }) } })
assert.equal((await client.submit(request)).jobId, 'j1'); assert.equal((await client.getJob('j1')).state, 'queued')
assert.equal(calls[0].init.headers['x-perception-token'], 'fixture'); assert.equal(JSON.parse(calls[0].init.body).action, 'submit')
const failClient = createPerceptionClient({ stateDir: root, fetchImpl: async () => Response.json({ ok: false, code: 'model.missing', error: '模型不可用', hint: '安装模型' }, { status: 400 }) })
await assert.rejects(failClient.status(), e => e.code === 'model.missing' && e.hint === '安装模型')
console.log('bili media: part, subtitle cid, coverage, cancellation, history and protected Host checks passed')
