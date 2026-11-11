# Case 2026-11-11 Phase A 修复：主动目的受众收敛、进程有界终态与交互取消准确回执

> 对应审查基线：`748afe6256a4619e83936c1bb225a29320a3a555`
> 对应实施阶段：阶段 A（A1 记忆受众与归属、A2 取消状态与进程终态、A3 V2能力声明与适配诊断）

## 现象

- **A1（记忆材料受众与归属丢失）**：只允许 `douyin/local` 或其他私聊会话的记忆，在普通 QQ 记忆卡中被正确隐藏，但当 `purpose-engine` 从全量 memory-card 提取素材时，绕过了受众与上下文检查，导致限制性记忆进入了发往 QQ 主人私聊的模型输入；同时目的引擎将记忆类素材一律将 `subject` 认定为 `self`，导致他人的愿望（例如“张三想要辞职”）被模型理解成鱼自己的愿望。
- **A2（取消虚报与进程终止悬挂）**：在审批/提问超时时，桥接在发出取消请求后立即向 QQ 报告“已取消”，未核验 DSH 回执；如果 DSH 明确拒绝取消或请求断线超时，用户得到错误反馈。此外，在 ASR/进程执行中，若子进程忽略 `SIGTERM` 与 `SIGKILL` 且未发射 `'close'`，`runProcess` 永久 `await closePromise`，连带导致 `perception.cancel()` 与 `dispose()` 挂起。
- **A3（V2 状态与环境诊断失配）**：V2 在生产总装中未完整注入退休与生命周期组件，旧诊断脚本依赖已删除的 `{{cwd}}` 变量与历史固定端口/Profile 路径。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS 26 / Apple Silicon / DSH 0.2.2-rc.1 (Desktop) |
| SurfCore 版本 | 0.8.8 (`dev` / `refactor` 工作树) |
| 安装方式 | 源码工作树 + 本地 Profile 链接 |
| Node 版本 | v26.5.1 |

## 根因

1. **A1 (`src/bridge.js`, `src/purpose-engine.js`, `src/memory-card.js`)**：
   - `gatherPurposeMaterials` 原先直接从 `memory-card.json` 读取全部 `records` 传入 `collectMaterials`，未经过 `visibleFor` 过滤。
   - `collectMaterials` 抽取出素材时未传递并核对 `targetPlatform` 与 `targetConversationKey`。
   - `purpose-engine` 的 `subjectOf` 无条件将 `kind === 'memory'` 映射为 `subject: 'self'`，丢弃了记录原件的 `attributionSubject` 与 `who`。
2. **A2 (`src/perception/process.js`, `src/perception/service.js`, `src/interaction-lifecycle.js`, `src/bridge.js`)**：
   - `runProcess` 中的 `closePromise` 缺少在 `terminateChild` 后的硬时限竞速。当进程忽略信号不发射 `'close'` 时，等待无界。
   - `cancelPendingEntry` 原本直接发送拒绝请求而不判定 `ok`，亦未区分 `confirmed`、`rejected`、`timeout`、`unknown` 四种状态。
3. **A3 (`scripts/verify-dsh-020-adaptation.mjs`)**：
   - 依赖已淘汰的 `{{cwd}}` 模板变量，且硬编码了 `web` profile 与单一配置路径。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - A1 链路：`memory-card.json` → `bridge.readPurposeMemoryRecords` / `gatherPurposeMaterials` → `filterVisibleRecords` → `purpose.collectMaterials` → `buildPurposePrompt` → DSH 模型投递。
  - A2 链路：DSH 交互事件 → `bridge.armInteractionTimeout` → `cancelPendingInteraction` (`src/interaction-lifecycle.js`) → DSH `api.respond` 确认回执 → QQ 状态通知；本机子进程 → `perception/process.js` `runProcess` → 有界优雅终止/强制退出竞速 → 记录未释放进程表 → 返回结构化终止异常。
- **机制**：
  - 受众守卫：所有记忆材料生成必须以“目标会话上下文”为鉴权约束，继承原件的可见性分类与有效上下文，不得扩大受众。主体归属按原件保留（user → owner, external → member, self → self）。
  - 取消与终态契约：取消操作严格区分“请求中”、“已确认取消”、“取消被拒”、“超时未知”。未确认取消绝不向外部声称“已停止”。进程资源在确认退出前绝不释放给新任务。
- **爆炸半径**：
  - 进程数：1（QQ 桥接主进程 + 本地辅助进程）；读者数：QQ 交互流、ASR 任务调度、目的引擎；无花钱风险、保护隐私数据不越权扩散。
- **取舍**：
  - A1：路线 A（推荐）：在底层统一记忆投影与受众过滤，从源头堵住进入 Prompt 的切口，并透传主体归属。
  - A2：路线 A（推荐）：抽取 `src/interaction-lifecycle.js` 统一回执判定和历史登记；进程采用有界两阶段终态竞速，记录未释放 pid。
- **生效与重启**：
  - 重启 QQ 桥接进程（PID 30591）即可生效。

## 修法

1. **`src/memory-card.js`**：
   - 增强 `visibleFor`：支持数组输入、严格排除 `revoked`/`corrected`/`forgotten` 状态的记录，严格隔离跨会话私密记录。
   - 导出 `filterVisibleRecords` 与 `visibleFor`。
2. **`src/purpose-engine.js`**：
   - `collectMaterials` 增加 `targetPlatform` 与 `targetConversationKey` 过滤；
   - 继承 `attributionSubject`（`self`, `user`, `external`）、`attributionCertainty` 与 `who`；
   - `subjectOf(material)` 按照 `attributionSubject` 分流，禁止他人愿望转变为自身意图；
   - `formatMaterialLine` 增加 `[记忆·他人]`、`[记忆·主人]`、`[记忆·你]` 显式标签。
3. **`src/perception/process.js`**：
   - 引入 `getUnreleasedProcesses()` 与 `recordUnreleasedProcess`；
   - 在 `runProcess` 中限制终止等待时间，终态未知时抛出带 `code: 'PROCESS_TERMINATION_UNKNOWN'` 结构化错误并登记进程。
4. **`src/interaction-lifecycle.js`**：
   - 新建独立模块，提供 `assertInteractionReceipt`、`createHistoricalInteractionRegistry` 与 `cancelPendingInteraction`，明确判定 DSH 交互状态。
5. **`src/bridge.js`**：
   - 接入 `src/interaction-lifecycle.js`；
   - 超时与覆盖取消时判定状态，若非 confirmed 向用户报告真实状态与下一步提示。
6. **`scripts/test-phase-a-verification.mjs`**：
   - 编写包含五项受众反例、顽固进程终止及交互取消状态的端到端验证套件。

## 验证

- **自动化**：
  - `node scripts/test-phase-a-verification.mjs`：全部通过（A1 五组反例、A2 进程与取消、A3 V2能力声明与路由默认）。
  - `npm run test:regressions`：17/17 项通过。
  - `npm run test:audit`：191/191 项通过。
- **失败路径**：
  - 进程终止失败：返回 `{ ok: false, code: 'PROCESS_TERMINATION_UNKNOWN', hint: '...' }` 并登记未释放 PID。
  - 取消超时/未知：向 QQ 发送 `⏰ 等待回答超时，取消结果未知（未能收到 DSH 确认），已断开本地等待，请在 DSH 检查任务`。
- **未验证到的部分**：
  - 真实 macOS 硬件上被其他应用硬占用的真实僵尸子进程处理（由于当前在离线 fixture 与 Mock 进程中复现）。

## 遗留 / 后续

- 进入阶段 B：完成 Memory V2 生产装配（Native owner/source runtime 接入、声明显式生命周期 inventory、改进本地词法与时间检索保真度）。
