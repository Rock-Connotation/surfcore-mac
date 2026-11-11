import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.env.QQ_MEMORY_FIXTURE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v2-qq-real-'));
  try {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, DSH_HOME: root, QQ_MEMORY_FIXTURE: root }, stdio: 'inherit', timeout: 180000 });
    process.exitCode = child.status ?? 1;
  } finally { assert.ok(root.startsWith(path.join(os.tmpdir(), 'memory-v2-qq-real-'))); fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { createMemoryService } = await import('../src/core/memory-v2-service.js');
  const { createQQMemoryBridge } = await import('../src/core/memory-v2-qq.js');
  const { createMemoryClient } = await import('../src/core/memory-v2-client.js');
  const { writeMemoryRouting, readMemoryRouting, deriveMemoryProviderRouteId } = await import('../src/core/memory-v2-routing.js');
  const { createMemoryHost } = await import('../plugins/surfcore/lib/memory-v2-host.mjs');
  const { createMemoryApiService } = await import('../plugins/surfcore/lib/memory-v2-api.mjs');
  const { resolveQQMemoryIdentity } = await import('../plugins/surfcore/lib/memory-v2-identity.mjs');
  const { createCharacter, switchCharacter, readCurrentCharacter, CHARACTERS_DIR } = await import('../src/character-persona.js');
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
  async function testOfficialIdentityEndpoint() {
    const consoleToken = ['fixture', 'console', 'read'].join('-') + 'x'.repeat(32);
    let mode = 'ok', accountId = '100', reads = 0, consoleHandler;
    const onebot = http.createServer((req, res) => {
      reads++;
      assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + ['onebot', 'fixture'].join('-'));
      if (mode === 'config-change' && reads === 1) runtime.cfg.allow.groups = ['902'];
      const login = req.url === '/get_login_info';
      const data = login ? { user_id: mode === 'changed' && reads % 3 === 0 ? '101' : accountId, nickname: 'Never returned' }
        : { online: mode !== 'offline', good: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'malformed' ? { status: 'ok', retcode: 0, data: [] }
        : mode === 'failed' ? { status: 'failed', retcode: 1, wording: 'synthetic-private-error' } : { status: 'ok', retcode: 0, data }));
    });
    let runtime, consoleServer;
    try {
      await new Promise(resolve => onebot.listen(0, '127.0.0.1', resolve));
      const gatewayUrl = `http://127.0.0.1:${onebot.address().port}`;
      runtime = await bridgeHarness({ config: { consoleToken, ownerQQ: 999, allow: { groups: ['900'], private: ['200'] },
        snowluma: { httpUrl: gatewayUrl, accessToken: ['onebot', 'fixture'].join('-') }, dsh: { followDefaultModel: false, provider: 'fixture/provider', model: '模型/model' } },
        globals: { fetch: (url, options) => { assert.ok(String(url).startsWith(gatewayUrl + '/')); return fetch(url, options); },
          http: { ...http, createServer: handler => { consoleHandler = handler; return http.createServer(handler); } } } });
      consoleServer = runtime.startConsoleServer();
      if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve));
      const base = `http://127.0.0.1:${consoleServer.address().port}`;
      const request = async (headers = {}, suffix = '', options = {}) => {
        const response = await fetch(base + '/api/memory-v2/identity' + suffix, { ...options, headers: { 'x-console-token': consoleToken, ...headers } });
        return { status: response.status, body: await response.json() };
      };
      runtime.setSelfUserId('999');
      const first = await request({}, '?accountId=999&allowedGroups=999');
      assert.equal(first.status, 200); good(first.body);
      assert.deepEqual(first.body, { ok: true, verified: true, accountId: '100', allowedGroups: ['900'], allowedPrivates: ['200'], route: { provider: 'fixture/provider', model: '模型/model' } });
      assert.equal(reads, 3); assert.ok(!JSON.stringify(first.body).includes('nickname')); assert.ok(!JSON.stringify(first.body).includes(consoleToken));
      const denied = async headers => { const before = reads, result = await request(headers); assert.ok([401, 403].includes(result.status)); assert.equal(result.body.ok, false); assert.ok(result.body.code && result.body.error && result.body.hint); assert.notEqual(result.body.verified, true); assert.equal(reads, before); };
      await denied({ 'x-console-token': 'bad-token' });
      await denied({ 'x-agent-token': 'fake-agent' });
      await denied({ 'x-agent-call': '1' });
      await denied({ origin: 'https://other.invalid' });
      const badHost = await new Promise((resolve, reject) => { http.get(base + '/api/memory-v2/identity', { headers: { host: 'other.invalid', 'x-console-token': consoleToken } }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); }).on('error', reject); });
      assert.equal(badHost.status, 403); assert.ok(badHost.body.code && badHost.body.hint);
      const sameOrigin = await request({ origin: base }); assert.equal(sameOrigin.status, 200);
      let remoteStatus, remoteBody;
      await consoleHandler({ url: '/api/memory-v2/identity', method: 'GET', headers: { host: new URL(base).host, 'x-console-token': consoleToken }, socket: { remoteAddress: '203.0.113.1' } },
        { writeHead: status => { remoteStatus = status; }, end: text => { remoteBody = JSON.parse(text); } });
      assert.equal(remoteStatus, 403); assert.ok(remoteBody.code && remoteBody.hint);
      accountId = '101'; assert.equal((await request()).body.accountId, '101');
      runtime.cfg.allow.groups = ['901']; runtime.cfg.allow.private = ['201'];
      const updated = (await request()).body; assert.deepEqual(updated.allowedGroups, ['901']); assert.deepEqual(updated.allowedPrivates, ['201']);
      runtime.cfg.dsh.followDefaultModel = true; assert.equal((await request()).body.route, undefined);
      runtime.cfg.dsh.followDefaultModel = false; runtime.cfg.dsh.provider = ''; assert.equal((await request()).body.route, undefined);
      for (const failure of ['offline', 'malformed', 'failed']) {
        mode = failure; const result = (await request()).body;
        assert.equal(result.ok, false); assert.notEqual(result.verified, true); assert.ok(result.code && result.error && result.hint);
        assert.ok(!JSON.stringify(result).includes('synthetic-private-error'));
      }
      mode = 'ok'; accountId = 'unknown'; assert.equal((await request()).body.ok, false);
      accountId = '100'; mode = 'changed'; reads = 0; assert.equal((await request()).body.code, 'MEMORY_QQ_IDENTITY_CHANGED');
      mode = 'config-change'; reads = 0; assert.equal((await request()).body.code, 'MEMORY_QQ_CONFIG_CHANGED');
      mode = 'ok'; runtime.cfg.allow.groups = ['malformed']; assert.equal((await request()).body.code, 'MEMORY_QQ_ALLOWLIST_INVALID');
      const wrongMethod = await request({}, '', { method: 'POST', body: JSON.stringify({ accountId: '999' }), headers: {} }); assert.equal(wrongMethod.body.ok, false);
      console.log('PASS official QQ identity endpoint: real bridge console handler, synthetic OneBot only, console/agent/Host/Origin/loopback isolation, fresh login and allowlists, exact configured route, offline/malformed/unknown failures');
    } finally {
      if (consoleServer) await new Promise(resolve => consoleServer.close(resolve));
      if (runtime) await runtime.close();
      await new Promise(resolve => onebot.close(resolve));
    }
  }
  await testOfficialIdentityEndpoint();

  const providerRouteId = good(deriveMemoryProviderRouteId({ provider: 'fixture', model: 'fixture' })).providerRouteId;
  let fixtureSessionSafety = true;
  createCharacter({ name: 'QQ fixture', id: 'qq-test', personaText: '我是隔离测试角色，不读取旧记忆。' }); switchCharacter('qq-test');
  const firstRole = readCurrentCharacter(), management = Object.freeze({}), replayAuthority = Object.freeze({});
  const stateDir = path.join(process.env.QQ_MEMORY_FIXTURE, 'surfcore');
  const service = createMemoryService({ stateDir, charactersDir: CHARACTERS_DIR, getCharacter: readCurrentCharacter, authorizeManagement: auth => auth === management, authorizeProducerReplay: auth => auth === replayAuthority });
  good(await service.initialize());
  const base = { channel: 'qq', conversationKey: 'qq:100:group:900', sourceAccountKey: 'qq:200', requesterAccountKey: 'qq:200', providerRouteId: providerRouteId, purpose: 'conversation', audiencePolicyId: 'qq-group', processingGrantId: 'qq-grant' };
  let operation = 0;
  const action = async value => { const admin = good(await service.host.captureAdminContext(base, management)).context; return service.applyMemoryAction(admin, value, admin.controlRevision, `manage:${++operation}`); };
  good(await action({ type: 'configure_policy', policy: { policyId: 'qq-group', approved: true, audiences: [['qq', base.conversationKey, '*']], processingGrants: [{ grantId: 'qq-grant', providerRouteId: providerRouteId }] } }));
  good(await action({ type: 'configure_policy', policy: { policyId: 'qq-private', approved: true, audiences: [['qq', 'qq:100:private:200', 'qq:200']], processingGrants: [{ grantId: 'qq-private-grant', providerRouteId: providerRouteId }] } }));
  good(await action({ type: 'enable_shadow', enabled: true }));
  const publishFixtureRoute = async () => good(writeMemoryRouting({ stateDir, status: { ...good(await service.getStatus()), activeBackend: 'v2' } }));
  await publishFixtureRoute();
  const host = createMemoryHost({ memoryService: service, getCharacter: readCurrentCharacter, handleTtlMs: 300000, resolveIdentity: ({ sourceFacts }) => resolveQQMemoryIdentity({ accountId: '100', allowedGroups: ['900'], allowedPrivates: ['200'], providerRouteId: providerRouteId }, sourceFacts), getProducerReplayAuthorization: () => replayAuthority });
  const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, `http://${req.headers.host}`)));
  let api, harness, restartedHarness;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    api = createMemoryApiService({ host, stateDir, currentDshUrl: () => `http://127.0.0.1:${server.address().port}`, scopes: [{ id: 'qq-bridge', channel: 'qq', principal: {}, canBindInput: true, canSubmitSourceFacts: true }] }); good(api.writeHostFiles());
    const client = createMemoryClient({ stateDir, getCharacter: readCurrentCharacter });
    const adapter = createQQMemoryBridge({ stateDir, getCharacter: readCurrentCharacter, client });
    const source = (id, actor = '200', key = 'group:900', text = '完整QQ当前输入：今天计划去河边散步。') => ({ key, loginAccountId: '100', actorAccountId: actor, objectId: String(id), text });
    good(await adapter.captureSource(source(1, '200', 'group:900', '长文本保留。'.repeat(250) + 'sk-' + 'fixturesecret1234567890')));
    good(await adapter.captureSource(source(2, '201')));
    const prepared = good(await adapter.prepareReply({ key: 'group:900' })); assert.equal(prepared.inputManifest.length, 2); assert.ok(prepared.text.includes('长文本保留。'.repeat(250))); assert.ok(!prepared.text.includes('fixturesecret1234567890'));
    const privateAdapter = createQQMemoryBridge({ stateDir, getCharacter: readCurrentCharacter, client: createMemoryClient({ stateDir, getCharacter: readCurrentCharacter }) });
    good(await privateAdapter.captureSource(source(3, '200', 'private:200', '只在私聊出现的橘子密码故事。'))); const privatePrepared = good(await privateAdapter.prepareReply({ key: 'private:200' })); assert.ok(!prepared.text.includes('橘子密码故事')); assert.ok(privatePrepared.text.includes('橘子密码故事'));
    harness = await bridgeHarness({ config: { ownerQQ: 100, agentPreset: 'qq-safe', dsh: { provider: 'fixture', model: 'fixture', followDefaultModel: false, allowModelFallback: true }, allow: { private: ['200'], groups: ['900'] } }, globals: { readCurrentCharacter, createQQMemoryBridge: options => createQQMemoryBridge({ ...options, stateDir, getCharacter: readCurrentCharacter, client: createMemoryClient({ stateDir, getCharacter: readCurrentCharacter }), getSessionMemorySafety: async ({ sessionId, preset }) => { const runtime = [harness, restartedHarness].find(item => Object.values(item?.state.sessions ?? {}).includes(sessionId)); const actual = runtime?.calls.created.find((item, index) => sessionId === `fixture-${index + 1}` && item.agentPreset === preset); return fixtureSessionSafety === true && !!actual; } }) } });
    harness.setMode('reserved2'); harness.setReady(true); harness.setPresets([harness.cfg['social' + 'V2'].agentPreset, harness.cfg.agentPreset].filter(Boolean)); harness.setSelfUserId('100');
    harness.socialV2.paused = true;
    await harness.handleIncoming('group', 900, { self_id: 100, user_id: 200, group_id: 900, message_id: 10, raw_message: '来自真实入站信封的当前测试消息。', message: [{ type: 'text', data: { text: '来自真实入站信封的当前测试消息。' } }], sender: { nickname: 'fixture actor' } }, harness.cfg);
    assert.equal(harness.qqMemory.status('group:900').sourceState, 'committed');
    const beforeCreateRace = harness.calls.prompts.length, originalCreate = harness.api.sessions.create;
    harness.api.sessions.create = async value => { const response = await originalCreate(value); good(await action({ type: 'binding_barrier' })); await publishFixtureRoute(); return response; };
    const createRace = await harness.deliverPromptNow('group:900', '旧会话创建竞态', {}); assert.equal(createRace.ok, false); assert.equal(harness.calls.prompts.length, beforeCreateRace);
    harness.api.sessions.create = originalCreate;
    good(await harness.qqMemory.captureSource(source(11, '200', 'group:900', '来自真实入站信封的新鲜当前测试消息。')));
    fixtureSessionSafety = false;
    const unsafeBefore = harness.calls.prompts.length;
    const unsafe = await harness.deliverPromptNow('group:900', 'No native restricted-tool proof is mounted.'); assert.equal(unsafe.code, 'MEMORY_PRESET_UNSAFE'); assert.ok(unsafe.hint); assert.equal(harness.calls.prompts.length, unsafeBefore); assert.equal(harness.state.sessions['group:900'], undefined);
    fixtureSessionSafety = true;
    const originalSelect = harness.api.sessions.selectModel;
    for (const scenario of [
      { id: 101, model: 'fixture', selected: { provider: 'fixture' }, code: 'MEMORY_PROVIDER_ROUTE_REQUIRED' },
      { id: 102, model: 'other', selected: { provider: 'fixture', model: 'other' }, code: 'MEMORY_PROVIDER_ROUTE_MISMATCH' },
      { id: 103, model: 'fixture', selected: { provider: 'fallback', model: 'fallback' }, code: 'MEMORY_PROVIDER_ROUTE_MISMATCH' },
    ]) {
      good(await harness.qqMemory.captureSource(source(scenario.id)));
      harness.cfg.dsh.model = scenario.model;
      harness.api.sessions.selectModel = async () => ({ result: { ok: true, value: { selected: scenario.selected } } });
      const prompts = harness.calls.prompts.length, created = harness.calls.created.length;
      const refused = await harness.deliverPromptNow('group:900', '未授权实际模型不得接收输入', {});
      assert.equal(refused.ok, false); assert.equal(refused.code, scenario.code); assert.ok(refused.hint); assert.equal(harness.calls.prompts.length, prompts); assert.equal(harness.state.sessions['group:900'], undefined); assert.ok(harness.calls.archived.includes(`fixture-${created + 1}`));
    }
    harness.api.sessions.selectModel = originalSelect; harness.cfg.dsh.model = 'fixture';
    good(await harness.qqMemory.captureSource(source(12, '200', 'group:900', '来自真实入站信封的新鲜当前测试消息。')));
    const sentBefore = harness.calls.sent.length;
    good(await harness.deliverPromptNow('group:900', 'FORBIDDEN_LEGACY_HISTORY', {})); assert.equal(harness.calls.prompts.length, 1);
    const submitted = JSON.stringify(harness.calls.prompts[0]); assert.ok(submitted.includes('真实入站信封')); assert.ok(!submitted.includes('FORBIDDEN_LEGACY_HISTORY'));
    const sessionId = harness.state.sessions['group:900']; assert.ok(sessionId);
    assert.equal((await harness.qqMemory.validateSessionSafety({ sessionId: 'foreign-session', preset: harness.calls.created.at(-1).agentPreset })).code, 'MEMORY_PRESET_UNSAFE');
    assert.equal((await harness.qqMemory.validateSessionSafety({ sessionId, preset: 'foreign-preset' })).code, 'MEMORY_PRESET_UNSAFE');
    await harness.sendToQQ('group:900', '当前授权的模型回复。'); assert.equal(harness.calls.sent.length, sentBefore + 1);
    const observedDrift = harness.validateMemoryV2ProviderRoute('group:900', sessionId, { provider: 'fixture', model: 'changed-after-submit' });
    assert.equal(observedDrift.code, 'MEMORY_PROVIDER_ROUTE_MISMATCH');
    await harness.sendToQQ('group:900', '实际模型偏离后不得发送'); assert.equal(harness.calls.sent.length, sentBefore + 1); assert.equal(harness.state.sessions['group:900'], undefined); assert.ok(harness.calls.archived.includes(sessionId));
    good(await harness.qqMemory.captureSource(source(13))); good(await harness.deliverPromptNow('group:900', '恢复精确授权的模型', {}));
    const currentSessionId = harness.state.sessions['group:900'];
    good(await action({ type: 'revoke_policy', policyId: 'qq-group' })); await publishFixtureRoute();
    await harness.sendToQQ('group:900', '撤销后不得发送。'); assert.equal(harness.memoryV2Failures.get('group:900')?.ok, false); assert.equal(harness.calls.sent.length, sentBefore + 1);
    const beforePrompts = harness.calls.prompts.length; const blocked = await harness.deliverPromptNow('group:900', '不得回放旧会话。', {}); assert.equal(blocked.ok, false); assert.equal(harness.calls.prompts.length, beforePrompts); assert.ok(harness.calls.cancelled.includes(currentSessionId)); assert.ok(harness.calls.archived.includes(currentSessionId));
    good(await action({ type: 'configure_policy', policy: { policyId: 'qq-group-next', approved: true, audiences: [['qq', base.conversationKey, '*']], processingGrants: [{ grantId: 'qq-grant-next', providerRouteId: providerRouteId }] } })); await publishFixtureRoute();
    good(await harness.qqMemory.captureSource(source(30)));
    const originalPrompt = harness.api.sessions.prompt, beforeGeneration = harness.calls.sent.length;
    harness.api.sessions.prompt = async value => { const response = await originalPrompt(value); good(await action({ type: 'binding_barrier' })); await publishFixtureRoute(); return response; };
    const generatedDuringRevocation = await harness.deliverPromptNow('group:900', '生成期间撤销', {}); assert.equal(generatedDuringRevocation.ok, false); assert.equal(harness.calls.sent.length, beforeGeneration); assert.equal(harness.state.sessions['group:900'], undefined);
    harness.api.sessions.prompt = originalPrompt;
    const mass = createQQMemoryBridge({ stateDir, getCharacter: readCurrentCharacter, client: createMemoryClient({ stateDir, getCharacter: readCurrentCharacter }) });
    for (let i = 0; i < 605; i++) good(await mass.captureSource(source(1000 + i, '200', 'group:900', `第${i}条完整原始来源。`)));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(CHARACTERS_DIR, firstRole.id, 'memory', 'memory-v2.sqlite'), { readOnly: true });
    try { assert.ok(db.prepare('SELECT COUNT(*) AS n FROM events').get().n > 600); assert.ok(db.prepare('SELECT payload FROM events').all().some(row => row.payload.includes('长文本保留'))); } finally { db.close(); }
    let loseRegistration = true;
    const lossy = createMemoryClient({ stateDir, getCharacter: readCurrentCharacter, fetchImpl: async (url, options) => { const response = await fetch(url, options); if (loseRegistration && JSON.parse(options.body ?? '{}').action === 'registerProducer') { loseRegistration = false; await response.text(); throw new Error('fixture lost original registration response'); } return response; } });
    const pendingRegistration = createQQMemoryBridge({ stateDir, getCharacter: readCurrentCharacter, client: lossy });
    const lost = await pendingRegistration.captureSource(source(80)); assert.equal(lost.acceptance, 'queued_durable'); assert.equal(lost.sourceState, 'pending'); assert.ok(lost.operationId);
    good(await adapter.captureSource(source(20))); good(await adapter.prepareReply({ key: 'group:900' }));
    const lease = good(await adapter.authorizeSend({ key: 'group:900', loginAccountId: '100', objectId: 'send:role-switch' })).lease;
    createCharacter({ name: 'QQ next fixture', id: 'qq-next', personaText: '下一角色。' }); switchCharacter('qq-next');
    const queued = await adapter.recordSent(lease, { text: '旧角色在切换边界得到实际ACK。', messageId: 'onebot:77', deliveryState: 'delivered' }); assert.equal(queued.acceptance, 'queued_durable');
    const recoveredRegistration = await pendingRegistration.drainPending('group:900'); assert.equal(recoveredRegistration.ok, true, JSON.stringify(recoveredRegistration)); assert.ok(recoveredRegistration.outcomes.length >= 2); assert.ok(recoveredRegistration.outcomes.every(value => value.sourceState === 'committed'));
    const recovered = await adapter.drainPending('group:900'); assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.outcomes.length, 0); assert.equal(readCurrentCharacter().id, 'qq-next');
    const allSources = fs.readdirSync(path.join(stateDir, 'memory-v2', 'qq-producer', firstRole.id, String(firstRole.epoch))).filter(name => name.endsWith('.jsonl')).map(name => fs.readFileSync(path.join(stateDir, 'memory-v2', 'qq-producer', firstRole.id, String(firstRole.epoch), name), 'utf8')).join('');
    assert.ok(allSources.includes('旧角色在切换边界')); assert.ok(allSources.includes(`"capturedEpoch":${firstRole.epoch}`));
    good(await harness.qqMemory.captureSource(source(90))); good(await harness.deliverPromptNow('group:900', '新角色的新鲜输入', {}));
    const activeSession = harness.state.sessions['group:900'], previousPromptCount = harness.calls.prompts.length;
    const stop = harness.api.stopSessionWork; harness.api.stopSessionWork = async () => { throw new Error('fixture queue cancellation unavailable'); };
    const retirementPending = await harness.deliverPromptNow('group:900', '旧会话未清退不得继续', {}); assert.equal(retirementPending.code, 'MEMORY_SESSION_RETIRE_PENDING'); assert.equal(harness.calls.prompts.length, previousPromptCount);
    const savedState = JSON.parse(JSON.stringify(harness.state)); assert.equal(savedState.memoryV2Retirements[activeSession].pending, true); harness.api.stopSessionWork = stop;
    restartedHarness = await bridgeHarness({ savedState, config: { ownerQQ: 100, agentPreset: 'qq-safe', dsh: { provider: 'fixture', model: 'fixture', followDefaultModel: false, allowModelFallback: true }, allow: { private: ['200'], groups: ['900'] } }, globals: { readCurrentCharacter, createQQMemoryBridge: options => createQQMemoryBridge({ ...options, stateDir, getRouting: () => ({ ok: true, backend: 'v1' }), getCharacter: readCurrentCharacter, client: createMemoryClient({ stateDir, getCharacter: readCurrentCharacter }), getSessionMemorySafety: async ({ sessionId, preset }) => { const runtime = [harness, restartedHarness].find(item => Object.values(item?.state.sessions ?? {}).includes(sessionId)); const actual = runtime?.calls.created.find((item, index) => sessionId === `fixture-${index + 1}` && item.agentPreset === preset); return fixtureSessionSafety === true && !!actual; } }) } });
    assert.equal(restartedHarness.qqMemory.routing().backend, 'v1'); assert.equal(restartedHarness.state.memoryV2Sessions['group:900'], undefined);
    assert.ok(restartedHarness.calls.cancelled.includes(activeSession)); assert.ok(restartedHarness.calls.archived.includes(activeSession)); assert.equal(restartedHarness.calls.prompts.length, 0); assert.ok(!restartedHarness.calls.follows.includes(activeSession));
    good(await harness.qqMemory.captureSource(source(91))); good(await harness.deliverPromptNow('group:900', 'worker退出前的新鲜输入', {}));
    const workerSession = harness.state.sessions['group:900'], sendsBeforeWorkerDeath = harness.calls.sent.length, promptsBeforeWorkerDeath = harness.calls.prompts.length;
    await service.close(); await harness.sendToQQ('group:900', 'worker已退出不得发送'); assert.equal(harness.calls.sent.length, sendsBeforeWorkerDeath);
    assert.equal((await harness.deliverPromptNow('group:900', 'worker已退出不得回退', {})).ok, false); assert.equal(harness.calls.prompts.length, promptsBeforeWorkerDeath); assert.ok(harness.calls.cancelled.includes(workerSession)); assert.ok(harness.calls.archived.includes(workerSession));
    console.log('PASS real QQ Host/kernel/HTTP: complete inputs, multi-actor group, private separation, actual VM prompt/send gates, revocation retirement and original-epoch/lost-registration recovery, 605 sources, exact model route/unknown/mismatch/fallback/observed drift, default-deny native preset proof (positive proof is fixture-only), creation/generation revocation, pending retirement restart into V1 and worker death');
  } finally { if (restartedHarness) await restartedHarness.close(); if (harness) await harness.close(); api?.close(); host.close(); await new Promise(resolve => server.close(resolve)); await service.close(); }
}
