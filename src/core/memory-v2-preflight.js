// 旧记忆配置只读预检（2026-11-12，V1 退役 R07）。
//
// 为什么单独一个模块：`readMemoryRouting` 需要完整 Runtime 才能给出下一步，
// 而升级后最常见的故障恰恰是「Runtime 起不来」。这里只做文件级只读判定，
// 不启动 worker、不打开 SQLite、不写任何文件、不改权限，给出：
//   状态分类 + 机器码 + 人读原因 + 明确的下一步（含「不要做什么」）。
//
// 分类（与 W2 契约一致）：
//   fresh            路由与控制库都不存在 → 新环境，按 V2 建新状态，权限默认未批准
//   ready            路由有效且控制库存在 → 继续检查运行就绪与授权
//   retired-v1       显式 v1 路由 → 已退役，阻断业务，给出原数据保留计划
//   control-only     路由缺失但控制库存在 → 完整性/恢复状态，不是全新安装
//   route-only       路由存在但控制库缺失 → 完整性状态
//   corrupt          路由损坏/字段非法/权限不正确/符号链接
//   reader-too-new   路由要求更高的读取版本
//   unreadable       读取失败（权限、IO）——与「未配置」严格区分
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_VERSION = 1;
const ROUTE_FIELDS = ['schemaVersion', 'backend', 'controlRevision', 'storeGeneration', 'minCompatibleReader'];
const PROTECTED_HINT = '原文件一律保持不动：不要删除、不要移动、不要改权限、不要用直接改数据库的方式制造「全新安装」。';
const decision = (state, code, error, hint, extra = {}) => ({ ok: true, state, code, error, hint: `${hint}${hint.includes(PROTECTED_HINT) ? '' : ` ${PROTECTED_HINT}`}`, ...extra });

function inspectRouteFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { problem: 'protected' };
  if (process.platform !== 'win32' && (stat.mode & 0o077)) return { problem: 'permissions' };
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { problem: 'json' }; }
  if (!value || Array.isArray(value) || typeof value !== 'object') return { problem: 'shape' };
  if (Object.keys(value).some((key) => !ROUTE_FIELDS.includes(key))) return { problem: 'fields' };
  if (value.backend !== 'v2') return { value, retiredBackend: value.backend };
  if (value.schemaVersion !== ROUTE_VERSION
    || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0
    || !Number.isSafeInteger(value.minCompatibleReader) || value.minCompatibleReader < 1
    || typeof value.storeGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.storeGeneration)) return { problem: 'value' };
  return { value };
}

/**
 * 只读预检。永不抛错、永不写盘；任何读取失败都作为显式状态返回。
 * @param {{ stateDir: string }} input
 */
export function preflightMemoryConfig({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    return { ok: false, code: 'MEMORY_PREFLIGHT_INPUT_INVALID', error: '预检缺少 Host 解析的绝对状态目录。', hint: '由 Host 传入当前状态目录后重试；不会修改任何配置。' };
  }
  const dir = path.join(stateDir, 'memory-v2');
  const file = path.join(dir, 'routing.json');
  const controlFile = path.join(stateDir, 'memory-control.sqlite');

  let routeExists = false, controlExists = false;
  try {
    routeExists = fs.existsSync(file);
    controlExists = fs.existsSync(controlFile);
  } catch (error) {
    return { ok: false, code: 'MEMORY_PREFLIGHT_UNREADABLE', error: '无法读取记忆配置目录。', hint: `检查状态目录权限后重试（${error?.code ?? 'IO'}）；不要删除目录或改用全新库绕过。` };
  }

  if (!routeExists && !controlExists) {
    return decision('fresh', 'MEMORY_PREFLIGHT_FRESH', '路由与控制库都不存在：这是全新环境。',
      '按 V2 建立新状态；任何记忆访问都需要先在记忆页明确批准具体会话与精确模型。');
  }
  if (!routeExists && controlExists) {
    return decision('control-only', 'MEMORY_PREFLIGHT_CONTROL_WITHOUT_ROUTE', '控制库存在但路由文件缺失：这是恢复状态，不是全新安装。',
      '先在记忆页只读核对控制库与授权；由 Host 重新发布路由。不要按「新装」重置，也不要删除控制库。');
  }
  if (routeExists && !controlExists) {
    return decision('route-only', 'MEMORY_PREFLIGHT_ROUTE_WITHOUT_CONTROL', '路由仍生效但控制库缺失：权限与删除屏障无法证明。',
      '恢复原控制库或由有授权的会话重建；在恢复前拒绝记忆、模型与发送。不要用空库冒充新装。');
  }

  let inspected;
  try {
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return decision('corrupt', 'MEMORY_PREFLIGHT_ROUTE_UNPROTECTED', '路由目录不是受保护的普通目录。', '恢复为普通目录并保留原文件；不要在符号链接上继续运行。');
    inspected = inspectRouteFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return decision('corrupt', 'MEMORY_PREFLIGHT_ROUTE_UNREADABLE', '路由文件在预检期间消失。', '重新预检；不要凭猜测重建权限或数据库。');
    return decision('corrupt', 'MEMORY_PREFLIGHT_ROUTE_UNREADABLE', '读取路由文件失败。', `检查文件权限与磁盘（${error?.code ?? 'IO'}），保留原文件后再预检。`);
  }

  if (inspected.retiredBackend !== undefined) {
    return decision('retired-v1', 'MEMORY_BACKEND_RETIRED', `路由仍指向已移除的记忆后端「${String(inspected.retiredBackend).slice(0, 16)}」。`,
      '本版本只支持 V2。旧角色包、记忆卡与全量档案原地只读保留；处理计划是：只读核对 → 在有授权的会话里确认 V2 初始化 → 由 Host 重新发布路由。真实转换需单独授权。',
      { retiredBackend: inspected.retiredBackend });
  }
  if (inspected.problem) {
    const reason = { protected: '路由文件不是普通文件、过大或是符号链接。', permissions: '路由文件权限过宽（组/其他用户可读写）。', json: '路由文件不是有效 JSON。', shape: '路由文件结构不是对象。', fields: '路由文件包含未知字段。', value: '路由字段取值非法。' }[inspected.problem];
    return decision('corrupt', 'MEMORY_ROUTING_INVALID', reason, '保留原文件并交由 Host 重新发布路由；不要手工拼写、不要删除控制库。', { problem: inspected.problem });
  }
  if (inspected.value.minCompatibleReader > ROUTE_VERSION) {
    return decision('reader-too-new', 'MEMORY_READER_UNSUPPORTED', `控制库要求读取版本 ${inspected.value.minCompatibleReader}，当前程序只支持 ${ROUTE_VERSION}。`,
      '升级到兼容版本后重试；不要降级读取旧卡或会话，也不要改写路由。', { minCompatibleReader: inspected.value.minCompatibleReader });
  }
  return decision('ready', 'MEMORY_PREFLIGHT_READY', '路由有效且控制库存在：继续检查运行就绪与具体会话授权。',
    '在记忆页核对当前角色与已批准会话；批准状态与运行就绪是两件事。', { controlRevision: inspected.value.controlRevision });
}

/** 预检结果的可执行处理计划（只描述，不执行）。 */
export function preflightPlan(result) {
  if (!result || result.ok !== true) return { steps: [], note: '预检未完成，先解决读取失败。' };
  const common = ['原角色包、人格、记忆卡、全量档案、控制库、权限与账本一律原地保留。'];
  const byState = {
    fresh: ['按 V2 建立新控制库与路由。', '在记忆页为每个需要的会话与精确模型单独预览并批准。'],
    ready: ['在记忆页核对当前角色、后端与已批准会话。', '若显示 blocked，按 reason.code 修复；不要切回旧后端。'],
    'retired-v1': ['只读核对旧路由与旧档案位置。', '在有授权的会话里确认 V2 初始化范围。', '由 Host 重新发布 V2 路由（不手写文件）。', '需要把历史资料导入 V2 时，另开一次明确授权的数据操作。'],
    'control-only': ['只读核对控制库与已批准授权。', '由 Host 重新发布路由；确认前拒绝记忆、模型与发送。'],
    'route-only': ['恢复原控制库。', '恢复前拒绝记忆、模型与发送；不要用空库冒充新装。'],
    corrupt: ['保留原路由文件与目录权限证据。', '由 Host 重新发布路由；必要时在隔离副本演练。'],
    'reader-too-new': ['升级到支持该读取版本的兼容程序。', '升级前不要改写或删除路由。'],
  };
  return { steps: [...(byState[result.state] ?? []), ...common], note: '以上为只读计划；任何写操作需单独授权。' };
}
