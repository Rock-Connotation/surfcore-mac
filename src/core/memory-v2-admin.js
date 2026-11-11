import { canonical, digest, eventDigest, identifier, intersectPolicies, normalizeEvent, receipt, redactContent, requireThat } from './memory-v2-contract.js';

const parse = JSON.parse;
const uniq = (items) => [...new Set(items)].sort();
const pending = (operationId, values = {}) => receipt(operationId, { acceptance: 'durable', operationState: 'pending', sourceState: 'pending', retry: 'query_receipt', complete: false, ...values });
const fields = { remove_hot: ['recordId', 'recordRevision'], correct: ['recordId', 'recordRevision', 'content'], create_person: ['platform', 'accountId'], bind_account: ['platform', 'accountId', 'personId'], unbind_account: ['bindingId'] };
const pointer = (record) => ({ type: record.type, id: record.id, revision: record.revision, payloadDigest: record.row.payloadDigest });

export function createAdministration({ control, role, state, generation, now, transaction, fault, applyControls, index, saveReceipt, requireKernel }) {
  control.exec(`CREATE TABLE IF NOT EXISTS admin_request_bindings(operationId TEXT PRIMARY KEY,characterId TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_operations(operationId TEXT PRIMARY KEY,characterId TEXT NOT NULL,requestDigest TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_persons(personId TEXT PRIMARY KEY,characterId TEXT NOT NULL,createdBy TEXT NOT NULL,confirmedAt TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_bindings(bindingId TEXT PRIMARY KEY,characterId TEXT NOT NULL,platform TEXT NOT NULL,accountId TEXT NOT NULL,personId TEXT NOT NULL REFERENCES identity_persons(personId),confirmedBy TEXT NOT NULL,confirmedAt TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS identity_active_account ON identity_bindings(characterId,platform,accountId) WHERE status='active';
    CREATE TABLE IF NOT EXISTS identity_invalidations(characterId TEXT NOT NULL,bindingId TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(characterId,bindingId));`);
  function authority(ctx, current = true) {
    requireThat(ctx.admin === true && ctx.purpose === 'admin' && ctx.storeGeneration === generation, 'MEMORY_ADMIN_REQUIRED', 'An original current-role management capability is required.');
    const head = state();
    if (current) for (const key of ['controlRevision', 'policyRevision', 'bindingRevision', 'deletionRevision']) requireThat(ctx[key] === head[key === 'controlRevision' ? 'revision' : key], 'MEMORY_CONTEXT_STALE', 'The management context no longer matches current controls.', 'Refresh management and query the original operation before resuming.');
    return head;
  }
  function operation(ctx, id) {
    const row = control.prepare('SELECT * FROM admin_operations WHERE operationId=?').get(identifier(id));
    if (!row) return null;
    requireThat(row.characterId === ctx.characterId, 'MEMORY_RECEIPT_DENIED', 'This operation belongs to a different role.');
    return { ...row, payload: parse(row.payload), result: parse(row.result) };
  }
  function requestBinding(ctx, id) {
    const row = control.prepare('SELECT * FROM admin_request_bindings WHERE operationId=?').get(identifier(id));
    if (!row) return null;
    requireThat(row.characterId === ctx.characterId, 'MEMORY_RECEIPT_DENIED', 'This request binding belongs to another role.');
    return parse(row.payload);
  }
  function admission(id, admin = false) {
    if (!admin) requireThat(!control.prepare("SELECT operationId FROM admin_operations WHERE characterId=? AND phase!='completed' LIMIT 1").get(id), 'MEMORY_ADMIN_PENDING', 'A confirmed management operation has not completed its safety barrier.', 'Open authenticated management, query its original operation ID, and explicitly resume it.');
  }
  function bindRequest(ctx, request) {
    authority(ctx); const keys = ['operationId', 'action', 'payloadDigest', 'expectedRevision', 'characterId', 'characterEpoch'];
    requireThat(request && Object.keys(request).length === keys.length && keys.every((key) => Object.hasOwn(request, key)), 'MEMORY_REQUEST_INVALID', 'A complete typed operation-request binding is required.');
    identifier(request.operationId); identifier(request.action); requireThat(/^[a-f0-9]{64}$/.test(request.payloadDigest) && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0 && Number.isSafeInteger(request.characterEpoch), 'MEMORY_REQUEST_INVALID', 'The request digest, revision or epoch is invalid.');
    const prior = requestBinding(ctx, request.operationId);
    if (prior) { requireThat(canonical(prior) === canonical(request), 'MEMORY_DIGEST_CONFLICT', 'This operation ID already binds a different immutable HTTP request.'); return { ok: true, operationId: request.operationId, requestBinding: prior, operationState: 'not_started', sourceState: 'not_applicable' }; }
    requireThat(request.characterId === ctx.characterId && request.characterEpoch === ctx.capturedEpoch, 'MEMORY_REQUEST_SCOPE_DENIED', 'A new binding must name the actual current role and epoch.');
    for (const table of ['admin_operations', 'privacy_actions', 'lifecycle_ops', 'producer_registration_ops']) requireThat(!control.prepare(`SELECT operationId FROM ${table} WHERE operationId=?`).get(request.operationId), 'MEMORY_REQUEST_BINDING_REQUIRED', 'An existing unbound operation cannot be assigned a new request assertion.');
    requireThat(!role(ctx.characterId).prepare('SELECT operationId FROM operations WHERE operationId=?').get(request.operationId), 'MEMORY_REQUEST_BINDING_REQUIRED', 'An existing source operation cannot be assigned a new HTTP request.');
    requireKernel(ctx.characterId);
    return transaction(control, request.operationId, () => { control.prepare('INSERT INTO admin_request_bindings VALUES(?,?,?)').run(request.operationId, ctx.characterId, canonical(request)); return { ok: true, operationId: request.operationId, requestBinding: request, operationState: 'not_started', sourceState: 'not_applicable' }; }, true);
  }
  function record(db, id, revision) {
    identifier(id); requireThat(Number.isSafeInteger(revision) && revision >= 1, 'MEMORY_RECORD_INVALID', 'An exact record revision is required.');
    const event = revision === 1 ? db.prepare('SELECT * FROM events WHERE eventId=?').get(id) : null;
    const memory = db.prepare('SELECT v.*,m.currentRevision,m.propositionKey,m.lineageDomainId,m.kind FROM memory_versions v JOIN memories m ON m.memoryId=v.memoryId WHERE v.memoryId=? AND v.revision=?').get(id, revision);
    requireThat(!(event && memory), 'MEMORY_RECORD_AMBIGUOUS', 'The identifier names both an event and formal record.');
    requireThat(event || memory, 'MEMORY_RECORD_NOT_FOUND', 'The requested record is not in the current role.');
    const row = event ?? memory; return { type: event ? 'event' : 'memory', id, revision, row, payload: parse(row.payload) };
  }
  function account(payload) {
    requireThat(['qq', 'bili', 'douyin', 'local'].includes(payload.platform), 'MEMORY_IDENTITY_INVALID', 'Choose a supported stable account platform.');
    const accountId = identifier(payload.accountId, 'accountId'), key = accountId.startsWith(`${payload.platform}:`) ? accountId : `${payload.platform}:${accountId}`;
    requireThat(!accountId.includes(':') || accountId.startsWith(`${payload.platform}:`), 'MEMORY_IDENTITY_INVALID', 'The account namespace differs from its selected platform.');
    return { platform: payload.platform, accountId: key };
  }
  function anchor(db, selected) {
    const found = db.prepare("SELECT * FROM events WHERE status='active'").all().find((row) => { const p = parse(row.payload); return p.actorAccountKey === selected.accountId && !(p.inputManifest?.length) && !p.manualCorrection && (!p.expiresAt || Date.parse(p.expiresAt) > now()) && parse(row.policies).every((id) => policy(id)?.approved) && !parse(row.roots).some((root) => control.prepare('SELECT rootId FROM root_controls WHERE characterId=? AND rootId=?').get(p.characterId, root)); });
    requireThat(found, 'MEMORY_IDENTITY_EVIDENCE_REQUIRED', 'This role has no original stable source actor for the selected account.', 'Capture an authorized source from that actual platform account; a nickname or typed account string is insufficient.');
    return { type: 'event', id: found.eventId, revision: 1, payloadDigest: found.payloadDigest };
  }
  function requireCurrentOrigins(db, roots, ownExpiry = null) {
    let expiry = ownExpiry;
    for (const row of db.prepare('SELECT payload,roots FROM events').all()) {
      if (!parse(row.roots).some((root) => roots.includes(root))) continue;
      const source = parse(row.payload); if (source.expiresAt && (!expiry || Date.parse(source.expiresAt) < Date.parse(expiry))) expiry = source.expiresAt; requireThat(!source.expiresAt || Date.parse(source.expiresAt) > now(), 'MEMORY_SOURCE_EXPIRED', 'An original source has expired and cannot authorize a new correction.', 'Inspect its original provenance and current permissions before recording a fresh independently authorized statement.');
    }
    requireThat(!expiry || Date.parse(expiry) > now(), 'MEMORY_SOURCE_EXPIRED', 'The correction source authorization has expired.', 'Inspect current source permissions before creating an independent new assertion.'); return expiry;
  }
  function plan(ctx, request, expectedRevision) {
    const head = authority(ctx); requireThat(Number.isSafeInteger(expectedRevision) && expectedRevision === head.revision, 'MEMORY_REVISION_CONFLICT', 'The management preview is based on an old control head.');
    const { action, payload } = request ?? {}; requireThat(fields[action] && payload && Object.keys(payload).length === fields[action].length && fields[action].every((key) => Object.hasOwn(payload, key)), 'MEMORY_ACTION_INVALID', 'The management action payload contains missing or unsupported fields.');
    admission(ctx.characterId); const db = role(ctx.characterId), normalized = { ...payload }; let target = {};
    if (action === 'correct' || action === 'remove_hot') {
      const selected = record(db, payload.recordId, payload.recordRevision);
      requireThat(selected.type === 'event' || selected.row.currentRevision === selected.revision, 'MEMORY_REVISION_CONFLICT', 'Only the exact current formal version can be changed.');
      requireThat(selected.row.status === 'active', 'MEMORY_RECORD_INACTIVE', 'This record is already inactive.', 'Inspect its provenance and existing privacy operation before creating another correction.');
      target = { ...pointer(selected), roots: parse(selected.row.roots), policies: parse(selected.row.policies), domain: selected.row.lineageDomainId ?? digest(intersectPolicies(parse(selected.row.policies).map(policy))) };
      if (action === 'correct') {
        requireThat(typeof payload.content === 'string' && payload.content.trim().length > 0 && Buffer.byteLength(payload.content) <= 65536, 'MEMORY_CORRECTION_INVALID', 'Provide nonempty correction text of at most 64 KiB.');
        target.expiresAt = requireCurrentOrigins(db, target.roots, selected.payload.expiresAt);
        normalized.content = redactContent(payload.content, { scope: 'shared' }); requireThat(normalized.content.trim().length > 0 && Buffer.byteLength(normalized.content) <= 65536, 'MEMORY_CORRECTION_INVALID', 'The normalized correction is empty.');
        requireCurrentOrigins(db, target.roots, target.expiresAt);
    const domain = intersectPolicies(target.policies.map(policy)); requireThat(domain.audiences.length && domain.processingGrants.length, 'MEMORY_POLICY_DENIED', 'Withdrawn source policy cannot authorize a new correction.');
      }
    } else if (action === 'create_person' || action === 'bind_account') {
      Object.assign(normalized, account(payload)); target = { account: { platform: normalized.platform, accountId: normalized.accountId }, anchor: anchor(db, normalized) };
      requireThat(!control.prepare("SELECT bindingId FROM identity_bindings WHERE characterId=? AND platform=? AND accountId=? AND status='active'").get(ctx.characterId, normalized.platform, normalized.accountId), 'MEMORY_IDENTITY_CONFLICT', 'This stable account already has a confirmed person.', 'Inspect its binding; explicitly unbind it before confirming a different association.');
      if (action === 'bind_account') requireThat(control.prepare('SELECT personId FROM identity_persons WHERE characterId=? AND personId=?').get(ctx.characterId, identifier(payload.personId)), 'MEMORY_PERSON_UNCONFIRMED', 'The target person is not confirmed in the current role.');
    } else {
      const binding = control.prepare("SELECT * FROM identity_bindings WHERE characterId=? AND bindingId=? AND status='active'").get(ctx.characterId, identifier(payload.bindingId));
      requireThat(binding, 'MEMORY_BINDING_NOT_FOUND', 'No active binding with this ID exists in the current role.'); target = { bindingId: binding.bindingId, bindingRevision: binding.revision, personId: binding.personId };
    }
    const payloadDigest = digest(normalized), previewDigest = digest({ action, payloadDigest, expectedRevision, characterId: ctx.characterId, characterEpoch: ctx.capturedEpoch, target });
    return { action, normalized, payloadDigest, target, previewDigest, expectedRevision };
  }
  function policy(id) { const row = control.prepare('SELECT payload FROM policies WHERE policyId=?').get(id); return row ? parse(row.payload) : null; }
  function isHot(db, type, id, revision) { const row = db.prepare('SELECT state FROM jobs WHERE jobId=?').get(`hot-${digest([type, id, revision])}`); return !row || parse(row.state).selected !== false; }
  function identity(id, payload) {
    const accountId = payload.eventId ? payload.actorAccountKey : payload.subject;
    const row = control.prepare("SELECT bindingId,personId,revision FROM identity_bindings WHERE characterId=? AND accountId=? AND status='active'").get(id, accountId);
    return row ? { state: 'confirmed', personId: row.personId, accountKey: accountId, bindingId: row.bindingId, bindingRevision: row.revision, evidence: 'manual-administrator-confirmation' } : { state: 'unknown' };
  }
  function dependencies(db, id, type, recordId, revision, inputs) {
    const refs = [];
    for (const item of inputs) {
      const current = identity(id, item.payload); if (current.state === 'confirmed') refs.push({ bindingId: current.bindingId, revision: current.bindingRevision });
      const inherited = db.prepare('SELECT state FROM jobs WHERE jobId=?').get(`identity-${digest([item.ref.type, item.ref.id, item.ref.revision])}`); if (inherited) refs.push(...parse(inherited.state).bindings);
    }
    const bindings = [...new Map(refs.map((ref) => [canonical(ref), ref])).values()];
    if (bindings.length) db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(`identity-${digest([type, recordId, revision])}`, canonical([{ type, id: recordId, revision }]), canonical({ kind: 'identity_dependencies', type, id: recordId, revision, bindings }));
  }
  function applyRoleControls(db, id) {
    const revoked = new Set(control.prepare('SELECT bindingId FROM identity_invalidations WHERE characterId=?').all(id).map((row) => row.bindingId));
    if (!revoked.size) return;
    for (const row of db.prepare("SELECT state FROM jobs WHERE jobId LIKE 'identity-%'").all()) {
      const entry = parse(row.state); if (!entry.bindings.some((ref) => revoked.has(ref.bindingId))) continue;
      if (entry.type === 'event') db.prepare("UPDATE events SET status='invalidated' WHERE eventId=?").run(entry.id);
      else { db.prepare("UPDATE memory_versions SET status='invalidated' WHERE memoryId=? AND revision=?").run(entry.id, entry.revision); db.prepare("UPDATE memories SET status='invalidated' WHERE memoryId=? AND currentRevision=?").run(entry.id, entry.revision); }
    }
  }
  function inspect(ctx, options = {}) {
    const db = role(ctx.characterId); let list;
    if (options.recordId !== undefined) list = [record(db, options.recordId, options.recordRevision)];
    else {
      requireThat(typeof (options.query ?? '') === 'string' && (options.query ?? '').length <= 6000 && (!Object.hasOwn(options, 'limit') || Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 20), 'MEMORY_QUERY_INVALID', 'Use bounded management text and a limit from 1 to 20.');
      const query = (options.query ?? '').toLowerCase(); list = [];
      for (const [type, sql] of [['memory', 'SELECT v.* FROM memory_versions v JOIN memories m ON m.memoryId=v.memoryId AND m.currentRevision=v.revision ORDER BY v.rowid DESC'], ['event', 'SELECT * FROM events ORDER BY rowid DESC']]) for (const row of db.prepare(sql).all()) {
        if (!parse(row.payload).content.toLowerCase().includes(query)) continue;
        list.push({ type, id: row.memoryId ?? row.eventId, revision: row.revision ?? 1, row, payload: parse(row.payload) }); if (list.length >= (options.limit ?? 20)) break;
      }
      list = list.slice(0, options.limit ?? 20);
    }
    return { ok: true, characterId: ctx.characterId, records: list.map((r) => ({ ...pointer(r), content: r.payload.content, subject: r.payload.subject ?? '', status: r.row.status, roots: parse(r.row.roots), hot: isHot(db, r.type, r.id, r.revision), identity: identity(ctx.characterId, r.payload), validFrom: r.payload.validFrom ?? null, validTo: r.payload.validTo ?? null, provenance: { certainty: r.payload.certainty ?? 'unknown', attribution: r.payload.attribution ?? 'statement', sourceAccountKey: r.payload.actorAccountKey ?? null, evidenceRefs: r.payload.evidenceRefs ?? [], inputManifest: r.payload.inputManifest ?? [], corrects: r.payload.corrects ?? r.payload.manualCorrection ?? null } })) };
  }
  function lifecycleOperations(characterId) {
    const selected = control.prepare('SELECT operationId,characterId,kind,phase,payload,result FROM lifecycle_ops WHERE operationId=? AND characterId=?');
    return control.prepare("SELECT operationId,characterId,kind,phase,payload,result FROM lifecycle_ops WHERE characterId=? ORDER BY CASE WHEN phase IN ('completed','backup_verified','resumed') THEN 1 ELSE 0 END,rowid DESC LIMIT 20").all(characterId).map((row) => {
      let current = row; const seen = new Set([row.operationId]);
      for (let hops = 0; current.phase === 'resumed' && hops < 32; hops++) {
        const nextId = parse(current.result).resumedBy;
        if (!nextId || seen.has(nextId)) break;
        const next = selected.get(nextId, characterId); if (!next) break;
        seen.add(nextId); current = next;
      }
      const kind = row.kind === 'resume' ? parse(row.payload).effectiveKind : row.kind;
      return { operationId: row.operationId, characterId, action: ({ requestDelete:'request_delete', continueDelete:'continue_delete' })[kind] ?? kind, phase: current.phase, complete: ['completed','backup_verified'].includes(current.phase) };
    });
  }
  function status(ctx) {
    const db = role(ctx.characterId), head = state(), policyIds = new Set(db.prepare('SELECT DISTINCT policyId FROM events').all().map((row) => row.policyId));
    for (const row of control.prepare('SELECT action FROM privacy_actions WHERE characterId=?').all(ctx.characterId)) { const action = parse(row.action); if (['configure_policy','revoke_policy'].includes(action.type) && action.policyId) policyIds.add(action.policyId); }
    const policies = [...policyIds].map((id) => control.prepare('SELECT payload FROM policies WHERE policyId=?').get(id)).filter(Boolean).map((row) => { const p = parse(row.payload); return {policyId:p.policyId,approved:p.approved}; });
    return { ok: true, characterId: ctx.characterId, characterEpoch: ctx.capturedEpoch, controlRevision: head.revision, bindingRevision: head.bindingRevision, deletionRevision: head.deletionRevision,
      counts: { events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n, memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n },
      policies,
      backups: control.prepare('SELECT backupId,state FROM lifecycle_backups WHERE characterId=? ORDER BY rowid DESC LIMIT 20').all(ctx.characterId).map((row) => ({ ...row })),
      operations: [...control.prepare('SELECT operationId,characterId,action,phase FROM admin_operations WHERE characterId=? ORDER BY rowid DESC LIMIT 20').all(ctx.characterId).map((row) => ({ ...row, complete:row.phase === 'completed' })), ...lifecycleOperations(ctx.characterId)],
      persons: control.prepare('SELECT personId,revision FROM identity_persons WHERE characterId=?').all(ctx.characterId).map((row) => ({ ...row })),
      bindings: control.prepare("SELECT bindingId AS id,platform,accountId,personId,revision FROM identity_bindings WHERE characterId=? AND status='active'").all(ctx.characterId).map((row) => ({ ...row })), capabilities: { inspect: true, removeHot: true, identity: true, createPerson: true, correct: true, migration: false, activation: false } };
  }
  function progress(ctx, id) {
    authority(ctx,false);
    const row = operation(ctx, id); if (!row) return null;
    const roleReceipt = role(ctx.characterId).prepare('SELECT result FROM operations WHERE operationId=?').get(id);
    return { ...row.result, ...(roleReceipt ? parse(roleReceipt.result) : {}), operationState: row.phase === 'completed' ? 'completed' : 'pending', phase: row.phase, complete: row.phase === 'completed', retry: row.phase === 'completed' ? 'none' : 'query_receipt', ...(requestBinding(ctx, id) ? { requestBinding: requestBinding(ctx, id) } : {}) };
  }
  function update(row, phase, values = {}) {
    const result = { ...row.result, ...values, phase };
    return transaction(control, row.operationId, () => { control.prepare('UPDATE admin_operations SET payload=?,phase=?,result=? WHERE operationId=?').run(canonical(row.payload), phase, canonical(result), row.operationId); return result; }, true);
  }
  function correction(ctx, row, content) {
    const db = role(ctx.characterId), target = row.payload.target, original = record(db, target.id, target.revision);
    requireThat(original.row.payloadDigest === target.payloadDigest, 'MEMORY_SOURCE_STALE', 'The original correction target changed.');
    requireThat(typeof content === 'string', 'MEMORY_CORRECTION_CONTENT_REQUIRED', 'The control intent is durable but its reported source transaction has not committed.', 'Resume this original operation with the exact originally confirmed correction content; do not generate another operation ID.');
    requireThat(digest({recordId:target.id,recordRevision:target.revision,content}) === row.payload.actualPayloadDigest,'MEMORY_DIGEST_CONFLICT','The resumed source text differs from the original HTTP action.');
    content = redactContent(content, { scope: 'shared' }); requireThat(digest({ recordId: target.id, recordRevision: target.revision, content }) === row.payload.payloadDigest, 'MEMORY_DIGEST_CONFLICT', 'The resumed correction text differs from the original confirmed request.');
    requireCurrentOrigins(db, target.roots, target.expiresAt);
    const domain = intersectPolicies(target.policies.map(policy)); requireThat(domain.audiences.length && domain.processingGrants.length, 'MEMORY_POLICY_DENIED', 'Current source controls no longer authorize the reported correction.');
    const context = row.payload.originalContext, stem = `admin-${digest([row.characterId, row.operationId]).slice(0, 40)}`, grant = domain.processingGrants[0];
    const [event] = normalizeEvent({ eventId: `${stem}:source`, operationId: `${stem}:source-op`, sourceKey: `${stem}:source-key`, producerId: 'host-admin', segmentId: stem, producerSeq: 1, content, expiresAt: target.expiresAt, subject: original.payload.subject ?? context.sourceAccountKey, speaker: context.sourceAccountKey, certainty: 'reported', attribution: 'statement', occurredAt: new Date(now()).toISOString(), observedAt: new Date(now()).toISOString(), timePrecision: 'exact' }, { ...context, channel: 'local', conversationKey: 'local:memory-management', audiencePolicyId: target.policies[0], processingGrantId: grant.grantId });
    requireThat(event.partCount === 1, 'MEMORY_CORRECTION_INVALID', 'The reported correction must fit one complete source part.');
    event.manualCorrection = { ...target, roots: undefined }; delete event.manualCorrection.roots; event.manualCorrection = Object.fromEntries(Object.entries(event.manualCorrection).filter(([, value]) => value !== undefined)); event.payloadDigest = eventDigest(event);
    const sourceRef = { type: 'event', id: event.eventId, revision: 1, payloadDigest: event.payloadDigest }, memoryId = original.type === 'memory' ? original.id : `correction-${digest([ctx.characterId, original.id]).slice(0, 32)}`, revision = original.type === 'memory' ? original.revision + 1 : 1;
    const payload = { content: event.content, expiresAt: event.expiresAt, subject: original.payload.subject ?? context.sourceAccountKey, kind: original.row.kind ?? 'fact', certainty: 'reported', attribution: 'administrator-statement', validFrom: original.payload.validFrom ?? original.payload.occurredAt ?? null, validTo: original.payload.validTo ?? null, recordedAt: new Date(now()).toISOString(), originalOccurredAt: original.payload.occurredAt ?? null, corrects: pointer(original), evidenceRefs: [{ ...sourceRef, start: 0, end: event.content.length, text: event.content }], inputManifest: [sourceRef], coverage: [], roots: [event.rootEventId], lineageDomainId: target.domain };
    return transaction(db, row.operationId, () => {
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)').run(event.eventId, event.sourceKey, event.operationId, event.payloadDigest, event.policyId, canonical(event), canonical([event.rootEventId]), canonical(target.policies), 'active');
      db.exec('UPDATE source_clock SET sequence=sequence+1 WHERE id=1'); db.prepare('INSERT INTO source_sequence VALUES(?,?)').run(event.eventId, db.prepare('SELECT sequence FROM source_clock WHERE id=1').get().sequence); index(db, 'event', event.eventId, 1, event.content);
      if (original.type === 'memory') { db.prepare("UPDATE memory_versions SET status='superseded' WHERE memoryId=? AND revision=?").run(original.id, original.revision); db.prepare("UPDATE memories SET currentRevision=?,status='active' WHERE memoryId=?").run(revision, memoryId); }
      else db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?)').run(memoryId, `source:${original.id}`, target.domain, revision, 'fact', 'active');
      db.prepare('INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?)').run(memoryId, revision, digest(payload), canonical(payload), canonical([event.rootEventId]), canonical(target.policies), 'active'); index(db, 'memory', memoryId, revision, content);
      if (original.type === 'memory') db.prepare('INSERT INTO links VALUES(?,?,?,?,?)').run(memoryId, revision, original.id, original.revision, 'supersedes');
      db.prepare('UPDATE metadata SET appliedControlRevision=? WHERE id=1').run(state().revision);
      return saveReceipt(db, row.operationId, row.requestDigest, receipt(row.operationId, { acceptance: 'durable', sourceState: 'committed', selectionState: 'committed', memoryId, revision, eventIds: [event.eventId], eventRefs: [sourceRef], correctionState: 'reported-version-created' }), { ...context, admin: true });
    });
  }
  function advance(ctx, row, content) {
    if (row.phase === 'completed') return progress(ctx, row.operationId);
    applyControls(ctx.characterId);
    const db = role(ctx.characterId); let applied = db.prepare('SELECT requestDigest,result FROM operations WHERE operationId=?').get(row.operationId);
    if (!applied) {
      let result;
      if (row.action === 'correct') result = correction(ctx, row, content);
      else result = transaction(db, row.operationId, () => {
        if (row.action === 'remove_hot') { const t = row.payload.target; db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(`hot-${digest([t.type, t.id, t.revision])}`, canonical([{ type: t.type, id: t.id, revision: t.revision }]), canonical({ kind: 'hot_selection', selected: false })); }
        applyRoleControls(db, ctx.characterId); db.prepare('UPDATE metadata SET appliedControlRevision=? WHERE id=1').run(state().revision);
        return saveReceipt(db, row.operationId, row.requestDigest, receipt(row.operationId, { acceptance: 'durable', sourceState: 'not_applicable', selectionState: row.action === 'remove_hot' ? 'removed_hot' : 'not_selected', ...(row.result.personId ? { personId: row.result.personId, bindingId: row.result.bindingId } : {}) }), row.payload.originalContext);
      });
      if (!result.ok) return result; fault('adminAfterRole', row.operationId);
      applied = db.prepare('SELECT requestDigest,result FROM operations WHERE operationId=?').get(row.operationId);
    }
    requireThat(applied.requestDigest === row.requestDigest, 'MEMORY_DIGEST_CONFLICT', 'The role receipt belongs to another immutable admin request.');
    applyControls(ctx.characterId);
    if (row.action === 'remove_hot') return update(row, 'completed', { ...parse(applied.result), complete: true, operationState: 'completed', retry: 'none' });
    const current = state(), retirement = { operationId: row.operationId, characterId: ctx.characterId, previousEpoch: ctx.capturedEpoch, previousStoreGeneration: generation, controlRevision: current.revision, bindingRevision: current.bindingRevision, deletionRevision: current.deletionRevision, nonce: digest([row.operationId, generation, current.revision]), reason: `memory-admin:${row.action}` };
    row.payload.retirement = retirement; const changed = update(row, 'retirement_required', { ...pending(row.operationId), ...parse(applied.result), operationState:'pending', complete:false, retry:'query_receipt', retirement }); if (!changed.ok) return changed;
    fault('adminBeforeRetirement', row.operationId); return changed;
  }
  function commit(ctx, request, expectedRevision, operationId) {
    identifier(operationId); const existing = operation(ctx, operationId);
    if (existing) { requireThat(existing.action === request.action && existing.payload.actualPayloadDigest === digest(request.payload) && existing.payload.expectedRevision === expectedRevision, 'MEMORY_DIGEST_CONFLICT', 'This operation ID belongs to different immutable action inputs.'); return progress(ctx, operationId); }
    for (const table of ['privacy_actions', 'lifecycle_ops', 'producer_registration_ops']) requireThat(!control.prepare(`SELECT operationId FROM ${table} WHERE operationId=?`).get(operationId), 'MEMORY_DIGEST_CONFLICT', 'This operation ID is already owned by another immutable business request.');
    requireThat(!role(ctx.characterId).prepare('SELECT operationId FROM operations WHERE operationId=?').get(operationId), 'MEMORY_DIGEST_CONFLICT', 'This operation ID is already owned by an immutable role operation.');
    const p = plan(ctx, request, expectedRevision); requireThat(request.previewDigest === p.previewDigest, 'MEMORY_PREVIEW_STALE', 'The confirmed preview does not match current records and controls.');
    const bound = requestBinding(ctx, operationId);
    if (bound) requireThat(bound.action === p.action && bound.payloadDigest === digest(request.payload) && bound.expectedRevision === expectedRevision && bound.characterId === ctx.characterId && bound.characterEpoch === ctx.capturedEpoch, 'MEMORY_DIGEST_CONFLICT', 'The mutation does not match its durable HTTP request binding.');
    const requestDigest = digest({ action: p.action, payloadDigest: p.payloadDigest, expectedRevision, characterId: ctx.characterId, characterEpoch: ctx.capturedEpoch });
    requireKernel(ctx.characterId);
    const result = transaction(control, operationId, () => {
      const revision = state().revision + 1, bindingChange = ['create_person', 'bind_account', 'unbind_account'].includes(p.action);
      control.prepare('UPDATE state SET revision=?,bindingRevision=bindingRevision+?,deletionRevision=deletionRevision+? WHERE id=1').run(revision, bindingChange ? 1 : 0, p.action === 'correct' ? 1 : 0);
      let extra = {};
      if (p.action === 'correct') for (const root of p.target.roots) control.prepare("INSERT INTO root_controls VALUES(?,?,'invalidated',?) ON CONFLICT(characterId,rootId) DO UPDATE SET status='invalidated',revision=excluded.revision").run(ctx.characterId, root, revision);
      if (p.action === 'create_person' || p.action === 'bind_account') {
        const personId = p.action === 'create_person' ? `person-${digest([ctx.characterId, operationId]).slice(0, 32)}` : p.normalized.personId, bindingId = `binding-${digest([ctx.characterId, operationId]).slice(0, 32)}`, confirmedAt = new Date(now()).toISOString();
        if (p.action === 'create_person') control.prepare('INSERT INTO identity_persons VALUES(?,?,?,?,?)').run(personId, ctx.characterId, ctx.sourceAccountKey, confirmedAt, state().bindingRevision);
        control.prepare('INSERT INTO identity_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(bindingId, ctx.characterId, p.normalized.platform, p.normalized.accountId, personId, ctx.sourceAccountKey, confirmedAt, state().bindingRevision, 'active'); extra = { personId, bindingId };
      } else if (p.action === 'unbind_account') { control.prepare("UPDATE identity_bindings SET status='revoked',revision=? WHERE bindingId=?").run(state().bindingRevision, p.target.bindingId); control.prepare('INSERT OR REPLACE INTO identity_invalidations VALUES(?,?,?)').run(ctx.characterId, p.target.bindingId, state().bindingRevision); }
      const payload = { actualPayloadDigest:digest(request.payload), payloadDigest: p.payloadDigest, originalContext: { ...ctx }, target: p.target, expectedRevision, intentRevision: revision }, value = pending(operationId, { action: p.action, ...extra, phase: 'intent', controlRevision: revision });
      control.prepare('INSERT INTO admin_operations VALUES(?,?,?,?,?,?,?)').run(operationId, ctx.characterId, requestDigest, p.action, canonical(payload), 'intent', canonical(value)); return value;
    }, true);
    if (!result.ok) return result; fault('adminAfterIntent', operationId);
    return advance(ctx, operation(ctx, operationId), request.payload.content);
  }
  function acknowledge(ctx, request) {
    authority(ctx, false); const row = operation(ctx, request.operationId), r = row?.payload.retirement, proof = request.proof;
    requireThat(row?.phase === 'retirement_required' && r && r.controlRevision === state().revision && proof?.ok === true && proof.nonce === r.nonce && proof.characterId === ctx.characterId && Number.isSafeInteger(proof.epoch) && proof.epoch > r.previousEpoch && proof.sessionsRetired === true && proof.inflightCancelled === true && proof.legacyAdmissionBlocked === true, 'MEMORY_RETIREMENT_REQUIRED', 'The trusted Host retirement proof is incomplete or stale.');
    row.payload.proof = { epoch: proof.epoch, nonce: proof.nonce, sessionsRetired: true, inflightCancelled: true, legacyAdmissionBlocked: true }; row.payload.previousGeneration = generation;
    const result = update(row, 'await_generation', { restartRequired: true }); if (!result.ok) return result; fault('adminAfterAcknowledgement', row.operationId); return result;
  }
  function recover() {
    for (const r of control.prepare("SELECT * FROM admin_operations WHERE phase='await_generation'").all()) {
      const row = { ...r, payload: parse(r.payload), result: parse(r.result) };
      if (row.payload.previousGeneration === generation) continue;
      if (row.payload.retirement.controlRevision !== state().revision) { const result = update(row, 'recovery_blocked'); requireThat(result.ok, result.code, result.error, result.hint); continue; }
      applyControls(row.characterId); const result = update(row, 'completed', { retirement: null, restartRequired: false, complete: true, operationState: 'completed', retry: 'none', completedGeneration: generation }); requireThat(result.ok, result.code, result.error, result.hint);
    }
  }
  function call(ctx, method, request = {}, expectedRevision, operationId) {
    authority(ctx, !['acknowledge', 'progress'].includes(method));
    if (method === 'status') return status(ctx);
    if (method === 'inspect') return inspect(ctx, request);
    if (method === 'bindRequest') return bindRequest(ctx, request);
    if (method === 'preview') { const p = plan(ctx, request, expectedRevision); return { ok: true, action: p.action, previewDigest: p.previewDigest, controlRevision: expectedRevision, characterId: ctx.characterId, characterEpoch: ctx.capturedEpoch, target: p.target, changes: p.action === 'correct' ? 'Create an independent reported administrator statement and superseding formal version; withdraw old-root views.' : p.action === 'remove_hot' ? 'Remove this exact revision from prepare selection; keep source and explicit search.' : 'Confirm this explicit stable-account identity change without expanding source permissions.' }; }
    if (method === 'commit') return commit(ctx, request, expectedRevision, operationId);
    if (method === 'acknowledge') return acknowledge(ctx, request);
    if (method === 'progress') return progress(ctx, request.operationId) ?? { ...receipt(request.operationId), operationState: 'not_found', sourceState: 'not_applicable' };
    requireThat(method === 'resume', 'MEMORY_ACTION_INVALID', 'Unknown Host admin operation.'); const row = operation(ctx, request.operationId); requireThat(row, 'MEMORY_OPERATION_NOT_FOUND', 'No original admin operation exists in this role.'); return advance(ctx, row, request.content);
  }
  return { call, progress, requestBinding, admission, isHot, identity, dependencies, applyRoleControls, recover };
}
