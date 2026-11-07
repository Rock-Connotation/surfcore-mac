import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { problem, safeDisplayText } from './douyin-companion-utils.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const unavailable = () => problem('DOUYIN_CHAT_STORAGE', '本机伙伴对话记录暂时不可用，原记录未重置。', '保留角色的 sharing.jsonl，检查权限或文件完整性后刷新。');
function checkRecord(value) {
  if (!value || value.version !== 1 || !['opening', 'request', 'answer', 'failure', 'ack'].includes(value.kind) ||
      typeof value.id !== 'string' || value.id.length > 160 || !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) throw unavailable();
  const allowed = {
    opening: ['jobId', 'sourceId', 'sourceTitle', 'occurredAt', 'text', 'question', 'coverage'],
    request: ['openingId', 'requestId', 'text', 'owner', 'pid'], answer: ['openingId', 'requestId', 'text'],
    failure: ['openingId', 'requestId', 'code', 'error', 'hint'], ack: ['openingId'],
  }[value.kind];
  if (Object.keys(value).some(key => !['version', 'kind', 'id', 'epoch', 'at', ...allowed].includes(key))) throw unavailable();
  for (const key of ['openingId', 'requestId', 'jobId', 'sourceId']) {
    if (value[key] !== undefined && !safeDisplayText(value[key], 160)) throw unavailable();
  }
  if (['opening', 'request', 'answer'].includes(value.kind) && !safeDisplayText(value.text, value.kind === 'request' ? 1000 : 600)) throw unavailable();
  if (value.kind === 'request' && (value.owner !== undefined || value.pid !== undefined) &&
      (!/^\d+:[0-9a-f-]{36}$/.test(value.owner || '') || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !value.owner.startsWith(`${value.pid}:`))) throw unavailable();
  if (value.kind === 'opening' && (!/^\d{1,32}$/.test(value.sourceId) || !/^douyin-[0-9a-f-]{36}$/.test(value.jobId) ||
      !safeDisplayText(value.sourceTitle, 240) || !safeDisplayText(value.question, 100) || !value.coverage ||
      typeof value.coverage.transcriptComplete !== 'boolean' || !Number.isSafeInteger(value.coverage.frameSamples) || value.coverage.frameSamples < 1 || value.coverage.frameSamples > 3)) throw unavailable();
  if (value.kind === 'failure' && (!/^DOUYIN_[A-Z0-9_]{1,72}$/.test(value.code) || !safeDisplayText(value.error, 240) || !safeDisplayText(value.hint, 300))) throw unavailable();
  return value;
}

// Append-only, scoped to one role. A separate short lock protects record/ack
// writes while the shared companion ledger lock protects paid model admission.
export function createSharingStore(stateDir) {
  function locations(id, create = false) {
    if (!path.isAbsolute(stateDir) || !/^[A-Za-z0-9_-]+$/.test(id)) throw unavailable();
    let current = path.parse(stateDir).root;
    const target = path.join(stateDir, 'characters', id, 'douyin');
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      } catch (error) {
        if (error.code !== 'ENOENT') throw unavailable();
        if (!create) return null;
        fs.mkdirSync(current, { mode: 0o700 });
      }
    }
    return { dir: target, file: path.join(target, 'sharing.jsonl'), lock: path.join(target, '.sharing.lock') };
  }
  function read(id) {
    const files = locations(id);
    if (!files) return [];
    let fd;
    try {
      const before = fs.lstatSync(files.file);
      if (!before.isFile() || before.isSymbolicLink()) throw unavailable();
      fd = fs.openSync(files.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) throw unavailable();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_BYTES) throw unavailable();
      if (bytes.length && bytes.at(-1) !== 10) throw unavailable();
      return bytes.toString('utf8').split('\n').filter(Boolean).map(line => checkRecord(JSON.parse(line)));
    } catch (error) { if (error.code === 'ENOENT') return []; throw unavailable(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function append(id, event, checkBeforeWrite = () => {}) {
    checkRecord(event);
    const files = locations(id, true), owner = crypto.randomUUID();
    let lockFd, fd;
    try {
      try { lockFd = fs.openSync(files.lock, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw problem('DOUYIN_CHAT_STORAGE_BUSY', '另一项操作正在保存伙伴对话。', '稍后刷新已有结果；不要删除锁或重复发送。');
        throw unavailable();
      }
      fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, owner })); fs.fsyncSync(lockFd);
      const records = read(id);
      if (records.some(record => record.id === event.id)) return;
      const data = Buffer.from(JSON.stringify(event) + '\n');
      let before;
      try { before = fs.lstatSync(files.file); if (!before.isFile() || before.isSymbolicLink()) throw unavailable(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fd = fs.openSync(files.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (before && (stat.dev !== before.dev || stat.ino !== before.ino))) throw unavailable();
      if (!stat.isFile() || stat.size + data.length > MAX_BYTES) throw problem('DOUYIN_CHAT_ARCHIVE_LIMIT', '本机对话归档已达到大小上限，未删除旧记录。', '保留原 sharing.jsonl 并整理归档后再继续对话。');
      checkBeforeWrite();
      let written = 0;
      while (written < data.length) written += fs.writeSync(fd, data, written, data.length - written);
      fs.fsyncSync(fd);
      const dir = fs.openSync(files.dir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) {
      if (/^DOUYIN_/.test(error.code || '')) throw error;
      throw unavailable();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        try { const lock = JSON.parse(fs.readFileSync(files.lock, 'utf8')); if (lock.owner === owner) fs.unlinkSync(files.lock); } catch {}
      }
    }
  }
  return { read, append };
}
