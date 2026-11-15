# Case: 阶段 B-E 记忆闭环、任务准入与 Mac 本地执行能力建设

## 现象

- 在多平台（QQ、B站、本机）共存场景下，跨端任务执行缺乏不可伪造的持久化账本与外部交付回执（delivered / delivery_unknown / failed）。
- 普通群聊与未授权会话如果接触电脑执行或研究指令，缺乏前置独立的 Harness 准入闸门，易发生越权风险；网页引文缺乏结构化抓取证据与哈希核验。
- Memory V2 生产装配中需要确保记忆原件召回的有效时间（validFrom/validTo）和时间倒序排序、有界摘录支持，以及非安全 preset 的严格 fail-closed 拦截。
- 本地执行能力（文件整理、终端/脚本运行、Mac 原生应用控制）缺乏前置计划校验、系统受限目录隔离、破坏性指令拦截与有界超时控制。
- 鱼的自主生活与日常低风险活动缺乏透明记录，容易割裂或误广播。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS 26 / Apple Silicon; DSH 0.2.1-rc.5 (已装配会话护栏) |
| SurfCore 版本 | 0.8.8 |
| Node 版本 | v26.5.1 |
| 分支 / 提交基线 | refactor / 748afe6256a4619e83936c1bb225a29320a3a555 |

## 根因

1. **Memory V2 召回排序与时间完整性**：`src/core/memory-v2-store.js` 原有召回在词法重合度相同（overlap 相等）时回退为按 id 字符排序，未体现时间衰减与发生顺序；且 `prepareMemoryContext` 未格式化 `validFrom`/`validTo`/`occurredAt` 标签，长文本摘录缺乏显式 `budget.allowExcerpt` 开关门禁。
2. **任务账本与独立准入缺失**：此前 QQ 消息缺乏独立任务流水线与持久化任务账本（`TaskLedger`），无法对网络调研报告落盘（路径、SHA256、字节数）进行严格校验，且发送失败时可能存在静默吞咽或误报成功风险。
3. **本地副作用边界未锁死**：文件整理和脚本执行若直接在外部消息驱动下运行，若无独立 Harness 守门拦截，群聊或越权路径可能访问系统敏感根目录（如 `/System`, `/usr`, `/bin`, `/etc`）。

## 完整逻辑（给用户看的那一遍）

1. **链路**：
   - 入站消息（`OneBot WebSocket`）→ `src/bridge.js:handleIncoming`
   - 准入审查 → `src/task-harness.js:checkAdmission`（严格限制仅主人身份 + 私聊，群聊一律拦截）
   - 持久任务工单 → `src/task-ledger.js:createTask / updateTask`（状态原子写入 `state/tasks.json`）
   - 网页研究 & 产物生成 → `executeResearchStep`（安全抓取、文本清洗、引用源存证）→ `executeSynthesisStep`（报告 Markdown 落盘、SHA256 计算、文件存在与大小核验）
   - 本地执行 → `executeFilePlan`（系统目录白名单校验、删除文件强制进隔离区 `state/_quarantine/`）、`executeCommandStep`（黑名单命令拦截、有界超时 SIGTERM+SIGKILL、输出超限截断保留头尾）、`executeMacAppStep`（Mac 原生 `open -a`、`osascript`、`shortcuts` 原生控制）
   - 结果回送与回执确认 → `executeDeliveryStep`（调用 `sendToQQ` 并通过 `lastSendSucceeded` 确认真实发送，失败记录 `delivery_unknown`，绝不虚假声称成功）
   - 自主生活节奏 → `runAutonomousIdleActivity`（低风险日常活动、思维日志透明记入账本，不向外部广播、不篡改长期事实）
2. **机制**：
   - 职责边界分离：`src/bridge.js` 负责网络接入与协议分发；`src/task-harness.js` 负责副作用前置准入校验、路径安全与有界执行；`src/task-ledger.js` 负责状态持久化与证据账本。
   - 失败可见性：所有拒绝与失败均输出结构化 `{ ok: false, code, error, hint }`，并在聊天入口反馈清晰的可操作提示。
3. **爆炸半径**：
   - 进程数：1（主进程）+ 0~1（受限临时执行子进程，有界超时）。
   - 读者数：QQ 桥接通道、B站适配层、本地任务账本与活动日志。
   - 敏感资源保护：严格禁止对系统受限目录的写入；删除操作强制隔离至 `state/_quarantine/`；不接触任何密钥或生产数据。
4. **取舍**：
   - 路线 A（临时内联在 bridge.js 中写逻辑）：成本低但代码庞杂，无法被 B站或本地 CLI 复用，难以独立单元测试。
   - 路线 B（抽出独立的 deep modules `src/task-ledger.js` 与 `src/task-harness.js`）：职责清晰，接口简单，测试与生产共用同一套 Seam，拒绝/超时/回执逻辑完备。选路线 B。
5. **生效与重启**：
   - 修改 `src/bridge.js`, `src/task-harness.js`, `src/task-ledger.js`, `src/core/memory-v2-store.js`, `plugins/surfcore/lib/index.js`。
   - 生产重启：重启 QQ 桥接进程（`npm start`）。

## 修法

1. **`src/task-ledger.js`**：创建轻量级持久化任务账本，管理任务标识、步骤、来源、产物（SHA256、文件大小）、外部交付回执状态与取消支持。
2. **`src/task-harness.js`**：
   - `checkAdmission`：硬性拒绝群聊与非主人请求（返回 `ADMISSION_GROUP_DENIED`、`ADMISSION_OWNER_REQUIRED`）。
   - `isSystemRestrictedPath`：阻止访问 `/System`, `/usr`, `/bin`, `/sbin`, `/etc`, `/Library`, `/Applications` 等系统路径。
   - `executeResearchStep` & `executeSynthesisStep`：受控抓取并生成报告，原子写入磁盘并校验哈希。
   - `executeFilePlan`：校验计划内所有路径，支持 `create_dir`, `copy`, `move`, `delete`（安全移至 `state/_quarantine/`）。
   - `executeCommandStep`：危险命令拦截（`rm -rf /` 等）、子进程超时保护（SIGTERM + SIGKILL）、8KB 输出有界截断。
   - `executeMacAppStep`：原生 Mac 应用操作（AppleScript, shortcuts, open）。
   - `runAutonomousIdleActivity`：自主日常低风险活动与反思日志透明记入本地账本，不外发广播。
3. **`src/bridge.js`**：
   - 在 `handleIncoming` 命令处理前置拦截 `任务：...`、`调研：...`、`研究：...`、`任务状态`、`取消任务` 指令，调用 `taskHarness` 独立准入判定。
   - 回调交付通过 `lastSendSucceeded` 校验真实 QQ 交付状态，遇到异常标为 `delivery_unknown`。
4. **`src/core/memory-v2-store.js`**：
   - `searchMemory`：词法分数并列时按 `occurredAt/recordedAt/observedAt/validFrom` 倒序（最新优先）。
   - `prepareMemoryContext`：长文本有界摘录受 `budget.allowExcerpt` 严格门禁；格式化 `validFrom..validTo` 与时间标签。

## 验证

1. **自动化全量测试**：
   - `npm run test:audit`：191/191 全部通过。
   - `npm run test:regressions`：17/17 全部通过。
   - `npm run test:memory-v2`：47/47 全部通过。
   - `node scripts/test-phase-a-verification.mjs`：全部通过。
   - `node scripts/test-phase-bc-verification.mjs`：全部通过（覆盖 Memory V2 预设安全、准入拦截、端到端调研流水线、文件哈希、回执记录、未知状态处理、指令拦截）。
   - `node scripts/test-phase-de-verification.mjs`：全部通过（覆盖文件计划路径校验、危险命令拦截、有界超时、超长输出截断、Mac AppleScript 原生调用、自主生活日常活动账本）。

## 遗留 / 后续

- B站通道后续接入复用：B站私信/评论可直接复用 `taskHarness` 准入与执行能力。
