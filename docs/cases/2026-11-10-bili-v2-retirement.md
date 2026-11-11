# Bili V2：确认退役后释放私有上下文

状态：隔离模块与实际 native 复验通过，生产生命周期接线仍在进行；未安装、未提交、未切换默认。

## 现象与根因

真实 agent 已取消并卸载、队列已确认清空后，Bili runtime 的 jobs Map、source runtime 的 states Map、private root 的 handles Set 仍持有对象。原来只做物理退役，没有清理包装层的所有权引用。新 RED 先证实 releaseJob 未调用（0 !== 1），来源端没有该方法。不能通过删持久拒绝登记或改成共享主会话解决。

## 完整逻辑

1. **链路**：`bili-v2-agent.mjs` 创建专用 agent；`bili-v2-source-runtime.mjs` 为该 job 保留输入证明、opaque handles；`memory-v2-native-root.mjs` 持有实际原生 handle。任务完成和管理退役都经过 finish。源码与测试均核对了这三个读者。
2. **机制**：finish 先停止准入，等待正在创建的真实会话完成，再取消、等 idle、验证原队列/收件箱为空及卸载 ACK。随后才 releaseAgent、释放注册工具、releaseJob、删除请求 scope 和 jobs。失败保留阻断状态，显式重试可重新核验，不触发平台重发。releaseJob 对同一 job 的并发释放合并一次；释放开始后旧证明即拒绝，迟到的 capture 会释放新返回的 handle。
3. **爆炸半径**：修改私有 Host 的三个模块，不写公共 profile、凭据或用户原始来源库；主要主动读者为一个 Bili runtime，失败按结构化结果返回（局部估算 1×1×1）。真实 Worker 来源仍保留，释放的是临时证明/会话引用。生产 UI 的失败呈现和管理器全链路仍待组合验收。
4. **取舍**：每次任务后关闭整个共享 root 会打断其它活跃任务；选择逐 job 释放，保留旧 ID 拒绝登记。为保留既有 2/2/30 验收，sourceCount/admittedInputs/committedOutputs 改为无正文累计计数，另以 jobs/activeSourceCount 表示活跃持有量。没有以计数代替实际 ACK。
5. **生效与重启**：隔离测试已生效。生产安装后需重新加载桌面插件私有运行时；本次未安装或重启公共 Host，V1 默认不变。
6. **验证**：Node24 来源 30 项、runtime 37 项通过，包括未确认退役保持阻断、确认后原 ID 继续禁用、创建中退役、并发释放和 capture 晚到。实际 App Electron-as-Node 的完整来源 fixture 仍为 providerCalls=2、sourceCount=2、committedOutputs=1、30 tokens、lateRevocationStopsOutput=true、derivedPersisted=false；新增断言 jobs/activeSourceCount/activeJobs/activeHandles/activeTools 全 0，实际 SessionStore 该 ID 也已移除，外网=[]、平台写=0。provider 与官方传输仍为 fake，真实 Worker/private Host/budget/codec 与退役 ACK 均实际执行。
7. **回滚与残余**：修改前 5 文件保存在 `_backups/memory-v2-coordinator/bili-retirement-cleanup-20261110/` 同名路径，恢复时先隔离当前版本；不删拒绝登记或用户来源。生产 Bili、QQ、Douyin、生命周期管理器、迁移与最终总门禁仍未完成。旧 native 测试在退役后期望 SOURCE_CHANGED/STALE；新行为先返回 JOB_UNBOUND。运行中撤权 SOURCE_CHANGED、30 tokens 与拒绝晚到输出仍有单独强断言，未把拒绝改成成功。

## 复验

`node plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`；`node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs`。

实际 native：`SURFCORE_BILI_SOURCES_NATIVE=1 ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --expose-internals plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`。完整日志在上述备份目录的 `source-native-session-store.log`；普通 RED/最终 GREEN 与 verification.json 同目录。

## 可转发发布交接块

- 版本/提交：未改版本、未提交，不是发布。
- 改动：Bili 私有任务在真实退役 ACK 后释放 source/root/request 活跃引用，失败保持阻断并允许显式核验重试。
- 验证：普通 30/37 项；真实 native 2 calls/2 sources/30 tokens，活跃引用 0、SessionStore ID 不存在、晚撤权阻断，零外网/发送。
- 生效：待完整 P0–P4 与合并后从长期代码安装到 DeepSeek Harness.app desktop profile；保持 V1。
- 回滚：上述 5 文件预编辑备份，保留持久拒绝登记；生产迁移/正式切换仍须另行预览确认。
