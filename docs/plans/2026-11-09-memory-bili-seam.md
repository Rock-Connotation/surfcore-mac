# P2 Bili：模型输入 → 工具 → 网络出口的可信调用缝

2026-11-09 只读事实核对。只新增本文，不修改源码、安装包或用户状态；未执行真实模型、网络、服务、profile 或提交。以下“已验证”指源码契约，未声称生产端到端通过。

## 1. 结论与应先冻结的边界

现有 B站 agent 通过通用 shell 执行 `node .../tools/bili.mjs ...`；到 CLI 最终 POST 时没有自动携带完整 memory input manifest、可信 request/job capability 或 processing grant。当前 optional role env、cookie 账号守卫、额度与动态 action receipt 均不能替代这些契约。

当前安装的 Host **具备**可信工具调用拦截、原生工具注册、完整模型请求拦截、归档和等待 agent idle 的公开入口。因此无需修改安装 bundle；但它没有现成的“把 Bili CLI 自动绑定到同一 memory job”的 API。需要仓库内 Host adapter 显式维护该关系，并在真正网络调用前复核。

父协调者已明确：**保留现有 Bili agent 流程，不在事实核对中擅自改成 direct pipeline**。本地源码可证明存在支持该方向的可信缝：实际 agent-loop request 带 Host-origin sessionId 和进程内对象品牌，native tool execution 另带 actual agent/session/token。它们可以由 SurfCore 创建 session 时登记的 Host job map 连接，见 §4。

需要为专用 V2 session 限制工具、拦截完整每步输入、追踪新 tool result/附件、绑定最终 CLI 出口，并单独解决 agent-loop 预算 observation 关联。**不能**直接用 common direct runner 包住 `sessionController.prompt`；它返回 enqueue ACK，且 agent 自己写 usage event。若后续发现所需外部契约不支持，应向父协调者 hand back，而不是自行改变产品流程。

## 2. 现有调用链：实际暴露方式

仓库路径均相对本仓库根 `/Users/shizihan/Daily/Github/surfcore-memory-v2`。

| 已核对入口 | 当前行为 | 缺少的绑定 |
| --- | --- | --- |
| `plugins/surfcore/lib/scheduler.js:873-875` | prompt 中要求执行绝对 Node + `plugins/surfcore/tools/bili.mjs` 命令；`:628-648` 选择 standard preset/local tools | 没有原生 Bili tool schema 的 per-call capability |
| `plugins/surfcore/tools/bili.mjs:63-79` | 从 argv 选择静态脚本，`spawnSync(process.execPath,[script,...rest],{stdio:'inherit'})` | 仅转发 model argv 与环境；未注入 session/request/manifest lease |
| `plugins/surfcore/lib/scheduler.js:519-534` | legacy budget block 后 `ctx.sessionController.prompt(args,signal)`；非 budget 异常会 log 后继续 | 没有 V2 processing admission；prompt 不是一次模型 dispatch |
| `plugins/surfcore/lib/scheduler.js:176-199` | memoryCardBlockForBili 有 legacy fallback；biliContextForRound 校验 checked 后丢弃 checked.text，重新 identityContextLines 读取 persona/self/admin/alignment/QQ近况/card | 已验证的包与实际拼入文本不是同一快照；V2 必须直接使用 Host 构建/绑定的输入，不得回退重读旧卡或未授权 QQ 文本 |
| `plugins/surfcore/lib/scheduler.js:666-695` | inspect/reuse 持久 session，缺失再 create | 已有历史可能含旧角色/旧 memory 输入 |
| `plugins/surfcore/lib/extensions.js:220-246` | `api.bili.run` → `execBili` → execFile，传 ambient env/runtime patch | 无 invocation session/request binding |
| `plugins/surfcore/lib/bili-round.js:92-106` | direct round 只允许 feed/debrief/score/today，Host 捕获角色再传 expected-role env | 这是可信 direct producer 的角色 pin；不是 generic shell 的授权证明 |

当前源码检索未发现 SurfCore 注册原生 `bili_comment/bili_dynamic/bili_dm` 工具的实现；Bili 主命令映射位于 `plugins/surfcore/tools/bili.mjs:10-60`。实际 Host 通用 shell 名字为 **`bash`** 和 **`pwsh`**，不是一个 Bili MCP endpoint：安装包 `@deepseek-ai/dsh-tool-bash/lib/index.js:493`、`@deepseek-ai/dsh-tool-pwsh/lib/index.js:466`。

主命令面不只有 comment/dynamic/dm。还包括 daily/share-dynamic、dynamic-image、dynamic-edit、danmaku/auto、fav、comment-del 等写出口。因此仅补三个文件后，V2 专用 session 必须禁止其余未迁移动作；不能宣称全 Bili 写操作已覆盖。

### 最终网络出口

- `plugins/surfcore/tools/commands/comment.mjs:445` 最终评论 POST 前已有身份/额度守卫，但没有 memory manifest lease；也没有导入 `assertExpectedCharacter`。
- `plugins/surfcore/tools/commands/dm.mjs:92-111` send 经过身份检查和异步账号查询再 POST；没有 memory lease，也没有 expected-role guard。
- `plugins/surfcore/tools/commands/dynamic.mjs:140-166` 有角色/凭据 hash/accountMid/actionId 绑定；最终 `plugins/surfcore/tools/lib/dynamic-receipt.mjs:130-134` 调 `expectedIdentity()` 再 `await send()`。该回调目前同步，不能冒充已完成 async memory validate。intent/unknown/actionId receipt 必须继续保留，结果未知不得自动重发。
- `plugins/surfcore/tools/lib/state-paths.mjs:53` 的 `assertExpectedCharacter` 在两个 `SURFCORE_EXPECTED_CHARACTER_*` 都缺失时返回 null。模型 shell 可改 env，所以它只能作一致性检查。

## 3. 安装 Host 的真实接口与信任级别

下面安装源码根为 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`；ASAR 通过已安装 Electron 的只读 fs 接口检查，未修改安装包。

| 入口与精确位置 | 源码证明的能力 | 不能据此假定 |
| --- | --- | --- |
| `dsh-tools/lib/index.js:433` `ctx.tools.register(definition,options)` | 注册 `execute(args,exec)`；要求 `output:{schema,render}`，有 disposer，支持 scoped/global | 不会自动给工具加 memory authority；模型 arguments 仍不可信 |
| `dsh-tools/lib/pipeline.js:293-313` | pipeline 创建 execution token；exec 有 `token,callId,rootCallId,name,signal,agent?,toolSet?,parent?` | callId 不等于可信业务 requestId；无内置 role/epoch/manifest/grants |
| `dsh-tools/lib/pipeline.js:492` `tools/execute` waterfall | `ctx.on('tools/execute',async(exec,next)=>...)` 可以在 body 前 async validate；真实 agent/session 与 token 不靠 CLI 自报 | 仅拦某个 shell 命令字符串不能约束任意子命令、二次 shell 或直接 HTTP |
| `dsh-tools/lib/index.js:649-660` `ctx.tools.guard(fn)` | 同步、单调拒绝；`fn(exec)` 返回 denial reason string 拒绝，undefined 放行；pre-execute approval 后仍检查 | 此处不能 await；不要返回 false 当作放行 |
| `dsh-tools/lib/pipeline.js:386` `tools/pre-execute` | async waterfall fallback `{kind:'allow'}`；已有 deny/cancel/ask 决策形状 | 新业务授权不应触发无关 ask/用户审批 |
| `dsh-tools/lib/index.js:453` `agent.ctx.tools.restrict({allow,deny})` | scoped tool mask，交集限制；global context 调用被拒 | 仅改 prompt 不等于工具限制；不要在第一次 prompt 已运行后才安装 guard |
| `dsh-shell-env/lib/index.js:58-104` | `ctx.shellEnv.register({name,variables,resolve(execution)})`，同步 contributor；`:89` 从 actual execution.agent.session.header.id 注入 `DSH_SESSION_ID` | env 不是不可改 authority；没有 builtin role/request/grant；同步 resolve 不能做 async validate |
| `dsh-tool-bash/lib/index.js:663-702` / `dsh-tool-pwsh/lib/index.js:636-674` | collect(exec) 的 DSH env overlay 到真实 shell；foreground 用 exec.signal；background 有单独 job registry | session cancel ACK 不证明已分离 background child 都停止 |
| `dsh-tool-executor-ptc/lib/index.js:500-510` | nested call 有 rootCallId、实际 agent、parent execution token 与 signal | 不能只拦最外层 run_code；要覆盖每个 nested tool body |
| `dsh-llm/lib/index.js:2398-2402` | `ctx.on('llm/stream',(options,next)=>...)` 接收完整 request，prepared call 同样经过 waterfall | 无自动 memory requestId；也未证明 budgetRequestId 被写入 session event |

不把环境变量值、模型传来的 `_meta`/角色/授权字段、parent cwd 当成证明。可信 authority 来自 Host 维护的 actual agent/session/job 映射和 Host-created execution token；opaque handle 可以作为 selector，但不能让模型指定 grants、角色或源集合。当前 CLI 没有读取某个 SDK `_meta` 的契约。

### 完整输入的可观察边界

`dsh-agent-loop/lib/index.js:1018-1092` 构建每步实际请求；`:1078` 读取完整 `session.deriveMessages()`，`:1085-1092` 标记并冻结 messages/toolHistory/tools/sessionId/signal。`:877-883` 发到 llm。因此 llm/stream 能看到的是完整步输入，不能只验证 scheduler 最新 prompt 或一张 prepared 摘要。

注意 `dsh-llm/lib/index.js:2340-2354` 在 middleware 之后还会将 file refs/image/tool updates 投影到 adapter 输入。正确 manifest 还需要对应文件/图片/转写快照的 payload digest 与来源政策；未知或无法关联的附件/旧历史必须拒绝，不可把整段旧历史重新标成“当前授权”。新 session 本身也不能证明 standard preset 注入的 system/memory 都已合法。

现有仓库能力可复用：`plugins/surfcore/lib/memory-v2-host.mjs:47` `createAdapter({channel,principal,purpose,canBindInput})`；`:81-107` capture 只接 conversationKey，可信 resolveIdentity 与 audience resolver 产生账号/路由/政策；`:131-159` prepare/validate/verifyPrepared/bindActualInput。默认 resolver 拒绝；当前 `plugins/surfcore/lib/memory-v2-identity.mjs:15` 只有 QQ resolver，Bili identity 仍须父协调层注入真实账号和确定 conversation/providerRoute 映射。`sourceFacts` 目前只允许 QQ，不能给 Bili 塞模型提供的 identity facts 绕过它。

绑定引用必须是 `type,id,revision,payloadDigest`，上限 100，见 `plugins/surfcore/lib/memory-v2-host.mjs:13-22`；prepare 的 manifest 不包含未检索但实际输入中的原始视频、score reason、旧对话、tool result 或 raw card，Host 必须补全 bindActualInput，再 validate 所有源的 audience 与 provider-processing 交集。

## 4. 已核准的 agent LLM → native tool → network 缝

### 4.1 实际 llm/stream options 的 Host-origin 字段

精确传递链（安装源码，未凭 ambient env 推断）：

1. `dsh-agent-loop/lib/index.js:868-877`：`const request = this.buildRequest(config, preparedCall, assembly.tools, {turn,step}, startsRequestSeries, signal)`，随后 **同一个 request** 传入 `preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`。
2. `dsh-agent-loop/lib/index.js:1078-1092`：冻结实际 `session.deriveMessages()`，返回 `markAgentLoopRequest(Object.freeze({...header.config, messages:boundaryMessages, toolHistory:session.toolHistory(), ...tools, sessionId:this.session.id, signal}))`。`sessionId` 在 config spread **之后**由 actual agent 的 session 覆盖，因此这条 agent-loop 路径不是模型自报 ID。
3. `dsh-llm/lib/index.js:2254-2263`：prepared call 只允许一次 dispatch，检查配置一致，然后 `this.streamWithRegistration(options,{...})`，没有复制/剥离该 options。
4. `dsh-llm/lib/index.js:2398-2402`：普通 stream 同样调用 streamWithRegistration；后者 `ctx.waterfall(this,'llm/stream',options,()=>this.adapterStream(options,prepared))`，middleware 收到上述对象。
5. `dsh-llm/lib/index.js:358,377-387`：`AGENT_LOOP_REQUESTS` 是模块级 WeakSet，`markAgentLoopRequest` 记录**精确对象**，`isAgentLoopRequest(options)` 检查对象身份；两者在 `:2434` 为 package public exports。模型不能通过 JSON 字段伪造这个对象品牌。可信 Host 插件可调用 mark，所以它不是隔离恶意 Host 插件的密码学凭证。
6. 官方已安装用法：`dsh-session-checkpoint-policy/lib/index.js:61-64` 就在 llm/stream 读取 options.sessionId，经 `ctx.sessions.get(id)` 找真实 session；`:26-30` 返回 async generator，在 `await ctx.sessions.flush(session)` 成功前不调用 `next()`。

明确字段边界：该 envelope **有** actual `sessionId`、`signal`、messages/toolHistory/tools 和 provider/model config；没有该 return expression 追加的 `agent` 对象、SurfCore jobId、memory requestId、role/epoch、grant 或 manifest。`turn/step` 作为 buildRequest 的 position 参数被用于 session 记录，但没有在该 return expression 中成为独立可信 options.turn/options.step/trace 字段。不要虚构 requestId 或从 shell env 补成 trusted metadata。

可由调用同一已安装 `@deepseek-ai/dsh-llm` package instance 的 `isAgentLoopRequest` 验证品牌；复制函数源码或另一份 module instance 有不同 WeakSet，不能工作。composition 是否能导入同一实例须在接线 fixture/Host 验收中确认；不允许对安装 bundle monkeypatch。

**足以建立的 Host 绑定**：SurfCore create 得到 sessionId 后，在第一次 prompt 前登记私有 `{sessionId -> retained agent/session object, jobId, role/epoch, adapter handle, preparedHandle, full input refs, route, abort}`。llm/stream 对该 session 验证品牌 + current actual session object + job 状态，再 async validate 实际完整 envelope/manifest/route/grants；缺映射/品牌/来源拒绝。其他渠道请求按各自已有策略处理，不把它们绑定成 Bili。

异步 LLM guard 必须保持 stream 契约：参照官方 afterCheckpoint，返回 async generator，在第一次 `next()` 前 await 验证；不要把 listener 简单改成返回 Promise<stream> 的 async function。每个 await 后检查角色、撤销与 signal；完整输入包含动态 tool result/附件，不能只检查首次 prepared 摘要。

### 4.2 native tool guard 与绕过点

使用 `ctx.tools.register` 提供固定 Bili read/write 工具，模型只提供允许的业务 selector/文本，不提供角色、grants、source manifest 或授权 session。真实 `execute(args,exec)` 的 `exec.agent.session` 与 Host-created `exec.token` 绑定到同一 job/session map；callId/rootCallId 仅做关联，不单独当 authority。

- `tools.guard` 单调拒绝发生在 extensible `tools/pre-execute` 决策之后，见 `dsh-tools/lib/pipeline.js:386-404`，因此前一个 policy 返回 allow 仍会检查 guard。guard 同步返回 reason 或 undefined；async memory validate 放在 `tools/execute` middleware/原生 body。
- `tools/execute` 本体包装在 `dsh-tools/lib/pipeline.js:488-492`。对 V2 session 的不在 allowlist 工具默认拒绝，不能让 raw file/admin/shell/未受控 HTTP/MCP 继续作为旁路。
- PTC 不是绕过理由：`dsh-tool-executor-ptc/lib/index.js:500-510` nested input 继续带 actual agent、toolSet、parent token 与 signal；`:564-566` 调同一 pipeline 的 `prepare` 再 `dispatch`，所以 native guard/middleware 应覆盖 nested body。不要像 checkpoint 示例一样在业务授权里因 `exec.parent` 存在就跳过检查。
- 原生工具必须检查没有 agent、foreign session、失效 job、错误 parent/root 链的调用；不能只在 tool schema `when` 或 prompt 隐藏工具。限制在 create 之后、首次 prompt 之前安装；`dsh-api-session-controller/lib/index.js:666-697` create 已创建 actual agent 并返回其 sessionId。
- read 工具取得外部结果后 **先捕获原始源/ingest/bind refs，再返回给 agent**；role/revoke 在取得结果与返回之间发生则不把数据放进下一步。模型下一步 actual messages 由 llm/stream 再验完整来源。
- 不把任意 command 传给 CLI；固定脚本/action/target schema。V2 未迁移的 dynamic-image/edit、danmaku、fav 等写入口仍须禁止。

### 4.3 最终 CLI/network lease

Host 保留 per-job adapter 与 authority closure，不写全局共享授权文件。可由固定脚本 allowlist 经 Node `child_process.fork` 建立专属 IPC；CLI 在构造最终 immutable POST target/body 后请求该 job 的网络 dispatch。Host 根据**自己持有的 child object/channel**关联 job/session/token，不能按 child 自报 sessionId/env 授权。opaque handle 只是 selector，不让模型选择权限。

推荐 Host 完成最后一次 async `adapter.validate(handle,preparedHandle)`、完整实际 input manifest 与全部源政策/route/grant 交集验证，并亲自调用固定 allowlist endpoint 的 network transport，再把受限平台结果回给 CLI。仅回“允许”后让 CLI 自行 fetch 仍有跨进程撤销窗口，不能把 IPC ACK 当最终 gate。IPC 失联/超时/复用/角色变化/撤销默认拒绝，实际 network AbortController 与 child 均由 Host 跟踪。

这是需新实现的仓库 IPC/dispatch 接口，不是已存在的 Host SDK。原 quota/identity/dynamic intent/unknown receipt 继续保留。HTTP 已发出的动作不能靠撤销“撤回”；区分未 dispatch/在途/已确认/unknown，不自动换 actionId 重试。

**仍独立待冻结：agent-loop 预算去重。** `dsh-agent-loop/lib/index.js:949-955` 自行 append assistant/message usage；没有已证明的 supported writer hook 自动写 `event.data.budgetRequestId`。direct runner 文档 `docs/plans/2026-11-09-memory-model-admission.md:91` 已排除 agent-loop 包装。本次 sessionId/brand 事实解决身份关联缝，不等于解决持久 usage observation 去重；该外部契约交父协调者，不伪造 metadata 或双重 settle。

## 5. 角色切换、撤销与 stop/archive ACK

| 方法与源码位置（安装 Host） | ACK 的真实含义 |
| --- | --- |
| `dsh-api-session-controller/lib/index.js:831-871` `prompt(request,source)` | requestId 去重并 steer/followup，返回 `{accepted:true}` 是入队，不是模型已完成 |
| `dsh-api-session-controller/lib/index.js:903-953` `updateQueue({sessionId,itemId,action:{kind:'remove'}})` | 可逐项删除 pending next-turn/next-step input；不存在已证明的 public `clearQueue()` |
| `dsh-api-session-controller/lib/index.js:960-965` `cancel({sessionId})` | `agent.cancel(...,{keepInbox:true})`，保留队列；accepted 不等于 drain |
| `dsh-agent-loop/lib/index.js:579-585` `agent.cancel(cause,options)` | 不带 keepInbox 才 clear inbox，再 abort 当前 phase；同步发信号，不 await completion |
| `dsh-workspace/lib/index.js:526-540` `ctx.workspaceRegistry.archiveSession(id,{stopActivity:true})` | 先 durable archive，再发 stop requests；`:524` 明确只等所有请求发出，不等 drain；已归档 id 会直接 return，不再 stop |
| `dsh-api-workspace-controller/lib/index.js:297-308` | archive controller 返回 `{archivedSessionIds}`，不是旧输入已擦除 |
| `dsh-api-session-controller/lib/index.js:3265` | archived-session gate 拒绝未来 agent/pre-step，包括相应子会话谱系 |
| `dsh-agent/lib/index.js:29-38` | archive observer 调 cancel，不带 keepInbox；不是 await quiescence |
| `dsh-agent-loop/lib/index.js:634-638` `agent.whenIdle()` | 等 activityDone 且循环确认 driver 未换；属于 agent driver idle 证据，不包含任意已分离 background job/平台网络结果 |

Host 可用实际 `ctx.agents.get(sessionId)`（controller `:961` 同样使用）拿到 agent。退休流程应先失效 Host lease/拒绝新模型和工具，再 abort active child/network，archive+stop，等待 retained agent.whenIdle 并确认身份/队列/自身 tracked jobs。**不要在该 agent 自己正在执行的工具 body 内等待自己的 whenIdle**。超时/stop 不确认要显示结构化失败并保留禁止复用状态。

现有 `plugins/surfcore/lib/scheduler.js:1330-1333` retire 只有 stop timers + controller.cancel；不能证明队列清空或在途停止。仓库 `src/dsh-client.js:481-483` 的“archive 只隐藏”注释弱于当前安装实现；当前 Host 归档还提供未来步 admission gate，但仍不 purge 原历史，不可拿它当删除数据证明。

## 6. Bili 原始源、可变 revision 与分享依赖清单

| Producer / 实际读源 | 当前稳定键与可变性 | V2 捕获要求 |
| --- | --- | --- |
| `plugins/surfcore/tools/commands/feed.mjs:49-66`；search/gamefeed/video-content、thread/comment-digest/dm-await 等经 `tools/bili.mjs:10-60` 暴露的读取 | 视频 BV/aid、评论 rpid/root、作者 mid、私信对话/消息等是源对象 selector；标题/简介/字幕/评论/私信与读结果可更新。feed `:239`、gamefeed `:180` 还写 pick 状态 | 整个实际 tool result/候选/通知/正文在模型前捕获；不把 selector 当 payloadDigest；私信/主人内容不因来自 B站就 public |
| `plugins/surfcore/tools/commands/debrief.mjs:128` + `plugins/surfcore/tools/lib/watch-history.mjs:213-260`；bili-watch 同类 writer | observationId/activityId；同 observation 或同 BV/cid 30分钟升级合并，`:107-113` revision +1；保留部分语音/帧/coverage/错误，2MiB rotate | 使用 observation/source identity +真实 revision/digest；转写分段、cid/范围/语言、帧/图片/字幕文件单独列依赖；不能只记录视频标题 |
| `plugins/surfcore/lib/bili-perception.js:38-63` | recordHistory 后 projectExperience，eventId=`bili-observation:${job.jobId}`；模型前已经有 observed/restricted bili 的外部经历 | 复用最早可信 source capture；后续媒体补齐/partial→complete 须产生新 revision；不得把它当模型主观点评 |
| `plugins/surfcore/tools/lib/scores.mjs:57-69` + `tools/commands/score.mjs:31` | 每日同 BV 更高分更新 score/reason/at；没有 sourceRevision 字段，14天裁剪 | 稳定实体 key 与 payload digest 分离；score、reason、title 的更新必须使 V2 revision 变化，不能只 hash BV |
| `plugins/surfcore/tools/commands/fav.mjs:147-164` | 网络收藏后 favorites.json append `{bv,title,at,reason,kind,favId}`；JSON 内容可变 | 原始收藏事实与主观 reason 分别归因/可复核，保留账号/对象/正文 digest |
| `plugins/surfcore/tools/commands/quota.mjs:176-193`、comment/dynamic/dm 发送回执 | quota.json log 的 target/note/reply/share/at；发送状态和结果可变 | 发言正文/回复对象/unknown receipt 与后续确认均入源；不能把模型自己记录的 note 当外部已观察事实 |
| `plugins/surfcore/tools/commands/diary.mjs:30-39`、daily `:387`，以及 role `whale-diary.md` | whale-log.jsonl append 无业务 event ID；叙事文件可任意改写。旧聚合用日期/短文本 | 对 append 源用真正持久 segment/offset 或 source generation；叙事更新要显式 digest/revision，mtime 仅是缓存提示 |
| `src/bili-memory.js:271-375`、`:378-492`、`:654-682` | collect 读 diary/scores/favorites/quota + dynamics/title cache；卡 `bv:${bv}`, `thought:${date}:${shortText}`, `dynamic:${id}`；refresh 可补标题/owner/pic，再分别写 doc/brief/index | doc/brief/index 是派生投影，不是授权原始源；记录各组成 refs 与 cache payload 版本；稳定 card.id 不代表内容没变 |
| `src/bili-dynamics.js:93-136` 自动同步 | cache 存原始 dynamics items，以 item.id 做 seen；formatDynamicMessage `:40` 含 text/title/url，`:129` 直接 sendToQQ | 这是另一条跨渠道 raw producer/网络出口，不能被分享卡 gate 代表；需要 QQ owner 提供最终 audience/source refs gate，未接线时 V2 禁用 |
| `plugins/surfcore/lib/memory-card.js:300-343` 旧 aggregate | size/mtime fingerprint；eventId=sha256(entry.id)，seen 后跳过 | 已有根因：同 BV 分数/理由/标题变化仍同 ID，容易永远漏 ingest。V2 用真实源版本与 payload digest，不沿用 seen-id 即 immutable 假设 |

`plugins/surfcore/lib/bili-round.js:168-228` 是 feed→context→选择模型→debrief/media→完整 transcript→点评模型→score→readback→memory 维护。两次模型都是 direct stream（`:122-165`），可迁入 common runner；当前 stream guard 在 usage 捕获之前，迁移时必须倒正。评分/点评/拟动态是主观模型产物，`dynamicText` 仅草稿，不能自动转为外部 observed。

### Raw share card 有两条独立出口

`src/bili-share-scheduler.js:165-221`：pick card → `sendCard(key,card)`（`:201`，先发）→ `buildSharePrompt`（`:207`）→ `deliverPrompt`（`:210`）→ recordShare。两条必须各自 gate。

- `src/bili-share-scheduler.js:39-67` 的实际 prompt 包含 title、url、`reason || text`、quote，不只 prepared 摘要。
- `src/bili-card.js:117-167` 可 await fetchVideoInfo 补 title/owner/pic，缓存 miniapp ark，然后 `sendGroupSegments` 真发；补元数据之后仍要复核 manifest + QQ 目标 audience，不能只在 scheduler 选 card 时检查一次。
- `src/bridge.js:9776` 创建真实 sender；`:17344-17354` 向 share scheduler 注入 deliverPrompt/sendCard。bridge 属于 QQ/协调者边界；Bili 子任务不能自行证明或修改其最终 QQ send gate。这里的 bridge 行号是本次只读快照；该文件有并行 QQ 改动，后续按 createBiliCardSender/createBiliShareScheduler 符号定位。

因此 raw card 的 score reason、diary/quote、favorite、title/owner/pic cache、后续补充 video metadata 和目标 QQ 群均是实际依赖。相同 card.id 可对应不同输入；QQ 跨渠道授权必须由实际 QQ 目标的可信 audience resolver 与完整源政策交集决定。

## 7. 后续工单建议：各自最多 8 文件，避开 D/S/Q/index

以下是可派发的**候选边界**，不是本次实现。当前方向已明确保留 agent 流程；不在工单中擅自替换为 direct 回复。每个工单独立验收，不同时修改同一路径。

### A：先冻结最终 Bili 网络 gate（8 文件上限）

1. NEW `plugins/surfcore/lib/bili-v2-dispatch.mjs`：Host job/lease registry、可信模型/网络 closure、可选 native tools/middleware 注册；只导出 factory，不自行改 index。
2. NEW `plugins/surfcore/tools/lib/bili-v2-dispatch.mjs`：专属 IPC final POST 检查；缺 authority/失联/超时 fail closed，不能写全局 shared authorization 文件。
3. `plugins/surfcore/tools/commands/comment.mjs`：最终 immutable target/body 与 async gate；保留原 identity/quota。
4. `plugins/surfcore/tools/commands/dynamic.mjs`：在真实 send closure 内完成 async gate；保留 actionId/unknown receipt。
5. `plugins/surfcore/tools/commands/dm.mjs`：所有 send 分支均 gate，尤其 me() await 之后。
6. `plugins/surfcore/lib/scheduler.js`：fresh-session lifecycle + controlled native tools + Host job/session 绑定；未迁移 generic write path 在 V2 禁用。
7. NEW `plugins/surfcore/scripts/test-memory-v2-bili-dispatch.mjs`：fake network/child/Host exec +真实 memory/budget fixture。
8. NEW `docs/cases/2026-11-09-memory-v2-bili-dispatch.md`：完整链路、失败、回滚和交接。

父协调者负责 `plugins/surfcore/lib/index.js` composition mount：注入真实 memoryHost/Bili identity/provider route/budget/character/network transport，必要时 registration disposer。保留原 agent 回合时，§4 的 agent-loop usage writer 外部契约仍需单独冻结；该问题不能塞进本工单用猜测完成。未迁移 comment-del/dynamic-image/edit/danmaku/fav 等必须明确禁用或单独工单。

### B：再做源捕获、revision 与 direct round（8 文件上限）

1. NEW `plugins/surfcore/lib/bili-v2-source.mjs`：可信源快照/refs/版本归并；不使用模型自报 identity。
2. `plugins/surfcore/lib/bili-perception.js`：最早 source capture 与媒体升级版本。
3. `plugins/surfcore/lib/bili-round.js`：完整 candidates/transcript/context manifest +common runner；取消/role change 时 usage 仍先捕获。
4. `plugins/surfcore/tools/lib/scores.mjs`：可验证更新语义，或改为由 source collector 显式管理 score snapshot 版本，测试不可漏更新。
5. `src/bili-memory.js`：原始依赖 refs 与派生卡版本；不把派生 index 当唯一真相。
6. `src/bili-share-scheduler.js`：raw card +prompt 的可信依赖/授权回调，缺回调在 V2 默认拒绝。
7. NEW `plugins/surfcore/scripts/test-memory-v2-bili-source.mjs`。
8. NEW `docs/cases/2026-11-09-memory-v2-bili-source.md`。

父协调者/QQ owner 负责 `src/bridge.js` + `src/bili-card.js` 的最后发送边界与补元数据 refs，不在 Bili 子任务中偷改；父协调者提供已冻结 callback contract。旧 `memory-card.js` 的 V2 分支绕开 legacy aggregate，由父协调层控制模式，不要求 B 子任务改 D/S/Q 的共享聚合路径。

## 8. 后续验收与明确未覆盖

必要 fixture 至少包括：实际 exec/session 正确但模型伪造 role/grant/env 不获权；跨 session/adapter/child/重复 token 拒绝；输入源或标题/score reason 同 ID 更新后旧 lease 拒绝；实际 tool result/transcript/raw card 中任意一源 revoke 后模型和最终 send 都拒绝；角色变化在每个 await 后拒绝；IPC 失联/settle/fsync/unknown 可见且不重发；fresh session 无旧史，未知 system/附件拒绝；cancel ACK 后队列与 background work 不被误当停止；direct runner usage-on-throw 与跨角色全局额度仍成立。

本文验证方式：仓库定向 grep/sed、安装 ASAR 只读 source ranges；未跑可能有副作用的 probe/setup/selftest。文档 formatting 用 `git diff --no-index --check /dev/null docs/plans/2026-11-09-memory-bili-seam.md`。没有新运行时代码，所以没有声称执行 audit、模型、真实网络发送或原生 Windows 验收。

尚未完成的外部契约：Bili trusted identity resolver 与 index composition；保留 agent loop 所需的真实 usage event 关联；bridge/QQ raw share final-send capability；源 snapshot/revision ingress 与 full manifest builder。它们都有明确 owner/工单，当前仅有设计输入，不能据此打开生产 V2 Bili。
