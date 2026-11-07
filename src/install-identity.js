import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const INSTALL_IDENTITY_FILE = '.surfcore-install.json';
export const INSTALL_IDENTITY_SCHEMA = 1;
export const DEFAULT_SOURCE_REPO = 'Rock-Connotation/surfcore-mac';

const INITIALIZE_HINT = '源码安装请在仓库根目录显式运行：node scripts/initialize-install-identity.mjs；初始化不会自动执行或改动用户数据。';

function failure(code, error, hint = INITIALIZE_HINT, extra = {}) {
  return { ok: false, code, error, hint, ...extra };
}

function readPackage(root) {
  const file = path.join(root, 'package.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.name !== 'surfcore' || !String(value?.version ?? '').trim()) {
      return failure('identity.package-invalid', '当前目录的 package.json 不是有效的 SurfCore 安装', INITIALIZE_HINT, { file });
    }
    return { ok: true, value, file };
  } catch (error) {
    return failure('identity.package-unreadable', `无法读取安装版本：${String(error?.message ?? error).slice(0, 160)}`, INITIALIZE_HINT, { file });
  }
}

export function canonicalInstallRoot(root) {
  const raw = String(root ?? '').trim();
  if (!raw) return '';
  try { return fs.realpathSync(path.resolve(raw)); } catch { return path.resolve(raw); }
}

function sameInstallRoot(a, b) {
  const left = canonicalInstallRoot(a);
  const right = canonicalInstallRoot(b);
  if (!left || !right) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function readInstallationIdentity(root) {
  const installRoot = canonicalInstallRoot(root);
  if (!installRoot) return failure('identity.missing-root', '安装根目录为空');
  const pkg = readPackage(installRoot);
  if (!pkg.ok) return pkg;

  const file = path.join(installRoot, INSTALL_IDENTITY_FILE);
  if (!fs.existsSync(file)) {
    return failure('identity.missing', `缺少安装身份文件：${INSTALL_IDENTITY_FILE}`, INITIALIZE_HINT, { file, root: installRoot, actualVersion: String(pkg.value.version) });
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.schemaVersion !== INSTALL_IDENTITY_SCHEMA
      || !['source', 'package'].includes(String(value.kind ?? ''))
      || !String(value.sourceRepo ?? '').trim()
      || !String(value.updateOwner ?? '').trim()) {
      return failure('identity.invalid', '安装身份文件格式不受支持或字段不完整', INITIALIZE_HINT, { file, root: installRoot, actualVersion: String(pkg.value.version) });
    }
    return {
      ok: true,
      identity: value,
      root: installRoot,
      file,
      actualVersion: String(pkg.value.version),
    };
  } catch (error) {
    return failure('identity.invalid', `安装身份文件无法读取：${String(error?.message ?? error).slice(0, 160)}`, INITIALIZE_HINT, { file, root: installRoot, actualVersion: String(pkg.value.version) });
  }
}

/** Explicit setup/build hook. It writes the package.json version, never a caller's stale version. */
export function writeInstallationIdentity(root, identity) {
  const installRoot = canonicalInstallRoot(root);
  if (!installRoot || !identity || typeof identity !== 'object') {
    return failure('identity.invalid', '无法写入不完整的安装身份');
  }
  const pkg = readPackage(installRoot);
  if (!pkg.ok) return pkg;
  const value = {
    ...identity,
    version: String(pkg.value.version),
    schemaVersion: INSTALL_IDENTITY_SCHEMA,
  };
  if (!['source', 'package'].includes(String(value.kind ?? ''))
    || !String(value.updateOwner ?? '').trim()
    || !String(value.sourceRepo ?? '').trim()) {
    return failure('identity.invalid', '无法写入不完整的安装身份');
  }
  const file = path.join(installRoot, INSTALL_IDENTITY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, root: installRoot, file, identity: value };
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return failure('identity.write-failed', `安装身份写入失败：${String(error?.message ?? error).slice(0, 160)}`, '检查安装目录权限后重试；身份文件未完整写入。', { file, root: installRoot });
  }
}

function githubRepoFromRemote(remote) {
  const value = String(remote ?? '').trim().replace(/\.git$/i, '');
  const match = value.match(/(?:^|[/:@])github\.com[:/]([^/]+\/[^/]+)$/i);
  return match ? match[1] : '';
}

/** Explicit, idempotent source-checkout initializer used only by the CLI setup action. */
export function initializeSourceInstallationIdentity(root, { sourceRepo = DEFAULT_SOURCE_REPO } = {}) {
  const installRoot = canonicalInstallRoot(root);
  if (!installRoot) return failure('identity.missing-root', '安装根目录为空');
  const pkg = readPackage(installRoot);
  if (!pkg.ok) return pkg;
  const file = path.join(installRoot, INSTALL_IDENTITY_FILE);
  if (fs.existsSync(file)) return failure('identity.exists', '安装身份文件已存在；为避免覆盖现有身份，初始化已停止。', '先检查现有 .surfcore-install.json；不要删除用户配置或数据。', { file, root: installRoot });

  try {
    const repoRoot = execFileSync('git', ['-C', installRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!sameInstallRoot(repoRoot, installRoot)) return failure('identity.source-root-mismatch', '当前目录不是 Git 源码仓库根目录', INITIALIZE_HINT, { root: installRoot });
    const remote = execFileSync('git', ['-C', installRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const actualRepo = githubRepoFromRemote(remote);
    if (!actualRepo || actualRepo.toLowerCase() !== String(sourceRepo).toLowerCase()) {
      return failure('identity.source-repo-mismatch', 'Git origin 与 SurfCore 官方源码仓库不匹配', '确认当前仓库来源正确后再初始化；不会更改 origin 或用户数据。', { root: installRoot });
    }
    const sourceCommit = execFileSync('git', ['-C', installRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return writeInstallationIdentity(installRoot, {
      kind: 'source',
      sourceRepo: actualRepo,
      sourceCommit,
      updateOwner: 'surfcore-updater',
    });
  } catch {
    return failure('identity.source-unverified', '无法核实当前目录的 Git 源码身份', '检查仓库是否完整且包含 origin，再显式运行 node scripts/initialize-install-identity.mjs。', { root: installRoot });
  }
}

export function validatePending(pending, { installRoot } = {}) {
  const p = pending && typeof pending === 'object' ? pending : {};
  const expectedRoot = canonicalInstallRoot(installRoot);
  if (!expectedRoot) return failure('pending.identity-missing', '没有提供可信的当前安装根目录', '由当前 Host 提供安装根后再恢复更新；旧任务保持暂停。');

  const current = readInstallationIdentity(expectedRoot);
  if (!current.ok) return { ...current, hint: current.hint || INITIALIZE_HINT };

  const targetRoot = canonicalInstallRoot(p.target);
  if (!targetRoot || !sameInstallRoot(targetRoot, expectedRoot)) {
    return failure('pending.target-mismatch', '更新任务目标目录与当前安装不一致', '旧任务已暂停并保留诊断；请从当前安装重新检查更新。');
  }
  if (current.identity.kind === 'package' && current.identity.updateOwner === 'dsh-package-manager') {
    return failure('pending.owner-managed', '当前 package 安装由 DSH 包管理器负责更新', '请在 DSH 包管理器中更新 SurfCore；此 pending 保留供诊断。');
  }

  for (const [pendingKey, identityKey] of [['sourceRepo', 'sourceRepo'], ['updateOwner', 'updateOwner'], ['installationKind', 'kind']]) {
    if (String(p[pendingKey] ?? '') !== String(current.identity[identityKey] ?? '')) {
      return failure(`pending.${pendingKey}-mismatch`, `更新任务 ${pendingKey} 与当前安装身份不一致`, '旧任务已暂停并保留诊断；请从当前安装重新检查更新。');
    }
  }
  const from = String(p.fromVersion ?? '').trim().replace(/^v/i, '');
  const actual = String(current.actualVersion ?? '').trim().replace(/^v/i, '');
  if (!from || !actual || from !== actual) {
    return failure('pending.from-version-mismatch', `更新任务来源版本与当前 package.json 不一致（当前 ${actual || '未知'}）`, '旧任务已暂停并保留诊断；请从当前安装重新检查更新。');
  }
  return { ok: true, identity: current.identity, actualVersion: current.actualVersion, installRoot: current.root };
}
