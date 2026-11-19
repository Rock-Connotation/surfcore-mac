# 本机任务 QQ 入口（T06）：主人私聊发任务，Host 记账，执行与回执分开

## 现象

主人想在 QQ 里直接说「本机任务：把三份纪要合成周报」，由 DSH 在自己的会话里用真实文件工具去做，
做完在同一个 QQ 私聊里回报结果。此前只有三条**固定指令**（列目录 / 读文本 / 新建文本），
既不能承接自然语言，也没有任何"任务账本"——重启就不知道刚才那条做到哪了。

## 环境

- 本机：macOS，DSH Desktop `0.2.2-rc.3`，SurfCore 插件 0.8.8（工作树 `feat/local-task-t01t08`，基线 `b559af5`）。
- 桥接：`src/bridge.js`（OneBot 入站）；Host：`plugins/surfcore`。
- 本票落地前：T01–T05 已提交（`964d3c2` / `7f14bbf` / `00a171d` / `eeb33ed` / `a46033b`）。

## 根因

不是某一行写错，而是**缺一层**：桥接只有"聊天"这一条下行链路，没有把"一条 QQ 消息"变成
"一个有编号、可查询、可取消的任务"的地方。任务状态如果放在桥接内存里，进程一重启就丢；
如果把执行塞进桥接自己写的循环里，就等于在 DSH 之外再造一个执行器（契约明确禁止）。

## 完整逻辑（给用户看的那一遍）

1. **链路**：主人 QQ 私聊 → SnowLuma → `src/bridge.js` 的 `handleIncoming` → `plainContent`
   → `handleOwnerLocalTask`（只认主人私聊）→ HTTP `POST /dsh-surfcore/local-task-api`
   → Host 侧 `local-task-api.mjs` → `local-task-service.mjs`（账本，`storageDomain` 落盘）
   → `local-task-runner.mjs` 建**专用 Session**（preset `local-task`）送 prompt
   → DSH 自己跑工具 → `session/event` → runner 投影状态 → `onFinished` → `deliver`
   → `callBridge('/api/notify/owner')` → 桥接 `send_private_msg` → 回到同一个 QQ 私聊。
2. **机制**：任务身份（去重键）只能来自平台消息号：`botId|channel|conversationId|messageId`
   加正文指纹。同号同文 = 同一条任务（幂等）；同号不同文 = `TASK_SOURCE_CONFLICT`
   （宁可报冲突，也不要悄悄覆盖一个人的原意）。不同消息号发同样的话 = 两条新任务。
3. **爆炸半径**：只影响主人私聊里的三种显式说法（`本机任务：…` / `本机任务列表` / `取消本机任务 …`）；
   普通聊天一个字都不改——意图解析只认这三条正则，匹配不上就交回原链路。
   一旦 Host 不可达，回执如实说"可能已受理，先查任务列表，不要重发"，**不自动重试**。
4. **取舍**：
   - 通道复用 `memory-v2-api.mjs` 的发现文件范式（0600 + 回环 + 定长令牌比较），而不是新写一份传输层；
     代价是多一个 64KB 的 `local-task/qq.json`，收益是桥接不需要知道 Host 端口。
   - 投递走既有 `callBridge('/api/notify/owner')`，而不是让 Host 直接连 SnowLuma；
     代价是回执要绕一圈，收益是"QQ 令牌只在桥接进程里"这条边界不动。
   - 回执消息用 `truncateText(body, 900)` 截断，而不是分片；代价是超长列表会被截，收益是不会刷屏。
5. **生效与重启**：改的是桥接与 Host 插件两边——桥接要重启 `bridge`，Host 侧要在 DSH 里
   重载 SurfCore 插件（本次未重启，`T07` 里连真实会话一起验）。
6. **验证**：`node plugins/surfcore/scripts/test-local-task-api.mjs` → 10 checks passed；
   `node scripts/test-local-task-intent.mjs` → 7 checks passed；`npm run test:audit` 见提交记录。
7. **回滚与残余**：回滚 = 删掉 `handleOwnerLocalTask` 的调用一行即可恢复纯聊天（其余模块不被引用）。
   残余：真实 QQ 收发与真实 DSH 会话尚未验证（需要重启 + 真机），见 `T07`。

## 踩坑：入口词不能重名（2026-11-17）

第一版用 `任务：` / `任务状态` / `取消任务` 做入口词，`npm run test:audit` 立刻把
`test-owner-delivery-r3.mjs` 打红：这三种说法**早就被 `src/bridge.js` 的 task-harness 占用**
（见 `src/bridge.js:220` 的注释），新入口一挂上去就把旧的远程任务链路吃掉了，
表现是"发送条数多一条、产物文件没生成"。

修法不是加例外，而是换词：新入口必须带「本机」二字（`本机任务：` / `本机任务列表` / `取消本机任务`）。
代价是主人要多打两个字，收益是两条入口永不互相劫持；这条也写进了意图解析的注释里，
下次谁想"顺手简化成任务："会先看到原因。

## 修法

- 新增 `plugins/surfcore/lib/local-task-api.mjs`：Host 侧唯一入口，只认 `submit`/`query`/`cancel`；
  令牌错、来源错、动作错、未就绪各有独立错误码与 hint（不许一个 403 打天下）。
- 新增 `src/core/local-task-intent.js`：三条正则的纯函数，普通聊天不命中。
- 新增 `src/core/local-task-client.js`：每次请求重读发现文件；超时按"未知"返回，不重发。
- `src/bridge.js`：`handleIncoming` 里 `plainContent` 之后一行优先分流；回执统一走 `send_private_msg`。
- `plugins/surfcore/lib/local-task-host.mjs`：`onFinished` → `deliver()`，投递结果单独记
  `delivery.state = delivered | uncertain`，**绝不改写执行状态**。
- `plugins/surfcore/lib/index.js`：用 `ctx.webServer.register({ kind:'exact', path })` 挂通道。

## 额度（契约默认值，已实现）

`plugins/surfcore/lib/local-task-budget.mjs`：活跃 30 分钟 / 30 次模型请求 / 120 次工具调用。
计数发生在 `runner.observe`（`assistant/attempt` 与 `tool/result`），越界立刻：
任务记 `failed` + `TASK_BUDGET_EXCEEDED`（带 hint：先看工作区再决定要不要重发）→
撤掉该会话 → 不再接受这个任务的后续派发。计数只在内存里，重启窗口自然重置（重启已把在途任务标成 `needs_reconciliation`）。

## 设置页「本机任务」

`DSH 设置 → SurfCore → 本机任务`（`plugins/surfcore/lib/client.js` 的 `TABS` + `LocalTasksTab`）：

- 只读列表：任务号 / 内容 / 状态 / 回传状态（已回传、回传未知、未回传）；
- 两个动作：执行中任务可「停止」；已绑定会话的任务可「原生会话」（显示真实 `dshSessionId`）；
- **刻意没有发起入口**：派发只发生在 QQ，设置页不提供第二个执行入口。

Host 侧接口是 `API_PREFIX/local-tasks`：GET 列表、POST `{action:'cancel'|'open', taskId}`，
未就绪回 503，没绑定会话回 409 `LOCAL_TASK_SESSION_MISSING`。

**未验证**：这个接口没有单测（只在 `test-client-contract.mjs` 里断言了页面存在与调用路径），
也没有真机截图——要重载 DSH 插件才能在界面上看到。

## 验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 通道契约 | `node plugins/surfcore/scripts/test-local-task-api.mjs` | 10 checks passed |
| 意图解析 | `node scripts/test-local-task-intent.mjs` | 7 checks passed |
| 全量门禁 | `npm run test:audit` | 见本票提交记录 |

## 失败路径（§1.7）

| 码 | 触发 | 用户看到 | 下一步 |
| --- | --- | --- | --- |
| `LOCAL_TASK_AUTH_REQUIRED` | 令牌不符 | 没接住（LOCAL_TASK_AUTH_REQUIRED） | 重启 DSH 让桥接重新读发现文件 |
| `LOCAL_TASK_ORIGIN_REJECTED` | 非回环 Host | 没接住（LOCAL_TASK_ORIGIN_REJECTED） | 只在本机调用 |
| `LOCAL_TASK_HOST_UNAVAILABLE` | 超时/断连 | 本机任务通道没有响应 | 先发「任务列表」确认，不要重发 |
| `LOCAL_TASK_NOT_READY` | 域没开起来 | 本机任务还没装好 | 重启 DSH |
| `TASK_SOURCE_CONFLICT` | 同号不同文 | 这条消息号已经被另一条内容占用 | 重新发一条 |
| `TASK_NOT_FOUND` | 查询/取消不存在的号 | 查不到（TASK_NOT_FOUND） | 发「任务列表」拿正确任务号 |
| `LOCAL_TASK_DELIVERY_FAILED` | 回执发送失败 | 执行结果仍记为完成，投递记 `uncertain` | 发「任务状态 <任务号>」查看 |

## 发布交接块

```
[新功能] 本机任务 QQ 入口：自然语言发起、查询、取消
- 桥接只承认主人在私聊里的三种显式说法，其余聊天不受影响
- 任务身份来自平台消息号，重复投递幂等，冲突明确报错
- 执行状态与回执投递分开记录，Host 不可达时如实提示而不是重发
- 测试：test-local-task-api（10）/ test-local-task-intent（7）/ test:audit
- 未验证：真实 QQ 收发与真实 DSH 会话（见 T07）
- 回滚：删除 bridge.js 里 handleOwnerLocalTask 调用一行
```
