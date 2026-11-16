import assert from 'node:assert/strict';
import fs from 'node:fs';
const client = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
const host = fs.readFileSync(new URL('../plugins/surfcore/lib/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(client, /MemoryCardPanel|["']\/memory-card/);
assert.doesNotMatch(host, /handleMemoryCard|["']\/memory-card/);
assert.match(client, /h\(MemoryV2Panel/);
assert.match(host, /memoryV2\.handleManagement/);
console.log('PASS V2 management is the sole memory settings entry point');
