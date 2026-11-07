import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateUpdateArchive } from '../plugins/surfcore/lib/update-archive.js';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-archive-'));
try {
  fs.mkdirSync(path.join(base, 'root'));
  fs.writeFileSync(path.join(base, 'root', 'safe.txt'), 'fixture');
  const archive = path.join(base, 'safe.zip');
  if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -LiteralPath '${path.join(base, 'root').replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}'`]);
  else execFileSync('zip', ['-qr', archive, 'root'], { cwd: base });
  assert.ok(validateUpdateArchive(archive).entries > 0);
  const original = fs.readFileSync(archive);
  const rejects = (mutate) => {
    const data = Buffer.from(original); mutate(data);
    const file = path.join(base, 'bad.zip'); fs.writeFileSync(file, data);
    assert.throws(() => validateUpdateArchive(file), /ZIP/);
  };
  // Alter both local and central names, proving preflight blocks traversal before unzip.
  rejects((data) => {
    let at = data.indexOf('root/safe.txt');
    while (at >= 0) { data.write('../x/safe.txt', at); at = data.indexOf('root/safe.txt', at + 1); }
  });
  rejects((data) => {
    const at = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    data.writeUInt32LE(0xa1ff0000, at + 38); // Unix symlink attributes.
  });
  rejects((data) => { data.write('evil', data.indexOf('root/safe.txt')); }); // local/central mismatch
  rejects((data) => { data[data.length - 1] = 1; }); // malformed comment length
  assert.throws(() => { const f = path.join(base, 'empty'); fs.writeFileSync(f, ''); validateUpdateArchive(f); }, /ZIP/);
  console.log('PASS update archive: safe ZIP accepted; traversal, symlink, name mismatch and truncation rejected');
} finally { fs.rmSync(base, { recursive: true, force: true }); }
