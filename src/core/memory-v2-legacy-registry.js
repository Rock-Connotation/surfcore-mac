import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// This registry records Host-verified claims; it does not verify physical lineage or grant authority.
const APP_ID = 1297502802;
const TABLE = 'CREATE TABLE segments (logical TEXT PRIMARY KEY NOT NULL, identity TEXT UNIQUE NOT NULL, stream TEXT UNIQUE NOT NULL) STRICT';
const META = 'CREATE TABLE registry_meta (id INTEGER PRIMARY KEY CHECK(id=1), checksum TEXT NOT NULL) STRICT';
const checksum = rows => createHash('sha256').update(JSON.stringify(rows.map(({ logical, identity, stream }) => [logical, identity, stream]))).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,159}$/;
const STREAM = /^legacy-stream-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = (code, error, commitState = 'not_committed') => ({ ok: false, code, error, hint: 'Keep V1 active and retain the registry and source bytes; inspect the registry through the trusted Host before retrying.', commitState });
const invalid = () => Object.assign(new Error('Registry state is invalid or corrupt.'), { registryCode: 'LEGACY_REGISTRY_CORRUPT' });
function syncParent(filePath) {
  const fd = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function inspect(db) {
  const quick = db.prepare('PRAGMA quick_check').all();
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') throw invalid();
  if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID || db.prepare('PRAGMA user_version').get().user_version !== 1) throw invalid();
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (schema.length !== 2 || !schema.some(row => row.type === 'table' && row.name === 'segments' && row.sql === TABLE) || !schema.some(row => row.type === 'table' && row.name === 'registry_meta' && row.sql === META)) throw invalid();
  const rows = db.prepare('SELECT logical,identity,stream FROM segments ORDER BY logical').all();
  const keys = new Set(), identities = new Set(), streams = new Set();
  for (const row of rows) {
    if (!ID.test(row.logical) || !ID.test(row.identity) || !STREAM.test(row.stream) || keys.has(row.logical) || identities.has(row.identity) || streams.has(row.stream)) throw invalid();
    keys.add(row.logical); identities.add(row.identity); streams.add(row.stream);
  }
  const meta = db.prepare('SELECT id,checksum FROM registry_meta').all();
  if (meta.length !== 1 || meta[0].id !== 1 || meta[0].checksum !== checksum(rows)) throw invalid();
  return rows;
}
function existingFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid();
}
function connect(filePath) {
  existingFile(filePath);
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA busy_timeout=150; PRAGMA synchronous=EXTRA;');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' || db.prepare('PRAGMA synchronous').get().synchronous !== 3) throw invalid();
    return db;
  } catch (error) { db.close(); throw error; }
}
function safelyClose(db) { try { db?.close(); } catch {} }

/** Private Host API. Segment identity must already be independently verified. */
export function openLegacyRegistry(options) {
  const { filePath, create = false } = options ?? {};
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || typeof create !== 'boolean') return failure('LEGACY_REGISTRY_ARGUMENT_INVALID', 'An absolute registry path and valid create flag are required.');
  let db, created = false;
  try {
    if (create) {
      const fd = fs.openSync(filePath, 'wx', 0o600);
      created = true;
      fs.closeSync(fd);
      db = new DatabaseSync(filePath);
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE; ${TABLE}; ${META};`);
      db.prepare('INSERT INTO registry_meta(id,checksum) VALUES(1,?)').run(checksum([]));
      db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; COMMIT;`);
      inspect(db);
      syncParent(filePath);
    } else {
      db = connect(filePath);
      db.exec('BEGIN');
      inspect(db);
      db.exec('COMMIT');
    }
  } catch (error) {
    safelyClose(db);
    return failure(created ? 'LEGACY_REGISTRY_CREATE_UNKNOWN' : (error.registryCode || 'LEGACY_REGISTRY_UNAVAILABLE'), created ? 'Registry creation did not complete with a confirmed durable outcome.' : 'Registry could not be opened and validated.', created ? 'unknown' : 'not_committed');
  }
  safelyClose(db);
  const read = () => {
    let current;
    try {
      current = connect(filePath);
      current.exec('BEGIN');
      const rows = inspect(current);
      current.exec('COMMIT');
      const streamRegistry = Object.freeze(Object.fromEntries(rows.map(row => [row.logical, row.stream])));
      return { ok: true, streamRegistry };
    } catch (error) {
      return failure(error.registryCode || 'LEGACY_REGISTRY_UNAVAILABLE', 'Registry could not be read and validated.');
    } finally { safelyClose(current); }
  };
  const register = (entry) => {
    const { logicalStreamKey, segmentIdentity } = entry ?? {};
    if (typeof logicalStreamKey !== 'string' || typeof segmentIdentity !== 'string' || !ID.test(logicalStreamKey) || !ID.test(segmentIdentity)) return failure('LEGACY_REGISTRY_ARGUMENT_INVALID', 'A logical key and previously verified opaque segment identity are required.');
    let current, transaction = false, committing = false;
    try {
      current = connect(filePath);
      current.exec('BEGIN IMMEDIATE');
      transaction = true;
      const rows = inspect(current);
      const byKey = rows.find(row => row.logical === logicalStreamKey);
      const byIdentity = rows.find(row => row.identity === segmentIdentity);
      if ((byKey && byKey.identity !== segmentIdentity) || (byIdentity && byIdentity.logical !== logicalStreamKey)) {
        current.exec('ROLLBACK'); transaction = false;
        return failure('LEGACY_REGISTRY_CONFLICT', 'A previously registered logical key or segment identity has a contradictory binding.');
      }
      const legacyStreamId = byKey?.stream ?? `legacy-stream-${randomUUID()}`;
      if (!byKey) {
        current.prepare('INSERT INTO segments(logical,identity,stream) VALUES(?,?,?)').run(logicalStreamKey, segmentIdentity, legacyStreamId);
        const nextRows = current.prepare('SELECT logical,identity,stream FROM segments ORDER BY logical').all();
        current.prepare('UPDATE registry_meta SET checksum=? WHERE id=1').run(checksum(nextRows));
      }
      committing = true;
      current.exec('COMMIT');
      transaction = false;
      return { ok: true, legacyStreamId };
    } catch (error) {
      if (transaction && !committing) { try { current.exec('ROLLBACK'); } catch {} }
      return committing
        ? failure('LEGACY_REGISTRY_COMMIT_UNKNOWN', 'Registry commit could not be confirmed.', 'unknown')
        : failure(error.registryCode || 'LEGACY_REGISTRY_UNAVAILABLE', 'Registry registration failed without a confirmed commit.');
    } finally { safelyClose(current); }
  };
  return { ok: true, read, register };
}
