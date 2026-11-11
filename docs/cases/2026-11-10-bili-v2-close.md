# Bili V2 关闭：先确认退休与注销，再释放 owner

状态：CLOSE run1/3 已通过协调者独立验收；生产 Host 装配、完整 Memory V2 门禁与桌面安装尚未完成。保持 V1 默认。

## 完整逻辑

1. **链路**：`plugins/surfcore/lib/bili-v2-agent.mjs` 创建受管理 Bili Agent，注册工具 guard、LLM stream hook、preset，并持有预算 owner。`bili-v2-host.mjs` 的关闭与角色退休调用此入口。旧关闭只注销 preset，两个订阅仍在；其 finally 又在退休失败时标记关闭并释放 owner，显式重试无法补完。
2. **机制**：新增 shuttingDown 从关闭开始阻断新作业与迟到 stream；共享 closeTask 合并并发关闭。依次等待退休、hook、guard、preset 的 ACK，再同步释放预算 owner 并标记 closed。每个 disposer 仅在成功后清空；失败保留未确认对象及 owner，返回结构化错误，显式重试只补未完成项，不重放作业。预算 owner 的 close 是既有同步接口；不把它当作异步 ACK。
3. **影响面**：一个插件 Agent runtime 的关闭入口及测试；不修改 Memory Core、平台消息或默认后端。失败场景用隔离 fixture 模拟 ACK 拒绝；真实 SDK 联合验证只替换官方 HTTP 与 provider。没有真实模型、费用、平台发送、用户数据迁移或安装。
4. **取舍**：选择在原入口维护关闭任务与逐项确认，重用既有退休协议；另建全局关闭管理器会增加跨模块状态与重试协调。把 finally 无条件释放改成成功链尾，允许失败后保留所有权与显式恢复，代价是失败时保持关闭接纳，直到管理员处理后重试。
5. **生效与重启**：最终插件安装到 macOS DeepSeek Harness.app 后需重新加载插件运行时。当前仅在工作树及隔离实际 SDK 环境验证，未重启公共 Host、未改变 desktop profile。生产装配的可见失败仍在主任务范围内。
6. **验证**：Node24 `plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs --ordinary` 为42场景（38旧+4新），来源旧版32场景保持通过；父端实际 Host 工厂/DefaultModel/Memory Worker/预算 fixture 为1次合成 provider、15 tokens、jobs/sources=0，65537字节 persona 反例在 provider 前拒绝。父端 Source native fixture 保持2次调用/2个实际输入/1个输出/2个来源/30 tokens，晚撤销阻断、未知 shell 拒绝、derived 不持久化，外网与平台写入均为0。生产激活未验证，测试库仅合成预激活。
7. **回滚与残余**：`_backups/memory-v2-bili-close/original/` 保存修改前字节；父端独立证据在 `_backups/memory-v2-coordinator/bili-close-independent/`。回滚先保全现状，再恢复原模块及测试，不能删除 owner 锁以绕过未确认退休。实际生产 lifecycle/index/scheduler 仍由后续装配验收；此模块通过不代表整个 Memory V2 已完成。

## 失败与恢复

退休或注销拒绝返回既有 `BILI_V2_RETIRE_FAILED` 等结构化 code/error/hint，getStatus().ok=false；新作业继续被拒绝。排除未确认退休或订阅注销原因后，显式再次 close，已确认的项不会重复注销。父端实测 owner 在失败时仍持有、成功时释放，并发/重复关闭不双注销。

## 可直接转发的发布交接块

改动：Bili V2 关闭先等待退休及 hook/guard/preset 注销，再释放 owner；失败保留未确认项，显式重试不重放作业。
范围：Agent runtime、对应42场景测试、关闭契约与本case；无 Core/平台协议或默认后端变化。
验证：协调者 Node24 42+32 场景及真实 Host/Source 两套 native fixture 通过；全部为合成 provider/官方 HTTP，无外网和平台写入。最终全仓门禁待冻结后运行。
生效：尚未安装；最终只安装到 DeepSeek Harness.app desktop，保持 V1，不自动迁移或正式切换。
回滚：保全当前字节后恢复 original 对应文件；未确认退休不得以删锁绕过。
