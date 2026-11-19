import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const bridge = read('src/bridge.js');
const pet = read('plugins/surfcore/lib/pet-chat.js');
const scheduler = read('plugins/surfcore/lib/scheduler.js');
const host = read('plugins/surfcore/lib/index.js');
const client = read('plugins/surfcore/lib/client.js');

assert.match(bridge, /nativeMemoryClient\.requestQQReply\(/);
assert.match(bridge, /qqMemory\.captureSource\(/);
assert.doesNotMatch(bridge, /usesMemoryV2\b|auditAndSend\b|createOutbox\b|memoryCardPromptBlock\b|recordMemoryInboxEvent\b/);
assert.doesNotMatch(pet, /appendMemoryInboxEvent\b|memoryCardPromptBlock\b/);
assert.match(scheduler, /biliV2Agent\.enqueue\(/);
assert.doesNotMatch(scheduler, /memoryCardPromptBlock\b|qqMemoryBlockForBili\b/);
assert.match(host, /memoryV2\.handleManagement\(/);
assert.doesNotMatch(host, /handleMemoryCard\b|handleMemoryCardFull\b/);
assert.match(client, /h\(MemoryV2Panel/);
assert.doesNotMatch(client, /\/memory-card|MemoryCardPanel/);

const harness = await bridgeHarness();
try {
  const archive = path.join(harness.temp, 'dsh', 'surfcore', 'memory');
  fs.mkdirSync(archive, { recursive: true });
  const prompt = path.join(archive, 'memory-card-prompt-qq.md');
  const inbox = path.join(archive, 'memory-inbox.jsonl');
  fs.writeFileSync(prompt, 'retired-archive-canary\n');
  fs.writeFileSync(inbox, 'existing-archive-bytes\n');
  const key = 'private:123';
  await harness.handleIncoming('private', '123', { self_id: 1, user_id: 123, message_id: 456,
    message: [{ type: 'text', data: { text: '测试 V2 私聊' } }] }, harness.cfg);
  assert.equal(harness.calls.nativeReplies.length, 1);
  assert.equal(harness.calls.prompts.length, 0);
  assert.doesNotMatch(harness.currentRoleHint(key), /retired-archive-canary/);
  assert.equal(fs.readFileSync(inbox, 'utf8'), 'existing-archive-bytes\n');
  assert.equal(fs.readFileSync(prompt, 'utf8'), 'retired-archive-canary\n');
} finally {
  await harness.close();
}

console.log('PASS V2-only production wiring and unchanged V1 archive');
