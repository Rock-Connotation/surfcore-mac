import fs from 'node:fs';
import path from 'node:path';

const ENTRY_LIMIT = 512;
const TEXT_LIMIT = 2600;
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
