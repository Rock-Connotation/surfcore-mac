# T01 · 本机 DSH 实装契约与阻断项（2026-11-17）

> 结论先行：**T01 gate 通过（有条件）**。四个核心原语在本机实装版本上可证，
> 一个原语（策略缺失时 fail-closed 阻断派发）**宿主不提供**，需要最小兼容适配；
> 两个事实仍 `unverified`，不阻塞 T02/T04 的离线实现，但**阻塞"真实电脑任务放行"**。

## 0. 环境事实（证据来源：本机，不是上游）

| 项 | 值 | 怎么取的 |
| --- | --- | --- |
| DSH 版本 | `0.2.2-rc.3` | `/Applications/DeepSeek Harness.app/Contents/Info.plist` 的 `CFBundleShortVersionString` |
| 代码形态 | 单文件 `Contents/Resources/app.asar`（210011763 B，20114 个文件） | asar 头解析（`/tmp/asar-read.mjs`） |
| profile | `desktop` / `web` / `headless` | `ls ~/.dsh/profiles` |
| surfcore 挂载点 | 只有 `desktop` profile 的 `dependencies` 里有 `surfcore` | `~/.dsh/profiles/desktop/package.json` |
| 上游参考 SHA | `39163dd30f703a79079e2d2446545cff3c453738` | 交接包给定；**不是**本机证据 |

取证据的方法：asar 是文件不是目录，`app.asar/dsh` 不可直读；用 `/tmp/asar-read.mjs`
（解析 asar 头 → 按偏移取文件）读实装包内的 `README.md` / `lib/index.js`。
下文所有引用都来自**本机实装包的 README 正文**，不是上游 GitHub。

## 1. 能力矩阵

### 1.1 存储与持久确认（T02 依赖）

| 契约要求 | 结论 | 证据 |
| --- | --- | --- |
| `ctx.storageDomain` 存在且可用于 Host 侧持久数据 | **supported** | 实装包里 `storageDomain` 85 处、`ctx.storageDomain` 38 处；`@deepseek-ai/dsh-storage-domain` README §Summary：「Reads return synchronously from validated in-memory state, while each write becomes durable before it resolves and emits `domain/changed` in order」 |
| 单写者串行 | **supported** | 同 README §Design concept：「Every write queues on one per-domain write chain: backend durability first, then memory mutation, then `domain/changed`」 |
| unknown-state 行为 | **supported（语义明确）** | 同节：「an `unknown-state` rejection quarantines reads and later writes until close. Any unknown durable outcome requires closing and reopening the backend and domain before further use」 |
| 不产生模型可见的副作用 | **supported** | 同 README §Model Experience：「Nothing. The package registers no tools, injects no prompts, and appends no session events」 |
| 跨表事务 | **unsupported（双向）** | 无；Task+Command+Delivery 必须合并到**一条** domain 记录里更新 |

→ T02 决断：一个 domain（`surfcore-local-task`）存 `tasks` 记录，Task 内嵌 Command/Delivery 数组，
不再拆表；Grant/Workspace 另开两个 domain。持久失败 → 关闭并重开 domain，期间**不派发**。

### 1.2 文件语义（T03/T07 依赖）

| 契约要求 | 结论 | 证据 |
| --- | --- | --- |
| 原子只新建 / no-clobber | **supported** | `@deepseek-ai/dsh-fs-local` README §Write path：「enforces the optional guard (`createIfAbsent` or `replaceIfVersion`)… Guarded creation uses a hard-link publication that never replaces a concurrent creator, rejecting it with `FS_NOT_OBSERVED`」 |
| 并发/竞争创建可判定 | **supported** | 同上 + 「A per-target FIFO lock serializes read→guard→write windows, so concurrent writes and edits are deterministically ordered」 |
| 版本冲突可见 | **supported** | 错误码 `FS_STALE_VERSION`、`FS_NOT_TEXT`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`、`FS_PATCH_MISMATCH`、`FS_SAME_TARGET`、`FS_NOT_FOUND` |
| `cwd` 能当目录边界 | **unsupported** | 同 README §When to choose it：「`config.cwd` is a resolution default, not a containment boundary: absolute paths and `..` escape it」 |
| 写入可被工作区围栏 | **supported** | `@deepseek-ai/dsh-fs-sandbox` README：「`workspace-write` allows a mutation only when the target canonicalizes under the workspace root, an explicit additional writable root, or a platform temp area」；拒绝码 `FS_SANDBOX_DENIED` |
| 读取也受围栏 | **unsupported** | 同 README：「Reads, listings, metadata, and read-only watches work exactly as with `fs-local`; the mutation fence does not restrict observation」 |
| 单次提权可放宽 | **supported（对本任务是有害能力）** | 同 README：「A session with an approved escalation may retry the same operation at a strictly wider mode for that one call」 |

→ T03 决断：**目录边界必须自己实现**（realpath 规范化 + 符号链接解析 + 父目录 + 目标四段校验），
不能靠 `cwd`，也不能靠 `workspace-write` 覆盖读取；Task preset 必须**关掉单次提权**否则围栏可被绕过。

### 1.3 工具准入与生命周期（T03 的核心阻断项）

| 契约要求 | 结论 | 证据 |
| --- | --- | --- |
| 按会话隐藏工具 | **supported** | `@deepseek-ai/dsh-tools` README §Restrict：「`ctx.tools.restrict(filter)` applies an allow or deny mask… masks intersect, scoped registrations stay visible」 |
| 执行期兜底拒绝 | **supported** | §Enforce policy：「`ctx.tools.guard(guard)` registers a monotonic synchronous guard after the extensible `tools/pre-execute` waterfall: a returned reason denies the call, and no later listener can turn that denial back into permission」 |
| 策略插件卸载后仍然阻断 | **unsupported** | §Restrict 明确：「the restriction lifts when disposed」。restrict/guard 都是 effect-owned，插件卸载即失效 |
| 宿主存在"策略缺失就拒绝派发"的开关 | **unsupported** | 全包无此机制；guard/restrict 只是可选装饰 |
| 组件装配失败会阻止会话 | **supported** | `@deepseek-ai/dsh-agent-preset-registry` README：「Import failures, activation failures and leaks reject the mount… Failure prevents new bindings to that definition」 |
| 冷恢复时 preset 定义缺失会被拒 | **supported** | 同 README：「recovery after restart uses the current definition of that ID and rejects a missing definition」 |
| 首轮前 preset 可变 | **supported（风险点）** | 同 README：「`select` leaves a blank Session that records the requested preset and already runs its current revision unchanged」 |

→ **T03 阻断项 B1**：契约要求"策略不存在就拒绝继续模型和工具派发"，实装宿主做不到。
最小兼容适配（不重写 Agent Loop）：

1. **能力天花板下沉到装配层**：Task 专用 preset 的 `plugins` 只装 `dsh-tool-fs` + `fs-sandbox` +
   `todo`，不装 `bash`/`pwsh`/`str_replace_editor`/`subagent*`/`mcp-*`/`tool-web`。
   插件缺失时能力仍然不存在 —— 这一层天然 fail-closed。
2. **策略层用 `restrict`+`guard`**，把可写范围从"整个工作区"收窄到"Grant 指定的资源"。
3. **宿主侧闸门**：TaskService 自己持有 gate 健康位；gate 卸载/装配失败 → 健康位归零 →
   **TaskService 拒绝再送 `session.prompt` 与审批**（bridge 侧不派发）。这一条不依赖 DSH。
4. **残余风险（必须写进交付）**：gate 在**一轮进行中**被热重载掉时，该轮剩余工具调用只能靠
   第 1 层（无 shell、有 sandbox）兜底，路径白名单会退化为"整个工作区可写"。
   缓解：T08 把 gate 放进 bundle（跟随主插件生命周期），并在设置页显示 gate 状态。

### 1.4 会话与请求语义（T04/T05 依赖）

| 契约要求 | 结论 | 证据 |
| --- | --- | --- |
| 稳定 requestId 去重 | **supported** | `@deepseek-ai/dsh-api-session-controller` README：「Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message」 |
| 接受 ≠ 执行 | **supported** | 同 README：「Acceptance acknowledges insertion, not execution or completion」 |
| 只有 create/fork 建 Agent | **supported** | 「Create and fork are the only operations that create a new Agent directly」 |
| 取消需要活会话 | **supported（有限制）** | 「Cancellation requires live state」→ 冷会话不能取消，只能靠 stopRequest 屏障 |
| 事件流/订阅/重连补齐 | **supported** | 同 README §Client：`SessionEventStream` 只发连续段，断档用尾页修复 |

→ T04 决断：Task 的 `session.prompt` 一律用持久化 `requestId`；创建与首条 prompt 连续做，
中间不给"空会话被原生 UI 抢先执行"的窗口；`session.create` 响应丢失时按已记录的 taskId/sessionId 核对，不盲目重建。

### 1.5 仍 `unverified`（不阻塞实现，阻塞放行）

| 事实 | 为什么未验证 | 打算怎么证 |
| --- | --- | --- |
| 辅助模型调用（压缩/自动标题）是否带 `sessionId` | 需要 `llm/stream` 实装行为与真实请求日志；本机没有可安全复现的抓包 | 在 Task preset 里**关闭** compaction/auto-title，再跑一次真实任务核对；证不了就保持关闭 |
| `job` 归属与取消粒度 | 需要真实后台任务 + 取消路径 | T05 实现时用受控测试任务验证 |

## 2. 对 T02–T08 的实施决断

1. 存储：`ctx.storageDomain` 三个 domain（tasks / grants / workspaces），Task 记录内嵌 Command、Delivery。
2. 会话：Task = 一个专用 Session + 一个专用 preset（`surfcore-task`），preset 源在
   `dsh/agent-presets/surfcore-task/{preset.yml,agent.cordis.yml}`，由
   `scripts/build-agent-preset-patches.mjs` 渲染成 `plugins/surfcore/presets/surfcore-task.patch.yml`。
3. 策略：`plugins/surfcore/task-tool-gate.mjs`（restrict + guard + 路径四段校验），
   与 `qq-tool-restrict.mjs` 同构，复用其失败模式（未知工具名逐个 try/catch）。
4. 文件动作：只走 `ctx.fs` 的 `createIfAbsent`（新建）、只读接口（列目录/读文本）。
5. 旧路径：`src/task-harness.js` 的固定指令入口在 T08 关停，`tasks.json` 只读。

## 3. 未验证声明

本文件是**静态审查 + 实装包文档核对**的结论，没有跑真实 QQ、没有跑真实 DSH 任务、
没有改 `~/.dsh`。T01 的 gate 结论是"可以继续实现"，不是"可以放行真实电脑任务"。
