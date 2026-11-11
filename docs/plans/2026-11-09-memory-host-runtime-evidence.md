# P0：实际 packaged Desktop Host 的隔离 SQLite / worker 证据

日期：2026-11-09。工作树：`/Users/shizihan/Daily/Github/surfcore-memory-v2`。新增执行入口：`scripts/test-memory-v2-host-runtime.mjs`。

**结论：实际已安装 Desktop Host 入口在独立临时 profile 中，经真实 Loader 加载最小探针插件，SQLite import 与 worker 事务/重开门槛通过。** 这补齐“匹配 bundled executable”与“实际 Host loader 加载插件”之间的证据差距；没有测试常用正在运行的 Host，没有加载完整 SurfCore 插件或正常 Desktop profile，不能代替后续完整 SurfCore integration。Windows、Intel、精确 Node22.13 运行仍未验，V1 不因本证据而停用。

## 启动前的源码隔离审查

以下路径均在只读安装归档 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/` 内，行号来自本机包原文；使用 Python 按 ASAR header/offset 读取，未解包或修改安装文件。

| 源码 | 隔离约束与实际采用 |
| --- | --- |
| `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:435`—`:439` | argv2 为 runtimeDir，argv3 为 projectDir；`loadProfileDirectory("dsh", projectDir, installAnchor)` 使用传入目录。runtime/project 都是本轮新夹具路径。 |
| 同文件 `:441`—`:455` | 使用真实 `runProfile`，保留 profile 名 desktop；argv 内固定 `--no-open --host 127.0.0.1 --port 0`。本轮 profile 的实际 webserver 配置也显式相同，不打开 App UI。 |
| 同文件 `:456`—`:464` | packageManager 只在 argv5 存在时启用；本轮不传 argv5，不提供安装命令。 |
| 同文件 `:584`—`:610` | IPC disconnect 会 stop；真实 application 完成后读取真实 connection/webServer 并发送 ready。本轮只收 IPC，不对该 URL 发请求。 |
| 同文件 `:480`—`:492` | shutdown 消息调用 application 的 shutdown，再发送 shutdown-complete 并退出。本轮优先走此链路；超时才通过持有的本轮 child handle 发终止信号。 |
| 同文件 `:594`—`:597` | Office source 为 argv4，root 基于 resolveDshHome。本轮 source 是空临时目录，DSH_HOME 是临时目录；不调用依赖工具，不复制/安装 payload。 |
| `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1795`—`:1830` | profile bundles 只来自新建 package.json，user layer 只来自其 `cordis.patch.yml`；本轮 bundles=[]，patch 只有4个显式 entry。 |
| `dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-e2mS45fC.js:237`—`:245`、`:290`—`:313` | resolvedProfile 优先；root config 写到传入 profile；真实 boot 提供 profileContext/PluginPackages/cmdline。探针断言 profile.dir/home 与夹具一致，ctx.effect/ctx.loader.entries 存在且自身 id 出现在 Loader。 |
| `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4486`—`:4504` | .env 仅读 cwd 与 resolveDshHome 两层。本轮两者均是新建目录，环境为显式白名单，不继承父进程凭据/代理/NODE_OPTIONS。 |
| `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js:109`—`:125` | DSH_HOME、DSH_AGENTS_HOME 支持显式覆盖。本轮另设 HOME/USERPROFILE/XDG cache/config/TMPDIR，全部指向夹具。 |

## 最小实际 Host composition

创建临时 package.json（无依赖安装、无 bundles）与 JSON 形式的合法 YAML patch，仅由真实 Loader 激活：

1. 安装包的 `@deepseek-ai/dsh-host-webserver`：`host=127.0.0.1, port=0, compression=none`。
2. 安装包的 `@deepseek-ai/dsh-credentials-local`：`watch=false`，凭据路径自然落在临时 DSH_HOME；不读取正常 profile。
3. 安装包的 `@deepseek-ai/dsh-client-connection`：使用真实本轮进程认证，不导出生成令牌。
4. 临时 `./probe.mjs`：inject 真实 webServer/connection，从真实 Loader 的 apply(ctx) 中启动本地 worker。

没有构造 Cordis Context、手工调用 probe.apply 或假造 connection/webServer。包源码通过临时 `runtime/app.asar` 与 `runtime/app.asar.unpacked` 的只读符号链接定位；runtimeDir 保持 `runtime/app.asar/dsh` 的归档路径形态。符号链接目标是安装包，所有可写 profile/home/source/state 均为临时目录，安装包没有写操作。

在实际 Host 主入口之前，通过 `--import guard.mjs` 禁止 Socket.connect、TLS、UDP、HTTP(S) request/get、fetch、child_process 的 spawn/exec/fork 变体及非本轮监听。只允许 `Server.listen(0, '127.0.0.1')`。Node 为绑定字面量 loopback 而调用的 dns.lookup 用纯 nextTick 合成 `127.0.0.1/family4`；其它 DNS 查询拒绝，不调用系统 DNS。worker 继承同一 preload guard。该护栏针对本测试实际依赖调用面，不声称是任意不可信代码的 OS 沙箱；composition 不含模型、平台、更新或浏览器插件。

探针本身与 worker 均断言拒绝计数为空；本轮真实结果为0拒绝调用、1次纯合成 loopback lookup。没有连接常用3100桥接或59783 Host；ready 端口还断言不等于这两个端口。生成的真实认证 URL 仅在父进程内解析，证据只保存 protocol/host/port/authenticated 布尔值，不保存查询令牌。

## 精确执行与结果

工作目录：`/Users/shizihan/Daily/Github/surfcore-memory-v2`。

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' scripts/test-memory-v2-host-runtime.mjs
```

该命令通过标准 child_process.spawn 启动的真实命令如下；各夹具路径由脚本 mkdtemp 创建：

```sh
ELECTRON_RUN_AS_NODE=1 DSH_DESKTOP_NODE_EXECUTABLE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --expose-internals --import '<fixture>/guard.mjs' \
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' \
  '<fixture>/runtime/app.asar/dsh' '<fixture>/project' '<fixture>/source'
```

运行没有继承整个外部环境；精确 args、cwd、显式环境和源夹具均保存在：

`_backups/memory-v2-host-runtime/run-ghaVlB/result.json`

| 实测项 | 结果 |
| --- | --- |
| 父探针退出 | 0，`ok:true` |
| Host 包身份 | `@deepseek-ai/dsh-desktop-host`，0.2.2-rc.1；插件在实际 Host 中读取安装 package.json |
| 实际 Host process | PID37627（仅本轮瞬时值），execPath `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`，Node v24.21.0，darwin arm64 |
| IPC 生命周期 | starting → probe acknowledgment + ready → shutdown-complete；Host exit code0 / signal null |
| 监听 | 真实 packaged webserver 的 `127.0.0.1:50171`；无请求发送，无 UI打开 |
| Loader acknowledgment | `memory-runtime-probe` entry 存在，真实 apply context；profile dir/home/cwd 均为本轮临时路径 |
| 主线程 SQLite import | `node:sqlite` 成功，DatabaseSync 为 function |
| worker 身份 | 同一 Electron execPath，Node v24.21.0，darwin arm64，SQLite3.53.4，正常 exit0 |
| worker7项行为 | worker-ready；DELETE/EXTRA/foreign_keys；commit；rollback；close-reopen-readback；integrity；foreign-key-check |
| 设置读回 | journal_mode=`delete`，synchronous=3，foreign_keys=1；首次打开及重新打开都验证 |
| 原子行为 | event+receipt 同一事务提交；另一个事务插入后回滚，该行不存在 |
| 重开 | 关闭数据库后新连接读取已提交中文正文与 receipt→event；完整性ok，FK check为空 |
| 出站/子进程调用 | Host 与 worker 拒绝计数都为空；preload 不调用原始出站函数；未创建额外子进程 |
| Host 输出 | log空，无启动警告/错误 |

临时 SQLite 与目录均保留，不做计算路径删除。正常路径通过 IPC 关闭自建 Host；兜底也只调用持有的本轮 child.kill，不扫描、控制或重启既有进程。worker 10秒超时、Host ready25秒、IPC退出7秒与SIGTERM3秒的有界等待均在脚本中定义。

## 失败记录、取舍与局限

实现迭代共3次，达到本 brief 上限。所有失败原件保留：

- `run-U3ZwDN/result.json`：把 node_modules 直接链接进ASAR时，安装 resolver 的 native realpath 遇 `ENOTDIR: not a directory, realpath '.../runtime/node_modules/@deepseek-ai/dsh'`，在插件装载前退出。改为保留 `.asar/dsh` 路径形态的只读归档链接。
- `run-mOOwJx/result.json`：归档挂载已工作，但护栏把 Node 绑定127.0.0.1所需的 dns.lookup 也拒绝，真实 webserver 未启动，探针 pending，Host在读取webserver.protocol时失败。随后仅为该字面量提供纯合成lookup，没有开放真实DNS。
- `run-ghaVlB/result.json`：最终通过。没有将前两次夹具错误改写为SQLite不支持；失败均顶层 `MEMORY_HOST_GATE_FAILED`，给出保留V1和查看隔离证据的 hint。

候选路线A（采用）是直接调用发行Host入口+空临时profile+真实最小服务图：能够证明实际loader/plugin/worker的模块环境，代价是验证隔离入口及guard；所有产物局限在新目录，可停止使用脚本而回滚。路线B是复用正常profile或安装SurfCore后重启常用DSH：上下文更完整，但会读取正常状态、可能启动平台或模型，也超出本轮边界，所以不采用。

SQLite API仅用Node22.13已有的DatabaseSync constructor/exec/prepare/close与StatementSync run/get/all，没有sqlite.backup或新构造参数；实际发行Host本身使用其安装版本提供的API（如registerHooks），本轮不声称精确Node22.13可启动这个Host包。普通进程的锁/强杀恢复/独立备份等21项另见 `docs/research/2026-11-09-memory-runtime.md`，不能把那些结果冒称为本Host插件7项的一部分。

本轮补齐的是macOS arm64实际packaged Host最小插件装载门槛。完整SurfCore/kernel worker资源定位与退出回收仍待该模块完成后单独验收；正常用户profile、Windows/Intel、断电/磁盘满/损坏库均未验。没有访问正常profile内容/凭据，没有依赖安装/模型/网络外发/平台发送，没有安装包改写、服务重启或commit。无需重启常用DSH。发布交接：仅新增P0隔离探针与证据，不改版本、不发布、不宣称V2替代V1。
