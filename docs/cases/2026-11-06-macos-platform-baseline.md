# macOS 平台基线测试边界

## 现象与根因

- `test-audit-setup-guards.mjs:49` 在 macOS 首个失败为 `start.bat 必须使用 CRLF`（19 个 LF）。
- `test-console-encoding.mjs` 调用 Windows 专用 `chcp`，报 `spawnSync chcp ENOENT`。
- `test-update-apply-result.mjs:47` 夹具调用 `powershell Compress-Archive`，报 `spawnSync powershell ENOENT`；原生产解压在 `plugins/surfcore/lib/updates.js:1538` 使用 PowerShell。

## 完整逻辑

- **链路**：Node 审计脚本读取 `start.bat`、探测控制台编码并构造更新 ZIP，`npm run test:audit` 汇总执行。
- **机制**：CRLF、`chcp`、PowerShell 是 Windows 契约；macOS 强行执行会把“不适用”误报为回归。
- **爆炸半径**：更新检查 Host 与独立 helper 两个进程，更新消费者两类，失败可见；涉及安装程序文件覆盖，隔离测试不访问真实用户数据、密钥或费用。
- **取舍**：A 继续依赖 PowerShell，macOS 无法验证真实 apply；B 保留 Windows PowerShell、为 POSIX 增加原生 Node 复制与系统 `unzip`，覆盖真实链路且改动局部，采用 B。
- **生效与重启**：更新器代码由下次执行更新任务读取；实际应用仍要求宿主退出后由 `apply-update.mjs` 执行，不需要本机 DSH 重启来验证离线测试。

## 修法与回滚

- `test-audit-setup-guards.mjs` 仅 `win32` 断言 CRLF，其他平台打印跳过原因。
- `test-console-encoding.mjs` 仅 `win32` 调用 `chcp`。
- `updates.js` 保留 Windows PowerShell，POSIX 使用 `unzip`；`apply-update.mjs` 在 POSIX 原生递归复制，保留排除项、文件模式与目标独有数据，并拒绝暂存符号链接越界。
- `.gitattributes`：`*.bat text eol=crlf`，保证 Windows 检出 CRLF。
- 回滚：撤回 POSIX extraction/copy 分支即可恢复 Windows-only 行为；更新事务已有 `.state/backups/<txn>/files` 回滚链路，本轮未触碰 Windows 分支。

## 验证

- 通过：`node scripts/test-audit-setup-guards.mjs`；`node scripts/test-console-encoding.mjs`（2 通过、0 失败）；`node scripts/test-update-apply-result.mjs` 全部通过，含 config/角色/模型/感知/目标独有文件保留断言。
- `npm ci` 成功，postinstall 仅执行既有本地 SnowLuma ESM 扩展名修补。
- 完整 audit 日志：`/tmp/surfcore-macos-baseline-audit.log`；仍有 `test-audit-bridge.mjs`、`test-stickers.mjs`、`test-voice.mjs` 及组合后的 release manifest 漂移，属既有/协调范围。
- 未验证 Windows 实机 CRLF/chcp/PowerShell 分支；POSIX 真实解压/复制与符号链接拒绝已验证。

## 发布交接块

```text
改了哪些文件：.gitattributes、scripts/test-audit-setup-guards.mjs、test-console-encoding.mjs、test-update-apply-result.mjs、test-update-archive.mjs、test-audit.mjs、apply-update.mjs；插件 updates.js、update-archive.js；本 case 和索引。
测过什么、结果如何：完整 apply 测试通过，ZIP 穿越/符号链接/local-central 不一致/截断拒绝测试通过；组合插件 npm test exit 0；最终 audit 由主树从提交对象重建清单后补跑。
建议 patch 还是 minor：本批 patch 兼容修复，完整 macOS 首期另由发布会话决定。
case 文档路径：docs/cases/2026-11-06-macos-platform-baseline.md
改动层级：实现层增加 POSIX 解压/复制，外部接口向后兼容；Windows 路径保留。
完整逻辑与爆炸半径：见本 case；只在明确的更新事务覆盖安装程序文件，保留用户数据与目标独有文件。
失败路径：解压前校验失败沿用 verify.unzip-failed 与 hint；复制失败写 apply.failed、error、非空 hint，测试已断言。
还有什么没验证：Windows 实机、官方 App 的实际更新、安装身份与完整回滚演练仍待 WP5。
```

## 工作树记录

- 分支：`fix/macos-test-baseline`
- 范围：WP0 macOS 平台测试边界与 Windows CRLF 检出属性
- 合并前：协调会话重生成 release manifest，并在 Windows 验证完整分支
