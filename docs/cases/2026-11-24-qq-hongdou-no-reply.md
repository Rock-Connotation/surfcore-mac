# 2026-11-24 红豆不回群消息：重启后内存态来源丢失 + 失败静默

## 现象

- 用户原话：给红豆发消息，红豆没理我。
- 具体目标：`group:1135502130` 在 2026-11-23 10:36 的 seq 29/30 两条群消息；抓到入站，但没有 Native 回复，也没有 QQ 可见的错误提示。
- 复现条件：QQ 桥接在 2026-11-23 03:13:57.173Z、03:53:05.093Z 连续重启后，约 12 秒触发启动补唤醒。
- 影响面：所有依赖“最近一条已提交 QQ 源”的会话在桥接重启后都会命中 `MEMORY_SOURCE_PENDING`；消息本身已持久提交，不丢数据，但用户侧完全静默，无法自助恢复。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS；DSH 0.2.1-rc.5（本地补丁见 PITFALLS #100） |
| SurfCore 版本 | live worktree `0.9.0-dev.2`（`feat/local-task-t01t08`，基线 `51c4d25`） |
| 安装方式 | git worktree；当前主树 `/Users/shizihan/Daily/Github/surfcore-mac` 为 `feat/v1-retirement` `b7316ca` |
| 其它相关版本 | SnowLuma 发送通道；Memory V2 producer `qq-producer` |

## 根因

- `/Users/shizihan/Daily/Github/surfcore-local-task/src/core/memory-v2-qq.js:33` 的 `latest/history` 是纯内存 Map；`/Users/shizihan/.dsh/surfcore/memory-v2/qq-producer` 中的 producer 元数据是磁盘持久态。
- 桥接重启后内存 Map 为空，但 `wakeBacklogConversations('boot')` 由 `/Users/shizihan/Daily/Github/surfcore-local-task/src/bridge.js:4597-4599` 在启动后 12 秒执行；此时 `prepareReply()` 在 `src/core/memory-v2-qq.js:155` 读到空 `latest`，直接返回 `MEMORY_SOURCE_PENDING`。
- `/Users/shizihan/Daily/Github/surfcore-local-task/src/bridge.js:1969-1973` 的 `memoryV2Failure()` 只写 `memoryV2Failures` 和活动日志，从未调用 `sendToQQ()`；Native 宿主 `plugins/surfcore/lib/qq-v2-reply-host.mjs:230-235` 也只把错误报回桥接。因此失败对 QQ 用户不可见。
- 证据：桥接日志 `/Users/shizihan/.dsh/surfcore/bridge-supervisor.log:45-46` 两次重启；`/Users/shizihan/Daily/Github/surfcore-local-task/state/qq-activity.log:221-224` 两次重启后约 12 秒出现 `MEMORY_SOURCE_PENDING`；扫描持久 producer 得到 `private:2125387192|committed=108`、`group:1135502130|committed=91`，无 PENDING 目标。
- 为什么之前没发现：现有单测都在同一进程内 `captureSource()` 后立刻 `prepareReply()`，没有覆盖“进程重启后只靠磁盘恢复”的路径；失败路径断言只查 `code`，没有验证 QQ 用户是否真的收到提示。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ → SnowLuma OneBot → `src/bridge.js` 入站 → `src/core/memory-v2-qq.js` 的 `captureSource()` 写 producer spool + 元数据 → Host 返回 `committed` → 12 秒后 `checkDsh()` 里的 `wakeBacklogConversations('boot')` → `prepareReply()` → Native 回复 → `sendToQQ()`。读 `latest/history` 的只有 `prepareReply/validate/authorizeSend/status`；读 producer 目录的是 `drainPending()` 和新增的 `hydrate()`。
- **机制**：契约是“已提交源不可改写角色/纪元、不可伪造授权”。重启清空内存索引但没有清空已提交源，导致授权材料在磁盘上而入口查表为空。修法不是放宽 `MEMORY_SOURCE_PENDING`（那会绕过 11-11 已修的 scope/授权漏洞），而是让入口在补唤醒前从磁盘**只读恢复当前角色/纪元的已提交记录**，并逐条校验字节游标与 manifest 自洽。残留缺口：启动时 SnowLuma 从未连过（everConnected=false）时，被通道门槛跳过的 boot 补唤醒在首次连接后原逻辑提前 return，永不重试；新增 `backlogWakePending` 让首次连接也重排一次 `wakeBacklogConversations('reconnect')`。
- **爆炸半径**：桥接 1 进程 × QQ 会话 N × 静默失败 3；涉及用户数据与密钥，因此只恢复 `sourceState==='committed'` 且游标等于文件大小的记录，不重放 pending、不跨角色/纪元、不输出 token；发送失败队列按 key+code 去重且脱敏。
- **取舍**：A) 放宽 `MEMORY_SOURCE_PENDING` 到“内存空即允许无源回复”——成本最低但直接打穿授权与来源证据，否决；B) 在每入站时同步恢复——能修但耦合入站热路径、重复扫描，否决；C) 启动时一次性 `hydrate()` + 统一失败可见化/重连重放——在本进程边界内根治，且不碰 SnowLuma 运行时，选用。备选 D) 改 Host/SnowLuma 重放协议，收益更高但越出授权范围，未做。
- **生效与重启**：谁读——`src/bridge.js` 在 `checkDsh()` 中调用；必须重启 QQ 桥接进程（`node src/bridge.js` / 控制台重启），DSH 主进程无需重启；`hydrate()` 在 `wakeBacklogConversations('boot')` 之前 `await`，确保补唤醒看到恢复后的来源。

## 修法

- `src/core/memory-v2-qq.js`：新增 `hydrate()`，只扫描 `memory-v2/qq-producer/<role>/<epoch>`，接受 `version===1`、角色/纪元匹配、文件名与 `segmentId` 一致、key 合法、`sourceState==='committed'`、`registrationId` 非空、`refs` 的 `revision===1 && type==='event'`、`sourceStamp.conversationKey`、`sourceFacts.objectId`、游标等于文件大小、方向为 inbound 或已 delivered 的记录；按文件 mtime 排序写回 `history`（最多 7 条）和 `latest`；返回 `{ok, restored, skipped, malformed}` 并在对象 API 导出 `hydrate`。
- `src/bridge.js`：在 `checkDsh()` 的 `startPurposeLoop()` 之后、`if (currentMode === 'reserved2')` 之前 `await qqMemory.hydrate?.()`；新增 `createSystemFailureQueue/formatSystemFailureNotice`，`memoryV2Failure()` 与 SnowLuma 断线提示统一走 `queueSystemFailure()`，发送通道可用时立即发送、失败时留队并在 `notifySendChannelUp()` 重连后 `replaySystemFailures()`；`sendWakePromptV2()` 通道门槛在 `reason==='backlog'` 时置 `snowlumaHealth.backlogWakePending=true`，`notifySendChannelUp()` 无论是否曾弹过断线提示都先重放失败队列，再在标记存在时重排 `wakeBacklogConversations('reconnect')`（修掉“首次连接永不补唤醒”的残留缺口）。
- 新增 `src/core/memory-v2-qq-system-failure.mjs`：结构化 `code/error/hint` 规范化、控制字符/空白清理、180/240 字上限、密钥脱敏、`key|code` 10 分钟去重；提示明确标注“这不是角色回复”。
- 回滚：撤销上述六个代码文件改动并重启桥接即可；`hydrate()` 只读磁盘、不改 producer 元数据，无数据回滚需求。

## 验证

- 自动化（live worktree，2026-11-24）：`node scripts/test-memory-v2-qq-system-failure.mjs` PASS；`node scripts/test-memory-v2-snowluma-backlog-retry.mjs` PASS（通道断开时标记、首次连接后重排补唤醒）；`node scripts/test-memory-v2-qq.mjs` PASS（含新增重启 hydrate 断言：未 hydrate 时 `MEMORY_SOURCE_PENDING`，hydrate 恢复 2 条后 `prepareReply/validate` 均 ok）；`npm run test:memory-v2` 53/53；`npm run test:audit` 209/209；`npm run test:regressions` 全部通过；`npm run lint:failures` 退出 0；`node --check src/bridge.js` 通过。
- 自动化（当前树 `/Users/shizihan/Daily/Github/surfcore-mac`，2026-11-24 回写后）：`node --check src/bridge.js`、helper、reconnect 测试、`node scripts/test-memory-v2-qq.mjs` PASS；`npm run test:memory-v2` 50/50；`npm run test:audit` 195/195；`npm run lint:failures` 退出 0。之前记录的 SQLite ENV 失败在完整重跑中未复现，属偶发前置问题。
- 失败路径：脱敏/去重/重放由 `scripts/test-memory-v2-qq-system-failure.mjs` 钉住；`code` 非法回退 `MEMORY_QQ_FAILED`，QQ key 非法直接忽略；发送失败（`lastSendFailed.get(key)`）保留队列，重连后重放。
- 手工/集成验证：2026-11-24 15:38:23 已用 supervisor 重启 live 桥接（新 pid 90664，DSH_NODE 锁定到运行中的同一 Node 可执行文件以通过 owner 校验）；启动日志确认「[记忆] 已恢复 70 条已提交 QQ 源（跳过 0，异常 0）」，dshReady=true，memoryV2.failures=[]。交接时 SnowLuma 仍 connected=false/everConnected=false，故首次连接后的 backlogWakePending 重排只能由 QQ 真机消息 + 通道恢复共同验收；用户发送一条真实群消息后，确认收到 Native 回复或 QQ 侧可见的错误提示 + 重试指引，回执再补记到本 case 与 RELEASE-QUEUE。
- 没验证到的部分：未改 SnowLuma/ssh 隧道；跨角色纪元的原始 producer 恢复仍走既有 `drainPending()` 授权流程，本轮未重跑真实跨纪元恢复。

## 遗留 / 后续

- 若真实测试仍无回复，先查 `/Users/shizihan/.dsh/surfcore/bridge-supervisor.log` 是否有 `[记忆] 已恢复 N 条已提交 QQ 源`，再查 `state/qq-activity.log` 是否出现可见提示。
- 发布会话需从合并后的 HEAD 重生成 `release/install-manifest.json`，版本号由用户决定。

## 交接块（可直接复制给发布会话）
```text
【合并请求】
分支：live `/Users/shizihan/Daily/Github/surfcore-local-task`（feat/local-task-t01t08，基线 51c4d25）；已回写 `/Users/shizihan/Daily/Github/surfcore-mac`（feat/v1-retirement，b7316ca 工作区）
范围：红豆群消息静默根治——桥接重启后从磁盘水合已提交 QQ 源 + 系统失败 QQ 可见化 + 断线/首次连接重连重放与补唤醒
改到的文件：src/bridge.js、src/core/memory-v2-qq.js、src/core/memory-v2-qq-system-failure.mjs（新增）、scripts/test-memory-v2-qq.mjs、scripts/test-memory-v2-qq-system-failure.mjs（新增）、scripts/test-memory-v2-snowluma-backlog-retry.mjs（新增）、scripts/audit-bridge-harness.mjs、docs/cases/2026-11-24-qq-hongdou-no-reply.md、docs/PITFALLS.md、docs/cases/README.md、docs/RELEASE-QUEUE.md
测试：node --check src/bridge.js 通过；test-memory-v2-qq-system-failure/test-memory-v2-qq/test-memory-v2-snowluma-backlog-retry PASS；npm run test:memory-v2 live 53/53 / 当前树 50/50；npm run test:audit live 209/209 / 当前树 195/195；npm run test:regressions 全通过；npm run lint:failures 退出 0
失败路径：MEMORY_SOURCE_PENDING / SNOWLUMA_OFFLINE 等以【系统提示】code/error/hint 发到 QQ，脱敏、10 分钟去重、发送失败留队、重连重放
风险/未验证：真实 QQ 群消息验收待用户发送后补；未改 SnowLuma/ssh；发布前需从合并 HEAD 重生成安装清单
回滚：撤销六个代码文件改动并重启桥接；hydrate 只读不写 producer 元数据
建议版本：patch（用户可见失败可见性 + 重启恢复；版本号由发布会话定）
```

## 回写当前树验证差异

- 当前主树 `/Users/shizihan/Daily/Github/surfcore-mac` 已手工适配回写同一修法（含 `backlogWakePending` 首次连接补唤醒残留修复）。
- 2026-11-24 完整重跑：`node --check src/bridge.js`、`test-memory-v2-qq-system-failure.mjs`、`test-memory-v2-snowluma-backlog-retry.mjs`、`npm run test:memory-v2` 50/50、`npm run test:audit` 195/195、`npm run lint:failures` 退出 0，全部通过。
- 历史说明（已消解）：早前该树 `npm run test:memory-v2`（1 项）与 `npm run test:audit`（194/195）曾失败在 `MEMORY_BACKEND_UNSUPPORTED: The worker cannot initialize its SQLite backend.`；当时用 `git archive HEAD` 解到 `/tmp/sc-base-check` 验证干净 HEAD 同样失败，确认非本轮引入；本次完整重跑未复现。
