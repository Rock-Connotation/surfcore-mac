# 2026-11-19 SurfCore 审核返工 R2（01–12）案例记录

> 基线：`dev` @ `4069552`；候选分支：`fix/review-2026-11-19-r2`（独立工作树 `surfcore-review-r2`）。
> 候选提交：`c4722c6` → `8c60dcf` → `d555674` → `52863d6` → `fae7ac6`；清单重生成提交见分支末端。
> 权威设计：`/Users/shizihan/.codex/visualizations/2026/11/19/01a1f2ac-cde4-78f0-9f8b-ec167235fb75/SurfCore-返工技术设计-4069552.md`。
> 本批只交付本地候选，**未发布、未推送、未操作真实账号或真实用户数据**。

## 1. 链路与机制（七步中的 1–3）

- **01 任务账本**：`src/task-ledger.js` 是 QQ 桥接投递/研究的唯一任务状态文件，`src/bridge.js` 与 `src/task-harness.js` 读写它。旧实现把任何读失败都当空账本重写，损坏文件被静默覆盖。现在仅 `ENOENT` 初始化；`version`/`tasks`/单条记录结构先严格校验，截断、未知版本、坏记录、`EACCES` 都在写入前抛 `TASK_LEDGER_UNAVAILABLE`，磁盘字节不变。爆炸半径：桥接单进程 × 3 个读入口，静默=数据丢失。
- **02/07/11 B站私信采集与回执**：`plugins/surfcore/tools/commands/dm-await.mjs` 采集 → `plugins/surfcore/lib/scheduler.js` 消费 pending → `plugins/surfcore/lib/bili-v2-agent.mjs`/`bili-v2-host.mjs` 提供终态回执。根因是分页失败时把「已完整边界」推进到失败页的 `nextBoundary`，恢复停在缺口之后；现在完整边界与续拉位置分离，页数据连同 resume 位置先持久化，只有整段被证实时才前移边界。`has_more=0` 未覆盖区间记 `BILI_DM_HISTORY_RANGE_UNPROVEN`，不再跳过。大队列按 25 条/16 KiB 切分 JSON 行，调度器解析全部行而不是只取最后一行。终态回执由 Agent 持久化注册表在**整组 terminal** 时物化，Host 只把可校验的 durable receipt 交给 CLI，ACK 才推进。爆炸半径：B站插件进程 × 采集/调度/ACK 三读者，静默=永久漏私信。
- **03/04 QQ 研究与投递**：`src/task-harness.js` 通过 `src/safe-fetch.js` 抓取，`src/bridge.js` 投递并记账。研究结论此前能把旧摘录算作本次来源、关键词任务也发「已创建」；投递前二次读账本会把已真正送达的消息改写成 unknown。现在只统计本轮可用来源，全失败零成功报告，仅关键词返回 `RESEARCH_URLS_REQUIRED`；投递以调用方任务快照为准，真实发送后记账失败仍报告送达或 `送达待核对 + task id`，`delivering`/`delivery_unknown` 不自动重发。三种 body 形态（受控对象/旧 `text()`/标准 `Response`）都取到真实正文，空正文 + Login 标题不得完成。
- **05/06 发布制品**：`scripts/release-manifest.mjs` 从 git 对象生成清单，`scripts/verify-remote-manifest.mjs`/`plugins/surfcore/lib/updates.js` 校验，`scripts/apply-update.mjs` 落盘。旧校验只查「清单里的文件存在」，增加程序文件不报、包内清单缺失也能过。现在先逐字节校验包内清单与固定 ref，再双向比对受管文件集合与内容；客户端 staging 在备份前双向检查缺失/坏/未验证文件，`verify.staging-mismatch` 带路径。7 个 Windows 脚本保持 CRLF。
- **08/09/10/12 运行时**：`src/state-acl.mjs` 收紧 Windows ACL 后回读，显式 SID 宽授权、继承 ACE、缺失必要授权都失败；`src/core/memory-v2-lifecycle.js` 对专属目录/文件加 `lstat`、符号链接与 POSIX uid 校验。`plugins/surfcore/lib/bridge-process.js` 实现保留，只在 Darwin 两次 `/bin/ps` 元数据调用注入已验证 UTF-8 locale。控制台夹具真正实现 `GET /api/voice/packs`，删掉浏览器端兜底。QQ 模式保存离线回 `200/applied:false/QQ_MODE_SAVED_PENDING_BRIDGE`，在线回执新增常驻测试。

## 2. 取舍、生效与验证（七步中的 4–7）

- **路线取舍**：① 在调度器补洞 vs 在消费者去重——选前者，避免每轮重复拉同一缺口；② 回执靠内存标志 vs 持久化注册表——选后者，重启后仍能证明终态；③ 客户端只查清单存在 vs 双向集合+字节——选后者，能挡住「多塞文件」和「少装文件」；④ 测试端放过 voice/packs 404 vs 夹具补路由——选后者，不让浏览器兜底掩盖契约缺口。每条都优先改既有状态所有者/校验器/夹具，不引入新框架、不放宽断言、不延长超时。
- **生效/重启**：`src/*` 改动需重启 QQ 桥接；插件与 B站状态键随下次 tick/CLI 读取生效；发布脚本与文档即时生效；本次无版本 bump、无 tag、无 Release。
- **验证**：见下文「逐项验收」和「组合门禁」。所有退出码来自本机候选工作树，真实平台/线上包只在「待环境验收」列出。
- **回滚**：候选未合并、未发布，整批回滚只需放弃分支/工作树；若已并入 `dev`，按逻辑单元 revert，B站回滚前先停进程并保留状态文件与回执，避免 pending 被旧版丢弃。

## 3. 逐项验收

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 01 任务账本保护 | 已修复 | `node scripts/test-task-ledger-guard.mjs` EXIT=0，10 组；`version=999/tasks=[{}]` 不被重写，截断/坏记录/EACCES 写入前失败且字节保留 |
| 02 B站分页恢复与同会话原文 | 已修复 | `node plugins/surfcore/scripts/test-bili-dm-r2.mjs` EXIT=0，27/27；`node plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs` EXIT=0，78 cases；精确 msg_key 翻历史页取原文 |
| 03 QQ 研究结论证据 | 已修复 | `node scripts/test-qq-research-evidence.mjs` EXIT=0，11 组；`node scripts/test-phase-bc-verification.mjs` EXIT=0；仅关键词不建任务、全失败零成功报告 |
| 04 QQ 投递与送达可见 | 已修复 | `node scripts/test-owner-delivery-r3.mjs` EXIT=0；二次写入失败仍显示送达或 `送达待核对+task id`，`delivering` 不重发 |
| 05 发布归档字节一致 | 已修复 | `node scripts/test-release-manifest-guard.mjs` EXIT=0；`node scripts/release-manifest.mjs --verify-ref HEAD` EXIT=0，清单 1122 个/跟踪 1122 个/问题 0 |
| 06 包内清单与客户端 staging | 已修复 | 同上守卫覆盖双向集合+内容；`verify.staging-mismatch` 在备份前失败并带路径；update/apply 测试 EXIT=0 |
| 07 离线大队列与稳定遍历 | 已修复 | `test-bili-dm-r2` 27/27：100 条 pending 分多行 JSON，每行 ≤16 KiB，调度器两轮各交付 100 条；空尾/缺 msg_key 不跳过；19 位序号原样排序；同秒 seen=100 仍入队 |
| 08 记忆库权限 | 已修复 | `node scripts/test-memory-v2-permissions.mjs` EXIT=0，6 checks；`node scripts/test-memory-v2-lifecycle.mjs` EXIT=0，28 checks；POSIX 0600/0700、Windows 宽 SID/继承 ACE 与符号链接均可见失败 |
| 09 macOS 中文路径桥接 | 已修复（既有实现守住） | `LC_ALL=C` 与 `LC_ALL=en_US.UTF-8` 下 `node plugins/surfcore/scripts/test-bridge-process.mjs` 均 EXIT=0；locale 只进 Darwin 两次 `/bin/ps`，路径/argv/端口/锁校验未放宽 |
| 10 控制台 UI 四因 | 已修复 | `npm run test:console-ui` EXIT=0，22/22；`GET /api/voice/packs` 由正式夹具返回 200，浏览器兜底删除；360/1440 分桶断言保留 |
| 11 B站终态回执 ACK | 已修复 | `node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs --ordinary` EXIT=0，53 scenarios；`test-memory-v2-bili-host.mjs`/`test-memory-v2-bili-index.mjs` EXIT=0；仅整组 terminal 物化 durable receipt，接受态无回执 |
| 12 模式保存回执 | 已修复 | `node plugins/surfcore/scripts/test-qq-mode-save-r3.mjs` EXIT=0；离线 `applied:false + QQ_MODE_SAVED_PENDING_BRIDGE`，在线 fake bridge 恰好一次 `POST /api/mode` 且 `applied:true` |

## 4. 组合门禁（候选工作树）

| 门禁 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:audit` | 0 | Audit suite 208/208 |
| `npm run test:regressions` | 0 | 17/17 全部通过 |
| `npm run test:memory-v2` | 0 | 51 ordinary scripts |
| `npm run test:console-ui` | 0 | 22/22，真实 Chrome headless |
| `npm run lint:failures` | 0 | 无新增失败 |
| `npm run doc-facts` | 0 | 文档数字与代码一致（桥接 18375 行） |
| `node scripts/release-manifest.mjs --verify-ref HEAD` | 0 | 最终候选 HEAD 1123/1123，问题 0 |
| 插件全量脚本（125 个） | 复验 0（结果见残余） | 首轮 119/125、复验 120/125；5 个失败在干净 `dev@4069552` 上同错误复现，属基线环境缺口；首轮 `test-bili-dm-r2` 单次 26/27，独立重跑 8/8、复验套件通过，未能复现 |

## 5. 本批回归 / 基线缺口 / 残余风险

- **本批回归（已修）**：`plugins/surfcore/lib/updates.js` 新引入共享清单 helper 后，`plugins/surfcore/scripts/test-persona-api-epoch.mjs` 的离线安装夹具没有 `scripts/`，导致 `ERR_MODULE_NOT_FOUND`。已让夹具复制真实安装也会带的 `scripts/`，测试 EXIT=0。`doc-facts` 因 `src/bridge.js` 从 18387 行变为 18375 行报三处文档口径过时，已同步文档，复验 EXIT=0。
- **未修完整**：B站 `msg_key` 仍按不透明字符串处理，真正的跨会话序号序依赖平台返回的可验证 seq；`__unverifiable` 保留原状，不做猜测排序。
- **基线缺口 / 待环境验收**：插件全量 125 个脚本中 5 个在干净 `dev@4069552` 上以相同错误失败（`test-memory-v2-bili-agent` 需原生 Host fixture、`test-memory-v2-bili-host-native` 需显式隔离环境、三个更新脚本依赖已安装布局 `/Users/shizihan/Daily/scripts/apply-update.mjs`），候选未新增失败。真实 B站账号分页/删除/同秒消息语义、真实 QQ 桥接与 Windows 真机 ACL、线上 tag 归档下载与客户端真实更新、打包宿主内 UI 与 `/bin/ps` 限制，均未在本次本地候选中取得产品级证据。
- **单次未复现抖动**：首轮插件套件里 `test-bili-dm-r2` 曾 26/27，独立连续 8 次与复验套件均 27/27；干净基线独立运行也通过。未定位到本次改动可复现的根因，保留为低概率调度/环境抖动，不在断言或超时上放松。
- **未验证声明**：本次没有真实账号、真实用户数据、真实网络抓取、push、tag、Release 或 dev Pre-release。

## 6. 发布交接块（可直接转发）

```
【发布批次：2026-11-19 · 审核返工 R2（编号 01–12）】
- 目的：把 01–12 从“已实现但证据不足”补成可复验候选：B站分页恢复/原文/终态回执、
  任务账本 fail-closed、QQ 研究证据与投递可见、发布归档双向校验、运行时权限与 UI 契约。
- 改动层级：实现层 + 测试/文档；无对外接口删除。B站状态新增 resume/receipt 键，
  旧程序会按其 schema 拒绝读取；研究报告新增本轮来源状态。
- 验证：test:audit 208/208、regressions 17/17、memory-v2 51、console-ui 22/22、
  lint-failures 0、doc-facts 0、清单 --verify-ref HEAD 1122/0、插件全量见交付报告。
- 未验证：真实 B站/QQ 账号、Windows 真机 ACL、线上归档下载、打包宿主 UI。
- 回滚：候选未发布；若已合入 dev 按逻辑单元 revert，回滚 B站前先停进程并保留状态/回执。
- 生效：src/* 重启 QQ 桥接；插件随 tick/CLI；发布脚本即时生效。
- case：docs/cases/2026-11-19-surfcore-review-r2.md
```