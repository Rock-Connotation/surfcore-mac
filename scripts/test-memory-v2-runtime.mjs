// Isolated P0 capability gate. Uses the Node 22.13 API surface; never imports SurfCore/profile code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const script = fileURLToPath(import.meta.url);
const evidenceRoot = fileURLToPath(new URL('../_backups/memory-v2-p0/', import.meta.url));
const hint = 'Keep V1 active; do not transfer data ownership. Use a supported bundled runtime and rerun this isolated gate.';
const unsupported = (error) => ({ ok: false, code: 'MEMORY_BACKEND_UNSUPPORTED', error: String(error?.message ?? error), hint, retainV1: true });
const flags = process.execArgv.filter((arg) => ['--expose-internals', '--experimental-sqlite'].includes(arg));

function validateFixture(directory) {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(evidenceRoot));
  assert.match(path.basename(resolved), /^run-/);
  assert.equal(fs.readFileSync(path.join(resolved, '.fixture'), 'utf8'), 'surfcore-memory-v2-p0\n');
  return resolved;
}

async function sqliteModule() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 13), 'Node >=22.13.0 required');
  const sqlite = await import('node:sqlite');
  assert.equal(typeof sqlite.DatabaseSync, 'function');
  return sqlite;
}

function configure(db) {
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=150;');
  const settings = Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout'].map((key) => [key, Object.values(db.prepare(`PRAGMA ${key}`).get())[0]]));
  assert.deepEqual(settings, { journal_mode: 'delete', synchronous: 3, foreign_keys: 1, busy_timeout: 150 });
  return settings;
}

function expectSqlError(action, errcode) {
  let caught;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught, 'expected SQLite failure');
  assert.equal(caught.code, 'ERR_SQLITE_ERROR');
  assert.equal(caught.errcode & 255, errcode);
  return { code: caught.code, errcode: caught.errcode, error: caught.message };
}

function snapshot(db) {
  return JSON.stringify(db.prepare('SELECT eventId, sourceKey, payload FROM events ORDER BY eventId').all());
}

async function runWorker() {
  const directory = validateFixture(workerData.directory);
  const { DatabaseSync } = await sqliteModule();
  const filename = path.join(directory, '角色 memory.sqlite');
  let db;
  let contender;
  let backup;
  const checks = [];
  const record = (name, details = {}) => checks.push({ name, ok: true, ...details });
  try {
    db = new DatabaseSync(filename);
    const pragmas = configure(db);
    record('sqlite-import-worker-startup', { node: process.version, execPath: process.execPath, execArgv: process.execArgv, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version, filename });
    record('pragma-readback', pragmas);
    if (workerData.recover) {
      assert.equal(db.prepare("SELECT payload FROM events WHERE eventId='committed'").get().payload, 'whale 鲸 committed');
      assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE eventId='killed'").get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM crash_pages WHERE value != ?').get('stable').n, 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      db.exec("INSERT INTO events VALUES ('after-recovery', 'source-after-recovery', 'writable');");
      record('killed-transaction-recovery', { integrity: 'ok', committedPreserved: true, uncommittedAbsent: true, writable: true });
      return checks;
    }
    db.exec(`
      CREATE TABLE events(eventId TEXT PRIMARY KEY, sourceKey TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE receipts(operationId TEXT PRIMARY KEY, eventId TEXT REFERENCES events(eventId));
      CREATE TABLE ingest_offsets(producerId TEXT PRIMARY KEY, position INTEGER NOT NULL);
      CREATE TABLE crash_pages(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      BEGIN IMMEDIATE;
      INSERT INTO events VALUES ('committed', 'source-committed', 'whale 鲸 committed');
      INSERT INTO receipts VALUES ('operation-committed', 'committed');
      INSERT INTO ingest_offsets VALUES ('fixture', 1);
      COMMIT;
    `);
    const seed = db.prepare('INSERT INTO crash_pages VALUES (?, ?)');
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 512; i++) seed.run(i, 'stable');
    db.exec('COMMIT');
    db.exec("BEGIN IMMEDIATE; INSERT INTO events VALUES ('rolled-back', 'source-rollback', 'transient'); INSERT INTO receipts VALUES ('operation-rollback', 'rolled-back'); UPDATE ingest_offsets SET position=2;");
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE eventId='rolled-back'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operationId='operation-rollback'").get().n, 0);
    assert.equal(db.prepare('SELECT position FROM ingest_offsets').get().position, 1);
    record('rollback-event-receipt-offset-atomicity');
    record('primary-key-unique', expectSqlError(() => db.exec("INSERT INTO events VALUES ('committed', 'another-source', 'duplicate');"), 19));
    record('source-key-unique', expectSqlError(() => db.exec("INSERT INTO events VALUES ('another-id', 'source-committed', 'duplicate');"), 19));
    record('operation-id-unique', expectSqlError(() => db.exec("INSERT INTO receipts VALUES ('operation-committed', 'committed');"), 19));
    record('foreign-key-enforced', expectSqlError(() => db.exec("INSERT INTO receipts VALUES ('invalid', 'missing');"), 19));
    db.close();
    db = new DatabaseSync(filename);
    configure(db);
    assert.equal(db.prepare("SELECT payload FROM events WHERE eventId='committed'").get().payload, 'whale 鲸 committed');
    assert.equal(db.prepare("SELECT eventId FROM receipts WHERE operationId='operation-committed'").get().eventId, 'committed');
    record('committed-data-reopen');
    assert.equal(db.prepare('SELECT eventId FROM events WHERE instr(payload, ?) > 0').get('鲸').eventId, 'committed');
    assert.equal(db.prepare('SELECT eventId FROM events WHERE payload LIKE ?').get('%whale%').eventId, 'committed');
    record('basic-lexical-search');
    let fts5;
    try { db.exec('CREATE VIRTUAL TABLE search_fts USING fts5(payload)'); fts5 = true; }
    catch (error) {
      assert.match(error.message, /no such module: fts5/i);
      fts5 = false;
    }
    if (fts5) {
      db.exec("INSERT INTO search_fts VALUES ('whale memory')");
      assert.equal(db.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'whale'").get().n, 1);
    }
    record('optional-fts5', { available: fts5, requiredForBaseGate: false });
    contender = new DatabaseSync(filename);
    configure(contender);
    db.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    const busy = expectSqlError(() => contender.exec("INSERT INTO events VALUES ('contender', 'source-contender', 'lock');"), 5);
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs >= 100 && elapsedMs < 3000, `bounded busy timeout: ${elapsedMs}ms`);
    db.exec('ROLLBACK');
    contender.exec("INSERT INTO events VALUES ('contender', 'source-contender', 'after lock release');");
    contender.close();
    contender = null;
    record('lock-contention-and-release', { ...busy, elapsedMs });
    const backupFile = path.join(directory, 'independent backup.sqlite');
    const beforeBackup = snapshot(db);
    // VACUUM INTO is SQLite SQL supported by Node 22.13; no newer sqlite.backup API.
    db.prepare('VACUUM INTO ?').run(backupFile);
    db.exec("INSERT INTO events VALUES ('after-backup', 'source-after-backup', 'later');");
    backup = new DatabaseSync(backupFile);
    configure(backup);
    assert.equal(snapshot(backup), beforeBackup);
    assert.notEqual(snapshot(db), beforeBackup);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(backup.prepare('SELECT position FROM ingest_offsets').get().position, 1);
    assert.equal(backup.prepare('SELECT count(*) AS n FROM receipts').get().n, 1);
    backup.close();
    backup = null;
    db.close();
    db = null;
    backup = new DatabaseSync(backupFile);
    assert.equal(snapshot(backup), beforeBackup);
    record('consistent-independent-backup-reopen', { method: 'VACUUM INTO', sourceClosedBeforeFinalReopen: true, laterSourceWriteAbsent: true, integrity: 'ok' });
    return checks;
  } finally {
    backup?.close();
    contender?.close();
    db?.close();
  }
}

async function workerProbe(directory, recover = false) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { directory, recover }, execArgv: flags });
  return new Promise((resolve, reject) => {
    let message;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('worker deadline exceeded (20000ms)')); }, 20000);
    worker.once('message', (value) => { message = value; });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, 'worker exits cleanly');
        assert.equal(message?.ok, true, JSON.stringify(message));
        resolve([...message.checks, { name: recover ? 'recovery-worker-clean-exit' : 'worker-clean-exit', ok: true, exitCode: code }]);
      } catch (error) { reject(error); }
    });
  });
}

async function crashChild() {
  const directory = validateFixture(process.argv[3]);
  const { DatabaseSync } = await sqliteModule();
  const db = new DatabaseSync(path.join(directory, '角色 memory.sqlite'));
  configure(db);
  db.exec('PRAGMA cache_size=8; BEGIN IMMEDIATE;');
  const update = db.prepare('UPDATE crash_pages SET value=? WHERE id=?');
  for (let i = 0; i < 512; i++) update.run('uncommitted'.repeat(256), i);
  db.exec("INSERT INTO events VALUES ('killed', 'source-killed', 'must disappear');");
  assert.ok(fs.statSync(path.join(directory, '角色 memory.sqlite-journal')).size > 512);
  process.send({ ready: true, transactionOpen: true, journalPresent: true, node: process.version });
  setInterval(() => {}, 1000);
}

async function killOpenTransaction(directory) {
  const child = fork(script, ['--crash-child', directory], {
    execArgv: flags,
    env: { PATH: process.env.PATH, HOME: directory, DSH_HOME: directory, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let ready;
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`crash-child deadline exceeded (15000ms): ${output}`)); }, 15000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output = (output + data).slice(-4000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('message', (message) => {
      ready = message;
      child.kill('SIGKILL');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(ready?.ready, true, output);
        assert.equal(ready.transactionOpen, true);
        assert.equal(ready.journalPresent, true);
        assert.equal(signal, 'SIGKILL');
        resolve({ name: 'force-kill-open-transaction', ok: true, ...ready, exitCode: code, signal });
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(evidenceRoot, 'run-'));
  fs.writeFileSync(path.join(directory, '.fixture'), 'surfcore-memory-v2-p0\n', { flag: 'wx' });
  const report = { ok: false, scope: 'bundled-executable-only; actual Host loaded plugin is unverified', runtime: { node: process.version, execPath: process.execPath, execArgv: process.execArgv, platform: process.platform, arch: process.arch }, directory, checks: [], artifacts: 'Retained in the fresh fixture directory on success and failure; no production profile access.' };
  let ticks = 0;
  const interval = setInterval(() => { ticks++; }, 10);
  try {
    await sqliteModule();
    report.checks.push({ name: 'sqlite-main-import', ok: true });
    const failure = unsupported(new Error('injected missing node:sqlite capability'));
    assert.equal(failure.code, 'MEMORY_BACKEND_UNSUPPORTED');
    assert.ok(failure.error && failure.hint && failure.retainV1 && !failure.ok);
    report.checks.push({ name: 'unsupported-structured-envelope', ok: true, fixture: failure });
    report.checks.push(...await workerProbe(directory));
    assert.ok(ticks >= 5, `main-thread timer runs while worker blocks on SQLite: ${ticks}`);
    report.checks.push({ name: 'main-event-loop-remains-responsive', ok: true, ticks });
    report.checks.push(await killOpenTransaction(directory));
    report.checks.push(...await workerProbe(directory, true));
    report.ok = true;
  } catch (error) {
    Object.assign(report, unsupported(error));
    process.exitCode = 1;
  } finally {
    clearInterval(interval);
    report.checkCount = report.checks.length;
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
  }
}

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, checks: await runWorker() }); }
  catch (error) { parentPort.postMessage(unsupported(error)); }
} else if (process.argv[2] === '--crash-child') {
  try { await crashChild(); }
  catch (error) { console.error(JSON.stringify(unsupported(error))); process.exitCode = 1; }
} else {
  await main();
}
