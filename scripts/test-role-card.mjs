// 人格卡按 V2-only 语义取用（src/role-card.js）的离线单测。
// 保证：〔一代〕小节一律不注入（一代仿真已退役）、〔二代〕与未标记小节照常注入、
// 模式标记能被正确剥离、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别；未标记的小节照常注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('V2-only：〔一代〕小节一律不注入，〔二代〕与未标记小节照常注入', () => {
  const text = selectRoleText(CARD);
  // 公共内容保留
  assert.match(text, /你是群里的测试角色/);
  assert.match(text, /简短、口语化/);
  // 二代专属保留；一代专属（含一代指令）一律排除
  assert.match(text, /qq_send_message/);
  assert.doesNotMatch(text, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  const text = selectRoleText(CARD);
  assert.doesNotMatch(text, /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(text, /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const text = selectRoleText(card);
  assert.match(text, /- b/); assert.match(text, /- c/);
  assert.doesNotMatch(text, /- a/); assert.doesNotMatch(text, /- d/);
});

test('没有模式标记的老卡片：完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  const text = selectRoleText(card);
  assert.match(text, /开头一句话/);
  assert.doesNotMatch(text, /- x/);
  assert.match(text, /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v2Only > 0, '应能统计出二代专属的字符数');
  assert.ok(stats.injected < stats.total, '筛掉一代小节后应短于原文');
  const report = roleSectionReport(CARD);
  const v1Section = report.find((r) => r.heading === '二、分条方式');
  assert.equal(v1Section.injected, false, '一代专属小节应标为不注入');
  assert.equal(v1Section.mode, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, true, '二代专属小节应标为注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('真实人格卡可用，且公共内容不丢、一代指令不注入', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const text = selectRoleText(raw);
  assert.ok(text.length > 0);
  assert.match(text, /小鲸鱼/);
  assert.match(text, /AI 味|去 AI 味/);
  // 注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(text, /空格分隔（例如|\[SILENT\]/);
});
