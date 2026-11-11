# P4：Memory V2 authenticated Host 管理控制器

本文件记录 `plugins/surfcore/lib/memory-v2-management.mjs` 与现有 `memory-v2-panel.mjs` 的接缝。控制器不接管 index、UI、core、模型 runner 或真实会话退休；统一接线由 parent 完成。当前不会自动激活 V2。

## Factory freeze

```js
createMemoryManagementController({
  memoryService, getCharacter,
  getAuthorization = () => null,
  getRuntimeStatus = () => ({}),
  inspectMemory,
  organizer, migrator, identityManager, corrector, hotManager = null,
  onControlChanged = () => {},
  now = Date.now,
  previewTtlMs = 120000,
}) // -> Object.freeze({ handle(req, res, url), dispose() })
```

- `memoryService`：真实 `createMemoryService` 返回值；管理操作调用其私有 Host 入口与真实 Worker。
- `getCharacter()`：可信同步 native 当前角色 `{id, epoch, name?}`；epoch 为正整数。body 不拥有角色选择权。
- `getAuthorization(req)`：可信同步工厂闭包，返回 core `authorizeManagement` 能验证的原始 opaque capability。缺失、布尔值、thenable 均拒绝；body、查询参数或前端字符串不产生 capability。外层仍须 cookie、loopback、same-origin 守卫；本模块另外验证实际 socket peer 为 loopback、Host 为 loopback、Origin 为实际协议加 Host 的精确值。
- `getRuntimeStatus({context})`：可 async；`context` 为本次真实 native admin capability。只能提供当前角色事实；显式外角色 `characterId` 行会丢弃。允许字段为 backend、backups、operations、policies、approvedConversations、budget、queue、storage、migration、bindings；未知字段不出 HTTP。
- `inspectMemory({context, query, limit}) -> {ok:true, records}`；选择具体版本时为 `inspectMemory({context, recordId, recordRevision}) -> {ok:true, record:{id,revision,roots,characterId?}}`。必须是当前角色真正的管理员读取/版本解析器，不可用普通模型 all RPC 或临时 SQL 代替。缺失返回 `MEMORY_INSPECTION_UNAVAILABLE`，purge capability 为 false。FINAL core 已提供 `host.admin.inspect`；parent 显式注入适配器，exact lookup 的 `records[0]` 映射为 `record`。早期 stub reader 只验证 transport；run 2 genuine fixture 已调用真实 core。
- `onControlChanged({characterId,characterEpoch,operationId,action,result})`：成功、已提交部分阶段或 commit-unknown 的内容无关通知，result 只含白名单 phases。不得在 active 回调里 await 自身 transition、cancel、dispose 或队列 drain；真正退休/排空由 core lifecycle 构造器的 parent 回调负责。通知失败仍保留原操作编号和已提交阶段，要求查询回执。
- `dispose()`：关闭新 admission、清除私人 preview cache，不宣称取消已入 core 的工作、清除 DSH 历史或完成会话退休。

### Trusted runtime mapping

```js
{
  backend: 'v1' | 'v2', // 不注入时保守显示 v1；不会修改路由
  characterId: 'app', // 可选，但不允许与 native 当前角色冲突
  approvedConversations: [{
    id, label,
    processorScopes: [{ id, label, policy: /* 实际 validatePolicy 对象 */ }],
  }],
  policies: [{ id, label, characterId? }],
  backups: [{ id, label, verified, characterId? }],
  operations: [{ characterId, operationId, action, ...canonicalPhases }],
  bindings: [{ id, platform, accountId, personId, characterId? }],
  budget: { settled?, reserved?, unknownHolds?, cost? },
}
```

`approvedConversations[].processorScopes[].policy` 是 parent 已批准映射，不接收客户端 policy 原对象。HTTP 只返回选项 id/label，绝不回传 grant、route、policy 私有内容或文件路径。policy 操作在 core 再经真实 admin capability 与 CAS 验证；UI 选择本身不是权限。

FINAL `host.admin.status` 提供当前角色受限摘要；parent 必须将 policyId/backupId 等真实字段映射到该 runtime 契约，并从真实生命周期库存/持久回执维护 verified 与跨用途目录；禁止把空默认值当作该功能已完整提供。counts 只从 core 当前角色条目取 eventCount、memoryVersionCount。不存在的 budget 字段保持缺失，不伪造成零。capabilities.activation 永远 false；removeHot 只在真实 hotManager 三方法均存在时开启，UI 映射 remove_hot 到 granular removeHot，不能借 purge 开启缺失动作；optional runner 缺失时 organize/identity/migration/correct 为 false。

### Optional runner freeze

每个 runner 均须同时实现：

```js
runner.preview({context, action, payload, operationId, expectedRevision})
// -> {ok:true, previewDigest: '<真实 backend 摘要>', preview: {...}}
runner.commit({context, action, payload, operationId, expectedRevision, previewDigest})
// -> 实际 canonical receipt / structured failure
runner.receipt({context, operationId})
// -> 实际 canonical receipt；仅明确查证不存在才 operationState:'not_found'
```

`context` 只证明当前 admin 发起权。organizer 适配器必须自己 capture fresh `purpose:organize` capability，按原操作编号计费并调用模型；不能拿 admin context 冒充 organize。只有明确的 organize commit 才携带 `{optIn:true,manual:true}`，本模块无 timer、无模型调用、无自动重试。corrector 必须提供真实的“写入新版本并保留旧版关系”流程；FINAL `host.admin.preview/commit` 提供真实 plaintext 工作流，只有显式注入对应适配器后才开启；旧 replacement pointer 控制项仍是独立 primitive。identityManager/migrator 同理：transport 接缝不等于实现其业务。

## HTTP 与 payload 映射

统一前缀 `/dsh-surfcore/api/memory-v2`，全部经过同一 auth 和 native-role 检查。每个 await 前后重新比对 native id/epoch。所有 JSON 失败包含静态 `code/error/hint`，不回传异常文本、stack、任意路径或 token。

| Route | 实际行为 |
| --- | --- |
| `GET /panel-client` | 只读取同目录固定生产文件 `memory-v2-panel.mjs`，JS/no-store；不接受 path 参数 |
| `GET /status` | core status + 可信 runtime 的严格白名单；仅当前角色计数 |
| `GET /search?q=&limit=20` | 私有 admin reader，limit 1–20；缺 reader 明确不可用 |
| `GET /receipt?operationId=原ID` | 实际 core receipt/lifecycle progress，随后可查询 optional runner receipt；未知/跨角色不可授权保持 query-only |
| `POST /manage` | Content-Type JSON，最多 65536 字节，必须是下面六个顶层字段 |

```js
{ action, payload, expectedRevision, operationId, characterId, characterEpoch }
```

payload 仅接受下表字段及 `payloadDigest`，通用预览可额外 `preview:true`。意外字段、prototype action、body admin/purpose/grants、客户端 core previewDigest 一律拒绝。

| UI action | 真实 commit payload（不含摘要字段） | backend |
| --- | --- | --- |
| `backup` / `preview_backup` | `{}` | lifecycle previewBackup / backup |
| `restore` / `preview_restore` | `{backupId}` | verified 库存 + lifecycle previewRestore / restore |
| `request_delete` / `preview_delete` | `{mode:'delete_roots',recordId,recordRevision}` | 当前 admin reader 解析实际 roots，再 lifecycle previewDelete / requestDelete |
| `suppress` | `{recordId,recordRevision}` | 解析实际 roots → core applyMemoryAction suppress |
| `configure_policy` | `{conversationId,processorScope}` | 仅可信映射实际 policy → core configure_policy |
| `revoke_policy` | `{policyId}` | 当前角色实际 policy 库存 → core revoke_policy |
| `continue_delete` | `{operationId:原删除ID}` | 当前角色 request_delete 库存 → lifecycle continueDelete `{deleteOperationId,purgeRetained:true}` |
| `resume` | `{}` | 仅库存唯一未完成 restore/delete/purge → lifecycle resume 原 ID；零个/多个明确报错 |
| `remove_hot` | `{recordId,recordRevision}` | optional hotManager；只映射真实 host.admin preview/commit，不替换为 suppress |
| `correct` | `{recordId,recordRevision,content}` | optional corrector，缺失 unavailable |
| `create_person` | `{platform:'qq'|'bili'|'douyin',accountId}` | optional identityManager；core 真实 anchor/person registry，不自动合并同人或扩 ACL |
| `bind_account` | `{platform:'qq'|'bili'|'douyin',accountId,personId}` | optional identityManager |
| `unbind_account` | `{bindingId}` | optional identityManager |
| `organize` | `{optIn:true,manual:true}` | optional organizer；无 opt-in 拒绝 |
| `migrate` / `preview_migration` | `{snapshotId}` | optional migrator |

## Preview、CAS 与回执时序

1. UI 的 `payloadDigest` 是 deep-sort canonical JSON 的 SHA256，计算时移除 preview/payloadDigest。控制器重新计算实际 payload 摘要；它只证明 UI 摘要一致，不是授权或 core previewDigest。
2. 私有 cache 最多 128 项，默认 TTL 120 秒、最大 300 秒。key 为同一 operationId，保存 native角色/epoch、control revision、store generation、action、实际 payload、实际 backend/core previewDigest、解析后的真实请求。
3. 同 ID 同摘要预览可复用。不同 action/payload 冲突；native角色、revision、generation 变化使旧预览无效。TTL 超期或 controller 重启不会自动重建预览或生成新 UUID。
4. 首次真实 mutation 前必须 await 私有 `host.admin.bindRequest(adminctx,{operationId,action,payloadDigest,expectedRevision,characterId,characterEpoch})`，摘要来自 Host 对规范 action 的实际 payload 重算；持久 binding 不提升 privacy revision。已有业务 receipt 只能在原 core `requestBinding` 的六字段全部匹配后确认，不能先绑定本次 body 再接受旧回执。旧 receipt 无 binding 时保留 confirmed phases、返回失败/query-only，绝不追认。binding-only not_started/not_found 不是业务提交，仍要求有效私人 preview。
5. 同 ID 的并发 preview 在私人 planning 槽中占位，不同 payload 冲突，相同 payload 未完成时返回 busy，不能覆盖已审核输入。commit 先查原 ID 的真实回执，已存在或不确定时只返回实际阶段，绝不重新 mutation；不存在且有有效私人 cache 才允许继续。commit 再验证真实解析请求未改变，CAS 和 core digest 原样传入真实 backend。
5. 生命周期在真正退休后可能改变 native epoch。此时放弃旧角色正文，只返回内容无关的原 operationId、source/selection/index/operation phases、`completed_before_cancel` 和 `retry:query_receipt`。不声称未保存或回滚。
6. 已提交但角色视图 applied:false、生命周期 complete:false/retirement_required 均保持 query-only；不能因为 receipt 顶层 ok:true 就宣告完成。HTTP 200 也可能 `ok:false`。worker 崩溃/commit unknown/通知失败保留原 ID，UI 只能 GET receipt，不能新 ID 重发。core 的 not_found 结果在 GET receipt 中不升级为“未保存”：规范成未知、提示切回原角色并核对原编号。
7. 私人 cache 不是永久幂等账本。跨 controller / worker 重启以 core 或 runner 的实际持久 receipt 为准；不确定的 optional runner 必须自己持久化原 ID 与计费未知占用。控制器不取消或减免该占用。

## 完整逻辑与取舍

- **链路**：index 私有 authenticated HTTP → 本模块精确 Origin/loopback/typed body → trusted sync getter → service.host.captureAdminContext → core Worker 控制/生命周期 → canonical receipt → 受限 JSON。panel 只得到当前角色管理数据。模型/QQ/B站 RPC 不注册该模块。
- **机制**：body 携带版本和角色只用于比对，native capability 与真实 control revision 才拥有权限。UI 摘要无法代替 core 预览计划；因此保留实际 core digest 并在 commit 重验选择。已提交阶段不能因换角色或丢 HTTP 被改写成未保存。
- **影响面**：Host 管理端一个进程与 Worker；源抑制/撤权/恢复/删除会影响后续上下文；organize 仅 runner 显式 opt-in 才可能花钱。当前代码没有自行读写用户 profile、复制 DB、模型请求、路由激活或构造 SQL。
- **路线比较**：让 UI 直接传 core plan/digest 成本低但暴露授权/允许篡改；控制器保留私人短期真实 plan 多一个小 cache，换来封闭 authority 和实际 CAS。后者可直接移除新模块回滚，故选择后者。
- **生效与重启**：parent 在 index 构造并路由后才生效；需要重启插件 Host。重启清空短期预览，历史操作须核对原持久 receipt，不复用内存 cache。
- **验证**：运行 `node plugins/surfcore/scripts/test-memory-v2-management.mjs`，以及 bundled Node 同一脚本。输出 `ok:true` 和每组 checks。fixtures 只写 `_backups/memory-v2-management` 并起 127.0.0.1:0 HTTP；无真实模型/平台/用户 profile。真实 core 测 configure/revoke/backup/delete/restore/suppress；注入 reader/optional runner 只证明控制器 transport。
- **回滚与残余**：parent 撤销 index 工厂与路由接线，保留该模块和 fixture 即停止新管理 admission。已经提交的 core 控制/生命周期记录仍按原 ID 查询，不删除数据库、不重写历史。真实 reader、runtime 库存、optional runner、会话退休和全 UI 集成仍属于 parent/对应 owner；默认 unsupported 不算这些功能完成。

## 可转发的发布交接块

- 类型：Memory V2 P4 管理控制器接缝（编辑会话，无版本号/提交/发布）
- 变更：三个新文件；authenticated native admin、当前角色状态与回执、实际 preview/commit digest + CAS，默认关闭缺失 backend 能力
- 验证：以本次交付报告的双 runtime focused checks 为准；core lifecycle nonce/epoch 回调仅 isolated fixture，不是生产会话退休证据
- 生效：parent 完成 index 接线与真实 backend adapters 后重启插件 Host；不得据此自动启用 V2
- 回滚：撤销 parent 接线，保留原操作 ID/receipt、已提交阶段与 kernel 2 兼容 core；首次 admin mutation 升 minimumCompatibleKernel=2 后不可单独回滚旧 kernel，不删除用户数据

## Run 1 自检证据

- 新 HTTP fixture：22 组 scenario，CLI Node 26.5.1 与 bundled Node 24.21.0 均通过。覆盖 auth/body/native role、实际 core 管理与生命周期、摘要篡改、并发 preview/commit、核心提交后故障、未应用控制、待退休、丢 HTTP 与重启原编号回执。optional runner/inspection 标注为 transport 测试，不冒充完整 backend。
- 现有 bundled kernel 18 checks、lifecycle 27 checks 通过；audit 176/176 与 audit regressions 全部通过。
- 新 fixture 全在 `_backups/memory-v2-management`。现有验证脚本会使用其固有 `_backups/memory-v2-kernel` / `_backups/memory-v2-lifecycle` 目录，audit 也产生标准 fixture；该额外产物已报告 parent，未删改它们，未修改相应源码。
- 未调用真实模型、生产 profile、平台发送、用户数据、git commit 或发布。parent 仍须独立验收并接线。

## Run 2 R6 RED 历史与修复机制

- 已加真实 HTTP RED `durable-same-ID-binding-rejects-changed-action-payload-or-revision-after-restart`；Node 24.21.0 已复现 configure_policy 提交后经过 controller + Worker 重启，同一 operationId 换合法 revoke_policy、payload 或 expectedRevision 仍返回前次成功回执；dispatch 次数仍为 1。前次 receipt 的存在不能证明本次请求内容一致。
- 根因是管理 HTTP 的 existing-receipt 快路跳过 core 真实 mutation 方法内 requestDigest 检查。core 当前 privacy_actions/lifecycle_ops 各有 native requestDigest，但没有统一验证实际 UI action/payload/expectedRevision 的 private admin API，optional runner 也不在同一张操作表。不能用内存缓存补持久契约。
- 当时已 hand_back parent 请求 core owner 提供 content-free durable request-binding/check API；随后按 FINAL API 接线，原 RED 已在双 runtime 转 GREEN。原 partial confirmed phases 与 query-only 行为保持，未扩展 core Boundary，也不生成新 UUID。
- parent 新批准 `create_person` 严格 payload 和 identityManager 路由已接入；真实 registry/anchor 与 backend runner 属于 core owner。未改 UI，也未提前猜测 hotManager 方法。

## Run 2 FINAL seam 已验证

`host.admin.bindRequest` 已按 parent/ad9 FINAL 六字段接口接线，实际 frozen core hook 上三组指定定向 HTTP 用例在 Node 26.5.1 和 bundled 24.21.0 均通过。已有回执对比的 binding authority 只来自 core `getMemoryReceipt`，optional runner 不能自证。binding-only 保持未开始，旧未绑定回执只能查询；旧 binding 角色 epoch 不更新为 current epoch。binding-only/legacy-unbound 已真实通过；create_person 的额外 transport-only case 保留在 test 源码，本轮未额外运行，不把它作为真实 registry 验证证据。

### Original preview capability 与显式 hotManager

core admin preview 绑定原 WeakMap capability，故 private cache 的 `planned.args.context` 保留到该次 runner.commit；不能将另一 HTTP 请求新 capture 的 adminctx 配上旧 previewDigest。commit 前仍以 fresh native capture 校验 role/epoch/revision/generation，再由真实 core 检查原 capability。parent 注入 hotManager 时采用同一 preview/commit/receipt runner 接口，映射 FINAL `host.admin.preview/commit` 的 remove_hot，不复用 purge。status removeHot 只有该真实适配器具备三方法时才为 true。

### Run 2 验证证据与运行边界

- `durable-same-ID-binding-rejects-changed-action-payload-or-revision-after-restart`：真实 configure_policy 提交，经 controller + Worker 重启后原请求可回放；合法 action、payload、expectedRevision 任一变化均失败，业务 dispatch 恒为 1。
- `binding-only-is-never-a-business-commit-and-unbound-legacy-replay-fails-closed`：真实 durable binding 没有业务效果时只报未开始/query-only；已有旧业务回执无 binding 时保留已提交阶段但拒绝变更请求，也不追认新 binding。
- `genuine-core-admin-HTTP-preserves-original-preview-capability`：显式注入 FINAL core runner/reader/status；新 capability 携旧 coreDigest 被实际 core 拒绝，manager 原 previewctx commit 成功；remove_hot 后真正 hot:false 且显式搜索仍保留；纠正实际生成新报告内容并触发原生 epoch/Worker 退休，HTTP 返回 content-free completed_before_cancel，原编号查询最终 complete，binding 保持旧 epoch。
- CLI 与 bundled 的上述三组日志在 `_backups/memory-v2-management/run-2/`；本轮未运行完整 audit/ASR 或宣称全部 26 组已在 FINAL core 重跑。实际生产 profile/会话退休仍未验证，由 parent 接线验收。
- 首次实际 admin mutation 会将 `minimumCompatibleKernel` 升为 2。之后只能撤销管理接线并保留匹配的新 core；不能单独退回旧 kernel、删除/重写 compatibility marker，或以旧角色备份回滚当前控制/身份。保留数据与原回执，由 parent 处理完整版本回退。

### 原 business COMMIT 故障夹具维护

新增 binding 独立 control transaction 后，旧 controlCommitAfter:1 会先击中 binding。按 parent 同 run 2 批准，在该既有 test 中先真实 bind，随后显式 setFaults 并重启 Worker，再进行原 preview/commit；继续断言 COMMIT unknown、原编号 query-only，以及 reopen 后真实业务 receipt applied===true。该单组在 Node 26.5.1 / 24.21.0 均通过；未弱化断言或将 binding-only 误报成业务 saved。run 2 共完成四个定向组、每组双 runtime。
