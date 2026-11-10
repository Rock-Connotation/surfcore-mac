import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withVolcBudgetLock } from './voice-volc-budget.js';

const MISSING = Symbol('missing');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => a === MISSING || b === MISSING ? a === b : JSON.stringify(a) === JSON.stringify(b);
const stale = () => Object.assign(new Error('QQ 配置已被其他操作修改。'), { code: 'CONFIG_STALE', hint: '保留未保存草稿，重新读取配置并处理冲突后再保存。' });
const selectionError = () => Object.assign(new Error('通用设置不能修改语音服务选择。'), { code: 'VOICE_SELECTION_MANAGED', hint: '请在语音管理中调整服务及额度；自定义端点需先停止相关进程并按语音指南配置。' });

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('invalid config');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > 4 * 1024 * 1024 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('invalid config');
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text.replace(/^﻿/, ''));
    if (!object(value)) throw new Error('invalid config');
    return { value, bytes, bom: text.startsWith('﻿') };
  } catch (e) {
    if (e.code === 'ENOENT') return { value: {}, bytes: null, bom: false };
    throw Object.assign(new Error('QQ 配置无法读取，已拒绝写入。'), { code: 'QQ_CONFIG_INVALID', hint: '检查并保留原配置，修复后重试。' });
  }
}

function selection(config) {
  const social = config?.socialV2, voice = social?.voice, t = voice?.tts || {};
  if ((own(config, 'socialV2') && !object(social)) || (object(social) && own(social, 'voice') && !object(voice)) ||
      (object(voice) && own(voice, 'tts') && !object(voice.tts)) || (object(voice) && own(voice, 'cloud') && !object(voice.cloud)) ||
      (own(t, 'endpoints') && !object(t.endpoints))) throw selectionError();
  return [t.enabled === true, t.route === 'cloud' ? 'cloud' : 'local', t.cloudProvider === 'volc' ? 'volc' : 'voxd',
    t.volcKeyId ?? null, t.selectionRevision ?? 0, t.endpoints?.cloud || 'http://127.0.0.1:8767', t.endpoints?.local || 'http://127.0.0.1:8765', t.baseUrl || 'http://127.0.0.1:8765',
    t.volcMonthlyQuota ?? 0, voice?.cloud?.monthlyQuota ?? 0, voice?.maxPerMinute ?? 2, voice?.maxPerHour ?? 10];
}

export function assertVoiceSelectionUnchanged(before, after) {
  if (!same(selection(before), selection(after))) throw selectionError();
}

function mergePatch(base, next, current) {
  if (same(base, next)) return current;
  if (base !== MISSING && next !== MISSING && current !== MISSING && object(base) && object(next) && object(current)) {
    const output = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw stale();
      const value = mergePatch(own(base, key) ? base[key] : MISSING, own(next, key) ? next[key] : MISSING,
        own(current, key) ? current[key] : MISSING);
      if (value === MISSING) delete output[key]; else output[key] = value;
    }
    return output;
  }
  if (!same(base, current) && !same(next, current)) throw stale();
  return next;
}

// Generic config writers may not alter the provider, route, key or selection revision.
export function transactQqConfig(file, mutate, { requireExisting = false, allowVoiceSelection = false } = {}) {
  try { return withVolcBudgetLock(file, state => {
    const before = read(file);
    if (requireExisting && !before.bytes) throw Object.assign(new Error('QQ 配置不存在。'), { code: 'QQ_CONFIG_MISSING', hint: '检查配置路径，保留现有数据后重试。' });
    const draft = structuredClone(before.value);
    const result = mutate(draft);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw Object.assign(new Error('配置事务不能包含异步操作。'), { code: 'QQ_CONFIG_ASYNC_UNSUPPORTED', hint: '等待操作完成后再保存配置。' });
    }
    if (!same(selection(before.value), selection(draft))) {
      if (!allowVoiceSelection) throw selectionError();
      const oldTts = before.value?.socialV2?.voice?.tts || {}, nextTts = draft?.socialV2?.voice?.tts;
      const revision = oldTts.selectionRevision ?? 0;
      if (!object(nextTts) || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER ||
          (nextTts.selectionRevision ?? 0) !== revision) throw selectionError();
      nextTts.selectionRevision = revision + 1;
    }
    if (same(draft, before.value)) return { config: before.value, result, backup: null };
    const merged = draft;
    const dir = path.join(state, 'qq-config-transaction-backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw stale();
    let backup = null;
    if (before.bytes) {
      backup = path.join(dir, `${crypto.randomUUID()}.json`);
      const fd = fs.openSync(backup, 'wx', 0o600);
      try { fs.writeFileSync(fd, before.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (process.platform !== 'win32') { const fdDir = fs.openSync(dir, 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); } }
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${before.bom ? '﻿' : ''}${JSON.stringify(merged, null, 2)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      if (process.platform !== 'win32') { const fdDir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); } }
    } finally { try { fs.unlinkSync(temp); } catch {} }
    return { config: merged, result, backup };
  }); } catch (error) {
    if (typeof error?.code === 'string' && error.hint) throw error;
    throw Object.assign(new Error('QQ 配置写入未确认。'), { code: 'QQ_CONFIG_WRITE_FAILED', hint: '保留当前文件和备份，重新读取配置并检查权限后再操作。' });
  }
}

// Publish an initial config without exposing partial content or replacing an existing file.
export function initializeQqConfig(file, templateFile) {
  if (fs.existsSync(file)) return { created: false };
  return withVolcBudgetLock(file, () => {
    if (fs.existsSync(file)) return { created: false };
    const bytes = fs.readFileSync(templateFile);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''));
    if (!object(value)) throw Object.assign(new Error('配置模板无效。'), { code: 'QQ_CONFIG_TEMPLATE_INVALID', hint: '检查安装包配置模板后重试。' });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, file); } catch (error) { if (error.code === 'EEXIST') return { created: false }; throw error; }
      if (process.platform !== 'win32') { const fdDir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); } }
      return { created: true };
    } finally { try { fs.unlinkSync(temp); } catch {} }
  });
}

// Preserve concurrent unrelated fields; reject overlapping edits and generic provider changes.
export function commitQqConfigPatch(file, base, next, { requireExactBase = false } = {}) {
  if (!object(base) || !object(next)) throw stale();
  if (!same(selection(base), selection(next))) throw selectionError();
  return transactQqConfig(file, draft => {
    if (requireExactBase && !same(base, draft)) throw stale();
    const merged = mergePatch(base, next, draft);
    for (const key of Object.keys(draft)) delete draft[key];
    for (const [key, value] of Object.entries(merged)) Object.defineProperty(draft, key, { value, enumerable: true, configurable: true, writable: true });
  }).config;
}
