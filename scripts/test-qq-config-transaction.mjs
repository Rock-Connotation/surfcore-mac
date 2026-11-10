import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { commitQqConfigPatch, initializeQqConfig, transactQqConfig } from '../src/qq-config-transaction.js';
import { persistSnowLumaEndpoint } from '../src/snowluma-conn.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-transaction-'));
  const file = path.join(root, 'config.json');
  const initial = { allow: { groups: [1] }, socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'voxd', selectionRevision: 1 } } } };
  fs.writeFileSync(file, JSON.stringify(initial));
  return { root, file, initial };
}

test('并发无关字段合并，重叠变更拒绝', () => {
  const f = fixture();
  const next = structuredClone(f.initial); next.allow.groups = [1, 2];
  const external = structuredClone(f.initial); external.label = 'other'; fs.writeFileSync(f.file, JSON.stringify(external));
  const result = commitQqConfigPatch(f.file, f.initial, next);
  assert.deepEqual(result.allow.groups, [1, 2]); assert.equal(result.label, 'other');
  const wanted = structuredClone(result); wanted.allow.groups = [1, 3];
  const conflict = structuredClone(result); conflict.allow.groups = [1, 4]; fs.writeFileSync(f.file, JSON.stringify(conflict));
  assert.throws(() => commitQqConfigPatch(f.file, result, wanted), e => e.code === 'CONFIG_STALE' && Boolean(e.hint));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).allow.groups, [1, 4]);
});

test('完整恢复遇到任何并发变更都拒绝，避免误报全部恢复', () => {
  const f = fixture();
  const backup = structuredClone(f.initial); backup.allow.groups = [8];
  const current = structuredClone(f.initial); current.other = 'new'; fs.writeFileSync(f.file, JSON.stringify(current));
  assert.throws(() => commitQqConfigPatch(f.file, f.initial, backup, { requireExactBase: true }), e => e.code === 'CONFIG_STALE' && Boolean(e.hint));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), current);
});

test('跨进程交错写入保留彼此字段和语音选择', async () => {
  const f = fixture();
  const spec = new URL('../src/qq-config-transaction.js', import.meta.url).href;
  const script = `import {commitQqConfigPatch} from ${JSON.stringify(spec)}; const [file,field,raw]=process.argv.slice(1); const base=JSON.parse(raw),next=structuredClone(base);next[field]=field;for(let i=0;i<100;i++){try{commitQqConfigPatch(file,base,next);process.exit(0)}catch(e){if(e.code!=='VOICE_VOLC_BUDGET_BUSY')process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}process.exit(3);`;
  const children = ['first', 'second'].map(field => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.file, field, JSON.stringify(f.initial)]);
    child.once('error', reject); child.once('exit', resolve);
  }));
  assert.deepEqual(await Promise.all(children), [0, 0]);
  const result = JSON.parse(fs.readFileSync(f.file));
  assert.equal(result.first, 'first'); assert.equal(result.second, 'second');
  assert.equal(result.socialV2.voice.tts.cloudProvider, 'voxd'); assert.equal(result.socialV2.voice.tts.selectionRevision, 1);
});

test('真实通用保存和语音管理跨进程交错不丢选择', async () => {
  const f = fixture(); fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, 'src', 'bridge.js'), '');
  const storeUrl = new URL('../plugins/surfcore/lib/store.js', import.meta.url).href;
  const voiceUrl = new URL('../src/voice-management.js', import.meta.url).href;
  const snowUrl = new URL('../src/snowluma-conn.js', import.meta.url).href;
  const code = `import fs from 'node:fs';import path from 'node:path';const [root,role,storeUrl,voiceUrl,snowUrl]=process.argv.slice(1);process.env.SURFCORE_ROOT=root;process.env.DSH_HOME=path.join(root,'dsh');process.env.USERPROFILE=process.env.DSH_HOME;const mod=await import(role==='store'?storeUrl:role==='voice'?voiceUrl:snowUrl);const manager=role==='voice'?mod.createVoiceManagement({configFile:path.join(root,'config.json'),programRoot:root}):null;fs.writeFileSync(path.join(root,'ready-'+role),'');while(!fs.existsSync(path.join(root,'go')))await new Promise(r=>setTimeout(r,5));let ok=false;for(let i=0;i<100;i++){try{if(role==='store')mod.saveQqConfig({allow:{private:['1234'],groups:[1]}});else if(role==='snow')mod.persistSnowLumaEndpoint(path.join(root,'config.json'),{wsUrl:'ws://127.0.0.1:12345'});else{const r=await manager.dispatch({method:'POST',pathname:'/volc-config',body:{provider:'volc'}});if(!r.data.ok){if(/BUSY/.test(r.data.code))throw Object.assign(new Error('busy'),{code:'VOICE_VOLC_BUDGET_BUSY'});process.exit(3)}}ok=true;break}catch(e){if(e.code!=='VOICE_VOLC_BUDGET_BUSY')process.exit(4);await new Promise(r=>setTimeout(r,5))}}if(manager)await manager.dispose();process.exit(ok?0:5);`;
  const children = ['store', 'voice', 'snow'].map(role => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.root, role, storeUrl, voiceUrl, snowUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject);
    child.once('exit', status => status === 0 ? resolve(status) : reject(new Error(`fixture ${role}: ${status} ${stderr}`)));
  }));
  const deadline = Date.now() + 5000;
  while (!['store', 'voice', 'snow'].every(role => fs.existsSync(path.join(f.root, `ready-${role}`)))) {
    assert(Date.now() < deadline, '子进程必须到达隔离屏障'); await new Promise(resolve => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(f.root, 'go'), ''); await Promise.all(children);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.equal(saved.socialV2.voice.tts.cloudProvider, 'volc'); assert.equal(saved.socialV2.voice.tts.selectionRevision, 2);
  assert.deepEqual(saved.allow.private, ['1234']); assert.equal(saved.snowluma.wsUrl, 'ws://127.0.0.1:12345');
});

test('原子替换失败返回可行动错误并保留原配置及备份', () => {
  const f = fixture(), before = fs.readFileSync(f.file, 'utf8'), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.file) throw new Error('fixture'); return rename(from, to); };
  try {
    assert.throws(() => transactQqConfig(f.file, cfg => { cfg.label = 'next'; }), e => e.code === 'QQ_CONFIG_WRITE_FAILED' && Boolean(e.hint));
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    const dir = path.join(f.root, 'state', 'qq-config-transaction-backups'), names = fs.readdirSync(dir);
    assert.equal(names.length, 1); assert.equal(fs.readFileSync(path.join(dir, names[0]), 'utf8'), before);
  } finally { fs.renameSync = rename; }
});

test('嵌套事务立即拒绝，原文件不变', () => {
  const f = fixture(); const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => transactQqConfig(f.file, () => transactQqConfig(f.file, () => {})), e => e.code === 'VOICE_VOLC_BUDGET_BUSY' && Boolean(e.hint));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('初始化只创建缺失文件，绝不覆盖已有配置', () => {
  const f = fixture(), template = path.join(f.root, 'config.example.json');
  fs.writeFileSync(template, JSON.stringify({ example: true }));
  const original = fs.readFileSync(f.file, 'utf8');
  assert.equal(initializeQqConfig(f.file, template).created, false); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  const fresh = path.join(f.root, 'fresh.json'); assert.equal(initializeQqConfig(fresh, template).created, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh)), { example: true });
});

test('端点自愈兼容相对配置路径并保留语音选择', () => {
  const f = fixture();
  const result = persistSnowLumaEndpoint(path.relative(process.cwd(), f.file), { httpUrl: 'http://127.0.0.1:12345' });
  assert.equal(result.updated, true);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.equal(saved.snowluma.httpUrl, 'http://127.0.0.1:12345');
  assert.equal(saved.socialV2.voice.tts.cloudProvider, 'voxd'); assert.equal(saved.socialV2.voice.tts.selectionRevision, 1);
});

test('授权选择变更自动递增版本，异步事务被拒绝', () => {
  const f = fixture();
  transactQqConfig(f.file, cfg => { cfg.socialV2.voice.tts.cloudProvider = 'volc'; }, { allowVoiceSelection: true });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).socialV2.voice.tts.selectionRevision, 2);
  transactQqConfig(f.file, cfg => { cfg.socialV2.voice.tts.cloudProvider = 'voxd'; }, { allowVoiceSelection: true });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).socialV2.voice.tts.selectionRevision, 3);
  assert.throws(() => transactQqConfig(f.file, async () => {}), e => e.code === 'QQ_CONFIG_ASYNC_UNSUPPORTED' && Boolean(e.hint));
});

test('通用写入不能更改服务选择及版本', () => {
  const f = fixture();
  for (const change of [{ cloudProvider: 'volc' }, { selectionRevision: 2 }, { route: 'local' }, { endpoints: null }]) {
    const next = structuredClone(f.initial); Object.assign(next.socialV2.voice.tts, change);
    assert.throws(() => commitQqConfigPatch(f.file, f.initial, next), e => e.code === 'VOICE_SELECTION_MANAGED' && Boolean(e.hint));
  }
  const erased = structuredClone(f.initial); erased.socialV2.voice = null;
  assert.throws(() => commitQqConfigPatch(f.file, f.initial, erased), e => e.code === 'VOICE_SELECTION_MANAGED' && Boolean(e.hint));
  const higherLimit = structuredClone(f.initial); higherLimit.socialV2.voice.maxPerMinute = 60;
  assert.throws(() => commitQqConfigPatch(f.file, f.initial, higherLimit), e => e.code === 'VOICE_SELECTION_MANAGED' && Boolean(e.hint));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.initial);
});
