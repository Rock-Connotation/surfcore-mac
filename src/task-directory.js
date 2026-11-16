import fs from 'node:fs';
import path from 'node:path';

const ENTRY_LIMIT = 512;
const TEXT_LIMIT = 2600;
const FILE_BYTE_LIMIT = 2400;
const fileNamePattern = /^(?!\.)[^/\\\p{C}\p{Zl}\p{Zp}]+\.txt$/iu;
const fail = (code, error, hint) => ({ ok: false, code, error, hint });

function outside(relative) {
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function displayName(name) {
  return JSON.stringify(name).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    symbol => `\\u{${symbol.codePointAt(0).toString(16)}}`);
}

export function listTaskDirectory({ root, target }) {
  const formatHint = '发送「任务：列出文件 <绝对路径>」，路径可用双引号包住。';
  const denied = () => fail('TASK_DIRECTORY_NOT_ALLOWED', '该目录不在 QQ 只读工作区内，或经过符号链接。', '从本机 QQ 只读工作区选择实际目录。');
  if (typeof target !== 'string' || !path.isAbsolute(target) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(target)) {
    return fail('TASK_DIRECTORY_INVALID', '请提供单个有效的绝对目录路径。', formatHint);
  }
  const relative = path.relative(root, target);
  if (outside(relative)) return denied();

  try {
    const rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || (process.platform !== 'win32' && (rootInfo.mode & 0o022))) return denied();
    const canonicalRoot = fs.realpathSync(root);
    const directory = path.join(canonicalRoot, relative);
    if (fs.realpathSync(directory) !== directory) return denied();
    const before = fs.lstatSync(directory);
    if (!before.isDirectory()) return fail('TASK_DIRECTORY_NOT_FOUND', '目标不是目录。', '检查本机文件夹路径。');

    const names = [];
    const entries = fs.opendirSync(directory);
    let scanLimited = false;
    try {
      for (let scanned = 0; scanned <= ENTRY_LIMIT; scanned += 1) {
        const entry = entries.readSync();
        if (!entry) break;
        if (scanned === ENTRY_LIMIT) { scanLimited = true; break; }
        if (entry.isFile()) names.push(entry.name);
      }
    } finally {
      entries.closeSync();
    }
    const after = fs.lstatSync(directory);
    if (!after.isDirectory() || before.ino !== after.ino || before.dev !== after.dev || fs.realpathSync(directory) !== directory) {
      return fail('TASK_DIRECTORY_CHANGED', '列出文件时目录已变化。', '确认目录位置后重新发起任务。');
    }
    let text = '';
    let displayed = 0;
    for (const name of names.sort()) {
      const line = `- ${displayName(name)}\n`;
      if (text.length + line.length > TEXT_LIMIT) break;
      text += line;
      displayed += 1;
    }
    const truncated = scanLimited || displayed < names.length;
    return { ok: true, text: text.trimEnd() || '未列到普通文件。', displayed, truncated };
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? fail('TASK_DIRECTORY_NOT_FOUND', '目录不存在。', '检查本机文件夹路径。')
      : fail('TASK_DIRECTORY_READ_FAILED', 'Mac 无法读取该目录。', '在本机检查目录读取权限后重新发起任务。');
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readRegularFile(file, limit, privateFile = false) {
  const statOptions = { bigint: true };
  const safe = info => info.isFile() && info.nlink === 1n && info.uid === BigInt(process.getuid()) &&
    !(info.mode & (privateFile ? 0o077n : 0o022n));
  const before = fs.lstatSync(file, statOptions);
  if (!safe(before)) return { code: 'TASK_FILE_NOT_ALLOWED' };
  if (before.size > BigInt(limit)) return { code: 'TASK_FILE_TOO_LARGE' };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, statOptions);
    if (!safe(opened) || !sameFile(before, opened)) return { code: 'TASK_FILE_CHANGED' };
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count > limit) return { code: 'TASK_FILE_TOO_LARGE' };
    const current = fs.lstatSync(file, statOptions);
    if (BigInt(count) !== opened.size || !safe(current) || !sameFile(opened, current) || !sameFile(opened, fs.fstatSync(fd, statOptions))) {
      return { code: 'TASK_FILE_CHANGED' };
    }
    return { buffer: buffer.subarray(0, count), identity: opened };
  } finally {
    fs.closeSync(fd);
  }
}

function readFileScope(root, grantName = 'text-directory') {
  if (typeof process.getuid !== 'function' || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) return null;
  try {
    const grant = readRegularFile(`${root}.${grantName}`, 255, true);
    const name = grant.buffer?.toString('utf8').trim();
    if (!name || !/^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]*$/u.test(name)) return null;
    const isTrustedDirectory = info => info.isDirectory() && info.uid === process.getuid() &&
      !(info.mode & (grantName === 'create-directory' ? 0o077 : 0o022));
    if (grantName === 'create-directory' && !isTrustedDirectory(fs.lstatSync(path.dirname(root)))) return null;
    if (!isTrustedDirectory(fs.lstatSync(root))) return null;
    const directory = path.join(fs.realpathSync(root), name);
    const info = fs.lstatSync(directory);
    if (!isTrustedDirectory(info) || fs.realpathSync(directory) !== directory) return null;
    return { name, directory, dev: info.dev, ino: info.ino, grant: grant.identity };
  } catch {
    return null;
  }
}

function sameFileScope(root, grantName, scope) {
  const current = readFileScope(root, grantName);
  return current?.directory === scope.directory && current.dev === scope.dev && current.ino === scope.ino &&
    sameFile(current.grant, scope.grant);
}

export function readTaskText({ root, target }) {
  const scope = readFileScope(root);
  if (!scope) return fail('TASK_FILE_SCOPE_REQUIRED', '本机未启用文件正文读取目录。', '在 Mac 上确认指定目录的只读授权。');
  const name = typeof target === 'string' ? path.basename(target) : '';
  if (!fileNamePattern.test(name) || (target !== name && target !== path.join(root, scope.name, name))) {
    return fail('TASK_FILE_NOT_ALLOWED', '只允许读取指定目录当前层的 .txt 文件。', '发送「任务：读取文件 <文件名.txt>」。');
  }
  const verifyScope = () => sameFileScope(root, 'text-directory', scope);
  let result;
  try {
    result = readRegularFile(path.join(scope.directory, name), FILE_BYTE_LIMIT);
  } catch (error) {
    if (error?.code === 'ENOENT') return fail('TASK_FILE_NOT_FOUND', '该文件不存在。', '核对指定目录里的文件名后重试。');
    result = { code: error?.code === 'ELOOP' ? 'TASK_FILE_NOT_ALLOWED' : 'TASK_FILE_READ_FAILED' };
  }
  if (result.code === 'TASK_FILE_NOT_ALLOWED') return fail(result.code, '目标不是可读取的本机普通文件。', '在指定目录内使用本人拥有且无链接的 .txt 文件。');
  if (result.code === 'TASK_FILE_TOO_LARGE') return fail(result.code, `文件超过 ${FILE_BYTE_LIMIT} 字节。`, '请在本机选一个更短的文本文件。');
  if (result.code === 'TASK_FILE_CHANGED' || !verifyScope()) return fail('TASK_FILE_CHANGED', '读取时文件或目录授权已变化。', '在本机确认文件和授权后重新发送指令。');
  if (!result.buffer) return fail(result.code, 'Mac 无法读取该文件。', '在本机确认文件读取权限后重试。');

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.buffer);
    if (!/\p{Cc}/u.test(text.replace(/[\t\r\n]/g, ''))) return { ok: true, text, bytes: result.buffer.length, verifyScope };
  } catch {
    // A malformed UTF-8 file cannot be returned faithfully as QQ text.
  }
  return fail('TASK_FILE_TEXT_INVALID', '该文件无法作为 UTF-8 纯文本回传。', '在本机选一个 UTF-8 .txt 文件后重试。');
}

export function createTaskText({ root, target, text, validate }) {
  const grantName = 'create-directory';
  const scope = readFileScope(root, grantName);
  if (!scope) return fail('TASK_CREATE_SCOPE_REQUIRED', '本机未启用文件新建权限。', '在 Mac 上确认指定测试目录的新建授权。');
  if (typeof target !== 'string' || target.length > 120 || Buffer.byteLength(target) > 240 ||
      !/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.txt$/iu.test(target)) {
    return fail('TASK_CREATE_NAME_INVALID', '请提供指定目录当前层的 .txt 文件名。', '发送「任务：新建文件 文件名.txt 写入 正文」，文件名用字母、数字、下划线、点或连字符。');
  }
  if (typeof text !== 'string' || !text.trim() || /\p{Cc}/u.test(text.replace(/[\t\r\n]/g, ''))) {
    return fail('TASK_CREATE_TEXT_INVALID', '请提供要写入的纯文本正文。', '在「写入」后加一个空格，再输入正文。');
  }
  if (Buffer.byteLength(text) > FILE_BYTE_LIMIT) {
    return fail('TASK_CREATE_TEXT_TOO_LARGE', `正文超过 ${FILE_BYTE_LIMIT} 字节。`, '缩短正文后重新发送指令。');
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) return fail('TASK_CREATE_TEXT_INVALID', '正文包含无效字符。', '复制有效的 UTF-8 正文后重试。');

  const destination = path.join(scope.directory, target);
  const allowedNow = () => validate() && sameFileScope(root, grantName, scope);
  const changed = () => fail('TASK_CREATE_SCOPE_CHANGED', '创建前授权或目录已变化。', '在 Mac 上核对目录授权，再发送一条新指令。');
  const unknown = () => ({ ...fail('TASK_CREATE_UNCONFIRMED', '文件已提交创建，但无法确认最终状态。', '先在 Mac 上检查文件，再查询任务状态。'), effect: 'unconfirmed' });
  if (!allowedNow()) return changed();

  let stageDir;
  let staged;
  let published;
  let cleanupFailed = false;
  try {
    stageDir = fs.mkdtempSync(path.join(path.dirname(root), '.task-create-'));
    staged = path.join(stageDir, 'content');
    const fd = fs.openSync(staged, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      published = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }

    if (!allowedNow()) return changed();
    try {
      fs.linkSync(staged, destination);
    } catch (error) {
      if (error?.code === 'EEXIST') return fail('TASK_CREATE_EXISTS', '同名文件或链接已存在，原样保留。', '若需创建另一份，使用不同文件名。');
      throw error;
    }
  } catch {
    return fail('TASK_CREATE_IO_FAILED', 'Mac 无法创建文件。', '检查指定目录的权限、磁盘空间和文件系统后重试。');
  } finally {
    if (stageDir) {
      try {
        if (staged) {
          try { fs.unlinkSync(staged); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
        fs.rmdirSync(stageDir);
      } catch {
        cleanupFailed = true;
      }
    }
  }

  try {
    if (cleanupFailed || !sameFileScope(root, grantName, scope)) return unknown();
    const actual = readRegularFile(destination, FILE_BYTE_LIMIT, true);
    if (!actual.buffer?.equals(bytes) || actual.identity.ino !== published.ino || actual.identity.dev !== published.dev) return unknown();
    const dirFd = fs.openSync(scope.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(dirFd);
      if (info.dev !== scope.dev || info.ino !== scope.ino) return unknown();
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    return { ok: true, name: target, bytes: bytes.length };
  } catch {
    return unknown();
  }
}
