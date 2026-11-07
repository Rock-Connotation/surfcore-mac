import fs from 'node:fs';
import path from 'node:path';
import { characterPaths, isValidCharacterId, readCurrentCharacter } from '../character-persona.js';
import { normalizePurposeState, summarizePurposeState } from '../purpose-engine.js';

export const LIFE_STATE_VERSION = 1;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function uniqueItems(values, maxItems = 100, maxText = 240) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = typeof value === 'string'
      ? { text: text(value, maxText) }
      : { ...asObject(value), text: text(value?.text ?? value?.title ?? value?.intent, maxText) };
    if (!item.text || seen.has(item.text)) continue;
    seen.add(item.text);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

export function createEmptyLifeState(characterId, now = Date.now()) {
  return {
    version: LIFE_STATE_VERSION,
    characterId: String(characterId ?? ''),
    updatedAt: new Date(now).toISOString(),
    currentFocus: '',
    unresolved: [],
    goals: [],
    activities: [],
    lastActivityAt: '',
    nextActivityAt: '',
  };
}

export function normalizeLifeState(raw, characterId, now = Date.now()) {
  const input = asObject(raw);
  return {
    ...createEmptyLifeState(characterId, now),
    ...input,
    version: LIFE_STATE_VERSION,
    characterId: String(characterId ?? input.characterId ?? ''),
    updatedAt: text(input.updatedAt, 40) || new Date(now).toISOString(),
    currentFocus: text(input.currentFocus, 240),
    unresolved: uniqueItems(input.unresolved, 100),
    goals: uniqueItems(input.goals, 100),
    activities: (Array.isArray(input.activities) ? input.activities : [])
      .filter((item) => item && typeof item === 'object')
      .slice(-200)
      .map((item) => ({
        activityId: text(item.activityId, 128),
        characterEpoch: Number.isInteger(Number(item.characterEpoch)) ? Math.max(0, Number(item.characterEpoch)) : 0,
        kind: text(item.kind, 64),
        status: text(item.status, 32),
        source: text(item.source, 64),
        resultRef: text(item.resultRef, 240),
        updatedAt: text(item.updatedAt, 40),
      }))
      .filter((item) => item.activityId),
    lastActivityAt: text(input.lastActivityAt, 40),
    nextActivityAt: text(input.nextActivityAt, 40),
  };
}

function resolveCharacter(target = {}) {
  const current = readCurrentCharacter();
  const id = String(target.characterId ?? target.id ?? current?.id ?? '');
  if (!isValidCharacterId(id)) return null;
  const epochValue = target.characterEpoch ?? target.epoch ?? (current?.id === id ? current.epoch : 0);
  const epoch = Number(epochValue);
  return { id, epoch: Number.isInteger(epoch) && epoch >= 0 ? epoch : 0, paths: characterPaths(id) };
}

export function readCharacterLifeState(target = {}, { now = Date.now() } = {}) {
  const role = resolveCharacter(target);
  if (!role) return { ok: false, code: 'LIFE_CHARACTER_REQUIRED', error: '角色生活状态缺少 characterId。', hint: '先读取当前角色，再读取其 life/state.json。', state: null };
  try {
    const state = JSON.parse(fs.readFileSync(role.paths.lifeState, 'utf8'));
    if (state?.version !== undefined && state.version !== LIFE_STATE_VERSION) return { ok: false, code: 'LIFE_VERSION_UNSUPPORTED', error: '生活状态版本不受支持。', hint: '保留原文件，使用支持该版本的程序读取；不要降级覆盖。', state: null };
    if (String(state?.characterId ?? '') !== role.id) {
      return { ok: false, code: 'LIFE_CHARACTER_MISMATCH', error: '生活状态文件属于其他角色。', hint: '恢复正确角色的 life/state.json 后重试。', state: null };
    }
    return { ok: true, state: normalizeLifeState(state, role.id, now), characterEpoch: role.epoch };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, state: createEmptyLifeState(role.id, now), characterEpoch: role.epoch };
    return { ok: false, code: 'LIFE_STATE_READ_FAILED', error: '角色生活状态读取失败。', hint: '保留原文件并检查 JSON 格式与读权限。', state: null };
  }
}

export function saveCharacterLifeState(target, raw, { now = Date.now() } = {}) {
  const role = resolveCharacter(target ?? {});
  if (!role) return { ok: false, code: 'LIFE_CHARACTER_REQUIRED', error: '角色生活状态缺少 characterId。', hint: '先捕获 characterId 和 characterEpoch，再保存状态。' };
  if (raw?.version !== undefined && raw.version !== LIFE_STATE_VERSION) return { ok: false, code: 'LIFE_VERSION_UNSUPPORTED', error: '生活状态版本不受支持。', hint: '保留原文件，使用支持该版本的程序保存。' };
  if (fs.existsSync(role.paths.lifeState)) {
    const existing = readCharacterLifeState(role, { now });
    if (!existing.ok) return existing;
  }
  const state = normalizeLifeState(raw, role.id, now);
  const tmp = `${role.paths.lifeState}.${process.pid}.${now}.tmp`;
  let fd = -1;
  try {
    fs.mkdirSync(role.paths.lifeDir, { recursive: true });
    if (fs.existsSync(role.paths.lifeState)) {
      const backups = path.join(role.paths.lifeDir, '_backups');
      fs.mkdirSync(backups, { recursive: true });
      fs.copyFileSync(role.paths.lifeState, path.join(backups, `state-${now}-${process.pid}-${Math.random().toString(16).slice(2)}.json`), fs.constants.COPYFILE_EXCL);
    }
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, role.paths.lifeState);
    return { ok: true, state, characterId: role.id, characterEpoch: role.epoch };
  } catch {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, code: 'LIFE_STATE_WRITE_FAILED', error: '角色生活状态未能保存。', hint: '检查角色 life 目录的磁盘空间和写入权限后重试。' };
  }
}

export function recordLifeActivity(target, activity, { now = Date.now() } = {}) {
  const role = resolveCharacter(target ?? {});
  if (!role) return { ok: false, code: 'LIFE_CHARACTER_REQUIRED', error: '活动缺少 characterId。', hint: '提交任务前捕获当前角色身份。' };
  const activityId = text(activity?.activityId, 128);
  if (!activityId) return { ok: false, code: 'LIFE_ACTIVITY_ID_REQUIRED', error: '活动缺少 activityId。', hint: '为活动生成稳定 ID 后重试。' };
  const loaded = readCharacterLifeState(role, { now });
  if (!loaded.ok) return loaded;
  const at = new Date(now).toISOString();
  const activities = loaded.state.activities.filter((item) => item.activityId !== activityId);
  activities.push({
    activityId,
    characterEpoch: role.epoch,
    kind: text(activity?.kind, 64),
    status: text(activity?.status, 32) || 'queued',
    source: text(activity?.source, 64),
    resultRef: text(activity?.resultRef, 240),
    updatedAt: at,
  });
  const state = normalizeLifeState({
    ...loaded.state,
    activities: activities.slice(-200),
    lastActivityAt: at,
    updatedAt: at,
  }, role.id, now);
  return saveCharacterLifeState(role, state, { now });
}

export function lifeContextText(state, maxChars = 600) {
  const value = normalizeLifeState(state, state?.characterId ?? '', Date.now());
  const lines = [];
  if (value.currentFocus) lines.push(`当前关注：${value.currentFocus}`);
  for (const item of value.unresolved.slice(0, 4)) lines.push(`待继续：${item.text}`);
  for (const item of value.goals.slice(0, 4)) lines.push(`目标：${item.text}`);
  const limit = Math.max(0, Math.round(Number(maxChars) || 0));
  const joined = lines.join('\n');
  return limit > 0 ? joined.slice(0, limit) : '';
}

/** Select a local maintenance activity when no channel is available; never dispatch external actions. */
export function coordinateCharacterLife(target, { channels = {}, now = Date.now() } = {}) {
  const role = resolveCharacter(target ?? {});
  if (!role || role.epoch < 1) return { ok: false, code: 'LIFE_CHARACTER_REQUIRED', error: '生活协调缺少角色及 epoch。', hint: '重新捕获角色身份后再整理。' };
  const loaded = readCharacterLifeState(role, { now });
  if (!loaded.ok) return loaded;
  let purpose = null;
  try { purpose = summarizePurposeState(normalizePurposeState(JSON.parse(fs.readFileSync(role.paths.purposeState, 'utf8')), now)); }
  catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, code: 'LIFE_PURPOSE_READ_FAILED', error: '目的状态读取失败。', hint: '保留原文件并检查格式和读取权限后重试。' };
  }
  const available = Object.entries(channels).filter(([, enabled]) => enabled === true).map(([name]) => name);
  const activityId = `local-maintenance:${Math.floor(now / 3600000)}`;
  const existing = loaded.state.activities.find((item) => item.activityId === activityId && item.characterEpoch === role.epoch);
  if (existing) return { ok: true, activity: existing, availableChannels: available, purpose };
  const result = recordLifeActivity(role, { activityId, kind: 'local-maintenance', status: 'completed', source: 'core' }, { now });
  return result.ok ? { ...result, activity: result.state.activities.at(-1), availableChannels: available, purpose } : result;
}
