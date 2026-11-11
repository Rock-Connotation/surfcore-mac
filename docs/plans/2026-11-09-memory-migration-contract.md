# Memory V2：旧来源盘点与迁移计划契约

状态：P4 仅生成计划，2026-11-10。实现位于 `src/core/memory-v2-migration-plan.js`，测试位于 `scripts/test-memory-v2-migration-plan.mjs`。本文补充 `2026-11-09-memory-v2-contract.md` 的迁移部分，不批准导入、切换或生产数据操作。

## 决策与边界

旧 card/full 是经过筛选和截断的投影，不能恢复成完整原始聊天。来源中还混有 UI 已读、模型回复、发布意图与平台回执；逐文件直接导入成本较低，但会把这些不同事实合并，并在坏行、重试或文件搬迁时制造重复来源。这里选择先做只读盘点：保留原始位置和摘要、明确类型、隔离未知权限，再交给后续管理导入器。成本是多一份计划与一次复核；收益是可检查、可重跑，不需要修改原件来回滚。

本模块只用只读文件描述符读取 Host 已解析的来源，不打开数据库，不启动 worker，不取得管理能力，不调用模型或平台，不创建磁盘文件，不注册 HTTP/Agent 工具，不持久化 registry，不写 checkpoint，不改变 activeBackend。测试只读写自身合成 fixture。现有 Q 六文件保持冻结。

## 精确接口

```js
export function planLegacyMigration({
  characterId,
  sources,
  streamRegistry = {},
  capturedAt,
  resolveFacts = () => null,
  maxSourceBytes = 64 * 1024 * 1024,
} = {})
```

这是同步 Host-private 接口。`sources`、路径、registry 与函数参数只能由可信本地管理代码构造；不得把此函数直接包成接受模型/HTTP 任意路径的接口。

每个 descriptor：

```js
{
  kind,
  logicalStreamKey,
  legacyStreamId,       // 可省略；给出时必须等于 registry 中已登记值
  filePath,             // Host 解析的绝对路径，仅用于本次定位，不进入计划
  highWaterBytes,       // 可省略，默认打开时的文件大小
  expectedPrefixHash,  // 可省略；已捕获的 prefix SHA256
  origin,              // 只接受已知 legacy/v1；显式未知或 V2 拒绝
  sourceGeneration,    // 只接受 1/'legacy'/'v1'；显式未知或 V2 拒绝
}
```

`streamRegistry` 是 `{ [logicalStreamKey]: legacyStreamId }`。同一稳定 ID 不允许登记到两个逻辑流。Host 必须在后续控制层持久登记后才将该映射交给计划器；本模块不能证明其已持久化，也不自行登记。缺登记时，descriptor 中的拟议 ID 只出现在 `registryAdditions`，该来源返回 `MIGRATION_REGISTRY_REQUIRED`，不读取或授权它。路径、inode、文件名和正文摘要均不能自行生成 registry 权限。

每个不可变来源段需要独立登记身份。旧 inbox/current、轮转段和替换后的新段不能仅因路径相同而共用一段身份；重命名/复制已有段时由 Host 携带原登记映射。没有可信段沿革时保留待核对，不能猜一个新 ID 导入。

可信同步回调收到：

```js
resolveFacts({ characterId, legacyStreamId, kind, sourceKey, record })
// 无权威事实时返回 null；Promise 不被接受。
// 有独立依据时可以返回：
{
  actorAccountKey: 'qq:200',
  channel: 'qq',
  conversationKey: 'qq:100:group:900',
  audience: {
    classification: 'private',
    allowedContexts: ['qq:100:group:900'],
  },
}
```

这份返回值只是迁移候选的已解析事实，不是 Context、policy、grant 或批准回执。回调必须纯读取，不更改传入记录。默认回调返回 null，记录进入 `MIGRATION_AUTHORITY_UNKNOWN` 隔离。

actor 命名空间须与 channel 相同；原始 accountId/senderId 已知时须吻合。昵称只保留 `unresolvedSpeaker`，不转换成账号。QQ 必须解析登录账号与具体 group/private 会话，不能从旧 `group:900` 推导登录账号。旧显式 classification 保持不变，allowedContexts 只能缩小，scope/private/sensitive 继续约束；无法证明交集时隔离，不自动改成 public。

## 实际来源格式与映射

以下是原生 writer/DTO 的证据位置。表中字段保留原名称，不以聚合预览代替来源。

| `kind` | 原生格式与证据 | 计划中的语义 |
| --- | --- | --- |
| `experience-inbox` | `src/core/experience.js:95` 校验 schemaVersion=1、eventId、characterId/characterEpoch、occurredAt/observedAt、source、visibility、attribution、content；`:165` 追加并 fsync JSONL | `legacy-experience`；只有 Douyin reflection 且 attribution.subject=self 才标为 `self-reflection`。保留 source.accountId/objectId/conversationId 与 certainty；不把 reported/inferred 改为 observed |
| `memory-inbox` | `src/memory-card.js:2422` 追加 JSONL；字段含 at/id/sender/senderId/conversationKey/text/isSelf，正文先截到 500 | `legacy-message-capture` 或 `legacy-self-capture-unverified`，明确 `truncated_legacy`；isSelf 不构成平台送达证明 |
| `memory-card` | `src/memory-card.js:1328` 的 makeRecord；JSON 根 records；`:301` 的 meta 保存初始/初遇关系 | `legacy-projection`，保留完整现存记录及 protectionMetadata；不声明原始聊天完整 |
| `memory-card-full-jsonl` | `src/memory-card.js:803` archivedLine：投影记录加 archivedAt | 投影版本观察。archivedAt 放到 snapshotObservedAt，不充当事件发生时间 |
| `memory-card-full-json` | `src/memory-card.js:839` 兼容数组或 `{records:[...]}` | 同上；即使名字叫 full，也不变成独立原始证据 |
| `sharing` | `plugins/surfcore/lib/companion-sharing.mjs:110` 的 `{version:1,kind,id,epoch,at,...extra}`；`:132` opening 携带 job/source/coverage；存储在 `plugins/surfcore/lib/companion-sharing-store.mjs` | opening/request/answer/failure/ack 分成五种类型；request 是本地用户输入、answer 是本地回复、ack 是 UI 已读；均不代表对外平台发布 |
| `douyin-ledger` | `plugins/surfcore/lib/douyin-companion-ledger.mjs:71` jobs 对象、`:79` items；job 有 characterId/characterEpoch，item 有 id/occurredAt/title/feeling/reason/summary/draft/coverage | 保留 jobId/jobState、原 epoch、反思和 coverage。只表示自己的反思/待核查记录，不把第三方视频内容转为自传事实 |
| `bili-scores` | `plugins/surfcore/tools/lib/scores.mjs:57` 日期键数组，条目含 bvid/title/tags/score/reason/at | `legacy-bili-activity`，保留 ledgerDate；评分对象与内容保留，不推导账号归属 |
| `bili-favorites` | `plugins/surfcore/tools/commands/fav.mjs:158` 的 items：bv/aid/title/up/at/reason/kind/favId | `legacy-bili-activity`，保留收藏账记录；不由昵称推断发布者账号或权限 |
| `bili-quota` | `plugins/surfcore/tools/commands/quota.mjs:176` 的 log：at/type/auto/share/target/note，可带 up/reply/ta/mine/toMid/parent | `logged-action-unverified`；这是本地记账，不能单凭一行 quota 宣布评论、私信或动态发布成功 |
| `bili-dynamic-receipt` | `plugins/surfcore/tools/lib/dynamic-receipt.mjs:88` 将 `{version:1,id,at,type:'dynamic',auto}` 保存到 dynamic-receipts；`:140` 先取得平台成功响应中的可靠 ID | 具有正数平台 ID 与原时间的条目标为 `platform-confirmed-receipt`，仍需账号/ACL 校验；不从 quota 伪造回执 |
| `bili-dynamic-intent` | `plugins/surfcore/tools/lib/dynamic-receipt.mjs:80` `{version:1,actionId,state:'pending',binding}`；`:124` finished/result | `legacy-action-intent`，保留原状态和 result；pending、unknown、失败和已完成意图均不自动升级为独立平台回执 |
| `persona` / `life` / `purpose` / `bili-diary` | 现有角色参考文本；`src/bili-memory.js:280` 收集的 diary 也是聚合输入 | `reference`，即使有 resolver 也进入 `MIGRATION_REFERENCE_ONLY`；corePersona、规则、life/purpose 不能自动升级成事实 |

experience DTO 现存 summary/details 本身已各限 1200（`src/core/experience.js:123`、`:137`）；card text 600、detail 500 等裁剪已发生在旧 writer。计划器保留所有现存字段和原始切片哈希，不能补回之前丢失的文本。`legacy-capture-only` 只表示完整保留当前捕获记录，不宣称完整原始活动。

## 固定水位、位置和稳定身份

1. 检查绝对路径与各级符号链接，使用只读且可用时带 O_NOFOLLOW 的 fd；比较打开前、打开后与末次路径的文件身份。inode 仅用于发现本次读取被替换，不进入来源权限或稳定 ID。
2. 固定 `highWaterBytes`；从同一 fd 完整读取，SHA256 校验，再读相同前缀复核。小于水位、换文件、前缀变化或 expectedPrefixHash 不符都产生结构化失败。
3. 水位后的追加允许存在。输出恒为 `boundary:'verified-prefix'`、`completeSnapshot:false`，并记录 openedSize/observedSize；不谎称获得活跃文件的全量快照。后续真正导入前还须复核这份 prefixHash。
4. JSONL 以原始字节 offset 分行；不解码半行尾。坏 JSON、非法 UTF-8、空行、重复 JSON key 或不可映射行阻止 safeImportEnd 前进，后面的可解析行只盘点并标为前序阻塞。
5. JSON 容器扫描原始 UTF-8 子对象区间，不能用重新 stringify 的偏移当原位置。重复 key、过深嵌套、格式错误或预算超限明确失败，不静默截断。

显式 eventId 优先，按 `[characterId,'event',eventId]` 摘要建立 sourceKey。其他显式 id 带来源种类命名空间；投影使用 record 命名空间。无显式 ID 时采用 `[characterId,legacyStreamId,startOffset,originalHash]`。同文不同位置、不同段或不同角色不会被全局正文去重。

每条输出同时有原始位置 originalHash、未脱敏语义的 originalPayloadDigest 与脱敏后的 payloadDigest。摘要不包含可直接重放的原文。同一显式身份不同原始 payload 必须隔离，即使差异在脱敏后不可见，也不能被误判为同一记录。纯 JSON key 顺序变化采用 canonical 摘要，不制造冲突。

## 投影、保护与拆分

card/full 有 eventId 时与同 ID 原始事件连接为 confirmed-source，不创造第二根证据；只有 sourceId 时保留 unresolved-object 的摘要指针。没有原事件时投影仍不是独立根。相同正文只建立 possible-duplicate、不增加独立证据计数；来源同一但冲突的版本保留观察记录并隔离，不自动覆盖或融合。

pinned、anchor、isInitial、firstMet、manual、protected、manualCorrection、初始等级/概率、mergedFrom 及原 record 全部保留；root meta 的 firstOwner/firstMet 关系单独保留。本模块不会归档、降权或清除这些保护字段。

脱敏先于返回任何计划记录：使用共用 redactContent，再遮蔽结构化敏感字段、Bearer/JWT 和绝对路径；异常只返回静态 code/error/hint，不回显原文、文件路径或异常堆栈。生产计划的保存与权限由未来 Host 管理入口负责，不能把未脱敏原件复制到新导出目录。

每条脱敏记录以 canonical JSON 序列化，使用共用 splitUtf8 拆成每段最多 64 KiB 的完整 UTF-8。parts 携带稳定 parentId、partId、index/count、text 和 digest，可逐段校验并还原 canonical 记录；不调用旧 writer 再次裁剪。合成超长文本测试刻意扩展已验证 DTO，以测试规划器的边界，不声称旧 writer 曾保存同样长的字段。

V2 的 origin/sourceGeneration、schemaVersion=2、memoryV2Refs/memoryV2Receipts/memoryV2Receipt 均拒绝自导入；Douyin job 级 provenance 也传递到其条目检查。混合 ledger 不得把 V2 派生文本再包装成无来源旧反思。未来兼容 writer 必须携带明确 generation，不能只依赖文件名。

## 返回值与失败语义

返回 `{ok,manifest,counts,candidates,quarantine,diagnostics,registryAdditions}`。

- `manifest.phase='plan-only'`，`authority='none'`，`importReady=false` 恒成立。`inventoryComplete` 只表示来源盘点没有顶层诊断，不表示隔离已解决或可以导入。
- candidates 是有可信事实映射、尚待 Core 验证的草案：`requiresCoreValidation:true`、`authorization:'not-issued'`。它们没有 live Context、policy/grant、operation receipt 或实际输入授权。
- quarantine 保留能够安全解析的完整脱敏记录、原因与原始字节位置；不可解码行只保留区间与摘要，原件留在原位置。每项错误都有非空 code/error/hint。
- `safeImportEnd` 是结构可解码的上界，**不是已导入 cursor 或可跳过未知权限记录的许可**。真正导入必须对每行取得事务回执，或按获批隔离流程持久保留它，然后才能推进相应 checkpoint；本模块从不推进任何游标。
- counts 分开统计可解析记录、候选、隔离条目、坏行、半行尾、受保护记录与 parts。非法行不假装是一条已成功解析记录；同一原始身份可以有多个版本观察。
- 来源不可读、变更、超预算、registry 错误等令 ok=false，其他来源仍可独立盘点。成功读取但权限未知可令 ok=true 且存在 quarantine，界面不得据 ok:true 显示“迁移成功”。

## 后续导入与切换的交接条件

下一任务需要独立的认证管理入口、持久 registry、Core 批量导入和精确回执。它须重新证明原件前缀、原角色/epoch、来源 actor 与 ACL，处理冲突及隔离，使用固定 operation ID 处理 commit_unknown；不能让模型上传 SQL、文件路径或身份字段来替代 Host 事实。

SHADOW 导入与 activeBackend 切换是不同阶段。最终切换须先冻结旧 writer、追平固定水位、复核权限和来源、展示实际数量/冲突与预算，再取得具体授权并执行控制路由和 epoch/session 屏障。本计划不批准上述任何写入或切换。来源不改，撤销本计划只需停止后续任务；不需要恢复用户原件或回退控制修订。

## 验证与已知范围

```bash
node scripts/test-memory-v2-migration-plan.mjs
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' scripts/test-memory-v2-migration-plan.mjs
```

合成测试覆盖复制/换 inode、固定前缀与追加、读取期间变更、JSON UTF-8 原始 offset、坏行/空行/非法 UTF-8/半行、未知 actor/ACL、同文不同流/位置、同 ID 冲突与脱敏后碰撞、保护字段、投影源连接、sharing 五类型、实际 ledger 字段、V2 嵌套 provenance、自导入、600/10000 条不静默裁剪、64 KiB UTF-8 parts、registry、权限缩小以及文件/格式失败。最后逐个核对合成原件 SHA256 未变；读取期间变更测试由 fixture 注入并恢复其合成文件。

未运行生产 profile 扫描、实际迁移、SQLite 导入、旧 writer 冻结、Host GUI 或 Windows 验证；这些属于后续任务。此纯新增模块未被生产入口导入，没有生效或重启操作。本轮不重复重型 audit/ASR，父会话统一收集根门禁证据。
