# Harness 原会话连续请求失败：HY4 额度与共享冷却

## 现象与证据

目标为原生 DeepSeek Harness.app 的 session-4473bab2-d56f-4ad4-ab47-70e7694767b6。2026-11-11 02:01、09:53、09:55、09:56 连续失败；10:00 手工停止。主会话实际模型为 magpie-responses/codex/gpt-6.1-sol，High，不是 HY4。

Magpie 本机 app.log 的 02:00:07 与 09:52:36 原因一致：workbuddy/hy4free 超出频率额度，服务器给出的重置时间为 2026-11-11 10:14:14 UTC+8。原会话收到的 bili_throttle_hold 是后续本地抑制，不是 Sol 自己额度耗尽的证明。历史 EOF/600秒 idle timeout 曾发生于前几轮，但最后这批失败的直接原因是共享 429 hold。

## 完整逻辑

1. **链路**：原生会话 → DSH provider → Billion Context 0.1.213（本机18787）→ Magpie（本机3425）→ Codex/WorkBuddy。HY4 子任务和 Sol 主会话使用同一网关 origin、同一凭据桶。读取实际压缩会话、原生界面、Magpie日志和已安装插件源码相互核对。
2. **机制**：Billion Context 默认 network.throttle429Scope=credential。未带可识别模型限流标记的 HY4 429，被归为 origin+credential 的 hold，连带拦截 Sol；Retry-After 被尊重，DSH 的5次短重试仍都落在冷却内。切换子代理为 Terra 本身不能解决共享桶。
3. **爆炸半径**：主要是一个代理进程及其网关模型请求读者；本轮2类模型读者、报错系数1，至少1×2×1=2。全局 bili 网络选项覆盖由该用户配置管理的请求；按模型隔离适合当前多供应商网关，真正账号级配额若跨模型共享，兄弟模型也可能各收到一次上游429后各自冷却。未修改账号、ACL或项目源代码。真实验收只有一次原会话Sol请求，工具调用0。
4. **取舍**：A等待10:14:14重置，无修改成本，但再次用满HY4会重演；B采用已安装插件正式提供的model粒度，单字段、可恢复、保留429治理，避免跨模型阻塞。选择B。未关闭限流或删除压缩状态。
5. **生效与重启**：用户配置 ~/.config/billion-context/billion-context.json 新增 network.throttle429Scope=model。实际getter每次读取文件内容，缓存按raw文本失效；运行中的 /__bili/config 已读回model。旧credential hold不会自动改归属，须到期；本次10:02:40已到期后验收成功，不需要重启公共Host/桥接。
6. **验证**：提取已安装包实际限流函数，以隔离VM和无秘密假凭据复现旧credential设置阻塞Sol；读取新配置后验证HY4返回bili_throttle_hold且model/message/retryAfterSec非空、Sol和Terra放行、未知model仍按credential处理。首次提取边界误含下一模块import而SyntaxError，修正提取边界后5项通过，未修改安装包。10:05原生App原会话单次仅验证消息返回“原会话回复正常”，turn23 completed，约7秒、工具0。它证明Sol原入口已恢复，不证明HY4额度已恢复或Terra真实上游已调用。
7. **回滚与残余**：修改前完整配置保存在 ~/.dsh/_backups/session-4473-throttle-20261111-100449/billion-context.before.json（受限权限）。回滚时先保存现文件，再仅删除/恢复本字段，避免覆盖后续配置；文件热读，无需重启。HY4真实额度仍以服务器为准，本轮未额外重试HY4。DSH短重试仍存在，现已限制在对应模型；不以重试替代等待上游重置。

## Memory V2 实际进展（读取现存文件与证据，未代做原任务）

实际开发树为 ../surfcore-memory-v2，feat/memory-v2；保留全部未提交改动。原生顶部main来自原会话初始workspace，不能代替真实开发cwd。

- 已验收：原始native输入证明修复；PUBLIC-SET41+独立7个恶意描述符反例；VIDEO-SOURCE39、Bagg44、触发器/DM；显式隔离Home的真实Worker/private Host/真实预算+fake provider，两调用/两来源/30tokens、撤权阻断、引用释放；Host接收观察两调用/30tokens；管理原ID恢复及部分UI/生产入口/L2失败链路。
- 当前断点：Official公共读取适配尚无实现。现场production与既有test分别与run1备份逐字相同，新public-read测试及contract均不存在；09:52原会话已发run2工单后被429打断。手动单轮只读报告已存在。
- 后续依赖：先完成Official并独立验收公共视频Host整链，再做V2托管单轮、QQ native/send、实际角色/账号/关闭生命周期、稳定来源/importer/taildelta/迁移预览，最后全量门禁、提交预览/dev合并/清树/桌面Host安装。
- 当前不能称P0–P4完成；V1默认，V2尚未安装或生产切换。正式迁移仍需原计划的预览与确认。历史模块测试不等于最终全仓门禁通过。

断点证据：../surfcore-memory-v2/docs/cases/2026-11-11-memory-bili-host-wiring.md；_backups/memory-v2-coordinator/bili-video-source-independent/verification.json；_backups/memory-v2-coordinator/bili-manual-round-facts/report.md；原会话todo/write seq5549及后续消息。

## 发布交接块

改了哪些文件：本机billion-context.json一个网络配置字段；仓库仅本case/索引/PITFALLS/HANDOFF/协作登记，独立fix/harness-throttle树，基线dev 17c9b1f；未提交。
测过什么、结果如何：实际安装限流函数5项离线通过；运行中配置读回model；原生App原会话turn23 completed/原文回复/0工具。
建议patch还是minor：本机运维配置修复，无SurfCore程序版本变更或待发布制品。
case文档路径：docs/cases/2026-11-11-harness-shared-throttle.md。
改动层级与兼容性：已安装插件公开配置；共享限流粒度改变，未知model保留凭据级；其它provider代理配置逐对象不变。
完整逻辑与爆炸半径：见上文7步，影响本机bili的模型冷却；无生产业务数据迁移。
失败路径：HY4仍会显示429及重置时间；不可在窗口内反复继续，应等上游恢复或使用已授权的其他模型。5项隔离断言覆盖拒绝及模型隔离。
还有什么没验证：HY4重置后的实际成功、Terra实际上游调用；Memory V2原项目未完成事项另见断点清单。

复现命令（无外网、无平台动作）：`node ~/.dsh/_backups/session-4473-throttle-20261111-100449/test-installed-throttle.mjs`；结构化验证结果见同目录 `verification.json`。

仓库最低门禁已完成：独立dev基线工作树、官方bundled Node24下 `npm run test:audit` 退出0，187/187脚本通过；包含既有协议回归。日志为上述私有备份目录 `repository-audit.log`。`git diff --check` 通过。未改SurfCore插件源码。
