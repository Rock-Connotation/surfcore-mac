import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = (code, error, hint = '检查Host当前控制状态并重新发布路由；不要因为Host暂时不可用而切回旧上下文。') => ({ ok: false, code, error, hint });
const ROUTE_VERSION = 1;

export function deriveMemoryProviderRouteId({ provider, model } = {}) {
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  if (!valid(provider) || !valid(model)) return fail('MEMORY_PROVIDER_ROUTE_REQUIRED', '缺少实际选择的模型供应方或模型标识。', '在当前入口明确选择模型，并批准该精确路由；不要继承默认值或回退模型的授权。');
  const hash = createHash('sha256').update(JSON.stringify({ provider, model }), 'utf8').digest('hex');
  return { ok: true, providerRouteId: `dsh-route:${hash}` };
}
function descriptor(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('protected routing required');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['schemaVersion', 'backend', 'controlRevision', 'storeGeneration', 'minCompatibleReader'].includes(key))) throw new Error('invalid routing fields');
  if (value.schemaVersion !== ROUTE_VERSION || !['v1', 'v2'].includes(value.backend) || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0
    || !Number.isSafeInteger(value.minCompatibleReader) || value.minCompatibleReader < 1 || typeof value.storeGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.storeGeneration)) throw new Error('invalid routing');
  return value;
}
export function readMemoryRouting({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) return fail('MEMORY_ROUTING_INVALID', '缺少Host解析的持久状态目录。');
  const file = path.join(stateDir, 'memory-v2', 'routing.json');
  try {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('protected routing directory required');
    const route = descriptor(file);
    if (route.minCompatibleReader > ROUTE_VERSION) return fail('MEMORY_READER_UNSUPPORTED', '当前程序不支持控制库要求的读取版本。', '升级到兼容版本后重试，不降级读取旧卡或会话。');
    if (route.backend === 'v2' && !fs.existsSync(path.join(stateDir, 'memory-control.sqlite'))) return fail('MEMORY_CONTROL_UNAVAILABLE', 'V2路由仍生效，但当前控制库缺失。');
    return { ok: true, backend: route.backend, descriptor: route };
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(file) && !fs.existsSync(path.join(stateDir, 'memory-control.sqlite'))) return { ok: true, backend: 'v1', descriptor: null, source: 'legacy-default' };
    return fail('MEMORY_ROUTING_INVALID', '持久记忆路由缺失、损坏或权限不正确。');
  }
}

/** Host-only publication from a successfully read current control snapshot. */
export function writeMemoryRouting({ stateDir, status, allowDowngrade = false } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || status?.ok !== true) return fail('MEMORY_ROUTING_INVALID', 'Host尚未确认当前控制库，不能发布路由。');
  const dir = path.join(stateDir, 'memory-v2'), file = path.join(dir, 'routing.json');
  const route = { schemaVersion: ROUTE_VERSION, backend: status.activeBackend, controlRevision: status.revision,
    storeGeneration: status.storeGeneration, minCompatibleReader: status.minCompatibleReader ?? ROUTE_VERSION };
  if (!['v1', 'v2'].includes(route.backend) || !Number.isSafeInteger(route.controlRevision) || route.controlRevision < 0
    || !Number.isSafeInteger(route.minCompatibleReader) || route.minCompatibleReader < 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(route.storeGeneration ?? '')) return fail('MEMORY_ROUTING_INVALID', 'Host控制快照的路由字段无效。');
  let fd, published = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) || fs.lstatSync(dir).isSymbolicLink()) {
      if (fs.lstatSync(dir).isSymbolicLink()) return fail('MEMORY_ROUTING_INVALID', '路由目录不能是符号链接。');
      const prior = descriptor(file);
      if (route.controlRevision < prior.controlRevision) return fail('MEMORY_ROUTING_ROLLBACK', '当前控制修订落后于已发布路由，拒绝覆盖。');
      if (prior.backend === 'v2' && route.backend === 'v1' && !allowDowngrade) return fail('MEMORY_ROUTING_ROLLBACK', 'V2路由不能在启动或故障时自动退回V1。', '先完成有授权的兼容回滚、会话清退与数据保全，再发布回滚路由。');
      if (JSON.stringify(prior) === JSON.stringify(route)) return { ok: true, backend: route.backend, descriptor: route, unchanged: true };
    }
    const temp = path.join(dir, `.routing-${randomUUID()}.tmp`), bytes = Buffer.from(JSON.stringify(route) + '\n');
    fd = fs.openSync(temp, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error('no write progress'); offset += count; }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file); published = true;
    if (process.platform !== 'win32') { const handle = fs.openSync(dir, 'r'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
    return { ok: true, backend: route.backend, descriptor: route };
  } catch {
    return fail(published ? 'MEMORY_ROUTING_COMMIT_UNKNOWN' : 'MEMORY_ROUTING_WRITE_FAILED', published ? '路由可能已经发布，但持久确认失败。' : '路由未能持久发布。');
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
