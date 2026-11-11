import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function issue(code, message, hint) {
  return Object.assign(new Error(message), { code, hint });
}
function check(condition, code, message, hint) {
  if (!condition) throw issue(code, message, hint);
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function roleKey(id) { return JSON.stringify(String(id)); }
function emptyLedger() { return { version: 1, acceptanceCalls: 0, roles: {}, jobs: {} }; }
function onlyKeys(value, allowed) { return isRecord(value) && Object.keys(value).every(key => allowed.includes(key)); }
function storedText(value, max, optional = false) {
  if (optional && value == null) return true;
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    !/(?:https?:\/\/|www\.)\S+/i.test(value) && !/data:[^\s;,]+;base64,|\b[A-Za-z0-9+/]{160,}={0,2}\b/i.test(value) &&
    !/\b(?:bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session|password|secret|sessdata|cookie|authorization)\s*[:=]\s*\S+)|eyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{16,}/i.test(value);
}
function validIso(value, optional = false) { return (optional && value == null) || (typeof value === 'string' && value.length <= 40 && !Number.isNaN(new Date(value).getTime())); }
function validFailure(value, optional = false) {
  return (optional && value == null) || (onlyKeys(value, ['code', 'error', 'hint']) && /^(?:DOUYIN|MEMORY|MODEL|COMPANION|CHARACTER|BUDGET)_[A-Z0-9_]{1,72}$/.test(value.code) && storedText(value.error, 240) && storedText(value.hint, 300));
}
function validSourceUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    url.search = ''; url.hash = '';
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (host === 'douyin.com' || host.endsWith('.douyin.com')) && url.toString() === value;
  } catch { return false; }
}
function validCoverage(value) {
  return onlyKeys(value, ['status', 'transcriptComplete', 'missingRanges', 'visualCoverage', 'frameSamples', 'warningCount', 'acceptanceQualified']) &&
    value.status === 'partial' && typeof value.transcriptComplete === 'boolean' && Number.isSafeInteger(value.missingRanges) && value.missingRanges >= 0 &&
    ['sparse', 'none'].includes(value.visualCoverage) && Number.isSafeInteger(value.frameSamples) && value.frameSamples >= 0 && value.frameSamples <= 3 &&
    Number.isSafeInteger(value.warningCount) && value.warningCount >= 0 && value.warningCount <= 100 && typeof value.acceptanceQualified === 'boolean';
}
const provenanceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/.test(value);
function validRefs(refs, cap) {
  return Array.isArray(refs) && refs.length <= cap && refs.every(ref => onlyKeys(ref, ['type', 'id', 'revision', 'payloadDigest']) &&
    ['event', 'memory'].includes(ref.type) && provenanceId(ref.id) && Number.isSafeInteger(ref.revision) && ref.revision >= 1 && /^[a-f0-9]{64}$/.test(ref.payloadDigest));
}
function validReceipt(receipt) {
  return onlyKeys(receipt, ['phase', 'ok', 'operationId', 'acceptance', 'sourceState', 'selectionState', 'indexState', 'operationState', 'retry', 'commitSequence', 'eventIds', 'eventRefs', 'nextOffset']) &&
    ['source', 'model-input', 'reflection'].includes(receipt.phase) && receipt.ok === true && provenanceId(receipt.operationId) && receipt.acceptance === 'volatile' &&
    receipt.sourceState === 'committed' && receipt.selectionState === 'not_selected' && receipt.indexState === 'ready' && receipt.operationState === 'completed' && receipt.retry === 'none' &&
    Number.isSafeInteger(receipt.commitSequence) && receipt.commitSequence >= 1 && (receipt.nextOffset === null || (Number.isSafeInteger(receipt.nextOffset) && receipt.nextOffset >= 0)) &&
    Array.isArray(receipt.eventIds) && receipt.eventIds.length >= 1 && receipt.eventIds.length <= 32 && receipt.eventIds.every(provenanceId) && new Set(receipt.eventIds).size === receipt.eventIds.length &&
    validRefs(receipt.eventRefs, 32) && receipt.eventRefs.length === receipt.eventIds.length && new Set(receipt.eventRefs.map(ref => ref.id)).size === receipt.eventRefs.length &&
    receipt.eventRefs.every(ref => ref.type === 'event' && ref.revision === 1 && receipt.eventIds.includes(ref.id));
}
function validProvenance(value, refsCap, receiptsCap) {
  if (value.memoryV2Refs === undefined && value.memoryV2Receipts === undefined && value.memoryV2Receipt === undefined) return true;
  const refs = value.memoryV2Refs, receipts = value.memoryV2Receipts;
  return validRefs(refs, refsCap) && refs.length > 0 && Array.isArray(receipts) && receipts.length > 0 && receipts.length <= receiptsCap && receipts.every(validReceipt) &&
    receipts.every(receipt => receipt.eventRefs.every(ref => refs.some(actual => actual.type === ref.type && actual.id === ref.id && actual.revision === ref.revision && actual.payloadDigest === ref.payloadDigest))) &&
    (value.memoryV2Receipt === undefined || (validReceipt(value.memoryV2Receipt) && JSON.stringify(value.memoryV2Receipt) === JSON.stringify(receipts.at(-1))));
}
function validateLedger(value) {
  check(onlyKeys(value, ['version', 'acceptanceCalls', 'roles', 'jobs']) && value.version === 1 && Number.isSafeInteger(value.acceptanceCalls) && value.acceptanceCalls >= 0 && value.acceptanceCalls <= 12 && isRecord(value.roles) && isRecord(value.jobs), 'DOUYIN_STATE_INVALID', '陪伴账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试。');
  for (const [key, role] of Object.entries(value.roles)) {
    check(onlyKeys(role, ['characterId', 'acceptedEpoch', 'enabled', 'paused', 'lastError', 'days']) && key === roleKey(role.characterId) && storedText(role.characterId, 160) &&
      (role.acceptedEpoch === null || (Number.isSafeInteger(role.acceptedEpoch) && role.acceptedEpoch >= 0)) && typeof role.enabled === 'boolean' && typeof role.paused === 'boolean' && validFailure(role.lastError, true) && isRecord(role.days),
    'DOUYIN_STATE_INVALID', '陪伴角色账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试.');
    for (const [date, day] of Object.entries(role.days)) {
      check(/^\d{4}-\d{2}-\d{2}$/.test(date) && onlyKeys(day, ['calls', 'rounds', 'windows']) && Number.isSafeInteger(day.calls) && day.calls >= 0 && day.calls <= 8 && Number.isSafeInteger(day.rounds) && day.rounds >= 0 && day.rounds <= 2 && isRecord(day.windows), 'DOUYIN_STATE_INVALID', '陪伴日常额度账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试。');
      for (const [window, entry] of Object.entries(day.windows)) check(['12:30', '20:30'].includes(window) && onlyKeys(entry, ['state', 'jobId', 'startedAt', 'completedAt', 'error']) && ['running', 'completed', 'failed'].includes(entry.state) && /^douyin-[0-9a-f-]{36}$/.test(entry.jobId) && validIso(entry.startedAt) && validIso(entry.completedAt, true) && validFailure(entry.error, true), 'DOUYIN_STATE_INVALID', '陪伴窗口账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试。');
    }
  }
  for (const [id, job] of Object.entries(value.jobs)) {
    check(onlyKeys(job, ['jobId', 'mode', 'state', 'phase', 'characterId', 'characterEpoch', 'createdAt', 'updatedAt', 'completedAt', 'calls', 'acceptanceQualified', 'scheduleDate', 'scheduleWindow', 'items', 'code', 'error', 'hint', 'memoryV2Refs', 'memoryV2Receipts', 'memoryV2Receipt']) &&
      validProvenance(job, 64, 12) && job.jobId === id && /^douyin-[0-9a-f-]{36}$/.test(id) && ['acceptance', 'daily'].includes(job.mode) && ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(job.state) &&
      ['queued', 'readiness', 'feed', 'context', 'perceive', 'model', 'memory', 'finished', 'failed', 'cancelled', 'interrupted'].includes(job.phase) && storedText(job.characterId, 160) && Number.isSafeInteger(job.characterEpoch) && job.characterEpoch >= 0 &&
      validIso(job.createdAt) && validIso(job.updatedAt) && validIso(job.completedAt, true) && Number.isSafeInteger(job.calls) && job.calls >= 0 && job.calls <= 4 && typeof job.acceptanceQualified === 'boolean' &&
      (job.scheduleDate === null || /^\d{4}-\d{2}-\d{2}$/.test(job.scheduleDate)) && (job.scheduleWindow === null || ['12:30', '20:30'].includes(job.scheduleWindow)) && Array.isArray(job.items) && job.items.length <= 2 &&
      (job.code == null || /^(?:DOUYIN|MEMORY|MODEL|COMPANION|CHARACTER|BUDGET)_[A-Z0-9_]{1,72}$/.test(job.code)) && storedText(job.error, 240, true) && storedText(job.hint, 300, true),
    'DOUYIN_STATE_INVALID', '陪伴作业账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试.');
    for (const item of job.items) check(onlyKeys(item, ['id', 'url', 'title', 'durationMs', 'occurredAt', 'state', 'memorySaved', 'partial', 'coverage', 'feeling', 'reason', 'summary', 'draft', 'code', 'error', 'hint', 'memoryV2Refs', 'memoryV2Receipts', 'memoryV2Receipt']) &&
      validProvenance(item, 32, 6) && storedText(item.id, 160) && validSourceUrl(item.url) && storedText(item.title, 240) && Number.isSafeInteger(item.durationMs) && item.durationMs > 0 && item.durationMs <= 120_000 && validIso(item.occurredAt, true) &&
      ['skipped', 'partial', 'completed'].includes(item.state) && typeof item.memorySaved === 'boolean' && typeof item.partial === 'boolean' && validCoverage(item.coverage) &&
      (item.feeling == null || ['like', 'mixed', 'neutral', 'dislike'].includes(item.feeling)) && storedText(item.reason, 240, true) && storedText(item.summary, 500, true) && storedText(item.draft, 300, true) &&
      (item.code == null || /^(?:DOUYIN|MEMORY|MODEL|COMPANION|CHARACTER|BUDGET)_[A-Z0-9_]{1,72}$/.test(item.code)) && storedText(item.error, 240, true) && storedText(item.hint, 300, true),
    'DOUYIN_STATE_INVALID', '陪伴结果账本格式无法识别，未重置数据。', '保留账本原件并检查本机状态目录后再试.');
  }
  return value;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function createDouyinCompanionStore(stateDir, nowIso) {
  const root = path.join(stateDir, 'douyin-companion');
  const ledgerFile = path.join(root, 'ledger.json');
  const lockFile = path.join(root, 'engine.lock');
  let lockFd = null;
  let lockOwner = '';
  let localLedger = null;
  function ensureRoot() { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  function readLedger() {
    if (lockFd !== null && localLedger) return localLedger;
    try { return validateLedger(JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))); }
    catch (error) {
      if (error?.code === 'ENOENT') return emptyLedger();
      if (error?.code === 'DOUYIN_STATE_INVALID') throw error;
      throw issue('DOUYIN_STATE_UNAVAILABLE', '无法读取陪伴全局账本，未重置数据。', '检查本机状态目录权限和账本格式；保留原文件后再试。');
    }
  }
  function writeLedger(ledger) {
    validateLedger(ledger);
    ensureRoot();
    const temp = `${ledgerFile}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(ledger)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, ledgerFile);
      try { const dirFd = fs.openSync(root, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch {}
      localLedger = ledger;
    } catch {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temp); } catch {}
      throw issue('DOUYIN_STATE_WRITE_FAILED', '无法原子保存陪伴账本，未发起新模型请求。', '检查本机状态目录权限和可用空间；保留账本原件后再试。');
    }
  }
  function busyProblem() {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.owner !== 'string' || !lock.owner) return issue('DOUYIN_LOCK_INVALID', '陪伴实例锁格式无效，已停止启动。', '保留锁文件和账本，确认没有运行中的陪伴实例后再手动隔离失效锁。');
      if (!processAlive(lock.pid)) return issue('DOUYIN_LOCK_STALE', '发现未确认的旧陪伴实例锁，已停止启动。', '核对锁记录的进程已退出且没有其他实例运行，再保留证据并手动隔离旧锁。');
      return issue('DOUYIN_COMPANION_BUSY', '另一个陪伴实例正在持有全局账本锁。', '在该实例查看作业状态；不要删除锁文件或重复启动。');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return issue('DOUYIN_LOCK_INVALID', '无法读取陪伴实例锁，已停止启动。', '检查本机状态目录权限并保留锁文件；确认无运行实例后再处理。');
    }
  }
  function acquireLock() {
    if (lockFd !== null) return;
    ensureRoot();
    const owner = `${process.pid}:${crypto.randomUUID()}`;
    let fd;
    try { fd = fs.openSync(lockFile, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw busyProblem() ?? issue('DOUYIN_COMPANION_BUSY', '陪伴账本正被另一个实例使用。', '在该实例查看状态后再试。');
      throw issue('DOUYIN_LOCK_UNAVAILABLE', '无法取得陪伴实例锁，已停止启动。', '检查本机状态目录权限后再试。');
    }
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, owner, createdAt: nowIso() })}\n`, 'utf8');
      fs.fsyncSync(fd);
      lockFd = fd;
      lockOwner = owner;
      localLedger = null;
    } catch {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
      throw issue('DOUYIN_LOCK_WRITE_FAILED', '无法记录陪伴实例锁，已停止启动。', '检查本机状态目录权限后再试。');
    }
  }
  function releaseLock() {
    if (lockFd === null) return;
    const fd = lockFd, owner = lockOwner;
    lockFd = null; lockOwner = '';
    try { fs.closeSync(fd); } catch {}
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock.owner === owner && lock.pid === process.pid) fs.unlinkSync(lockFile);
    } catch {}
    localLedger = null;
  }
  function lockOwnerActive() {
    if (lockFd !== null) return true;
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      return Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.owner === 'string' && processAlive(lock.pid);
    } catch (error) { return error?.code === 'ENOENT' ? false : null; }
  }
  function lockIdentity() {
    if (lockFd !== null) return { pid: process.pid, owner: lockOwner, active: true };
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.owner !== 'string' || !/^\d+:[0-9a-f-]{36}$/.test(lock.owner)) return null;
      return { pid: lock.pid, owner: lock.owner, active: processAlive(lock.pid) };
    } catch { return null; }
  }
  return { readLedger, writeLedger, acquireLock, releaseLock, get locked() { return lockFd !== null; }, get lockOwnerActive() { return lockOwnerActive(); }, get lockIdentity() { return lockIdentity(); } };
}
