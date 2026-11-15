import fs from 'node:fs';
import { canonical, digest, validatePolicy } from '../../../src/core/memory-v2-contract.js';
import { isLoopbackReq, json } from './http-guard.js';
import { deriveBiliV2PublicSourceSet } from './bili-v2-public-source-set.mjs';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';

const PREFIX = '/dsh-surfcore/api/memory-v2';
const PREVIEWS = { preview_backup: 'backup', preview_restore: 'restore', preview_delete: 'request_delete', preview_migration: 'migrate' };
const FIELDS = {
  backup: [], restore: ['backupId'], request_delete: ['mode', 'recordId', 'recordRevision'],
  suppress: ['recordId', 'recordRevision'], remove_hot: ['recordId', 'recordRevision'], correct: ['recordId', 'recordRevision', 'content'],
  continue_delete: ['operationId'], resume: [], configure_policy: ['conversationId', 'processorScope'], revoke_policy: ['policyId'],
  create_person: ['platform', 'accountId'], bind_account: ['platform', 'accountId', 'personId'], unbind_account: ['bindingId'], organize: ['optIn', 'manual'], migrate: ['snapshotId'],
};
const METHODS = { backup: 'backup', restore: 'restore', request_delete: 'requestDelete', continue_delete: 'continueDelete', resume: 'resume' };
const PREVIEW_METHODS = { backup: 'previewBackup', restore: 'previewRestore', request_delete: 'previewDelete' };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const stable = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@.-]{0,255}$/.test(value);
const failure = (code, hint = '刷新当前角色状态并重新预览；提交结果未知时，只核对原操作编号。') => ({ ok: false, code, error: '记忆管理请求未完成。', hint });
const ensure = (condition, code, hint) => { if (!condition) throw failure(code, hint); };
const safeCode = code => typeof code === 'string' && /^(?:MEMORY|CHARACTER|ORGANIZER|BUDGET)_[A-Z_]+$/.test(code) ? code : 'MEMORY_MANAGEMENT_FAILED';
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const label = value => text(value) && value.length <= 200 && !/(?:token|secret|pass(?:word)?|cookie|bearer)\s*[:=]|(?:\/Users\/|\/private\/|[A-Z]:\\)/i.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,100}$/.test(value);
const pickNumbers = (value, keys) => Object.fromEntries(keys.filter(key => number(value?.[key])).map(key => [key, value[key]]));
const notStarted = value => ['not_found', 'not_started'].includes(value?.operationState);
const unknown = value => [value, value?.receipt].some(v => v && (v.retry === 'query_receipt' || v.sourceState === 'commit_unknown' || ['unknown', 'completed_before_cancel'].includes(v.operationState) || ['commit_unknown', 'MEMORY_COMMIT_UNCERTAIN', 'MEMORY_COMMIT_UNKNOWN'].includes(v.state) || ['MEMORY_COMMIT_UNCERTAIN', 'MEMORY_COMMIT_UNKNOWN'].includes(v.code)));
function phases(value = {}) {
  const result = {};
  for (const key of ['operationId', 'sourceState', 'selectionState', 'indexState', 'operationState', 'state', 'phase', 'deletionPhase', 'accessState', 'retry', 'backupId']) if ((key === 'operationId' || key === 'backupId' ? stable(value[key]) : token(value[key]))) result[key] = value[key];
  for (const key of ['source', 'selection', 'index']) {
    if (token(value[key])) result[key] = value[key];
    else if (plain(value[key])) result[key] = phases(value[key]);
  }
  Object.assign(result, pickNumbers(value, ['controlRevision', 'appliedControlRevision', 'commitSequence']));
  for (const key of ['complete', 'applied', 'activeStorePurged', 'retainedCopiesPurged']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (value.receipt) result.receipt = phases(value.receipt);
  if (value.ok === false || value.code) Object.assign(result, failure(safeCode(value.code)), { ok: value.ok === true });
  return result;
}
function checked(value) { if (value?.ok !== true) throw { ...failure(safeCode(value?.code)), ...phases(value), ok: false }; return value; }
function safeRows(rows, fields) {
  return list(rows).slice(0, 100).filter(row => plain(row) && stable(row.id)).map(row => Object.fromEntries(fields.filter(key => key === 'id' ? stable(row[key]) : key === 'verified' ? typeof row[key] === 'boolean' : label(row[key])).map(key => [key, row[key]])));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0, done = false;
    const finish = (error, body) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(body); };
    const timer = setTimeout(() => finish(failure('MEMORY_REQUEST_TIMEOUT')), 5000);
    req.on('data', chunk => { if (done) return; bytes += chunk.length; if (bytes > 65536) { chunks.length = 0; finish(failure('MEMORY_REQUEST_TOO_LARGE')); } else chunks.push(chunk); });
    req.on('end', () => { if (done) return; try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(failure('MEMORY_JSON_INVALID')); } });
    req.on('error', () => finish(failure('MEMORY_REQUEST_FAILED')));
    req.on('aborted', () => finish(failure('MEMORY_REQUEST_FAILED')));
  });
}

/** Private Host controller; never register its methods as model or channel RPC tools. */
function sourceSetPreview(candidate, role) {
  const value = candidate?.sourceSetPreview;
  if (value === undefined) return;
  const hint = '重新读取官方公开来源，核对完整对象集合、当前角色、账号与精确模型后再预览。';
  ensure(plain(value) && !Object.getOwnPropertySymbols(value).length && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => 'value' in item), 'MEMORY_POLICY_REQUIRED', hint);
  ensure(value.characterId === role.id && value.characterEpoch === role.epoch && label(value.provider) && label(value.model), 'MEMORY_POLICY_REQUIRED', hint);
  const set = deriveBiliV2PublicSourceSet({ characterId: value.characterId, characterEpoch: value.characterEpoch, accountMid: value.accountMid, providerRouteId: value.providerRouteId, selectors: value.selectors, outputTarget: value.outputTarget });
  ensure(set.ok && set.id === value.id, 'MEMORY_POLICY_REQUIRED', hint);
  const scopes = list(candidate.processorScopes);
  ensure(scopes.length === 1 && plain(scopes[0]?.policy), 'MEMORY_POLICY_REQUIRED', hint);
  const policy = validatePolicy(scopes[0].policy), account = `bili:${value.accountMid}:actor:${value.accountMid}`;
  const audiences = [set.outputConversationKey, ...set.sourceConversations.map(source => source.conversationKey)].map(key => ['bili', key, account]);
  ensure(policy.approved === true && policy.processingGrants.length === 1 && policy.processingGrants[0].providerRouteId === value.providerRouteId && digest(policy.audiences) === digest(validatePolicy({ ...policy, audiences }).audiences), 'MEMORY_POLICY_REQUIRED', hint);
  return { id: set.id, characterId: value.characterId, characterEpoch: value.characterEpoch, accountMid: value.accountMid, providerRouteId: value.providerRouteId,
    provider: value.provider, model: value.model, selectors: set.selectors, outputTarget: set.outputTarget };
}
function qqAccessPreview(candidate, role) {
  if (!/^qq-(group|private)-[1-9][0-9]*$/.test(candidate?.id ?? '')) return;
  const access = candidate.replyAccess, policy = candidate.processorScopes?.[0]?.policy;
  ensure(plain(access) && label(access.provider) && label(access.model) && /^[1-9][0-9]{0,19}$/.test(access.accountId), 'MEMORY_POLICY_REQUIRED');
  const [, kind, id] = candidate.id.split('-'), conversationKey = `qq:${access.accountId}:${kind}:${id}`;
  const route = deriveMemoryProviderRouteId(access);
  ensure(route.ok && policy?.approved === true && policy.audiences?.length === 1 && policy.audiences[0][0] === 'qq' && policy.audiences[0][1] === conversationKey && policy.audiences[0][2] === (kind === 'group' ? '*' : `qq:${id}`) && policy.processingGrants?.length === 1 && policy.processingGrants[0].providerRouteId === route.providerRouteId, 'MEMORY_POLICY_REQUIRED');
  return { conversationId: candidate.id, conversationKey, accountId: access.accountId, provider: access.provider, model: access.model, characterId: role.id, characterEpoch: role.epoch };
}

export function createMemoryManagementController({ memoryService, getCharacter, getAuthorization = () => null, getRuntimeStatus = () => ({}), inspectMemory, organizer, migrator, identityManager, corrector, hotManager = null, adminResumer = null, onControlChanged = () => {}, now = Date.now, previewTtlMs = 120000 } = {}) {
  if (typeof memoryService?.host?.captureAdminContext !== 'function' || typeof getCharacter !== 'function' || typeof getAuthorization !== 'function' || typeof getRuntimeStatus !== 'function' || typeof onControlChanged !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1 || previewTtlMs > 300000) throw new TypeError('Invalid management Host dependencies.');
  const previews = new Map(), planning = new Map(), active = new Set(), resumePreviews = new Map(), resuming = new Set(); let disposed = false;
  function native() {
    const value = getCharacter();
    ensure(value && !value.then && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value.id) && Number.isSafeInteger(value.epoch) && value.epoch > 0, 'CHARACTER_CONTEXT_REQUIRED');
    return { id: value.id, epoch: value.epoch, ...(label(value.name) ? { name: value.name } : {}) };
  }
  function guard(role) { const current = native(); ensure(!disposed, 'MEMORY_MANAGEMENT_CLOSED'); ensure(current.id === role.id && current.epoch === role.epoch, 'CHARACTER_EPOCH_STALE'); }
  async function wait(role, promise) { guard(role); const value = await promise; guard(role); return value; }
  async function capture(role, authorization) {
    return checked(await wait(role, memoryService.host.captureAdminContext({ channel: 'local', conversationKey: 'local:memory-management', sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', audiencePolicyId: 'local:management', providerRouteId: 'local:management', processingGrantId: 'local:management' }, authorization))).context;
  }
  async function snapshot(role, ctx, channel) {
    const core = checked(await wait(role, memoryService.getStatus()));
    const runtime = await wait(role, getRuntimeStatus({ context: ctx, ...(channel ? { channel } : {}) }));
    ensure(plain(runtime) && (runtime.characterId === undefined || runtime.characterId === role.id), 'MEMORY_RUNTIME_SCOPE_INVALID');
    const scoped = { ...runtime };
    for (const key of ['backups', 'policies', 'approvedConversations', 'bindings']) scoped[key] = list(runtime[key]).filter(row => row.characterId === undefined || row.characterId === role.id);
    return { core, runtime: scoped };
  }
  const runnerFor = action => action === 'organize' ? organizer : action === 'migrate' ? migrator : action === 'correct' ? corrector : action === 'remove_hot' ? hotManager : ['create_person', 'bind_account', 'unbind_account'].includes(action) ? identityManager : null;
  const capable = runner => typeof runner?.preview === 'function' && typeof runner?.commit === 'function' && typeof runner?.receipt === 'function';
  function status(role, core, runtime) {
    const current = list(core.characters).find(row => row.characterId === role.id);
    // V2-only（R01/§5.1）：「后端」和「就绪」是两个事实，不能看到 backend=v2 就宣称运行正常。
    // 后端只可能是 v2；任何缺失都进入可见 blocked，并带上机器码与下一步，而不是悄悄回落 v1。
    const backend = runtime.backend === 'v2' ? 'v2' : null;
    const blocked = backend === null
      ? { code: 'MEMORY_BACKEND_RETIRED', hint: '本版本只支持 V2 记忆；在记忆页核对当前角色与授权，不要切回旧后端。' }
      : null;
    const result = {
      ok: true, character: role, revision: core.revision, storeGeneration: core.storeGeneration,
      backend: backend ?? 'v2',
      readiness: blocked ? 'blocked' : 'ready',
      ...(blocked ? { reason: blocked } : {}),
      capabilities: { adminResume: typeof adminResumer?.resume === 'function', shadow: core.capabilities?.shadow === true, activation: false, removeHot: capable(hotManager), backup: typeof memoryService.host.lifecycle?.backup === 'function', restore: typeof memoryService.host.lifecycle?.restore === 'function', purge: typeof inspectMemory === 'function' && typeof memoryService.host.lifecycle?.requestDelete === 'function', organize: capable(organizer), identity: capable(identityManager), migration: capable(migrator), correct: capable(corrector) },
      worker: { state: 'ready' }, counts: { ...(number(current?.eventCount) ? { sources: current.eventCount } : {}), ...(number(current?.memoryVersionCount) ? { committed: current.memoryVersionCount } : {}) },
      backups: safeRows(runtime.backups, ['id', 'label', 'verified']), policies: safeRows(runtime.policies, ['id', 'label']),
      operations: list(runtime.operations).filter(row => row.characterId === role.id).slice(0, 100).map(row => ({ ...phases(row), ...(token(row.action) ? { action: row.action } : {}) })),
      approvedConversations: safeRows(runtime.approvedConversations, ['id', 'label']).map(row => {
        const candidate = runtime.approvedConversations.find(item => item.id === row.id), preview = sourceSetPreview(candidate, role);
        const access = candidate?.replyAccess;
        const replyAccess = plain(access) && typeof access.approved === 'boolean' && label(access.provider) && label(access.model) && /^[1-9][0-9]{0,19}$/.test(access.accountId) ? { approved: access.approved, provider: access.provider, model: access.model, accountId: access.accountId, ...(stable(access.policyId) ? { policyId: access.policyId } : {}), ...(token(access.code) ? { code: access.code } : {}) } : undefined;
        return { ...row, ...(replyAccess ? { replyAccess } : {}), ...(preview ? { sourceSetPreview: preview } : {}), processorScopes: list(candidate?.processorScopes).filter(scope => plain(scope) && stable(scope.id)).slice(0, 32).map(scope => ({ id: scope.id, ...(label(scope.label) ? { label: scope.label } : {}) })) };
      }),
      budget: pickNumbers(runtime.budget, ['settled', 'reserved', 'unknownHolds', 'cost']),
    };
    if (runtime.queue) result.queue = pickNumbers(runtime.queue, ['pending', 'highWater', 'unsavedSince']);
    if (runtime.storage) result.storage = pickNumbers(runtime.storage, ['activeBytes', 'hardLimitBytes', 'spoolBytes', 'indexBytes', 'backupBytes', 'freeBytes']);
    if (runtime.migration) result.migration = { ...pickNumbers(runtime.migration, ['highWater', 'checkpoint', 'imported', 'quarantined']), ...(stable(runtime.migration.snapshot) ? { snapshot: runtime.migration.snapshot } : {}), gates: {} };
    if (runtime.bindings) result.bindings = safeRows(runtime.bindings, ['id', 'platform', 'accountId', 'personId']);
    return result;
  }
  function bodyShape(body) {
    ensure(plain(body) && Object.keys(body).length === 6 && Object.keys(body).every(key => ['action', 'payload', 'expectedRevision', 'operationId', 'characterId', 'characterEpoch'].includes(key)), 'MEMORY_FIELD_FORBIDDEN');
    ensure(typeof body.action === 'string', 'MEMORY_ACTION_UNAVAILABLE');
    const action = Object.hasOwn(PREVIEWS, body.action) ? PREVIEWS[body.action] : body.action;
    ensure(Object.hasOwn(FIELDS, action), 'MEMORY_ACTION_UNAVAILABLE');
    const keys = FIELDS[action];
    ensure(plain(body.payload) && Object.keys(body.payload).every(key => keys.includes(key) || ['preview', 'payloadDigest'].includes(key)) && keys.every(key => Object.hasOwn(body.payload, key)), 'MEMORY_FIELD_FORBIDDEN');
    const payload = Object.fromEntries(keys.map(key => [key, body.payload[key]]));
    ensure(stable(body.operationId) && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0 && typeof body.payload.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(body.payload.payloadDigest), 'MEMORY_REQUEST_INVALID');
    ensure(body.payload.preview === undefined || body.payload.preview === true, 'MEMORY_REQUEST_INVALID');
    ensure(!Object.hasOwn(PREVIEWS, body.action) || body.payload.preview === undefined, 'MEMORY_REQUEST_INVALID');
    for (const key of keys) {
      if (key === 'recordRevision') ensure(Number.isSafeInteger(payload[key]) && payload[key] > 0, 'MEMORY_REQUEST_INVALID');
      else if (['optIn', 'manual'].includes(key)) ensure(payload[key] === true, 'MEMORY_ORGANIZER_OPT_IN_REQUIRED');
      else if (key === 'content') ensure(text(payload[key]) && payload[key].trim().length > 0, 'MEMORY_REQUEST_INVALID');
      else ensure(stable(payload[key]), 'MEMORY_REQUEST_INVALID');
    }
    if (action === 'request_delete') ensure(payload.mode === 'delete_roots', 'MEMORY_REQUEST_INVALID');
    if (['create_person', 'bind_account'].includes(action)) ensure(['qq', 'bili', 'douyin'].includes(payload.platform), 'MEMORY_REQUEST_INVALID');
    ensure(digest(payload) === body.payload.payloadDigest, 'MEMORY_PAYLOAD_MISMATCH');
    return { action, payload, isPreview: Object.hasOwn(PREVIEWS, body.action) || body.payload.preview === true };
  }
  async function selected(role, ctx, payload) {
    ensure(typeof inspectMemory === 'function', 'MEMORY_INSPECTION_UNAVAILABLE', '等待 Host 提供当前角色的真实管理员检查接口。');
    const value = checked(await wait(role, inspectMemory({ context: ctx, recordId: payload.recordId, recordRevision: payload.recordRevision })));
    const record = value.record;
    ensure(plain(record) && record.id === payload.recordId && record.revision === payload.recordRevision && (record.characterId === undefined || record.characterId === role.id) && list(record.roots).length > 0 && record.roots.length <= 100 && record.roots.every(stable), 'MEMORY_RECORD_STALE');
    return [...new Set(record.roots)].sort();
  }
  async function plan(role, ctx, action, payload, runtime, operationId, expectedRevision) {
    if (['backup', 'restore'].includes(action)) {
      if (action === 'restore') ensure(list(runtime.backups).some(row => row.id === payload.backupId && row.verified === true), 'MEMORY_BACKUP_UNVERIFIED');
      return { kind: 'lifecycle', method: METHODS[action], request: payload };
    }
    if (action === 'request_delete') return { kind: 'lifecycle', method: 'requestDelete', request: { roots: await selected(role, ctx, payload) } };
    if (action === 'suppress') return { kind: 'control', request: { type: 'suppress', roots: await selected(role, ctx, payload) } };
    if (action === 'configure_policy') {
      const candidate = list(runtime.approvedConversations).find(row => row.id === payload.conversationId);
      const scope = list(candidate?.processorScopes).find(row => row.id === payload.processorScope), preview = sourceSetPreview(candidate, role);
      ensure(scope?.policy, 'MEMORY_POLICY_REQUIRED', '从 Host 已批准会话及真实处理授权中选择；客户端不能填写授权字段。');
      const qqPreview = qqAccessPreview(candidate, role);
      return { kind: 'control', request: { type: 'configure_policy', policy: validatePolicy(scope.policy) }, ...(preview ? { sourceSetPreview: preview } : {}), ...(qqPreview ? { qqAccessPreview: qqPreview } : {}) };
    }
    if (action === 'revoke_policy') { ensure(list(runtime.policies).some(row => row.id === payload.policyId), 'MEMORY_POLICY_REQUIRED'); return { kind: 'control', request: { type: 'revoke_policy', policyId: payload.policyId } }; }
    if (action === 'continue_delete') {
      ensure(list(runtime.operations).some(row => row.operationId === payload.operationId && row.characterId === role.id && row.action === 'request_delete'), 'MEMORY_OPERATION_NOT_FOUND');
      return { kind: 'lifecycle', method: 'continueDelete', request: { deleteOperationId: payload.operationId, purgeRetained: true } };
    }
    if (action === 'resume') {
      const pending = list(runtime.operations).filter(row => row.characterId === role.id && row.complete !== true && ['restore', 'request_delete', 'continue_delete'].includes(row.action));
      ensure(pending.length === 1, 'MEMORY_OPERATION_REQUIRED', '先读取未完成任务，只有唯一原任务时才可显式恢复。');
      return { kind: 'lifecycle', method: 'resume', request: { operationId: pending[0].operationId } };
    }
    const runner = runnerFor(action); ensure(capable(runner), 'MEMORY_ACTION_UNAVAILABLE', '该操作缺少真实 Host 适配器；保持关闭，不会发起模型或写入。');
    return { kind: 'runner', runner, request: payload, args: { context: ctx, action, payload, operationId, expectedRevision } };
  }
  function cleanPreview(plan, corePreview) {
    const result = { action: plan.method || plan.request.type || plan.args?.action };
    if (list(corePreview?.eventIds).length) result.sources = corePreview.eventIds.length;
    if (Array.isArray(corePreview?.versions)) result.derivedVersions = corePreview.versions.length;
    if (Array.isArray(corePreview?.retained)) result.retainedCopies = corePreview.retained.length;
    if (plan.request.roots) result.roots = plan.request.roots;
    if (plan.request.backupId) result.backupId = plan.request.backupId;
    if (plan.sourceSetPreview) result.sourceSetPreview = plan.sourceSetPreview;
    if (plan.qqAccessPreview) result.qqAccessPreview = plan.qqAccessPreview;
    if (corePreview?.preservePostBackupEvents === true) result.postBackupSources = 'preserved';
    if (corePreview?.restoreControls === false) result.currentControls = 'preserved';
    if (corePreview?.restoreQuota === false) result.budget = 'not-restored';
    if (corePreview?.counts && typeof corePreview.counts === 'object') {
      result.counts = {
        sources: Number(corePreview.counts.sources) || 0,
        records: Number(corePreview.counts.records) || 0,
        candidates: Number(corePreview.counts.candidates) || 0,
        quarantined: Number(corePreview.counts.quarantined) || 0,
        invalidRows: Number(corePreview.counts.invalidRows) || 0,
        partialTails: Number(corePreview.counts.partialTails) || 0,
        protectedRecords: Number(corePreview.counts.protectedRecords) || 0,
        parts: Number(corePreview.counts.parts) || 0,
      };
    }
    if (Number.isSafeInteger(corePreview?.candidates)) result.candidates = corePreview.candidates;
    if (Number.isSafeInteger(corePreview?.quarantined)) result.quarantined = corePreview.quarantined;
    if (Number.isSafeInteger(corePreview?.conflicts)) result.conflicts = corePreview.conflicts;
    if (Number.isSafeInteger(corePreview?.highWaterBytes)) result.highWaterBytes = corePreview.highWaterBytes;
    if (typeof corePreview?.manifest?.phase === 'string') result.phase = corePreview.manifest.phase;
    if (corePreview?.manifest?.importReady !== undefined) result.importReady = corePreview.manifest.importReady === true;
    return result;
  }
  function collect() { for (const [id, entry] of previews) if (entry.expiresAt <= now()) previews.delete(id); }
  function stamp(role, ctx, core) { return { roleId: role.id, epoch: role.epoch, revision: core.revision, generation: ctx.storeGeneration }; }
  async function query(role, ctx, operationId) {
    const result = await wait(role, memoryService.getMemoryReceipt(ctx, operationId));
    if (result?.operationId && result.operationId !== operationId) throw failure('MEMORY_OPERATION_CONFLICT');
    return result;
  }
  async function management(role, ctx, body) {
    const parsed = bodyShape(body), { action, payload, isPreview } = parsed;
    guard(role); ensure(body.characterId === role.id && body.characterEpoch === role.epoch, 'CHARACTER_EPOCH_STALE');
    const { core, runtime } = await snapshot(role, ctx, action === 'configure_policy' && /^qq-(group|private)-/.test(payload.conversationId) ? 'qq' : undefined);
    const requestBinding = { operationId: body.operationId, action, payloadDigest: digest(payload), expectedRevision: body.expectedRevision, characterId: role.id, characterEpoch: role.epoch };
    if (!isPreview) {
      let previous = await query(role, ctx, body.operationId);
      const persisted = previous?.requestBinding, runner = runnerFor(action);
      if (persisted) ensure(Object.keys(requestBinding).every(key => persisted[key] === requestBinding[key]), 'MEMORY_DIGEST_CONFLICT');
      if (notStarted(previous) && capable(runner)) previous = await wait(role, runner.receipt({ context: ctx, operationId: body.operationId }));
      if (!notStarted(previous)) {
        if (!persisted) return { ...failure('MEMORY_REQUEST_BINDING_REQUIRED', '原操作缺少可核对的持久请求绑定；只查询原回执，不复用编号提交不同内容。'), ...phases(previous), ok: false, operationId: body.operationId, operationState: previous?.operationState === 'completed_before_cancel' ? previous.operationState : 'unknown', retry: 'query_receipt' };
        return receiptResult(previous, body.operationId, true);
      }
    }
    ensure(body.expectedRevision === core.revision && ctx.controlRevision === core.revision, 'MEMORY_REVISION_CONFLICT');
    ensure(ctx.storeGeneration === core.storeGeneration, 'MEMORY_PREVIEW_STALE');
    collect(); const old = previews.get(body.operationId), actualDigest = body.payload.payloadDigest, cut = stamp(role, ctx, core);
    if (old) ensure(old.action === action && old.actualDigest === actualDigest && canonical(old.payload) === canonical(payload), 'MEMORY_OPERATION_CONFLICT');
    if (old) ensure(canonical(old.cut) === canonical(cut), 'MEMORY_PREVIEW_STALE');
    if (isPreview) {
      if (old) return { ok: true, revision: body.expectedRevision, payloadDigest: actualDigest, preview: old.preview, expiresAt: old.expiresAt };
      ensure(previews.size + planning.size < 128, 'MEMORY_PREVIEW_LIMIT');
      const planningKey = canonical({ action, payload, cut });
      if (planning.has(body.operationId)) { ensure(planning.get(body.operationId) === planningKey, 'MEMORY_OPERATION_CONFLICT'); throw failure('MEMORY_PREVIEW_BUSY'); }
      planning.set(body.operationId, planningKey);
      try {
        const planned = await plan(role, ctx, action, payload, runtime, body.operationId, body.expectedRevision);
        let preview;
        if (PREVIEW_METHODS[action]) preview = checked(await wait(role, memoryService.host.lifecycle[PREVIEW_METHODS[action]](ctx, planned.request)));
        else if (planned.kind === 'runner') preview = checked(await wait(role, planned.runner.preview(planned.args)));
        else preview = { ok: true, preview: { action }, previewDigest: digest(planned.request) };
        ensure(/^[a-f0-9]{64}$/.test(preview.previewDigest), 'MEMORY_PREVIEW_INVALID');
        const after = checked(await wait(role, memoryService.getStatus()));
        ensure(after.revision === core.revision && after.storeGeneration === core.storeGeneration, 'MEMORY_PREVIEW_STALE');
        const visible = cleanPreview(planned, preview.preview);
        const expiresAt = now() + previewTtlMs;
        previews.set(body.operationId, { cut, action, payload, actualDigest, planned, coreDigest: preview.previewDigest, preview: visible, expiresAt });
        return { ok: true, revision: body.expectedRevision, payloadDigest: actualDigest, preview: visible, expiresAt };
      } finally { planning.delete(body.operationId); }
    }
    ensure(old && old.expiresAt > now(), 'MEMORY_PREVIEW_REQUIRED', '预览已失效或服务已重启；重新预览并明确确认，不会自动执行。');
    if (active.has(body.operationId)) return { ...failure('MEMORY_OPERATION_BUSY'), operationId: body.operationId, operationState: 'unknown', retry: 'query_receipt' };
    active.add(body.operationId); let result;
    try {
      const fresh = await plan(role, ctx, action, payload, runtime, body.operationId, body.expectedRevision);
      ensure(fresh.kind === old.planned.kind && digest(fresh.request) === digest(old.planned.request), 'MEMORY_PREVIEW_STALE');
      guard(role);
      ensure(typeof memoryService.host.admin?.bindRequest === 'function', 'MEMORY_REQUEST_BINDING_UNAVAILABLE');
      checked(await wait(role, memoryService.host.admin.bindRequest(ctx, requestBinding)));
      if (fresh.kind === 'control') result = await memoryService.applyMemoryAction(ctx, fresh.request, body.expectedRevision, body.operationId);
      else if (fresh.kind === 'lifecycle') result = await memoryService.host.lifecycle[fresh.method](ctx, { ...fresh.request, ...(PREVIEW_METHODS[action] ? { previewDigest: old.coreDigest } : {}) }, body.expectedRevision, body.operationId);
      else result = await fresh.runner.commit({ ...fresh.args, context: old.planned.args.context, previewDigest: old.coreDigest });
      const current = native();
      if (current.id !== role.id || current.epoch !== role.epoch) return { ...failure('CHARACTER_EPOCH_STALE', '切回原角色并核对原操作编号；已提交阶段不会回滚。'), ...phases(result), ok: false, operationId: body.operationId, operationState: 'completed_before_cancel', retry: 'query_receipt', ...(result?.sourceState ? {} : { sourceState: result?.ok ? 'committed' : 'commit_unknown' }) };
      if (result?.ok === true || Number.isSafeInteger(result?.controlRevision) || unknown(result)) {
        try { await onControlChanged({ characterId: role.id, characterEpoch: role.epoch, operationId: body.operationId, action, result: phases(result) }); }
        catch { return { ...failure('MEMORY_NOTIFICATION_FAILED'), ...phases(result), ok: false, operationId: body.operationId, retry: 'query_receipt' }; }
        guard(role);
      }
      return receiptResult(result, body.operationId);
    } catch (error) { return { ...failure(safeCode(error?.code)), ...phases(result), ...phases(error), ok: false, operationId: body.operationId, operationState: error?.code === 'CHARACTER_EPOCH_STALE' && result ? 'completed_before_cancel' : 'unknown', retry: 'query_receipt' }; }
    finally { active.delete(body.operationId); previews.delete(body.operationId); }
  }
  function resumeBody(body) {
    ensure(plain(body) && ['operationId', 'characterId', 'characterEpoch', 'expectedRevision', 'payloadDigest'].every(key => Object.hasOwn(body, key)) && Object.keys(body).every(key => ['operationId', 'characterId', 'characterEpoch', 'expectedRevision', 'payloadDigest', 'preview', 'content'].includes(key)), 'MEMORY_FIELD_FORBIDDEN');
    ensure(stable(body.operationId) && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0 && /^[a-f0-9]{64}$/.test(body.payloadDigest), 'MEMORY_REQUEST_INVALID');
    ensure(body.preview === undefined || body.preview === true, 'MEMORY_REQUEST_INVALID');
    ensure(body.content === undefined || text(body.content) && body.content.trim().length > 0, 'MEMORY_REQUEST_INVALID');
    const payload = { operationId: body.operationId, ...(body.content !== undefined ? { content: body.content } : {}) };
    ensure(digest(payload) === body.payloadDigest, 'MEMORY_PAYLOAD_MISMATCH');
    return payload;
  }
  function dropResume(id) { const entry = resumePreviews.get(id); if (entry) clearTimeout(entry.timer); resumePreviews.delete(id); }
  async function resumeState(role, ctx, body) {
    const core = checked(await wait(role, memoryService.getStatus()));
    ensure(body.expectedRevision === core.revision && ctx.controlRevision === core.revision, 'MEMORY_REVISION_CONFLICT');
    ensure(ctx.storeGeneration === core.storeGeneration, 'MEMORY_PREVIEW_STALE');
    ensure(typeof memoryService.host.admin?.status === 'function', 'MEMORY_ACTION_UNAVAILABLE');
    const catalog = checked(await wait(role, memoryService.host.admin.status(ctx)));
    ensure(catalog.characterId === role.id && catalog.characterEpoch === role.epoch && catalog.controlRevision === core.revision, 'MEMORY_PREVIEW_STALE');
    const target = list(catalog.operations).find(row => row.operationId === body.operationId && row.characterId === role.id);
    ensure(target && ['correct', 'create_person', 'bind_account', 'unbind_account', 'remove_hot'].includes(target.action), 'MEMORY_OPERATION_NOT_FOUND', '选择当前角色真实未完成的管理员操作；生命周期任务仍使用原恢复入口。');
    ensure(target.complete === false, 'MEMORY_OPERATION_COMPLETED', '原操作已完成；查询原编号回执，不重复恢复。');
    ensure(body.content === undefined || target.action === 'correct', 'MEMORY_FIELD_FORBIDDEN');
    return { cut: stamp(role, ctx, core), target: { operationId: target.operationId, action: target.action, phase: target.phase, complete: target.complete } };
  }
  async function resumeAdmin(role, ctx, body) {
    const payload = resumeBody(body), id = body.operationId, isPreview = body.preview === true;
    ensure(typeof adminResumer?.resume === 'function', 'MEMORY_ACTION_UNAVAILABLE', '等待 Host 注入真实管理员恢复适配器；不会从浏览器创建权限。');
    guard(role); ensure(body.characterId === role.id && body.characterEpoch === role.epoch, 'CHARACTER_EPOCH_STALE');
    ensure(!resuming.has(id) && !active.has(id), 'MEMORY_OPERATION_BUSY');
    resuming.add(id); let prior, result, sent = false;
    try {
      for (const [key, entry] of resumePreviews) if (entry.expiresAt <= now()) dropResume(key);
      const fresh = await resumeState(role, ctx, body), old = resumePreviews.get(id);
      if (isPreview) {
        ensure(old || resumePreviews.size < 128, 'MEMORY_PREVIEW_LIMIT');
        const preview = { operationId: id, action: fresh.target.action, phase: fresh.target.phase }, entry = { ...fresh, context: ctx, payloadDigest: body.payloadDigest, payload, preview, expiresAt: now() + previewTtlMs };
        dropResume(id); entry.timer = setTimeout(() => { if (resumePreviews.get(id) === entry) dropResume(id); }, previewTtlMs); entry.timer.unref?.(); resumePreviews.set(id, entry);
        return { ok: true, operationId: id, revision: body.expectedRevision, payloadDigest: body.payloadDigest, preview };
      }
      ensure(old && old.expiresAt > now(), 'MEMORY_PREVIEW_REQUIRED', '预览已过期或 Host 已重启；对原编号重新预览并确认，不会自动继续。');
      ensure(old.payloadDigest === body.payloadDigest && canonical(old.payload) === canonical(payload), 'MEMORY_DIGEST_CONFLICT');
      ensure(canonical(old.cut) === canonical(fresh.cut) && canonical(old.target) === canonical(fresh.target), 'MEMORY_PREVIEW_STALE');
      prior = checked(await query(role, ctx, id));
      // The original context is rechecked against native control revisions inside the Worker resume call.
      guard(role); sent = true; result = await adminResumer.resume({ context: old.context, ...payload });
      const current = native();
      if (current.id !== role.id || current.epoch !== role.epoch) return { ...failure('CHARACTER_EPOCH_STALE', '切回原角色并核对原操作编号；已确认阶段不会回滚，不要创建新编号。'), ...phases(prior), ...phases(result), ok: false, operationId: id, operationState: 'completed_before_cancel', retry: 'query_receipt' };
      if (result?.ok === true || unknown(result)) { await onControlChanged({ characterId: role.id, characterEpoch: role.epoch, operationId: id, action: 'admin_resume', result: phases(result) }); guard(role); }
      const response = receiptResult({ ...phases(prior), ...result }, id);
      if (result?.code === 'MEMORY_CORRECTION_CONTENT_REQUIRED') response.hint = '输入最初确认的纠正原文，对原编号重新预览并确认；不要生成替代文本或新操作编号。';
      if (result?.code === 'MEMORY_DIGEST_CONFLICT') response.hint = '原文与原操作摘要不一致；输入最初确认的原文，对同一原编号重新预览。';
      return response;
    } catch (error) {
      if (!sent) throw error;
      return { ...failure(safeCode(error?.code)), ...phases(prior), ...phases(result), ...phases(error), ok: false, operationId: id, operationState: error?.code === 'CHARACTER_EPOCH_STALE' && result ? 'completed_before_cancel' : 'unknown', retry: 'query_receipt' };
    } finally { resuming.delete(id); if (!isPreview) dropResume(id); }
  }
  function receiptResult(value, operationId, queryOnly = false) {
    const incomplete = value?.complete === false || value?.applied === false || value?.ok === false && Number.isSafeInteger(value?.controlRevision) && value.controlRevision > 0;
    if (incomplete) value = { ...value, sourceState: value.sourceState || 'committed', operationState: value.operationState === 'completed_before_cancel' ? value.operationState : 'unknown', retry: 'query_receipt', ...(value.code ? { ok: false } : {}) };
    if (value?.operationId && value.operationId !== operationId) return { ...failure('MEMORY_OPERATION_CONFLICT'), operationId, state: 'commit_unknown', retry: 'query_receipt' };
    if (!value || value.ok !== true) return { ...failure(safeCode(value?.code)), ...phases(value), ok: false, operationId, ...(unknown(value) || queryOnly ? { state: 'commit_unknown', operationState: value?.operationState === 'completed_before_cancel' ? 'completed_before_cancel' : 'unknown', retry: 'query_receipt', hint: '保留原操作编号，只核对回执；跨角色请切回原角色，控制连接不可用时重启 Host 后再核对，不要重发。' } : {}) };
    if (notStarted(value)) return { ...failure('MEMORY_RECEIPT_UNRESOLVED', '当前角色无法确认原操作；保留编号，只核对回执，必要时切回原角色。'), operationId, state: 'commit_unknown', operationState: 'unknown', retry: 'query_receipt' };
    return { ok: true, ...phases(value), operationId, state: unknown(value) ? 'commit_unknown' : 'committed' };
  }
  async function handle(req, res, url) {
    const send = (status, value) => json(res, status, value);
    let role, mutation = false, operationId, receiptQuery = false, resumeRequest = false;
    try {
      ensure(url?.pathname?.startsWith(`${PREFIX}/`), 'MEMORY_ROUTE_INVALID');
      const peer = req.socket?.remoteAddress || '';
      ensure(!disposed && isLoopbackReq(req) && (/^(?:127\.|::ffff:127\.)/.test(peer) || peer === '::1'), 'MEMORY_AUTH_REQUIRED');
      const host = String(req.headers?.host || ''), origin = req.headers?.origin;
      ensure(!origin || origin === `${req.socket?.encrypted === true ? 'https' : 'http'}://${host}`, 'MEMORY_ORIGIN_REJECTED');
      const authorization = getAuthorization(req);
      if (authorization?.then) { Promise.resolve(authorization).catch(() => {}); throw failure('MEMORY_ADMIN_REQUIRED'); }
      ensure(authorization !== null && authorization !== undefined && typeof authorization !== 'boolean', 'MEMORY_ADMIN_REQUIRED');
      role = native();
      const route = url.pathname.slice(PREFIX.length), allowedQuery = route === '/search' ? ['q', 'limit'] : route === '/receipt' ? ['operationId'] : route === '/status' ? ['channel'] : [];
      ensure([...url.searchParams.keys()].every(key => allowedQuery.includes(key)) && [...url.searchParams.keys()].every(key => url.searchParams.getAll(key).length === 1), 'MEMORY_FIELD_FORBIDDEN');
      ensure(!url.searchParams.has('channel') || url.searchParams.get('channel') === 'qq', 'MEMORY_REQUEST_INVALID');
      ensure(req.method === 'GET' && ['/status', '/search', '/receipt', '/panel-client', '/qq-access-client'].includes(route) || req.method === 'POST' && ['/manage', '/admin-resume'].includes(route), 'MEMORY_ROUTE_INVALID');
      let body;
      if (req.method === 'POST') {
        ensure(/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || ''), 'MEMORY_JSON_REQUIRED');
        body = await wait(role, readJson(req));
        resumeRequest = route === '/admin-resume'; if (resumeRequest && stable(body?.operationId)) operationId = body.operationId;
        if (resumeRequest) resumeBody(body); else bodyShape(body);
        ensure(body.characterId === role.id && body.characterEpoch === role.epoch, 'CHARACTER_EPOCH_STALE');
        operationId = body.operationId;
      }
      if (route === '/receipt') { operationId = url.searchParams.get('operationId'); ensure(stable(operationId), 'MEMORY_REQUEST_INVALID'); receiptQuery = true; }
      const ctx = await capture(role, authorization);
      if (route === '/panel-client' || route === '/qq-access-client') {
        const module = await wait(role, fs.promises.readFile(new URL(route === '/panel-client' ? './memory-v2-panel.mjs' : './qq-access-panel.mjs', import.meta.url), 'utf8'));
        guard(role); res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(module); return;
      }
      if (route === '/manage' || resumeRequest) {
        mutation = resumeRequest ? body.preview !== true : !body.payload.preview && !Object.hasOwn(PREVIEWS, body.action);
        const result = resumeRequest ? await resumeAdmin(role, ctx, body) : await management(role, ctx, body);
        try { guard(role); }
        catch (error) {
          if (!mutation) throw error;
          send(200, { ...failure(safeCode(error?.code)), ...phases(result), ok: false, operationId: body.operationId, operationState: result.ok === true || result.operationState === 'completed_before_cancel' ? 'completed_before_cancel' : 'unknown', retry: 'query_receipt' }); return;
        }
        send(200, result); return;
      }
      let result;
      if (route === '/status') { const snap = await snapshot(role, ctx, url.searchParams.get('channel')); result = status(role, snap.core, snap.runtime); }
      if (route === '/receipt') {
        const id = url.searchParams.get('operationId'); ensure(stable(id), 'MEMORY_REQUEST_INVALID'); operationId = id; receiptQuery = true;
        let receipt = await query(role, ctx, id);
        if (notStarted(receipt)) for (const runner of [organizer, migrator, identityManager, corrector, hotManager].filter(capable)) { const optional = await wait(role, runner.receipt({ context: ctx, operationId: id })); if (!notStarted(optional)) { receipt = optional; break; } }
        result = receiptResult(receipt, id, true);
      }
      if (route === '/search') {
        ensure(typeof inspectMemory === 'function', 'MEMORY_INSPECTION_UNAVAILABLE', '等待 Host 提供当前角色的真实管理员检查接口。');
        const query = url.searchParams.get('q') || '', limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
        ensure(query.length <= 1000 && Number.isInteger(limit) && limit > 0 && limit <= 20, 'MEMORY_QUERY_INVALID');
        const found = checked(await wait(role, inspectMemory({ context: ctx, query, limit })));
        const records = list(found.records).slice(0, limit);
        ensure(records.every(row => plain(row) && stable(row.id) && Number.isSafeInteger(row.revision) && row.revision > 0 && (row.characterId === undefined || row.characterId === role.id)), 'MEMORY_INSPECTION_SCOPE_INVALID');
        result = { ok: true, records: records.map(row => ({ id: row.id, revision: row.revision, ...Object.fromEntries(['kind', 'content', 'certainty', 'status', 'validFrom', 'validTo', 'recordedAt'].filter(key => text(row[key])).map(key => [key, row[key]])), ...(Array.isArray(row.roots) && row.roots.every(stable) ? { roots: row.roots.slice(0, 100) } : {}) })) };
      }
      guard(role); send(200, result);
    } catch (error) {
      send(400, { ...failure(safeCode(error?.code)), ...phases(error), ok: false, ...(operationId && (mutation || receiptQuery || resumeRequest) ? { operationId } : {}), ...(receiptQuery || resumeRequest && (unknown(error) || error?.code === 'CHARACTER_EPOCH_STALE' || /^MEMORY_(?:WORKER_|CONTROL_BLOCKED|BACKEND_|CONTEXT_UNTRUSTED)/.test(error?.code)) ? { operationState: 'unknown', retry: 'query_receipt', hint: '保留原操作编号，只核对回执；跨角色请切回原角色，控制连接不可用时重启 Host 后再核对，不要重发。' } : {}) });
    }
  }
  return Object.freeze({ handle, dispose() { disposed = true; previews.clear(); planning.clear(); for (const id of resumePreviews.keys()) dropResume(id); } });
}
