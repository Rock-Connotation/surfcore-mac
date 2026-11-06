import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-channel-fixture-'));
process.env.DSH_HOME = home;
const { PlatformRegistry } = await import('../lib/platforms.js');
const chars = await import('../../../src/character-persona.js');
const { appendExperienceEvent, readExperienceInbox } = await import('../../../src/core/experience.js');
const { createEmptyCard, ingestExperienceEvents, saveMemoryCardOutputs } = await import('../../../src/memory-card.js');
const { buildCharacterContext } = await import('../../../src/core/context.js');
const alpha = chars.characterPaths('alpha');
const beta = chars.characterPaths('beta');
fs.mkdirSync(alpha.memoryDir, { recursive: true });
fs.mkdirSync(beta.memoryDir, { recursive: true });
fs.writeFileSync(alpha.persona, '# Alpha');
fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: 1 }));
const ctx = Object.freeze({ characterId: 'alpha', characterEpoch: 1, activityId: 'activity:1' });
const event = (context) => ({ schemaVersion: 1, eventId: 'local:fixture1', ...context,
  occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(),
  source: { channel: 'local', objectId: 'fixture' }, kind: 'content_observed',
  visibility: { classification: 'restricted', allowedContexts: ['local'] },
  content: { summary: '隔离素材的本地观察' }, attribution: { subject: 'external', certainty: 'observed' } });

test('local adapter preserves captured role and projects a restricted event into the allowed view', async () => {
 const registry = new PlatformRegistry();
 let observed;
 const dispose = registry.register({ id: 'local', name: '本地', channelStatus: async () => ({ state: 'ready' }),
   observe: async (request, activity) => {
     observed = activity; await Promise.resolve();
     return appendExperienceEvent(chars.characterPaths(activity.characterId), event(activity));
   } });
 const pending = registry.observe('local', {}, ctx);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'beta', epoch: 2 }));
 const result = await pending; assert.equal(result.ok, true); assert.deepEqual(observed, ctx);
 assert.equal(readExperienceInbox(alpha).events.length, 1); assert.equal(readExperienceInbox(beta).events.length, 0);
 const card = createEmptyCard(); const projection = ingestExperienceEvents(card, readExperienceInbox(alpha).events); assert.equal(projection.added, 1);
 const paths = { dir: alpha.memoryDir, json: alpha.memoryJson, markdown: alpha.memoryMd, promptQq: alpha.memoryPromptQq, promptBili: alpha.memoryPromptBili };
 saveMemoryCardOutputs(paths, card);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: 1 }));
 assert.match(buildCharacterContext({ audience: { channel: 'local' } }).text, /隔离素材的本地观察/);
 assert.doesNotMatch(buildCharacterContext({ audience: { channel: 'bili' } }).text, /隔离素材的本地观察/);
 dispose(); registry.dispose();
});

test('status separates implementation and readiness; unavailable and unknown never invoke handlers', async () => {
 const registry = new PlatformRegistry(); let count = 0; let state = 'needs_auth';
 const dispose = registry.setRuntime('bili', { status: async () => ({ state }), observe: async () => { count++; return { ok: true }; } });
 assert.equal(typeof dispose, 'function');
 const caps = await registry.channelCapabilities('bili'); assert.equal(caps.implemented.observe, true); assert.equal(caps.available.observe, false); assert.equal(caps.state, 'needs_auth');
 const denied = await registry.observe('bili', {}, ctx); assert.equal(denied.code, 'CHANNEL_NEEDS_AUTH'); assert.ok(denied.error && denied.hint); assert.equal(count, 0);
 state = 'disabled'; assert.equal((await registry.observe('bili', {}, ctx)).code, 'CHANNEL_DISABLED');
 const unknown = await registry.observe('unknown', {}, ctx); assert.equal(unknown.code, 'CHANNEL_UNKNOWN'); assert.ok(unknown.error && unknown.hint);
 state = 'ready'; const invalid = await registry.observe('bili', {}, { ...ctx, characterEpoch: 0 }); assert.equal(invalid.code, 'CHANNEL_ACTIVITY_INVALID'); assert.ok(invalid.hint);
 assert.equal((await registry.prepareMedia('bili', {}, ctx)).code, 'CHANNEL_UNSUPPORTED');
 assert.equal((await registry.observe('bili', {}, ctx)).ok, true); assert.equal(count, 1);
 dispose(); registry.dispose();
});

test('degraded requires explicit availability, legacy actions are never executed, and errors are actionable', async () => {
 const registry = new PlatformRegistry(); let actions = 0;
 registry.register({ id: 'example', actions: { send: () => { actions++; } },
   channelStatus: async () => ({ state: 'degraded', available: { observe: true } }),
   observe: async () => ({ ok: true }), prepareMedia: async () => ({ ok: true }) });
 const caps = await registry.channelCapabilities('example'); assert.equal(caps.available.observe, true); assert.equal(caps.available.prepareMedia, false);
 assert.equal((await registry.observe('example', {}, ctx)).ok, true);
 assert.equal((await registry.prepareMedia('example', {}, ctx)).code, 'CHANNEL_DEGRADED');
 const result = await registry.execute('example', { action: 'send' }, ctx); assert.equal(result.code, 'CHANNEL_UNSUPPORTED'); assert.ok(result.hint); assert.equal(actions, 0);
 registry.dispose();
});

test('runtime lifecycle and legacy extension registration preserve ownership', async () => {
 const registry = new PlatformRegistry(); let disposed = 0;
 const detach = registry.setRuntime('bili', { status: async () => ({ state: 'ready' }), observe: async () => ({ ok: true }), dispose: () => { disposed++; } });
 assert.equal(registry.list().find((item) => item.id === 'bili').status, 'active');
 assert.equal((await registry.statusAll()).find((item) => item.id === 'bili').status, 'active');
 assert.equal(registry.require('bili').id, 'bili');
 assert.equal(registry.setRuntime('bili', { observe: () => ({ ok: true }) }).code, 'CHANNEL_RUNTIME_EXISTS');
 detach(); detach(); assert.equal(disposed, 1);
 let firstDisposed = 0; let secondDisposed = 0;
 const first = registry.register({ id: 'other', dispose: () => { firstDisposed++; } });
 const second = registry.register({ id: 'other', dispose: () => { secondDisposed++; } });
 first(); assert.equal(registry.get('other').id, 'other'); second(); assert.equal(registry.get('other'), null);
 registry.dispose(); assert.equal(firstDisposed, 1); assert.equal(secondDisposed, 1); assert.equal(disposed, 1);
});

test('status throws or instance is disposed while status is pending: operation fails closed', async () => {
 const registry = new PlatformRegistry(); let release; let invoked = 0;
 const detach = registry.setRuntime('bili', { status: () => new Promise((resolve) => { release = resolve; }), observe: () => { invoked++; return { ok: true }; } });
 const pending = registry.observe('bili', {}, ctx); detach(); release({ state: 'ready' });
 const result = await pending; assert.equal(result.code, 'CHANNEL_RUNTIME_CHANGED'); assert.equal(invoked, 0); assert.ok(result.error && result.hint);
 const second = registry.setRuntime('bili', { status: () => { throw new Error('fixture'); }, observe: () => ({ ok: true }) });
 const failed = await registry.observe('bili', {}, ctx); assert.equal(failed.code, 'CHANNEL_ERROR'); assert.ok(failed.hint); second(); registry.dispose();
});

test('explicit execute delegates to channel gate and needs_setup rejects access', async () => {
 const registry = new PlatformRegistry(); let gateCalls = 0;
 const detach = registry.setRuntime('bili', {
   status: async () => ({ state: 'ready' }),
   execute: async (_request, captured) => { gateCalls++; assert.deepEqual(captured, ctx); return { ok: false, code: 'ACTION_DENIED', error: '当前不允许发送。', hint: '检查原渠道配置。' }; },
 });
 const denied = await registry.execute('bili', { action: 'send' }, ctx);
 assert.equal(denied.code, 'ACTION_DENIED'); assert.equal(gateCalls, 1); assert.ok(denied.hint);
 const bypass = await registry.invokeChannel('bili', 'toString', {}, ctx); assert.equal(bypass.code, 'CHANNEL_UNSUPPORTED');
 detach();
 const noStatus = registry.setRuntime('bili', { observe: () => ({ ok: true }) });
 const caps = await registry.channelCapabilities('bili'); assert.equal(caps.state, 'needs_setup'); assert.equal(caps.implemented.observe, true); assert.equal(caps.available.observe, false);
 assert.equal((await registry.observe('bili', {}, ctx)).code, 'CHANNEL_NEEDS_SETUP'); noStatus(); registry.dispose();
});

test('async disposal is awaited and remains scoped to its registry', async () => {
 const one = new PlatformRegistry(); const two = new PlatformRegistry(); let release; let secondDisposed = false;
 const first = one.setRuntime('bili', { status: async () => ({ state: 'ready' }), observe: () => ({ ok: true }), dispose: () => new Promise((resolve) => { release = resolve; }) });
 const second = two.setRuntime('bili', { status: async () => ({ state: 'ready' }), observe: () => ({ ok: true }), dispose: () => { secondDisposed = true; } });
 let done = false; const pending = first().then(() => { done = true; });
 const duplicate = first(); await Promise.resolve(); assert.equal(done, false); assert.equal(secondDisposed, false);
 assert.equal((await two.observe('bili', {}, ctx)).ok, true); release(); await pending; await duplicate; assert.equal(done, true);
 await second(); await one.dispose(); await two.dispose(); assert.equal(secondDisposed, true);
});

test('legacy extension registration, status probe and disposer retain their interface', async () => {
 const { ExtensionHost } = await import('../lib/extensions.js');
 const registry = new PlatformRegistry(); const host = new ExtensionHost({ platforms: registry });
 const disposers = []; const api = host.createApi({ id: 'fixture-extension' }, disposers, []); let cleaned = 0;
 api.registerPlatform({ id: 'extension', name: 'Extension', capabilities: ['identity', 'actions'], status: async () => ({ connected: true }), dispose: () => { cleaned++; } });
 const entry = (await registry.statusAll()).find((item) => item.id === 'extension');
 assert.equal(entry.status, 'active'); assert.deepEqual(entry.capabilities, ['identity', 'actions']); assert.deepEqual(entry.runtime, { connected: true });
 assert.equal(registry.list().find((item) => item.id === 'extension').owner, 'extension:fixture-extension');
 disposers[0](); assert.equal(registry.get('extension'), null); assert.equal(cleaned, 1); await registry.dispose(); assert.equal(cleaned, 1);
});
