import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, characterId, digest, fail, identifier, requireThat, SCHEMA_VERSION, terms, validateEvent } from './memory-v2-contract.js';

const FORMAT = 1;
const KERNEL = 2;
const compatible = (version) => Number.isSafeInteger(version) && version >= FORMAT && version <= KERNEL;
const ROLE_TABLES = ['metadata', 'events', 'memories', 'memory_versions', 'links', 'operations', 'ingest_offsets', 'search_docs', 'terms', 'jobs', 'source_sequence', 'source_clock'];
const json = JSON.parse;
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const uid = (value) => { requireThat(typeof value === 'string' && /^[a-z]+-[a-f0-9]{32}$/.test(value), 'MEMORY_LIFECYCLE_ID_INVALID', 'Use an issued managed lifecycle ID.'); return value; };
function sync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function write(file, value) { fs.writeFileSync(file, canonical(value), { flag: 'wx', mode: 0o600 }); sync(file); syncDir(path.dirname(file)); }
function regular(file) { const st = fs.lstatSync(file); requireThat(st.isFile() && !st.isSymbolicLink(), 'MEMORY_LIFECYCLE_PATH_INVALID', 'Lifecycle files must be ordinary managed files.'); return st; }
function remove(file) { regular(file); const absolute = path.resolve(file); requireThat(absolute === fs.realpathSync(file), 'MEMORY_LIFECYCLE_PATH_INVALID', 'Refusing to remove a linked or redirected file.'); fs.unlinkSync(absolute); syncDir(path.dirname(absolute)); }
function inside(root, file) { const resolved = path.resolve(file), rel = path.relative(fs.realpathSync(root), resolved); requireThat(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'MEMORY_LIFECYCLE_PATH_INVALID', 'The path is outside its fixed managed root.'); return resolved; }
function verifiedDb(file, role = false) {
  regular(file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    requireThat(db.prepare('PRAGMA integrity_check').all().every((r) => Object.values(r)[0] === 'ok') && db.prepare('PRAGMA foreign_key_check').all().length === 0, 'MEMORY_SNAPSHOT_INVALID', 'A lifecycle database failed integrity or foreign-key validation.');
    if (role) requireThat(ROLE_TABLES.every((name) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)), 'MEMORY_SNAPSHOT_INVALID', 'The role snapshot schema is incomplete.');
    return { bytes: fs.statSync(file).size, sha256: sha(file), userVersion: Object.values(db.prepare('PRAGMA user_version').get())[0] };
  } finally { db.close(); }
}
function copy(file, destination) { regular(file); fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL); sync(destination); requireThat(fs.statSync(destination).ino !== fs.statSync(file).ino || fs.statSync(destination).dev !== fs.statSync(file).dev, 'MEMORY_SNAPSHOT_INVALID', 'A backup must have independent storage, not a hard link.'); }
function snapshot(db, target) { db.prepare('VACUUM INTO ?').run(target); sync(target); return verifiedDb(target); }
function replaceManaged(file, next, quarantine) {
  requireThat(!fs.existsSync(quarantine), 'MEMORY_LIFECYCLE_PATH_INVALID', 'A preserved source already exists.');
  fs.renameSync(file, quarantine);
  try { fs.renameSync(next, file); syncDir(path.dirname(file)); }
  catch (error) { if (!fs.existsSync(file)) fs.renameSync(quarantine, file); throw error; }
}

export function checkLifecycleControl(stateDir, charactersDir) {
  const marker = path.join(stateDir, 'memory-v2.lifecycle.json');
  if (!fs.existsSync(marker)) return;
  const info = json(fs.readFileSync(marker, 'utf8'));
  requireThat(info.format === FORMAT && compatible(info.minimumCompatibleKernel), 'MEMORY_LIFECYCLE_INCOMPATIBLE', 'The lifecycle compatibility lower bound is unknown.', 'Use a compatible kernel; never replace or reset the current controls.');
  const controlFile=path.join(stateDir,'memory-control.sqlite'); let available=false;
  if(fs.existsSync(controlFile)) {
    try {
      verifiedDb(controlFile); const db=new DatabaseSync(controlFile,{readOnly:true});
      try { const current=db.prepare('SELECT revision FROM state WHERE id=1').get(); available=Number.isSafeInteger(current?.revision) && current.revision >= (info.minimumControlRevision ?? 0) && ['policies','root_controls','lifecycle_ops','role_generations','source_tombstones',...(info.minimumCompatibleKernel >= 2 ? ['admin_request_bindings','admin_operations','identity_persons','identity_bindings','identity_invalidations'] : [])].every((name)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); } finally {db.close();}
    } catch {}
    if(available) return;
  }
  for (const id of info.characters ?? []) {
    characterId(id);
    const generations = path.join(charactersDir, id, 'memory', 'generations');
    if (!fs.existsSync(generations)) continue;
    const quarantine = path.join(charactersDir, id, 'memory', 'quarantine'); fs.mkdirSync(quarantine, { recursive: true });
    fs.renameSync(generations, path.join(quarantine, `${fs.existsSync(controlFile)?'unknown':'missing'}-control-${randomUUID()}`));
  }
  requireThat(false, fs.existsSync(controlFile)?'MEMORY_CURRENT_CONTROL_UNKNOWN':'MEMORY_CURRENT_CONTROL_MISSING', 'Current installation controls are missing, invalid or behind the durable control high-water; candidates were quarantined.', 'Recover the latest installation controls. Do not restore old backup controls or enable automatic recall.');
}

export function createLifecycle({ stateDir, charactersDir, control, role, closeRole, transaction, state, generation, now, fault, materializeControls, applyRoleControls }) {
  const base = path.join(stateDir, 'memory-v2-lifecycle'), backups = path.join(base, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  control.exec(`CREATE TABLE IF NOT EXISTS lifecycle_ops(operationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,characterId TEXT NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS role_generations(characterId TEXT PRIMARY KEY,relativeFile TEXT NOT NULL,minimumKernel INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_tombstones(characterId TEXT NOT NULL,keyType TEXT NOT NULL,keyId TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(characterId,keyType,keyId));
    CREATE TABLE IF NOT EXISTS lifecycle_backups(backupId TEXT PRIMARY KEY,characterId TEXT NOT NULL,manifestDigest TEXT NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_mappings(characterId TEXT NOT NULL,sourceKey TEXT NOT NULL,eventId TEXT NOT NULL,PRIMARY KEY(characterId,sourceKey,eventId));`);
  const marker = path.join(stateDir, 'memory-v2.lifecycle.json');
  function mark(id, minimumKernel = FORMAT) {
    const old = fs.existsSync(marker) ? json(fs.readFileSync(marker, 'utf8')) : { format: FORMAT, minimumCompatibleKernel: FORMAT, characters: [] };
    if (old.characters.includes(id) && old.minimumCompatibleKernel >= minimumKernel) return;
    const next = `${marker}.${randomUUID()}.next`; write(next, { ...old, minimumCompatibleKernel:Math.max(old.minimumCompatibleKernel,minimumKernel), minimumControlRevision:Math.max(old.minimumControlRevision ?? 0,state().revision), characters: [...new Set([...old.characters, id])].sort() });
    fs.renameSync(next, marker); syncDir(stateDir);
  }
  function recordControlHead() {
    if(!fs.existsSync(marker)) return;
    const info=json(fs.readFileSync(marker,'utf8')), revision=state().revision;
    if((info.minimumControlRevision ?? -1) >= revision) return;
    const next=`${marker}.${randomUUID()}.next`; write(next,{...info,minimumControlRevision:revision}); fs.renameSync(next,marker); syncDir(stateDir);
  }
  recordControlHead();
  function selectedFile(id, allowMissing = false) {
    const row = control.prepare('SELECT * FROM role_generations WHERE characterId=?').get(id);
    if (!row) return path.join(charactersDir, characterId(id), 'memory', 'memory-v2.sqlite');
    requireThat(compatible(row.minimumKernel), 'MEMORY_LIFECYCLE_INCOMPATIBLE', 'This generation needs another kernel.');
    const file = inside(path.join(charactersDir, id), path.join(charactersDir, id, row.relativeFile));
    requireThat(allowMissing || fs.existsSync(file), 'MEMORY_GENERATION_MISSING', 'The selected verified generation is missing.'); return file;
  }
  function roleSource(id) {
    const selected = selectedFile(id,true);
    try { verifiedDb(selected,true); return selected; } catch {}
    for (const row of control.prepare("SELECT payload FROM lifecycle_ops WHERE characterId=? ORDER BY rowid DESC").all(id)) {
      const value = json(row.payload); if (!value.candidateId) continue;
      const preserved = path.join(charactersDir,id,'memory','quarantine',uid(value.candidateId),'previous.sqlite');
      if (fs.existsSync(preserved)) { verifiedDb(preserved,true); return preserved; }
    }
    requireThat(false,'MEMORY_GENERATION_MISSING','No verified active or preserved source generation exists.','Keep admission blocked and inspect the durable lifecycle intent and quarantined original.');
  }
  function op(id) { const row = control.prepare('SELECT * FROM lifecycle_ops WHERE operationId=?').get(identifier(id)); return row ? { ...row, payload: json(row.payload), result: json(row.result) } : null; }
  function save(row, phase, result, payload = row.payload) { control.prepare('UPDATE lifecycle_ops SET phase=?,payload=?,result=? WHERE operationId=?').run(phase, canonical(payload), canonical(result), row.operationId); return { ...row, phase, payload, result }; }
  function pending(id) { return control.prepare("SELECT operationId,phase FROM lifecycle_ops WHERE characterId=? AND phase NOT IN ('completed','backup_verified') AND kind!='backup' AND phase!='resumed'").all(id); }
  function admission(id, admin = false) { if (!admin) requireThat(pending(id).length === 0, 'MEMORY_LIFECYCLE_BLOCKED', 'A lifecycle safety barrier is awaiting verified recovery or Host retirement.', 'Open lifecycle progress, complete session retirement, and resume the original operation before reading, invoking models, or sending.'); }
  function admin(ctx, expected) {
    requireThat(ctx?.admin === true && ctx.purpose === 'admin' && ctx.storeGeneration === generation, 'MEMORY_ADMIN_REQUIRED', 'A live Host management capability is required.');
    if (expected !== undefined && expected !== null) requireThat(expected === state().revision && ctx.controlRevision === expected, 'MEMORY_REVISION_CONFLICT', 'The lifecycle preview control revision is stale.', 'Refresh the lifecycle preview against current installation controls.');
  }
  function inventory(input = {}) {
    requireThat(Array.isArray(input.sealedSpool ?? []) && Array.isArray(input.externalCopies ?? []), 'MEMORY_INVENTORY_INVALID', 'The trusted copy inventory is malformed.');
    const sealedSpool = (input.sealedSpool ?? []).map((item) => {
      identifier(item.copyId); identifier(item.producerId); identifier(item.segmentId);
      requireThat(item.sealed === true && Number.isSafeInteger(item.highWater) && item.highWater >= 0 && /^[a-f0-9]{64}$/.test(item.sha256), 'MEMORY_INVENTORY_INVALID', 'Only a sealed, hashed high-water spool can be backed up.');
      const file = path.resolve(item.path), root = [stateDir, charactersDir].find((dir) => { const rel = path.relative(dir, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
      requireThat(root && file === fs.realpathSync(file), 'MEMORY_LIFECYCLE_PATH_INVALID', 'A spool path is outside trusted managed roots or redirects through a link.'); inside(root, file);
      requireThat(regular(file).size === item.highWater && sha(file) === item.sha256, 'MEMORY_SPOOL_HIGHWATER_CHANGED', 'The sealed spool high-water or hash changed.');
      const bytes = fs.readFileSync(file); requireThat(!bytes.length || bytes.at(-1) === 10, 'MEMORY_SPOOL_INCOMPLETE', 'A sealed spool has an incomplete final line.');
      for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) { const event = validateEvent(json(line)); requireThat(event.producerId === item.producerId && event.segmentId === item.segmentId, 'MEMORY_INVENTORY_INVALID', 'Spool producer identity differs from its trusted inventory.'); }
      return { ...item, path: file };
    });
    const externalCopies = (input.externalCopies ?? []).map((item) => {
      identifier(item.copyId); identifier(item.kind);
      requireThat(['pending', 'purged', 'not-affected'].includes(item.state) && (item.state === 'pending' || typeof item.proofId === 'string'), 'MEMORY_INVENTORY_INVALID', 'Copy completion requires an explicit proof.');
      return { copyId: item.copyId, kind: item.kind, state: item.state, proofId: item.proofId ?? null };
    });
    const quota = input.quotaSnapshot ?? null;
    if (quota) { requireThat(Object.keys(quota).every((key) => ['recordedAt', 'usedRequests', 'usedTokens', 'usedCost', 'reservedRequests'].includes(key)) && Number.isFinite(Date.parse(quota.recordedAt)), 'MEMORY_INVENTORY_INVALID', 'Quota snapshot must contain only reconciliation counters and time.'); for (const [key, value] of Object.entries(quota)) if (key !== 'recordedAt') requireThat(Number.isFinite(value) && value >= 0, 'MEMORY_INVENTORY_INVALID', 'Quota counters must be nonnegative.'); }
    return { complete: input.complete === true, sealedSpool, externalCopies, quotaSnapshot: quota };
  }
  function retention() {
    const rows = control.prepare("SELECT backupId,createdAt FROM lifecycle_backups WHERE state='verified' ORDER BY createdAt DESC,backupId").all(), keep = new Set(), days = new Set(), weeks = new Set();
    for (const row of rows) { const day = Math.floor(row.createdAt / 86400000), week = Math.floor((day + 3) / 7); if (!days.has(day) && days.size < 7) { days.add(day); keep.add(row.backupId); } if (!weeks.has(week) && weeks.size < 4) { weeks.add(week); keep.add(row.backupId); } }
    return { daily: 7, weekly: 4, keep: [...keep], candidates: rows.filter((r) => !keep.has(r.backupId)).map((r) => r.backupId), automaticErasure: false };
  }
  function backupPlan(ctx, request, inv) {
    const source = roleSource(ctx.characterId), db = new DatabaseSync(source,{readOnly:true}), s = state(), ids = request.sealedSpoolIds ?? [];
    requireThat(Array.isArray(ids) && ids.length <= 100 && new Set(ids).size === ids.length, 'MEMORY_INVENTORY_INVALID', 'Select a bounded unique list of sealed spool IDs.');
    const sequence = db.prepare('SELECT commitSequence FROM metadata WHERE id=1').get().commitSequence; db.close();
    const spool = ids.map((id) => { const found = inv.sealedSpool.find((p) => p.copyId === id); requireThat(found, 'MEMORY_INVENTORY_INVALID', 'A selected spool was not provided by trusted Host inventory.'); return { copyId: found.copyId, producerId: found.producerId, segmentId: found.segmentId, highWater: found.highWater, sha256: found.sha256 }; });
    return { kind: 'backup', characterId: ctx.characterId, schemaVersion: SCHEMA_VERSION, minimumCompatibleKernel: Math.max(KERNEL, fs.existsSync(marker) ? json(fs.readFileSync(marker,'utf8')).minimumCompatibleKernel : FORMAT), controlRevision: s.revision, policyRevision: s.policyRevision, bindingRevision: s.bindingRevision, deletionRevision: s.deletionRevision, storeGeneration: generation, commitSequence: sequence, spool, scope: 'role-and-controls', quotaUse: 'reconciliation-only', retention: retention() };
  }
  function loadBackup(id) {
    uid(id); const row = control.prepare('SELECT * FROM lifecycle_backups WHERE backupId=?').get(id);
    requireThat(row?.state === 'verified', 'MEMORY_BACKUP_UNVERIFIED', 'This backup is absent, pending, or quarantined.');
    const dir = inside(backups, path.join(backups, id)), file = path.join(dir, 'manifest.json');
    requireThat(sha(file) === row.manifestDigest, 'MEMORY_MANIFEST_CORRUPT', 'The published backup manifest hash does not match.');
    const manifest = json(fs.readFileSync(file, 'utf8'));
    requireThat(manifest.format === FORMAT && compatible(manifest.minimumCompatibleKernel) && manifest.characterId === row.characterId, 'MEMORY_LIFECYCLE_INCOMPATIBLE', 'The backup format, compatibility bound, or role is not supported.');
    for (const item of manifest.files) {
      requireThat(typeof item.file === 'string' && /^[a-z0-9-]+\.(?:sqlite|jsonl)$/.test(item.file), 'MEMORY_MANIFEST_CORRUPT', 'A backup manifest contains an unsafe filename.');
      const target = inside(dir, path.join(dir, item.file)); regular(target);
      requireThat(fs.statSync(target).size === item.bytes && sha(target) === item.sha256, 'MEMORY_MANIFEST_CORRUPT', 'A backup component hash or size differs from its manifest.');
      if (item.kind === 'role' || item.kind === 'control') verifiedDb(target, item.kind === 'role');
    }
    return { dir, manifest };
  }
  function makeBackup(ctx, request, operationId, inv, safety = false) {
    const backupId = `backup-${digest([ctx.characterId, operationId]).slice(0, 32)}`, existing = control.prepare('SELECT state FROM lifecycle_backups WHERE backupId=?').get(backupId);
    if (existing?.state === 'verified') return { backupId, ...loadBackup(backupId) };
    const plan = backupPlan(ctx, request, inv), dir = path.join(backups, backupId);
    requireThat(!fs.existsSync(dir), 'MEMORY_BACKUP_PENDING', 'An incomplete independent backup is preserved.', 'Inspect and quarantine the incomplete copy, then issue a new preview/operation ID; do not erase it automatically.');
    control.prepare("INSERT OR IGNORE INTO lifecycle_backups VALUES(?,?,?,'pending',?)").run(backupId,ctx.characterId,'unpublished',now());
    fs.mkdirSync(dir);
    fault('backupBeforeCopy', operationId);
    const files = [];
    const source = roleSource(ctx.characterId), sourceDb = new DatabaseSync(source,{readOnly:true});
    try { for (const [kind, db] of [['control', control], ['role', sourceDb]]) { const file = `${kind}.sqlite`; snapshot(db, path.join(dir, file)); files.push({ kind, file, ...verifiedDb(path.join(dir, file), kind === 'role') }); } } finally { sourceDb.close(); }
    fault('backupAfterCopy', operationId);
    for (let i = 0; i < plan.spool.length; i++) { const item = plan.spool[i], source = inv.sealedSpool.find((p) => p.copyId === item.copyId), file = `spool-${i}.jsonl`; copy(source.path, path.join(dir, file)); files.push({ kind: 'spool', file, copyId: item.copyId, bytes: item.highWater, sha256: item.sha256, producerId: item.producerId, segmentId: item.segmentId }); }
    const manifest = { format: FORMAT, ...plan, createdAt: now(), safety, files, quotaSnapshot: inv.quotaSnapshot, quotaSnapshotAtomicWithContent: false };
    fault('backupBeforeManifest', operationId); write(path.join(dir, 'manifest.json'), manifest); syncDir(dir);
    control.prepare("UPDATE lifecycle_backups SET manifestDigest=?,state='verified' WHERE backupId=?").run(sha(path.join(dir,'manifest.json')),backupId);
    loadBackup(backupId); return { backupId, dir, manifest };
  }
  function tombstones(id) { const rows = control.prepare('SELECT keyType,keyId FROM source_tombstones WHERE characterId=?').all(id); return new Set(rows.map((row) => `${row.keyType}:${row.keyId}`)); }
  const baseSource = (key) => key.replace(/\.part-\d+-of-\d+$/, '');
  function eventDeleted(id, event, roots = []) { const denied = tombstones(id); return denied.has(`event:${event.eventId}`) || denied.has(`source:${event.sourceKey}`) || denied.has(`source:${baseSource(event.sourceKey)}`) || [event.rootEventId, ...roots].some((root) => denied.has(`root:${root}`)); }
  function cleanRole(id, sourceFiles, destination, revision) {
    const sources = sourceFiles.map((file) => { verifiedDb(file, true); return new DatabaseSync(file, { readOnly: true }); });
    const rows = Object.fromEntries(ROLE_TABLES.map((name) => [name, new Map()])), conflicts = [], removedEvents = new Set(), removedVersions = new Set();
    const key = (table, row) => canonical(table === 'memory_versions' ? [row.memoryId, row.revision] : table === 'links' ? [row.fromId, row.fromRevision, row.toId, row.toRevision, row.type] : table === 'ingest_offsets' ? [row.producerId, row.segmentId] : ['metadata', 'source_clock'].includes(table) ? [row.id] : [row.eventId ?? row.memoryId ?? row.operationId ?? row.jobId]);
    try {
      for (const src of sources) for (const table of ROLE_TABLES.filter((t) => !['search_docs', 'terms'].includes(t))) for (const row of src.prepare(`SELECT * FROM ${table}`).all()) {
        const k = key(table, row), previous = rows[table].get(k);
        if (table === 'memories' && previous && previous.currentRevision !== row.currentRevision) conflicts.push({ memoryId: row.memoryId, backupRevision: previous.currentRevision, currentRevision: row.currentRevision });
        if (table === 'events' && previous) requireThat(previous.payloadDigest === row.payloadDigest, 'MEMORY_RESTORE_SOURCE_CONFLICT', 'An immutable source differs across restore inputs.');
        if (table === 'memory_versions' && previous && previous.payloadDigest !== row.payloadDigest) { conflicts.push({ memoryId: row.memoryId, revision: row.revision }); continue; }
        if (table === 'source_clock' && previous && previous.sequence > row.sequence) continue;
        if (table === 'ingest_offsets' && previous && previous.position > row.position) continue;
        rows[table].set(k, { ...row });
      }
      const deleted = tombstones(id), blocked = new Set(control.prepare('SELECT rootId FROM root_controls WHERE characterId=?').all(id).map((r) => r.rootId));
      for (const [k, row] of rows.events) if (eventDeleted(id, json(row.payload), json(row.roots))) { removedEvents.add(row.eventId); rows.events.delete(k); }
      for (const [key, row] of rows.source_sequence) if (removedEvents.has(row.eventId)) rows.source_sequence.delete(key);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [k, row] of rows.memory_versions) {
          const payload = json(row.payload), refs = payload.inputManifest ?? [];
          if (json(row.roots).some((root) => deleted.has(`root:${root}`)) || refs.some((ref) => ref.type === 'event' ? removedEvents.has(ref.id) : removedVersions.has(canonical([ref.id, ref.revision])))) { removedVersions.add(canonical([row.memoryId, row.revision])); rows.memory_versions.delete(k); changed = true; }
        }
      }
      for (const row of rows.events.values()) if (json(row.roots).some((root) => blocked.has(root))) row.status = 'suppressed';
      for (const row of rows.memory_versions.values()) if (json(row.roots).some((root) => blocked.has(root))) row.status = 'invalidated';
      for (const [k, memory] of rows.memories) {
        const remaining = [...rows.memory_versions.values()].filter((v) => v.memoryId === memory.memoryId);
        if (!remaining.length) { rows.memories.delete(k); continue; }
        if (!remaining.some((v) => v.revision === memory.currentRevision)) { memory.currentRevision = Math.max(...remaining.map((v) => v.revision)); memory.status = 'invalidated'; }
        if (conflicts.some((c) => c.memoryId === memory.memoryId)) { memory.status = 'review_pending'; for (const version of remaining) if (version.status === 'active') version.status = 'review_pending'; }
      }
      for (const [k, link] of rows.links) if (!rows.memory_versions.has(canonical([link.fromId, link.fromRevision])) || !rows.memory_versions.has(canonical([link.toId, link.toRevision]))) rows.links.delete(k);
      for (const [k, operation] of rows.operations) { const result = json(operation.result); if ((result.eventIds ?? []).some((event) => removedEvents.has(event)) || (result.memoryId && ![...rows.memories.values()].some((m) => m.memoryId === result.memoryId))) rows.operations.delete(k); }
      for (const [k, job] of rows.jobs) if (json(job.inputs).some((ref) => ref.type === 'event' ? removedEvents.has(ref.id) : removedVersions.has(canonical([ref.id, ref.revision])))) rows.jobs.delete(k);
      const output = new DatabaseSync(destination);
      try {
        output.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=OFF;');
        const schema = sources[0].prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY type DESC,rowid").all();
        for (const entry of schema) output.exec(entry.sql);
        output.exec('BEGIN IMMEDIATE');
        for (const table of ROLE_TABLES.filter((t) => !['metadata', 'search_docs', 'terms'].includes(t))) {
          const entries = [...rows[table].values()]; if (!entries.length) continue;
          const columns = Object.keys(entries[0]), insert = output.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
          for (const row of entries) insert.run(...columns.map((col) => row[col]));
        }
        const commitSequence = Math.max(0, ...[...rows.metadata.values()].map((m) => m.commitSequence)) + 1;
        output.prepare('INSERT INTO metadata VALUES(1,?,?)').run(revision, commitSequence);
        const index = output.prepare('INSERT INTO search_docs VALUES(?,?,?,?)'), insertTerm = output.prepare('INSERT OR IGNORE INTO terms VALUES(?,?,?,?)');
        applyRoleControls?.(output, id);
        for (const [type, table] of [['event', 'events'], ['memory', 'memory_versions']]) for (const row of output.prepare(`SELECT * FROM ${table} WHERE status='active'`).all()) { const content = json(row.payload).content, itemId = row.eventId ?? row.memoryId, rev = row.revision ?? 1; index.run(type, itemId, rev, content); for (const term of terms(content)) insertTerm.run(term, type, itemId, rev); }
        output.exec('COMMIT; PRAGMA foreign_keys=ON;');
      } finally { output.close(); }
      sync(destination); verifiedDb(destination, true);
      return { conflicts, eventCount: rows.events.size, memoryVersionCount: rows.memory_versions.size, removedEventIds: [...removedEvents], removedVersionIds: [...removedVersions] };
    } finally { for (const db of sources) db.close(); }
  }
  function rootsPreview(id, roots) {
    requireThat(Array.isArray(roots) && roots.length > 0 && roots.length <= 100 && new Set(roots).size === roots.length, 'MEMORY_ACTION_INVALID', 'Select bounded unique explicit source roots.'); roots.forEach((root) => identifier(root));
    const db = role(id), events = db.prepare('SELECT eventId,sourceKey,roots FROM events').all().filter((r) => json(r.roots).some((root) => roots.includes(root))), versions = db.prepare('SELECT memoryId,revision,roots FROM memory_versions').all().filter((r) => json(r.roots).some((root) => roots.includes(root)));
    requireThat(events.length > 0 || versions.length > 0, 'MEMORY_DELETE_EMPTY', 'No current source or derived version belongs to these roots.');
    return { roots: [...roots].sort(), eventIds: events.map((r) => r.eventId).sort(), sourceKeys: [...new Set(events.map((r) => r.sourceKey))].sort(), versions: versions.map((r) => ({ memoryId: r.memoryId, revision: r.revision })), commitSequence: db.prepare('SELECT commitSequence FROM metadata WHERE id=1').get().commitSequence };
  }
  function preview(ctx, method, request, inv) {
    admin(ctx); const s = state();
    let plan;
    if (method === 'previewBackup') plan = backupPlan(ctx, request, inv);
    if (method === 'previewRestore') { const saved = loadBackup(request.backupId); requireThat(saved.manifest.characterId === ctx.characterId, 'MEMORY_BACKUP_ROLE_MISMATCH', 'The backup belongs to a different role.'); plan = { kind: 'restore', backupId: request.backupId, characterId: ctx.characterId, controlRevision: s.revision, deletionRevision: s.deletionRevision, policyRevision: s.policyRevision, commitSequence: role(ctx.characterId).prepare('SELECT commitSequence FROM metadata WHERE id=1').get().commitSequence, preservePostBackupEvents: true, formalConflicts: 'review', restoreControls: false, restoreQuota: false }; }
    if (method === 'previewDelete') plan = { kind: 'delete', characterId: ctx.characterId, controlRevision: s.revision, ...rootsPreview(ctx.characterId, request.roots), retained: control.prepare('SELECT backupId,state FROM lifecycle_backups WHERE characterId=?').all(ctx.characterId).map((row) => ({ ...row })), externalCopies: inv.externalCopies, inventoryComplete: inv.complete, excluded: ['platform-and-model-recipients', 'user-exports', 'system-backups', 'SSD-forensics'] };
    requireThat(plan, 'MEMORY_LIFECYCLE_METHOD_INVALID', 'This lifecycle preview method is unknown.'); return { ok: true, preview: plan, previewDigest: digest(plan) };
  }
  function challenge(row) { return { operationId: row.operationId, characterId: row.characterId, previousEpoch: row.payload.previousEpoch, previousStoreGeneration: row.payload.oldGeneration, controlRevision: row.payload.controlRevision, ...Object.fromEntries(['bindingRevision', 'deletionRevision'].map((key) => [key, state()[key]])), nonce: row.payload.nonce, reason: row.kind }; }
  function resolved(row) {
    const seen=new Set(); while(row?.phase==='resumed' && row.result.resumedBy){ requireThat(!seen.has(row.operationId) && seen.size<32,'MEMORY_LIFECYCLE_CORRUPT','The durable resume chain is cyclic or exceeds its bound.'); seen.add(row.operationId); const next=op(row.result.resumedBy); requireThat(next && next.characterId===row.characterId,'MEMORY_LIFECYCLE_CORRUPT','The durable resume target is unavailable or belongs to another role.'); row=next; } return row;
  }
  function progress(ctx, operationId) { admin(ctx); let row=op(operationId); requireThat(row && row.characterId===ctx.characterId,'MEMORY_OPERATION_NOT_FOUND','No lifecycle operation exists for this role and original ID.'); row=resolved(row); return {ok:true,...row.result,operationId, ...(row.operationId!==operationId?{effectiveOperationId:row.operationId}:{}),phase:row.phase,complete:['completed','backup_verified'].includes(row.phase),...(row.phase==='retirement_required'?{retirement:challenge(row)}:{})}; }
  function start(ctx, kind, request, expected, operationId, inv) {
    admin(ctx); identifier(operationId); requireThat(Number.isSafeInteger(expected) && expected >= 0, 'MEMORY_REVISION_REQUIRED', 'Lifecycle mutations require an explicit expected control revision.'); const requestDigest = digest({ kind, request, expectedRevision: expected, characterId: ctx.characterId }); const previous = op(operationId);
    if (previous) { requireThat(previous.requestDigest === requestDigest, 'MEMORY_DIGEST_CONFLICT', 'The lifecycle operationId already binds different immutable parameters.'); return progress(ctx, operationId); }
    admin(ctx, expected); requireThat(pending(ctx.characterId).length === 0 || ['resume', 'continueDelete'].includes(kind), 'MEMORY_LIFECYCLE_BLOCKED', 'Finish or explicitly resume the pending lifecycle operation first.'); mark(ctx.characterId);
    if (['backup', 'restore', 'requestDelete'].includes(kind)) { const plan = preview(ctx, { backup: 'previewBackup', restore: 'previewRestore', requestDelete: 'previewDelete' }[kind], request, inv); requireThat(plan.previewDigest === request.previewDigest, 'MEMORY_PREVIEW_STALE', 'The lifecycle cut, control, or selected scope changed.', 'Refresh the preview and confirm the new exact scope.'); }
    if (kind === 'backup') {
      mark(ctx.characterId, KERNEL);
      const intent = transaction(control, operationId, () => { control.prepare('INSERT INTO lifecycle_ops VALUES(?,?,?,?,?,?,?)').run(operationId, requestDigest, ctx.characterId, kind, 'intent_committed', '{}', canonical({ ok: true, operationId, phase: 'intent_committed' })); return { ok: true }; }, true);
      if (!intent.ok) return intent;
      const saved = makeBackup(ctx, request, operationId, inv), result = { ok: true, operationId, backupId: saved.backupId, manifest: saved.manifest, phase: 'backup_verified', activeBackend: 'v1' };
      const completed = transaction(control, operationId, () => { save(op(operationId), 'backup_verified', result); return result; }, true); return completed.ok ? progress(ctx,operationId) : completed;
    }
    const parent = resolved(kind === 'continueDelete' ? op(request.deleteOperationId) : kind === 'resume' ? op(request.operationId) : null);
    if (parent) requireThat(parent.characterId === ctx.characterId && ['restore', 'requestDelete', 'continueDelete'].includes(parent.payload.effectiveKind ?? parent.kind), 'MEMORY_OPERATION_NOT_FOUND', 'The original lifecycle scope cannot be resumed by this role.');
    if (kind === 'continueDelete') requireThat(parent && ['requestDelete','continueDelete'].includes(parent.payload.effectiveKind ?? parent.kind), 'MEMORY_ACTION_INVALID', 'Select an original deletion intent.');
    if (kind === 'resume') requireThat(parent && parent.phase !== 'completed', 'MEMORY_ACTION_INVALID', 'Select an unfinished original operation.');
    if(['resume','continueDelete'].includes(kind)) requireThat(pending(ctx.characterId).every((item)=>item.operationId===parent?.operationId),'MEMORY_LIFECYCLE_BLOCKED','A different unfinished lifecycle operation must be resolved first.');
    const revision = state().revision + 1, payload = { request, inventory: inv, previousEpoch: ctx.capturedEpoch, oldGeneration: generation, nonce: randomUUID(), controlRevision: revision, candidateId: `generation-${digest([ctx.characterId, operationId]).slice(0, 32)}`, parentId: parent?.operationId ?? null, effectiveKind: kind === 'resume' ? parent.payload.effectiveKind ?? parent.kind : kind, originalRequest: kind === 'resume' ? parent.payload.originalRequest ?? parent.payload.request : request };
    const result = { ok: true, operationId, phase: 'intent_committed', controlRevision: revision, activeBackend: 'v1', accessState: kind === 'requestDelete' || kind === 'continueDelete' ? 'access_revoked' : 'blocked', activeStorePurged: false, retainedCopiesPurged: false, pending: [] };
    const committed = transaction(control, operationId, () => {
      control.prepare('UPDATE state SET revision=?,bindingRevision=bindingRevision+1,deletionRevision=deletionRevision+? WHERE id=1').run(revision, kind === 'requestDelete' ? 1 : 0);
      if (kind === 'requestDelete') {
        const selected = rootsPreview(ctx.characterId, request.roots), insert = control.prepare('INSERT OR IGNORE INTO source_tombstones VALUES(?,?,?,?)');
        for (const root of request.roots) { insert.run(ctx.characterId, 'root', root, revision); control.prepare("INSERT INTO root_controls VALUES(?,?,'delete',?) ON CONFLICT(characterId,rootId) DO UPDATE SET status='delete',revision=excluded.revision").run(ctx.characterId, root, revision); }
        for (const event of role(ctx.characterId).prepare('SELECT * FROM events').all()) if (selected.eventIds.includes(event.eventId)) { insert.run(ctx.characterId, 'event', event.eventId, revision); insert.run(ctx.characterId, 'source', event.sourceKey, revision); insert.run(ctx.characterId, 'source', baseSource(event.sourceKey), revision); }
        for (const mapping of control.prepare('SELECT * FROM source_mappings WHERE characterId=?').all(ctx.characterId)) if (selected.eventIds.includes(mapping.eventId)) insert.run(ctx.characterId, 'source', mapping.sourceKey, revision);
      }
      if (kind === 'resume' || (kind==='continueDelete' && parent.phase!=='completed')) save(parent, 'resumed', { ...parent.result, resumedBy: operationId, phase: 'resumed', complete: false });
      control.prepare('INSERT INTO lifecycle_ops VALUES(?,?,?,?,?,?,?)').run(operationId, requestDigest, ctx.characterId, kind, 'intent_committed', canonical(payload), canonical(result)); return result;
    }, true);
    if (!committed.ok) return committed; fault('lifecycleAfterIntent', operationId);
    return prepare(ctx, op(operationId));
  }
  function prepare(ctx, row) {
    const id = row.characterId, effective = row.payload.effectiveKind;
    if (effective !== 'requestDelete') {
      const safetyId = `safety-${row.operationId}`; makeBackup(ctx, {}, safetyId, row.payload.inventory, true);
      const dir = path.join(charactersDir, id, 'memory', 'generations', row.payload.candidateId); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'memory-v2.sqlite');
      if (fs.existsSync(file)) { const abandoned = path.join(dir, `abandoned-${randomUUID()}.sqlite`); fs.renameSync(file, abandoned); }
      const request = row.payload.originalRequest;
      const sources = effective === 'restore' ? [path.join(loadBackup(request.backupId).dir, 'role.sqlite'), roleSource(id)] : [roleSource(id)];
      const summary = cleanRole(id, sources, file, state().revision);
      row.payload.candidateFile = path.relative(path.join(charactersDir, id), file); row.payload.summary = summary;
      fault('lifecycleAfterCandidate', row.operationId);
    }
    const updated = transaction(control, row.operationId, () => { save(row, 'retirement_required', { ...row.result, phase: 'retirement_required', pending: [{ kind: 'host-retirement', action: 'Retire role sessions, cancel in-flight work, guard legacy admission and advance native epoch.' }] }); return { ok: true }; }, true);
    if (!updated.ok) return updated; return progress(ctx, row.operationId);
  }
  function acknowledge(ctx, operationId, proof) {
    admin(ctx); let row = op(operationId); requireThat(row?.characterId === ctx.characterId && row.phase === 'retirement_required', 'MEMORY_RETIREMENT_REQUIRED', 'This operation is not awaiting a verified retirement proof.');
    requireThat(proof?.nonce === row.payload.nonce && proof.characterId === row.characterId && Number.isSafeInteger(proof.epoch) && proof.epoch > row.payload.previousEpoch && proof.sessionsRetired === true && proof.inflightCancelled === true && proof.legacyAdmissionBlocked === true, 'MEMORY_RETIREMENT_REQUIRED', 'The Host retirement proof or native epoch is incomplete.');
    requireThat(state().revision === row.payload.controlRevision, 'MEMORY_REVISION_CONFLICT', 'Current controls changed during lifecycle retirement.', 'Resume the original intent against a fresh current control preview.');
    row.payload.retirementProof = proof;
    const accepted = transaction(control, operationId, () => { save(row, 'sessions_retired', { ...row.result, phase: 'sessions_retired' }); return { ok: true }; }, true); if (!accepted.ok) return accepted;
    fault('lifecycleAfterRetirement', operationId);
    closeRole(row.characterId);
    if (row.payload.candidateFile) {
      const file = inside(path.join(charactersDir, row.characterId), path.join(charactersDir, row.characterId, row.payload.candidateFile)); verifiedDb(file, true);
      const old = selectedFile(row.characterId,true), quarantine = path.join(charactersDir, row.characterId, 'memory', 'quarantine', row.payload.candidateId); fs.mkdirSync(quarantine, { recursive: true });
      const preserved = path.join(quarantine, 'previous.sqlite');
      row.payload.previousFile = path.relative(path.join(charactersDir,row.characterId),old); row.payload.preservedFile = path.relative(path.join(charactersDir,row.characterId),preserved);
      const planned = transaction(control,operationId,()=>{ save(row,'publish_prepared',{...row.result,phase:'publish_prepared'}); return {ok:true}; },true); if(!planned.ok) return planned;
      fault('lifecycleRenameBusy',operationId);
      let originalRole = false; if(fs.existsSync(old)) try { verifiedDb(old,true); originalRole=true; } catch {}
      if (originalRole && !fs.existsSync(preserved)) { fs.renameSync(old, preserved); syncDir(path.dirname(old)); }

      const legacy = path.join(charactersDir, row.characterId, 'memory', 'memory-v2.sqlite');
      if (!fs.existsSync(legacy)) { const guard = new DatabaseSync(legacy); try { guard.exec('CREATE TABLE metadata(lifecycle_guard INTEGER NOT NULL); INSERT INTO metadata VALUES(1); PRAGMA user_version=2147483646;'); } finally { guard.close(); } sync(legacy); }
    }
    fault('lifecycleBeforePublish', operationId);
    const published = transaction(control, operationId, () => {
      if (row.payload.candidateFile) control.prepare('INSERT INTO role_generations VALUES(?,?,?) ON CONFLICT(characterId) DO UPDATE SET relativeFile=excluded.relativeFile,minimumKernel=excluded.minimumKernel').run(row.characterId, row.payload.candidateFile, json(fs.readFileSync(marker,'utf8')).minimumCompatibleKernel);
      save(row, 'published_await_generation', { ...row.result, phase: 'published_await_generation', pending: [{ kind: 'fresh-worker-generation', action: 'Close and reopen the sole Worker, then verify the selected generation.' }] }); return { ok: true, operationId, phase: 'published_await_generation', restartRequired: true };
    }, true); if(published.ok) fault('lifecycleAfterPublish',operationId); return published;
  }
  function purgeRetained(row) {
    const pendingCopies = [], id = row.characterId, inv = row.payload.inventory;
    for (const saved of control.prepare("SELECT backupId FROM lifecycle_backups WHERE characterId=? AND state='verified'").all(id)) {
      const loaded = loadBackup(saved.backupId), manifest = loaded.manifest;
      control.prepare("UPDATE lifecycle_backups SET state='redaction_pending' WHERE backupId=?").run(saved.backupId);
      for (const item of manifest.files) {
        const file = path.join(loaded.dir, item.file), next = `${file}.${randomUUID()}.next`, removed = `${file}.${randomUUID()}.retired`;
        if (item.kind === 'role') cleanRole(id, [file], next, state().revision);
        else if (item.kind === 'spool') { const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => validateEvent(json(line))).filter((event) => !eventDeleted(id, event)); fs.writeFileSync(next, events.map((event) => canonical(event) + '\n').join(''), { flag: 'wx', mode: 0o600 }); sync(next); }
        else continue;
        replaceManaged(file, next, removed); remove(removed); item.bytes = regular(file).size; item.sha256 = sha(file);
      }
      manifest.redactedThroughDeletionRevision = state().deletionRevision;
      const manifestFile = path.join(loaded.dir, 'manifest.json'), next = `${manifestFile}.${randomUUID()}.next`, old = `${manifestFile}.${randomUUID()}.retired`; write(next, manifest); replaceManaged(manifestFile, next, old); remove(old);
      control.prepare("UPDATE lifecycle_backups SET state='verified',manifestDigest=? WHERE backupId=?").run(sha(manifestFile), saved.backupId); loadBackup(saved.backupId);
    }
    const quarantine = path.join(charactersDir, id, 'memory', 'quarantine');
    if (fs.existsSync(quarantine)) for (const dir of fs.readdirSync(quarantine)) {
      const child = path.join(quarantine, dir); requireThat(fs.lstatSync(child).isDirectory() && !fs.lstatSync(child).isSymbolicLink(), 'MEMORY_LIFECYCLE_PATH_INVALID', 'Unknown quarantine entry requires manual inspection.');
      for (const file of fs.readdirSync(child)) { const target = path.join(child, file); if (/\.sqlite(?:-journal|-wal|-shm)?$/.test(file)) remove(target); else pendingCopies.push({ copyId: `quarantine:${dir}:${file}`, kind: 'unknown-retained-file', state: 'pending', action: 'Inspect and explicitly purge this preserved file.' }); }
    }
    const generations = path.join(charactersDir,id,'memory','generations'), active = selectedFile(id);
    if (fs.existsSync(generations)) for (const name of fs.readdirSync(generations)) {
      const dir = path.join(generations,uid(name)); requireThat(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(),'MEMORY_LIFECYCLE_PATH_INVALID','A generation directory redirects outside managed storage.');
      for (const name of fs.readdirSync(dir)) { const file = path.join(dir,name); if (file === active) continue; if (/\.sqlite(?:-journal|-wal|-shm)?$/.test(name)) remove(file); else pendingCopies.push({copyId:`generation:${path.basename(dir)}:${name}`,kind:'unverified-generation-copy',state:'pending',action:'Inspect and explicitly purge this retained candidate artifact.'}); }
    }
    for (const spool of inv.sealedSpool) pendingCopies.push({ copyId: spool.copyId, kind: 'source-spool', state: 'pending', action: 'Producer must quarantine/purge its original sealed segment and provide a new trusted proof.' });
    if (!inv.complete) pendingCopies.push({ kind: 'host-inventory', state: 'pending', action: 'Provide complete Host inventory for sessions, legacy copies and source queues.' });
    for (const item of inv.externalCopies) if (item.state === 'pending') pendingCopies.push({ ...item, action: 'The owning Host module must purge or verify this retained copy.' });
    for (const item of control.prepare("SELECT backupId,state FROM lifecycle_backups WHERE characterId=? AND state!='verified'").all(id)) pendingCopies.push({ copyId: item.backupId, kind: 'unverified-backup', state: 'pending', action: 'Inspect and explicitly purge the incomplete backup; it is never automatically erased.' });
    return pendingCopies;
  }
  function recover() {
    for (const item of control.prepare("SELECT operationId FROM lifecycle_ops WHERE phase='published_await_generation'").all()) {
      let row = op(item.operationId); requireThat(row.payload.oldGeneration !== generation, 'MEMORY_LIFECYCLE_BLOCKED', 'Lifecycle publication needs an actual fresh Worker generation.');
      let candidateReady=true; try {if(row.payload.candidateFile) verifiedDb(selectedFile(row.characterId),true);} catch {candidateReady=false;}
      if(!candidateReady || !row.payload.retirementProof || state().revision!==row.payload.controlRevision){ const held=transaction(control,row.operationId,()=>{save(row,'recovery_blocked',{...row.result,ok:true,complete:false,code:'MEMORY_LIFECYCLE_BLOCKED',error:'The published candidate needs current controls, verified files and fresh retirement.',hint:'Inspect progress and explicitly resume the original intent using latest controls.'});return{ok:true};},true);requireThat(held.ok,held.code,held.error,held.hint);continue;}

      materializeControls(row.characterId);
      const effective = row.payload.effectiveKind, purged = effective === 'continueDelete';
      let pendingCopies = [];
      if (purged) pendingCopies = row.payload.originalRequest.purgeRetained === true ? purgeRetained(row) : [{ kind: 'retained-copies', state: 'pending', action: 'Confirm explicit retained-copy purge after inspecting backup/quarantine/producer inventory.' }];
      const result = { ...row.result, ok: true, phase: 'completed', storeGeneration: generation, epoch: row.payload.retirementProof.epoch, accessState: effective === 'requestDelete' || purged ? 'access_revoked' : 'current-controls-applied', activeStorePurged: purged, retainedCopiesPurged: purged && pendingCopies.length === 0, deletionPhase: purged ? (pendingCopies.length ? 'active_store_purged' : 'retained_copies_purged') : effective === 'requestDelete' ? 'access_revoked' : null, conflicts: row.payload.summary?.conflicts ?? [], pending: pendingCopies, quotaRestored: false, activeBackend: 'v1' };
      const committed = transaction(control, row.operationId, () => { save(row, 'completed', result); return { ok: true }; }, true); requireThat(committed.ok, committed.code, committed.error, committed.hint);
    }
  }
  function call(ctx, method, request = {}, expected, operationId, suppliedInventory = {}) {
    admin(ctx); if(method === 'progress') return progress(ctx,request.operationId); const inv = inventory(suppliedInventory);
    if (method.startsWith('preview')) return preview(ctx, method, request, inv);
    if (method === 'acknowledge') return acknowledge(ctx, request.operationId, request.proof);
    requireThat(['backup', 'restore', 'requestDelete', 'continueDelete', 'resume'].includes(method), 'MEMORY_LIFECYCLE_METHOD_INVALID', 'This lifecycle method is unavailable.');
    return start(ctx, method, request, expected, operationId, inv);
  }
  return { selectedFile, admission, eventDeleted, call, recover, pending, recordControlHead, requireAdminKernel: (id) => mark(id, KERNEL), format: FORMAT };
}
