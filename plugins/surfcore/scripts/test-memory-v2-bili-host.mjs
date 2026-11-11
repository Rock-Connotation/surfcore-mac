import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBiliV2Host } from '../lib/bili-v2-host.mjs';

const external = [], originalFetch = globalThis.fetch;
globalThis.fetch = async url => { external.push(String(url)); throw new Error('External network forbidden'); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ resolveModelInfo, fetchImpl, adapter, getFeedCandidates } = {}) {
  let role = { id: 'fixture', epoch: 1 }, selection = { provider: 'fixture-provider', model: 'fixture-model' };
  const calls = [], blocked = [], serviceReads = [], services = {
    agentDefaultModel: { currentSelection: () => ({ ...selection }) },
    llm: { resolveModelInfo: resolveModelInfo ?? (async (provider, model) => ({ provider, id: model })) },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-host-test-'));
  const host = createBiliV2Host({
    ctx: { get: key => { serviceReads.push(key); return services[key]; } }, stateDir,
    getCharacter: () => ({ ...role }), tokenBudget: {},
    memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }), adapter }, getFeedCandidates,
    getCredentials: async () => ({ cookie: 'DedeUserID=9; bili_jct=SYNTHETIC_CSRF', bili_jct: 'SYNTHETIC_CSRF' }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method ?? 'GET' });
      if (fetchImpl) return fetchImpl(url, options);
      assert.equal(String(url), 'https://api.bilibili.com/x/web-interface/nav');
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: '9' } }) };
    }, onBlocked: value => blocked.push(value),
  });
  return { host, calls, blocked, stateDir, services, serviceReads, setRole: value => { role = value; }, setSelection: value => { selection = value; } };
}
function refused(value, code) { assert.equal(value.ok, false); assert.equal(value.code, code); assert.ok(value.error); assert.ok(value.hint); }
try {
  const f = fixture();
  assert.equal(f.host.getStatus().activeJobs, 0); assert.deepEqual(fs.readdirSync(f.stateDir), []); assert.deepEqual(f.calls, []);
  const first = await f.host.getPlatformState(), second = await f.host.getPlatformState();
  assert.equal(first.ok, true); assert.equal(first.verified, true); assert.equal(first.accountId, '9');
  assert.equal(first.route.provider, 'fixture-provider'); assert.equal(first.route.model, 'fixture-model');
  assert.match(first.route.providerRouteId, /^dsh-route:[a-f0-9]{64}$/); assert.deepEqual(first.targets, []);
  assert.equal(second.accountId, '9'); assert.equal(f.calls.length, 2, 'each state must obtain a fresh official account result');
  assert.ok(!JSON.stringify(first).includes('SYNTHETIC_CSRF')); assert.deepEqual(fs.readdirSync(f.stateDir), []);
  await f.host.close();
  console.log('PASS lazy constructor, exact actual selection, fresh NAV and content-free state');

  const bad = fixture({ resolveModelInfo: async () => ({ provider: 'foreign-provider', id: 'fixture-model' }) });
  refused(await bad.host.getPlatformState(), 'BILI_V2_ROUTE_UNPROVEN'); assert.equal(bad.calls.length, 0); await bad.host.close();
  console.log('PASS foreign resolved metadata refuses before official fetch');

  for (const mode of ['route', 'role', 'close']) {
    const entered = gate(), pending = gate();
    const raced = fixture({ resolveModelInfo: async (provider, model) => { entered.resolve(); await pending.promise; return { provider, id: model }; } });
    const result = raced.host.getPlatformState(); await entered.promise;
    if (mode === 'route') raced.setSelection({ provider: 'fixture-provider', model: 'other-model' });
    if (mode === 'role') raced.setRole({ id: 'other-role', epoch: 2 });
    if (mode === 'close') await raced.host.close();
    pending.resolve();
    refused(await result, mode === 'route' ? 'BILI_V2_ROUTE_CHANGED' : mode === 'role' ? 'CHARACTER_EPOCH_STALE' : 'BILI_V2_HOST_CLOSED');
    assert.equal(raced.calls.length, 0); await raced.host.close();
  }
  console.log('PASS async route, role and close fences precede official fetch');

  const navEntered = gate(), navPending = gate();
  const navRace = fixture({ fetchImpl: async () => { navEntered.resolve(); await navPending.promise; return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: '9' } }) }; } });
  const navResult = navRace.host.getPlatformState(); await navEntered.promise;
  navRace.setSelection({ provider: 'fixture-provider', model: 'changed-during-nav' }); navPending.resolve();
  refused(await navResult, 'BILI_V2_ROUTE_CHANGED'); await navRace.host.close();
  console.log('PASS route changes during NAV never publish stale verified state');

  const unknown = fixture();
  refused(await unknown.host.enqueue({ requestId: 'retired', input: { kind: 'today' } }), 'BILI_V2_TRIGGER_UNSUPPORTED');
  assert.deepEqual(unknown.calls, []); assert.deepEqual(fs.readdirSync(unknown.stateDir), []); await unknown.host.close();
  console.log('PASS unsupported trigger cannot initialize native runtime or fork a worker');

  const secret = fixture({ resolveModelInfo: async () => { throw new Error('PRIVATE_PROVIDER_CONFIGURATION'); } });
  const error = await secret.host.getPlatformState(); refused(error, 'BILI_V2_ROUTE_UNPROVEN');
  assert.ok(!JSON.stringify(error).includes('PRIVATE_PROVIDER_CONFIGURATION')); assert.equal(secret.blocked.length, 1); await secret.host.close();

  for (const mode of ['route', 'role', 'close', 'abort']) {
    const entered = gate(), pending = gate(), controller = new AbortController(); let captures = 0;
    const f = fixture({ getFeedCandidates: async () => { entered.resolve(); await pending.promise; return [{ kind: 'video', bvid: 'BV1234567890' }]; }, adapter: { capture: async () => { captures++; return { ok: false, code: 'MEMORY_POLICY_DENIED' }; }, release: () => true } });
    const result = f.host.enqueue({ requestId: 'feed-candidate-' + mode, input: { kind: 'feed' }, signal: controller.signal }); await entered.promise;
    let closing;
    if (mode === 'route') f.setSelection({ provider: 'fixture-provider', model: 'changed-during-feed' });
    if (mode === 'role') f.setRole({ id: 'other-role', epoch: 2 });
    if (mode === 'close') closing = f.host.close();
    if (mode === 'abort') controller.abort();
    pending.resolve();
    refused(await result, mode === 'route' ? 'BILI_V2_ROUTE_CHANGED' : mode === 'role' ? 'CHARACTER_EPOCH_STALE' : mode === 'close' ? 'BILI_V2_HOST_CLOSED' : 'BILI_V2_TRIGGER_UNPROVEN');
    if (closing) assert.equal((await closing).closed, true);
    assert.equal(captures, 0); assert.equal(f.calls.length, 0); assert.equal(f.host.getStatus().activePreflights, 0); assert.deepEqual(fs.readdirSync(f.stateDir), []);
    assert.ok(f.serviceReads.every(key => ['agentDefaultModel', 'llm'].includes(key)));
    await f.host.close();
  }
  console.log('PASS candidate await fences route, role, close and caller abort before official fetch or SDK');

  const transitionHost = fixture(), transitionEntered = gate(), transitionPending = gate();
  const changing = transitionHost.host.withTransition(async () => {
    transitionEntered.resolve(); await transitionPending.promise;
    transitionHost.setRole({ id: 'other-role', epoch: 2 }); return 'changed';
  });
  await transitionEntered.promise;
  assert.equal(transitionHost.host.getStatus().transitioning, true);
  refused(await transitionHost.host.getPlatformState(), 'BILI_V2_HOST_CHANGED');
  refused(await transitionHost.host.enqueue({ requestId: 'during-transition', input: { kind: 'feed' } }), 'BILI_V2_HOST_CHANGED');
  assert.equal(transitionHost.calls.length, 0);
  transitionPending.resolve(); assert.equal(await changing, 'changed');
  assert.equal(transitionHost.host.getStatus().transitioning, false);
  assert.equal((await transitionHost.host.getPlatformState()).ok, true);
  await assert.rejects(transitionHost.host.withTransition(async () => { throw new Error('operation failed'); }), /operation failed/);
  assert.equal(transitionHost.host.getStatus().transitioning, false);
  await transitionHost.host.close();
  console.log('PASS retirement holds admission across the entire asynchronous role operation and releases after failure');

  if (!process.argv.includes('--preflight-fences-only')) {
    const view = async url => ({ ok: true, status: 200, json: async () => String(url).includes('/nav') ? { code: 0, data: { isLogin: true, mid: '9' } } : { code: 0, data: { bvid: 'BV1234567890', aid: '9007199254740993123', title: 'RAW_TITLE', desc: 'RAW_DESCRIPTION', owner: { mid: '8', name: 'RAW_OWNER' }, pubdate: 1700000000 } } });
    const captures = [];
    const denied = fixture({ fetchImpl: view, adapter: { capture: async value => { captures.push(value); return { ok: false, code: 'MEMORY_POLICY_DENIED', error: 'Denied', hint: 'Approve this exact set' }; }, release: () => { throw new Error('No captured handle to release'); } } });
    refused(await denied.host.enqueue({ requestId: 'debrief-unapproved', input: { kind: 'debrief', bv: 'BV1234567890' } }), 'BILI_V2_PUBLIC_SET_APPROVAL_REQUIRED');
    assert.equal(captures.length, 1); assert.equal(denied.host.getStatus().publicSourceSetCount, 1);
    const state = await denied.host.getPlatformState(); assert.equal(state.publicSourceSets.length, 1); assert.equal(state.publicSourceSets[0].selectors[0].aid, '9007199254740993123');
    assert.equal(captures[0].conversationKey, state.publicSourceSets[0].outputConversationKey); assert.deepEqual(state.targets, []);
    assert.deepEqual(fs.readdirSync(denied.stateDir), []); assert.ok(denied.serviceReads.every(key => ['agentDefaultModel', 'llm'].includes(key)));
    assert.ok(!JSON.stringify(state).includes('RAW_TITLE')); assert.ok(!JSON.stringify(state).includes('SYNTHETIC_CSRF'));
    denied.setSelection({ provider: 'fixture-provider', model: 'new-model' }); assert.deepEqual((await denied.host.getPlatformState()).publicSourceSets, []);
    await denied.host.close();
    console.log('PASS official exact-set discovery and actionable policy denial precede SDK initialization');

    let releaseAllowed = false, released = 0;
    const held = fixture({ fetchImpl: view, adapter: { capture: async () => ({ ok: true, handle: 'held-preflight-context' }), release: handle => { assert.equal(handle, 'held-preflight-context'); released++; return releaseAllowed ? { ok: true } : false; } } });
    refused(await held.host.enqueue({ requestId: 'release-refused', input: { kind: 'debrief', bv: 'BV1234567890' } }), 'BILI_V2_RETIRE_UNCONFIRMED');
    assert.equal(held.host.getStatus().preflightHandles, 1); assert.equal(held.host.getStatus().ok, false); assert.equal(released, 1);
    refused(await held.host.enqueue({ requestId: 'blocked-new', input: { kind: 'debrief', bv: 'BV1234567890' } }), 'BILI_V2_HOST_CHANGED');
    refused(await held.host.retire(), 'BILI_V2_RETIRE_UNCONFIRMED'); assert.equal(held.host.getStatus().preflightHandles, 1);
    releaseAllowed = true; assert.equal((await held.host.retire()).ok, true); assert.equal(released, 3); assert.equal(held.host.getStatus().preflightHandles, 0); assert.equal(held.host.getStatus().publicSourceSetCount, 0);
    assert.deepEqual(fs.readdirSync(held.stateDir), []); assert.ok(held.serviceReads.every(key => ['agentDefaultModel', 'llm'].includes(key))); await held.host.close();
    console.log('PASS denied preflight release retains context, blocks new jobs and only explicit retirement retries');
  }
  assert.deepEqual(external, []);
  console.log('PASS structured private failures, no fallback and zero external network');
} finally { globalThis.fetch = originalFetch; }
