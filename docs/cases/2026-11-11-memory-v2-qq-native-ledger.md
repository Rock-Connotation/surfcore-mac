# QQ V2 Native 语法账本：全集路由与 tool-calls 完成

日期：2026-11-11。状态：语法账本独立验收通过；接入 QQ Source 运行时后完成闭环，尚未安装或正式切换。

## 1. 链路

新模块 `plugins/surfcore/lib/qq-v2-native-ledger.mjs` 由可信 Native Owner 或 Source Runtime 注入，负责有序校验输入、观察模型输出流及记录工具调用结果。与 Core routing、Native Codecs（`AssistantStreamAccumulator`, `BlockAssembler`）及 TokenBudget 协同工作。

## 2. 机制与失败

1. 路由解析使用 `deriveMemoryProviderRouteId`，完整支持包含空格、标点、中文及最长 512 code units 的合法模型标识，拒绝狭隘 identifier 正则。
2. 模型输出完成支持正常 `tool-calls` 结束（由 SDK pi-ai 及 deepseek 适配器映射的合法工具调用结束事件），与 `stop` 一并作为合法完成条件；严格拒绝 `aborted/error/max-tokens` 异常截断。
3. 支持稀疏大索引（非负 safe integer，拒绝 `-0`），匹配 dsh-llm assembler Map 映射机制。
4. 失败返回结构化 `{ ok: false, code: 'QQ_NATIVE_LEDGER_OUTPUT_UNPROVEN', error: 'The native message ledger could not verify this operation.', hint: '...' }`。

## 3. 影响面

影响 Host 私有账本校验与 QQ Native 模型输出观察链路；不开放外网，不发送真实消息。

## 4. 取舍

不放宽为任意字符串的弱校验，而是在严格契约内扩大支持 Core 合法路由和真实 SDK tool-calls 事件。

## 5. 生效与重启

新文件随 Memory V2 整体交付，待工程验收完成后安装桌面插件生效；当前 V1 保持默认。

## 6. 验证

- Node 24 运行 `plugins/surfcore/scripts/test-memory-v2-qq-native-ledger.mjs`：26 场景全部 PASS。
- 实际 Harness Native 探针运行：2 calls / 30 tokens / 2 gates / 1 tool，首块 index=MAX_SAFE_INTEGER 且 tool-calls finish，通过。
- 证据文件：`_backups/memory-v2-coordinator/qq-native-ledger-independent/verification.json`。

## 7. 回滚与残余

可单独撤销/隔离 `qq-v2-native-ledger.mjs`；目前已与 `qq-v2-source-runtime.mjs` 完成联合验证。

## 可转发的发布交接块

- 批次：2026-11-11 QQ Native 语法账本；
- 改动：支持完整合法 Core 路由全集、正常 tool-calls 结束判定及非负 safe integer 块索引；
- 验证：普通 26 场景通过，Native 探针 2 calls / 30 tokens / 2 gates / 1 tool 绿灯；
- 风险与生效：V1 默认不变，仅在 V2 启用时作为底层账本。
