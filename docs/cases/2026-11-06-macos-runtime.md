# macOS Node、浏览器与媒体运行时

## 现象与环境

旧代码在 macOS `.app/Contents/Resources` 和 Finder 环境下可能找不到真正的 Node；调度器直接执行与 Agent 命令可能选到不同的 Node。扫码只查 Windows Edge，体检检查宿主版本而非实际子进程。目标环境是 Apple Silicon、macOS 26.6.2、DSH Desktop 0.2.2-rc.1；本次仅离线与隔离测试，不代表该宿主已加载插件。

## 根因与修法

路径存在不证明可执行或具备 ESM、fetch、WebSocket、AbortSignal.timeout；Electron 需要构建支持且子进程环境正确。`src/node-path.js` 返回已执行探测的描述对象；显式 DSH_NODE 无效直接报告错误，不回落。调度器、插件桥接、扩展与 MCP 配置携带同一 executable、参数前缀和子进程环境；命令文本按 shell 转义。浏览器查找 Edge/Chrome，扫码使用临时 profile 和自有子进程组；GUI 不继承 Electron Node mode。媒体解析分别验证 FFmpeg 和 FFprobe，返回绝对路径和能力。体检通过调用方提供的真实子进程结果及启用渠道判定；具体宿主接线需由集成会话完成。

之前的测试主要验证 Windows 路径和文件存在，不能证明 `.app` 布局、所选可执行文件能力或 Agent 命令与直接调用一致。

## 完整逻辑

1. **链路**：Host 的 `paths.js` 重导出 Node resolver；`scheduler.js`、`extensions.js`、`bridge.js` 使用描述对象；`setup-dsh.mjs` 生成 MCP command/args/env。扫码入口在 `bili-qr-login.mjs`，媒体接口在 `tools/lib/ffmpeg.mjs`，供 B 站和 ASR 装配使用。`index.js` 的 Host 诊断、运行和扫码错误传递由集成会话接线。
2. **机制**：候选依次为显式配置、应用资源、缓存、当前进程和系统路径；逐个验证文件权限、运行版本与能力。Electron Node mode 仅在实际探测成功时给子进程加环境变量。扫码清理只针对该次浏览器，避免结束日常浏览器。
3. **影响面**：Host、桥接、调度任务和 MCP 子进程多处读取，错误可让工具不可用；不处理用户凭据、不安装或复制媒体二进制、不触及资金。扫码成功仍需原有账号归属校验。
4. **取舍**：逐处维护查找代码成本低但易漂移、回滚分散；共享描述对象及实际探测改动较多但消除路径和环境分叉，可按本批文件回退。选后者。
5. **生效**：代码需在集成并安装后重新加载 DSH，桥接/调度进程也需重启；本次未重启任何真实进程。
6. **验证**：`node scripts/test-node-path.mjs`、`node scripts/test-bili-qr-login.mjs`、`node scripts/test-runtime-media.mjs`、`node plugins/surfcore/scripts/test-doctor.mjs`、`node scripts/test-audit-setup.mjs` 和 `npm run test:regressions` 均通过。旧树完整 `npm run test:audit` 136/143，失败列表与证据见 `/tmp/surfcore-runtime-audit.log`；集成基线的结果另记。空 PATH 指向真实 `.app/Contents/Resources` 的探测得到 Node 24.21.0 arm64，所需能力均通过；本机 FFmpeg/FFprobe 9.0 arm64 能力通过。`npm test` 在旧基线更新器测试失败，日志 `/tmp/surfcore-runtime-plugin.log`；已知修复在集成基线 52ced0f，须合成后重跑。
7. **回滚与剩余**：备份在 `_backups/20261106-macos-runtime/`；按文件恢复前先核对集成改动，避免覆盖其他工作。尚未在真正 DSH Desktop、Finder、浏览器、B 站账号或 Intel Mac 验收；不能宣称完整运行或发布通过。ASR 模型及引擎就绪需单独证明。

## 可转发发布交接

```text
改动：Node 描述对象/能力探测、同源执行与 MCP 环境、Edge/Chrome 扫码进程管理、FFmpeg/FFprobe 诊断和渠道体检。
测试：运行时聚焦、setup 审计、协议回归通过；完整审计和集成后插件全套以最终集成记录为准。旧树更新器测试失败，不可按此树发布。
版本建议：minor，最终版本由用户决定。接口层新增 descriptor，保留 findNodeExe 兼容入口；调用方必须传 argvPrefix/envPatch。
case：docs/cases/2026-11-06-macos-runtime.md；完整逻辑及影响面见上文。
失败：显式错误配置拒绝回落并返回 code/error/hint；Node、媒体、QQ 禁用诊断有失败断言；Host 界面透传与实机仍待集成验证。
未验证：真实 DSH Desktop/Finder、真实扫码及账号、Intel、完整 ASR 模型执行。未发布，未改用户 profile 或运行中的应用。
```

组合审查补充：Windows 的 PROGRAMFILES 环境变量是目录，系统 Node 候选须补 `nodejs/node.exe`；保留显式完整可执行文件参数。新增模拟 Windows 目录布局行为断言，通过能力探测后选中该文件；Windows 实机仍未验证。
