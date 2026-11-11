import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-round-memory-fence-'));
process.env.DSH_HOME = path.join(root, 'dsh');
process.env.SURFCORE_ROOT = path.join(root, 'repo');
fs.mkdirSync(path.join(process.env.SURFCORE_ROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(process.env.SURFCORE_ROOT, 'config.json'), '{}');
fs.writeFileSync(path.join(process.env.SURFCORE_ROOT, 'src', 'bridge.js'), '// fixture only\n');
const { QQ_STATE_DIR } = await import('../lib/paths.js');
assert.ok(QQ_STATE_DIR.startsWith(root + path.sep), 'routing must stay inside the isolated fixture');
const { biliContextForRound } = await import('../lib/scheduler.js');
const { writeMemoryRouting } = await import('../../../src/core/memory-v2-routing.js');
fs.mkdirSync(QQ_STATE_DIR, { recursive: true });
const originalRead = fs.readFileSync;
let legacyReads = 0;
fs.readFileSync = function (file, ...args) {
  if (/(?:persona\.md|MEMORY\.md|memory-card\.json|life\.md|purpose\.json)$/.test(String(file))) {
    legacyReads++; throw new Error('Legacy context must not be read');
  }
  return originalRead.call(this, file, ...args);
};
try {
  const before = biliContextForRound({ characterId: 'fixture', characterEpoch: 1 });
  assert.notEqual(before.code, 'BILI_V2_MANAGED_ROUND_REQUIRED');
  const explicit = biliContextForRound({ characterId: 'fixture', characterEpoch: 1, memoryBackend: 'v2' });
  assert.equal(explicit.ok, false); assert.equal(explicit.code, 'BILI_V2_MANAGED_ROUND_REQUIRED'); assert.ok(explicit.hint); assert.equal(explicit.text, '');
  assert.equal(writeMemoryRouting({ stateDir: QQ_STATE_DIR, status: { ok: true, activeBackend: 'v2', revision: 1, storeGeneration: 'fixture-generation', minCompatibleReader: 1 } }).ok, true);
  const missingControl = biliContextForRound({ characterId: 'fixture', characterEpoch: 1 });
  assert.equal(missingControl.code, 'MEMORY_CONTROL_UNAVAILABLE'); assert.ok(missingControl.hint); assert.equal(missingControl.text, '');
  new DatabaseSync(path.join(QQ_STATE_DIR, 'memory-control.sqlite')).close();
  const selected = biliContextForRound({ characterId: 'fixture', characterEpoch: 1 });
  assert.equal(selected.ok, false); assert.equal(selected.code, 'BILI_V2_MANAGED_ROUND_REQUIRED'); assert.ok(selected.error && selected.hint); assert.equal(selected.text, ''); assert.deepEqual(selected.sections, []);
  assert.equal(legacyReads, 0);

  // Managed V2 connection produces character context without reading legacy memory files
  let legacyMemoryReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (/(?:MEMORY\.md|memory-card\.json|life\.md|purpose\.json)$/.test(String(file))) {
      legacyMemoryReads++; throw new Error('Legacy memory must not be read in V2');
    }
    return originalRead.call(this, file, ...args);
  };
  const charactersDir = path.join(process.env.DSH_HOME, 'surfcore', 'characters');
  fs.mkdirSync(path.join(charactersDir, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(charactersDir, 'current.json'), JSON.stringify({ version: 1, id: 'fixture', name: 'FixtureRole', epoch: 1 }));
  const managed = biliContextForRound({ characterId: 'fixture', characterEpoch: 1, v2: true });
  assert.equal(managed.ok, true);
  assert.equal(typeof managed.text, 'string');
  assert.equal(legacyMemoryReads, 0);

  // Scheduler retirement returns V2 retirement ACK
  const { startScheduler } = await import('../lib/scheduler.js');
  const mockBiliV2Agent = { retire: async () => ({ ok: false, code: 'BILI_V2_RETIRE_UNCONFIRMED', error: 'Pending retirement', hint: 'Wait for ACK' }) };
  const mockScheduler = startScheduler({ get: () => null }, { dshHome: path.join(root, 'dsh'), biliMjs: path.join(root, 'bili.mjs'), biliV2Agent: mockBiliV2Agent });
  const retired = await mockScheduler.retire();
  assert.equal(retired.ok, false);
  assert.equal(retired.code, 'BILI_V2_RETIRE_UNCONFIRMED');

  console.log('PASS selected V2 and explicit V2 block legacy round composition before reading old persona or memory; V1 branch preserved; managed V2 and retire ACK verified');
} finally { fs.readFileSync = originalRead; }
