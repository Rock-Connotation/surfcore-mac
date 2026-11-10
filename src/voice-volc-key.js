import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function keyDir(configFile) { return path.join(path.dirname(configFile), 'state', 'volc-voice-keys'); }
function validateKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key); }
function directory(configFile, create = false) {
  const dir = keyDir(configFile);
  const statePath = path.dirname(dir);
  if (create) fs.mkdirSync(statePath, { recursive: true, mode: 0o700 });
  const state = fs.lstatSync(statePath);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('credential directory unavailable');
  if (create) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() ||
      (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw new Error('credential directory unavailable');
  return dir;
}
export function saveVolcKey(configFile, key) {
  if (!fs.constants.O_NOFOLLOW) throw Object.assign(new Error('当前系统无法安全保存火山密钥。'), { code: 'VOICE_VOLC_PLATFORM_UNSUPPORTED', hint: '请在支持安全文件访问的 macOS 上配置火山语音。' });
  if (!validateKey(key)) throw Object.assign(new Error('API Key 格式无效。'), { code: 'VOICE_VOLC_KEY_INVALID', hint: '请输入有效的火山 API Key。' });
  const dir = directory(configFile, true);
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, id), key, { flag: 'wx', mode: 0o600 });
  return id;
}
export function readVolcKey(configFile, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return '';
  const file = path.join(directory(configFile), id);
  if (!fs.constants.O_NOFOLLOW) throw new Error('credential protection unavailable');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > 4096 || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw new Error('credential file unavailable');
    const key = fs.readFileSync(fd, 'utf8');
    if (!validateKey(key)) throw new Error('credential invalid');
    return key;
  } finally { fs.closeSync(fd); }
}
