// 走真实 bridge.js 的语音路由：text → voxd（本地假服务）→ record 段 → 网关（假）。
// 不连真 QQ、不碰真实 config；用来证明「AI 说一句」这条链路在代码层是通的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

import { bridgeHarness } from './audit-bridge-harness.mjs';
import { synthesizeToFile } from '../src/voice-tts.js';
import { createVoiceManagement } from '../src/voice-management.js';

function wav(seconds = 0.1, sr = 16000) {
  const n = Math.round(sr * seconds);
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const seen = [];
const tts = http.createServer((req, res) => {
  if (req.url === '/v1/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"engine":"fixture"}'); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push(JSON.parse(body || '{}'));
    if (!req.url.startsWith('/v1/speak/file')) {
      res.writeHead(404).end();
      return;
    }
    const buf = wav();
    res.writeHead(200, { 'content-type': 'audio/wav', 'x-duration-ms': '1500' });
    res.end(buf);
  });
});
await new Promise((r) => tts.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${tts.address().port}`;

const h = await bridgeHarness({
  config: {
    allow: { groups: ['456'], private: ['123'] },
    socialV2: {
      mode: 'reserved2',
      voice: {
        enabled: true,
        maxPerMinute: 5,
        tts: {
          enabled: true,
          // 桥接解析顺序是 endpoints[route] > endpoints[默认 route] > baseUrl；
          // 只给 baseUrl 会被默认 127.0.0.1:8765 覆盖（本机只跑云端 8767 时直接 fetch failed）。
          baseUrl,
          route: 'local',
          endpoints: { local: baseUrl, cloud: baseUrl },
          maxChars: 20,
          character: 'huayan'
        }
      },
      tools: { sendVoice: true }
    }
  }
});

try {
  // ① text → 合成 → 本地 wav
  const r = await h.synthesizeVoiceText('来了来了', {});
  assert.ok(fs.existsSync(r.path), '应该落成本地文件');
  assert.equal(r.via, 'tts');
  assert.equal(fs.readFileSync(r.path).subarray(0, 4).toString(), 'RIFF', '必须是 wav');
  assert.ok(seen.length, '应该请求 TTS 服务');
  assert.equal(seen[0].text, '来了来了');
  assert.equal(seen[0].format, 'wav');
  assert.equal(seen[0].character, 'huayan', 'character 应该来自 voice.tts.character');

  // ② 发出去的是 record 段，不是文本
  const sent = await h.sendVoiceForV2('group:456', null, { resolved: r, verify: false });
  assert.equal(sent.key, 'group:456');
  const onebot = h.calls.http.filter((c) => c.url.endsWith('send_group_msg')).pop();
  assert.ok(onebot, '应该调用 send_group_msg');
  assert.equal(onebot.body.message[0].type, 'record');
  assert.equal(onebot.body.group_id, 456);
  assert.equal(onebot.body.message[0].data.file, r.path, '默认保留本机路径');

  if (fs.constants.O_NOFOLLOW) {
  const inline = await bridgeHarness({ config: { allow: { groups: ['456'] }, socialV2: { mode: 'reserved2', voice: { enabled: true, recordTransport: 'base64' }, tools: { sendVoice: true } } } });
  try {
    await inline.sendVoiceForV2('group:456', null, { resolved: r, verify: false });
    const msg = inline.calls.http.filter(c => c.url.endsWith('send_group_msg')).pop();
    assert.equal(msg.body.message[0].data.file, 'base64://' + fs.readFileSync(r.path).toString('base64'));
  } finally { await inline.close(); }

  const reverse = await bridgeHarness({ config: { socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'voxd', endpoints: { cloud: baseUrl } } } } } });
  try {
    const oldCloud = await reverse.synthesizeVoiceText('旧云可用', {});
    assert.equal(oldCloud.route, 'cloud'); assert(seen.some(value => value.text === '旧云可用'));
    const file = `${reverse.temp}/config.json`, changed = JSON.parse(fs.readFileSync(file));
    changed.socialV2.voice.tts.cloudProvider = 'volc'; fs.writeFileSync(file, JSON.stringify(changed));
    const before = seen.length;
    await assert.rejects(reverse.synthesizeVoiceText('切换后', {}), e => e.code === 'VOICE_TTS_CONFIG_CHANGED' && Boolean(e.hint));
    const manager = createVoiceManagement({ configFile: file, programRoot: reverse.temp });
    try {
      const back = await manager.dispatch({ method: 'POST', pathname: '/volc-config', body: { provider: 'voxd' } });
      assert.equal(back.data.ok, true); assert.equal(JSON.parse(fs.readFileSync(file)).socialV2.voice.tts.selectionRevision, 1);
      await assert.rejects(reverse.synthesizeVoiceText('切回后', {}), e => e.code === 'VOICE_TTS_CONFIG_CHANGED' && Boolean(e.hint));
    } finally { await manager.dispose(); }
    assert.equal(seen.length, before, '旧voxd进程不得在切换或切回后继续发请求');
  } finally { await reverse.close(); }

  let fallbackCalls = 0;
  const fallback = await bridgeHarness({ config: { socialV2: { voice: { tts: { enabled: true, route: 'local', cloudProvider: 'voxd', endpoints: { local: 'http://127.0.0.1:11111', cloud: baseUrl } } } } },
    synthesizeImpl: async () => { fallbackCalls++; throw new Error('TTS 服务没起来'); } });
  try {
    const file = `${fallback.temp}/config.json`, changed = JSON.parse(fs.readFileSync(file));
    changed.socialV2.voice.tts.cloudProvider = 'volc'; fs.writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(fallback.synthesizeVoiceText('后备', {}), e => e.code === 'VOICE_TTS_CONFIG_CHANGED' && Boolean(e.hint));
    assert.equal(fallbackCalls, 1, '本地失败后不得调用已过期的旧云后备');
  } finally { await fallback.close(); }

  const keyId = '00000000-0000-4000-8000-000000000000';
  let volcCalls = 0;
  const volc = await bridgeHarness({ config: { socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', volcKeyId: keyId, maxChars: 120 } } } },
    files: { [`state/volc-voice-keys/${keyId}`]: 'fixture-key' },
    synthesizeImpl: async opts => {
      volcCalls++;
      assert.equal(opts.provider, 'volc'); assert.equal(opts.apiKey, 'fixture-key');
      assert.equal(opts.budget.configFile, `${volc.temp}/config.json`);
      throw Object.assign(new Error('fixture-key fixture failed'), { code: 'VOICE_VOLC_FAILED', hint: 'fixture-key 请检查' });
    } });
  try {
    fs.chmodSync(`${volc.temp}/state/volc-voice-keys`, 0o700);
    fs.chmodSync(`${volc.temp}/state/volc-voice-keys/${keyId}`, 0o600);
    await assert.rejects(volc.synthesizeVoiceText('测试', {}), e => e.code === 'VOICE_VOLC_FAILED' && Boolean(e.hint));
    assert.equal(volcCalls, 1, '火山失败不能自动换路重试');
    const logged = fs.readFileSync(`${volc.temp}/state/voice-errors.log`, 'utf8');
    const record = JSON.parse(logged.trim().split('\n').at(-1));
    assert.equal(record.code, 'VOICE_VOLC_FAILED'); assert.ok(record.hint); assert(!logged.includes('fixture-key'));
    await assert.rejects(volc.synthesizeVoiceText('字'.repeat(121), {}), /最多 120 字/);
    assert.equal(volcCalls, 1);
  } finally { await volc.close(); }

  let cloudCalls = 0;
  const stale = await bridgeHarness({ config: { socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', volcKeyId: keyId, maxChars: 120, endpoints: { cloud: baseUrl } } } } },
    files: { [`state/volc-voice-keys/${keyId}`]: 'fixture-key' },
    synthesizeImpl: opts => synthesizeToFile({ ...opts, fetchImpl: async () => { cloudCalls++; throw new Error('must not fetch'); } }) });
  try {
    fs.chmodSync(`${stale.temp}/state/volc-voice-keys`, 0o700);
    fs.chmodSync(`${stale.temp}/state/volc-voice-keys/${keyId}`, 0o600);
    const file = `${stale.temp}/config.json`;
    const changed = JSON.parse(fs.readFileSync(file)); changed.socialV2.voice.tts.cloudProvider = 'voxd';
    fs.writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(stale.synthesizeVoiceText('测试', {}), e => e.code === 'VOICE_VOLC_CONFIG_CHANGED' && Boolean(e.hint));
    assert.equal(cloudCalls, 0); assert.equal(fs.existsSync(`${stale.temp}/state/volc-voice-budget.json`), false);
    const consoleServer = stale.startConsoleServer();
    if (!consoleServer.listening) await new Promise(resolve => consoleServer.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${consoleServer.address().port}/api/voice/tts-check`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': stale.cfg.consoleToken }, body: '{}'
      });
      const result = await response.json();
      assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.route, 'cloud');
      assert.equal(result.stages.find(stage => stage.name === 'synth').ok, true);
      assert.equal(result.code, 'VOICE_DISABLED'); assert.ok(result.hint);
      assert.equal(cloudCalls, 0); assert(seen.some(value => value.text === '语音自检'));
    } finally { await new Promise(resolve => consoleServer.close(resolve)); }
  } finally { await stale.close(); }
  }

  // ③ 超长：给可读错误，而不是让模型猜
  await assert.rejects(() => h.synthesizeVoiceText('字'.repeat(30), {}), /最多 20 字/);

  console.log('test-voice-route: ok');
} finally {
  await h.close();
  await new Promise((r) => tts.close(r));
}
