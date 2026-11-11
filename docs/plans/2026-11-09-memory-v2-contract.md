# 记忆层 V2 公共契约（工程实施约束）

状态：2026-11-09，设计稿§4/5/7对应的源码边界；所有生产路由默认V1。Node executable验证不等于真实Host或Windows门槛通过。

## 模块与所有权

- `src/core/memory-v2-contract.js`：纯校验、稳定摘要、脱敏、UTF-8切片、ACL交集和准备包校验。
- `src/core/memory-v2-spool.js`：生产者追加文件、完整写入、有限读批；桥接不得打开SQLite。
- `src/core/memory-v2-store.js`：只由worker导入，控制库+角色库事务、索引和版本；外部不得拿连接或SQL。
- `src/core/memory-v2-worker.js`：worker协议与单写者所有权；服务连接失败一律结构化拒绝。
- `src/core/memory-v2-service.js`：Host facade。桥接只经认证Host RPC；管理HTTP与Agent查询权分开。
- 插件集成负责可信当前角色/epoch、登录账号、具体会话、授权策略和路由；任何模型产出不得设这些字段。

## Host接口

`createMemoryService({ stateDir, charactersDir, getCharacter, now = Date.now, workerFactory, authorizeManagement })` 返回具有以下异步方法的服务：

- `initialize()` / `getStatus()` / `close()`：运行时探测、结构化状态、worker退出。initialize失败不隐式换后端。
- `captureContext(input)`：由Host可信适配器给出的channel/conversationKey/sourceAccountKey/requesterAccountKey/purpose/providerRouteId构造Context，加入当前角色、requestId及控制revision。不得导出为模型可任意设置授权的RPC。
- `ingestEvents(ctx, batch, batchOperationId)`：redact在首次落盘前，稳定ID与摘要校验，事务事件+operation receipt+连续游标；来源记录不依赖模型成功。
- `getMemoryReceipt(ctx, operationId)`：查询原操作结果，unknown不得换ID重试。
- `prepareMemoryContext(ctx, query, budget)`：ACL先于排名，返回准备包与inputManifest；空结果保持空。
- `searchMemory(ctx, query, options)`：相同权限与删除overlay；管理员全量另走显式purpose admin，普通local不是管理员。
- `proposeMemory(ctx, proposal)`：实际输入清单由Host附加；校验证据、控制/来源revision和角色；CAS写版本。
- `applyMemoryAction(adminCtx, action, expectedRevision, operationId)`：控制先行、幂等、错误可见；普通Agent无法调用。
- `validateContext(ctx, prepared?)`：模型前、结果持久化前和发送前校验同一快照；失败清退旧session，不回退到旧记忆或缓存。

初始化与服务状态允许扩展纯Host管理方法；新方法须在本契约补充，并由调用方测试验证。workerFactory只用于真实worker故障fixture，不得绕过生产校验。

## 已冻结的Host-only扩展（2026-11-09）

`authorizeManagement`默认拒绝，只供认证设置页transport闭包确认管理能力；不根据模型参数中的purpose或authorization字符串放权。`captureContext`拒绝purpose admin。`service.host.captureAdminContext(input, authorization)`返回管理能力Context；`service.host.configurePolicy(adminCtx, policy, expectedRevision, operationId)`持久化批准策略；`service.host.bindInputManifest(ctx, manifest)`绑定全部实际输入，独立于模型选择的evidenceRefs。三个方法均不注册为普通Agent工具。

`service.host.resolveAudience(facts)`从当前控制库查询完整channel/conversationKey/requesterAccountKey/providerRouteId对应的已批准audience与grant，返回 `{ok:true,...facts,audiencePolicyId,processingGrantId}`。输入不接受策略/grant/revision；零匹配`MEMORY_POLICY_DENIED`，多匹配`MEMORY_AUDIENCE_AMBIGUOUS`。同policyId的权限内容不可变；改变权限须新policyId并撤销旧者，避免历史来源权限被静默放宽。Host transport身份resolver默认拒绝；opaque handle只指向Host内原Context，客户端不能伪造管理身份。

Host进程内Context用WeakMap记录能力；发worker的序列化快照使用本进程随机密钥HMAC并复核持久revision。worker崩溃/重启令旧Context与Prepared失效，密钥不写磁盘或日志。下游适配器须维护相同输入清单，不允许无来源的旧history混入。

## Context与权限

Context含characterId,capturedEpoch,requestId,channel,conversationKey,sourceAccountKey,requesterAccountKey,audiencePolicyId,policyRevision,bindingRevision,deletionRevision,providerRouteId,processingGrantId,purpose。Host使用受信来源构造，service校验当前角色与持久控制。具体策略必须存在/获批；缺字段或控制不可读拒绝记忆。行政身份只能由认证的设置页路由生成，服务不因purpose字符串自动授权。

派生权限取全部实际inputManifest来源的交集；evidenceRefs子集不缩小权限依赖。propositionKey相同但授权域不同的记忆不共享currentRevision。引用、玩笑、reported/inferred不被提升成已证事实；模型不能写corePersona/控制/绑定。

## Receipt与错误

成功只说明相应阶段状态：acceptance volatile|queued_durable|rejected；sourceState pending|committed|commit_unknown|failed；selectionState not_selected|candidate|review|committed|reused|rejected|failed；indexState pending|ready|failed|not_applicable。每个失败携带code,error,hint。明确commit_unknown要求query_receipt；禁止由ok:true文案推导长期记忆已入选。

## Prepared包与同步兼容

Prepared包至少含schemaVersion,characterId,capturedEpoch,requestId,policyRevision,bindingRevision,deletionRevision,storeGeneration,queryDigest,eventWatermark,expiresAt,evidenceIds,inputManifest,text,budget。`buildCharacterContext(request)`保持同步；V2时只接受经Host准备并验证的包，不同步重读新角色/异步查询，不再混入旧热卡、briefBlock或recallBlock。没有有效准备包则结构化空记忆/失败状态，普通会话只在当前输入和session均独立获准时继续。

query中最近最多3轮只来自同具体授权会话。候选上限80，最终8条，一跳20；记忆预算1800 UTF-16字符，整体6000，切片不拆代理对；摘录最多320，不能安全保留主语/否定/覆盖范围时丢整条。没有可靠tokenizer标estimated，不声称精准计数。

## 初始禁用与迁移

worker可在隔离fixture或SHADOW保存/查询；activeBackend持久路由初始v1，任何自动运行时探测不自动切换v2。影子迁移固定水位和稳定legacyStreamId；未知身份/ACL隔离。实际切换必须具备相应平台门槛证据与具体预览授权，冻结旧writer再最终追平，落控制路由后epoch/session屏障。回退也不倒退控制、费用或新数据。

## 后续契约

成长整理只接受Host实际输入manifest，固定40事件/6000估计input tokens、5分钟空闲或手动/compact触发；模型调用挂现有全局额度reserve/admit/settle/reconcile。unknown保留原quotaDay和reserve，不自动重试。缺授权/预算/价格时相应调用拒绝而来源事件仍可记录。

备份/恢复/永久删除必须走同一worker排空后的管理入口，不让另一个模块打开活跃数据库。备份哈希与独立reopen校验，恢复套当前控制并保留备份后的合法事件与费用；无法验证当前控制时候选隔离。抑制覆盖根和派生闭包及raw召回；永久删除阶段不把SQL DELETE等同介质清除。

## 已冻结的同步/异步上下文接口

`buildCharacterContext(request)` 保持同步。V2传 `memoryBackend: 'v2'`、`memoryContext`（签发包stamp）、`preparedMemory`、`memoryQuery`、可信 `verifyPreparedMemory(prepared, context)` 同步闭包。闭包必须返回 `{ok:true}`，Promise/缺失/包篡改均拒绝；同步签发校验不声称读取了当前持久控制。V2不读取旧热卡、daily、life、purpose；全上下文最多6000UTF-16单位，记忆最多1800，摘录超预算返回需重新准备，保留否定与完整覆盖范围。V1保持默认，路由只能由Host当前控制选择，不能由模型/HTTP正文指定。

异步 `prepareCharacterContext(request, {adapter, handle, query})` 供渠道调用：同步固定角色后await `adapter.prepare(handle, query, {memory,total})`，再await `adapter.validate(handle,preparedHandle)`，最后用 `value => adapter.verifyPrepared(handle,preparedHandle,value)` 拼装。返回memoryHandle/preparedHandle及完整inputManifest。成功拼装不是网络准许；每次模型请求、持久化、发送均还需validate。

Host direct adapter 和 bridge client 均具 `verifyPrepared(handle,preparedHandle,preparedCopy)`。Host比较issued digest再检查服务原始WeakMap；client默认拒绝缺少可信同步getCharacter，需对应prepare+成功validate ack，并检查角色、TTL、包digest、discovery实例，mutation/release清ack；两者仅返回 `admission:'issued-package-only'`。worker当前控制、完整实际输入和过期来源由asyncvalidate负责。
