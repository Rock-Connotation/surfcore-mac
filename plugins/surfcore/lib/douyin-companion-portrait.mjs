import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;
const CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const fail = (code, error, hint) => ({ ok: false, code, error, hint });

function portraitPath(characterId) {
  const configuredHome = path.resolve(process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh'));
  const configuredStat = fs.lstatSync(configuredHome);
  if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) throw Object.assign(new Error(), { code: 'UNSAFE' });
  const home = fs.realpathSync(configuredHome);
  let directory = path.parse(home).root;
  for (const part of path.relative(directory, home).split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error(), { code: 'UNSAFE' });
  }
  return {
    home,
    file: path.join(home, 'surfcore', 'characters', characterId, 'appearance', 'companion-portrait.webp'),
  };
}

function pathComponents(home, characterId) {
  const parts = ['surfcore', 'characters', characterId, 'appearance', 'companion-portrait.webp'];
  const values = [];
  let current = home;
  for (const part of parts) {
    current = path.join(current, part);
    values.push(current);
  }
  return values;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectPath(home, characterId) {
  const values = pathComponents(home, characterId);
  for (let index = 0; index < values.length; index++) {
    let stat;
    try { stat = fs.lstatSync(values[index]); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return fail('COMPANION_PORTRAIT_MISSING', '当前角色还没有本机立绘。', '点刷新重试；若持续失败，请重新配置当前角色的本机立绘。');
      return fail('COMPANION_PORTRAIT_READ_FAILED', '读取当前角色立绘目录失败。', '检查角色目录权限后点刷新重试。');
    }
    if (stat.isSymbolicLink()) return fail('COMPANION_PORTRAIT_UNSAFE', '立绘路径包含符号链接，已拒绝读取。', '检查本机角色立绘文件和目录，移除符号链接后点刷新。');
    if (index < values.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      return fail('COMPANION_PORTRAIT_UNSAFE', '立绘路径包含非普通文件或目录。', '检查当前角色的立绘文件与目录后点刷新。');
    }
    if (index === values.length - 1) return { ok: true, file: values[index], stat };
  }
  return fail('COMPANION_PORTRAIT_MISSING', '当前角色还没有本机立绘。', '点刷新重试；若持续失败，请重新配置当前角色的本机立绘。');
}

export function readCompanionPortrait(characterId) {
  if (typeof characterId !== 'string' || !CHARACTER_ID.test(characterId)) {
    return fail('COMPANION_PORTRAIT_CHARACTER_INVALID', '当前角色编号无效，已拒绝读取立绘。', '在角色页重新载入有效角色后点刷新。');
  }

  let location;
  try { location = portraitPath(characterId); }
  catch (error) {
    if (error?.code === 'UNSAFE') return fail('COMPANION_PORTRAIT_UNSAFE', '角色存储根目录不安全，已拒绝读取立绘。', '检查 SurfCore 角色目录是否为真实目录后点刷新。');
    return fail('COMPANION_PORTRAIT_MISSING', '当前角色立绘目录尚未就绪。', '检查当前角色目录后点刷新重试。');
  }

  const inspected = inspectPath(location.home, characterId);
  if (!inspected.ok) return inspected;
  if (inspected.stat.size < 12 || inspected.stat.size > MAX_BYTES) {
    return fail('COMPANION_PORTRAIT_INVALID', '立绘大小无效或超过 4 MiB。', '检查立绘文件小于 4 MiB 且为 WebP 后点刷新。');
  }

  let fd;
  try {
    fd = fs.openSync(inspected.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(inspected.stat, opened) || opened.size < 12 || opened.size > MAX_BYTES) {
      return fail('COMPANION_PORTRAIT_UNSAFE', '立绘文件在读取前发生变化，已拒绝读取。', '检查角色目录后点刷新重试。');
    }
    const bytes = fs.readFileSync(fd);
    const after = inspectPath(location.home, characterId);
    if (!after.ok || !sameIdentity(opened, after.stat) || fs.realpathSync(inspected.file) !== inspected.file) {
      return fail('COMPANION_PORTRAIT_UNSAFE', '立绘路径在读取期间发生变化，已拒绝读取。', '检查角色目录后点刷新重试。');
    }
    if (bytes.length < 12 || bytes.length > MAX_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
      return fail('COMPANION_PORTRAIT_INVALID', '本机立绘不是有效的 WebP 文件。', '提供标准 WebP 立绘后点刷新。');
    }
    return { ok: true, bytes };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return fail('COMPANION_PORTRAIT_MISSING', '当前角色还没有本机立绘。', '点刷新重试；若持续失败，请重新配置当前角色的本机立绘。');
    if (error?.code === 'ELOOP') return fail('COMPANION_PORTRAIT_UNSAFE', '立绘路径包含符号链接，已拒绝读取。', '检查本机角色立绘文件和目录，移除符号链接后点刷新。');
    return fail('COMPANION_PORTRAIT_READ_FAILED', '读取当前角色立绘失败。', '检查文件权限后点刷新重试。');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
