# 已合并 worktree 默认收工清理（2026-11-10）

用户确认：已经合并的 worktree 可以删除以节约空间，并将其作为项目长期规则。

## 完整逻辑

1. 链路：AGENTS §1.9 以短指针连接多会话工作流 §4.1；协调登记保存每次核验和移除回执。后续收工会话执行。
2. 机制：Git 的 merged 表示提交祖先关系；新建空分支也可能满足。因此先证明任务完成/合并验收、无人使用、内容已保全，再移除登记的 worktree。
3. 爆炸半径：只处理已核对的临时副本，不覆盖其他工作树、不删除未提交或唯一 ignored 数据、不改生产配置。当前四棵树全部保留。
4. 取舍：默认安全清理能阻止副本长期累积；逐个重复审批增加负担，现采用用户长期授权。整树复制再删除不能有效释放空间，Git 已存提交仅记恢复引用，唯一的非 Git 内容才另行保全。
5. 生效：后续会话读取 AGENTS 即获得入口；不需 DSH 安装或重启。分支默认保留，可重新添加工作树恢复。
6. 验证：核对四棵树的 porcelain 状态、ignored 清单、实际目标祖先关系和新分支 reflog。发现 voice-quota-500 于 17:35:58 刚建，未把 merged 列表当完成证明。本轮只改文档，执行 diff/whitespace/文档指针检查；未执行删除，释放空间为 0。
7. 回滚与残余：编辑前原文保存在 `_backups/memory-v2-coordinator/worktree-policy-*/`；恢复明确文档即可撤销规则。本次没有符合条件可移除的树，磁盘不足未解决；不宣称 ASR 或总门禁恢复。

## 可直接转交发布会话

- 文档改动：AGENTS.md、docs/guides/MULTI-SESSION-WORKFLOW.md、docs/COORDINATION.md 与本 case。
- 长期授权：合并验收完成、无人使用、内容保全后默认移除临时 worktree，无需重复确认；不使用 --force，不连带删分支。
- 验证：四树实际核验、文档指针与 whitespace；无运行时代码改变，无需重启，无版本/提交/推送/发布动作。
- 结果：当前无安全清理候选，全部保留；磁盘资源门禁仍未通过。


## 完成判据的实际应用（2026-11-10 18:11）

此前四树均保留是当时状态；随后用户明确要求优先完成后提交合并清树，并确认旧语音准确47文件/两条中文message。协调者比对已验收候选902文件且独立18脚本通过，得到功能48723db及文档cf36f0b。新建独立dev集成树，--no-ff合并08acae9，再从Git对象生成安装清单为17c9b1f；verify-ref HEAD为883项、问题0，main94a4a78未变。

`../surfcore-volc-voice` 在无活动句柄、tracked/untracked干净、3860项独有ignored逐SHA/链接复验、分支祖先检查后，由 `git worktree remove -- <已核对绝对路径>` 非force移除；feat/volc-voice-mac仍指向cf36f0b。配置/状态/回滚材料保存在仓库外受限归档（权限0600），node_modules可重建。收口receipts在 `../_surfcore-test-artifacts-20261110/voice-worktree-removed.json`。Memory未完成与quota-500新树继续保留；不把HEAD已包含于main误认为任务已交付。无push/版本/发布/公共重启。
