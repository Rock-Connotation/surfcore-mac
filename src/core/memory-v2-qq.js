import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, eventDigest, fail, redactContent } from './memory-v2-contract.js';
import { createSpool, readSpool } from './memory-v2-spool.js';
import { readMemoryRouting } from './memory-v2-routing.js';
import { createMemoryClient } from './memory-v2-client.js';
import { prepareCharacterContext } from './context.js';

const problem = (code, error, hint = 'Check Host memory diagnostics and the original receipt. Keep the producer queue; do not use an old session or legacy memory.') => fail(code, error, hint);
const roleOf = (getCharacter) => {
  const role = getCharacter();
  if (!role || typeof role.then === 'function' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(role.id) || !Number.isSafeInteger(role.epoch) || role.epoch < 1) throw Object.assign(new Error('A current synchronous character is required.'), problem('CHARACTER_CONTEXT_REQUIRED', 'A current synchronous character is required.'));
  return { id: role.id, epoch: role.epoch };
};
const sameRole = (a, b) => a.id === b.id && a.epoch === b.epoch;
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonical(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}

export function createQQMemoryBridge({ stateDir, getCharacter, getRouting = () => readMemoryRouting({ stateDir }), client = createMemoryClient({ stateDir, scope: 'qq', getCharacter }), prepareContext = prepareCharacterContext, getSessionMemorySafety = () => false } = {}) {
  if (!stateDir || typeof getCharacter !== 'function') throw new TypeError('QQ memory requires stateDir and a synchronous getCharacter.');
  const directory = path.join(stateDir, 'memory-v2', 'qq-producer');
  const latest = new Map(), history = new Map(), active = new Map(), failures = new Map(), sendLeases = new WeakMap();
  let sourceChain = Promise.resolve(), observedV2 = false;
  async function release(handle) { try { await client.release(handle); } catch {} }
  function routing() {
    try {
      const route = getRouting();
      if (route?.ok && route.backend === 'v2') observedV2 = true;
      if (observedV2 && route?.ok && route.backend === 'v1') return problem('MEMORY_BACKEND_CHANGED', 'An active V2 bridge cannot downgrade in-flight work to legacy memory.', 'Restart the bridge to retire its V2 sessions before continuing with V1; keep durable sources unchanged.');
      return route;
    } catch { return problem('MEMORY_ROUTING_INVALID', 'The memory route cannot be read.'); }
  }
  function requireRoute() {
    const route = routing();
    if (!route.ok) throw Object.assign(new Error(route.error), route);
    return route;
  }
  function checkRole(role) {
    if (!sameRole(role, roleOf(getCharacter))) throw Object.assign(new Error('The source belongs to a retired character epoch.'), problem('CHARACTER_EPOCH_STALE', 'The source belongs to a retired character epoch.', 'Keep the original source pending and use the approved producer-recovery flow; never rewrite its epoch.'));
  }
  function remember(record) {
    if (record.sourceFacts.direction === 'outbound' && record.deliveryState !== 'delivered') return;
    latest.set(record.key, record);
    const entries = history.get(record.key) ?? [];
    if (!entries.some((entry) => entry.segmentId === record.segmentId)) entries.push(record);
    history.set(record.key, entries.slice(-7));
  }
  const safeError = (error) => error?.code?.startsWith('MEMORY_') || error?.code?.startsWith('CHARACTER_') ? problem(error.code, error.error ?? error.message, error.hint) : problem('MEMORY_QQ_FAILED', 'The QQ memory operation did not complete.');
  async function flush(record, handle, { recovery = false } = {}) {
    const check = () => { if (!recovery) checkRole(record.role); };
    check();
    let cursor = record.cursor;
    const size = fs.statSync(record.file).size;
    while (cursor < size) {
      const batch = readSpool({ file: record.file, offset: cursor, maxEvents: 1, maxBytes: 1024 * 1024 });
      if (!batch.ok) return batch;
      if (!batch.events.length) return problem('MEMORY_SPOOL_INCOMPLETE', 'The source queue has an incomplete tail.');
      const operationId = `qq-batch:${digest([batch.producerId, batch.segmentId, batch.startOffset, batch.nextOffset])}`;
      const wire = { ...batch };
      if (Buffer.byteLength(canonical(wire)) > 240 * 1024) return problem('MEMORY_BATCH_INVALID', 'The complete source part exceeds the QQ transport budget.');
      let receipt;
      if (record.unknownOperation === operationId) {
        receipt = recovery ? await client.queryProducerReceipt({ registrationId: record.registrationId, operationId }) : await client.receipt(handle, operationId); check();
        if (!receipt?.ok || receipt.operationState === 'unknown') return receipt ?? problem('MEMORY_RECEIPT_UNKNOWN', 'The original source operation has no confirmed receipt.');
        if (receipt.operationState === 'not_found') record.unknownOperation = null;
      }
      if (!receipt || receipt.operationState === 'not_found') {
        record.unknownOperation = operationId; save(record.metaFile, record);
        receipt = recovery ? await client.replayProducer({ registrationId: record.registrationId, batch: wire, operationId }) : await client.ingest(handle, wire, operationId); check();
      }
      if (!receipt?.ok || receipt.sourceState !== 'committed' || receipt.nextOffset !== batch.nextOffset || !Array.isArray(receipt.eventRefs) || receipt.eventRefs.length !== batch.events.length) {
        save(record.metaFile, record);
        return receipt?.ok === false ? receipt : problem('MEMORY_RECEIPT_UNKNOWN', 'Host did not confirm the exact source byte cursor.');
      }
      record.refs.push(...receipt.eventRefs); record.cursor = batch.nextOffset; cursor = record.cursor;
      record.unknownOperation = null; record.sourceState = cursor === size ? 'committed' : 'pending';
      save(record.metaFile, record);
    }
    if (sameRole(record.role, roleOf(getCharacter))) remember(record);
    return { ok: true, acceptance: 'committed', sourceState: 'committed', eventRefs: structuredClone(record.refs), nextOffset: record.cursor };
  }
  async function recordSource(input, approvedSend = null) {
    let record, captured, durableRecord = false;
    try {
      const role = approvedSend?.role ?? roleOf(getCharacter), route = requireRoute();
      if (route.backend === 'v1') return { ok: true, backend: 'v1', acceptance: 'legacy' };
      if (!approvedSend && input.expectedCharacter && !sameRole(role, input.expectedCharacter)) return problem('CHARACTER_EPOCH_STALE', 'The role changed while the platform message was being read.');
      const match = /^(group|private):([1-9][0-9]{0,19})$/.exec(input.key ?? '');
      if (!match || typeof input.text !== 'string' || !input.text.trim()) return problem('MEMORY_SOURCE_FACTS_INVALID', 'A concrete QQ conversation and complete source text are required.');
      const facts = { loginAccountId: String(input.loginAccountId ?? ''), actorAccountId: String(input.actorAccountId ?? ''), conversationType: match[1], conversationId: match[2], objectId: String(input.objectId ?? ''), direction: input.direction ?? 'inbound' };
      if (!/^[1-9][0-9]{0,19}$/.test(facts.loginAccountId) || !/^[1-9][0-9]{0,19}$/.test(facts.actorAccountId) || !/^-?[A-Za-z0-9][A-Za-z0-9_.:-]{0,126}$/.test(facts.objectId) || !['inbound', 'outbound'].includes(facts.direction)) return problem('MEMORY_SOURCE_FACTS_INVALID', 'QQ source identity requires actual login, actor and stable platform/send-operation IDs.');
      if (approvedSend && sameRole(role, roleOf(getCharacter))) { const admitted = await client.validate(approvedSend.captured.handle); if (!admitted?.ok) return { ...admitted, acceptance: 'rejected', sourceState: 'not_saved' }; }
      const conversationKey = `qq:${facts.loginAccountId}:${match[1]}:${match[2]}`;
      captured = approvedSend?.captured ?? await client.capture(conversationKey, { sourceFacts: facts });
      if (!approvedSend) checkRole(role);
      if (!captured?.ok) return { ...(captured ?? problem('MEMORY_CAPTURE_FAILED', 'Host did not authorize the QQ source.')), acceptance: 'rejected', sourceState: 'not_saved' };
      const stamp = captured.sourceStamp;
      if (!stamp || stamp.characterId !== role.id || stamp.capturedEpoch !== role.epoch || stamp.conversationKey !== conversationKey || stamp.sourceAccountKey !== `qq:${facts.actorAccountId}`) return problem('MEMORY_SOURCE_CONTEXT_MISMATCH', 'Host source identity differs from the actual platform envelope.');
      const segmentId = digest([role.id, role.epoch, conversationKey, facts.objectId, facts.direction]);
      const producerId = `qq:${facts.loginAccountId}:actor:${facts.actorAccountId}`;
      const root = path.join(directory, role.id, String(role.epoch)), metaFile = path.join(root, `${segmentId}.json`);
      if (fs.existsSync(metaFile)) {
        record = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (record.segmentId !== segmentId || record.role.id !== role.id || record.role.epoch !== role.epoch || record.sourceFacts.objectId !== facts.objectId) return problem('MEMORY_SOURCE_IDENTITY_CONFLICT', 'The producer source identity conflicts with its original queue.');
        durableRecord = true;
      } else {
        if (typeof client.registerProducer !== 'function') return problem('MEMORY_PRODUCER_RECOVERY_REQUIRED', 'Host has not enabled immutable QQ producer registration.');
        const registered = approvedSend?.registered ?? await client.registerProducer(captured.handle, { producerId, segmentId }, `qq-register:${segmentId}`);
        const registrationOperationId = `qq-register:${segmentId}`;
        const spool = createSpool({ directory: root, producerId, segmentId, context: stamp });
        if (!spool.ok) return spool;
        syncDirectory(root);
        const actualObjectId = facts.direction === 'outbound' && input.deliveryState === 'delivered' && input.platformMessageId ? String(input.platformMessageId) : facts.objectId;
        const eventId = `qq-event:${digest([role.id, role.epoch, conversationKey, actualObjectId, facts.direction])}`;
        const queued = spool.append({ eventId, operationId: `qq-source:${segmentId}`, sourceKey: `qq-source:${digest([conversationKey, actualObjectId, facts.direction])}`, content: input.text, occurredAt: input.occurredAt ?? null, observedAt: new Date().toISOString(), timePrecision: input.occurredAt ? 'exact' : 'unknown', certainty: facts.direction === 'outbound' ? (input.deliveryState === 'delivered' ? 'observed' : 'unknown') : 'reported', attribution: facts.direction === 'outbound' ? 'action' : 'statement', coverage: { deliveryState: facts.direction === 'outbound' ? input.deliveryState ?? 'delivery_unknown' : 'received', platformMessageId: input.platformMessageId ?? null } });
        const sealed = spool.seal();
        if (!queued.ok || !sealed.ok) return !queued.ok ? queued : sealed;
        record = { version: 1, registrationOperationId, registrationId: registered?.ok ? registered.registrationId ?? null : null, role, key: input.key, sourceFacts: facts, deliveryState: facts.direction === 'outbound' ? input.deliveryState ?? 'delivery_unknown' : 'received', sourceStamp: stamp, segmentId, producerId, file: spool.file, metaFile, cursor: 0, refs: [], sourceState: 'pending', unknownOperation: null };
        save(metaFile, record); durableRecord = true;
      }
      if (record.sourceFacts.direction === 'inbound' || record.deliveryState === 'delivered') latest.set(input.key, record);
      if (!record.registrationId) { const pending = problem('MEMORY_PRODUCER_REGISTRATION_PENDING', 'The approved source is durable, but its original producer-registration receipt is not confirmed.', 'Query the original registration operation; keep its role and epoch unchanged.'); failures.set(input.key, pending); return { ...pending, acceptance: 'queued_durable', sourceState: 'pending', operationId: record.registrationOperationId }; }
      const result = await flush(record, captured.handle);
      if (!result.ok) { failures.set(input.key, result); return { ...result, acceptance: 'queued_durable', sourceState: 'pending' }; }
      failures.delete(input.key); return result;
    } catch (error) {
      const result = record && !durableRecord ? problem('MEMORY_SPOOL_METADATA_FAILED', 'The QQ source queue has no confirmed durable metadata receipt.', 'Inspect protected producer segments and the original registration receipt before retrying; keep the original files.') : safeError(error); if (input.key) failures.set(input.key, result);
      return durableRecord ? { ...result, acceptance: 'queued_durable', sourceState: 'pending' } : { ...result, acceptance: 'rejected', sourceState: 'not_saved' };
    } finally { if (captured?.handle) await release(captured.handle); }
  }
  function captureSource(input) {
    let role;
    try { role = roleOf(getCharacter); } catch (error) { return Promise.resolve({ ...safeError(error), acceptance: 'rejected', sourceState: 'not_saved' }); }
    const task = sourceChain.then(() => recordSource({ ...input, expectedCharacter: input.expectedCharacter ?? role }));
    sourceChain = task.catch(() => {}); return task;
  }
  async function prepareReply({ key, query } = {}) {
    let captured;
    try {
      const role = roleOf(getCharacter), route = requireRoute();
      if (route.backend === 'v1') return { ok: true, backend: 'v1' };
      await sourceChain; checkRole(role);
      const current = latest.get(key);
      if (!current || current.sourceState !== 'committed') return failures.get(key) ?? problem('MEMORY_SOURCE_PENDING', 'The current QQ input is not committed and authorized.');
      checkRole(current.role);
      captured = await client.capture(current.sourceStamp.conversationKey, { sourceFacts: current.sourceFacts }); checkRole(role);
      if (!captured?.ok) return captured ?? problem('MEMORY_CAPTURE_FAILED', 'Host did not authorize a fresh QQ request.');
      const selected = [], unavailableHistory = [];
      for (const entry of (history.get(key) ?? []).filter(item => sameRole(item.role, role) && item.segmentId !== current.segmentId).slice(-6)) {
        const probe = await client.capture(current.sourceStamp.conversationKey, { sourceFacts: current.sourceFacts }); checkRole(role);
        if (!probe?.ok) return probe ?? problem('MEMORY_CAPTURE_FAILED', 'Host did not authorize retained-history validation.');
        try {
          const allowed = await client.bindActualInput(probe.handle, entry.refs); checkRole(role);
          if (allowed?.ok) selected.push(entry);
          else if (['MEMORY_EVIDENCE_DENIED', 'MEMORY_SOURCE_STALE'].includes(allowed?.code)) unavailableHistory.push({ segmentId: entry.segmentId, code: allowed.code });
          else return allowed ?? problem('MEMORY_MANIFEST_BINDING_FAILED', 'Retained-history authorization did not complete.');
        } finally { await release(probe.handle); }
      }
      selected.push(current);
      const refs = selected.flatMap((entry) => entry.refs);
      const bound = await client.bindActualInput(captured.handle, refs); checkRole(role);
      if (!bound?.ok) return bound ?? problem('MEMORY_MANIFEST_BINDING_FAILED', 'The actual QQ input manifest was not authorized.');
      const sourceText = (entry) => {
        let cursor = 0, text = '';
        while (cursor < fs.statSync(entry.file).size) { const batch = readSpool({ file: entry.file, offset: cursor }); if (!batch.ok || !batch.events.length) throw Object.assign(new Error('A retained QQ source is incomplete.'), problem('MEMORY_SPOOL_BAD_LINE', 'A retained QQ source is incomplete.')); for (const event of batch.events) { const ref = entry.refs.find(item => item.id === event.eventId); if (!ref || ref.payloadDigest !== event.payloadDigest || event.characterId !== entry.role.id || event.capturedEpoch !== entry.role.epoch || event.conversationKey !== entry.sourceStamp.conversationKey || event.actorAccountKey !== entry.sourceStamp.sourceAccountKey) throw Object.assign(new Error('A retained source differs from its committed manifest.'), problem('MEMORY_MANIFEST_BINDING_FAILED', 'A retained source differs from its committed manifest.')); text += event.content; } cursor = batch.nextOffset; }
        return text;
      };
      const currentText = sourceText(current), retrievalQuery = typeof query === 'string' ? redactContent(query, { scope: 'qq' }) : currentText;
      const prepared = await prepareContext({ characterId: role.id, characterEpoch: role.epoch, scene: 'qq', audience: { channel: 'qq', conversationKey: current.sourceStamp.conversationKey }, includeLife: false, includePurpose: false }, { adapter: client, handle: captured.handle, query: retrievalQuery }); checkRole(role);
      if (!prepared?.ok) return prepared ?? problem('MEMORY_PREPARATION_FAILED', 'QQ memory preparation did not complete.');
      const previous = active.get(key); if (previous?.handle) await release(previous.handle);
      const packet = { handle: captured.handle, preparedHandle: prepared.preparedHandle, role, route: digest(route.descriptor ?? route), sourceStamp: captured.sourceStamp, inputManifest: prepared.inputManifest, source: current, selectedSources: structuredClone(selected) };
      active.set(key, packet); captured = null;
      const lines = selected.map((entry) => `${entry.sourceFacts.direction === 'outbound' ? '角色' : entry.sourceStamp.sourceAccountKey}：${sourceText(entry)}`);
      return { ...prepared, backend: 'v2', unavailableHistory, text: `${prepared.text}\n\n【已授权最近对话与当前输入】\n${lines.join('\n')}\n\n请根据当前输入回应；只使用本次已授权材料。`, sessionStamp: { ...packet.sourceStamp, routeGeneration: packet.route }, providerAdmissionCoverage: 'submission-observed' };
    } catch (error) { return safeError(error); }
    finally { if (captured?.handle) await release(captured.handle); }
  }
  async function validate(key, { prepared = false } = {}) {
    try {
      const route = requireRoute(); if (route.backend === 'v1') return { ok: true, backend: 'v1' };
      const packet = active.get(key); if (!packet) return problem('MEMORY_CONTEXT_REQUIRED', 'No current authorized QQ request exists.');
      checkRole(packet.role);
      if (packet.route !== digest(route.descriptor ?? route)) return problem('MEMORY_BINDING_STALE', 'The memory routing generation changed.');
      const result = await client.validate(packet.handle, prepared ? packet.preparedHandle : undefined); checkRole(packet.role);
      if (!result?.ok) return result ?? problem('MEMORY_VALIDATION_FAILED', 'Host did not validate the current QQ input manifest.');
      return { ok: true, backend: 'v2' };
    } catch (error) { return safeError(error); }
  }
  async function exportNativeSources(key) {
    try {
      const packet = active.get(key), route = requireRoute();
      if (route.backend !== 'v2' || !packet?.handle || !packet.preparedHandle) return problem('MEMORY_CONTEXT_REQUIRED', 'A current prepared V2 QQ request is required.');
      const current = () => {
        checkRole(packet.role);
        const latestRoute = requireRoute();
        if (active.get(key) !== packet || latestRoute.backend !== 'v2' || digest(latestRoute.descriptor ?? latestRoute) !== packet.route) throw Object.assign(new Error('The prepared QQ request or route changed.'), problem('MEMORY_BINDING_STALE', 'The prepared QQ request or route changed.'));
      };
      current();
      const admitted = await client.validate(packet.handle, packet.preparedHandle);
      current();
      if (!admitted?.ok) return problem(/^(MEMORY|CHARACTER)_[A-Z_]+$/.test(admitted?.code) ? admitted.code : 'MEMORY_VALIDATION_FAILED', admitted?.error || 'Host did not validate the prepared QQ request.', admitted?.hint);
      const entries = packet.selectedSources;
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 7) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'The selected QQ source set is invalid.');
      const sources = [], seen = new Set(), roots = new Set();
      let totalRefs = 0;
      for (const entry of entries) {
        const facts = entry.sourceFacts, refs = entry.refs;
        const conversationKey = `qq:${facts.loginAccountId}:${facts.conversationType}:${facts.conversationId}`;
        const segmentId = digest([packet.role.id, packet.role.epoch, conversationKey, facts.objectId, facts.direction]);
        if (!sameRole(entry.role, packet.role) || entry.key !== key || conversationKey !== packet.sourceStamp.conversationKey || entry.sourceStamp.conversationKey !== conversationKey || entry.sourceStamp.sourceAccountKey !== `qq:${facts.actorAccountId}` || entry.segmentId !== segmentId || entry.producerId !== `qq:${facts.loginAccountId}:actor:${facts.actorAccountId}` || entry.sourceState !== 'committed' || entry.deliveryState !== (facts.direction === 'inbound' ? 'received' : 'delivered') || !Array.isArray(refs) || refs.length < 1) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ source has an invalid scope or reference count.');
        totalRefs += refs.length;
        if (totalRefs > 128) return problem('MEMORY_SOURCE_EXPORT_TOO_LARGE', 'The selected QQ sources exceed the reference limit.');
        const size = fs.statSync(entry.file).size;
        if (size !== entry.cursor) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ source differs from its committed cursor.');
        const events = [];
        let cursor = 0;
        while (cursor < size) {
          const batch = readSpool({ file: entry.file, offset: cursor });
          if (!batch.ok) return batch;
          if (!batch.events.length || batch.nextOffset <= cursor || events.length + batch.events.length > refs.length) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ source is incomplete or has extra records.');
          events.push(...batch.events); cursor = batch.nextOffset;
          if (Buffer.byteLength(JSON.stringify(events)) > 2 * 1024 * 1024) return problem('MEMORY_SOURCE_EXPORT_TOO_LARGE', 'The selected QQ sources exceed the export limit.');
        }
        if (fs.statSync(entry.file).size !== size || events.length !== refs.length) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ source is incomplete or changed.');
        const first = events[0];
        if (!first || first.partCount !== events.length || roots.has(first.rootEventId)) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ source has duplicate or incomplete parts.');
        roots.add(first.rootEventId);
        for (let index = 0; index < events.length; index++) {
          const event = events[index], ref = refs[index];
          if (!ref || Object.keys(ref).sort().join(',') !== 'id,payloadDigest,revision,type' || ref.type !== 'event' || ref.revision !== 1 || ref.id !== event.eventId || ref.payloadDigest !== event.payloadDigest || seen.has(event.eventId) || event.characterId !== packet.role.id || event.capturedEpoch !== packet.role.epoch || event.channel !== 'qq' || event.conversationKey !== conversationKey || event.actorAccountKey !== `qq:${facts.actorAccountId}` || event.segmentId !== segmentId || event.producerId !== entry.producerId || event.rootEventId !== first.rootEventId || event.wholeDigest !== first.wholeDigest || event.partCount !== events.length || event.partIndex !== index || event.coverage?.deliveryState !== entry.deliveryState) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'A selected QQ event differs from its committed source reference.');
          seen.add(event.eventId);
        }
        const { rootEventId, wholeDigest, partIndex, partCount, payloadDigest, ...base } = first;
        base.eventId = rootEventId;
        if (partCount > 1) { const suffix = `.part-1-of-${partCount}`; if (!base.sourceKey.endsWith(suffix) || !base.operationId.endsWith(suffix)) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'The selected QQ source has invalid part identifiers.'); base.sourceKey = base.sourceKey.slice(0, -suffix.length); base.operationId = base.operationId.slice(0, -suffix.length); }
        base.content = events.map(event => event.content).join(''); base.textCompleteness = 'complete';
        if (eventDigest(base) !== wholeDigest) return problem('MEMORY_SOURCE_EXPORT_INVALID', 'The selected QQ source content is incomplete.');
        sources.push({ sourceFacts: structuredClone(facts), events, eventRefs: structuredClone(refs) });
      }
      if (Buffer.byteLength(JSON.stringify(sources)) > 2 * 1024 * 1024) return problem('MEMORY_SOURCE_EXPORT_TOO_LARGE', 'The selected QQ sources exceed the export limit.');
      current();
      return { ok: true, authority: 'requires-kernel-binding', packet: { character: { ...packet.role }, conversationKey: packet.sourceStamp.conversationKey, sources } };
    } catch (error) { return safeError(error); }
  }
  async function validateSessionSafety({ sessionId, preset } = {}) {
    try {
      const role = roleOf(getCharacter);
      if (typeof sessionId !== 'string' || !sessionId || typeof preset !== 'string' || !preset || typeof getSessionMemorySafety !== 'function') return problem('MEMORY_PRESET_UNSAFE', 'The actual QQ session has no trusted restricted-tool proof.', 'Enable the native Host session guard and approve its fixed safe tool surface before using V2 replies.');
      const allowed = await getSessionMemorySafety({ sessionId, preset }); checkRole(role);
      return allowed === true ? { ok: true } : problem('MEMORY_PRESET_UNSAFE', 'The actual QQ session has no trusted restricted-tool proof.', 'Enable the native Host session guard and approve its fixed safe tool surface before using V2 replies.');
    } catch { return problem('MEMORY_PRESET_UNSAFE', 'The trusted QQ session-safety check failed.', 'Restore the native Host session guard and retry with a fresh authorized input.'); }
  }
  async function authorizeSend({ key, loginAccountId, objectId = `send:${randomUUID()}` } = {}) {
    let captured;
    try {
      const role = roleOf(getCharacter), allowed = await validate(key); checkRole(role);
      if (!allowed.ok || allowed.backend === 'v1') return allowed;
      const match = /^(group|private):([1-9][0-9]{0,19})$/.exec(key ?? '');
      if (!match || !/^[1-9][0-9]{0,19}$/.test(String(loginAccountId))) return problem('MEMORY_SOURCE_FACTS_INVALID', 'Actual OneBot login is required before an outbound send.');
      const facts = { loginAccountId: String(loginAccountId), actorAccountId: String(loginAccountId), conversationType: match[1], conversationId: match[2], objectId, direction: 'outbound' };
      const conversationKey = `qq:${facts.loginAccountId}:${match[1]}:${match[2]}`;
      captured = await client.capture(conversationKey, { sourceFacts: facts }); checkRole(role);
      if (!captured?.ok || captured.sourceStamp?.characterId !== role.id || captured.sourceStamp?.capturedEpoch !== role.epoch || captured.sourceStamp?.sourceAccountKey !== `qq:${facts.loginAccountId}` || captured.sourceStamp?.conversationKey !== conversationKey) return captured?.ok === false ? captured : problem('MEMORY_SOURCE_CONTEXT_MISMATCH', 'Host did not authorize the actual outbound identity.');
      if (captured.sourceStamp.providerRouteId !== active.get(key)?.sourceStamp.providerRouteId) return problem('MEMORY_PROVIDER_ROUTE_MISMATCH', 'The outbound source route changed after reply preparation.', 'Retire the request and approve the exact current provider/model before replying.');
      const actualInput = active.get(key)?.inputManifest;
      if (!Array.isArray(actualInput)) return problem('MEMORY_MANIFEST_REQUIRED', 'No full input manifest is available for the QQ send.');
      const bound = await client.bindActualInput(captured.handle, actualInput); checkRole(role); if (!bound?.ok) return bound;
      const segmentId = digest([role.id, role.epoch, conversationKey, facts.objectId, 'outbound']);
      const registered = await client.registerProducer(captured.handle, { producerId: `qq:${facts.loginAccountId}:actor:${facts.actorAccountId}`, segmentId }, `qq-register:${segmentId}`); checkRole(role);
      if (!registered?.ok || !registered.registrationId) return registered;
      const admitted = await client.validate(captured.handle); checkRole(role); if (!admitted?.ok) return admitted;
      const lease = Object.freeze({}); sendLeases.set(lease, { key, role, facts, captured, registered }); captured = null;
      return { ok: true, backend: 'v2', lease };
    } catch (error) { return safeError(error); }
    finally { if (captured?.handle) await release(captured.handle); }
  }
  function recordSent(lease, { text, messageId = null, deliveryState = 'delivery_unknown' } = {}) {
    const approved = sendLeases.get(lease);
    if (!approved) return Promise.resolve(problem('MEMORY_SOURCE_LEASE_REQUIRED', 'The outbound source has no private pre-send authorization lease.'));
    sendLeases.delete(lease);
    const task = sourceChain.then(() => recordSource({ key: approved.key, ...approved.facts, text, platformMessageId: messageId, deliveryState, expectedCharacter: approved.role }, approved));
    sourceChain = task.catch(() => {}); return task;
  }
  async function retire(key, { preserveSources = false } = {}) { const packet = active.get(key); active.delete(key); if (!preserveSources) { latest.delete(key); history.delete(key); } if (packet?.handle) await release(packet.handle); }
  async function drainPending(key) {
    await sourceChain;
    const records = [];
    if (fs.existsSync(directory)) for (const roleDir of fs.readdirSync(directory)) for (const epochDir of fs.readdirSync(path.join(directory, roleDir))) for (const name of fs.readdirSync(path.join(directory, roleDir, epochDir))) if (name.endsWith('.json')) {
      try { const record = JSON.parse(fs.readFileSync(path.join(directory, roleDir, epochDir, name), 'utf8')); if (record.sourceState !== 'committed' && (!key || record.key === key)) records.push(record); } catch { return problem('MEMORY_SPOOL_BAD_METADATA', 'Producer queue metadata cannot be read; keep all original files.'); }
    }
    const outcomes = [];
    for (const record of records) {
      if (!record.registrationId) {
        const registered = typeof client.queryProducerReceipt === 'function' ? await client.queryProducerReceipt({ operationId: record.registrationOperationId }) : null;
        if (!registered?.ok || !registered.registrationId || registered.characterId !== record.role.id || registered.capturedEpoch !== record.role.epoch) { outcomes.push(problem('MEMORY_PRODUCER_REGISTRATION_PENDING', 'The original producer registration is not confirmed for its original role and epoch.', 'Keep the old spool and query the original operation; do not rewrite or re-register it under the active role.')); continue; }
        record.registrationId = registered.registrationId; save(record.metaFile, record);
      }
      if (!sameRole(record.role, roleOf(getCharacter))) {
        if (!record.registrationId || typeof client.replayProducer !== 'function' || typeof client.queryProducerReceipt !== 'function') outcomes.push(problem('MEMORY_REPLAY_AUTHORIZATION_REQUIRED', 'An original-epoch producer segment requires the trusted Host recovery interface.'));
        else outcomes.push(await flush(record, null, { recovery: true }));
        continue;
      }
      const captured = await client.capture(record.sourceStamp.conversationKey, { sourceFacts: record.sourceFacts });
      if (!captured.ok) { outcomes.push(captured); continue; }
      try { outcomes.push(await flush(record, captured.handle)); } finally { await release(captured.handle); }
    }
    return { ok: outcomes.every((result) => result.ok), outcomes };
  }
  return Object.freeze({ routing, captureSource, prepareReply, validate, exportNativeSources, validateSessionSafety, authorizeSend, recordSent, retire, drainPending, status: (key) => ({ sourceState: latest.get(key)?.sourceState ?? 'not_saved', active: active.has(key), failure: failures.get(key) ?? null }) });
}
