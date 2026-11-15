// 人格卡（roles/<名称>.md）的解析与「注入取用」。
//
// V2-only（2026-11-12 一代仿真退役，不留兼容）：一代仿真（reserved）已删除，
// 〔一代〕小节一律不注入；未标记与 〔二代〕 小节照常注入。
// 仍识别 〔一代〕 标记只有一个目的：把老卡片里的一代专属小节干净地排除掉，
// 并让 GEN1_ROLE_LINE_RE 的兜底过滤/警告仍有据可查。
//   ## 表情包体系 〔二代〕      → 注入
//   ## 分条方式 〔一代〕        → 一律不注入（V1 已退役）
//   ## 你是谁                   → 注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认；〔一代〕 只用于排除。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 *   mode === 'v1' 的小节是退役的一代内容：调用方一律排除。
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出真正要注入的人格文本（V2 视角：all + 〔二代〕，已去掉模式标记）。
 */
export function selectRoleText(text) {
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === 'v2')
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节是否会被注入，供控制台预览。
 */
export function roleSectionReport(text) {
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === 'v2',
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计注入相关字符数，用于控制台提示与截断警告。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    injected: selectRoleText(source).length,
  };
}

// 一代仿真遗留指令：〔一代〕 小节会被排除；但没标记的正文里出现这些行时，
// currentRoleHint 仍会按 GEN1 兜底逐行过滤，roleWarnings 也会提示清理。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
