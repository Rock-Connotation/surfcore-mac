# 2026-11-12 V1 退役破坏式重构（历史案例 + 收口续篇）

> **2026-11-13 更新：本文 §「现象 / 根因 / 修法 / 验证 / 遗留」是 28dd419–76f666a 的
> 历史快照，保留作决策史料；本批 R01–R10 收口请直接看文末「收口续篇」。**
> 历史段里「未完成」「插件测试未通过」「建议删 routing」等措辞**不再代表当前状态**。

**收口状态（2026-11-13）**：R01–R10 已按用户拍板的破坏式重构完成实现与隔离回归；
真实 `~/.dsh` 的角色包/人格/记忆/控制库/权限/账本全程只读保留（中途两次测试夹具
误写真实目录已恢复并留证，见文末「数据事故与恢复」）。离线门禁、真实链路、合并与
发布状态以最终交付报告为准。

> 依据 2026-11-12 用户拍板：「直接把六项 v1 删掉就可以了。现在是开发中，不需要那么多向后兼容，破坏式重构就可以了」。
> 分支 `feat/v1-retirement`（基线 `5f27111`）；提交 `28dd419` / `5cd3456` / `b26f9fc` / `eba9153`，含后续文档与钉子收口。
> 清单决策史料：[`docs/product/V1-INVENTORY.md`](../product/V1-INVENTORY.md)。

## 现象

- V1-INVENTORY ①②③④⑤⑥ 六项 V1 面与 V2 双轨并存：fresh 环境记忆路由仍缺省 `v1`；QQ 缺省 preset 是 `qq-chat`；控制台有一代仿真页与 `reserved` 模式；B站调度器自建 DSH 会话、自校正权限，与 `bili-v2-*.mjs` 双路径并存。
- 用户可见后果：新装环境落在已废弃的一代记忆后端；模式/预设两套语义互相污染；一代预设目录仍被安装脚本与制品清单生成、校验。
- 影响面：所有渠道的记忆读写、QQ 会话创建、B站自主生活触发链、控制台页面、发布制品清单。**不碰用户数据**。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH 0.2.1-rc.5（本批未启动 DSH，全部离线门禁） |
| SurfCore 版本 | 0.8.8（未 bump，未发布） |
| 安装方式 | git 工作树 `/Users/shizihan/Daily/Github/surfcore-v1-retirement` |
| 其它 | Node v26.5.1；`test-console-ui` 需 Playwright，本机未装，未跑 |

## 根因

- 代码位置：`src/core/memory-v2-routing.js` 的 fresh 缺省；`src/bridge.js` 的 `PRESET_NAMES` / `MODE_INPUT_ALIASES` / `isSocialEnabled` / `/api/social*`；`plugins/surfcore/lib/scheduler.js` 的 `sessionController.prompt` 与权限装配；`plugins/surfcore/lib/index.js` 的 `applySessionPermission` 路由。
- 问题链条：V2 模块逐批落地时保留了 V1 兼容分支与缺省值，缺省值仍是 V1 → 双轨永远不会自然收敛。`audit-bridge-harness` 把路由桩成 `v1` 让老用例通过，掩盖了 fresh 缺省变化对真实 VM 夹具的影响（S1 后 audit 一度 166/195）。
- 为什么之前没发现：memory-v2 专项套件（47 项）只覆盖 V2 模块自身；跨渠道的 VM 夹具与发布清单门禁依赖另一个 ref，未提交时天然不符。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - 记忆：`src/core/memory-v2-routing.js` 被 QQ 桥接（`memory-v2-qq.js`）、B站 Host（`bili-v2-host.mjs`）、抖音陪伴（`douyin-companion-memory.mjs`）、插件 `memory-v2-runtime.mjs` 共读；`src/core/context.js` 是所有渠道的上下文组装点。
  - QQ：`scripts/setup-dsh.mjs` 写 DSH profile 的 preset patch → `src/bridge.js` 建会话选 preset → `public/console.html` / `plugins/surfcore/lib/client.js` 提供模式与设置入口。
  - B站：`plugins/surfcore/lib/index.js` 装配 `startScheduler` → `scheduler.js` 的 tick/监听循环 → `biliV2Agent.enqueue`（V2 Host）→ `bili-v2-agent.mjs` fork `tools/commands/*` worker。
  - 发布：`release/install-manifest.json` 由 `scripts/release-manifest.mjs` 按 HEAD 的 git blob 生成，`scripts/build-plugin-package.mjs` 按 git tree 生成制品，`scripts/test-package-patch-anchor.mjs` 校验制品。
- **机制**：V2 Host 没有自己的定时器，B站 V2 的唤醒/监听入口**只能**由 `scheduler.js` 的 tick 机器驱动；V2 worker 又直接 fork `tools/commands/`。所以「删 B站 V1」≠ 删调度器/工具链：删的是 `sessionController.prompt`、`applySessionPermission`、workspace/preset 装配这些**一代会话层**，触发机器与共享工具库必须留。同理 `src/memory-card.js` 保留：评测测试 import `addMemoryRecord/createEmptyCard/recallFullMemory`，`src/bili-api.js` 保留：`fetchVideoInfo` 被 B站 V2 使用。
- **爆炸半径**：桥接进程 × 控制台/插件设置/发布脚本等读者 ≈ 3（静默错误计入 3）；不碰密钥、不花钱（未调模型/未启动 DSH）、不删 `~/.dsh` 任何文件。最大风险是「发布清单与 HEAD 不同源」——已用 `--verify-ref HEAD` 钉住。
- **取舍**：
  - A（采用）：按用户拍板破坏式重构，缺省直接切 V2、fail-closed 拒绝 v1、删 preset 目录与 reserved 枚举，测试钉子按 V2 语义改写。收益：双轨消失；成本：改 69 个文件 / 一次性重写约 30 个测试钉子；风险：旧 `state/mode.json` 值 `reserved` 会被拒（有 hint）；回滚：`git revert` + 恢复 preset 目录（数据在 `~/.dsh` 未动）。
  - B（未采用）：清单建议的 D1→D2→D3 分批 + 观察期 + 兼容迁移。收益是平滑，但用户明确说开发中不需要向后兼容，且要维护两套缺省更久。
  - C（未采用）：连 `tools/commands` / `automation.js` / `src/memory-card.js` 一起删。会砸掉 V2 worker、只读 UI 快照和评测测试，收益为负。
- **生效与重启**：`src/bridge.js` 改动要重启 QQ 桥接进程；`plugins/surfcore/*` 改动要重载 DSH 插件/重启 DSH；`dsh/agent-presets/*` patch 要重启 DSH 才装配；`state/mode.json` 与 `memory-v2/routing.json` 是用户数据，本批不动，按下方「回滚与残余」手工处理。`release/install-manifest.json` 已按新 HEAD 重生成，发布会话直接使用。

## 修法

- ① S1（`28dd419`）：路由缺省 `{backend:'v2',source:'fresh-default'}`，descriptor 只认 v2，读/发布 v1 → `MEMORY_BACKEND_RETIRED`（带 `code`/`hint`）；删 `legacy-registry` / `migration-plan` 与两个测试；`context.js` 删 V1 记忆卡分支、life/purpose 注入、`memoryBackend` 参数；`douyin/scheduler/bridge` 消费方按 v2-only 收紧。
- ② S2（`5cd3456`）：`PRESET_NAMES` → `QQ_CHAT_PRESET='qq-chat-v2'`；`git rm dsh/agent-presets/qq-chat/` 与 `qq-chat.patch.yml`；模式枚举删 `reserved`；`role-card.js`/`preset-prompt.js`/`persona-layers.js` 固定 V2；控制台删一代按钮/选项/页面；插件设置窗口删「一代仿真（reserved）」组；`/api/social*` 四个路由与 5 秒社交心跳删除。
- ③ S3（`b26f9fc`）：`scheduler.js` 1389→822 行，唤醒改走 `biliV2Agent.enqueue`，记忆路由非 v2 直接 `throw`（fail-closed）；`lib/index.js` 移除断裂 import，权限修复接口改结构化拒绝 `BILI_V1_SESSION_PERMISSION_RETIRED`；删 V1 workspace/preset 参数与 `qq-chat.patch.yml` 的 bundle 声明。
- ④ S4（`b26f9fc`）：新增 `scripts/test-v2-context-fixture.mjs`，把旧「账本→卡→上下文」用例的文本包成合法 Host 准备包（测新契约，不在生产复活旧读取路径）；VM 夹具路由桩保持旧基线仅供夹具，真实 V2 语义由 `test-memory-v2-qq-integration.mjs` 覆盖；preset/模式/角色提示词/工作区/前缀/时间窗/沉默逛等钉子全部按 v2-only 改写；删 `scripts/test-scheduler-permission.mjs`。
- ⑤ 清单（`eba9153`）：按新 HEAD 重生成 `release/install-manifest.json`（1092→1084 文件）。
- 回滚方式：`git revert <四个提交>`（逆序），preset 目录从 git 恢复；`~/.dsh` 未动，无需恢复数据。

## 验证

- 自动化：`npm run test:audit` **194/194 通过**（基线 5f27111 为 194/195，唯一失败是清单 ref 差异）；`npm run lint:failures` 退出 0，存量债务 **661 ≤ 基线 669**；`npm run test:regressions` **全部通过**；`npm run test:memory-v2` **47/47**；`cd plugins/surfcore && npm test` 未通过：`test-douyin-companion.mjs` 报 `job did not finish`；`npm run doc-facts` 退出 0；`node scripts/release-manifest.mjs --verify-ref HEAD` → 「问题 0 个」。
- 失败路径（用户看到什么 / 下一步 / 断言）：
  - 旧 `state/mode.json` 写 `reserved`：`refreshMode` fail-closed，日志提示「请改为 simulation（即二代 reserved2）」；`plugins/surfcore/lib/index.js` 的 `/mode` 直接回 `400 RETIRED_MODE_REJECTED` 带 `hint`。`scripts/test-issue-regressions.mjs` 钉住老值不再被采纳。
  - 旧 `memory-v2/routing.json` 指向 v1：`MEMORY_BACKEND_RETIRED`，`hint` = 「备份后删除 routing.json，重启宿主按 V2 重新初始化」；`scripts/test-memory-v2-routing.mjs` 断言 `code` 与 `hint` 非空。
  - 旧 UI 点「修复会话权限」：回 `ok:false` + `BILI_V1_SESSION_PERMISSION_RETIRED` + `hint`（不再静默 404）。
  - B站记忆路由非 v2 / V2 Host 拒绝本轮：`scheduler.js` 抛 `BILI_V2_ROUTING_UNAVAILABLE` / `BILI_V2_JOB_FAILED`，`onMemoryBlocked` 上报到记忆页，不自动重试、不回落旧会话。
- 手工/集成验证：未启动真实 DSH / QQ 桥接 / B站。`test-console-ui` 用系统 Chrome 实跑（`PLAYWRIGHT_MODULE` 指向 npx 缓存、`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向 `/Applications/Google Chrome.app`）：17/21 通过，4 个 FAIL（提权命令文案、payload 契约、趋势图桶宽、404）与基线 `5f27111` 用同一 Chrome 跑出的 19/23 **完全相同**，属环境/基线漂移，非本批引入；本批新增的 9 页面导航、mode/preset 契约、191 legacy IDs 断言均通过。真机回归留给发布前独立验收。
- 没验证到的部分：真实 DSH 装配 `qq-chat-v2` patch、真实 QQ 入站→V2 回复、B站 V2 Host 真机 enqueue、旧 `~/.dsh` 里含 `reserved` / `v1` 路由文件的迁移演练。

## 遗留 / 后续

- 需要补的测试：真机安装后跑 `probe:tools` / QQ 回复闭环 / B站唤醒闭环；`test-console-ui` 在装了 Playwright 的机器上补跑。
- 需要改的文档：产品文档四份与两个 README 已同步（见本批）；`docs/guides/*` 中提及一代的历史案例按「历史记录」保留，不删。
- **已知残留（如实登记，别当成已删）**：
  1. `src/bridge.js` 的一代社交状态机函数与 `social` 容器仍在：会话退役/重置路径借它清内存态；但 `reserved` 不可达、`isSocialEnabled()` 恒 false、心跳不启动、`/api/social*` 已删，属惰性死代码。彻底删除需重写约 600 行且与 V2 清理逻辑交错，收益不佳，留待独立重构批次。
  2. QQ 出站 `auditAndSend()`（V1 路径）与 `sendMessagesV2()` 仍双路径并存，本批未整体重写出站链（清单 ⑥）。
  3. Memory V2 管理/面板 UI（`memory-v2-management.mjs` / `memory-v2-panel.mjs` / `qq-access-panel.mjs`）仍接受 `backend: 'v1'` 夹具值并有旧版文案；核心路由已 V2-only，这些只是展示层夹具。
  4. `plugins/surfcore/lib/companion-sharing.mjs` / `douyin-companion-memory.mjs` 等仍有 `['v1','v2']` 兼容判定与 `backend:'v1'` 字面量（测试夹具与防守式校验），生产路由已不会给出 v1。
- **用户数据迁移提示**：`~/.dsh` 里角色包人格卡、V1 记忆卡与全量卡 JSONL、`state/mode.json`、B站账本**原地保留**；旧 `mode.json` 值 `reserved` 需手工改为 `simulation`；旧 `memory-v2/routing.json` 指向 v1 时，在有授权的会话里备份后删除该文件并重启宿主按 V2 重新初始化。

## 发布交接块（可直接复制给发布会话）

```text
【合并请求】
分支：feat/v1-retirement（覆盖 28dd419 / 5cd3456 / b26f9fc / eba9153 及后续文档与钉子收口）
范围：V1 退役破坏式重构（不留向后兼容）——记忆后端 V2-only、QQ 一代 preset/reserved/人格过滤层删除、B站 V1 会话/权限层删除、控制台与设置窗口一代入口删除、发布清单按 HEAD 重生成
改到的文件：src/bridge.js、src/core/*、src/role-card.js、src/preset-prompt.js、src/persona-layers.js、public/console.html、plugins/surfcore/{lib,package.json,qq-mode,scripts}、scripts/*（含新增 test-v2-context-fixture.mjs）、docs/product/*、README.md、docs/cases/2026-11-12-v1-retirement.md、release/install-manifest.json
删除：dsh/agent-presets/qq-chat/、plugins/surfcore/presets/qq-chat.patch.yml、src/core/memory-v2-legacy-registry.js、memory-v2-migration-plan.js、scripts/test-memory-v2-legacy-registry.mjs、test-memory-v2-migration-plan.mjs、scripts/test-scheduler-permission.mjs
测试：test:audit 194/194；lint:failures 退出 0（债务 661 ≤ 669）；test:regressions 全通过；test:memory-v2 47/47；plugins/surfcore npm test 未通过，待修复；doc-facts 退出 0；release-manifest --verify-ref HEAD 问题 0 个
改动层级：实现层 + 接口层（接口不向后兼容）：删除 /api/social* 四路由、/mode 不再接受 reserved、/bili/session-permission 回结构化拒绝、preset 只装 qq-chat-v2
失败路径：旧 mode.json=reserved 有 hint 改 simulation；旧 routing.json=v1 回 MEMORY_BACKEND_RETIRED 带 hint；B站路由非 v2 抛 code/hint 不回落
风险/未验证：未启动真实 DSH/QQ/B站；真机装配、入站回复闭环、B站唤醒闭环待验收；test-console-ui 需 Playwright 未跑；旧 ~/.dsh 数据迁移需手工（原地保留，未删）
残留：bridge.js 惰性一代状态机、QQ 出站 auditAndSend 双路径、Memory V2 面板 UI 的 v1 夹具值（详见 case「遗留 / 后续」）
建议版本：minor（破坏式行为变化，用户可见模式/preset/接口变化；版本号由发布会话定）
是否已 rebase/merge 最新 dev：**未合并**——主树 `/Users/shizihan/Daily/Github/surfcore-mac`（dev）仍有非本会话的未跟踪目录 `2026-11-12/`，按 AGENTS §1.9 不碰他人脏工作区；待对应会话收走后由协调/发布会话 `--no-ff` 合并，并从合并后的 HEAD 重新生成 release/install-manifest.json
```

---

## 收口续篇（2026-11-13）：R01–R10 实现、行为回归与数据事故

> 本节是当前规范；上方所有「未完成 / 待补 / 建议删除 routing」等历史措辞均已失效。

### 现象 → 根因 → 影响 → 修法

| 编号 | 现象 | 根因（机制） | 修法 |
| --- | --- | --- | --- |
| R01 | 新安装授权成功却 `MEMORY_SHADOW_DISABLED` | `validate()` 把历史影子开关当 V2 业务准入门禁；`shadowEnabled=0` 是 fresh 默认 | `src/core/memory-v2-store.js` 移除 `requireShadow` 门禁；列保留不删不重置。管理/面板/Host 状态分离 `backend` 与 `readiness` |
| R02 | 旧记忆卡在启动 8s 后仍被摄取/衰减/清空 prompt | `startMemoryCardTimer`、角色切换/回档/设置保存/感知投影、旧变更 API 全在生产链上 | `plugins/surfcore/lib/index.js` 移除全部生产维护装配与旧 API 实现，写动作统一 `410 MEMORY_CARD_WRITE_RETIRED`；旧档案只读保留。参考算法/只读查看保留 |
| R03 | `closed-agent` UI 可选但 V2 必拒 `MEMORY_PRESET_UNSAFE` | 完整本地工具会话与受限 NativeOwner 语义冲突 | 明确「本版本不可用」：`UNAVAILABLE_MODES` + `/api/mode` 409 + 控制台按钮禁用 + 插件设置去掉选项；owner 远程任务能力由独立 Task Harness 承接（owner 准入/群聊拒绝/危险拦截/审批/取消/回执） |
| R04 | owner DM 丢 `msgKey`、失败前游标已推进 | scheduler 重建对象漏字段；`dm-await` 命中即写 `lastSeen/seen` | scheduler 保留官方精确坐标；`dm-await` 命中只写 `pending`（稳定 requestId），`--ack` 才推进游标；「观察 / Host 持久接收 / 平台 ACK」三态分离 |
| R05 | `retire()` 返回后旧 tick 仍 enqueue 并写账本 | `stop()` 只清定时器，无实例准入/取消/在途跟踪 | scheduler 增加 `generation + AbortController + inflight`；每个 await 后、enqueue 前、写账本前复核；retire 禁入→取消→限时等待→Host ACK；失败/超时返回结构化 blocked。`stopSchedulerNow` 检查 `ok:false` |
| R06 | 抖音测试卡在 `job did not finish` | 夹具合法 receipt/refs 不全、未隔离 DSH_HOME/当前角色、`verifyPrepared` 异步、缺 `getModelRequest`、旧 `recordMemory` 断言 | `test-douyin-companion.mjs` 与 host/recall/sharing 系列迁到真实 MemoryService/Host 工厂；合法回执、同步验签、正式请求元数据、V2 reflection/持久回执断言；保留预算/取消/重启/隐私语义 |
| R07 | 旧 `reserved` 被静默忽略并沿用上次模式；v1 routing hint 建议删文件/库 | `refreshMode` 把「退役值」当「读取失败」处理；routing hint 用「制造 fresh」掩盖控制库存在 | 模式来源区分 absent/valid/retired/invalid/unreadable/unavailable，权威退役/非法/读取失败进入可见 blocked；新增 `src/core/memory-v2-preflight.js` 只读预检 + 计划，明确不删 routing/SQLite/原数据 |
| R08 | 前置失败作业在 status 消失（`recentJobs:[]`、`lastError:null`） | `safeJob` 要求完整来源证明；无证明就整体返回 null | 分离控制元数据与受限内容：终态作业投影 `jobId/state/phase/固定码/清洗 hint/时间`，正文/视频标识/摘要/refs 仍要求 proof；`daily.lastError` 回退到终态作业 |
| R09 | QQ/B站 真实 Native 人格绕过一代过滤 | 两个 Host 各自 `fs.readFileSync(persona.md)` | 新增 `src/core/persona-v2-compile.js`：共享 `selectRoleText` + `GEN1_ROLE_LINE_RE`，内存编译、按场景/预算组合、同字符串同摘要给 Source/Owner，原文件不改 |
| R10 | 分享缺 `memoryV2` 默认 v1 并保留旧 perform | 兼容分支仍在 | `companion-sharing.mjs` 删 v1 默认/perform，缺适配器/显式 v1/异步路由/接口不全一律结构化拒绝且零模型调用；sharing/race/platform/UI 业务测试迁到 V2 工厂 |

### 完整逻辑（七步）

1. **链路**：`memory-v2-store/service/host` → `memory-v2-runtime` → QQ `memory-v2-qq.js` / B站 `bili-v2-host` / 抖音 `douyin-companion-memory` / 分享 `companion-sharing`；`scheduler.js` 只保留 V2 触发机器，`tools/commands` 仍由 V2 worker 直接 fork，`src/memory-card.js` 仅保留参考算法与只读查看。
2. **机制**：所有业务准入以「角色 epoch + 具体 audience/provider policy + 控制修订 + 来源证明 + 生命周期/删除屏障」为准；影子开关退出历史。停止/角色切换以「实例 generation + 取消 + 在途等待 + Host ACK」为屏障。平台通知以「pending → 持久接收 ACK → 游标」为状态机。
3. **爆炸半径**：桥接进程 × DSH 插件宿主 × B站调度器 × 抖音/分享；失败均为显式 `code/error/hint`。不碰密钥、不花钱（隔离假模型）、不删用户数据。
4. **取舍**：A（采用）沿现有 V2 收口、删旧生产路径，成本可控、回归可钉；B（未采用）重写 1.8 万行 bridge/scheduler/记忆层，风险与回滚成本过高。R05 跨链路 audit 未整体重写：VM 夹具继续测旧用例自身行为，另建 `scripts/test-v2-real-integration.mjs` 用真实 Host 覆盖 R01–R10，恒真准备包已显式标注「仅纯函数夹具」。
5. **生效与重启**：`src/bridge.js` 改动重启 QQ 桥接；`plugins/surfcore/*` 改动重载 DSH 插件/重启 DSH；`dsh/agent-presets/qq-chat-v2` patch 重启 DSH 才装配。`state/mode.json`、`memory-v2/routing.json`、控制库是用户数据，本批不动。
6. **验证**：`test:audit`、`test:regressions`、完整 `plugins/surfcore test`、`test:memory-v2`、`lint:failures`、`doc-facts`、`build-agent-preset-patches --check`；新增 `scripts/test-v2-real-integration.mjs`（12 项真实 V2 门禁）、`test-memory-v2-bili-scheduler-retire.mjs`（4 项）、DM pending/ack 3 项、R01 fresh 授权、R02 旧档案哈希、R07 预检、R08 失败可见、R09 人格编译、R10 缺装配零调用。Memory 评测 runner 显式编排 baseline→kernel，不再依赖未跟踪 `_backups` 报告。
7. **回滚与残余**：程序回滚 = `git revert` 本批提交；**不**恢复旧数据库/额度账本/`~/.dsh` 角色资料。真实 DSH 实装、QQ 入站→回复 ACK、B站真机 enqueue/停止、旧配置副本处理仍列为未验（见最终交付）。`auditAndSend` 旧链与一代社交状态机在 V2 主路径后不可达，仍作为惰性残留登记，不误删共享传输/`isDirectAddress`/V2 工具。

### 数据事故与恢复（如实登记）

2026-11-12 两次测试夹具事故：`test-companion-sharing*.mjs` / `test-douyin-companion*.mjs` 的 ESM 静态 import 在 `process.env.DSH_HOME` 赋值前求值，把 `CHARACTERS_DIR` 绑到真实 `~/.dsh`，写入 `characters/current.json`（`alpha/epoch1`）、`alpha/persona.md`、新建 `alpha/persona.scenes/local.md` 与 `role-a/`、`role-b/` 目录。

- 处置：现场复制到 `~/.dsh/_quarantine/incident-2026-11-12-test-wrote-real-dsh/`；按 `index.json` 权威值恢复 `current.json` = `app`/红豆/epoch 8；`alpha/persona.md` 从 `snapshots/before-switch/persona.md` 恢复为 `Alpha persona\n`；新建目录 rename 到隔离区。
- 根治：新增 `plugins/surfcore/scripts/isolate-test-home.mjs`，所有会触碰 `character-persona.js` 的测试**第一条 import** 引入；`sharing-v2-fixture.mjs` 自检拒绝真实 home；所有门禁用隔离副本与显式 `DSH_HOME`。
- 未受影响：`app` 角色全部数据、`memory-control.sqlite`、权限、删除屏障、预算与账本（mtime 未变）。

### 发布交接块（当前批次）

```text
【合并请求】分支 feat/v1-retirement（R01–R10 收口，基线 76f666a）
范围：V2-only 生产准入、旧卡写者退役、QQ 模式/预检/Task Harness 能力差异、
B站 DM pending/ack 与调度退役屏障、抖音/分享真实 V2 工厂与失败可见、
真实 V2 跨链路门禁、当前 README/RULES/DSH_SETUP/UI 文案、case/HANDOFF。
数据：真实 ~/.dsh 只读保留；误写已恢复并留证。
未验：真实 DSH 实装、QQ 入站→ACK、B站真机唤醒/停止、旧配置副本演练。
发布：未获单独确认，不 bump/tag/Release/Pre-release。
合并后：从新 HEAD 的 git 对象重生成 install-manifest 并提交，
再跑 release-manifest --verify-ref HEAD 要求 0 问题。
```

### 真实验收计划（离线工作完成后；已验 / 未验分开）

| 项目 | 目标隔离 profile / 对象 | 前置授权 | 已验 | 未验步骤 |
| --- | --- | --- | --- | --- |
| DSH 实装同源 | 独立 profile，不从常用 `web` 复制数据 | 安装/重启授权 | ❌ | 从最终提交构建 → 只装 `qq-chat-v2` patch + 3 个 MCP + surfcore bundle → 源/制品/实装文件逐 SHA 比对 → 重启后探针确认 preset 清单与工具面 |
| QQ 入站→回复 ACK | 指定测试 QQ 对象、精确模型、单条消息数量 | 真实发送与模型预算单独确认 | ❌ | 入站身份 → 具体 policy → 来源 capture → prepare → Native 模型输入 → 发送租约 → 平台 ACK → 记忆写回 → 重复事件/重启恢复；不发群、不扩授权 |
| B站 唤醒与停止 | 隔离 B站账号/对象、关闭真实互动 | 真机唤醒与外发单独确认 | ❌ | owner DM 精确坐标 → pending → Host 持久接收 → 游标推进；评论/夜间唤醒 → V2 Host enqueue；停止/角色切换时在每个 await 边界验证 0 新任务/0 写入；失败/超时保持 blocked |
| 旧配置副本处理 | 脱敏副本：`mode.json` / `memory-v2/routing.json` / 控制库 / 旧角色档案 | 数据转换单独授权 | ❌ | 只读预检区分 fresh/ready/retired-v1/control-only/route-only/corrupt/reader-too-new/unreadable → 确认无自动改写、无删除 DB 建议 → 只读哈希清单 → 需要转换时另开授权批次 |

**离线已验**（本批）：真实 MemoryService/Host 的正式授权→capture/prepare（R01）、撤销/换角色拒绝、旧档案哈希保留（R02）、模式与预检（R03/R07）、DM 精确坐标与 pending/ack（R04）、scheduler 退役屏障（R05）、抖音/分享全套 V2 工厂与失败可见（R06/R08/R10）、人格编译（R09）、真实 V2 跨链路 12 项门禁。

**合并状态**：未合并。主树 `/Users/shizihan/Daily/Github/surfcore-mac` 有他人未跟踪 `2026-11-12/`；本地 `dev`=`5f27111`（退役前基线），功能分支 `feat/v1-retirement` HEAD=`b38523d`。按 AGENTS §1.9 不清理、不 stash、不在此会话合并。合并方案（待协调会话）：确认主树未跟踪目录归属与 `dev` 无他人写入 → `git checkout dev` → `git merge --no-ff feat/v1-retirement` → 从合并后 HEAD 重生成 `release/install-manifest.json` 并单独提交 → `node scripts/release-manifest.mjs --verify-ref HEAD` 要求 0 问题。发布另行确认。
