import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, digest, redactContent, splitUtf8 } from './memory-v2-contract.js';

const VERSION = 1;
const REFERENCES = new Set(['persona', 'life', 'purpose', 'bili-diary']);
const LINES = new Set(['experience-inbox', 'memory-inbox', 'memory-card-full-jsonl', 'sharing']);
const KINDS = new Set([...REFERENCES, ...LINES, 'memory-card', 'memory-card-full-json', 'douyin-ledger', 'bili-scores', 'bili-favorites', 'bili-quota', 'bili-dynamic-receipt', 'bili-dynamic-intent']);
const PROJECTIONS = new Set(['memory-card', 'memory-card-full-json', 'memory-card-full-jsonl']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:./-]{0,159}$/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const issue = (code, error, extra = {}) => ({ code, error, hint: 'Keep V1 active and retain the original source. Inspect this item through the trusted Host before importing or advancing its checkpoint.', ...extra });
const throwIssue = (code, error) => { throw Object.assign(new Error(error), issue(code, error)); };
const check = (test, code, error) => { if (!test) throwIssue(code, error); };
const clean = value => {
  if (typeof value === 'string') return /^(?:\/|[A-Za-z]:[\\/])/.test(value) ? '[路径已隐藏]' : redactContent(value, { scope: 'qq' })
    .replace(/\bbearer\s+\S+/gi, 'bearer=[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[令牌已隐藏]');
  if (Array.isArray(value)) return value.map(clean);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactContent(key, { scope: 'qq' }),
    (/^(?:token|passwd|secret|api[_-]?key|apiKey|cookie|authorization|bearer|sessdata|access[_-]?token|refresh[_-]?token)$/i.test(key) || key.toLowerCase() === ['pass', 'word'].join('')) ? '[已隐藏]' : clean(item)]));
  return value;
};
const selfOutput = row => plain(row) && ((row.origin !== undefined && !['legacy', 'v1'].includes(row.origin)) ||
  (row.sourceGeneration !== undefined && ![1, 'v1', 'legacy'].includes(row.sourceGeneration)) ||
  row.schemaVersion === 2 || row.memoryV2Refs !== undefined || row.memoryV2Receipts !== undefined || row.memoryV2Receipt !== undefined);

function readExact(fd, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(fd, bytes, offset, length - offset, offset);
    check(n > 0, 'MIGRATION_SOURCE_CHANGED', 'The captured source prefix became shorter.');
    offset += n;
  }
  return bytes;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sourcePrefix(source, cap) {
  check(typeof source.filePath === 'string' && path.isAbsolute(source.filePath), 'MIGRATION_PATH_INVALID', 'A Host-resolved absolute source path is required.');
  let current = path.parse(source.filePath).root;
  for (const part of source.filePath.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    check(!fs.lstatSync(current).isSymbolicLink(), 'MIGRATION_PATH_INVALID', 'Symbolic links cannot establish a source boundary.');
  }
  const before = fs.lstatSync(source.filePath);
  check(before.isFile(), 'MIGRATION_PATH_INVALID', 'Only regular source files can be inventoried.');
  const fd = fs.openSync(source.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    check(sameFile(before, opened), 'MIGRATION_SOURCE_CHANGED', 'The source file changed while opening it.');
    const cut = source.highWaterBytes ?? opened.size;
    check(Number.isSafeInteger(cut) && cut >= 0 && cut <= opened.size, 'MIGRATION_CUT_INVALID', 'The captured high water is outside the source.');
    check(cut <= cap, 'MIGRATION_SOURCE_TOO_LARGE', 'The captured source exceeds the explicit read budget; it was not truncated.');
    const bytes = readExact(fd, cut), prefixHash = sha(bytes);
    if (source.expectedPrefixHash !== undefined) check(source.expectedPrefixHash === prefixHash, 'MIGRATION_PREFIX_MISMATCH', 'The captured prefix does not match its expected SHA256.');
    const after = fs.fstatSync(fd), onPath = fs.lstatSync(source.filePath);
    check(onPath.isFile() && !onPath.isSymbolicLink() && sameFile(opened, after) && sameFile(opened, onPath) && after.size >= cut && onPath.size >= cut && sha(readExact(fd, cut)) === prefixHash,
      'MIGRATION_SOURCE_CHANGED', 'The captured source prefix changed during inventory.');
    return { bytes, prefixHash, cut, openedSize: opened.size, observedSize: after.size, boundary: 'verified-prefix', completeSnapshot: false };
  } finally { fs.closeSync(fd); }
}
function decode(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }

// JSON pointer spans refer to original UTF-8 bytes, including records lacking IDs.
function jsonSpans(bytes) {
  const spans = new Map();
  const space = at => { while (at < bytes.length && [9, 10, 13, 32].includes(bytes[at])) at++; return at; };
  const stringEnd = at => { for (let n = at + 1; n < bytes.length; n++) { if (bytes[n] === 92) n++; else if (bytes[n] === 34) return n + 1; } throwIssue('MIGRATION_JSON_INVALID', 'A JSON string is incomplete.'); };
  function walk(at, pointer, depth) {
    check(depth <= 128, 'MIGRATION_JSON_DEPTH', 'The source JSON exceeds the safe nesting depth.');
    at = space(at); const start = at;
    if (bytes[at] === 123 || bytes[at] === 91) {
      const object = bytes[at] === 123, end = object ? 125 : 93; at = space(at + 1); let index = 0;
      while (bytes[at] !== end) {
        let key = String(index++);
        if (object) { const next = stringEnd(at); key = JSON.parse(decode(bytes.subarray(at, next))); at = space(next) + 1; }
        at = space(walk(at, [...pointer, key], depth + 1));
        if (bytes[at] !== 44) break;
        at = space(at + 1);
      }
      at++;
    } else if (bytes[at] === 34) at = stringEnd(at);
    else { while (at < bytes.length && ![9, 10, 13, 32, 44, 93, 125].includes(bytes[at])) at++; }
    check(!spans.has(JSON.stringify(pointer)), 'MIGRATION_JSON_DUPLICATE_KEY', 'Duplicate JSON keys make source inventory ambiguous.');
    spans.set(JSON.stringify(pointer), { start, end: at }); return at;
  }
  walk(0, [], 0); return spans;
}
function jsonRows(value, kind) {
  const rows = [], add = (row, pointer, inherited = {}) => rows.push({ row, pointer, inherited });
  const array = (items, pointer, inherited) => { check(Array.isArray(items), 'MIGRATION_FORMAT_INVALID', 'The legacy record collection is not an array.'); items.forEach((row, n) => add(row, [...pointer, String(n)], inherited)); };
  if (kind === 'memory-card') array(value?.records, ['records']);
  else if (kind === 'memory-card-full-json') Array.isArray(value) ? array(value, []) : array(value?.records, ['records']);
  else if (kind === 'bili-favorites') array(value?.items, ['items']);
  else if (kind === 'bili-quota') array(value?.log, ['log']);
  else if (kind === 'bili-scores') {
    check(plain(value), 'MIGRATION_FORMAT_INVALID', 'A score ledger must contain date-keyed arrays.');
    for (const [date, items] of Object.entries(value)) array(items, [date], { ledgerDate: date });
  } else if (kind === 'douyin-ledger') {
    check(plain(value?.jobs), 'MIGRATION_FORMAT_INVALID', 'The companion ledger has no jobs object.');
    for (const [jobId, job] of Object.entries(value.jobs)) array(job?.items, ['jobs', jobId, 'items'],
      { characterId: job.characterId, characterEpoch: job.characterEpoch, jobId, jobState: job.state, ...(selfOutput(job) ? { sourceGeneration: 'v2' } : {}) });
  } else add(value, []);
  return rows;
}
function typeOf(kind, row) {
  if (REFERENCES.has(kind)) return 'reference';
  if (PROJECTIONS.has(kind)) return 'legacy-projection';
  if (kind === 'sharing') {
    check(row.version === 1 && ['opening', 'request', 'answer', 'failure', 'ack'].includes(row.kind), 'MIGRATION_FORMAT_INVALID', 'Unknown sharing record type.');
    return `sharing-${row.kind}`;
  }
  if (kind === 'experience-inbox') return row.source?.channel === 'douyin' && row.kind === 'reflection' && row.attribution?.subject === 'self' ? 'self-reflection' : 'legacy-experience';
  if (kind === 'memory-inbox') return row.isSelf === true ? 'legacy-self-capture-unverified' : 'legacy-message-capture';
  if (kind === 'douyin-ledger') return 'self-reflection';
  if (kind === 'bili-dynamic-receipt') {
    check(row.version === 1 && row.type === 'dynamic' && /^[1-9]\d*$/.test(String(row.id)) && iso(row.at), 'MIGRATION_FORMAT_INVALID', 'A confirmed dynamic receipt requires its original platform ID and time.');
    return 'platform-confirmed-receipt';
  }
  if (kind === 'bili-dynamic-intent') return 'legacy-action-intent';
  return kind === 'bili-quota' ? 'logged-action-unverified' : 'legacy-bili-activity';
}
function restrictions(row, kind) {
  const contexts = row.visibility?.allowedContexts ?? row.allowedContexts;
  return { classification: row.visibility?.classification ?? row.visibilityClassification ?? (row.private === true ? 'private' : null),
    allowedContexts: Array.isArray(contexts) ? contexts : null, scope: row.visibility?.legacyScope ?? row.scope ?? null,
    sensitive: row.sensitive === true, channel: row.source?.channel ?? row.sourceChannel ?? row.platform ?? (kind.startsWith('bili-') ? 'bili' : null) };
}
function factsFor(resolver, input, row, kind) {
  const facts = resolver(input);
  if (!plain(facts) || typeof facts.then === 'function') return { reasons: ['MIGRATION_AUTHORITY_UNKNOWN'], facts: null };
  const audience = facts.audience, old = restrictions(row, kind), reasons = [];
  if (!id(facts.actorAccountKey) || !/^(?:qq|bili|douyin|local|pet):[^:]+/.test(facts.actorAccountKey) || (!['qq', 'bili', 'douyin', 'local', 'pet'].includes(facts.channel) || !facts.actorAccountKey?.startsWith(`${facts.channel}:`))) reasons.push('MIGRATION_ACTOR_UNKNOWN');
  if (!plain(audience) || !['public', 'private', 'restricted'].includes(audience.classification) || !Array.isArray(audience.allowedContexts) || !audience.allowedContexts.length || audience.allowedContexts.some(item => !id(item))) reasons.push('MIGRATION_AUDIENCE_UNKNOWN');
  else {
    if (old.classification && audience.classification !== old.classification) reasons.push('MIGRATION_AUDIENCE_CONFLICT');
    if (old.allowedContexts && (!old.allowedContexts.length || audience.allowedContexts.some(item => !old.allowedContexts.includes(item)))) reasons.push('MIGRATION_AUDIENCE_CONFLICT');
    const scope = { qq: ['qq'], bili: ['bili'], pet: ['pet'], shared: ['qq', 'bili', 'pet', 'local'], douyin: ['douyin', 'local'] }[old.scope];
    if (scope && audience.allowedContexts.some(item => !scope.some(channel => item === channel || item.startsWith(`${channel}:`)))) reasons.push('MIGRATION_AUDIENCE_CONFLICT');
    if (row.private === true && audience.classification !== 'private') reasons.push('MIGRATION_AUDIENCE_CONFLICT');
  }
  if (old.channel && old.channel !== facts.channel) reasons.push('MIGRATION_ACTOR_CONFLICT');
  if (old.sensitive) reasons.push('MIGRATION_SENSITIVE_REVIEW');
  const actual = row.source?.accountId ?? (kind === 'memory-inbox' ? row.senderId : null);
  if (actual && facts.actorAccountKey !== `${facts.channel}:${actual}`) reasons.push('MIGRATION_ACTOR_CONFLICT');
  const conversation = row.source?.conversationId ?? row.conversationKey;
  if (facts.channel === 'qq' && (!/^qq:\d+:(?:group|private):\d+$/.test(facts.conversationKey ?? '') ||
    (conversation && ![facts.conversationKey, facts.conversationKey.replace(/^qq:\d+:/, '')].includes(conversation)))) reasons.push('MIGRATION_CONVERSATION_UNKNOWN');
  return { facts: clean({ actorAccountKey: facts.actorAccountKey ?? null, channel: facts.channel ?? null, conversationKey: facts.conversationKey ?? null, audience: audience ?? null }), reasons: [...new Set(reasons)] };
}
function failureReport(item, code, error) { return { ...item, ...issue(code, error) }; }

/** Host-private inventory only. Paths and authority resolvers must never be accepted from an Agent or HTTP body. */
export function planLegacyMigration({ characterId, sources, streamRegistry = {}, capturedAt, resolveFacts = () => null, maxSourceBytes = 64 * 1024 * 1024 } = {}) {
  const result = { ok: true, manifest: { version: VERSION, characterId: null, capturedAt: null, phase: 'plan-only', authority: 'none', sources: [] },
    counts: { sources: 0, records: 0, candidates: 0, quarantined: 0, invalidRows: 0, partialTails: 0, protectedRecords: 0, parts: 0 }, candidates: [], quarantine: [], diagnostics: [], registryAdditions: [] };
  const all = [], sourceKeys = new Set(), streams = new Map();
  try {
    check(typeof characterId === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(characterId) && Array.isArray(sources) && plain(streamRegistry) && iso(capturedAt) && typeof resolveFacts === 'function' && Number.isSafeInteger(maxSourceBytes) && maxSourceBytes > 0,
      'MIGRATION_ARGUMENT_INVALID', 'A character, explicit capture time, source descriptors and registered stream map are required.');
    Object.assign(result.manifest, { characterId, capturedAt: iso(capturedAt) });
    for (const [logical, stable] of Object.entries(streamRegistry)) {
      check(id(logical) && id(stable) && !streams.has(stable), 'MIGRATION_REGISTRY_CONFLICT', 'Each logical stream requires one unique registered stable ID.'); streams.set(stable, logical);
    }
    for (const source of sources) {
      const entry = { sourceOrdinal: result.counts.sources++, kind: KINDS.has(source?.kind) ? source.kind : null, logicalStreamKey: clean(source?.logicalStreamKey ?? ''), legacyStreamId: null,
        records: 0, invalidRows: 0, partialTailBytes: 0, safeImportEnd: 0, inventoryOnlyAfter: null };
      result.manifest.sources.push(entry);
      try {
        check(plain(source) && KINDS.has(source.kind) && id(source.logicalStreamKey), 'MIGRATION_DESCRIPTOR_INVALID', 'The Host source descriptor has an unknown kind or logical stream.');
        check(!sourceKeys.has(source.logicalStreamKey), 'MIGRATION_DESCRIPTOR_CONFLICT', 'A logical source stream appears twice in this plan.'); sourceKeys.add(source.logicalStreamKey);
        const stable = streamRegistry[source.logicalStreamKey];
        if (!stable && id(source.legacyStreamId)) result.registryAdditions.push({ logicalStreamKey: source.logicalStreamKey, legacyStreamId: source.legacyStreamId });
        check(id(stable), 'MIGRATION_REGISTRY_REQUIRED', 'Persist the caller-proposed stream mapping before planning its records.');
        check(!source.legacyStreamId || source.legacyStreamId === stable, 'MIGRATION_REGISTRY_CONFLICT', 'The descriptor differs from the registered logical stream identity.'); entry.legacyStreamId = stable;
        check(!selfOutput(source), 'MIGRATION_SELF_IMPORT', 'V2 or unknown-generation compatibility output cannot be imported as legacy truth.');
        const captured = sourcePrefix(source, maxSourceBytes), { bytes } = captured;
        Object.assign(entry, { highWaterBytes: captured.cut, prefixHash: captured.prefixHash, observedSize: captured.observedSize, openedSize: captured.openedSize, boundary: captured.boundary, completeSnapshot: false });
        const accept = (row, start, end, inherited = {}) => {
          entry.records++; result.counts.records++;
          const location = { legacyStreamId: stable, startOffset: start, endOffset: end, originalHash: sha(bytes.subarray(start, end)) };
          try {
            check(plain(row), 'MIGRATION_RECORD_INVALID', 'A legacy record must be an object.');
            const raw = { ...row, ...inherited };
            check(!selfOutput(raw), 'MIGRATION_SELF_IMPORT', 'This record carries V2 provenance and cannot create another legacy root.');
            const type = typeOf(source.kind, raw);
            const legacyId = typeof raw.eventId === 'string' && raw.eventId ? ['event', raw.eventId] : typeof raw.id === 'string' && raw.id ? [PROJECTIONS.has(source.kind) ? 'record' : source.kind, raw.id] : null;
            const identity = legacyId ? digest([characterId, ...legacyId]) : digest([characterId, stable, start, location.originalHash]);
            const sourceKey = `legacy:${identity}`;
            const record = clean(raw), content = canonical(record), parts = splitUtf8(content);
            const protection = Object.fromEntries(['pinned', 'anchor', 'isInitial', 'firstMet', 'manual', 'initialTier', 'initialProbability', 'mergedFrom', 'protected', 'manualCorrection'].filter(key => raw[key] !== undefined).map(key => [key, record[key]]));
            const protectedRecord = raw.pinned === true || raw.anchor === true || raw.isInitial === true || raw.firstMet === true || raw.manual === true || raw.protected === true || raw.manualCorrection !== undefined;
            if (protectedRecord) result.counts.protectedRecords++;
            const authority = REFERENCES.has(source.kind) ? { facts: null, reasons: ['MIGRATION_REFERENCE_ONLY'] } : factsFor(resolveFacts,
              { characterId, legacyStreamId: stable, kind: source.kind, sourceKey, record: raw }, raw, source.kind);
            const reasons = [...authority.reasons];
            if (raw.characterId !== undefined && raw.characterId !== characterId) reasons.push('MIGRATION_CHARACTER_CONFLICT');
            if (entry.inventoryOnlyAfter !== null && start >= entry.inventoryOnlyAfter) reasons.push('MIGRATION_PRECEDING_ROW_BLOCKED');
            const item = { sourceKey, draftId: `migration:${digest([sourceKey, canonical(record)])}`, type, kind: source.kind, location,
              originalId: legacyId ? clean(legacyId[1]) : null, record, protection, facts: authority.facts, reasons,
              capturedEpoch: Number.isSafeInteger(raw.characterEpoch) ? raw.characterEpoch : Number.isSafeInteger(raw.epoch) ? raw.epoch : null,
              occurredAt: iso(raw.occurredAt ?? raw.at ?? raw.createdAt), observedAt: iso(raw.observedAt), snapshotObservedAt: iso(raw.archivedAt),
              textCompleteness: PROJECTIONS.has(source.kind) || source.kind === 'memory-inbox' ? 'truncated_legacy' : 'legacy-capture-only',
              requiresCoreValidation: true, authorization: 'not-issued', independentRoot: !PROJECTIONS.has(source.kind) && !REFERENCES.has(source.kind),
              evidenceRoot: sourceKey, links: [], originalPayloadDigest: digest(raw), payloadDigest: digest(record),
              parts: parts.map((text, n) => ({ parentId: sourceKey, partId: `${sourceKey}.part-${n + 1}-of-${parts.length}`, index: n, count: parts.length, text, digest: sha(Buffer.from(text)) })) };
            if (raw.eventId && PROJECTIONS.has(source.kind)) item.links.push({ relation: 'source-event', target: `legacy:${digest([characterId, 'event', raw.eventId])}` });
            if (raw.sourceId) item.links.push({ relation: 'unresolved-object', pointerHash: digest([raw.sourceChannel ?? raw.platform ?? null, raw.sourceId]) });
            if (raw.speaker || raw.sender) item.unresolvedSpeaker = { name: clean(raw.speaker ?? raw.sender), accountInferredFromName: false };
            result.counts.parts += parts.length; all.push(item);
          } catch (error) {
            entry.invalidRows++; result.counts.invalidRows++;
            entry.inventoryOnlyAfter ??= start; entry.safeImportEnd = Math.min(entry.safeImportEnd, start);
            result.quarantine.push(failureReport({ location, kind: source.kind }, /^MIGRATION_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'MIGRATION_RECORD_INVALID', 'A legacy record could not be mapped; its original byte range remains intact.'));
          }
        };
        if (LINES.has(source.kind)) {
          let start = 0;
          while (start < bytes.length) {
            const newline = bytes.indexOf(10, start);
            if (newline < 0) {
              entry.partialTailBytes = bytes.length - start; result.counts.partialTails++;
              result.quarantine.push(failureReport({ location: { legacyStreamId: stable, startOffset: start, endOffset: bytes.length, originalHash: sha(bytes.subarray(start)) } }, 'MIGRATION_INCOMPLETE_TAIL', 'A non-terminated tail was retained without decoding or advancing it.')); break;
            }
            const end = newline + 1;
            if (newline === start) {
              entry.invalidRows++; result.counts.invalidRows++; entry.inventoryOnlyAfter ??= start;
              result.quarantine.push(failureReport({ location: { legacyStreamId: stable, startOffset: start, endOffset: end, originalHash: sha(bytes.subarray(start, end)) } }, 'MIGRATION_EMPTY_ROW', 'An empty legacy row blocks checkpoint advancement.'));
            } else {
              try { const line = bytes.subarray(start, newline); const row = JSON.parse(decode(line)); jsonSpans(line); accept(row, start, end); }
              catch {
                entry.invalidRows++; result.counts.invalidRows++; entry.inventoryOnlyAfter ??= start;
                result.quarantine.push(failureReport({ location: { legacyStreamId: stable, startOffset: start, endOffset: end, originalHash: sha(bytes.subarray(start, end)) } }, 'MIGRATION_ROW_INVALID', 'An undecodable or invalid JSON row blocks checkpoint advancement.'));
              }
            }
            if (entry.inventoryOnlyAfter === null) entry.safeImportEnd = end;
            start = end;
          }
          entry.completeCutBytes = start;
        } else if (REFERENCES.has(source.kind)) {
          accept({ referenceType: source.kind, text: decode(bytes) }, 0, bytes.length); entry.completeCutBytes = bytes.length;
        } else {
          let value;
          try { value = JSON.parse(decode(bytes)); } catch { throwIssue('MIGRATION_JSON_INVALID', 'The complete JSON capture is invalid or not decodable; no records were imported.'); }
          check(!selfOutput(value), 'MIGRATION_SELF_IMPORT', 'The source envelope carries V2 or unknown-generation output.');
          if (source.kind === 'memory-card') entry.protectionMetadata = clean(Object.fromEntries(['firstOwnerRecordId', 'firstOwnerAt', 'firstMetSource', 'firstMetAt', 'firstMetRecordIds', 'firstMetEventId'].filter(key => value.meta?.[key] !== undefined).map(key => [key, value.meta[key]])));
          const spans = jsonSpans(bytes);
          for (const { row, pointer, inherited } of jsonRows(value, source.kind)) { const span = spans.get(JSON.stringify(pointer)); check(span, 'MIGRATION_JSON_INVALID', 'A record has no original byte span.'); accept(row, span.start, span.end, inherited); }
          entry.completeCutBytes = bytes.length;
          entry.safeImportEnd = entry.inventoryOnlyAfter === null ? bytes.length : 0;
        }
      } catch (error) {
        result.ok = false;
        const diagnostic = failureReport({ sourceOrdinal: entry.sourceOrdinal, legacyStreamId: entry.legacyStreamId }, error.code?.startsWith('MIGRATION_') ? error.code : 'MIGRATION_SOURCE_UNAVAILABLE', 'The legacy source could not be safely inventoried.');
        result.diagnostics.push(diagnostic); entry.errorCode = diagnostic.code;
      }
    }
    const bySourceKey = new Map();
    for (const item of all) { const group = bySourceKey.get(item.sourceKey) ?? []; group.push(item); bySourceKey.set(item.sourceKey, group); }
    for (const group of bySourceKey.values()) {
      const originalRows = group.filter(item => !PROJECTIONS.has(item.kind));
      const conflict = new Set((originalRows.length ? originalRows : group).map(item => item.originalPayloadDigest)).size > 1;
      if (conflict) for (const item of group) item.reasons.push('MIGRATION_SOURCE_KEY_CONFLICT');
      for (const item of group) {
        const source = originalRows.find(other => other !== item);
        if (source && PROJECTIONS.has(item.kind)) { item.evidenceRoot = source.sourceKey; item.independentRoot = false; item.links.push({ relation: 'confirmed-source', target: source.sourceKey }); }
        else if (group.length > 1) { item.independentRoot = false; item.links.push({ relation: PROJECTIONS.has(item.kind) ? 'projection-version-observation' : 'same-identity-observation', target: item.sourceKey }); }
      }
    }
    const similarities = new Map();
    for (const item of all) {
      const text = item.record.text ?? item.record.content?.summary ?? item.record.summary;
      if (!PROJECTIONS.has(item.kind) || typeof text !== 'string' || !text) continue;
      const key = digest(text), group = similarities.get(key) ?? []; group.push(item); similarities.set(key, group);
    }
    for (const group of similarities.values()) if (new Set(group.map(item => item.sourceKey)).size > 1) for (const item of group) {
      item.independentRoot = false; item.links.push({ relation: 'possible-duplicate', comparisonHash: digest(item.record.text ?? item.record.content?.summary ?? item.record.summary), independentEvidence: false });
    }
    for (const item of all) {
      if (item.reasons.length) result.quarantine.push(failureReport(item, item.reasons[0], 'The draft requires explicit trusted review before any import.'));
      else result.candidates.push(item);
    }
  } catch (error) {
    result.ok = false; Object.assign(result, issue(error.code?.startsWith('MIGRATION_') ? error.code : 'MIGRATION_PLAN_FAILED', 'The migration plan could not be completed safely.'));
  }
  result.counts.candidates = result.candidates.length; result.counts.quarantined = result.quarantine.length;
  result.manifest.inventoryComplete = result.ok;
  result.manifest.importReady = false;
  return result;
}
