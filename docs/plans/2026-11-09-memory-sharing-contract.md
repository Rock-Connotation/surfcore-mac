# Memory V2 — 本机分享对话契约

日期：2026-11-09。范围：现有 `companion-sharing` 服务、JSON controller、append-only store；不修改页面、客户端、记忆内核、Host、模型执行器或预算实现。

## 决策与原因

旧链路把 `memorySaved` 布尔值当作来源证明，并直接将分享开场和最近十条问答拼给模型。角色检查无法证明这些原文仍获准处理；取消时提前结束 Promise.race 也无法证明模型会话已经停稳。修复将 V2 放在原服务的独立分支：使用真实 Host capability、来源回执与完整输入 manifest，并在保存和 HTTP 输出处复核当前权限。

比较过两个方案：把现有分享记录自动重种为当前本机 ACL，成本较低但会把未知旧权限错误升级为授权；显式校验真实 V2 refs、隔离旧记录，需要少量接口和失效处理，但不扩大任何来源权限。本实现选择后者。V1 在没有注入时保持原行为；V2 失败不回退原始 opening、recent history 或旧全局记忆卡。

## 入口与冻结接口

```js
createCompanionSharing({
  stateDir, getCharacter, buildContext, modelReply, readiness, now, timeoutMs,
  memoryV2: { adapter, getRouting, onBlocked },
  getModelRequest,
})
```

- `memoryV2` 可省略；省略时使用现有 V1。`getRouting()` 是可信同步函数，返回 `{ok:true,backend:'v1'|'v2'}` 或结构化失败。Promise、无效状态、错误路由均拒绝，不能视为 V1。
- `adapter` 使用 Host 的 `capture / ingest / receipt / prepare / validate / bindActualInput / verifyPrepared / release`；本模块不激活 V2，不发管理 RPC，不构造 SQL，不自行分配账号、ACL 或处理授权。
- capture 的逻辑会话键为 `local:companion-sharing:<characterId>`，属于当前角色与明确授权的本机 owner。真正的来源账号、请求账号、provider route、processing grant 由 Host 的可信身份解析器决定。父 Host 应发放最长 300000ms 的句柄。本机 audience 必须已经明确获准；跨渠道来源没有本机授权时不能显示。
- `getModelRequest(input)` 是可信同步函数。input 为 `{jobId:'sharing:'+requestUUID, activityId:opening.jobId, step:'reply', characterId, characterEpoch, providerRouteId, system, prompt, images:[]}`。返回原模型执行器的 `requestMetadata`：`requestId` 和 `jobId` 都等于 `sharing:<原requestUUID>`，`category:'other'`、`purpose:'conversation'`、当前 `role/epoch/providerRouteId`、真实非空 `model`、正整数 `estimatedTokens`，可带执行器已有的价格、日期和 session 字段。缺失或异步元数据明确失败，不新建 ID 绕过重试。
- `modelReply` 收到 `requestMetadata` 与异步 `beforeSend`。执行器必须在真实模型发送前 await `beforeSend()`；未执行时不接受模型结果。模型 runner 和 token 用量记账由模型模块所有者负责，sharing 不再记一份 token 用量。

追加服务接口：

```js
await service.validateResponse(context, statusValue) // 当前角色、路由、完整manifest
service.releaseResponse(statusValue)               // HTTP结束后释放保留的capability
await service.withTransition(action, { retirementAcknowledged: false })
```

`statusValue` 必须是当前服务签发并保留的对象。controller 在 JSON 序列化之前 await 校验，随后始终释放；过时的角色结果也释放。直接调用 status 的可信调用者同样必须校验并释放，不能把对象缓存后跳过再次校验。

## 逻辑会话与请求代次的生命周期

`characterId` 决定长期来源所在的角色与逻辑本机会话；owner 仍由精确 audience 的 requesterAccountKey 和 Host 来源身份限定。`characterEpoch` 是请求的撤销代次，继续单独进入 Host `capturedEpoch`、capability、模型 request metadata、分享 archive 行和当前窗口 guard。A(epoch1) → B(epoch3) → A(epoch4) 时，A 的新上下文可以检索先前已获本机授权、当前 ACL 仍有效的 A 来源；旧 A1 handle 和迟到回调仍拒绝。B 只获得 B 自己明确批准的本机 audience，不能借 owner 相同读取 A。archive 的 opening/history 展示仍按当前 epoch 筛选，本次只修正长期记忆检索的逻辑地址，不恢复旧窗口或旧模型会话。

真实 worker + Host 的 RED：旧版把 A1 来源的 immutable policy audience 固定为 `local:companion-sharing:alpha:1`；返回 A4 时 sharing 捕获 `local:companion-sharing:alpha:4`，普通 `status` 即返回 `MEMORY_POLICY_DENIED`。保留 epoch 后缀并为每个 epoch 重发授权成本高，也不能自动改变旧来源的 immutable policy；放宽成任意角色/会话则扩大权限。因此选择固定角色逻辑 key，保持原有 epoch 撤销检查和精确 owner ACL。

兼容边界：V1 默认路径不变，当前 V2 尚未生产启用。本实现不为旧 shadow ephemeral epoch-key 来源建立别名、不重写来源事实或 ACL，也不把历史 `alpha:1` 静默解释成 canonical `alpha`。旧来源只有在单独、显式确认迁移事实与 ACL 授权后才可迁移；缺少批准时继续拒绝。父 Host 身份 resolver 与设置页 policy proposal 必须同样使用 canonical key，本模块不会修改它们或替用户批准授权。普通对话重置、sharing dispose/recreate 和角色切换不会删除内核长期来源；重置后的新请求仍需重新 capture，重新校验当前权限。

## 来源、问答与实际输入

1. 用户输入使用现有 UUID 派生稳定 `sharing:<UUID>:user` eventId/operationId/sourceKey；完整内容先按 V2 隐私规则脱敏，再完整采集，不把 1000 字 legacy 展示限制当作来源上限。V2 接受脱敏后最多 6000 字；controller 的有界 JSON body 为 32768 bytes。V1 仍保持 1000 字校验。用户发言是 statement，不代表新的处理授权。
2. 分享 opening 只接受 job/item 导出的 `memoryV2Refs` 与 `memoryV2Receipts`。canonical receipt 保留 Host 实际成功字段（包括 `ok:true`、`sourceState:'committed'`、`operationState:'completed'`、整数 `commitSequence`、`operationId`、`eventIds`、`eventRefs`），可追加 `phase`。`memorySaved:true` 不构成 V2 证明。旧记录缺少此证明时返回 `DOUYIN_CHAT_MIGRATION_REQUIRED`，不自动补 ACL。
3. 跨渠道旧 operation receipt 不在本机会话下重新查询。先检查保存的 canonical receipt/事件成员关系，再由当前本机 Host 的 `bindActualInput` 校验真实 refs 的 root、ACL、revision 和 payloadDigest。真正权限由当前内核验证决定，旧 receipt 正文不能授予权限。
4. 最近十条可验证问答、当前 opening 全文、V2 prepare 选中记忆和当前用户消息全部绑定到同一 capability。`prepareCharacterContext` 返回共享上下文；旧 memory card、daily、life、purpose 不进入 V2 模型输入。当前角色的可信 `built.personaText` 单独进入模型 system；`sections` 仅有元数据，不能从中读取 persona 正文。准备检索不能把之前已绑定的私有输入缩窄为模型引用的子集。
5. 模型前和真实发送前使用 `validate(handle, preparedHandle)`。模型后、答复采集前、QA append 前及 HTTP JSON 前使用当前完整 `validate(handle)`。模型完成后不要求检索包重新满足 30 秒新鲜期限；capability TTL、角色和当前控制仍必须有效。
6. 助手答复使用稳定 `sharing:<UUID>:assistant` 采集；Host 将整套实际 manifest 的权限交集和根依赖传递到新事件。QA answer 行保存全部实际输入 refs、答复 refs 与 canonical receipts，不按模型引用子集保存。之后撤销任一私有根会阻止这条衍生答复再次使用或显示。

原分享 archive 版本仍为 1，追加可选 `memoryV2Refs / memoryV2Receipts / sourceState / modelState`。refs 最多 100；历史累计超过内核有界 manifest 时明确阻止，不静默删依赖以继续发送。未知旧 opening/request/answer 不进入 V2视图。已知 V2 记录撤权后整个依赖视图校验失败，不回显旧正文。重启时重新捕获并校验 retained copy，不信任进程内旧判断。

## 失败、取消与控制屏障

- 所有失败经现有 JSON envelope 返回 `ok:false + code + error + hint`，由当前页面已有错误显示路径展示。路由、worker、来源、准备包、角色、HTTP 前控制失效均可见。
- 当前用户来源已提交而模型失败时，返回 `sourceState:'committed'`、`modelState:'failed'` 和原 canonical receipt。receipt 查询失败但 ingest 已确认提交时仍保留 committed 证据；提交结局不明时保留 `sourceState:'commit_unknown'`、原 operationId 与 `retry:'query_receipt'`，不能声称未保存。没有自动模型重试；同一已登记请求只复用结果或失败，不再调用一次模型。
- 保留现有全局 paid-admission 锁、job/day/acceptance 限额和 requestUUID 跨进程去重；V2模型失败沿用 daily paused 行为。token 用量未知由模型 runner 的原始 admission receipt 管理，sharing 不返还或重记用量。
- V2 transition、cancel、dispose 都 abort 并等待实际模型 Promise settle。模型忽略 abort 时屏障保持等待，不能先宣称清退完成。V1 保留既有取消行为以维持兼容。
- policy/worker/撤权校验失败调用 `onBlocked` 并留下 sticky blocked 状态；transition action 自身返回失败或抛异常也阻止继续。只有父生命周期所有者明确清退不可验证会话并传入 `retirementAcknowledged:true` 才可解除本地屏障。此参数是可信 Host acknowledgement，不是普通用户请求字段。sticky block 同时约束新 capture、模型/保存 admission 和已签发 retained view 的发送，即使 worker 或路由恢复也不自行解除。`onBlocked` 只做逻辑 scope 失效或发出非阻塞 abort/cancel 信号；不能从正在执行的 sharing 回调内部 await 自己的 `withTransition`、`cancel` 或 `dispose`（这些都会等待 active.done），否则形成自等待。完整 async drain 必须由活动回调之外的父管理/生命周期路径调用 `withTransition`。
- 这里不声称永久删除 DSH 历史副本。不可验证的模型/宿主会话必须由父生命周期层清退；本模块仅保证不继续使用或发送未获验证的 retained view。

## 存储失败

append 仍持有独立短锁，执行 fsync，并保留既有 Windows 目录句柄兼容。`fs.writeSync` 返回 0 或非法进度时立即抛 `DOUYIN_CHAT_WRITE_FAILED`；ENOSPC 作为结构化 `DOUYIN_CHAT_STORAGE` 显示。写入失败保留先前 archive 字节前缀，finally 清理本进程持有的锁。若失败发生在部分行之后，残尾不会当作成功记录加载，需保留文件检查原回执；不截断、重置或删除旧记录。

## 验证与发布交接

新增 `plugins/surfcore/scripts/test-memory-v2-sharing.mjs` 使用独立标准临时目录、真实 worker + Host adapter + production sharing service/controller 和 fake model，不调用实际模型。覆盖真实来源采集/答复采集、完整脱敏长输入、同 UUID 一次模型调用、opening/history 完整依赖、私有根撤销与子集洗白、重启/retained copy、安全 HTTP 输出、角色失效、abort 等待、worker 各阶段失败、缺少可信 metadata、执行器必须 await beforeSend、模型失败来源回执保留、未知 commit、legacy quarantine、零进度/ENOSPC 前缀和锁清理。

```sh
node plugins/surfcore/scripts/test-memory-v2-sharing.mjs
node plugins/surfcore/scripts/test-companion-sharing.mjs
node plugins/surfcore/scripts/test-companion-sharing-race.mjs
node plugins/surfcore/scripts/test-companion-sharing-platform.mjs
node plugins/surfcore/scripts/test-companion-sharing-ui-controller.mjs
npm run test:audit
npm run test:regressions
```

此前新增真实 worker fixture 29 项检查，CLI Node 26.5.1 与 bundled Node 24.21.0 的五条 sharing fixture、audit 176/176 和 regressions 已通过。2026-11-10 逻辑会话生命周期修复只重跑本文件的轻量 fixture：两种 runtime 均通过 32 项检查（原 29 项加 A1→B3→A4/ordinary service reset、B 隔离与旧 handle 拒绝、旧 epoch audience 无隐式迁移）。同 owner 的 fresh A4 context 在真实 worker 中检索并 prepare 得到 A1 来源 refs，`bindActualInput` 与 prepared validation 均成功；从未在 B 检查过的另一 A1 handle 在 A4 仍返回 `CHARACTER_EPOCH_STALE`。普通 reset 取证范围为本服务 transition + dispose/recreate，不声称运行真实 DSH reset。RED/GREEN 日志与三个改动前源码位于 `_backups/memory-v2-local-conversation-lifetime/`，本轮未重复 audit、ASR、UI 或实际模型测试。没有布局或样式修改；聚合 UI gate、index 注入、父生命周期清退与真实模型 runner 集成由父任务验收。跨渠道测试用真实 Douyin adapter 生成 canonical source，再由本机 adapter 绑定；同时验证独立本机 policy 不会授权一个仅限 Douyin 的旧来源。不凭本机拥有者身份扩大来源授权。

发布交接块：

> P2-LOCAL-SHARING：既有本机分享对话可在可信注入 V2 时采集用户和助手来源，绑定完整 opening/history/context manifest，并在模型发送、保存与 HTTP 输出前校验当前权限；失效来源可见阻止。V1 默认行为保持。失败不自动重试，模型失败保留来源/回执，transition 等待实际模型会话结束并要求显式 retirement acknowledgement。需部署 SurfCore 插件源并重新加载插件/宿主，使新 factory 接线生效；无需 CSS/UI 变更。本子任务不发布、不提交、不修改版本号。

回滚：三个旧源码保存在 `_backups/memory-v2-sharing/original/`。父任务必须先安全清退当前 V2 会话，再按整体 V2 路由回滚契约恢复旧源码；不能把恢复 V1 实现当作旧受限来源可读的授权。新增 V2 archive 字段须保留原文件并通过受控迁移处理，不能让旧严格 parser 静默重置记录。仓库 case、PITFALLS/ROADMAP、COORDINATION 与最终发布交接由父任务统一落盘，本任务文件边界不包含这些文件。
