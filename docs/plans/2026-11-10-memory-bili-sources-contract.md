# Bili V2 原生来源证明契约

状态：P2-BILI-NATIVE-SOURCE-PROOF run1/3。三个新增文件，未接入生产 index、未启用 V2。native cycle1 的 `MODEL_NOT_AUTHORIZED` 已定位为实际 Host 工具数组排序差异并严格修复；普通 28/28 PASS，修复后唯一一次 native 结果见下节。

## 冻结接口

```js
createBiliV2SourceRuntime({
  memoryV2, getCharacter, corePersona, nativeRoot, nativeCodec,
  getNativeConfig, getIdentity, sourceTransport, now = Date.now,
})
// -> preparePrompt, prepareInput, validate, captureToolResult,
//    prepareSend, captureModelOutput, getStatus, close
```

六个既有 B runtime callback 签名保持不变。factory 只供 Host 私有调用，不能注册成模型工具或通过 RPC 暴露。getStatus 仅返回计数和结构化错误，不返回正文、句柄或调用账本。

- `getNativeConfig({job})` 同步返回当前原生 call 的 `preparedConfig` 原指针；不接收待验 options。factory 核对实际 agent、原始 request identity、preparedConfig pointer、固定 provider/model。当前支持非内容配置 `provider/model/maxTokens/reasoningEffort`，未知配置拒绝。
- `getIdentity({job,action,target?,signal})` 返回 `{ok:true,accountMid,conversationKey,sourceAccountKey,requesterAccountKey,providerRouteId,audience,target?}`。action 为 prompt/read/comment/dynamic/dm，只选择事实，不产生 policy/grant。
- `sourceTransport.hydrate({job,selector,signal})` 返回 `{ok:true,conversationKey,records}`。selector 为 `{kind:'trigger',input}` 或 `{kind:'tool',action,args,stdout}`。`args` 来自实际 native execution 的 `arguments` 字段；stdout 仅辅助官方固定动作选择，不能直接当完整原文。
- 每条 record 为 `{sourceKey,revision,kind,objectId,authorMid,occurredAt,audience,target,coverage,wire}`。revision 为稳定字符串；wire 为完整官方 plain JSON 对象。comment/dynamic/dm 只接受 full，notification/telemetry 只接受 observed-receiver，后者 author 必须为实际接收账号。
- `sourceTransport.revalidate({job,sources,signal})` 接受每条原 sourceKey/revision/objectId/authorMid/audience/target/wireDigest，返回 `{ok:true,unchanged:true}`。只比事实，不授权。

实际发送 target 沿现 IPC：comment `{audience:'public',kind:'comment',type,oid,root,parent}`；dynamic `{audience:'public',kind:'dynamic'}`；dm `{audience:'private',kind:'dm',mid}`。Host transport 只能调用固定官方动作，不接收模型路径、URL、角色、grant 或控制参数。

## 完整逻辑

1. **链路**：scheduler typed input → B 私有 job → 本 factory → 当前 adapter.capture/ingest/bindActualInput/validate → 实际 B 预算 runner → H gate。typed read 返回前重新官方 hydrate；源输出通过同一个真实 NativeLoop codec；写入仍由既有 IPC/Host H gate 发出。transport/index 的生产组装由 parent 负责。
2. **机制**：capture 的 sourceStamp 必须与 job、实际账号、精确 conversation、source/requester account、route 全匹配。每份原文先用新未绑定 handle ingest，避免把后来的独立官方观察假变为前一份来源的衍生物；真实 receipt.eventRefs 进入整个 job 的单调 union，再 bind 到模型或目标 handle。未知/缺字段/角色切换均结构化拒绝。
3. **影响面**：三个新文件；不改 core/root/B/runtime/index，不触碰真实 profile 或账号。普通 fixture 使用临时目录、真实 worker 与私有 Host；官方 transport/provider 都为 fake，外网与平台写入为 0。未执行安装、发布、提交或自动 V2 激活。
4. **取舍**：选择真实 source capture 加 RAM 衍生语义账本；不把 fulloptions 序列化后当新授权事实，也不把模型输出 raw-ingest 成新 observed event。store.ingestEvents 会加入自身 root，后两种路线会洗来源或增独立根；RAM 账本保留祖先 refs，回滚简单，代价是不能恢复旧 session。
5. **生效**：仅新增模块，当前没有生产装配调用方。parent 完成 index/真实 transport 并独立验收后才可接入；重载私有 B/root 运行时才能使用。身份与来源每次 validate 都重新核对当前 Host 事实，账号切换不能沿用旧 handle。失败由既有 B onBlocked 将 `{ok:false,code,error,hint}` 送至当前状态界面；本模块不绕过该通道。
6. **验证**：普通命令 `node plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`。覆盖真实 worker 入库/完整 refs/H gate、无 policy、未知来源/author/coverage、forged append/复制/unknown config、private→public、revision/role/worker loss、合法 source-bound toolresult、credential yield 前拒绝及 failed candidate 丢弃。native 命令及实际失败见下节。
7. **回滚与残余**：不接入这三个文件即可保持当前运行行为；若已组装，应先 retire B/root、关闭 source factory，再移除装配。已持久化官方 redacted source 与 DENIAL marker 留存；不得删除账本或解除旧 session。模型输出/写回执/生成评分只在 RAM，不能作为平台发表 receipt 或独立 evidence root。

## 原生 codec 与输入账本

来自同一实际 packaged `@deepseek-ai/dsh-llm`：

```js
new AssistantStreamAccumulator(); push({time, chunk}); snapshot();
new BlockAssembler(); push(chunk); blocks(); // usage/finish/replayState getters
createSystemMessage(text);
createUserMessage({source, content});
createAssistantMessage({content, source});
createToolResultMessage({callId, content, isError});
```

实际源码：dsh-llm/lib/index.js:70/86/101/954/1150；dsh-agent-loop/lib/index.js:395–400、941–955、1085–1092。NativeLoop 将真实 chunk 经 accumulator snapshot 后交 BlockAssembler，后者负责 tool-call、max-token 和 replay 语义。本模块使用相同公开 codec，不自行拼正文。

start 只建候选。chunk 必须在同一私有 call/options/request 下通过检查；保留 exact chunk identity 并冻结已接收对象。credential 检查在 chunk yield 前执行，包括跨 delta 的 credential 前缀；未知 block、图片、文件、原文中未支持的媒体附件拒绝。complete 只有受信 B wrapper 在 budget iterator 正常结束且 settlement/usage_unknown hold 已处理后才调用，此时才提交完整 content/source/replay 的期望消息。failed/return 丢弃候选 assembler，usage 缺失不构成退款或重试许可。

后续 full actualoptions 逐项匹配批准的 system、原始 Host user prompt、真实 chunk 衍生的 assistant、source-bound typed tool result，并匹配四个实际工具 schema、完整 toolHistory、固定 provider/model 和私有 prepared.config。未知增加、复制、换序、角色/source/tool-call 不一致均拒绝。随机 message.id 只在完整匹配后绑定为定位信息，不用它声称 writer 身份或产生新权限。

实际 Host 的 `SystemPrompt.assemble()` 用 `orderTools`（默认 `tools.sort(compareToolNames)`，code-unit 名称比较）把工具投影按名称排序后交给 `buildRequest`，因此 `options.tools` 与 `options.toolHistory.tools` 都是排序后的四个 schema；而 `:178` 的 `ctx.tools.schemas(agent)` 与 tool-call 校验用注册顺序。两者都固定：`:178` / `toolSpecs` 保持注册顺序，`:181` 用 `approvedRequestTools = Object.freeze([...toolSpecs].sort(...))` 严格匹配排序后数组。不放宽顺序、不删字段、不拿实际 options 当期望、不接受未知工具。

**明确限制**：没有公开 native writer-ID hook，完全相同 content/source/replay、顺序与数量的语义替身不可区分。parent 已批准这一限制：它不增加新语义或权限；不应宣称能凭随机 ID 识别 writer。当前仅 text/reasoning 与四种 typed tool-call，其他 block/历史更新/媒体输入需要明确新增契约。

## 来源与隐私

- comment 对照 wire.rpid/member.mid/type/oid/root/parent/content.message，并逐项匹配实际 thread target；dynamic 对照 id_str/module_author.mid/desc.text，拒绝未支持的 major/additional；DM 对照 msg_key/sender_uid/receiver_id/msg_type/content。
- wire 所有字符串及 credential key 值先 redaction，再进 SQLite 或模型。原始 wire 只用于 RAM 内指纹比较。普通 fixture 扫描自身 state/characters 文件，确认 `CONTROL_SECRET_CANARY` 未进入控制数据。
- B 不调用 QQ-only producer registration，不伪造 QQ source facts。稳定 event/source/operation IDs 绑定角色 epoch、账号、原 sourceKey/revision；同 job/旧字节不能跨角色 rebind。
- 模型正文和 write receipt 不作为 observed raw events ingest；后续模型/发送始终使用完整原始 refs。每次发送重新 capture 实际目标并验证 payload 与接受的 native tool arguments 一致，再 bind 全 job refs，private 祖先不能洗成 public。
- 上限：单次 hydrate 32 records、每 record redacted 128 KiB、每 factory 64 jobs、每 job 8 inference candidates、每 candidate 4096 chunks/8 MiB。超限停手，不能清除旧 ID 后重放。

## native cycle 定位、修复与验收

唯一运行命令：

```sh
SURFCORE_BILI_SOURCES_NATIVE=1 ELECTRON_RUN_AS_NODE=1 \
'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --expose-internals \
plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs
```

**cycle1 失败（保留）**：`_backups/memory-v2-coordinator/bili-sources-native-independent.log` 为独立复验，普通 21 PASS 后 `AssertionError {"errors":[{"ok":false,"code":"MODEL_NOT_AUTHORIZED",...}],"sourceStatus":{...,"failure":{"ok":false,"code":"MEMORY_NATIVE_INPUT_UNPROVEN","hint":"Capture the complete original source under the current Host identity before retrying."}}}`，`0 !== 2` at test:164:12；providerCalls=0（预期 2）、sourceCount=1、admittedInputs=0、committedOutputs=0。原始 `/tmp/surfcore-bili-sources-native-cycle1.log`，旧版本 `_backups/memory-v2-bili-sources/native-cycle1.before-hardening/`。

**根因（actual Host 静态定位，非放宽 ACL）**：`plugins/surfcore/lib/bili-v2-source-runtime.mjs:181`（修复前 :180）用 `hash(toolSpecs)` 同时校验非空 `history.tools` 与 `options.tools`。真实 packaged `dsh-system-prompt/lib/index.js:89–109` 的 `orderTools` 默认 `tools.sort(compareToolNames)`（`:395` 调用），`dsh-agent-loop/lib/index.js:1021–1025` 把排序数组放入 header，`dsh-session/lib/index.js:667–683` 把同一数组写入 `toolHistory`，`buildRequest :1085–1092` 再展开进 options。故实际排序为 `[surfcore_bili_comment, surfcore_bili_dm, surfcore_bili_dynamic, surfcore_bili_read]`，而冻结 `toolSpecs` 为注册顺序 `[read, comment, dynamic, dm]`；`biliV2InputDigest` 的 `canonical()` 对数组按下标序列化，顺序敏感 → 仅顺序不符即拒绝。parent 独立只读 real assembly 确认 `registered=[read,comment,dynamic,dm]`、`assembled=[comment,dm,dynamic,read]`、`JSON.stringify(assembled)===JSON.stringify([...definitions].sort(...))` 为 true；`renderPrompt(assembly)` 在单一 `complete:true/interpolate:false` persona section 下等于 `corePersona` 原文，system/user 消息只有 `role/content/source/id`，无 `seq` 等额外字段；`:178` 自定义 hint 未出现，证明 `ctx.tools.schemas(agent)` 与 `toolSpecs` 逐字节相同。此前 +bash/+seq 的普通 RED 只是假设反例，不证明真实 Host 有额外工具或消息字段。

**修复**：`plugins/surfcore/lib/bili-v2-source-runtime.mjs:30` 新增 `const approvedRequestTools = Object.freeze([...toolSpecs].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));`；`:181` 三处 `hash(toolSpecs)` 改为 `hash(approvedRequestTools)`；`:179`（definitions）、`:114`/`:115`（tool-call 校验）保持 `toolSpecs` 注册顺序不变。`getStatus`/hint/错误码规则不变；完整 request identity、`prepared.config` 原指针、nonce、祖先 refs、整条 messages 仍严格。

**普通 RED→GREEN**：RED（仅改测试、runtime 仍为冻结 SHA `128d58a…`）：新增 `canonicalSpecs`、`f.begin` 的 `requestOverride`、以及「actual Host canonical tool order with a complete non-empty tool history is admitted」用例，日志 `/tmp/surfcore-hy4-source-red.log` → RED_EXIT=1，21 PASS 后 `AssertionError ... MEMORY_NATIVE_INPUT_UNPROVEN / false !== true`。GREEN：上述修复 + `f.begin` 默认 `tools: canonicalSpecs` + 6 个拒绝用例（注册顺序、未知工具进 tools、未知工具进 history、改 description、重复 schema、history 带 update），日志 `/tmp/surfcore-hy4-source-green.log` → GREEN_EXIT=0、`PASS Bili real source proof: 28 ordinary cases`。`node --check` 两个 .mjs OK；三文件 CRLF=0/trailing_ws_lines=0/no_final_newline=0/tabs=0。备份 `_backups/memory-v2-bili-sources/hy4-repair/pre-red-20261110-151200-*`；定位探针日志 `surfcore-hy4-source-probe.log`（V0/V1 PASS，V2/V3 FAIL `:180:7`，V4 FAIL `semantic:14:33`）。

**修复后唯一 native（累计 1/1，已消耗，按 brief 不再运行 child native）**：完整日志 `_backups/memory-v2-bili-sources/hy4-repair/surfcore-hy4-source-native.log` / `/tmp/surfcore-hy4-source-native.log`，exit1。28 个普通用例先全部 PASS；真实 native 链路首次越过原先的 `MODEL_NOT_AUTHORIZED` / `providerCalls=0`，以下核心断言均 **PASS**：`providerCalls===2`、`sawBoundTool===true`、`shellDenied===true`、`status.admittedInputs===2`、`status.committedOutputs===1`、`status.sourceCount===2`、`status.derivedPersisted===false`（test:194–195）。即真实 actualWorker/privateHost + actualNativeRoot + realBudget + fake provider 下，两次付费调用、owned typed read 进入下一 full input、2 个 source 均已成立。

随后 test:196 撞上一个**冻结版本就存在、此前从未被触达**的 fixture bug：`const tokens = budget.status().usage.total.tokens;` 少了 `await`（`token-budget.js:735` 的 `status` 是 `async function`），报 `TypeError: Cannot read properties of undefined (reading 'total')` at test:196:41。旧 native 一直在第 164 行 `0 !== 2` 失败，永远走不到这里。静态证明：`/tmp/surfcore-hy4-source-budget-probe.mjs` → `SYNC_VALUE_IS_PROMISE=true`、`AWAITED_HAS_USAGE=true`、`AWAITED_TOTAL_TOKENS_TYPE=number`；同仓 `test-memory-v2-agent-budget.mjs` / `test-memory-v2-bili-agent.mjs` 共 14 处均用 `await ...budget.status()`。已按静态证据把两处 `budget.status()` 改为 `await budget.status()`（`JSON.stringify` 诊断同步改为已解析的 `budgetStatus`），**没有降低任何断言**，`tokens===30`、late-revocation、network/registry 检查原文保留；`plugins/surfcore/lib/bili-v2-source-runtime.mjs` 未因此再改动。

**仍需 parent 独立复验**：受「child native 累计最多 1 次」约束，本会话不再跑第二次 native；`tokens===30`、撤销后正文不泄漏、registry/agents/network/收尾等 test:196–203 断言尚未在真实 native 中跑到。请 parent 用同一唯一命令独立运行一次完成端到端验收；本模块不宣称已通过，不启用生产或发布。

发布交接：本改动未提交、未接入、未发布；范围仅3新文件。parent 仍负责 production HTTP/CLI hydration、身份事实解析、index 装配、全局 case/发布队列和最终验收。按 brief 未运行全 audit/regressions/ASR，不写边界外文档。


## Parent 独立验收（2026-11-10 15:41，替代上节待复验状态）

已独立读三文件diff并按上述同一命令复验，exit0；完整日志 `_backups/memory-v2-coordinator/hy4-source-native-independent.log`。28普通和全部native断言通过：actualNativeCodecs/actualWorkerPrivateHost=true、providerCalls=2、matchedNativeInputs=2、committedOutputs=1、sourceCount=2、legalNextStepToolResult/unknownShellDenied/lateRevocationStopsOutput=true、tokens=30、derivedPersisted=false、externalNetwork=[]、platformWrites=0。实际native agent与registry收尾断言通过。child native1/1与parent独立一次分别计数；先前失败日志保留。仅此来源接缝验收，不代表官方transport/index/整体P0–P4完成。


## 2026-11-10 退役所有权补充

新增 Host 私有 `releaseJob({job})`：仅原 job hash 可释放，重复/并发调用不重复累计；开始释放即拒绝旧证明，迟到 capture 释放 opaque handle。Bili agent 仅在真实队列/收件箱/卸载 ACK 后调用，失败保留阻断与状态供显式重试。private root 新增 `releaseAgent(actualHandle)`，真实 dispose/registry absent 后删除强引用；不改或伪造 actual handle。来源 sourceCount/admittedInputs/committedOutputs 是不含正文的累计计数，jobs/activeSourceCount 是活跃量。完整 native 原 2 calls/2 sources/30 tokens 保留，退役后活跃量 0、真实 SessionStore ID 消失；再查询旧 job 返回 BILI_SOURCE_JOB_UNBOUND，运行中撤权仍断言 BILI_SOURCE_CHANGED。普通来源现 30 项、runtime 37 项，证据与回滚见 cases/2026-11-10-bili-v2-retirement.md。


## 2026-11-10 V2 read enum 收口（当前阶段）

用户已确认移除 `today` 读分支；该分支从未实现（`plugins/surfcore/tools/commands/` 无 `today.mjs`），此前只在 V2 对模型的 schema 承诺与执行分支里占位。保留并继续完成 `feed` / `debrief`；`score --today` CLI 原用途不变，它不是 V2 read 的替代品，也不在本改动范围内。旧阶段把 `today` 列入 read enum 的设计属历史记录，前文各节不批量改写。

**当前契约**：`surfcore_bili_read` 的 `parameters.kind.enum` 只有 `['feed', 'debrief']`。四处同源改动：`plugins/surfcore/lib/bili-v2-agent.mjs`（删 `action === 'today'` → `today.mjs` fork 分支；model-facing definition enum）、`plugins/surfcore/lib/bili-v2-source-runtime.mjs`（`toolSpecs` enum、`captureToolResult` 的 read action 列表）。因为 `prepareInput` 会把实际 native definitions 与 `toolSpecs` 做 hash 比对，两个测试 fixture 的 `specs` / `canonicalSpecs` 必须同步（否则所有旧 canonical 用例都会因 hash 不符而拒绝）。

**旧 today 调用的拒绝方式（不新增错误码、不新建框架）**：`kind: 'today'` 在 `plugins/surfcore/lib/bili-v2-agent.mjs` 的真实 wrapper 参数循环里命中 `parameter.enum.includes(value)` 失败，抛既有结构化 `BILI_V2_ARGS_INVALID`（`ok:false` + `code` + `error` + `hint`）；该判定位于 `try`/`fork` 之前，因此 0 fork、0 source capture、0 平台 dispatch，也不会触发 catch 里的会话退役。来源侧 `safeBlocks` 的 enum 校验对 `kind:'today'` tool-call 返回 `MEMORY_NATIVE_INPUT_UNPROVEN`，`captureToolResult` 对 `action:'today'` 走写回执分支并返回 `BILI_SOURCE_RECEIPT_UNPROVEN`；两者都由既有 wrapper 转成结构化失败。`feed` 成功路径、canonical tools 顺序、未知工具/history/config/nonce/ancestor、private→public 等旧断言全部保留。

**普通 RED→GREEN**：RED 仅改两个测试（新增 3 个 ordinary 用例 + 显式 `--ordinary` 跳过自动 Electron Host 分支，默认/native 行为不变），日志 `_backups/memory-v2-bili-read-enum/red-agent.log`（`EXIT=1`，实际注册 enum 仍含 `today`，`plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs:250` deepStrictEqual 失败）与 `red-sources.log`（`EXIT=1`，`{"ok":true}` 被 `bad()` 拒绝失败）。GREEN 落上述四处 + 两处 fixture 同步，日志 `green-agent.log`（`EXIT=0`，38 项）与 `green-sources.log`（`EXIT=0`，32 项）。Node v26.5.1 普通 Node，0 native、0 实际 Host、0 provider、0 外网、0 全局门禁、0 commit。

**边界外后续项（由 parent 处理，本改动未触及）**：`plugins/surfcore/lib/bili-v2-official-transport.mjs:284`、`plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs:430` 仍列 `today`；`plugins/surfcore/lib/bili-round.js:96`/`:210` 与 `plugins/surfcore/tools/commands/score.mjs:8/24/25/32`、`plugins/surfcore/tools/bili.mjs:37`、`plugins/surfcore/scripts/test-bili-round.mjs:19` 属 V1 `score --today` 链路，保持不动。另 parent 已独立实锤 `guardOff` / `hookOff` 在 close 时未注销（残留 2 订阅、0 注销，证据 `_backups/memory-v2-coordinator/bili-close-subscriptions/red-result.json`）；本工单按 brief 不顺手修、不消耗 native，留待独立工单。

**回滚**：`_backups/memory-v2-bili-read-enum/original/` 保存 5 个文件的初始字节快照；按本节四处 + 两处 fixture 反向替换即可恢复，无 schema 迁移、无持久化数据变更。
