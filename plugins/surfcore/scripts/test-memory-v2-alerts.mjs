import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateEventStore } from '../../../src/gate-events.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-memory-alerts-'));
try {
  const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function reportMemoryBlocked(result) {');
  const end = source.indexOf('\n  biliMemoryHost =', start);
  assert.ok(start > 0 && end > start);
  const store = createGateEventStore({ dir });
  const logs = [];
  const report = new Function('gateEvents', 'readCurrentCharacter', 'pluginLog', source.slice(start, end) + '\nreturn reportMemoryBlocked;')(store, () => ({ id: 'app', epoch: 8 }), value => logs.push(value));
  for (let i = 0; i < 5; i++) report({ code: 'MEMORY_POLICY_DENIED', channel: 'qq', conversationKey: 'group:123', error: 'PRIVATE SECRET /Users/fixture' });
  let events = store.list().events;
  assert.equal(events.length, 1); assert.equal(events[0].level, 'L1'); assert.equal(logs.length, 1);
  assert.equal(events[0].subject.conversationKey, 'group:123'); assert.match(events[0].reason.message, /QQ group:123/); assert.match(events[0].recommendation, /白名单卡片/);
  assert.equal(JSON.stringify(events).includes('PRIVATE SECRET'), false);
  store.ack([events[0].id]);
  report({ code: 'MEMORY_POLICY_DENIED', channel: 'qq', conversationKey: 'group:123' });
  assert.equal(store.list({ includeAcked: false }).events.length, 0); assert.equal(logs.length, 1);
  report({ code: 'MEMORY_POLICY_DENIED', channel: 'local' });
  assert.match(store.list().events.find(row => row.subject.channel === 'local').recommendation, /不需要批准其他渠道/);
  report({ code: 'MEMORY_NATIVE_UNSAFE', channel: 'qq' });
  assert.equal(store.list().events.find(row => row.event === 'MEMORY_NATIVE_UNSAFE').level, 'L2');
  console.log('PASS actual Host failure reporter: scoped setup L1, persistent dedupe, actionable QQ entry, no permission expansion, genuine failures remain modal');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
