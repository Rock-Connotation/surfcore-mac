# QQ 本机 WebUI 打开失败及宿主异步异常（2026-11-07）

## 现象与根因

macOS 的 QQ 登录入口尝试启动 Windows `cmd.exe`；原函数立即返回 `opened: true`，随后 `spawn` 异步发出未监听的 ENOENT，可能导致 Host 退出。原同步 try/catch 无法捕获这个事件。提取原函数并注入假子进程复现：`{"command":"cmd.exe","opened":true,"unhandled":"ENOENT"}`，exit 1；未打开窗口或访问网络。

## 完整逻辑

1. **链路**：设置页 `start-snowluma` 和 QQ 启动流程调用 `launchSnowLuma`；仅在本机 WebUI 端口已监听时调用 `openLocalUrl`。两处调用均等待结果；直接操作的既有 UI 从响应的 `error` 显示失败，组合启动从 `message`/`hint` 显示下一步。
2. **机制**：新 `local-webui.js` 严格接受 `http://127.0.0.1:<1–65535>`，拒绝凭据、路径、查询、换行或其他主机；macOS 使用 `/usr/bin/open`，Windows 使用原 `cmd /d /c start` 参数，Linux 使用 `xdg-open`。`execFile` 等待回调，异步 ENOENT、非零退出、超时和同步异常都变成带 `code/error/hint` 的失败，并提供无凭据的手动地址。成功只表明系统打开命令成功，不证明用户已登录或浏览器实际呈现。
3. **爆炸半径**：单一 Host 的用户主动点击 × 一次本机 WebUI 打开；原未监听错误可能影响整个 Host。没有启动 SnowLuma、登录 QQ、访问网络或读取凭据。
4. **取舍**：在原函数加平台分支成本低，但异步事件与地址安全缺少独立测试接点；拆出受限打开器可独立注入假进程并精确测试，增加一小文件，回滚只需恢复原调用和文件。选后者。
5. **生效与重启**：插件代码需宿主重新加载才生效；本次未重启实际 App 或更改 profile。
6. **验证**：原实现的假子进程异步 ENOENT 实际红测如上；新专项在官方 App Node `v24.21.0` 下从项目根及插件目录运行通过，覆盖坏 URL 不调用进程、三平台命令、异步 ENOENT/非零退出、同步错误、结构化错误和手动地址、两处 await 与现有 UI 错误展示契约。`node --check` 和 `git diff --check` 通过。测试不启动任何浏览器或外部程序；尚未实测各平台 UI。
7. **回滚与残余**：原 `index.js`、插件 package.json 备份在 `_backups/20261107-qq-host/`；保护后续更改后按文件恢复即可。Windows 和 Linux 实机浏览器调用及 macOS 真正打开窗口未测；上游 SnowLuma 启动器本身的异步错误不在本次范围。主线最终 checks-2-ui-final：audit164/164、regressions、完整插件测试均exit0；Astra R2无新增实质P1/P2。

## 发布交接块

```text
改了哪些文件：plugins/surfcore/lib/index.js、lib/local-webui.js、scripts/test-local-webui.mjs、plugins/surfcore/package.json、本 case
测过什么、结果如何：原函数异步 ENOENT 复现 exit 1；Node 24 专项、语法及 diff 检查 exit 0；主线最终audit164/164、regressions、完整插件exit0，Astra R2无新增实质P1/P2
建议 patch 还是 minor：patch，版本由发布会话决定
case 文档路径：docs/cases/2026-11-07-qq-macos-webui.md
改动层级：受限回环 WebUI 打开与 QQ 启动结果传播
完整逻辑与爆炸半径：见本 case
失败路径：返回 code/error/hint，提示手动打开本机地址，不假报 opened
还有什么没验证：真实浏览器、Windows/Linux 实机、上游 SnowLuma 启动、完整组合门禁
接收位置：fix/qq-macos-host，主会话组合审阅
```
