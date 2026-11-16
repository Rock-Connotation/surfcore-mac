# 临时许可撤回后伙伴侧栏报红

## 现象与证据

恢复红豆本机聊天许可后，DSH 侧栏显示 `MEMORY_EVIDENCE_DENIED`，点击重载也无法恢复。只读查询确认，本机聊天许可有效，临时合并许可已撤回。实测留下的分享、提问和回复各一条仍引用该临时许可；同一归档中也保留早期缺少 V2 证明的记录。用真实 Memory V2 Worker 重放同样的策略切换，旧实现的伙伴状态接口返回 409 和相同错误码。

## 完整逻辑

1. **链路**。DSH 侧栏轮询和对话页面走 `companion-sharing-controller.mjs`，共享 `companion-sharing.mjs` 的状态读取。模型回复也从同一角色的 `sharing.jsonl` 读取历史。Memory Host 通过 `memory-v2-service.js` 调用 Worker 校验引用，真实附件继续走 `bindInputManifest`。
2. **机制**。分享来源保留写入时的许可编号。旧实现一次绑定整个归档，只要一条历史来源被拒，当前句柄绑定就失败，状态读取也进入阻塞。修复后先用同一 Worker 只读筛选候选引用，跳过已撤权或失效的记录及依赖这些分享的消息，再绑定实际展示或传给模型的全部引用。返回视图、提交回复及网络准入的现有二次校验继续执行。
3. **影响面**。一个 SurfCore Host 的伙伴状态与回复两条入口。读取接口新增可选 `historyNotice`，对话页用普通提示说明历史不可用，侧栏继续展示真正的读取失败。撤权和原始记录均保留。直接回复已失效分享返回 `DOUYIN_CHAT_HISTORY_RESTRICTED`，并在写入及预留模型额度前结束。
4. **取舍**。迁移或移出旧记录只能清理当前症状，后续撤权仍可能复现。Host 只读预检复用原校验契约，既保留归档与授权审计，也处理正常的权限变化。当前上下文失效、Worker 故障和实际绑定失败继续按原错误返回。
5. **生效**。部署匹配的 Core 和 SurfCore 插件程序后重启 DSH，使宿主加载新代码及退休旧句柄。账号、角色文件、授权和预算账本留在原数据目录。
6. **验证**。`node plugins/surfcore/scripts/test-memory-v2-sharing.mjs` 从同码报错转为通过；覆盖恢复本机许可、混合历史过滤、拒绝的回复零写入零模型、有效分享独立回复、发送前撤权以及 Worker 故障仍可见。`node plugins/surfcore/scripts/test-companion-sharing-ui.mjs` 验证普通提示只在对话页显示，侧栏仍可打开。
7. **回滚**。退出 DSH 后以备份 `program-previous` 还原插件程序，再启动 DSH。回滚只涉及程序目录，旧版可能再次触发侧栏报错。

## 本机验证

- DSH 桌面安装本地候选 `d8405912bc0d800e14fc8064d7617d00f1d0fb90`。安装的 404 个清单文件全部匹配，原程序留在 `~/.dsh/_backups/surfcore-companion-history.J22AP9im/program-previous`。
- 重启后原生侧栏没有 `MEMORY_EVIDENCE_DENIED` 和「重载状态」，可打开「和红豆聊聊」。面板显示没有当前可回复的分享，以及普通的历史权限提示。抖音发现日记上方仍明确提示平台许可缺失，聊天区成功加载。
- SQLite 只读复核确认本机许可的受众和处理授权与原范围相等，临时合并许可仍撤回。分享归档 SHA-256 与部署前一致，验收账本仍用 12 次。实机本轮仅打开面板；有权限的新分享回复由隔离夹具验证。
- `npm run test:audit` 207/207，`npm run test:regressions` 通过，`npm run lint:failures` 通过，伙伴和 Memory Host 相关 9 条插件脚本通过。完整插件套件前两次分别遇到 Host 并发夹具超时与 B站部分点评夹具报错，完整串行复跑通过，包括 37 条普通 Memory V2 脚本。

## 发布交接

```text
范围：修复伙伴侧栏因历史分享撤权报红，同时过滤回复使用的历史。
文件：src/core/memory-v2-service.js、plugins/surfcore/lib/{memory-v2-host,companion-sharing,douyin-companion-page}.mjs，及伙伴 UI、V2 分享回归。
层级：Host 内部新增只读校验；状态 JSON 新增可选 historyNotice；现有权限及实际输入准入保持。
失败分支：失效历史在对话页提供说明。直接选择失效分享返回错误码和操作提示；Worker 与实际附件异常走原失败状态。
验证：全量审计 207/207，协议回归、完整插件套件与 DSH 原生侧栏复验通过。本轮真实环境没有新授权分享，回复行为由隔离夹具验证。
版本建议：随下次 patch，Core 与插件一起交付。完整机制和验收见 docs/cases/2026-11-16-companion-history-revocation.md。
```
