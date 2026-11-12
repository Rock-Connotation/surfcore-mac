#!/usr/bin/env node
/**
 * lint-failures.mjs — 失败可见性静态检查（AGENTS 1.7 / docs/guides/ERROR-REPORTING.md）
 *
 * 规则：业务代码里每个处于代码位置的 `ok: false`（字符串/注释里的不算），
 * 其对象字面量闭合范围内必须同时出现 `code`（机器可读错误码）与 `hint`（用户下一步）。
 * 缺失即违规；有回潮（超过基线）退出码 1。
 *
 * 棘轮基线：存量债务记在 scripts/lint-failures-baseline.json（按文件计数）。
 * 某文件违规数超过基线 → 退出 1（禁止回潮）；修好后用 --update-baseline 收紧
 * （只接受持平或下降，脚本会拒绝把数字调大）。
 *
 * 用法：node scripts/lint-failures.mjs
 *   --json              输出 JSON（供其他工具消费）
 *   --update-baseline   用当前违规数覆盖基线（只接受持平或下降）
 *
 * 豁免：在 `ok: false` 所在行尾或前一行写 `// failure-lint:ignore <原因>`，
 * 用于内部步骤（外层组装 code/hint）、测试夹具等确不适用本规则的场景。原因必填。
 * 不联网，仅只读扫描。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const scanDirs = ['plugins/surfcore/lib', 'src'];
const exts = new Set(['.js', '.mjs']);
const skipParts = new Set(['node_modules', 'dist', '.git']);

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (skipParts.has(name)) continue;
      out.push(...walk(p));
    } else if (exts.has(name.slice(name.lastIndexOf('.')))) {
      out.push(p);
    }
  }
  return out;
}

// ── 轻量词法：标记每个字符是否处于代码位置（跳过字符串/模板/正则/注释） ──────────
// 正则字面量用启发式判定（除号误判最多吞一行，遇换行即放弃），够 lint 用。
function analyze(text) {
  const n = text.length;
  const code = new Uint8Array(n);
  const stack = [{ mode: 'code', depth: 0 }];
  const REGEX_BEFORE = new Set(['(', '{', '[', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^']);
  const KEYWORD_BEFORE = /(\breturn|\btypeof|\bcase|\bnew|\bdelete|\bvoid|\binstanceof|\bdo|\belse|\bin|\bof|\byield|\bawait)$/;
  for (let i = 0; i < n;) {
    const top = stack[stack.length - 1];
    const ch = text[i];
    if (top.mode === 'code') {
      if (ch === '/') {
        if (text[i + 1] === '/') { stack.push({ mode: 'line' }); i += 2; continue; }
        if (text[i + 1] === '*') { stack.push({ mode: 'block' }); i += 2; continue; }
        let p = i - 1;
        while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r')) p -= 1;
        const prev = p >= 0 ? text[p] : '';
        const word = p >= 8 ? text.slice(p - 8, p + 1) : '';
        if (prev === '' || REGEX_BEFORE.has(prev) || KEYWORD_BEFORE.test(word)) {
          stack.push({ mode: 'regex' }); i += 1; continue;
        }
        code[i] = 1; i += 1; continue;
      }
      if (ch === "'") { stack.push({ mode: 'sq' }); i += 1; continue; }
      if (ch === '"') { stack.push({ mode: 'dq' }); i += 1; continue; }
      if (ch === '`') { stack.push({ mode: 'tpl' }); i += 1; continue; }
      code[i] = 1; i += 1; continue;
    }
    if (top.mode === 'sq' || top.mode === 'dq') {
      if (ch === '\\') { i += 2; continue; }
      if ((top.mode === 'sq' && ch === "'") || (top.mode === 'dq' && ch === '"')) { stack.pop(); i += 1; continue; }
      if (ch === '\n') { stack.pop(); i += 1; continue; } // 未闭合字符串到行尾为止
      i += 1; continue;
    }
    if (top.mode === 'regex') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') { // 字符类内不识别 /
        let j = i + 1;
        while (j < n && text[j] !== ']') { if (text[j] === '\\') j += 1; j += 1; }
        i = j + 1; continue;
      }
      if (ch === '/' || ch === '\n') { stack.pop(); i += 1; continue; }
      i += 1; continue;
    }
    if (top.mode === 'tpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i += 1; continue; }
      if (ch === '$' && text[i + 1] === '{') { stack.push({ mode: 'texpr', depth: 0 }); i += 2; continue; } // ${ 的括号是模板语法，不标 code
      i += 1; continue;
    }
    if (top.mode === 'texpr') {
      if (ch === '{') { top.depth += 1; code[i] = 1; i += 1; continue; }
      if (ch === '}') {
        if (top.depth > 0) { top.depth -= 1; code[i] = 1; i += 1; continue; }
        stack.pop(); i += 1; continue; // 关闭 ${ 的 } 也不标 code
      }
      if (ch === "'") { stack.push({ mode: 'sq' }); i += 1; continue; }
      if (ch === '"') { stack.push({ mode: 'dq' }); i += 1; continue; }
      if (ch === '`') { stack.push({ mode: 'tpl' }); i += 1; continue; }
      if (ch === '/' && text[i + 1] === '/') { stack.push({ mode: 'line' }); i += 2; continue; }
      if (ch === '/' && text[i + 1] === '*') { stack.push({ mode: 'block' }); i += 2; continue; }
      code[i] = 1; i += 1; continue;
    }
    if (top.mode === 'line') { if (ch === '\n') { stack.pop(); } i += 1; continue; }
    if (top.mode === 'block') { if (ch === '*' && text[i + 1] === '/') { stack.pop(); i += 2; continue; } i += 1; continue; }
    i += 1;
  }
  return code;
}

const OK_FALSE = /ok\s*:\s*false/g;
const CODE_KEY = /\bcode\s*[:,}]/;
const HINT_KEY = /\bhint\s*[:,}]/;
const IGNORE = /failure-lint:ignore\s+(\S+)/;

const violations = [];
let files = 0;
let totalOkFalse = 0;
let ignored = 0;

for (const dir of scanDirs) {
  for (const file of walk(join(root, dir))) {
    files += 1;
    const rel = relative(root, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const code = analyze(text);
    let m;
    OK_FALSE.lastIndex = 0;
    while ((m = OK_FALSE.exec(text))) {
      // 只认代码位置的 ok:false（字符串/注释里的忽略）
      let inCode = true;
      for (let i = m.index; i < m.index + m[0].length; i += 1) if (!code[i]) { inCode = false; break; }
      if (!inCode) continue;
      const lineNo = text.slice(0, m.index).split('\n').length;
      totalOkFalse += 1;
      const line = lines[lineNo - 1] ?? '';

      // 行内豁免（本行尾注或前一行注）
      const prev = lines[lineNo - 2] ?? '';
      const ig = IGNORE.exec(line) || IGNORE.exec(prev);
      if (ig) { ignored += 1; continue; }

      // 检查范围：从匹配点向前扫到第一个让 depth 变负的 `}`（即本对象字面量的闭括号，
      // 兼容 `return {\n ok:false …}` 这种开括号在匹配点之前的多行写法），最多 1600 字符
      let depth = 0;
      let stop = Math.min(text.length, m.index + 1600);
      for (let i = m.index; i < stop; i += 1) {
        if (!code[i]) continue;
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') { depth -= 1; if (depth < 0) { stop = i + 1; break; } }
      }
      const span = text.slice(m.index, stop);
      if (CODE_KEY.test(span) && HINT_KEY.test(span)) continue;
      violations.push({ file: rel, line: lineNo, snippet: line.trim().slice(0, 120) });
    }
  }
}

violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const byFile = new Map();
for (const v of violations) byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);

// ── 棘轮基线 ──────────────────────────────────────────────────────────────
const baselinePath = join(root, 'scripts/lint-failures-baseline.json');
function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed.files ?? {} : {};
  } catch { return null; }
}
const baseline = readBaseline();
const hasBaseline = baseline !== null;
const regressions = [];
const debts = [];
const fixed = [];
for (const [file, count] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
  const allow = baseline?.[file];
  // 无基线（首次运行）：全部记为债务，允许 --update-baseline 生成；有基线后缺文件/超数才算回潮
  if (hasBaseline && (allow === undefined || count > allow)) regressions.push({ file, count, allow: allow ?? 0 });
  else if (count > 0) debts.push({ file, count, allow });
  else if (allow > 0) fixed.push({ file, from: allow });
}
for (const [file, allow] of Object.entries(baseline ?? {})) {
  if (!byFile.has(file) && allow > 0) fixed.push({ file, from: allow });
}

if (jsonMode) {
  console.log(JSON.stringify({
    ok: regressions.length === 0,
    code: regressions.length ? 'failure_visibility_regression' : 'lint_failures_ok',
    error: regressions.length
      ? `${regressions.length} 个文件的 ok:false 三件套违规数超过基线`
      : (debts.length ? `无新增违规；存量债务 ${debts.reduce((s, d) => s + d.count, 0)} 处待还` : '违规 0 处'),
    hint: regressions.length
      ? '为新增的 ok:false 补 code 与 hint；确不适用时加 // failure-lint:ignore <原因>'
      : '有修复时用 --update-baseline 收紧基线（只许降不许升）',
    scannedFiles: files,
    totalOkFalse,
    ignored,
    regressions,
    debts,
    fixed,
    violations,
  }, null, 2));
} else {
  console.log(`扫描 ${files} 个文件，代码位置 ok:false 共 ${totalOkFalse} 处（豁免 ${ignored} 处）`);
  if (debts.length) {
    console.log(`\n存量债务 ${debts.reduce((s, d) => s + d.count, 0)} 处（不超过基线，待后续批次烧掉）：`);
    for (const d of debts) console.log(`  ${d.file}: ${d.count}${d.allow === undefined ? '' : `/${d.allow}`}`);
    if (!hasBaseline) console.log('  （首次运行：用 node scripts/lint-failures.mjs --update-baseline 生成棘轮基线）');
  }
  if (fixed.length) {
    console.log(`\n较基线修复 ${fixed.reduce((s, f) => s + f.from, 0)} 处，用 --update-baseline 收紧基线：`);
    for (const f of fixed) console.log(`  ${f.file}: ${f.from} → 0`);
  }
  if (regressions.length) {
    console.log(`\n回潮 ${regressions.length} 个文件（违规数超过基线，禁止合入）：`);
    for (const r of regressions) console.log(`  ${r.file}: ${r.count} > 基线 ${r.allow}`);
    for (const v of violations.filter((v) => regressions.some((r) => r.file === v.file))) {
      console.log(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    console.log('\n修法：补 code（稳定错误码）与 hint（可执行下一步）；确不适用加 // failure-lint:ignore <原因>');
  } else if (violations.length === 0) {
    console.log('违规 0 处。');
  }
}

// --update-baseline：只接受持平或下降；有回潮时先修再收
if (args.has('--update-baseline')) {
  if (regressions.length) {
    console.error('\n存在回潮，先修复再更新基线。');
    process.exit(1);
  }
  for (const [file, allow] of Object.entries(baseline ?? {})) {
    const now = byFile.get(file) ?? 0;
    if (now > allow) {
      console.error(`拒绝：${file} 基线只许降不许升（${allow} → ${now}）。`);
      process.exit(1);
    }
  }
  const payload = {
    _comment: 'lint-failures 棘轮基线：按文件记录代码位置 ok:false 缺 code/hint 的存量数。只许降不许升；修复后运行 node scripts/lint-failures.mjs --update-baseline 收紧。生成时间见 _updated。',
    _updated: new Date().toISOString(),
    files: Object.fromEntries([...byFile].sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n基线已更新：${baselinePath}（${Object.values(payload.files).reduce((s, n) => s + n, 0)} 处债务）`);
}

if (regressions.length) process.exit(1);
