# Memory V2：Native Root 可重试退役确认

状态：局部实现与独立验收通过；总目标未完成，未安装、未切换生产。

## 1. 链路

插件 Host 的 `bili-v2-host.mjs` 创建 `memory-v2-native-root.mjs`，后者持有独立 Cordis root、实际 agent handle、preset、借用的 LLM hook、动态工具 disposer 和子插件 fiber。Bili 初始化失败与显式退役都走这些原对象；QQ owner 正在按同一私有接口开发。

## 2. 机制与修复

旧 `close()` 在清理前设置 closed，后续直接返回；agent/hook/context 清理失败就失去重试机会。动态工具也在 unregister 成功前删除了 disposer。创建中的 agent 尚未进入 handles，关闭还能提前确认。

现在 closed 立即阻止新调用；retired 仅在全部清理确认后成立。关闭合并并发请求，等待原创建任务结束及其卸载，依次清理原 handles、工具、preset/hook、逆序 fibers 和根 context。每个动作成功后才从待清理集合移除；失败保留该动作及依赖，下一次关闭重试。同步工具撤销保留同步语义，异步撤销等待原 Promise。

`getStatus()` 暴露 closed、retired、pendingCreations、activeHandles、activeTools、pendingCleanup。初始化中清理失败通过非枚举 `error.retryCleanup` 保留 Host 私有能力；Bili Host 接住它，允许没有 source 的待退役实例查询状态并显式重试。该函数不进入 JSON 或模型上下文。

## 3. 影响面

影响一个插件 Host 内的托管 Native root 与其清理读者。V1 默认和审批约束保持。失败返回结构化 code/error/hint；新作业被拒绝。没有实际用户数据、凭据、真实模型调用或平台发送。

## 4. 取舍

选择按依赖顺序保留失败动作，便于对原所有权重试和审查。继续清掉全部父依赖会妨碍子对象重试；直接换新 Root 会遗留旧资源，均不采用。共享 Root 修复避免在 QQ adapter 再造一层清理框架。

## 5. 生效

代码由插件 Host 加载。需完整门禁后安装桌面插件并按既有流程重载；本阶段没有重启运行中的 DeepSeek Harness.app。

## 6. 验证

使用 `/Users/shizihan/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`：

- `plugins/surfcore/scripts/test-memory-v2-native-retirement.mjs`：12 场景通过，包括六类失败重试、同步/异步工具撤销、并发关闭、初始化失败能力、实际 Bili 函数恢复和创建/关闭竞态。
- `plugins/surfcore/scripts/test-memory-v2-native-root.mjs`：实际安装 SDK 的隔离 Host 验证通过；一条假 provider 请求，未证明后续输入被拒绝，原 agent 卸载，网络拦截列表为空。
- `plugins/surfcore/scripts/test-memory-v2-bili-host.mjs`：完整普通 Host 回归通过。

证据：`_backups/memory-v2-coordinator/native-retirement/`。`red-retry.log` 复现第二次关闭仍遗留 agent；`red-creation.log` 复现创建中提前 ACK；`retirement-final.log`、`native-root-final.log`、`host-final.log` 为最终通过。

## 7. 回滚与残余

原 Root/Host 文件备份在上述目录，按具体文件恢复并保持 V1。实际 QQ source/Bridge/预算联合、Core 生命周期、正向 Bili 单轮、迁移尾增量与全门禁仍待完成。隔离 SDK 成功不代表生产激活或桌面安装通过。

## 发布交接块

- 范围：Native Root 可重试清理、创建/关闭竞态、Bili 初始化失败所有权。
- 文件：`memory-v2-native-root.mjs`、`bili-v2-host.mjs`、新增 retirement 测试与本 case。
- 验证：普通12项、实际 SDK Root、完整 Bili Host 已通过；真实 provider/平台外发0。
- 状态：阶段接受，禁止据此发布；尚未提交/安装/激活。版本由发布会话决定。


### 2026-11-11 11:38 当前工作树阶段门禁通过

`npm run test:audit` 176/176 scripts passed；`npm run test:regressions` 全部通过。日志和receipt见 `_backups/memory-v2-coordinator/phase-gates-2026-11-11/`。最终 Root 普通12项、实际SDK1条假provider请求及完整Host复验均通过，见 native-retirement/verification.json。上述为当前阶段基线；QQ Native owner最终变更尚待独立Native复验，来源/Bridge/预算联合、Core生命周期、迁移尾增量与全目标验收仍未完成，不能进入提交/安装或生产切换。
