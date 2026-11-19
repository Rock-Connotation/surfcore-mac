# 本机任务会话编排（T04）：一 Task 一专用 Session、先装配后送 prompt

## 现象

- 用户看到什么：QQ 里派一个本机任务后，只有"旧固定指令三项"能跑（列目录 / 读文本 / 新建一个 txt），
  自然语言任务无法交给 DSH 执行；查不到任务状态、取消也没有停止语义。
- 复现步骤：`任务：新建文件 qq-test.txt 写入 红豆写入测试` 走的是桥接里写死的
  `handleOwnerMacFileTask`，不是 DSH 的工具路径。
- 影响面：三份真机验收 case（2026-11-16 的 readonly-directory / readonly-file / create-file）
  证明的是**固定指令**闭环，不是"QQ 自然语言 → DSH 会话 → 工具 → 回执"。不碰用户数据（不动旧账本）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS + DSH 0.2.2-rc.3（`/Applications/DeepSeek Harness.app`） |
| SurfCore 版本 | 仓库 `0.8.8`（`feat/local-task-t01t08`，编辑会话不 bump） |
| 安装方式 | git 工作树 |
| 其它 | 基线 `b559af5`（`feat/live-channels-acceptance`） |

## 根因

- 代码位置：`src/task-harness.js`（执行准入 + 产物）、`src/task-ledger.js`（旧账本）、
  `src/task-directory.js`（旧三项文件操作）；桥接侧 `src/bridge.js` 的 `macFileCommandPattern`。
- 问题链条：旧路径用"固定指令 + 固定授权 + 桥接自己执行"，从来没有 DSH 会话参与，
  所以既没有 Agent 能力，也没有 requestId 语义、事件投影和取消屏障。
- 为什么之前没发现：真机验收只覆盖了固定指令；"任务"这个词被历史实现占用了。

## 完整逻辑（给用户看的那一遍）

- **链路**：QQ 私聊消息 → `src/bridge.js` → `local-task-service.submitTask`（持久 Task）
  → `local-task-runner.dispatch` → `ctx.sessionController.create({cwd, agentPreset:'local-task'})`
  → 装配校验 → `sessionController.prompt({requestId, content})` → DSH Agent Loop
  → `ctx.on('session/event')` → `runner.observe` → `service.finish(...)`；投递（T06）另算。
- **机制**：DSH 的 `prompt` 只承诺"消息已入队"（`accepted:true`），完成/失败只能由
  会话事件 `turn/end`（`data.reason`）判定；`requestId` 命中已入队消息时返回原接受结果，
  所以持久化 requestId 后重试是幂等的，不会重复插消息。
- **爆炸半径**：Host 进程 1 个；读者是本模块 + 后续 QQ 入口/设置页；
  静默=3 → **3 分**。碰用户数据（任务账本写在 `~/.dsh/storages/surfcore_local_task.json`），
  不碰密钥，不额外花钱（复用 DSH 既有路由）。
- **取舍**：A 用 `ctx.agents.createSession` 直连 agent（绕过 `sessionController` 的队列/去重）；
  B 只用 `ctx.sessionController` 公开面。选 B：A 拿不到 `requestId` 去重和 `keepInbox` 语义，
  且升级即碎。装配校验不做"创建前查一次"，改成**创建后按会话取证**（preset id + 工具面 + 闸门存活），
  因为 preset 是每会话装配的，静态查不到。
- **生效与重启**：`plugins/surfcore/lib/local-task-host.mjs` 由 `lib/index.js` 的 `apply()` 调起；
  改 preset 源文件后要跑 `node scripts/build-agent-preset-patches.mjs` 并**重启 DSH**，
  preset 在装载时读，热改不生效。

## 修法

- 新增 `plugins/surfcore/lib/local-task-runner.mjs`：
  - `dispatch`：`requireRunning` → `create` → `verifySurface` → `attachSession` → `prompt`；
    装配不合格就 `cancel` 会话并让任务落 `failed`，绝不送 prompt。
  - `verifySurface(sessionId)`：`agentPresets.composedPreset(agent.ctx) === 'local-task'`（防回落到别的 preset）、
    工具面 ⊆ `read/write/glob/grep/todo_write`（防 bash/subagent/MCP 混入）、闸门存活计数 > 0（防策略被卸载）。
  - `observe`：按会话归属过滤 → `noteEvent` 去重（seq 只前进）→ 只认 `turn/end` → 有 `stopRequest` 就不覆盖。
  - `cancel`：先 `service.cancelTask`（持久停止意图）再 `sessionController.cancel({sessionId})`；
    cancel 抛错时如实返回 `uncertain:true`。
- `local-task-gate.mjs`：加 preset 行入口 `apply(ctx)`（root 取 `exec.agent.session.header.cwd`），
  补上"没有工作区根就拒绝"的 fail-closed 分支。
- 新增 preset 源 `dsh/agent-presets/local-task/{preset.yml,agent.cordis.yml}`（persona / sandbox-policy /
  fs-sandbox / tool-fs（edit、applyPatch、readImage 全关）/ local-task-gate），
  `scripts/build-agent-preset-patches.mjs` 加 `local-task` 与守卫行改写、必须行按 preset 区分，
  产物 `plugins/surfcore/presets/local-task.patch.yml` 进 `dsh.bundle.patch`。
- `lib/local-task-host.mjs`：`ctx.inject(['storageDomain','agents','agentPresets','tools','sessionController'])`
  打开域、建服务与 runner、订阅 `session/event`；`getLocalTasks()` 给上层同一个句柄；卸载时关域、清句柄。
- 回滚：`git revert` 本提交即可；域文件 `~/.dsh/storages/surfcore_local_task.json` 可留可删（无其它读者）。

## 验证

- `node plugins/surfcore/scripts/test-local-task-runner.mjs` → `20 checks passed`
  （闸门不在册不送 prompt、装配到别的 preset 拒绝、工具面越界点名 bash、取不到 agent 拒绝、
  事件归属/乱序/取消/出错投影、取消 ACK 失败标 uncertain、建会话/送 prompt 失败落 failed、终态不复活）。
- `node plugins/surfcore/scripts/test-local-task-host.mjs` → `4 checks passed`（装配、事件转发、卸载失效、缺 storageDomain）。
- `node plugins/surfcore/scripts/test-local-task-service.mjs` → 11；`...-gate.mjs` → 11。
- `node scripts/test-agent-preset-patches.mjs --check` → `✅ agent preset patch 契约通过`。
- `npm run test:audit` → `207/207 scripts passed`。
- **未验证**：真实 DSH 进程里的 `storageDomain.open` / `sessionController.create` 端到端（要重启 DSH 才能验，属 T07）。

## 失败路径（§1.7）

| code | 谁看到 | 下一步 |
| --- | --- | --- |
| `TASK_POLICY_UNMOUNTED` | QQ 回执 | 重启 DSH 让策略重新装配 |
| `TASK_POLICY_MISMATCH` | QQ 回执 | 检查 `dsh.bundle.patch` 是否装了 local-task 预设 |
| `TASK_TOOL_SURFACE_UNSAFE` | QQ 回执（点名越界工具） | 改回 preset 装配行，任务不要重试 |
| `TASK_SESSION_CREATE_FAILED` / `TASK_PROMPT_REJECTED` | QQ 回执 | 看原生会话日志；任务已标 failed，不自动重试 |
| `TASK_SESSION_MISSING` / `TASK_SURFACE_UNREADABLE` | QQ 回执 | 重启 DSH 后重发任务 |

## 发布交接块

```
批次：2026-11-17 本机任务 T04（会话编排）
覆盖提交：见下方 git log 最新 commit（`[新功能] 本机任务会话编排`）
改了什么：新增 local-task preset（只有 read/write + 闸门）、runner（一任务一专用会话、
          先装配校验后送 prompt、事件投影、停止屏障）、host 接线（storageDomain + session/event）。
影响谁：只在 QQ 派发本机任务时生效；未改 QQ 聊天/B站/记忆链路。
验证：test-local-task-{service,gate,runner,host}.mjs 全绿；test-agent-preset-patches --check 通过；
      npm run test:audit 207/207。
注意：preset 是装载期读取，升级后需重启 DSH；真实进程端到端验收在 T07 做。
```
