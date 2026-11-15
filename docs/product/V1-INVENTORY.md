# V1 清单盘点（2026-11-12，退役进行中）

> **状态：六项 V1 的退役尚未完成；QQ 出站链及其他残留仍在，插件测试未通过。** 依据 2026-11-12 拍板："直接把六项 v1 删掉就可以了。现在是开发中，不需要那么多向后兼容，破坏式重构就可以了"。
> 删除只动代码/脚本/测试/文档：`~/.dsh` 用户数据（角色包/记忆卡/state/mode.json/账本）**只读不动**，删代码不删数据。操作与残留见 [docs/cases/2026-11-12-v1-retirement.md](../cases/2026-11-12-v1-retirement.md)。
> 配套：[PRD.md](PRD.md) §五 P2-12 · [IMPROVEMENTS.md](IMPROVEMENTS.md) A4

## 0. 判定范围（先划清什么不是"V1 系列"）

以下命中 `v1` 字样的内容是**第三方协议版本号或外部制品版本**，不属于本次拍板的"V1 系列"，**不在删除范围**：

| 命中 | 位置 | 说明 |
| --- | --- | --- |
| DeepSeek API 路径 | `src/web-search.js:33,38`、`docs/guides/DSH_020_ADAPTATION.md:545` | `api.deepseek.com/.../v1` 是上游 API 版本 |
| voxd TTS 协议 | `src/voice-tts.js:100`、`src/voice-packs.js:1298-1304`、`src/voice-management.js:159-162` | `/v1/speak/file`、`/v1/health` 是 voxd 包装协议 |
| B站/抖音 API 路径 | `src/bili-api.js:99`、`plugins/surfcore/tools/commands/{dm,dm-await,feed}.mjs`、`lib/douyin-browser.mjs` | `web-dynamic/v1`、`web_im/v1`、`/aweme/v1/` 是平台 API 版本 |
| DSH 令牌签名 | `src/dsh-client.js:130` | `v1.` 前缀的签名格式 |
| SnowLuma 制品 | `docs/guides/DSH_020_ADAPTATION.md:468`、HANDOFF | `SnowLuma-v1.14.20-*.zip` 外部版本 |
| 语音云包 | `docs/HANDOFF.md:731` | `voice-cloud-offline-v1.0.0-*.zip` 外部制品 |
| PCM 标准化标记 | `src/perception/util.js:312` | `pcm-s16le-16000-mono-v1` 数据格式名 |
| 抖音 profile 归属标记 | `lib/douyin-browser.mjs:37,40` | `surfcore-douyin-profile-v1` 目录标记 |

---

## 1. 清单本体（按"删了最安全 → 删了最痛"排序）

### ① 🟢 人格卡 / 提示词里的 v1/v2 文案过滤层 —— 删了最安全

| 项 | 内容 |
| --- | --- |
| 位置 | `src/persona-layers.js`（`〔一代〕/〔二代〕`小节过滤，mode 'v1'/'v2'）；`src/role-card.js:14-101`（`ROLE_INJECT_MODES`、`〔一代|1代|v1|reserved〕`正则、`v1Only` 统计）；`src/preset-prompt.js:35-47`（`PRESET_BLOCKING_SUBSTRINGS_V1` 与 preset 'v1'/'v2' 硬校验） |
| 被谁引用 | 人格卡注入链（persona.js → bridge/pet/bili 注入）；`scripts/test-persona-layers.mjs`；preset 保存校验 |
| 删除波及 | 人格卡中〔一代〕小节不再被过滤区分；preset 硬校验少一套不变量。**依赖前提：先让所有 preset 只用 v2 校验**，否则校验语义缺口 |
| 数据/用户配置依赖 | ⚠️ **角色包人格卡（`roles/*.md` / 角色包 character 文件）里可能含〔一代〕小节**——是用户数据。删除过滤层前需把内容合并为 v2-only 文本并迁移 |
| 批次状态 | ✅ **已删**：〔一代〕/〔二代〕过滤、`v1Only` 统计、`PRESET_BLOCKING_SUBSTRINGS_V1` 与 preset 'v1'/'v2' 硬校验全部移除；`role-card.js`/`preset-prompt.js`/`persona-layers.js` 固定 V2。`~/.dsh` 角色包内的〔一代〕文本属用户数据，只读不动，未做内容迁移 |

### ② 🟢 Memory V2 模块内部的 'v1' 兼容分支 —— 删了较安全（V2 转正后）

| 项 | 内容 |
| --- | --- |
| 位置 | `src/core/memory-v2-routing.js:34`（fresh 环境 `backend:'v1'` 的 legacy-default）；`src/core/memory-v2-qq.js:97,152,192,269`（legacy acceptance 分支）；`src/core/memory-v2-lifecycle.js:263,272`（`activeBackend:'v1'` 结果态）；`plugins/surfcore/lib/memory-v2-host.mjs:71-72,132,141`（worker 不可用时回落 'v1' 文案）；`lib/memory-v2-management.mjs:113`；`lib/memory-v2-panel.mjs:88,239`（"V1 继续作为当前记忆来源"UI 文案）；`src/core/memory-v2-legacy-registry.js`、`memory-v2-migration-plan.js`（'legacy'/'v1' 来源判定） |
| 被谁引用 | 路由判定被 `scheduler.js:biliContextForRound`、`douyin-companion-memory.mjs`、`qq-v2-reply-host.mjs:42`、`bili-v2-agent.mjs:66`、`lib/index.js`（memoryV2 装配）消费 |
| 删除波及 | V2 变成硬性前置：无控制库/fail-closed 时不再回落 'v1'，而是明确报错。**这正是退役 V1 的语义**，但必须先完成数据迁移与真机验收，否则所有渠道记忆写入直接失败 |
| 数据/用户配置依赖 | 迁移路径本身（memory-v2-migration-plan/legacy-registry）就是为 V1 数据设计的——**删迁移代码 = 永久放弃 V1 数据导入能力**，必须在数据迁移完成后才删 |
| 批次状态 | ✅ **已删**：Memory 后端收口 V2-only——fresh 路由缺省 `{backend:'v2',source:'fresh-default'}`，读/发布 v1 一律 fail-closed `MEMORY_BACKEND_RETIRED`；删 `memory-v2-legacy-registry.js`、`memory-v2-migration-plan.js`，legacy acceptance/回落 'v1' 分支与 UI 文案一并移除。`context.js` 删 V1 记忆卡分支与 life/purpose 注入。残留：Memory V2 管理/面板 UI 仍接受 `backend:'v1'` 夹具值，仅 UI 展示层，核心路由已 V2-only |

### ③ 🟡 QQ 一代仿真（v1 preset + reserved 模式） —— 删了中等痛

| 项 | 内容 |
| --- | --- |
| 位置 | `src/bridge.js:538`（`PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' }`）；`src/bridge.js:920`（`agentPreset` 缺省回退 `'qq-chat'`）、`:960`（`learnerPreset: 'qq-chat'`）；`dsh/agent-presets/qq-chat/`（v1 preset 目录，与之相对 `qq-chat-v2/`）；`plugins/surfcore/qq-mode/index.js:31-34`（模式枚举含 `reserved`，默认 `reserved2`）；`lib/qq-mode.js`（re-export） |
| 被谁引用 | bridge 会话创建/模式闸（模式变→重建会话）、控制台模式页、`state/mode.json` 读写、测试脚本（协议回归） |
| 删除波及 | `agentPreset` 缺省回退要改指 v2；模式枚举删 `reserved` 后，控制台与 `state/mode.json` 里已存的 `["reserved",...]` 值会校验失败——需要兼容读取或一次性迁移 |
| 数据/用户配置依赖 | ⚠️ `state/mode.json`（用户当前模式）、DSH profile 的 `agentPreset` 配置值 |
| 批次状态 | ✅ **已删**：`qq-chat` preset 目录与 patch 删除、`PRESET_NAMES` 收敛 `qq-chat-v2`；模式枚举删 `reserved`（旧 `state/mode.json` 值 fail-closed并提示改 `simulation`）；控制台一代仿真模式按钮/选项、插件设置窗口「一代仿真（reserved）」设置组删除；`/api/social*` 四个 V1 路由删除，V1 5 秒社交心跳不再启动。旧 `state/mode.json` 的 `reserved` 值需手工改 `simulation`（用户数据，只读不动） |

### ④ 🔴 V1 记忆后端本体（记忆卡 + 全量卡 + 同步） —— 删了最痛

| 项 | 内容 |
| --- | --- |
| 位置 | `src/memory-card.js`（衰减卡/全量卡核心）、`lib/memory-card.js`（插件侧）、`lib/memory.js`（双向脱敏同步）、`src/core/context.js:150`（`memoryBackend` 缺省 `'v1'`） |
| 被谁引用 | **所有渠道的记忆读写**：QQ（inbox 注入、`/api/memory-card/notify`）、B站（调度上下文、脱敏同步）、桌宠（pet-chat）、purpose-engine（素材来源）、身份对齐 |
| 删除波及 | 三场景共享记忆、长期关系、主动目的全部失效——产品停摆。**且它是 Memory V2 的迁移源**：迁移计划、legacy-registry 都从 V1 数据出发 |
| 数据/用户配置依赖 | 🔴 **角色包 `memory/` 目录的全部 V1 记忆卡 + 全量卡 JSONL（append-only 用户数据，体量大、不可再生）** |
| 批次状态 | 🟡 **部分删除**：`src/core/context.js` 的 V1 记忆卡注入分支已删（Memory 后端 V2-only）；`src/memory-card.js` / `lib/memory-card.js` / `lib/memory.js` 本体**保留**——前者供评测测试 import，插件侧仍是衰减卡/全量卡与跨平台同步的实现。`~/.dsh` 角色包 `memory/` 下 V1 记忆卡/全量卡 JSONL 属用户数据，只读不动 |

### ⑤ 🔴 B站 V1 链路（调度 + 四本账 + 工具面） —— 删了最痛

| 项 | 内容 |
| --- | --- |
| 位置 | `lib/scheduler.js`（10s tick 生物钟）、`tools/`（watch/like/favorite/comment/reply/dynamic/share + feed-core、fish-guard、watch-history、pref-scan）、`lib/automation.js`、`src/bili-api.js`；V2 相对物是 `lib/bili-v2-*.mjs`（`dsh.biliV2` 默认关） |
| 被谁引用 | 插件 index 装配、设置窗口 B站标签、桥接 B站工具面 |
| 删除波及 | B站自主生活（PRD P1-9）停摆；四本账/观看历史/偏好数据失去消费者 |
| 数据/用户配置依赖 | 🔴 `logs/bili-bot/` 账本与观看历史（append-only 用户数据）、`dsh.bili` 配置 |
| 批次状态 | 🟡 **部分删除（V1 会话层已删，工具链/调度触发机器保留）**：`scheduler.js` 的 B站 V1 会话创建/权限装配删除，只保留 tick/监听机器并改走 `biliV2Agent.enqueue`（V2 Host 无自有触发器）；`src/bili-api.js` 保留（B站 V2 用）、`tools/commands` 与 `tools/lib` 是 V2 worker 共享库保留、`lib/automation.js` 只读 UI 快照保留。`~/.dsh`/`logs/bili-bot/` 账本与观看历史属用户数据，只读不动 |

### ⑥ 🔴 QQ V1 发送/审计链路 —— 删了最痛（与 V2 共存双路径）

| 项 | 内容 |
| --- | --- |
| 位置 | `src/bridge.js` 内 v1 路径 `auditAndSend()` 与 v2 `sendMessagesV2()` 双路径（HANDOFF 3056：v1 `auditAndSend` 成功后也记 `recordSelfMemoryEvent`）；`lib/qq-v2-reply-host.mjs` 是 V2 相对物（要求 `memoryV2.getRouting().backend === 'v2'`，`:42`） |
| 被谁引用 | QQ 出站全链路；QQ V2 只在 Memory 路由为 v2 时生效 |
| 删除波及 | 当前生产大量流量仍走 v1 路径（Memory 默认 v1）；先删会让 QQ 出站只剩"V2 且 Memory=v2"才可用 |
| 数据/用户配置依赖 | `dsh.memoryV2` / 路由状态文件；回复审计账本 |
| 批次状态 | 🟡 **已知残留（本批未整体重写 QQ 出站双路径）**：`src/bridge.js` 的 `auditAndSend` 仍在，属已知残留，未在本批删除；Memory 路由已 V2-only 后 QQ V2 链路生效。另 `src/bridge.js` 的一代社交状态机函数与 `social` 容器暂时保留（会话退役/重置仍借它清内存态），但 `reserved` 不可达、心跳不启动、HTTP 面已删 |

---

## 2. 依赖关系一句话

**原前置链（Memory V2 转正 → 各渠道 V2 广泛回归 → 用户圈定范围 → 隔离备份 → 分批删 V1）已被 2026-11-12 破坏式重构取代**：不再等"用户圈定 + 数据迁移"，直接删代码面、收口 V2-only，用户数据（`~/.dsh`）只读不动；残余只在代码残留（④⑤⑥ 部分保留）与用户侧旧配置的手工改值。

## 3. 推荐圈定方案（2026-11-12 调研补证后，供拍板）

> **已被破坏式重构取代，以下仅保留作决策史料**：2026-11-12 拍板最终改为「直接删六项、不留向后兼容」，未采用下列"分批 + 圈定 + 数据迁移"节奏。

### 3.1 调研补证（本轮新增实证，全部可复核）

1. **v1 preset 是生产缺省，且被测试钉住**：`src/bridge.js:920`（`agentPreset ?? 'qq-chat'`）；`scripts/test-audit-bridge.mjs:18` 断言缺省就是 `'qq-chat'`；`scripts/test-setup-dsh-idempotent.mjs:122` 要求 `qq-chat` 与 `qq-chat-v2` 两个 preset 目录都装；`scripts/test-phase-bc-verification.mjs:21` 的 safePresets 含 `'qq-chat'`。→ 删 ③ 必须连动改至少 4 个测试文件 + 缺省值 + 用户配置迁移。
2. **模式枚举被三处测试钉住**：`test-qq-mode-plugin.mjs:71`、`test-console-ui.mjs:121`、`test-audit-security-mcp.mjs:205` 都遍历含 `'reserved'` 的五模式。→ 删 reserved 枚举是纯机械改造，但有回归面。
3. **〔一代〕小节在仓库内只出现在文档示例**（`roles/README.md`），仓库自带的 preset/角色模板没有。→ ① 的迁移负担实际只在 `~/.dsh` 用户角色包（数据面），且可以做成一次性只读扫描 + 备份迁移脚本，体量可控。
4. **memory-card 测试面很厚**：`src/memory-card.js` 2,481 行，受 `test-core-rev-sync`（rev 后缀纪律）、`test-memory-card`、`test-phase-a-verification`、`test-memory-v2-evaluation` 覆盖。→ ④ 不是"删文件"而是"删地基"，必须最后动。
5. **reserved2 已在用 v2 preset**：`bridge.js:1009` 已有一处直接用 `'qq-chat-v2'`；`:4071` reserved2 优先取 `socialV2.agentPreset`。→ 把缺省从 v1 切到 v2 只剩"缺省值 + 迁移 + 观察期"，不是从零开始。

### 3.2 三个候选方案

**方案 A（推荐）：全部 6 项圈入退役范围，按三批走，节奏绑 V2 转正**

| 批次 | 内容 | 准入条件 | 体量 | 风险 |
| --- | --- | --- | --- | --- |
| **D1 开关批（不是删除，可立即启动）** | 缺省 `agentPreset` 从 `'qq-chat'` 切 `'qq-chat-v2'`（`bridge.js:920`）+ 4 个测试文件改造 + `state/mode.json`、profile `agentPreset` 的兼容迁移（旧值照读，新写一律 v2）+ 一个使用周期观察 | QQ V2 已有真机验收（2026-11-12 HANDOFF），直接可做 | bridge.js 数行 + 4 测试 + 1 个迁移函数 | 低：v2 已真机跑过；回滚 = 改回缺省值一行 |
| **D2 删 ①③（D1 观察期通过后）** | 删 `dsh/agent-presets/qq-chat/` 目录、reserved 模式枚举、`persona-layers.js`/`role-card.js`/`preset-prompt.js` 的 v1 过滤与硬校验（连同 `PRESET_BLOCKING_SUBSTRINGS_V1`） | D1 观察期无回退需求；`~/.dsh` 角色包〔一代〕小节一次性迁移（先隔离备份） | ~6 个文件 + 3 个测试文件改造 | 中：人格卡文本迁移是唯一数据面动作 |
| **D3 删 ②④⑤⑥（Memory V2 转正后）** | 删 Memory V2 内 legacy 分支、`src/memory-card.js`+`lib/memory-card.js`+`lib/memory.js` 的 V1 本体、`lib/scheduler.js`+`tools/` 的 B站 V1 链路、`bridge.js` 的 v1 发送路径 | Memory V2 转正（真机验收 + 全量数据迁移 + 抽样核对）→ B站 V2 / QQ V2 广泛回归 → 用户最终确认 | 最大：memory-card 2,481 行 + tools 67 个文件 + scheduler + bridge v1 路径 | 高：数据迁移是硬前置；回滚靠 git revert + `_quarantine` 备份 |

**方案 B（不推荐）：只圈 ①③，④⑤⑥ 无限期保留。** 与拍板"V1 系列最终删除"冲突；且 Memory V2 / QQ V2 / B站 V2 的工程与验收投入已经发生，长期双轨只会让 lint 债务（bridge.js 443 处）和文档数字继续腐烂。

**方案 C（不可取）：一次全删。** QQ V2 目前只有单轮真机验收，删 v1 发送路径会让出站只剩未广泛回归的链路；B站 V2 还是"模块验收、未安装"状态。铁律 2/3 都不允许。

### 3.3 圈定结论（推荐采纳方案 A）

- **退役范围 = 清单 ①②③④⑤⑥ 全部**；排除表（§0）的 8 类第三方协议 v1 与 docs 历史记录**不在范围**，永久保留。
- **立即可启动**：D1（缺省切 v2 + 测试改造 + 迁移）——这是解锁 ①③ 的钥匙，且本身不删任何东西。
- **D2、D3 各自单独立批**：删除动作执行时按铁律 6 先隔离备份（`~/.dsh/_quarantine/` / `_backups/`），每批删除前后跑全门禁（audit / lint:failures / 插件测试 / doc-facts）。
- **不删清单**：`test-core-rev-sync` 对 memory-card 的 rev 纪律在 D3 之前继续有效；`dsh.biliV2` / `dsh.memoryV2` 配置键在转正前保持默认关。

## 4. 本清单的边界

- 只清点了"v1/V1 命名"与"V1 默认行为"；行数规模与测试钉子已在 §3.1 补证（memory-card 2,481 行、4+3 个测试文件受影响）——该补证是删除前的决策史料，现行状态以 §1「批次状态」为准。
- §0 的第三方协议 `v1` 排除表（8 类）**不在删除范围，永久保留**；`docs/` 下的历史案例/HANDOFF 提到 V1 的文字不属于删除对象（历史记录）。
- **`~/.dsh` 用户数据只读不动**：角色包人格卡/记忆卡、`state/mode.json`、`logs/bili-bot/` 账本一律不删。旧 `mode.json` 值 `reserved` 需手工改 `simulation`；旧 `memory-v2/routing.json` 指向 v1 时备份后删文件、重启按 V2 重新初始化。
- 代码残留如实列在 §1（④⑤⑥ 部分保留、`auditAndSend` 与 `social` 容器保留）；引用关系以删除前 grep 实证为准，逐条可复核。
