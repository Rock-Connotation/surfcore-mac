# Memory V2 P0：SQLite 发行运行时技术门槛

日期：2026-11-09。基线：`94a4a78`，工作树 `/Users/shizihan/Daily/Github/surfcore-memory-v2`。本记录仅覆盖技术探针，不是 P0 全包验收或生产切换许可。

**结论：本机两个发行运行时入口的隔离行为检查均通过 21 项；实际 Host 已加载的 SurfCore 插件内能力、Windows 和精确 Node 22.13.0 运行仍未验证。继续保留 V1，不转移数据所有权。**

## 输入、边界与路线

依据设计 `/Users/shizihan/Downloads/SurfCore_Memory_Design_20261109.md:116`（§3.2）、`:354`（§5.2）、`:776`（§7.4），以及 `docs/ROADMAP.md:8`、`docs/HANDOFF.md:8`、`docs/PITFALLS.md:3723`（#118 Node 定位）、`:4016`（路径别名）、`:4021`（独立 App 与日志副作用）、`docs/guides/DEVELOPMENT-TOOLS.md`。

现象：最低 Node 版本声明不能证明发行 Host/worker 可用 SQLite。原因：Desktop Host、原生 Node、shell launcher 和已加载插件是不同证据层；同步 SQLite 也不能放进 Host 主事件循环。影响面限制为新建隔离 SQLite 文件，不触碰任何生产 profile、既有记忆、模型、平台发送或服务启停。

路线 A：新增标准库 assert 探针，由 worker 执行 SQLite，同一脚本的独立子进程用于强杀事务。收益是可复跑、无需安装依赖；成本为小型测试脚本；风险限于本轮新建夹具；撤销时停止调用脚本即可，保留证据。路线 B：直接安装/重启插件并访问真实 Host；可补完整装载链路证据，但涉及生产状态和启动日志，不在本轮授权内，因此留给后续隔离 Host 门槛。没有在 SQLite 失败后自动改用另一存储路线。

仅新增 `scripts/test-memory-v2-runtime.mjs` 和本文件。所有运行证据位于新建 `_backups/memory-v2-p0/`，脚本按自身位置定位此目录，不依赖 cwd。每轮 `mkdtempSync` 新建目录与标记；helper 先核实真实父目录及标记，再允许打开夹具。成功与失败证据均保留，不删除或覆盖既有文件。数据库名含中文与空格。

## 可重现命令与实际结果

工作目录均为 `/Users/shizihan/Daily/Github/surfcore-memory-v2`，除最后一个负向测试外均期望退出 0。

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' --version
# v24.21.0

DSH_DESKTOP_NODE_EXECUTABLE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node' --version
# v24.21.0

'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' scripts/test-memory-v2-runtime.mjs
# exit 0; ok:true; checkCount:21
# _backups/memory-v2-p0/run-dzghLP/result.json

DSH_DESKTOP_NODE_EXECUTABLE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node' scripts/test-memory-v2-runtime.mjs
# exit 0; ok:true; checkCount:21
# _backups/memory-v2-p0/run-onQsdY/result.json

'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' --no-experimental-sqlite scripts/test-memory-v2-runtime.mjs
# expected exit 1; ok:false; code:MEMORY_BACKEND_UNSUPPORTED
# error: No such built-in module: node:sqlite
# hint nonempty; retainV1:true
# _backups/memory-v2-p0/run-wvsPg2/result.json
```

负向命令由 Python `subprocess.run(..., timeout=30)` 收集，并断言退出码 1、`ok:false`、精确 code、非空 error/hint 与 `retainV1:true`；验证器自身退出 0。脚本输出为完整 JSON。其失败提示为：`Keep V1 active; do not transfer data ownership. Use a supported bundled runtime and rerun this isolated gate.` 这是门槛测试的失败契约，不冒充已经接入产品 UI 的错误展示或生产启动门闸。

`runtime/bin/node` 实际是三行 shell launcher：

```sh
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$@"
```

不带 `DSH_DESKTOP_NODE_EXECUTABLE` 的 `--version` 和 SQLite import 均实测退出 127：`exec: : not found`。这是缺少 Desktop 启动环境的调用失败；不能将其写成 SQLite 不支持。显式设置安装中 Electron 可执行路径后，两者通过。原生 bundled primary Node 不需要该变量。

## 平台与进程矩阵

| 对象 | 版本/参数 | 已有证据 | 状态 |
| --- | --- | --- | --- |
| macOS arm64 原生 bundled primary Node | Node v24.21.0，SQLite 3.53.4，`execArgv:[]` | 新进程 main import、worker、数据库行为、崩溃恢复与备份 | 本技术探针通过 |
| macOS arm64 Desktop launcher → Electron Node | Node v24.21.0，SQLite 3.53.4，`execArgv:["--expose-internals"]` | 显式 Desktop 环境下同一套新进程/worker 探针 | 本技术探针通过 |
| 当前真实 Desktop Host | 包版本 0.2.2-rc.1；观察时 PID30268/父30216，Electron 路径，`--expose-internals`，`dsh-desktop-host/lib/index.js` | 只读进程/安装包启动代码；未读取生产 profile | 只证明进程/包形态；实际已加载插件 SQLite/worker 未验 |
| Windows 默认安装形态 | 无目标设备 | 无原生 Node/Host/worker/路径/锁/强杀/备份实测 | 未验，不标为支持或不支持 |
| macOS Intel | 无目标设备 | 无实测 | 未验 |
| 精确 Node v22.13.0 | 本机测试入口均为 v24.21.0 | 仅做 API 使用面审查，未下载/安装旧 Node | 未验最低版本运行 |

原生 bundled primary Node SHA256：`69e76cb4e09d4d25408fb4dbd2bc5ca8a4b1c7d8659d5aca76276c82931240de`。按已发现路径只读核对的 cached runtime Node 版本及哈希与它一致；这不能证明某个常驻进程的 `node:sqlite` 已成功执行。launcher SHA256：`70e7283062bf127839ed8318e03f7c61e807bd1f257bcc12cfde896aa3395a09`。

只读包证据：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中 `package.json`、`dsh/package.json`、`dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json` 均为 0.2.2-rc.1。`lib/main.js:9745` 的 `desktopNodeEnvironment()` 设置 `ELECTRON_RUN_AS_NODE` 与 launcher 所需变量；`:9979`—`:9990` 显示真实 Host entry/参数/env 组装。通过 Python 按 ASAR header/offset 只读提取，未解包写回；`ps` 仅保存 pid/ppid/executable 和两个已知参数布尔值，不保留原始命令行或环境。完整脱敏摘要为 `_backups/memory-v2-p0/host-package-evidence.json`。

## 行为门槛结果

| 门槛 | 原生 primary / launcher 实测结果 |
| --- | --- |
| main 与 worker SQLite import | 均成功；worker 的 Node/execPath/execArgv/SQLite 版本写入 JSON |
| 设置后读回 | `journal_mode=delete`、`synchronous=3`（EXTRA）、`foreign_keys=1`、`busy_timeout=150`；重开/恢复连接也重复验证 |
| 原子回滚 | event、receipt、ingest offset 同事务；ROLLBACK 后前两项不存在，offset 仍为 1 |
| 提交后关闭重开 | 原事件正文与 operation→event 回执保留 |
| 唯一约束 | eventId 主键 errcode1555、sourceKey 唯一2067、operationId 主键1555，均为 `ERR_SQLITE_ERROR` |
| 外键实际执行 | 不存在 event 的 receipt 写入失败，errcode787；非仅检查 PRAGMA |
| 基础检索 | 参数化 `instr` 命中中文、LIKE 命中 ASCII；不依赖 FTS |
| 可选 FTS5 | 两者可建表并 MATCH 命中；缺少 FTS5 仅报告 optional，不否决基础 SQLite |
| 锁冲突/释放 | 独立连接遇写锁返回 errcode5 / `database is locked`；185ms / 187ms，界限100—3000ms；持锁方 ROLLBACK 后竞争者写入成功 |
| Host 式主线程响应 | 所有数据库行为在 worker；10ms 主线程 timer 累计24 / 20次，非零断言；只证明独立探针进程的事件循环 |
| worker 生命周期 | 两次 worker 都等待退出码0，无常驻 worker/服务；每次20秒超时保护 |
| 进程强杀恢复 | 子进程开启写事务、更新512行、创建实际回滚日志后发 IPC；父进程 SIGKILL，等待退出后新 worker 重开；旧 commit 保留、killed event 不存在、512行恢复旧值、可再次写入、integrity_check=ok/FK check为空；子进程15秒超时保护 |
| 一致性独立备份 | `VACUUM INTO ?` 生成独立库；源库随后写入新事件，备份保持旧有序事件快照、receipt/offset一致；完整性/外键检查通过；关闭源库后再次打开备份仍一致 |
| unsupported 失败路径 | 真实禁用 node:sqlite 后返回精确 code/error/hint/retainV1；另有人工构造 envelope 断言 |

约束验证故意触发的错误均断言 `code` 与 SQLite primary errcode；进程外部故障以结构化顶层失败传播，不吞错、不自动换 journal mode。没有测断电/磁盘满/损坏文件、跨库控制屏障、永久删除或生产并发，这些不能由 SIGKILL 夹具外推。

首次实现的两个运行均失败于 harness 将 `PRAGMA busy_timeout` 读回列名误认为 `busy_timeout`，实际列名为 `timeout`。随后定向 `:memory:` 查询及唯一约束错误形态检查确认，改用 PRAGMA 单值读取后完整重跑通过。原失败目录 `_backups/memory-v2-p0/run-AMdVZT/` 和 `run-BCDjrx/` 均保留，不将其包装成运行时缺陷。实现迭代共2次，未超过3次上限。

## Node 22.13 API 使用面审查

SQLite 只使用 `new DatabaseSync(path)`、`DatabaseSync.exec()`、`.prepare()`、`.close()`、`StatementSync.run()`、`.get()`、`.all()`。未使用 `sqlite.backup()`、构造器 timeout 选项、async SQLite、新增会话/变更集接口或扩展加载。备份采用 SQLite SQL `VACUUM INTO`，而不是复制活动数据库文件。worker/fork/fs/path/assert/url API 均属于 Node22.13 已有标准库接口。

固定最低版本 API 参考为设计[N1]指定的 [Node v22.13.0 SQLite API](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)；该链接作为后续复核入口，本轮遵守无网络边界未抓取网页，未声称通过精确 Node22.13 二进制。实际两个测试运行都是 Node24.21.0。`PRAGMA synchronous=EXTRA` 的机制参考设计[N3]的 [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)，不等于设备断电持久性保证。

## P0 出口、待验项与交接

本技术子门槛已满足：macOS arm64 两入口的基础 SQLite、隔离 worker、DELETE/EXTRA/FK、回滚/持久/唯一约束/写锁/强杀恢复/一致性独立备份与 structured unsupported。不必安装数据库服务、Python数据库依赖或额外 npm 包。

完整 P0 尚缺：真实已加载 SurfCore Host 插件内启动检测及 worker 资源定位/退出回收；Windows 默认发行安装实测；其它设计P0工作流（真实来源/权限映射、只读旧数据预演、13场景夹具/基线）不在本文件覆盖范围。精确Node22.13与Intel未验单独保留。只有后续这些条件完成且父任务判定达标，才能转入下一阶段；本记录不得用于绕过V1保留门槛。

本轮无生产行为变更，无需重启 DSH。没有读取/改写生产记忆/profile，没有模型/网络/平台发送，没有提交、安装或发布。全仓 `test:audit` 与后续集成测试由父任务统一执行；本工作树初始无 node_modules，本子任务没有安装依赖或修改测试总入口。回滚方式是停止调用新增脚本；证据保留，生产V1无须回档。

发布会话交接块：本轮仅P0技术探针与研究记录；两入口各21项通过，负向unsupported契约通过；实际Host加载链路/Windows/精确Node22.13未验，V1保持；不改版本、不发布、不宣称记忆V2已交付。父任务如需更新HANDOFF/ROADMAP/case，应按其既有授权写入，本子任务不越过两个命名文件边界。
