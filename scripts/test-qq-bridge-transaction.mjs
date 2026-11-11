import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createVoiceManagement } from '../src/voice-management.js';
import { persistSnowLumaEndpoint } from '../src/snowluma-conn.js';

test('旧桥接快照写回不覆盖火山选择，通用入口不能改选择', async () => {
  const h = await bridgeHarness({ config: { socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'voxd' } } } } });
  const file = path.join(h.temp, 'config.json');
  const manager = createVoiceManagement({ configFile: file, programRoot: h.temp });
  try {
    const old = h.readConfigObject(file); old.snowluma = { ...(old.snowluma || {}), httpUrl: 'http://127.0.0.1:43210' };
    const switched = await manager.dispatch({ method: 'POST', pathname: '/volc-config', body: { provider: 'volc' } });
    assert.equal(switched.data.ok, true);
    h.atomicWriteJson(file, old);
    let saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(saved.socialV2.voice.tts.selectionRevision, 1);
    assert.equal(saved.snowluma.httpUrl, 'http://127.0.0.1:43210');
    const forbidden = h.readConfigObject(file); forbidden.socialV2.voice.tts.cloudProvider = 'voxd';
    assert.throws(() => h.atomicWriteJson(file, forbidden), e => e.code === 'VOICE_SELECTION_MANAGED' && Boolean(e.hint));
    persistSnowLumaEndpoint(file, { wsUrl: 'ws://127.0.0.1:43211' });
    saved = JSON.parse(fs.readFileSync(file)); assert.equal(saved.socialV2.voice.tts.cloudProvider, 'volc');
    assert.equal(saved.socialV2.voice.tts.selectionRevision, 1); assert.equal(saved.snowluma.wsUrl, 'ws://127.0.0.1:43211');
    const lock = path.join(h.temp, 'state', 'volc-voice-budget.lock'); fs.mkdirSync(lock);
    await h.syncTokenToFile();
    const failed = h.snowlumaHealthSnapshot().configWriteFailure;
    assert.equal(failed.code, 'VOICE_VOLC_BUDGET_BUSY'); assert.ok(failed.error && failed.hint);
    const consoleHtml = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
    const client = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
    assert(consoleHtml.includes('qqConfigWriteWarn') && consoleHtml.includes('configWriteFailure'));
    assert(client.includes('bridge.snowluma?.configWriteFailure'));
    fs.rmdirSync(lock); await h.syncTokenToFile(); assert.equal(h.snowlumaHealthSnapshot().configWriteFailure, null);
    const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/config`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': h.cfg.consoleToken },
        body: JSON.stringify({ voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'voxd' } } }) });
      const data = await response.json(); assert.equal(response.status, 409); assert.equal(data.code, 'VOICE_SELECTION_MANAGED'); assert.ok(data.hint);
      assert.equal(JSON.parse(fs.readFileSync(file)).socialV2.voice.tts.cloudProvider, 'volc');
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await manager.dispose(); await h.close(); }
});
