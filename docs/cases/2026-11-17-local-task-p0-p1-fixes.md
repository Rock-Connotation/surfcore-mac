# 本机任务 P0/P1 审核问题修复（2026-11-17）

## 现象

对照 DSH `0.2.2-rc.3` 实装包（`app.asar`）与审核工单，原 `feat/local-task-t01t08`（`dd03233`）存在三项 P0 与九项 P1 缺陷：

1. **P0-1**：`storageDomain` 写入未 `await`，同步返回 `{ ok: true }` 且无法捕获异步 rejection 与 `unknown-state`。
2. **P0-2**：`local-task-gate` 卸载只让下一次 `dispatch` 失败，已运行中的会话失去守卫继续执行且无法确认停止时未标 `needs_reconciliation`。
3. **P0-3**：仅新建只靠 pre-execute `existsSync` 检查；模型可先 `read` 再从 `fs-observation-policy` 拿 `replaceIfVersion`，或遭遇并发创建竞争覆写。
4. **P1**：`queued` 任务被 `local-task-api` 直接调用 `runner.dispatch` 并发执行；无 FIFO 晋升；持久化失败或取消失败仍释放 `activeTaskId`；DSH 真实 `turn/end.data.reason` 是对象 `{ kind }` 且未知 reason 默认 `succeeded`；Delivery 未先持久化 `sending`；缺少 `redeliver` 接口；`assistant/message` 与 `tool/call` 未计入额度导致真实 DSH 下额度可绕过；`local-task` preset 重复挂载宿主服务导致 `leakedServices` 装配风险。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DeepSeek Harness `0.2.2-rc.3`（`app.asar` 实装核对） |
| 工作树 / 分支 | `/Users/shizihan/Daily/Github/surfcore-local-task` / `feat/local-task-t01t08` |
| 基线提交 | `b559af5` → `dd03233` |

## 根因

1. **P0-1**：`dsh-storage-domain` 的 `KvTableImpl.put()` 是异步入队写入（`await unit.putRecord()` 后才提交内存并 emit），遇到 `StorageError('unknown-state')` 会隔离读写；原 `persist()` 同步调用未 `await`，且无写串行互斥锁与隔离核对流程。
2. **P0-2**：`dsh-tools` 的 `tools.guard` 随 preset fiber 卸载而摘除，但 `runner` 未订阅卸载事件、`host` 未给本机任务会话加宿主兜底守卫。
3. **P0-3**：`dsh-tool-fs` 通过 `ctx.waterfall('fs/write-intent', ...)` 决定写入守卫传给 `dsh-fs-local`（`createIfAbsent` 硬链接原子发布 vs `replaceIfVersion`/无条件覆盖）。原门禁未抢占 `fs/write-intent`。
4. **P1-6 / P1-9（实装核对实证）**：`dsh-agent-loop` 正常回合结束写 `{ kind: 'completed' }` 等对象，成功模型请求写 `assistant/message`（只有失败/空流才写 `assistant/attempt`），工具调用在启动和提交分别写 `tool/call` 与 `tool/result`，且 `dsh-agent-preset-registry` 会拒绝 preset 内未隔离的宿主服务 `sandbox-policy`/`fs-sandbox`。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 主人私聊（`src/bridge.js` → `src/core/local-task-client.js`）→ Host HTTP（`plugins/surfcore/lib/local-task-api.mjs`）→ 权威存储（`local-task-service.mjs`，`storageDomain`）→ 会话编排（`local-task-runner.mjs`）→ 宿主兜底与投递（`local-task-host.mjs`）+ 门禁（`local-task-gate.mjs` / `local-task.patch.yml`）→ 设置页（`plugins/surfcore/lib/index.js` + `client.js`）。
- **机制**：
  - 所有写操作经 `writeChain` 互斥队列并 `await table.put()`，先落盘后更新内存与 `activeTaskId`，`unknown-state` 进入隔离并拒绝对外派发，支持关闭重开核对。
  - `local-task-gate` 通过 `onGateLivenessChange` 同步通知 `runner` 中止在途会话（无法确认停止标 `needs_reconciliation` 并锁席位），同时 `local-task-host` 挂载仅作用于本机任务会话的宿主兜底 `tools.guard`（普通 DSH 会话直接返回 `undefined`）。
  - `local-task-gate` 与 `local-task-host` 以 `{ prepend: true }` 拦截本机任务会话的 `fs/write-intent` 并返回 `{ kind: 'createIfAbsent' }`（不调用 `next()`），由 `dsh-fs-local` 硬链接原子拒绝竞争文件与已读覆盖。
  - `submit` 仅在无活跃任务时派发，`queued` 任务禁止直调 `dispatch()`，前任务收敛后由 `pumpQueue()` 按 FIFO 晋升；取消先写 `stopRequest`，`sessionController.cancel` 失败则标 `needs_reconciliation` 且保留 `activeTaskId` 防止新任务越过旧任务；`turn/end` 对未知 reason 一律保守标 `needs_reconciliation`；Delivery 先持久 `sending`，发送后再写 `delivered`/`uncertain`，并提供 `redeliver` 接口仅重发旧结果；额度统计覆盖 `assistant/message`、`assistant/attempt`、`session/title-llm-request` 与按 `callId` 去重的 `tool/call`/`tool/result`。
- **爆炸半径**：仅作用于本机任务链（`local-task` preset 与 `surfcore_local_task` 域）；普通 QQ 聊天、Memory V2、普通 DSH 会话、三条旧文件命令和旧 `tasks.json` 均保持隔离不受影响。
- **取舍**：在宿主与 preset 两层同时布防而非仅靠 `agentPresets` 重写 DSH 引擎，改动边界清晰、易回滚；移除 preset 中重复的 `sandbox-policy`/`fs-sandbox` 行以复用宿主层（`dsh-base`），避免 `leakedServices` 拒绝装配。
- **生效与重启**：需在发布/部署后重启 DSH Host（加载新插件与 `local-task.patch.yml`）及重启 QQ 桥接（加载 `local-task-client.js` / `local-task-intent.js` / `bridge.js`）。
- **回滚与残余**：`git revert` 本批提交即可完整回退；外网实机 NapCat / 真实手机 QQ 收发因本机无在线 NapCat 登录凭据暂留待真机环境验收。

## 残余与实装宿主阻塞收口（同日二轮修复与隔离全宿主验证）

在完成第一批提交后，对三条残余风险与前两条实装宿主阻断项补齐代码与端到端隔离实测，并新暴露并根治三处仅在真实 `dsh-desktop-host` + `src/bridge.js` 联调下才显现的实装契约缺陷：

1. **残余 1（宿主全量 LLM 流入口封堵）**：核对 `app.asar` `dsh-llm/lib/index.js` 确认宿主所有模型调用（含 `dsh-agent-loop`、`dsh-session-title-llm`、`dsh-compaction-basic` 及未来辅助插件）均走 `ctx.waterfall(this, 'llm/stream', options, ...)`；在 `local-task-host.mjs` 以 `{ prepend: true }` 挂载 `llm/stream`，在 `local-task-runner.mjs` 新增 `admitLlmStream(options)`，请求发往上游前扣减并与后续 `assistant/message`/`assistant/attempt`/`session/title-llm-request` 去重，超第 30 次当场阻断。
2. **残余 2（Playwright 真实浏览器交互）**：新增 `plugins/surfcore/scripts/test-local-task-ui.mjs` 并接入 `plugins/surfcore/package.json`，用真实 Chrome + 真实 `handleLocalTasks` + 真实 `client.js` + 本地回环模拟桥接控制台验证设置页「本机任务」：列表只读无第二个发起框、「原生会话」「补发结果（先 503/uncertain 可见 toast，恢复后已回传且不重跑会话）」「停止」「刷新」「重开并核对」。
3. **隔离真实 `dsh-desktop-host` + `src/bridge.js` 发现并修复的三处实装缺陷**（见 `docs/PITFALLS.md` `#247`）：
   - `local-task-gate.mjs` 补齐 `tools.restrict({ deny: [...] })` 动态隐藏全局/MCP 工具并监听 `tools/change`（避免 `allow: []` 把 `presetScope` 上的 `read`/`write` 一并掩盖），`verifySurface` 补齐 `TASK_TOOL_SURFACE_INCOMPLETE` 校验；
   - `local-task-runner.mjs` 修正 `sessionController.prompt(request, signal)` 第二参数为 `AbortSignal`（真实宿主曾因传入普通对象抛出 `signal.throwIfAborted is not a function`）；
   - `src/bridge.js` `/api/notify/owner` 经 `sendChain` 与一次性 `managementSendTickets` 放行控制台直发（此前无 QQ 聊天会话时会撞 `Memory V2` 包装返回 `502`）。

## 修法

- `plugins/surfcore/lib/local-task-service.mjs`：全写方法改 `async` + `writeChain` 互斥 + 失败回滚内存/席位 + `unknown-state` 隔离与 `recoverWithDomain` + FIFO `promoteNext` + `requestStop`/`confirmCancelled`/`markNeedsReconciliation`/`updateDelivery`。
- `plugins/surfcore/lib/local-task-gate.mjs`：`onGateLivenessChange` 同步卸载事件、`fs/write-intent` `{ prepend: true }` 返回 `{ kind: 'createIfAbsent' }`、效果卸载清理注册。
- `dsh/agent-presets/local-task/agent.cordis.yml` & `plugins/surfcore/presets/local-task.patch.yml`：移除重复挂载的宿主服务行，由 `scripts/build-agent-preset-patches.mjs` 重新生成。
- `plugins/surfcore/lib/local-task-runner.mjs`：监听 gate 卸载立即中止会话、FIFO `pumpQueue()`、`queued` 禁直派、取消失败锁席位与 `needs_reconciliation`、保守 `classifyTurnEndReason`、真实 DSH 模型与工具额度全事件覆盖。
- `plugins/surfcore/lib/local-task-host.mjs`：宿主兜底 `tools.guard` 与 `fs/write-intent`（零影响普通会话）、卸载停机、`sending -> delivered/uncertain` 投递与 `redeliver` / `recoverQuarantine`。
- `plugins/surfcore/lib/local-task-api.mjs`、`src/core/local-task-client.js`、`src/core/local-task-intent.js`、`src/bridge.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`、`scripts/audit-bridge-harness.mjs`：接入 `queued` 禁直派、`redeliver` 与隔离恢复接口及界面操作。

## 验证

- 新增真实异步与攻击测试：`plugins/surfcore/scripts/test-local-task-dsh-native.mjs`（直接加载本机 `app.asar` 真实 `@deepseek-ai/dsh-storage-domain`、`dsh-fs-local`、`dsh-fs-observation-policy`、`dsh-tool-fs`、`dsh-tools`、`cordis`）。
- 新增真实浏览器 UI 测试：`plugins/surfcore/scripts/test-local-task-ui.mjs`（Playwright Chromium + 真实 `/dsh-surfcore/api/local-tasks` + 真实 `client.js`）。
- 新增隔离真实 DSH Host + 真实 Bridge 全链路测试：`scripts/test-local-task-isolated-host.mjs`（`ELECTRON_RUN_AS_NODE=1` 启动真实 `dsh-desktop-host` 与 `setup-dsh.mjs desktop` 配置，非回环外网硬阻断，验证 preset 零 `leakedServices`、真实 `ToolExecutionPipeline` 围栏与 `createIfAbsent`、`llm/stream` 31 次阻断、FIFO 排队/取消/补发、`session.v4.jsonl.zstd` 落盘、`bridge.js` `/api/notify/owner`、普通 `qq-chat-v2` 与聊天路径零回归、优雅停机）。
- 本轮已验证项与真实 NapCat/QQ 实机未验证边界见 `docs/HANDOFF.md` 与最终交付报告。

## 三轮真机验收与全局根因修复（2026-11-17 实机联调）

### 1. `desktop` profile「修复 DSH 注册」回滚 + `local-task` 第三方 `agent-scoped` 工具越界

- **根因**：
  1. `scripts/setup-dsh.mjs` 对 Electron 托管的 `desktop` profile 仍调用 `dsh plugin --profile desktop install`，DSH CLI 按设计拒绝（`managed exclusively by the Electron application`）触发整体回滚；
  2. `dsh-tools` 的 `tools.restrict()` 只过滤继承层全局/祖先工具，直接注入 `agent.ctx`（`own.tools`）的第三方插件工具（如 `@cerbur/clutch-dsh-worktree` 的 `clutch_*`）天然豁免 `restrict()`，导致 `verifySurface()` 判为 `TASK_TOOL_SURFACE_UNSAFE`。
- **完整逻辑与修法**：
  - `scripts/setup-dsh.mjs`：识别 `managed exclusively by the Electron application` 为桌面端托管跳过，保留已写入的 MCP 与 `surfcore` 链接，仅在真实错误时回滚；
  - `plugins/surfcore/lib/local-task-gate.mjs`：通过 `tools.layers.peek(agent/agent.ctx)` 在挂载、`agent/created` 与 `tools/change` 时清除属于 `local-task` preset 的子会话 `ToolLayer` 上任何非 `TASK_ALLOWED_TOOLS` 的越界工具（普通 DSH 会话与 QQ 会话零触碰）。
- **验证**：真机私聊 `本机任务：在工作区创建 test-live.txt 并写入 hello world` 通过（`task-mwkkfrxp-0e9xgr`，状态 `已完成`、回传 `已回传`、工作区真实写入 `test-live.txt`）。

### 2. L2 弹窗重复弹出、QQ 页误报「回复受阻」、一键启动 3 项误报与 UI 失真

- **根因**：
  1. `gateEvents.record` 仅对 `MEMORY_POLICY_DENIED` 去重，历史瞬间写入的多条同源 `MEMORY_WORKER_UNAVAILABLE` / `MEMORY_EVIDENCE_DENIED` 在点「确认」时只确认单个 `id`，未按 `dedupeKey` 批量确认，且 `MEMORY_WORKER_UNAVAILABLE` 在 Memory V2 恢复 `ready` 后未像 `snowluma:send-channel-down` 那样自动确认；
  2. `src/bridge.js` `startPurposeLoop()` 仍在 V2 边界内每 60s 执行 `purposeTick()` 写入 `memoryV2Failures['purpose'] = MEMORY_SOURCE_UNREFERENCED`，`plugins/surfcore/lib/bridge.js` `mapStatusPayload()` 未排除 `'purpose'` 键，导致 QQ 聊天正常却常驻红标「QQ 回复未完成 · 回复受阻」；
  3. 一键启动中 `launchSnowLuma()` / `diagnoseSnowLuma()` 硬编码端口 `3000/3001` 且在 `allowLaunch` 之前未先检查已在线的 Docker NapCat/OneBot；`startComponent('bili')` / `start-all` / `start-bili` 未识别已登录的 `controlled-only` 模式并误报需扫码登录；`client.js` 语音项未显示「`· 未安装`」且默认选 `voice-local`。
- **修法**：
  - `plugins/surfcore/lib/index.js` + `plugins/surfcore/lib/client.js`：`memoryV2Ready` 及未确认 `MEMORY_WORKER_UNAVAILABLE` 查询时恢复即自动确认；`POST /gate-events` 支持 `dedupeKey` 调用 `ackByDedupe()` 一次确认同类重复告警；抽出 `snowLumaOneBotPorts()` / `oneBotPortOpen()` 与 `biliLaunchOutcome()` 统一判断外部 OneBot 在线与 B站受控单轮模式，完善语音未安装提示；
  - `src/bridge.js` + `plugins/surfcore/lib/bridge.js`：停止后台 60s `purposeTick()` 噪音轮询（保留显式调用的结构化拒绝），`mapStatusPayload()` 计算 QQ `replyReady`/`replyFailure` 时过滤 `key === 'purpose'`。
- **验证**：`npm run test:regressions`（13 项全部通过）、`npm --prefix plugins/surfcore test`（含全量普通脚本、8 项 `local-task`、Playwright Chrome UI 与 37 项 Memory V2）、`npm run test:audit`（208/208 通过）、`npm run lint:failures`（无新增债务）。

### 3. 一键启动适配火山云端直连语音（无需离线语音包）与历史 L2 清零

- **根因**：用户已在 `config.json` 配置 `cloudProvider: 'volc'` + `route: 'cloud'` + `tts.enabled: true` 并保存 `volcKeyId`（`state/volc-voice-keys` 原落在包安装目录下），直连火山 HTTPS 接口无需运行本地/voxd 进程；但 `launchStatus()` / `startComponent('voice')` 与 `client.js` 只检查 `state/voice-packs` 目录，导致明明可用火山云端 TTS 却显示「未安装」并报 `VOICE_PACK_NOT_INSTALLED`。
- **修法**：
  - `plugins/surfcore/lib/index.js`：`voicePacksSnapshot()` / `launchStatus()` 联合检查 `/volc-config`（`volcConfigured` / `volcCloudActive`），`startComponent('voice')` 在 `voice-cloud` + `volcConfigured` 时走 `/volc-config` 激活核验；`stopComponent('voice')` 明确告知按需云端直连无需停后台进程。
  - `plugins/surfcore/lib/client.js`：前端自动识别 `volcConfigured` 默认选 `voice-cloud（火山云端直连）` 并显示 `运行中（火山云端）`。
  - 同步原 `volc-voice-keys` / 预算文件至工作树 `state/`（保持 `0700`/`0600` 权限），并通过 `/dsh-surfcore/api/gate-events` 按 `dedupeKey` 确认清理 11-15/16 历史 L2/L1 积压事件。
