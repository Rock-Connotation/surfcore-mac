# DSH MCP 健康检查限定当前 profile（2026-11-07）

## 现象、根因与修复

独立官方 App profile 缺 MCP 时，QQ 桥接旧检查扫描常用 HOME 下所有 profile，既可能错误报警，也可能被另一个健康 profile 掩盖。真实桥接 `auditDshHealth` 函数在临时 HOME / DSH_HOME 夹具中重现：常用目录有缺失而目标 profile 完整时错误产生 L2，原始 red 日志见 `_backups/20261107-dsh-health-scope/red.log`。现改为使用本进程 DSH_HOME，优先 DSH_PROFILE；未显式指定时仅选择该 DSH_HOME 中唯一在安装清单声明 SurfCore 的 profile。目标不存在、读取或解析失败、候选不唯一均返回 unknown、code 和下一步，不猜测其他 profile。旧 `checkProfileMcp(home)` 扫描语义保留。

## 完整逻辑

1. **链路**：`src/bridge.js` 的 `checkDsh` 在 DSH 首次就绪时调用 `auditDshHealth`，后者用 `src/dsh-health.js` 只读当前 profile 的 `cordis.patch.yml` 并通过 gate-events 告警。目标来自桥接继承的 `DSH_HOME` / `DSH_PROFILE`，不扫描其他主机进程、不访问常用 profile。
2. **机制**：旧调用只传 HOME，健康条件是任意 profile 包含三个 ID，无法代表当前实例。新检查用现有 `js-yaml` 解析 loader 插入条目，识别 disabled 与格式错误；仅选定 profile 决定 healthy/broken/unknown，注释或 config 中的相同字符串不能当成注册。unknown 生成独立的非确认事件，不以“某个 profile 缺 MCP”冒充结果。
3. **影响面**：启动后的 QQ 健康提示及操作建议；不自动写 profile、修复、重启或读取凭据。首次 ready 时 chat 现在也做 profile 健康检查，但 `profileOnly` 保证旧会话 preset 核对和退役仍仅发生在 reserved2，与先前行为一致。当前目标真实健康才确认旧的 `dsh-profile-mcp-missing` 和 `dsh-profile-mcp-unknown` 事件；未知不确认旧 L2。
4. **取舍**：A 延续所有 profile 扫描、成本小，但有已复现误报和漏报；B 显式目标优先、唯一安装候选兜底，歧义时要求确定 DSH_PROFILE。选 B，避免将另一个 profile 的状态当成本实例。旧对外纯扫描入口保留兼容；唯一安装候选是文件证据而非运行进程证明，多个候选不猜。
5. **生效与重启**：需由主会话将程序装入目标包并让目标桥接进程加载；`checkDsh` 在 DSH 从未就绪变为就绪时运行。仅修 profile 文件不会自动使现有桥接重新执行健康检查，修复完成应由主会话安排有目标的复核；脚本本身不重启 DSH，旧会话的工具表可能仍需重建。
6. **验证**：官方 Node 24 的 `scripts/test-dsh-health-scope.mjs` 在临时目录执行真实 `auditDshHealth` 和 `checkDsh` 函数：common/独立根互换、健康 sibling 不能遮住损坏目标、缺文件和无效 YAML 为 unknown、disabled 和空配置、profile 歧义与唯一安装、路径穿越、健康时 ack；chat 不读 session/不退役，reserved2 保留不匹配退役。原有 `scripts/test-dsh-health.mjs` 和桥接回归也运行，原始输出在 `_backups/20261107-dsh-health-scope/`。夹具不证明真实宿主 MCP 被加载。
7. **回滚与残余**：保留旧文件于工作树 `_backups/20261107-dsh-health-scope/`，回滚这两处源文件并保留配置及事件；恢复旧实现会重新引入跨 profile 错判。多 profile 必须显式标识，安装清单不等于有效运行时；真实 App 新包、修复动作、事件界面和重启由组合会话验收。

## 失败与用户下一步

`DSH_PROFILE_AMBIGUOUS` / `DSH_PROFILE_UNKNOWN` / `DSH_PROFILE_PATCH_UNREADABLE` 不说明 MCP 缺失；在当前 DSH 实例明确 `DSH_PROFILE` 并检查该实例 DSH_HOME 和 patch 文件。确认当前 profile 实际缺 MCP 时，使用宿主提供的显式修复入口，修后按提示重启；不能由模型私自修复。

## 组合主线真实补验（2026-11-07）

独立官方App安装f68fa63同源第三包，实际修复当前desktop注册后完整退出重启。官方RPC列出的三个MCP均enabled/active，独立stdio真实握手列工具32/1/2且qq_status只读调用成功。两条历史dsh-profile-mcp-missing记录均由健康检查变为ack:true；主线只点“稍后”，没有用用户确认掩盖检测。私有证据见 `_backups/20261107-qq-resident/registration-gates-after-restart.json` 及同根MCP证据。冻结audit169/169、回归/完整插件exit0；不是常用profile或其它平台的实测结果。

## 发布交接

- 现象：健康提示扫描错误 DSH 数据根，或被其他 profile 的健康状态掩盖。
- 改动：按当前根和确定的 profile 解析 MCP；歧义/不可读作为 unknown，健康复核后确认旧告警；chat 首次就绪只检查 profile，不扩大旧会话退役行为。
- 验证：Node 24 隔离夹具、原兼容测试、桥接回归日志见 `_backups/20261107-dsh-health-scope/`；最终全仓门禁和同源制品由组合会话执行。
- 夹具范围：无真实账号、模型、消息或 profile 写入；主线已授权独立 App 实测见上节，其他平台仍需验收。不发布、不推送、不改版本。
