# P3：Host 受控模型调用公共入口

状态：2026-11-09，新公共 helper 与隔离 fixture；生产调用方尚未接线，不增加任何自动模型调用或处理授权。依赖已验收的全局 token-budget reserve/admit/settle/reconcile 账本，与 memory kernel 无导入依赖。

## 决策与范围

采用 `plugins/surfcore/lib/model-call-admission.mjs` 公共 runner，由渠道 Host 闭包注入模型调用、当前角色和实际处理授权。预算账本继续只有现有全局 token service 一处。另一条路线是在每个渠道重复生命周期；它容易在角色/隐私中断时漏记已发生费用，因此不采用。

该 runner 只覆盖 **direct plugin `ctx.get('llm').stream(...)`** 类型调用。它不包装 agent session 回合，不注册模型工具，不控制最终 QQ/B站发送；调用者仍必须在持久化和实际平台发送之前异步验证 memory context、完整 input manifest、当前授权与角色。

## 冻结接口

```js
const runner = createModelCallAdmission({
  tokenBudget,                 // 现有 createTokenBudgetService 返回对象
  getCharacter,               // 同步可信闭包，返回 { id, epoch }
  authorize,                  // async 可信闭包；默认拒绝
  now: Date.now,
});
const result = await runner.run({ request, invoke, signal });
```

`request` 使用预算服务原有 Host metadata：`requestId, category, purpose, jobId, role, epoch, providerRouteId, model, estimatedTokens`，以及可选 `quotaDay, sessionId, priceSnapshot`。requestId 必须由上游可信作业稳定提供，runner 不生成新 ID，不把角色、路由、权限交给模型参数决定。首次 await 之前同步捕获角色并复制、深冻结 request；请求的 role/epoch 必须相符。定价快照与额度检查全部留在 budget service，runner 不生成 CNY 估价。

`authorize({phase, request, character, signal})` 仅接受可信闭包。返回 `true` 或 `{ok:true}` 才放行；缺省、拒绝和异常均有结构化失败。phase 固定三处：

1. `reserve`：耐久预留之后、admit 之前。
2. `dispatch`：耐久 admit 之后、invoke 紧邻之前。
3. `completion`：invoke 完成或抛错之后、输出交付之前。

授权闭包应捕获真实 memory handle/context/input manifest，并在每个 phase 调用相应异步 validate；不能只核对 request 中自报的 purpose。预算允许不代表内容可以发送给模型。每次 await 返回后重读同步当前角色/epoch，并检查 signal；完成检查失败不返回模型输出。

`invoke({requestId, onUsage, signal})` 负责一次 direct provider 流消费并返回调用方需要的结果；它不能自行重试另一笔付费请求。只有首次耐久 admit 返回 `ok && send` 时才执行 invoke。

## usage 回调与生命周期

`onUsage(usage)` 是同步回调，接受 **本次唯一 provider 请求的完整累计快照**。重复快照替换而不相加。支持 canonical 桶和 Host 别名：`uncachedInputTokens/inputTokens/cacheMiss`、`outputTokens/output`、`cacheReadTokens/cacheHit`、`cacheWriteTokens/cacheWrite`。归一化复用 `src/model-prices.js`；inputTokens 是未命中输入，cache 桶独立。reasoningTokens 已包含在 output，totalTokens 不再相加。空对象、只有 totalTokens、负数、小数等不能成为零费用成功。

收到 stream usage chunk 后必须 **先 onUsage，再做隐私、角色、取消或 finish 处理**，否则已付费 chunk 会被调用方丢掉。参考已存在的 `plugins/surfcore/lib/douyin-companion-model.mjs:32-98`。示意接线：

```js
const outcome = await runner.run({
  request: trustedRequest,
  signal,
  invoke: async ({ onUsage, signal }) => {
    let text = '';
    for await (const chunk of ctx.get('llm').stream({
      provider: trustedProvider,
      model: trustedRequest.model,
      system: approvedSystem,
      messages: approvedMessages,
      maxTokens,
      signal,
    })) {
      if (chunk.type === 'usage') onUsage(chunk.usage);
      // 此处之后才做调用方隐私/角色检查；遇 error/aborted finish 必须抛错。
      signal?.throwIfAborted();
      checkTrustedCurrentContext();
      if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw new Error('Controlled provider request did not complete.');
      }
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    return text;
  },
});
// 只有 outcome.ok && outcome.invoked 才有新的 value。
// 发送/落记忆前仍 await adapter.validate(handle, preparedHandle)，再核对当前角色。
```

runner 无法观察 invoke 内部的 await，因此渠道的流循环仍需上述 usage-before-guard 时序。onUsage 只在 invoke 生命周期内有效；不能异步遗留回调到完成后继续记账。若流缺少 usage、usage 非法或请求已 admitted 但 dispatch 授权失败，落 `usage_unknown`，保留原 quotaDay 和 reservation，交由 Host 显式 reconcile；不自动退款或换 ID 重发。

| 阶段 | 失败后的账本动作 | 输出 |
| --- | --- | --- |
| reserve 前取消/角色不符 | 不创建预留 | 结构化拒绝 |
| reserve 后、admit 前授权/取消失败 | 仅对本 runner 新建的 reserved 显式 cancelled | 结构化拒绝 |
| admitted 后未得到完整 usage | usage_unknown，保留预留 | 结构化失败，无 value |
| invoke 抛错/角色变化/取消但已得到 usage | settle 完整 canonical usage | 结构化失败，无 value |
| completion 授权通过、usage 已知 | settle 后返回 | ok:true，invoked:true，value |
| 同 ID 同摘要已存在 | 返回已知 receipt，无 invoke/自动重试 | ok:true，reused:true，invoked:false，无 value |
| 同 ID 不同摘要/耐久失败/额度失败 | 原始 budget 结构化失败 | 无 invoke 或无 value，按 receipt 处理 |

已 admitted 的调用从不走 cancellation/refund。actual 超过估算仍由全局预算完整记账并阻止后续调用。organize/expand 的共享 6 次/30000 原始估算 token、全局与 scope 限制均复用原服务。

## 错误、恢复与隐私

失败返回 `ok:false, code, error, hint, requestId, invoked, receipt?, completedAt`，不返回模型 value。预算失败保留 `budgetFailure`；若同时有调用失败，再保留结构化 `operationFailure`。原始调用/授权 exception 仅通过 **不可枚举** `cause` 留给可信 Host 内部排查，JSON 序列化不会包含 provider 错误正文。不要把 cause 写入用户界面、日志或网络响应；公共 error/hint 不拼入 provider text、密钥、prompt 或模型输出。

当预算 commit/fsync 不确定，显示 budget 原始 code/error/hint，查询同 requestId；不要因 runner 报错就推断调用没有发生。重复 ID 即使仍 reserved 或 usage_unknown，也不会自动继续调用。必要恢复由 Host 检查原 receipt、显式 reconcile，并重新进行单独的处理授权。

## 精确计费关联证据与边界

2026-11-09 只读检查了当前安装的 Host ASAR，未启动服务或调用模型：

- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js:2398-2402`：`stream(options)` 经 `llm/stream` waterfall 到 adapterStream；该 direct 路径没有自行 append session usage event。
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:877-883`：agent 自己消费 stream；`:949-955` 由 agent 的 `session.append('assistant/message', {usage,stream,...})` 写 usage。direct plugin 调用绕过这一 agent loop。
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1456-1462` 映射 input/output/cache usage；`:1651-1667` 在 done/error 时产生 usage chunk。
- 仓库 `plugins/surfcore/lib/index.js:354` 的 session/event 观察是另一条入口；旧 `plugins/surfcore/lib/bili-round.js:122-165` 使用 direct stream 后独立 recordExternalUsage。

因此 **当前 direct-plugin 接线必须只让 runner settle，不能再调用 recordExternalUsage，也不能自行把同一 usage append 为 session assistant event**。本 helper 不写 observation metadata，不假定 requestId 自动进入 provider 端或 Host session/event；未证明 Host 支持 `budgetRequestId` stream option，示例不传虚构字段。

若后续把该 runner 包到 agent/session-backed invoke，或新 middleware 将 direct usage 同时写进被全局服务观察的 session，必须先停在 `session/event` 的关联接口：由可信 event writer 支持并验证 `event.data.budgetRequestId` 与真实 request receipt 对应，再由预算服务现有过滤去重。只在 request 对象添加名字相同的字段不能证明事件关联。未完成该接口前不得宣称这类调用 exactly-once，也不能启用这条路径。

## 验证、上线与回滚

fixture：`plugins/surfcore/scripts/test-model-call-admission.mjs` 使用 fake invoke + 真实隔离 tokenBudget，证据仅写 `_backups/memory-v2-model-admission/`。覆盖并发同 ID、授权默认拒绝和异常、各阶段取消/角色变化、usage-before-abort、known-on-throw、无 usage unknown、定价桶转换、非法 usage、reserve/admit/settle fsync 失败、跨角色共享 6 次额度。执行：

```sh
node plugins/surfcore/scripts/test-model-call-admission.mjs
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-model-call-admission.mjs
```

真实 provider、网络、生产 Host 接线、Windows 原生与真实最终发送未验证；Node CLI fixture 不代表这些验收已通过。本次只新增 helper/test/document，不修改 channel/index/model 文件。后续调用方 owner 接线、执行各自场景回归并重启 Host 后才生效。回滚接线时恢复调用方受控路径，但不得删除已有 budget receipt、退回实际费用或复发 unknown；本次三个新增文件可隔离保留，无生产账本迁移。
