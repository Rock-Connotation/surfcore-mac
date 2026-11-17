# 审核工单：本机任务（T01–T06）实现代码评审

> 这份文件是给**另一个 agent** 的工单。你不需要看我的会话记录，按下面读代码、跑测试、给结论。
> 审核目标是「能不能上真机」，不是「写得漂不漂亮」。

## 0. 一句话背景

主人想在 QQ 私聊里说一句 `本机任务：把三份纪要合成周报`，由 DSH 在自己的专用会话里用真实文件工具做完，
回执回到同一个私聊。这轮实现覆盖 T01（能力矩阵）到 T06（QQ 入口 + 设置页 + 额度），T07 真机验收与
T08 旧入口退役**没做**（需要重启 DSH，见 `docs/plans/2026-11-17-t07t08-handoff.md`）。

## 1. 代码在哪

- 工作树：`/Users/shizihan/Daily/Github/surfcore-local-task`
- 分支：`feat/local-task-t01t08`，基线 `b559af5`（`feat/live-channels-acceptance`）
- 只看这段 diff：`git diff b559af5..HEAD`（10 个提交，38 文件，+3000 行左右）

## 2. 审核范围（按重要性排序）

| 层 | 文件 | 要回答的问题 |
| --- | --- | --- |
| 存储 | `plugins/surfcore/lib/local-task-service.mjs` | 是否只有一个写者？`persist` 失败会不会假装成功？取消后迟到的完成会不会把状态改回成功？重启对账会不会重放写入？ |
| 权限闸门 | `plugins/surfcore/lib/local-task-gate.mjs`、`plugins/surfcore/local-task-gate.mjs` | 路径围栏有没有绕过（`..`、符号链接、`/w/a` vs `/w/ab` 前缀陷阱）？只新建能不能被 `write` 覆盖绕过？`sandbox_permissions` 升权能不能过？闸门卸载后是否 fail-closed？ |
| 会话编排 | `plugins/surfcore/lib/local-task-runner.mjs` | 派发前是否真的核对了 preset 与工具面？失败路径会不会留下跑着的会话？`turn/end` 的 reason 映射会不会把失败记成成功？ |
| 额度 | `plugins/surfcore/lib/local-task-budget.mjs` + runner | 越界后是否真的停会话？计数是否可能被绕过（比如事件类型不同）？ |
| 通道 | `plugins/surfcore/lib/local-task-api.mjs`、`src/core/local-task-client.js` | 令牌/回环/同源校验够不够？桥接拿不到 Host 时会不会**静默重发**或**回退旧执行器**？ |
| 桥接入口 | `src/bridge.js`（`handleOwnerLocalTask`、`handleIncoming` 里那行分流）、`src/core/local-task-intent.js` | 会不会劫持普通聊天？只认主人私聊吗？`任务：` 三种旧说法有没有被抢走（历史坑，见 `docs/PITFALLS.md` #246）？ |
| 设置页 | `plugins/surfcore/lib/client.js`（`LocalTasksTab`）、`plugins/surfcore/lib/index.js`（`handleLocalTasks`） | 有没有偷偷成为第二个发起入口？按钮的失败反馈看得见吗？ |
| 装配 | `plugins/surfcore/lib/local-task-host.mjs`、`dsh/agent-presets/local-task/*`、`scripts/build-agent-preset-patches.mjs` | 装配失败会不会半启动？preset 里的工具面是不是最小集合？ |

## 3. 合同（不满足就是缺陷）

来自 `~/Downloads/surfcore-redbean-agent-pack-20261116/02-IMPLEMENTATION-CONTRACT.md` 与 `03-LOCAL-AGENT-PROMPT.md`：

1. 身份只能来自可信 OneBot/Host 上下文，**不能**由模型或消息正文提供。
2. 去重键 = 机器人 + 渠道/会话 + 平台消息 ID + 内容指纹；同号同文幂等，同号异文报冲突。
3. 持久成功之后才能回「已接收」。
4. 执行状态与投递状态**分开**记录；投递失败不得改写执行结果；ACK 丢失标 `uncertain`。
5. 查询只读，不开新回合。
6. 取消：先持久 `stopRequest` → 停派发 → 只取消本任务的队列/审批/turn/jobs。
7. 失败必须可见可行动：`{ok:false, code, error, hint}`，前端不得只 `console.log`。
8. 默认值：并发 1、队列 20、活跃 30 分钟 / 30 次模型请求 / 120 次工具调用。

## 4. 必须自己跑的验证（不要只读代码）

```bash
cd /Users/shizihan/Daily/Github/surfcore-local-task
npm run test:audit                      # 期望 208/208
node plugins/surfcore/scripts/test-local-task-service.mjs    # 11
node plugins/surfcore/scripts/test-local-task-gate.mjs       # 11
node plugins/surfcore/scripts/test-local-task-runner.mjs     # 22
node plugins/surfcore/scripts/test-local-task-host.mjs       # 5
node plugins/surfcore/scripts/test-local-task-recovery.mjs   # 8
node plugins/surfcore/scripts/test-local-task-api.mjs        # 10
node scripts/test-local-task-intent.mjs                      # 7
node scripts/release-manifest.mjs --verify-ref HEAD          # 问题 0 个
```

然后**自己写两个攻击用例**（不改仓库文件，放 `/tmp`）来验证你觉得最可疑的那一处，例如：

- 把目标写成 `workspace/../outside/x.txt` 或先在工作区里放一个指向外面的符号链接，看闸门是否拒绝；
- 伪造 `sandbox_permissions` 参数，看是否被拒；
- 同一个 `messageId` 发两次不同正文，看是否 `TASK_SOURCE_CONFLICT`；
- 取消后补一个 `turn/end: succeeded`，看状态是否被改回成功。

## 5. 边界（硬性）

- **只读审核**：不要修改 `plugins/surfcore/**`、`src/**`、`scripts/**`、`dsh/**` 里的任何文件。
  （要证明问题就在 `/tmp` 写临时脚本。）
- 不要 `git reset/checkout/stash/clean`，不要 push，不要动 `release/install-manifest.json`。
- 不要去重启 DSH、不要发真实 QQ 消息（那会让审核变成真机操作）。
- 找不到证据就写「未验证」，不要猜。

## 6. 输出格式

按这个结构回一份（中文）：

```
结论：可以上真机 / 修完再来 / 不可用
P0（会丢数据或越权）：
  - 文件:行号 · 现象 · 为什么是 P0 · 复现命令或攻击用例
P1（功能不对或有回归风险）：
P2（可读性/重复/命名）：
我实际跑了什么（命令 + 结果）：
我改变判断的那一刻（哪个证据最有力）：
我没能验证的部分（以及为什么）：
```

每条缺陷必须带 `文件:行号`；说"测试不足"要指出**哪条分支没测**，不要泛泛而谈。

## 7. 已知未验证（不要重复报告）

- 真实 QQ 收发、真实 DSH 会话执行、设置页界面：都需要重启 DSH，本会话跑在 DSH 里做不了。
- `LOCAL_TASK_API` 之外的设置页接口 `API_PREFIX/local-tasks` 没有单测，只有 `test-client-contract.mjs` 的静态断言。
- Token 用量 20 万提醒这条契约默认值没实现。
- 旧入口退役（T08）没做：`src/task-directory.js` 与三条固定指令仍在，旧账本 `tasks.json` 与新域并存（只读隔离已核实，无双写）。
