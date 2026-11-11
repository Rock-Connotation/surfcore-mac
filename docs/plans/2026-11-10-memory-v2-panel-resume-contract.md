# 2026-11-10 · 管理 UI 按原管理员任务 ID 恢复（冻结契约）

## 1. 问题（不是方案）

后端 `plugins/surfcore/lib/memory-v2-management.mjs:235-289` 已实现 `POST /dsh-surfcore/api/memory-v2/admin-resume` 的
`preview → confirm` 两段协议：`resumeBody()` 要求 5 个必需键（operationId/characterId/characterEpoch/expectedRevision/payloadDigest），
只允许额外的 `preview`（可选 true）与 `content`（可选，最多 7 键；`correct` 的 preview 可同时带 `preview:true` 与 `content`），
`resumeState()` 只接受当前角色 `complete === false` 且
`action ∈ {correct, create_person, bind_account, unbind_account, remove_hot}` 的原编号，`resumeAdmin()` 在确认时
复用已存预览的 `payloadDigest`/`cut`/`target`，任何重启、TTL 过期、摘要冲突都返回结构化失败。
`status()` 在 `plugins/surfcore/lib/memory-v2-management.mjs:86` 暴露 `capabilities.adminResume` 作为真实开关。

生产面板 `plugins/surfcore/lib/memory-v2-panel.mjs` 完全没有这条入口：
`:84` 的 `begin()` 对一切操作都 `crypto.randomUUID()` 生成新编号，`:85` 一律 POST `/memory-v2/manage`；
`:119` 的 `receipt()` 是唯一按原编号查询的地方；`:165` 的 `预览恢复处理` 是生命周期任务入口，
`:166` 的待办列表只有 `预览继续清理`。因此管理员在 UI 上无法按原编号恢复一个未完成的纠正/人物/关联/热记忆操作，
只能靠新 UUID 重新发起——这是「补屎山」，会制造重复任务。

用户已授权「管理 UI 按原管理员任务 ID 恢复」这一既定设计，本工单不再追问产品。

## 2. 冻结接口（不新增操作 ID、不伪造原文、不自动重试）

- 唯一新路径：`POST /memory-v2/admin-resume`（经 client.js:282 `api()` 拼为 `/dsh-surfcore/api/memory-v2/admin-resume`）。
- 预览 body：`{ operationId, characterId, characterEpoch, expectedRevision, payloadDigest, preview: true[, content] }`。
- 确认 body：同上但**不带** `preview`。
- `operationId` 恒等于 `status.operations[].operationId`，**面板不得调用 `crypto.randomUUID()`**。
- `payloadDigest = sha256(canonical({ operationId, ...(content !== undefined ? { content } : {}) }))`，
  与 `src/core/memory-v2-contract.js:10-17` 的 `canonical/digest` 同构（面板 `digest()` 使用相同排序规则）。
- `content` **只允许** `action === 'correct'`，且必须由管理员在 UI 输入**最初确认的纠正原文**；
  其它 4 类操作禁止带 `content`（后端 `:255` 会 `MEMORY_FIELD_FORBIDDEN`）。面板不得生成替代文本。
- `expectedRevision` 取当前 `status.revision`；`characterId/characterEpoch` 取当前 `status.character`。
- 只允许 `current.operations` 中 `complete === false` 且 `action` 属于上述 5 类的行；生命周期任务
  （`request_delete` / `continue_delete` / `resume`）继续走 `:165` / `:166` 原入口，权限边界不变。

## 3. 唯一允许的 verified 行为链

1. 守卫：`lock`、`uncertain`、`allowed('admin_resume')`（`capabilities.adminResume === true`、
   `backend ∈ v1|v2`、`revision` 与 `character.id/epoch` 齐备）；操作必须 `complete === false` 且动作合法。
2. `correct` 必须已有非空的原文本，否则本地失败 `MEMORY_CORRECTION_CONTENT_REQUIRED`（不发请求、不生成新编号）。
3. 计算 `payloadDigest` → 发预览请求 → 校验 `operationId / revision / payloadDigest / preview` 四者一致，
   否则 `MEMORY_PREVIEW_INVALID` 并要求对同一原编号重新预览。
4. 预览态显示：原操作编号、原操作、已确认阶段（`preview.phase`）、状态修订、SHA-256 摘要、确认范围。
5. 确认前复检 `expectedRevision` 与 `character.id/epoch` 未变，否则 `MEMORY_POLICY_STALE` 并清空预览（必须重新预览）。
6. 确认请求回执：`operationId` 不符 → `MEMORY_OPERATION_CONFLICT`；`retry:'query_receipt'` /
   `commit_unknown` / `complete === false` / `applied === false` → 走既有 `markUnknown()`，保留原编号可查，
   **不显示成功**；仅 `ok === true` 且无上述标记才显示「已按原编号恢复；请刷新状态并核对原编号回执」。
7. 失败一律由既有 `role="alert"` 显示 `error · code；hint`；后端自带可行动 hint
   （`MEMORY_PREVIEW_REQUIRED` / `MEMORY_DIGEST_CONFLICT` / `MEMORY_CORRECTION_CONTENT_REQUIRED` /
   `CHARACTER_EPOCH_STALE` / `MEMORY_OPERATION_NOT_FOUND` / `MEMORY_OPERATION_COMPLETED`）。
   失效后预览被清空，必须重新预览；**不自动重试、不生成 replacement UUID**。

## 4. 失败契约（AGENTS.md §1.7）

| 场景 | 可见结果 |
| --- | --- |
| `capabilities.adminResume !== true` | 「按原编号恢复」按钮禁用 + 原因说明（Host 未注入真实恢复适配器）；生命周期入口仍可用 |
| `correct` 未填原文 | 本地 `MEMORY_CORRECTION_CONTENT_REQUIRED` + 提示输入最初原文；0 次请求 |
| 预览摘要/修订不匹配 | `MEMORY_PREVIEW_INVALID` + 对同一编号重新预览 |
| 确认时状态/角色已变 | `MEMORY_POLICY_STALE` + 预览清空 |
| 预览过期 / Host 重启 | 后端 `MEMORY_PREVIEW_REQUIRED` + hint，预览清空 |
| 原文与摘要冲突 | 后端 `MEMORY_DIGEST_CONFLICT` + hint |
| 未知回执 / 未完成 | `待核对操作：<原ID>` + 「核对提交状态」按原 ID 查 `/memory-v2/receipt` |
| 已完成 / 不存在的编号 | 后端 `MEMORY_OPERATION_COMPLETED` / `MEMORY_OPERATION_NOT_FOUND` |

每条失败路径都有至少一条普通测试断言钉住 `code` 与 `hint` 非空。

## 4.1 run2 返工补充（parent 独立 review 两处实证缺陷）
- **已发 confirm 但回执 operationId 与原编号不符 = 回执不可信**：不得当作普通失败清空待核对态。必须 `markUnknown(原编号)`：`待核对操作：原ID` + `核对提交状态` 按钮可见，`MEMORY_OPERATION_CONFLICT` 与「保留原操作编号」错误同时可见，核对前所有新 mutation 禁用（含重新预览），核对用 `GET /memory-v2/receipt?operationId=原ID`，回执确认后解锁。不自动重试、不生成替代编号。父端探针 `_backups/memory-v2-coordinator/panel-resume-independent/mismatched-receipt-probe.mjs`。
- **纠正原文按字节保真**：`resumeContent` 仅用 `.trim()` 判空（全空白零请求），提交与 `payloadDigest` 一律使用未裁剪原串。后端 `src/core/memory-v2-admin.js:181-183` 以 `actualPayloadDigest` 校验 exact content，`plugins/surfcore/lib/memory-v2-management.mjs:239-241` 只校验 trim 非空、不裁剪。禁止正规化/伪造/替代文本。父端探针 `exact-content-probe.mjs`（ORIGINAL 前后各 2 空格）。
- 普通回归新增 case 9 扩展断言（实际按钮/原ID/查询路径/零重复 POST/解锁）与 case 11（带空白原文 preview+confirm 字节不变、空白-only 零请求）。
- 视觉门禁新增 `--admin-resume-conflict-before/after`：用 run1 panel 快照采 Before 错误态，修改后采 After，同 1440×1000 / 390×844 / light，证明原ID核对按钮从缺失到可用、查询后解锁、网络无重发。

## 5. 明确不做

- 不改 `client.js` / `index.js` / `memory-v2-management.mjs` / `src/core/*`（parent 独占）。
- 不改 `status`/`account` 投影，不写本地状态，不新增后端操作类型。
- 不自动 fallback V1、不自动重试、不把未完成结果当成功、不生成替代编号或替代文本。
- 不启动真实 DSH / QQ / 浏览器对外连接；隔离浏览器只连本地 HTTP fake。

## 6. 验收与证据路径

- 普通 RED/GREEN：`plugins/surfcore/scripts/test-memory-v2-panel-resume.mjs`（独立运行，不加入自动 runner）。
- 真实 React 隔离浏览器前后对比：`scripts/test-memory-v2-ui-visual.mjs --admin-resume-before` / `--admin-resume-after`。
  - 同场景数据：`adminResume:true`、`operations` 含 `admin-resume-fixture-1`（`correct`/`complete:false`/
    `phase:intent_confirmed`）、固定角色 `fixture-role/epoch 1`、固定 receipt `state:committed`。
  - 视口 1440×1000 与 390×844，theme light；Before 在生产 panel 编辑前用 `before-source` 快照采集。
  - 依赖 `MEMORY_UI_REACT_DEPS` 指向本机已装 React19 的 node_modules（只读，不安装）。
- 证据：`_backups/memory-v2-panel-admin-resume/{red.log,green.log,visual/before-*-light.png,visual/after-*-light.png,visual/*-evidence.json,diff.txt,*.before}`。
