import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-package-consumers-'));
const dshHome = path.join(root, 'dsh');
process.env.DSH_HOME = dshHome;
for (const key of ['SURFCORE_ROOT', 'SURFCORE_QQBOT_ROOT', 'QQBILI_QQBOT_ROOT']) delete process.env[key];
const { loadSearchConfig } = await import('../src/web-search.js');
const { createVoicePacks } = await import('../src/voice-packs.js');
const { createBillingService } = await import('../plugins/surfcore/lib/billing.js');
const { discoverDshBaseUrl } = await import('../src/dsh-port.js');
const pkg = path.join(root, 'program-package'); const persistent = path.join(dshHome, 'surfcore', 'qq');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'surfcore', version: '1.0.0' }));
fs.writeFileSync(path.join(pkg, '.surfcore-install.json'), JSON.stringify({ schemaVersion: 1, kind: 'package', sourceRepo: 'fixture/repo', updateOwner: 'fixture' }));
fs.mkdirSync(path.join(persistent, 'state', 'voice-packs', 'voice-cloud', 'logs'), { recursive: true });
fs.writeFileSync(path.join(persistent, 'config.json'), JSON.stringify({ webSearch: { provider: 'deepseek', model: 'fixture-package-model' }, socialV2: { voice: { cloud: { pricePerKChar: 4, monthlyQuota: 4000 } } } }));
fs.writeFileSync(path.join(persistent, 'state', 'voice-packs', 'voice-cloud', 'config.toml'), 'cloud_resource = "fixture-model"\n');
fs.writeFileSync(path.join(persistent, 'state', 'voice-packs', 'voice-cloud', 'logs', 'requests.jsonl'), JSON.stringify({ t: new Date().toISOString(), chars: 1250 }) + '\n');
fs.writeFileSync(path.join(persistent, 'state', 'token-usage.jsonl'), JSON.stringify({ k:'turn', t:Date.now(), sid:'s1', key:'group:42', turn:1, step:1, retry:0, model:'deepseek-flash', b:{cacheMiss:100,cacheHit:1000,cacheWrite:0,output:10} })+'\n');
fs.writeFileSync(path.join(persistent, 'state', 'context-telemetry-bridge.jsonl'), JSON.stringify({ v:1, ts:Date.now(), kind:'wake', wakeId:'w1', key:'group:42', sessionId:'s1', characterId:'alpha', reason:'groupMessage', promptChars:100, layers:{} })+'\n');
fs.writeFileSync(path.join(persistent, 'state', 'dsh-port.json'), JSON.stringify({ port: 54321 }));

test('package consumers use persistent config, billing ledger and voice data', async () => {
 assert.equal(loadSearchConfig(pkg).model, 'fixture-package-model');
 const billing = createBillingService({ stateDir: path.join(dshHome, 'surfcore'), qqRoot: pkg, intervalMs: 0, readCurrentCharacter: () => ({id:'alpha',name:'Alpha'}) });
 const result = billing.generate(); assert.equal(result.ok, true, result.error); assert.equal(result.conversations, 1);
 assert.match(fs.readFileSync(path.join(dshHome, 'surfcore', 'billing', 'conversations', 'group_42.md'), 'utf8'), /group:42/);
 const voice = createVoicePacks({}, { programRoot: pkg });
 const stats = await voice.cloudStats('voice-cloud'); assert.equal(stats.totalChars, 1250); assert.equal(stats.pricePerKChar, 4); assert.equal(stats.monthlyQuota, 4000);
 assert.equal((await voice.setEnabled('voice-cloud', true)).ok, true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(persistent, 'state', 'voice-packs', 'installed.json'))).packs['voice-cloud'].enabled, true);
 const originalConnect = net.connect;
 net.connect = ({port}) => { const sock = new EventEmitter(); sock.setTimeout = () => sock; sock.destroy = () => sock; queueMicrotask(() => sock.emit(port === 8767 ? 'connect' : 'error', new Error('fixture closed'))); return sock; };
 try { assert.equal((await voice.activate('voice-cloud')).ok, true); } finally { net.connect = originalConnect; }
 const written = JSON.parse(fs.readFileSync(path.join(persistent, 'config.json')));
 assert.equal(written.socialV2.voice.tts.route, 'cloud'); assert.equal(written.socialV2.voice.tts.enabled, true);
 assert.equal(voice.packsDir(), path.join(persistent, 'state', 'voice-packs'));
 assert.equal(fs.existsSync(path.join(pkg, 'state')), false); assert.equal(fs.existsSync(path.join(pkg, 'config.json')), false);
});

test('packaged cache changes probe order but multiple live endpoints fail closed', async () => {
 const calls = [];
 const command = (file) => file === '/usr/sbin/lsof' ? 'p1\nn127.0.0.1:11111\np2\nn127.0.0.1:54321\n' : '/Applications/DeepSeek Harness.app/Contents/MacOS/dsh';
 const env = { DSH_HOME: dshHome, HOME: root };
 const result = await discoverDshBaseUrl({ platform:'darwin', programRoot:pkg, env, command, probe:async (url) => { calls.push(url); return url.endsWith(':54321'); } });
 assert.equal(result, 'http://127.0.0.1:54321'); assert.equal(calls[0], 'http://127.0.0.1:54321');
 assert.equal(await discoverDshBaseUrl({ platform:'darwin', programRoot:pkg, env, command, probe:async () => true }), null);
});

test('source and explicit legacy roots retain existing config and state', async () => {
 const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'state', 'voice-packs', 'voice-cloud', 'logs'), { recursive: true });
 fs.mkdirSync(path.join(source, 'src'), { recursive: true }); fs.writeFileSync(path.join(source, 'src', 'bridge.js'), '');
 fs.writeFileSync(path.join(source, 'config.json'), JSON.stringify({ webSearch:{model:'fixture-source-model'}, socialV2:{voice:{cloud:{pricePerKChar:8,monthlyQuota:2000}}} }));
 fs.writeFileSync(path.join(source, 'state', 'token-usage.jsonl'), JSON.stringify({ k:'turn', t:Date.now(), sid:'s2', key:'group:88', turn:1, step:1, retry:0, model:'deepseek-flash', b:{cacheMiss:30,cacheHit:50,cacheWrite:0,output:5} })+'\n');
 fs.writeFileSync(path.join(source, 'state', 'dsh-port.json'), JSON.stringify({ port: 11111 }));
 fs.writeFileSync(path.join(source, 'state', 'voice-packs', 'voice-cloud', 'config.toml'), 'cloud_resource = "source-model"\n');
 fs.writeFileSync(path.join(source, 'state', 'voice-packs', 'voice-cloud', 'logs', 'requests.jsonl'), JSON.stringify({chars:321,t:new Date().toISOString()})+'\n');
 assert.equal(loadSearchConfig(source).model, 'fixture-source-model');
 assert.equal((await createVoicePacks({}, { programRoot:source }).cloudStats('voice-cloud')).totalChars, 321);
 process.env.SURFCORE_ROOT = source;
 try {
   assert.equal(loadSearchConfig(pkg).model, 'fixture-source-model');
   const legacyVoice = await createVoicePacks({}, { programRoot:pkg }).cloudStats('voice-cloud');
   assert.equal(legacyVoice.totalChars, 321); assert.equal(legacyVoice.pricePerKChar, 8);
   const legacyBilling = createBillingService({stateDir:path.join(root,'legacy-billing'),qqRoot:pkg,intervalMs:0});
   assert.equal(legacyBilling.generate().conversations, 1);
   assert.match(fs.readFileSync(path.join(root,'legacy-billing','billing','conversations','group_88.md'),'utf8'), /group:88/);
   const calls = []; const command = (file) => file === '/usr/sbin/lsof' ? 'p1\nn127.0.0.1:54321\np2\nn127.0.0.1:11111\n' : '/Applications/DeepSeek Harness.app/Contents/MacOS/dsh';
   await discoverDshBaseUrl({platform:'darwin',programRoot:pkg,env:{DSH_HOME:dshHome,SURFCORE_ROOT:source},command,probe:async (url) => { calls.push(url); return url.endsWith(':11111'); }});
   assert.equal(calls[0], 'http://127.0.0.1:11111');
   assert.equal(createVoicePacks({}, { programRoot:pkg }).packsDir(), path.join(source,'state','voice-packs'));
 } finally { delete process.env.SURFCORE_ROOT; }
});

test('package legacy collision fails closed before any consumer silently falls back', async () => {
 fs.mkdirSync(path.join(pkg, 'state'), { recursive:true }); fs.writeFileSync(path.join(pkg, 'state', 'legacy-fixture'), 'preserve');
 for (const fn of [() => loadSearchConfig(pkg), () => createVoicePacks({}, {programRoot:pkg}), () => createBillingService({stateDir:path.join(dshHome,'surfcore'),qqRoot:pkg,intervalMs:0})]) {
   assert.throws(fn, (error) => error.code === 'QQ_PACKAGE_LEGACY_DATA_FOUND' && Boolean(error.hint));
 }
 await assert.rejects(discoverDshBaseUrl({platform:'darwin',programRoot:pkg,env:{DSH_HOME:dshHome},command:() => '',probe:async () => false}), (error) => error.code === 'QQ_PACKAGE_LEGACY_DATA_FOUND' && Boolean(error.hint));
 assert.equal(fs.readFileSync(path.join(pkg,'state','legacy-fixture'),'utf8'), 'preserve');
});
