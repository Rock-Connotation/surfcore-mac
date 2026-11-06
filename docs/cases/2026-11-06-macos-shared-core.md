# macOS 共享核心：宿主汇总、持久经历与角色上下文

状态：开发夹具验证；未发布、未完成真实宿主验收。基线 `0c51bf2`，工作树 `feat/macos-core`。

## 完整逻辑

1. **链路**：Host 的记忆维护器读取固定角色的 B站账本（无账本时保留并消费旧索引；覆盖汇总前备份），经 `src/bili-memory.js` 生成本地索引，按稳定事件 ID 写入角色 `memory/experience-inbox.jsonl`，再投影到旧衰减卡；`src/core/context.js` 按场景读取人格、受限记忆与 life。桥接只读汇总，不再另起汇总写者。桌宠与 B站 scheduler 读取同一上下文包装器；QQ 人格与按会话记忆也由包装器构造，旧布局仍走派生块。
2. **机制**：角色和 epoch 在任务开始时固定，汇总异步期间不再转向当前角色；事件先持久化，卡与游标一起写入，投影失败后从旧游标重放。事件 ID 去重；未知可见性默认受限，私聊绑定会话；旧 scope 继续走旧卡规则。快照恢复 life 和卡时保留追加队列，使后来的经历可以重放。
3. **爆炸半径**：Host、QQ 桥接与桌宠/调度调用者共享角色状态（多进程、多读者，静默串角风险高）；会读写本地角色记忆及 B站公开账本，不调用受控外发或改凭据。测试是隔离夹具，不能证明真实运行或消息投递。
4. **取舍**：方案 A 在 bridge 与宿主分别维护写者，改动较小但跨进程竞态和 QQ 关闭缺口无法消除；方案 B 让 Host 单写者复用已有衰减卡，增加队列/游标及迁移验证成本，减少重复逻辑、可保留原卡回退。本批采用 B；远程标题/动态拉取未启用，回滚需同时保留新队列和已有卡备份。
5. **生效**：代码变更需重新加载插件宿主及 QQ bridge；本次未重启真实进程。新 wrapper 固定 characterId/epoch，旧桥接手动刷新返回 `BILI_MEMORY_HOST_OWNED` 并提示使用宿主整理。
6. **验证**：`node --test scripts/test-macos-shared-core.mjs` 6/6；`node scripts/test-bili-memory.mjs` 使用隔离 home、禁网络的 10 条合成数据通过；`node scripts/test-memory-card.mjs` 27/27；`node plugins/surfcore/scripts/test-pet-chat.mjs` 通过；`npm run test:regressions` 通过。安装依赖后的 `npm run test:audit` 为 136/143；失败原始日志 `/tmp/wp1-audit-last.log`，包括平台基线与清单；插件全量在插件目录运行 2 项更新器失败，原始日志 `/tmp/wp1-plugin-final-test-{update-helper-env,updates}.mjs.log`，未宣称发布门禁通过。
7. **回滚与残余**：保留 `_backups/20261106-wp1-core/` 和现有用户数据；在隔离副本停止写入后恢复旧代码与兼容快照，保留新队列以便后续迁移。真实 DSH、真实 Mac 生命周期、真实账号闭环、界面错误展示与整体组合验证尚未执行。Host 既有维护周期可在渠道关闭时记录本地整理活动并读取目的状态，但尚未实现完整渠道能力调度；真实 QQ 上下文行为仍待验收。

## 观察事件归属修正（追加）

接入 B站素材观察时发现：不同活动即便 eventId 不同，旧投影仍按同一 objectId 合并；同时衰减卡未保留作者归属及证据范围。现将旧账本兼容去重与通用观察分开，观察按 eventId 去重，卡保留归属、确定性和脱敏证据，展示注明外部作者观点。restricted 默认对所有渠道隐藏，只有显式 allowedContexts 中的具体渠道可见；未知渠道拒绝。重现日志 `/tmp/wp1-observation-repro.log` 为 1/2 事件失败，修正日志 `/tmp/wp1-observation-fixed.log` 为 7/7；原有记忆卡 27/27、插件人格/记忆/桌宠专项通过。此为离线夹具，不代表真实视频或账号验收。

## 隔离测试事故

曾执行 `node --test scripts/test-memory-card.mjs scripts/test-bili-memory.mjs`。旧 B站测试默认调用真实 home 的配置、凭据、账本与角色当前文件路径并写本工作树 `state/bili-memory{.md,-brief.md,.json}`；测试失败于简报长度。核查环境未设置 DSH_HOME，实际配置、凭据、角色 current、评分/收藏/额度/日记均不存在；动态函数因无 self.mid 在 fetch 之前返回，索引 0 项使标题 fetch 循环没有候选，依据执行路径及现场状态没有尝试 HTTP。上述 state 产物保留，未清理。脚本现在默认生成临时 home 和模拟数据，禁网络；只有显式设置 `SURFCORE_BILI_MEMORY_LIVE_TEST=1` 才使用真实模式。

## 可转发发布交接块

```text
文件：src/core/{context,experience,life}.js、src/{character-persona,memory-card,persona-layers,bili-memory,bridge}.js、plugins/surfcore/lib/{memory-card,pet-chat,scheduler}.js、对应离线测试与 case。
结果：核心夹具 6/6，B站隔离测试、记忆卡 27/27、桌宠测试与 regressions 通过；audit 136/143，插件更新器两项失败，仍需组合树验证。
版本建议：功能性 minor 待完整 WP1–WP5 验收后由发布会话决定；本批不是发布许可。
层级：新增共享上下文及经历接口；旧 scope 与卡保留，bridge 手动汇总行为改为提示宿主维护。
逻辑/影响：见本 case 七步。错误：持久写入、收件箱、损坏卡返回 code/error/hint；宿主定时日志可见，设置界面错误传播尚待组合。
未验证：真实 DSH/Mac/账号、完整渠道能力调度、真实端到端和最终清单；不能发布。
```

## 渠道运行契约（追加）

- **链路**：现有 `PlatformRegistry` 保留 `register/list/statusAll/require`；Host 通过 `setRuntime` 为已注册渠道绑定 `status/observe/prepareMedia/execute/dispose`。调用前固定 `characterId/characterEpoch/activityId`，不读取当前活动角色。
- **机制**：`channelCapabilities` 分开返回是否实现和当前可用；默认缺状态为 `needs_setup`，`degraded` 只允许明确标记可用的能力。`execute` 仅调用明确绑定的渠道 handler，不读取旧 `actions`；渠道 handler 仍须走原有外发门禁。实例释放和并发状态检查按拥有者隔离。
- **影响**：插件宿主与本地扩展使用注册器；旧列表/状态形状保持。没有新增 QQ、抖音业务、联网或对外发送。非法活动、未知渠道、不可用和未实现能力返回 `code/error/hint`。
- **取舍**：在旧注册器加运行契约可保持单一生命周期，成本是 Host 必须显式接线；另建独立注册器会产生双份状态及释放责任。采用前者；回退可恢复旧注册器，先停用本批 Host 接线。
- **生效**：代码需要重新加载插件宿主；本次只运行隔离 fixture，未重载真实 DSH。
- **验证**：`node --test plugins/surfcore/scripts/test-channel-contract.mjs` 8/8；临时 local 适配器提交 restricted 经历并验证 local 可见、B站不可见，固定旧角色身份、授权状态、显式外发门禁委托和异步实例释放均有断言。`node scripts/test-platform-start.mjs` 与插件 `node scripts/test-platform-start-host.mjs` 均通过；未执行共享全套检查。
- **回滚与残余**：原注册器在 Git blob `424a90c9db1407171ac264cd9425d66f4e92878c`；B站 observe 与原渠道门禁需要主会话实际接线和组合验证，fixture 不是实际账号或外发验收。

可转发交接：本批为共享核心运行接口，新增本地渠道契约夹具；插件宿主需显式绑定可用性和现有 B站观察服务，真实渠道门禁由渠道 handler 保持。无发布授权；未进行真实 DSH、账号或外发测试。

## 组合时补齐的失败契约

经历读取的路径缺失、不可读取和游标超前均返回 code/error/hint；生活状态遇到未知版本或损坏原文件时拒绝覆盖，防止降级程序把未来活动字段归一化丢失。隔离断言核对错误三字段及未来版本文件字节不变。组合验收统一见 `2026-11-06-macos-host-integration.md`；子树早期基线失败记录保留，不替代最终组合结果。

## 维护失败可见性与追加档案重放（追加）

- **链路与机制**：Host 固定本次角色路径，汇总及卡维护错误统一返回 `ok:false/code/error/hint`，最近失败按角色路径保存在进程内，并由 `memoryCardStatusNow` 和 `memoryCardSnapshot().status` 读取；成功重试清除。卡先写同目录临时文件，派生输出及归档成功后才原子提交卡和收件箱游标。
- **归档幂等**：旧归档先追加 JSONL、仅在卡内标记 `fullArchivedAt`，输出失败或快照回档可能使同一事件再次归档。统计文件新增小批次日志：预记 JSONL 末尾偏移、长度、摘要和记录键；追加并 fsync 后确认。重启只检查该批次区间，不扫描旧全量 JSONL；部分追加拒绝并保留原档。持久化 experience 收件箱归档水位和文件身份，快照保留原追加式收件箱，回档重放水位之前的事件可恢复卡但不重复归档；文件替换或截断 fail closed。
- **影响与取舍**：小日志与水位避免每次扫描 10GB 档案，增加小型状态与恢复逻辑；永久 eventId 索引或全档扫描可覆盖更多历史但迁移与长期成本更高。进程内失败状态在宿主重载后重新检查，不写额外用户诊断文件。真实设备、进程断电与文件系统崩溃未演练。
- **验证**：`node --test scripts/test-macos-shared-core.mjs` 14/14：覆盖聚合与派生输出失败、等待期间切角隔离、游标不推进、重试清除、未完成批次恢复/部分写失败、快照重放去重、收件箱替换/截断及旧布局；`node scripts/test-memory-card.mjs` 27/27；插件 `node scripts/test-memory-card-api.mjs` 通过。日志 `/tmp/surfcore-maintenance-failure.log` 和 `/tmp/surfcore-maintenance-memory.log`。
- **回滚与残余**：停写并保留新 stats、JSONL、收件箱、角色快照后恢复前版代码；已有 stats 没有归档水位的升级前历史无法无扫描地证明去重。身份使用系统设备号、inode、创建时间，文件复制或恢复改变身份时需保留文件并人工核对，不能自动重置水位；同 inode、同大小的原地改写不一定被识别，不可宣称内容防篡改。诊断 UI 由主会话接线，完整组合验证和真实宿主验收尚未进行。

## 归档提交的持久性屏障（追加）

此前追加日志和最终记忆卡只经临时文件写入及 rename，没有证明先同步到磁盘；异常掉电可能丢失日志或卡的目录项，却保留已经同步的 JSONL，从而重复归档。现在仅对这两条关键提交路径采用文件 fsync → rename → 父目录 fsync：统计日志同步成功前不追加 JSONL；记忆卡目录同步成功后才报告维护成功。若卡已 rename 而目录同步失败，返回 `MEMORY_COMMIT_UNCERTAIN` 和核对建议，保留归档收据；下一轮先同步卡目录，失败则不清收据。目录 fsync 明确返回不支持的 `EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS` 时兼容；其他错误不吞。Windows 真实目录 fsync 行为尚未验证，若返回其他错误会保守失败。

定向验证 `node --test scripts/test-macos-shared-core.mjs` 19/19：实际同步调用顺序、统计文件及目录 fsync 注入 EIO 后未追加且可重试、卡目录 fsync 注入 EIO 后的不确定提交与收据保留、明确不支持和 I/O 错误的区分均通过。未进行真实断电或 Windows 测试；全套组合检查由主会话执行。

## 追加日志恢复的档案同步（追加）

完整读取与摘要一致只能证明字节可从缓存读取，不能证明上一次失败的 JSONL fsync 已持久化。恢复未完成批次时，现对已核验的全量档案文件再次 fsync，成功后才清 pending 并提交统计；同步失败返回 `MEMORY_ARCHIVE_RECOVERY_REQUIRED` 和保留文件、检查磁盘后重试的建议，游标不推进。隔离测试先后对首次追加和恢复同步注入 EIO，验证两次均保留日志和游标，第三次同步成功后只归档一次：`node --test scripts/test-macos-shared-core.mjs` 20/20，日志 `/tmp/surfcore-archive-recovery-sync.log`；既有记忆卡测试 27/27。未做真实断电或 Windows 测试。
