import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliRoundController } from '../lib/bili-round-controller.js';
import { biliRoundPage } from '../lib/bili-round-page.js';

let cfg = { night: { controlledOnly: false } }, legacy = true, enabled = true;
let duringCatalog = null;
let role = { id: 'app', epoch: 4 }, starts = 0, cancels = 0, stops = 0, partials = 0;
const jobs = [
  { jobId: 'own', characterId: 'app', characterEpoch: 4, state: 'completed' },
  { jobId: 'other', characterId: 'other', characterEpoch: 2, state: 'running' },
];
const make = () => createBiliRoundController({
  ctx: { get: () => ({ listProviders: () => [{ id: 'magpie' }], listModels: async () => { duringCatalog?.(); return [{ id: 'workbuddy/hy4free', name: 'Hy4' }]; } }) },
  stateDir: '/unused-test-only', perception: {}, getCharacter: () => role,
  readConfig: () => cfg, saveConfig: value => { cfg = { night: { ...cfg.night, ...value.night } }; },
  platformEnabled: () => enabled, legacyRunning: () => legacy,
  stopLegacy: async () => { legacy = false; stops++; },
  json: (res, code, body) => { res.code = code; res.body = body; }, readBody: async req => JSON.stringify(req.body),
  createRound: () => ({
    status: async () => ({ jobs, activeJobId: 'other' }),
    getJob: async id => jobs.find(j => j.jobId === id),
    start: async () => { starts++; return { ok: true, jobId: 'new' }; },
    reviewPartial: async () => { partials++; return { ok: true, jobId: 'own', state: 'running' }; },
    cancel: async () => { cancels++; return { ok: true }; }, dispose: async () => {},
  }),
});
async function call(api, method, body, query = '') {
  const res = {};
  assert.equal(await api.handle({ method, body }, res, new URL('http://localhost/dsh-surfcore/api/bili/round' + query)), true);
  return res;
}
const api = make();
let r = await call(api, 'POST', { action: 'start', provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 });
assert.equal(r.body.code, 'BILI_ROUND_MODE_REQUIRED'); assert.ok(r.body.hint); assert.equal(starts, 0);
r = await call(api, 'POST', { action: 'pause' });
assert.equal(r.body.restartRequired, true); assert.equal(stops, 1); assert.equal(cfg.night.controlledOnly, true);
r = await call(api, 'POST', { action: 'start' }); assert.equal(r.body.code, 'BILI_ROUND_RESTART_REQUIRED'); assert.equal(starts, 0);
const fresh = make();
enabled = false;
r = await call(fresh, 'POST', { action: 'start' }); assert.equal(r.body.code, 'BILI_ROUND_CHANNEL_DISABLED');
enabled = true;
r = await call(fresh, 'POST', { action: 'start', provider: 'magpie', model: 'other', maxTokens: 2000 });
assert.equal(r.body.code, 'BILI_ROUND_MODEL_UNAVAILABLE'); assert.ok(r.body.hint); assert.equal(starts, 0);
r = await call(fresh, 'POST', { action: 'start', provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 }); assert.equal(r.code, 200); assert.equal(starts, 1);
r = await call(fresh, 'GET'); assert.deepEqual(r.body.value.jobs.map(j => j.jobId), ['own']); assert.equal(r.body.value.activeJobId, null);
r = await call(fresh, 'GET', null, '?jobId=other'); assert.equal(r.body.code, 'ROUND_FORBIDDEN'); assert.ok(r.body.hint);
r = await call(fresh, 'POST', { action: 'cancel', jobId: 'other' }); assert.equal(r.body.code, 'ROUND_FORBIDDEN'); assert.equal(cancels, 0);
r = await call(fresh, 'POST', { action: 'review-partial', jobId: 'other', allowPartial: true }); assert.equal(r.body.code, 'ROUND_FORBIDDEN'); assert.equal(partials, 0);
r = await call(fresh, 'POST', { action: 'review-partial', jobId: 'own' }); assert.equal(r.body.code, 'ROUND_PARTIAL_APPROVAL_REQUIRED'); assert.equal(partials, 0); assert.ok(r.body.hint);
r = await call(fresh, 'POST', { action: 'review-partial', jobId: 'own', allowPartial: true }); assert.equal(r.code, 200); assert.equal(partials, 1);
role = { id: 'app', epoch: 5 };
r = await call(fresh, 'GET', null, '?jobId=own'); assert.equal(r.body.code, 'ROUND_FORBIDDEN');
role = { id: 'app', epoch: 4 };
duringCatalog = () => { role = { id: 'other', epoch: 2 }; };
r = await call(fresh, 'GET', null, '?jobId=own');
assert.equal(r.body.code, 'ROUND_FORBIDDEN'); assert.equal(r.body.value, undefined);
role = { id: 'app', epoch: 4 };
r = await call(fresh, 'POST', { action: 'start', provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 });
assert.equal(r.body.code, 'ROUND_FORBIDDEN'); assert.equal(starts, 1);
duringCatalog = null; jobs[0].state = 'running';
await fresh.cancelActive(); assert.equal(cancels, 2); // all Host-owned in-flight rounds, regardless of UI role
const transition = fresh.beginTransition(); await transition.ready;
r = await call(fresh, 'POST', { action: 'start', provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 });
assert.equal(r.body.code, 'BILI_ROUND_TRANSITION'); assert.equal(starts, 1); assert.ok(r.body.hint);
transition.finish(); transition.finish(); assert.equal(fresh.readiness().ok, true);
let releaseMutation;
const mutation = fresh.withTransition(() => new Promise(resolve => { releaseMutation = resolve; }));
while (!releaseMutation) await new Promise(resolve => setTimeout(resolve, 1));
r = await call(fresh, 'POST', { action: 'start', provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 });
assert.equal(r.body.code, 'BILI_ROUND_TRANSITION'); assert.equal(starts, 1);
releaseMutation(); await mutation; assert.equal(fresh.readiness().ok, true);
// Parse the actual shipped inline script, rather than duplicating its syntax in a fixture.
const script = biliRoundPage.match(/<script>([\s\S]*)<\/script>/)?.[1]; assert.ok(script); new vm.Script(script);
await api.dispose(); await fresh.dispose();
// Exercise controller cancellation against the real service while its provider never yields.
let signalSeen;
const actual = createBiliRoundController({
  stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bili-round-controller-')),
  ctx: { get: () => ({ stream: options => { signalSeen = options.signal; return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }) }; } }) },
  tokenBudget: { block: async () => ({ blocked: false }), recordExternalUsage: () => true },
  runBili: async () => ({ ok: true, out: JSON.stringify({ items: [{ bv: 'BV1WW411a7qQ', title: '测试口播', duration: 96 }] }) }),
  perception: { getJob: async () => { throw Error('should not reach media'); }, cancel: async () => {} },
  getCharacter: () => ({ id: 'app', epoch: 4 }), buildContext: () => ({ ok: true, text: '测试角色' }), maintainMemory: async () => ({ ok: true }),
  readConfig: () => ({ night: { controlledOnly: true } }), saveConfig: () => {}, platformEnabled: () => true, legacyRunning: () => false,
});
await actual.round.start({ provider: 'magpie', model: 'workbuddy/hy4free', maxTokens: 2000 });
for (let i = 0; i < 50 && !signalSeen; i++) await new Promise(resolve => setTimeout(resolve, 2));
assert.ok(signalSeen); assert.equal(signalSeen.aborted, false);
await Promise.race([actual.cancelActive(), new Promise((_, reject) => setTimeout(() => reject(Error('cancel waited for model timeout')), 300))]);
assert.equal(signalSeen.aborted, true); assert.equal((await actual.round.status()).jobs[0].state, 'cancelled');
await actual.dispose();
console.log('PASS Bili round controller: exclusive mode, restart boundary, catalog, channel and role ownership');
