/**
 * 平台接入层（为后续贴吧预留；微博 2026-10-23 明确不做，已移除占位）。
 *
 * 核心数据模型不是“QQ 和 B站写死”，而是：
 *   PlatformAdapter = {
 *     id, name, version, status: 'active'|'planned'|'disabled',
 *     capabilities: ['identity','memory.read','memory.write','prompt.block','actions'],
 *     async status(), async readMemory(), async writeMemory(), promptBlock(ctx),
 *     dispose()
 *   }
 *
 * v1 内置 qq / bili 两个适配器；tieba 以 planned 占位，UI 里可见但不可用。
 * 后续要接贴吧（或其它平台），只需新增一个 adapter（或独立扩展包调用 registerPlatform），
 * 不需要改记忆同步、身份对齐、设置窗口的主流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORM_DIR } from './paths.js';

export const PLATFORM_CAPABILITIES = Object.freeze([
  'identity',
  'memory.read',
  'memory.write',
  'prompt.block',
  'actions',
]);

const BUILTIN_PLATFORMS = [
  { id: 'qq', name: 'QQ', version: '1.0.0', status: 'active', builtin: true, capabilities: ['identity', 'memory.read', 'prompt.block', 'actions'] },
  { id: 'bili', name: 'B站', version: '1.0.0', status: 'active', builtin: true, capabilities: ['identity', 'memory.read', 'memory.write', 'prompt.block', 'actions'] },
  { id: 'tieba', name: '贴吧', version: '0.0.0', status: 'planned', builtin: true, capabilities: ['identity', 'memory.read', 'memory.write', 'prompt.block'] },
];

const CHANNEL_STATES = new Set(['disabled', 'unsupported', 'needs_setup', 'needs_auth', 'ready', 'degraded', 'error']);
const CHANNEL_METHODS = ['observe', 'prepareMedia', 'execute'];

function failure(code, error, hint) { return { ok: false, code, error, hint }; }

function channelRuntime(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    status: typeof raw.status === 'function' ? raw.status : null,
    observe: typeof raw.observe === 'function' ? raw.observe : null,
    prepareMedia: typeof raw.prepareMedia === 'function' ? raw.prepareMedia : null,
    execute: typeof raw.execute === 'function' ? raw.execute : null,
    dispose: typeof raw.dispose === 'function' ? raw.dispose : null,
    disposed: false,
  };
}

function disposeRuntime(runtime) {
  if (!runtime) return Promise.resolve();
  if (runtime.disposed) return runtime.disposePromise || Promise.resolve();
  runtime.disposed = true;
  try { runtime.disposePromise = Promise.resolve(runtime.dispose?.()).catch(() => {}); }
  catch { runtime.disposePromise = Promise.resolve(); }
  return runtime.disposePromise;
}

function captureActivityContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const characterId = String(raw.characterId ?? '');
  const characterEpoch = raw.characterEpoch;
  const activityId = String(raw.activityId ?? '');
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(characterId)
    || !Number.isSafeInteger(characterEpoch) || characterEpoch < 1
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(activityId)) return null;
  return Object.freeze({ ...raw, characterId, characterEpoch, activityId });
}

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('平台适配器必须是对象');
  const id = String(adapter.id ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{1,23}$/.test(id)) throw new Error('平台 id 必须是 2~24 位小写字母/数字/下划线');
  const name = String(adapter.name ?? id).slice(0, 40);
  const capabilities = Array.isArray(adapter.capabilities)
    ? adapter.capabilities.filter((item) => PLATFORM_CAPABILITIES.includes(item))
    : [];
  return {
    id,
    name,
    version: String(adapter.version ?? '0.0.0').slice(0, 20),
    status: ['active', 'planned', 'disabled'].includes(adapter.status) ? adapter.status : 'active',
    builtin: Boolean(adapter.builtin),
    capabilities,
    statusFn: typeof adapter.status === 'function' ? adapter.status : null,
    readMemory: typeof adapter.readMemory === 'function' ? adapter.readMemory : null,
    writeMemory: typeof adapter.writeMemory === 'function' ? adapter.writeMemory : null,
    promptBlock: typeof adapter.promptBlock === 'function' ? adapter.promptBlock : null,
    actions: adapter.actions && typeof adapter.actions === 'object' ? adapter.actions : {},
    dispose: typeof adapter.dispose === 'function' ? adapter.dispose : null,
    channelRuntime: channelRuntime({ status: adapter.channelStatus, observe: adapter.observe, prepareMedia: adapter.prepareMedia, execute: adapter.execute }),
    retired: false,
  };
}

export class PlatformRegistry {
  constructor() {
    this.adapters = new Map();
    this.extensions = new Map();
    for (const platform of BUILTIN_PLATFORMS) {
      this.adapters.set(platform.id, normalizeAdapter(platform));
    }
  }

  /** 扩展登记的平台适配器；返回 disposer。 */
  register(adapter, owner = 'extension') {
    const normalized = normalizeAdapter(adapter);
    if (this.adapters.has(normalized.id) && this.adapters.get(normalized.id).builtin) {
      throw new Error(`平台 ${normalized.id} 是内置平台，不能被覆盖`);
    }
    normalized.owner = String(owner);
    const previous = this.adapters.get(normalized.id);
    this.adapters.set(normalized.id, normalized);
    return () => {
      if (normalized.retired) return;
      normalized.retired = true;
      disposeRuntime(normalized.channelRuntime);
      try { normalized.dispose?.(); } catch {}
      if (this.adapters.get(normalized.id) !== normalized) return;
      if (previous && !previous.retired) this.adapters.set(normalized.id, previous);
      else this.adapters.delete(normalized.id);
    };
  }

  get(id) {
    return this.adapters.get(String(id)) ?? null;
  }

  /** 给内置平台挂运行态探针（不改变适配器身份/能力）。 */
  setStatus(id, fn) {
    const adapter = this.adapters.get(String(id));
    if (!adapter) return false;
    adapter.statusFn = typeof fn === 'function' ? fn : null;
    return true;
  }

  /** Host attaches an owned runtime to a registered adapter without changing legacy metadata. */
  setRuntime(id, handlers) {
    const adapter = this.get(id);
    if (!adapter) return failure('CHANNEL_UNKNOWN', '渠道未注册。', '先注册渠道，再连接运行能力。');
    if (adapter.channelRuntime && !adapter.channelRuntime.disposed && CHANNEL_METHODS.some((method) => adapter.channelRuntime[method])) {
      return failure('CHANNEL_RUNTIME_EXISTS', '渠道运行能力已连接。', '先卸载本实例的运行能力后重试。');
    }
    const runtime = channelRuntime(handlers);
    if (!runtime || !CHANNEL_METHODS.some((method) => runtime[method])) return failure('CHANNEL_RUNTIME_INVALID', '渠道运行能力没有可用入口。', '提供 observe、prepareMedia 或 execute 后重试。');
    adapter.channelRuntime = runtime;
    return () => {
      const disposed = disposeRuntime(runtime);
      if (adapter.channelRuntime === runtime) adapter.channelRuntime = null;
      return disposed;
    };
  }

  /** Legacy advertised capabilities remain intact; runtime implementation/readiness are separate. */
  async channelCapabilities(id) {
    const adapter = this.get(id);
    if (!adapter) return failure('CHANNEL_UNKNOWN', '渠道未注册。', '检查渠道标识或先注册适配器。');
    const runtime = adapter.channelRuntime;
    const implemented = Object.fromEntries(CHANNEL_METHODS.map((method) => [method, Boolean(runtime && !runtime.disposed && runtime[method])]));
    let state = adapter.status === 'disabled' ? 'disabled' : adapter.status !== 'active' ? 'unsupported' :
      !Object.values(implemented).some(Boolean) ? 'unsupported' : 'needs_setup';
    let availableFlags = {};
    if (state === 'needs_setup' && runtime.status) {
      try {
        const result = await runtime.status();
        if (this.get(id) !== adapter || adapter.channelRuntime !== runtime || runtime.disposed) return failure('CHANNEL_RUNTIME_CHANGED', '渠道运行实例已变化。', '重新获取渠道状态后重试。');
        state = CHANNEL_STATES.has(result?.state) ? result.state : 'error';
        availableFlags = result?.available && typeof result.available === 'object' ? result.available : {};
      } catch { state = 'error'; }
    }
    const available = Object.fromEntries(CHANNEL_METHODS.map((method) => [method,
      implemented[method] && (state === 'ready' ? availableFlags[method] !== false : state === 'degraded' && availableFlags[method] === true)]));
    return { ok: true, id: adapter.id, state, implemented, available };
  }

  async invokeChannel(id, method, request, activityContext) {
    if (!CHANNEL_METHODS.includes(method)) return failure('CHANNEL_UNSUPPORTED', '渠道未实现这项能力。', '选择受支持的渠道入口。');
    const context = captureActivityContext(activityContext);
    if (!context) return failure('CHANNEL_ACTIVITY_INVALID', '渠道活动身份不完整。', '提交前固定 characterId、正整数 characterEpoch 和 activityId。');
    const adapter = this.get(id);
    if (!adapter) return failure('CHANNEL_UNKNOWN', '渠道未注册。', '检查渠道标识或先注册适配器。');
    const runtime = adapter.channelRuntime;
    const status = await this.channelCapabilities(id);
    if (!status.ok) return status;
    if (!status.implemented[method]) return failure('CHANNEL_UNSUPPORTED', '渠道未实现这项能力。', '选择已实现该能力的渠道。');
    if (!status.available[method]) return failure(`CHANNEL_${status.state.toUpperCase()}`, '渠道当前不能执行这项能力。', '检查渠道开关、配置和登录状态后重试。');
    if (this.get(id) !== adapter || adapter.channelRuntime !== runtime || runtime.disposed) return failure('CHANNEL_RUNTIME_CHANGED', '渠道运行实例已变化。', '重新获取渠道状态后重试。');
    try {
      const result = await runtime[method](request, context);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return failure('CHANNEL_RESULT_INVALID', '渠道未返回有效结果。', '检查渠道实现后重试。');
      if (result.ok === false && (!result.code || !result.error || !result.hint)) return failure('CHANNEL_OPERATION_FAILED', '渠道操作失败。', '检查渠道状态并重试。');
      return result;
    } catch { return failure('CHANNEL_OPERATION_FAILED', '渠道操作失败。', '检查渠道状态和操作日志后重试。'); }
  }

  observe(id, request, context) { return this.invokeChannel(id, 'observe', request, context); }
  prepareMedia(id, request, context) { return this.invokeChannel(id, 'prepareMedia', request, context); }
  execute(id, request, context) { return this.invokeChannel(id, 'execute', request, context); }

  require(id) {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`未知平台：${id}`);
    if (adapter.status !== 'active') throw new Error(`平台 ${id} 尚未启用（${adapter.status}）`);
    return adapter;
  }

  list() {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      version: adapter.version,
      status: adapter.status,
      builtin: adapter.builtin,
      owner: adapter.owner ?? 'builtin',
      capabilities: adapter.capabilities,
    }));
  }

  async statusAll() {
    const out = [];
    for (const adapter of this.adapters.values()) {
      let runtime = null;
      try { runtime = adapter.statusFn ? await adapter.statusFn() : null; } catch (error) { runtime = { ok: false, error: String(error?.message ?? error) }; }
      out.push({
        id: adapter.id,
        name: adapter.name,
        version: adapter.version,
        status: adapter.status,
        builtin: adapter.builtin,
        capabilities: adapter.capabilities,
        runtime,
      });
    }
    return out;
  }

  /** 载入 platforms/ 下可选的本地适配器（默认只有 README 与占位清单）。 */
  async loadLocal(directory = PLATFORM_DIR) {
    const loaded = [];
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return loaded; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestFile = path.join(directory, entry.name, 'manifest.json');
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { continue; }
      if (manifest.enabled === false || manifest.status === 'planned') continue;
      try {
        const moduleFile = path.join(directory, entry.name, manifest.entry ?? 'index.js');
        const mod = await import(`${pathToFileURL(moduleFile).href}?t=${Date.now()}`);
        const adapterFactory = mod.default ?? mod.adapter ?? mod.createAdapter;
        if (typeof adapterFactory !== 'function') continue;
        const adapter = await adapterFactory({ manifest });
        this.register(adapter, `local:${entry.name}`);
        loaded.push(entry.name);
      } catch (error) {
        loaded.push({ name: entry.name, error: String(error?.message ?? error) });
      }
    }
    return loaded;
  }

  dispose() {
    const pending = [];
    for (const adapter of this.adapters.values()) {
      pending.push(disposeRuntime(adapter.channelRuntime));
      adapter.retired = true;
      try { adapter.dispose?.(); } catch {}
    }
    this.adapters.clear();
    return Promise.all(pending).then(() => undefined);
  }
}
