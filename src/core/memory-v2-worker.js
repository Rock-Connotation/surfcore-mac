import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { canonical, checkStamp, fail, requireThat } from './memory-v2-contract.js';

export function processStartIdentity(pid) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'MEMORY_WRITER_LOCK_INVALID', 'The lock contains an invalid PID.');
  if (process.platform === 'win32') {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
    requireThat(/^\d+$/.test(value), 'MEMORY_WRITER_IDENTITY_UNAVAILABLE', 'The Windows process start identity could not be verified.');
    return `windows:${value}`;
  }
  const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }).trim();
  requireThat(value.length > 0, 'MEMORY_WRITER_IDENTITY_UNAVAILABLE', 'The process start identity could not be verified.');
  return `${process.platform}:${value}`;
}
export function releaseWriterLock(file, ownerToken) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (lock.ownerToken === ownerToken && path.resolve(file) === path.join(lock.installRoot, 'memory-v2.writer.lock')) fs.unlinkSync(file);
  } catch {}
}
function acquireWriterLock(directory, ownerToken) {
  fs.mkdirSync(directory, { recursive: true });
  const guard = path.join(fs.realpathSync(directory), 'memory-v2.writer.lock.acquiring');
  let fd;
  try { fd = fs.openSync(guard, 'wx', 0o600); }
  catch { throw Object.assign(new Error('Another worker is acquiring or recovering the writer lock.'), fail('MEMORY_WRITER_LOCKED', 'Another worker is acquiring or recovering the writer lock.', 'Close other memory workers. Preserve an orphan acquisition guard for explicit ownership inspection; it is never removed by age.')); }
  try { return acquireGuardedWriterLock(directory, ownerToken); }
  finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}
function acquireGuardedWriterLock(directory, ownerToken) {
  fs.mkdirSync(directory, { recursive: true });
  const installRoot = fs.realpathSync(directory), file = path.join(installRoot, 'memory-v2.writer.lock');
  const owner = { pid: process.pid, startIdentity: processStartIdentity(process.pid), installRoot, ownerToken };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      const bytes = Buffer.from(canonical(owner));
      let written = 0;
      while (written < bytes.length) { const n = fs.writeSync(fd, bytes, written, bytes.length - written, null); requireThat(n > 0, 'MEMORY_WRITER_LOCK_INVALID', 'The writer lock could not be completely written.'); written += n; }
      fs.fsyncSync(fd); fs.closeSync(fd);
      return { file, owner };
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Object.assign(new Error('The writer lock is corrupt.'), fail('MEMORY_WRITER_LOCK_INVALID', 'The writer lock is corrupt.', 'Keep the lock, close other instances, and inspect ownership before recovery.')); }
      requireThat(Number.isSafeInteger(old.pid) && old.pid > 0 && old.installRoot === installRoot && typeof old.startIdentity === 'string' && typeof old.ownerToken === 'string', 'MEMORY_WRITER_LOCK_INVALID', 'The writer lock does not identify this installation.');
      let absent = false;
      try { process.kill(old.pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') absent = true; else throw Object.assign(new Error('Writer ownership cannot be checked.'), fail('MEMORY_WRITER_LOCKED', 'Writer ownership cannot be checked.')); }
      if (!absent) {
        let identity;
        try { identity = processStartIdentity(old.pid); } catch { throw Object.assign(new Error('Writer process start identity is unverified.'), fail('MEMORY_WRITER_LOCKED', 'Writer process start identity is unverified.')); }
        requireThat(identity !== old.startIdentity, 'MEMORY_WRITER_LOCKED', 'Another live Host owns the installation writer lock.', 'Close the other memory service or Host. A lock is never stolen by age.');
      }
      // Preserve the exact stale ownership record; a PID/start-identity mismatch proves that original owner is gone.
      requireThat(fs.readFileSync(file, 'utf8') === canonical(old), 'MEMORY_WRITER_LOCKED', 'Writer ownership changed during recovery.');
      fs.renameSync(file, `${file}.retired-${ownerToken}`);
    }
  }
  throw Object.assign(new Error('Writer lock could not be acquired.'), fail('MEMORY_WRITER_LOCKED', 'Writer lock could not be acquired.'));
}

if (!isMainThread) {
  let store, lock, clock = Date.now();
  try {
    lock = acquireWriterLock(workerData.stateDir, workerData.ownerToken);
    const { createStore } = await import('./memory-v2-store.js');
    store = createStore({ ...workerData, now: () => clock });
    parentPort.postMessage({ type: 'ready', result: store.getStatus() });
    let queue = Promise.resolve();
    parentPort.on('message', (packet) => {
      queue = queue.then(() => {
        let body = {}, result, closeApproved = false;
        try {
          requireThat(packet && typeof packet === 'object' && !Array.isArray(packet), 'MEMORY_WORKER_STAMP_INVALID', 'The serialized Host packet is malformed.');
          const { signature, ...request } = packet;
          body = request;
          requireThat(checkStamp(body, signature, workerData.secret), 'MEMORY_WORKER_STAMP_INVALID', 'The serialized Host request stamp is invalid.');
          requireThat(['metadata', 'resolveAudience', 'getStatus', 'ingestEvents', 'getMemoryReceipt', 'searchMemory', 'prepareMemoryContext', 'proposeMemory', 'applyMemoryAction', 'validateContext', 'validateManifest', 'readOrganizeBatch', 'finishOrganizeBatch', 'lifecycle', 'admin', 'registerProducer', 'producerRegistration', 'producerRegistrationReceipt', 'replayProducer', 'queryProducerReceipt', 'close'].includes(body.method), 'MEMORY_WORKER_METHOD_INVALID', 'This worker method is unavailable.');
          clock = body.now;
          requireThat(Number.isFinite(clock), 'MEMORY_WORKER_STAMP_INVALID', 'The Host timestamp is invalid.');
          requireThat(Array.isArray(body.args), 'MEMORY_WORKER_METHOD_INVALID', 'Worker arguments must be an array.');
          result = store[body.method](...body.args);
          closeApproved = body.method === 'close' && result.ok === true;
        } catch (error) {
          result = fail(error.code?.startsWith('MEMORY_') || error.code?.startsWith('CHARACTER_') ? error.code : 'MEMORY_STORE_FAILED', error.code?.startsWith('MEMORY_') || error.code?.startsWith('CHARACTER_') ? error.message : 'The memory transaction could not be completed.', error.hint);
        }
        parentPort.postMessage({ id: body.id ?? null, result });
        if (closeApproved) { releaseWriterLock(lock.file, workerData.ownerToken); parentPort.close(); }
      }).catch(() => { try { store.close(); } catch {} releaseWriterLock(lock.file, workerData.ownerToken); parentPort.close(); });
    });
    parentPort.on('close', () => { try { store.close(); } catch {} releaseWriterLock(lock.file, workerData.ownerToken); });
  } catch (error) {
    if (store) try { store.close(); } catch {}
    if (lock) releaseWriterLock(lock.file, workerData.ownerToken);
    parentPort.postMessage({ type: 'ready', result: fail(error.code?.startsWith('MEMORY_') ? error.code : 'MEMORY_BACKEND_UNSUPPORTED', error.code?.startsWith('MEMORY_') ? error.message : 'The worker cannot initialize its SQLite backend.', error.hint) });
    parentPort.close();
  }
}
