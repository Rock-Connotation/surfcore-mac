# P2-BILI-NATIVE：保留 B站 Agent 流的 V2 边界

状态：实现于独立工作树；默认路由不变，不代表已启用或安装。完整 Host 接线、来源生产者及用户界面由主会话验收。

## 决策及完整逻辑

1. **链路**：scheduler 的八个原 prompt 入口先读取 Host 记忆路由。V1 仍延迟构造原提示词；V2 只提交 typed trigger 给 `createBiliV2AgentRuntime`。Host 为每个原作业创建随机新 session，固定实际模型，先安装当前 agent 的工具遮罩及根级 guard，再提交有来源证明的 prompt。每次真实 `llm/stream` 经既有 native budget middleware；typed 工具执行固定 Node 子进程，最终 POST 经 IPC 回到 Host 的 H admission gate。
2. **机制**：sessionId、角色、grant、路由等模型参数不能授权。原生请求由安装版本同模块实例的 `isAgentLoopRequest` 验证；工具由实际 `exec.agent`、执行 token、scoped definition 身份和当前 job 状态验证。IPC 绑定父进程保留的真实 child / exec / job，不接受客户端声称的权限。环境标记只有禁止直连的作用。
3. **爆炸半径**：一条 Host Agent 链路加固定 CLI worker；影响 scheduler 一个调用方、三个 CLI 的最终发送出口、计费拦截及退休屏障。会创建隔离的拒绝登记文件及正常 CLI 已有的 quota / action receipt。真实模型会计费，真实 POST 会对外发内容，因此本轮只用 fake LLM / fake transport / 临时 profile 进行验证。
4. **取舍**：另写 direct-LLM pipeline 会绕开既有 Agent 及 native tool 执行契约，还要重复实现工具调度；复用旧 workspace/session 则无法证明旧历史和未知工具结果的来源。本实现保留 native Agent 流，但每轮用最小 preset、新空会话和四个专用工具；未知上下文直接拒绝。代价是旧工作流中的 score / diary / 图片等功能需另行迁移，不能靠通用 shell 补齐。
5. **生效**：这些模块被 SurfCore Host 插件读取；主会话完成工厂注入和完整来源生产者后，需重载对应插件或重启其 DSH Host。没有调用真实 profile、重启服务、安装插件、切换 backend 或发布。原环境当前路由不由本工单修改。
6. **验证**：运行 `node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs`。预期普通 Node 与实际 ASAR ToolsService / Scope / NativeToolExecutor / private brand 场景全部 PASS，并有 scheduler V1/V2/error fixture。另跑 audit、regressions、既有动态回执及 native/common budget 测试。证据与最终结果见本节末及主会话交接。
7. **回滚与残余**：改动前备份位于 `_backups/memory-v2-bili-agent/{scheduler.js,comment.mjs,dynamic.mjs,dm.mjs}.run1.before`。回滚由主会话在无活动作业时隔离本工单新增文件并恢复这四份文件；不可删除受保护拒绝登记和既有 dynamic receipt 来假装新作业。禁止将失败 V2 作业送回旧上下文重试。完整真实账号/平台、生产来源工厂和完整 Host 装载仍需主会话单独验收。

## 工厂及所有权

```js
createBiliV2AgentRuntime({
  ctx, nativeRoot, memoryV2, getCharacter, tokenBudget, isAgentLoopRequest,
  sourceRuntime, modelRequest, getModelRoute, transport,
  registryPath, nodeRuntime, commandsDir, onBlocked,
})
// => enqueue({requestId,input,signal}), getScope(options),
//    isManagedSession(sessionId), getSessionSafety(sessionId),
//    retire(), close(), getStatus()
```

注入 `nativeRoot` 时，工厂在实际 `createAgent({sessionId,provider,model})` resolve 后才调用 `registerTool(definition, actualAgent.ctx)`；不在 ownedAgents 尚未发布的 setup 内注册，不访问 ancestor tools/preset。来源六 API 的签名不变。native prompt 使用 Host 生成的冻结 `{id,role:'user',source:{kind:'user-rpc',requestId},content}`，经实际 `agent.followup` 入队；没有伪造 sessionController ACK。

isolated 分支退休按 parent 冻结定义：原 agent.cancel 清真实 inbox，await 原 whenIdle，检查 nextTurn/nextStep 均为空，await 原 native handle.dispose，确认 root.ctx.agents.get(id) 不再是该 agent。这是专属 root 的实际卸载 ACK，不是 workspace/disk archive。未注入 root 的旧 controller 分支仍要求 cancel accepted 与 archive ACK。nativeRoot 自身由提供者关闭；B close 后其真实 LLM owner 上的持久拒绝 hook 保留到 owner ctx dispose，root.close 也不能让旧 session 在 outer context 复活。拒绝登记、备份和证据文件保留，不宣称物理删除；完整 lifecycleInventory 由主会话如实列出 pending。

工厂自己安装 B 的根级 `tools.guard` 与 `llm/stream` middleware；index 不得再给同一 B runtime 叠一份预算 middleware。QQ 自己的 middleware 应仅识别其自身 managed session；B 的 membership facade 也只认 B 的登记。

`getCharacter` / `getModelRoute` / `modelRequest` 全部是私有 Host 回调。job 是 frozen 的 `{jobId,requestId,characterId,characterEpoch,sessionId,providerRouteId,provider,model}`；`providerRouteId` 必须等于共享 `deriveMemoryProviderRouteId({provider,model}).providerRouteId`。不得从工具参数或环境导出 job / source refs / grant handle。

`getModelRoute` 必须返回实际已解析的 provider / model，不可返回 `default` 或模型自报别名。工厂只对实际 agent 执行 `agent.model.select`，不调用会改全局默认的 `sessionController.selectModel`。`modelRequest` 返回可信 `estimatedTokens` 和可选 `priceSnapshot`；业务 metadata 固定在 Host，purpose 为 canonical `conversation`。

`getScope` 为同步 WeakMap 查询/建立；完整 options 的 SHA256 排除根级 `signal`，保留系统、历史、工具定义、工具结果和额外输入字段。getter、symbol 或不支持的值拒绝。原请求对象不复制、不换 brand。prepare、异步 validate 返回后及实际 dispatch 临界点都检查原摘要；输入变更必须新授权。

## 六个可信来源方法

| 方法 | 输入 | 必须返回 |
| --- | --- | --- |
| `preparePrompt` | `{job,input,signal}` | `{ok:true,content,handle}`，完整原始来源与固定 persona 已被 Host 绑定 |
| `prepareInput` | `{job,options,request,signal}` | `{ok:true,handle}`，实际完整 request 的所有可处理来源 |
| `validate` | `{job,options?,request?,phase,signal}` | `true` 或 `{ok:true}`，当前角色、来源修订和权限仍有效 |
| `captureToolResult` | `{job,execution,action,result,signal}` | `{ok:true,result}`，先 capture 并绑定来源，再返回受限结果 |
| `prepareSend` | `{job,execution,action,target,payload,signal}` | `{ok:true,handle}`，实际 audience / target 的新 send capability，覆盖全部 job refs |
| `captureModelOutput` | `{job,options,request,dispatchId,phase,chunk?,error?,signal}` | `start/chunk/complete` 必须显式 `true` 或 `{ok:true}`；`failed` 丢弃 candidate |

`captureModelOutput` 是来源验证器，不能授权模型 dispatch。outer middleware 为实际 private options/request 创建 Host UUID `dispatchId`，在既有 budget stream 首次 invoke 前 start；只把 budget 已许可实际 yield 的原 chunk 对象送给 chunk callback 后继续 yield；在原 generator 正常 done 且结算后才 complete。consumer return、异常或验证失败都先让原 budget generator 清理结算，再以 failed 放弃未采用内容并终止作业。没有第二次 invoke，也不缓冲/拼接整个 stream。实际 assembler 的 tool calls、reasoning、完整 assistant 语义由主会话 sourceRuntime 精确匹配；不能用 text concat 或任意 `session.append('assistant/message', ...)` 伪造 native provenance。缺此方法明确返回 `MEMORY_NATIVE_INPUT_UNPROVEN`。

生产可注入主会话/H 验证的 `nativeRoot`：它必须是独立 Cordis ROOT，提供 `ctx/createAgent/registerTool/ownsAgent/ownsRequest/getCurrentCall/getLlmHookContext`。B 的实际 agents、tools、preset 和 session 都使用这个 root；借用 LLM 的 hook 在 `getLlmHookContext()` 返回的真实 owner 上订阅。只处理实际 owned request 和 private retained agent/original options identity；其他 outer session 透传，历史 B DENIAL marker 对应 session 仍禁止在 outer context 续跑。未传 `nativeRoot` 时保留原 fixture 路径及严格来源拒绝，不创建伪隔离或放宽权限。该 root 接缝验证不代表六方法生产 provenance 已完成。

`memoryV2.adapter.withNetworkAdmission(handle, dispatch, {signal})` 返回 RAW dispatch result / error；不能当作 `{ok,value}`。回调中必须同步发起实际 provider 的 first `next()` 或实际 `transport.send()`，之后释放 gate 再 await response。不得先返回 allow ACK，再由 CLI 自行 fetch。

没有完整原文/作者/对象/会话覆盖信息时，上述来源方法必须拒绝。不能把未知 system、历史、文件、图片、tool-result 临时 ingest 一次便当成已授权。公开发言的新 capability 必须覆盖同一 job 的所有来源；先读私信后发公开动态不能只校验正文或最后一次 read。

read worker 的完整 stdout 交给 `captureToolResult`，结果在它完成前不会回给 agent。写回执标记为 derived，并保留当次推理 requestId。score、diary 等生成物不能冒充 observed 原始消息；它们尚未开放为 native tool。

## 八类 typed trigger

| kind | 数据 | 覆盖性质 |
| --- | --- | --- |
| `night-skip` | `snapshot` | 当次排程快照 |
| `night-wake` | `snapshot` | 当次排程快照 |
| `dm-notification` | `snapshot,items` | `notification-only`，不可代替私信完整原文 |
| `comment-notification` | `items` | `notification-only`，不可代替评论完整原文 |
| `live-notification` | `room,stdout` | `transport-output`，不是完整消息授权证明 |
| `attack-review` | `pendingCount` | 受控提醒，不是待审内容原文 |
| `ta-nudge` | `used,limit` | 受控提醒 |
| `daily-nudge` | `kindKey,inSlot,definition,pin,note` | 受控提醒；偏好文字仍须来源校验 |

每个入口的原 V1 参数构造器保持 lazy，因此 V2 不执行 `identityContextLines` / `wakePrompt`，不建立或读写旧 B 会话权限。原 trigger ID 包含 quota day 与 typed input 摘要；同一原作业不能靠换 actionId 自动重试。

## Session 与拒绝登记

实际 Host API 为 `sessionController.create({sessionId,agentPreset})`、`state({sessionId},signal)`，不是 `createSession` / `inspect`。创建 ACK 的 sessionId 必须精确匹配 Host 随机生成值；实际 session 的 deriveMessages() 必须是空数组；原生 toolHistory() 必须是严格的 {tools:[],updates:[]} 空 snapshot（拒 getter、symbol、未知字段或非空历史；仅旧 non-root fixture 路径保留空数组形状），且实际 agent 具备 `model.select`、`cancel`、`whenIdle`。未知或非空历史即拒绝。

受保护 `registryPath` 使用既有 ownership lock、临时文件、fsync、rename 和目录同步。marker 只含 `characterId,characterEpoch,jobId,requestId`，以 sessionId 为 key；不存消息正文、密钥、grant 或源路径。首次 prompt ACK 之前必须持久化。此登记只用于拒绝，不能证明可处理、不可用来重建 grant。

这与 budget receipt 的 native ownership 是两种用途：零次成功模型 admission 的 session 也必须永久拒绝无绑定续跑；预算观察器只有在 canonical admitted receipt 证明归属时才跳过账单，B 工厂不伪造 recordExternalUsage 或 sidecar usage。

一轮完成或失败后：stop/abort 保留的 actual agent，读取并移除真实 queue，要求 cancel accepted ACK、archive ACK，再 await 同一个保留 agent 的 `whenIdle()`。实际 Host 的 inactive state 返回 `queue:null`，同时必须验证保留 agent 的 `inbox.nextTurn` / `nextStep` 都为空。不得在本轮 tool body 内 await 自己 idle；失败清理另排 microtask。

`close()` 关闭作业、preset 并释放 ownership；根级 DENIAL hook 与 guard 保留到其 ctx 被 dispose，阻止旧 session 手动 unarchive 后得到全局工具。关闭后不相关 QQ session 继续 passthrough。无 ACK、元数据损坏或 fsync 失败保持拒绝；错误通过 `onBlocked` / scheduler `onMemoryBlocked` 返回结构化 `code/error/hint`。主会话必须把它展示在当前界面，不能只落日志。

## 固定工具及 IPC

仅开放：`surfcore_bili_read`（feed / debrief / today）、`surfcore_bili_comment`、`surfcore_bili_dynamic`、`surfcore_bili_dm`。其余 shell、文件、管理/MCP、图片、编辑、弹幕、收藏等默认拒绝；本工单不把旧 workspace preset 带进来。actual agent ctx 上 `restrict({allow:[]})` 遮掉继承 globals，scoped registration 定义身份仍受根级 guard 验证。

三个 CLI 只把原最终 POST fetch 换成 `biliV2Fetch`。V1 普通调用继续原 fetch；V2 worker 必须走实际父 child 的 IPC，断开、超时、重复请求不能回退直连。identity / quota / dynamic intent 与未知回执既有逻辑保留，dynamic 使用 Host 的原 jobId 作为稳定 action ID。

| action | 唯一 POST URL | target |
| --- | --- | --- |
| comment | `https://api.bilibili.com/x/v2/reply/add` | public type / oid / root / parent |
| dynamic | `https://api.bilibili.com/x/dynamic/feed/create/dyn` | public text dynamic |
| dm | `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg` | private receiver |

可信 `transport.send` 必须核对或重建当前绑定账号的凭据，worker headers 本身不构成身份授权。Host 从真实 body 解析不可变 target/payload；URL 必须完全匹配，拒绝重复 body 参数。仅在 fresh send handle 的 H gate 内发出固定 endpoint 请求。返回给 worker 的回执只保留 HTTP status、平台 code、固定消息和受限 numeric ID，拒绝回传 transport header、cookie 或任意平台附加字段。已开始的发送断线一律 unknown，保留原 action receipt，不自动更换 ID 重发。

## 验证及交接

2026-11-10 isolated-root 接线增量仅涉及本 runtime、fixture、本契约三文件。原生联合 cycle1 保留为 **FAIL**：首 prompt 前 `BILI_V2_SESSION_UNSAFE`，未进入 provider，日志 `/tmp/surfcore-bili-isolated-root-native-cycle1.log`。只读核对 installed `dsh-session/lib/index.js:709-717,1652-1655` 后确定原生 toolHistory 是 `{tools:[],updates:[]}` 而不是数组；已按该精确对象契约修正，新增正例、非空 tools/updates、缺字段、未知字段和 getter 拒绝普通测试。修后普通 Node 26.5.1 **33/33**，日志 `/tmp/surfcore-bili-root-history-shape-ordinary.log`；本 child 不重复 native，修后真实联合验收由 parent 独立进行，不能以普通测试代替。root 文件保持 parent 冻结 SHA `857d8014013a50a0127d357c76be3faa077065736f6753b48b548cfb4c7b25f0`。


本脚本的 ASAR 模式使用真实安装版本 Cordis、ToolsService、Scope、NativeToolExecutor、ToolExecutionPipeline 和 private LLM brand；通过真实 `tools.execute` 的 prepare / execute / render 流程及带实际 minted token / parent 的嵌套 prepare 验证拒绝。session controller / agent 生命周期、来源方法与平台 transport 使用受控替身；不宣称已运行真实账号或完整生产 profile。

- 新增 fixture：27 项普通运行时场景，ASAR 共 28 项（多一项 nested guard），另有 scheduler 五路由场景和 IPC / digest 断言；所有数据在 `_backups/memory-v2-bili-agent/run-*`。
- 实际结果：Node 26.5.1 普通 27/27、bundled Node 24.21.0 actual ASAR 28/28；`npm run test:audit` 为 176/176，`npm run test:regressions` 全通过；既有 bili dynamic receipt / automation / round controller / round、native agent budget / common admission / canonical budget admission / durable 八脚本全通过。audit 在新增第六 provenance hook 前完成，之后仅重跑本工单两运行时定向 fixture，未重复全量 audit。
- 主会话仍负责：index 注入、完整 sourceRuntime、实际 route pinning、界面错误消费、跨平台记忆 capture 与 H gate 集成；工厂不因 backend=v2 自动补造这些依赖。
- 未做：真实模型、真实 B站 POST、profile 修改、服务重启、安装、commit 或发布。

发布交接块（由主会话补 case 路径与合并后验证结果）：

```text
改了哪些文件：scheduler、三个 CLI 最终 POST 接口、新 native factory / IPC helper / fixture / 本契约（八文件边界）
测过什么：见 fixture 与主会话最终 audit/regressions 证据；不包含真实账号或生产 Host 装载
建议版本：接口层新增能力，待完整接线验收后由发布会话决定；当前不发布
case 文档：本工单仅可写本契约，主会话汇总到 docs/cases/ 对应案例
改动层级：Host 接口新增，V1 参数与配额/回执保留；V2 不支持路径显式拒绝
完整逻辑与爆炸半径：本文第一节
失败路径：onBlocked/onMemoryBlocked 的 code/error/hint；元数据/来源/角色错误先恢复 Host，unknown 先查原回执，禁止自动重发
还有什么没验证：生产 sourceRuntime/index/UI、实际账号/模型/平台、完整 Host 装载
```
