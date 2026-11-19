// Isolated Chrome DevTools MCP stdio launcher for SurfCore local desktop tasks.
// Launches Google chrome-devtools-mcp with a dedicated Chrome user-data directory
// (default <DSH_HOME>/surfcore/chrome-profile) so automated tasks never attach to
// or mutate the user's personal logged-in Chrome browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function expandHome(input, home) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

function sameOrInside(target, base) {
  const normTarget = process.platform === 'linux' ? path.resolve(target) : path.resolve(target).toLowerCase();
  const normBase = process.platform === 'linux' ? path.resolve(base) : path.resolve(base).toLowerCase();
  const rel = path.relative(normBase, normTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveNearestExistingRealpath(target) {
  const resolved = path.resolve(target);
  const tail = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync(cursor), ...tail);
  } catch {
    return resolved;
  }
}

export function personalChromeProfileRoots({ home = os.homedir(), localAppData = process.env.LOCALAPPDATA || '' } = {}) {
  const roots = [
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    path.join(home, 'Library', 'Application Support', 'Chromium'),
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
  ];
  if (localAppData) roots.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
  return roots;
}

export function isPersonalChromeDir(targetPath, opts = {}) {
  const resolved = path.resolve(targetPath);
  const realTarget = resolveNearestExistingRealpath(resolved);
  for (const root of personalChromeProfileRoots(opts)) {
    if (sameOrInside(resolved, root) || sameOrInside(realTarget, root)) return true;
  }
  return false;
}

function readConfiguredProfileDir(dshHome) {
  const configFile = path.join(dshHome, 'surfcore', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const dir = parsed?.localTask?.chromeProfileDir;
    return typeof dir === 'string' ? dir.trim() : '';
  } catch {
    return '';
  }
}

export function resolveChromeProfileDir({ env = process.env, home = os.homedir(), dshHome } = {}) {
  const effectiveDshHome = dshHome || env.DSH_HOME || path.join(home, '.dsh');
  const raw = String(env.SURFCORE_CHROME_PROFILE_DIR ?? '').trim()
    || readConfiguredProfileDir(effectiveDshHome)
    || path.join(effectiveDshHome, 'surfcore', 'chrome-profile');
  const resolved = path.resolve(expandHome(raw, home));
  if (isPersonalChromeDir(resolved, { home, localAppData: env.LOCALAPPDATA || '' })) {
    const err = new Error('CHROME_PROFILE_PERSONAL_FORBIDDEN: chromeProfileDir cannot point to your personal Chrome User Data directory.');
    err.code = 'CHROME_PROFILE_PERSONAL_FORBIDDEN';
    err.hint = 'Use the dedicated isolated folder (default <DSH_HOME>/surfcore/chrome-profile) instead.';
    throw err;
  }
  return resolved;
}

function parseSemverTuple(version) {
  return String(version || '0.0.0').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
}

function compareSemver(a, b) {
  const pa = parseSemverTuple(a);
  const pb = parseSemverTuple(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function resolveChromeDevtoolsPackageBinary(pkgRoot) {
  for (const rel of [
    path.join('build', 'src', 'bin', 'chrome-devtools-mcp.js'),
    path.join('out', 'Default', 'gen', 'src', 'bin', 'chrome-devtools-mcp.js'),
  ]) {
    const candidate = path.join(pkgRoot, rel);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function findCachedChromeDevtoolsBinary(parentDir) {
  let entries = [];
  try { entries = fs.readdirSync(parentDir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgRoot = path.join(parentDir, entry.name, 'node_modules', 'chrome-devtools-mcp');
    const bin = resolveChromeDevtoolsPackageBinary(pkgRoot);
    if (!bin) continue;
    let version = '0.0.0';
    try {
      version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version || '0.0.0';
    } catch {}
    if (!best || compareSemver(version, best.version) > 0) best = { bin, version };
  }
  return best?.bin || null;
}

export function resolveChromeDevtoolsCommand({ repoRoot, env = process.env, home = os.homedir(), dshHome } = {}) {
  const explicit = String(env.SURFCORE_CHROME_DEVTOOLS_BIN ?? '').trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    try {
      if (fs.statSync(resolved).isFile()) return { command: process.execPath, prefixArgs: [resolved] };
    } catch {}
    const err = new Error(`CHROME_DEVTOOLS_BIN_INVALID: SURFCORE_CHROME_DEVTOOLS_BIN does not exist: ${resolved}`);
    err.code = 'CHROME_DEVTOOLS_BIN_INVALID';
    err.hint = 'Clear SURFCORE_CHROME_DEVTOOLS_BIN or point it to a valid chrome-devtools-mcp executable script.';
    throw err;
  }

  const localBin = resolveChromeDevtoolsPackageBinary(path.join(repoRoot, 'node_modules', 'chrome-devtools-mcp'));
  if (localBin) return { command: process.execPath, prefixArgs: [localBin] };

  const npmCache = env.NPM_CONFIG_CACHE || env.npm_config_cache || path.join(home, '.npm');
  const effectiveDshHome = dshHome || env.DSH_HOME || path.join(home, '.dsh');
  const cachedBin = findCachedChromeDevtoolsBinary(path.join(npmCache, '_npx'))
    || findCachedChromeDevtoolsBinary(path.join(effectiveDshHome, 'dsh-runtimes', 'desktop-mcp-local'));
  if (cachedBin) return { command: process.execPath, prefixArgs: [cachedBin] };

  if (String(env.QQ_BRIDGE_TEST_LIVE ?? '') === '0') {
    const err = new Error(
      'chrome-devtools-mcp binary not found in offline test mode; refusing network npx fetch',
    );
    err.code = 'CHROME_DEVTOOLS_NOT_INSTALLED';
    throw err;
  }

  const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npxCandidates = [
    path.join(path.dirname(process.execPath), npxName),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/npx', '/usr/local/bin/npx'] : []),
  ];
  const resolvedNpx = npxCandidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  return {
    command: resolvedNpx || npxName,
    prefixArgs: ['-y', '--quiet', '--prefer-offline', 'chrome-devtools-mcp@latest'],
  };
}

const UNSAFE_CONNECT_FLAG_RE = /^--?(?:auto[-_]?connect|browser[-_]?url|ws[-_]?endpoint|u|w)(?:=|$)/i;

export function buildChromeDevtoolsArgs({ profileDir, extraArgs = [], env = process.env } = {}) {
  for (const arg of extraArgs) {
    if (UNSAFE_CONNECT_FLAG_RE.test(String(arg ?? '').trim())) {
      const err = new Error(`CHROME_DEVTOOLS_CONNECT_FORBIDDEN: Disallowed Chrome connection flag (${arg}); dedicated isolated profile is enforced.`);
      err.code = 'CHROME_DEVTOOLS_CONNECT_FORBIDDEN';
      err.hint = 'Remove personal browser connection flags so Chrome launches inside the isolated SurfCore profile.';
      throw err;
    }
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    '--channel=stable',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--viewport=1280x800',
  ];
  if (env.SURFCORE_CHROME_HEADLESS === '1') args.push('--headless=true');
  args.push(...extraArgs);
  return args;
}

function main() {
  const selfPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(selfPath), '..');
  let profileDir;
  let launch;
  let serverArgs;
  try {
    profileDir = resolveChromeProfileDir();
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    launch = resolveChromeDevtoolsCommand({ repoRoot });
    serverArgs = buildChromeDevtoolsArgs({ profileDir, extraArgs: process.argv.slice(2) });
  } catch (error) {
    const code = error?.code || 'CHROME_DEVTOOLS_LAUNCH_FAILED';
    const message = error?.message || String(error);
    const hint = error?.hint || 'Check Node, Chrome Stable, and SurfCore chromeProfileDir settings.';
    process.stderr.write(`[mcp-chrome-devtools] ${code}: ${message}\nNext: ${hint}\n`);
    process.exit(1);
    return;
  }

  const cmdDir = path.isAbsolute(launch.command) ? path.dirname(launch.command) : '';
  const currentPath = process.env.PATH || '';
  const nextPath = cmdDir && !currentPath.split(path.delimiter).includes(cmdDir)
    ? [cmdDir, currentPath].filter(Boolean).join(path.delimiter)
    : currentPath;

  const child = spawn(launch.command, [...launch.prefixArgs, ...serverArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ...(nextPath ? { PATH: nextPath } : {}),
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '4000',
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    },
  });

  const forwardSignal = (signal) => {
    try { child.kill(signal); } catch {}
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', (error) => {
    process.stderr.write(`[mcp-chrome-devtools] CHROME_DEVTOOLS_SPAWN_ERROR: ${error?.message || error}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

try {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    main();
  }
} catch {}
