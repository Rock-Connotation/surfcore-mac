import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createBiliCardSender } from '../src/bili-card.js';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing production section ${start}`);
  return source.slice(first, last);
}
const functions = section('  async function finishMemoryV2Send(', '  async function retireMemoryV2Session(')
  + section('  async function onebotSendSegments(', '  // B站视频卡片：');

async function scenario(mode, { finalization = 'ok' } = {}) {
  const calls = [], receipts = [], failures = [], lease = Object.freeze({});
  const networkError = Object.assign(new Error(mode === 'timeout' ? 'fixture timeout' : 'fixture network rejection'), { name: mode === 'timeout' ? 'TimeoutError' : 'Error' });
  const finalizeError = new Error('fixture finalization failure');
  const context = {
    cfg: { snowluma: { httpUrl: 'http://fixture.invalid' } }, AbortSignal,
    beginMemoryV2Send: async (key) => { calls.push(['authorize', key]); return lease; },
    qqMemory: { recordSent: async (actualLease, receipt) => {
      assert.equal(actualLease, lease); receipts.push(receipt);
      if (finalization === 'throw') throw finalizeError;
      if (finalization === 'blocked') return { ok: false, code: 'MEMORY_RECEIPT_PENDING', error: 'Receipt is pending.', hint: 'Inspect the original receipt before resuming.' };
      return { ok: true };
    } },
    memoryV2Failure: (key, result) => { failures.push({ key, ...result }); return result; },
    fetch: async (url, options) => {
      calls.push(['fetch', url, options]);
      if (mode === 'reject' || mode === 'timeout') throw networkError;
      const invalidIds = { 'invalid-id': 'not-an-id', 'invalid-zero': 0, 'invalid-object': {}, 'invalid-unsafe': 9007199254740992, 'invalid-space': ' 77' };
      const data = mode === 'success' ? { status: 'ok', retcode: 0, data: { message_id: 77 } } : mode === 'success-string' ? { status: 'ok', retcode: 0, data: { data: { message_id: '-77' } } } : mode === 'missing-id' ? { status: 'ok', retcode: 0, data: {} } : Object.hasOwn(invalidIds, mode) ? { status: 'ok', retcode: 0, data: { message_id: invalidIds[mode] } } : ['application-failure', 'server-error'].includes(mode) ? { status: 'failed', retcode: 10, wording: 'fixture application failure' } : {};
      return { ok: mode !== 'server-error', status: mode === 'server-error' ? 500 : 200, json: async () => { if (mode === 'malformed') throw new Error('fixture malformed response'); return data; } };
    },
  };
  const send = vm.runInNewContext(`(() => { ${functions} return onebotSendSegments; })()`, context);
  let result, error;
  try { result = await send('group', '456', [{ type: 'text', data: { text: 'fixture' } }]); }
  catch (caught) { error = caught; }
  assert.equal(calls.filter(call => call[0] === 'authorize').length, 1);
  assert.equal(calls.filter(call => call[0] === 'fetch').length, 1, 'no retry or second send');
  assert.equal(receipts.length, 1, 'each admitted send finalizes its lease exactly once');
  assert.equal(receipts[0].text, '[QQ消息卡片]');
  if (mode === 'reject' || mode === 'timeout') {
    assert.equal(receipts[0].deliveryState, 'delivery_unknown');
    assert.equal(receipts[0].messageId, null);
    assert.equal(error.cause, finalization === 'throw' ? finalizeError : networkError);
    assert.equal(error.deliveryUnknown, true);
    assert.equal(error.code, 'MEMORY_QQ_DELIVERY_UNKNOWN');
    assert.ok(error.hint);
    assert.equal(failures[0].code, 'MEMORY_QQ_DELIVERY_UNKNOWN');
    assert.ok(failures[0].hint);
  } else if (mode === 'success') {
    if (finalization === 'blocked') assert.equal(error.code, 'MEMORY_RECEIPT_PENDING');
    else if (finalization === 'throw') { assert.equal(error.code, 'MEMORY_QQ_RECEIPT_FAILED'); assert.equal(error.cause, finalizeError); assert.ok(error.hint); }
    else { assert.equal(error, undefined); assert.equal(result.message_id, 77); }
    assert.equal(receipts[0].deliveryState, 'delivered'); assert.equal(receipts[0].messageId, '77');
  } else if (mode === 'success-string') {
    assert.equal(error, undefined); assert.equal(result.data.message_id, '-77');
    assert.equal(receipts[0].deliveryState, 'delivered'); assert.equal(receipts[0].messageId, '-77');
  } else if (['malformed', 'server-error', 'missing-id'].includes(mode) || mode.startsWith('invalid-')) {
    assert.ok(error, 'unconfirmed delivery must not report success');
    if (finalization === 'blocked') assert.equal(error.code, 'MEMORY_RECEIPT_PENDING');
    else if (finalization === 'throw') { assert.equal(error.code, 'MEMORY_QQ_RECEIPT_FAILED'); assert.equal(error.cause, finalizeError); }
    else { assert.equal(error.deliveryUnknown, true); assert.equal(error.code, 'MEMORY_QQ_DELIVERY_UNKNOWN'); }
    assert.ok(error.hint); assert.equal(receipts[0].deliveryState, 'delivery_unknown'); assert.equal(receipts[0].messageId, null);
  } else {
    assert.match(error.message, /OneBot send_group_msg 失败/);
    assert.equal(receipts[0].deliveryState, 'delivery_unknown'); assert.equal(receipts[0].messageId, null);
  }
  if (finalization === 'blocked') {
    const pending = failures.at(-1);
    assert.equal(pending.key, 'group:456'); assert.equal(pending.code, 'MEMORY_RECEIPT_PENDING'); assert.ok(pending.hint);
  }
}

for (const mode of ['reject', 'timeout', 'success', 'success-string', 'application-failure', 'malformed', 'server-error', 'missing-id', 'invalid-id', 'invalid-zero', 'invalid-object', 'invalid-unsafe', 'invalid-space']) {
  await scenario(mode); console.log(`PASS segment ${mode}`);
}
await scenario('reject', { finalization: 'blocked' });
await scenario('success', { finalization: 'blocked' });
await scenario('success', { finalization: 'throw' });
await scenario('reject', { finalization: 'throw' });
await scenario('missing-id', { finalization: 'blocked' });
await scenario('missing-id', { finalization: 'throw' });
console.log('PASS structured pending receipt and thrown finalization remain visible');

for (const mode of ['reject', 'server-error', 'receipt-blocked', 'receipt-throw', 'missing-id', 'missing-receipt-blocked', 'missing-receipt-throw']) {
  let attempts = 0, records = 0;
  const failures = [], lease = Object.freeze({});
  const context = {
    cfg: { snowluma: { httpUrl: 'http://fixture.invalid' } }, AbortSignal,
    beginMemoryV2Send: async () => lease,
    qqMemory: { recordSent: async (actual, receipt) => {
      assert.equal(actual, lease); records++;
      assert.equal(receipt.deliveryState, mode.startsWith('receipt-') ? 'delivered' : 'delivery_unknown');
      if (mode.endsWith('receipt-blocked')) return { ok: false, code: 'MEMORY_RECEIPT_PENDING', error: 'Receipt pending.', hint: 'Inspect original receipt.' };
      if (mode.endsWith('receipt-throw')) throw new Error('fixture receipt failure');
      return { ok: true };
    } },
    memoryV2Failure: (key, issue) => { failures.push({ key, ...issue }); return issue; },
    fetch: async () => {
      attempts++;
      if (mode === 'reject') throw new Error('fixture ambiguous send');
      if (mode === 'server-error') return { ok: false, status: 500, json: async () => ({ status: 'failed', retcode: 10 }) };
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: mode.startsWith('missing-') ? {} : { message_id: 77 } }) };
    },
  };
  const sendSegments = vm.runInNewContext(`(() => { ${functions} return onebotSendSegments; })()`, context);
  const sendCard = createBiliCardSender({
    getShare: () => ({ cardMode: 'miniapp' }),
    requestMiniArk: async () => ({ app: 'fixture', meta: {} }),
    sendGroupSegments: (id, segments) => sendSegments('group', id, segments),
  });
  assert.equal(await sendCard('group:456', { bvid: 'BV1JaJo6jEqH', title: 'fixture', pic: 'https://example.invalid/cover' }), false);
  assert.equal(attempts, 1); assert.equal(records, 1);
  assert.ok(failures[0].code && failures[0].hint);
  console.log(`PASS actual segment function + card caller: ${mode} sends once`);
}
