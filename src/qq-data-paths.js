import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstallationIdentity, INSTALL_IDENTITY_FILE } from './install-identity.js';

export class QqDataPathError extends Error {
  constructor(code, message, hint) { super(`${code}：${message} 下一步：${hint}`); this.code = code; this.error = message; this.hint = hint; }
}

function explicitLegacyRoot(env) {
  for (const value of [env.SURFCORE_ROOT, env.SURFCORE_QQBOT_ROOT, env.QQBILI_QQBOT_ROOT]) {
    if (!value) continue;
    const root = path.resolve(value);
    if (fs.existsSync(path.join(root, 'config.json')) && fs.existsSync(path.join(root, 'src', 'bridge.js'))) return root;
  }
  return null;
}

function hasLegacyData(root) {
  for (const name of ['config.json', 'state', 'roles']) {
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isDirectory() || fs.readdirSync(file).length > 0) return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new QqDataPathError('QQ_PACKAGE_DATA_CHECK_FAILED', '无法检查旧包目录中的 QQ 数据。', '检查包目录读取权限，保留现有数据后重试。');
    }
  }
  return false;
}

/** Code stays under programRoot; only mutable QQ data moves for package installs. */
export function resolveQqDataPaths({ programRoot, env = process.env, dshHome } = {}) {
  const root = path.resolve(programRoot);
  const explicit = explicitLegacyRoot(env);
  const identity = readInstallationIdentity(root);
  if (!identity.ok && fs.existsSync(path.join(root, INSTALL_IDENTITY_FILE))) {
    throw new QqDataPathError('QQ_INSTALL_IDENTITY_INVALID', '无法验证 SurfCore 安装身份。', '检查 .surfcore-install.json 和包版本；不要覆盖现有数据。');
  }
  const isPackage = identity.ok && identity.identity.kind === 'package';
  if (isPackage && !explicit && hasLegacyData(root)) {
    throw new QqDataPathError('QQ_PACKAGE_LEGACY_DATA_FOUND', '旧包目录中存在 QQ 配置、状态或角色数据，已停止切换数据目录。', '先备份并保留旧安装；将 SURFCORE_ROOT 指向保留的完整旧安装后重试，勿删除或自动迁移数据。');
  }
  const home = dshHome || env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh');
  const dataRoot = explicit || (isPackage ? path.join(home, 'surfcore', 'qq') : root);
  return { programRoot: root, dataRoot, config: path.join(dataRoot, 'config.json'), stateDir: path.join(dataRoot, 'state'), personaDir: path.join(dataRoot, 'roles'), installationKind: isPackage ? 'package' : 'source', kind: explicit ? 'explicit-legacy' : isPackage ? 'package' : 'source' };
}
