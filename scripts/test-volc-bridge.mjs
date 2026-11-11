import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function call(port, token, pathname, body, agentToken) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', 'x-console-token': token };
    if (agentToken) headers['x-agent-token'] = agentToken;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers }, res => {
      let text = ''; res.on('data', data => { text += data; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('旧控制台提供火山配置与自检，AI和操作者 dryRun 不合成', async () => {
  let synths = 0;
  const h = await bridgeHarness({ config: { socialV2: { mode: 'reserved2', tools: { sendVoice: true }, voice: {
    enabled: true, trigger: { who: 'owner' }, tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', maxChars: 120 }
  } } }, synthesizeImpl: async () => { synths++; throw new Error('must not synthesize'); } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port, token = h.cfg.consoleToken;
  try {
    const check = await call(port, token, '/api/voice/tts-check', {});
    assert.equal(check.data.code, 'VOICE_VOLC_KEY_INVALID'); assert.ok(check.data.hint);
    const errorLog = fs.readFileSync(path.join(h.temp, 'state', 'voice-errors.log'), 'utf8');
    assert.match(errorLog, /VOICE_VOLC_KEY_INVALID/); assert(!errorLog.includes(token));
    const set = await call(port, token, '/api/voice/volc-config', { provider: 'volc', apiKey: 'fixture' + '-only-key' });
    assert.equal(set.data.ok, true); assert(!JSON.stringify(set).includes('fixture-only-key'));
    const get = await call(port, token, '/api/voice/volc-config');
    assert.equal(get.data.hasKey, true); assert(!JSON.stringify(get).includes('fixture-only-key'));
    const op = await call(port, token, '/api/voice/send', { target: 'private:123', text: '你好', dryRun: true });
    assert.equal(op.data.ok, true); assert.equal(op.data.dryRun, true);
    const st = h.getSocialV2State('private:123');
    const agent = await call(port, token, '/api/socialV2/send-voice', { key: 'private:123', text: '你好', dryRun: true, token: st.agentToken }, st.agentToken);
    assert.equal(agent.data.ok, true, JSON.stringify(agent.data)); assert.equal(agent.data.dryRun, true);
    const badOp = await call(port, token, '/api/voice/send', { target: 'private:123', text: '你好', volume: 0 });
    assert.equal(badOp.data.code, 'VOICE_AUDIO_OPTIONS_INVALID'); assert.ok(badOp.data.hint);
    const badAgent = await call(port, token, '/api/socialV2/send-voice', { key: 'private:123', text: '你好', normalize: true, loudness: 'invalid', token: st.agentToken }, st.agentToken);
    assert.equal(badAgent.data.code, 'VOICE_AUDIO_OPTIONS_INVALID'); assert.ok(badAgent.data.hint);
    h.cfg.socialV2.voice.tts.cloudProvider = 'voxd';
    const oldCloud = await call(port, token, '/api/voice/send', { target: 'private:123', text: '你好', dryRun: true });
    assert.equal(oldCloud.data.ok, true); assert.equal(oldCloud.data.dryRun, true);
    const oldAgent = await call(port, token, '/api/socialV2/send-voice', { key: 'private:123', text: '你好', dryRun: true, token: st.agentToken }, st.agentToken);
    assert.equal(oldAgent.data.ok, true); assert.equal(oldAgent.data.dryRun, true);
    assert.equal(synths, 0);
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'volc-voice-budget.json')), false);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('火山合成自检成功不掩盖发送总闸或工具关闭', async () => {
  for (const [master, tool, expectedCode] of [[false, true, 'VOICE_DISABLED'], [true, false, 'VOICE_TOOL_DISABLED'], [true, true, '']]) {
    const h = await bridgeHarness({ config: { socialV2: { tools: { sendVoice: tool }, voice: {
      enabled: master, tts: { enabled: true, route: 'cloud', cloudProvider: 'volc' }
    } } }, voiceManagementImpl: () => ({ dispatch: async () => ({ status: 200, data: { ok: true, stages: [{ name: 'synth', ok: true, detail: 'fixture' }] } }), dispose: async () => {} }) });
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    try {
      const result = await call(server.address().port, h.cfg.consoleToken, '/api/voice/tts-check', {});
      const send = result.data.stages.find(stage => stage.name === 'send');
      assert.equal(result.data.stages[0].name, 'synth'); assert.equal(result.data.stages[0].ok, true);
      assert.equal(send.ok, master && tool); assert.match(send.detail, /目标授权/);
      assert.equal(result.data.ok, master && tool);
      if (expectedCode) { assert.equal(result.data.code, expectedCode); assert.ok(result.data.hint); assert.ok(send.hint); }
    } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
  }
});
