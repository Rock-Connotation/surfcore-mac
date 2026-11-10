import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStamp } from '../src/config-stamps.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-transaction-'));
fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'bridge.js'), '');
const file = path.join(root, 'config.json');
fs.writeFileSync(file, JSON.stringify({ socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'voxd', selectionRevision: 1 } } } }));
process.env.SURFCORE_ROOT = root; process.env.DSH_HOME = path.join(root, 'dsh');
const { saveQqConfig } = await import('../plugins/surfcore/lib/store.js');

test('通用保存保留语音选择，直接修改选择明确拒绝', () => {
  const stamp = fileStamp(file);
  const saved = saveQqConfig({ allow: { private: ['1234'], groups: [] } }, { expectedStamp: stamp });
  assert.equal(saved.config.socialV2.voice.tts.cloudProvider, 'voxd');
  assert.equal(JSON.parse(fs.readFileSync(file)).socialV2.voice.tts.selectionRevision, 1);
  assert.throws(() => saveQqConfig({ socialV2: { voice: { tts: { cloudProvider: 'volc' } } } }), e => e.code === 'VOICE_SELECTION_MANAGED' && Boolean(e.hint));
  assert.equal(JSON.parse(fs.readFileSync(file)).socialV2.voice.tts.cloudProvider, 'voxd');
  assert.throws(() => saveQqConfig({ ownerQQ: '1234' }, { expectedStamp: stamp }), e => e.code === 'CONFIG_STALE' && Boolean(e.hint));
});
