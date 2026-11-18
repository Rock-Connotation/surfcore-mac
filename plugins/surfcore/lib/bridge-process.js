import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// macOS `ps` uses the inherited locale to decide whether non-ASCII argv is
// printed verbatim or VISUAL-escaped (`M-fM-!...`). Under `LC_ALL=C` a bridge
// installed in a Chinese/space path would look like another process and be
// refused as BRIDGE_OWNER_UNVERIFIED. Pin a verified UTF-8 locale for the
// metadata query only; executable, argv, port and lock checks stay unchanged.
let darwinUtf8Locale;
function darwinPsEnv(platform, execFile) {
  if (platform !== 'darwin') return undefined;
  if (darwinUtf8Locale === undefined) {
    darwinUtf8Locale = '';
    if (execFile === execFileSync) {
      try {
        const available = new Set(execFile('/usr/bin/locale', ['-a'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/));
        darwinUtf8Locale = ['en_US.UTF-8', 'C.UTF-8'].find((name) => available.has(name)) ?? '';
      } catch {}
    }
  }
  const locale = darwinUtf8Locale || 'en_US.UTF-8';
  return { ...process.env, LC_ALL: locale, LANG: locale };
}

// Only compare the exact executable and argv that our launcher creates. Never
// parse or execute a process's command line as shell input.
export function inspectBridgeProcess({ pid, port, runtime, script, platform = process.platform, execFile = execFileSync, fileSystem = fs }) {
  try {
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return false;
    const real = p => fileSystem.realpathSync(p);
    const executable = real(runtime.executable);
    const target = real(script);
    const ownsListener = (binary) => {
      const lines = execFile(binary, ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'] }).split('\n');
      return lines.some(line => line === `n127.0.0.1:${port}` || line === `n*:${port}`);
    };
    if (platform === 'darwin') {
      const ps = (column) => execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', column], { encoding:'utf8', timeout:3000, stdio:['ignore','pipe','ignore'], env: darwinPsEnv(platform, execFile) }).trim();
      const comm = ps('comm=');
      if (!comm || real(comm) !== executable) return false;
      const actual = ps('args=');
      const candidates = [comm, runtime.executable, executable];
      const prefixes = runtime.argvPrefix || [];
      const scripts = [script, target];
      if (!candidates.some(exe => scripts.some(file => actual === [exe, ...prefixes, file].join(' ')))) return false;
      return ownsListener('/usr/sbin/lsof');
    }
    if (platform === 'linux') {
      const exe = real(`/proc/${pid}/exe`);
      const args = fileSystem.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (exe !== executable || args.length !== 2 + (runtime.argvPrefix || []).length) return false;
      if (real(args[0]) !== executable || real(args.at(-1)) !== target) return false;
      if ((runtime.argvPrefix || []).some((v,i) => args[i+1] !== v)) return false;
      // Missing lsof is deliberately an unknown identity, never permission to kill.
      const lsof = ['/usr/bin/lsof', '/usr/sbin/lsof'].find(p => fileSystem.existsSync(p));
      return lsof ? ownsListener(lsof) : false;
    }
    return false;
  } catch { return false; }
}
