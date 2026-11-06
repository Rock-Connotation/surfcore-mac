// Share the same QQ config path and DSH port discovery as the running plugin.
import fs from 'node:fs';
import { QQ_CONFIG } from '../plugins/surfcore/lib/paths.js';
import { discoverDshBaseUrl, isLoopbackBaseUrl } from './dsh-port.js';

export class SelfTestTargetError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function validUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function resolveSelfTestTarget({ cliUrl, env = process.env, configPath = QQ_CONFIG, discover = discoverDshBaseUrl } = {}) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new SelfTestTargetError('SELF_TEST_CONFIG_INVALID', '自测配置无法读取或解析。', '检查 SurfCore 的 config.json 格式和读取权限后重试。');
  }
  const explicit = cliUrl !== undefined ? String(cliUrl).trim() : String(env.DSH_WEB_URL ?? '').trim();
  let selected = explicit;
  if (!selected && cliUrl === undefined) {
    const configured = String(config.dsh?.baseUrl ?? '').trim();
    if (validUrl(configured) && !isLoopbackBaseUrl(configured)) selected = configured;
    else {
      let found = null;
      try { found = await discover(); } catch { /* config fallback below */ }
      selected = validUrl(found) ? String(found).trim() : configured;
    }
  }
  if (!validUrl(selected)) throw new SelfTestTargetError('SELF_TEST_TARGET_INVALID', '没有可用的 DSH 自测地址。', '传入有效的 HTTP(S) 地址，或设置 DSH_WEB_URL / config.json 中的 dsh.baseUrl 后重试。');
  const dsh = config.dsh ?? {};
  return {
    baseUrl: selected.replace(/\/+$/, ''),
    auth: { token: dsh.authToken || '', header: dsh.authHeader, prefix: dsh.authPrefix, allowRemote: dsh.allowRemote === true, tokenExplicit: Boolean(dsh.authToken) },
  };
}

export async function loadSelfTestClient(loader = () => import('./dsh-client.js')) {
  try { return await loader(); } catch {
    throw new SelfTestTargetError('SELF_TEST_DEPENDENCY_MISSING', '自测所需的 DSH 客户端依赖无法加载。', '在 SurfCore 安装目录按锁文件安装依赖后重试。');
  }
}
