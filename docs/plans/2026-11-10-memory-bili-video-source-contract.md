# Bili V2 视频文字来源接入契约（HY4-BILI-VIDEO-SOURCE）

状态：run1/3 ready · 3 个边界文件（2 改 1 新建）· 普通测试 39/39（bundled Node v24.21.0）；native fixture / 真实 Host / 外网 / 付费 / 平台发送 / 派生 subagent / 安装 / commit / 全量 gates 均 0。

## 边界与冻结接口

- 编辑 `plugins/surfcore/lib/bili-v2-source-runtime.mjs`：在既有 source proof 通道内新增 video text-only 来源，不改 factory 签名、不改既有 comment/dynamic/dm 行为。
- 编辑 `plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`：新增 7 个 ordinary 用例（真实 Worker fixture，非 native）。
- 新建本契约文档 `docs/plans/2026-11-10-memory-bili-video-source-contract.md`。
- Host factory / 官方 transport / public-source-set / index / core / root / scheduler 全部只读，未编辑（属父端或另一 active child）。父端已冻结的 sourceSelector 接缝见 `docs/plans/2026-11-10-memory-bili-host-contract.md:75/:77`；视频文字原件形状见 `docs/plans/2026-11-10-memory-bili-video-metadata-contract.md:22-49`。

## sourceSelector 接缝（与父端冻结一致）

- `identity(state, action, target, signal, sourceSelector?)`：第 5 参可选，仅在 `getIdentity({ job, action, target, signal, ...(sourceSelector || {}) })` 顶层展开；**action 仍为 `'read'`**（hydrate:102 原调用 `identity(state,'read',record.target,signal)` 只加第 5 参，不改成 `'ingest'`）。
- 只在 ingest 阶段、record/wire 全部核对通过之后，从真实对象构造完整 selector：
  - comment → `{ kind:'comment', rpid:record.objectId, type:target.type, oid:target.oid, root:target.root, parent:target.parent, authorMid:record.authorMid }`（7 键，与 `bili-v2-public-source-set.mjs:16` COMMENT_KEYS 一致）。
  - video → `{ kind:'video', bvid:target.bvid, aid:target.aid, authorMid:record.authorMid }`（4 键，与 `bili-v2-public-source-set.mjs:15` VIDEO_KEYS 一致）。
  - 其余 kind（dynamic/dm/notification/telemetry）传 `undefined`，不展开任何键。
- `getIdentity` 返回 DTO 仍为原 exact 8 键 `{ok,accountMid,conversationKey,sourceAccountKey,requesterAccountKey,providerRouteId,audience,target}`；identity 返回 `{...value,handle}`，**不**把 sourceSelector 写回 DTO。`valid()` 的独立 `getIdentity({job,action:'prompt',signal})`、preparePrompt / captureToolResult / prepareSend 的 identity 调用均不传 selector；prompt/live/send 校验不变。
- selector 的键（`kind`/`rpid`/`bvid`/`aid`/...）与 `getIdentity` 既有键（job/action/target/signal）无冲突，spread 不覆盖身份字段。官方 factory 只在 `action='read'` + 精确 selector 匹配时选成员 alias；无 selector 取 dynamic 输出——由父端 Host 侧接线，本工单不等其实现，用固定 `getIdentity` 映射验证。

## video text-only 原件校验（record 仍 10 键、无 provenance 键）

- `:88` `exact(record, ['sourceKey','revision','kind','objectId','authorMid','occurredAt','audience','target','coverage','wire'])` 不变，kind 白名单追加 `'video'`；顶层恰好 10 键，无 `verified`/`scope`/`route`/`provenance`/`root`/`full`。
- `targetValid` 新增 video 分支：恰好 4 键 `{audience,kind,bvid,aid}`、`audience==='public'`、`bvid` 匹配 `/^BV[A-Za-z0-9]{10}$/`、`aid` 匹配 `/^[1-9][0-9]{0,29}$/`。
- coverage：video 要求 `coverage==='text-only' && audience==='public'`；不要求 `authorMid===state.accountMid`（第三方 UP 文字元数据），也不宣称 full / 不取媒体 / 音轨 / 帧。非 video 分支保持原 `full` / `observed-receiver` 规则。
- wire 恰好 6 键 `{bvid,aid,title,desc,owner,pubdate}`，`wire.owner` 恰好 2 键 `{mid,name}`；`wire.bvid===target.bvid`（BV 正则）、`wire.aid===target.aid===record.objectId`（正 decimal）、`wire.owner.mid===record.authorMid`（同正 decimal）、`title` 非空字符串（逐字保留不 trim）、`desc`/`owner.name` 字符串（可空）。
- `pubdate`：`Number.isSafeInteger && >0 && <=8640000000000` 秒；**先守范围再算** `record.occurredAt === new Date(pubdate*1000).toISOString()`，避免 `+275760-09-13T00:00:00.000Z` 以上的 `RangeError: Invalid time value`。普通 1700000000 → `2023-11-14T22:13:20.000Z`；边界 8640000000000 → `+275760-09-13T00:00:00.000Z`；越界 8640000000001 / 0 / 字符串拒绝，不抛异常。
- 所有不合格走结构化 `BILI_SOURCE_COVERAGE_UNPROVEN`（`ok:false` + `code` + `error` + `hint`），不泄漏 wire 正文、凭据、官方响应；`preparePrompt` 失败返回 lastFailure 对象而非抛错（既有 api wrapper 行为不变）。

## event/operation ID 含真实 conversation

- `:100-102` 的 ingest key hash 由原 5 元素 `[characterId, characterEpoch, accountMid, record.sourceKey, record.revision]` 扩展为 6 元素，追加 `sourceContext.conversationKey`（identity 返回的真实已验证 conversation，capture sourceStamp 交叉校验过）。由此 eventId / operationId / sourceKey / segmentId 及 `state.job.jobId + ':source:' + key` 全部按 conversation 分离。
- 原因：`src/core/memory-v2-store.js:143-150` `requestScope(ctx)` 含 conversationKey、`existing()` 对同 operationId 不同 scope 抛 `MEMORY_RECEIPT_DENIED`，`:227-230` 对同 eventId/sourceKey 不同内容抛 `MEMORY_DIGEST_CONFLICT`。同一物理原件在两个获批集合重读时若不把 conversation 入 hash，会撞 ID 或复用旧 scope receipt。
- 单一多 audience policy（`policyAllows` 用 `.some()`）保证两个 conversation 各自恰好命中 1 个 audience，跨绑 ref 均可见；测试用「一个 policy 两 audiences」而非两个 policyId。

## 结构化失败（固定，不泄漏）

`requireProof(...)` 产出由 `fail(code, hint)` 构造的 `Error`，带 `ok:false, code, error:'Bili source proof was refused.', hint`；api wrapper 转成 `{ok:false,code,error,hint}`。video 相关 code 全部 `BILI_SOURCE_COVERAGE_UNPROVEN`，hint 分两类：coverage 分支 `'Video text metadata must be public, text-only and carry the exact accepted wire.'`、wire 分支 `'Video text metadata must be the exact accepted public wire with matching IDs, owner and pubdate; no media or API fields.'`。既有 `BILI_SOURCE_TARGET_UNPROVEN` / `BILI_SOURCE_IDENTITY_UNPROVEN` / `BILI_SOURCE_CHANGED` 不变。

## 普通测试与 RED→GREEN 证据

- `plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`：原 32 例全保全，新增 7 例 → 39 例，全为真实 Worker ordinary fixture（真实 Memory service/adapter/store，fake `getIdentity` + `sourceTransport`），无 native、无真实 Host、无网络、无发送。`--only=` 仅做用例名筛选，不是权限后门。
- 新增用例：① 精确 public wire 正例（rendered 一条 text-only video、ingest ok + refs、`reads[0].selector` 深等 video 4 键、prompt identity 调用 selector 为空钉死接缝）；② 22 反例（extra/missing wire field、extra owner field、media stats、BV mismatch/malformed、aid/objectId/author mismatch、full/observed-receiver coverage、private target/audience、target extra field、pubdate 越界/0/字符串、occurredAt mismatch、blank/non-string title、non-string desc/owner.name）；③ 边界 maxDate 正例（ingest spy 的 occurredAts 读到 `+275760-09-13T00:00:00.000Z`）；④ typed read（feed derived:false，sourceCount 2、两 ingest eventId 不同）；⑤ 同一物理 video 原件在两个获批 conversation 各独立 ingest（两 eventId/sourceKey/operationId 不同、sourceCount 2）；⑥ 同 oid/root/parent 但 rpid31/32 的两条 comment 原件，spy `getIdentity` 收到不同完整 7 键 selector、分配到两个获批 conversation、双来源均绑定原 job 输出；⑦ ordinary comment 原件跨两 conversation 真实 Worker 摄取碰撞探针（两 ingest 都 ok、eventId 不同）。
- RED（test-only 编辑，prod 0 改动）：`_backups/memory-v2-bili-video-source/red-agent.log` → `RED_EXIT=1`，32 旧例 PASS 后首例 `good(await f.prompt())` 失败 `BILI_SOURCE_COVERAGE_UNPROVEN` at `:249`；`red-conversation.log` 同 code at `:325`；`red-selector.log` `0 !== 2` at `:347`（prod 未传 selector）。
- GREEN：`_backups/memory-v2-bili-video-source/green-agent.log` → `GREEN_EXIT=0`，`PASS Bili real source proof: 39 ordinary cases`；VIDEO-EVIDENCE 行逐一定格 positive / negatives(22) / maxDate / typedRead / conversations / selectors / collisionProbe。`node --check` 双文件通过；两文件 `CRLF 0 / trailing_ws 0 / final_newline 0a`。
- 回归（`_backups/memory-v2-bili-video-source/regression.log`）：12 个 bili 脚本，8 个 EXIT=0（含 `bili-official-transport` 76 例直接 import 本 runtime、`bili-public-source-set` 41、`bili-video-metadata` 27、`bili-sources` 39）。4 个 EXIT=1（`bili-agent`/`bili-host-native`/`bili-host`/`bili-round-fence`）用基线对照实验（`baseline-regression.log`）证实：临时还原 `original/` 原始 prod 字节（`BASELINE_SHA=f1efef7b...`）后 4 个脚本仍 EXIT=1 且错误逐字相同，随后恢复 GREEN（`RESTORED_SHA=7d269ce...`）——分别为 native fixture 门禁、fixture 路径断言、missing installed Host tool fixture、父端 public-source-set/另一 child 边界的 `BILI_V2_HOST_FAILED`，均与本次 additive prod 改动无关。

## Deliverables / SHA256

| file | SHA256 |
|---|---|
| `plugins/surfcore/lib/bili-v2-source-runtime.mjs` | `7d269ce119b1cbce60938dcad1bcecd4f1b981dad9124b67082ff8131d974f49`（268 行） |
| `plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs` | `baed2eedafd567521db528027bfbe93896474d2538a11ee49ed323f31e03707d`（433 行） |
| `docs/plans/2026-11-10-memory-bili-video-source-contract.md` (new) | 本文件 |

原始字节快照 `_backups/memory-v2-bili-video-source/original/`：prod `f1efef7b5f931eec0734712d252ecbc29f1dca6b7df7d67174dab00fcb853a6`（259 行）、test `77c3598db12191214b1862495e398704706e9c8403765183769b832c1cb6830e`（251 行）。diff：`prod.diff` 56 行、`test.diff` 234 行（`diff -u` 对快照，两文件 git status `??`）；`git diff --check` OK。完整 result 见 `_backups/memory-v2-bili-video-source/result.md`。

## 未覆盖（父端决定，不扩本工单）

- 官方 factory / Host 侧 `action='read'` + selector 精确匹配选成员 alias 的接线、真实官方 view GET 在生产网络下的字段取值、集合审批与 typed read 截获——父端或另一 active child 边界，本工单用固定 `getIdentity` 映射验证接缝，不等其实现。
- 视频/音轨/帧等二进制内容未取也不宣称 full；本 source 只审核文字 wire 与已验 view helper 的输出一致。
- `docs/cases/*.md` + PITFALLS/ROADMAP 与发布交接块、真实 Host 联合验收、正式 V2 激活/迁移/平台发送不在 3 文件边界内（父端补）。
- 既有 32 个 ordinary 用例、`SURFCORE_BILI_SOURCES_NATIVE` 门与 nativeSourceCycle 未改；native / 真实 Host / 全量 audit+regressions 门禁本工单未跑（0）。
