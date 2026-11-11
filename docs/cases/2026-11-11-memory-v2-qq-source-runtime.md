# QQ V2 原生来源运行时与 Bridge 联合闭环

日期：2026-11-11。状态：已完成组件实现与 Native 周期验证，47 项 Memory V2 全套普通回归与 17 项全库协议回归全部绿灯。

## 1. 链路

新模块 `plugins/surfcore/lib/qq-v2-source-runtime.mjs` 组合已接受的 Core 原件导出、文本包构造器（`buildQQV2SourcePacket`）、私有 QQ Host Adapter、Native Owner 与语法账本（`qq-v2-native-ledger.mjs`），接入真实 Core 授权召回，建立鲜活身份防漂移与 Kernel 隔离准入闭环。

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

## 2. 机制与失败

1. **鲜活身份防漂移**：在 `prepareReplyPrompt` 签发快照并在 `prepareInput`、`admitNetwork`、`prepareSend` 每次执行前现读 `getQQIdentity()` 与 `getCharacter()`，核验账号、群/私聊白名单及当前角色 epoch。一旦检测到漂移，立即阻断并退役会话，抛出结构化 `MEMORY_QQ_IDENTITY_UNVERIFIED`、`CHARACTER_EPOCH_STALE` 或 `MEMORY_AUDIENCE_DENIED`。
2. **Core 凭据与召回核验**：调用私有 `adapter.prepare` 获取 Core 签发记忆；合并 `inputManifest` 到总引用集合；通过 `verifyPrepared` 与 `validate` 双重校验。
3. **输出完备性与执行 witness**：模型输出强制由 Native Ledger 验证 chunk 流与 finish 事件；工具结果必须提供由 Native Owner 签署的 `validateOwnedToolContext` witness 证明方可记录入账。
4. **单次发送租约**：`prepareSend` 签发独占单次 lease，`recordSent` 必须消费相同 lease，防止未授权复用或重放。
5. **引用一致性**：在 `prepareInput` 锁定 `state.preparedConfig`，在后续模型输出各 phase 间复用同一冻结对象，确保账本引用的严格全等。

## 3. 影响面

影响 QQ V2 来源抽取、准入校验、原生模型推理、工具记账与发送授权链路；不影响现有 V1 默认通道；隔离测试中无外网请求、无真实 QQ 消息发送。

## 4. 取舍

不采用宽松的对象比对或无状态重签机制，坚持在所有异步阶段现读鲜活身份并复用严格冻结的 `preparedConfig` 引用。

## 5. 生效与重启

新模块暂不自动激活；待桌面插件安装后，由用户在控制台显式配置或启动 V2 时生效。

## 6. 验证

- Node 24 运行 `plugins/surfcore/scripts/test-memory-v2-qq-source-runtime.mjs`：4 项普通隔离场景全部 PASS。
- Electron Harness 运行 `ELECTRON_RUN_AS_NODE=1 SURFCORE_QQ_SOURCE_NATIVE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"`：
  - `providerCalls`: 2
  - `toolCalls`: 1
  - `tokens`: 30
  - `gates`: 2
  - `admittedInputs`: 2
  - `committedOutputs`: 2
  - `sentLeases`: 1
  - `networkCalls`: 0
  - `platformWrites`: 0
- 全库集成与门禁：
  - `scripts/test-memory-v2-qq-integration.mjs` 全部 PASS；
  - `scripts/run-memory-v2-tests.mjs` 47/47 全部 PASS；
  - `npm run test:audit` 176/176 全部 PASS；
  - `npm run test:regressions` 17/17 全部 PASS。
- 证据文件：`_backups/memory-v2-coordinator/qq-source-runtime-independent/verification.json`。

## 7. 回滚与残余

可安全隔离撤回新增文件；V1 保持默认。

## 可转发的发布交接块

- 批次：2026-11-11 QQ V2 原生来源运行时与 Bridge 联合闭环；
- 文件：`plugins/surfcore/lib/qq-v2-source-runtime.mjs`、`plugins/surfcore/scripts/test-memory-v2-qq-source-runtime.mjs`、`docs/plans/2026-11-11-memory-qq-source-runtime-contract.md`；
- 验证：普通 4 项 + 真实 Native 探针 2 calls / 30 tokens / 2 gates / 1 tool 绿灯，47 项 Memory V2 全套普通回归全部通过；
- 风险与生效：V1 默认不变，无生产切换。
