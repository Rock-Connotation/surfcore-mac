#!/usr/bin/env node
/**
 * publish-dev 的文档版本字同步（2026-11-15 根治）。
 *
 * 背景：`scripts/publish-dev.mjs` 只改 package.json / README.md / CHANGELOG.md，
 * 但 `scripts/doc-facts.mjs:188-199` 还对两处文档做**逐字等值**校验：
 *   - docs/ROADMAP.md  的 `当前版本：\`x\``
 *   - docs/guides/DSH_SETUP.md 的 `当前 \`x\``
 * 不同步就会每发一次 dev 构建把 doc-facts 弄红。
 *
 * 这里把同步逻辑抽出来，既供 publish-dev.mjs 调用，也供 test-dev-publish.mjs 做
 * 红→绿功能自证（在临时目录里跑，不碰真实仓库）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** doc-facts 校验的两处版本表述（正则与 scripts/doc-facts.mjs 保持一致）。 */
export const DOC_VERSION_RULES = [
  { rel: 'docs/ROADMAP.md', re: /当前版本：`([^`]+)`/, rewrite: (v) => `当前版本：\`${v}\`` },
  { rel: 'docs/guides/DSH_SETUP.md', re: /当前 `([0-9][^`]*)`/, rewrite: (v) => `当前 \`${v}\`` },
];

/**
 * 把 dir 下两处文档版本字改写为 version（只改被 doc-facts 校验的那一处，不动同句其它版本号）。
 * @returns {string[]} 实际被改写的文件（相对 dir），未改动则空数组。
 */
export function syncDocVersions({ dir, version, log = () => {} }) {
  const changed = [];
  for (const { rel, re, rewrite } of DOC_VERSION_RULES) {
    const file = path.join(dir, rel);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 文件不存在不视为失败（与 publish-dev 对 README/CHANGELOG 的 try/catch 一致）
    }
    const replaced = text.replace(re, (match) => rewrite(version));
    if (replaced !== text) {
      fs.writeFileSync(file, replaced, 'utf8');
      changed.push(rel);
      log(`  已同步文档版本字：${rel}`);
    }
  }
  return changed;
}
