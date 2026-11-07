import { spawn as nodeSpawn } from 'node:child_process';
import { fail } from './errors.js';

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const TERM_WAIT_MS = 1200;
const KILL_WAIT_MS = 1200;

function collectTail(current, chunk, limit) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChild(child, closePromise, { termWaitMs = TERM_WAIT_MS, killWaitMs = KILL_WAIT_MS } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { terminated: true };
  try { child.kill('SIGTERM'); } catch {}
  const termResult = await Promise.race([closePromise.then(() => 'closed'), wait(termWaitMs).then(() => 'timeout')]);
  if (termResult === 'closed') return { terminated: true };
  try { child.kill('SIGKILL'); } catch {}
  const killResult = await Promise.race([closePromise.then(() => 'closed'), wait(killWaitMs).then(() => 'timeout')]);
  return { terminated: killResult === 'closed' };
}

export async function runProcess(executable, args, {
  spawnImpl = nodeSpawn,
  cwd,
  env,
  signal,
  timeoutMs = 0,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  onChild,
  stage = 'process',
  termWaitMs = TERM_WAIT_MS,
  killWaitMs = KILL_WAIT_MS,
} = {}) {
  if (typeof executable !== 'string' || !executable.startsWith('/')) {
    throw fail('RUNTIME_UNAVAILABLE', 'The configured executable path is invalid.', 'Choose an absolute path to the verified local runtime or media tool.', { stage });
  }
  if (signal?.aborted) throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage });

  let child;
  try {
    child = spawnImpl(executable, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw fail('RUNTIME_UNAVAILABLE', 'The configured local executable could not start.', 'Check that the selected executable exists and is runnable for this Mac.', { retryable: true, stage, cause: error });
  }
  onChild?.(child);

  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let spawnError = null;
  const closePromise = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signalName) => resolve({ code, signal: signalName }));
    child.stdout?.on('data', (chunk) => { stdout = collectTail(stdout, chunk, outputLimit); });
    child.stderr?.on('data', (chunk) => { stderr = collectTail(stderr, chunk, outputLimit); });
  });

  let timedOut = false;
  let timeoutHandle = null;
  let abortPromise = null;
  const onAbort = () => {
    if (!abortPromise) abortPromise = terminateChild(child, closePromise, { termWaitMs, killWaitMs });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs > 0) timeoutHandle = setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs);

  try {
    const close = await closePromise;
    if (abortPromise) await abortPromise;
    if (timedOut) {
      throw fail('JOB_TIMEOUT', 'The local process exceeded its time limit.', 'Retry the job or use a shorter requested range after checking local system load.', { retryable: true, stage });
    }
    if (signal?.aborted) {
      throw fail('ASR_CANCELLED', 'The job was cancelled.', 'Submit a new ASR job if this audio is still needed.', { stage });
    }
    if (spawnError) {
      throw fail('RUNTIME_UNAVAILABLE', 'The configured local executable could not start.', 'Check the selected runtime or media-tool path and executable permissions.', { retryable: true, stage, cause: spawnError });
    }
    return {
      code: close.code,
      signal: close.signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    signal?.removeEventListener('abort', onAbort);
    onChild?.(null);
  }
}

export async function stopOwnedProcess(child, closePromise, options) {
  return await terminateChild(child, closePromise, options);
}
