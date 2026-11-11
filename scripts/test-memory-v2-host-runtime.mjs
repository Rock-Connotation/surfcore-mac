import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const resources = '/Applications/DeepSeek Harness.app/Contents/Resources';
const executable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const installedRuntime = path.join(resources, 'app.asar', 'dsh');
const hostEntry = path.join(installedRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_backups/memory-v2-host-runtime');
fs.mkdirSync(root, { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'run-'));
const dirs = Object.fromEntries(['home', 'runtime', 'project', 'source', 'tmp', 'cache', 'config', 'agents'].map(name => [name, path.join(fixture, name)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
const dshHome = path.join(dirs.home, '.dsh');
fs.mkdirSync(dshHome);
fs.symlinkSync(path.join(resources, 'app.asar'), path.join(dirs.runtime, 'app.asar'));
fs.symlinkSync(path.join(resources, 'app.asar.unpacked'), path.join(dirs.runtime, 'app.asar.unpacked'), 'dir');
const runtimeDir = path.join(dirs.runtime, 'app.asar', 'dsh');
function create(name, content) {
  fs.writeFileSync(path.join(fixture, name), content, { flag: 'wx' });
}

create('guard.mjs', `
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
globalThis.memoryGateDenied = [];
const deny = kind => (...args) => {
  globalThis.memoryGateDenied.push(kind);
  throw Object.assign(new Error('isolated Host gate denied ' + kind), {code:'MEMORY_GATE_IO_DENIED'});
};
net.Socket.prototype.connect = deny('tcp');
tls.connect = deny('tls');
dgram.createSocket = deny('udp');
for (const mod of [http, https]) {
  mod.request = deny('http-request');
  mod.get = deny('http-get');
}
globalThis.memoryGateLoopbackLookups = 0;
dns.lookup = (host, options, callback) => {
  if (host !== '127.0.0.1') return deny('dns')();
  globalThis.memoryGateLoopbackLookups++;
  const cb = typeof options === 'function' ? options : callback;
  process.nextTick(() => options?.all ? cb(null,[{address:'127.0.0.1',family:4}]) : cb(null,'127.0.0.1',4));
};
for (const key of ['resolve','resolve4','resolve6','reverse']) dns[key] = deny('dns');
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[key] = deny('child-process');
globalThis.fetch = async () => deny('fetch')();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const first = args[0];
  const port = typeof first === 'object' ? first.port : first;
  const host = typeof first === 'object' ? first.host : args[1];
  if (port !== 0 || host !== '127.0.0.1') return deny('non-ephemeral-listener')();
  return listen.apply(this, args);
};
syncBuiltinESMExports();
`);

create('project/package.json', JSON.stringify({ name: 'memory-v2-host-gate', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2));
const rows = [
  { id: 'gate-webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0, compression: 'none' } },
  { id: 'gate-credentials', name: '@deepseek-ai/dsh-credentials-local', config: { watch: false } },
  { id: 'gate-connection', name: '@deepseek-ai/dsh-client-connection', config: {} },
  { id: 'memory-runtime-probe', name: './probe.mjs', config: { fixture, project: dirs.project, dshHome } },
];
create('project/cordis.patch.yml', JSON.stringify([{ insert: rows }], null, 2));
create('project/probe.mjs', `
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
const hostPackage = JSON.parse(readFileSync(${JSON.stringify(path.join(installedRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/package.json'))},'utf8'));
export const name = 'memory-runtime-probe';
export const inject = ['webServer','connection'];
export async function apply(ctx, config) {
  const profile = ctx.get('profileContext');
  assert.equal(profile.dir, config.project);
  assert.equal(profile.home, config.dshHome);
  assert.equal(typeof ctx.effect, 'function');
  assert.equal(typeof ctx.loader.entries, 'function');
  assert.ok([...ctx.loader.entries()].some(entry => entry.options.id === 'memory-runtime-probe'));
  const sqlite = await import('node:sqlite');
  assert.equal(typeof sqlite.DatabaseSync, 'function');
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { fixture: config.fixture } });
  let result;
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Host plugin worker timeout')); }, 10000);
    worker.once('message', message => { result = message; });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timer);
      try { assert.equal(code,0); assert.equal(result?.ok,true); resolve(); } catch(error) { reject(error); }
    });
  });
  assert.deepEqual(globalThis.memoryGateDenied, []);
  process.send?.({ type:'memory-runtime-probe', ok:true, pid:process.pid, node:process.version,
    execPath:process.execPath, execArgv:process.execArgv, platform:process.platform, arch:process.arch,
    profile:{dir:profile.dir,home:profile.home,cwd:profile.cwd},
    hostPackage:{name:hostPackage.name,version:hostPackage.version}, loopbackLookups:globalThis.memoryGateLoopbackLookups,
    loaderAck:{id:'memory-runtime-probe',registered:true,applyContext:true}, worker:result, denied:globalThis.memoryGateDenied });
}
`);
create('project/worker.mjs', `
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
const filename = path.join(workerData.fixture, 'worker-memory.sqlite');
const open = () => {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;');
  const settings = Object.fromEntries(['journal_mode','synchronous','foreign_keys'].map(key => [key,Object.values(db.prepare('PRAGMA '+key).get())[0]]));
  assert.deepEqual(settings,{journal_mode:'delete',synchronous:3,foreign_keys:1});
  return db;
};
let db = open();
db.exec('CREATE TABLE events(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE receipts(id TEXT PRIMARY KEY,event_id TEXT REFERENCES events(id));');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO events VALUES(?,?)').run('committed','Host 插件 worker 提交');
db.prepare('INSERT INTO receipts VALUES(?,?)').run('receipt','committed');
db.exec('COMMIT');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO events VALUES(?,?)').run('rolled-back','absent');
db.exec('ROLLBACK');
assert.equal(db.prepare('SELECT count(*) n FROM events WHERE id=?').get('rolled-back').n,0);
db.close();
db = open();
assert.equal(db.prepare('SELECT body FROM events WHERE id=?').get('committed').body,'Host 插件 worker 提交');
assert.equal(db.prepare('SELECT event_id FROM receipts WHERE id=?').get('receipt').event_id,'committed');
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
const sqlite = db.prepare('SELECT sqlite_version() version').get().version;
db.close();
assert.deepEqual(globalThis.memoryGateDenied, []);
parentPort.postMessage({ok:true, node:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch,sqlite,
  checks:['worker-ready','DELETE/EXTRA/foreign_keys','commit','rollback','close-reopen-readback','integrity','foreign-key-check'],denied:globalThis.memoryGateDenied});
parentPort.close();
`);

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: dirs.home, USERPROFILE: dirs.home,
  DSH_HOME: dshHome, DSH_AGENTS_HOME: dirs.agents, TMPDIR: dirs.tmp,
  XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config,
  ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: executable,
  DSH_TELEMETRY_DISABLED: '1', LANG: 'en_US.UTF-8',
};
const args = ['--expose-internals', '--import', path.join(fixture, 'guard.mjs'), hostEntry, runtimeDir, dirs.project, dirs.source];
const record = { ok: false, fixture, command: { executable, args, cwd: dirs.project }, environment: env, messages: [] };
let child;
let exited;
let exitResult;
let output = '';
function boundedLog(chunk) {
  output = (output + chunk.toString()).slice(-16000).replace(/([?&]token=)[^\s"']+/g, '$1[REDACTED]');
}
async function ownShutdown() {
  if (!child || exitResult) return;
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  if (child.connected) child.send({ type: 'shutdown' }, () => {});
  let timer;
  const done = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 7000); })]);
  clearTimeout(timer);
  if (!done) {
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!stopped) child.kill('SIGKILL');
    await exited;
  }
}
try {
  child = spawn(executable, args, { cwd: dirs.project, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
    child.once('error', error => { exitResult = { error: error.message }; resolve(exitResult); });
  });
  child.stdout.on('data', boundedLog);
  child.stderr.on('data', boundedLog);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged Desktop Host readiness timeout')), 25000);
    let ready = false;
    let probe = false;
    const fail = error => { clearTimeout(timer); reject(error); };
    child.on('message', message => {
      try {
        if (message.type === 'fatal') throw new Error(String(message.diagnostic || message.message));
        if (message.type === 'ready') {
          const url = new URL(message.url);
          assert.equal(url.hostname, '127.0.0.1');
          assert.ok(Number(url.port) > 0 && ![3100, 59783].includes(Number(url.port)));
          record.messages.push({ type: 'ready', protocol: url.protocol, host: url.hostname, port: Number(url.port), authenticated: url.search.length > 0 });
          ready = true;
        } else if (message.type === 'memory-runtime-probe') {
          assert.equal(message.pid, child.pid);
          assert.equal(message.execPath, executable);
          assert.equal(message.ok, true);
          assert.equal(message.worker.ok, true);
          record.probe = message;
          probe = true;
        } else if (['starting', 'shutdown-complete'].includes(message.type)) record.messages.push({ type: message.type });
        if (ready && probe) { clearTimeout(timer); resolve(); }
      } catch (error) { fail(error); }
    });
    exited.then(() => { if (!ready || !probe) fail(new Error('packaged Desktop Host exited before ready/probe acknowledgments')); });
  });
  await ownShutdown();
  assert.deepEqual(exitResult, { code: 0, signal: null });
  assert.ok(record.messages.some(message => message.type === 'shutdown-complete'));
  record.ok = true;
} catch (error) {
  record.code = 'MEMORY_HOST_GATE_FAILED';
  record.error = error.message;
  record.hint = 'Retain V1; inspect this isolated fixture evidence before retrying the Host gate.';
  process.exitCode = 1;
} finally {
  await ownShutdown();
  record.exit = exitResult;
  record.log = output;
  fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(record, null, 2));
}
