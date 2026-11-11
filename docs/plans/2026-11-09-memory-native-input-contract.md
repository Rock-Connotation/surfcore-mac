# Native private session：完整实际输入与安全 scope 的技术契约

日期：2026-11-10。范围：只读本机已安装包与仓库；只新增本文。所有安装包引用根为 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`，下表 `包/lib/...:行` 均相对该根。native 包为 `0.2.2-rc.1`，Cordis 为 `4.1.0`。先前 `prepareCall`/request brand 的事实沿用 [network admission 证据](2026-11-09-memory-network-admission.md)，没有重复推理调用。

**结论：公开 API 可以创建指定 preset 的实际 agent、设置 session-local exact model、在真实 scoped tool pipeline 加拒绝 guard；但 preset 名、request brand、session event metadata 都不能证明完整实际输入归属。共享 Host 的未知 required context、AGENTS pre-step 消息、既有 history/tool result/attachment 必须逐项有可信来源，否则 source factory 必须拒绝，不能重标成 current input。** 本研究没有证明正常已安装 Host 的完整输入隔离；V1 保留。

## 1. 真正的 preset、session 与 model pin

| 实际包 / 位置 | 签名或关键代码 | 可依赖的事实 / 限制 |
| --- | --- | --- |
| `dsh-agent-preset-registry/lib/index.js:486,511-522`；`lib/typert.host.js:180-181` | `async register(definition: PresetDefinition): Promise<() => Promise<void>>` | definition 是 `{id, name?, description?, order?, plugins:[{name,config},...]}`，不是直接传 plugin 数组。registry 保留声明 ctx，创建真实 preset mount。 |
| `dsh-agent-preset-registry/lib/index.js:612,648,670,717` | `resolve(id)`、`retain(id)`、generation bind、`composeFrom(...)` | 使用明确的私有 id，并保留实际 generation/mount；字符串相等不代表某个实际 agent 由该受控 factory 创建。 |
| `dsh-api-session-controller/lib/typert.host.js:2718-2719,3595-3596`；`lib/index.js:666-697` | `create(request: SessionCreateRequest): Promise<SessionCreateValue>`；request 为 `{workspaceId?,cwd?,sessionId?,agentPreset?}` | 返回 `{sessionId,agentPreset}`，不是 retained agent。源码会 mkdir cwd；研究未调用此 API。该公开 create request 没有 exact model 字段；没有据本次有界取证发现可用的 `controller.open(...)` 签名。 |
| `dsh-api-session-controller/lib/index.js:264-275,424-438` | resolve preset → `setup` 中 `installModelSelection(...)` + `presets.mount(...)` → `ctx.agents.create({sessionId,agentOptions,meta:{cwd,agentPreset},setup})` | 原生 create 链路确实传入 preset；parent 可以复用真实 factory/setup，而不伪造 `agentPreset` metadata。 |
| `dsh-agent/lib/index.js:582,595,725` | `create(options)` / `resume(options)` 交给 retained factory；`get(id) { return this.store.get(id)?.agent; }` | `ctx.agents.get(sessionId)` 能拿到真实 live Agent 对象。用 identity 比较和私有 WeakMap 保存它，不能用 controller/UI projection 当 scope proof。 |
| `dsh-agent-loop/lib/index.js:1571-1584` | sessions.enter/announce → `await setup?.(agent.ctx,agent)` → setup commit → agents.enter → `await agents.announce(...)` → `{agent,dispose}` | trusted Host setup 可在实际 agent publish 完成前绑定句柄、选模型、装 scoped 控件；普通 controller.create 返回后再 select 不能追溯约束已发生的 creation hooks。 |
| `dsh-api-session-controller/lib/index.js:704-718` | `agent.model.select(selection)` 后 `agentDefaultModel.saveSelection(...)` | **controller.selectModel 会写全局默认，不用于私有任务。** |
| `dsh-agent/lib/index.js:181-203`；`dsh-agent-loop/lib/index.js:671,986-1015` | `AgentModel.current()` 优先 recorded pending/lastUsed selection，再回退 options；`select(selection)` append `model/selection`；pre-step `const selection = this.model.current()` | `agent.model.select(exactSelection)` 是 session-local。prepareRequest 使用该 selection，去掉 header 中 provider/model 后显式填入它，拒绝 `agent/request` waterfall 改 provider/model/reasoning，再交给 `llm.prepareCall`；此段没有重新读取全局默认。 |

建议：可信 factory 在 await setup 阶段给 actual agent 固定 exact provider/model，之后每个实际 prepared dispatch 再核对 route。session-local selection 能隔离普通全局默认变更，但其他持有该 agent 的可信 JS 仍可再调用 select；它不是不可变安全能力。`NO_ADAPTER` 的 proposed-config 分支也不等于已获得 provider pin。默认 alias/fallback 的全局选择问题仍按前文缺口处理，不猜 route。

## 2. 实际 input 会怎样被补全

| 实际包 / 位置 | 实际行为 | 对 private preset 的含义 |
| --- | --- | --- |
| `dsh-agent-loop/lib/index.js:679-683,842-877` | systemPrompt.assemble 接收 actual agent scope/modelSelection/toolSet；之后 append 渲染系统消息、runtime contexts、user inputs，再 buildRequest | 输入不只是 caller 的 owned prompt；pre-step、prompt assembly 和 durable session surface 都参与。 |
| `dsh-system-prompt/lib/index.js:255,281,291,301` | `.section(section)`；`.context(context)`；`.suppressRuntimeContext()`；`.tools(provider)` | 这些是真实公开 JS 控件。scoped 同名 context 可以 shadow global，但没有查到通用 context whitelist API。 |
| `dsh-system-prompt/lib/index.js:358-411` | 合并 global/scoped sections/contexts/variables；`:367` 合并所有 toolProviders；`:383-384` 至多一个 `complete:true` section；`:410` 在 waterfall 后恢复 sole complete section | 完整 persona section 能替换 section 输出；两个 complete section 会报错。不能据此推断 contexts、tools 或 session history 为空；部分 root providers 仍会在最终筛选前执行。 |
| `dsh-system-prompt/lib/index.js:398,406-411` | suppress 只去掉 optional contexts，`required === true` 保留；最终按 required names 过滤 | `includeRuntimeContext:false` / suppress 不能屏蔽 required runtime facts，更不能清掉 AGENTS 的 durable user messages。 |
| `dsh-agent-instructions/lib/index.js:1309-1342,1480-1497` | 有 ctx.fs 时从 cwd/DSH/agents roots 收集 baseline；`agent/pre-step` waterfall 把 desired instruction message 插到 `decision.messages` 中 | 这是独立于 SystemPrompt.sections 的输入通道。private preset 少装一个 instructions 插件，不会撤销已经挂在 root 的 inherited listener；不能因本次没读正常 profile 就断言当前实例没有它。 |
| `dsh-agent-loop/lib/index.js:1018-1075` | 记录 actual request/header 与 tool registry 变化；工具集变化可追加 developer message | 静态 Host text 必须由已知安装版本/受控 builder 明确登记，不能把全部 developer/system message 泛化为已知静态文本。 |
| `dsh-agent-loop/lib/index.js:1078-1091` | `messages: session.deriveMessages()`；`toolHistory: session.toolHistory()`；实际 tools、sessionId、signal；deep freeze + `markAgentLoopRequest(...)` | brand 证明原生构造路径，**不证明每条内容来自本 job 或被 V2 授权**。不能拿 final options 当 provenance 的根。 |
| `dsh-agent-loop/lib/index.js:961-976` | executor 的 `additionalContexts` 会进入 inbox，参与后续 step | tool 主结果之外的上下文也必须受来源约束；attachments、旧 history、插件消息均不得隐式归属当前 owned prompt。 |

当前可证的 isolation 控件是 partial controls。共享 root 的 required contributions / pre-step hooks / providers 未逐项受控之前，严格的 full-input source factory 不能默认成功。可选择 parent 明确隔离 root composition，或在最终实际请求边界验证每项来源并拒绝未知项；不存在已证的单个“private preset = clean input”开关。

## 3. 原生 assistant/session 记录不是 provider provenance

| 实际包 / 位置 | 精确字段 / 行为 | 判定 |
| --- | --- | --- |
| `dsh-session/lib/index.js:1380,1524-1544` | `Session.create(id,seed?,header?,inheritedEventCount?,projections?)`；`append(type,data,{surfaceOp,sourceEventSeqs}?)` snapshot JSON 并赋 `{type,seq,time,data,...}` | schema/surface 校验没有 authenticated writer / admitted call proof。public JS 拿到 Session 后可构造符合结构的 assistant event。 |
| `dsh-session/lib/index.js:1169-1172,307-308,316` | assistant settlement 要求非负整数 turn/step 和 stream 数组；surfaceOp 可为 `"append"`；assistant 不接受 sourceEventSeqs | 限制结构与 surface 引用；不是“该 stream 确实由网络产生”的证明。 |
| `dsh-agent-loop/lib/index.js:377-407,415-434,872-905,949-955` | attemptId 为 `` `${sessionId}:${attempt}` ``；frames start/chunk/end 有 revision、turn/step 或 chunk index/time；end 关联 committed event type/seq；durable assistant/message 存 `{turn,step,message,usage?,stream}` | 是可靠的关联点；attempt 是 attached-Session-local counter，不是跨重启的私有 provider nonce，也不是防伪签名。interrupted attempt/usage 也要处理。 |
| `dsh-agent-loop/lib/index.js:872-873` | 原生 scoped `agent/assistant-stream` 发布 `{frame}` | 可以与 retained actual agent/session/本次 call 的私有记录关联，但仅凭 frame 自带 id 不能认证来源。 |

parent 的最小生产契约建议：在真正已 admitted、pinned 的 **outer stream 边界** 捕获交给 native consumer 的全部 chunks/terminal/usage，绑定私有 job/call nonce、actual agent/session identity、request digest 和 route；再与原生 settlement event/实际组装 message 对上。保留只由该可信 wrapper 写入的 sidecar，逐项匹配消息 role/id/content、tool call/result 与附件来源，不允许 caller 仅提交“候选 metadata”完成登记。要复用原生 accumulator/assembler 的规范化语义，不能假设 raw chunks 与 compacted durable stream 字节相等。

`sourceRuntime.captureModelOutput(...)` 是交给 parent 冻结的**新增接口建议**，不是声称已存在的 native API。它应接受 wrapper 私有 proof，不接受 HTTP/model body 的授权标志；最终 prepareInput 只承认 sidecar 已登记的本 job 输出。没能把原生 settlement 与已 admitted call 对上的 assistant history，保持 unsupported。旧 session、fork/resume seed 或任意 caller append 不能自动变成当前 job 的输出。

## 4. 哪个生命周期与 tool guard 可以形成私有 scope proof

| 实际包 / 位置 | 已证 API / 顺序 | 安全边界 |
| --- | --- | --- |
| `dsh-session/lib/index.js:1918-1933` | `session/created` 同步 dispatch；返回 Promise 不被 await | 此时 agent 尚未完成 setup/preset/registry enter。不能靠 async session-created 回调返回私有安全证明。 |
| `dsh-agent/lib/index.js:703-714,725`；`dsh-agent-loop/lib/index.js:1574-1579` | `agent/created` 用 `ctx.serial(entry.carrier,...)` await；校验 registry entry 的 actual object identity；在 setup/preset 完成与 agents.enter 之后 | trusted factory 的 setup，或 awaited agent/created hook，是绑定 actual agent 与 original H handle 的合适 Host seam。需要 WeakMap + registry identity，不只 sessionId/preset metadata。 |
| `dsh-agent-preset-registry/lib/index.js:733-743` | `composedPreset(agent.ctx)`；`serviceFor(agent,name)` 查询 actual generation mount | 可核对实际 preset 与其提供的服务；`presetForSession` 的 metadata projection 不是这种 proof。 |
| `dsh-tools/lib/index.js:453-506,542-579` | restrict 仅裁剪 inherited/global tool names，own scope registrations 不受它裁剪；`resolve(context)` 捕获实际注册身份；`definitions(scope,toolSet)` 读取 effective definitions | 不能只核对工具名或只设 restrict。必须对 actual scoped toolSet/definitions 的身份与 schema、owned registrations 做精确核对，并检查后续变更。 |
| `dsh-tools/lib/index.js:624-661` | selectExecutor 取最近 scoped executor；`guard(fn)` 注册；`checkGuards(exec)` 先 global、再 inherited scope，每个 `guard(exec)` 返回非 undefined 即拒绝 | guard 是同步、单调拒绝；scope-local tool registration 不会绕过 global guard。不要写返回 Promise 的 async guard。 |
| `dsh-tools/lib/pipeline.js:375-406,468-492` | pre-execute policy + approval 之后 checkGuards，允许后才 dispatch definition.execute | 拒绝 guard 在实际 body 前；可信 root guard 不会被普通“批准”覆盖。仍不是对任意恶意 Host JS 的 sandbox。 |
| `dsh-tool-executor-native/lib/index.js:8-16,28`；`dsh-tool-executor-ptc/lib/index.js:507-509,1733` | native executor 用 shared ToolExecutionPipeline；PTC nested 也带 original agent、toolSet、parent execution token 进同一 pipeline | 内建 native/PTC 的 routed scoped/nested tool calls 都过上述 guard。不能把此结论推广到任意自定义 executor、直接 JS 调用或所有 PTC sandbox 能力。 |

“private safety = true”只能由 Host 私有 factory 对实际 retained agent 建立：核对 agents.get(id) identity、controlled preset generation、selected executor、实际有效工具及 schemas；装 root monotonic guard，对同一 private scope 的非 owned tools 一律拒绝；将 original H handle + 该 agent/session 放入私有 WeakMap。工具变更、agent 替换、handle release/retire、角色/权限变化都使 proof 失效。JSON/HTTP/env/model body、预设名、工具名列表都不能自己产生该 proof。完整输入 provenance 与安全 tool scope 是两个都要满足的条件。

## 实测边界与复核方式

只运行清理环境的 Electron Node stdin：`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --input-type=module -`，`ELECTRON_RUN_AS_NODE=1`，PATH=`/usr/bin:/bin`，HOME/USERPROFILE=`/dev/null`，DSH_HOME/agents/XDG paths 均在 `/dev/null/...`。未创建 store/Host session，没有调用 LlmRuntime/provider、网络或平台，没有 profile 读取或磁盘产物。

第三次 stdin 的前半段执行了以下实际包调用（不是伪造 Session 类）：

```js
const session = Session.create(SessionId('isolated-native-input-provenance'));
const message = createAssistantMessage({
  source: { provider: 'no-provider-called', model: 'no-model-called' },
  content: [{ type: 'text', text: 'CALLER_CONSTRUCTED_ASSISTANT' }],
});
session.append('assistant/message', { turn: 0, step: 0, message, stream: [] },
  { surfaceOp: 'append' });
assert.ok(JSON.stringify(session.deriveMessages()).includes('CALLER_CONSTRUCTED_ASSISTANT'));
```

实际 stdout：`{"sessionProof":true,"node":"v24.21.0","assistantCallerAppendAccepted":true,"derivedAssistantMessageCount":1,"noProviderCalled":true,"noStoreSessionCreated":true}`。这直接证明 public append + structural metadata 不能认证模型来源。

**整个第三次组合 harness 退出码仍为1**：后半尝试纯 Cordis prompt assembly 时用了本安装包不存在的 `ctx.start()`，报 `TypeError: ctx.start is not a function`；prompt assembly 未运行。前两次分别是 fixture 的 Cordis import 扩展名错误（package main 实为 lib/index.js）、以及缺少必需 surfaceOp。三次尝试上限已用，不继续试跑；没有把这个局部成功声称为完整 native Host/buildRequest 捕获通过。prompt isolation/guard/model 结论来自上表实际源码，不是该未完成 harness。

## parent 最小落地与 fail-closed 交接

1. 用真实 registry/factory 形成 actual agent proof；在 awaited setup 固定 exact local model/preset/工具面，禁止 controller.selectModel 的全局写入。每次 dispatch 仍验证 exact prepared route。
2. source factory 保留自己的 owned prompt、approved core persona、逐字可核对的 Host static text、controlled tool results 和 admitted-output sidecar。最终检查完整 actual messages/system/tools/toolHistory/attachments；未知 AGENTS/required context/history 不能重标 current input，也不能只靠 model request brand 放行。
3. 未完成上述关联时，建议结构化拒绝（待 parent 冻结）：`{ok:false,code:'MEMORY_NATIVE_INPUT_UNPROVEN',error:'Native input lacks complete job provenance.',hint:'Keep V1 active; do not dispatch until the Host proves the actual session, effective tools and every input source.'}`。这是具体 unsupported gate，不增加网络授权。

尚未验证：正常加载 profile 的实际 plugins/headers、完整最小 Host fake-provider request capture、真实 QQ/B站 producer/native session 联动、全量 provider-stream sidecar、真实会话退役、Windows 与精确 Node22.13。没有更改任何生产源代码/API/core/index/B/Q/S、安装包或默认模型；无需重启。本文供 parent 决策/接线，不能作为 full-input gate 已通过的凭据。
