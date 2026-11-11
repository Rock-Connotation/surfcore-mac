# QQ Native 输出观察：在交付分片前验明原请求，取消后确认卸载

日期：2026-11-11。状态：owner 输出观察能力独立验收通过；Source / Bridge 组合尚未完成，未安装。

## 1. 链路

`plugins/surfcore/lib/qq-v2-native-owner.mjs` 在私有 Native Root 的实际 `llm/stream` 钩子内调用可选 `sourceAuthority.captureModelOutput`。同一 dispatch 的 start/chunk/complete/failed 都携带原 SDK options、原预算 DTO request、原 preparedConfig 和唯一 dispatchId；分片先通过观察回调，再交给 SDK 下游。当前生产尚无 QQ V2 Source 工厂使用这个观察能力。

## 2. 机制与失败

既有 owner 只能检查输入与发起推理；后续来源账本还需要知道哪些 assistant/tool-call 内容确实来自这一次实际 Native 输出。此次加入分阶段观察并钉住对象身份、冻结并比较实际配置，拒绝分片或请求在检查期间被改写。观察异常或拒绝固定返回 `QQ_NATIVE_OUTPUT_UNPROVEN`，包含 code/error/hint，不回显回调抛出的敏感文本。只有正常耗尽流才走 complete；抛错、取消或提前结束走 failed。

可选观察启用时，退役先取消实际 agent 并等待其 idle，让迭代器在 Root 仍保留期间上报 failed，再关闭 Root。只有 agent、hook 与 Root 全部清理确认，才标记 retired；清理失败仍保留原资源重试。

新增 `validateOwnedToolContext(execution)` 钉住 guard 观察到的原对象及 agent/tool/name/callId/token/toolSet/args，拒绝突变、重建和过期上下文。这是可信 Host guard witness。实际 SDK 的公开 `checkGuards(copy)` 可被特权 Host 代码用于复制对象再建立 witness，故它不能单独证明工具确实执行或拥有来源/发送权限。后续 Source 必须再匹配实际观察的模型 call ID、名称和参数，并绑定 Kernel 原回执。

## 3. 影响面

影响 QQ 私有 owner 的一个流钩子与可选退役顺序；无 observer 的既有调用保持兼容。既有 owner 场景全部重跑。没有修改 SDK、Root 实现、QQ 平台发送、预算策略或旧 Bridge 路由。没有 UI 变更、真实模型费用或用户状态写入。

## 4. 取舍

备选是让普通回调事后提交 assistant 文本，成本较低，但无法区分真实输出与重建数据。采用实际 Native 钩子内观察，能在分片向下游交付前拒绝变化，并正确记录失败；代价是退役要等待实际流结束。工具上下文只保留 SDK 实际能提供的 witness 边界，避免把一个可复制对象称为不可伪造品牌。

## 5. 生效与重启

未安装或重启桌面 Host，V1 默认。最终 Source / Bridge 组合和全局门禁通过后才安装到用户指定的 macOS DeepSeek Harness.app 桌面 Host；生产迁移/正式切换仍单独预览确认。

## 6. 验证

Node24 独立复跑：

- `node plugins/surfcore/scripts/test-memory-v2-qq-native-owner.mjs`：既有 16 场景通过。
- `node plugins/surfcore/scripts/test-memory-v2-qq-native-observation.mjs`：15 项通过，覆盖回调身份、配置/分片变化、异常、失败一次、上下文 witness 与退役清理。
- 安装中的实际 SDK：子任务最终循环两次假调用/30 tokens；Parent 在冻结文件上再运行独立扩展 fixture，先完成两次真实 Native 框架调用，再让第三次假 provider 流暂停并主动退役。第三次只记录 failed 一次、无 complete，实际 agent 消失、pendingCleanup=0。总计三次假调用/45 tokens，三个 gate，hook 注册/移除 3/3，外网拒绝清单为空，实际 typed tool 执行及 `checkGuards(copy)` 限制均有断言。

证据：`_backups/memory-v2-coordinator/qq-native-observation-independent/verification.json`、`owner-regression.log`、`observation.log`、`native-cancellation.log`。生产模块、测试、契约在 Parent 复验前后 SHA 不变。actual SDK 指框架是真的、provider 是隔离假实现；Source / ACL / QQ Bridge 联合均明确为 false。

## 7. 回滚与残余

修改前 owner/契约快照及 diff 在 `_backups/memory-v2-qq-native-observation/`。该能力尚无生产调用者，可按本组快照恢复，不覆盖其它角色/来源改动。共享 Root 的既有退役修复不属于本组回滚范围。

仍待实际 Native 完整输入与工具结果账本、Core 召回、QQ 原件与 ACL、鲜活身份世代、Bridge 会话与发送联合。本阶段不能把 Source 回调返回 true 的 fixture 作为上线依据。

## 可转发的发布交接块

- 批次：2026-11-11 QQ Native 输出观察与取消；未提交，阶段验收，不可发布。
- 改动：实际流分阶段观察、原配置/请求/分片检查、工具 guard witness、等待实际取消后卸载确认。
- 验证：16+15 普通场景；Parent 安装中 SDK 隔离假调用 3 次/45 tokens，gate 3、hook 3/3、取消 failed 一次及 pendingCleanup=0。
- 生效：尚未安装，V1 默认；完成全链路后安装桌面插件，生产迁移/正式启用另行预览确认。
- 残余：Source、ACL、Core 召回、Native 账本与 Bridge 联合尚未完成。
