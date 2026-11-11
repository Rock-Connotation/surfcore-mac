# QQ修复按功能提交、合入dev与无用本地资料清理

## 现象、根因与授权

用户要求将已验收的QQ修复按功能提交，合入dev或main，并删除其它本地分支/worktree及指定七个目录。QQ树有41个改动文件、基线748afe6；主目录main另有Phase A–E。七目录合计24,260,184 KiB，约23.14 GiB，主要是历史程序快照、依赖、ASR夹具和验收材料。

最初按保留独有历史资料准备内容去重归档；用户随后明确：“这些对当前业务有用吗？没有用的话……删了，不需要备份。”已核对这些资料不参与当前业务，停止归档并删除原七目录及本次生成的归档、临时索引/测试副本。历史资料未保留恢复副本；最新有效源码已在Git中，不依赖它们。

## 完整逻辑

1. **链路**：QQ工作区冻结tree f90fb609 → 四个功能commit → dev快进接纳main9eb4028 → no-ff合入QQ修复 → 按合并HEAD生成安装清单 → 组合测试 → 依赖/cwd/祖先关系核验 → Git移除worktree/分支 → 按用户新授权直接删除无用资料。
2. **机制**：按既有冻结候选对象拆分同文件的功能，未倒退最终工作区。四批完成后Git tree与原冻结tree完全一致。bridge冲突保留Native QQ默认安全拒绝和新执行器，同时保留TaskLedger/TaskHarness；harness保留双方访问器；插件入口保留主线改动，文档保留双方历史。
3. **爆炸半径**：仅本地Git、两个临时树的语言索引进程和指定资料。本机项目与DSH依赖symlink均不指向七目录，profile包声明/锁指向其它受保留路径，安装SurfCore是独立实体目录。删除前七目录无进程cwd。未改当前DSH程序、profile、角色、聊天、密钥、记忆或额度；未调用真实模型、合成或QQ。TypeScript索引进程按cwd/argv精确退出；DSH与桥接未重启。
4. **取舍**：A对所有历史资料做内容去重归档，保留追溯能力但仍占数GiB；B确认当前业务无依赖、源码已入Git后直接删除。用户明确选择无需历史备份，因此采用B；不以“独有旧测试结果”等同“当前业务必需”。第一版raw复制及流式CAS都已取消，中间产物一并删除。
5. **生效与重启**：主目录当前dev，仅保留main/dev；main仍为9eb4028。当前运行程序仍是此前真实验收的3927fa47候选，合并HEAD未重新部署；本次无需DSH或桥接重启。版本仍0.8.8，无push/tag/Release。
6. **验证**：四个实际暂存树各跑关联隔离测试；合并HEAD2210660在官方Node24/隔离DSH_HOME下通过audit195/195、协议17、Phase A/B-C/D-E、完整插件（含34插件V2脚本）及完整Memory V2 49项。安装清单1081项/0问题。后续仅清理记录与清单变化，再核对最终manifest、Git状态、剩余工作树/分支和路径不存在。
7. **回滚与残余**：源码可从dev历史或指定提交重新建树，不恢复已明确放弃的历史测试资料。当前运行程序已有的回滚目录/真实用户数据不在本轮删除范围。主线原有Memory生命周期callback缺少epoch推进，服务仍以MEMORY_RETIREMENT_REQUIRED失败关闭；本次未扩成新功能实施。profile重装可能覆盖已实装候选的历史差异未在本轮改动，详见原QQ案例。

## 功能批次

| 提交 | 功能 |
| --- | --- |
| 4b86c0d | QQ桥接接通原生宿主回复与发送回执 |
| 03e4581 | 记忆授权结果可见、角色资源退役与测试隔离 |
| 7227f5f | QQ原生语音合成、取消与可靠发送 |
| 2b9d625 | 白名单同页处理许可与重复提醒收敛 |
| 5bef7e1 | 合入dev并保留Phase A–E |
| 2210660 | 从合并Git对象刷新安装清单 |

## 清理核对

- 已移除worktree：`surfcore-memory-approval-fix` @748afe6、`surfcore-qq-reply-fix` @2b9d625；均clean且HEAD为dev祖先，用git worktree remove、不带force。
- 已删除本地分支：`fix/memory-approval-ui`、`fix/qq-reply-discovery`、`refactor`；全部已包含于dev，使用git branch -d。
- 已删除五个资料目录：`_surfcore-cleanup-20261108`、`_surfcore-qq-reply-backups-20261111`、`_surfcore-test-artifacts-20261110`、`_surfcore-voice-host-20261108`、`_surfcore-volc-final-20261108`。
- 已取消并删除本次归档目录 `~/.dsh/_backups/surfcore-consolidation-20261112` 和 `/tmp/surfcore-commit-cleanup-20261112`。未把资料换位置继续占空间。
- 原始测试日志随无用资料删除；验证命令及结果保留在本case，真实语音/群回复结果仍见两个QQ原案例。

可用空间实测（df -k，同一数据卷）：5,348,252 KiB → 25,880,496 KiB，约5.1 GiB → 24.7 GiB，增加约19.6 GiB；与目录du之和不同，受共享文件、并行业务写入和本轮测试产物影响，不把逻辑文件大小冒充实际释放量。

## 一句话验收

`git status --porcelain`为空；`git worktree list`只有主目录；`git branch`只有dev/main；七目录均不存在；`node scripts/release-manifest.mjs --verify-ref HEAD`为0问题。

## 发布交接（可直接转发）

```text
改动：QQ原生文字/语音、记忆审批结果、白名单同页许可及提醒四批，已合dev并保留Phase A–E；main不变。无用开发资料按用户明确“不备份”要求删除。
验证：audit195/195、协议17、完整插件（含34插件V2）、全Memory49、Phase A–E；最终清单与Git状态核对通过。
建议：沿QQ修复建议patch，由发布会话决定版本；本轮不发布。
case：docs/cases/2026-11-12-functional-commits-and-safe-cleanup.md。
层级：QQ内部执行和设置交互；V1默认与精确处理授权边界保持。
完整逻辑：本case七步及两个QQ原功能case；当前运行程序/用户数据未受清理影响。
失败：原功能有code/error/hint和失败断言；清理遇到脏工作树、未合并或运行依赖立即停止，不force移除。
未验证：合并HEAD未重新部署常用DSH；既有Memory生命周期实际退休缺口及包管理来源差异已注明。
```
