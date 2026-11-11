# 固定语料上的真实 V2 Worker 检索/准备评测

本文件对应 P2-EVAL-V2。评测入口为 `node scripts/test-memory-v2-evaluation-kernel.mjs`，只运行离线合成 shadow Worker，不启用生产路由、模型、网络或平台发送。V1 对照报告使用父会话独立验收的 `_backups/memory-v2-evaluation/v1-L3VBpm/report.json`，V1 方法及局限见 [V1 基线](2026-11-09-memory-evaluation-baseline.md)。

## 冻结输入与分母

继续使用 `scripts/fixtures/memory-v2-evaluation.json` 的原始字节，SHA-256 `70c664208a85f1d7dedac7cb28aeb2dc8e7f5102881203cff46a5023f2fdecc3`。10,000 事件、160 问题，开发/留出各 80 个事件族和问题，事件分区 4,924/5,076，交集为空。所有问题用相同完整源索引运行，未以留出结果选词、改题、改 gold 或调整 kernel 排名。

可回答分母为 130，应保留未知为 30（专门无答案组 20 + 身份组 10）；改写组 60 = 有意义词重合 48 + 真正零 V1 查询词重合 12。1,200 个 `longTermCandidate` 标记源不等于已选入长期摘要。原始 13 类场景元数据也不等于通过生产行为测试。

## 显式 Host 映射与授权

- `eventId = sourceId`，`sourceKey = fixture-source:<sourceId>`，源操作和批次操作均用固定 fixture ID。100 条/批以下，真实 `service.ingestEvents()` 写入，返回 receipt 逐条核对，不直接打开数据库或绕过 Worker。
- 只投影源事件的原文、账号、发生时间、归属/确定性、媒体覆盖和源侧状态元数据。主体为 `<source attribution subject>:<accountId>`，因此不同来源账号和外部作者不合并。joke / quoted_injection / uncertain_asr 分别使用既有 joke / quote / unknown 元数据。
- `validTime`、源状态、bindingState、supersedes 保存在源 `evidenceRefs` 元数据内；没有把答案片段、必要来源或 gold 写入内容、标题或索引，也没有凭它们制造长期摘要。原始事件 schema 没有直接的 validTo 版本选择字段，本评测不据此声称时间推理正确。
- 九条 approved fixture policies 按“角色 + 源 ACL 域集合”产生。audience 三元组来自源事件的真实合成 channel/conversation/account 和问题的 `context`；问题正文、expectedSourceIds、forbiddenSourceIds、answerSpans 均不进入策略构造器。
- 源归属角色由 `snapshotHost` 闭包返回；`captureContext` 的 actor、requester、policy、provider、grant 全由固定 fixture Host 决定。provider 为 `fixture-local:uninvoked-provider`，grant 为 `fixture-local-processing`，没有调用 provider。管理能力仅由闭包中的 Symbol 通过 `authorizeManagement` 授权。
- 允许多域的源 policy 包含这些域的已知受众；查询本身用其单域已批准 policy。因为多个合法 policy 的 audience 可以重合，这里使用可信 fixture 映射显式 capture，不把 `resolveAudience` 的零/多匹配问题隐藏成生产 identity resolver 已验证。
- 唯一 unknown ACL 源仍物理摄取，但 Host 放入 `fixture-quarantine / quarantine:unknown-acl` 专属 audience，没有普通查询 audience。该隔离是显式 fixture policy 选择，不是测出自动迁移识别能力。
- 原始 deleted/suppressed/binding 状态保留为元数据；本次没有发管理操作去应用它们，不声称测了删除、撤权、spool replay 或恢复。原始语料对禁止来源的分级单独报告，不能把 query-declared 身份限制等同于实际 ACL 泄露。

策略/来源映射分别保存为每次 artifact 目录中的 `policy-mapping.json` / `source-mapping.json`。纯映射检查去掉 factSpan/family/longTermCandidate 后结果完全一致。10,000 个真实 `normalizeEvent()` 投影均为单 part、ID 不变；既有 redactor 仅改变背景 `fixture-event-10000` 中的五位数字 `10000`。检查返回的正文使用实际正常化文本，冻结语料不变。

## 实测链路与指标

只导入真实 `createMemoryService()`，不使用调用方上下文拼接 helper，避免读取真实 DSH_HOME。服务所有 state、角色库及锁均在本次 `_backups/memory-v2-evaluation/v2-*` 内。配置 policies、显式 enable_shadow，确认 activeBackend 仍为 v1；摄取全部来源后真实 close/reopen，再检查持久 eventCount 和长期标记来源 receipt。

每个固定问题创建新的可信 context，然后分别运行：

1. 真实 `searchMemory(ctx, query, {limit:8})`；记录前 8 来源、candidateCount、原始禁止来源和 RPC wall time。
2. 真实 `prepareMemoryContext(ctx, query, {memory:1800,total:6000})`；记录实际 evidenceIds、完整 text、inputManifest、丢出 search top8 的来源及从更后候选补入的来源。whole excerpt 超过 320 或整体预算不够时由 kernel 丢整条，评测不替它截短/补入。
3. 核对最多 8 条、正文预算 1800、原文未被裁剪、manifest 与 evidenceIds 一致；用原始 issued object 执行 `verifyPrepared()`，绑定实际 manifest，再 `validateContext()`。这些准入调用单独计时，不混进 prepare 时间。

Hit@8 是可回答问题至少一个正确来源在前 8；completeEvidenceAt8 要求某个完整必要来源集合出现。复用固定 V1 纯 metric helper。源事件搜索与准备不是摘要选择能力测试，memoryVersionCount 预期为 0；没有模型也没有提出 summary。未知问题出现候选不代表模型编造答案。

额外 canary 文本探针和无相关内容探针不计入 160 个得分问题。四个 canary 分别在两种普通问题 audience 查询，并用其原始私密 source audience 做阳性对照；保留实际返回 ID 和耗时。固定无相关 ASCII 查询要求 search 与 prepare 真正返回空列表/空 text，不根据“应未知”标签伪造空结果。

## 性能与复现条件

初始化/策略写入、所有来源摄取、每批写入、查询 context capture、search、prepare 和后续 admission 分别记录。查询测量在全部 10,000 来源落盘并 reopen 后进行；前三次预热不计入，随后 160 个不同问题各测一次，P95 为 nearest-rank。时间来自 `performance.now()`，不受 fixture 业务时钟影响。

源码 SHA 在运行前后核对，不同则拒绝该次结果；fixture 哈希运行前后也必须相同。无性能通过阈值、冷启动 SLA、Windows/真实 Host durability 或 Node 22.13 完整兼容性结论。Node 可执行版本和实际源码摘要以报告为准。复现命令：

```bash
node --check scripts/test-memory-v2-evaluation-kernel.mjs
node scripts/test-memory-v2-evaluation-kernel.mjs
```

## 测量结果与验收记录

父会话于 2026-11-09 确认 run2 kernel 已稳定后，实际执行 `node scripts/test-memory-v2-evaluation-kernel.mjs`，退出 0。报告 `_backups/memory-v2-evaluation/v2-qZKnwl/report.json`；终端日志 `_backups/memory-v2-evaluation/v2-measurement.log`。Node `v26.5.1`，整个实测前后四份 kernel 代码哈希和 fixture 哈希一致。

持久结果：真实 close/reopen 后 `fixture-aurora=9,999`、`fixture-boreal=1`，总计 10,000 源事件，远大于旧热卡 600 上限。两角色 `memoryVersionCount=0`；1,200 个长期候选仅表示源已完整摄取，不夸大为 1,200 摘要。192.08 天前的 `fixture-event-00001` 在 search/prepare 均返回。

| 指标 | V1 full 诊断 | V1 自动热卡 | V2 search top8 | V2 实际 prepare |
| --- | ---: | ---: | ---: | ---: |
| 可回答 Hit@8 | 118/130 | 5/130 | 118/130 | 118/130 |
| 改写/长期延迟 | 48/60 | 0/60 | 48/60 | 48/60 |
| 改写：有意义词重合 | 48/48 | 0/48 | 48/48 | 48/48 |
| 改写：零 V1 查询词重合 | 0/12 | 0/12 | 0/12 | 0/12 |
| 开发集可回答 | 58/64 | 2/64 | 58/64 | 58/64 |
| 留出集可回答 | 60/66 | 3/66 | 60/66 | 60/66 |
| 应未知但候选为空 | 0/30 | 0/30 | 0/30 | 0/30 |
| 原始 query-declared forbidden 数/问题数 | 99/22 | 3/3 | 10/10 | 10/10 |

V2 的 completeEvidenceAt8 同为 118/130：时间/承诺组 30/30、身份可回答 15/15、媒体/归属组 25/25。它表示必要来源存在，不表示模型正确解释日期、覆盖或身份。V2 没有弥补零词重合的 12 题；相对于 V1 的 full 诊断，来源命中没有提高。提升主要是把查询驱动的万级源召回接入真正的授权准备路径；本评测没有启用生产 context 路由。

V2 两种输出各有 10 条 query-declared 身份禁止来源（问题 093、095、098、100、103、105、108、110、113、115），分别是源 00125、00129、00135、00139、00145、00149、00155、00159、00165、00169，ID 均带 `fixture-query-` / `fixture-event-` 前缀。wrongRole / wrongAcl / deleted-suppressed 元数据暴露各为 0。pending/revoked binding 的源侧标签没有变成管理操作，本测量不认定这些十条已经获得身份合并授权；也不把它们偷换成已发生的 ACL 泄露。30 个应未知问题均有候选，答案克制率仍未测。

四个 canary 各在两种普通 audience 测试，8 次 search/prepare 均未返回 canary；原始私密 audience 的 4 次阳性 search 均命中其确切 sourceId。两次固定无相关查询的实际 search IDs、prepare IDs、text 均为空，准入仍通过。该证据只覆盖这些固定 policies 和 audiences。

15 个问题的实际 prepare 丢出共 30 个 search top8 来源，并从后续候选补入 30 条；相同 gold 指标不等于相同 packet。最大实际 text 为 1,792 字符，全部最多 8 条、未裁剪入选来源，160 次 issued-object/manifest/admission 检查全部通过。

| 时间（毫秒） | 样本数 | Median | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| V1 full 诊断（已验收报告） | 160 | 154.67 | 236.07 | 405.84 |
| V1 自动热卡（已验收报告） | 160 | 12.34 | 22.06 | 50.03 |
| V2 search RPC | 160 | 1.83 | 4.72 | 646.56 |
| V2 prepare RPC | 160 | 1.88 | 5.22 | 634.14 |
| V2 context capture | 160 | 0.26 | 0.56 | 4.67 |
| V2 admission + manifest | 160 | 1.94 | 3.25 | 6.52 |
| V2 摄取批次 | 109 | 49.33 | 100.02 | 211.82 |

V2 初始化 103.12 ms；10,000 源摄取总计 5,990.03 ms。P95 不能掩盖尾延迟：`fixture-query-031` 的 search/prepare 分别为 646.56/634.14 ms，candidateCount=80，是本轮明显的宽词查询尾部。源码路径会先取得 term hits 并逐条做可见性过滤，之后才限制候选；没有采样 profiler 或单题重复跑，因此不把具体 SQL 因果当成测量证明。已将该尾部和原始身份禁止来源交给父会话，不在本子任务改 kernel。以上为两次不同时间运行的离线观测，不建立冷启动、SLA 或统一端到端性能胜负。

固定测量代码 SHA-256：

```text
src/core/memory-v2-contract.js ddba3cc5865a34418430d023b1fe2eac1ae54b633c3d175cb499f8299c97f383
src/core/memory-v2-store.js cfd521acd5ed7ec876a76014fc1d60f8f161df297e5cf2e36c3a3b17a813c6e9
src/core/memory-v2-worker.js e1de42b4a3cb0a037c8bec8e2bd722ca392763e5bcfc49d1bc6eb5bcd621848a
src/core/memory-v2-service.js 495b6e1086d2750b2f0cf6331739b1d6cc4f46ec048ba8e6a6b956017c7055d6
```

这些摘要钉住测量时版本。后续父会话 P4 可继续扩展 store；该扩展不自动获得本报告的性能证明。

自检：新脚本 `node --check` 通过；纯映射检查覆盖 10,000 `normalizeEvent()` 投影、稳定 ID、去除 gold 注释后映射相同、canary/unknown audience 边界和冻结哈希。`npm run test:audit` 退出 0，`Audit suite: 176/176 scripts passed.`，日志 `_backups/memory-v2-evaluation/v2-qZKnwl/audit.log`。标准 audit 自己在 `_backups/` 中生成隔离证据目录；本 evaluator 的 state/report 仍全部在其 `v2-*` 范围。CLI 失败以 stderr JSON 明确报告 `ok:false/code/error/hint` 并退出 1；失败格式的纯断言检查了 code/hint 非空。最终补充只触及 CLI 错误显示，实测 kernel 与评分逻辑不变。

## 边界、取舍与回滚

选择真实 Worker source 检索/prepare，而非自写 ranker 或从答案制造 summary，成本是完整摄取万级源，收益是实际验证现有 kernel 的授权/排名/预算路径。选择显式 synthetic policy，收益是授权条件可复现；代价是不能把本结果外推为所有生产 identity/grant 适配器的证明。

本子任务只新增评测脚本和本文件，不改已有 fixture、V1 evaluator、kernel 或其它文档；回滚可隔离这两份新文件并保留 artifact。无需生产重启，不修改 profile，不提交。模型答案支持率、幻觉率、未知答案克制率、长期摘要选择质量、生产撤权/生命周期/usage 均未测，设计 80%/95% 为 proposal 不是已通过门槛。没有 UI 变化，不适用 before/after 截图。
