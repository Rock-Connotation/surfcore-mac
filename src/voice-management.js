import { voiceGroupPolicies, voiceGroupPoliciesFromRows } from './voice-group-policy.js';
// Shared control plane for DSH Host and the legacy bridge console. No QQ session,
// message pump or model is imported. Engines remain explicit, optional providers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createVoicePacks } from './voice-packs.js';
import { synthesizeToFile } from './voice-tts.js';
import { readVolcKey, saveVolcKey } from './voice-volc-key.js';
import { advanceVoiceSelectionRevision, effectiveVolcMonthLimit, startVoxdCloud, withVolcBudgetLock } from './voice-volc-budget.js';
import { fileStamp } from './config-stamps.js';

const finished = new Set(['完成', '失败']);
const failure = (code, error, hint, status = 409) => ({ status, data: { ok: false, code, error, hint } });
const success = data => ({ status: 200, data });
const sessions = new Map();
const closedError = () => failure('VOICE_MANAGEMENT_CLOSED', '语音管理已关闭。', '重新打开SurfCore设置后重试。');

function createVoiceSession({ configFile, programRoot, label = 'DSH', onIdle = () => {},
  createPacks = createVoicePacks, fetchImpl = fetch, synthesize = synthesizeToFile, platform = process.platform } = {}) {
  if (!path.isAbsolute(configFile || '')) throw new Error('voice management requires an absolute configFile');
  const owner = crypto.randomUUID();
  const lock = path.join(path.dirname(configFile), 'state', 'voice-management.lock');
  let manager, managerKey, pending = false, timer = null, revision = 0;
  const readConfig = () => {
    try {
      const value = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid config');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return {}; throw Object.assign(new Error('语音配置不可读取。'), { code: 'VOICE_CONFIG_INVALID' }); }
  };
  function writeConfig(value) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    let original = null;
    try {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid config file');
      original = fs.readFileSync(configFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original) {
      const dir = path.join(path.dirname(configFile), 'state', 'voice-management-config-backups');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('invalid backup directory');
      const backup = fs.openSync(path.join(dir, `${crypto.randomUUID()}.json`), 'wx', 0o600);
      try { fs.writeFileSync(backup, original); fs.fsyncSync(backup); } finally { fs.closeSync(backup); }
      if (process.platform !== 'win32') { const fdDir = fs.openSync(dir, 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); } }
    }
    const temp = `${configFile}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        const bom = original?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '﻿' : '';
        fs.writeFileSync(fd, bom + JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, configFile);
      if (process.platform !== 'win32') { const fdDir = fs.openSync(path.dirname(configFile), 'r'); try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); } }
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  function ownerState() {
    let file = lock;
    for (let depth = 0; depth < 32; depth++) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return { foreign: true, invalid: true };
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.owner !== 'string' || !record.owner || record.owner.length > 200)
          return { foreign: true, invalid: true };
        let dead = false;
        try { process.kill(record.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        if (!dead) return { foreign: record.owner !== owner, record, file };
        // A dead authority is immutable. All contenders derive the same successor;
        // no contender can rename/unlink a newly published live owner's authority.
        const next = crypto.createHash('sha256').update(file + '\0' + record.owner).digest('hex');
        file = path.join(path.dirname(lock), `voice-management.recovered-${next}.lock`);
      } catch (e) { return e.code === 'ENOENT' ? { file } : { foreign: true, invalid: true }; }
    }
    return { foreign: true, invalid: true };
  }
  function acquire() {
    const state = ownerState();
    if (state.record?.owner === owner) return true;
    if (state.foreign) return false;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const candidate = `${state.file}.${crypto.randomUUID()}.candidate`;
    try {
      const fd = fs.openSync(candidate, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, label })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      // Publish a complete record atomically, never exposing an empty lock file.
      fs.linkSync(candidate, state.file);
      return true;
    } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    finally { try { fs.unlinkSync(candidate); } catch {} }
  }
  function release() {
    const state = ownerState();
    if (state.record?.owner === owner) fs.unlinkSync(state.file);
    if (timer) clearInterval(timer);
    timer = null;
  }
  async function busy() {
    if (pending) return true;
    if (!manager) return false;
    const snapshot = await manager.list();
    return pending || snapshot.packs.some(p => [p.install, p.import].some(job => job && !finished.has(job.phase)));
  }
  async function settle() {
    const captured = revision;
    const active = await busy();
    if (captured !== revision || pending) return;
    if (!active) { release(); onIdle(); }
    else if (!timer) {
      timer = setInterval(() => { void settle().catch(() => {}); }, 1000);
      timer.unref?.();
    }
  }
  async function packs(cfg) {
    for (let retry = 0; retry < 4; retry++) {
      const key = JSON.stringify(cfg.voicePacks || {});
      if (!manager) { manager = createPacks(cfg, { programRoot, configFile }); managerKey = key; }
      if (key === managerKey) return manager;
      const captured = revision, previous = manager, previousKey = managerKey;
      const active = await busy();
      if (manager !== previous || managerKey !== previousKey) { cfg = readConfig(); continue; }
      if (!active && captured === revision) {
        manager = createPacks(cfg, { programRoot, configFile }); managerKey = key;
      }
      return manager;
    }
    throw new Error('语音配置持续变化，请等待当前操作完成后刷新。');
  }
  const busyError = () => ownerState().invalid
    ? failure('VOICE_MANAGEMENT_LOCK_INVALID', '语音管理归属记录需要检查。', '关闭所有语音管理端，保留锁记录并检查state目录后再恢复。')
    : failure('VOICE_MANAGEMENT_BUSY', '语音管理正在处理另一个操作。', '回到发起安装/导入的管理界面完成或取消；不要重复操作。');

  async function check(cfg, lifecycle) {
    const v = cfg.socialV2?.voice?.tts || {};
    const route = v.route === 'cloud' ? 'cloud' : 'local';
    if (v.enabled !== true) return failure('VOICE_TTS_DISABLED', '语音合成尚未开启。', '选择本地或云端语音服务并完成配置，再启用语音合成；不需要启动QQ。');
    if (route === 'cloud' && v.cloudProvider === 'volc') {
      try {
        const apiKey = readVolcKey(configFile, v.volcKeyId);
        if (!apiKey) return failure('VOICE_VOLC_KEY_INVALID', '尚未配置火山 API Key。', '在语音设置中输入 API Key。');
        const voice = cfg.socialV2?.voice || {};
        const budget = { configFile, keyId: v.volcKeyId, selectionRevision: v.selectionRevision ?? 0, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour };
        const result = await synthesize({ provider: 'volc', apiKey, budget, text: '语音自检', timeoutMs: Math.min(120000, Math.max(3000, Number(v.timeoutMs) || 60000)), outDir: path.join(path.dirname(configFile), 'state', 'voice-tts'), fetchImpl, signal: lifecycle.signal });
        if (lifecycle.closed()) return closedError();
        return success({ ok: true, route, stages: [{ name: 'synth', ok: true, detail: `合成完成 · ${Math.round(result.durationMs || 0)}ms` }, { name: 'scope', ok: true, detail: '仅检查语音合成，没有发送QQ消息。' }] });
      } catch (error) {
        if (lifecycle.closed()) return closedError();
        return failure(error.code || 'VOICE_VOLC_FAILED', error.code === 'VOICE_VOLC_BUDGET_EXHAUSTED' ? error.message : '火山语音自检失败。', error.hint || '检查 API Key、资源授权和网络后手动重试。');
      }
    }
    let endpoint;
    try {
      endpoint = new URL(v.endpoints?.[route] || v.baseUrl || `http://127.0.0.1:${route === 'cloud' ? 8767 : 8765}`);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    } catch { return failure('VOICE_ENDPOINT_INVALID', '语音服务地址无效。', '填写兼容 /v1/health 与 /v1/speak/file 的HTTP(S)服务地址。'); }
    const baseUrl = endpoint.href.replace(/\/+$/, '');
    try {
      const r = await fetchImpl(`${baseUrl}/v1/health`, { signal: AbortSignal.any([AbortSignal.timeout(3000), lifecycle.signal]) });
      if (!r.ok) throw new Error();
    } catch {
      if (lifecycle.closed()) return closedError();
      return { ...failure('VOICE_SERVICE_UNAVAILABLE', '语音引擎未就绪。', '启动所选本地或云端语音服务后重试；语音管理无需QQ桥接。'),
        data: { ...failure('VOICE_SERVICE_UNAVAILABLE', '语音引擎未就绪。', '启动所选本地或云端语音服务后重试；语音管理无需QQ桥接。').data,
          route, stages: [{ name: 'service', ok: false, code: 'VOICE_SERVICE_UNAVAILABLE', detail: '无法取得语音引擎健康回执', hint: '检查所选服务地址和运行状态；尚未执行合成。' }] } };
    }
    if (lifecycle.closed()) return closedError();
    try {
      const request = () => synthesize({ text: '语音自检', baseUrl, character: String(v.character || ''),
        timeoutMs: Math.min(120000, Math.max(3000, Number(v.timeoutMs) || 60000)), cacheVersion: Number(v.cacheVersion) || 0,
        outDir: path.join(path.dirname(configFile), 'state', 'voice-tts'), fetchImpl, signal: lifecycle.signal });
      const result = await (route === 'cloud' ? startVoxdCloud(configFile, {
        route, endpoint: String(v.endpoints?.cloud || 'http://127.0.0.1:8767').replace(/\/+$/, ''),
        baseUrl: String(v.baseUrl || '').replace(/\/+$/, ''), selectionRevision: v.selectionRevision ?? 0,
      }, request) : request());
      if (lifecycle.closed()) return closedError();
      return success({ ok: true, route, stages: [{ name: 'service', ok: true, detail: '语音服务可达' },
        { name: 'synth', ok: true, detail: `合成完成 · ${Math.round(result.durationMs || 0)}ms` },
        { name: 'scope', ok: true, detail: '仅检查语音合成，没有发送QQ消息。' }] });
    } catch (error) {
      if (lifecycle.closed()) return closedError();
      if (error?.code === 'VOICE_TTS_CONFIG_CHANGED' || error?.code === 'VOICE_VOLC_BUDGET_BUSY' || error?.code === 'VOICE_VOLC_BUDGET_UNAVAILABLE')
        return failure(error.code, error.message, error.hint);
      return failure('VOICE_SYNTH_FAILED', '语音合成失败。', '检查所选服务的音色、凭据及日志；不会自动换路重试。');
    }
  }

  async function dispatch({ method = 'GET', pathname = '/packs', body = {}, query = new URLSearchParams() } = {}, lifecycle) {
    method = String(method).toUpperCase();
    if (lifecycle.closed()) return closedError();
    try {
      if (ownerState().foreign) return busyError();
      const cfg = readConfig();
      if (pathname === '/tts-check' && method === 'POST') return await check(cfg, lifecycle);
      if (pathname === '/volc-config') {
        const describe = config => {
          const voice = config.socialV2?.voice || {}, tts = voice.tts || {};
          return { ok: true, selected: tts.cloudProvider === 'volc', hasKey: Boolean(tts.volcKeyId),
            route: tts.route === 'cloud' ? 'cloud' : 'local', ttsEnabled: tts.enabled === true,
            monthlyLimit: Math.min(effectiveVolcMonthLimit(voice.cloud?.monthlyQuota), effectiveVolcMonthLimit(tts.volcMonthlyQuota)) };
        };
        if (method === 'GET') return success(describe(cfg));
        if (method !== 'POST') return failure('VOICE_METHOD_NOT_ALLOWED', '此语音操作不支持该方法。', '使用页面提供的操作按钮。', 405);
        const hasQuota = Object.hasOwn(body, 'monthlyQuota');
        if ((body.provider !== undefined && !['volc', 'voxd'].includes(body.provider)) || (body.provider === undefined && !hasQuota) ||
            (body.activate !== undefined && typeof body.activate !== 'boolean') || (body.activate === true && body.provider !== 'volc'))
          return failure('VOICE_PROVIDER_INVALID', '语音服务选择无效。', '重新选择云端服务。', 400);
        if (hasQuota && (!Number.isSafeInteger(body.monthlyQuota) || body.monthlyQuota < 1 || body.monthlyQuota > 900000))
          return failure('VOICE_VOLC_QUOTA_INVALID', '火山月上限无效。', '输入1到900000之间的整数。', 400);
        if (body.apiKey !== undefined && body.apiKey !== '' && (typeof body.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(body.apiKey))) return failure('VOICE_VOLC_KEY_INVALID', 'API Key 格式无效。', '请输入有效的火山 API Key。', 400);
        if (pending || !acquire()) return busyError();
        pending = true; revision++;
        try { return withVolcBudgetLock(configFile, () => {
          const beforeStamp = fileStamp(configFile);
          const current = readConfig();
          current.socialV2 ||= {}; current.socialV2.voice ||= {}; current.socialV2.voice.tts ||= {};
          const voice = current.socialV2.voice, next = voice.tts, previous = { ...next };
          if (body.activate === true && !body.apiKey) {
            let key = '';
            try { key = readVolcKey(configFile, next.volcKeyId); } catch {}
            if (!key) return failure('VOICE_VOLC_KEY_INVALID', '尚未配置可用的火山 API Key。', '输入有效 API Key 后再启用合成。', 400);
          }
          if (body.apiKey) next.volcKeyId = saveVolcKey(configFile, body.apiKey);
          if (body.provider !== undefined) next.cloudProvider = body.provider;
          if (body.activate === true) {
            next.route = 'cloud'; next.enabled = true;
            if (voice.enabled !== true) voice.enabled = false;
          }
          if (hasQuota) next.volcMonthlyQuota = Math.min(body.monthlyQuota, effectiveVolcMonthLimit(voice.cloud?.monthlyQuota));
          advanceVoiceSelectionRevision(next, previous);
          writeConfig(current);
          const afterStamp = fileStamp(configFile);
          if (!afterStamp) return failure('QQ_CONFIG_STAMP_UNAVAILABLE', '配置已保存但无法核对版本。', '保留草稿，重新读取配置后再继续。');
          return success({ ...describe(current), beforeStamp, afterStamp });
        }); } finally { pending = false; await settle(); }
      }
      if (pathname === '/rules') {
        if (method === 'GET') {
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = fileStamp(configFile), current = readConfig(), after = fileStamp(configFile);
            if (before !== after) continue;
            const v = current.socialV2?.voice || {};
            return success({ ok: true, triggerWho: v.trigger?.who || 'owner', groupRules: Object.entries(voiceGroupPolicies(v.groupPolicies)).map(([groupId, rule]) => ({ groupId, ...rule })), maxPerDay: 500, maxPerMinute: v.maxPerMinute ?? 30,
              maxPerHour: v.maxPerHour ?? 100, aiEnabled: v.tts?.enabled === true, route: v.tts?.route === 'cloud' ? 'cloud' : 'local',
              pricePerKChar: Number(v.cloud?.pricePerKChar) || 0, monthlyQuota: Number(v.cloud?.monthlyQuota) || 0, configStamp: after });
          }
          return failure('CONFIG_STALE', '语音规则正在变化。', '保留草稿，稍后重新读取规则。');
        }
        if (method !== 'POST') return failure('VOICE_METHOD_NOT_ALLOWED', '此语音操作不支持该方法。', '使用页面提供的操作按钮。', 405);
        if (pending || !acquire()) return busyError();
        pending = true; revision++;
        try { return withVolcBudgetLock(configFile, () => {
          const beforeStamp = fileStamp(configFile);
          if (body.baseStamp !== undefined && (typeof body.baseStamp !== 'string' || body.baseStamp !== beforeStamp))
            return failure('CONFIG_STALE', '语音规则已被其他操作修改。', '保留未保存草稿，重新读取后处理冲突。');
          if (Object.hasOwn(body, 'triggerWho') && !['owner', 'anyone', 'list'].includes(body.triggerWho))
            return failure('VOICE_RULES_INVALID', '语音触发人无效。', '重新选择触发人后保存。', 400);
          if (Object.hasOwn(body, 'aiEnabled') && typeof body.aiEnabled !== 'boolean')
            return failure('VOICE_RULES_INVALID', '语音合成开关无效。', '重新选择开关状态后保存。', 400);
          if (Object.hasOwn(body, 'route') && !['local', 'cloud'].includes(body.route))
            return failure('VOICE_RULES_INVALID', '语音路线无效。', '重新选择本地或云端路线。', 400);
          let groupPolicies;
          if (Object.hasOwn(body, 'groupRules')) {
            try { groupPolicies = voiceGroupPoliciesFromRows(body.groupRules); }
            catch (error) { return failure(error.code, error.message, error.hint, 400); }
          }
          const current = readConfig();
          current.socialV2 ||= {}; current.socialV2.voice ||= {}; const next = current.socialV2.voice;
          if (groupPolicies) next.groupPolicies = groupPolicies;
          if (Object.hasOwn(body, 'triggerWho')) next.trigger = { ...(next.trigger || {}), who: body.triggerWho };
          for (const [k, max] of [['maxPerMinute', 60], ['maxPerHour', 600]]) if (Object.hasOwn(body, k) && Number.isFinite(Number(body[k]))) next[k] = Math.max(1, Math.min(max, Number(body[k])));
          if (Object.hasOwn(body, 'aiEnabled') || Object.hasOwn(body, 'route')) {
            next.tts ||= {}; const previous = { ...next.tts };
            if (Object.hasOwn(body, 'aiEnabled')) next.tts.enabled = body.aiEnabled;
            if (Object.hasOwn(body, 'route')) next.tts.route = body.route;
            advanceVoiceSelectionRevision(next.tts, previous);
          }
          for (const k of ['pricePerKChar', 'monthlyQuota']) if (Object.hasOwn(body, k) && Number.isFinite(Number(body[k]))) { next.cloud ||= {}; next.cloud[k] = Math.max(0, Number(body[k])); }
          writeConfig(current);
          const afterStamp = fileStamp(configFile);
          if (!afterStamp) return failure('QQ_CONFIG_STAMP_UNAVAILABLE', '规则已保存但无法核对版本。', '保留草稿，重新读取配置后再继续。');
          return success({ ok: true, beforeStamp, afterStamp, configStamp: afterStamp });
        }); } finally { pending = false; await settle(); }
      }
      const vp = await packs(cfg);
      if (lifecycle.closed()) return closedError();
      if (pathname === '/packs' && method === 'GET') return success(await vp.list());
      const queryId = String(query.get('id') || 'voice-cloud');
      if (method === 'GET') {
        if (pathname === '/packs/cloud-config') return success(await vp.readCloudConfig(queryId));
        if (pathname === '/packs/cloud-stats') {
          if (cfg.socialV2?.voice?.tts?.cloudProvider === 'volc') return success({ ok: true, provider: 'volc', usageAvailable: false });
          return success(await vp.cloudStats(queryId));
        }
        if (pathname === '/packs/sample') {
          const sample = await vp.sampleFile(queryId);
          return { status: 200, buffer: sample.buffer, headers: { 'content-type': 'audio/wav', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(sample.name)}` } };
        }
      }
      const id = String(body.id || '');
      const actions = {
        '/packs/install': () => vp.install(id, { force: !!body.force, mirror: String(body.mirror || ''), jobs: Number(body.jobs) || 0 }),
        '/packs/import-inspect': () => vp.inspectImport(id, String(body.sourceDir || '')),
        '/packs/import': () => vp.startImport(id, { sourceDir: String(body.sourceDir || ''), allowUnverified: body.allowUnverified === true }),
        '/packs/import-cancel': () => vp.cancelImport(id),
        '/packs/import-delete-source': () => vp.deleteImportSource(id, String(body.sourceDir || '')),
        '/packs/import-delete-backup': () => vp.deleteImportBackup(id, String(body.backupDir || '')),
        '/packs/remove': () => vp.remove(id), '/packs/cancel': () => vp.cancelInstall(id), '/packs/clean': () => vp.cleanPartial(id),
        '/packs/start': () => vp.start(id), '/packs/stop': () => vp.stop(id), '/packs/activate': () => vp.activate(id),
        '/packs/cloud-config': () => vp.cloudConfig(id, body), '/packs/enable': () => vp.setEnabled(id, body.enabled !== false),
        '/packs/test': () => vp.test(id, { text: body.text, selection: cfg.socialV2?.voice?.tts || {} }),
      };
      if (!Object.hasOwn(actions, pathname)) return failure('VOICE_ROUTE_NOT_FOUND', '未知语音管理操作。', '刷新语音页面后重试。', 404);
      if (method !== 'POST') return failure('VOICE_METHOD_NOT_ALLOWED', '此语音操作只支持POST。', '使用页面提供的操作按钮。', 405);
      const manifest = vp.manifests(cfg).find(m => m.id === id);
      if (!manifest) return failure('VOICE_PACK_UNKNOWN', '未知语音包。', '选择列表中的本地或云端语音包。', 400);
      const windowsRuntime = /\.bat$/i.test(manifest.engineScript || '') ||
        (manifest.directStart ? /\.exe$/i.test(manifest.directStart.python || '') : /\.bat$/i.test(manifest.startScript || 'run.bat'));
      if (platform !== 'win32' && windowsRuntime && ['/packs/install', '/packs/start', '/packs/activate', '/packs/stop'].includes(pathname))
        return failure('VOICE_PACK_PLATFORM_UNSUPPORTED', '此语音包的启停依赖Windows运行时。', '先选择兼容当前系统的语音引擎；现有本地/云端配置与管理入口仍可使用，不会自动下载或启动。');
      if (pending || !acquire()) return busyError();
      pending = true; revision++;
      try {
        if (['/packs/start', '/packs/activate'].includes(pathname)) {
          const snapshot = await vp.list();
          if (lifecycle.closed()) return closedError();
          if (!snapshot.packs.find(p => p.id === id)?.installed)
            return failure('VOICE_PACK_NOT_INSTALLED', '所选语音包尚未安装。', '稍后选择兼容当前系统的本地或云端语音包并完成配置。');
        }
        const data = await actions[pathname]();
        if (lifecycle.closed()) return closedError();
        if (data?.ok === false) return { status: 409, data: { ...data, code: data.code || 'VOICE_OPERATION_FAILED', hint: data.hint || '检查语音包状态与日志后重试；无需启动QQ。' } };
        return success(data);
      } finally { pending = false; await settle(); }
    } catch (error) {
      if (typeof error.code === 'string' && (error.code.startsWith('VOICE_VOLC_') || error.code.startsWith('VOICE_TTS_')) && error.hint) return failure(error.code, error.message, error.hint);
      if (typeof error.toJSON === 'function') return { status: error.status || 400, data: error.toJSON() };
      return failure(error.code === 'VOICE_CONFIG_INVALID' ? error.code : 'VOICE_OPERATION_FAILED',
        error.code === 'VOICE_CONFIG_INVALID' ? error.message : '语音管理操作未完成。',
        '检查语音配置、包目录权限和服务日志；不需要启动QQ。', 400);
    }
  }
  return { dispatch, settle };
}

// Keep the manager and its live progress across Host route disposal/re-apply.
// Each retired handle stays retired; only a fresh handle can cancel the old job.
export function createVoiceManagement(options = {}) {
  const key = JSON.stringify([options.configFile, options.programRoot]);
  let entry = sessions.get(key);
  if (!entry) {
    entry = { refs: 0 };
    entry.session = createVoiceSession({ ...options, onIdle: () => {
      if (entry.refs === 0 && sessions.get(key) === entry) sessions.delete(key);
    } });
    sessions.set(key, entry);
  }
  entry.refs++;
  let retired = false;
  const abort = new AbortController();
  const lifecycle = { closed: () => retired, signal: abort.signal };
  return {
    dispatch: request => entry.session.dispatch(request, lifecycle),
    async dispose() {
      if (retired) return;
      retired = true; abort.abort(); entry.refs--;
      await entry.session.settle();
    },
  };
}
