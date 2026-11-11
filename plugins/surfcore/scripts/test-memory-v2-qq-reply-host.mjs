import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createQQV2ReplyHost, resolveQQV2ModelRoute } from '../lib/qq-v2-reply-host.mjs';

async function fixture(mode = 'ok') {
  let role = { id: 'fixture', epoch: 1 }, ownerCount = 0, retireCount = 0, release;
  const calls = [], sources = new Map(), wait = new Promise(resolve => { release = resolve; });
  const ctx = { get: name => name === 'llm' ? { resolveModelInfo: async (provider, id) => ({ provider, id }) } : { currentSelection: () => ({ provider: 'p', model: 'm' }) } };
  const host = createQQV2ReplyHost({ ctx, memoryV2: { adapter: {}, getRouting: () => ({ ok: true, backend: 'v2' }) }, tokenBudget: {},
    getCharacter: () => role, getQQIdentity: async () => ({ ok: true, verified: true, accountId: '1', allowedGroups: ['2', '3'], allowedPrivates: [] }), readPersona: () => 'Fixture persona.', timeoutMs: mode === 'timeout' ? 5 : 1000,
    loadEnvironment: async () => ({ nativeModules: {}, nativeCodec: { createUserMessage: value => value }, llm: {}, getLlmHookContext: () => ctx }),
    createSource: ({ bridge, validateOwnedToolContext }) => {
      let job;
      return {
        prepareReplyPrompt: async input => { job = input.job; assert.match(job.jobId, /^owned-/); const exported = await bridge.exportNativeSources(input.key); assert.ok(exported.ok); sources.set(job.jobId, input.key); return { ok: true, content: [{ type: 'text', text: 'Complete fresh input.' }] }; },
        captureModelOutput: async () => ({ ok: true }),
        prepareSend: async input => { assert.equal(input.job, job); return bridge.authorizeSend(input); },
        recordSent: async input => bridge.recordSent(input.lease, { text: input.text, messageId: input.messageId, deliveryState: input.deliveryState }),
        retireJob: async () => { await bridge.retire(); return { ok: true }; },
      };
    },
    createOwner: async options => {
      ownerCount++; const id = 'owned-' + randomUUID();
      assert.deepEqual(options.tools, []); assert.equal(typeof options.getLlmHookContext, 'function'); assert.ok(options.estimatedTokens > 8192);
      let message, cancelled = false;
      return {
        sessionId: id, validateOwnedToolContext: () => ({ ok: false }),
        followup: value => { message = value; },
        whenIdle: async () => {
          assert.equal(sources.get(id), message.source.requestId === 'r3' ? 'group:3' : 'group:2');
          if (['wait', 'timeout', 'epoch'].includes(mode)) await wait;
          if (cancelled) return;
          if (mode === 'epoch') role = { ...role, epoch: 2 };
          await options.sourceAuthority.captureModelOutput({ phase: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Complete reply.' } });
          await options.sourceAuthority.captureModelOutput({ phase: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Complete reply.' } } });
          if (mode !== 'missing-finish') await options.sourceAuthority.captureModelOutput({ phase: 'chunk', chunk: { type: 'finish', reason: { kind: mode === 'truncated' ? 'max-tokens' : 'stop' } } });
          await options.sourceAuthority.captureModelOutput({ phase: 'complete' });
        },
        retire: async () => { retireCount++; cancelled = true; release(); },
      };
    },
    callBridge: async (_path, { body }) => {
      assert.equal(body.characterId, 'fixture'); assert.equal(body.characterEpoch, 1); assert.ok(body.requestId); assert.ok(body.key);
      calls.push(body);
      let data = { ok: true };
      if (body.action === 'authorize') data.lease = 'private-lease-' + body.requestId;
      if (body.action === 'send') data = mode === 'unknown' ? { ok: false, code: 'MEMORY_QQ_DELIVERY_UNKNOWN', error: 'Unknown', hint: 'Check original.' } : { ok: true, messageId: '123', deliveryState: 'delivered' };
      return { ok: data.ok, status: data.ok ? 200 : 409, data };
    },
  });
  const request = (id = 'r1', key = 'group:2') => ({ key, requestId: id, characterId: 'fixture', characterEpoch: 1 });
  return { host, request, calls, release, counts: () => ({ ownerCount, retireCount }) };
}
{
  const f = await fixture(); const accepted = f.host.submit(f.request());
  assert.equal(accepted.accepted, true); assert.deepEqual(f.host.submit(f.request()), accepted);
  assert.equal(f.host.submit(f.request('r2')).code, 'MEMORY_QQ_BUSY');
  assert.equal(f.host.submit(f.request('r1', 'group:3')).code, 'MEMORY_QQ_REQUEST_REUSE');
  await f.host.whenIdle();
  assert.equal(f.host.getReceipt('r1').delivered, true);
  assert.deepEqual(f.calls.filter(c => c.action === 'send').map(c => c.text), ['Complete reply.']);
  assert.equal(f.calls.filter(c => c.action === 'record').length, 1); assert.equal(f.calls.at(-1).ok, true);
  f.host.submit(f.request()); await f.host.whenIdle(); assert.equal(f.counts().ownerCount, 1);
  await f.host.retire(); f.host.submit(f.request('r3', 'group:3')); await f.host.whenIdle(); assert.equal(f.host.getReceipt('r3').delivered, true);
  await f.host.close();
}
for (const mode of ['missing-finish', 'truncated', 'unknown', 'timeout', 'epoch']) {
  const f = await fixture(mode); f.host.submit(f.request());
  if (mode === 'epoch') f.release();
  await f.host.whenIdle();
  assert.equal(f.host.getReceipt('r1').ok, false, mode);
  const sent = f.calls.filter(c => c.action === 'send').length;
  assert.equal(sent, mode === 'unknown' ? 1 : 0, mode);
  assert.equal(f.calls.at(-1).action, 'complete'); assert.equal(f.calls.at(-1).ok, false);
  assert.ok(f.calls.at(-1).code && f.calls.at(-1).hint); assert.ok(f.counts().retireCount);
  await f.host.close();
}
{
  const f = await fixture('wait'); f.host.submit(f.request());
  for (let i = 0; i < 20 && !f.counts().ownerCount; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.host.retire()).ok, true); assert.equal(f.calls.filter(c => c.action === 'send').length, 0);
  await f.host.close();
}
await assert.rejects(resolveQQV2ModelRoute({ get: name => name === 'llm' ? { resolveModelInfo: async () => ({ provider: 'other', id: 'm' }) } : { currentSelection: () => ({ provider: 'p', model: 'm' }) } }), e => e.code === 'MEMORY_PROVIDER_ROUTE_MISMATCH');
console.log('PASS production QQ Host orchestration: exact route, bound Native session, full output once, receipt, idempotency, truncation, unknown, timeout, role drift and retirement');
