import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenBudgetService } from '../lib/token-budget.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-durable-budget-'));
const service = createTokenBudgetService({ ctx: {}, dshHome: home, qqStateDir: path.join(home, 'qq'), log: () => {} });
const usage = { category: 'other', model: 'workbuddy/hy3', usage: { uncachedInputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
const rename = fs.renameSync, sync = fs.fsyncSync;
try {
  let syncs = 0;
  fs.fsyncSync = (...args) => { syncs++; return sync(...args); };
  assert.equal(service.recordExternalUsage({ ...usage, durable: true }), true);
  assert.ok(syncs >= 2, 'durable acceptance must sync both usage files');
  fs.fsyncSync = sync;
  for (const target of [service.stateFile, service.dailyFile]) {
    fs.renameSync = (...args) => { if (args[1] === target) throw Object.assign(new Error('fixture write failure'), { code: 'EIO' }); return rename(...args); };
    assert.equal(service.recordExternalUsage({ ...usage, durable: true }), false, 'write failure cannot acknowledge usage');
    fs.renameSync = rename;
  }
  fs.fsyncSync = () => { throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' }); };
  assert.equal(service.recordExternalUsage({ ...usage, durable: true }), false, 'sync failure cannot acknowledge usage');
  let legacySyncs = 0;
  fs.fsyncSync = () => { legacySyncs++; throw new Error('legacy must stay batched'); };
  assert.equal(service.recordExternalUsage(usage), true); assert.equal(legacySyncs, 0, 'default contract stays buffered');
  fs.fsyncSync = sync;
  assert.equal(service.recordExternalUsage({ ...usage, durable: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(service.stateFile)).categories.other.tokens, 18, 'failed acknowledgements retain accrued usage for reconciliation');
  console.log('PASS durable usage: successful sync, state/daily write failure, sync failure, legacy batching, retained accrual');
} finally { fs.renameSync = rename; fs.fsyncSync = sync; service.dispose(); }
