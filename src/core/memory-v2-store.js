import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import { validateGrowthProposal } from './memory-v2-growth.js';
import { createAdministration } from './memory-v2-admin.js';
import { checkLifecycleControl, createLifecycle } from './memory-v2-lifecycle.js';
import { audienceKey, canonical, characterId, CONTEXT_FIELDS, digest, fail, identifier, intersectPolicies, policyAllows, receipt, requireThat, SCHEMA_VERSION, terms, validateEvent, validatePolicy, validatePrepared } from './memory-v2-contract.js';

requireThat(!isMainThread, 'MEMORY_WORKER_REQUIRED', 'Only the memory worker may open the store.');
const parse = (value) => JSON.parse(value);
const unique = (values) => [...new Set(values)].sort();
const settings = (db) => Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys'].map((key) => [key, Object.values(db.prepare(`PRAGMA ${key}`).get())[0]]));
function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=150;');
  requireThat(canonical(settings(db)) === canonical({ journal_mode: 'delete', synchronous: 3, foreign_keys: 1 }), 'MEMORY_BACKEND_UNSUPPORTED', 'SQLite durability settings did not read back correctly.');
  return db;
}
export function createStore({ stateDir, charactersDir, generation, now = Date.now, faults = {} }) {
  fs.mkdirSync(stateDir, { recursive: true });
  checkLifecycleControl(stateDir, charactersDir);
  const controlFile = path.join(stateDir, 'memory-control.sqlite');
  let control = open(controlFile), retired = false;
  const roles = new Map();
  let lifecycle, administration;
  const faultCounts = new Map();
  function fault(name, operationId) {
    if (faults.operationId && operationId !== faults.operationId) return;
    const n = faultCounts.get(name) ?? 0;
    if (faults[name] && n < faults[name]) { faultCounts.set(name, n + 1); throw new Error(`fixture:${name}`); }
  }
  control.exec(`CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, policyRevision INTEGER NOT NULL, bindingRevision INTEGER NOT NULL, deletionRevision INTEGER NOT NULL, activeBackend TEXT NOT NULL, shadowEnabled INTEGER NOT NULL);
    INSERT OR IGNORE INTO state VALUES(1,0,0,0,0,'v2',0);
    CREATE TABLE IF NOT EXISTS policies(policyId TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS privacy_actions(operationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,revision INTEGER NOT NULL UNIQUE,characterId TEXT NOT NULL,action TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS root_controls(characterId TEXT NOT NULL,rootId TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(characterId,rootId));`);
  function admission(id, admin = false) { lifecycle.admission(id, admin); administration?.admission(id, admin); }
  function state() { requireThat(!retired && control, 'MEMORY_CONTROL_BLOCKED', 'The control connection is retired.', 'Close and reopen the service, then query the original operation receipt.'); return { ...control.prepare('SELECT * FROM state WHERE id=1').get() }; }
  function role(id) {
    characterId(id);
    if (roles.has(id)) return roles.get(id);
    const dir = path.join(charactersDir, id, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const db = open(lifecycle?.selectedFile(id) ?? path.join(dir, 'memory-v2.sqlite'));
    try { db.exec(`CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY CHECK(id=1), appliedControlRevision INTEGER NOT NULL, commitSequence INTEGER NOT NULL); INSERT OR IGNORE INTO metadata VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS events(eventId TEXT PRIMARY KEY,sourceKey TEXT NOT NULL UNIQUE,operationId TEXT NOT NULL UNIQUE,payloadDigest TEXT NOT NULL,policyId TEXT NOT NULL,payload TEXT NOT NULL,roots TEXT NOT NULL,policies TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE IF NOT EXISTS memories(memoryId TEXT PRIMARY KEY,propositionKey TEXT NOT NULL,lineageDomainId TEXT NOT NULL,currentRevision INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,UNIQUE(propositionKey,lineageDomainId));
      CREATE TABLE IF NOT EXISTS memory_versions(memoryId TEXT NOT NULL REFERENCES memories(memoryId),revision INTEGER NOT NULL,payloadDigest TEXT NOT NULL,payload TEXT NOT NULL,roots TEXT NOT NULL,policies TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(memoryId,revision));
      CREATE TABLE IF NOT EXISTS links(fromId TEXT NOT NULL,fromRevision INTEGER NOT NULL,toId TEXT NOT NULL,toRevision INTEGER NOT NULL,type TEXT NOT NULL,PRIMARY KEY(fromId,fromRevision,toId,toRevision,type),FOREIGN KEY(fromId,fromRevision) REFERENCES memory_versions(memoryId,revision),FOREIGN KEY(toId,toRevision) REFERENCES memory_versions(memoryId,revision));
      CREATE TABLE IF NOT EXISTS operations(operationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,result TEXT NOT NULL,commitSequence INTEGER NOT NULL,requestScope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_offsets(producerId TEXT NOT NULL,segmentId TEXT NOT NULL,position INTEGER NOT NULL,sourceDigest TEXT NOT NULL,PRIMARY KEY(producerId,segmentId));
      CREATE TABLE IF NOT EXISTS search_docs(recordType TEXT NOT NULL,recordId TEXT NOT NULL,revision INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(recordType,recordId,revision));
      CREATE TABLE IF NOT EXISTS terms(term TEXT NOT NULL,recordType TEXT NOT NULL,recordId TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(term,recordType,recordId,revision));
      CREATE INDEX IF NOT EXISTS terms_lookup ON terms(term);
      CREATE TABLE IF NOT EXISTS jobs(jobId TEXT PRIMARY KEY,inputs TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_sequence(eventId TEXT PRIMARY KEY REFERENCES events(eventId),sequence INTEGER NOT NULL UNIQUE);
      INSERT OR IGNORE INTO source_sequence SELECT eventId,rowid FROM events ORDER BY rowid;
      CREATE TABLE IF NOT EXISTS source_clock(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO source_clock SELECT 1,COALESCE(MAX(sequence),0) FROM source_sequence;
      UPDATE source_clock SET sequence=MAX(sequence,(SELECT COALESCE(MAX(sequence),0) FROM source_sequence)) WHERE id=1;`); } catch(error) { db.close(); throw error; }
    roles.set(id, db);
    return db;
  }
  function retire() {
    retired = true;
    for (const db of roles.values()) { try { db.close(); } catch {} }
    roles.clear(); try { control.close(); } catch {} control = null;
  }
  function transaction(db, operationId, action, controlTx = false) {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try { result = action(); }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    try {
      fault(controlTx ? 'controlCommitBefore' : 'roleCommitBefore', operationId);
      db.exec('COMMIT');
      if(controlTx) lifecycle?.recordControlHead();
      fault(controlTx ? 'controlCommitAfter' : 'roleCommitAfter', operationId);
      return result;
    } catch {
      retire();
      return { ...fail('MEMORY_COMMIT_UNCERTAIN', 'The transaction commit is unconfirmed; its connection has been retired.', 'Reopen the service and query_receipt with the original operationId. Do not create a replacement request.'), operationId, sourceState: 'commit_unknown', operationState: 'unknown', retry: 'query_receipt' };
    }
  }
  function policy(id) { const row = control.prepare('SELECT payload FROM policies WHERE policyId=?').get(id); return row ? parse(row.payload) : null; }
  function blockedRoots(id) { return new Set(control.prepare('SELECT rootId FROM root_controls WHERE characterId=?').all(id).map((row) => row.rootId)); }
  function applyControls(id) {
    const s = state(), db = role(id);
    const applied = db.prepare('SELECT appliedControlRevision FROM metadata WHERE id=1').get().appliedControlRevision;
    if (applied === s.revision) return true;
    requireThat(applied < s.revision, 'MEMORY_CONTROL_BLOCKED', 'The character view is ahead of the current control store.');
    fault('applyControls');
    if (faults.applyControlsAtRevision === s.revision) throw new Error('fixture:applyControlsAtRevision');
    const roots = blockedRoots(id);
    const result = transaction(db, `control-apply-${s.revision}`, () => {
      for (const row of db.prepare('SELECT eventId,roots FROM events').all()) if (parse(row.roots).some((root) => roots.has(root))) db.prepare("UPDATE events SET status='suppressed' WHERE eventId=?").run(row.eventId);
      for (const row of db.prepare('SELECT memoryId,revision,roots FROM memory_versions').all()) if (parse(row.roots).some((root) => roots.has(root))) {
        db.prepare("UPDATE memory_versions SET status='invalidated' WHERE memoryId=? AND revision=?").run(row.memoryId, row.revision);
        db.prepare("UPDATE memories SET status='invalidated' WHERE memoryId=? AND currentRevision=?").run(row.memoryId, row.revision);
      }
      administration?.applyRoleControls(db, id);
      db.prepare('UPDATE metadata SET appliedControlRevision=? WHERE id=1').run(s.revision);
      return { ok: true };
    });
    requireThat(result.ok, result.code, result.error, result.hint);
    return true;
  }
  // V2-only（2026-11-12）：普通业务准入不再检查历史 `shadowEnabled` 列。
  // 该列只在旧版影子期用于「先观察再切换」，V1 退役后它既不能代表授权、也不能代表就绪；
  // 留着它做准入会制造「已选 V2、授权已提交、却仍被拒」的矛盾状态（R01）。
  // 真正必须通过的门禁一律保留：角色/epoch、具体 audience/provider policy、控制修订、
  // 来源证明、生命周期与删除屏障。列本身不删除、不重置、不做数据迁移。
  function validate(ctx, { permitAdmin = false } = {}) {
    const s = state();
    admission(ctx.characterId, ctx.admin === true);
    requireThat(ctx.storeGeneration === generation, 'MEMORY_WORKER_STALE', 'This context belongs to a retired worker.');
    requireThat(ctx.purpose !== 'admin' || (permitAdmin && ctx.admin === true), 'MEMORY_ADMIN_REQUIRED', 'This action requires a trusted management capability.');
    for (const key of ['policyRevision', 'bindingRevision', 'deletionRevision', 'controlRevision']) requireThat(ctx[key] === s[key === 'controlRevision' ? 'revision' : key], 'MEMORY_CONTEXT_STALE', `The captured ${key} is stale.`, 'Retire the affected session and capture a new trusted context.');
    requireThat(policyAllows(policy(ctx.audiencePolicyId), ctx, { admin: ctx.admin === true }), 'MEMORY_POLICY_DENIED', 'This specific audience or provider has no approved processing policy.');
    const db = role(ctx.characterId);
    requireThat(db.prepare('SELECT appliedControlRevision FROM metadata WHERE id=1').get().appliedControlRevision === s.revision, 'MEMORY_CONTROL_BLOCKED', 'The character view has not acknowledged current security controls.', 'Reopen the service to finish applying controls before memory, model, or send admission.');
    return db;
  }
  function visible(row, ctx, { admin = false } = {}) {
    if (!admin && row.status !== 'active') return false;
    if (!admin && parse(row.roots).some((root) => blockedRoots(ctx.characterId).has(root))) return false;
    return parse(row.policies).every((id) => policyAllows(policy(id), ctx, { admin }));
  }
  function source(db, ctx, ref, { admin = false } = {}) {
    requireThat(ref && ['event', 'memory'].includes(ref.type), 'MEMORY_MANIFEST_INVALID', 'Input references must identify event or memory records.');
    const row = ref.type === 'event'
      ? db.prepare('SELECT * FROM events WHERE eventId=?').get(identifier(ref.id))
      : db.prepare('SELECT * FROM memory_versions WHERE memoryId=? AND revision=?').get(identifier(ref.id), ref.revision);
    requireThat(row && visible(row, ctx, { admin }), 'MEMORY_EVIDENCE_DENIED', 'An actual input is absent, suppressed, stale, or not authorized.');
    requireThat(ref.payloadDigest === row.payloadDigest && (ref.type !== 'event' || ref.revision === 1), 'MEMORY_SOURCE_STALE', 'An actual input version or digest has changed.');
    const payload = parse(row.payload);
    requireThat(!payload.expiresAt || Date.parse(payload.expiresAt) > now(), 'MEMORY_SOURCE_STALE', 'An actual input has expired.');
    return { row, payload, ref: { type: ref.type, id: ref.id, revision: ref.revision, payloadDigest: row.payloadDigest } };
  }
  function manifest(db, ctx, refs) {
    requireThat(Array.isArray(refs) && refs.length <= 100, 'MEMORY_MANIFEST_INVALID', 'A bounded Host input manifest is required.');
    const loaded = refs.map((ref) => source(db, ctx, ref));
    requireThat(new Set(loaded.map((item) => canonical(item.ref))).size === loaded.length, 'MEMORY_MANIFEST_INVALID', 'Duplicate actual input references are not accepted.');
    return loaded;
  }
  const requestScope = (ctx) => digest(['characterId', 'channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'providerRouteId', 'processingGrantId'].map((key) => ctx[key]));
  function existing(db, operationId, requestDigest, ctx) {
    const row = db.prepare('SELECT * FROM operations WHERE operationId=?').get(operationId);
    if (!row) return null;
    requireThat(!ctx || row.requestScope === requestScope(ctx), 'MEMORY_RECEIPT_DENIED', 'The original operation belongs to another trusted audience.', 'Query the receipt using its original channel context or authenticated management.');
    requireThat(row.requestDigest === requestDigest, 'MEMORY_DIGEST_CONFLICT', 'This operationId is already bound to a different request.', 'Query the original receipt. Keep its ID and immutable batch members unchanged.');
    return parse(row.result);
  }
  function saveReceipt(db, operationId, requestDigest, result, ctx) {
    db.exec('UPDATE metadata SET commitSequence=commitSequence+1 WHERE id=1');
    const sequence = db.prepare('SELECT commitSequence FROM metadata WHERE id=1').get().commitSequence;
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(operationId, requestDigest, canonical({ ...result, commitSequence: sequence }), sequence, requestScope(ctx));
    return { ...result, commitSequence: sequence };
  }
  function index(db, type, id, revision, text) {
    db.prepare('INSERT INTO search_docs VALUES(?,?,?,?)').run(type, id, revision, text);
    const insert = db.prepare('INSERT OR IGNORE INTO terms VALUES(?,?,?,?)');
    terms(text).forEach((term) => insert.run(term, type, id, revision));
  }
  function metadata(ctx) {
    const s = state();
    admission(ctx.characterId, ctx.admin === true);
    try { applyControls(ctx.characterId); } catch (error) { if (!ctx.admin) throw Object.assign(new Error('The character view has not acknowledged current controls.'), fail('MEMORY_CONTROL_BLOCKED', 'The character view has not acknowledged current controls.', 'Reopen the service and finish applying the committed control revision before memory, model, or send admission.')); }
    return { ...s, storeGeneration: generation };
  }
  function resolveAudience(facts) {
    state(); admission(facts.characterId); applyControls(facts.characterId);
    const matches = [];
    for (const row of control.prepare('SELECT payload FROM policies').all()) {
      const candidate = parse(row.payload);
      for (const grant of candidate.processingGrants) {
        const ctx = { ...facts, processingGrantId: grant.grantId };
        if (policyAllows(candidate, ctx)) matches.push({ audiencePolicyId: candidate.policyId, processingGrantId: grant.grantId });
      }
    }
    requireThat(matches.length === 1, matches.length ? 'MEMORY_AUDIENCE_AMBIGUOUS' : 'MEMORY_POLICY_DENIED', matches.length ? 'Multiple approved policies or grants match the complete audience and provider.' : 'No approved policy matches the complete audience and provider.', 'Use authenticated settings to configure exactly one policy and processing grant for this trusted channel audience.');
    const { characterId: ignored, ...input } = facts;
    return { ok: true, ...input, ...matches[0] };
  }
  function getStatus() {
    const s = state();
    return { ok: true, ...s, storeGeneration: generation, workerPid: process.pid, node: process.version, durabilityProfile: 'runtime-unverified', pragmas: settings(control), capabilities: { shadow: true, activation: false, backup: true, purge: true, lifecycleFormat: lifecycle.format }, characters: [...roles].map(([id, db]) => ({ characterId: id, ...db.prepare('SELECT * FROM metadata WHERE id=1').get(), eventCount: db.prepare('SELECT count(*) AS n FROM events').get().n, memoryVersionCount: db.prepare('SELECT count(*) AS n FROM memory_versions').get().n })) };
  }
  function getMemoryReceipt(ctx, operationId) {
    const own = ctx.admin === true ? administration.progress(ctx, operationId) : null;
    if (own) return own;
    const result = lookupMemoryReceipt(ctx, operationId), binding = ctx.admin === true ? administration.requestBinding(ctx, operationId) : null;
    return binding ? { ...result, ...(result.operationState === 'not_found' ? { operationState:'not_started', sourceState:'not_applicable', acceptance:'durable-request-binding-only' } : {}), requestBinding:binding } : result;
  }
  function lookupMemoryReceipt(ctx, operationId) {
    identifier(operationId);
    if (ctx.admin === true) {
      requireThat(ctx.purpose === 'admin' && ctx.storeGeneration === generation, 'MEMORY_ADMIN_REQUIRED', 'A live management receipt capability is required.');
      state();
    } else validate(ctx);
    if (ctx.admin === true && control.prepare('SELECT operationId FROM lifecycle_ops WHERE operationId=?').get(operationId)) return lifecycle.call(ctx, 'progress', { operationId });
    const action = control.prepare('SELECT * FROM privacy_actions WHERE operationId=?').get(operationId);
    if (action) {
      requireThat(ctx.admin === true && action.characterId === ctx.characterId, 'MEMORY_ADMIN_REQUIRED', 'Control receipts require the matching management context.');
      const applied = role(ctx.characterId).prepare('SELECT appliedControlRevision FROM metadata WHERE id=1').get().appliedControlRevision;
      return { ...parse(action.result), appliedControlRevision: applied, applied: applied >= action.revision };
    }
    const row = role(ctx.characterId).prepare('SELECT result,requestScope FROM operations WHERE operationId=?').get(operationId);
    requireThat(!row || ctx.admin === true || row.requestScope === requestScope(ctx), 'MEMORY_RECEIPT_DENIED', 'The receipt belongs to another trusted audience.', 'Query it using the original channel context or authenticated management.');
    return row ? parse(row.result) : { ...receipt(operationId), operationState: 'not_found', retry: 'same_id_after_verified_absence' };
  }
  function ingestEvents(ctx, batch, operationId, refs = []) {
    const db = validate(ctx), input = manifest(db, ctx, refs);
    identifier(operationId);
    requireThat(Array.isArray(batch.events) && batch.events.length > 0 && batch.events.length <= 100, 'MEMORY_BATCH_INVALID', 'A batch must contain 1 to 100 complete event parts.');
    const events = batch.events.map(validateEvent);
    requireThat(Buffer.byteLength(canonical(batch)) <= 1024 * 1024, 'MEMORY_BATCH_INVALID', 'An ingest batch may not exceed 1 MiB.');
    const requestDigest = digest({ batch, refs });
    for (const event of events) requireThat(!lifecycle.eventDeleted(ctx.characterId, event), 'MEMORY_SOURCE_DELETED', 'A permanently deleted source cannot be replayed.');
    const prior = existing(db, operationId, requestDigest, ctx); if (prior) return prior;
    return transaction(db, operationId, () => {
      const again = existing(db, operationId, requestDigest, ctx); if (again) return again;
      const inheritedRoots = input.flatMap((item) => parse(item.row.roots)), inheritedPolicies = input.flatMap((item) => parse(item.row.policies));
      const rootsBlocked = blockedRoots(ctx.characterId), ids = [];
      for (const event of events) {
        requireThat(!lifecycle.eventDeleted(ctx.characterId, event, inheritedRoots), 'MEMORY_SOURCE_DELETED', 'A permanently deleted source identity cannot be collected under new event IDs.');
        requireThat(event.characterId === ctx.characterId && event.capturedEpoch === ctx.capturedEpoch && event.channel === ctx.channel && event.conversationKey === ctx.conversationKey && event.actorAccountKey === ctx.sourceAccountKey && event.policyId === ctx.audiencePolicyId && event.processingGrantId === ctx.processingGrantId, 'MEMORY_EVENT_CONTEXT_MISMATCH', 'Event identity does not match the trusted Host context.');
        const roots = unique([event.rootEventId, ...inheritedRoots]);
        requireThat(!roots.some((root) => rootsBlocked.has(root)), 'MEMORY_ROOT_SUPPRESSED', 'A source root is suppressed and cannot be collected or regenerated.');
        const old = db.prepare('SELECT * FROM events WHERE eventId=? OR sourceKey=? OR operationId=?').all(event.eventId, event.sourceKey, event.operationId);
        if (old.length) {
          requireThat(old.length === 1 && old[0].payloadDigest === event.payloadDigest && canonical(parse(old[0].roots)) === canonical(roots) && canonical(parse(old[0].policies)) === canonical(unique([event.policyId, ...inheritedPolicies])), 'MEMORY_DIGEST_CONFLICT', 'An event, source key, or event operationId already identifies different content or dependencies.');
          ids.push(old[0].eventId); continue;
        }
        const policies = unique([event.policyId, ...inheritedPolicies]);
        const effective = intersectPolicies(policies.map(policy));
        requireThat(effective.audiences.length && effective.processingGrants.length, 'MEMORY_POLICY_INTERSECTION_EMPTY', 'Actual event dependencies have no common approved audience.');
        const payload = { ...event, inputManifest: input.map((item) => item.ref), ingestedAt: new Date(now()).toISOString() };
        db.prepare('INSERT INTO events(eventId,sourceKey,operationId,payloadDigest,policyId,payload,roots,policies) VALUES(?,?,?,?,?,?,?,?)').run(event.eventId, event.sourceKey, event.operationId, event.payloadDigest, event.policyId, canonical(payload), canonical(roots), canonical(policies));
        db.prepare('UPDATE source_clock SET sequence=sequence+1 WHERE id=1').run();
        db.prepare('INSERT INTO source_sequence VALUES(?,(SELECT sequence FROM source_clock WHERE id=1))').run(event.eventId);
        index(db, 'event', event.eventId, 1, event.content); administration.dependencies(db, ctx.characterId, 'event', event.eventId, 1, input); ids.push(event.eventId);
      }
      const offsetKeys = ['startOffset', 'nextOffset', 'positions'];
      requireThat(offsetKeys.every((key) => batch[key] === undefined) || offsetKeys.every((key) => batch[key] !== undefined), 'MEMORY_OFFSET_GAP', 'A spool batch must provide its complete byte range and every position.');
      if (batch.startOffset !== undefined) {
        requireThat(Number.isSafeInteger(batch.startOffset) && batch.startOffset >= 0 && Number.isSafeInteger(batch.nextOffset) && batch.nextOffset > batch.startOffset, 'MEMORY_OFFSET_GAP', 'Spool positions must be nonnegative complete byte offsets.');
        identifier(batch.producerId); identifier(batch.segmentId);
        const old = db.prepare('SELECT position FROM ingest_offsets WHERE producerId=? AND segmentId=?').get(batch.producerId, batch.segmentId);
        requireThat((old?.position ?? 0) === batch.startOffset && batch.positions?.length === events.length, 'MEMORY_OFFSET_GAP', 'The batch does not start at the committed contiguous byte cursor.');
        let cursor = batch.startOffset;
        for (let i = 0; i < events.length; i++) {
          requireThat(Number.isSafeInteger(batch.positions[i].start) && Number.isSafeInteger(batch.positions[i].end) && batch.positions[i].start === cursor && batch.positions[i].end > cursor && events[i].producerId === batch.producerId && events[i].segmentId === batch.segmentId, 'MEMORY_OFFSET_GAP', 'A producer byte range has a gap or mixed identity.');
          cursor = batch.positions[i].end;
        }
        requireThat(cursor === batch.nextOffset, 'MEMORY_OFFSET_GAP', 'The final byte cursor does not match the batch range.');
        db.prepare('INSERT INTO ingest_offsets VALUES(?,?,?,?) ON CONFLICT(producerId,segmentId) DO UPDATE SET position=excluded.position,sourceDigest=excluded.sourceDigest').run(batch.producerId, batch.segmentId, cursor, digest(events.map((event) => event.payloadDigest)));
      }
      const eventRefs = ids.map((id) => { const stored = db.prepare('SELECT eventId,payloadDigest FROM events WHERE eventId=?').get(id); return { type: 'event', id: stored.eventId, revision: 1, payloadDigest: stored.payloadDigest }; });
      return saveReceipt(db, operationId, requestDigest, receipt(operationId, { sourceState: 'committed', indexState: 'ready', eventIds: ids, eventRefs, nextOffset: batch.nextOffset ?? null }), ctx);
    });
  }
  function searchMemory(ctx, query, options = {}) {
    const db = validate(ctx, { permitAdmin: true });
    requireThat(typeof query === 'string' && query.length <= 6000, 'MEMORY_QUERY_INVALID', 'Query must be bounded text from the current authorized conversation.');
    const limit = Math.min(80, Math.max(1, Number.isInteger(options.limit) ? options.limit : 80));
    const queryTerms = terms(query);
    if (options.personId !== undefined) identifier(options.personId, 'personId');
    if (!queryTerms.length && !options.personId) return { ok: true, records: [], candidateCount: 0 };
    const hits = options.personId ? db.prepare('SELECT recordType,recordId,revision,1 AS overlap FROM search_docs').all() : db.prepare(`SELECT recordType,recordId,revision,COUNT(*) AS overlap FROM terms WHERE term IN (${queryTerms.map(() => '?').join(',')}) GROUP BY recordType,recordId,revision`).all(...queryTerms);
    const authorized = [];
    for (const hit of hits) {
      const row = hit.recordType === 'event' ? db.prepare('SELECT * FROM events WHERE eventId=?').get(hit.recordId)
        : db.prepare('SELECT v.* FROM memory_versions v JOIN memories m ON v.memoryId=m.memoryId AND v.revision=m.currentRevision WHERE v.memoryId=? AND v.revision=?').get(hit.recordId, hit.revision);
      if (!row || !visible(row, ctx, { admin: ctx.admin === true })) continue;
      const payload = parse(row.payload);
      if (payload.expiresAt && Date.parse(payload.expiresAt) <= now()) continue;
      if (options.personId && administration.identity(ctx.characterId, payload).personId !== options.personId) continue;
      authorized.push({ identity: administration.identity(ctx.characterId, payload), type: hit.recordType, id: hit.recordId, revision: hit.revision, payloadDigest: row.payloadDigest, content: payload.content, subject: payload.subject ?? '', certainty: payload.certainty ?? 'unknown', attribution: payload.attribution ?? 'statement', coverage: payload.coverage ?? {}, textCompleteness: payload.textCompleteness ?? 'complete', roots: parse(row.roots), policyIds: parse(row.policies), validFrom: payload.validFrom ?? null, validTo: payload.validTo ?? null, occurredAt: payload.occurredAt ?? null, observedAt: payload.observedAt ?? null, recordedAt: payload.recordedAt ?? null, overlap: hit.overlap });
    }
    authorized.sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      const timeA = Date.parse(a.occurredAt ?? a.recordedAt ?? a.observedAt ?? a.validFrom ?? '') || 0;
      const timeB = Date.parse(b.occurredAt ?? b.recordedAt ?? b.observedAt ?? b.validFrom ?? '') || 0;
      if (timeA !== timeB) return timeB - timeA;
      if (a.type !== b.type) return a.type === 'memory' ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    return { ok: true, records: authorized.slice(0, limit), candidateCount: Math.min(authorized.length, 80), ranking: 'authorized-lexical-overlap', tokenAccounting: 'estimated' };
  }
  function prepareMemoryContext(ctx, query, budget = {}) {
    const found = searchMemory(ctx, query);
    const maxChars = Math.min(1800, Number.isInteger(budget.memory) ? Math.max(0, budget.memory) : 1800, Number.isInteger(budget.total) ? Math.max(0, budget.total) : 6000);
    const allowExcerpt = Boolean(budget.allowExcerpt);
    const selected = [], roots = new Set(); let text = '';
    for (const item of found.records) {
      if (selected.length === 8) break;
      if (!administration.isHot(role(ctx.characterId), item.type, item.id, item.revision)) continue;
      if (item.textCompleteness !== 'complete' || (!allowExcerpt && item.content.length > 320) || item.roots.some((root) => roots.has(root))) continue;
      let displayContent = item.content;
      if (displayContent.length > 320) {
        displayContent = `${displayContent.slice(0, 310)}…`;
      }
      const timeParts = [];
      if (item.validFrom || item.validTo) timeParts.push(`valid=${item.validFrom ?? '*'}..${item.validTo ?? '*'}`);
      if (item.occurredAt) timeParts.push(`occurredAt=${item.occurredAt}`);
      else if (item.recordedAt) timeParts.push(`recordedAt=${item.recordedAt}`);
      const timeTag = timeParts.length > 0 ? `;${timeParts.join(';')}` : '';
      const line = `[${item.type}:${item.id}@${item.revision};${item.certainty};${item.subject}${timeTag};coverage=${canonical(item.coverage)}${item.identity.state === 'confirmed' ? `;identity=${canonical(item.identity)}` : ''}] ${displayContent}`;
      if ((text ? text.length + 1 : 0) + line.length > maxChars) continue;
      text += `${text ? '\n' : ''}${line}`; selected.push(item); item.roots.forEach((root) => roots.add(root));
    }
    const db = role(ctx.characterId);
    const prepared = { schemaVersion: SCHEMA_VERSION, ...Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, ctx[key]])), queryDigest: digest(query), eventWatermark: db.prepare('SELECT commitSequence FROM metadata WHERE id=1').get().commitSequence, expiresAt: now() + 30000, evidenceIds: selected.map((item) => item.id), inputManifest: selected.map((item) => ({ type: item.type, id: item.id, revision: item.revision, payloadDigest: item.payloadDigest })), text, budget: { memory: maxChars, total: Math.min(6000, budget.total ?? 6000), candidates: 80, selected: 8, excerpt: 320, tokenAccounting: 'estimated' } };
    return { ok: true, prepared };
  }
  function proposeMemory(ctx, proposal, refs) {
    const db = validate(ctx), operationId = identifier(proposal.operationId), requestDigest = digest({ proposal, refs });
    const prior = existing(db, operationId, requestDigest, ctx); if (prior) return prior;
    const allowed = new Set(['operationId', 'memoryId', 'expectedRevision', 'propositionKey', 'kind', 'subject', 'content', 'certainty', 'attribution', 'validFrom', 'validTo', 'evidenceRefs', 'links', 'jobId', 'commitment']);
    requireThat(Object.keys(proposal).every((key) => allowed.has(key)), 'MEMORY_FIELD_FORBIDDEN', 'Proposals cannot mutate corePersona, permissions, binding, or control fields.');
    requireThat(['episode', 'fact', 'relation', 'commitment', 'open_topic', 'reflection', 'preference', 'self_view'].includes(proposal.kind), 'MEMORY_PROPOSAL_INVALID', 'Unsupported memory kind.');
    requireThat(typeof proposal.content === 'string' && proposal.content.length > 0 && typeof proposal.subject === 'string' && proposal.subject.length > 0 && ['observed', 'reported', 'inferred', 'unknown'].includes(proposal.certainty), 'MEMORY_PROPOSAL_INVALID', 'A proposal requires content, an explicit subject, and certainty.');
    const input = manifest(db, ctx, refs);
    requireThat(input.length > 0 && Array.isArray(proposal.evidenceRefs) && proposal.evidenceRefs.length > 0, 'MEMORY_EVIDENCE_REQUIRED', 'A proposal must cite exact spans in actual Host inputs.');
    for (const evidence of proposal.evidenceRefs) {
      const found = input.find((item) => item.ref.type === evidence.type && item.ref.id === evidence.id && item.ref.revision === evidence.revision);
      requireThat(found && Number.isInteger(evidence.start) && Number.isInteger(evidence.end) && evidence.start >= 0 && evidence.end > evidence.start && found.payload.content.slice(evidence.start, evidence.end) === evidence.text, 'MEMORY_EVIDENCE_SPAN_INVALID', 'A claimed evidence span does not match the actual input.');
      if (found.payload.textCompleteness === 'segmented') {
        const siblings = input.filter((item) => item.ref.type === 'event' && item.payload.rootEventId === found.payload.rootEventId);
        requireThat(siblings.length === found.payload.partCount && new Set(siblings.map((item) => item.payload.partIndex)).size === found.payload.partCount && siblings.every((item) => item.payload.wholeDigest === found.payload.wholeDigest), 'MEMORY_EVIDENCE_INCOMPLETE', 'A segmented source requires every original part in the actual input manifest.', 'Load all authorized parts of the original source before proposing a summary.');
      }
      requireThat(proposal.subject === found.payload.subject, 'MEMORY_SUBJECT_UNPROVEN', 'The proposed subject is not established by its cited input.');
      requireThat(proposal.certainty !== 'observed' || (found.payload.certainty === 'observed' && ['action', 'reflection'].includes(found.payload.attribution) && ['episode', 'reflection'].includes(proposal.kind)), 'MEMORY_REALITY_UPGRADE_DENIED', 'Reported, quoted, inferred, planned, or conditional material cannot become an observed external fact.');
    }
    for (const key of ['validFrom', 'validTo']) requireThat(proposal[key] === undefined || proposal[key] === null || Number.isFinite(Date.parse(proposal[key])), 'MEMORY_PROPOSAL_INVALID', `Invalid ${key}.`);
    if (proposal.validFrom && proposal.validTo) requireThat(Date.parse(proposal.validFrom) <= Date.parse(proposal.validTo), 'MEMORY_PROPOSAL_INVALID', 'The validity interval is reversed.');
    const roots = unique(input.flatMap((item) => parse(item.row.roots))), policyIds = unique(input.flatMap((item) => parse(item.row.policies)));
    const effective = intersectPolicies(policyIds.map(policy));
    requireThat(effective.audiences.length > 0 && effective.processingGrants.length > 0, 'MEMORY_POLICY_INTERSECTION_EMPTY', 'All actual inputs must share a processing and audience domain.');
    const domain = digest(effective), propositionKey = identifier(proposal.propositionKey), old = db.prepare('SELECT * FROM memories WHERE propositionKey=? AND lineageDomainId=?').get(propositionKey, domain);
    requireThat((old?.currentRevision ?? 0) === proposal.expectedRevision, 'MEMORY_REVISION_CONFLICT', 'The current memory revision changed.', 'Refresh the current version and review the proposal before resubmitting.');
    const id = proposal.memoryId ?? old?.memoryId ?? `mem-${digest([propositionKey, domain]).slice(0, 32)}`;
    identifier(id);
    requireThat(!old || id === old.memoryId, 'MEMORY_REVISION_CONFLICT', 'The proposal targets a different domain version chain.');
    requireThat(!input.some((item) => item.ref.type === 'memory' && item.ref.id === id), 'MEMORY_DEPENDENCY_CYCLE', 'A memory cannot depend on its own version chain.');
    const links = proposal.links ?? [];
    requireThat(Array.isArray(links) && links.length <= 20, 'MEMORY_LINK_INVALID', 'At most 20 bounded one-hop links are accepted.');
    for (const link of links) {
      requireThat(['supports', 'derived_from', 'supersedes', 'contradicts'].includes(link.type), 'MEMORY_LINK_INVALID', 'Unsupported dependency edge.');
      const dependency = input.find((item) => item.ref.type === 'memory' && item.ref.id === link.id && item.ref.revision === link.revision);
      requireThat(dependency && link.id !== id, 'MEMORY_LINK_INVALID', 'Every edge must target an actual authorized existing input version.');
      const cycle = db.prepare('WITH RECURSIVE deps(id,rev) AS (SELECT toId,toRevision FROM links WHERE fromId=? AND fromRevision=? UNION SELECT l.toId,l.toRevision FROM links l JOIN deps d ON l.fromId=d.id AND l.fromRevision=d.rev) SELECT id FROM deps WHERE id=? LIMIT 1').get(link.id, link.revision, id);
      requireThat(!cycle, 'MEMORY_DEPENDENCY_CYCLE', 'The proposed derived dependency graph would become cyclic.');
    }
    if (proposal.jobId) {
      const job = db.prepare('SELECT * FROM jobs WHERE jobId=?').get(identifier(proposal.jobId)), jobState = job && organizeState(job);
      requireThat(ctx.purpose === 'organize' && jobState && refDigest(parse(job.inputs)) === refDigest(refs), 'MEMORY_ORGANIZE_JOB_INVALID', 'An organizer candidate must bind its actual durable source job and full input manifest.');
    }
    const citedRoots = new Map(), visitedEvidence = new Set(); let citedDerived=false;
    function cited(ref) {
      const key = canonical([ref.type,ref.id,ref.revision]); if (visitedEvidence.has(key)) return; visitedEvidence.add(key);
      requireThat(visitedEvidence.size <= 256, 'MEMORY_GROWTH_EVIDENCE_LIMIT', 'The cited provenance expansion exceeds its bounded root inspection.');
      const row = ref.type === 'event' ? db.prepare('SELECT * FROM events WHERE eventId=?').get(ref.id) : db.prepare('SELECT * FROM memory_versions WHERE memoryId=? AND revision=?').get(ref.id,ref.revision);
      requireThat(row && visible(row,ctx), 'MEMORY_GROWTH_SOURCE_STALE', 'An actually cited original dependency is no longer authorized and active.');
      const value = parse(row.payload);
      if (ref.type === 'event') { if(value.inputManifest?.length){ citedDerived=true; return; } if (!citedRoots.has(value.rootEventId)) citedRoots.set(value.rootEventId,value); }
      else for (const actual of value.evidenceRefs ?? []) cited(actual);
    }
    for (const ref of proposal.evidenceRefs) cited(ref);
    const previousRow = old ? db.prepare('SELECT * FROM memory_versions WHERE memoryId=? AND revision=?').get(old.memoryId,old.currentRevision) : null;
    const previous = previousRow ? parse(previousRow.payload) : undefined;
    if (proposal.commitment && previous?.commitment) requireThat(visible(previousRow,ctx), 'MEMORY_GROWTH_SOURCE_STALE', 'The actual previous commitment is no longer authorized and active.');
    const counterEvidence = old ? db.prepare("SELECT v.* FROM links l JOIN memory_versions v ON (v.memoryId=l.fromId AND v.revision=l.fromRevision) OR (v.memoryId=l.toId AND v.revision=l.toRevision) WHERE l.type='contradicts' AND (l.fromId=? OR l.toId=?) AND v.memoryId!=? AND v.status='active'").all(old.memoryId,old.memoryId,old.memoryId).map((row) => ({ ...parse(row.payload), status:row.status })) : [];
    const growth = citedDerived && citedRoots.size===0 && ['reflection','preference','self_view','commitment'].includes(proposal.kind) ? {ok:false,selectionState:'review',code:'MEMORY_GROWTH_DERIVED_EVIDENCE',error:'Derived views and reflections do not establish independent original observations.',hint:'Cite the actual original source events explicitly; preserve the full actual manifest for privacy and deletion.'} : validateGrowthProposal({ proposal, rootEvents:[...citedRoots.values()], previous, counterEvidence, asOf:new Date(now()).toISOString() });
    if (!growth.ok) return transaction(db, operationId, () => {
      db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(`candidate-${digest(operationId).slice(0,32)}`,canonical(refs),canonical({ type:'growth-candidate',status:growth.selectionState,proposal,code:growth.code }));
      const result = { ...receipt(operationId,{ sourceState:'not_applicable',selectionState:growth.selectionState,jobId:proposal.jobId ?? null }), ...growth, ok:growth.selectionState === 'review' };
      return saveReceipt(db,operationId,requestDigest,result,ctx);
    });
    if (growth.commitment && previous?.commitment) { for (const root of parse(previousRow.roots)) if (!roots.includes(root)) roots.push(root); for (const id of parse(previousRow.policies)) if (!policyIds.includes(id)) policyIds.push(id); requireThat(digest(intersectPolicies(policyIds.map(policy))) === domain,'MEMORY_POLICY_INTERSECTION_EMPTY','A commitment transition cannot widen its previous source domain.'); }
    const revision = (old?.currentRevision ?? 0) + 1;
    const payload = { content: proposal.content, subject: proposal.subject, kind: proposal.kind, certainty: proposal.certainty, attribution: proposal.attribution ?? 'statement', validFrom: proposal.validFrom ?? null, validTo: proposal.validTo ?? null, recordedAt: new Date(now()).toISOString(), inputManifest: input.map((item) => item.ref), evidenceRefs: proposal.evidenceRefs, coverage: input.map((item) => item.payload.coverage ?? {}), roots, lineageDomainId: domain, ...(growth.growth ? { growth:growth.growth } : {}), ...(growth.commitment ? { commitment:growth.commitment } : {}) };
    return transaction(db, operationId, () => {
      if (old) {
        db.prepare("UPDATE memory_versions SET status='superseded' WHERE memoryId=? AND revision=?").run(id, old.currentRevision);
        db.prepare("UPDATE memories SET currentRevision=?,kind=?,status='active' WHERE memoryId=? AND currentRevision=?").run(revision, proposal.kind, id, proposal.expectedRevision);
      } else db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,'active')").run(id, propositionKey, domain, revision, proposal.kind);
      db.prepare("INSERT INTO memory_versions VALUES(?,?,?,?,?,?,'active')").run(id, revision, digest(payload), canonical(payload), canonical(roots), canonical(policyIds));
      const dependencyLinks = input.filter((item) => item.ref.type === 'memory').map((item) => ({ ...item.ref, type: 'derived_from' }));
      for (const link of [...dependencyLinks, ...links]) db.prepare('INSERT OR IGNORE INTO links VALUES(?,?,?,?,?)').run(id, revision, link.id, link.revision, link.type);
      index(db, 'memory', id, revision, payload.content);
      administration.dependencies(db, ctx.characterId, 'memory', id, revision, input);
      return saveReceipt(db, operationId, requestDigest, receipt(operationId, { sourceState: 'committed', selectionState: 'committed', indexState: 'ready', memoryId: id, revision, lineageDomainId: domain, jobId: proposal.jobId ?? null }), ctx);
    });
  }
  function applyMemoryAction(ctx, action, expectedRevision, operationId) {
    const s = state(); identifier(operationId);
    requireThat(ctx.admin === true && ctx.purpose === 'admin' && ctx.storeGeneration === generation, 'MEMORY_ADMIN_REQUIRED', 'A live trusted management context is required.');
    const requestDigest = digest({ action, expectedRevision, characterId: ctx.characterId });
    const prior = control.prepare('SELECT * FROM privacy_actions WHERE operationId=?').get(operationId);
    if (prior) {
      requireThat(prior.requestDigest === requestDigest, 'MEMORY_DIGEST_CONFLICT', 'The management operationId identifies a different action.');
      applyControls(ctx.characterId);
      return { ...parse(prior.result), applied: true, appliedControlRevision: state().revision };
    }
    requireThat(expectedRevision === s.revision && ctx.controlRevision === s.revision, 'MEMORY_REVISION_CONFLICT', 'The management preview revision is stale.', 'Refresh the management preview and confirm the exact current revision.');
    requireThat(['configure_policy', 'enable_shadow', 'suppress', 'invalidate', 'revoke_policy', 'binding_barrier', 'correct'].includes(action.type), 'MEMORY_ACTION_UNAVAILABLE', 'This management action is unavailable in the current memory kernel.', 'Production activation, backup, restore, migration and purge require a later verified phase.');
    let configured, correction;
    if (action.type === 'configure_policy') {
      configured = validatePolicy(action.policy);
      const previous = policy(configured.policyId);
      requireThat(!previous || canonical(previous) === canonical(configured), 'MEMORY_POLICY_IMMUTABLE', 'An existing policy ID cannot change its historical permission domain.', 'Create a new explicitly approved policy ID and revoke the old one; existing provenance keeps its original policy.');
    }
    if (['suppress', 'invalidate', 'correct'].includes(action.type)) {
      requireThat(Array.isArray(action.roots) && action.roots.length > 0 && action.roots.length <= 100, 'MEMORY_ACTION_INVALID', 'Select explicit source roots.'); action.roots.forEach((root) => identifier(root));
    }
    if (action.type === 'revoke_policy') requireThat(policy(identifier(action.policyId)), 'MEMORY_POLICY_REQUIRED', 'The selected policy does not exist.');
    if (action.type === 'correct') {
      const replacement=action.replacement;
      requireThat(replacement && typeof replacement==='object' && !Array.isArray(replacement) && Object.keys(replacement).every((key)=>['type','id','revision','payloadDigest'].includes(key)),'MEMORY_CORRECTION_TEXT_UNSUPPORTED','Correction controls accept only a persisted role-version pointer, never replacement text.','Persist an independent evidence-backed role version first, then provide its id/revision/payloadDigest. The original source has not been changed.');
      requireThat((replacement.type ?? 'memory') === 'memory' && Number.isSafeInteger(replacement.revision) && replacement.revision>=1,'MEMORY_CORRECTION_EVIDENCE_REQUIRED','Select an actual current formal role version.');
      const db=role(ctx.characterId), row=db.prepare('SELECT v.* FROM memory_versions v JOIN memories m ON v.memoryId=m.memoryId AND v.revision=m.currentRevision WHERE v.memoryId=? AND v.revision=?').get(identifier(replacement.id),replacement.revision);
      requireThat(row && visible(row,ctx,{admin:true}) && parse(row.policies).every((id)=>policy(id)?.approved===true) && parse(row.payload).evidenceRefs?.length>0 && !parse(row.roots).some((root)=>action.roots.includes(root)),'MEMORY_CORRECTION_EVIDENCE_REQUIRED','Persist an independent currently authorized evidence-backed replacement before correcting the old source.');
      requireThat(!replacement.payloadDigest || replacement.payloadDigest===row.payloadDigest,'MEMORY_DIGEST_CONFLICT','The replacement pointer differs from the actual role version.');
      correction={type:'memory',id:row.memoryId,revision:row.revision,payloadDigest:row.payloadDigest};
    }
    const revision = s.revision + 1;
    const result = receipt(operationId, { controlRevision: revision, accessState: 'access_revoked', sourceState: 'committed', applied: false, activeBackend: 'v2', ...(correction?{correctionState:'persisted-replacement-linked',replacement:correction}:{}) });
    const committed = transaction(control, operationId, () => {
      if (configured) control.prepare('INSERT INTO policies VALUES(?,?) ON CONFLICT(policyId) DO UPDATE SET payload=excluded.payload').run(configured.policyId, canonical(configured));
      if (action.type === 'revoke_policy') { const p = policy(action.policyId); control.prepare('UPDATE policies SET payload=? WHERE policyId=?').run(canonical({ ...p, approved: false }), action.policyId); }
      const policyIncrement = ['configure_policy', 'revoke_policy'].includes(action.type) ? 1 : 0;
      const deletionIncrement = ['suppress', 'invalidate', 'correct'].includes(action.type) ? 1 : 0;
      // `shadowEnabled` 是影子期历史列：保留写入路径只为让旧库结构一致，
      // 它已不参与任何业务准入（见 validate）。不要据此判断 V2 是否「已激活」。
      control.prepare('UPDATE state SET revision=?,policyRevision=policyRevision+?,bindingRevision=bindingRevision+?,deletionRevision=deletionRevision+?,shadowEnabled=? WHERE id=1').run(revision, policyIncrement, action.type === 'binding_barrier' ? 1 : 0, deletionIncrement, action.type === 'enable_shadow' ? Number(action.enabled === true) : s.shadowEnabled);
      for (const root of action.roots ?? []) control.prepare('INSERT INTO root_controls VALUES(?,?,?,?) ON CONFLICT(characterId,rootId) DO UPDATE SET status=excluded.status,revision=excluded.revision').run(ctx.characterId, root, action.type, revision);
      const descriptor = { type: action.type, roots: action.roots ?? [], policyId: configured?.policyId ?? action.policyId ?? null, replacement: correction ?? null };
      control.prepare('INSERT INTO privacy_actions VALUES(?,?,?,?,?,?)').run(operationId, requestDigest, revision, ctx.characterId, canonical(descriptor), canonical(result));
      return result;
    }, true);
    if (!committed.ok) return committed;
    try { applyControls(ctx.characterId); }
    catch (error) { return { ...fail('MEMORY_CONTROL_BLOCKED', 'Security controls committed, but the character view has not acknowledged them.', 'Reopen the service and query the same management operationId before reading, invoking a model, or sending.'), operationId, controlRevision: revision, accessState: 'access_revoked', applied: false }; }
    return { ...result, applied: true, appliedControlRevision: revision };
  }
  function validateContext(ctx, prepared, refs = []) {
    const db = validate(ctx, { permitAdmin: true });
    const actual=manifest(db, ctx, refs);
    if (prepared) { validatePrepared(prepared, ctx, now()); manifest(db, ctx, prepared.inputManifest); }
    const deadlines=actual.map((item)=>item.payload.expiresAt?Date.parse(item.payload.expiresAt):Infinity); if(prepared) deadlines.push(prepared.expiresAt); const validUntil=Math.min(...deadlines);
    return { ok: true, admission: 'current-snapshot-only', controlRevision: state().revision, storeGeneration: generation, validUntil:Number.isFinite(validUntil)?validUntil:null };
  }
  const refDigest = (refs) => digest([...refs].sort((a,b) => canonical(a).localeCompare(canonical(b))));
  const organizeState = (row) => { try { const value = parse(row.state); return value.type === 'organize-batch' ? value : null; } catch { return null; } };
  const terminalJob = (value) => ['completed', 'review', 'rejected', 'failed'].includes(value);
  function readOrganizeBatch(ctx, options = {}) {
    const db = validate(ctx);
    requireThat(ctx.purpose === 'organize', 'MEMORY_ORGANIZE_REQUIRED', 'Only an authorized Host organization request can load source batches.');
    const limit = options.limit ?? 40, maxInputTokens = options.maxInputTokens ?? 6000;
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 40 && Number.isInteger(maxInputTokens) && maxInputTokens >= 1 && maxInputTokens <= 6000, 'MEMORY_ORGANIZE_BUDGET_INVALID', 'Organization batches allow at most 40 events and 6000 conservative input tokens.');
    const scope = requestScope(ctx), completed = new Set(); let after = 0, highWater = db.prepare('SELECT sequence FROM source_clock WHERE id=1').get().sequence;
    for (const job of db.prepare('SELECT * FROM jobs').all()) { const saved = organizeState(job); if (saved && terminalJob(saved.status)) for (const ref of parse(job.inputs)) completed.add(ref.id); }
    if (options.cursor) {
      const previous = db.prepare('SELECT * FROM jobs WHERE jobId=?').get(identifier(options.cursor.jobId)), saved = previous && organizeState(previous);
      requireThat(saved && options.cursor.scope === scope && options.cursor.highWater === saved.highWater && options.cursor.afterSequence === saved.afterSequence, 'MEMORY_ORGANIZE_CURSOR_INVALID', 'The source cursor does not match a persisted authorized organization cut.');
      requireThat(terminalJob(saved.status), 'MEMORY_ORGANIZE_JOB_PENDING', 'Finish or reconcile the previous durable job before advancing its cursor.');
      manifest(db, ctx, parse(previous.inputs)); after = saved.afterSequence; highWater = saved.highWater;
    }
    const rows = db.prepare('SELECT s.sequence AS sourceSequence,e.* FROM events e JOIN source_sequence s ON s.eventId=e.eventId WHERE s.sequence>? AND s.sequence<=? ORDER BY s.sequence').all(after, highWater), events = [], refs = [], deferred = [];
    let domain = options.domain ?? null, inputTokens = 0, nextSequence = after; const visited = new Set();
    for (const row of rows) {
      if (visited.has(row.eventId) || completed.has(row.eventId) || !visible(row, ctx)) continue;
      const payload = parse(row.payload); if (payload.expiresAt && Date.parse(payload.expiresAt) <= now()) continue;
      const effective = intersectPolicies(parse(row.policies).map(policy)), candidateDomain = digest(effective);
      if (!domain) domain = candidateDomain; if (domain !== candidateDomain) continue;
      const group = payload.textCompleteness === 'segmented' ? rows.filter((other) => parse(other.payload).rootEventId === payload.rootEventId) : [row];
      if (group.some((other) => !visible(other, ctx) || digest(intersectPolicies(parse(other.policies).map(policy))) !== domain)) { deferred.push({ rootEventId: payload.rootEventId, reason: 'incomplete-or-unauthorized-source' }); break; }
      if (payload.textCompleteness === 'segmented' && (group.length !== payload.partCount || new Set(group.map((other) => parse(other.payload).partIndex)).size !== payload.partCount || group.some((other) => { const part = parse(other.payload); return part.partCount !== payload.partCount || part.wholeDigest !== payload.wholeDigest; }))) { deferred.push({ rootEventId: payload.rootEventId, reason: 'incomplete-segment-coverage' }); break; }
      const actual = group.map((other) => parse(other.payload)), actualRefs = group.map((other) => ({ type: 'event', id: other.eventId, revision: 1, payloadDigest: other.payloadDigest }));
      const cost = Buffer.byteLength(canonical({ events: actual, refs: actualRefs }), 'utf8') + 64;
      if (events.length + actual.length > limit || inputTokens + cost > maxInputTokens) { deferred.push({ rootEventId: payload.rootEventId, reason: 'complete-source-exceeds-current-batch-budget', conservativeInputTokens: cost }); break; }
      events.push(...actual); refs.push(...actualRefs); inputTokens += cost; for (const other of group) { visited.add(other.eventId); nextSequence = Math.max(nextSequence, other.sourceSequence); }
    }
    const inputDigest = digest({ events, inputManifest: refs, domain }), jobId = `organize-${digest([ctx.characterId, domain, inputDigest]).slice(0, 32)}`;
    let saved = db.prepare('SELECT * FROM jobs WHERE jobId=?').get(jobId), jobState = saved && organizeState(saved);
    if (events.length && !saved) {
      jobState = { type: 'organize-batch', status: 'pending', domain, inputDigest, highWater, afterSequence: nextSequence, scope, receipt: null, requestId: null };
      const committed = transaction(db, jobId, () => { db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId, canonical(refs), canonical(jobState)); return { ok: true }; }); if (!committed.ok) return committed;
    }
    if (jobState) { highWater = jobState.highWater; nextSequence = jobState.afterSequence; }
    const cursor = { scope, jobId, highWater, afterSequence: nextSequence };
    return { ok: true, events, inputManifest: refs, inputDigest, domain, policyDomain: domain ? intersectPolicies(events.length ? parse(rows.find((row) => row.eventId === events[0].eventId).policies).map(policy) : []) : null, jobId, jobState: jobState?.status ?? 'empty', receipt: jobState?.receipt ?? null, highWater, cursor, deferred, inputTokens, tokenAccounting: ['utf8','byte','upper','bound'].join('-'), automaticModelCall: false };
  }
  function finishOrganizeBatch(ctx, request, operationId) {
    const db = validate(ctx); requireThat(ctx.purpose === 'organize', 'MEMORY_ORGANIZE_REQUIRED', 'Only an authorized organization request may finish source jobs.');
    identifier(operationId); identifier(request?.jobId); identifier(request.requestId);
    requireThat(['completed', 'review', 'rejected', 'model_unknown', 'failed'].includes(request.state) && Array.isArray(request.candidates) && request.candidates.length <= 8, 'MEMORY_ORGANIZE_RESULT_INVALID', 'Use a supported durable job outcome and at most eight candidate operation receipts.');
    const row = db.prepare('SELECT * FROM jobs WHERE jobId=?').get(request.jobId), saved = row && organizeState(row);
    requireThat(saved && saved.inputDigest === request.inputDigest && refDigest(parse(row.inputs)) === refDigest(request.inputManifest ?? []) && request.cursor?.jobId === request.jobId && request.cursor.highWater === saved.highWater && request.cursor.afterSequence === saved.afterSequence && request.cursor.scope === requestScope(ctx), 'MEMORY_ORGANIZE_JOB_INVALID', 'The job input digest, actual source references, or cursor does not match the durable job.');
    manifest(db, ctx, parse(row.inputs));
    const requestDigest = digest(request), prior = existing(db, operationId, requestDigest, ctx); if (prior) return prior;
    requireThat(!terminalJob(saved.status) && (!saved.requestId || saved.requestId === request.requestId), 'MEMORY_ORGANIZE_JOB_CLAIMED', 'The job already completed or belongs to another durable model request.');
    const candidates = request.candidates.map((candidate) => {
      const id = candidate.operationId ?? candidate.receipt?.operationId; identifier(id);
      const operation = db.prepare('SELECT * FROM operations WHERE operationId=?').get(id);
      if (!operation && candidate.phase === 'rejected' && candidate.ok === false && ['code','error','hint'].every((key) => typeof candidate[key] === 'string' && candidate[key].length > 0 && candidate[key].length <= 1000)) return { operationId:id, phase:'rejected', ok:false, selectionState:'rejected', code:candidate.code, error:candidate.error, hint:candidate.hint, persistence:'host-local-rejection-only' };
      requireThat(operation && operation.requestScope === requestScope(ctx), 'MEMORY_ORGANIZE_RECEIPT_MISSING', 'A candidate has no committed operation receipt in this authorized scope.');
      const result = parse(operation.result); requireThat(result.jobId === request.jobId, 'MEMORY_ORGANIZE_RECEIPT_MISMATCH', 'A candidate receipt belongs to another source job.');
      return { operationId: id, selectionState: result.selectionState, memoryId: result.memoryId ?? null };
    });
    requireThat(request.state !== 'model_unknown' || candidates.length === 0, 'MEMORY_ORGANIZE_RESULT_INVALID', 'A pre-model claim cannot already contain formal candidate receipts.');
    return transaction(db, operationId, () => {
      const result = receipt(operationId, { sourceState: 'not_applicable', jobId: request.jobId, requestId: request.requestId, jobState: request.state, selectionState: request.state === 'review' ? 'review' : 'not_selected', cursor: request.cursor, candidates });
      db.prepare('UPDATE jobs SET state=? WHERE jobId=?').run(canonical({ ...saved, status: request.state, requestId: request.requestId, receipt: result }), request.jobId);
      return saveReceipt(db, operationId, requestDigest, result, ctx);
    });
  }
  control.exec(`CREATE TABLE IF NOT EXISTS producer_registrations(registrationId TEXT PRIMARY KEY,producerId TEXT NOT NULL,segmentId TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(producerId,segmentId));
    CREATE TABLE IF NOT EXISTS producer_registration_ops(operationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,result TEXT NOT NULL);`);
  function producerRegistration(registrationId) {
    state(); const row = control.prepare('SELECT payload FROM producer_registrations WHERE registrationId=?').get(identifier(registrationId));
    requireThat(row, 'MEMORY_PRODUCER_NOT_REGISTERED', 'No durable original producer registration exists.'); return { ok: true, registration: parse(row.payload) };
  }
  function producerRegistrationReceipt(operationId) { state(); const row=control.prepare('SELECT result FROM producer_registration_ops WHERE operationId=?').get(identifier(operationId)); if(!row) return {ok:true,found:false}; const result=parse(row.result); return {ok:true,found:true,registration:producerRegistration(result.registrationId).registration,receipt:result}; }
  function registerProducer(ctx, producer, operationId) {
    validate(ctx); requireThat(producer && Object.keys(producer).every((key)=>['producerId','segmentId'].includes(key)),'MEMORY_FIELD_FORBIDDEN','Original producer role, epoch and grants come only from the trusted live context.'); identifier(producer?.producerId); identifier(producer?.segmentId); identifier(operationId);
    const registration = Object.fromEntries(['characterId', 'capturedEpoch', 'channel', 'conversationKey', 'sourceAccountKey', 'requesterAccountKey', 'audiencePolicyId', 'processingGrantId', 'providerRouteId'].map((key) => [key, ctx[key]]));
    Object.assign(registration, { producerId: producer.producerId, segmentId: producer.segmentId });
    const requestDigest = digest(registration), prior = control.prepare('SELECT * FROM producer_registration_ops WHERE operationId=?').get(operationId);
    if (prior) { requireThat(prior.requestDigest === requestDigest, 'MEMORY_DIGEST_CONFLICT', 'The producer operationId already binds a different original scope.'); return parse(prior.result); }
    const registrationId = `producer-${requestDigest.slice(0, 32)}`, existing = control.prepare('SELECT * FROM producer_registrations WHERE producerId=? AND segmentId=?').get(producer.producerId, producer.segmentId);
    requireThat(!existing || existing.registrationId === registrationId, 'MEMORY_PRODUCER_SCOPE_CONFLICT', 'This producer segment is already bound to another immutable original scope.');
    const result = receipt(operationId, { sourceState: 'not_applicable', registrationState: 'durable', registrationId, characterId: ctx.characterId, capturedEpoch: ctx.capturedEpoch });
    return transaction(control, operationId, () => { control.prepare('INSERT OR IGNORE INTO producer_registrations VALUES(?,?,?,?)').run(registrationId, producer.producerId, producer.segmentId, canonical({ registrationId, ...registration })); control.prepare('INSERT INTO producer_registration_ops VALUES(?,?,?)').run(operationId, requestDigest, canonical(result)); return result; }, true);
  }
  function producerContext(registrationId) {
    const registered = producerRegistration(registrationId).registration; admission(registered.characterId); applyControls(registered.characterId); const s = state();
    return { ...registered, purpose: 'producer_replay', storeGeneration: generation, controlRevision: s.revision, policyRevision: s.policyRevision, bindingRevision: s.bindingRevision, deletionRevision: s.deletionRevision, admin: false };
  }
  function replayProducer(registrationId, batch, operationId) {
    const ctx = producerContext(registrationId); validate(ctx);
    requireThat(Array.isArray(batch?.events) && batch.events.length > 0 && batch.events.length <= 100 && batch.producerId === ctx.producerId && batch.segmentId === ctx.segmentId, 'MEMORY_PRODUCER_SCOPE_CONFLICT', 'The durable batch must retain its registered producer and segment identity.');
    for (const item of batch.events) {
      const event = validateEvent(item);
      for (const key of ['characterId', 'capturedEpoch', 'channel', 'conversationKey', 'processingGrantId', 'producerId', 'segmentId']) requireThat(event[key] === ctx[key], 'MEMORY_PRODUCER_SCOPE_CONFLICT', `Original producer scope ${key} differs from its durable registration.`);
      requireThat(event.actorAccountKey === ctx.sourceAccountKey, 'MEMORY_PRODUCER_SCOPE_CONFLICT', 'Original event actor differs from its durable registration.');
      for (const key of ['sourceAccountKey', 'requesterAccountKey', 'providerRouteId']) if (key in event) requireThat(event[key] === ctx[key], 'MEMORY_PRODUCER_SCOPE_CONFLICT', 'An extra original scope field conflicts with the durable registration.');
      requireThat(event.policyId === ctx.audiencePolicyId, 'MEMORY_PRODUCER_SCOPE_CONFLICT', 'The original event policy differs from its registration.');
      requireThat(!event.expiresAt || Date.parse(event.expiresAt) > now(), 'MEMORY_SOURCE_EXPIRED', 'Expired queued source cannot be replayed into active memory.');
    }
    return { ...ingestEvents(ctx, batch, operationId), characterId: ctx.characterId, capturedEpoch: ctx.capturedEpoch };
  }
  function queryProducerReceipt(registrationId, operationId) { const ctx = producerContext(registrationId); validate(ctx); const registered = control.prepare('SELECT result FROM producer_registration_ops WHERE operationId=?').get(identifier(operationId)); if (registered) { const result=parse(registered.result); requireThat(result.registrationId===registrationId,'MEMORY_RECEIPT_DENIED','This producer registration receipt belongs to another original scope.'); return result; } return { ...getMemoryReceipt(ctx, operationId), characterId: ctx.characterId, capturedEpoch: ctx.capturedEpoch }; }
  lifecycle = createLifecycle({ stateDir, charactersDir, control, role, closeRole(id) { const db = roles.get(id); if (db) { db.close(); roles.delete(id); } }, transaction, state, generation, now, fault, materializeControls:applyControls, applyRoleControls:(db,id)=>administration?.applyRoleControls(db,id) });
  administration = createAdministration({ control, role, state, generation, now, transaction, fault, applyControls, index, requireKernel: lifecycle.requireAdminKernel, saveReceipt });
  lifecycle.recover(); administration.recover();
  return { metadata, resolveAudience, getStatus, ingestEvents, getMemoryReceipt, searchMemory, prepareMemoryContext, proposeMemory, applyMemoryAction, validateContext, readOrganizeBatch, finishOrganizeBatch, registerProducer, producerRegistration, producerRegistrationReceipt, replayProducer, queryProducerReceipt, admin: (...args) => administration.call(...args), lifecycle: (...args) => { administration.admission(args[0].characterId); return lifecycle.call(...args); }, validateManifest(ctx, refs) { manifest(validate(ctx), ctx, refs); return { ok: true }; }, close() { retire(); return { ok: true }; } };
}
