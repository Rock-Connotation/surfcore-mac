import fs from 'node:fs';

// Opt-in durability for direct model consumers. Existing sampled usage keeps its batching.
export function syncBudgetFiles(files, directory) {
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('usage file is not a regular file');
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (process.platform !== 'win32') {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error; }
    finally { fs.closeSync(fd); }
  }
}
