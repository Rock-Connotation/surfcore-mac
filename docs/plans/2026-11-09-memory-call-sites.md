# Memory V2 P0：四渠道调用链与撤销接缝

状态：ready（只读研究完成；不是 V2 上线或真实 Host 能力验收）。日期：2026-11-09。源码基线：工作树 `feat/memory-v2`，开始时 HEAD `94a4a78`；其他执行者随后可并行改源码，本报告描述本次读到的 V1 基线。唯一写入：本文件。未调用模型、启动服务、读取生产 profile、修改业务文件或提交。

目标依据：`/Users/shizihan/Downloads/SurfCore_Memory_Design_20261109.md` §§4.3、4.5、5.1、5.5、5.9、7.5；其中可信 ctx 字段见该文件:188-206，异步服务/同步 builder 边界:245-260，四渠道来源:335-352，逐次推理/阶段校验:468-520，撤销与保留副本:570-588，模块迁移:789-806。任务中起始指针已核对；实际文件名为 `plugins/surfcore/lib/bili-round-controller.js`、`plugins/surfcore/lib/bili-round.js`、`plugins/surfcore/lib/companion-sharing-controller.mjs`、`plugins/surfcore/lib/bili-perception.js`。

## 1. 结论与必须冻结的接口决定

四条链路均有角色隔离基础，但尚不存在把所有实际模型输入绑定到授权与删除版本的统一上下文。`src/core/context.js:89` 只同步构建角色字符串；`src/core/experience.js:165` 负责 JSONL；Host `plugins/surfcore/lib/memory-card.js:352` 负责热卡维护。QQ 还拼接独立 Bili brief/recall 与 recent/history；Bili selection/review 共用一份字符串；Douyin 一轮共用上下文；本地分享直接重放 opening/history。只替换热卡读取不能完成撤销。

基线 native 全文搜索 `src/`、`plugins/surfcore/lib/`、`scripts/`、`tests/` 未找到生产 `inputManifest`、`capturedEpoch`、`policyRevision`、`bindingRevision`、`deletionRevision` 传播；这是一项明确缺口，不表示未来执行者已加入的文件仍无这些字段。

本报告建议由集成任务冻结以下四项，然后再分发独立渠道适配：

1. **可信 ctx 只能在 Host 受信闭包构建。** channel、具体 conversation、登录账号、requester、policy、route/grant 不能来自模型或任意 RPC body。Bridge 提供原始身份事实，Host 验证并构建能力 ctx；RPC 返回序列化 prepared/验证结果，不返回可伪造的管理能力。现有相同模式是 perception discovery/token，而非设置页 cookie API。
2. **每个推理前 prepare，沿用同一快照校验。** selection 与 review、Douyin 各候选、sharing 每次 reply 都是独立模型调用；不能继续仅在 round 开始 prepare。发模型前、结果落盘前、外部发送前校验，manifest 包含实际 recent/history/opening/life/purpose/brief/raw 输入，而非模型自己挑的 evidenceRefs。
3. **撤销必须有可等待的 channel barrier。** Host policy/delete revision 先提交，再阻止旧 ctx、清退相关 session/queue/cache/opening/history。现有 QQ reset 的 `ok:true` 不证明 cancel/archive 成功；现有 scheduler retire 仅 cancel。不能拿它们当完整删除完成回执。
4. **V1 fallback 与迁移开关要显式。** 保持 `buildCharacterContext(request)` 同步；V2 分支只消费已准备/验证包，禁止无包时重新混入 V1 card/brief/recall。SHADOW/fixture 成功不自动启用 V2；现有工具/HTTP/角色恢复仍是外部契约。

父协调者新增契约 `docs/plans/2026-11-09-memory-v2-contract.md:16-34`、`:46-60` 已读：以上边界与其一致。**需要集成补齐的接口，不是 kernel 七文件内能独立完成的事**：`validateContext` 失败后的可等待 session retirement 接口；channel 完整 manifest 的来源标记与 `service.host.bindInputManifest` 调用；bridge→Host authenticated transport；对 legacy source mutation/restore 的 route 与 deletion overlay；Bili 工具外部发送 gate。建议 kernel 保持纯服务，集成统一拥有这些接缝。

## 2. 共享底座：签名、数据所有权和现有过滤

| 组件 / 真实签名 | 行为与约束 |
| --- | --- |
| `buildCharacterContext(request = {})`，`src/core/context.js:89` | :90 同步读当前角色；:91-102 校验显式角色/epoch 与当前值（允许 `allowStale` 例外）；:104 捕获 paths；:106-108 使用 caller 提供的 audience/channel。默认总预算 6000、memory 1800，见 `src/core/context.js:13`、`:47-68`。无 authenticated policy resolver。 |
| `validateExperienceEvent(raw, { characterId = '', characterEpoch = null } = {})`，`src/core/experience.js:95` | schema1、稳定 eventId、角色、epoch 格式、occurredAt/observedAt；source accountId/objectId/conversationId 见 `src/core/experience.js:38-46`。summary/details 各最多 1200，见 `src/core/experience.js:123`、`:137`。 |
| `appendExperienceEvent(paths, raw)`，`src/core/experience.js:165` | 按 paths.id 校验并 append+fsync，单次 `fs.writeSync(fd, line, null, 'utf8');` 在 `src/core/experience.js:175` 忽略返回字节数。不自行比对当前角色/epoch；调用者负责。 |
| `readExperienceInbox(paths, { offset = 0 } = {})`，`src/core/experience.js:186` | 整文件读、字节 cursor、只处理完整换行；坏记录停批停 cursor，见 `src/core/experience.js:190-212`。 |
| `runMemoryCardMaintenance({ forceDecay = false, config = memoryCardConfig(), now = Date.now(), signal, expectedCharacter = null } = {})`，`plugins/surfcore/lib/memory-card.js:352` | 模块 promise 队列串行；角色/取消检查；Bili aggregate→experience/inbox→archive staged journal→热卡输出，见 `plugins/surfcore/lib/memory-card.js:398-451`。`memoryCardIdle()` 在 `plugins/surfcore/lib/memory-card.js:70` 供切换排空。 |
| `maintainMemoryCard({...})`，`src/memory-card.js:2316` | experience→Bili→inbox 在 `src/memory-card.js:2338-2342`，之后才 archive 在 `src/memory-card.js:2346`，最后 outputs 在 `src/memory-card.js:2385`。 |
| `recallFullMemory(paths, query, { limit = 30, maxScanBytes = 200 * 1024 * 1024 } = {})`，`src/memory-card.js:1184` | 行扫描 tail 最多 200MiB；仅 title/text/speaker/tags 的词匹配，见 `src/memory-card.js:1191`；没有 ctx/ACL 参数。唯一生产调用是 Host 管理快照 `plugins/surfcore/lib/memory-card.js:244`。不能直接接普通 Agent 搜索。 |
| `appendMemoryInboxEvent(paths, event = {}, { maxBytes = 1024 * 1024 } = {})`，`src/memory-card.js:2422` | 旧 QQ/pet append；text 500 字符，1MiB rotation，boolean 回执，异常返回 false，见 `src/memory-card.js:2424-2453`。无稳定消息事件 ID。 |

角色路径由 `src/character-persona.js:130` 的 `characterPaths(id)` 定义，memoryJson 在 `src/character-persona.js:150`，experienceInbox 在 `src/character-persona.js:158`；`activeMemoryPaths()` 在 `src/character-persona.js:186` 兼容旧字段。底层 card 文件族在 `src/memory-card.js:199`，包括热卡 JSON/Markdown、QQ/Bili prompt、旧 inbox、full JSONL/stats/Markdown 及旧 full JSON。

`src/core/context.js:153-169` 直接读取 card 与 render；坏读被清成空 memory，整体仍可 `ok:true`。输出的 personaRevision/memoryRevision/lifeRevision/revision 在 `src/core/context.js:195-211` 是内容摘要，不能替代持久授权/删除控制版本。life 默认包含，purpose opt-in，见 `src/core/context.js:118-119`、`:172-175`；这两类自由文本没有来源 ACL 元数据。

现有 `visibleFor()` 在 `src/memory-card.js:2007`：敏感排除；restricted 缺 allowedContexts 拒绝；显式范围走 allowedContexts；旧 Bili/shared、可选 QQ 回灌、pet 和 QQ group/private 各有兼容规则，见 `src/memory-card.js:2014-2047`。它没有 account namespace；旧 private 缺 conversationKey 可被 private 兼容分支接受，不能据此声称 V2 的同账号、具体会话权限已经具备。

## 3. 四渠道 capture → persist → context → model → send

### 3.1 QQ（Bridge 进程 + DSH retained session）

1. **Capture**：`src/bridge.js:15440` `handleIncoming` 先检查 mode/deny（`:15444-15450`），调用 `recordMemoryInboxEvent({ key: conversationKey, kind, event, plainContent, textContent, isOwner, quoteTargetIsSelf })` 在 `src/bridge.js:15529`。函数定义 `src/bridge.js:15389`，过滤 slash/media、非 owner、私聊短文本等在 `src/bridge.js:15392-15398`。选中消息写 `appendMemoryInboxEvent` 在 `src/bridge.js:15399`，包含 sender/group/conversation，但无稳定 messageId、sourceAccountKey，且忽略 boolean 失败。
2. **Persist / projection**：Bridge 唯一旧 QQ inbox writer；Host `plugins/surfcore/lib/memory-card.js:96-106` 读取 `.1` 与当前文件，尾取 4000 行，再由 `src/memory-card.js:1452` `ingestInboxLines` 投影。去重 key 在 `src/memory-card.js:1467` 仅 date/sender/text，不包含 conversation。不能把它当可靠 source ledger。
3. **Context**：`memoryCardPromptBlock(key = '')` 定义 `src/bridge.js:13262`，共享 builder 调用 `src/bridge.js:13267`，失败返回空 `src/bridge.js:13270`；legacy fallback 在 `src/bridge.js:13287-13293`。`roleHintForMode(mode, key = '', personaMode = 'full', opts = {})` 在 `src/bridge.js:13310`，persona builder 在 `src/bridge.js:13320`，随后独立加入 Bili brief `src/bridge.js:13328` 和 memory `src/bridge.js:13333`。purpose `src/bridge.js:12173-12180`、wake `src/bridge.js:14487-14499`、三处普通 prompt `src/bridge.js:15865-15867`、`:15903-15905`、`:15940-15942` 都有独立 brief/recall/history 路径。
4. **Model boundary**：`deliverPromptNow` 在 `src/bridge.js:12790`，DSH down 时原 prompt 入 pending `src/bridge.js:12807`；await session `src/bridge.js:12813`、media `src/bridge.js:12881`；只按 session policy 检查 `src/bridge.js:12885`，随后 `api.sessions.prompt` 在 `src/bridge.js:12889`。这就是 bridge 侧 pre-model gate 接口位置；DSH 已保存的历史不由 builder 控制。
5. **Send / self capture**：`captureSendGuard(key)` 定义 `src/bridge.js:10300`，关闭当前 session/policy；v2 queued onebot 发前检查 `src/bridge.js:10267`，成功后 self memory `src/bridge.js:10286`。`auditAndSend` 在 `src/bridge.js:10318`，redact→send `src/bridge.js:10328`→self capture `src/bridge.js:10329`。`recordSelfMemoryEvent(key, text)` 定义 `src/bridge.js:15417`，写 inbox 在 `src/bridge.js:15423`，同样无持久 source receipt。

**所有独立 retained 输入**：`recentChat` Map 在 `src/bridge.js:13344`；`recordRecentChat` 在 `src/bridge.js:13347`（150 行、单条400字符），`buildRecentChatBlock` 在 `src/bridge.js:13356-13365`。native 搜索没有 clear/delete。history catchup `src/bridge.js:15072` 按水位/年龄/ID/deny 筛选，把 self 加 recent、incoming 加 recent+unread，见 `src/bridge.js:15114-15123`；它绕过 handleIncoming（`src/bridge.js:14959`）。snapshot replay `src/bridge.js:16395`→`recordSessionSnapshot` `src/bridge.js:3416` 重建 collector/model/token 视图，不能从 memory card 删除推导这些副本已清理。

### 3.2 Bili（工具 ledgers、Host aggregate、两种模型路径、外部动作）

1. **Capture / source writers**：评分 `recordScore({ bv, score, reason = '', title = '' })` 在 `plugins/surfcore/tools/lib/scores.mjs:57`；写 temp/fsync/backup/rename/readback 在 `plugins/surfcore/tools/lib/scores.mjs:31-52`，同日同 BV 高分可更新 reason/title `plugins/surfcore/tools/lib/scores.mjs:64-66`，保留14天 `plugins/surfcore/tools/lib/scores.mjs:70`。收藏网络动作在 `plugins/surfcore/tools/commands/fav.mjs:147`，日志写164，save41 直接 overwrite。quota log record 在 `plugins/surfcore/tools/commands/quota.mjs:176-193`，save39 直接 write。diary 工具写 whale-log 在 `plugins/surfcore/tools/commands/diary.mjs:39`、读 whale-diary 在64；未找到唯一 narrative diary writer，scheduler 提示模型经工具读写，故不能声称该 Markdown 受单写者保障。
2. **Persist / aggregate**：`createBiliMemory({ stateDir, home = os.homedir(), biliDir = null, characterId = null, configFile = null, allowNetwork = true, log = () => {} })` 在 `src/bili-memory.js:159`；collect271→cards378→index606（entries260上限609）→refresh654；doc/brief/index 分别写 `src/bili-memory.js:680-682`。独立实例：Bridge `src/bridge.js:1932`、Host `plugins/surfcore/lib/memory-card.js:303`、CLI `scripts/bili-memory-sync.mjs:14`。不要把 Bili 聚合物等同单一 Host writer。
3. **Experience**：Host `aggregateBiliExperiences(role, now, requestFailure = () => null)` 在 `plugins/surfcore/lib/memory-card.js:300`，读取 scores/favorites/quota/whale-diary 指纹305-310，备份314-320、refresh321 后 recheck322；index325→stable `bili:${sha256(entry.id)}`335→public/bili/self observed event337-343。seen IDs 在330，新 reason 保持同 entry.id 时不会重新投影。另一条**原始观察**链：`createBiliPerceptionService({...})` 在 `plugins/surfcore/lib/bili-perception.js:21`，watch-history append40，projectExperience43 以 `bili-observation:${job.jobId}`50 创建 restricted/bili/external observed，onExperience54；Host `plugins/surfcore/lib/index.js:697-706` 检查角色后 append/maintenance/再检查。观察与角色评价不是同一种事实。
4. **Context/model，直接 round**：`createBiliRoundController({...})` 在 `plugins/surfcore/lib/bili-round-controller.js:6`，transition/current gate10/24-31，owner epoch54-58；给 `createBiliRoundService({... limits = {} })`（`plugins/surfcore/lib/bili-round.js:66`）传 builder。round 在176建 context；selection178、review203 共用；partial230 才重新建。`modelCall(job, signal, system, user)` 在 `plugins/surfcore/lib/bili-round.js:122`，额度 gate126、`llm.stream`138、每 chunk角色142、最终角色165；没有 policy/deletion/manifest gate。评分208→readback210→maintain214；draft205/237 是派生保留副本。
5. **Context/model，legacy scheduler**：`memoryCardBlockForBili` 在 `plugins/surfcore/lib/scheduler.js:176-180`，`identityContextLines`184 混 persona/self/admin/alignment/QQ memory/card；`biliContextForRound(request)`196 先验证 pinned shared builder197，却丢弃其 text 再读 identityContextLines199。`promptBili(args, signal, where = '叫醒')`519→quota检查（异常531继续）→`ctx.sessionController.prompt`534；`ensureSession`666 inspect672/create695。这是另一个 retained DSH session，不应只适配直接 llm.stream。
6. **Send**：`createBiliShareScheduler({...})` 在 `src/bili-share-scheduler.js:96`；fire165 选 memory card→sendCard201→deliverPrompt210；至少某成功后 recordShare221、markSlot222。卡片直接发送与文本 prompt 都要 gate。Bili runtime 外部效果也在 `plugins/surfcore/tools/commands/comment.mjs:445`、`plugins/surfcore/tools/commands/dynamic.mjs:166-172`、`plugins/surfcore/tools/commands/dm.mjs:92-111`。工具 role helper `assertExpectedCharacter()` 在 `plugins/surfcore/tools/lib/state-paths.mjs:53`，缺 expected env 直接返回 null56；不能视作强制 ctx 校验。account Bili 存储仍共享，见同文件65/74。

**额外 readers**：`plugins/surfcore/tools/lib/watch-history.mjs:339`、`plugins/surfcore/tools/lib/watch-actions.mjs:129-130` 也读 scores/quota/favorites；`briefBlock()` 在 `src/bili-memory.js:713` 与 `recallBlock()`741 在 QQ 多处消费。`recordShare()`829 唯一生产 caller 是 `src/bili-share-scheduler.js:221`。

### 3.3 Douyin companion（来源记录与模型产物分阶段）

Host wiring `plugins/surfcore/lib/index.js:647-670`：model adapter→memory adapter→sharing→companion engine。

- **Role/capture**：`currentRole()` 在 `plugins/surfcore/lib/douyin-companion.mjs:66` 校验 role+epoch 成对；`requireCurrentRole()`78 强制存在。`guarded(job, context, operation, timeoutMs = operationTimeout, timeoutProblem = null)`164 在 await 前165、后172校验。该 guard 保护 role/取消，不含 account/policy/delete revisions。
- **Context/model**：一轮在 `plugins/surfcore/lib/douyin-companion.mjs:497` buildContext，504给每 candidate复用；processOne334、shared context scrub12k388、trusted persona4k390、modelCall397-398。调用不传 beforeSend，尽管 model adapter支持该 hook；外层 guard 不能证明 adapter内部 await到stream之间政策未变。
- **Adapter**：`createCompanionModel({ ctx, tokenBudget, route = COMPANION_ROUTE } = {})` 在 `plugins/surfcore/lib/douyin-companion-model.mjs:17`；`request({ system, prompt, images = null, signal, beforeSend = null, maxTokens = 8192, timeoutMs = 180000 })`32 的同步 guard44/49/51/61、stream68、迭代75/78、拒工具84、要求usage86、durable记账96-97。公开 `call({ images, beforeSend: _ignored, ...options } = {})`101 丢弃 hook；`reply`105-108保留 hook。需接缝修复不能只修改 engine参数。
- **Persist**：模型 parse405→job save411→role guard425→recordMemory426；只有成功才 memorySaved435→recordSharing442。`createCompanionMemory({ getCharacter, maintainMemory })` 在 `plugins/surfcore/lib/douyin-companion-memory.mjs:5`；`buildContext`8-11同步 shared builder且禁life/purpose（无ACL）；`recordMemory`14 guard17，稳定 `douyin:activity:${id}`36，restricted allowed douyin/local38、self/reported40，append35→maintenance45→guard47→ok49。reason240+coverage350 在34已经压缩，不是无损source。maintenance未返回结果时只显式 false才失败48。
- **Send**：本链模型输出保存为 companion job/记忆/opening，用户可见出口由 sharing controller和其reply链负责；本次未发现此 engine直接发 Douyin评论。不要虚构一个不存在的远端send接口。

### 3.4 本地分享（HTTP请求/回复日志不是 card 来源）

`createCompanionSharing({ stateDir, getCharacter, buildContext, modelReply, readiness, now = () => new Date(), timeoutMs = 180000 })` 在 `plugins/surfcore/lib/companion-sharing.mjs:17`。当前角色21、guard26；events30 按角色epoch过滤。只有 source memorySaved 的 companion job39才 record opening43-49。status55返回last8 opening58、last24 request/answer59，revision只是rows.length68。

`reply`115建requestId119、display text≤1000在120、idempotency105-113、paid lock127→perform144→readiness151→buildContext153。实际 prompt 在162-163拼**shared context + raw opening + recent last10 request/answer + 当前输入**（history选155）。guard164→append request168→reserve170→modelReply172（beforeSend hook173）→postmodel guard173→answer≤600175→append176。failure183仍检查当前角色；withTransition213 abort并await，dispose218。

`createSharingStore(stateDir)` 在 `plugins/surfcore/lib/companion-sharing-store.mjs:33`；role路径 douyin/sharing.jsonl49，symlink检查38-60、无换行拒63；`append(id, event, checkBeforeWrite = () => {})`68锁73、仅按record.id去重80、O_APPEND85、2MiB cap88、check89、write循环91、fsync92/96。zero-byte write没有进度拒绝。opening/request/answer/failure/ack事件结构见8-27；request/answer没有导入 experience/card的生产调用。必须由新的selected-source事务专门接入，不能推断opening已memorySaved就表示整段sharing对话已存储。

`createSharingController({ service, getCharacter })` 在 `plugins/surfcore/lib/companion-sharing-controller.mjs:5`，capture6→sameOrigin12→body8KiB34→body/current role检查36→reply38/ack39/cancel40→fresh检查42/44→JSON45。这里的HTTP发送gate要携带prepared/revision；当前只有role/epoch。

## 4. 唯一 writers / readers 清单与旁路范围

| 持久物 | 基线 writer | readers / 需要兼容的外部契约 |
| --- | --- | --- |
| 旧 memory inbox | QQ两函数 `src/bridge.js:15399`、`:15423`；另有pet `plugins/surfcore/lib/pet-chat.js:332` | Host `plugins/surfcore/lib/memory-card.js:96`；core `src/memory-card.js:1452` |
| experience JSONL | Host Bili aggregation `plugins/surfcore/lib/memory-card.js:343`；Host perception callback `plugins/surfcore/lib/index.js:702`；Douyin adapter `plugins/surfcore/lib/douyin-companion-memory.mjs:35` | core cursor `src/core/experience.js:186`→Host maintenance `plugins/surfcore/lib/memory-card.js:401` |
| 热卡/派生prompts/full | 正常维护 `src/memory-card.js:2385`；Host compact/action/restore `plugins/surfcore/lib/memory-card.js:484`、`:558-559`、`:579`；底层archive `src/memory-card.js:937` | shared context；Host prompt cache `plugins/surfcore/lib/memory-card.js:587-594`；bridgelegacy prompt；管理snapshot/recall |
| Bili doc/brief/index | `src/bili-memory.js:654-682`，Bridge/Host/CLI各自实例 | QQ brief/recall、scheduler、share scheduler、Host aggregate；不是统一service writer |
| Bili sources | scores/fav/quota/diary工具（上一节） | aggregate、watch helpers、模型工具读取、角色snapshot/restore |
| sharing.jsonl | sharing store `plugins/surfcore/lib/companion-sharing-store.mjs:68` | sharing status/history/model prompt；controller JSON response |
| life/purpose、角色snapshot | 角色管理 `src/character-persona.js:530`、`:629`；非本次四链统一所有者 | shared builder的自由文本；restore可复活已删来源；需要Host集成task接入 |
| DSH session/queued prompt/compact/history | DSH Host外部系统，bridge/client及scheduler发RPC | QQ follow events、model prompt、scheduler retained session；仓库无法证明内部持久副本可精确purge |

`buildCharacterContext`全部生产callers已搜：`src/bridge.js:13267`、`:13320`；`plugins/surfcore/lib/scheduler.js:108`、`:179`、`:197`；`plugins/surfcore/lib/douyin-companion-memory.mjs:11`；`plugins/surfcore/lib/pet-chat.js:279`、`:292`。**pet 不在四渠道实现范围，但同步builder签名/默认行为是必须保持或明确迁移的外部契约**，不能漏掉测试。

## 5. 认证 Host RPC 和 trusted context 的可复用模式

设置页路由前缀 `plugins/surfcore/lib/index.js:133` `/dsh-surfcore/api`；wrapper `plugins/surfcore/lib/index.js:841-868` 强制loopback846、write sameOrigin/content-type847-849、DSH `connection.requestRejection(req)`854-860。该认证依赖Host会话Cookie；bridge没有此Cookie，不宜绕过或借它开放任意body权限。

现有Host→Bridge client `callBridge(pathname, { method = 'GET', body, timeoutMs = 4000 } = {})` 在 `plugins/surfcore/lib/bridge.js:61`，fetch72发送 `x-console-token`76；另一 client `src/mcp-snowluma-safe.js:187` 使用console token。这是反方向认证，不等于bridge已经能调用Host memory。

可复用**反向服务**模式：`createPerceptionApiService({ service, stateDir, currentDshUrl, getCharacter, getConfig = () => ({}), getChannels = async () => [], observeBili, resumeBili, configure })` 在 `plugins/surfcore/lib/perception-api.js:18`，runtime随机secret21、discovery host.json31 atomic rename32 +0600在33，限制localhost29。`handle(req, res, url, { trusted = false } = {})`100检查loopback+timing safe `x-perception-token`102与sameOrigin105，JSON256KiB113，结构化code/error/hint7/119。Host在performDispatch38捕获当前角色，local submit重写provenance/ACL65-68，body不能升级private为public。client `readDiscovery()` 在 `plugins/surfcore/tools/lib/perception-client.mjs:24` 校验loopback/api/token32；`createPerceptionClient`116每次request重新读discovery122、header133、AbortController。

建议新 memory transport采用独立scoped discovery secret和同类loopback/sameOrigin/体积限制、结构化失败、每次重读discovery；不要复用perception secret扩大现有权限。Host闭包从已认证bridge身份+受信配置/current role+policy+account binding映射构建ctx。普通Agent查询和管理action分路由；缺account/policy/route/grant时失败，不能以channel='local'授管理权。公开captureContext/admin purpose不可由任意RPC直接提供。内存WeakMap能力或worker HMAC部分属于父契约kernel，transport不用自行实现第二套授权算法。

## 6. 撤销、session退休、compact/history与恢复

### 6.1 当前QQ屏障能做什么

`sessionPolicy(key)`，`src/bridge.js:3657`，只有 currentMode/modePreset/ownerQQ；`isCurrentSession(key, sessionId)` 在 `src/bridge.js:3661` 校验mode/mapping/policy。`ensureSession(key)` 在 `src/bridge.js:10484` 捕获sessionEpoch10485和policy10486，await model10494后检查10502，create workspace/preset10530-10536，follow10552，再检查10554并写映射10559，再检查10564。这是扩展revision屏障的现有风格。

`retireSession(key)`，`src/bridge.js:3701`：删session/policy3703-3704、清部分cache3707、reverse/collector/model/tool3709-3720、forget follow3723、pending/timers3724-3730、rotate agentToken3734、bootstrap/modelSeen3736-3737；save后异步stop3741。`forgetConversationCaches` 在 `src/bridge.js:3690` 仅rate/wait/hint，不清recentChat；social recent/unread也不在此普通退休中清除。

`stopRetiredSessionWork(sessionId, key = '')` 在 `src/bridge.js:3672` **fire-and-forget** stop3674→archive3676。底层 `async stopSessionWork(sessionId, { signal, timeoutMs = 8000 } = {})` 在 `src/dsh-client.js:483`：先readQueue493、每项 `session/updateQueue` remove495，再 `session/cancel`506，即使queue失败也cancel，最后throw失败511。`src/dsh-client.js:481`明确archive只是hide，不停止工作。可复用其queue→cancel顺序，但删除完成需要await和可见错误。

API reset `src/bridge.js:9137` 增epoch9141、删mapping/queue/social9165-9170、rotate token9181、删v2conversation9182；stop failure只log9188，archive失败吞掉9189，始终ok9191。聊天 `/reset` `src/bridge.js:15595-15644` 有同类流程。global v2 reset `src/bridge.js:6242-6269` 也异步stop。三类均未清recentChat。一个新memory action不能直接调用现有reset后就回“已彻底忘记”。

### 6.2 Host角色切换屏障与其他渠道

`switchCharacterEverywhere` 在 `plugins/surfcore/lib/index.js:567`：sharing→companion→douyin→Bili nested transition570，排memoryCardIdle577，legacy scheduler.retire582，stopBridge536-542、停进程588、snapshot596→switch597→maintenance601→restart603。`archiveBridgeRuntimeState`549 rename sessions.json/social-v2.json552-559。这说明跨进程清退已有组合先例，政策撤销应提供同样可等待但按影响域执行的接口。

legacy scheduler `retire()` 在 `plugins/surfcore/lib/scheduler.js:1330-1332`只stop timers+cancel，没有queue清理/archive。sharing transition会abort+await但未移除旧history/opening；Douyin和Bili job/draft仍是派生copy。权限修改未改变characterEpoch时，现有role-only检查继续通过。

### 6.3 compact/历史与restore的明确未处理契约

本次对repository生产源码搜索 `compactSession`、`session/compact`、sessions.compact未发现DSH compact lifecycle接入；`qq-model-view`里的compact只是展示投影，不能作为Host摘要来源清单。runtime提供的 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/` 不能作为native目录读取（Path不存在/不是目录）；未解包安装物，未探测服务。故**真实Host保存的compact/history如何按source删除、旧session恢复后如何避免再次重放**仍是外部契约，不能猜测已清除。安全实现可先退休整段session并禁止旧id重用，但还需验证Host重启后不会复活旧summary/prompt。

本地恢复路径也要套当前删除控制：`restoreMemoryCardBackup(...)` 在 `plugins/surfcore/lib/memory-card.js:567` copy旧JSON576/render579，无tombstone overlay；`restoreSnapshot(id, slot, { now = Date.now() } = {})` 在 `src/character-persona.js:629`，备份635，恢复card/prompts/inbox646-647，保留较新experience供replay649-650，life651、Bili654。当前 `applyMemoryCardAction(action, payload = {}, { config = memoryCardConfig(), now = Date.now() } = {})` 在 `plugins/surfcore/lib/memory-card.js:492` 先archive496，forget仅删working记录509，再写outputs558/full559。原始/全量/备份可恢复：需要根+派生闭包抑制和当前control overlay，不能只删working row。

## 7. 与设计相关的基线缺陷（只记证据，不修）

| 风险 | 机制 / 证据 | 实施归属 |
| --- | --- | --- |
| source写成功误报 | experience单次write返回值未验 `src/core/experience.js:175`；旧inbox无fsync、false被bridge忽略 `src/memory-card.js:2450-2453` / `src/bridge.js:15399` | 新spool完整写/回执；旧适配要传播失败 |
| zero-progress挂起 | sharing store `while` write at `plugins/surfcore/lib/companion-sharing-store.mjs:91` 不拒绝0 | sharing adapter/store单独修；不得悄悄放kernel之外 |
| 600 cap先丢后归档 | 默认maxRecords600 `src/memory-card.js:76`；`addMemoryRecord`每插入后evict1419-1426，maintain所有ingest2338-2342之后才archive2346 | V2先source transaction再selected/index；V1迁移需从原source补，full不保证完整 |
| 多层有损截断 | inbox500 `src/memory-card.js:2424`；event summary/details1200 `src/core/experience.js:123/137`；makeRecord text600/details500/botReply600 `src/memory-card.js:1330/1355/1375`；Bili index260 `src/bili-memory.js:609`；Host inbox last4000 `plugins/surfcore/lib/memory-card.js:106` | 不能声称无损历史已存在；V2原文64KiB分片需在投影前 |
| 不同会话去重碰撞 | inbox hash只有date/sender/text `src/memory-card.js:1467` | 稳定source account+conversation+message id |
| stable ID掩盖source修订 | Bili seen eventID + hash(entry.id) `plugins/surfcore/lib/memory-card.js:330-343`；source可更新同日BV评分 `plugins/surfcore/tools/lib/scores.mjs:64` | operationId+payloadDigest冲突/版本策略需冻结 |
| 原始raw读取绕ACL | full recall无ctx `src/memory-card.js:1184`；Bili brief/recall跨QQ路径；life/purpose free text | 所有输入统一manifest+policy；admin显式授权 |
| 删除只影响投影 | forget/restore/session/history以上路径 | control先提交、派生闭包、await channel barrier |
| “fresh role check”后重新读 | scheduler `plugins/surfcore/lib/scheduler.js:196-199` | 消费已验证prepared，不重读当前角色 |
| round复用过期输入 | Bili context176→178/203；Douyin497→504 | 每次推理prepare/recheck，旧cached字符串不复用 |
| adapter最终hook断链 | Douyin engine无beforeSend + model.call主动丢弃 hook，见 `plugins/surfcore/lib/douyin-companion.mjs:397` / `plugins/surfcore/lib/douyin-companion-model.mjs:101` | 适配器合同必须改并测试竞态 |

archive本身已有较强journal机制：`archiveDecayedToFull(paths, decayed, config = {}, now = Date.now(), { committedKeys = [], alreadyArchivedExperienceIds = [], experienceNextOffset = null, experienceIdentity = null } = {})` 在 `src/memory-card.js:937`，pendingAppend967→write+fsync970→recovery971；不能因它可靠就推断更早evict/clip消失的内容已存档。`scanFullRecords(paths, visitor, { maxScanBytes = 200 * 1024 * 1024, chunkBytes = 1024 * 1024 } = {})` 在 `src/memory-card.js:1141` tail scan，坏JSON忽略1165、I/O错误return0在1176；空召回不能等同空库。

## 8. 可实施小任务边界（依赖顺序与兼容风险）

路线比较：直接把SQLite查询塞进同步builder成本表面低，但bridge进程会直接开库、所有调用者变async、权限混入字符串且重复writer；回滚难。保留同步builder、Host worker facade先异步prepare/validate再消费prepared，适配工作较多，但保留现有同步callers和单写者边界，V1持久route可回退。推荐后者，与父契约一致。

| 工单 / 边界 | 依赖与验收接口 | 不能隐含带走的文件/责任 |
| --- | --- | --- |
| K kernel（父已派发七文件） | `memory-v2-{contract,spool,store,worker,service}.js` +2tests；receipt、ctx/manifest能力、worker single writer、control overlay | 不实现bridge/Host身份映射、真实Host compact或渠道cache退休 |
| H Host facade/RPC | `plugins/surfcore/lib/index.js` wiring +独立memory transport/client；trust current role/account/route/grant，scoped discovery token；service生命周期 | 管理cookie路由与Agent工具权限分离；不要再造SQL连接 |
| C context兼容 | `src/core/context.js` +对应shared-core tests；V2只prepared，保持sync；pet调用明确覆盖 | 不自行async DB、不能恢复brief/raw fallback |
| Q QQ integration | `src/bridge.js` +`src/dsh-client.js`（如需要await屏障）+harness；capture source identity、RPCprepare、full manifest、pre-model/pre-send、pending/history/recent retirement | 旧session summary是Host外部合同；不允许以reset always-ok冒充删除完成 |
| B Bili integration | scheduler、bili-round/controller/perception、source tools或单独tool gate；每个模型调用prepare；观察/评价区分；directshare gate | `src/bili-memory.js`/CLI多writer迁移应另有明确owner；工具comment/dynamic/DM不能漏 |
| D Douyin integration | companion engine/model/memory；逐candidate prepare，beforeSend贯通，source receipt独立于model成功 | modelReply共享模块同时服务sharing，参数变更需与S协调 |
| S sharing integration | sharing/store/controller；完整opening+history manifest，source事务、0进度write错误、revision retirement、结构化UI失败 | 局部jsonl idempotency不能替代service receipt；local不是admin |
| R revoke/restore integration | Host统一management action barrier、角色snapshot/backup恢复overlay；向Q/B/D/S发可等待退休 | 不能由另一模块直接开活跃SQLite；真实Host重启/compact需独立fixture/验收 |
| T packaging/harness verification | VM import注入、git-object包路径、隔离回归 | 新文件未commit不会出现在git-object package；不能只在worktree运行就声称发布物可用 |

H/C/K seam冻结前不宜同时让Q/B/D/S自行定义Context/Prepared或自造删除revision。`plugins/surfcore/lib/index.js`是高冲突wiring文件，统一owner集中集成，其余task只提供factory参数/回调签名。`douyin-companion-model.mjs`为D/S共享，固定一个owner；不能两个task同时改。

现有耐久写可复用先例：`syncBudgetFiles(files, directory)` 在 `plugins/surfcore/lib/token-budget-sync.mjs:4` 检查非symlink regular、fsync文件9、目录13（特定unsupported codes兼容）；budget `persist(force = false, { durable = false } = {})` 在 `plugins/surfcore/lib/token-budget.js:575`，rename586、durable sync600；`recordExternalUsage`702在durable模式返回persist722。借鉴机制即可，不把memory开发扩展为重构budget。

## 9. Harness、imports、packaging与验证记录

- `scripts/audit-bridge-harness.mjs:11-61` 逐模块import；`:181-196` 删除bridge顶层imports，`:244` 构造VM context，`:280` spread旧memoryCard/characterStore，`:286` `readCurrentCharacter: () => null`，`:291` temp activeMemoryPaths。bridge新增import必须显式注入；当前fixture不走active-role shared-context分支，新源码符号即使存在也可能VM ReferenceError。
- `scripts/test-memory-card-wiring.mjs:19-68` 是源代码regex断言，锁legacy名字/calls；`:54-55` 锁“不向prompt读full”。它不是端到端privacy/receipt测试；适配后要保留安全意图而非机械保留旧调用字符串。
- `scripts/build-plugin-package.mjs:14-16` 解析git ref/tree；`:28` include src/scripts/dsh/plugin prefix；`:29` 排test/probe与plugin scripts；`:30` git show取blob；`:41-43` 合并依赖。`../../../src` imports依靠保留layout。未commit文件不会进包。此次没跑build，也没commit。
- `scripts/test-memory-v2-runtime.mjs:1` 为隔离executable探测；`:10` evidenceRoot `_backups/memory-v2-p0`；`:222-247` mkdir/写结果；自身`:225` scope明确 `bundled-executable-only; actual Host loaded plugin is unverified`。因本brief仅允许写本report，未执行该写工作树evidence的探测。不能据此宣布真实Host SQLite通过。
- `scripts/test-dsh-session-retire.mjs:27` 默认DSH_BASE_URL/3080，调用真实NodeApiClient；没有运行，符合无服务边界。

已执行fixture（不调用真实模型/服务，临时目录隔离）：

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/test-macos-shared-core.mjs` | exit0，22 tests /22 pass /0 fail；包括privacy、epoch、duplicate/replay、journal/fsync、Windows兼容fixture |
| `node plugins/surfcore/scripts/test-douyin-companion-recall.mjs` | exit0；append→maintenance→fresh context，bounded reasons/IDs/ISO、无ACL扩大 |
| `node plugins/surfcore/scripts/test-companion-sharing-race.mjs` | exit0；cross-process one paid mock call、one durable reply |
| `node plugins/surfcore/scripts/test-token-budget-durable.mjs` | exit0；state/daily/sync失败、legacy batching、retained accrual |
| `node scripts/test-memory-card-wiring.mjs` | 初次不能load：`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from /Users/shizihan/Daily/Github/surfcore-memory-v2/src/preset-prompt.js`，Node v26.5.1。父协调者随后通知隔离 `npm ci --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund` 完成，依赖缺失已解决；本agent未重复全套。由父负责最终audit/regressions/plugin日志验收。 |

未运行模型、真实Host/QQ/Bili/Douyin探针、迁移、清退、restore、package build、生产profile访问；没有将隔离fixture通过冒充真实渠道门禁。

## 10. 给集成者的未处理外部合同 / 必须明确的gap

1. **真实Host persisted compact/history**：仓库没有source-aware purge API；需要Host能力证据或整session retirement/restart恢复防重放方案。`archive`仅hide，不能删上下文。Windows实际Host运行门槛也未由mac fixture证明。
2. **可信账号与policy route registry**：旧event的accountId字段不等于登录account namespace；Host必须定义对QQ/Bili/Douyin/local事实的信任来源、缺失隔离规则和processing grant审批，不接受模型填写。
3. **Bili outgoing tool过程**：独立comment/dynamic/DM在工具模块内发网络；单改Host model gate不能证明已撤销结果不会发送。expected角色env是可选的。
4. **pet同步caller与旧CLI**：不属于四渠道实现，但更改context/paths/source writer时必须兼容或显式停用；Bili CLI可能继续重建聚合文件。
5. **恢复与旧source修订**：角色snapshot、memory backup、experience replay、Bili source同ID新payload均要套当前control；旧full不是完整原文备份。不得用旧seen ID静默吃掉合法修订。
6. **UI失败合同**：现有局部false/空串/always-ok不能充当V2结构化失败；管理action与sharing controller必须向当前界面给code/error/hint，不能只log。UI文件未在本只读task内修改或验收。
7. **Manifest持久与退休索引**：每段actual input需要稳定source/version标记（含history/opening/life/purpose/raw），retained session需存依赖；没有来源的旧history应隔离/退休，不能拼进新prepared后声明已校验。

本报告没有改掉任何上述问题。read-only P0的完成标准是路径、机制、边界与外部合同可供实施者核查；生产启用仍须以父任务的独立验收为准。
