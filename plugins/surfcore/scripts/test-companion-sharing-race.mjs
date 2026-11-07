import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, opening, context, request, jobId } from './sharing-fixture.mjs';

if (process.argv[2] === '--child') {
  const child = fixture({ root: process.argv[3], seed: false });
  const result = await child.service.reply(context, request);
  console.log(JSON.stringify({ result, calls: child.calls.length }));
  await child.service.dispose();
  process.exit(0);
}
const f = fixture(); assert.equal((await opening(f)).ok, true);
const read = fs.readFileSync;
let raced = false, child;
// Pause only the filesystem scheduling boundary after capturing old bytes.
// The second process runs the same real public service, ledger and history.
fs.readFileSync = function (file, ...args) {
  const bytes = read.call(this, file, ...args);
  if (!raced && typeof file === 'number' && bytes.includes(Buffer.from('"kind":"opening"'))) {
    raced = true;
    child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', f.root], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  return bytes;
};
try {
  const result = await f.service.reply(context, request);
  const other = JSON.parse(child.stdout.trim()), ledger = f.ledger.readLedger();
  assert.equal(other.calls, 1); assert.equal(f.calls.length, 0, 'stale pre-lock history must not dispatch another paid request');
  assert.equal(result.ok, true); assert.equal(result.duplicate, true);
  assert.equal(ledger.acceptanceCalls, 9); assert.equal(ledger.jobs[jobId].calls, 3);
  assert.equal((await f.service.status(context)).messages.length, 2);
  console.log('Sharing cross-process request race: one paid call, one durable reply');
} finally { fs.readFileSync = read; await f.service.dispose(); }
