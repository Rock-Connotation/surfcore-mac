import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const error = (code, message, hint) => Object.assign(new Error(message), { code, hint });
const unavailable = () => error('VOICE_VOLC_BUDGET_UNAVAILABLE', '火山语音额度账本不可用。', '停止重试，检查语音账本及锁文件；不要删除账本后重试。');
const limited = () => error('VOICE_VOLC_BUDGET_EXHAUSTED', '火山语音合成额度已达到上限。', '等待频率窗口结束或核对本月额度后再手动重试。');
const cap = (value, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(max, Math.floor(Number(value))) : max;
export const effectiveVolcMonthLimit = value => cap(value, 100000);
const changed = () => error('VOICE_TTS_CONFIG_CHANGED', '语音服务配置已变更，已停止合成。', '确认当前语音服务；若QQ桥接仍使用旧配置，请重启桥接后重试。');
export function voiceSelectionRevision(tts) {
  const revision = tts?.selectionRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw changed();
  return revision;
}
export function advanceVoiceSelectionRevision(tts, previous) {
  const fields = value => [value?.enabled === true, value?.route === 'cloud' ? 'cloud' : 'local',
    value?.cloudProvider === 'volc' ? 'volc' : 'voxd', value?.volcKeyId ?? ''];
  const revision = voiceSelectionRevision(previous);
  if (JSON.stringify(fields(tts)) === JSON.stringify(fields(previous))) return;
  if (revision === Number.MAX_SAFE_INTEGER) throw changed();
  tts.selectionRevision = revision + 1;
}

// Provider selection and paid request initiation share one cross-process lock.
export function withVolcBudgetLock(configFile, action) {
  if (!path.isAbsolute(configFile || '')) throw unavailable();
  const state = path.join(path.dirname(configFile), 'state');
  const lock = path.join(state, 'volc-voice-budget.lock');
  let owned = false;
  try {
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(state);
    if (!st.isDirectory() || st.isSymbolicLink()) throw unavailable();
    try { fs.mkdirSync(lock, { mode: 0o700 }); owned = true; }
    catch (e) { if (e.code === 'EEXIST') throw error('VOICE_VOLC_BUDGET_BUSY', '火山语音额度正在处理。', '等待当前操作结束后手动重试；若持续失败，检查账本锁。'); throw e; }
  } catch (e) {
    if (typeof e?.code === 'string' && e.code.startsWith('VOICE_')) throw e;
    throw unavailable();
  }
  try { return action(state); }
  finally { if (owned) { try { fs.rmdirSync(lock); } catch {} } }
}

// Legacy cloud requests use the same selection lock without touching the paid ledger.
export function startVoxdCloud(configFile, expected, startRequest) {
  return withVolcBudgetLock(configFile, () => {
    let tts;
    try {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
      const fd = fs.openSync(configFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (fs.fstatSync(fd).size > 4 * 1024 * 1024) throw changed();
        const config = JSON.parse(fs.readFileSync(fd, 'utf8').replace(/^﻿/, ''));
        if (!config || Array.isArray(config) || typeof config !== 'object') throw changed();
        tts = config.socialV2?.voice?.tts || {};
      } finally { fs.closeSync(fd); }
    } catch { throw changed(); }
    const endpoint = String(tts.endpoints?.cloud || 'http://127.0.0.1:8767').replace(/\/+$/, '');
    if ((tts.enabled === true) !== (expected.enabled ?? true) || (tts.route === 'cloud' ? 'cloud' : 'local') !== expected.route ||
        (tts.cloudProvider === 'volc' ? 'volc' : 'voxd') !== 'voxd' || endpoint !== expected.endpoint ||
        (expected.baseUrl !== undefined && String(tts.baseUrl || '').replace(/\/+$/, '') !== expected.baseUrl) ||
        voiceSelectionRevision(tts) !== expected.selectionRevision) throw changed();
    return startRequest();
  });
}

// All processes reserve before network I/O. A crashed lock fails closed until inspected.
export function reserveVolcBudget({ configFile, text, maxPerMinute, maxPerHour, monthlyQuota, now = Date.now(), requireSelection = false, keyId, selectionRevision = 0, startRequest } = {}) {
  if (!path.isAbsolute(configFile || '') || typeof text !== 'string' || !text.length || text.length > 120 || !Number.isSafeInteger(now) || now < 0 || !fs.constants.O_NOFOLLOW) throw unavailable();
  return withVolcBudgetLock(configFile, state => {
    const ledger = path.join(state, 'volc-voice-budget.json');
    let temp = '';
    try {
    const configFd = fs.openSync(configFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let config;
    try {
      const configStat = fs.fstatSync(configFd);
      if (!configStat.isFile() || configStat.size > 4 * 1024 * 1024) throw unavailable();
      config = JSON.parse(fs.readFileSync(configFd, 'utf8').replace(/^﻿/, ''));
      if (!config || Array.isArray(config) || typeof config !== 'object') throw unavailable();
    } finally { fs.closeSync(configFd); }
    const voice = config.socialV2?.voice || {};
    if (requireSelection && (voice.tts?.enabled !== true || voice.tts?.route !== 'cloud' || voice.tts?.cloudProvider !== 'volc' ||
        typeof keyId !== 'string' || !keyId || voice.tts?.volcKeyId !== keyId ||
        voiceSelectionRevision(voice.tts) !== selectionRevision))
      throw error('VOICE_VOLC_CONFIG_CHANGED', '火山语音配置已变更，已停止合成。', '确认所选语音服务，重启QQ桥接后再试。');
    let data;
    try {
      const fd = fs.openSync(ledger, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077)) throw unavailable();
        data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } finally { fs.closeSync(fd); }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      data = { version: 1, month: new Date(now).toISOString().slice(0, 7), chars: 0, lastAt: 0, events: [] };
    }
    if (!data || data.version !== 1 || !/^\d{4}-\d{2}$/.test(data.month) || !Number.isSafeInteger(data.chars) || data.chars < 0 ||
        !Number.isSafeInteger(data.lastAt) || data.lastAt < 0 || data.lastAt > now || !Array.isArray(data.events) || data.events.length > 100 ||
        data.events.some(t => !Number.isSafeInteger(t) || t < 0 || t > now)) throw unavailable();
    const month = new Date(now).toISOString().slice(0, 7);
    if (month < data.month) throw unavailable();
    const chars = month === data.month ? data.chars : 0;
    const events = data.events.filter(t => now - t < 3600000);
    if (events.filter(t => now - t < 60000).length >= Math.min(cap(maxPerMinute, 2), cap(voice.maxPerMinute, 2)) ||
        events.length >= Math.min(cap(maxPerHour, 10), cap(voice.maxPerHour, 10)) ||
        chars + text.length > Math.min(effectiveVolcMonthLimit(monthlyQuota), effectiveVolcMonthLimit(voice.cloud?.monthlyQuota), effectiveVolcMonthLimit(voice.tts?.volcMonthlyQuota))) throw limited();
    const next = { version: 1, month, chars: chars + text.length, lastAt: now, events: [...events, now] };
    temp = path.join(state, `.volc-budget-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, ledger); temp = '';
    const dir = fs.openSync(state, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return startRequest ? startRequest() : undefined;
    } catch (e) {
      if (typeof e?.code === 'string' && (e.code.startsWith('VOICE_VOLC_') || e.code.startsWith('VOICE_TTS_'))) throw e;
      throw unavailable();
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
    }
  });
}
