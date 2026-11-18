# 2026-11-19 SurfCore 审核修复（编号 01–12，A–D 四批）

## 现象

2026-11-18–19 的独立审查以 `feat/v1-retirement@b7316ca` 为主审快照、`dev@d46612a` 为集成基线，报告了 6 项高优先级、3 项有明确触发条件、3 项浏览器/已修项。用户可见后果分别是：

1. **任务账本损坏后会被覆盖**：隔离复现中，读到截断/结构错误的 `tasks.json` 后创建一个任务，原文件被只剩新任务的文件覆盖。
2. **B 站同一会话漏私信**：第一条确认后，同秒、不同平台编号的第二条进入调度队列 0 次；两轮轮询之间的中间消息没有补拉路径。
3. **QQ 研究任务在没有研究结论时显示完成**：唯一来源返回 HTTP 503 后仍交付占位报告，并记 `completed`。
4. **QQ 研究抓取绕过既有网络限制**：生产装配用原生 `fetch`，`safe-fetch` 的目标地址检查、逐跳重定向复核和正文上限没有进入调用链。
5. **归档字节与清单不一致**：同一提交按 Git 对象校验 1096/1096，本地 `git archive` 解开后 1091/1096，5 个 Windows 启停脚本被 LF 转 CRLF。
6. **缺包内清单仍能通过校验**：把 `release/install-manifest.json` 整个删掉，目录校验仍能 1096/1096 退出 0。
7. **离线时已有 pending 不重放**：远端采集失败时 CLI 重放 0 条，磁盘上明明还有 1 条。
8. **记忆库权限过宽**：V2 控制库/角色库 `0644`，直接父目录 `0755`。
9. **macOS 中文路径识别失败**：`LC_ALL=C` 下 `ps` 把中文路径转义，桥接会拒绝接管自己的进程。
10. **控制台测试 17/21**：四项失败（Windows 专属 `icacls` 断言、已退役 `closed-agent` 基线、7 天桶宽竞态、`/api/voice/packs` 夹具 404）。
11. **无持久接管回执仍可 ACK**：主审快照的 B 站 CLI 可绕过回执推进游标（dev 已有 `ef30eb5`）。
12. **QQ 模式离线保存误报 409**：dev 已有 `74390e3`，需核对回归。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / Node | macOS（Darwin 25.6.0）/ Node 24 |
| 审查主快照 | `feat/v1-retirement@b7316ca` |
| 修复基线 | `dev@d46612a`（集成工作树 `../surfcore-review-fix`，分支 `fix/review-2026-11-19`） |
| SurfCore 版本 | `0.9.0-dev.2`（本批不 bump） |
| 验证方式 | 隔离夹具 / 临时目录 / 模拟平台回执；未使用真实 QQ、B站账号与真实网络 |

## 根因

- **01 账本**（`src/task-ledger.js:31`）：`loadRaw()` 用 `catch { return { tasks: [] } }` 把所有读取错误（截断 JSON、结构错误、EACCES）都解释成“空账本”，下一次 `saveAtomic` 就把空底座写回。
- **02/07 B 站**（`plugins/surfcore/tools/commands/dm-await.mjs`）：会话列表只提供 `last_msg`，旧实现把它当唯一新消息；`seen` 以时间戳推进。同秒第二条被覆盖；两轮之间消息没有历史补拉；会话列表失败时直接返回，不读本地 pending。
- **03/04 QQ 研究**（`src/task-harness.js:46`、`:202`，`src/bridge.js:1908`）：`safeFetchImpl = fetch`，抓取失败只把错误写进 `snippet`，合成步骤仍生成占位句并投递，任务记 `completed`。
- **05 归档行尾**（`.gitattributes`）：`*.bat text eol=crlf` 让 Git 把 blob 归一化为 LF，`git archive` 再转 CRLF；清单按 blob 字节算，用户拿到归档字节，两边必然不同。
- **06 清单校验**（`scripts/release-manifest.mjs:89`）：`--verify <dir>` 读的是**工作区**的清单，不是解压目录里的清单；备用远端脚本同样依赖工作区清单。
- **08 权限**（`src/core/memory-v2-store.js:20`）：建库只有 `mkdir`/`DatabaseSync`，权限继承 umask。
- **09 桥接识别**（`plugins/surfcore/lib/bridge-process.js:17`）：`ps -o args=` 的输出受继承 locale 影响。
- **10 控制台**：断言写死 Windows 命令；基线快照记录的是退役前契约；图表等待条件过宽导致竞态；离线夹具缺 `/api/voice/packs`。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - QQ 输入 → `src/bridge.js` 的 `handleIncoming` → `src/task-harness.js` 流水线（准入 → 抓取 → 合成 → 投递）→ `src/task-ledger.js` 落盘。
  - B 站：scheduler → `dm-await --once --json`（会话列表 + 会话历史）→ pending 状态文件 → Host 接管回执 → `--ack` 推进游标。
  - 发布：`release-manifest.mjs`（生成/校验，字节来自 Git blob）→ `git archive`/下载包 → 客户端 `plugins/surfcore/lib/updates.js` 校验。
  - 记忆：Memory V2 worker → `memory-v2-store.js` / `memory-v2-lifecycle.js` 建库。
  - 桥接进程识别：插件 `bridge-process.js` → `/bin/ps` / `lsof` → 决定是否接管/结束进程。
- **机制**：四类契约错误——(a) 读失败被当成“没有数据”；(b) 用时间戳代替平台消息身份；(c) “抓取失败”没有资格阻止“生成报告”；(d) 校验器与被校验物不同源（工作区 vs 归档、blob vs 归档、umask 继承）。
- **爆炸半径**：
  - 01/03/04：1 个桥接进程 × 所有 QQ 任务读者；会静默覆盖用户任务记录、静默产出假报告，按静默=3 计，且直接碰用户数据。
  - 02/07：1 个调度器 × B 站 owner/all 两个作用域；漏消息+离线不重放，静默=3。
  - 05/06：发布链路 × 全部 zip/dev 用户；会让更新校验不可靠，静默=3。
  - 08/09：本机权限与进程接管；08 在宽松祖先目录下才会暴露隐私，09 只在非 UTF-8 locale 触发。
- **取舍**：
  - 01：只移植 `7c0a67d` 的读取分类，不带该提交的目录功能；不自动重建损坏账本（重建要猜记录，且会覆盖恢复证据）。
  - 02：历史分页 + 不透明 `msg_key` 身份 + 独立采集边界，比“只扩大时间窗口”多改状态结构，但能真正消除同秒/跨页漏信；旧状态保留时间边界并做有界回读。
  - 03/04：接 `safe-fetch` + 来源摘录，比“继续用原生 fetch 但补超时”能真正继承 SSRF/重定向保护；代价是报告格式与来源数量绑定。
  - 05：局部关闭文本转换并让仓库直存 CRLF，比“发布自生成 ZIP”改动小、分发链不变；代价是 7 个路径需要显式规则。
  - 06：先证明包内清单再证明文件，避免自引用哈希；备用路径证明远端 Git 对象，但无法证明归档分发阶段的转换（保留为残余）。
- **生效与重启**：`src/*` 改动需重启 QQ 桥接；插件 `dm-await`/scheduler 由下次 tick 读到；`bridge-process.js` 由插件热载/重连生效；发布脚本即时生效；客户端校验逻辑随下次安装/更新生效。

## 修法

- **A（01）**：`loadRaw()` 仅 `ENOENT` 返回空账本；其余抛 `TASK_LEDGER_UNAVAILABLE`（`code/error/hint/cause`）。`bridge.js` 的创建/查询/取消与发送链全部纳入异常处理，失败走不读账本的 `management` 回执；`task-harness` 在创建失败与流水线中途失效时结构化返回，不执行、不投递。
- **A（03/04）**：默认 `safeFetchImpl = safeFetch`，生产装配显式注入；适配 `{url,statusCode,body,truncated}` 并兼容旧替身 `{text()}`；非 2xx/空正文/异常记失败来源；无可用正文抛 `RESEARCH_NO_SOURCES`；每条结论附“来源摘录”；仅关键词返回 `RESEARCH_URLS_REQUIRED`；成功回执分列成功/失败来源。
- **B（02/07/11）**：会话列表只用于发现变化；`fetch_session_msgs` 按 `size/end_seqno/has_more` 分页，`msg_key` 作不透明身份、`msg_seqno` 排序；采集边界只在页完整读到时前移；未补齐记 `historyIncomplete`；会话列表失败时 `replayOnly()` 仍输出本地 pending 并暴露 `collect.ok=false`；`recomputeAckThrough()` 只沿连续已 ACK 前缀推进；`--scope owner|all` 隔离两个作用域；调度器暴露 `dmCollectFailure`。
- **C（05/06）**：`.gitattributes` 对 7 个 Windows 脚本加 `-text eol=crlf`，仓库直存 CRLF；`--verify <dir> [--ref]` 先校验包内清单字节与固定 ref 的 blob 一致，再校验结构、文件集与逐文件哈希；`verify-remote-manifest` 同样先核对远端清单；缺/坏/删条目/单文件错误均非零退出并给路径。
- **D（08/09/10/12）**：Memory V2 建库走 `secureFile/secureDirectory`（文件 0600、专属目录 0700、伴生文件一并收紧，共享父目录不动），失败抛 `MEMORY_PERMISSIONS_UNSAFE`；macOS 只对 `ps` 查询注入已校验的 UTF-8 locale；控制台测试按平台断言权限命令、只改写两条退役基线并补已知新字段、等待具体桶宽、离线兑现 `/api/voice/packs`；12 核对 `74390e3` 后契约，离线有既有测试、在线用隔离模拟补证。
- **回滚**：`git revert` 本批提交即可恢复程序行为；不自动回滚账本/数据库/DM 状态文件。B 站状态新增字段对旧读者是新增键，旧程序会按其 schema 校验拒绝读取（因此回退前应先停消费者并保留状态文件）。

## 验证

- `npm run test:audit`：**208/208**。
- `npm run test:regressions`：**17/17**。
- `npm --prefix plugins/surfcore test`：**37 ordinary scripts，exit 0**。
- `npm run test:memory-v2`：**51 scripts，exit 0**。
- `npm run test:console-ui`（playwright-core + 系统 Chrome）：**21/21**。
- `npm run lint:failures`：exit 0（`src/task-harness.js 4/5` 为失败可见性覆盖计数，非新增债务）。
- `npm run doc-facts`：exit 0（桥接行数已同步为 18387）。
- `node scripts/release-manifest.mjs --verify-ref HEAD`：清单 1121 / 跟踪 1121 / **问题 0**。
- `git archive HEAD` 解包后 `--verify <dir> --ref HEAD`：**ok 1121 / 不符 0 / 缺失 0 / 问题 0**。
- 专项：
  - `node scripts/test-task-ledger-guard.mjs`：6 组（缺文件、旧账本、截断、结构错误、权限错误、QQ 入口零执行零投递）。
  - `node scripts/test-qq-research-evidence.mjs`：7 组（有证据、唯一来源 503、混合来源、空正文、仅关键词、送达未知、正式入口）。
  - `node plugins/surfcore/scripts/test-bili-dm-r2.mjs`：23/23（同秒 A/B、跨页正/倒序/重叠、离线 pending、连续 ACK、scope 隔离、回执不匹配、旧游标迁移）。
  - `node scripts/test-memory-v2-permissions.mjs`：3 组（宽松 umask 下 0600/0700、重开保留、无关目录不变）。
  - `LC_ALL=C` 与 `LC_ALL=en_US.UTF-8` 下 `test-bridge-process.mjs` 均通过。
  - `node scripts/test-release-manifest-guard.mjs`：40 项（正例、缺清单、坏清单、删条目+删文件、单文件错误、远端两分支、7 脚本工作区=staged=归档且纯 CRLF）。

**没验证到的部分**：

- 真实 B 站账号的历史分页方向/`msg_seqno` 精度/删除消息行为，只用夹具建模。
- 真实 QQ/模型调用、真实网络上的 `safe-fetch` 拦截效果（由 `safe-fetch` 自身用例覆盖）。
- Windows 真机 ACL 与 7 个启停脚本的实际启停效果。
- 网络上已发布 tag 的下载包（本轮未发版；发布后需按 RELEASE §一·五 门禁 3 复核）。

## 遗留 / 后续

- 控制台夹具应在 `scripts/console-ui-fixture.mjs` 正式补 `GET /api/voice/packs` 并重新生成 `console-ui-contracts.json`，而不是长期在测试里兑现。
- 既有 `0644` 角色库只在角色首次打开时收紧；若要求启动即全量扫描，需要新增遍历。
- 仅关键词任务会先收到“已创建工单”再收到“请补充网址”，文案可后续收敛。
- 账号/宿主级验收（真实 DSH、QQ、B站、抖音、Windows）仍按发布流程在对应环境执行。
