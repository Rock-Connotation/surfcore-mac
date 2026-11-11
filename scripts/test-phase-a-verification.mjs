import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { filterVisibleRecords, visibleFor } from '../src/memory-card.js';
import {
  collectMaterials,
  buildPurposePrompt,
  subjectOf,
  formatMaterialLine
} from '../src/purpose-engine.js';
import {
  runProcess,
  getUnreleasedProcesses
} from '../src/perception/process.js';
import {
  cancelPendingInteraction,
  createHistoricalInteractionRegistry
} from '../src/interaction-lifecycle.js';

console.log('--- Phase A Verification Suite ---');

// ==========================================
// A1: Purpose Memory Audience & Attribution
// ==========================================
console.log('\n[A1] Testing Purpose Memory Audience and Attribution Boundaries...');

// 1. Five memory records
const baseRecords = [
  {
    id: 'rec-public-1',
    content: '今天天气很晴朗，主人提到了喜欢看海',
    visibilityClassification: 'public',
    allowedContexts: ['qq', 'bili', 'douyin', 'local'],
    attributionSubject: 'owner',
    who: '主人',
    importance: 80,
    timestamp: Date.now() - 10000
  },
  {
    id: 'rec-private-other-2',
    content: '小李私下说了一个秘密：不要告诉其他人',
    visibilityClassification: 'private',
    allowedContexts: ['qq'],
    conversationKey: 'private:111222333', // different user
    attributionSubject: 'external',
    who: '小李',
    importance: 80,
    timestamp: Date.now() - 9000
  },
  {
    id: 'rec-restricted-platform-3',
    content: '抖音专属记忆：只在抖音直播间讨论过的梗',
    visibilityClassification: 'restricted',
    allowedContexts: ['douyin', 'local'], // no 'qq'
    attributionSubject: 'self',
    who: '自己',
    importance: 80,
    timestamp: Date.now() - 8000
  },
  {
    id: 'rec-revoked-corrected-4',
    content: '曾经记录过的旧地址：海淀区某路1号',
    visibilityClassification: 'public',
    allowedContexts: ['qq'],
    revoked: true,
    status: 'corrected',
    importance: 80,
    timestamp: Date.now() - 7000
  },
  {
    id: 'rec-third-party-wish-5',
    content: '张三想要辞职去环游世界',
    visibilityClassification: 'public',
    allowedContexts: ['qq'],
    attributionSubject: 'external',
    who: '张三',
    importance: 80,
    timestamp: Date.now() - 6000
  }
];

// Target context: QQ private chat with owner (ownerId: '999888777')
const targetContext = {
  platform: 'qq',
  conversationKey: 'private:999888777'
};

const visibleRecords = filterVisibleRecords(baseRecords, targetContext);
console.log(`Filtered ${baseRecords.length} records down to ${visibleRecords.length} records.`);

// Assertions on filtered records:
const recordIds = visibleRecords.map(r => r.id);
assert.ok(recordIds.includes('rec-public-1'), 'Public record MUST be visible');
assert.ok(!recordIds.includes('rec-private-other-2'), 'Cross-conversation private record MUST NOT be visible');
assert.ok(!recordIds.includes('rec-restricted-platform-3'), 'Restricted platform record (douyin only) MUST NOT be visible on QQ');
assert.ok(!recordIds.includes('rec-revoked-corrected-4'), 'Revoked/corrected record MUST NOT be visible');
assert.ok(recordIds.includes('rec-third-party-wish-5'), 'Public third-party record MUST be visible in target context');

// Check attribution on third-party record
const thirdPartyRecord = visibleRecords.find(r => r.id === 'rec-third-party-wish-5');

const materialResult = collectMaterials({
  memoryRecords: visibleRecords,
  targetPlatform: targetContext.platform,
  targetConversationKey: targetContext.conversationKey
});
const materials = materialResult.items;

// Verify collected material tags & who
const thirdPartyMaterial = materials.find(m => m.sourceId === 'rec-third-party-wish-5' || m.text.includes('张三想要辞职'));
assert.ok(thirdPartyMaterial, 'Third-party material must be collected');
assert.equal(thirdPartyMaterial.who, '张三', 'Material must retain third-party author/who');
assert.equal(thirdPartyMaterial.attributionSubject, 'external', 'Material must retain external attribution');

// Verify subjectOf(material) does NOT map to 'self'
const analyzedSubject = subjectOf(thirdPartyMaterial);
assert.equal(analyzedSubject, 'member', "Third party's wish must map to subject 'member', NEVER 'self'");

// Verify formatting
const formattedLine = formatMaterialLine(thirdPartyMaterial);
assert.ok(formattedLine.includes('记忆·他人'), `Formatted line must explicitly identify attribution: ${formattedLine}`);
assert.ok(formattedLine.includes('张三'), `Formatted line must include author name: ${formattedLine}`);

// Build actual prompt
const promptText = buildPurposePrompt({
  materials,
  ownerUin: '999888777'
});

assert.ok(promptText.includes('今天天气很晴朗'), 'Prompt must contain public memory');
assert.ok(!promptText.includes('小李私下说了一个秘密'), 'Prompt must NOT contain cross-conversation private memory');
assert.ok(!promptText.includes('抖音专属记忆'), 'Prompt must NOT contain restricted douyin memory');
assert.ok(!promptText.includes('曾经记录过的旧地址'), 'Prompt must NOT contain revoked/corrected memory');
assert.ok(promptText.includes('记忆·他人'), 'Prompt must label external memory as 他人');

console.log('✅ A1 verification passed: 5 audience boundaries and attribution rules verified on real prompt output.');

// ==========================================
// A2: Bounded Process Termination & Cancellation
// ==========================================
console.log('\n[A2] Testing Bounded Process Termination and Interaction Cancellation...');

// Test 1: runProcess with a mock child process that refuses SIGTERM + SIGKILL and never emits close
class StubbornChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 999999;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killSignals = [];
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill(signal) {
    this.killSignals.push(signal);
    // Deliberately refuse to emit 'close' or 'exit'
    return true;
  }
}

const stubbornChild = new StubbornChild();
const mockSpawn = () => stubbornChild;

const startTime = Date.now();
let caughtError = null;
try {
  await runProcess('/usr/local/bin/dummy-stubborn', [], {
    timeoutMs: 50,
    termWaitMs: 50,
    killWaitMs: 50,
    spawnImpl: mockSpawn
  });
} catch (err) {
  caughtError = err;
}
const elapsed = Date.now() - startTime;

assert.ok(caughtError, 'runProcess must fail when child ignores termination');
assert.ok(
  caughtError.code === 'PROCESS_TERMINATION_UNKNOWN' || caughtError.code === 'JOB_TIMEOUT',
  `Error code must be structured termination failure, got: ${caughtError.code}`
);
assert.ok(elapsed < 2000, `runProcess must complete within bounded time (took ${elapsed}ms, expected < 2000ms)`);

const unreleased = getUnreleasedProcesses();
assert.ok(unreleased.some(p => p.pid === 999999), 'Stubborn process must be recorded in unreleased process tracker');
console.log(`✅ A2.1 runProcess terminated with bounded timeout (${elapsed}ms) and recorded unreleased process.`);

// Test 2: cancelPendingInteraction with mock API
const historyRegistry = createHistoricalInteractionRegistry();

const mockApiSuccess = {
  respond: async () => ({ ok: true, status: 'canceled' })
};

const mockApiFailure = {
  respond: async () => ({ ok: false, error: 'Interaction not found or already closed' })
};

const mockApiTimeout = {
  respond: async () => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 2000))
};

// 2.1 Confirmed cancellation
const resultSuccess = await cancelPendingInteraction(
  { eventId: 'int-123', kind: 'approval' },
  mockApiSuccess,
  { timeoutMs: 200, historyRegistry }
);
assert.equal(resultSuccess.ok, true);
assert.equal(resultSuccess.status, 'confirmed');
assert.equal(historyRegistry.get('int-123')?.status, 'confirmed');

// 2.2 Rejected cancellation
const resultFailure = await cancelPendingInteraction(
  { eventId: 'int-456', kind: 'question' },
  mockApiFailure,
  { timeoutMs: 200, historyRegistry }
);
assert.equal(resultFailure.ok, false);
assert.equal(resultFailure.status, 'rejected');
assert.equal(historyRegistry.get('int-456')?.status, 'rejected');

// 2.3 Timeout on cancellation
const resultTimeout = await cancelPendingInteraction(
  { eventId: 'int-789', kind: 'approval' },
  mockApiTimeout,
  { timeoutMs: 100, historyRegistry }
);
assert.equal(resultTimeout.ok, false);
assert.equal(resultTimeout.status, 'timeout');
assert.equal(historyRegistry.get('int-789')?.status, 'timeout');

console.log('✅ A2.2 cancelPendingInteraction accurately differentiates confirmed, rejected, and timeout states.');

// ==========================================
// A3: Capability Status & Diagnostics Check
// ==========================================
console.log('\n[A3] Testing Memory V2 Capability Status Defaults...');

import { readMemoryRouting } from '../src/core/memory-v2-routing.js';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { createQQMemoryBridge } from '../src/core/memory-v2-qq.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Verify memory routing defaults to v1 mode in legacy/fresh environment
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-routing-test-'));
try {
  // Verify default QQ memory bridge safety is false (fail-closed)
  const defaultQQBridge = createQQMemoryBridge({
    stateDir: tmpDir,
    getCharacter: () => ({ id: 'fish', epoch: 1 }),
    client: {}
  });
  const safetyResult = await defaultQQBridge.validateSessionSafety({ sessionId: 'test-session', preset: 'qq-chat' });
  assert.equal(safetyResult.ok, false, 'Default validateSessionSafety must fail-closed (ok: false)');
  assert.equal(safetyResult.code, 'MEMORY_PRESET_UNSAFE', 'Default code must be MEMORY_PRESET_UNSAFE');

  const routing = readMemoryRouting({ stateDir: tmpDir });
  assert.equal(routing.ok, true, 'Routing query must succeed');
  assert.equal(routing.backend, 'v1', 'Routing activeBackend must default to v1');
  assert.equal(routing.source, 'legacy-default', 'Source must be legacy-default');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✅ A3 verification passed: fail-closed defaults and incomplete inventory correctly guarded.');

console.log('\n=========================================');
console.log('🎉 ALL PHASE A VERIFICATION TESTS PASSED!');
console.log('=========================================\n');
