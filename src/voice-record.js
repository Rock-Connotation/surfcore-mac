import fs from 'node:fs';

// Inline is opt-in for a gateway in another filesystem namespace.
export function encodeVoiceRecord(file, maxBytes, expected = null) {
  const limit = Math.min(20 * 1024 * 1024, Number(maxBytes));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('音频大小限制无效');
  if (!fs.constants.O_NOFOLLOW) throw new Error('当前系统无法安全打开音频文件');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('音频文件为空或超过大小限制');
    if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs)) throw new Error('音频检查后发生变化');
    const audio = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < audio.length) {
      const read = fs.readSync(fd, audio, offset, audio.length - offset, offset);
      if (!read) throw new Error('音频读取不完整');
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('音频读取时发生变化');
    return `base64://${audio.toString('base64')}`;
  } finally { fs.closeSync(fd); }
}
