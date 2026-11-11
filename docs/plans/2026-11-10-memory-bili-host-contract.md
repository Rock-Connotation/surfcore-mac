# Bili V2 Host 生产组合契约

状态：实施前接缝记录；下述生产组合尚未实现，不能作为交付或安装证据。沿用已确认的 Memory V2 P0–P4 范围和 Lead-Core 拓扑。HY4 子工单当前仅处理 DM msgKey 与移除 today，写范围与本契约不重叠。

## 事实与决定

- `plugins/surfcore/lib/index.js` 已构造 Memory V2 runtime，但 startScheduler 没有传入 memoryV2/biliV2Agent；Bili 状态读取也未接入官方 transport。
- `plugins/surfcore/lib/scheduler.js:539` 已支持 V2 enqueue 并拒绝回退旧上下文。其 requestId 对 quotaDay/where/input 求摘要，须维持同原任务去重。
- 真实 Host `agentDefaultModel.currentSelection()` 返回 detached provider/model/reasoning 选择；LLM 的 `resolveModelInfo(provider, model, signal)` 查询精确模型元数据。两项已读 App 内置 SDK 源码确认。不从 QQ 配置猜 B站路由，不借用固定 COMPANION_ROUTE。
- 已接受的 `loadMemoryV2NativeEnvironment` 提供真实模块、codec、LLM 和保留 owner；实际来源 native 已通过该 helper 的 2 calls/2 sources/30 tokens。不得重新构造虚假的 SDK/owner 替代。
- 用户确认删除从未实现的 today 分支，完成 feed/debrief；原 score --today 保持。当前官方原件传输对 VIDEO/feed/debrief 仍明确未覆盖，不得把 CLI 摘要标为 full。
- 来源原评论 root/parent 与回复目标 root/parent 分开；权限保持精确账号、对象、模型路由和受众，不因接线扩大。

## 选型

路线 A：把组合与并发/清理逻辑全部写入已超过 4,000 行的 index.js。可少一文件，但难以独立验证，也把角色与来源所有权分散到大量 HTTP 分支。

路线 B（采用）：增加内部 `bili-v2-host.mjs`，组合现有 runtime/source/official/native 模块，index 仅提供真实 Host 服务、角色、核心人格路径、凭据读取与现有预算，scheduler 消费 enqueue/retire。成本是一个有限接口，收益是可验证的私有 job scope 和统一清理；未启用 V2 时不创建原生 root。关闭组合入口并恢复旧插件可回滚，用户账本不回滚。

## 输入输出边界

拟定内部构造器接收 ctx、stateDir、memoryV2、getCharacter、getCorePersona、getCredentials、tokenBudget、nodeRuntime、commandsDir、fetchImpl、onBlocked。ctx 必须来自插件 Host；运行时不接受模型/HTTP 传入 nativeModules、codec、LLM owner、job 或 scope。

公开给内部调用方的最小能力：

- `enqueue({requestId,input,signal})`：只接受受信 scheduler 的 DTO，经 projectBiliV2Trigger 分组。由原 requestId + 固定 group scope 派生稳定子 ID，不自动替换未知回执的 ID，不重试发送。
- `getPlatformState()`：鲜活官方 NAV 账号 + 当前精确模型 + 有界已登记目标；只保留角色内内容无关的目标 DTO，供 Memory runtime 身份校验与权限候选。不能用 Cookie 字段、公开状态后缀或 TTL 身份缓存代替官方结果。
- `retire()` / `close()`：停止接收、取消现有作业并等待真实退役 ACK、释放 source/official/root 和订阅。失败保留 blocked 状态、结构化错误及原回执；不得报告已退休。
- `getStatus()` / `isManagedSession()`：内容无关状态与持久会话分类；不返回 raw agent、worker、source body、凭据、内部 job/signal。

## 作业所有权与并发

1. Host 从实际 default selection 读取 provider/model，并经真实 resolveModelInfo 核对返回身份；元数据查询后重读选择与角色，变化则在来源/模型请求前拒绝。
2. 对受信 trigger 使用严格 projector；缺 msgKey/sourceRoot 等 selector 直接拒绝，不使用 title/text 补齐。不同目标分组按原 ID 稳定派生，不互相借用 scope。
3. 私有 pending 表按子 requestId 登记冻结 scope；实际 agent 调用 source.preparePrompt 时，才把其真实 frozen job 和 signal 绑定到条目。getScope(job) 必须核对原 job；transport.send 由实际 controller.signal 的 WeakMap 找回 job，不接受 worker 自报 scope/job。
4. 每个 job 有独立 official transport，内部账号快照与关闭/撤销前 fetch 检查复用已验实现；source runtime 的 hydrate/revalidate/getIdentity 路由到该 job transport。保留一个持久 managed-session registry 和 agent runtime，避免每 job 独立 owner 锁和重启后丢旧 ID 拒绝。
5. private native root 按当前角色核心 persona.md 建立；不读 daily/tone/scenes、旧上下文或平台历史。角色切换/关闭时先撤销原作业，再清理并允许新角色初始化，不能让晚完成初始化重新挂入旧 root。
6. Source release 只有在实际 agent/队列/SessionStore 退役确认后发生；累计计数可留，活跃 job/source/handle/tool 必须归零。失败的释放不解除 blocked，重试必须显式。

## 紧邻缺口与验收顺序

- 已发现 Bili agent runtime 保存 guardOff/hookOff，但 close 未显式调用。先用父端定向反例验证 owner 订阅是否残留，再另给明确工单；当前 read-enum 子代理不顺手扩范围。
- Host 接线先做 V1 不初始化、无效 route/selector、异步角色/模型切换、账号切换、并发 scope、释放与旧 ID 拒绝的 ordinary RED/GREEN。
- 正面 native 必须经生产 Host 构造器、实际 loader/root/AgentLoop/Memory Worker/预算；仅 fake HTTP 与 fake provider，外网/真实发送为零。旧独立来源 2/2/30 不可替代新生产组合验收。
- feed/debrief 原件扩展独立明确 wire、coverage 与账号/对象判据，再接现有 typed read；文字元数据明确 text-only，影音未处理不能 full。today 不增加替代实现。
- index 传入 channelMemory('bili') 与组合；角色、配置、路由及卸载生命周期均等待 retire。失败进入现有用户页面并给 code/error/hint，日志不足以通过。
- 冻结后统一 audit/regressions/插件/native；准确提交预览、合并 dev、保全清树和 desktop 安装按原授权执行。V1 默认，生产迁移/正式切换另做具体预览确认；不付费/真实外发/推送/改版本/发布。


## 22:39 原生工厂接口事实与局部验证

真实 SDK 的 default-model 插件接收字符串配置，Cordis 按 Schema 建立 volatile 引用；夹具不替换该服务或 Memory runtime/Worker。真实 Source runtime 保留 job 的完整冻结副本：Host 私有来源桥接校验所有字段的规范摘要后，必须换回 pending 中真实原 job 再走官方 transport；公开入口、modelRequest 和 signal 发送继续要求原对象/原 signal，不接受 caller 自报 job。

当前 actual Host factory 1 call/15 tokens、作业/来源清退 0 已通过，Node24 ordinary 8 场景仍 GREEN。测试库预置 V2，生产 activation 未证明；关闭订阅修复待 HY4-BILI-CLOSE，不能提前接受整体。证据见 `factory-native-verification.json` 和当前 Host composition case。


## 23:11 公开来源集合决定与接缝

- 已定：用户工具问答明确选择确切来源集合单独审批；角色、epoch、官方账号、精确模型路由、精确video/comment selectors、公开动态输出目标共同绑定。新增来源重批，私信始终隔离。
- 假设：只采用现有多 audience + processing grant 机制；不改 Core 的精确 conversation/manifest/ingest 检查，不加 public wildcard。
- 排除：同账号所有公开来源持续共享，因为用户已选择精确集合；把所有原件直接改写成同一普通动态conversation也不采用，保留每个物理对象出处。
- 完成标准：精确集合预览/审批；未批与变更集合在模型前拒绝；实际Worker/native成功输入与来源清退；DM/外集合/其他角色账号路由反例；可见提示与同场景UI证据。

采用集合专用的内部 conversation 命名空间，避免新集合与旧单对象policy或已批准旧集合产生resolveAudience歧义。不是平台原始会话id，也不是来源真实性证明：原件sourceKey、target、wire的官方IDs及作者保留，审批界面明确展示确切对象IDs。每个来源对象、动态输出分别拥有集合专用key，通过同一条显式批准的多audience policy共享；集合变化时id和全部内部keys改变，无法复用旧审批。不接受caller任意conversation字符串，Runtime只认可当前Host私有已验证集合导出的keys。旧通知/私信路径保持原key。

冻结纯DTO辅助接口：`deriveBiliV2PublicSourceSet({ characterId, characterEpoch, accountMid, providerRouteId, selectors, outputTarget } = {})`。selectors仅完整精确video `{kind,bvid,aid,authorMid}` 或comment `{kind,rpid,type,oid,root,parent,authorMid}`，1..31项去重排序；outputTarget仅 `{audience:'public',kind:'dynamic'}`。这些输入须来自Host官方读取，纯helper不声称verified/原文/provenance。对role/account/route/完整canonical selectors/outputTarget计算SHA256；返回冻结 `{ok:true,id,label,selectors,outputTarget,outputConversationKey,sourceConversations}`；sourceConversations每项 `{selector,conversationKey}`，每个selector key独立、确定性、绑定整集合digest。输出key `bili:<mid>:public-set:<64hex>:dynamic`，来源key `bili:<mid>:public-set:<64hex>:source:<64hex selector digest>`。源+输出最多32 audience，无通配符/DM。错误固定ok/code/error/hint，非法输入不抛或返回半集合。

Host保留每集合官方验证快照和精确成员allowlist，不能让CLI摘要/模型claim直接登记集合。Runtime将已验证集合显示成可审批候选，审批policy的audiences精确列全部source keys+output key。Source逐原件target捕获各自的集合key，hydratation不混改物理target/sourceKey；prompt handle在output key，Core仍实际检查多audience授权。此后补feed/debrief候选发现、preflight与可见审批流程，不将纯helper交付等同生产完成。

### 2026-11-10 集合读取与官方 transport 接口冻结（实施中）

- Host 在 native 作业之前从固定 feed 候选获取精确 BV；debrief 必须给出明确 BV。候选中的标题、UP 名、摘要和派生分数均不作原件，也不进入模型。只读官方 view 重新取得 BV/aid/作者，派生角色/epoch/账号/精确模型绑定的集合并登记审批候选。此阶段不生成 native job、Memory source/handle/manifest，也不表示已授权模型处理。
- 官方 factory 新增私有 Host 读取接口 `inspectVideos({ locators, signal })`：locators 仅 video 的 bvid 或 aid，原始数量1..31，固定 view GET；同一 operation 新鲜 NAV、凭据与账户稳定检查保留。返回 `{ok:true, accountMid, selectors}`，selectors 为官方核验的完整 video 集合成员 DTO，不带正文/凭据/来源权威声明。真实媒体、封面、ASR 与清洗后的 CLI 文本不作为 V2 原件。
- `getScope(job)` 可多一个 `publicSourceSet`，必须是当前 Host 私有持有的纯派生结果；仍需 public/dynamic 输出 target。官方 factory 用实际 NAV accountMid 和真实 job.characterId/characterEpoch/providerRouteId 重派生并逐项核对，不信任调用方会话字符串。旧 notification/comment/DM 继续原 physical scope。
- 来源身份请求新增可选 `sourceSelector`：Source 完成 record/wire 核对之后，在 ingest 阶段从真实对象构造完整 video/comment selector。官方 factory 必须精确匹配获批集合成员，选择其 source conversation；同oid的不同rpid不得共用一个成员alias。prompt/live/send 无此字段，使用集合 output conversation；send 仍只能 public dynamic，不因能读集合成员而开放评论写入。
- 集合内 feed typed read 只读此集合；debrief typed read 只接受此集合中的确切 BV。`read({job,action,args,signal})` 只返回受限 locator stdout；Source 再走官方 hydrate 和真实 Memory 摄取。Host 必须给 Bagg 注入此 read 路径，在 fork CLI 之前截获两种 V2 读取，避免 debrief 的媒体/ASR旁路；不回落到原 worker。未包含的新来源返回结构化需重新审批提示。
- `hydrate` 与 `revalidate` 的 video 为 text-only，完整 selected wire 来自已验 view helper；comment 仍为完整原文。每个来源 event/operation/source/segment ID 含其真实已验证 conversation，保持物理 sourceKey/revision/wire 不变，防止不同获批集合的同对象重读撞ID。
- Host 登记候选后先经实际 Memory adapter 对集合输出 capture/立即release，确认当前集合 policy 可用，再初始化 native Root。缺授权时在当前界面报告并指向身份与权限页；重试需重新核对对象与身份，新增来源派生全新集合并重批。正式生产 V2 激活、迁移或平台发送仍未授权。


## 定时触发的可信边界（2026-11-11，实现接缝）

- 既有 scheduler 的 night-skip/night-wake/live-notification/attack-review/ta-nudge/daily-nudge 是 Host 收到的调度事件。Host 在接纳时复制有界 JSON 并记录 receivedAt；Source record 固定 telemetry、observed-receiver、当前官方账号为接收者，不声称获得第三方完整原件。原事件参数作为 wire，角色/路由/账号及 Source handle 闸门保持。
- daily-nudge 先走固定 feed 候选与官方元数据的确切集合预检；未审批时不建立 Native Agent。其本地调度观察使用该集合的 output alias，官方成员仍各用独立 alias。其它上述事件仅使用原 public dynamic 输出会话，不能借此读取额外第三方来源。
- Source wrapper 仅对私有 entry 绑定的首次 trigger 追加本地观察；tool 结果仍走官方适配。revalidate 对完整原观察 proof 做精确比较，并重新确认官方账号；其它 proofs 继续交官方适配重查。清理随原 job 释放，不新增跨作业或跨角色全局观察库。
- index 的固定候选回调执行 feed --json --no-remember，仅取 BV；候选摘要不入 Native 输入。生产默认仍 V1，执行夹具不得访问真实网络、provider 或账号。
