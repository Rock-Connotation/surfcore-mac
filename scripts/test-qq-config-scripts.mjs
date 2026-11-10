import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-scripts-'));
fs.mkdirSync(path.join(root, 'scripts')); fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
for (const name of ['voice-activate.mjs', 'sync-dsh-port.mjs', 'init-qq-config.mjs']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(root, 'scripts', name));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
const configFile = path.join(root, 'config.json');
const run = (name, args = []) => spawnSync(process.execPath, [path.join(root, 'scripts', name), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, SURFCORE_ROOT: root } });

test('端口同步重读配置并保留火山选择；旧启用脚本拒绝接管火山', () => {
  const initial = { dsh: { baseUrl: 'http://127.0.0.1:1234' }, socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', selectionRevision: 4 } } } };
  fs.writeFileSync(configFile, JSON.stringify(initial));
  const sync = run('sync-dsh-port.mjs', ['--url', 'http://127.0.0.1:2345']); assert.equal(sync.status, 0, sync.stderr);
  let saved = JSON.parse(fs.readFileSync(configFile)); assert.equal(saved.dsh.baseUrl, 'http://127.0.0.1:2345');
  assert.equal(saved.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(saved.socialV2.voice.tts.selectionRevision, 4);
  const before = fs.readFileSync(configFile, 'utf8');
  const refused = run('voice-activate.mjs'); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /VOICE_SELECTION_MANAGED/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  saved.socialV2.voice.tts.cloudProvider = 'voxd'; saved.socialV2.voice.tts.enabled = false; fs.writeFileSync(configFile, JSON.stringify(saved));
  const activated = run('voice-activate.mjs'); assert.equal(activated.status, 0, activated.stderr);
  saved = JSON.parse(fs.readFileSync(configFile)); assert.equal(saved.socialV2.voice.tts.enabled, true); assert.equal(saved.socialV2.voice.tts.selectionRevision, 5);
});

test('独立安装器只原子创建配置且遵守共享锁', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/installer/installer.mjs'), 'utf8');
  const start = source.indexOf('function initializeConfig('), end = source.indexOf('\nfunction run(', start);
  assert(start >= 0 && end > start);
  const context = vm.createContext({ fs, path, crypto, TextDecoder });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.initializeConfig = initializeConfig;', context);
  const dir = fs.mkdtempSync(path.join(root, 'installer-'));
  fs.writeFileSync(path.join(dir, 'config.example.json'), '{"sample":true}');
  assert.equal(context.initializeConfig(dir), true);
  fs.writeFileSync(path.join(dir, 'config.example.json'), '{"sample":false}');
  assert.equal(context.initializeConfig(dir), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).sample, true);
  fs.mkdirSync(path.join(dir, 'state', 'volc-voice-budget.lock'));
  assert.equal(context.initializeConfig(dir), false, '已有配置无需争用锁');
  const busy = fs.mkdtempSync(path.join(root, 'installer-busy-'));
  fs.writeFileSync(path.join(busy, 'config.example.json'), '{}'); fs.mkdirSync(path.join(busy, 'state', 'volc-voice-budget.lock'), { recursive: true });
  assert.throws(() => context.initializeConfig(busy));
});

test('初始化脚本不会覆盖已有配置', () => {
  fs.writeFileSync(path.join(root, 'config.example.json'), '{"template":true}');
  const before = fs.readFileSync(configFile, 'utf8'); const result = run('init-qq-config.mjs', [root]);
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(configFile, 'utf8'), before);
});
