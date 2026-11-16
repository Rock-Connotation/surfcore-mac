// 目的机制接线：真实 bridge.js 的配置/预览/投递/发送回执/回合回执（VM 夹具，不连真 QQ）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run, options) {
  const h = await bridgeHarness(options);
  try {
    h.setMode('reserved2');
    await run(h);
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, error.message);
  } finally {
    await h.close();
  }
}

function seedOwner(h) {
  h.appendSocialV2Message('private:123', '主人', '明天面试有点紧张', '明天面试有点紧张', false, true, 'm1');
  h.appendSocialV2Message('private:123', '主人', '你最近在忙什么', '你最近在忙什么', false, true, 'm2');
}

await test('配置默认开、owner 回退到 config.ownerQQ', async (h) => {
  assert.equal(h.cfg.purpose.enabled, true);
  assert.equal(h.cfg.purpose.ownerUin, '123');
  assert.ok(h.cfg.purpose.quietStart);
  assert.ok(h.cfg.purpose.quietEnd);
});

await test('legacy purpose execution remains blocked at the V2 boundary', async (h) => {
  const result = await h.runPurpose({ force: true });
  assert.equal(result.code, 'MEMORY_SOURCE_UNREFERENCED');
  assert.ok(result.hint);
  assert.equal(h.calls.nativeReplies.length + h.calls.prompts.length + h.calls.sent.length, 0);
});

if (failures) process.exitCode = 1;
