// First-reply quiet-window regressions. Real bridge handlers, fixture peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run, cfg = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    proactive: { enabled: false }, sticker: { enabled: false },
    ...cfg,
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body, { beforeSendMs = 0 } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    const send = () => req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
    if (beforeSendMs > 0) setTimeout(send, beforeSendMs);
    else send();
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  try { await run({ h, key, st, server, request, append }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('retired raw wait cannot expose a new arrival or grant observation in V2', () => fixture(async ({ h, st, request, append }) => {
  append('archive-canary');
  const wait = request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 100 });
  append('new-arrival-canary');
  const reply = await wait;
  assert.equal(reply.status, 403);
  assert.equal(reply.data.code, 'MEMORY_HISTORY_UNAVAILABLE');
  assert.ok(reply.data.hint);
  assert.ok(!JSON.stringify(reply.data).includes('-canary'));
  assert.equal(st.unread.length, 2);
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.nativeReplies.length, 0);
}));

test('retired sleep wait cannot attach to the Native job', () => fixture(async ({ request, append }) => {
  append('archive-canary');
  const reply = await request('wait', { purpose: 'sleep', timeoutMs: 1500 });
  assert.equal(reply.status, 403);
  assert.ok(!JSON.stringify(reply.data).includes('archive-canary'));
}));
