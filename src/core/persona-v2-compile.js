// V2 人格编译入口（2026-11-12，V1 退役 R09）。
//
// 为什么必须有这一层：QQ Reply Host 与 B站 Host 原先各自 `fs.readFileSync(persona.md)`，
// 于是本批在 `selectRoleText` 里做的「排除〔一代〕小节」只对控制台预览生效，
// 真实 Native 输入仍然带着一代协议行与旧分句规则。人格/协议不一致属于安全相关缺陷。
//
// 契约：
//   · 原 persona 文件一律不改（只在内存里读、过滤、组合）。
//   · 过滤口径复用 `selectRoleText`（〔一代〕小节 + GEN1 兜底行），不复制正则。
//   · Source 证明与 Owner 使用**同一个最终字符串**与摘要，调用方只拿这一个结果。
//   · 不在这里做任何 I/O 之外的副作用：不写文件、不发消息、不读记忆。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { characterPaths, personaLayersForCharacter } from '../character-persona.js';
import { composePersonaLayers, personaSceneFromKey } from '../persona-layers.js';
import { buildPersonaIdentity, personaNameFromCard } from '../persona-identity.js';
import { GEN1_ROLE_LINE_RE, selectRoleText } from '../role-card.js';

const MAX_PERSONA_BYTES = 64 * 1024;

const fail = (code, error, hint) => ({ ok: false, code, error, hint });

/** 兜底：没标记成〔一代〕小节、但仍混进正文的一代指令行，逐行剔除并计数。 */
export function stripLegacyPersonaLines(text) {
  const removed = [];
  const kept = [];
  for (const line of String(text ?? '').split('\n')) {
    if (GEN1_ROLE_LINE_RE.test(line)) { removed.push(line.trim().slice(0, 120)); continue; }
    kept.push(line);
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/**
 * 编译一次人格输入。返回的 `text` 是 Source 证明与 Owner 共用的唯一字符串。
 * @param {{ roleId: string, scene?: string, sceneKey?: string, maxChars?: number, personaMode?: 'full'|'tone',
 *           ownerName?: string, readCore?: (file: string) => string }} input
 */
export function compileV2Persona({
  roleId, scene, sceneKey, maxChars = 6000, personaMode = 'full', ownerName = '主人',
  readCore = file => fs.readFileSync(file, 'utf8'),
} = {}) {
  if (typeof roleId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(roleId)) {
    return fail('PERSONA_ROLE_REQUIRED', '人格编译缺少有效角色编号。', '由 Host 传入当前角色后重试；不会回退到其它角色的人格。');
  }
  let paths;
  try { paths = characterPaths(roleId); } catch { return fail('PERSONA_PATH_INVALID', '无法解析当前角色的人格路径。', '检查角色目录后重试；不要借用其它角色的文件。'); }
  const sceneId = String(scene ?? (sceneKey ? personaSceneFromKey(sceneKey) : '')).trim();

  let raw;
  try { raw = readCore(paths.persona); } catch (error) {
    return fail('MEMORY_QQ_PERSONA_INVALID', '无法读取当前角色的人格卡。', `恢复当前角色的人格文件后重试（${error?.code ?? 'IO'}）；原文件不会被改动。`);
  }
  if (typeof raw !== 'string' || !raw.trim()) return fail('MEMORY_QQ_PERSONA_INVALID', '当前角色的人格卡为空。', '恢复当前角色的人格卡后重试。');
  if (Buffer.byteLength(raw) > MAX_PERSONA_BYTES) return fail('MEMORY_QQ_PERSONA_INVALID', '当前角色的人格卡超出上限。', `压缩到 ${MAX_PERSONA_BYTES} 字节以内后重试；不会截断后继续运行。`);

  // 第一层：按〔一代〕/〔二代〕标记选段（共享口径）。
  const selected = selectRoleText(raw);
  // 第二层：没标记但仍是旧协议的整行（共享 GEN1_ROLE_LINE_RE）。
  const cleaned = stripLegacyPersonaLines(selected);
  if (!cleaned.text) return fail('MEMORY_QQ_PERSONA_INVALID', '人格卡过滤后没有可用正文。', '检查人格卡是否整篇都被标记为〔一代〕；原文件保持不动。');

  // 分层一律按**传入的 roleId** 解析，不读「当前角色」指针：Host 可能已在切换途中。
  const layers = personaLayersForCharacter(roleId) ?? {};
  const readLayer = file => { try { return file ? readCore(file) : ''; } catch { return ''; } };
  const tone = selectRoleText(readLayer(layers.tone));
  const sceneFile = sceneId ? (layers.scenes?.[sceneId] ?? '') : '';
  const sceneText = selectRoleText(readLayer(sceneFile));
  const identity = buildPersonaIdentity({ name: personaNameFromCard(raw, roleId), owner: ownerName });
  const composed = composePersonaLayers({
    core: cleaned.text, tone, scene: sceneText, identity,
    personaMode, maxChars: Math.max(0, Math.min(MAX_PERSONA_BYTES, Number(maxChars) || 6000)), sceneId,
  });
  const text = composed.text || cleaned.text;
  if (!text.trim()) return fail('MEMORY_QQ_PERSONA_INVALID', '人格编译结果为空。', '检查人格卡与预算后重试；不会以空人格继续运行。');

  return {
    ok: true,
    roleId,
    scene: sceneId,
    text,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    chars: text.length,
    removedLegacyLines: cleaned.removed.length,
    truncated: composed.truncated === true,
  };
}
