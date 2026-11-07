import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPerceptionApiService } from '../lib/perception-api.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-perception-api-'));
const jobs = new Map();
const current = { id: 'test', epoch: 2 };
let submits = 0, resumedJobId = null;
const service = {
  getStatus: () => ({ ready: false }), doctor: () => ({ ok: false, code: 'MODEL_NOT_READY', error: '模型未准备', hint: '选择模型后重试' }), listModels: () => [],
  listJobs: () => [...jobs.values()], getJob: (id) => jobs.get(id),
  submit: (request) => { submits++; jobs.set('job1', { jobId: 'job1', state: 'queued', request, characterId: request.characterId }); return { jobId: 'job1' }; },
  cancel: (id) => { jobs.get(id).state = 'cancelled'; }, resume: () => { if (resumedJobId) return { jobId: resumedJobId }; throw Object.assign(new Error('旧任务'), { code: 'CHARACTER_STALE', hint: '重新提交' }); },
};
let api;
const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://127.0.0.1'), { trusted: req.url.startsWith('/admin') }));
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let overlap = 0, maximum = 0, saved = null, resumeGateCalls = 0;
  const order = [];
  api = createPerceptionApiService({ service, stateDir: root, getCharacter: () => current, currentDshUrl: () => base,
    resumeBili: async () => { resumeGateCalls++; return { ok: false, code: 'CHANNEL_DISABLED', error: '渠道已关闭', hint: '启用渠道后重试' }; },
    configure: async (value) => { overlap++; maximum = Math.max(maximum, overlap); order.push(value.id); await new Promise(r => setTimeout(r, value.delay)); saved = value.id; overlap--; return { ok: true }; } });
  api.writeHostFile();
  const discovery = JSON.parse(fs.readFileSync(api.hostFile));
  assert.equal(discovery.baseUrl, base);
  if (process.platform !== 'win32') assert.equal(fs.statSync(api.hostFile).mode & 0o777, 0o600);
  const call = async (body, extraHeaders = {}, auth = true, suffix = api.prefix) => {
    const response = await fetch(base + suffix, { method: body ? 'POST' : 'GET', headers: {
      ...(auth ? { 'x-perception-token': discovery.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, data: await response.json() };
  };
  for (const headers of [{}, { 'x-perception-token': 'wrong' }]) {
    const r = await call(null, headers, false); assert.equal(r.response.status, 403); assert.ok(r.data.code && r.data.hint);
  }
  const foreign = await call({ action: 'submit' }, { origin: 'https://example.com' });
  assert.equal(foreign.response.status, 403); assert.ok(foreign.data.code && foreign.data.hint);
  const assetFile = path.join(root, 'perception', 'assets', 'test.wav'); fs.writeFileSync(assetFile, 'fixture');
  const request = { characterId: 'test', characterEpoch: 2, asset: { localPath: assetFile } };
  const old = await call({ action: 'submit', request: { ...request, characterEpoch: 1 } });
  assert.equal(old.data.code, 'CHARACTER_STALE'); assert.ok(old.data.hint); assert.equal(submits, 0);
  const outside = path.join(root, 'secret.wav'); fs.writeFileSync(outside, 'private');
  const denied = await call({ action: 'submit', request: { ...request, asset: { localPath: outside } } });
  assert.equal(denied.data.code, 'ASSET_UNAVAILABLE'); assert.ok(denied.data.hint); assert.equal(submits, 0);
  const savingA = call({ action: 'configure', config: { id: 'A', delay: 50 } }, {}, false, '/admin');
  await new Promise(r => setTimeout(r, 5));
  const savingB = call({ action: 'configure', config: { id: 'B', delay: 0 } }, {}, false, '/admin');
  await Promise.all([savingA, savingB]);
  assert.equal(maximum, 1); assert.deepEqual(order, ['A', 'B']); assert.equal(saved, 'B');
  const submitted = await call({ action: 'submit', request: { ...request, source: { channel: 'bili' }, visibility: { classification: 'public' } } }); assert.equal(submitted.data.jobId, 'job1'); assert.equal(submits, 1);
  assert.equal(jobs.get('job1').request.visibility.classification, 'restricted');
  assert.equal(jobs.get('job1').request.source.channel, 'local');
  jobs.get('job1').memoryState = 'failed'; jobs.get('job1').memoryError = { code: 'PROJECTION_FAILED', error: '写入失败', hint: '重试经历入库' };
  const list = await call(null); assert.equal(list.data.jobs.length, 1); assert.equal(list.data.jobs[0].request, undefined); assert.equal(list.data.jobs[0].memoryError.hint, '重试经历入库');
  assert.ok(list.data.doctor.code && list.data.doctor.hint);
  const cancel = await call({ action: 'cancel', jobId: 'job1' }); assert.equal(cancel.data.job.state, 'cancelled');
  jobs.set('local-interrupted', { jobId: 'local-interrupted', state: 'interrupted', characterId: 'test', characterEpoch: 2 });
  jobs.set('local-resumed', { jobId: 'local-resumed', state: 'queued', characterId: 'test', characterEpoch: 2 });
  resumedJobId = 'local-resumed';
  const linked = await call({ action: 'resume', jobId: 'local-interrupted' });
  assert.equal(linked.data.jobId, 'local-resumed'); assert.equal(linked.data.job.jobId, 'local-resumed'); assert.equal(linked.data.job.state, 'queued');
  resumedJobId = null;
  jobs.set('bili-resume-test', { jobId: 'bili-resume-test', state: 'interrupted', characterId: 'test', characterEpoch: 2, activityId: 'test-resume' });
  const resumed = await call({ action: 'resume', jobId: 'bili-resume-test' });
  assert.equal(resumed.data.code, 'CHANNEL_DISABLED'); assert.ok(resumed.data.hint); assert.equal(resumeGateCalls, 1);
  jobs.get('bili-resume-test').state = 'completed'; jobs.get('bili-resume-test').memoryState = 'failed';
  const projection = await call({ action: 'resume', jobId: 'bili-resume-test' });
  assert.equal(projection.data.code, 'CHARACTER_STALE'); assert.equal(resumeGateCalls, 1, 'local projection replay must not require channel availability');
  current.id = 'other';
  const cross = await call({ action: 'cancel', jobId: 'job1' }); assert.equal(cross.data.code, 'JOB_FORBIDDEN'); assert.ok(cross.data.hint);
  console.log('PASS perception API: scoped auth, origin, managed assets, epoch, role isolation, status and cancellation');
} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
