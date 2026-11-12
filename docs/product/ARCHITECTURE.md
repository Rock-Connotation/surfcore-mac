# SurfCore 功能架构说明

配套文档：[PRD.md](PRD.md)（产品视角）· [IMPROVEMENTS.md](IMPROVEMENTS.md)（缺口与风险）· [V1-INVENTORY.md](V1-INVENTORY.md)（V1 退役清单）
**文档版本 v0.2（2026-11-12）**：拍板不改变本图的进程/分层事实；受拍板影响的只有 §6 的状态语义（V1 系列标记为过时、抖音暂缓、桌宠低优先）。
依据：`dev` @ `790c1d3` 的源码与文档，只读扫描。所有结论标注入口文件；未逐行阅读 `src/bridge.js`（18,221 行），桥接细节引用 `docs/guides/MODULE-BRIDGE.md`。

---

## 1. 为什么单独成文

PRD 的模块表回答"用户能看到什么"；本文回答"它在哪个进程、由谁实现、上游下游是谁、现在处于什么状态"。两者混写会让"仅设计"的条目看起来像已交付功能，因此拆开。

---

## 2. 进程与部署拓扑

```
┌─────────────────────────────── 用户 Mac / PC ───────────────────────────────┐
│                                                                             │
│  ┌──────────── DSH 宿主进程（Electron） ─────────────┐   ┌── SnowLuma（外部）──┐│
│  │  agent preset：constant + qq-chat / qq-chat-v2    │   │  QQ 客户端运行时    ││
│  │  surfcore bundle（plugins/surfcore/lib/index.js）│◄──┤  HTTP+WS，令牌鉴权  ││
│  │   ├─ 设置窗口 /dsh-surfcore（client.js，15 标签）│   └─────────┬───────────┘│
│  │   ├─ B站调度 scheduler.js（10s tick）             │             │            │
│  │   ├─ 记忆卡维护 / 目的 / 桌宠 API / 额度 / 语音   │             │            │
│  │   └─ 设备身份 Ed25519（install-identity.js）      │             │            │
│  └───────────────┬───────────────────────────────────┘             │            │
│                  │ 派生 + 监控（bridge-process.js）                │            │
│  ┌───────────────▼──────────────┐        ┌──────────────────────────▼────────┐  │
│  │ QQ 桥接进程 src/bridge.js     │◄──────►│ SnowLuma HTTP API（QQ 收发）      │  │
│  │  ├─ 控制台 :3100（10 页）      │        └───────────────────────────────────┘  │
│  │  ├─ 会话映射 / 工具面          │                                              │
│  │  └─ 工具脚本 tools/            │───► B站 HTTP + Playwright 浏览器 profile      │
│  └───────────────────────────────┘───► 抖音 Playwright profile（独立账号）      │
│                                                                             │
│  桌宠 Electron（仓库外）──轮询──► 插件 /dsh-surfcore/api/pet/*（本地令牌）        │
└─────────────────────────────────────────────────────────────────────────────┘
```

关键事实：

- 插件宿主与桥接是**两个进程**，桥接由插件派生并监控（`lib/bridge-process.js`），但两者都能独立启停（`plugins/surfcore/README.md:29-32`）。
- 设置窗口由**插件宿主**提供，不依赖桥接；桥接控制台是独立的 `:3100`，二者权限面不同（`README.md:86`、`RULES.md:32`）。**设置窗口 15 个标签对所有用户一致，无按用户类型的分叉**（拍板核查，`client.js:6938-6954,7215`）。
- 桌宠、SnowLuma、语音引擎、DSH 本体均为外部依赖；本仓库只探测与调用（`BOUNDARIES.md:18-21`）。

---

## 3. 分层与职责

| 层 | 所在位置 | 职责 | 不该做什么 |
| --- | --- | --- | --- |
| 身份层 | `plugins/surfcore/lib/characters.js`、`src/character-persona.js` | 角色包整包切换、人格卡、快照 | 不直接发消息、不写平台账本 |
| 记忆层 | `src/memory-card.js`、`lib/memory-card.js`、`lib/memory.js` | 衰减卡/全量卡、跨平台同步、对齐 | 不做模型调用；不决定"要不要说话" |
| 表达层 | `lib/scheduler.js`、`tools/`、`lib/douyin-*.mjs`、`lib/pet-chat.js` | 各渠道（出口）的具体行为 | 不绕过约束层 |
| 约束层 | `src/qqtool-restrict.mjs`、`src/fish-guard.js`、`src/token-budget.js`、`lib/privacy.js`、`src/identity-guard.js` | 工具面、鱼群、额度、隐私、身份 | 不依赖人格提示词"自觉" |
| 运维层 | `lib/client.js`、`public/console.html`、`lib/doctor.js`、`lib/updates.js` | 配置、诊断、备份、更新 | 不成为第二套业务逻辑 |

---

## 4. 三条主链路（时序）

### 4.1 QQ 入站 / 出站（默认出口）

```
QQ → SnowLuma WS → bridge.js（黑名单→白名单→模式闸→鱼群→防抖）
   → 任务前置拦截（任务：…）→ DSH 会话（每 QQ 会话独立 session + agentToken）
   → 模型（constant preset + 人格 + 记忆注入 + 工具面）
   → 回复 → bridge.js 审计（source=qq, mode）→ 白名单校验 → SnowLuma 发送
```

- 会话与令牌映射：`ARCHITECTURE.md:150-184`。
- 群聊观感由提示词掌控（"发言/潜水/收尾"），能力由代码决定（`AGENTS.md`）。
- 主动目的在这一层是**旁路**：`purpose-engine` 生成目的，`qq-purpose.js` / `pet-purpose.js` 选载体。

### 4.2 B站日常（用户在设置中开启的出口）

```
scheduler.js 每 10s tick
  → 生物钟判定（窗口/次数/间隔/安静时段）
  → actions：watch / like / favorite / comment / reply / dynamic / share
  → tools/lib/*（HTTP 带 cookie；摄像头类用 Playwright）
  → 四本账额度 + 鱼群保护 + 身份闸 + 脱敏
  → 写入 B站账本（logs/bili-bot/...），部分事件回流记忆卡
```

- 默认动作集合与间隔：`plugins/surfcore/README.md:119-178`。
- 观赏历史只追加、按角色分目录：`tools/lib/watch-history.mjs`。

### 4.3 抖音陪伴（暂缓出口：代码保留，不投入）

```
douyin-service（登录/推荐/详情，独立 profile）
  → 有界调度（每日两轮，每轮 ≤2 条 / ≤120s / ≤4 次模型请求）
  → 音轨 + 稀疏帧 + ASR → 模型点评（一次视觉请求同时产出感受与轻问题）
  → 日记（companion-page 内嵌 iframe）+ 同渠道分享（客户端轮询未读/回复）
```

- 账号边界：主人号只读；角色号不读联系人；服务号不可私信（`README.md:275-293`）。
- 状态：`CHANNEL-STATUS-2026-11-07.md` 明确"源码完成 ≠ 接入完成"；2026-11-12 拍板暂缓。

---

## 5. 数据与配置（单一真相）

| 数据 | 位置 | 写入方 | 备注 |
| --- | --- | --- | --- |
| 用户配置 | `~/.dsh/surfcore/config.json` | 设置窗口 / 控制台 | 原子写 + 备份（`lib/config.js`） |
| DSH profile 设置 | `dsh.profile.settings` | 窗口 / 控制台 | `dsh.qq` / `dsh.bili` / `dsh.biliV2` / `dsh.memoryV2` / `dsh.tokenBudget` / `dsh.chat` / `dsh.pet` / `dsh.platforms.start` |
| 插件清单 | `plugins/surfcore/package.json` | 发布流程 | 版本必须与根 `package.json` 一致 |
| 角色包 | `~/.dsh/surfcore/characters/<id>/` | `characters.js` | 切换即整包替换 |
| 记忆卡 | 角色包内 `memory/` | 插件唯一写者 | QQ 只写 inbox，不直接改卡 |
| 平台账本 | `logs/bili-bot/`、`logs/qq-bot/` | 各工具 | append-only + 配额 |
| 运行时状态 | `state/mode.json`、`pet/focus.json`、`dsh-port.json` | 桥接 / 桌宠 / 宿主 | 端口会漂移，禁止硬编码 |

> 已知缺口：`config.example.json` 未包含 `chat` / `pet` / `tokenBudget` / `platforms.start` 的模板值（`ARCHITECTURE.md:249`）。新装用户看不到这些默认项。"默认只开 QQ"的默认值改造落地时须同步补模板。

---

## 6. 模块矩阵（实现位置 × 状态）

状态语义（拍板后）：`🗄️ 已过时` = 按 2026-11-12 拍板判定过时、最终退役（清单见 [V1-INVENTORY.md](V1-INVENTORY.md)）；`⏸️ 暂缓` = 拍板不投入，代码保留。

| 子系统 | 入口 | 规模 | 状态 | 判据 |
| --- | --- | --- | --- | --- |
| 设置窗口 | `lib/client.js` | 7,333 行 / 15 标签 | ✅ | 标签与 API 一一对应；静态渲染无分叉（`client.js:6939-6955,7215`） |
| 插件宿主 API | `lib/index.js` | 4,149 行 / prefix 分派 | ✅ | `index.js:3916-4038` |
| QQ 桥接 | `src/bridge.js` | 18,221 行 / 165 处路径 | ✅ | 控制台 + 审计 + 真机验收 |
| B站调度 | `lib/scheduler.js` | — | ✅ | tick + 四本账 + 案例 |
| B站 V1 链路 | `lib/scheduler.js` + `tools/` | — | 🗄️（生产默认，退役需先转正 V2） | [V1-INVENTORY.md](V1-INVENTORY.md) |
| B站 V2 | `lib/bili-v2-*.mjs` | 多模块 | 🟡 | 模块验收，未安装 |
| 抖音 | `lib/douyin-*.mjs` | 13 个模块 | 🟡 ⏸️ | 真实链路有验收，稳定性未验；拍板暂缓 |
| 记忆 V1 | `src/memory-card.js` | — | 🗄️（生产默认，退役需先转正 V2） | 默认路径；用户数据载体 |
| 记忆 V2 | `src/core/memory-v2-*` | 16 个模块 | 🟡 | 默认 `backend: 'v1'`（`memory-v2-routing.js:34`） |
| QQ 一代仿真（v1 preset） | `dsh/agent-presets/qq-chat`、`bridge.js:538` | — | 🗄️（默认 preset 是 v1，转正 v2 后退役） | `PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' }` |
| 语音 | `src/voice-*.js` | — | ✅/🟡 | 语音库 ✅；云端 🟡；火山 TTS 真实计费/音质第一梯队 |
| 桌宠 | `lib/pet*.js` | — | ✅ ⬇️ | API + 令牌；本体外部；拍板优先级较低 |
| 目的 | `src/purpose-engine.js` | — | ✅ | 9 类需求 + 双载体 |
| 额度 | `src/token-budget.js` | — | ✅ | 四口径 + 峰谷；资源约束而非商业功能 |
| 任务 Harness | `src/task-harness.js` | 1,000+ 行 | 🟡 | dev，未发布；含 macOS 控制 |
| 统一生活 | `src/core/life.js` | — | 🟡 | 已接入卡片，无独立入口 |
| 扩展/平台 | `lib/extensions.js`、`lib/platforms.js` | — | 🟡 | 只有空壳示例；`tieba: planned` |
| 贴吧 | `platforms/tieba/manifest.json` | 清单 | 🧪 | 无适配器 |
| 一代仿真 | `qq-mode.js` `reserved` | — | 🗄️ | 默认 `reserved2` |
| macOS 设计稿 | `docs/design/macos/` | 索引指向该入口 | 🧪 | 该目录被 `.gitignore:58` 忽略，本工作树未携带；`docs/README.md:78` 的"已收录"措辞易误读 |

---

## 7. 架构层面的三个真实约束

1. **DSH 是宿主，不是库**：模型、会话、工具面、profile 都由 DSH 提供；插件只能通过 host API 与 profile 交互。DSH 升级会覆盖 `app.asar` 补丁（`AGENTS.md` 环境事实）。
2. **桥接是单体**：18k 行单文件 + 165 处路径判断，所有 QQ/B站工具面与安全闸都在这里；这是当前最大的维护面。
3. **跨平台靠进程外协作**：桌宠不 import 宿主代码，只用 HTTP + 令牌；好处是解耦，代价是所有状态需要落文件（`ARCHITECTURE.md:212-221`）。

---

## 8. 与文档不一致的架构数字（供维护者核对）

这些数字已交给 `npm run doc-facts`（`scripts/doc-facts.mjs`）自动核对；口径见该脚本头部注释。下表保留最初发现时的对照记录：

| 项 | 文档（旧） | 实测 |
| --- | --- | --- |
| 设置标签 | 13（插件 README:60-75）/ 14（ARCHITECTURE:80） | 15（`client.js:6939-6955`） |
| 控制台路径 | 126（ARCHITECTURE:105、BOUNDARIES:173） | 165 处判断（按出现次数口径） |
| `src/` 引用 | 11 模块 26 处 / 12 模块 / 19 处 | 37 模块 96 处（含 presets 口径） |
| 版本 | 0.1.0（ROADMAP:158） | 0.8.8 |

修复记录见 [IMPROVEMENTS.md](IMPROVEMENTS.md) A2/A3（feat/doc-facts 批次）。
