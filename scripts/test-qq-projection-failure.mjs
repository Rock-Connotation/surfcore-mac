import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-projection-'));
const qq = path.join(root, 'qq'), dsh = path.join(root, 'dsh');
fs.mkdirSync(path.join(qq, 'src'), { recursive: true }); fs.writeFileSync(path.join(qq, 'src', 'bridge.js'), '');
fs.mkdirSync(path.join(qq, 'state', 'volc-voice-budget.lock'), { recursive: true });
fs.writeFileSync(path.join(qq, 'config.json'), JSON.stringify({ ownerQQ: '12345' }));
fs.mkdirSync(path.join(dsh, 'surfcore'), { recursive: true });
fs.writeFileSync(path.join(dsh, 'surfcore', 'config.json'), JSON.stringify({ admin: { qq: '12345', displayName: 'fixture' }, platforms: { start: { qq: false, bili: false } } }));
process.env.SURFCORE_ROOT = qq; process.env.DSH_HOME = dsh; process.env.USERPROFILE = dsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1'; process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1'; process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';
const connect = net.connect, fetchImpl = globalThis.fetch;
net.connect = () => { const socket = new EventEmitter(); socket.setTimeout = () => socket; socket.destroy = () => socket; queueMicrotask(() => socket.emit('error', new Error('offline fixture'))); return socket; };
globalThis.fetch = async () => { throw new Error('offline fixture'); };

test('启动时管理员投影锁冲突在概览可见', async () => {
  const { apply } = await import('../plugins/surfcore/lib/index.js');
  const routes = [], effects = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } }, get: () => null,
    effect(fn) { effects.push(fn); return () => {}; }, sessionController: { inspect: async () => ({ events: [] }), create: async () => ({}), prompt: async () => ({ accepted: true }) }, settings: null };
  try {
    apply(ctx);
    const route = routes.find(value => value.path === '/dsh-surfcore/api'); assert(route);
    const req = new EventEmitter(); req.method = 'GET'; req.url = '/dsh-surfcore/api/overview'; req.headers = { host: '127.0.0.1' };
    const res = { statusCode: 200, body: '', writeHead(code) { this.statusCode = code; }, end(body = '') { this.body += body; } };
    await route.handler(req, res);
    const data = JSON.parse(res.body);
    assert.equal(data.adminProjectionFailure.code, 'VOICE_VOLC_BUDGET_BUSY'); assert.ok(data.adminProjectionFailure.error && data.adminProjectionFailure.hint);
    const ui = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
    assert(ui.includes('overview?.adminProjectionFailure'));
  } finally {
    for (const fn of effects) { try { const dispose = fn(); if (typeof dispose === 'function') dispose(); } catch {} }
    net.connect = connect; globalThis.fetch = fetchImpl;
  }
});
