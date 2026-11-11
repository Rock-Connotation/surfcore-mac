# QQ 消息段发送：未知结果不得自动重发

## 现象与根因

QQ B站小程序分享调用 `src/bridge.js` 的 `onebotSendSegments`：V2 发送 lease 已获取后，如果网关请求拒绝或超时，原代码直接抛错，未提交 `delivery_unknown` 回执。`src/bili-card.js` 随即把异常视为可回退原因，再发文本链接；第一条可能已送达，第二次发送可能造成重复。另一个不完整的 HTTP 200 / status ok 响应可能没有有效 message_id：原回执为未知，但函数和分享调用者报告成功。模拟拒绝的原始复现为 lease 终结次数 0，调用者级复现为发送次数 2；缺失 message_id 的复现为未确认投递被报告成功。

## 完整逻辑

1. **链路**：B站分享 sender → `onebotSendSegments` → `beginMemoryV2Send` 的来源 lease → OneBot 请求 → `finishMemoryV2Send` / `qqMemory.recordSent`，调用者依据结果决定是否回退文本。普通文本和原生 bot 包装器仍使用原有处理。
2. **机制**：网络拒绝、超时、非明确拒绝的 HTTP 响应无法证明消息未送达；成功响应缺失或含无效的 QQ message_id 也不能证明送达。有效 ID 为非零安全整数或非零十进制整数字符串（包括负数）；支持现有嵌套 data 形状。将原 lease 恰好终结一次并记录 `delivery_unknown`；未知或回执失败带结构化 code/hint，禁止 miniapp 自动二次发送。只有发送前 ARK 准备失败或明确 OneBot 应用拒绝才保留原文本回退。`MEMORY_*` / `CHARACTER_*` 拒绝不回退。
3. **爆炸半径**：单个 QQ bridge 进程 × B站分享调用者 × 可见错误路径（权重 1）= 1；直接涉及该发送的消息及原角色来源回执，不读写凭据、不调用付费模型。失败保留原 owner/epoch 的记录语义，无法从未知状态推断送达。
4. **取舍**：A 无条件回退可用性高，但可能重复投递；B 按明确拒绝与未知结果分流，复用既有 lease 和 gate，保留明确失败时的回退。选择 B；无需新增全局锁或重发协议。
5. **生效与重启**：实现由 QQ bridge 和其加载的 B站分享模块读取；当前工作树未安装、未重启，生产生效需由后续授权的安装/启动流程处理。V1 默认及生产切换均未更改。
6. **验证**：Node 24 的隔离夹具验证拒绝、超时、成功、明确应用拒绝、坏响应、HTTP 500、回执拒绝或异常；真实生产函数与 sender 在 VM/fake fetch 组合中证实未知结果只发送一次。原始角色/epoch 回执和隔离真实 Host fixture 由既有 QQ 专项覆盖。未调用真实 QQ/网关或模型。
7. **回滚与残余**：以 `_backups/memory-v2-qq-segment-lease/bridge.before.js` 和对应 B站 sender 备份为精确修改前基线，须保留工作树原有未提交内容；仅由负责人核对差异后局部回退。QQ native session proof / budget 以及完整生产 V2 验收属于独立未完成工作。

## 失败与下一步

`MEMORY_QQ_DELIVERY_UNKNOWN` 提示先核对原消息和记忆回执，再决定是否人工重试；`MEMORY_QQ_RECEIPT_FAILED` 提示检查原回执并保留原角色恢复。具体回执拒绝继续保留其原始 code/hint。单元夹具断言失败时不报成功、不重复发送、code/hint 非空；原调用者继续返回 `false`。

## 验证证据和限制

- RED：`_backups/memory-v2-qq-segment-lease/red.log` 为拒绝后 lease 终结 0；`card-red.log` 为未知发送后调用 2 次；`response-red.log` 为坏响应未标记未知；`run2-red.log` 为缺失 message_id 时错误报告成功。
- GREEN（Node 24）：`scripts/test-memory-v2-qq-segment-lease.mjs`、`scripts/test-bili-card-ark.mjs`、`scripts/test-memory-v2-qq.mjs`、`scripts/test-memory-v2-qq-integration.mjs`；`run2-green.log` 覆盖缺失/无效 ID、未知回执失败及调用者不重发。日志在 `_backups/memory-v2-qq-segment-lease/`。
- 验证失误：误启动 `scripts/test-bili-card.mjs`；其在读取不存在的工作树 `config.json` 时立即以 ENOENT 退出，未读配置、未访问网络、未发消息。随后确认它是实际平台发送探针，未重试；它不属于隔离测试。
- 全量 audit、regression 和插件最终门禁本工单未获授权运行；真实安装、QQ 平台和生产迁移均未验证。

## 发布交接块（尚不可发布）

文件：`src/bridge.js`、`src/bili-card.js`、`scripts/test-memory-v2-qq-segment-lease.mjs`、`scripts/test-bili-card-ark.mjs`、本 case。实现层补未知发送回执与禁止不安全回退；caller 内部错误增加结构化标记，明确拒绝与发送前失败仍可回退。局部隔离测试及结果见上；建议并入整体 Memory V2 后再由发布会话评估 patch；接口兼容与最终门禁须协调者审查。尚无生产安装/平台验证，不得据此发布或激活 V2。


## 协调者独立验收（2026-11-11 11:32）

run2/3已接受：实际diff审查及独立segment/card回归通过，前一轮QQ adapter/integration也通过。HTTP成功仍须非零安全整数或合法精确整数字符串message_id；缺失/非法返回MEMORY_QQ_DELIVERY_UNKNOWN并保留一次原租约结果，receipt拒绝或抛错也不能报告成功/自动补发。证据 _backups/memory-v2-coordinator/qq-segment-independent/。实际QQ Native来源与预算接线仍未完成。
