import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';

if (process.env.SURFCORE_BILI_HOST_NATIVE !== '1' || !process.env.DSH_HOME?.includes('bili-host-native')) throw new Error('Run only in the explicitly isolated native Host fixture.');
const home = process.env.DSH_HOME, receiverMode = process.env.SURFCORE_BILI_HOST_RECEIVER_NATIVE === '1', publicMode = process.env.SURFCORE_BILI_HOST_PUBLIC_NATIVE === '1';
assert.ok(!(receiverMode && publicMode), 'Run each Native scenario separately.');
const publicKind = process.env.SURFCORE_BILI_HOST_PUBLIC_KIND === 'feed' ? 'feed' : 'debrief';
const childProcesses = createRequire(import.meta.url)('node:child_process'), originalFork = childProcesses.fork;
let workerForks = 0, sawPublicRead = false;
if (publicMode) { childProcesses.fork = () => { workerForks++; throw new Error('CLI workers forbidden in public Native fixture.'); }; syncBuiltinESMExports(); }
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const { createBiliV2Host } = await import('../lib/bili-v2-host.mjs');
const { createMemoryV2Runtime } = await import('../lib/memory-v2-runtime.mjs');
const { createTokenBudgetService } = await import('../lib/token-budget.js');
const { characterPaths } = await import('../../../src/character-persona.js');
const { digest } = await import('../../../src/core/memory-v2-contract.js');
const { writeMemoryRouting } = await import('../../../src/core/memory-v2-routing.js');
const require = createRequire(import.meta.url), base = process.resourcesPath + '/app.asar/dsh/node_modules/@deepseek-ai/';
const load = name => require(base + name + '/lib/index.js');
const actual = { ...require(base + 'cordis'), ...load('dsh-llm') };
const outer = new actual.Context(), fibers = [], external = [], blocked = [], officialCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => { external.push(String(url)); throw new Error('External network forbidden.'); };
const role = { id: 'alpha', epoch: 1 }, selected = { provider: 'fixture-host', model: 'fixture-model' };
const core = 'Synthetic approved Bili core only.';
const personaFile = characterPaths(role.id).persona;
assert.ok(personaFile.startsWith(home + path.sep), 'approved core must be inside the isolated home');
fs.mkdirSync(path.dirname(personaFile), { recursive: true }); fs.writeFileSync(personaFile, core);
const stateDir = path.join(home, 'state');
let memory, host, address, providerCalls = 0;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, address);
    if (await memory.handleApi(req, res, url)) return;
    if (await memory.handleManagement(req, res, url)) return;
    res.writeHead(404).end();
  } catch { res.writeHead(500).end('{}'); }
});
const checked = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const deadline = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native Host fixture deadline')), 20000); })]); }
  finally { clearTimeout(timer); }
};
async function request(suffix, body) {
  const url = new URL('/dsh-surfcore/api/memory-v2/' + suffix, address);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body ? 'POST' : 'GET', headers: { origin: address, 'x-fixture-owner': 'fixture-owner', ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let bytes = ''; res.setEncoding('utf8'); res.on('data', value => { bytes += value; }); res.on('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function configure(conversationId) {
  const status = checked(await request('status')), payload = { conversationId, processorScope: 'exact-model' };
  const body = { action: 'configure_policy', payload: { ...payload, payloadDigest: digest(payload), preview: true }, expectedRevision: status.revision, operationId: randomUUID(), characterId: role.id, characterEpoch: role.epoch };
  checked(await request('manage', body)); delete body.payload.preview; checked(await request('manage', body));
}
const budget = createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq') });
try {
  outer.baseUrl = new URL('../package.json', import.meta.url).href;
  for (const plugin of [load('dsh-system-prompt').default, load('dsh-tools').default, load('dsh-llm').default, load('cordis-plugin-loader').default]) { const fiber = outer.plugin(plugin); fibers.push(fiber); await fiber; }
  const config = { ...selected };
  const defaultFiber = outer.plugin(load('dsh-agent-default-model').default, config); fibers.push(defaultFiber); await defaultFiber;
  assert.deepEqual(outer.get('agentDefaultModel').currentSelection(), selected);
  outer.systemPrompt.section({ name: 'host-ancestor-canary', text: 'UNSAFE_HOST_ANCESTOR', order: 0 });
  class SyntheticModel extends actual.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic native Host model' }; }
    async *stream(options) {
      providerCalls++;
      assert.equal(actual.isAgentLoopRequest(options), true);
      assert.equal(options.provider, selected.provider); assert.equal(options.model, selected.model);
      const text = JSON.stringify(options);
      assert.ok(text.includes(core));
      if (providerCalls === 1) assert.ok(text.includes('Complete official original.'));
       else if (publicMode) {
         assert.ok(text.includes('Complete official video metadata only.'));
         assert.ok(text.includes('text-only')); assert.ok(!text.includes('Complete official original.'));
         if (publicKind === 'feed') assert.ok(text.includes('bili:video:9007199254740993125'));
         if (providerCalls === 3) {
           sawPublicRead = options.messages.some(message => message.role === 'tool' && message.toolCallId === 'public-read' && JSON.stringify(message.content).includes('Complete official video metadata only.'));
           assert.equal(sawPublicRead, true);
         }
       }
      else { assert.ok(receiverMode); assert.ok(text.includes('bili-scheduler-receiver')); assert.ok(text.includes('pendingCount')); assert.ok(text.includes('attack-review')); assert.ok(!text.includes('Complete official original.')); }
      assert.ok(!text.includes('UNSAFE_HOST_ANCESTOR')); assert.ok(!text.includes('SYNTHETIC_CSRF'));
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      if (publicMode && providerCalls === 2) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'public-read', name: 'surfcore_bili_read', arguments: JSON.stringify(publicKind === 'feed' ? { kind: 'feed' } : { kind: 'debrief', bv: 'BV1234567890' }) } };
      } else yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic permitted final reply.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  outer.llm.registerAdapter(['fixture-host'], new SyntheticModel());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); address = `http://127.0.0.1:${server.address().port}`;
  memory = createMemoryV2Runtime({ stateDir, charactersDir: path.join(home, 'characters'), getCharacter: () => role,
    currentDshUrl: () => address, getManagementAuthorization: req => req.headers['x-fixture-owner'] === 'fixture-owner',
    getPlatformState: channel => channel === 'bili' ? host?.getPlatformState() ?? null : null });
  checked(await memory.initialize());
  // V2-only（2026-11-12）：全新隔离库的缺省后端就是 v2，不再需要也不允许直接改 SQLite
  // 伪造影子开关；路由由 Runtime 按正式控制快照发布。
  const before = memory.routing(); assert.equal(before.backend, 'v2');
  const status = checked(await memory.service.getStatus());
  checked(writeMemoryRouting({ stateDir, status: { ...status, activeBackend: 'v2' } }));
  host = createBiliV2Host({ ctx: outer, stateDir, getCharacter: () => role, memoryV2: memory.channelMemory('bili'), tokenBudget: budget,
    getFeedCandidates: async () => [{ kind: 'video', bvid: 'BV1234567890' }, { kind: 'video', bvid: 'BV1234567891' }],
    getCredentials: async () => ({ cookie: 'DedeUserID=9; bili_jct=SYNTHETIC_CSRF', bili_jct: 'SYNTHETIC_CSRF' }),
    fetchImpl: async (url, options) => {
      const parsed = new URL(url); officialCalls.push({ path: parsed.pathname, method: options?.method ?? 'GET' });
      assert.equal(parsed.hostname, 'api.bilibili.com'); assert.notEqual(options?.method, 'POST');
      if (parsed.pathname === '/x/web-interface/nav') return { ok: true, status: 200, json: async () => ({ code: 0, data: { isLogin: true, mid: '9' } }) };
      if (parsed.pathname === '/x/web-interface/view') return { ok: true, status: 200, json: async () => ({ code: 0, data: { bvid: parsed.searchParams.get('bvid') ?? 'BV1234567890', aid: parsed.searchParams.get('bvid') === 'BV1234567891' ? '9007199254740993125' : '9007199254740993123', title: 'Synthetic approved video', desc: 'Complete official video metadata only.', owner: { mid: '9007199254740993124', name: 'Synthetic author' }, pubdate: 1700000000 } }) };
      assert.equal(parsed.pathname, '/x/v2/reply');
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { replies: [{ rpid: '31', oid: '11', type: 1, root: 0, parent: 0, ctime: 1700000000, member: { mid: '8' }, content: { message: 'Complete official original.' } }] } }) };
    }, onBlocked: value => blocked.push(value) });
  const input = { kind: 'comment-notification', items: [{ sourceId: '31', sourceRoot: '0', targetId: '0', business: '1', oid: '11', mid: '8' }] };
  fs.copyFileSync(personaFile, personaFile + '.before-size-check');
  try {
    fs.writeFileSync(personaFile, 'x'.repeat(64 * 1024 + 1));
    const oversized = await deadline(host.enqueue({ requestId: 'oversized-core', input }));
    assert.equal(oversized.ok, false); assert.equal(oversized.code, 'BILI_V2_CORE_UNPROVEN'); assert.ok(oversized.hint);
    assert.equal(providerCalls, 0); assert.equal(host.getStatus().activeJobs, 0);
  } finally { fs.copyFileSync(personaFile + '.before-size-check', personaFile); }
  const first = await deadline(host.enqueue({ requestId: 'before-policy', input }));
  assert.equal(first.ok, false); assert.match(first.code, /^MEMORY_/); assert.ok(first.hint); assert.equal(providerCalls, 0);
  await deadline((async () => { while (host.getStatus().activeJobs) await new Promise(resolve => setTimeout(resolve, 10)); })());
  const candidates = await memory.approvedConversations();
  const candidate = candidates.find(item => item.processorScopes[0]?.policy?.audiences?.[0]?.[0] === 'bili');
  assert.ok(candidate, JSON.stringify({ first, candidates, host: host.getStatus() }));
  await configure(candidate.id);
  const accepted = checked(await deadline(host.enqueue({ requestId: 'after-policy', input })));
  assert.equal(accepted.accepted, true);
  await deadline((async () => { while (host.getStatus().activeJobs) await new Promise(resolve => setTimeout(resolve, 10)); })());
  assert.equal(providerCalls, 1, JSON.stringify(blocked));
  assert.equal((await budget.status()).usage.total.tokens, 15);
  assert.equal(host.getStatus().registeredSources, 0);
  if (receiverMode) {
    const observation = { kind: 'attack-review', pendingCount: 2 };
    const refused = await deadline(host.enqueue({ requestId: 'receiver-before-policy', input: observation }));
    assert.equal(refused.ok, false); assert.match(refused.code, /^MEMORY_/); assert.ok(refused.hint); assert.equal(providerCalls, 1);
    await deadline((async () => { while (host.getStatus().activeJobs) await new Promise(resolve => setTimeout(resolve, 10)); })());
    const dynamic = (await memory.approvedConversations()).find(item => item.processorScopes[0]?.policy?.audiences?.some(([channel, key]) => channel === 'bili' && key.endsWith(':public:dynamic')));
    assert.ok(dynamic); await configure(dynamic.id);
    checked(await deadline(host.enqueue({ requestId: 'receiver-after-policy', input: observation })));
    await deadline((async () => { while (host.getStatus().activeJobs) await new Promise(resolve => setTimeout(resolve, 10)); })());
    assert.equal(providerCalls, 2, JSON.stringify(blocked)); assert.equal((await budget.status()).usage.total.tokens, 30); assert.equal(host.getStatus().registeredSources, 0);
  }
  if (publicMode) {
    const input = publicKind === 'feed' ? { kind: 'feed' } : { kind: 'debrief', bv: 'BV1234567890' };
    const denied = await deadline(host.enqueue({ requestId: 'public-before-policy', input }));
    assert.equal(denied.ok, false); assert.equal(denied.code, 'BILI_V2_PUBLIC_SET_APPROVAL_REQUIRED'); assert.ok(denied.hint); assert.equal(providerCalls, 1);
    const candidates = await memory.approvedConversations();
    const publicSet = candidates.find(item => item.processorScopes[0]?.policy?.audiences?.some(([channel, key]) => channel === 'bili' && key.includes(':public-set:') && key.endsWith(':dynamic')));
    assert.ok(publicSet, JSON.stringify({ candidates, denied })); await configure(publicSet.id);
    checked(await deadline(host.enqueue({ requestId: 'public-after-policy', input })));
    await deadline((async () => { while (host.getStatus().activeJobs) await new Promise(resolve => setTimeout(resolve, 10)); })());
    assert.equal(providerCalls, 3, JSON.stringify(blocked)); assert.equal(sawPublicRead, true);
    assert.equal((await budget.status()).usage.total.tokens, 45); assert.equal(workerForks, 0);
    assert.equal(host.getStatus().registeredSources, 0); assert.equal(host.getStatus().preflightHandles, 0);
  }
  checked(await host.close()); assert.equal(host.getStatus().closed, true); assert.equal(host.getStatus().activeJobs, 0);
  assert.deepEqual(external, []);
  const result = { actualHostFactory: true, actualDefaultModelService: true, actualMemoryRuntimeWorker: true, actualBudget: true, syntheticPreactivatedDatabase: true, productionActivationVerified: false, providerCalls, tokens: publicMode ? 45 : receiverMode ? 30 : 15, receiverObservationVerified: receiverMode, publicVideoNativeVerified: publicMode, publicReadKind: publicMode ? publicKind : null, publicReadToolVerified: sawPublicRead, workerForks, activeJobs: 0, activeSources: 0, externalNetwork: external, platformWrites: officialCalls.filter(call => call.method === 'POST').length };
  fs.writeFileSync(path.join(home, 'native-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  if (host) await host.close(); if (memory) await memory.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  for (const fiber of fibers.reverse()) { await fiber.dispose(); await fiber; }
  globalThis.fetch = originalFetch; childProcesses.fork = originalFork; syncBuiltinESMExports();
}
