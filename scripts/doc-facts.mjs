#!/usr/bin/env node
/**
 * 文档事实校验（离线、只读）
 *
 * 把容易腐烂的数字（版本号 / 设置页标签数 / src 模块引用 / 控制台路径数 /
 * 桥接行数）从代码里数出来，再和文档里写的数字对照。
 *
 * 用法：
 *   node scripts/doc-facts.mjs           # 人读输出；有不符/缺失时退出码 1
 *   node scripts/doc-facts.mjs --json    # 机器读输出；退出码同上
 *   node scripts/doc-facts.mjs --help
 *
 * 口径（改动代码后请同步这里，不要改文档去迁就脚本）：
 *   - 版本：根 package.json 的 version；插件 package.json 必须与它一致。
 *   - 标签：plugins/surfcore/lib/client.js 里 const TABS 的条目数。
 *   - src 引用：plugins/surfcore/{lib,tools,presets} 下 .js/.mjs 中
 *     "../../../src/..." 的模块去重数 + 出现总次数。
 *   - 控制台路径：src/bridge.js 中 url.pathname === 与 pathname.startsWith
 *     的出现次数（同一行有多个判断也分别计数）。
 *   - 控制台页面：public/console.html 的 data-page 去重数。
 *   - 桥接行数：src/bridge.js 的行数（含最后一行，不含末尾换行产生的空行）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`文档事实校验（离线、只读）

  node scripts/doc-facts.mjs          人读输出；有不符/缺失时退出码 1
  node scripts/doc-facts.mjs --json   机器读输出；退出码同上

退出码：
  0 = 全部一致
  1 = 有不符或缺失
  2 = 脚本自身无法读取必要文件`);
  process.exit(0);
}

const jsonMode = args.has('--json');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function countLines(text) {
  if (!text) return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function walkFiles(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

/* ------------------------------ 事实 ------------------------------ */

const rootPkg = readJson('package.json');
const pluginPkg = readJson('plugins/surfcore/package.json');

const clientCode = read('plugins/surfcore/lib/client.js');
const tabsBlock = clientCode.match(/const TABS = \[([\s\S]*?)\n\s*\];/);
const tabs = tabsBlock
  ? [...tabsBlock[1].matchAll(/^\s*\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/gm)].map((m) => ({
      id: m[1],
      label: m[2],
    }))
  : [];

const refFiles = ['plugins/surfcore/lib', 'plugins/surfcore/tools', 'plugins/surfcore/presets']
  .map((d) => join(ROOT, d))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });

const refModules = new Set();
let srcRefs = 0;
for (const dir of refFiles) {
  for (const file of walkFiles(dir, ['.js', '.mjs'])) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.\.\/\.\.\/\.\.\/src\/[A-Za-z0-9._/-]+/g)) {
      srcRefs += 1;
      refModules.add(m[0].replace(/^.*\/src\//, ''));
    }
  }
}

const bridgeCode = read('src/bridge.js');
const bridgeLines = countLines(bridgeCode);
const consoleExact = (bridgeCode.match(/url\.pathname ===/g) || []).length;
const consolePrefix = (bridgeCode.match(/pathname\.startsWith/g) || []).length;

const consoleHtml = read('public/console.html');
const consolePages = new Set([...consoleHtml.matchAll(/data-page="([^"]+)"/g)].map((m) => m[1])).size;

const pluginReadme = read('plugins/surfcore/README.md');
const tabSection = pluginReadme.split(/^## 设置窗口\s*$/m)[1]?.split(/^## /m)[0] || '';
const pluginReadmeTabs = (tabSection.match(/^\| \*\*/gm) || []).length;

const facts = {
  version: rootPkg.version,
  pluginVersion: pluginPkg.version,
  tabs: tabs.length,
  tabLabels: tabs.map((t) => t.label),
  pluginReadmeTabs,
  srcModules: refModules.size,
  srcRefs,
  bridgeLines,
  consoleExact,
  consolePrefix,
  consolePages,
};

/* ------------------------------ 检查 ------------------------------ */

const failures = [];
const missing = [];

/**
 * 在指定文档里按行找正则，把所有命中值与期望值比较。
 * @param {string} label 人读名称
 * @param {string} rel 文档相对路径
 * @param {RegExp} re 必须带 g 标志；第 1 组是数字（可含逗号）
 * @param {number|((m: RegExpMatchArray) => boolean)} expect
 * @param {(m: RegExpMatchArray) => string} [detail]
 */
function checkNumber(label, rel, re, expect, detail) {
  let text;
  try {
    text = read(rel);
  } catch {
    missing.push(`${label}：读不到 ${rel}`);
    return;
  }
  const lines = text.split('\n');
  let hits = 0;
  lines.forEach((line, i) => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(line)) !== null) {
      hits += 1;
      const got = Number(String(m[1]).replace(/,/g, ''));
      const ok = typeof expect === 'function' ? expect(m) : got === expect;
      if (!ok) {
        failures.push({
          label,
          file: rel,
          line: i + 1,
          got: detail ? detail(m) : String(m[1]),
          want: typeof expect === 'function' ? '规则不满足' : String(expect),
        });
      }
      if (m[0] === '') rx.lastIndex += 1;
    }
  });
  if (hits === 0) missing.push(`${label}：${rel} 里没有找到可校验的表述（可能被改写）`);
}

// 版本：插件与根一致，文档与 package.json 一致。
if (facts.pluginVersion !== facts.version) {
  failures.push({
    label: '插件版本 = 根版本',
    file: 'plugins/surfcore/package.json',
    line: 1,
    got: facts.pluginVersion,
    want: facts.version,
  });
}
for (const [rel, re] of [
  ['docs/ROADMAP.md', /当前版本：`([^`]+)`/],
  ['docs/guides/DSH_SETUP.md', /当前 `([0-9][^`]*)`/],
]) {
  const text = read(rel);
  const m = text.match(re);
  if (!m) {
    missing.push(`版本等值：${rel} 未找到版本表述`);
  } else if (m[1] !== rootPkg.version) {
    const line = text.slice(0, m.index).split('\n').length;
    failures.push({ label: '文档版本 = package.json', file: rel, line, got: m[1], want: rootPkg.version });
  }
}

checkNumber('设置页标签数（ARCHITECTURE）', 'docs/guides/ARCHITECTURE.md', /设置页 (\d+) 个标签/g, facts.tabs);
checkNumber('设置页标签数（plugin README 表格行）', 'plugins/surfcore/README.md', /^## 设置窗口$/gm, () => true);
checkNumber('设置页标签数（根 README 声明）', 'README.md', /(\d+) 个标签：/g, facts.tabs);
checkNumber('设置页标签数（docs/README 索引）', 'docs/README.md', /设置页 (\d+) 个标签/g, facts.tabs);
checkNumber('设置页标签数（12 课）', 'docs/guides/12-LESSONS-ARCHITECTURE.md', /client\.js（(\d+) 标签）/g, facts.tabs);

// 根 README 的标签清单逐项数，防止“数字对了、列表少一个”。
{
  const text = read('README.md');
  const m = text.match(/(\d+) 个标签：([^\n]+)/);
  if (!m) {
    missing.push('根 README 标签清单：未找到“N 个标签：…”');
  } else {
    const items = m[2].split('/').map((s) => s.replace(/[。.\s]/g, '')).filter(Boolean);
    if (items.length !== facts.tabs) {
      failures.push({ label: '根 README 标签清单条数', file: 'README.md', line: text.slice(0, m.index).split('\n').length, got: String(items.length), want: String(facts.tabs) });
    }
    for (const must of ['抖音', '语音']) {
      if (!items.includes(must)) {
        failures.push({ label: `根 README 标签清单缺「${must}」`, file: 'README.md', line: text.slice(0, m.index).split('\n').length, got: '缺', want: must });
      }
    }
  }
}

// 插件 README 的表格行数单独比（与上面的“## 设置窗口”存在性检查配合）。
{
  const text = pluginReadme;
  const idx = text.split('\n').findIndex((l) => l.trim() === '## 设置窗口');
  if (idx < 0) {
    missing.push('plugin README 设置窗口章节：未找到');
  } else if (pluginReadmeTabs !== facts.tabs) {
    failures.push({ label: 'plugin README 设置窗口表格行数', file: 'plugins/surfcore/README.md', line: idx + 1, got: String(pluginReadmeTabs), want: String(facts.tabs) });
  }
}

// src 引用：模块数与总处数
for (const [rel, re] of [
  ['docs/guides/ARCHITECTURE.md', /引用 (\d+) 个核心模块共 (\d+) 处/g],
]) {
  const text = read(rel);
  let hit = 0;
  text.split('\n').forEach((line, i) => {
    let m;
    const rx = new RegExp(re.source, 'g');
    while ((m = rx.exec(line)) !== null) {
      hit += 1;
      if (Number(m[1]) !== facts.srcModules || Number(m[2]) !== facts.srcRefs) {
        failures.push({
          label: 'src 模块引用数',
          file: rel,
          line: i + 1,
          got: `${m[1]} 个模块 / ${m[2]} 处`,
          want: `${facts.srcModules} 个模块 / ${facts.srcRefs} 处`,
        });
      }
    }
  });
  if (hit === 0) missing.push(`src 模块引用数：${rel} 未找到`);
}

checkNumber('src 模块引用数（FOLDER_MAP）', 'docs/FOLDER_MAP.md', /（(\d+) 个模块、(\d+) 处/g, (m) => Number(m[1]) === facts.srcModules && Number(m[2]) === facts.srcRefs, (m) => `${m[1]} 个模块 / ${m[2]} 处`);
checkNumber('src 模块引用数（12 课）', 'docs/guides/12-LESSONS-ARCHITECTURE.md', /（(\d+) 个模块、(\d+) 处/g, (m) => Number(m[1]) === facts.srcModules && Number(m[2]) === facts.srcRefs, (m) => `${m[1]} 个模块 / ${m[2]} 处`);

// 桥接行数
checkNumber('桥接行数（ARCHITECTURE）', 'docs/guides/ARCHITECTURE.md', /bridge\.js` 是\*\*全仓库最大单体\*\*（([\d,]+) 行）/g, facts.bridgeLines, (m) => `${m[1]} 行`);
checkNumber('桥接行数（FOLDER_MAP）', 'docs/FOLDER_MAP.md', /bridge\.js` 是主程序（\*\*([\d,]+) 行\*\*/g, facts.bridgeLines, (m) => `${m[1]} 行`);
checkNumber('桥接行数（RISK_REGISTER）', 'docs/RISK_REGISTER.md', /bridge\.js` \*\*([\d,]+) 行\*\*/g, facts.bridgeLines, (m) => `${m[1]} 行`);

// 控制台路径与页面
{
  const rel = 'docs/guides/ARCHITECTURE.md';
  const text = read(rel);
  const m = text.match(/控制台 \*\*(\d+) 条精确路径判断 \+ (\d+) 条前缀判断\*\*/);
  if (!m) {
    missing.push('控制台路径判断数：ARCHITECTURE 未找到');
  } else if (Number(m[1]) !== facts.consoleExact || Number(m[2]) !== facts.consolePrefix) {
    failures.push({
      label: '控制台路径判断数',
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      got: `${m[1]} 精确 + ${m[2]} 前缀`,
      want: `${facts.consoleExact} 精确 + ${facts.consolePrefix} 前缀`,
    });
  }
}

checkNumber('控制台页面数（根 README）', 'README.md', /控制台 (\d+) 个页面/g, facts.consolePages);
checkNumber('控制台页面数（ARCHITECTURE）', 'docs/guides/ARCHITECTURE.md', /控制台 (\d+) 个页面/g, facts.consolePages);

// 明确禁止回流的旧表述（只扫当前状态文档，不扫历史案例与 HANDOFF）。
const BANNED = [
  /不支持 macOS/,
  /Windows 优先/,
  /暂不支持（沙箱/,
  /11 个核心模块/,
  /126 条路径/,
  /14,964/,
  /15,000 行/,
];
const CURRENT_DOCS = [
  'README.md',
  'plugins/surfcore/README.md',
  'docs/README.md',
  'docs/FOLDER_MAP.md',
  'docs/ROADMAP.md',
  'docs/RISK_REGISTER.md',
  'docs/guides/ARCHITECTURE.md',
  'docs/guides/BOUNDARIES.md',
  'docs/guides/DSH_SETUP.md',
  'docs/guides/12-LESSONS-ARCHITECTURE.md',
];
for (const rel of CURRENT_DOCS) {
  let text;
  try {
    text = read(rel);
  } catch {
    missing.push(`旧表述扫描：读不到 ${rel}`);
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const re of BANNED) {
      if (re.test(line)) {
        failures.push({ label: `旧表述残留 ${re}`, file: rel, line: i + 1, got: line.trim().slice(0, 60), want: '删掉或改成实测值' });
      }
    }
  });
}

/* ------------------------------ 输出 ------------------------------ */

const failed = failures.length + missing.length;

if (jsonMode) {
  console.log(JSON.stringify({ facts, failures, missing, ok: failed === 0 }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

console.log('SurfCore 文档事实校验（离线 / 只读）');
console.log('─'.repeat(60));
console.log('实测事实：');
console.log(`  版本                ${facts.version}（插件 ${facts.pluginVersion}）`);
console.log(`  设置页标签          ${facts.tabs}（${facts.tabLabels.join(' / ')}）`);
console.log(`  src 模块引用        ${facts.srcModules} 个模块 / ${facts.srcRefs} 处`);
console.log(`  桥接行数            ${facts.bridgeLines}`);
console.log(`  控制台路径判断      ${facts.consoleExact} 精确 + ${facts.consolePrefix} 前缀`);
console.log(`  控制台页面          ${facts.consolePages}`);
console.log('─'.repeat(60));

if (failed === 0) {
  console.log('✅ 所有文档数字与代码一致，未发现旧表述残留。');
  process.exit(0);
}

if (failures.length) {
  console.log(`❌ 不符 ${failures.length} 处：`);
  for (const f of failures) {
    console.log(`  - [${f.label}] ${f.file}:${f.line}  文档=${f.got}  实测=${f.want}`);
  }
}
if (missing.length) {
  console.log(`⚠️  缺失 ${missing.length} 处：`);
  for (const m of missing) console.log(`  - ${m}`);
}
console.log('─'.repeat(60));
console.log('修法：改文档为“实测”列的值；不要改脚本去迁就文档。');
console.log('若确实改了统计口径，请同步更新脚本顶部注释与对应文档的“数字来源”。');
process.exit(1);
