// dev 通道发布链路（2026-11-01 用户定）：设计契约测试，不联网、不发版。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncDocVersions } from './publish-dev-doc-sync.mjs';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
const updates = read('plugins/surfcore/lib/updates.js');
const client = read('plugins/surfcore/lib/client.js');
const plugin = read('plugins/surfcore/lib/index.js');
const publishDev = read('scripts/publish-dev.mjs');
const version = read('scripts/version.mjs');

// 1) 版本规则：dev 版本合法、且比较上低于同号正式版
ok(/\(rc\|beta\|alpha\|dev\)/.test(version), 'version.mjs 允许 -dev.N 版本');
ok(updates.includes('pre-release'), '更新器识别 Pre-release');
ok(updates.includes("code: 'DEV_NO_BUILD'"), '没有 dev 构建时有明确状态');
ok(updates.includes("'channel-switch'"), '从正式版切 dev 允许安装一次');

// 2) 稳定通道绝不查 dev
const stableBlock = updates.slice(updates.indexOf("channel === 'dev'"), updates.indexOf('// 提交级比对'));
ok(updates.includes("channel === 'dev'"), '有 dev 分支判断');
ok(updates.includes("channel: channel() === 'dev' ? 'dev' : 'stable'"), 'status 暴露通道');
ok(updates.includes('resetCheck'), '切换通道能清旧结果（main 不被 dev 打扰）');

// 3) 发布脚本：只发 dev、只发 Pre-release、不碰 main
ok(publishDev.includes("rev-parse', '--abbrev-ref', 'HEAD') !== 'dev'"), '只允许在 dev 分支发布');
ok(publishDev.includes('prerelease: true'), '发布为 Pre-release');
ok(publishDev.includes('refs/heads/dev'), '推 dev 分支（tag 需要可达 commit）');
ok(!/PATCH', `\/repos\/\$\{repoArg\}\/git\/refs\/heads\/main/.test(publishDev), '发布 dev 不得改 main');
ok(publishDev.includes('verify-ref') && publishDev.includes('问题 0 个'), 'dev 构建也要过清单门禁');

// 4) UI：检查更新下面有 main/dev 单选
ok(client.includes('update-channel'), '设置页有通道单选');
ok(client.includes('main（正式版'), 'main 选项文案');
ok(client.includes('dev（测试版'), 'dev 选项文案');
ok(client.includes('switchUpdateChannel'), '切换走 set-channel');
ok(plugin.includes("action === 'set-channel'"), '后端支持 set-channel');
ok(plugin.includes('updates.resetCheck'), '切通道时清掉旧检查结果');

// 5) 发布脚本必须同步两处文档版本字，否则 doc-facts 会红（2026-11-15 根治）
ok(publishDev.includes('syncDocVersions'), 'publish-dev 调用文档版本字同步');
ok(publishDev.includes('docs/ROADMAP.md') && publishDev.includes('docs/guides/DSH_SETUP.md'), '同步覆盖两处文档');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dev-publish-docsync-'));
  try {
    for (const rel of ['docs/ROADMAP.md', 'docs/guides/DSH_SETUP.md']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(path.resolve(rel), path.join(root, rel));
    }
    const rules = [
      ['docs/ROADMAP.md', /当前版本：`([^`]+)`/],
      ['docs/guides/DSH_SETUP.md', /当前 `([0-9][^`]*)`/],
    ];
    const target = '9.9.9-dev.9';
    let red = 0;
    for (const [rel, re] of rules) {
      const m = fs.readFileSync(path.join(root, rel), 'utf8').match(re);
      if (m && m[1] !== target) red += 1;
    }
    ok(red === 2, '同步前两处文档版本字与目标版本不一致（红）', `red=${red}`);
    const changed = syncDocVersions({ dir: root, version: target, log: () => {} });
    let green = 0;
    for (const [rel, re] of rules) {
      const m = fs.readFileSync(path.join(root, rel), 'utf8').match(re);
      if (m && m[1] === target) green += 1;
    }
    ok(green === 2 && changed.length === 2, '同步后两处文档版本字与目标版本一致（绿）', `green=${green} changed=${changed.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ dev 通道发布链路通过');
