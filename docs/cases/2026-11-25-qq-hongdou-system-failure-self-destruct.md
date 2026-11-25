# 2026-11-25 红豆又不说话了：系统提示误走旧发送包装触发自毁循环 + 退役黑话每 10 条群消息点火

## 现象

- 用户原话：查看当前项目情况，为什么红豆又不说话了，原因是什么？找到根本原因并进行修复。
- 实测日志（`/Users/shizihan/Daily/Github/surfcore-local-task/state/bridge.log` 与 `qq-activity.log`）：
  - `private:2125387192`：11-24 16:48 正常回复后，18:07 SnowLuma 断线入队 `SNOWLUMA_OFFLINE`；18:18 与 11-25 09:48 重连补发时连报 2 次 `MEMORY_PRESET_UNSAFE`；14:16、15:01 主动唤醒均报 `MEMORY_SOURCE_PENDING` 并触发连续发送失败暂停 30 分钟。
  - `group:1135502130`：11-25 12:48 仍正常回复；12:48–12:52 收到 4 条群消息（seq 37–40），第 10 条凑齐黑话窗口触发 `MEMORY_DERIVATION_UNAVAILABLE`，紧接着连报 2 次 `MEMORY_PRESET_UNSAFE`；16:35 主动唤醒报 `MEMORY_SOURCE_PENDING`、`sendFailureStreak=4`、`wakeSuspendedUntil=17:05:15`。
  - 期间 QQ 侧既无红豆回复，也无 `【系统提示】`。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS；DSH 0.2.1-rc.5（`http://127.0.0.1:52818`） |
| Live 运行工作树 | `/Users/shizihan/Daily/Github/surfcore-local-task`（`feat/local-task-t01t08`，`~/.dsh/plugins/surfcore` 软链指向此处） |
| 主工作树 | `/Users/shizihan/Daily/Github/surfcore-mac`（`feat/v1-retirement`） |
| 发送通道 | Docker `surfcore-qq-local`（OneBot HTTP `:37600` / WS `:37601`，登录账号正常在线） |

## 根因

1. **主因（自毁循环）**：11-24 新增的 `flushSystemFailures(key)` 直接调用 `sendToQQ(key, formatSystemFailureNotice(issue))`，没有带 `managementSendTickets` 管理票据。`bot.sendPrivateMessage/sendGroupMessage` 包装器拦截所有无票据调用并进入 `beginMemoryV2Send(key)` → `requireMemoryV2SessionSafety(key, state.sessions[key])`。V2 Native 回复不建 `state.sessions[key]`，因此必败 `MEMORY_PRESET_UNSAFE`；而 `requireMemoryV2SessionSafety` 失败分支会：
   - 再次调用 `memoryV2Failure(key, MEMORY_PRESET_UNSAFE)`（形成二次发送失败、快速累加 `sendFailureStreak` 触发 30 分钟自动唤醒暂停）；
   - 调用 `await qqMemory.retire(key)`（默认 `preserveSources: false`），**把内存中该会话的 `latest` 和 `history` 全部清空**。
   此后该会话下一次唤醒在 `prepareReply()` 读到空 `latest` → 必撞 `MEMORY_SOURCE_PENDING` → 再次尝试发系统提示 → 再次撞 `MEMORY_PRESET_UNSAFE` 与 30 分钟暂停，且系统提示因发送失败从未 `ack()`，留在队列里逢重连反复复发。
2. **直接导火索**：V1 退役后 `runSlangExtraction(key)` 无条件返回 `memoryV2Failure(key, MEMORY_DERIVATION_UNAVAILABLE)`，但 `feedSlangWindow` → `maybeQueueSlangExtraction` 仍在普通群聊中每 10 条消息（5 分钟冷却）自动触发它；12:52:32 凑满 10 条群消息时点爆了上述自毁链。即便修好系统提示通道，继续自动触发也会每 10 条消息往群里刷 `【系统提示】MEMORY_DERIVATION_UNAVAILABLE`。
3. **测试漏网原因**：11-24 的 `test-memory-v2-qq-system-failure.mjs` 只测了纯队列 helper，未跑真实 `bridgeHarness` + `everConnected: true`；而其余桥接测试里 `everConnected` 默认 `false`，`flushSystemFailures` 提前 return 未触及 `sendToQQ`。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 群消息 / 断线事件 → `src/bridge.js` 的 `feedSlangWindow`/`notifySendChannelDown`/`deliverPromptNow` → `memoryV2Failure` → `queueSystemFailure` → `flushSystemFailures` → 原先走 `sendToQQ` → `bot[method]` 包装器 → `beginMemoryV2Send` → `requireMemoryV2SessionSafety` → `qqMemory.retire(key)` 清空 `src/core/memory-v2-qq.js` 的 `latest`/`history`。读 `flushSystemFailures` 的只有 `queueSystemFailure` 和 `replaySystemFailures`；调用 `maybeQueueSlangExtraction` 的只有 `feedSlangWindow` 和 `checkDsh`。
- **机制**：契约上 `beginMemoryV2Send` / `requireMemoryV2SessionSafety` 是给旧 DSH 模型会话出站做受限工具面证明的；确定性系统提示属于桥接管理消息，应走已有 `sendOwnerManagementReply`（带一次性 `managementSendTickets`、仍做白名单/模式/角色校验与 ACK 核对），绝不进入旧会话安全检查或触发 `qqMemory.retire`。同时已退役的旧黑话提炼不得在正常群聊中自动排程。
- **爆炸半径**：桥接 1 进程 × 所有允许的 QQ 会话 × 静默失败 3（发不出回复也发不出系统提示）；不碰用户数据/密钥/付费模型，不放宽任何 V2 授权或受限工具面约束。
- **取舍**：
  - 路线 A（选用）：`flushSystemFailures` 复用现有 `sendOwnerManagementReply({ ..., phase: 'management', system: true, validate })` + `Map` 串行防并发重发；`maybeQueueSlangExtraction` 在 V2 下不自动排程（保留 `runSlangExtraction` 显式调用返回 `MEMORY_DERIVATION_UNAVAILABLE` + `hint`）。收益：改动最小、复用既有管理通道与 ACK 校验、不削弱 `qqMemory.retire` 安全边界；回滚容易。
  - 路线 B（否决）：把 `qqMemory.retire` 默认改成 `preserveSources: true` 或放宽 `beginMemoryV2Send`。成本略低但会削弱旧会话安全失败的清理语义，且系统提示仍会报 `MEMORY_PRESET_UNSAFE` 发不出去。
- **生效与重启**：`src/bridge.js` 由 QQ 桥接进程加载；仅需通过 supervisor 重启 QQ 桥接，DSH 主进程和 NapCat 容器无需重启。
- **验证**：见下方测试与真实重启验收结果。
- **回滚与残余**：撤销 `src/bridge.js` 与测试文件改动并重启桥接即可；不改任何持久数据。残余：其它仍在 `src/bridge.js` 中直接调 `sendToQQ` 的旧斜杠命令/旧交互提示若在 V2 Native 模式下被触发，同样会受无 `state.sessions[key]` 影响，本轮未扩大范围。

## 修法（升级为全局最优解）

- **出站通道彻底分层（`src/bridge.js`）**：新增 `sendBridgeSystemNotice(key, message)` 统一封装 `sendOwnerManagementReply({ conversationKey: key, text: message, phase: 'management', system: true, validate: () => isSessionAllowedInCurrentMode(key) })`；除 `flushSystemFailures`（`Map` 按 key 串行防并发重发）外，将全部 25+ 处桥接确定性系统/管理/交互控制提示（早安告警、过期编号提示、`/reset`/`/status`/`/role`/`/silent`/`/active` 斜杠命令、审批与提问协议回执及超时取消、`turnGuard` 止损、敏感拦截与 agent 异常提示）统一收口到 `sendBridgeSystemNotice`；`sendToQQ` 只保留给旧 AI 正文输出。
- **磁盘真源按需自愈 + 退役不擦历史事实（`src/core/memory-v2-qq.js` + `src/bridge.js`）**：`hydrate({ key })` 支持按单 key 严格只读水合；`prepareReply({ key })` 在内存 `latest.get(key)` 为空且无未决 `failures` 时自动按单 key 从当前角色/纪元磁盘 `qq-producer` 自愈一次（仍做全量完整性与 Host 授权复核，真正无源会话仍 fail-closed 返回 `MEMORY_SOURCE_PENDING`）；`src/bridge.js` 所有会话/发送异常的 `qqMemory.retire(key, { preserveSources: true })` 只退役在途句柄，不再擦除已提交源缓存。
- **熔断器只熔断真实通道故障（`src/bridge.js`）**：`noteSendFailure` 按结构化错误码排除 `/^(MEMORY|CHARACTER|QQ_MODE|OWNER_REPLY)_/`，内部策略拒绝不再计入 `sendFailureStreak` 或触发 30 分钟 `wakeSuspendedUntil`。
- **停用 V2 下已退役黑话自动排程（`src/bridge.js`）**：`maybeQueueSlangExtraction` 在 V2 下直接返回；显式调用 `runSlangExtraction` 仍返回结构化 `MEMORY_DERIVATION_UNAVAILABLE` + `hint`。
- **回归测试（`scripts/test-memory-v2-qq.mjs`、`scripts/test-memory-v2-qq-system-failure.mjs`、`scripts/audit-bridge-harness.mjs`）**：覆盖重启后 `prepareReply` 按需自愈与空会话 fail-closed、系统提示经管理通道成功/失败留队/重连补发、15 条群聊消息不自动触发退役黑话、`/status` 斜杠命令不撞 `MEMORY_PRESET_UNSAFE`、以及 `MEMORY_*` 错误不计通道连败与 `retire` 保留已提交源。

## 验证

- **自动化（live `surfcore-local-task`）**：
  - `npm run test:memory-v2` **53/53** 通过
  - `npm run test:audit` **209/209** 通过
  - `npm run test:regressions` 全部通过
  - `npm run lint:failures` 退出 0
- **自动化（主工作树 `surfcore-mac`）**：
  - `npm run test:memory-v2` **50/50** 通过
  - `npm run test:audit` **195/195** 通过
  - `npm run test:regressions` 全部通过
  - `npm run lint:failures` 退出 0
- **真机重启验收（2026-11-25 17:04 & 17:24）**：
  - 17:04:21 首轮重启后 `group:1135502130` 补唤醒并于 `17:04:40` 取得真实 Native QQ 发送回执；
  - 17:24 全局最优版二次重启后继续确认 `dshReady: true`、`snowluma.connected/accountOnline/good: true`、`memoryV2.failures: []`。

## 交接块（可直接复制给发布会话）

```text
【合并请求】
分支：live `/Users/shizihan/Daily/Github/surfcore-local-task`（feat/local-task-t01t08）与主树 `/Users/shizihan/Daily/Github/surfcore-mac`（feat/v1-retirement）未提交候选
范围：修复系统失败提示误走旧发送包装触发 MEMORY_PRESET_UNSAFE + 清空 qqMemory 自毁循环，以及退役黑话每 10 条群消息自动触发阻断
改到的文件：src/bridge.js、scripts/audit-bridge-harness.mjs、scripts/test-memory-v2-qq-system-failure.mjs、docs/cases/2026-11-25-qq-hongdou-system-failure-self-destruct.md、docs/PITFALLS.md、docs/cases/README.md、docs/RELEASE-QUEUE.md
测试：live test:audit 209/209 + test:regressions + lint:failures 全绿；主树 test:audit 195/195 + test:regressions + lint:failures 全绿；新增桥接真链路失败提示/重连补发/退役黑话回归通过
失败路径：系统提示经 sendOwnerManagementReply(system:true) 发送，失败留队重连重放、不清空 qqMemory、不触发 MEMORY_PRESET_UNSAFE；显式 runSlangExtraction 保留 code/hint
实机验证：17:04:21 重启 live 桥接（pid 19962），水合 91 条已提交源，17:04:40 group:1135502130 取得真实 Native QQ 发送回执，memoryV2.failures=[]
风险/未验证：未改动 V2 Native 下其他直调 sendToQQ 的旧斜杠命令；发布前需从合并 HEAD 重生成安装清单
回滚：撤销 src/bridge.js 改动并重启 QQ 桥接，无数据变更
建议版本：patch（与 2026-11-24 候选合并交付，版本号由发布会话定）
```
