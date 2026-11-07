// DSH 升级后的健康检查（2026-11-01 用户反馈：升级 rc.5 后 QQ 会话没有 qq_* 工具）。
//
// 两个独立故障面：
//   ① profile 里的 MCP 条目被摘 → 新会话也拿不到 qq_* 工具（要重跑 setup-dsh.mjs + 重启 DSH）；
//   ② 旧会话是在 preset 还完整时创建的 → 工具表定死，修复 profile 后旧会话仍然没有 qq_*，
//      必须重建会话。
//
// 这里只做纯判断，读写/DSH 调用由 bridge 做。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export const REQUIRED_MCP_IDS = Object.freeze(['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']);

function unknown(code, error, hint, profile = null) {
  return { ok: false, status: 'unknown', code, error, hint, profile, checked: 0, healthy: [], broken: [] };
}

function validProfile(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

// Only visit loader entries, not arbitrary config values, which can contain IDs as text.
function patchIds(doc) {
  const found = new Set();
  const visit = (rows, disabled = false, definitions = false) => {
    if (!Array.isArray(rows)) throw new Error('invalid patch rows');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid patch row');
      const off = disabled || row.disabled === true;
      if (typeof row.id === 'string') {
        if (off) found.delete(row.id); else if (definitions) found.add(row.id);
      }
      if (row.insert !== undefined) visit(row.insert, off, true);
      if (row.plugins !== undefined) visit(row.plugins, off, true);
    }
  };
  if (Array.isArray(doc)) visit(doc);
  else if (doc && typeof doc === 'object' && Array.isArray(doc.plugins)) visit(doc.plugins, false, true);
  else throw new Error('invalid patch document');
  return found;
}

function readOne(root, name, ids) {
  const file = path.join(root, name, 'cordis.patch.yml');
  let found;
  try { found = patchIds(yaml.load(fs.readFileSync(file, 'utf8')) ?? []); }
  catch { return { profile: name, file, unknown: true }; }
  return { profile: name, file, missing: ids.filter(id => !found.has(id)), hasSurfcore: found.has('surfcore') };
}

/** Legacy scan is retained; bridge callers explicitly request one active profile. */
export function checkProfileMcp(home, { ids = REQUIRED_MCP_IDS, dshHome, profile, resolveProfile = false } = {}) {
  const root = path.join(dshHome || path.join(String(home || ''), '.dsh'), 'profiles');
  const scoped = resolveProfile || profile !== undefined;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return scoped ? unknown('DSH_PROFILE_UNKNOWN', '无法读取当前 DSH 的 profile 目录。', '检查 DSH_HOME 和 profile 目录权限，再重试。') : { ok:false, checked:0, healthy:[], broken:[] }; }
  if (scoped) {
    let selected = typeof profile === 'string' ? profile.trim() : '';
    if (selected && !validProfile(selected)) return unknown('DSH_PROFILE_INVALID', '当前 profile 名称无效。', '在当前 DSH 进程中设置有效的 DSH_PROFILE 后重试。');
    if (!selected) {
      const installed = [];
      for (const name of names) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
          if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('surfcore')) installed.push(name);
        } catch (error) {
          if (error?.code !== 'ENOENT') return unknown('DSH_PROFILE_UNKNOWN', '无法确认哪个 profile 安装了 SurfCore。', '检查 profile 安装清单，或明确设置 DSH_PROFILE。');
        }
      }
      if (installed.length !== 1) return unknown('DSH_PROFILE_AMBIGUOUS', '无法唯一确认当前 SurfCore profile。', '在当前 DSH 进程中明确设置 DSH_PROFILE，然后重试。');
      selected = installed[0];
    }
    if (!names.includes(selected)) return unknown('DSH_PROFILE_UNKNOWN', '当前 profile 目录不存在。', '核对 DSH_HOME 与 DSH_PROFILE 后重试。', selected);
    const item = readOne(root, selected, ids);
    if (item.unknown) return unknown('DSH_PROFILE_PATCH_UNREADABLE', '当前 profile 的 MCP 配置无法读取或解析。', '检查当前 profile 的 cordis.patch.yml 和文件权限后重试。', selected);
    const broken = item.missing.length ? [{ profile:selected, missing:item.missing, file:item.file }] : [];
    return { ok: !broken.length, status: broken.length ? 'broken' : 'healthy', profile:selected, checked:1, healthy:broken.length ? [] : [selected], broken };
  }
  const profiles = [];
  for (const name of names) {
    const file = path.join(root, name, 'cordis.patch.yml');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    profiles.push({ name, file, missing: ids.filter((id) => !new RegExp(`(^|\\n)\\s*-?\\s*(?:id:\\s*)?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)), });
  }
  const healthy = profiles.filter(item => item.missing.length === 0);
  return {ok:healthy.length>0,checked:profiles.length,healthy:healthy.map(item=>item.name),broken:profiles.filter(item=>item.missing.length).map(({name,missing,file})=>({profile:name,missing,file}))};
}

/**
 * 会话的 preset 是否与当前配置不一致。
 * 只在「实际值存在且与期望不同」时判为不一致；实际值缺失（旧会话没记录 preset）只告警不动，
 * 避免把一批老会话全删掉。
 */
export function presetMismatch(expected, actual) {
  const want = String(expected ?? '').trim();
  const got = String(actual ?? '').trim();
  if (!want || !got) return false;
  return want !== got;
}
