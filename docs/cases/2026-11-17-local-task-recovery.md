# 本机任务查询与取消（T05）：查询不开回合、停止先持久、重启只对账不复算

## 现象

- 用户看到什么：QQ 派了任务以后，没有"现在到哪了"的只读回执；说"取消"，桥接只会
  把账本状态改成取消，DSH 里那一轮还在跑，文件可能照样被写；DSH 崩溃重启后，
  在跑的任务在账本里永远显示"执行中"。
- 复现步骤：派一个长任务 → 发"取消" → 观察 DSH 会话仍在推进；或执行中强杀 DSH → 重开 → 任务仍 `running`。
- 影响面：只影响本机任务这条链；不碰 QQ 聊天 / B站 / 记忆；写的是任务账本域，不碰用户文件。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS + DSH 0.2.2-rc.3 |
| SurfCore 版本 | 仓库 `0.8.8`（`feat/local-task-t01t08`，编辑会话不 bump） |
| 安装方式 | git 工作树 |
| 其它 | 依赖 T02 存储层 `7f14bbf`、T04 会话编排 `eeb33ed` |

## 根因

- 代码位置：`plugins/surfcore/lib/local-task-service.mjs`（状态机）、`lib/local-task-runner.mjs`（会话动作）、
  `lib/local-task-host.mjs`（装配）。
- 问题链条：`queryTask` 只返回原始记录，没有"人话"视图，调用方容易顺手再发一次 prompt 才拿到状态；
  `cancelTask` 只改账本、`sessionController.cancel` 单独调，两步之间没有先后约束；
  进程重启后没有任何人扫描在途任务，状态机就停在 `running` 上骗人。
- 为什么之前没发现：旧实现没有跨进程账本，也就没有"重启后是谁还在跑"这个问题。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 查询 → `queryTask` + `describeTask`（纯读，不建会话不送 prompt）；
  QQ 取消 → `service.cancelTask`（先写持久 `stopRequest` 并置 `cancelled`）→ `sessionController.cancel({sessionId})`
  → 在途审批走 abort 落 `cancelled`；Host 启动 → `mountLocalTasks` → `service.reconcileOnBoot({reason:'host-started'})`。
- **机制**：DSH 的 `prompt` 只承诺入队，状态只能靠 `turn/end` 事件收敛；`cancel` 是"撤回"语义，
  所以停止意图必须先落盘再发取消，否则崩溃在两者之间就会"取消了但还在跑"。
  DSH 的待批审批是**进程内**的（README: pending approvals are process-local），会话取消时随 abort 一起落 `cancelled`，
  不需要我另建审批队列；本任务 preset 根本没收 `job_*`/`bash` 工具，所以"归属 jobs"这一条不存在可取消对象。
- **爆炸半径**：Host 进程 1 个；读者是本模块 + T06 的 QQ/设置页；静默=3 → **3 分**。
  碰用户数据（账本域），不碰密钥，不额外花钱。
- **取舍**：A 每次查询重新读会话事件流算状态（要重放历史、可能触发会话活动）；
  B 查询只读账本投影。选 B：事件流是"过程"，账本才是"结论"，查询绝不能开回合。
  对账同理：A 重启后按 `lastEventPosition` 重放事件补状态（会重复执行写入）；B 一律标
  `needs_reconciliation` 交给人看。选 B，宁可多一次人工确认，也不重复写文件。
- **生效与重启**：改 `lib/*.mjs` 后重启 DSH 生效；重启后的第一次装配就会对账。

## 修法

- `local-task-service.mjs`：
  - `reconcileOnBoot({reason, at})`：`IN_FLIGHT`（`queued/running/waiting`）→ `needs_reconciliation` +
    `reconciledAt`/`reconcileReason`；**清空 `activeTaskId` 让出并发席位**；`persist` 失败跳过不影响其它任务；不重发 prompt。
  - `describeTask(task)`：中文状态标签 + 目标 + （复核/失败时）为什么与下一步 + 产物；QQ 与设置页共用一份措辞。
- `local-task-host.mjs`：装配成功后、`runner.attach()` 之前调 `service.reconcileOnBoot({reason:'host-started'})`。
- `scripts/test-local-task-recovery.mjs`（8 checks）：查询只读、`TASK_NOT_FOUND` 带 hint、对账只标不重放、
  对账释放席位、终态不受影响、已取消不被改写、排队任务可停（`cancelledTurn:false`）、非发起人 `TASK_ACTOR_FORBIDDEN`。
- `scripts/test-local-task-host.mjs` 增第 5 例：预置一条 `running` 任务 → 装配后为 `needs_reconciliation` 且 `prompt` 调用为 0。
- 回滚：`git revert` 本提交；已标 `needs_reconciliation` 的任务是数据不是代码，回滚后仍可查询。

## 验证

- `node plugins/surfcore/scripts/test-local-task-recovery.mjs` → `8 checks passed`
- `node plugins/surfcore/scripts/test-local-task-host.mjs` → `5 checks passed`
- `node plugins/surfcore/scripts/test-local-task-service.mjs` → `11 checks passed`
- `npm run test:audit` → 见提交时输出（本票要求全绿）
- **未验证**：真实 DSH 进程里"执行中强杀 → 重启 → 看到需要复核"（要真跑一轮会话，属 T07）。

## 失败路径（§1.7）

| code | 谁看到 | 下一步 |
| --- | --- | --- |
| `TASK_NOT_FOUND` | QQ 回执 | 说「任务列表」拿任务号 |
| `TASK_CLOSED` | QQ 回执 | 终态不可复活，要重做请新建任务 |
| `TASK_ACTOR_FORBIDDEN` | QQ 回执 | 让发起人自己取消，或主人授权 |
| `TASK_STORE_UNAVAILABLE` | QQ 回执 | 取消意图没落盘 → 不宣称"已停止"，重启 DSH 后重试 |
| `needs_reconciliation` | QQ 查询 | 先看工作区有没有产物，再决定重发 |

## 发布交接块

```
批次：2026-11-17 本机任务 T05（查询 / 取消 / 重启对账）
覆盖提交：`[新功能] 本机任务控制面：只读查询、停止屏障与重启对账`
改了什么：查询只读不开回合（新增 describeTask 人话文案）、重启装配时把在途任务标
          needs_reconciliation 并让出并发席位、取消仍保持"先持久停止意图再撤回会话"。
影响谁：只在 QQ 查询/取消本机任务、以及 DSH 重启后生效；不改 QQ 聊天/B站/记忆链路。
验证：test-local-task-recovery 8 / test-local-task-host 5 / service 11 全绿。
注意：对账不重放写入，重启后需要人看一眼工作区；真实进程强杀验收在 T07 做。
```
