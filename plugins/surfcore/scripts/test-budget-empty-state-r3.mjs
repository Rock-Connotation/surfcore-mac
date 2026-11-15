import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenBudgetService } from '../lib/token-budget.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-empty-r3-'));
const open = () => createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq') });
let service = open();
const stateFile = service.stateFile;
service.dispose();
const fresh = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.match(fresh.day, /^\d{4}-\d{2}-\d{2}$/);
service = open();
assert.equal((await service.block()).blocked, false);
service.dispose();
console.log('PASS fresh dispose/reload: valid day, admission available');

const legacy = { ...fresh, day: null };
fs.writeFileSync(stateFile, JSON.stringify(legacy));
service = open();
await service.ensureReady();
const request = { requestId: 'empty-reload', category: 'other', purpose: 'organize', jobId: 'job', role: 'whale', epoch: 4, providerRouteId: 'fixture-route', model: 'fixture-model', estimatedTokens: 100 };
const reserved = service.reserveModelCall(request);
assert.equal(reserved.ok, true);
assert.equal(service.admitModelCall(request.requestId).send, true);
assert.equal(service.settleModelCall(request.requestId, { actualTokens: 20 }).ok, true);
service.dispose();
service = open();
assert.equal(service.getModelCallReceipt(request.requestId).receipt.state, 'settled');
service.dispose();
console.log('PASS legacy null day: reserve/admit/settle and reload settled receipt');

const clone = () => structuredClone(fresh);
const cases = [
  ['malformed JSON', '{', 'The canonical budget state cannot be read.'],
  ['non-object', '[]', 'The canonical budget state is invalid.'],
  ...[0, 3].map(version => [`version ${version}`, JSON.stringify({ ...clone(), version }), 'The canonical budget state is incomplete.']),
  ...['categories', 'sessions'].map(key => [`${key} non-object`, JSON.stringify({ ...clone(), [key]: [] }), 'The canonical budget state is incomplete.']),
  ...[['cost', -1], ['cost', 'Infinity'], ['tokens', -1], ['tokens', 'Infinity']].map(([key, value]) => { const state = clone(); state.categories.qq[key] = value === 'Infinity' ? 1e999 : value; return [`bucket ${key} ${value}`, JSON.stringify(state), 'The canonical budget state is incomplete.']; }),
  ['v2 missing modelCalls', JSON.stringify((({ modelCalls, ...rest }) => rest)(clone())), 'The canonical budget state is incomplete.'],
  ['null day with usage', JSON.stringify({ ...legacy, categories: { ...legacy.categories, qq: { cost: 0, tokens: 1 } } }), 'The canonical budget state is incomplete.'],
  ['null day with session', JSON.stringify({ ...legacy, sessions: { example: {} } }), 'The canonical budget state is incomplete.'],
  ['null day with receipt', JSON.stringify({ ...legacy, modelCalls: { version: 1, requests: { example: {} } } }), 'The canonical budget state is incomplete.'],
  ['missing day', JSON.stringify((({ day, ...rest }) => rest)(legacy)), 'The canonical budget state is incomplete.'],
];
for (const [name, contents, error] of cases) {
  fs.writeFileSync(stateFile, contents);
  service = open();
  const result = await service.block();
  assert.equal(result.ok, false, name);
  assert.equal(result.code, 'BUDGET_STATE_INVALID', name);
  assert.equal(result.error, error, name);
  assert.equal(result.hint, 'Restore a verified budget state before admitting calls.', name);
  console.log(`PASS ${name}: ${result.code} | ${result.error} | ${result.hint}`);
  service.dispose();
}
