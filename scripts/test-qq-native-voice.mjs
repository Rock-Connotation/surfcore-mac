import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const priorDshHome = process.env.DSH_HOME;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-native-voice-test-'));
process.env.DSH_HOME = path.join(isolatedHome, 'dsh');

const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
const { createQQMemoryBridge: buildQQMemoryBridge } = await import('../src/core/memory-v2-qq.js');
let harness;
const synthesized = [];
let legacyMemoryAuthorizations = 0;
let abortNextSynthesis = null;
try {
  harness = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { private: ['123'], groups: ['12345'] },
      snowluma: { httpUrl: 'http://fixture.invalid', accessToken: 'fixture-token' },
      socialV2: {
        tools: { sendVoice: true },
        tokenGuard: { enabled: false },
        voice: {
          enabled: true,
          recordTransport: 'base64',
          maxPerMinute: 1,
          maxPerHour: 0,
          trigger: { who: 'owner', members: [], groups: [] },
          groupPolicies: { '12345': { triggerWho: 'mention', maxPerDay: 1 } },
          tts: {
            enabled: true,
            cloudProvider: 'volc',
            route: 'cloud',
            maxChars: 240,
            volcKeyId: 'fixture-key-id',
            endpoints: { cloud: 'https://voice.invalid' },
          },
        },
      },
      fishGuard: { enabled: false },
    },
    synthesizeImpl: async (request) => {
      synthesized.push(request);
      if (abortNextSynthesis) {
        abortNextSynthesis.abort();
        abortNextSynthesis = null;
      }
      fs.mkdirSync(request.outDir, { recursive: true });
      const file = path.join(request.outDir, `fixture-${synthesized.length}.wav`);
      fs.writeFileSync(file, Buffer.alloc(44));
      return { path: file, cached: false, durationMs: 25 };
    },
    globals: {
      readVolcKey: () => 'fixture-only-key',
      createQQMemoryBridge: (options) => {
        const memory = buildQQMemoryBridge(options);
        return new Proxy(memory, {
          get(target, property, receiver) {
            if (property === 'authorizeSend') return async (...args) => {
              legacyMemoryAuthorizations++;
              return target.authorizeSend(...args);
            };
            return Reflect.get(target, property, receiver);
          },
        });
      },
      inspectAudio: async () => ({ ok: true, size: 44, duration: 0.1, codec: 'wav', warnings: [] }),
      describeAudio: () => 'fixture wav',
    },
  });
  harness.setSelfIdentity('Owner', 123);

  assert.equal(typeof harness.sendNativeQQReply, 'function', 'bridge exposes the Native reply transport');
  const controller = new AbortController();
  const result = await harness.sendNativeQQReply('private:123', '我在这里。', {
    delivery: 'voice',
    validate: async () => {},
    signal: controller.signal,
  });
  assert.equal(result.ok, true, `Native owner voice reply is delivered (${JSON.stringify(result)})`);
  assert.equal(result.deliveryState, 'delivered');
  assert.equal(synthesized.length, 1, 'configured voice is synthesized once');
  assert.equal(synthesized[0].provider, 'volc', 'configured Volcengine route is used');
  const sent = harness.calls.http.filter(call => call.url.endsWith('/send_private_msg'));
  assert.equal(sent.length, 1, 'one OneBot voice request is sent');
  assert.equal(sent[0].body.message[0].type, 'record');
  assert.match(sent[0].body.message[0].data.file, /^base64:\/\//, 'configured base64 record transport is reused');
  assert.notEqual(sent[0].signal, controller.signal, 'OneBot send uses a combined timeout and retirement signal');
  assert.equal(sent[0].signal.aborted, false);
  assert.equal(legacyMemoryAuthorizations, 0, 'Native transport does not acquire the legacy memory send lease');

  const synthCount = synthesized.length;
  harness.cfg.socialV2.voice.enabled = false;
  const disabled = await harness.sendNativeQQReply('private:123', '这条不应合成。', { delivery: 'voice', validate: async () => {} });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'VOICE_DISABLED');
  assert.equal(harness.getNativeQQCapabilities('private:123').voice.enabled, false);
  assert.equal(synthesized.length, synthCount, 'global voice disable blocks before TTS');
  harness.cfg.socialV2.voice.enabled = true;

  const groupKey = 'group:12345';
  const groupDenied = await harness.sendNativeQQReply(groupKey, '没有群 @ 时不合成。', { delivery: 'voice', validate: async () => {} });
  assert.equal(groupDenied.code, 'VOICE_TRIGGER_DENIED');
  assert.equal(harness.getNativeQQCapabilities(groupKey).voice.enabled, false, 'group mention policy gates tool availability');
  assert.equal(synthesized.length, synthCount, 'group voice trigger denial happens before TTS');

  harness.voiceMentionAt.set(groupKey, Date.now());
  assert.equal(harness.getNativeQQCapabilities(groupKey).voice.enabled, true, 'a current group @ enables voice under the configured policy');
  const groupSend = await harness.sendNativeQQReply(groupKey, '收到群 @ 了。', { delivery: 'voice', validate: async () => {} });
  assert.equal(groupSend.ok, true, `group @ voice reply is delivered (${JSON.stringify(groupSend)})`);
  assert.equal(groupSend.deliveryState, 'delivered');
  const groupRequests = harness.calls.http.filter(call => call.url.endsWith('/send_group_msg'));
  assert.equal(groupRequests.length, 1, 'one group OneBot request follows a permitted @');

  harness.voiceMentionAt.set(groupKey, Date.now() + 10);
  const quotaBlocked = await harness.sendNativeQQReply(groupKey, '群额度不应再次合成。', { delivery: 'voice', validate: async () => {} });
  assert.equal(quotaBlocked.code, 'VOICE_GROUP_DAILY_LIMIT');
  assert.equal(synthesized.length, synthCount + 1, 'group daily quota blocks before another TTS request');
  assert.equal(harness.getNativeQQCapabilities(groupKey).voice.enabled, false);

  harness.cfg.socialV2.voice.groupPolicies['12345'].maxPerDay = 2;
  harness.cfg.socialV2.voice.maxPerMinute = 0;
  harness.cfg.socialV2.voice.maxPerHour = 0;
  const canceled = new AbortController();
  abortNextSynthesis = canceled;
  const requestsBeforeCancel = harness.calls.http.filter(call => call.url.endsWith('/send_private_msg')).length;
  const canceledResult = await harness.sendNativeQQReply('private:123', '作业会在合成时退役。', {
    delivery: 'voice', validate: async () => {}, signal: canceled.signal,
  });
  assert.equal(canceledResult.ok, false);
  assert.equal(canceledResult.code, 'MEMORY_QQ_JOB_STALE');
  assert.equal(synthesized.at(-1).signal, canceled.signal, 'TTS receives the Native retirement signal');
  assert.equal(harness.calls.http.filter(call => call.url.endsWith('/send_private_msg')).length, requestsBeforeCancel, 'retirement during TTS prevents a late OneBot send');

  const lateCancel = new AbortController();
  let validationCount = 0;
  const lateCanceledResult = await harness.sendNativeQQReply('private:123', '预留后作业退役。', {
    delivery: 'voice',
    signal: lateCancel.signal,
    validate: async () => { if (++validationCount === 6) lateCancel.abort(); },
  });
  assert.equal(lateCanceledResult.ok, false);
  assert.equal(lateCanceledResult.code, 'MEMORY_QQ_JOB_STALE');
  const budgetFile = path.join(harness.temp, 'state', 'voice-send-budget.json');
  let budget = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  assert.equal(budget.pending, null, 'retiring at the final pre-send validation releases the reservation');
  assert.equal(budget.count, 2, 'a pre-network cancellation does not consume the daily sent count');

  const finalSend = await harness.sendNativeQQReply('private:123', '退役后可安全处理下一条。', { delivery: 'voice', validate: async () => {} });
  assert.equal(finalSend.ok, true, `a later Native reply can send after reservation rejection (${JSON.stringify(finalSend)})`);
  budget = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  assert.equal(budget.pending, null);
  assert.equal(budget.count, 3);
  assert.equal(legacyMemoryAuthorizations, 0, 'Native voice never starts the legacy memory transaction');
  assert.equal(harness.calls.http.filter(call => call.url.endsWith('/send_private_msg') || call.url.endsWith('/send_group_msg')).length, 3, 'only confirmed private/group replies reached OneBot');

  const callbackAudio = path.join(harness.temp, 'state', 'callback-failure.wav');
  fs.writeFileSync(callbackAudio, Buffer.alloc(44));
  const callbackMentionAt = Date.now();
  harness.voiceMentionAt.set(groupKey, callbackMentionAt);
  await assert.rejects(
    harness.sendVoiceTransport(groupKey, callbackAudio, {
      guard: true,
      audit: false,
      onReceipt: async () => { throw Object.assign(new Error('fixture receipt writer failed'), { code: 'FIXTURE_RECEIPT_FAILED' }); },
    }),
    error => error.code === 'FIXTURE_RECEIPT_FAILED'
      && error.deliveryReceipt?.deliveryState === 'delivered'
      && error.deliveryReceipt?.messageId === 9001,
    'a memory receipt failure carries the confirmed OneBot ACK',
  );
  budget = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  assert.equal(budget.pending, null);
  assert.equal(budget.count, 4, 'confirmed ACK counts before the receipt writer runs');
  assert.ok(harness.voiceLastSentAt.get(groupKey) >= callbackMentionAt, 'confirmed ACK consumes the current group mention trigger');
  assert.equal(harness.voiceTriggerBlock(groupKey, 'group', 12345) !== null, true, 'a failed local receipt cannot make the same @ reusable');

  for (const malformedId of [true, '1.0', ' 1 ']) {
    const requests = [];
    const malformedHarness = await bridgeHarness({
      config: structuredClone(harness.cfg),
      synthesizeImpl: async request => {
        fs.mkdirSync(request.outDir, { recursive: true });
        const file = path.join(request.outDir, 'malformed-ack.wav');
        fs.writeFileSync(file, Buffer.alloc(44));
        return { path: file, cached: false, durationMs: 25 };
      },
      globals: {
        readVolcKey: () => 'fixture-only-key',
        inspectAudio: async () => ({ ok: true, size: 44, duration: 0.1, codec: 'wav', warnings: [] }),
        describeAudio: () => 'fixture wav',
        fetch: async (url, init = {}) => {
          requests.push({ url: String(url), signal: init.signal });
          return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: malformedId } }) };
        },
      },
    });
    try {
      malformedHarness.setSelfIdentity('Owner', 123);
      const malformed = await malformedHarness.sendNativeQQReply('private:123', '回执格式必须规范。', { delivery: 'voice', validate: async () => {} });
      assert.equal(malformed.ok, false, `noncanonical ACK ${JSON.stringify(malformedId)} is not delivered`);
      assert.equal(malformed.code, 'VOICE_SEND_UNCERTAIN');
      assert.equal(requests.length, 1, 'a malformed response is never replayed');
      const malformedBudget = JSON.parse(fs.readFileSync(path.join(malformedHarness.temp, 'state', 'voice-send-budget.json'), 'utf8'));
      assert.equal(malformedBudget.pending?.state, 'uncertain', 'malformed ACK preserves the conservative pending quota state');
      assert.equal(malformedBudget.count, 0, 'malformed ACK does not count as a confirmed send');
    } finally {
      await malformedHarness.close();
    }
  }

  const busyAckRequests = [];
  let postAckBudgetCalls = 0;
  const busyAckHarness = await bridgeHarness({
    config: structuredClone(harness.cfg),
    synthesizeImpl: async request => {
      fs.mkdirSync(request.outDir, { recursive: true });
      const file = path.join(request.outDir, 'busy-accounting.wav');
      fs.writeFileSync(file, Buffer.alloc(44));
      return { path: file, cached: false, durationMs: 25 };
    },
    globals: {
      readVolcKey: () => 'fixture-only-key',
      inspectAudio: async () => ({ ok: true, size: 44, duration: 0.1, codec: 'wav', warnings: [] }),
      describeAudio: () => 'fixture wav',
      voiceSendBudget: (_stateDir, action) => {
        if (action === 'check' || action?.type === 'check') return;
        if (action?.type === 'reserve') return '00000000-0000-4000-8000-000000000001';
        postAckBudgetCalls++;
        throw Object.assign(new Error('fixture busy'), { code: 'VOICE_SEND_BUDGET_BUSY' });
      },
      fetch: async (url, init = {}) => {
        busyAckRequests.push(String(url));
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: '9002' } }) };
      },
    },
  });
  try {
    busyAckHarness.setSelfIdentity('Owner', 123);
    const startedAt = Date.now();
    const busyAck = await busyAckHarness.sendNativeQQReply('private:123', '回执后额度账本忙。', { delivery: 'voice', validate: async () => {} });
    assert.equal(busyAck.ok, true, 'the actual OneBot ACK remains delivered after local quota accounting fails');
    assert.equal(busyAck.messageId, '9002');
    assert.equal(busyAck.deliveryState, 'delivered');
    assert.equal(busyAck.warning?.code, 'VOICE_SEND_UNCERTAIN');
    assert.equal(busyAckRequests.length, 1, 'post-ACK accounting trouble never replays the QQ request');
    assert.equal(postAckBudgetCalls, 2, 'post-ACK accounting uses one sent attempt and one uncertain attempt');
    assert.ok(Date.now() - startedAt < 1000, 'post-ACK lock contention returns promptly instead of waiting 65 seconds');
  } finally {
    await busyAckHarness.close();
  }
  console.log('QQ Native voice transport: policy, ownership, cancellation, and ACK checks passed');
} finally {
  await harness?.close();
  if (priorDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorDshHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
}
