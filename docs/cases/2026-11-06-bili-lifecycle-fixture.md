# B站生命周期夹具在 App Node 环境中无法就绪

## 现象与环境

组合审计在 `test-bili-media-lifecycle.mjs:46` 报 `assert.ok(fs.existsSync(readyFile))`，Node 为官方 App 内 v24.21.0。该断言之前的工具调用将子进程启动失败归一化，原日志未显示子进程 stderr，单凭审计原文不能断定退出原因。

## 完整逻辑

1. **链路**：生命周期测试调用 `verifyMediaDecode`，它通过 `spawn` 启动作为 FFmpeg 替身的可执行 helper；helper 注册 SIGTERM 后写入就绪文件，测试取消并要求退出标记出现。该夹具只使用临时目录和当前 Node，不访问账号或外网。
2. **机制**：原 helper 的 `#!/usr/bin/env node` 查找 shell PATH，而官方 App 启动的测试 Node 是包含空格的绝对路径，PATH 不一定含该 Node。用官方 Node、隔离 `DSH_HOME`、`PATH=/usr/bin:/bin` 复现相同断言和 exit 1；同一环境 `/usr/bin/env node --version` 实际 exit 127，输出 `env: node: No such file or directory`。此外一次并行运行的正常 PATH 出现一秒内未就绪，说明固定短轮询对调度延迟敏感，但不能据此断言原审计中也发生了调度延迟。
3. **影响**：仅影响测试夹具启动和审计结论；未发现产品代码缺陷，不涉及用户数据、凭据、真实 B站和外部发送。错误断言会掩盖 helper 启动失败。
4. **取舍**：继续依赖 PATH 或只加大等待会保留缺失解释器的问题；选择 POSIX shell wrapper 以引用安全的 `process.execPath` 启动本测试实际 Node，支持路径含空格和单引号。保留有限就绪等待，提前捕获工具返回的错误；失败时终止并等待本次 helper，不把等待超时当成功。
5. **生效与重启**：只改测试文件，下次执行审计即生效，无需重启 App 或更新运行时。Windows 原有条件分支不执行 POSIX wrapper，未在 Windows 实机验证。
6. **验证**：用 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（v24.21.0）分别在隔离 `DSH_HOME` 下运行目标测试，受限 PATH 和普通 PATH 均 exit 0，输出 `serialized media, queued cancellation, helper reaping and late ASR result cancellation passed`。就绪标记在 signal handler 注册之后写，取消与超时都等待 helper 写退出标记并退出；额外保留排队取消和迟到 ASR 结果断言。原审计证据在主树 `_backups/20261106-macos-wp0/native-fixes/checks-20261106T140007Z/audit.log:98`；本文件变更后 SHA-256 为 `c770af5dbcffc6992731fb2f37c8386b7f175bbac670cff25ccd08bfe79aa4fa`。
7. **回滚与残余**：变更前文件备份为当前工作树 `_backups/2026-11-06-bili-ready-fixture/lifecycle-before.mjs`；可单独恢复测试。整个组合 audit、Windows 及真实 App 生命周期未在本子任务重跑，需主会话在最终组合上验证。

## 发布交接

```text
【B站生命周期测试夹具】
现象：App Node 环境 PATH 缺 node 时 helper 无法启动，审计误报就绪失败。
修法：使用当前 Node 绝对路径启动受管 helper，并在就绪失败时回收本次进程。
验证：官方 App Node 24.21.0，普通和受限 PATH 下各一次目标测试通过；原组合审计失败可复现。
范围：仅测试夹具；没有改产品功能、版本或发布。完整组合审计和 Windows 待主会话验证。
回滚：恢复 _backups/2026-11-06-bili-ready-fixture/lifecycle-before.mjs。
```
