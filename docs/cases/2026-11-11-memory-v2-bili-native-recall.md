# Bili V2 Native 记忆召回与输出 Finish 完整性

日期：2026-11-11。状态：Bili Core Recall 与 finish 完整性独立验收通过；未进行生产激活。

## 1. 链路

模块 `plugins/surfcore/lib/bili-v2-source-runtime.mjs` 负责在 hydrate/ingest/bind 后调用私有 `adapter.prepare`，将 Core 签发并脱敏的记忆文本纳入实际 Native prompt 帧，并保持 inputManifest 与 sourceRefs 严格对齐。

## 2. 机制与失败

1. 在 `captureModelOutput` 中强制要求 `candidate.finish === true`，且 finish reason kind 必须为 `['stop', 'tool-calls']` 之一，杜绝将 error/aborted/max-tokens 当作 complete。
2. 修正旧测试 helper `f.output` 缺少 finish chunk 的问题，增加异常截断负例。
3. 缺失 Core 召回 API、篡改、过期或角色变更时结构化拒绝（`MEMORY_PREPARED_STALE`, `MEMORY_PREPARED_UNTRUSTED` 等），真正空的已签发包合法通过。

## 3. 影响面

影响 Bili V2 原生来源运行时及其 Native 模型输入帧装配；无外网请求，无平台写入。

## 4. 取舍

严格验证 Core 召回凭据与输出结束标记，防止模型在截断或未授权记忆状态下提交回执。

## 5. 生效与重启

仅在 V2 启用时生效；V1 保持默认。

## 6. 验证

- Node 24 运行 `plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`：40 场景 PASS。
- Node 24 运行 `plugins/surfcore/scripts/test-memory-v2-bili-native-recall.mjs`：6 项隔离场景 PASS。
- Electron Harness 运行 `ELECTRON_RUN_AS_NODE=1 SURFCORE_BILI_RECALL_NATIVE=1`：2 calls / 30 tokens / 2 sources / 1 tool，通过。
- 证据文件：`_backups/memory-v2-coordinator/bili-native-recall-independent/verification.json`。

## 7. 回滚与残余

可单独撤销/隔离；测试套件中所有 47 个普通回归保持兼容通过。

## 可转发的发布交接块

- 批次：2026-11-11 Bili Native 记忆召回与 finish 完整性；
- 改动：强制核验 Core prepared recall 文本与 manifest，输出 complete 严格要求合法 finish；
- 验证：普通 40+6 场景及 Native 2 calls / 30 tokens 绿灯；
- 风险与生效：V1 默认不变。
