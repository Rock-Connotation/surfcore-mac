import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createBiliPerceptionService } from '../lib/bili-perception.js'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-no-history-')), stateDir = path.join(root, 'surfcore')
const role = { id: 'one', epoch: 2 }, charDir = path.join(stateDir, 'characters', role.id)
fs.mkdirSync(charDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'characters', 'current.json'), JSON.stringify(role))
fs.mkdirSync(path.join(stateDir, 'bili'), { recursive: true }); fs.writeFileSync(path.join(stateDir, 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'fixture', bili_jct: 'fixture' }))
const view = { bvid: 'BV1234567890', aid: 1, owner: {}, title: 'fixture', pages: [{ page: 1, cid: 1, duration: 1 }] }
let events = 0; const requests = []
const asr = { async submit() { return { jobId: 'child' } }, async getJob() { return { state: 'completed', result: { transcriptId: 't', segments: [{ startMs: 0, endMs: 1000, text: 'fixture' }], coverage: { complete: true, processedRanges: [{ startMs: 0, endMs: 1000 }] } } } }, async listJobs() { return [] }, async cancel() {}, async dispose() {} }
const service = createBiliPerceptionService({ asrService: asr, stateDir, getCharacter: () => role, onExperience: async () => { events++; return { ok: true } }, createApi: () => ({ async fetchView() { return view }, async fetchPlayurl() {} }), prepareMedia: async ({ dataRoot }) => { fs.mkdirSync(dataRoot, { recursive: true }); const f = path.join(dataRoot, `fixture-${Date.now()}-${Math.random()}`); fs.writeFileSync(f, 'a'); return { audio: { path: f, status: 'completed', contentSha256: 'a'.repeat(64), durationMs: 1000, acquiredRanges: [{ startMs: 0, endMs: 1000 }], timelineMap: [{ localStartMs: 0, localEndMs: 1000, sourceStartMs: 0, sourceEndMs: 1000 }] } } } })
const server = http.createServer(async (req, res) => { try { assert.equal(req.headers['x-perception-token'], 'fixture'); let body = ''; for await (const chunk of req) body += chunk; const url = new URL(req.url, 'http://127.0.0.1'); let result; if (req.method === 'POST') { const value = JSON.parse(body); requests.push(value); result = { ok: true, ...await service.submitBili(value.request) } } else result = { ok: true, job: await service.getJob(url.searchParams.get('jobId')) }; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)) } catch (error) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: error.message })) } })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const perception = path.join(stateDir, 'perception'); fs.mkdirSync(perception, { recursive: true }); fs.writeFileSync(path.join(perception, 'host.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, api: '/dsh-surfcore/perception-api', token: 'fixture' }), { mode: 0o600 })
const preload = path.join(root, 'fetch-fixture.mjs')
fs.writeFileSync(preload, `const original = globalThis.fetch; globalThis.fetch = async (value, init) => { const url = new URL(value); if (url.hostname === '127.0.0.1') return original(value, init); if (url.pathname.endsWith('/view')) return Response.json({code:0,data:${JSON.stringify(view)}}); if (url.pathname.endsWith('/nav')) return Response.json({code:0,data:{wbi_img:{img_url:'https://x/abcdefghijklmnopqrstuvwxyzabcdef.png',sub_url:'https://x/abcdefghijklmnopqrstuvwxyzabcdef.png'}}}); if (url.pathname.endsWith('/v2')) return Response.json({code:0,data:{cid:1,subtitle:{subtitles:[]}}}); if (url.hostname === 'comment.bilibili.com') return new Response('<i></i>'); return Response.json({code:0,data:{replies:[]}}) }`)
const run = args => new Promise((resolve, reject) => { const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/bili.mjs', import.meta.url)), ...args], { env: { ...process.env, DSH_HOME: root, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }); let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c); child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`exit ${code}: ${stderr} ${stdout}`))) })
try {
  for (const args of [['transcribe', view.bvid, '--no-history', '--json'], ['debrief', view.bvid, '--no-frames', '--no-history', '--json']]) {
    const output = await run(args); const id = output.jobId ?? output.materials.speech.jobId
    assert.ok(id); assert.equal(output.history.status, 'skipped'); assert.equal(requests.at(-1).action, 'submit-bili'); assert.equal(requests.at(-1).request.recordHistory, false); assert.equal(requests.at(-1).request.recordExperience, false)
    for (let i = 0; i < 100; i++) { const job = await service.getJob(id); if (job.state === 'completed' && job.memoryState === 'skipped') break; await new Promise(resolve => setTimeout(resolve, 10)) }
    const job = await service.getJob(id); assert.equal(job.state, 'completed'); assert.equal(job.memoryState, 'skipped'); assert.equal(job.history.status, 'skipped')
    const saved = JSON.parse(fs.readFileSync(path.join(perception, 'bili-jobs', `${id}.json`))); assert.equal(saved.request.recordHistory, false); assert.equal(saved.request.recordExperience, false)
    await run(['transcribe', '--status', id, '--json'])
  }
  assert.equal(events, 0); assert.equal(fs.existsSync(path.join(charDir, 'bili', 'watch-history.jsonl')), false)
  console.log('actual CLI to loopback Host: no-history survives submit, finish and status without history or experience')
} finally { await service.dispose(); await new Promise(resolve => server.close(resolve)) }
