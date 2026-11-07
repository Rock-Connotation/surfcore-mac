import fs from 'node:fs';
import path from 'node:path';
import { isValidCharacterId } from '../character-persona.js';

const CHANNEL_RE = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const LEGACY_SCOPES = new Set(['qq', 'bili', 'shared', 'pet']);
const VISIBILITY = new Set(['public', 'private', 'restricted']);
const SUBJECTS = new Set(['self', 'user', 'external']);
const CERTAINTIES = new Set(['observed', 'reported', 'inferred']);

function short(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function isoTime(value) {
  const n = Date.parse(String(value ?? ''));
  return Number.isFinite(n) ? new Date(n).toISOString() : '';
}

function scopedContexts(source, visibility) {
  if (Array.isArray(visibility.allowedContexts)) {
    return [...new Set(visibility.allowedContexts.map((value) => short(value, 100)).filter(Boolean))].slice(0, 32);
  }
  if (visibility.classification === 'restricted') return [];
  if (visibility.legacyScope === 'shared') return ['qq', 'bili', 'pet', 'local'];
  if (source.channel === 'qq' && /^\w+:\d+$/.test(String(source.conversationId ?? ''))) {
    return [`qq:${source.conversationId}`];
  }
  if (visibility.classification === 'private') {
    if (source.channel === 'pet' || source.channel === 'local') return [source.channel];
    return [];
  }
  if (visibility.legacyScope) return [visibility.legacyScope];
  return [source.channel];
}

function normalizeSource(raw = {}) {
  const channel = String(raw.channel ?? '').trim().toLowerCase();
  if (!CHANNEL_RE.test(channel)) return null;
  return {
    channel,
    accountId: short(raw.accountId, 128),
    objectId: short(raw.objectId, 256),
    conversationId: short(raw.conversationId, 128),
  };
}

function normalizeVisibility(raw = {}, source) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const classification = String(raw.classification ?? 'restricted').trim().toLowerCase();
  const legacyScope = String(raw.legacyScope ?? '').trim().toLowerCase();
  if (!VISIBILITY.has(classification)) return null;
  if (legacyScope && !LEGACY_SCOPES.has(legacyScope)) return null;
  const allowedContexts = scopedContexts(source, { ...raw, classification, legacyScope });
  if (allowedContexts.some((value) => !/^(?:bili|pet|local|douyin|qq|qq:(?:group|private):\d+)$/.test(value))) return null;
  if (classification !== 'restricted' && !allowedContexts.length) return null;
  if (classification === 'private') {
    const safe = source.channel === 'pet'
      ? allowedContexts.every((item) => item === 'pet')
      : source.channel === 'local'
        ? allowedContexts.every((item) => item === 'local')
        : source.channel === 'qq'
          ? allowedContexts.length > 0 && allowedContexts.every((item) => /^qq:private:\d+$/.test(item))
          : false;
    if (!safe || !allowedContexts.length) return null;
  }
  return { classification, allowedContexts, legacyScope };
}

function normalizeEvidenceRef(raw = {}) {
  const item = {};
  const assetId = short(raw.assetId, 128);
  if (assetId) item.assetId = assetId;
  if (raw.sourceUrl) {
    try {
      const url = new URL(String(raw.sourceUrl));
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        // Evidence references never retain query strings, which can carry expiring credentials.
        item.sourceUrl = `${url.origin}${url.pathname}`.slice(0, 500);
      }
    } catch {}
  }
  for (const key of ['startMs', 'endMs']) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < 0) return null;
    item[key] = Math.round(value);
  }
  if (item.startMs !== undefined && item.endMs !== undefined && item.endMs < item.startMs) return null;
  return Object.keys(item).length ? item : null;
}

/** Validate and normalize the versioned event envelope before it reaches persistent storage. */
export function validateExperienceEvent(raw, { characterId = '', characterEpoch = null } = {}) {
  const fail = (code, error, hint) => ({ ok: false, code, error, hint });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('EXPERIENCE_EVENT_INVALID', '经历事件必须是对象。', '检查事件字段后重试。');
  }
  const id = String(raw.eventId ?? '').trim();
  const roleId = String(raw.characterId ?? '').trim();
  const epoch = Number(raw.characterEpoch);
  if (Number(raw.schemaVersion) !== 1 || !EVENT_ID_RE.test(id)) {
    return fail('EXPERIENCE_EVENT_INVALID', '经历事件版本或 eventId 无效。', '使用 schemaVersion=1 和稳定的 eventId 后重试。');
  }
  if (!isValidCharacterId(roleId) || (characterId && roleId !== characterId)) {
    return fail('EXPERIENCE_CHARACTER_MISMATCH', '经历事件角色与目标记忆目录不一致。', '按提交时捕获的 characterId 写入对应角色目录。');
  }
  if (!Number.isInteger(epoch) || epoch < 1 || (characterEpoch !== null && epoch !== Number(characterEpoch))) {
    return fail('EXPERIENCE_EPOCH_INVALID', '经历事件缺少有效的角色 epoch。', '提交任务前同步读取当前角色并保存 characterEpoch。');
  }
  const occurredAt = isoTime(raw.occurredAt);
  const observedAt = isoTime(raw.observedAt);
  if (!occurredAt || !observedAt) {
    return fail('EXPERIENCE_TIME_INVALID', '经历事件时间必须是有效的 ISO 8601 时间。', '填写 occurredAt 和 observedAt 后重试。');
  }
  const source = normalizeSource(raw.source);
  const visibility = source ? normalizeVisibility(raw.visibility, source) : null;
  if (!source || !visibility) {
    return fail('EXPERIENCE_SCOPE_INVALID', '经历事件来源或可见范围无效。', '明确填写来源渠道和允许的读取范围；私密 QQ 事件必须绑定 private 会话。');
  }
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {};
  const summary = short(content.summary, 1200);
  if (!summary) return fail('EXPERIENCE_CONTENT_EMPTY', '经历事件摘要不能为空。', '提供经过筛选的简短摘要后重试。');
  const attribution = raw.attribution && typeof raw.attribution === 'object' ? raw.attribution : {};
  const subject = String(attribution.subject ?? '').trim().toLowerCase();
  const certainty = String(attribution.certainty ?? '').trim().toLowerCase();
  if (!SUBJECTS.has(subject) || !CERTAINTIES.has(certainty)) {
    return fail('EXPERIENCE_ATTRIBUTION_INVALID', '经历事件归属或确定性无效。', '使用 self/user/external 与 observed/reported/inferred。');
  }
  const refs = Array.isArray(raw.evidenceRefs)
    ? raw.evidenceRefs.slice(0, 16).map(normalizeEvidenceRef).filter(Boolean)
    : [];
  const normalizedContent = {
    summary,
    title: short(content.title, 120),
    details: short(content.details, 1200),
    detailsRef: short(content.detailsRef, 300),
    tags: Array.isArray(content.tags) ? [...new Set(content.tags.map((tag) => short(tag, 40)).filter(Boolean))].slice(0, 12) : [],
    score: Number.isFinite(Number(content.score)) ? Math.max(0, Math.min(100, Math.round(Number(content.score)))) : 0,
    favorite: content.favorite === true,
    type: short(content.type, 32),
  };
  return {
    ok: true,
    event: {
      schemaVersion: 1,
      eventId: id,
      characterId: roleId,
      characterEpoch: epoch,
      activityId: short(raw.activityId, 128),
      occurredAt,
      observedAt,
      source,
      kind: short(raw.kind, 64).toLowerCase() || 'reflection',
      visibility,
      content: normalizedContent,
      evidenceRefs: refs,
      attribution: { subject, certainty },
    },
  };
}

/** Append first and fsync the queue before any memory projection is attempted. */
export function appendExperienceEvent(paths, raw) {
  const target = paths?.experienceInbox || (paths?.dir ? path.join(paths.dir, 'experience-inbox.jsonl') : '');
  const checked = validateExperienceEvent(raw, { characterId: String(paths?.id ?? '') });
  if (!checked.ok) return checked;
  if (!target) return { ok: false, code: 'EXPERIENCE_INBOX_PATH_MISSING', error: '经历收件箱路径不可用。', hint: '恢复角色 memory 目录后重试。' };
  let fd = -1;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(target, 'a', 0o600);
    const line = `${JSON.stringify(checked.event)}\n`;
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
    return { ok: true, eventId: checked.event.eventId, path: target };
  } catch {
    return { ok: false, code: 'EXPERIENCE_INBOX_WRITE_FAILED', error: '经历事件未能写入持久收件箱。', hint: '检查角色 memory 目录的磁盘空间和写入权限后重试。' };
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

/** Read only newline-terminated entries after the card's committed byte cursor. */
export function readExperienceInbox(paths, { offset = 0 } = {}) {
  const file = paths?.experienceInbox || (paths?.dir ? path.join(paths.dir, 'experience-inbox.jsonl') : '');
  if (!file) return { ok: false, code: 'EXPERIENCE_INBOX_PATH_MISSING', error: '经历收件箱路径不可用。', hint: '恢复角色 memory 目录后重试。', events: [], nextOffset: Number(offset) || 0, rejected: 0 };
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, events: [], nextOffset: 0, rejected: 0 };
    return { ok: false, code: 'EXPERIENCE_INBOX_READ_FAILED', error: '经历收件箱不可读取。', hint: '保留原文件并检查角色 memory 目录的权限。', events: [], nextOffset: Number(offset) || 0, rejected: 0 };
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  if (start > bytes.length) {
    return { ok: false, code: 'EXPERIENCE_CURSOR_AHEAD', error: '经历游标超出当前文件。', hint: '保留卡与收件箱，恢复相匹配的备份后重新整理。', events: [], nextOffset: start, rejected: 0 };
  }
  const chunk = bytes.subarray(start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { ok: true, events: [], nextOffset: start, rejected: 0 };
  const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
  const events = [];
  let rejected = 0;
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { rejected += 1; continue; }
    const checked = validateExperienceEvent(raw, { characterId: String(paths?.id ?? '') });
    if (checked.ok) events.push(checked.event);
    else rejected += 1;
  }
  if (rejected) return { ok: false, code: 'EXPERIENCE_INBOX_INVALID', error: '经历收件箱包含无效记录。', hint: '保留原收件箱，修复无效记录后重试。', events: [], nextOffset: start, rejected };
  return { ok: true, events, nextOffset: start + lastNewline + 1, rejected };
}
