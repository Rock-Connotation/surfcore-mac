// Real Host routes over a loopback-only server. All state and installed code are fixture copies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseRoot = process.env.SURFCORE_TEST_HOST_SOURCE || ownRoot;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-persona-epoch-'));
const codeRoot = path.join(root, 'code');
fs.mkdirSync(path.join(codeRoot, 'plugins'), { recursive: true });
fs.cpSync(path.join(baseRoot, 'src'), path.join(codeRoot, 'src'), { recursive: true });
fs.cpSync(path.join(baseRoot, 'plugins', 'surfcore'), path.join(codeRoot, 'plugins', 'surfcore'), { recursive: true });
fs.copyFileSync(path.join(ownRoot, 'plugins', 'surfcore', 'lib', 'index.js'), path.join(codeRoot, 'plugins', 'surfcore', 'lib', 'index.js'));
fs.copyFileSync(path.join(baseRoot, 'package.json'), path.join(codeRoot, 'package.json'));
fs.writeFileSync(path.join(codeRoot, 'config.json'), '{}');
fs.symlinkSync(path.join(baseRoot, 'node_modules'), path.join(codeRoot, 'node_modules'), 'dir');
const dsh = path.join(root, 'dsh'); const state = path.join(dsh, 'surfcore');
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ platforms: { start: { qq: false, bili: false } } }));
process.env.DSH_HOME = dsh; process.env.USERPROFILE = root; process.env.SURFCORE_ROOT = codeRoot;
process.env.SURFCORE_SKIP_AUTOSTART = '1'; process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1'; process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';
const { apply } = await import(pathToFileURL(path.join(codeRoot, 'plugins', 'surfcore', 'lib', 'index.js')).href);
const routes = []; const effects = []; let api; let raceChunkSeen;
const server = http.createServer((req, res) => {
 if (req.headers['x-fixture-race']) req.once('data', () => raceChunkSeen?.());
 Promise.resolve(api.handler(req, res)).catch(() => { res.statusCode = 500; res.end('{}'); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.DSH_WEB_URL = base;
const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { if (name === 'connection') return { requestRejection: () => false }; if (name === 'webServer') return { port: server.address().port, protocol: 'http:' }; return null; },
  effect(fn) { effects.push(fn); return () => {}; }, sessionController: { inspect: async () => ({events: []}), create: async () => ({}), prompt: async () => ({accepted: true}) }, settings: null };
const call = async (body) => {
 const res = await fetch(`${base}/dsh-surfcore/api/persona`, body === undefined ? {} : { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) });
 return { status: res.status, data: await res.json() };
};
const charRoot = path.join(state, 'characters');
const rolePath = (id) => path.join(charRoot, id);
function createRole(id) {
 const dir = rolePath(id); fs.mkdirSync(path.join(dir, 'persona.scenes'), { recursive: true });
 fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ id, name: id, version: 1 }));
 for (const [file, value] of [['persona.md', `${id}-core-`.repeat(12)], ['persona.tone.md', `${id}-tone`], ['persona.daily.md', `${id}-daily`], ['persona.scenes/bili.md', `${id}-scene`]]) fs.writeFileSync(path.join(dir, file), value);
}
let clock = Date.now();
function select(id, epoch) {
 const temp = path.join(charRoot, 'current.fixture.tmp'); const target = path.join(charRoot, 'current.json');
 fs.writeFileSync(temp, JSON.stringify({ id, epoch, name: id })); fs.renameSync(temp, target);
 clock += 2000; fs.utimesSync(target, new Date(clock), new Date(clock));
}
const tracked = (id) => ['persona.md','persona.tone.md','persona.daily.md','persona.scenes/bili.md','character.json'].map((file) => fs.readFileSync(path.join(rolePath(id), file), 'utf8'));
const backups = () => fs.readdirSync(path.join(state, 'backups')).sort();
try {
 apply(ctx); api = routes.find((route) => route.path === '/dsh-surfcore/api'); assert.ok(api);
 let r = await call(); assert.equal(r.status, 200); assert.equal(r.data.character, null);
 createRole('alpha'); createRole('beta'); select('alpha', 1);
 r = await call(); assert.deepEqual(r.data.character, {id:'alpha',epoch:1}); assert.match(r.data.layers.core.text, /alpha-core/);
 r = await call({ expectedCharacter:{id:'alpha',epoch:1}, layer:'core', text:'updated alpha core '.repeat(5) }); assert.equal(r.status, 200);
 const backupDir = path.join(state, 'backups'); fs.mkdirSync(backupDir, { recursive: true }); fs.writeFileSync(path.join(backupDir, 'persona-tone-fixture.md'), 'restored fixture tone');
 select('beta', 2); r = await call(); assert.deepEqual(r.data.character, {id:'beta',epoch:2}); assert.match(r.data.layers.core.text, /beta-core/);
 const beforeA = tracked('alpha'), beforeB = tracked('beta'), beforeBackups = backups();
 const stale = {id:'alpha',epoch:1};
 for (const body of [
  {layer:'core',text:'stale core '.repeat(10)}, {layer:'tone',text:'stale tone'}, {layer:'daily',text:'stale daily'},
  {layer:'scene',scene:'bili',text:'stale scene'}, {action:'restore',name:'persona-tone-fixture.md'},
 ]) {
  r = await call({...body, expectedCharacter:stale}); assert.equal(r.status,409); assert.equal(r.data.code,'PERSONA_CHARACTER_STALE'); assert.ok(r.data.error && r.data.hint);
 }
 for (const expectedCharacter of [null, {}, {id:'beta'}, {id:'beta',epoch:'2'}, {id:'beta',epoch:0}]) {
  r = await call({expectedCharacter,layer:'tone',text:'invalid'}); assert.equal(r.status,409); assert.equal(r.data.code,'PERSONA_CHARACTER_STALE'); assert.ok(r.data.hint);
 }
 assert.deepEqual(tracked('alpha'),beforeA); assert.deepEqual(tracked('beta'),beforeB); assert.deepEqual(backups(),beforeBackups);
 select('beta', 3); r = await call({expectedCharacter:{id:'beta',epoch:2},layer:'tone',text:'old epoch'}); assert.equal(r.status,409); assert.equal(r.data.code,'PERSONA_CHARACTER_STALE'); assert.ok(r.data.hint);
 assert.deepEqual(tracked('beta'),beforeB); assert.deepEqual(backups(),beforeBackups);
 r = await call({expectedCharacter:{id:'beta',epoch:3},layer:'tone',text:'valid beta'}); assert.equal(r.status,200); assert.equal(fs.readFileSync(path.join(rolePath('beta'),'persona.tone.md'),'utf8'),'valid beta\n');
 r = await call({expectedCharacter:{id:'beta',epoch:3},action:'restore',name:'persona-tone-fixture.md'}); assert.equal(r.status,200); assert.equal(fs.readFileSync(path.join(rolePath('beta'),'persona.tone.md'),'utf8'),'restored fixture tone');
 const tone = path.join(rolePath('beta'),'persona.tone.md'); fs.renameSync(tone, `${tone}.saved`); fs.mkdirSync(tone);
 r = await call({expectedCharacter:{id:'beta',epoch:3},layer:'tone',text:'cannot write'}); assert.equal(r.status,500); assert.equal(r.data.code,'PERSONA_OPERATION_FAILED'); assert.ok(r.data.error && r.data.hint);
 fs.renameSync(tone, `${tone}.blocked`); fs.renameSync(`${tone}.saved`, tone);
 r = await call({layer:'daily',text:'legacy client'}); assert.equal(r.status,200); assert.equal(fs.readFileSync(path.join(rolePath('beta'),'persona.daily.md'),'utf8'),'legacy client\n');
 r = await call(); assert.deepEqual(r.data.character,{id:'beta',epoch:3});
 // Delay the end of the HTTP body until after the role changes: the guard must run after readBody.
 const raceBeforeA = tracked('alpha'), raceBeforeB = tracked('beta'), raceBackups = backups();
 let raceRequest; const firstChunk = new Promise((resolve) => { raceChunkSeen = resolve; });
 const delayed = new Promise((resolve, reject) => {
  const req = http.request(`${base}/dsh-surfcore/api/persona`, {method:'POST',headers:{'content-type':'application/json','x-fixture-race':'1'}}, (res) => {
   let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({status:res.statusCode,data:JSON.parse(text)}));
  });
  req.on('error',reject); raceRequest = req; req.write('{"expectedCharacter":{"id":"beta","epoch":3},');
 });
 await firstChunk; select('alpha',4); raceRequest.end('"layer":"tone","text":"late body"}');
 r = await delayed; assert.equal(r.status,409); assert.equal(r.data.code,'PERSONA_CHARACTER_STALE');
 assert.deepEqual(tracked('alpha'),raceBeforeA); assert.deepEqual(tracked('beta'),raceBeforeB); assert.deepEqual(backups(),raceBackups);
 fs.renameSync(path.join(charRoot,'current.json'),path.join(charRoot,'current.saved')); r = await call(); assert.equal(r.data.character,null);
 r = await call({layer:'core',text:'legacy without role '.repeat(5)}); assert.equal(r.status,200); assert.deepEqual(tracked('alpha'),raceBeforeA); assert.deepEqual(tracked('beta'),raceBeforeB);
 console.log('PASS persona Host HTTP: captured identity, stale/malformed rejection before writes, all layers and restore, epoch and legacy');
} finally {
 await new Promise((resolve) => server.close(resolve));
 for (const fn of effects) { try { const dispose = fn(); if (typeof dispose === 'function') dispose(); } catch {} }
}
