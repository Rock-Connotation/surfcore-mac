import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bili-index-'));
process.env.DSH_HOME = path.join(root, 'dsh');
process.env.SURFCORE_ROOT = path.join(root, 'repo');
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';
fs.mkdirSync(path.join(process.env.SURFCORE_ROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(process.env.SURFCORE_ROOT, 'src', 'bridge.js'), '// fixture only\n');
fs.writeFileSync(path.join(process.env.SURFCORE_ROOT, 'config.json'), '{}');
fs.mkdirSync(path.join(process.env.DSH_HOME, 'surfcore'), { recursive: true });
fs.writeFileSync(path.join(process.env.DSH_HOME, 'surfcore', 'config.json'), JSON.stringify({ version: 1, platforms: { start: { qq: false, bili: true } } }));
const { createCharacter, switchCharacter, readCurrentCharacter } = await import('../../../src/character-persona.js');
createCharacter({ id: 'fixture', name: 'Fixture', personaText: 'Fixture core only.' });
switchCharacter('fixture');
assert.equal(readCurrentCharacter().id, 'fixture');
const { apply } = await import('../lib/index.js');
const originalFetch = globalThis.fetch, external = [], routes = [], effects = [];
let providerCalls = 0;
globalThis.fetch = async url => { external.push(String(url)); throw new Error('Network forbidden'); };
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  effect(fn) { effects.push(fn); return () => {}; },
  get(key) {
    if (key === 'webServer') return { port: 58750, protocol: 'http:' };
    if (key === 'connection') return { requestRejection: () => false };
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }) };
    if (key === 'llm') return { resolveModelInfo: async () => { throw new Error('PRIVATE_PROVIDER_SECRET'); }, stream: () => { providerCalls++; throw new Error('Provider dispatch forbidden'); } };
    return null;
  },
  sessionController: { inspect: async () => ({ events: [] }), create: async () => ({}), prompt: async () => { throw new Error('Session prompts forbidden'); } }, settings: null,
};
async function get(url) {
  const req = new EventEmitter(); req.method = 'GET'; req.url = url; req.headers = { host: '127.0.0.1:58750' }; req.socket = { remoteAddress: '127.0.0.1' };
  const res = { statusCode: 200, body: '', writeHead(code) { this.statusCode = code; }, end(body = '') { this.body += body; } };
  await routes.find(route => route.path === '/dsh-surfcore/api').handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
try {
  apply(ctx);
  const status = await get('/dsh-surfcore/api/memory-v2/status');
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const gates = await get('/dsh-surfcore/api/gate-events?includeAcked=true');
  assert.equal(gates.status, 200);
  const event = gates.body.events.find(item => item.gate === 'memory-v2' && item.reason?.code === 'BILI_V2_ROUTE_UNPROVEN');
  assert.ok(event, JSON.stringify(gates.body)); assert.equal(event.level, 'L2'); assert.ok(event.reason.message && event.recommendation); assert.ok(event.recommendation.includes('模型'));
  assert.ok(!JSON.stringify(gates).includes('PRIVATE_PROVIDER_SECRET')); assert.deepEqual(external, []); assert.equal(providerCalls, 0);
  console.log('PASS actual index Runtime Bili callback publishes sanitized actionable L2 failure to the existing notification endpoint; zero network/provider calls');
} finally {
  for (const effect of effects.reverse()) { const cleanup = effect(); if (typeof cleanup === 'function') await cleanup(); }
  globalThis.fetch = originalFetch;
}
