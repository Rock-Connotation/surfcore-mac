import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSpool, readSpool, writeFully } from '../src/core/memory-v2-spool.js';
import { canonical, MAX_PART_BYTES, normalizeEvent, redactContent, safeHead } from '../src/core/memory-v2-contract.js';

const root = path.resolve('_backups/memory-v2-kernel', `spool-${process.version}-${randomUUID()}`);
fs.mkdirSync(root, { recursive: true });
const ctx = { characterId: 'alpha', capturedEpoch: 1, channel: 'qq', conversationKey: 'qq:login:group:one', sourceAccountKey: 'qq:login:actor:a', audiencePolicyId: 'private', processingGrantId: 'grant-one' };
let count = 0;
function good(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function bad(result, code) { assert.equal(result.ok, false); assert.equal(result.code, code); assert.ok(result.error); assert.ok(result.hint); return result; }
function test(name, run) { run(); count++; console.log(`PASS ${name}`); }
const raw = (id, content = '没有答应见面，只是引用过一个计划。') => ({ eventId: id, sourceKey: `source:${id}`, operationId: `event-op:${id}`, producerId: 'producer-one', segmentId: 'segment-one', producerSeq: 1, content, subject: 'qq:login:actor:a' });
const file = (name, text) => { const target = path.join(root, name); fs.writeFileSync(target, text); return target; };

test('full-string privacy before stable UTF-8 segmentation without legacy clipping', () => {
  const text = `${'甲😀 '.repeat(24000)}token=private-synthetic-value 中文，https://example.invalid/path password=not-a-real-secret`;
  const spool = good(createSpool({ directory: path.join(root, 'large'), producerId: 'producer-one', segmentId: 'large', context: ctx }));
  const appended = good(spool.append({ ...raw('large'), content: text, coverage: { note: 'password=metadata-synthetic' } }));
  assert.equal(appended.acceptance, 'queued_durable');
  assert.ok(appended.events.length > 1);
  assert.equal(appended.events.map((item) => item.content).join(''), redactContent(text, { scope: 'qq' }));
  assert.ok(appended.events.every((item) => Buffer.byteLength(item.content) <= MAX_PART_BYTES && !/[\uD800-\uDBFF]$/.test(item.content)));
  assert.ok(appended.events.reduce((sum, item) => sum + item.content.length, 0) > 4000);
  const bytes = fs.readFileSync(spool.file, 'utf8');
  for (const [, secret] of text.matchAll(/(?:token|password)=([^\s]+)/g)) assert.ok(!bytes.includes(secret));
  assert.ok(!bytes.includes('example.invalid'));
  assert.equal(appended.events[0].coverage.note, 'password=[已隐藏]');
  const again = normalizeEvent({ ...raw('large'), content: text, coverage: { note: 'password=metadata-synthetic' }, producerId: 'producer-one', segmentId: 'large' }, ctx);
  assert.equal(canonical(again), canonical(appended.events));
  good(spool.seal());
  const batch = good(readSpool({ file: spool.file }));
  assert.equal(batch.events.length, appended.events.length); assert.equal(batch.nextOffset, appended.nextOffset);
});
test('short writes advance bytes until the complete newline is durable', () => {
  let writes = 0;
  const io = { ...fs, writeSync(fd, bytes, offset, length, position) { writes++; return fs.writeSync(fd, bytes, offset, Math.min(7, length), position); } };
  const spool = good(createSpool({ directory: path.join(root, 'short'), producerId: 'producer-one', segmentId: 'short', context: ctx, io }));
  const appended = good(spool.append(raw('short'))); good(spool.seal());
  assert.ok(writes > 1); assert.equal(fs.statSync(spool.file).size, appended.nextOffset);
  assert.equal(good(readSpool({ file: spool.file })).events.length, 1);
});
test('zero write and fsync failures retire the segment with actionable failures', () => {
  assert.throws(() => writeFully(1, Buffer.from('a'), { writeSync: () => 0 }), { code: 'MEMORY_SPOOL_SHORT_WRITE' });
  const zero = good(createSpool({ directory: path.join(root, 'zero'), producerId: 'p', segmentId: 'zero', context: ctx, io: { ...fs, writeSync: () => 0 } }));
  bad(zero.append(raw('zero')), 'MEMORY_SPOOL_SHORT_WRITE'); bad(zero.append(raw('zero-again')), 'MEMORY_SPOOL_RETIRED'); bad(zero.seal(), 'MEMORY_SPOOL_RETIRED');
  let syncs = 0;
  const failed = good(createSpool({ directory: path.join(root, 'sync'), producerId: 'p', segmentId: 'sync', context: ctx, io: { ...fs, fsyncSync(fd) { if (++syncs === 1) throw new Error('synthetic fsync failure'); return fs.fsyncSync(fd); } } }));
  bad(failed.append(raw('sync')), 'MEMORY_SPOOL_WRITE_FAILED'); bad(failed.seal(), 'MEMORY_SPOOL_RETIRED');
  assert.ok(fs.statSync(failed.file).size > 0);
});
test('incomplete final line never advances the cursor; a bad complete line never skips', () => {
  const event = normalizeEvent(raw('valid'), ctx)[0], prefix = `${canonical(event)}\n`;
  const partial = file('partial.jsonl', `${prefix}{"not-complete"`);
  const read = good(readSpool({ file: partial })); assert.equal(read.events.length, 1); assert.equal(read.nextOffset, Buffer.byteLength(prefix)); assert.equal(read.incompleteTail, true);
  const tail = good(readSpool({ file: partial, offset: read.nextOffset })); assert.equal(tail.events.length, 0); assert.equal(tail.nextOffset, read.nextOffset);
  const broken = file('broken.jsonl', `${prefix}{bad}\n${prefix}`);
  const stopped = bad(readSpool({ file: broken }), 'MEMORY_SPOOL_BAD_LINE'); assert.equal(stopped.nextOffset, 0); assert.equal(stopped.badOffset, Buffer.byteLength(prefix)); assert.equal(stopped.events.length, 0);
});
test('offset shrink, line boundary, mixed identity and duplicate segment refuse safely', () => {
  const a = normalizeEvent(raw('a'), ctx)[0], b = normalizeEvent({ ...raw('b'), producerId: 'other' }, ctx)[0];
  const target = file('bounds.jsonl', `${canonical(a)}\n`);
  bad(readSpool({ file: target, offset: fs.statSync(target).size + 1 }), 'MEMORY_SPOOL_OFFSET_AHEAD');
  bad(readSpool({ file: target, offset: 2 }), 'MEMORY_SPOOL_OFFSET_INVALID');
  bad(readSpool({ file: file('mixed.jsonl', `${canonical(a)}\n${canonical(b)}\n`) }), 'MEMORY_SPOOL_IDENTITY_CONFLICT');
  const first = good(createSpool({ directory: path.join(root, 'exclusive'), producerId: 'p', segmentId: 'same', context: ctx })); good(first.seal());
  bad(createSpool({ directory: path.join(root, 'exclusive'), producerId: 'p', segmentId: 'same', context: ctx }), 'MEMORY_SPOOL_SEGMENT_EXISTS');
});
test('UTF-16 safe head preserves an emoji boundary and redaction across old limit', () => {
  assert.equal(safeHead('甲😀乙', 2), '甲');
  const normalized = normalizeEvent(raw('over-limit', `${'文'.repeat(5000)} password=synthetic-after-old-limit`), ctx);
  assert.ok(normalized[0].content.length > 4000); assert.ok(!normalized[0].content.includes('synthetic-after-old-limit'));
});
console.log(`Memory V2 spool: ${count} checks passed; runtime ${process.version}; fixtures ${root}`);
