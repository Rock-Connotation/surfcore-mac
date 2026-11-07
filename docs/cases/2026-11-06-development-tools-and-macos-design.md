# 开发工具路由与 macOS 技术设计归档

## 现象与环境

用户要求结合本机安装与其他项目会话历史，把本项目有用的工具调用放到合适位置，并收录下载目录中的技术设计。
基线为 `feat/mac` / SurfCore v0.8.8 / `0deb826`。本次使用独立工作树 `../surfcore-tooling-docs`、分支 `docs/tooling-macos`；本克隆没有 `dev`，没有更改稳定线或创建发布。

## 根因

仓库有开工规则与产品 Agent 工具说明，却没有开发工具的任务路由；8 份外部设计自带分册链接，却缺少被引用的目录首页。
历史文档称 `design/`、`research/` 不存在；新材料归档后必须同步索引，同时保留 `.gitignore` 的本地资料边界。

## 完整逻辑

1. **链路**：开发 Agent 读 `AGENTS.md` → 按需读 `docs/guides/DEVELOPMENT-TOOLS.md` → 选择当前可用工具与 skill。用户读 `docs/README.md` → 本地 `docs/design/macos/README.md` → 7 篇分册或合并版。`docs/FOLDER_MAP.md` 同步目录职责。
2. **机制**：常驻规则只保留触发条件与入口；通用调用策略可跟踪，本机安装/频次证据进忽略的 `docs/research/`，设计原稿进忽略的 `docs/design/`。开发权限与 QQ/B站产品 Agent 的运行时权限不混用。
3. **爆炸半径**：运行进程改动数 0，运行时分值 0；影响面是后续开发者和 Agent 的选工具、找文档行为。不改用户配置、模型路由、凭据、QQ/B站外发或费用策略。
4. **取舍**：路线 A 把全部工具与机器清单写入 AGENTS，查阅直接但常驻上下文大、易过时、容易误用；路线 B 只放入口，详细路由与本地证据分层，维护成本低、触发明确、可按文件回滚。本次选 B。设计采用原样复制并保留下载原件，比直接移动更容易回退；沿用忽略策略，不强制纳入公开制品。
5. **生效与重启**：后续 Agent 读取更新的规则即生效；无需重启 DSH、桥接、桌宠或浏览器。设计归档不代表已经实施 macOS/ASR 工作包。
6. **验证**：见下节，包括原件一致性、链接、Git 边界与仓库门禁；门禁失败保持可见，不用文档检查替代运行时结果。
7. **回滚与残余**：修改前原件在 `_backups/20261106-tooling-docs/`；先保护回滚时的后续变更，再按明确文件恢复。新增目录可 rename 到该备份目录隔离，下载原件仍在。本地忽略资料不会随 Git 合并、克隆或 Release 搬运，交接需另行复制。

## 改动范围

- 跟踪文件：`AGENTS.md`、`docs/README.md`、`docs/FOLDER_MAP.md`、`docs/HANDOFF.md`、`docs/PITFALLS.md`、`docs/COORDINATION.md`、`docs/cases/README.md`、本 case、`docs/guides/DEVELOPMENT-TOOLS.md`。
- 本地资料：`docs/design/macos/`（8 份原稿与新增首页）、`docs/research/2026-11-06-development-tools.md`（本机核验与历史聚合）。
- 依赖仅为运行现有门禁在隔离工作树执行 `npm ci --ignore-scripts --no-audit --no-fund`；核对并备份 SnowLuma 包后补跑仓库 `npm run postinstall`。该步骤仅修补本工作树 `node_modules` 的 ESM 扩展名，没有改依赖声明或锁文件。

## 验证

- 8/8 份原稿与下载来源逐字节一致，来源文件全部保留。
- 设计目录 53 处相对链接全部有效；连同新增开发指引、case、本地盘点与既有文件新增链接共核对 71 处，断链 0。
- `git diff --check` 无输出、exit 0；`git check-ignore docs/design/macos/README.md docs/research/2026-11-06-development-tools.md` 已列出两条路径，确认本地资料继续被忽略。
- `npm run test:audit`：exit 1，首轮 **136/143**。其中 SnowLuma ESM 用例因首轮跳过安装脚本失败；补跑 `npm run postinstall` 后，仅重跑 `node scripts/test-snowluma-upstream-health.mjs`，**9/9 断言通过，exit 0**。未重跑全套；仍有下表 6 项未解决。
- `npm test --prefix plugins/surfcore`：exit 1，在 `scripts/test-updates.mjs:64` 因 `r.changelog` 为 undefined 中止；同一脚本在原始 `surfcore-mac` 工作区的未修改基线复现（exit 1）。后续串联插件用例未执行。
- 原始输出在 `_backups/20261106-tooling-docs/` 的 `npm-ci.log`、`test-audit.log`、`plugin-tests.log`、`baseline-test-updates.log`、`postinstall.log`、`test-snowluma-upstream-health-after-install.log`；不把它们纳入公开资料。
- 失败路径：文档没有新增运行时 API/错误分支，因此不新增 `code/hint` 测试；工具缺失的替代路线与门禁失败的可行动报告写在开发指南中。

| 未解决的 audit 脚本 | 本轮直接观察 | 后续处理入口 |
| --- | --- | --- |
| `test-audit-bridge.mjs` | 语音路径比较中 `/private/var/` 与 `/var/` 不等 | macOS 路径规范化/测试契约 |
| `test-audit-setup-guards.mjs` | `start.bat` CRLF 断言失败 | Windows 制品换行与检出策略 |
| `test-stickers.mjs` | 直接读取未提供的 `config.json`，ENOENT | 测试隔离/fixture，不复制用户真实配置 |
| `test-voice.mjs` | 合法文件名、无扩展名的语音路径断言失败 | 结合桥接路径失败定位，不先改业务行为 |
| `test-console-encoding.mjs` | macOS 上 `chcp` ENOENT | 平台专用测试的执行边界 |
| `test-update-apply-result.mjs` | macOS 上 `powershell` ENOENT | 更新夹具的跨平台生成方式 |

运行时代码、测试源码和锁文件均未改动。除插件更新器已单独在原工作区复现外，上表只记录本次环境观察，不声称逐项完成根因审查；它们应交给后续明确的适配任务。

## 发布交接块

```text
改了哪些文件：本 case“改动范围”所列 9 个跟踪文档；本地设计/盘点为忽略资料，须另行交接。
测过什么、结果如何：原稿 8/8 字节一致；设计相对链接 53 处有效；Git 差异/忽略检查；完整门禁结果见本 case“验证”。插件更新器基线已有失败，不具备发布绿灯。
建议 patch 还是 minor：纯文档，无需单独发布或 bump；本会话分批本地提交、未推送。
case 文档路径：docs/cases/2026-11-06-development-tools-and-macos-design.md
改动层级：开发指引与文档组织；无运行时实现/API 变更。
完整逻辑与爆炸半径：本 case“完整逻辑”；运行进程改动数 0，开发入口按任务加载。
失败路径：工具缺失时明确替代及证据缺口；门禁失败保留命令与下一步；无新增运行时失败分支。
还有什么没验证：macOS/ASR/B站设计待实现与实机验收；本机工具存在性不代表所有工具已对本项目调用成功。
接收位置：独立工作树 ../surfcore-tooling-docs / docs/tooling-macos；基于 0deb826，本克隆无 dev，不自动合并或发布。
```
