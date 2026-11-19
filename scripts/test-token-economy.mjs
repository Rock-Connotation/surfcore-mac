import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const seqs = (messages) => Array.from(messages, (message) => message.seq);
let failures = 0;
let tests = 0;

async function test(name, run) {
  tests++;
  const h = await bridgeHarness({ config: { socialV2: {
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY, admin = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text, { key = KEY, id = `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, media = [], forwards = [] } = {}) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, id, media, '789', forwards);
    return h.getSocialV2State(key).lastUnreadSeq;
  };
  try { await run({ h, st, request, append }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('V2 refuses unpinned history and preserves the unread watermark', async ({ h, st, request, append }) => {
  const first = append('archived-unread-canary');
  for (const [route, body] of [
    ['unread'],
    ['context-snapshot'],
    ['my-recent'],
    ['message-detail'],
    ['wake-config', { throughSeq: first, mode: 'diving' }],
    ['close-conversation', { throughSeq: first }],
  ]) {
    const reply = await request(route, { body });
    assert.equal(reply.status, 403);
    assert.equal(reply.data.code, 'MEMORY_HISTORY_UNAVAILABLE');
    assert.ok(reply.data.hint);
    assert.ok(!JSON.stringify(reply.data).includes('archived-unread-canary'));
  }
  assert.deepEqual(seqs(st.unread), [first]);
  assert.equal(h.calls.nativeReplies.length, 0);
  assert.equal(h.calls.prompts.length, 0);
});

await test('a caller cannot acknowledge unread that was never included in its V2 context', async ({ st, request, append }) => {
  const first = append('unseen');
  const reply = await request('mark-read', { body: { throughSeq: first } });
  assert.equal(reply.data.ok, false);
  assert.deepEqual(seqs(st.unread), [first]);
});

await test('a retired session token cannot authorize a replacement request', async ({ h, st, request, append }) => {
  const previousToken = st.agentToken;
  h.state.sessions[KEY] = 'withdrawn-fixture-session';
  h.retireSession(KEY);
  const fresh = h.getSocialV2State(KEY);
  append('new');
  const reply = await request('unread', { token: previousToken });
  assert.equal(reply.status, 403);
  assert.notEqual(fresh.agentToken, previousToken);
  assert.ok(!JSON.stringify(reply.data).includes('unseen'));
});

if (failures) process.exitCode = 1;
console.log(`token economy V2: ${tests - failures}/${tests}`);
