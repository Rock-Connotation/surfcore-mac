# Memory V2 生命周期契约（P4-LIFECYCLE）

状态：接口冻结，供 Host 接线；实现/平台验收结果另见 executor report。生产默认 V1，本文不授权切换、真实删除、模型、服务或发布。

## 决策与边界

一致备份、恢复、删除继续由唯一 Worker 串行处理，当前安装 control.sqlite 永不被恢复快照替换。采用独立 VACUUM INTO 快照和固定托管 generation 路径；另一条路线是覆盖活动目录/恢复整个安装快照，成本较低但会回退撤权、删除和账本，并在 Windows 上依赖不可用的覆盖语义，因此不采用。备份先试开只读副本、integrity/FK/hash 校验，再发布 manifest。费用快照只对账，生命周期从不写额度文件。

本阶段作用域为当前角色库、控制快照、明确列入清单的已封存 spool 片段及本功能创建的托管副本，不假装是整机备份。当前控制缺失、兼容下限未知或恢复候选未验证时阻断自动使用。旧角色库保留在隔离目录；默认不删除。隔离仍表示 retained copy pending，不表示永久删除。

## Host-only 接口

均挂在 `service.host.lifecycle`，不得进入模型 RPC/工具列表。ctx 必须是 `host.captureAdminContext` 返回的原对象。预览只读；每个变更要求 expectedRevision（控制修订）和稳定 operationId，参数摘要不变重试幂等，未知提交查询原 ID。变更 request 的 previewDigest 来自对应预览；水位/控制/范围变化须重新预览。

新备份预览中的 `minimumCompatibleKernel` 是将生成备份所需的读者下限：取当前内核要求 2 与已有下限的较大值。预览保持只读；确认备份并重新核对完整切面后，才持久提高兼容 marker，再提交备份意图。首次 HTTP 六字段请求绑定本就要求下限 2，因此该绑定不会让已确认的备份摘要自行失效；角色 commitSequence、控制修订、generation、spool 和保留范围仍全部参与摘要，任何实际切面变化仍须重新预览。旧格式下限 1 仍可由本内核读取，新备份不宣称旧内核可安全读取。

| 方法 | 参数（ctx 后） | 语义 |
| --- | --- | --- |
| previewBackup | options={} | 当前角色+控制一致切点、可选 sealedSpoolIds、7日/4周保留建议；无自动删除 |
| backup | request, expectedRevision, operationId | request={previewDigest,sealedSpoolIds?:[]}；已验证独立备份后返回 backupId/manifest |
| previewRestore | {backupId} | 当前控制覆盖、备份后源合并、正式版本冲突待审、角色/会话退休影响 |
| restore | {backupId,previewDigest}, expectedRevision, operationId | 固定托管路径创建候选，当前安全控制覆盖后等待实际退休/新 Worker，再确认完成 |
| previewDelete | {roots} | 显式根及派生闭包、活跃/保留副本和非受控范围 |
| requestDelete | {roots,previewDigest}, expectedRevision, operationId | 控制先提交 ID-only 墓碑与 deletionRevision，access_revoked；不隐含永久清理 |
| continueDelete | {deleteOperationId,purgeRetained:false}, expectedRevision, operationId | 独立安全备份成功后重建活跃干净库；purgeRetained=true 才处理托管保留副本 |
| resume | {operationId}, expectedRevision, resumeOperationId | 显式续做崩溃/退休失败后的原意图；重验当前控制和候选，不自动重新批准其他范围 |
| progress | operationId | 只读阶段/原回执/待办；含 code/error/hint，不把 pending 说成完成 |

`requestDelete` 的成功表示已持久撤权；`active_store_purged` 和 `retained_copies_purged` 仅在实际证据满足后分别出现。默认 V1/legacy 路径须由 Host 退休回调明确阻断，不能只清 memory 分区就恢复旧 session。

## 生命周期回调（constructor 可选，默认失败封闭）

`retireForLifecycle(challenge)`：只从已授权 Host 管理调用闭包调用，不接受 HTTP/model body 自报证明。challenge 包含 operationId、characterId、previousEpoch、previousStoreGeneration、controlRevision、bindingRevision、deletionRevision、nonce、reason。Host 必须取消该角色所有在途请求并退役 session/compact/opening/recent-answer 等含旧输入视图，阻断旧 legacy admission，再推进真实 native epoch。

返回 `{ok:true,nonce,characterId,epoch,sessionsRetired:true,inflightCancelled:true,legacyAdmissionBlocked:true}`。service 独立读取 getCharacter()，要求角色相同、epoch 与回调相等且大于 previousEpoch。缺回调、抛错、证明缺字段、epoch 未真实增加均保留已提交安全屏障并返回 pending+hint。证明只声明 Host 实际完成的操作；测试中的 epoch 回调不是实际 DSH session 退休验收。

候选被验证、控制覆盖最新、退休证明通过后，Worker 关闭旧句柄，隔离旧文件，在控制中发布所选 generation。服务实际关闭并重建唯一 Worker；新 Worker 必须观察不同 storeGeneration 并重新核验候选后才将操作记为完成。崩溃恢复只恢复已验证且安全屏障充分的状态；其他状态继续 blocked，需 progress/resume。

`lifecycleInventory({characterId,purpose})`：可选可信 Host 回调，返回 `{complete:false,sealedSpool:[],externalCopies:[],quotaSnapshot:null}`。缺省 complete=false，故不能宣称所有保留副本均清除。

- sealedSpool 项：`{copyId,path,producerId,segmentId,sealed:true,highWater,sha256}`。path 仅允许当前 stateDir/charactersDir 中的真实普通文件，拒绝符号链接/穿越；只有列入 sealedSpoolIds 的已封存已校验完整高水位片段才纳入备份。新段继续由生产者接纳，不声称开放段已备份。
- externalCopies 项：`{copyId,kind,state:'pending'|'purged'|'not-affected',proofId?}`。本原语不删除未知 Host/session/legacy 路径；不安全或未知项明确 pending。purged/not-affected 必须由实际管理者给证明 ID。
- quotaSnapshot：可选只含 recordedAt 和非负 usedRequests/usedTokens/usedCost/reservedRequests 的对账快照。不是一致内容事务的一部分，不用于恢复/退款。

外部路径/SSDs/平台和第三方模型已接收内容、用户自导出和系统备份不属于清除承诺。保留项隔离后仍 pending；永久清理仅针对已确认托管副本。

## 持久控制与兼容

生命周期表记录操作、阶段、所选托管 generation、最小兼容版本、根/来源 ID 墓碑及副本清单；不存被删正文或正文 hash。旧稳定 sourceKey（包括分段基础 key）、eventId/rootId 的再导入被拒绝，即便换 eventId/operationId。来源映射保持同样删除检查。

旧固定角色路径发布拒读 guard 数据库，原库隔离保留；当前兼容内核从 control 的已验证 generation 路由。旧 P1 不能继续读隔离旧角色正文，未知 lifecycle 格式拒绝。默认 V1 路由不改变；Host 在相关生命周期屏障期间必须拒绝旧读/模型/发送降级。当前控制缺失、空库、损坏或低于独立已 fsync 的 minimumControlRevision 时，候选进入隔离并拒绝初始化，不能用备份控制冒充最新凭据。控制提交后同步推进该最低水位；副本只用于检查，永不替换当前控制。

阶段至少区分 intent_committed / candidate_verified / retirement_required / sessions_retired / publish_prepared / published_await_generation / completed（以及 failed/pending/quarantined）。控制先持久、候选后处理；COMMIT 不确定退休连接，原 operationId 查询。无未验证候选自动生效。

## 有界整理读取

`service.host.readOrganizeBatch(ctx,{limit:40,maxInputTokens:6000,cursor?,domain?})`：仅 purpose=organize 的已授权原上下文，完整实际来源、引用、覆盖元数据、权限域、稳定 jobId 与 high-water cursor。每批最多40条、仅一个确切权限域，按 UTF-8 字节保守估计输入预算（不冒充 tokenizer 实测）。完整分段源不能只取一部分；超过预算则显式 deferred，不截字/伪装完整。过滤当前撤权、过期、删除、未知 ACL 后才选。该接口不调用模型、不扩展人格/成长规则；后续结果仍需绑定完整 inputManifest 并由 proposeMemory 验证。

## 验收与回退

真实 Worker：活动写入后的独立备份不变；损坏/hash/半发布拒绝；撤权/删除覆盖旧备份；保留合法恢复点后源；正式冲突进入待审；缺控制隔离；账本字节不变；ID 幂等/冲突；干净新库和索引没有删除 canary；保留副本阶段诚实；控制/候选/发布间故障和重启；无回调或假 epoch 不通过。Windows 关闭句柄/不覆盖非空目录仅做顺序模拟，不能报 Windows 实机。CLI26/bundled24 分别留证；Node22.13 使用 SQL VACUUM INTO（已在 scripts/test-memory-v2-runtime.mjs:134-151 核验方法），不依赖较新 sqlite.backup API。

实现异常保留原件/候选和控制意图，V1 不被本功能切换；涉及已撤权/删除不能启动绕过屏障的旧读取。移除本功能前先保留当前控制/墓碑及安全可读副本，不能把整个旧目录覆盖回去。


## 原生产者注册与不确定提交恢复

`host.registerProducer(originalLiveCtx,{producerId,segmentId},operationId)` 持久记录原角色/原 epoch/原会话/原 actor/请求者/批准策略/处理 grant/route 的无正文范围，不递增安全控制修订。不能由 body 改写这些字段。普通过期 WeakMap 上下文仍拒绝；注册不授予搜索、准备上下文或模型调用权限。

`host.replayProducer({registrationId,batch,operationId},authorization)` 只接收 normalize→完整短写/fsync→readSpool 得到的原始 canonical 记录，保持原 ID/时间/epoch。实际 event.actorAccountKey 必须等于原 sourceAccountKey；请求者/provider 权威只来自持久注册。可信 `authorizeProducerReplay(authorization,registration)` 可异步，只有明确 true 或 `{ok:true}` 放行，Promise 本身从不等于授权。回调应验证当前平台登录、allowlist、源主体，不能依赖当前 native 角色。Worker 为原角色加盖当前控制/删除/grant/generation，仅用于这次 ingest/receipt，绝不返回可供其他操作的 ctx。预先 materialize 最新控制，拒绝撤权、过期、墓碑与伪造范围。

`host.queryProducerReceipt({registrationId?,operationId},authorization)` 优先只查 control 的原注册操作表。命中后按实际持久范围授权并返回原注册回执；给了 registrationId 则必须匹配。没有 ID 且未命中时只允许可信回调明确批准 `{kind:'registration_receipt_lookup',operationId}` 的无内容诊断，再返回 not_found；不能跨角色扫描 ingest。控制异常继续报错，不伪造 not_found。注册确实未提交且旧 ctx 失效时，保留旧 spool，等待显式恢复，不能按新角色重注册旧数据。`authorizeManagement` 保持同步能力判定，Promise 拒绝。

事件 ingest 回执含实际存储的 `eventRefs:[{type:'event',id,revision:1,payloadDigest}]`，与事件/offset/回执同事务，重放或已有 sourceKey 复用返回同一 refs。无需用文本搜索重建来源身份。QQ 的批准群共享通配符仅允许 `['qq','qq:<login>:group:<group>','*']`；私聊/跨登录/跨群/其他平台/全局通配符拒绝。通配符与特定 actor 求交仍收窄到 actor，全 actual manifest 继续求交。

## 整理 claim、持久完成与成长校验

`readOrganizeBatch` 另返回 `inputDigest/jobState/receipt/cursor/highWater`。`source_sequence(eventId,sequence)` 和单调 `source_clock` 在角色库持久化并在 cleanDB/VACUUM 时保留；cursor 不依赖 rowid。jobId 按确切权限域和实际批次来源 refs 稳定生成。已完成/待审/拒绝/失败批次持久覆盖，重启不再自动重复模型。未决模型批次返回 model_unknown，不能跳过 cursor 继续下一批。

`host.finishOrganizeBatch(ctx,{jobId,cursor,inputManifest,requestId,inputDigest,state,candidates},operationId)` 仅 purpose=organize。state 为 completed/review/rejected/model_unknown/failed，candidates<=8。调用模型之前先持久 model_unknown claim（0 candidates），然后仅同一 requestId 用不同稳定完成 operationId 更新终态。验证实际 job/完整 refs/摘要/当前授权；proposal 带 jobId 仅关联候选，不能自行把 job 标完成。每个候选须有确切已提交、同 scope/jobId 的 proposal 回执；唯一例外是可信 Host 本地拒绝 `{operationId,phase:'rejected',ok:false,code,error,hint}`，诊断非空且各<=1000，只保存拒绝，不伪造 committed/索引。缺提交回执的成功候选仍拒绝。

成长元数据只来自独立纯 `validateGrowthProposal`（该 helper 由成长模块负责）。Kernel 在 span/subject/reality/ACL/CAS 后，从实际 evidenceRefs 递归解出原事件，不能把未引用 manifest 输入或派生记录全依赖闭包凑成 3 roots/2 dates。全 manifest 仍决定 ACL/删除依赖，不因缩小引用而放宽。读取实际当前版本和仍未解决的矛盾；review/rejected 存候选及回执，不建活跃正式版本/索引。模型不能自带 growth metadata。

承诺使用实际 prior commitment、真实新完成来源和可信 asOf。完成/取消/失败或改期不能靠旧承诺重复证明。当前状态转换同时保留原 promiser/status 的根与策略闭包；删除原承诺来源会使后续完成态也失效，不能通过只引用完成事件洗掉原依赖。


## 更正只链接真实角色版本

`applyMemoryAction(adminCtx,{type:'correct',roots,replacement:{type?:'memory',id,revision,payloadDigest?}},expectedRevision,operationId)` 要求 replacement 已是独立证据支持、当前活跃且策略仍批准的正式角色版本，不能依赖将被纠正的旧 roots。控制表仅投影 `{type,id,revision,payloadDigest}`；不允许带正文/任意附加字段。纯文本纠正返回 MEMORY_CORRECTION_TEXT_UNSUPPORTED，且旧源完全不变；先由可信流程落下真实新源/版本，再链接更正。成功回执为 `correctionState:'persisted-replacement-linked'`，不是“创建了新版本”。原正文/更正正文仅在角色库；控制和控制备份不得出现它们。若管理 UI 尚未实现真实先落新源/版本的流程，不能把该按钮称为支持直接正文纠正。

原始独立证据还排除“拥有新 eventId 的派生事件”：持久 event.inputManifest 非空的模型输入视图/行动记录/反思不是新独立观察。Kernel 不把其 full manifest 展开凑数；外层必须真正引用原始事件。只有派生证据的成长结果进入 review。ACL/删除闭包仍保留所有 actual inputs，绝不随证据计数缩小而放宽。

## Native 网络最后准入

`service.host.withNetworkAdmission(originalCtx,dispatchFunction,{signal}={})` 仅 Host JS 调用，不进入 RPC/HTTP/model body。要求原 WeakMap context、当前实际角色/epoch/generation、全部实际 manifest、已发 package 和来源截止时间、最新持久安全控制/grant 均通过。admin 能力不能隐式授予模型网络权限。

共享 FIFO fence（最多64个常规在途/排队任务）覆盖所有源/正式版本/安全控制/持久整理写入及 lifecycle entry。最终验证期间，写入等待；通过后同一段 JS 立即同步调用可信 dispatchFunction，它必须在自身第一次 await 之前真正发起 Host 网络或 first iterator.next。回调不能递归写控制、重放生产者、关闭服务或进入生命周期。这里只承诺验证与 dispatch 发起顺序，不声称与物理网络包原子。

回调返回的 in-flight Promise 被包装，dispatch 发起后立即释放 fence；实际响应/错误在 fence 外等待。撤权仍能提交并取消在途调用。此层不做响应后的角色过滤或吞掉 usage，调用者须先记录实际 usage，再做采用/发送守卫。原回调异常保留 Host 私有 identity/cause；最后准入失败则抛带 code/error/hint 的结构化异常。abort 只取消尚未 dispatch 的等待；dispatch 已发起后，不把实际响应/usage 改成“从未调用”。

排队和实际 manifest 等待支持立即 abort，回调不得在取消后迟到执行。生命周期在退休回调中等待任务 idle 时，排队 native Promise 必须已能取消并结束，不能互相等待。关闭/Worker 退出取消排队 native，并拒绝新准入。纯元数据读取不占该 fence；跨进程仍受唯一 Worker 写锁约束。

恢复进度按有界 resumedBy 链跟随有效操作，保留原查询 ID 并给 effectiveOperationId。后续控制修订若使已发布候选过期，启动保持 recovery_blocked、可检查/显式 resume，不自动启用候选，也不把整个管理恢复入口永久锁死。关闭旧句柄和文件计划先写 control，再进行 rename，故中途失败仍可回到可验证隔离原件。
