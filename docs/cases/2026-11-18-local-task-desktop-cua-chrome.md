# 复用 DSH CUA + 隔离 Chrome DevTools MCP + QQ 聊天委派与交互确认（2026-11-18）

## 现象

- 用户目标：能够在 QQ 中直接和红豆自然对话，让红豆帮自己操作 macOS 电脑（原生应用、本地文件/命令）和 Google Chrome 浏览器，并且尽可能复用 DSH（`0.2.2-rc.3`）官方自带能力。
- 此前差距：
  1. 本机任务仅限 `local-task` 预设的「仅工作区只读/新建文件」模式（无 `bash`、无 CUA、无 Chrome），且完成后仅回传状态和会话号而无 `assistant/message` 结果摘要；
  2. DSH `desktop` profile 未注册 `@deepseek-ai/dsh-cua-bundle` 与隔离的 `chrome-devtools` MCP，且 `qq-tool-restrict.mjs` 未对全局新挂载 MCP 做动态屏蔽；
  3. 后台任务运行中遇到 DSH 的 `user-questions/request`（如 `cua-app-access`、`cua-mouse-control`、`ask_user_question`）与 `approval/request`（沙箱升权）时无主人端应答渠道；
  4. QQ 主人私聊（`NativeOwner`）除显式 `本机任务：…` 命令外，没有受控的后台任务转交工具。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DeepSeek Harness `0.2.2-rc.3` |
| SurfCore 版本 | `0.9.0-dev.2`（`feat/local-task-t01t08`） |
| 安装方式 | git 工作树 `/Users/shizihan/Daily/Github/surfcore-local-task` |
| 其它相关组件 | Chrome Stable + `chrome-devtools-mcp`（stdio） |

## 根因

1. `dsh-cua` 官方明确 `browser: false`，专注原生桌面 UI/AX 控制；网页自动化官方建议配独立浏览器通道。
2. `dsh-tools` 中 `ptc` 预设启用 `PtcExecutor` 后，`tools.schemas(agent)` 只返回 `run_code`，真实工具定义在 `tools.definitions(agent)`；且 `tools.restrict()` 只管继承工具、不管第三方注入 `agent.ctx` 的 `own.tools`（如 `clutch_*`）。
3. `qq-v2-native-ledger` 与 `qq-v2-native-owner` 对暴露给模型的 `toolSpecs` 严格按工具名字母序和 `parameters` 结构比对哈希，任何字段或顺序漂移都会被 `MEMORY_NATIVE_INPUT_UNPROVEN` 拒收。

## 完整逻辑（给用户看的那一遍）

- **链路**：
  - 自然对话委派：`src/bridge.js`（仅 `private:<ownerQQ>` 的 `getNativeQQCapabilities` 返回 `localTask.enabled=true`）→ `plugins/surfcore/lib/qq-v2-reply-host.mjs`（注入 `qq_dispatch_local_task`，通过 `qq-v2-native-ledger` 校验）→ `plugins/surfcore/lib/index.js` → `local-task-service.mjs` & `local-task-runner.mjs`；
  - 显式命令与确认：`src/bridge.js` `handleOwnerLocalTask`（调用 `parseLocalTaskIntent` / `local-task-client.js` → `local-task-api.mjs` → Host `local-task-interactions.mjs`）；
  - 桌面与浏览器执行：`local-task-runner.mjs`（按 `task.mode` 在 `'ptc'` 与 `'local-task'` 间选preset，抓取 `assistant/message` 更新 `resultSummary`）→ `local-task-gate.mjs` `mountDesktopGate`（按 `ownsSession` 隔离 owned `ptc` 会话，放行 `cua`/`bash`/`fs`/`mcp__surfcore-chrome__*`，限制与清理 `mcp__chrome-devtools*`/`mcp__snowluma*`/`subagent*`/`schedule_*`/第三方插件工具，不碰用户手动 `ptc` 会话）→ `src/mcp-chrome-devtools.js`（以 `serverName: 'surfcore-chrome'`、专属 `--user-data-dir=<DSH_HOME>/surfcore/chrome-profile` 拉起 `chrome-devtools-mcp`，避免与 `dsh-mcp-connector` 既有 `chrome-devtools` 冲突）；
  - 结果与确认回传：`local-task-host.mjs` / `local-task-interactions.mjs` → `src/bridge.js` `/api/notify/owner`（送达确认后若带 `taskResult` 则同步进 `recordSentMessagesV2`）。
- **机制**：
  - **浏览器隔离（A1）**：`src/mcp-chrome-devtools.js` 使用独立 `serverName: 'surfcore-chrome'` 并可复用 `<DSH_HOME>/dsh-runtimes/desktop-mcp-local` 本地缓存，拒绝任何个人 Chrome User Data 目录（`CHROME_PROFILE_PERSONAL_FORBIDDEN`）与 `--auto-connect` / `--browserUrl` / `--wsEndpoint` 参数（`CHROME_DEVTOOLS_CONNECT_FORBIDDEN`）；`qq-tool-restrict.mjs` 在 `tools.schemas(undefined)` 上动态 `restrict({ deny })` 并于 `guard()` 拦截非白名单工具，保证 32 个 `mcp__surfcore-chrome__*` 工具只存在于桌面任务而绝不进入 `qq-chat-v2`。
  - **交互确认瀑布流（A2）**：`local-task-interactions.mjs` 以 `{ prepend: true }` 拦截仅属于 `ownsSession` 的 `user-questions/request`（`cua-app-access` / `cua-mouse-control` / `ask_user_question`）和 `approval/request`，生成不与桥接 8 位 hex 冲突的 `t`+7 位十六进制编号通知主人私聊（并同步展示于设置页），支持 `通过 t<hex>` / `始终允许 t<hex>` / `拒绝 t<hex>` / `t<hex> <回答>`；非自有会话调用 `next()` 原样透传给原生 DSH UI。
  - **模式兼容与单一真相**：`store.js` 默认 `localTask: { mode: 'desktop', chatHandoff: true, chromeProfileDir: '' }`；Host 通过 `local-task-api.mjs` 的 `getDefaultMode()` 解析默认值，保留 `files-only`（`文件任务：…` 或设置页切换）作为严格模式，全部 P0/P1 存储隔离、FIFO、预算、`createIfAbsent`（仅 `files-only`）与未确认停止保护继续生效。
- **爆炸半径**：新增全局注册的 `mcp-chrome-devtools` 与 macOS `desktop` bundle `@deepseek-ai/dsh-cua-bundle` 通过 `qq-tool-restrict.mjs` 与 `mountDesktopGate` 分别在 `qq-chat-v2` 与非任务/任务会话间隔离；群聊及非主人私聊 `localTask.enabled` 恒为 `false`；不触碰个人 Chrome 浏览器及登录态；`cua` 控制新应用前经 macOS TCC 与主人 QQ 确认双闸。
- **取舍**：
  - Chrome 方案选隔离 Chrome Profile + 官方 `chrome-devtools-mcp`（复用 `dsh-mcp-client`），放弃直接复用个人日常 Chrome `9222` 调试端口（避免泄露已登录会话）；
  - 电脑操控选复用 DSH 官方 `ptc` + `dsh-cua-bundle`（per-session `mountDesktopGate` 降权），放弃自建执行器（不重复造轮子、完整保留官方 CUA/沙箱/审批审计）。
- **生效与重启**：运行 `node scripts/setup-dsh.mjs desktop` 写入新 MCP 与 `@deepseek-ai/dsh-cua-bundle` → 重启 DSH（加载插件、`ptc`/`cua`/`chrome-devtools` 与 `qq-tool-restrict`）与重启 QQ 桥接（加载 `bridge.js`/`local-task-intent`/`local-task-client`）；并在 macOS 首次执行桌面控制时按需在系统设置授予 `DSH Computer Use`「辅助功能」「屏幕录制」权限。
- **回滚与残余**：设置页把默认模式切回 `仅限工作区新建文件` 并关闭「主人私聊自然委派」即可免代码降级；完整代码回退可 `git revert` 本批提交并重跑 `setup-dsh.mjs`。自动化已覆盖单元与隔离真宿主（含 real DSH `0.2.2-rc.3` 启动、`chromeCount=32`、`cua`、`user-questions/request`），真实 LLM 调 `cua`/`chrome-devtools` 完成端到端网页与 Mac UI 操作（含 TCC 弹窗）待真机验收。

## 修法

- 新增：`src/mcp-chrome-devtools.js`、`plugins/surfcore/lib/local-task-interactions.mjs`、`plugins/surfcore/scripts/test-local-task-desktop.mjs`、`scripts/test-local-task-desktop-host.mjs`
- 修改：`scripts/setup-dsh.mjs`、`plugins/surfcore/qq-tool-restrict.mjs`、`plugins/surfcore/lib/local-task-gate.mjs`、`plugins/surfcore/lib/local-task-service.mjs`、`plugins/surfcore/lib/local-task-runner.mjs`、`plugins/surfcore/lib/local-task-host.mjs`、`plugins/surfcore/lib/local-task-api.mjs`、`plugins/surfcore/lib/store.js`、`plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`、`plugins/surfcore/lib/qq-v2-reply-host.mjs`、`src/core/local-task-intent.js`、`src/core/local-task-client.js`、`src/bridge.js` 及配套测试脚本。

## 交接块

```
【改动摘要：2026-11-18 本机任务桌面全能 + Chrome DevTools MCP + QQ 聊天委派 + 截图/文字回传与异步派发修复】
- 分支：feat/local-task-t01t08（surfcore-local-task）
- 内容：
  1. Chrome：新增 src/mcp-chrome-devtools.js 并在 setup-dsh.mjs 挂载，强制隔离专属 Chrome Profile，qq-tool-restrict.mjs 动态屏蔽非白名单全局 MCP；
  2. Desktop/CUA：setup-dsh.mjs macOS desktop profile 启用官方 @deepseek-ai/dsh-cua-bundle；local-task 支持 desktop(ptc)/files-only(local-task) 双模式，mountDesktopGate 仅收敛自有 ptc 会话并捕获 assistant/message 摘要；local-task-interactions.mjs 将 CUA/沙箱确认与 ask_user 桥接至主人 QQ（t<7hex>）及设置页；
  3. QQ 自然对话：仅对 private:<ownerQQ> 在 NativeOwner 开放单工具 qq_dispatch_local_task，严格隔离群聊与非主人；
  4. 任务结果回传与异步派发（二轮实机验收修复）：
     - src/sensitive.js 新增 hasSensitiveTaskOutput / isUnsafeTaskFilePath，/api/notify/owner 在 taskResult 时放行工作区/桌面常规路径并仍严格拦截 Secret/凭据/系统/密钥库目录与不安全扩展名；
     - src/bridge.js + local-task-runner.mjs + local-task-host.mjs + local-task-service.mjs 打通安全校验后的截图 extractTaskImagePaths 与 OneBot text+base64://image 发送，保留 4xx/5xx 结构化 code/hint 与插件日志，并引导优先写工作区且合并多步越界命令以减少重复授权弹窗；
     - plugins/surfcore/lib/index.js 启用 dispatch(..., { background: true }) 异步派发以避免阻塞 qq-v2-native 30s prepared 窗口；
     - memory-v2-agent-budget.mjs / qq-v2-native-owner.mjs / qq-v2-reply-host.mjs / bridge readOfficialMemoryQQIdentity 通过不可枚举 cause 与白名单 code/stage 保留真实阻断/调用根因而不向 JSON 或 QQ 泄露原始异常文本。
- 实机生效：需重跑 node scripts/setup-dsh.mjs desktop（若尚未装好）并重启 DSH 与 src/bridge.js；若需 CUA 操控桌面应用，确保 macOS 已允许 DSH Computer Use 辅助功能与屏幕录制权限。
```

---

## 二轮实机验收问题修复完整逻辑（2026-11-18 下午）

### 现象
1. 真 QQ 私聊派发「打开 example.com 并截图」与「保存到桌面」任务后，DSH 内均已 `succeeded` 且截图文件已落盘，但主人 QQ 既未收到总结文本，也未收到截图。
2. `task-mwlinwt4-itu5b8` 出现两次 `bash` `danger-full-access` 审批（`tccec730` 与 `tea396fd`）。
3. 同一分钟 `plugin.log` 记录 `MODEL_INVOKE_FAILED`（`02:40:12`）与 `MODEL_NOT_AUTHORIZED`（`02:43:08`），但日志未显示深层 `cause`；无任务运行 3 小时（错觉来自本对话内部终端探针命令等待）。

### 完整逻辑（七步）
1. **链路**：
   - 结果回传链路：`local-task-runner.mjs`（抓取 `assistant/message` 与 `tool/result` 图片路径 → `service.finish` 记录 `resultSummary` & `resultImages`）→ `local-task-host.mjs` `deliver` → `src/bridge.js` `POST /api/notify/owner`（校验 `hasSensitiveTaskOutput` & `collectTaskNotifyImages` → `bot.sendPrivateMessage(..., [text, image(base64://...)])` 携带 `managementSendTickets`）；
   - 自然委派链路：`qq-v2-reply-host.mjs` `qq_dispatch_local_task` → `plugins/surfcore/lib/index.js` `dispatchLocalTask` → `local-task-runner.mjs` `dispatch(taskId, { background: true })` → 异步 `sessionController.create/prompt`；
   - 诊断链路：`qq-v2-source-runtime.mjs` / `model-call-admission.mjs` → `memory-v2-agent-budget.mjs`（非枚举 `cause` 带安全 `code`/`stage`）→ `qq-v2-native-owner.mjs` → `qq-v2-reply-host.mjs` `report()`（非枚举 `diagnostic`）→ `plugins/surfcore/lib/index.js` `reportMemoryBlocked` → `plugin.log`。
2. **机制**：
   - `src/sensitive.js` `SENSITIVE_RE` 会无差别拦截所有 `/Users/...` 与 `/home/...` 路径，而桌面/浏览器任务结果必定汇报产出文件路径，导致 `/api/notify/owner` 对正常完结消息稳定返回 `403 NOTIFY_SENSITIVE`；同时 `local-task-host.mjs` 把所有非 2xx 错误统一吞成 `LOCAL_TASK_DELIVERY_UNCERTAIN` 且不写日志。
   - `dispatchLocalTask` 原来同步 `await runtime.runner.dispatch(taskId)`，将 Chrome MCP / PTC 建会话的 ~5 秒阻塞串进 `qq-v2-native` 两步回合（Step 1 工具调用后才准备 Step 2 回复），直接压缩 `memory-v2-store.js` 的 30 秒 `prepared` 窗口。
3. **爆炸半径**：
   - `/api/notify/owner` 只对带合法 `task-` 编号的 `taskResult` 启用 `hasSensitiveTaskOutput`，日记/通用通知仍维持原 `SENSITIVE_RE`；所有任务文本仍拦截 `SECRET_TOKEN_RE`、凭据赋值、系统目录、点目录（`.ssh/.aws/.env`）、密钥扩展名及浏览器 Cookie/Keychain 路径；附图使用 `fs.realpathSync` + `acceptImageBuffer`（魔数+像素+总字节上限）+ `base64://` 发送，防符号链接越界与 Docker 宿主机路径不可达。
   - 诊断字段挂在不可枚举属性且只抽取 `[A-Za-z0-9_.:-]` code/stage 令牌，不改 `JSON.stringify` 输出、不泄露原始异常/Secret 文本。
4. **取舍**：
   - 选择新增 `hasSensitiveTaskOutput` / `isUnsafeTaskFilePath` 专用于 `taskResult`，而不是放宽全站 `SENSITIVE_RE`（避免削弱其它出站渠道路径审计）；
   - 选择保留 `background: false` 默认值，仅 `qq_dispatch_local_task` 传入 `{ background: true }`，既消除 QQ 30s 窗口竞争，又不打破既有 `dispatch()` 同步单测契约，并在 `sessionController.create` 返回后复核 `requireRunning` 防止取消竞态。
5. **生效与重启**：改动位于仓库源码（`src/` 与 `plugins/surfcore/lib/`），需重建/确认 DSH 插件指向并重启 DSH 与 `src/bridge.js` 后生效。
6. **验证**：`test-audit-security.mjs`（含大小写与 `Library` 敏感路径）、`test-notify-channels.mjs`、`test-local-task-host.mjs`（403 结构化透传）、`test-local-task-desktop.mjs`（截图提取去重、异步派发、安全诊断码无泄露）、`test-local-task-desktop-host.mjs`（真 DSH + 真 Bridge `/api/notify/owner` 图文回传与越界拦截）、`npm run test:regressions`、`npm run test:audit` 与 `release-manifest.mjs --verify-ref HEAD`。
7. **回滚与残余**：`git revert` 可完整回退；修改完成后可对历史 `task-mwlinwt4-itu5b8` 执行补发或在 QQ 私聊重新实测验证真实图文送达。
