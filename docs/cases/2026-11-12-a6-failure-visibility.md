# Case 2026-11-12 · A6 失败可见性：ok:false 三件套静态检查 + P0 链路补齐

> 对应规则：`AGENTS.md` 铁律 1.7（失败必须可见且可行动）、`docs/guides/ERROR-REPORTING.md`。

## 现象

- 用户要求（A6 建议）：先做 `ok:false` 静态检查（缺 `code`/`hint` 即违规），再按 P0 链路补齐缺 hint 的失败路径，每条失败路径有断言钉住 code/hint 非空。
- 复现步骤：任意一次失败响应缺 `code`/`hint`（如 `src/bridge.js` 的大量 HTTP 接口错误、`plugins/surfcore/lib/updates.js` 的下载/校验失败），前端只能拿到一句 error 文案，没有机器可读错误码、没有「下一步该点什么」。
- 影响面：所有控制台操作（B站扫码、更新、语音包管理、桌宠）与 QQ 语音链路；不丢数据，但排障与自救成本高。

## 产品拍板记录（2026-11-12 用户逐条确认，逐条落档）

1. 新用户默认只开 QQ；B站/抖音等由用户在设置中自行开启。→ **涉及默认配置行为变更（现默认 QQ+B站 都开），单独立批，不在本批做，见「遗留」。**
2. 无高级/低级用户之分，所有功能都可用。→ 本批未触碰任何权限分叉；后续 PRD/设置页批次执行。
3. 抖音先不管；火山 TTS 真实计费/音质排进第一梯队。→ 本批未动抖音渠道代码；TTS 排期记录在案。
4. 不找志愿者，单人开发。→ 发布/验证策略相应简化。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS（darwin 分支实测） |
| SurfCore 版本 | dev 0.8.8（未 bump，本批不发布） |
| 安装方式 | git 工作树 `../surfcore-a6-failures`，分支 `feat/a6-failure-visibility`（基线 dev 80207ee） |
| 其它相关版本 | Node ≥22.13.0 |

## 完整逻辑（给用户看的那一遍）

- **链路**：`scripts/lint-failures.mjs`（新增，只读扫描）→ 扫 `plugins/surfcore/lib/**` 与 `src/**` 共 202 个 js/mjs 文件；每处处于代码位置的 `ok: false`（字符串/注释里的不算）要求其对象字面量闭合范围内同时有 `code:`（机器可读）与 `hint:`（下一步动作）。违规数与 `scripts/lint-failures-baseline.json`（棘轮基线，按文件计数）比对：超基线=回潮，退出码 1，禁止合入。业务侧修改落在 B站扫码（`plugins/surfcore/lib/bili-qr-login.mjs`）、更新链路（`plugins/surfcore/lib/updates.js`）、TTS/语音（`src/voice-core.js`、`src/voice-packs.js`、`plugins/surfcore/lib/voice-health.js`）。
- **机制**：三件套契约是「接口返回 `ok:false` 时必须带 `code`（机器读）+ `error`（人读）+ `hint`（下一步）」；前端收到 `ok:false` 必须展示。静态检查无法区分「边界响应」与「内部步骤」，所以配了行内豁免注释 `// failure-lint:ignore <原因>`：内部步骤（外层边界统一组装 code/hint 的）逐处写明豁免原因，例如 `fetchJson`/`downloadTo` 的失败由 `apply()` 边界映射为 `download.failed`+hint（updates.js L1849/L1861），QR 浏览器启动竞速由外层 catch 补 `QR_BROWSER_START_FAILED`。棘轮基线解决「存量 669 处不可能一批修完」：债务可见、只许降不许升。
- **爆炸半径**：1 个新脚本（只读，不碰运行时）+ 基线 JSON + 5 个业务文件的失败分支（只增字段，不改控制流）+ 1 个测试文件（加断言）。读者数：lint 由开发者/CI 手动跑；业务文件读者为网关进程与控制台。报错型改动（失败分支更显式）=1 分；不碰用户数据/密钥/花钱。
- **取舍**：
  - 路线 A（本批）：lint + 棘轮基线 + P0 链路清零 + 债务入册。收益：机制立即生效、回潮被阻断、669 处债务透明可分批烧；成本：一次写对词法（踩了 2 个坑，见下）；风险：低（只读脚本+加字段）；回滚：revert 提交即可，基线删掉无副作用。
  - 路线 B（放弃）：全量手改 805 处。收益：一步到位；成本：极大（bridge.js 一个文件 443 处）、质量风险高（铁律 3：不在错地基上叠补丁）；放弃。
  - 路线 C（放弃）：lint 严格无基线。收益：最严格；成本：永久 exit 1，工具没有可用性；放弃。
- **生效与重启**：lint 只在开发会话跑，无运行时进程需要重启；业务文件改动随下次 `npm start`/桥接重启生效（更新链路的 code/hint 在下一次「检查更新/更新」操作时经控制台呈现）。
- **实现坑（两次返工，值得记）**：① 模板字符串 `${…}` 的花括号会被朴素括号平衡当成对象边界——先实现了轻量词法状态机（字符串/模板/正则/注释四态 + `${}` 嵌套栈），`${` 与其闭合 `}` 不计括号；② 多行 `return {\n ok:false …}` 的开括号在匹配点之前，匹配后先遇到闭括号使 depth 变负——检查范围改为「向前扫到第一个让 depth 变负的 `}`」，兼容两种写法。

## 修法

- **新增 `scripts/lint-failures.mjs`**（只读、不联网、不改业务代码）：扫描 + 轻量词法 + 豁免注释 + 棘轮基线（`--update-baseline` 只接受持平或下降，基线文件带 `_comment` 说明生成方式）。`package.json` 加 `"lint:failures"`。
- **P0 链路补 code/hint（全部清零）**：
  - `bili-qr-login.mjs`：`validateQrAccount` 4 个失败分支加 `code: 'bili.qr-no-mid'|'bili.qr-wrong-account'` + hint；`pollQrLogin` 会话过期加 `code: 'bili.qr-session-gone'`；内部候选探测/启动竞速 7 处豁免（外层汇总）。
  - `updates.js`：`downloadReleaseAsset` 加 `download.no-asset-url/download.failed/download.checksum-mismatch/download.size-mismatch`；`updateFromZip` catch 保留 `error.code` 并兜底 `update.zip-failed`+hint；`apply()` 两个前置守卫加 `apply.in-progress/apply.no-selection`；每个组件结果加 `apply.no-installer/apply.install-threw/apply.install-failed/apply.no-dir`；`fetchJson`/`downloadTo`/`readPackageManifest`/备份/内部 git 探测共 22 处豁免（边界已映射）。
  - `voice-packs.js`：卸载/取消导入/取消安装/端口占用 6 处加 `pack.busy-port/pack.dir-busy/pack.remove-failed/pack.install-not-running/pack.port-stuck` + hint。
  - `voice-core.js`/`voice-health.js`：内部探测与配置校验诊断 11 处豁免（reason 原文已可操作，直接展示）。
- **失败分支测试**：`scripts/test-bili-qr-login.mjs` 加循环断言——5 个失败分支 `code` 必须匹配 `/^bili\.qr-/`、`hint` 长度 ≥8（AGENTS 1.7 第 5 条）。
- **前端 catch 审计（结论：无需改动）**：`client.js` 统一 toast = `notify()`/`window.__surfcoreToast`，逐 tab 以 `toast:` prop 下发；131 处 catch 的主体是 `setErr(e.message)` 渲染红字；仅 3 处出现 console，均为 `(window.__surfcoreToast || console.warn)(...)` toast 优先、console 兜底。无「只 console」静默失败。
- **为什么选这个方案**：更简单的「只跑一次全量修复」不可行（bridge.js 443 处，手改必出质量问题）；更严格的「无基线全量拦截」会让工具永久红着没人看。棘轮是两条路中间唯一可执行的。
- **回滚方式**：`git revert` 本批两个提交；`scripts/lint-failures-baseline.json` 删除无副作用；业务文件只增字段，revert 后行为回到原样。

## 验证

- 自动化：`npm run test:audit` → **195/195 通过**；`node scripts/test-bili-qr-login.mjs` → 通过（含新增三件套断言）。
- lint 自检：`npm run lint:failures` → 退出 0，`扫描 202 个文件，代码位置 ok:false 共 1012 处（豁免 41 处）`，存量债务 669 处（33 个文件，不超基线）。
- 篡改测试：临时删掉 `voice-packs.js` L600 的 `hint` → lint 退出 **1** 并精确报 `src/voice-packs.js: 1 > 基线 0` + 行号与原文 → 还原后退出 **0**。
- 词法自检：`bili.qr-*` 多行对象（含模板字符串插值）不再误报（修掉 `${}` 与多行开括号两个坑后 L318/L338 转绿）。
- 没验证到的部分：lint 未接入 CI（本仓库无 CI，靠会话自觉跑）；`src/bridge.js` 等 669 处债务只圈定未修；豁免注释的「外层确实会映射」是逐处人工核对的，没有自动化证据。

## 遗留 / 后续

- **债务清单（669 处，`--update-baseline` 后按文件烧）**：`src/bridge.js` 443、`plugins/surfcore/lib/index.js` 32、`pet.js` 26、`client.js` 19、`pet-purpose.js` 18、`memory-v2-management.mjs` 11、`bili-v2-video-metadata.mjs` 10、`pet-chat.js` 9、`privacy.js` 9、`src/memory-card.js` 9、`src/state-acl.mjs` 9、`pet-api.js` 8、`plugins/surfcore/lib/memory-card.js` 7、`src/bili-api.js` 7、memory/scheduler/bili-share-scheduler/task-harness 各 5、lib/bridge.js/extensions/bili-dynamics/snowluma-conn 各 4、interaction-lifecycle/node-path 各 3、douyin-companion 2、billing/compat/platforms/snowluma-install/bili-memory/dsh-health/outbox/safe-fetch 各 1。建议顺序：index.js → pet 系列（桌宠降级后可放后）→ bridge.js 按路由分片烧。
- **产品拍板 1（默认只开 QQ）待另立批次**：改默认配置 + 迁移老用户配置（不能静默关掉已开的 B站）+ 设置页开关核对。
- lint:failures 建议并入 `test:audit` 前置（待债务烧到可接受水位再收紧，避免门禁长期红）。
