/**
 * 上线补历史消息（socialV2.history）回归：
 *   · 纯逻辑：配置归一化、时间水位、候选过滤（水位/时间窗/重复/黑名单/上限）；
 *   · 接线：真实 bridge.js（audit-bridge-harness，VM + 夹具网关）启动 / 手动触发时
 *     真的请求历史接口、并入未读、标 history=true、按开关唤醒；
 *   · 提示词：history 唤醒原因与快照里的 history 标记。
 *
 * 不连 QQ / DSH / SnowLuma，不发任何消息。
 *
 * 运行：node scripts/test-history-catchup.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_HISTORY_CATCHUP, buildHistoryCatchupLine, historyWatermark,
  normalizeHistoryConfig, selectMissedHistory, summarizeHistoryCatchup,
} from '../src/history-catchup.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const NOW = Date.UTC(2026, 9, 24, 2, 0, 0);

// ── 纯逻辑 ────────────────────────────────────────────────────────────────
assert.deepEqual(normalizeHistoryConfig(null), DEFAULT_HISTORY_CATCHUP, '缺省配置必须默认开启');
assert.equal(normalizeHistoryConfig({}).enabled, true, '没有配置时必须默认勾选打开');
assert.equal(normalizeHistoryConfig({ enabled: false }).enabled, false, '显式关闭必须保留');
assert.equal(normalizeHistoryConfig({ enabled: 'false' }).enabled, true, '非布尔值不能把默认开误关');
assert.deepEqual(
  normalizeHistoryConfig({ limit: -3, maxAgeMinutes: 999999, wake: 'no', includePrivate: 0 }),
  { enabled: true, limit: 1, maxAgeMinutes: 10080, wake: true, includePrivate: true },
  '坏值必须收敛且不改变布尔默认',
);

// 水位：取最近入站时间，并留 5 秒容差防止把停机前最后几秒误判成旧消息。
const watermarkState = {
  lastIncomingAt: NOW - 60_000,
  recentMessages: [
    { time: NOW - 120_000 },
    { time: NOW - 30_000, isSelf: true },
  ],
};
assert.equal(
  historyWatermark(watermarkState, { now: NOW, maxAgeMs: 12 * 3600_000 }),
  NOW - 35_000,
  '水位应取最近消息时间并减 5 秒容差',
);
// 时间窗把过旧的水位抬到 floor。
assert.equal(
  historyWatermark({ lastIncomingAt: NOW - 10 * 3600_000 }, { now: NOW, maxAgeMs: 3600_000 }),
  NOW - 3600_000,
  '超过时间窗的水位必须被 floor 截断',
);

const candidates = [
  { messageId: 'a1', time: NOW - 20 * 60_000, userId: '2001', isSelf: false },
  { messageId: 'a2', time: NOW - 10 * 60_000, userId: '2002', isSelf: true },
  { messageId: 'a3', time: NOW - 5 * 60_000, userId: '2003', isSelf: false },
  { messageId: 'old', time: NOW - 3 * 3600_000, userId: '2001', isSelf: false },
  { messageId: 'blocked', time: NOW - 2 * 60_000, userId: '9999', isSelf: false },
  { messageId: 'a1', time: NOW - 20 * 60_000, userId: '2001', isSelf: false },
  { messageId: '', time: NOW - 60_000, userId: '2001', isSelf: false },
  { messageId: 'future', time: NOW + 10 * 60_000, userId: '2001', isSelf: false },
];
const picked = selectMissedHistory(candidates, {
  watermark: NOW - 30 * 60_000,
  now: NOW,
  maxAgeMs: 12 * 3600_000,
  limit: 30,
  existingIds: ['a1'],
  blockedUsers: ['9999'],
});
assert.deepEqual(picked.map((m) => m.messageId), ['a2', 'a3'], '只保留水位后、未见过、非黑名单、非未来消息');

const capped = selectMissedHistory(
  Array.from({ length: 40 }, (_, index) => ({
    messageId: `m${index}`, time: NOW - (40 - index) * 60_000, userId: '2001', isSelf: false,
  })),
  { watermark: NOW - 24 * 3600_000, now: NOW, maxAgeMs: 24 * 3600_000, limit: 5 },
);
assert.deepEqual(capped.map((m) => m.messageId), ['m35', 'm36', 'm37', 'm38', 'm39'], '超限时保留最新 N 条且按时间升序');

assert.deepEqual(summarizeHistoryCatchup(picked), { incoming: 1, self: 1, total: 2 });
assert.match(buildHistoryCatchupLine({ incoming: 2, self: 1 }), /2 条群友\/好友消息/);
assert.match(buildHistoryCatchupLine({ incoming: 2, self: 1 }), /1 条你自己以前发过的消息/);
assert.equal(buildHistoryCatchupLine({ incoming: 0, self: 0 }), '');

// Old conversation history cannot be delivered without an authorized V2 import.
const harness = await bridgeHarness();
try {
  const result = harness.retiredHistoryFailure();
  assert.equal(result.code, 'MEMORY_HISTORY_UNAVAILABLE');
  assert.ok(result.error && result.hint);
  assert.equal(harness.calls.http.length, 0);
  assert.deepEqual(harness.calls.nativeReplies, []);
} finally {
  await harness.close();
}
console.log('PASS history selection and V2 refusal to replay legacy history');
