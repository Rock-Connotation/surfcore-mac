# G7 第二阶段：把 SurfCore 装进隔离实例的真实宿主验收

> 日期：2026-11-15 · 分支 `feat/g7-phase2-host-acceptance`（基于 `dev` @ `a234f4b` = `v0.9.0-dev.1`）
> 新增/改动：`scripts/test-surfcore-isolated-host.mjs`（新增，进 Darwin 门禁块）、`scripts/test-audit.mjs`（+3 行接线）
> 目标：回答"SurfCore 真能被装进一个干净 DSH 实例并在真实宿主里活起来、退出后不留后代吗"——用真实打包宿主 + 隔离 `DSH_HOME`，不碰用户安装与 3100 桥接。

## 1. 现象与背景

`docs/guides/DEV-TESTING.md` §0 要求测试机用独立 `DSH_HOME`（SurfCore 的 config/state 在 `~/.dsh/surfcore`）。但"独立 DSH_HOME 里装 SurfCore"此前**只被离线单元测试覆盖**：`scripts/test-memory-v2-host-runtime.mjs` 能起真实打包宿主，却不装 SurfCore 插件本体；`plugins/surfcore/scripts/*` 的宿主替身从不进入真实 loader。于是"插件在真实宿主里激活"这件事一直没有首手证据。

本批新增 `scripts/test-surfcore-isolated-host.mjs`：在 `os.tmpdir()` 的 fixture 里建一个隔离 `HOME`/`DSH_HOME`，用 `scripts/setup-dsh.mjs` 把本工作树的 `plugins/surfcore` 装进 profile `isolated-host`，再用 `@deepseek-ai/dsh-desktop-host` 起**真实应用二进制**，观察真实 loader 是否激活插件、停止后是否留后代、守门进程内是否有非回环外联。

## 2. 完整逻辑

### 2.1 链路

- 安装：`scripts/setup-dsh.mjs <profile>` → `<dshHome>/plugins/surfcore` 软链 + `<dshHome>/profiles/<profile>/node_modules/surfcore` 软链 + profile `package.json` 的 `dependencies.surfcore`/`dsh.profile.bundles` → `dsh plugin --profile <profile> install`。
- 启动：`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals --import <guard> <runtimeDir>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtimeDir> <project> <source>`（`ELECTRON_RUN_AS_NODE=1`，stdio 带 `ipc`）。
- 观察点：①IPC `ready` 消息里的 `hostname`/`port`/`authenticatedUrl`；②宿主 stdout 的 loader 行（`<id> (<name>): pending|failed|...`）；③`[surfcore] 已激活 …` 日志；④`ctx.webServer` 注册的 `/dsh-surfcore/health`；⑤shutdown 后 `exit` 与后代进程；⑥守门进程记录的 `denied` 与 `lsof` 采样。
- 读者：本脚本只写 fixture，删自己；`scripts/test-audit.mjs` 只在 `process.platform === 'darwin'` 时运行它。

### 2.2 机制与两个真实前提

1. **基座 bundle 不能缺**：真实桌面 profile（`~/.dsh/profiles/desktop/package.json`）的 `dsh.profile.bundles` 有 17 项，**前两项是 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`**。SurfCore 的 `inject = ['webServer','connection','sessionController']`（`plugins/surfcore/lib/index.js:203`）要由基座提供；只写 `['surfcore']` 时 loader 会把插件行标成 `pending (waiting for service: sessionController)`，宿主直接 `startup failed: 1 required plugin did not activate`。`scripts/setup-dsh.mjs` 只 push `surfcore`（`:404`/`:429-430` 附近），**不会补基座**——真实 profile 的基座是 DSH 自己创建 profile 时写的。
2. **不要重复声明基座已提供的服务**：脚本第一版在 profile patch 里手工插了 `gate-webserver`(`@deepseek-ai/dsh-host-webserver`)、`gate-credentials`(`@deepseek-ai/dsh-credentials-local`)、`gate-connection`(`@deepseek-ai/dsh-client-connection`)。基座 bundle 已经注册这三个服务 → 宿主报 `service "webServer" has been registered at <WebServer>` 并 startup failed。修法是只插自己的探针行 `{id:'surfcore-acceptance-probe',name:'./probe.mjs',config:{}}`。

### 2.3 守门（隔离网络边界）

`--import` 的 guard 只在**加载它的 Node 进程**里替换 `net.Socket.prototype.connect` / `tls.connect` / `dgram` / `fetch`。三处必要修正：①`loop = h => h==='127.0.0.1' || h==='localhost' || h==='::1'`（`localhost` 与缺省 host 都要放行，否则野外会出现 `isolated gate denied tcp:undefined` / `tcp:localhost` 的误判）；②`x.path` 存在（unix IPC）一律放行；③明确写出未覆盖面：`guardScope.notCovered = ['electron/chromium children','non-node children']`。用户已授权（本会话 ask_user_question）：隔离宿主允许其自身出站（更新检查/DNS），因为隔离 profile **无账号、mode 保持 `reserved2`、不发真实消息**。

### 2.4 爆炸半径

- 只读/隔离：fixture 在 `os.tmpdir()`，profile 只在 fixture 内；不写真实 `~/.dsh`；不碰用户安装版（`~/.dsh/profiles/desktop`）与 3100 桥接；不改 `state/mode.json` 的 `reserved2`。
- 真实进程：应用二进制 + 一个宿主进程 + 装载的插件（SurfCore/qq-mode/探针）；`env.environmentSideEffects` 记录两份补丁（`plugins/surfcore/presets/qq-chat-v2.patch.yml`、`plugins/surfcore/cordis.patch.yml`）装前装后 sha256 **未变化**。
- 花钱/账号：无。离线 provider 未挂账号。

### 2.5 取舍（为什么这么做）

- A（采纳）：隔离 `DSH_HOME` + 真实打包宿主 + 自己的只读探针插件行。收益=首手证明"真宿主真激活"；成本=~22s/次、需要基座 bundle；风险=应用升级后 host 入口路径变化（脚本会明确失败）。
- B（否决）：只跑 `scripts/test-memory-v2-host-runtime.mjs`（不装 SurfCore）→ 证明不了插件激活。
- C（否决）：真的启一个用户可见的 DSH 桌面实例 → 会碰 Electron 单实例/用户数据（`docs/PITFALLS.md:4024` 明确不可声称零触碰），且不可自动化。

### 2.6 生效与重启

无需重启任何产品进程：这是一个门禁脚本。改动生效方式是"下一次 `npm run test:audit` 会带上它"。

### 2.7 验证与失败路径

- 命令：`node scripts/test-surfcore-isolated-host.mjs`（自带 node v24.21.0）；门禁内由 `scripts/test-audit.mjs` 以 60s 超时调用。
- 失败路径：任一 AC 断言失败 → `record.ac[ACn] = {status:'FAIL', error}` → `process.exitCode = 1`；`finally` 里 kill 后代 + 删 fixture + 写 `result.json`；环境类阻断（HTTP 401 / 页面渲染不到）**记 `status:'环境阻断'`，不判红也不伪装通过**。

## 3. 验收项与结果（最终 sha256 `1d852e907ba43ac108129e03af4bf434d02a84b01701a234023c50b5f2f052bc`）

| AC | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| AC1 | 隔离安装成功 | PASS | `dsh plugin --profile isolated-host install: OK`；`<profile>/node_modules/surfcore` realpath = `<worktree>/plugins/surfcore` |
| AC2 | 真实宿主 ready | PASS | IPC `ready`：`127.0.0.1:<临时端口>` + token（非 3100/59783）；探针回报 `execPath`=应用二进制、`node v24.21.0`、`darwin`/`arm64` |
| AC3 | 真实 loader 激活插件 | PASS | loader ids 含 `surfcore`、`qq-mode`、`surfcore-acceptance-probe`；日志 `[surfcore] 已激活 v0.9.0-dev.1；surfcore=$DSH_HOME/surfcore；biliTools=…/tools/bili.mjs；privacy=v3` |
| AC4 | `GET /dsh-surfcore/health` → 200 | 环境阻断 | 六种认证方式（no-auth / `?token=` / Bearer / `x-dsh-token` / 登录根取 cookie / 带 cookie 复访）**全部 401**；路由注册由 AC3 的 loader 行 + 激活日志证明 |
| AC5 | Chromium 页面渲染 | 环境阻断 | `playwright-core` 能启动（`findBrowser()` 命中），`page.goto(ready url)` 后 `getByText('SurfCore')` 4s 超时 |
| AC6 | shutdown 干净、无残留 | PASS | 宿主 `exit {code:0,signal:null}`；`descendants` 3 个 PID 全部退出；`remaining: []` |
| AC7 | 守门进程内零非回环外联 | PASS | `denied: []`；`lsof -nP -a -p <hostPid> -i` 在 ready 与 shutdown 前两次采样都只有表头；`guardScope.notCovered` 已写明 |
| AC8 | 证据落盘与清理 | PASS | `result.json`（含各 AC 状态/messages/exit/durationMs/guardScope）写入 `os.tmpdir()`，fixture 已删 |
| AC9 | 反向重放（证明断言非空） | Lead 执行 | 见 §4 |

宿主日志另有 2 条与 SurfCore 无关的未激活项：`desktop-product-telemetry`（`$.serviceVersion missing required value`）、`product-analytics`（`pending (waiting for service: productTelemetry)`）——离线隔离 profile 缺少 DSH 应用内部遥测行。

## 4. 反向重放（AC9）

- 基线 sha256 `1d852e907ba43ac108129e03af4bf434d02a84b01701a234023c50b5f2f052bc`。
- 红：把 profile bundles 改成 `['surfcore']` → `RED_EXIT=1`，宿主在 `@deepseek-ai/dsh-desktop-host` 的 `main` 抛 `TypeError: Cannot read properties of undefined (reading 'authenticatedUrl')`，`AC2 FAIL`（`AC1` 仍 PASS）→ 证明"基座 bundle 前提"与 AC2 断言真的是承重的。
- 绿：`cp` 还原 → sha256 **逐字一致** → 复跑 `GREEN_EXIT=0`、6 个 `status: PASS`（AC1/AC2/AC3/AC6/AC7/AC8）。

## 5. 门禁接线

`scripts/test-audit.mjs` 的 `if (process.platform === 'darwin')` 块内、`tests.push('test-package-patch-anchor.mjs');` 之后新增 `tests.push('test-surfcore-isolated-host.mjs');`（附中文注释）。跑 `npm run test:audit` → **`Audit suite: 207/207 scripts passed.`**（此前 206；单脚本超时 60000ms，本脚本 ~22s）。

## 6. 已知残留 / 未验证

- AC4/AC5 的"环境阻断"只是**当前方式的**结论：DSH web 面的会话 token 由桌面外壳经 IPC 注入，测试进程复现不出。要在真外壳内验证 HTTP 面与页面渲染，需要另开"桌面外壳内的只读验收"（未做）。
- 守门只覆盖被 `--import` 的 Node 进程；Electron/Chromium 子进程与非 Node 子进程未做系统级网络审计（未引入 `sandbox-exec`/新依赖）。
- `scripts/setup-dsh.mjs` **不会**替用户补 `@deepseek-ai/dsh-base`/`dsh-web-app`：若哪天要用它给一个全新 profile 装 SurfCore，必须保证该 profile 已有基座 bundle（否则插件行 `pending`）。本批只把这件事写进 PITFALLS，未改安装器（改安装器会影响真实用户路径，需单独评估）。
- 长 TTS 跨轮询、DM 子进程退出、切角色/卸载的用户可见路径仍需真实 QQ/B站账号链路，未做。
- `plugins/surfcore/lib/memory-v2-host.mjs:220-223` 取回路径不校验 `frameSamples ∈ 0..3`（沿用上一轮残留）。

## 7. 回滚

- 回滚 = 删 `scripts/test-surfcore-isolated-host.mjs` + 去掉 `scripts/test-audit.mjs` 里那一行 `tests.push`。无数据面影响（脚本自清理，不写用户目录）。
