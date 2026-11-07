import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-repair-host-'));
const root = path.join(home, 'program');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), '{}');
fs.writeFileSync(path.join(root, 'src', 'bridge.js'), '// fixture; never executed\n');
fs.writeFileSync(path.join(root, 'scripts', 'setup-dsh.mjs'), '// fixture; never executed\n');
const dsh = path.join(home, 'dsh');
fs.mkdirSync(path.join(dsh, 'surfcore'), { recursive: true });
fs.writeFileSync(path.join(dsh, 'surfcore', 'config.json'), JSON.stringify({ platforms: { start: { qq: false, bili: false } } }));
const profile = path.join(dsh, 'profiles', 'fixture'); fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['surfcore'] } } }));
Object.assign(process.env, { DSH_HOME: dsh, HOME: home, USERPROFILE: home, SURFCORE_ROOT: root, DSH_PROFILE: 'fixture', SURFCORE_SKIP_AUTOSTART: '1', SURFCORE_DISABLE_CHARACTER_MIGRATION: '1', SURFCORE_DISABLE_MEMORY_TIMER: '1' });
const original = childProcess.execFile; const calls = []; let failExec = false;
childProcess.execFile = (command, args, options, callback) => { calls.push({ command, args, options }); queueMicrotask(() => callback(failExec ? new Error('fixture failure') : null, failExec ? '' : 'fixture success', failExec ? 'DSH_REPAIR_PATCH_UNSAFE: fixture\n下一步：检查托管区块' : '')); return new EventEmitter(); };
syncBuiltinESMExports();
const { apply } = await import('../lib/index.js');
const routes = [], effects = [];
const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } }, get(name) { return name === 'connection' ? { requestRejection: () => false } : null; }, effect(fn) { effects.push(fn); return () => {}; }, sessionController: { inspect: async () => ({ events: [] }), create: async () => ({}), prompt: async () => ({ accepted: true }) }, settings: null };
async function invoke(api, body = {}) {
  const req = new EventEmitter(); req.method = 'POST'; req.url = '/dsh-surfcore/api/dsh/repair'; req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };
  const res = { statusCode: 200, body: '', writeHead(code) { this.statusCode = code; }, end(chunk = '') { this.body += chunk; } };
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  await api.handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}
try {
  apply(ctx); const api = routes.find((r) => r.path === '/dsh-surfcore/api'); assert.ok(api);
  let result = await invoke(api); assert.equal(result.status, 200); result = result.data; assert.equal(result.ok, true);
  assert.equal(result.profile, 'fixture'); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, root); assert.ok(calls[0].args.includes(path.join(root, 'scripts', 'setup-dsh.mjs')));
  assert.ok(calls[0].args.includes('fixture')); assert.equal(calls[0].options.env.DSH_HOME, dsh);
  let r = await invoke(api, { profile: '../escape' }); assert.equal(r.data.code, 'DSH_REPAIR_PROFILE'); assert.ok(r.data.hint); assert.equal(calls.length, 1);
  delete process.env.DSH_PROFILE; r = await invoke(api); assert.equal(r.status, 200); assert.equal(r.data.profile, 'fixture'); assert.equal(calls.length, 2);
  const second = path.join(dsh, 'profiles', 'second'); fs.mkdirSync(second); fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['surfcore'] } } }));
  r = await invoke(api); assert.equal(r.status, 409); assert.equal(r.data.code, 'DSH_REPAIR_PROFILE_AMBIGUOUS'); assert.ok(r.data.hint); assert.equal(calls.length, 2);
  r = await invoke(api, { profile: 'fixture' }); assert.equal(r.status, 200); assert.equal(calls.length, 3);
  process.env.DSH_PROFILE = 'second'; r = await invoke(api, { profile: 'fixture' }); assert.equal(r.data.code, 'DSH_REPAIR_PROFILE_MISMATCH'); assert.ok(r.data.hint); assert.equal(calls.length, 3);
  process.env.DSH_PROFILE = 'fixture'; failExec = true; r = await invoke(api); assert.equal(r.status, 500); assert.equal(r.data.code, 'DSH_REPAIR_PATCH_UNSAFE'); assert.ok(r.data.error); assert.equal(r.data.hint, '检查托管区块');
  console.log('PASS Host repair uses captured installation root and current profile');
} finally { childProcess.execFile = original; syncBuiltinESMExports(); for (const dispose of effects.reverse()) await dispose?.(); }
