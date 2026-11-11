# 记忆 V2：主入口组合、官方身份与原生 Agent 隔离

状态：隔离工程阶段，P0–P4 尚未整体完成。本文记录已验证的接线和失败修复，不是安装或发布完成证明。

## 现象与环境

早期各模块独立测试通过，但插件主入口没有创建 Memory V2 runtime；管理面板、来源适配与 worker 没有组成同一条实际调用链。B站夹具还把原生 `Session.toolHistory()` 错当成数组，首次真实推理前即被安全检查拒绝。

- 工作树：`surfcore-memory-v2`，分支 `feat/memory-v2`，基线 `94a4a78`，版本仍为 `0.8.8`。
- 真实包内 Node：24.21.0；原生模块取自本机 DSH 0.2.2-rc.1。合成账号、独立临时角色及 fake provider/platform 用于验证。
- 默认后端仍为 V1；未访问常用 GUI 的 59783 端口，未修改正常 profile、安装包或旧工作树，未调用付费模型或实际平台发送。

## 完整逻辑

### 1. 链路

`plugins/surfcore/lib/index.js` 创建 `memory-v2-runtime.mjs`，runtime 组合真实 `createMemoryService`、worker SQLite、Host adapter、受限 RPC 与管理 controller。管理 HTTP 使用实际宿主 connection 认证；来源 RPC 使用独立 scope token、回环和 Origin 检查。

管理链为：当前角色 → 私有 admin 授权 → 原预览 context 与摘要 → 六字段持久请求绑定 → worker 原操作回执。抖音与本机分享通过私有 `channelMemory` / `modelRequest` 接入；QQ 官方身份由桥接只读接口提供。B站独立 root 与来源校验分开验证，后者仍在实施。

### 2. 机制

- API handler 返回 `void`，且对不匹配 URL 会写 404；组合器必须先匹配精确 prefix，再调用一个 handler，不能把返回值当作“是否接管”。
- 来源 RPC prefix 是 `/dsh-surfcore/memory-v2-api`，不在一般 `/dsh-surfcore/api` route 内，必须单独注册。管理 API 则保留宿主 UI 认证，缺 connection 默认拒绝。
- worker 的 `policyId` / `backupId`、`inspect.records[]` 与 UI 的 `id` / 单条 `record` 不同，映射集中放在 runtime，避免让前端猜核心格式。
- 本机分享的逻辑会话采用 `local:companion-sharing:<role>`，epoch 仍是单独的原生 context 屏障；切回同一角色不会因为新 epoch 丢掉已授权历史，也不会复活旧 handle。
- QQ 身份查询执行 `get_login_info → get_status → get_login_info`，确认在线、两次账号一致及配置未变。显式模型对来自同一配置快照；默认模型未固定时不猜 route。
- B站真实原生历史是 `{tools:[], updates:[]}`。隔离分支严格验证此对象，不把旧 fake 数组当成实际契约。原生取消、等待 idle、清空 inbox、释放实际 handle、从 registry 脱离共同构成 unload ACK。
- 独立 root 的调用侧账本保留真实 `prepared.config` 原指针；`ownsRequest` 还要求原对象 identity，同 sessionId 的浅拷贝不成立。这只证明调用与配置来源，不能代替完整消息来源校验。

### 3. 影响面

源码涉及插件 Host、QQ bridge、worker 与 UI controller 的组合；当前没有生产数据变更。管理写入必须经私有权限和原操作编号；来源 RPC 不能取得 admin 权限。预算必须记真实 stream，不能把 `session.prompt` 的排队 ACK 当成模型调用。

最危险的静默错误是：接错 route 导致面板始终不可用、把 partial 误报完成、旧操作换 body 仍收到旧成功、按 epoch 切断角色的合法长期历史、原生假历史绕过来源校验。对应失败须结构化并显示下一步。

### 4. 取舍

采用集中 runtime 映射和独立注册 RPC；相比修改各个核心 DTO，变更集中且便于回退。采用实际独立 root 而非只更换 preset 名称，因为祖先 AGENTS、context 和工具仍可能进入普通子 scope。原生随机 message ID 不能独自证明 writer，完整语义、顺序、一次消费与私有实际输出侧账本必须另做。

管理恢复选择“按原编号继续”的专用协议，复用核心原操作和只读 receipt；相比再建 `R → A` continuation 账本，减少持久协议和恢复路径。专用HTTP已独立通过完整管理35项，runtime已注入真实原生resumer；UI与真实会话退休仍未完成，不能将模块验收等同于生产恢复闭环。

首个备份动作还暴露跨核心缺口：preview后执行六字段绑定将兼容floor从1升到2，导致原摘要失效。选择让预览明确将生成备份所需的floor，并在确认完整切面后升级；另一条路线是让用户再次预览确认，但会制造无数据变化的重复确认，故不采用。实际控制、源序列或副本变化仍返回MEMORY_PREVIEW_STALE，不降低摘要校验。

### 5. 生效与重启

目前只在此工作树及临时夹具生效，常用 DSH 不会自动加载这些字节。未来安装插件后，需要重启读取 bundle 的 DSH Host；QQ bridge 的新接口需要其对应新进程。生产安装、重启及迁移需单独展示具体制品与影响后确认。

### 6. 验证与证据

已独立执行：

- `plugins/surfcore/scripts/test-platform-start-host.mjs`：实际插件入口、临时真实角色、默认 V1、管理认证和独立 RPC 注册通过；网络隔离。
- `plugins/surfcore/scripts/test-memory-v2-runtime.mjs`：25 项真实 HTTP / worker 组合检查通过（新增真实resumer注入、无来源身份拒绝与未知原编号不造恢复记录），包括配置策略、无事件策略目录、撤权、真实 verified 备份及原操作回执。
- `scripts/test-memory-v2-qq-integration.mjs`：官方身份接口及旧 QQ 集成场景通过，使用 fake OneBot，覆盖 agent/Host/Origin/回环/在线/账号变更和错误回执。
- `plugins/surfcore/scripts/test-memory-v2-sharing.mjs`：32 项通过，包括 A1 → B3 → A4 的合法历史与旧 handle 拒绝。
- B站两个实际 Host fixture flags 联跑：35 场景通过。新增 root 联测一次 provider、15 token、实际 owner hook、typed tool 可用、shell 拒绝、无祖先 canary、卸载后旧 session 拒绝；平台调用为 0。此处 `fakeSourceValidatorOnly:true`，不是完整生产来源证明。
- `plugins/surfcore/scripts/test-memory-v2-native-root.mjs`：11 项实际原生隔离检查通过，后续配置原指针及 clone 拒绝检查也通过。
- `scripts/test-memory-v2-migration-plan.mjs`：22 项通过，39 份合成原文件摘要不变；plan-only，不代表 importer 已实现。

- 完整管理suite35项、生命周期suite28项通过；首绑定RED→GREEN与源变更仍拒绝的证据在 `_backups/memory-v2-coordinator/first-binding-backup/`。更高兼容floor仍保留，最终相同逻辑定向回归通过。

日志位于 `_backups/memory-v2-coordinator/`：`main-entry-memory-routes.log`、`runtime-entry-composition.log`、`qq-identity-read-independent.log`、`bili-isolated-root-independent.log`、`native-root-prepared-config-independent.log`、`migration-plan-independent.log`。

本增量已重新执行 `npm run test:audit`（176/176）与 `npm run test:regressions`（17项全部通过），日志在 `first-binding-backup/`。完整P0–P4的组合插件、专项与最终门禁仍待未完实现冻结，当前增量通过不冒充整体完成。

### 7. 回滚与残余

每次覆盖前的源码备份见 `_backups/memory-v2-coordinator/entry-integration/`、`runtime-dispatch-before/`、`root-dynamic-tool-seam/` 和 `root-prepared-config/`。工程源码可从对应备份恢复；不得把旧核心直接指向已升级兼容 marker 的数据，也不得回滚 installation 控制库。当前从未执行生产切换。

仍未完成：B站完整输入/输出来源 factory 与真实 transport 接线、QQ 原生逐次模型与实际发送门、抖音官方私有身份 DI、完整生命周期退休与管理继续UI、迁移 importer / 最终 delta / 切换，以及最终组合门禁。Windows、精确 Node 22.13、真实模型质量、实际平台回执与长期运行未验证。

## 失败路径

认证失败显示 `MEMORY_ADMIN_REQUIRED` / `MEMORY_AUTH_REQUIRED`；无真实来源证明保持拒绝，不读旧 V1 记录补答。提交未知时保留原编号并只查 receipt；恢复需要显式预览原操作。缺原纠正正文时不能凭摘要还原或生成正文。完整原生来源于15:41协调者独立验收通过（见本文件最新增量）；管理继续controller通过但UI/真实退休未完，不将整体功能标成可交付。

后续子代理按用户新要求仅使用Magpie的WorkBuddy HY4，总并发≤2（含派生）。2026-11-10新会话已验证精确路由magpie/workbuddy/hy4free（Hy4 · WorkBuddy）并接续，无Sol或父模型继承回退。

## 可转发交接块（工程阶段，不可发布）

- 版本：不 bump，仍为 0.8.8；尚无本轮提交对象，不可生成声称包含新代码的 Git 发布清单。
- 变更：Memory V2 Host 组合、独立认证 RPC、官方 QQ 身份读取、原生 root / B站接线及管理目录修复。完整文件和协议以工单及各 contract 为准。
- 验证：上述专项与实际原生 fixture；最终组合门禁、生产四渠道及实装尚未完成。
- Case：`docs/cases/2026-11-10-memory-v2-integration.md`；当前执行队列：`docs/plans/2026-11-09-memory-v2.md`。
- API：默认 V1 保留，无自动迁移、自动路由降级、自动重试模型或新 UUID 重做未知提交。
- 发布条件：补完仍开放的实现、最终门禁、制品预览和用户明确授权；本交接块不构成安装、迁移、付费调用、外发、提交或发布授权。

## 来源模块独立审查补充（2026-11-10 11:45）

冻结三文件后，主代理以同一实际Host隔离夹具独立复验：普通21项通过；native阶段providerCalls=0而非预期2，来源拒绝MEMORY_NATIVE_INPUT_UNPROVEN，admittedInputs=0。故尚未验收合法nextstep／撤销后30-token结算；错误归一化为MODEL_NOT_AUTHORIZED不能作为具体根因。当前只定位到provider admission前的reserve授权段，不修改授权规则换取通过。日志与三文件指纹见 `_backups/memory-v2-coordinator/bili-source-review/review.json`。后续修复需定位真实request/config/history的具体差异并保留全部拒绝检查；来源模块未接入生产、V2未启用。


## 来源首次拒绝修复完整逻辑与交接（2026-11-10 15:41）

1. 链路：真实Host SystemPrompt组装→header/tools与toolHistory→B包装器reserve→source prepareInput→真实adapter→预算admit。只改source-runtime请求清单与其普通/native测试及contract，定义注册/核心Host不变。
2. 机制：Host按名称排序四份schema，原验证器按注册顺序hash数组，因此provider前就拒绝；普通手工fixture与真实Host排序不同。其后fixture读取async budget.status漏await，已修且保留30tokens断言。
3. 爆炸半径：隔离Host单进程的一处来源验证读者，失败可见报错，1×1×1；无生产数据/密钥/真实付费或发送。
4. 取舍：固定批准清单并按Host标准排序，只增加一份派生常量，回滚小；无序比较或取实际请求为预期会放宽证明，拒绝采用；改共享Host排序会扩大影响且偏离实际Host契约，未采用。
5. 生效：源码加载时生效；独立fixture新建私有Host，公共运行时未重启/安装。正式加载须另行用户授权。
6. 验证：同contract中的native命令独立exit0，28普通；2provider/2inputs/2sources/1output/30tokens、owned typed read进入下一完整输入、usage后撤销阻断正文、unknown shell拒绝、无observed derived、网络/平台写零。证据 `_backups/memory-v2-coordinator/hy4-source-native-independent.log`。
7. 回滚与残余：三源码/文档原件在 `_backups/memory-v2-coordinator/hy4-resume-20261110/` 和child阶段备份；恢复指定文件不触动其它继承改动。官方来源transport/index、QQ/Douyin入口、UI/退休、迁移/切换与最终联合门禁仍未完成。

可转发发布交接块（工程增量，不可发布）：
- 文件：`plugins/surfcore/lib/bili-v2-source-runtime.mjs`、`plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`、来源contract与本case/PITFALLS/HANDOFF/计划。
- 验证：28普通和协调者实际隔离native验收通过；最终audit/regressions/全插件待全部实现冻结。
- 版本建议：整体MemoryV2最终以minor评估；本次不改0.8.8、不提交，不单独发布此半成品。
- 层级：实现层修复，外部接口不变；完整逻辑/爆炸半径见上七步。
- 失败路径：未知/篡改/重复清单与历史更新仍返回结构化MEMORY_NATIVE_INPUT_UNPROVEN及hint；按真实Host新建任务重试，不跳来源或回退V1。
- 未验证：生产四渠道、Windows/精确Node22.13、真实模型质量/平台回执/长期运行，及其余开放P0–P4工单。默认V1、无生产变更。

### 2026-11-10 17:08 · Bili 官方身份候选接缝（生产接线仍待验收）

1. 链路：`index.js` 的 Host 组合器将来提供 `getPlatformState('bili')` → `memory-v2-runtime.mjs` 核对当前官方账号/精确 route/typed targets → `resolveIdentity` 与管理页 `approvedConversations` → 既有 Host/Worker ACL。此轮仅落 runtime 接缝与普通回归，index 尚未提供生产状态。
2. 机制：有 full 原文仍需合法 requester、conversation 与处理模型授权。runtime 原先没有 Bili 分支，导致模块假 identity 测试与真实组合脱节；新增分支只识别官方状态中已知目标，并列为需明确审批的候选。
3. 爆炸半径：一个 Host 插件进程、两个消费者（身份解析和授权候选）；权限失败可见，不涉及生产数据迁移、密钥输出、付费调用或外发。
4. 取舍：采用既有 getPlatformState 注入并按目标收窄，改动小、可回滚；否决使用 config.self/Cookie 存在性或任意目标通配，会把声明当官方账号/扩大授权。
5. 生效：未来打包安装后由 Host 插件读取；本会话未安装、未重启公共运行时。默认 V1/shadow 状态不变。
6. 验证：普通 RED 捕获“Official Bili targets must appear as explicit approval candidates”；GREEN 在系统 Node 和 bundled Node24 下通过 `test-memory-v2-runtime.mjs`，含未知目标/非法 type/账号变更拒绝，合法目标在当前默认状态仍拒绝 MEMORY_SHADOW_DISABLED；语法与 `git diff --check` 通过。该测试的官方身份 provider 是隔离注入，native/真实生产入口未验收。
7. 回滚与残余：改前源码备份 `_backups/memory-v2-coordinator/bili-runtime-seam-20261110/`；如需回退只恢复本轮两文件差异，禁止覆盖其余继承改动。Bili transport 的 CSRF/redirect/顶层评论审查问题已交原 HY4 run2；生产组合与视频来源仍未完成。

可转交发布会话的增量块（仅工程进度，不是发布授权）：
- 文件：`plugins/surfcore/lib/memory-v2-runtime.mjs`、`plugins/surfcore/scripts/test-memory-v2-runtime.mjs` 与本 case/PITFALLS/计划。
- 行为：新增 Bili 官方账号约束的授权候选和身份解析；不自动授权、不切换 V2、不改版本。
- 验证：普通 Worker/runtime 管理 API 在 Node26/bundled Node24 通过，语法/whitespace 通过；真实组合/native/全项目最终门禁待后续。
- 失败与下一步：未知身份/目标可见拒绝；shadow 关闭保持 MEMORY_SHADOW_DISABLED。需先补官方 Host 注入并完成联合验收，再由管理页按原流程明确审批；不得回退旧上下文绕过。
- 范围：Memory V2 整体仍在实施，禁止把本增量发布为已完成 P0–P4。


## 2026-11-10 18:11 当前验收与独立收口

source真实隔离native首项已通过。official run2普通58项通过不能代替新增账户切换反例：getAccount用A验证mid9后，getCredentials换B，send仍以B执行fake POST且navChecks=1；协调者在 `_backups/memory-v2-coordinator/bili-account-snapshot-red.log` 留下 `Cross-account credentials must be refused before POST` / `1 !== 0`。已回派原HY4 run3/3，要求操作内不可变私有凭据快照、nav/GET/WBI/POST同快照和异步/并发切换拒绝；未验收不接入。UI原管理员ID恢复另由第二HY4按既有协议实现，Before/After为硬门槛。

用户后续明确授权完成后提交/合并清树，并确认旧语音准确提交组。该独立已完成工作现已合入dev17c9b1f，main仍94a4a78，旧语音worktree已移除且保全独有数据。Memory V2这棵树的所有继承改动保留且仍未提交；不把旧语音收口、测试数据释放11.10GiB或普通transport模块通过计作P0–P4完成。
