import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MIN_NODE = [22, 13];
const probeCache = new Map();
const PROBE_SCRIPT = `
const capabilities = {
  esm: typeof import.meta.url === 'string',
  fetch: typeof fetch === 'function',
  abortSignalTimeout: typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function',
  webSocket: typeof WebSocket === 'function',
};
console.log(JSON.stringify({
  version: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  capabilities,
}));
`;

export class NodeRuntimeError extends Error {
  constructor(code, message, hint, details = {}) {
    super(message);
    this.name = 'NodeRuntimeError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export function isNodeExe(file) {
  return /^node(?:js)?(?:\.exe)?$/i.test(path.basename(String(file ?? '')));
}

function versionParts(version) {
  const match = String(version ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function nodeVersionEnough(version) {
  const parts = versionParts(version);
  if (!parts) return false;
  return parts[0] > MIN_NODE[0] || (parts[0] === MIN_NODE[0] && parts[1] >= MIN_NODE[1]);
}

function absoluteCandidate(file) {
  return path.resolve(String(file ?? '').trim());
}

function realPath(file, fsApi) {
  try { return fsApi.realpathSync.native?.(file) ?? fsApi.realpathSync(file); } catch { return file; }
}

function fileIdentity(file, fsApi) {
  try {
    const stat = fsApi.statSync(file);
    if (!stat.isFile()) return null;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function checkExecutable(file, { platform, fsApi }) {
  const absolute = absoluteCandidate(file);
  try {
    const stat = fsApi.statSync(absolute);
    if (!stat.isFile()) return { ok: false, reason: '不是普通文件' };
    if (platform !== 'win32') fsApi.accessSync(absolute, fs.constants.X_OK);
    return { ok: true, executable: realPath(absolute, fsApi) };
  } catch (error) {
    return { ok: false, reason: error?.code === 'EACCES' ? '没有执行权限' : '文件不存在或不可执行' };
  }
}

function runNodeProbe(candidate, {
  env,
  spawnSyncImpl = spawnSync,
  timeoutMs = 1800,
  fsApi = fs,
}) {
  const identity = fileIdentity(candidate.executable, fsApi);
  const cacheKey = identity
    ? `${candidate.executable}\0${identity}\0${JSON.stringify(candidate.envPatch)}`
    : '';
  if (cacheKey && probeCache.has(cacheKey)) return probeCache.get(cacheKey);

  const childEnv = { ...env, ...candidate.envPatch };
  const result = spawnSyncImpl(candidate.executable, [
    ...candidate.argvPrefix,
    '--input-type=module', '-e', PROBE_SCRIPT,
  ], {
    env: childEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  let probe = null;
  const outputLines = String(result?.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (!result?.error && result?.status === 0 && outputLines.length) {
    try { probe = JSON.parse(outputLines.at(-1)); } catch {}
  }
  let reason = '';
  if (result?.error) reason = `探测失败：${result.error.message}`;
  else if (result?.status !== 0) reason = `探测进程退出码 ${result?.status ?? '未知'}`;
  else if (!probe?.version || !probe?.platform || !probe?.arch || !probe?.capabilities) reason = '没有返回有效的运行时信息';
  else if (!nodeVersionEnough(probe.version)) reason = `版本 ${probe.version} 低于要求 v22.13.0`;
  else if (probe.platform !== candidate.platform) reason = `平台不匹配：返回 ${probe.platform}，当前为 ${candidate.platform}`;
  else {
    const missing = ['esm', 'fetch', 'abortSignalTimeout', 'webSocket'].filter((name) => probe.capabilities[name] !== true);
    if (missing.length) reason = `缺少能力：${missing.join(', ')}`;
  }

  const checked = reason
    ? { ok: false, reason, stdout: String(result?.stdout ?? '').slice(-500), stderr: String(result?.stderr ?? '').slice(-500) }
    : { ok: true, ...probe };
  if (cacheKey) probeCache.set(cacheKey, checked);
  return checked;
}

function uniqueCandidates(items, platform) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.path) return false;
    const file = absoluteCandidate(item.path);
    const key = platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
    item.path = file;
    return true;
  });
}

function bundledNodeCandidates({ execPath, resourcesPath, platform }) {
  const executableDir = path.dirname(absoluteCandidate(execPath));
  const roots = [resourcesPath];
  if (platform === 'darwin') {
    // Electron's process.execPath is normally Contents/MacOS/<app>; resources are its sibling.
    roots.push(path.resolve(executableDir, '..', 'Resources'));
    roots.push(path.resolve(executableDir, '..', 'resources'));
  }
  roots.push(path.join(executableDir, 'resources'));
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe'];
  const items = [];
  for (const root of roots.filter(Boolean)) {
    for (const name of names) {
      items.push({
        path: path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', name),
        source: 'app-resources', kind: 'node', argvPrefix: [], envPatch: {},
      });
    }
  }
  return items;
}

function cachedNodeCandidates({ dshHome, home, platform }) {
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe'];
  const roots = [dshHome, path.join(home, '.dsh')];
  const items = [];
  for (const root of roots) {
    for (const name of names) {
      items.push({
        path: path.join(root, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', name),
        source: root === dshHome ? 'dsh-home-cache' : 'default-dsh-cache',
        kind: 'node', argvPrefix: [], envPatch: {},
      });
    }
  }
  return items;
}

function systemNodeCandidates({ env, platform, programFiles }) {
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['node.exe', 'node'] : ['node', 'nodejs'];
  const items = [];
  for (const directory of String(env.PATH ?? '').split(pathDelimiter).filter(Boolean)) {
    for (const name of names) items.push({
      path: path.join(directory, name), source: 'path', kind: 'node', argvPrefix: [], envPatch: {},
    });
  }

  const common = platform === 'darwin'
    ? ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/local/bin/node', '/usr/bin/node']
    : platform === 'win32'
      ? [/\.exe$/i.test(programFiles) ? programFiles : path.join(programFiles, 'nodejs', 'node.exe'), env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '']
      : ['/usr/local/bin/node', '/usr/bin/node', '/opt/node/bin/node'];
  for (const candidate of common.filter(Boolean)) {
    items.push({ path: candidate, source: 'system-location', kind: 'node', argvPrefix: [], envPatch: {} });
  }
  return items;
}

function runtimeFailure(reason, candidate) {
  return {
    code: candidate.source === 'dsh-node-override' ? 'NODE_RUNTIME_OVERRIDE_INVALID' : 'NODE_RUNTIME_CANDIDATE_INVALID',
    message: `${candidate.source === 'dsh-node-override' ? 'DSH_NODE 指定的运行时' : '候选运行时'}不可用：${candidate.path}（${reason}）`,
  };
}

/**
 * Resolve and verify the actual Node runtime used by child processes.
 *
 * The returned descriptor is the shared contract for Host children and Agent command text.
 * DSH_NODE is an explicit choice: when set but invalid, the resolver fails instead of silently
 * selecting another Node version.
 */
export function resolveNodeRuntime({
  execPath = process.execPath,
  env = process.env,
  home = env.USERPROFILE || env.HOME || os.homedir(),
  dshHome = env.DSH_HOME || path.join(home, '.dsh'),
  platform = process.platform,
  resourcesPath = process.resourcesPath || '',
  programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files\\nodejs\\node.exe',
  electronVersion = process.versions.electron || '',
  spawnSyncImpl = spawnSync,
  probe = null,
  fsApi = fs,
} = {}) {
  const explicit = String(env.DSH_NODE ?? '').trim();
  const candidates = [];
  if (explicit) {
    candidates.push({ path: explicit, source: 'dsh-node-override', kind: 'node', argvPrefix: [], envPatch: {} });
  } else {
    candidates.push(...bundledNodeCandidates({ execPath, resourcesPath, platform }));
    candidates.push(...cachedNodeCandidates({ dshHome, home, platform }));

    if (isNodeExe(execPath) && !electronVersion) {
      candidates.push({ path: execPath, source: 'current-node-process', kind: 'node', argvPrefix: [], envPatch: {} });
    } else if (electronVersion) {
      candidates.push({
        path: execPath,
        source: 'electron-node-mode',
        kind: 'electron-node-mode',
        argvPrefix: [],
        envPatch: { ELECTRON_RUN_AS_NODE: '1' },
      });
    }
    candidates.push(...systemNodeCandidates({ env, platform, programFiles }));
  }

  const failures = [];
  for (const candidate of uniqueCandidates(candidates, platform)) {
    candidate.platform = platform;
    const checkedFile = checkExecutable(candidate.path, { platform, fsApi });
    if (!checkedFile.ok) {
      const failure = runtimeFailure(checkedFile.reason, candidate);
      failures.push({ source: candidate.source, path: candidate.path, reason: checkedFile.reason });
      if (candidate.source === 'dsh-node-override') {
        throw new NodeRuntimeError(failure.code, failure.message,
          '检查 DSH_NODE 是否指向可执行的 Node v22.13.0 或更高版本；清除该变量后重试也会重新执行运行时发现。',
          { candidates: failures });
      }
      continue;
    }

    candidate.executable = checkedFile.executable;
    const result = probe
      ? probe(candidate, { env: { ...env, ...candidate.envPatch }, fsApi })
      : runNodeProbe(candidate, { env, spawnSyncImpl, fsApi });
    if (!result?.ok) {
      const reason = String(result?.reason || 'Node 子进程能力探测失败');
      failures.push({ source: candidate.source, path: candidate.path, reason });
      if (candidate.source === 'dsh-node-override') {
        throw new NodeRuntimeError('NODE_RUNTIME_OVERRIDE_INVALID',
          `DSH_NODE 指定的运行时不可用：${candidate.path}（${reason}）`,
          '确认路径指向可运行的 Node v22.13.0 或更高版本，并支持 ESM、fetch、AbortSignal.timeout 和 WebSocket。',
          { candidates: failures });
      }
      continue;
    }

    return {
      executable: candidate.executable,
      argvPrefix: [...candidate.argvPrefix],
      envPatch: { ...candidate.envPatch },
      kind: candidate.kind,
      version: String(result.version),
      platform: String(result.platform),
      arch: String(result.arch),
      source: candidate.source,
      capabilities: { ...result.capabilities },
    };
  }

  throw new NodeRuntimeError('NODE_RUNTIME_NOT_FOUND',
    '没有找到通过版本与能力探测的 Node 运行时。',
    '设置 DSH_NODE 指向 Node v22.13.0 或更高版本，或检查 DSH Desktop 内置运行时与 PATH。',
    { candidates: failures });
}

/** Compatibility path API for existing callers; new child execution should pass the descriptor. */
export function findNodeExe(options = {}) {
  return resolveNodeRuntime(options).executable;
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Build shell text for the same executable, argv prefix, and child-scoped environment. */
export function nodeRuntimeCommand(runtime, scriptPath, args = [], { platform = process.platform } = {}) {
  if (!runtime?.executable) throw new NodeRuntimeError(
    'NODE_RUNTIME_COMMAND_UNAVAILABLE',
    '无法生成 Agent 命令：Node 运行时尚未就绪。',
    '先修复 Node 运行时诊断，再重试该工具命令。',
  );
  const values = [runtime.executable, ...(runtime.argvPrefix || []), path.resolve(scriptPath), ...args.map(String)];
  if (platform === 'win32') {
    const command = values.map(powershellQuote).join(' ');
    const patch = Object.entries(runtime.envPatch || {});
    if (!patch.length) return `& ${command}`;
    for (const [key] of patch) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new NodeRuntimeError(
      'NODE_RUNTIME_ENV_INVALID', 'Node 运行时环境变量名称无效。', '移除无效的运行时环境覆盖后重试。',
    );
    const save = patch.map(([key], i) => `$oldEnv${i} = [Environment]::GetEnvironmentVariable(${powershellQuote(key)}, 'Process')`).join('; ');
    const assignments = patch.map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`).join('; ');
    const restore = patch.map(([key], i) => `[Environment]::SetEnvironmentVariable(${powershellQuote(key)}, $oldEnv${i}, 'Process')`).join('; ');
    return `& { ${save}; ${assignments}; try { & ${command} } finally { ${restore} } }`;
  }

  const assignments = Object.entries(runtime.envPatch || {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new NodeRuntimeError(
      'NODE_RUNTIME_ENV_INVALID', 'Node 运行时环境变量名称无效。', '移除无效的运行时环境覆盖后重试。',
    );
    return `${key}=${posixQuote(value)}`;
  });
  return `${assignments.length ? `${assignments.join(' ')} ` : ''}${values.map(posixQuote).join(' ')}`;
}
