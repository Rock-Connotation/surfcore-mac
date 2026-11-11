# QQ V2 原生来源运行时与 Bridge 联合契约

状态：P3-QQ-NATIVE-SOURCE-FACTORY 设计与实施。组合已接受的 Core 原件导出、文本包构造器、私有 QQ Host Adapter、Native 所有者与语法账本，接入真实 Core 授权召回，建立鲜活身份防漂移与 Kernel 隔离准入闭环。

## 1. 架构与链路契约

```text
Bridge (exportNativeSources) 
      ↓ raw events/refs
buildQQV2SourcePacket 
      ↓ sanitized text & sourceRefs
QQV2SourceRuntime (private QQ Host adapter)
      ↓ capture -> bindActualInput(sourceRefs)
Core MemoryService.prepareMemoryContext
      ↓ Core-issued recall text & inputManifest
Native Ledger.seed (System + User prompt containing Sources & Recall)
      ↓
Native Owner (Native Agent + TokenBudget middleware)
      ↓
adapter.withNetworkAdmission (Kernel fence)
      ↓
LLM stream (captureModelOutput -> Ledger check chunks & finish)
      ↓
Tool execution (owner.validateOwnedToolContext -> ledger.captureToolResult)
      ↓
Bridge.authorizeSend (one-shot lease) -> send -> Bridge.recordSent
      ↓
retireJob (release handle, retire ledger, retire bridge)
```

## 2. 核心接口

```javascript
createQQV2SourceRuntime({
  bridge,                   // createQQMemoryBridge 实例
  adapter,                  // runtime.channelMemory('qq').adapter (私有 QQ Host adapter)
  getCharacter,             // 同步获取当前角色 { id, epoch }
  getQQIdentity,            // 异步/同步获取 QQ 鲜活身份 { accountId, allowedGroups, allowedPrivates, route }
  corePersona,              // 批准的核心人设
  nativeCodec,              // 具备 AssistantStreamAccumulator, BlockAssembler, createUserMessage 等的编解码器
  toolSpecs,                // 固定的 Host 原生工具定义列表
  validateOwnedToolContext, // (execution) => { ok: boolean }，来自 Native Owner 的 witness 检查
  now = Date.now,
})
```

### 2.1 prepareReplyPrompt({ key, job, signal })
1. 校验 `getCharacter()` 与 `getQQIdentity()`。必须处于已验证状态，且 `key` 包含在当前白名单中，路由与 job 声明一致；记录 `liveIdentitySnapshot`。
2. 调用 `bridge.exportNativeSources(key)` 提取原件。
3. 调用 `buildQQV2SourcePacket(packet)` 组织脱敏文本与 `sourceRefs`。
4. 私有 `adapter.capture({ conversationKey, sourceFacts })` 获取私有 `handle`。
5. `adapter.bindActualInput(handle, sourceRefs)` 绑定来源引用。
6. 调用 `adapter.prepare(handle, promptContext, { memory: 1800, total: 6000 })` 获取 Core 签发的授权记忆召回。
7. 校验 `adapter.verifyPrepared(handle, issued.preparedHandle, issued.prepared)`；合并 `issued.prepared.inputManifest` 到总引用集合。
8. 组装含来源与脱敏召回记忆的 Native 消息帧，调用 `ledger.seed({ sessionId, requestId, content })` 锁定账本期待。
9. 记录 job 状态并返回 `{ ok: true, handle, preparedHandle, content, sessionId, requestId }`。

### 2.2 prepareInput({ job, options, request, signal })
1. **鲜活身份防漂移**：现读 `getQQIdentity()` 与 `getCharacter()`，核对当前 QQ 账号、白名单及路由是否变更。若漂移则立即退役并返回 `MEMORY_IDENTITY_CHANGED` 或 `MEMORY_PROVIDER_ROUTE_MISMATCH`。
2. 语法账本校验：调用 `ledger.validateInput({ options, request, preparedConfig })`。
3. Core 凭据核验：调用 `adapter.verifyPrepared` 与 `adapter.validate(handle, preparedHandle)`。

### 2.3 admitNetwork({ job, dispatch, signal })
调用私有 `adapter.withNetworkAdmission(state.handle, () => dispatch(), { signal })`，确保模型调度在 Kernel 隔离准入的保护屏障内发生。

### 2.4 captureModelOutput 与 captureToolResult
- `captureModelOutput`：转发给 `ledger.captureModelOutput`，并在 `complete` 时强制要求 `candidate.finish === true` 且 kind 为 `stop` 或 `tool-calls`，拒绝异常截断。
- `captureToolResult`：必须先通过 `validateOwnedToolContext(execution)` 证明 guard witness，再调用 `ledger.captureToolResult` 有序入账。

### 2.5 prepareSend 与 recordSent
1. `prepareSend({ job, key, loginAccountId })`：核验鲜活身份后，调用 `bridge.authorizeSend({ key, loginAccountId })` 获取独占一次性 `lease`。
2. `recordSent({ lease, text, messageId, deliveryState })`：调用 `bridge.recordSent` 完成记账。

### 2.6 retireJob({ job, reason })
退役并彻底清理私有 handle、账本状态与 Bridge 会话状态，防止跨任务残留。
