# P4 admin resume：只读契约调查与待冻结方案

状态：只读调查已验收；parent 选定 A 路线并冻结下面的专用 HTTP 契约。P4-ADMIN-RESUME-HTTP run 1/3 仅修改 management controller、其真实 HTTP test 与本文；不修改 core/UI/runtime/index。调查时未运行 fixture；后续实现的定向 fixture 证据见文末。

## 已确认的断路

| 位置 | 当前行为 | 后果 |
| --- | --- | --- |
| `plugins/surfcore/lib/memory-v2-panel.mjs:165` | 全局恢复按钮发送 `resume` + `{}` | 用户无法指定原 admin operation；纠正缺原文时也没有重输入口 |
| `plugins/surfcore/lib/memory-v2-panel.mjs:74` | `begin` 对每次新操作生成 UUID，preview/commit 沿用它（:84、:108） | 恢复命令编号 R 与原 admin 操作 A 不同 |
| `plugins/surfcore/lib/memory-v2-management.mjs:145` | resume 仅从 runtime.operations 筛唯一未完成 restore/request_delete/continue_delete，调用 lifecycle.resume | status 虽能列出 admin 待办，HTTP 没有 admin.resume 分派 |
| `plugins/surfcore/lib/memory-v2-runtime.mjs:122` | genuine admin runner 仅作为 identity/correct/hot adapter 注入 | 注入这三个 adapter 不等于开放恢复能力 |
| `src/core/memory-v2-admin.js:274` | `resume(ctx,{operationId:A,content?})` 找原操作并 `advance` | 沿用 A，未持久登记 UI 恢复命令 R |
| `src/core/memory-v2-service.js:267` | admin commit/resume 的 retirement 由真实 Host callback 完成；缺失/失败返回 incomplete | 查询回执不能完成退休，必须显式恢复 |
| `plugins/surfcore/lib/memory-v2-management.mjs:238` | 返回 operationId 与本次 R 不同则报 MEMORY_OPERATION_CONFLICT | 不能把现有 admin.resume(A) 直接装进 generic manage(R) |
| `src/core/memory-v2-store.js:186` | GET receipt 查实际 admin progress/业务回执，再附 durable binding | 仅绑定 R 不会使 R 成为真实 continuation；重启查询 R 仍 not_started |

更正一个前提：`src/core/memory-v2-admin.js:220` 中 remove_hot 在 role effects 后直接 completed，不要求退休 ACK；它仍可能因 `adminAfterIntent` / `adminAfterRole` 或 COMMIT 故障停在未完成阶段，因此也需要恢复路径。correct/identity 的正常路径在 :221–223 进入 retirement_required。

## 不可破坏的原生语义

- `src/core/memory-v2-admin.js:37` 的 bindRequest 六字段绑定不可修改，A 的原 action/payloadDigest/expectedRevision/characterId/characterEpoch 不得重绑定为 resume；已提交的旧 epoch 不得改成当前 epoch。
- `src/core/memory-v2-admin.js:203` 的 advance 先检查原 role receipt，已存在则不再执行来源/身份业务写入；恢复推进 A 的阶段，不是重做 A。
- `src/core/memory-v2-admin.js:181`：纠正停在 control intent、role source 尚未提交时，需要最初确认的 content；:182–183 校验 actual/redacted 两种摘要。控制库存不保存纠正正文，不能从摘要恢复原文，不能替用户生成新文本。role receipt 已存在时无需再次提交正文。
- `src/core/memory-v2-admin.js:168` 的 progress 与 `src/core/memory-v2-store.js:186` 的 getMemoryReceipt 只读；不得在 GET receipt 中自动恢复或补写 alias。
- `src/core/memory-v2-admin.js:164` 已输出当前角色 admin 待办及 action/phase/complete，可供明确选择原操作；HTTP authority 仍由私有 native admin capability 决定，不能接受客户端 admin/platform authority。
- 原 lifecycle resume 已有真正持久 continuation：`src/core/memory-v2-lifecycle.js:265` 解析原目标、:270 保存 parentId/effectiveKind/originalRequest、:280–281 保存 resumedBy 并插入编号 R 的 lifecycle_ops。保持其现有 HTTP `{}`/唯一目标及 native 接口兼容。

## 两条最小完整路线

### A：显式“按原编号恢复”，复用当前 core，不创造 R

新增独立于 generic new-operation 流程的恢复命令路径，使用原 A 作为唯一结果/查询编号；UI 不运行当前 begin→randomUUID→execute 流程。native 仍调用 `host.admin.resume(ctx,{operationId:A,content?})`，并查询 A。

收益：不需要 core continuation schema，直接复用已有原编号恢复与只读查询。成本/风险：必须冻结新的 HTTP/UI 恢复语义及 native-cut 校验；该命令不能作为 generic manage 的普通 action，否则会触发六字段冲突。客户端丢失纠正正文时要显式重输，core 核原摘要。现有 lifecycle 流程保持不变。

这是允许单独恢复路径时的最小实现；当前 HTTP 公开形状由 parent 决策，本报告不自行授权新增 endpoint 或跳过 generic bind 校验。

### 未采用 B：保持 generic manage 每次确认有独立 R，增加原生 durable continuation

候选 native API，待 core owner/parent 冻结，非现有接口：

```js
host.admin.preview(ctx, {
  action: 'resume',
  payload: { operationId: A, content? }
}, expectedRevision)

host.admin.resume(ctx, {
  operationId: A, content?, previewDigest
}, expectedRevision, R)
```

现有 `resume(ctx,{operationId:A,content?})` 两参数调用继续返回/推进 A；带 R 的调用是真正 continuation，不改 A 的 binding。新的公开 HTTP action 名称及 payload、capability 名称尚待 parent 冻结，不能单凭 native 候选就修改 UI。

必要性质：

1. R 的六字段绑定包含原目标 A 和可选原文的实际 payloadDigest；同 R 换 A/content/revision 必须冲突。R 只能用于同角色 native admin 管理操作，不能跨角色或偷接 lifecycle/privacy/role operation。
2. 在调用 advance(A) 前，core 在持久 control transaction 内登记 R→A 关系及不可变请求摘要；仅调用 bindRequest(R) 不够。该记录不能保存纠正明文。可用独立 continuation 表，或由 core owner 扩展已有账本；不能把 action=resume 塞进现有 admin_operations 后直接走其普通 advance 分支。
3. core 返回 canonical `operationId:R`，同时带 content-free `resumedOperationId:A`；来源/选取/索引/完成阶段来自真实 A。A、R 的 GET receipt 均跨 controller/Worker 重启可查。R 的查询通过持久关系读 A 的真实进度，无写入、无虚构 success。旧 R 关系查得见后不得依赖 preview 内存再决定目标。
4. service retirement/ACK/reopen 始终针对真实 A；返回 R 不能让 :274 的 acknowledge 找错操作。涉及 epoch 变化时 HTTP 保留 R、A 和 confirmed phases，提示查询；不能把旧 A epoch 改写为当前值。
5. 已存在 R 的重放返回其真实 continuation 回执，尚未登记但仅 binding-only 的 R 不等于已恢复。故障发生在关系提交后、推进 A 前，仍可按同 R 显式继续；禁止自动换 UUID 重做 A。
6. pending/missing-content/failed-retirement 均要保留原 confirmed phases；缺原文返回可行动的 MEMORY_CORRECTION_CONTENT_REQUIRED。新的 preview 和 commit 应维持 exact original capability 验证，不能用 freshctx 携旧 previewDigest。

必要核心触点：`src/core/memory-v2-admin.js:10`（持久关系/碰撞约束）、:168（progress/alias 只读查询）、:225/:265（continuation preview/resume 分派与请求校验）、`src/core/memory-v2-service.js:257`（preview capability、退休目标和结果编号）、`src/core/memory-v2-store.js:186`（receipt 路由）。只有 manager/runtime 内存 Map 或改写返回对象 operationId，均不能替代这些持久语义。

收益：复用通用 preview/commit/UI 不确定状态与新编号查询，语义和 lifecycle continuation 一致。成本：需要真实 core schema/API 与 service 退休集成；不能只改 HTTP adapter。回退只撤接线，不删除关系/原回执，不单退已升级兼容标记的旧 kernel。

## 最小真实 RED 建议（未执行）

1. 真实 Worker + private admin Symbol + genuine runtime/HTTP，合成来源及真实 correct A；retirement callback 首次明确失败，保证 control intent/role source 已提交且 complete:false、A 的六字段 binding 已持久。
2. status 应列 A/correct/retirement_required。模拟现 UI 的 `resume {}` preview（新 R），目前应得到 MEMORY_OPERATION_REQUIRED；原 A 仍 pending，证明真实 backend 能力未接到 HTTP。
3. 先直接调用现有 native resume(A) 作正对照：让真实退休 callback 恢复健康，fresh native adminctx 显式恢复；A 最终 complete，无新纠正来源/身份业务副本。若选择 B，再用 R 的真实 native continuation 替代正对照，HTTP 与重启后 GET R 均应给 canonical R+A 与实际 complete。
4. B 必测：R 关系提交后中断，重启后 GET R 不写；继续同 R 原 A 成功；同 R 换目标/文本/expectedRevision 冲突；跨角色拒绝。不能以 wrapper 改编号或返回 ok:true 通过。
5. 纠正另一窗口：故障停在 adminAfterIntent、role source 未提交；不带 content 应可行动失败，错 content 摘要冲突，原 content 才能继续；原 binding/epoch 不变。
6. legacy lifecycle resume 原两参数/core path、当前 `{}` 唯一目标与其真实 R 回执保持既有行为；此调查未重跑其测试。

## 已定与待 parent 决策

已定：当前 UI/HTTP 恢复不可达；原 admin.resume 只推进 A；generic R 需要真正 durable continuation 才能有可重启查询的 R 回执；六字段/no write-on-query/no new UUID redo 不变。

已选 A：parent 确认这是技术实现选择；generic lifecycle resume 保持原协议，不增加 native alias 表。上面 B 仅记录历史备选，不是待实现输入或已开放的公开权限。

只读阶段未执行真实 RED；后续真实 RED→GREEN 和定向测试记录如下。完整 audit/ASR、UI before/after 与生产退休验收仍未执行，由 parent 后续接线安排。

## 已冻结并实现：原编号专用 HTTP 恢复

构造参数增加可选 `adminResumer = null`，由 parent 私有 Host 注入：

```js
adminResumer: {
  resume: ({ context, operationId, content }) => service.host.admin.resume(context, {
    operationId, ...(content !== undefined ? { content } : {})
  })
}
```

`capabilities.adminResume` 仅在该对象确有 resume 方法时为 true。controller 不创建/提升 admin 权限，不自动取用其他 runner 作为恢复器。实际 socket loopback、Host/Origin、opaque private authorization 和 native current role 捕获沿用原入口。

`POST /dsh-surfcore/api/memory-v2/admin-resume` 只接受：

```js
{
  operationId: A,
  characterId, characterEpoch, expectedRevision,
  payloadDigest: digest({ operationId: A, ...(content !== undefined ? { content } : {}) }),
  preview: true, // 提交时必须省略；不接受 false
  content       // 可省略；仅原 action=correct 时允许
}
```

规范化 continuation 只含 operationId 与实际提供的 content，按既有 canonical SHA-256 算法计算。正文空白不擅自修改；core 核对原始/脱敏摘要。字段不接受 action、purpose、授权、客户端 phase、previewDigest 或新 R。该摘要仅绑定本次 RAM 预览，绝不替换 A 原 action 的六字段 durable binding。

预览从真实 `host.admin.status(originalCtx)` 选择 exact A、当前角色、complete:false 且 action 属 correct/create_person/bind_account/unbind_account/remove_hot；生命周期任务不能借此入口恢复。返回：

```js
{ ok: true, operationId: A, payloadDigest, revision: expectedRevision,
  preview: { operationId: A, action: originalAction, phase: actualPhase } }
```

独立 RAM cache 最多 128 个预览、TTL 默认 120 秒（沿用构造参数最大 300 秒）；保留 exact original context、native cut、target action/phase、continuation 摘要及必要原文。到期计时器主动清除，替换、提交结算、dispose 也清除。原文不进入 control、receipt、HTTP response 或日志，不宣称永久擦除 Host/进程历史。

提交必须沿同 A/role/epoch/revision/continuation digest 和有效预览。重新读取真实 status 核 target phase/cut，然后以 original previewctx 调 resumer。core `authority` 在 Worker resume 入口检查 control/policy/binding/deletion 修订，service 检查 WeakMap capability/epoch/generation 并 fence；真实竞争测试证明 RPC 前晚到的控制变更会拒绝旧 context。phase 是 fresh 实际检查，不是新增的原子 expectedPhase CAS；复用原 A 的单调 phase、advance 幂等和 core fence。

提交沿用 receiptResult 的 canonical A 与分阶段结果；不登记新操作、调用 bindRequest、生成 UUID、重做 source/identity，或在查询中推进。缺/错原文保留原 intent 与 known phases，并给原文重输入建议。退休未完成仍 complete:false。epoch 变化返回 A + completed_before_cancel + confirmed phases + query_receipt；Worker/control 不可用同样保留 A、unknown、query_receipt。HTTP 丢失后只查询 A；controller/Worker 重启会清空预览，继续必须再显式预览/确认。

## 实现证据与剩余接线

- RED：`original-ID-red.log` 在真实退休 pending A、旧 resume{} 拒绝及 direct native A 正对照后，检测到专用能力/入口缺失；同用例随后 GREEN。
- 9 组恢复定向用例：原 A 专用入口；adminAfterIntent 缺/错/原文三路及 control 无正文；typed body/私有授权/Origin/TTL/错误目标/跨角色拒绝；原生 control CAS 与 phase/epoch 竞争；丢 HTTP + Worker 重启 + GET 控制 SQLite 字节不变；真实 identity(create_person) 与 remove_hot 故障恢复；旧 lifecycle resume 保持独立 R；同 A 并发只分派一次/角色变更丢弃旧响应；Worker 丢失仅查询原编号、重新预览后才继续。
- 既有 4 组绑定回归：same ID 不同请求跨重启冲突；binding-only 与 legacy unbound fail closed；真实 admin original previewctx；business COMMIT fault 原回执恢复。13 组分别在 CLI Node 26.5.1 与 bundled Node 24.21.0 通过。
- 所有 source delta、原始备份、RED/GREEN 日志与 26 次最终用例证据保存在 `_backups/memory-v2-admin-resume/run-1/`。fixture 沿既有 test script 保存在 `_backups/memory-v2-management/`，不删除数据。未运行完整 audit/ASR，没有模型、平台发送、生产 profile、安装、commit 或发布。
- parent 仍须独立 R6、将真实 resumer 注入 runtime、给 UI 原编号专用预览/确认/原文重输入路径，并验证可见失败与生产退休。这里没有修改 UI 或代称其验收完成。

## 发布交接与回退

- 改动：提供私有管理端原编号恢复入口，修复 admin 待办在 HTTP 无法继续的问题；保留六字段绑定与旧 lifecycle resume。
- 生效：parent runtime 接线后重启插件 Host；默认 resumer=null 不开放能力，不自动启用 V2。
- 验证：运行本文 13 个 --case 定向场景；预览不产生副作用，确认/丢响应/重启后始终查询原 A；core 原 intent 和已确认阶段不回滚。
- 回退：先撤 UI/Host resumer 注入或该专用端点，保留旧管理与 core、原 A 回执/控制状态。首次 admin mutation 已升 minimumCompatibleKernel=2 后不能单独退旧 kernel、删 marker 或用角色旧备份覆盖当前控制。
- 范围：case/总入口/实际 UI before-after/生产退休由 parent 负责；没有永久清除外部模型或 DSH 既有会话历史的承诺。
