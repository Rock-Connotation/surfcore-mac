# G7 Mac 实机取证（非侵入）：CLI 包装进程的孤儿后代与 SIGTERM 修复

> 批次：2026-11-15 · G7 实机（非侵入项 + 孤儿进程取证）。工作树 `/Users/shizihan/Daily/Github/surfcore-r4`（`feat/v1-retirement-r4`）。
> 用户定的边界：**不启动任何新实例**（不启隔离 profile、不启桥接、不发真实消息、不扫码），只做只读取证；对实机孤儿按批准逐个清理。
> 现场原始证据：`/tmp/g7-orphan-evidence-20261115.txt`（只读捕获，61 行）。

## 现象

- 本机（macOS 26.6.2 / Apple Silicon）有 **5 个 `PPID=1`（被 launchd 收养）的 B站 CLI 孤儿进程**，最早一个已存活 1.9 天：
  - `1494` `/…/surfcore-mac/plugins/surfcore/tools/commands/dm-await.mjs --once --json`（Fri Nov 13 17:06:23 起）；
  - `8988` `/…/surfcore-v1-retirement-r3/plugins/surfcore/tools/bili.mjs dm-await --once --json`（Sat Nov 14 13:19:07 起）；
  - `20533` / `21860` / `49108` 均为 `/…/surfcore-v1-retirement-r3/…/commands/dm-await.mjs --once --json`（Fri Nov 13 17:49:47 / 17:37:05 / 17:39:24）。
  - 5 个都是 `STAT=S`、CPU 累计约 3.2–3.9 秒、`lsof -a -p <pid> -i` 全空（**没有任何 socket**）——即"活着但不干事"。
- 另有一个**不属于本轮清理范围**的常驻进程：`51037` `~/.dsh/profiles/desktop/node_modules/surfcore/src/bridge.js`（Fri Nov 13 16:13:24 起，CPU 1:02.60，RSS 28016 KB），仍在 `127.0.0.1:3100 LISTEN`。这是用户自己安装的桥接控制台，按用户批准**不动**。
- 复现步骤（只读）：`ps -eo pid,ppid,stat,lstart,time,rss,command | grep dm-await`；`lsof -nP -a -p <pid> -i`；对孤儿发 `kill -TERM <pid>` 观察是否退出。
- 影响面：这些孤儿本身不再产生副作用（无 socket、无子进程），但它们**证明"停止/退役/卸载"没有真正收回 CLI 后代**；这类进程会跨工作树、跨插件更新一直占着 PID 与内存，且在下一个复核周期里被当成"还有活在跑"的假信号。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS 26.6.2（BuildVersion 25G83）/ Apple Silicon（Darwin 25.6.0 arm64）；DSH 桌面应用**正在运行**（Electron 主体 + 辅助进程 + `--user-data-dir=/Users/shizihan/Library/Application Support/@deepseek-ai/dsh-desktop`；另有 `MacOS/DeepSeek Harness … stdio-startup-guard.js` 拉起的 chrome-devtools-mcp / cloudbase-mcp） |
| Node | 实机 CLI 用的是 **DSH 自带 node `…/primary-runtime/dependencies/node/bin/node`（v24.21.0）**（5 个孤儿的命令行逐字如此）；系统 node 是 v26.5.1；`package.json` 要求 `>=22.13.0` |
| SurfCore 版本 | 源码工作树 `surfcore-mac`（`feat/v1-retirement` @ `b7316ca`）与 `surfcore-v1-retirement-r3`（@ `9d7e235`）；用户安装副本 `~/.dsh/profiles/desktop/node_modules/surfcore/` |
| 安装方式 | git 工作树 + 用户安装副本（junction/复制，未改动） |

## 根因

- 代码位置：`plugins/surfcore/tools/bili.mjs:79-88`（修复前的写法）。
- 问题链条：该文件是**转发型包装进程**（`bili.mjs <命令>` → 用 `process.execPath` spawn 真正的 `tools/commands/*.mjs`）：

  ```js
  let child
  let pendingSignal
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    pendingSignal = signal
    if (child) { try { child.kill(signal) } catch {} }      // 只转发，不退出
  })
  child = spawn(process.execPath, [path.join(here, entry[0]), ...rest], { stdio: 'inherit' })
  if (pendingSignal) { try { child.kill(pendingSignal) } catch {} }
  child.once('error', () => { process.exitCode = 1 })        // 只设码，不退出
  child.once('close', (code) => { process.exit(code ?? 1) }) // 唯一退出路径
  ```

  包装进程**没有任何自己的退出路径**：收到 `SIGTERM` 只把信号转发给子进程，自己继续等 `'close'`；子进程若不可中断（或已消失、`'close'` 不再触发），包装进程就永久存活。父进程（scheduler / DSH 会话）退出后它被 launchd 收养 → `PPID=1` 孤儿。
- 实机佐证：`8988` 收到 `SIGTERM` 后 3 秒仍存活，`STAT=S`、**无子进程**、`lsof -a -p 8988 -i` 空（见证据文件第 43–49 行）。
- 为什么之前没发现：现有测试只覆盖"子进程正常退出"（`'close'` 路径），没有任何测试**对包装进程本身发信号**；门禁在 Linux 跑，孤儿不在 CI 里产生；审计文档里 F04 的"CLI 后代"缺陷此前只在离线替身里验过（`test-bili-scheduler-retire-r2.mjs` 只检查 `retire.ok` 与 tick Promise 排空），实机现场这轮才第一次捕到。

## 完整逻辑（给用户看的那一遍）

- **链路**：`plugins/surfcore/tools/bili.mjs` 是 CLI 入口（`node bili.mjs <命令> [参数]`）。上游有两类调用者：① `plugins/surfcore/lib/scheduler.js:414` 的 `execFile(NODE_RUNTIME.executable, [...argvPrefix, biliMjs, ...args], { timeout: 120_000, signal: childController.signal })`（退役/取消时 abort）；② 人或其他脚本直接跑（本轮 5 个孤儿里至少 2 个来自不同工作树的手工/会话调用）。下游是 `tools/commands/*.mjs`（如 `dm-await.mjs`）。读这个文件的人：`plugins/surfcore/lib/scheduler.js`、`plugins/surfcore/scripts/test-bili-media-no-history.mjs`、`plugins/surfcore/scripts/test-bili-dynamic-receipt.mjs`、`scripts/test-share-dynamic.mjs`；它也在发布清单里（`release/install-manifest.json` 命中 1 次），属出货文件。
- **机制**：这是**所有权契约**问题，不是"哪行写错了"。包装进程对外的契约是"我在，`<命令>` 就在跑"；它必须保证：调用者终止我 → 我终止我的子进程 → **我在有界时间内退出**。旧实现只做了第二步转发，把"我什么时候退出"完全交给子进程的合作程度——子进程不合作（或已经不在了）时契约塌掉。注意 `child.once('error')` 只设 `process.exitCode` 而不退出，这在"spawn 失败"时靠 `'close'`（Node 在 spawn 失败时也会发 `'close'`，实测 `code=-2`）侥幸收场，但它说明这条链路的退出完全寄生在子进程事件上。
- **爆炸半径**：进程数 × 读者数 ×（静默=3/报错=1）= 2 类调用者 × 4 个读者 × 3（静默：孤儿不报错、不落日志、只占内存）= **高**。不碰用户数据、不碰密钥、不花钱。反向影响面很小：唯一可观察的行为变化是"包装进程自己被信号终止时退出码"（旧：子进程码或 1；新：128+signal）。
- **取舍**：
  - **A（本轮采用）**：包装进程自己保证有界退出——收到 `SIGTERM`/`SIGINT` 先转发，`GRACE_MS=3000` 后升级 `SIGKILL`，再 200ms 后自己 `process.exit(128+signal)`；`'close'` 里若本次已被信号终止，退出码用 128+signal。收益：覆盖**所有**调用者（scheduler 与手工调用一视同仁）；不要求子进程合作；改动 4 行。成本/风险：几乎为零（多两个定时器）。
  - **B**：让 scheduler 用进程组杀（`detached: true` + `process.kill(-pid)`）。收益：能连带孙进程。成本/风险：只覆盖 scheduler 这一条调用路径（本轮孤儿里就有非 scheduler 来源），`detached` 会改变子进程会话/信号语义，`kill(-pid)` 还有误伤同组进程的风险。**否决**。
  - **C**：让每个 `tools/commands/*.mjs` 自己注册信号处理并退出。收益：语义最清晰。成本/风险：要改 N 条命令；而且卡在不可中断等待里的子进程照样不合作——本轮 8988 的现场恰恰是"子进程已不在"的情形，C 对它无效。**否决**。
- **生效与重启**：`bili.mjs` 每次调用都是**新起一个进程**，所以源码修复对**之后**的每次调用立即生效，不需要重启 DSH。两点必须说清：①**已经在跑的孤儿不会自愈**——它们是旧代码起的进程（本轮已按用户批准逐个清理：4 个 `SIGTERM` 即退，`8988` 拒绝 `SIGTERM`，补 `SIGKILL` 后退）；②用户机器上真正运行的是**安装副本** `~/.dsh/profiles/desktop/node_modules/surfcore/`（`51037` 就是它），本仓库的修复要等下次安装/更新才带过去——本轮**没有**改动用户安装副本，也没有重启它。

## 修法

- 改了什么（`plugins/surfcore/tools/bili.mjs`，修复后）：

  ```js
  // 转发型包装进程：收到信号必须自己退出，不能只靠子进程的 'close' 事件。
  // 2026-11-15 G7 实机：子进程不可中断或已消失时，旧写法让包装进程永远活着（被 launchd 收养成 PPID=1 孤儿）。
  const GRACE_MS = 3000
  const exitCodeFor = (signal) => (signal === 'SIGINT' ? 130 : 143)
  let child
  let pendingSignal
  let hardStop
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    pendingSignal = signal
    try { child?.kill(signal) } catch {}
    if (!hardStop) hardStop = setTimeout(() => {
      try { child?.kill('SIGKILL') } catch {}
      setTimeout(() => process.exit(exitCodeFor(signal)), 200)
    }, GRACE_MS)
  })
  …
  child.once('close', (code) => { process.exit(pendingSignal ? exitCodeFor(pendingSignal) : (code ?? 1)) })
  ```

- 为什么选这个方案：缺陷在包装进程自己的生命周期契约里，就该由它自己封口；这样 scheduler、手工调用、其他工作树一律受同一条保证约束（"最坏 3.2 秒内退出"），不需要任何子进程配合。没有更简单的方案（B/C 如上否决）。
- 新增常驻合同测试 `plugins/surfcore/scripts/test-bili-cli-signal-r4.mjs`：在隔离测试根（`testHome/bili-cli-signal`）里复制 `tools/bili.mjs`，把 `tools/commands/dm-await.mjs` 换成**故意忽略 SIGTERM/SIGINT 并 `setInterval` 保持存活**的夹具子进程；等它打印 `FAKE_CHILD_READY` → 对包装进程发 `SIGTERM` → 断言 ①6 秒内退出 ②退出码 `143` ③那个死扛的子进程已被升级 `SIGKILL` 清掉；`finally` 里杀残留进程 + 删测试根 + 显式 `process.exit(failed ? 1 : 0)`（依据 PITFALLS #152）。
- 接进常驻门禁：`scripts/test-audit.mjs`（第 35 行，含两行中文注释）与 `plugins/surfcore/package.json` 的 `test` 链（79 → **80** 段，插在 `node scripts/test-bili-dynamic-receipt.mjs` 之后，无重复）。
- 回滚方式：`git revert` 该提交即可；回滚后行为回到"只在子进程 `'close'` 时退出"，不影响其他任何调用契约。

## 验证

- **先红（未修时）**：`node plugins/surfcore/scripts/test-bili-cli-signal-r4.mjs` → `EXIT=1 elapsed=7s`，`FAIL 包装进程收到 SIGTERM 后必须在 6000ms 内退出（现在仍存活 → 会变成 PPID=1 的孤儿）`；无残留进程/目录。
- **修后**：同一条测试连续两次 `EXIT=0`（`elapsed=4s` / `3s`），末行 `PASS bili.mjs 包装进程：转发信号后自己退出，并升级清掉死扛的子进程`。
- **中间还有一条红**（说明断言有区分度）：只加"转发+宽限"而没改 `'close'` 退出码时 → `1 !== 143`（包装进程按子进程被信号杀死后的 `code=null` 退成了 1）。
- **反向重放**（证明"升级 SIGKILL"这条断言有牙齿）：删掉 `try { child?.kill('SIGKILL') } catch {}` 一行 → `RED_EXIT=1`，`FAIL 忽略信号的子进程必须被升级到 SIGKILL 清掉 / true !== false`（此时包装进程自己仍会退出，但死扛的子进程活下来变成新孤儿）；`cp` 还原后 SHA 与改动前**逐字一致** `407fc4f783e3c0fec836354f7ab184925d77ebff2b3000b3a0a20d885de94a31`，再跑 `EXIT=0`。
- **相邻回归**（都引用 `tools/bili.mjs`）：`node plugins/surfcore/scripts/test-bili-media-no-history.mjs` → `PASS … no-history survives submit, finish and status without history or experience` exit 0；`node plugins/surfcore/scripts/test-bili-dynamic-receipt.mjs` → `PASS dynamic receipt: helper and real CLI behavior passed (isolated fetch stub, no network)` exit 0。
- **实机清理结果**（用户批准后执行，只动这 5 个）：`kill -TERM 1494 20533 21860 49108` → 全部退出；`8988` 3 秒后仍存活（`STAT=S`、无子进程、无 socket）→ 用户批准补 `kill -9 8988` → 退出；最终核对 5 个 CLI 孤儿全部清理；`51037`（用户安装的桥接控制台）保留且仍 `127.0.0.1:3100 LISTEN`。
- **实机环境证据（非侵入，本轮顺带取到）**：①5 个孤儿的命令行证明实机 CLI 跑在 **DSH 自带 node v24.21.0** 上（不是系统 v26.5.1）；②DSH 桌面应用当时**确实在运行**（见"环境"表）；③`~/.dsh/profiles/` 有 `desktop`/`headless`/`web` 三个 profile；④`DSH_HOME` 只被插件/工具侧尊重（`plugins/surfcore/tools/lib/state-paths.mjs:15` 等 6 处），宿主二进制里的 `--dsh-home` 语义**没取到可读上下文**（`app.asar` 是打包体），隔离实例该怎么开需另行实验。
- **没验证到的部分（老实写）**：①`8988` 的**确切机制**没取到——现场是"包装进程活着、无子进程、无 socket"，与"子进程死扛信号"不同类；本轮修复对三类情形（无活子进程 / 子进程在宽限内退出 / 子进程死扛）都给出有界退出，但**测试只钉住了"死扛"这一类**（另两类由同一个定时器封口，未单独构造红灯）。②没有用**真实 CLI 子命令对着真实网络**复跑（会读用户 `~/.dsh` 配置、可能触碰真实队列）——按用户边界跳过。③Chromium 页面渲染、真实 native SDK 发送（`asar` 阻断）仍未验，沿用 R4 的未验证清单。

## 遗留 / 后续

- 需要补的测试：如果把"无活子进程"这类单独钉住，需要给包装进程的退出逻辑留一个可注入的接缝（本轮刻意没为测试改动产品结构）；优先级低——同一个定时器已覆盖三类。
- 需要改的文档：`docs/PITFALLS.md` #155（本轮新增）、`docs/HANDOFF.md`、`docs/RELEASE-QUEUE.md`（本轮批次与交接块）、`docs/COORDINATION.md`。
- 下一轮（仍属 G7）：隔离 profile 下启动实例后的真实验证——DSH 自带 node 的真实解析、Native/IPC、长 TTS 跨轮询、DM 子进程退出、停止/切角色/卸载、实际页面渲染；`~/.dsh/profiles/desktop/node_modules/surfcore/` 的安装副本要等下次安装/更新才带上本轮修复。
