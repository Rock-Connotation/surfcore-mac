# 文档平台事实错误与易腐数字校正（A2）+ 可执行校验（A3）

## 现象

- 用户按 `README.md` / `docs/guides/BOUNDARIES.md` 判断平台，会看到“Windows 优先 / 不支持 macOS 正式支持”；
  但代码里已有 darwin 分支，`HANDOFF.md` 顶部也记录 2026-11-12 的 macOS 真机验收。
- 同一批文档里的数字与代码脱节：`ROADMAP.md` 写“当前版本 0.1.0”，实际 `0.8.8`；
  设置页写 13/14 个标签，实际 15；控制台写 126 条路径，实际 163 条精确判断 + 17 条前缀；
  插件引用 `src/` 写 11/12 个模块、26/19 处，实际 38 个模块、96 处；桥接写 15,000/14,964 行，实际 18,221。
- 这些错误不会被任何门禁发现，因为文档数字是手工抄写的快照。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS（darwin），Node `v26.5.1` |
| DSH 版本 | `0.2.1-rc.5` |
| SurfCore 版本 | `0.8.8`（未 bump） |
| 安装方式 | git worktree：`../surfcore-doc-facts`，分支 `feat/doc-facts`（从 `dev` 切） |
| 基线 | `dev` @ `80207ee` |

## 根因

- 代码位置（文件:行）：
  - 平台分支：`src/task-harness.js:661`（`open`/`osascript`/`shortcuts`）、`src/bridge.js:1471`、`plugins/surfcore/lib/bili-qr-login.mjs:38`、`plugins/surfcore/lib/bridge-process.js:16`。
  - 标签真相：`plugins/surfcore/lib/client.js:6939-6955` 的 `const TABS`。
  - 路径真相：`src/bridge.js` 的 `url.pathname ===` / `pathname.startsWith`。
  - 引用真相：`plugins/surfcore/{lib,tools,presets}` 里 `../../../src/...` 的相对引用。
- 问题链条：平台支持在实现层已经扩展（macOS 真机验收），但“平台”作为产品事实只写在文档里，没有回写到文档；
  数量类事实（标签/路径/模块/行数）原本靠人工抄写，代码增长后无人重算。
- 为什么之前没发现：没有“文档 ↔ 代码”的可执行对照；发布门禁只校验制品与清单，不校验文档数字。

## 完整逻辑（给用户看的那一遍）

- **链路**：文档（`README.md`、`docs/guides/BOUNDARIES.md`、`ARCHITECTURE.md`、`FOLDER_MAP.md`、`ROADMAP.md`、`docs/README.md`、`DSH_SETUP.md`、`12-LESSONS-ARCHITECTURE.md`、`RISK_REGISTER.md`、`plugins/surfcore/README.md`）
  → 读者是用户与后续会话；它们不参与运行时，不改状态。真相来源是代码：`client.js` 的 `TABS`、`bridge.js` 的路由判断、`plugins/surfcore/**` 的 `src` 引用、`package.json` 的版本。
  新增 `scripts/doc-facts.mjs` 只读这些文件，不写盘、不联网，由 `npm run doc-facts` 调用。
- **机制**：文档是人工快照，代码是唯一真相；快照没有校验就会腐烂。平台事实尤其危险：它不是“数字偏差”，而是把“已支持”说成“不支持”，会让用户直接放弃或按错误路径排查。
  因此这次同时做两件事：把事实改对（A2），把“事实是否会再次腐烂”变成可执行检查（A3）。
- **爆炸半径**：进程 0 个、运行时读者 0 个（纯文档与开发脚本）；文档读者是用户 + 协作会话；静默错误=3（用户读错平台会静默放弃）。
  不碰用户数据、密钥、花钱路径，也不改任何业务代码。
- **取舍**：
  - A：只改 README/BOUNDARIES 两处。收益最快，但同类数字仍会继续腐烂，且无法防止回退。
  - B：改全部当前状态文档 + 新增离线校验脚本（本次选）。收益是“以后改代码会立刻发现文档不一致”，成本是一个 ~370 行只读脚本 + 一次全量校准，风险仅脚本误报。
  - C：顺手重构 `bridge.js` 或补 macOS 缺失能力。收益与本次目标无关，成本高、回归面大，明确不做。
- **生效与重启**：文档改动立即生效（下次打开即新内容）；脚本无运行时、不需要重启任何进程。

## 修法

- 平台事实：
  - `README.md`：平台行、前置条件、支持矩阵、FAQ 改为 Windows / macOS，并注明 macOS 已有真机验收、Linux 未验证。
  - `docs/guides/BOUNDARIES.md`：操作系统行改为双平台；“不支持”列表删掉 macOS、保留 Linux；补 macOS 支持范围说明。
- 同类数字（全部写成实测值，并在文档里注明来源命令/入口）：
  - 版本 `0.8.8`（`ROADMAP.md`、`DSH_SETUP.md`）。
  - 设置页 15 标签（`README.md`、`ARCHITECTURE.md`、`FOLDER_MAP.md`、`docs/README.md`、`12-LESSONS`、插件 README 表格补齐“语音/抖音”两行）。
  - 控制台 163 条精确路径 + 17 条前缀判断（`ARCHITECTURE.md`、`BOUNDARIES.md`、`FOLDER_MAP.md`、`ROADMAP.md`、`RISK_REGISTER.md`）。
  - `src` 引用 38 个模块 / 96 处（`README.md`、`ARCHITECTURE.md`、`FOLDER_MAP.md`、`12-LESSONS`、`RISK_REGISTER.md`）。
  - 桥接 18,221 行（`ARCHITECTURE.md`、`FOLDER_MAP.md`、`docs/README.md`、`ROADMAP.md`、`RISK_REGISTER.md`）。
- A1 的文档表达（未删任何渠道）：根 README 新增「4.1 能力状态与暂不做的渠道」，插件 README 主叙事改为“单机运行的数字角色运行环境”，贴吧/微信/小红书标为占位或提案。
- 新增 `scripts/doc-facts.mjs` + `package.json` 的 `doc-facts`：
  - 统计口径写在脚本顶部注释；输出“实测事实 / 不符 / 缺失”，任何不符或缺失退出码 1；`--json` 供机器读。
  - 同时扫描禁止回流的旧表述（`不支持 macOS`、`Windows 优先`、`126 条路径`、`15,000 行` 等），只扫当前状态文档，不扫历史案例与 HANDOFF。
  - `docs/README.md` 增加调用说明。

## 验证

- 自动化：
  - `npm run doc-facts` → `✅ 所有文档数字与代码一致，未发现旧表述残留。` 退出码 0。
  - 反向验证：把 `README.md` 的“15 个标签”临时改成 14，脚本输出 `README.md:195 文档=14 实测=15`，退出码 1；恢复后通过。
  - `npm run test:audit` → `Audit suite: 195/195 scripts passed.` 退出码 0。
- 失败路径（用户看到什么 / 下一步 / 失败分支断言）：
  - 文档数字不符：脚本逐条打印 `[检查名] 文件:行 文档=… 实测=…`，并给出“改文档为实测值”的下一步；退出码 1。
  - 表述被改写导致找不到可校验项：打印“缺失 … 未找到”，同样退出码 1，避免“删掉数字就通过”。
  - 脚本自身读不到必要文件：以缺失项报告，不会静默跳过。
- 没验证到的部分（老实写）：
  - 没有在 Windows 上重跑 `test:audit`；本次改动不碰运行时，但 Windows 矩阵仍未验证。
  - `docs/HANDOFF.md` 的历史段落保留旧数字（历史记录不改写），也不在脚本的禁止扫描范围内。
  - 控制台“去重端点数”与“路径判断出现次数”是两种口径；本次采用后者（163/17），已写入脚本注释，等用户确认是否要换成前者。

## 遗留 / 后续

- 需要用户拍板：控制台路径的口径（判断出现次数 vs 去重端点）、`src` 引用是否含 `presets/`（当前含）。
- 需要补的测试：无新增运行时行为；建议后续把 `npm run doc-facts` 加进发布会话的发布前检查清单。
- 需要改的文档：等口径确认后，如改口径需同步脚本注释与上述文档的“数字来源”。
