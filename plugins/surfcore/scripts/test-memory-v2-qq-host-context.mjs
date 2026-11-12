import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryV2Runtime } from '../lib/memory-v2-runtime.mjs';
import { createMemoryClient } from '../../../src/core/memory-v2-client.js';
import { digest } from '../../../src/core/memory-v2-contract.js';

const root = path.resolve('_backups/memory-v2-qq-host-context', randomUUID());
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
let current = { id: 'alpha', epoch: 1 }, clock = Date.now();
let state = { verified: true, accountId: '1', allowedGroups: ['2'], allowedPrivates: ['3'] };
let route = { provider: 'fixture-provider', model: 'fixture-model' }, base, runtime;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (await runtime.handleApi(req, res, url) || await runtime.handleManagement(req, res, url)) return;
    res.writeHead(404).end();
  } catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
runtime = createMemoryV2Runtime({ stateDir: path.join(root, 'state'), charactersDir: path.join(root, 'characters'),
  getCharacter: () => current, getQQState: () => state, getQQRoute: () => route, currentDshUrl: () => base,
  getManagementAuthorization: req => req.headers['x-fixture-owner'] === 'fixture-owner', getPlatformState: () => null, now: () => clock });
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = value => { assert.equal(value?.ok, false, JSON.stringify(value)); assert.ok(value.code && value.hint, JSON.stringify(value)); return value; };
const request = async (suffix, body) => {
  const result = await fetch(`${base}/dsh-surfcore/api/memory-v2/${suffix}`, { method: body ? 'POST' : 'GET', headers: { origin: base, 'x-fixture-owner': 'fixture-owner', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return result.json();
};
async function manage(action, payload) {
  const status = good(await request('status'));
  const body = { action, payload: { ...payload, payloadDigest: digest(payload), preview: true }, expectedRevision: status.revision, operationId: randomUUID(), characterId: current.id, characterEpoch: current.epoch };
  good(await request('manage', body)); delete body.payload.preview;
  return good(await request('manage', body));
}
const facts = { loginAccountId: '1', actorAccountId: '3', conversationType: 'group', conversationId: '2', objectId: 'message-1' };
const capture = (adapter, sourceFacts = facts, conversationKey = 'qq:1:group:2') => adapter.capture({ conversationKey, sourceFacts });
async function deniedAdmission(adapter, handle, options) {
  let calls = 0;
  await assert.rejects(adapter.withNetworkAdmission(handle, () => { calls++; }, options), error => Boolean(error.code && error.hint));
  assert.equal(calls, 0);
}
try {
  const initialized = good(await runtime.initialize()); assert.equal(initialized.backend, 'v2');
  const status = good(await request('status')); assert.equal(status.backend, 'v2');
  const candidates = await runtime.approvedConversations();
  const policyId = candidates.find(item => item.id === 'qq-group-2').processorScopes[0].policy.policyId;
  await manage('configure_policy', { conversationId: 'qq-group-2', processorScope: 'exact-model' });
  const db = new DatabaseSync(path.join(root, 'state', 'memory-control.sqlite'));
  db.prepare('UPDATE state SET shadowEnabled=1 WHERE id=1').run(); db.close();
  const { adapter } = runtime.channelMemory('qq');
  const received = good(await capture(adapter));
  assert.equal(received.sourceStamp.conversationKey, 'qq:1:group:2');
  assert.equal(received.sourceStamp.sourceAccountKey, 'qq:3');
  const inserted = good(await adapter.ingest(received.handle, [{ eventId: 'event-one', operationId: 'source-one', sourceKey: 'source-one', producerId: 'fixture', segmentId: 'fixture-segment', producerSeq: 1, content: 'synthetic group memory' }], 'batch-one'));
  assert.equal(inserted.eventRefs.length, 1);
  good(await adapter.bindActualInput(received.handle, inserted.eventRefs));
  let dispatched = 0;
  const result = await adapter.withNetworkAdmission(received.handle, () => { dispatched++; return 'fixture-only'; });
  assert.equal(result, 'fixture-only'); assert.equal(dispatched, 1);
  const local = runtime.channelMemory('local').adapter;
  bad(await local.bindActualInput(received.handle, inserted.eventRefs));
  await deniedAdmission(local, received.handle);
  const remote = createMemoryClient({ stateDir: path.join(root, 'state'), scope: 'qq', getCharacter: () => current });
  const discovery = JSON.parse(fs.readFileSync(path.join(root, 'state', 'memory-v2', 'qq.json'), 'utf8'));
  const forbidden = await fetch(`${base}${discovery.api}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-memory-v2-token': discovery.token }, body: JSON.stringify({ action: 'withNetworkAdmission', handle: received.handle, dispatchFunction: 'not-a-function' }) });
  assert.equal((await forbidden.json()).code, 'MEMORY_FIELD_FORBIDDEN');
  const remoteCapture = good(await remote.capture('qq:1:group:2', { sourceFacts: facts }));
  bad(await adapter.bindActualInput(remoteCapture.handle, inserted.eventRefs));
  bad(await remote.bindActualInput(received.handle, inserted.eventRefs));
  await deniedAdmission(adapter, remoteCapture.handle);
  bad(await capture(adapter, { ...facts, conversationId: '4' }, 'qq:1:group:4'));
  bad(await capture(adapter, { ...facts, conversationType: 'private', conversationId: '3', actorAccountId: '4' }, 'qq:1:private:3'));
  bad(await capture(adapter, { ...facts, loginAccountId: '5' }));
  state = { ...state, allowedGroups: [] }; bad(await capture(adapter));
  state = { ...state, allowedGroups: ['2'] };
  route = { provider: 'fixture-provider', model: 'different-model' }; bad(await capture(adapter));
  route = { provider: 'fixture-provider', model: 'fixture-model' };
  current = { id: 'alpha', epoch: 2 }; await deniedAdmission(adapter, received.handle);
  current = { id: 'alpha', epoch: 1 };
  const fresh = good(await capture(adapter));
  const abort = new AbortController(); abort.abort(); await deniedAdmission(adapter, fresh.handle, { signal: abort.signal });
  clock += 300001;
  await deniedAdmission(adapter, fresh.handle);
  clock -= 300001;
  const beforeRevocation = good(await capture(adapter));
  await manage('revoke_policy', { policyId });
  await deniedAdmission(adapter, beforeRevocation.handle);
  bad(await capture(adapter));
  console.log('QQ private Host context: PASS (isolated synthetic shadow Worker)');
} finally {
  await runtime.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
