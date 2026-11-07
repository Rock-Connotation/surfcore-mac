# 直接模型用量必须区分内存接受与持久确认

范围：新增durable opt-in，原采样/批处理默认保持。

## 完整逻辑

1. **链路**：新抖音模型消费者 → token-budget.recordExternalUsage → 采集状态/每日用量两文件。原桌宠/B站等调用不带durable，继续批处理。
2. **机制**：旧true仅表示内存累计并安排800ms后写盘，实际persist失败只日志。新调用不能把它当已记账回执；durable模式立即写两文件、同步文件/目录，全部成功才true。
3. **爆炸半径**：1 Host×新增直接消费者1×显式错误1=1；原默认调用契约不变。涉及已产生模型用量，不回退或返还失败确认的累计。
4. **取舍**：全局强制同步会改变既有采样成本；新增显式durable参数仅给需要持久回执的调用。同步帮助单独模块，旧文件保持800行以内，可移除新调用回退。
5. **生效**：Host重载；新模型消费者传durable:true，失败返回可行动的COMPANION_USAGE_PERSIST_FAILED并停止活动。
6. **验证**：原用量39项通过；新增`test-token-budget-durable.mjs`实际注入state/daily rename与fsync错误，不能确认成功，原batch仍true且不即时sync。Host等待期限/用量抛错专项通过；Astra V2独立故障注入证明关闭两P2。
7. **回滚与残余**：关闭新活动并回装旧包；保留实际用量/调用账本。供应商真实尝试次数另对账，不能因客户端零重试声称上游零重试；不是金额硬上限或真实供应商成功证明。

## 发布交接块

```text
改动：token-budget.js新增durable可选参数；token-budget-sync.mjs同步持久文件/目录；新增故障回归。
验证：原39项与新durable专项、Host专项、Astra V2复审通过；组合见总集成case。
建议：patch兼容增量，由发布会话决定；本轮不发布。
case：docs/cases/2026-11-07-direct-usage-durability.md
层级：内部可选确认语义，默认兼容；新增消费者可见code/error/hint。
失败：写盘/同步失败返回false，新消费者停止；保留已经发生的用量，不自动重试。
残余：真实模型与跨设备验证见总case；回滚不清空账本。
```
