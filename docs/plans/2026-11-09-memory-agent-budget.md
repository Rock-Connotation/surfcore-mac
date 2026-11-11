# Native agent inference 预算准入与持久观察去重

2026-11-10，P2-NATIVE-AGENT-BUDGET run1。保留现有 agent 回合；本工单只交付 Host helper/账本/fixture，不改 scheduler/index/频道/UI 或安装包，不触发真实模型、网络、profile、服务或提交。

## 冻结接口

```js
createAgentBudgetMiddleware({
  tokenBudget, getCharacter,
  isAgentLoopRequest, // 必须来自实际运行 Host 的同一个 dsh-llm module instance
  getScope,          // 同步、Host 私有 options -> scope 查询
  isManagedSession,  // 同步 true / false / {ok:false,...}
}).stream(options, next) // async generator
```

`getScope(options)` 返回下列 Host 私有对象，不从模型 arguments/env 中构造 authority：

```js
{
  request: {
    requestId, jobId, category, purpose, role, epoch,
    sessionId, providerRouteId, model, estimatedTokens, priceSnapshot,
    inputDigest, // 完整实际输入的 SHA256 hex；稳定 ID 重用时也校验此 digest
  },
  signal, // 可选，Host job AbortSignal
  prepareInput({phase:'prepare', options, request, signal, character}),
  validate({phase, options, request, signal, character}),
  admitNetwork(dispatch),
}
```

`request` 在第一处 await 前深拷贝/冻结，角色同步捕获。`sessionId` 必须等于 actual options.sessionId，`request.model` 必须等于当前 options.model；这只是该 envelope 的一致性检查，**不证明 alias 已解析成实际 provider/model**。`providerRouteId`、估算与价格由可信 getScope 提供，必须基于实际 resolved/pinned route。父协调者冻结的 `deriveMemoryProviderRouteId({provider,model})` 位于 `src/core/memory-v2-routing.js`；此模块不猜测 defaults、aliases 或 provider。

`prepareInput` 只返回 true / `{ok:true}`；不替换 options。它负责 capture/ingest、完整实际 envelope 的 refs/digest、bindActualInput 和 processing grants。`validate` 的 phase 为 reserve / dispatch / chunk / completion，返回 true / `{ok:true}` 才放行。回调缺失、返回 false/错误或抛错默认拒绝；并在每次 await 后再检查角色与 signal。所有 system/history/tool results/files/transcripts 的来源映射仍是 B/index owner 的职责，本 helper 不声称能自动证明它们。

`admitNetwork(dispatch)` 是可信串行网络准入能力：它必须在自己的 critical section 中完成最后的 controls/role/source 验证，并**恰好调用一次** dispatch，返回该 dispatch 的结果（可 await）。dispatch 同时构造 `next(options)` 并发起 provider iterator 的第一次 `.next()`；两者均在 callback 内开始。该 Promise 可在锁释放后等待响应，不能把整个 provider 响应等待都算作持锁要求。missing capability 在任何 reserve 前拒绝；callback 未调用/重复调用/返回后再调用均不可补发。此 gate 的真实实现由 H/core 提供，不能用 `async fn => fn()` 冒充生产串行验证；fixture 仅用这种无外部副作用的假 gate 验证调用顺序。

## 准入与流式生命周期

复用 `createModelCallAdmission(...).run` 的原状态机，新增同 factory 的 `.stream({request,invoke,signal,admitNetwork})`：

1. ensureReady → canonical reserve → prepare/validate reserve → durable admit。只有 `ok:true && send:true` 进入 invoke。
2. dispatch validate → trusted admitNetwork → provider stream/首个 next。每次 llm/stream 对应一个稳定 requestId，不包装 `sessionController.prompt` 的 enqueue ACK。
3. provider 的 `{type:'usage',usage}` 在角色/取消/privacy 检查与 yield 之前进入 canonical usage recorder；usage 是 provider 的**完整累计快照**，后到覆盖先到，不把累计快照相加。
4. chunk validate 后逐块交付，最多一块待交付，通过 consumer 下一次 pull 释放背压；不缓冲整段响应。
5. throw/role switch/revoke/cancel/consumer return 都走 finally；generator cleanup 的 usage 也收取，等待 cleanup 和 settlement 后再结束 consumer。已知 actual 全量入账，超过 reserve 也不裁剪；缺失或无效 usage 保留 usage_unknown，不退款、不自动重发。

重复 requestId 返回 generator 的 done value（结构化 reused receipt），不产生新 chunks、不继续已存在 reservation；普通 for-await 的 Host 消费者不会因此 dispatch。未知 usage 的重复 ID 同样不重试。真正的 provider 自动重试如果再次进入 llm/stream，Host 必须给该次 inference/attempt 独立稳定 ID；本模块不根据 token 数量或模型文本猜 attempt。

保留实际 Host 的原品牌 options 对象与既有 options.signal；本 middleware 不伪造克隆品牌或假设 waterfall 能替换 frozen options。scope.signal/consumer return 会阻止输出并触发 iterator cleanup，但即时取消在途 provider 需要父 Host 将 job/context 取消联到 actual agent/controller（原 options.signal）。仅给 scope 一个未联动的独立 signal，不能声称 provider 网络已停止；不响应原 signal 的 provider 也可能使 drain 等待。该真实 Host 信号链是接线验收项。

流错误带 `ok:false,code,error,hint` 和 requestId/receipt。若 operation 与预算结算同时失败，保留 budgetFailure + operationFailure。原 provider exception 仅保留为不可枚举 cause，公开结构与 JSON 不复制 provider 文本/响应。平台 UI 对异常的展示仍由 Host/index 接线验收负责。

## canonical native session 标记与观察去重

tokenBudget 新增两个 Host-only 方法，没有 agent RPC：

- `reserveNativeAgentModelCall(request)`：内部加入 `nativeAgentSession:true`；request 必须有 sessionId 与 inputDigest。普通 reserveModelCall 拒绝直接携带 nativeAgentSession，避免把一般调用误标成专用 native session。
- `isManagedAgentSession(sessionId)`：返回 true/false，owner/state/ledger 不可证明时返回结构化错误。这个读取基于启动时已加载/验证的 canonical ledger，不依赖易失的 index session map。

标记作为原 modelCalls.requests receipt metadata，与 request digest、reserve/admit/settle 一起写在 **同一个 token-usage-state.json v2**。没有第二份 managed-session 文件，没有未支持的 event writer hook，也不要求 `event.data.budgetRequestId`。

**只有 marker=true 且真实 admittedAt 存在的 request 才使该 session 进入 native ownership**。reserved/cancelled-before-admit 均不让观察跳过。第一次 native reserve 和 admit 都拒绝已记录 legacy usage 的 session（BUDGET_NATIVE_SESSION_USED），避免异步授权期间旧 observation 到来后被悄悄吞掉。Host 必须使用全新、全部 inference 都由此 middleware 管理的专用 session；不能把有旧历史的任意 session 转为 native。

live ingestEvent 对已证明 native-owned session 的 assistant/message、assistant/attempt 只推进观察 seq/seen，不再加 legacy cost/tokens；bootstrap 对这些 session 不读累计投影/历史来重算 usage。费用与未知 hold 由 native request ledger 独占负责。其他 session 的分类/legacy telemetry、direct plugin recordExternalUsage 和原 budgetRequestId correlation 保持原契约。

重启后 settled/unknown/旧 quotaDay native request 仍留下 ownership。Host map 丢失时，新 managed 调用报 MEMORY_SESSION_UNBOUND；手动 unarchive 也不能恢复旧权限。membership/brand capability 未就绪报 MEMORY_BUDGET_NOT_READY；managed session 的 unbranded lookalike 报 MEMORY_AGENT_REQUEST_UNTRUSTED；明确 unmanaged 且 canonical 也未标记的请求原样 yield* next(options)。品牌本身没有 job 权限，scope 缺失仍拒绝。

不尝试把 assistant usage 的相似金额/数量匹配成某个 unknown receipt；unknown 只能显式 reconcile。dedicated session 的所有 billable inference 均须被覆盖，否则全 session observation suppression 不成立。子会话/第三方工具旁路的禁止或独立登记由 B/index owner 验收。

## 变更边界、验证与回滚

本工单恰好六个文件：

- 修改 `plugins/surfcore/lib/token-budget.js`、`plugins/surfcore/lib/token-budget-admission.mjs`、`plugins/surfcore/lib/model-call-admission.mjs`。
- 新增 `plugins/surfcore/lib/memory-v2-agent-budget.mjs`、`plugins/surfcore/scripts/test-memory-v2-agent-budget.mjs`、本文。

修改前备份：`_backups/memory-v2-agent-budget/{token-budget.js,token-budget-admission.mjs,model-call-admission.mjs}.run1.before`。fixture 的真实 canonical 预算文件均在 `_backups/memory-v2-agent-budget/run-*/fixture-*`；无生产预算迁移或写入。

验证命令（分别使用 CLI Node 26.5.1 与 bundled Node 24.21.0）：

```sh
node plugins/surfcore/scripts/test-memory-v2-agent-budget.mjs
node plugins/surfcore/scripts/test-token-budget-admission.mjs
node plugins/surfcore/scripts/test-model-call-admission.mjs
node plugins/surfcore/scripts/test-token-budget-durable.mjs
node scripts/test-token-budget-service.mjs
npm run test:audit
```

native fixture 覆盖：first/reused/concurrent/per-step IDs；critical callback 内首个 next；未绑定/无品牌/未知 membership/缺 callback；reserved 不 skip 与 legacy session 不可接管；abort/role/revoke/provider throw/consumer return/cleanup usage；未知用量跨日与重启；watcher + replay 去重且 legacy 仍计费；reserve/settle/return fsync 故障；输入 digest 冲突/损坏 marker；延迟/重复 dispatch 拒绝；全量 overrun 与跨角色六次全局额外预算；operation + settlement 同时失败且保留私有 cause。

回滚应在停止新 native job 后，从上述 **run1.before** 恢复本工单三份既有文件，并把三个新文件移到备份隔离目录；不要用 git restore 抹掉此前尚未提交但已验收的 P3 基础工作。生产若已有 native admitted receipt，旧代码无法安全解释该 ownership，必须先由父协调者做兼容迁移/保留新 reader，不能盲目降级；本工单未接生产故未产生这类数据。

真实 Host 的同实例品牌导入、实际 resolved provider proof、serialized core gate、完整 manifest、频道/平台 UI 与 index composition 均不属于本六文件边界，须由父协调者另行接线/Host fixture 验收后才启用。未运行真实模型/网络；fixture 通过不等于生产 Host 端到端通过。

验证结果：CLI 26.5.1 / bundled 24.21.0 均为 native 28 场景、common runner 27 场景通过；原 admission 17、durable、legacy service 39 也双端通过。仓库 audit 为 176/176 scripts；其后补强的最后几条 stream cleanup/cause 分支已由最终 native/common 双端重跑覆盖。真实 Host 品牌/route/cancel fixture 仍由父协调者负责。最终日志 `/tmp/surfcore-native-node26-final.log`、`/tmp/surfcore-native-node24-final.log`；其余旧回归 `/tmp/surfcore-native-node26-existing.log`、`/tmp/surfcore-native-node24-all.log`；audit `/tmp/surfcore-native-audit.log`。
