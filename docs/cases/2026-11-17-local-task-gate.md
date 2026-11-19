# 2026-11-17 本机任务闸门（T03）：能力天花板、路径围栏与只新建

## 现象

- 用户看到什么：暂无可见变化；这是「QQ 派活 → DSH 干活」这条链路**能不能安全放行**的判定层。
- 为什么现在做：契约要求权限 = 可信主体 ∩ 渠道 ∩ 任务作用域 ∩ Grant ∩ 动作 ∩ 资源 ∩ 可强制工具 ∩ 审批 ∩ 预算，并且在「任务开始、每次工具派发、每次模型外发、每次 QQ 回传」前都校验。工具派发这一环必须有宿主级硬闸门。
- 影响面：T03；不改现有 QQ 路径，纯新增模块。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH `0.2.2-rc.3` |
| SurfCore 版本 | `0.8.8`（不 bump） |
| 基线 | `b559af5…` + `7f14bbf`（T02） |

## 根因（为什么不能只靠「少装几个工具」）

- 代码位置：新增 `plugins/surfcore/lib/local-task-gate.mjs`；范式来源 `plugins/surfcore/qq-tool-restrict.mjs:235`（`ctx.tools.guard((exec) => reason|undefined)`）。
- 问题链条：
  1. `tools.restrict` 只影响**注册期可见性**，且「restriction lifts when disposed」——策略卸载后工具会重新出现在 schema 里；
  2. `fs-sandbox` 的 `workspace-write` **只拦写入**，读取/罗列不受围栏（T01 矩阵已证），所以 `read` 能读 `~/.ssh`；
  3. `write` 的语义是「创建或整体替换」，而契约要求「只新建必须底层 createIfAbsent，模型读过不算覆盖授权」——`fs-observation-policy` 恰恰是「读过即可覆盖」，不能直接拿来当授权；
  4. 模型可以自己传 `sandbox_permissions: danger-full-access` 申请升权。
- 为什么之前没发现：旧 QQ 文件路径只接受固定格式指令、目标目录写死在配置里，没有「模型自由选路径」这一步，所以从未需要路径围栏。

## 完整逻辑（给用户看的那一遍）

- **链路**：任务会话（T04 建）里模型调工具 → `tools/pre-execute` → **本模块的 guard** → `tools/execute` → fs 工具。guard 的拒绝是单调的，后续监听器改不回来。
- **机制**：
  - 白名单只有 `read/write/glob/grep/todo_write`：没有 `bash/pwsh`（执行）、没有 `subagent` 家族/`ralph`/`workflow`（派生）、没有 `mcp__*`（外部副作用）、没有 `tool_web`（外发）、没有 `present/goal`。
  - 路径判定用 `realpath` 而不是 `startsWith`：`/w/a` 与 `/w/ab` 前缀相同却不是同一目录；`work/out -> base` 这种符号链接会把 `startsWith` 骗过去。不存在的目标按「最深的已存在祖先 realpath + 剩余片段」归属。
  - `write` 命中已存在文件一律拒绝（这就是「只新建」，与模型是否读过无关）。
  - 带 `sandbox_permissions` 的调用一律拒绝：不许模型自行升权。
  - 健康位 `healthy=false`（策略不在册/自检失败）时**所有**工具调用被拒绝，fail-closed。
- **爆炸半径**：1 个进程（Host）× 2 类读者（工具管线、任务会话装配）× 静默 = 3 → 6 分。不碰用户数据（只读判定）；不碰密钥（反而挡住读密钥）；不花钱。
- **取舍**：
  - A（选中）：`tools.guard` + 自己的 realpath 围栏。收益：唯一能在执行期生效且单调的位置；成本：约 120 行；风险：新工具加入白名单需要改这里（有意为之）。
  - B（落选）：只依赖 preset 少装工具 + `fs-sandbox`。收益：零代码；成本：卸载即失效、读不设防、write 可覆盖。
  - C（落选）：把「只新建」交给 `fs-observation-policy`。收益：不用自己判存在性；成本：语义相反（读过=可覆盖）；风险：正是契约点名禁止的那条。
- **生效与重启**：装配进任务会话后由 Host 进程加载；改本文件要重启 DSH。

## 修法

- 新增 `plugins/surfcore/lib/local-task-gate.mjs`：`TASK_ALLOWED_TOOLS`、`taskGateDenyReason(exec,{root,healthy,exists})`、`resolveInsideRoot(root,candidate)`、`createLocalTaskGate({root,isHealthy})`。
- 新增 `plugins/surfcore/scripts/test-local-task-gate.mjs`（11 条断言，含符号链接逃逸、前缀陷阱、升权拒绝、健康位 fail-closed）。
- 回滚：删两个文件 + 还原 `package.json` 那一行。

## 验证

- 自动化：`node plugins/surfcore/scripts/test-local-task-gate.mjs` → `11 checks passed`。
- 失败路径：拒绝理由直接进模型可见的 reason（例如 `路径越出工作区：../work-other/escape.md（工作区：/tmp/…/work）`），模型能看到「为什么不让」；闸门不健康时理由是「策略未确认在册…拒绝任何工具调用」。
- 没验证到的部分：**没有在真实任务会话里跑过**（装配在 T04，需要 DSH 真机）；`exec.arguments` 的字段名取自本仓库既有 guard 实现（`lib/qq-v2-native-owner.mjs:145` 用 `structuredClone(exec.arguments)`），未在真机打印核对过命名。

## 遗留 / 后续

- T04 装配后补一条「真机会话被拒一次 + 成功一次」的记录。
- 审批（`decideDshApproval`）与预算判定还没接进来，属于 T05/T06。
