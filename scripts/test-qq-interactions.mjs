import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { NodeApiClient } from '../src/dsh-client.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
let failures = 0;
async function test(name, fn) {
  const h = await bridgeHarness({ config: { interaction: { requireRequestId: true } } });
  try { await fn(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
function eventStream(h) {
  const queue = []; let wake;
  h.api.events.mux = () => ({ async *[Symbol.asyncIterator]() {
    while (true) {
      if (!queue.length) await new Promise((resolve) => { wake = resolve; });
      while (queue.length) yield queue.shift();
    }
  } });
  h.pumpMux();
  return (payload) => { queue.push({ rpcId: payload.eventId, payload }); wake?.(); wake = null; };
}
await test('notification is registered before transport completes', async (h) => {
  h.cfg.sendDelayMs = 0; const sessionId = await h.ensureSession('private:123');
  let started, release, responses = 0;
  h.api.respond = async () => { responses++; return { result: { ok: true } }; };
  h.bot.sendPrivateMessage = async () => { if (!started) { started = true; await new Promise((resolve) => { release = resolve; }); } };
  const emit = eventStream(h);
  emit({ type: 'approval/requested', sessionId, clientId: 'client', eventId: 'event-one', toolName: 'safe-test' });
  for (let i = 0; i < 30 && !started; i++) await tick();
  try {
    assert.ok(started); const entry = h.pending.get('private:123'); assert.equal(entry?.eventId, 'event-one');
    const incoming = h.handleIncoming('private', '123', { user_id: 123, self_id: 1, message_id: 1, sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: `通过 ${entry.requestId}` } }] }, h.cfg);
    for (let i = 0; i < 50 && !responses; i++) await tick();
    assert.equal(responses, 1, 'fast reply is consumed before notification returns');
    release(); await incoming;
  }
  finally { release?.(); }
});
await test('duplicate event never cancels its own pending request', async (h) => {
  let responses = 0; h.api.respond = async () => { responses++; return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'same', sessionId: 'session' });
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'same', sessionId: 'session' });
  await tick();
  assert.equal(responses, 0); assert.equal(h.pending.get('private:123')?.eventId, 'same');
});
await test('stale and bare approvals cannot decide a newer request', async (h) => {
  h.cfg.sendDelayMs = 0; const replies = [];
  h.api.respond = async (value) => { replies.push(value); return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'old', sessionId: 'session' });
  const oldCode = h.pending.get('private:123').requestId;
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'new', sessionId: 'session' });
  await tick(); const entry = h.pending.get('private:123'); const before = replies.length;
  await h.handlePendingAnswer(entry, '通过', 'private:123', true);
  await h.handlePendingAnswer(entry, `通过 ${oldCode}`, 'private:123', true);
  assert.equal(replies.length, before);
  await h.handlePendingAnswer(entry, `通过 ${entry.requestId}`, 'private:123', true);
  assert.equal(replies.length, before + 1); assert.equal(replies.at(-1).outcome.value, 'allowed-once');
});
await test('concurrent answers submit only once', async (h) => {
  h.cfg.sendDelayMs = 0; let calls = 0, release;
  h.api.respond = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'concurrent', sessionId: 'session' });
  const entry = h.pending.get('private:123');
  const first = h.handlePendingAnswer(entry, `拒绝 ${entry.requestId}`, 'private:123', true);
  await tick(); await h.handlePendingAnswer(entry, `通过 ${entry.requestId}`, 'private:123', true);
  assert.equal(calls, 1); release({ result: { ok: true } }); await first;
  assert.equal(h.pending.has('private:123'), false);
});
await test('questions require the current ID and retain answer provenance', async (h) => {
  h.cfg.sendDelayMs = 0; const replies = [];
  h.api.respond = async (value) => { replies.push(value); return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'question', clientId: 'client', eventId: 'ask', questions: [{ id: 'q', header: '[仅主人]', options: [{ label: 'A' }] }] });
  const entry = h.pending.get('private:123');
  await h.handlePendingAnswer(entry, `${entry.requestId} A`, 'private:123', false);
  assert.equal(replies.length, 0);
  await h.handlePendingAnswer(entry, 'A', 'private:123', true);
  assert.equal(replies.length, 0);
  await h.handlePendingAnswer(entry, `${entry.requestId} A`, 'private:123', true);
  assert.equal(replies.length, 1); assert.match(replies[0].outcome.value.answers[0].custom, /回答者：主人/);
});
await test('non-owner group message cannot consume approval', async (h) => {
  h.setMode('chat'); h.cfg.sendDelayMs = 0; let replies = 0;
  h.api.respond = async () => { replies++; return { result: { ok: true } }; };
  await h.registerPending('group:456', { kind: 'approval', clientId: 'client', eventId: 'unauthorized' });
  const entry = h.pending.get('group:456');
  await h.handleIncoming('group', '456', { user_id: 777, self_id: 1, group_id: 456, message_id: 1, sender: { nickname: 'fixture' }, message: [{ type: 'text', data: { text: `通过 ${entry.requestId}` } }] }, h.cfg);
  assert.equal(replies, 0); assert.equal(h.pending.get('group:456'), entry);
});
await test('explicit refusal can retry; transport uncertainty cannot', async (h) => {
  h.cfg.sendDelayMs = 0; let calls = 0;
  h.api.respond = async () => { calls++; if (calls === 1) return { result: { ok: false, error: { code: 'fixture' } } }; return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'retry', sessionId: 'session' });
  let entry = h.pending.get('private:123');
  await h.handlePendingAnswer(entry, `通过 ${entry.requestId}`, 'private:123', true);
  assert.equal(h.pending.get('private:123'), entry);
  await h.handlePendingAnswer(entry, `通过 ${entry.requestId}`, 'private:123', true);
  assert.equal(calls, 2); assert.equal(h.pending.has('private:123'), false);
  h.api.respond = async () => { calls++; throw new Error('transport unknown'); };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'unknown', sessionId: 'session' });
  entry = h.pending.get('private:123'); await h.handlePendingAnswer(entry, `通过 ${entry.requestId}`, 'private:123', true);
  assert.equal(h.pending.has('private:123'), false); assert.equal(calls, 3);
});
await test('wire cancel clears only matching request and duplicate is not notified', async (h) => {
  h.cfg.sendDelayMs = 0; const sessionId = await h.ensureSession('private:123');
  const emit = eventStream(h); const frame = { type: 'approval/requested', sessionId, clientId: 'client', eventId: 'event-cancel', toolName: 'safe-test' };
  emit(frame); for (let i = 0; i < 50 && !h.pending.has('private:123'); i++) await tick();
  assert.equal(h.pending.get('private:123')?.eventId, 'event-cancel');
  emit(frame); emit({ type: 'interaction/cancelled', clientId: 'other', eventId: 'event-cancel' });
  await tick(); assert.equal(h.pending.has('private:123'), true);
  emit({ type: 'interaction/cancelled', clientId: 'client', eventId: 'event-cancel' });
  for (let i = 0; i < 50 && h.pending.has('private:123'); i++) await tick();
  assert.equal(h.pending.has('private:123'), false);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.calls.sent.length, 1);
});
await test('legacy bare approval remains compatible', async (h) => {
  h.cfg.sendDelayMs = 0; h.cfg.interaction.requireRequestId = false; let received;
  h.api.respond = async (value) => { received = value; return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'legacy', sessionId: 'session' });
  await h.handlePendingAnswer(h.pending.get('private:123'), '拒绝', 'private:123', true);
  assert.equal(received.outcome.value, 'rejected');
});
await test('failed notification retains pending request', async (h) => {
  h.cfg.sendDelayMs = 0; const sessionId = await h.ensureSession('private:123'); let attempted = false;
  h.bot.sendPrivateMessage = async () => { attempted = true; throw new Error('fixture disconnect'); };
  const emit = eventStream(h); emit({ type: 'approval/requested', sessionId, clientId: 'client', eventId: 'send-fail', toolName: 'safe' });
  for (let i = 0; i < 50 && !attempted; i++) await tick();
  assert.equal(attempted, true);
  assert.equal(h.pending.get('private:123')?.eventId, 'send-fail');
});
await test('timeout rejects pending and stale code cannot decide next event', async (h) => {
  h.cfg.sendDelayMs = 0; h.cfg.questionTimeoutMs = 10; const replies = [];
  h.api.respond = async (value) => { replies.push(value); return { result: { ok: true } }; };
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'expires' });
  const oldCode = h.pending.get('private:123').requestId;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.pending.has('private:123'), false); assert.equal(replies[0].outcome.value, 'rejected');
  h.cfg.questionTimeoutMs = 5000;
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'after-timeout' });
  const entry = h.pending.get('private:123'); const before = replies.length;
  await h.handlePendingAnswer(entry, `通过 ${oldCode}`, 'private:123', true);
  assert.equal(replies.length, before); assert.equal(h.pending.get('private:123'), entry);
});
await test('session retirement cancels old pending and old code cannot approve new', async (h) => {
  h.cfg.sendDelayMs = 0; const replies = [];
  h.api.respond = async (value) => { replies.push(value); return { result: { ok: true } }; };
  const sessionId = await h.ensureSession('private:123');
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'old-session', sessionId });
  const oldCode = h.pending.get('private:123').requestId; h.retireSession('private:123');
  assert.equal(h.pending.has('private:123'), false);
  await h.registerPending('private:123', { kind: 'approval', clientId: 'client', eventId: 'new-session', sessionId: 'next' });
  const entry = h.pending.get('private:123'), before = replies.length;
  await h.handlePendingAnswer(entry, `通过 ${oldCode}`, 'private:123', true);
  assert.equal(replies.length, before); assert.equal(h.pending.get('private:123'), entry);
});
await test('official remote mux cancel item maps to matching bridge frame', async () => {
  const original = globalThis.WebSocket;
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; static last;
    constructor() { this.readyState = 0; this.listeners = new Map(); this.frames = []; FakeSocket.last = this; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, data = {}) { for (const fn of this.listeners.get(type) || []) fn(data); }
    open() { this.readyState = 1; this.emit('open'); }
    send(data) { this.frames.push(JSON.parse(data)); }
    frame(value) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const api = new NodeApiClient('http://127.0.0.1:9', 1000, { token: 'fixture' }); api.cookie = 'fixture=ok';
    const abort = new AbortController(); const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
    const next = iterator.next(); await tick(); const socket = FakeSocket.last; socket.open();
    const streamId = socket.frames.find((frame) => frame.endpoint === '$events').streamId;
    socket.frame({ type: 'item', streamId, value: { type: 'ready', clientId: 'client' } });
    socket.frame({ type: 'item', streamId, value: { type: 'cancel', eventId: 'event-one' } });
    const frame = (await next).value.payload;
    assert.equal(frame.type, 'interaction/cancelled'); assert.equal(frame.clientId, 'client'); assert.equal(frame.eventId, 'event-one');
    abort.abort(); await iterator.return();
  } finally { globalThis.WebSocket = original; }
});
await test('DSH client rejects structured negative result', async () => {
  const api = new NodeApiClient('http://127.0.0.1:9', 1000, { token: 'fixture' });
  api.callUnary = async () => ({ result: { ok: false, error: { code: 'bad-response', message: 'fixture' } } });
  await assert.rejects(api.respond({ clientId: 'client', eventId: 'event', outcome: { kind: 'result', value: 'rejected' } }), (error) => error.code === 'DSH_EVENT_RESULT_REJECTED' && error.outcomeKnown === true);
});
console.log(`interaction fixture failures: ${failures}`);
process.exit(failures ? 1 : 0);
