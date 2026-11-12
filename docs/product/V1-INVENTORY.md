# V1 清单盘点（决策用，2026-11-12）

> **本文只做清单，未删除任何代码或数据。** 依据 2026-11-12 拍板："V1 系列判定为过时，最终目标是删除"。
> 真正删除需用户圈定范围后另立批次，并按 AGENTS 铁律 6 先隔离备份（`~/.dsh/_quarantine/` / `_backups/`）。
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
| 建议动作 | 随"QQ 一代仿真退役"（③）一起做；先迁移人格卡文本 |

### ② 🟢 Memory V2 模块内部的 'v1' 兼容分支 —— 删了较安全（V2 转正后）

| 项 | 内容 |
| --- | --- |
| 位置 | `src/core/memory-v2-routing.js:34`（fresh 环境 `backend:'v1'` 的 legacy-default）；`src/core/memory-v2-qq.js:97,152,192,269`（legacy acceptance 分支）；`src/core/memory-v2-lifecycle.js:263,272`（`activeBackend:'v1'` 结果态）；`plugins/surfcore/lib/memory-v2-host.mjs:71-72,132,141`（worker 不可用时回落 'v1' 文案）；`lib/memory-v2-management.mjs:113`；`lib/memory-v2-panel.mjs:88,239`（"V1 继续作为当前记忆来源"UI 文案）；`src/core/memory-v2-legacy-registry.js`、`memory-v2-migration-plan.js`（'legacy'/'v1' 来源判定） |
| 被谁引用 | 路由判定被 `scheduler.js:biliContextForRound`、`douyin-companion-memory.mjs`、`qq-v2-reply-host.mjs:42`、`bili-v2-agent.mjs:66`、`lib/index.js`（memoryV2 装配）消费 |
| 删除波及 | V2 变成硬性前置：无控制库/fail-closed 时不再回落 'v1'，而是明确报错。**这正是退役 V1 的语义**，但必须先完成数据迁移与真机验收，否则所有渠道记忆写入直接失败 |
| 数据/用户配置依赖 | 迁移路径本身（memory-v2-migration-plan/legacy-registry）就是为 V1 数据设计的——**删迁移代码 = 永久放弃 V1 数据导入能力**，必须在数据迁移完成后才删 |
| 建议动作 | Memory V2 转正 + 全量数据迁移验收后，作为"V1 退役"的一部分删除 |

### ③ 🟡 QQ 一代仿真（v1 preset + reserved 模式） —— 删了中等痛

| 项 | 内容 |
| --- | --- |
| 位置 | `src/bridge.js:538`（`PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' }`）；`src/bridge.js:920`（`agentPreset` 缺省回退 `'qq-chat'`）、`:960`（`learnerPreset: 'qq-chat'`）；`dsh/agent-presets/qq-chat/`（v1 preset 目录，与之相对 `qq-chat-v2/`）；`plugins/surfcore/qq-mode/index.js:31-34`（模式枚举含 `reserved`，默认 `reserved2`）；`lib/qq-mode.js`（re-export） |
| 被谁引用 | bridge 会话创建/模式闸（模式变→重建会话）、控制台模式页、`state/mode.json` 读写、测试脚本（协议回归） |
| 删除波及 | `agentPreset` 缺省回退要改指 v2；模式枚举删 `reserved` 后，控制台与 `state/mode.json` 里已存的 `["reserved",...]` 值会校验失败——需要兼容读取或一次性迁移 |
| 数据/用户配置依赖 | ⚠️ `state/mode.json`（用户当前模式）、DSH profile 的 `agentPreset` 配置值 |
| 建议动作 | 真机回归后把缺省切到 `qq-chat-v2`，观察一个使用周期，再删 preset 目录与 reserved 枚举 |

### ④ 🔴 V1 记忆后端本体（记忆卡 + 全量卡 + 同步） —— 删了最痛

| 项 | 内容 |
| --- | --- |
| 位置 | `src/memory-card.js`（衰减卡/全量卡核心）、`lib/memory-card.js`（插件侧）、`lib/memory.js`（双向脱敏同步）、`src/core/context.js:150`（`memoryBackend` 缺省 `'v1'`） |
| 被谁引用 | **所有渠道的记忆读写**：QQ（inbox 注入、`/api/memory-card/notify`）、B站（调度上下文、脱敏同步）、桌宠（pet-chat）、purpose-engine（素材来源）、身份对齐 |
| 删除波及 | 三场景共享记忆、长期关系、主动目的全部失效——产品停摆。**且它是 Memory V2 的迁移源**：迁移计划、legacy-registry 都从 V1 数据出发 |
| 数据/用户配置依赖 | 🔴 **角色包 `memory/` 目录的全部 V1 记忆卡 + 全量卡 JSONL（append-only 用户数据，体量大、不可再生）** |
| 建议动作 | 最后删。前置：Memory V2 转正（真实环境验收 + 失败路径有 code/hint + 回滚演练）→ 全量数据迁移且抽样核对 → 用户明确圈定后才动 |

### ⑤ 🔴 B站 V1 链路（调度 + 四本账 + 工具面） —— 删了最痛

| 项 | 内容 |
| --- | --- |
| 位置 | `lib/scheduler.js`（10s tick 生物钟）、`tools/`（watch/like/favorite/comment/reply/dynamic/share + feed-core、fish-guard、watch-history、pref-scan）、`lib/automation.js`、`src/bili-api.js`；V2 相对物是 `lib/bili-v2-*.mjs`（`dsh.biliV2` 默认关） |
| 被谁引用 | 插件 index 装配、设置窗口 B站标签、桥接 B站工具面 |
| 删除波及 | B站自主生活（PRD P1-9）停摆；四本账/观看历史/偏好数据失去消费者 |
| 数据/用户配置依赖 | 🔴 `logs/bili-bot/` 账本与观看历史（append-only 用户数据）、`dsh.bili` 配置 |
| 建议动作 | B站 V2 模块验收 + 真机安装后才可讨论；在此之前 V1 链路是唯一可用的 B站实现 |

### ⑥ 🔴 QQ V1 发送/审计链路 —— 删了最痛（与 V2 共存双路径）

| 项 | 内容 |
| --- | --- |
| 位置 | `src/bridge.js` 内 v1 路径 `auditAndSend()` 与 v2 `sendMessagesV2()` 双路径（HANDOFF 3056：v1 `auditAndSend` 成功后也记 `recordSelfMemoryEvent`）；`lib/qq-v2-reply-host.mjs` 是 V2 相对物（要求 `memoryV2.getRouting().backend === 'v2'`，`:42`） |
| 被谁引用 | QQ 出站全链路；QQ V2 只在 Memory 路由为 v2 时生效 |
| 删除波及 | 当前生产大量流量仍走 v1 路径（Memory 默认 v1）；先删会让 QQ 出站只剩"V2 且 Memory=v2"才可用 |
| 数据/用户配置依赖 | `dsh.memoryV2` / 路由状态文件；回复审计账本 |
| 建议动作 | 依赖链是：**Memory V2 转正 → QQ V2 广泛回归 → 删 v1 发送路径**。与 ④ 必须同批或后于 ④ 的一体化决策 |

---

## 2. 依赖关系一句话

**一切最痛项（④⑤⑥）都压在同一条前置链上：Memory V2 转正（真机验收 + 数据迁移）→ 各渠道 V2 广泛回归 → 用户圈定范围 → 隔离备份 → 分批删 V1。** 最安全项（①②③）可随这条链顺路退场，不需要单独冒进。

## 3. 本清单的边界

- 只清点了"v1/V1 命名"与"V1 默认行为"；未评估各模块的行数规模与删除工作量。
- `docs/` 下的历史案例/HANDOFF 提到 V1 的文字不属于删除对象（历史记录）。
- 本清单未删除任何代码、配置或数据；引用关系以 grep 实证为准，逐条可复核。
