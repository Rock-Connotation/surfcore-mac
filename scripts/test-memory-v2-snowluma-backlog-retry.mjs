import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const bridge = await bridgeHarness();
try {
  bridge.setMode('reserved2');
  bridge.setSnowlumaHealth({ connected: false, everConnected: false, downNotified: false,
    backlogWakePending: false, backlogWakeRetried: false });
  await bridge.sendWakePromptV2('group:1135502130', 'backlog');
  assert.equal(bridge.snowlumaHealth.backlogWakePending, true,
    '通道断开时被跳过的补唤醒必须留标记');
  bridge.setSnowlumaHealth({ connected: true, everConnected: true });
  bridge.notifySendChannelUp();
  assert.equal(bridge.snowlumaHealth.backlogWakePending, false, '恢复后标记应清空');
  assert.equal(bridge.snowlumaHealth.backlogWakeRetried, true, '恢复后必须重排补唤醒');
} finally {
  await bridge.close();
}
console.log('PASS SnowLuma reconnect retries the skipped backlog wake');
