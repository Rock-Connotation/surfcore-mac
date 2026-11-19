# 2026-11-17 本机任务存储层（T02）：Task 单一写者、来源去重与停止屏障

## 现象

- 用户看到什么：目前还没有用户可见变化。这是「QQ 发一句话 → DSH 原生会话干活 → 结果回 QQ」这条新链路的**存储与状态机底座**。
- 为什么现在做：旧路径 `src/task-ledger.js` 是桥接进程自己写 `tasks.json`（tmp+rename），只能做到「尽力落盘」；契约要求「持久成功之后才能回『已接收』」，这需要 DSH 的 `storageDomain`（串行写、写完才算数、unknown-state 隔离）。两套写同一批任务会互相覆盖，所以新链路必须换底座。
- 影响面：ticket T02；不改动现有 QQ 文件路径（那部分在 T08 才退役），也不碰已存用户数据。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH `0.2.2-rc.3`（本机实装，非上游 HEAD） |
| SurfCore 版本 | `0.8.8`（本 worktree 不 bump） |
| 安装方式 | git worktree `/Users/shizihan/Daily/Github/surfcore-local-task`，分支 `feat/local-task-t01t08` |
| 基线 | `b559af5cfae5896f97c14aad98113557d13613bb`（`feat/live-channels-acceptance`） |

## 根因（为什么需要这一层）

- 代码位置：新增 `plugins/surfcore/lib/local-task-service.mjs`；旧写入口 `src/task-ledger.js:1-203`。
- 问题链条：
  1. 桥接进程（`src/bridge.js`）收到 QQ 消息时，如果自己写账本再回「已接收」，进程在写盘后崩溃会留下「用户以为已受理、实际没登记」的空洞；
  2. `tmp+rename` 拿到的是「文件替换原子性」，不是「这次写入已经被后端接受」——两者在断电/配额/后端隔离时结论不同；
  3. 契约还要求 `stopRequest` 不能被迟到的完成事件抹掉，而旧账本没有 `controlEpoch`，无法表达「停止意图」与「完成事件」的先后。
- 为什么之前没发现：旧路径只服务三条固定格式的 QQ 文件指令（列目录/读文本/新建文本），单条命令、无并发、无取消，账本只是审计旁路，不是准入依据。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ → 桥接进程（`src/bridge.js` 的 OneBot 入站）→ Host 插件（DSH 进程内，`plugins/surfcore`）→ 本模块 → `ctx.storageDomain` → `~/.dsh/storages/surfcore_local_task.json`。读取方：任务列表/状态页（T06）、取消与对账（T05）。桥接进程**不写**这个域。
- **机制**：
  - 领域声明是 `{name:'surfcore_local_task', version:1, layout:'single', tables:{tasks:{valueSchema:{parse}}}}`。实测实装 `open()` 只用到 `name/version/layout/tables[*].valueSchema.parse`（`dsh-storage-domain` 的 `descriptorOf()` + `KvTableImpl`），所以不需要 `import` 那个包，也不需要 zod——插件零依赖的前提得以保留。
  - 单写者：所有状态变化都经过本模块，每次变化是「整条任务记录 put 一次」。域内的写链保证「后端持久成功 → 内存变更 → 发 `domain/changed`」的顺序；`put` 抛错（含 unknown-state 隔离）时内存回滚，调用方拿到 `TASK_STORE_UNAVAILABLE`，**不会**回「已接收」。
  - 去重：来源键 = `botId|channel|conversationId|messageId`，另存原文指纹（长度 + FNV-1a）。同键同指纹 = 同一条命令（返回 duplicate，不新建）；同键不同指纹 = `TASK_SOURCE_CONFLICT`（丢弃并记录，不执行）；不同 messageId 的相同文本 = 新命令。
  - 并发与队列：`CONCURRENCY=1`，`QUEUE_LIMIT=20`。有活跃任务时新任务进 `queued`；排队已满回 `TASK_QUEUE_FULL`。
  - 停止屏障：`cancelTask` 先写 `stopRequest{at,by,reason}`、`controlEpoch+1`、状态 `cancelled`；之后 `finish` 到达只会返回 `{ignored:'stop-request'}`，且不改状态。终态（`succeeded/failed/cancelled`）为封闭态，`attachSession` 回 `TASK_CLOSED`。
- **爆炸半径**：2 个进程（桥接、Host）× 3 类读者（任务列表、取消/对账、T06 设置页）× 静默 = 3 → 9 分。碰用户数据但只新建命名空间（不迁移、不清理 `~/.dsh` 既有域）；不碰密钥；不花钱。
- **取舍**：
  - A（选中）：`ctx.storageDomain` + 本模块单写者。收益：拿到「落盘后才回执」和 unknown-state 隔离，取消/去重有唯一权威；成本：新增一个文件；风险：域版本升级要靠 `version` 字段。
  - B（落选）：沿用 `src/task-ledger.js` 的 JSON 账本。收益：零新依赖；成本：桥接与 Host 双写、无隔离、`stopRequest` 无处安放；风险：迟到完成覆盖停止意图（正是契约禁止的）。
  - C（落选）：直接调 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain`。收益：类型更紧；成本：插件零依赖被破坏（`node_modules` 从仓库路径解析，装不到）；风险：升级即断。
- **生效与重启**：本模块只被 Host 插件引用；改它需要重启 DSH（Host 进程），桥接不用重启也读不到——T06 接上之后才影响用户可见行为。

## 修法

- 新增 `plugins/surfcore/lib/local-task-service.mjs`：`LOCAL_TASK_DOMAIN` / `EXECUTION_STATES` / `CONCURRENCY` / `QUEUE_LIMIT` / `sourceKeyOf` / `createLocalTaskService({domain,now,newId})`，方法 `submitTask/queryTask/cancelTask/attachSession/recordDelivery/finish/requireRunning`。
- 新增 `plugins/surfcore/scripts/test-local-task-service.mjs`（11 条断言），并登记进 `plugins/surfcore/package.json` 的 `test` 串。
- 为什么这个方案：契约点名 `ctx.storageDomain`，且实装 `open()` 的入参面比 README 描述更窄，手写 `{parse}` 就能满足，不必引依赖。
- 回滚方式：删掉这两个文件 + 还原 `package.json` 里那一行；不涉及数据迁移，已写入的域文件留在 `~/.dsh/storages/`（如需彻底清理另开命令，先备份）。

## 验证

- 自动化：`node plugins/surfcore/scripts/test-local-task-service.mjs` → `11 checks passed`（含失败分支：`TASK_SOURCE_CONFLICT`/`TASK_STORE_UNAVAILABLE`/`TASK_QUEUE_FULL`/`TASK_ACTOR_FORBIDDEN`/`TASK_CLOSED`/`TASK_SOURCE_INVALID`，每条断言 `code`/`error`/`hint` 非空）。
- 失败路径（用户看到什么 / 下一步）：持久失败 → `{ok:false, code:'TASK_STORE_UNAVAILABLE', error:'任务未能持久写入：…', hint:'检查 DSH 存储域是否可用…'}`，并且**不会**先回「已接收」。
- 没验证到的部分（老实写）：没有在真实 Host 里 `ctx.storageDomain.open()` 打开过这个域（要等 T06 接线才能跑），因此「域文件真实落盘 + 重启加载」目前只有假域表（同为同步读/写抛错语义）覆盖，标注为**未验证**。

## 遗留 / 后续

- 需要补的测试：T06 接线后补一条「真域 open→写→重启→读回」的 Host 集成测试。
- 需要改的文档：T06 落地后在 `docs/guides/` 补「本机任务」一页。

## 发布交接块

```
改了哪些文件：plugins/surfcore/lib/local-task-service.mjs（新增）、
             plugins/surfcore/scripts/test-local-task-service.mjs（新增）、
             plugins/surfcore/package.json（test 串加一行）
测过什么：node plugins/surfcore/scripts/test-local-task-service.mjs → 11 checks passed；
         npm run test:audit → 见下方结果
建议 patch（新增模块，不改现有行为；对用户不可见）
case 文档：docs/cases/2026-11-17-local-task-storage.md
改动层级：实现层新增，无接口变更，向后兼容（现有 QQ 路径完全没动）
失败路径：TASK_STORE_UNAVAILABLE / TASK_SOURCE_CONFLICT / TASK_QUEUE_FULL / TASK_ACTOR_FORBIDDEN /
         TASK_CLOSED / TASK_SOURCE_INVALID 均带 code/error/hint，且有断言
没验证：真实 Host 里 storageDomain.open() + 重启加载（等 T06）
```
