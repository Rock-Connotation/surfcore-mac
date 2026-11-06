import fs from 'node:fs';

/** Validate names and entry types before a platform extractor can write anything. */
export function validateUpdateArchive(file) {
  const data = fs.readFileSync(file);
  const fail = () => { throw new Error('更新 ZIP 路径或结构不安全；请重新下载官方制品'); };
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) fail();
  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  let at = data.readUInt32LE(end + 16);
  const limit = at + size;
  if (!count || count === 65535 || limit !== end || data.readUInt16LE(end + 8) !== count) fail();
  const checkName = (bytes) => {
    const name = bytes.toString('utf8');
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || name.split('/').some((part) => part === '..' || part === '.')) fail();
    return name;
  };
  for (let i = 0; i < count; i++) {
    if (at + 46 > limit || data.readUInt32LE(at) !== 0x02014b50) fail();
    const nameSize = data.readUInt16LE(at + 28);
    const next = at + 46 + nameSize + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    if (next > limit) fail();
    const nameBytes = data.subarray(at + 46, at + 46 + nameSize);
    checkName(nameBytes);
    const type = (data.readUInt32LE(at + 38) >>> 16) & 0xf000;
    // Only ordinary files and directories; no symlinks/devices/FIFOs.
    if (type && type !== 0x8000 && type !== 0x4000) fail();
    const local = data.readUInt32LE(at + 42);
    if (local + 30 > at || data.readUInt32LE(local) !== 0x04034b50) fail();
    const localNameSize = data.readUInt16LE(local + 26);
    if (local + 30 + localNameSize > at) fail();
    const localName = data.subarray(local + 30, local + 30 + localNameSize);
    checkName(localName);
    if (!localName.equals(nameBytes)) fail();
    at = next;
  }
  if (at !== limit) fail();
  return { entries: count };
}
