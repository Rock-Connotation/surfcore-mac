# Bili V2 Core 原生召回契约

状态：P2-BILI-NATIVE-RECALL 验收完成。覆盖四文件边界：
- `plugins/surfcore/lib/bili-v2-source-runtime.mjs`
- `plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`
- `plugins/surfcore/scripts/test-memory-v2-bili-native-recall.mjs`
- `docs/plans/2026-11-11-memory-bili-native-recall-contract.md`

## 1. 冻结接口与链路契约

Bili V2 来源运行时在原有来源水合与输入绑定之外，必须通过 Host 私有 Memory V2 Adapter 执行 Core 记忆召回，确保模型请求上下文具备授权历史召回能力，同时拒绝未授权或伪造内容。

### 1.1 依赖契约
`createBiliV2SourceRuntime({ memoryV2: { adapter }, ... })` 中，`adapter` 必须提供以下完整能力：
- `capture(request)`
- `ingest(handle, batch, operationId)`
- `bindActualInput(handle, refs)`
- `prepare(handle, promptContext, limits)`
- `verifyPrepared(contextHandle, preparedHandle, prepared)`
- `validate(handle, preparedHandle?)`
- `release(handle)`

缺失任何一项方法时，构造立即 fail-closed 抛出 `BILI_SOURCE_UNSUPPORTED`。

### 1.2 召回准备与验证契约
1. **Prepare 时机**：在 `preparePrompt` 阶段，来源经 `hydrate` 提取并对初始上下文 `bind` 后，立即调用 `adapter.prepare(context.handle, JSON.stringify(sources).slice(0, 6000), { memory: 1800, total: 6000 })`。
2. **结构证明**：返回对象必须为 `{ ok: true, preparedHandle, prepared: { text, inputManifest } }`，且满足：
   - `preparedHandle` 为非空字符串；
   - `prepared.text` 长度受有界约束（≤ 1800 字符）；
   - `prepared.inputManifest` 为数组；
   - 立即通过 `adapter.verifyPrepared(context.handle, issued.preparedHandle, issued.prepared)` 进行事实校验，不通过者抛出 `MEMORY_PREPARED_UNTRUSTED`。
3. **脱敏与注入**：召回文本通过 `redactContent` 处理并剔除凭据敏感字段后，作为授权记忆块注入用户 prompt 帧：
   `[{ type: 'text', text: 'Authorized recalled memory:\n' + recall }]`
   同时将其 `inputManifest` 引用逐项合并入当前 job 的记忆引用集合 `state.refs`。
4. **逐次验证**：在 `validate` 与状态检查链路中，逐次执行 `adapter.verifyPrepared` 与 `adapter.validate(handle, preparedHandle)`，确保句柄未被篡改且未过期。
5. **严禁静默降级**：
   - 当 `prepare` 失败、句柄过期（`MEMORY_PREPARED_STALE`）、篡改（`MEMORY_PREPARED_UNTRUSTED`）或角色/世代不符时，必须返回显式结构化拒绝，严禁静默降级为“空召回”；
   - 真正由 Core 签发、合法的空召回包（`prepared.text === ''`）允许合法通过。

### 1.3 输出 finish 完整性契约
1. `captureModelOutput` 的 chunk 检查中，`chunk.type === 'finish'` 时，必须满足：
   - `chunk.reason` 恰好包含 `kind` 字段；
   - `kind` 必须属于 `['stop', 'tool-calls']`；
   - 严禁重复 finish（`!candidate.finish`）；
   - 显式拒绝 `aborted`、`error`、`max-tokens` 等非正常结束。
2. `phase === 'complete'` 时，必须严格核实 `candidate.finish === true`，未收到合法 finish chunk 的输出严禁 complete，返回 `MEMORY_NATIVE_OUTPUT_UNPROVEN`。

## 2. 验证证据

1. **普通隔离测试**（`test-memory-v2-bili-sources.mjs`，Node 24）：
   - 40 个普通场景全部 PASS（包含 finish 完整性校验、错误类型拒绝与重复 finish 拦截）。
2. **召回与边界测试**（`test-memory-v2-bili-native-recall.mjs`，Node 24）：
   - `real Worker recall in prepared prompt`：PASS
   - `prepared failure cannot fall back to empty recall`：PASS
   - `foreign or changed issued copy is refused`：PASS
   - `foreign prepared handle is refused`：PASS
   - `prepared expiry blocks provider input`：PASS
   - `valid empty recall is admitted`：PASS
3. **真实已安装 SDK Native cycle**（Electron 桌面二进制，假 provider 隔离运行）：
   - 2 次 FakeProvider 调用，30 tokens，2 次匹配输入，1 次提交输出，2 个来源；
   - `oldRecallInActualSdkInput: true`；
   - `oldCoreReferenceInActualManifest: true`；
   - `legalNextStepToolResult: true`；
   - `unknownShellDenied: true`；
   - `lateRevocationStopsOutput: true`；
   - 外部网络访问 0，平台写入 0。
