# 协作登记表（COORDINATION）

> **本表由“协调/发布会话”维护。任何会话开工、收工、换分支、准备合并，都必须更新自己那一行。**
> 规则见 [`docs/guides/MULTI-SESSION-WORKFLOW.md`](guides/MULTI-SESSION-WORKFLOW.md) 与 `AGENTS.md §1.9`。
> 更新时间：2026-11-08（Asia/Shanghai，本克隆已收敛main；早期跨机登记保留为历史）

## 0. 当前协调人

**本对话（协调/发布会话）**：负责
- 审阅各会话的提交范围（`git diff --cached --stat` / `git show --stat`）；
- 把功能分支合并进 `dev`（`--no-ff`），合并后重生成清单；
- 发 dev 构建 / 稳定版（**必须用户明确说“发”**）；
- 维护本表与多会话规则。

工作区：`<REPOSITORY_ROOT>`（主工作区，**只用于协调、文档、发布；不接功能开发**）。

## 1. 活跃会话

| 会话 | 工作目录 | 分支 | 负责范围 | 状态 |
| --- | --- | --- | --- | --- |
| **QQ 只读 Mac 验收** | surfcore-live-channels/surfcore-mac | feat/live-channels-acceptance | QQ 主人私聊目录任务 | 本机已安装，隔离回归和真实 QQ 收发通过，见案例 |
| **QQ 只读 Mac 文件正文** | surfcore-live-channels/surfcore-mac | feat/live-channels-acceptance | 主人私聊、已批准目录的短文本 | 本机已安装，真实 QQ 正文回传及隔离回归通过，见案例 |
| **QQ 新建 Mac 文本文件** | surfcore-live-channels/surfcore-mac | feat/live-channels-acceptance | 主人私聊、指定目录内原子新建 | 本机验收中，见案例 |
| **红豆渠道实机验收 2026-11-16** | `~/.codex/worktrees/surfcore-live-channels/surfcore-mac` | `feat/live-channels-acceptance` @ `d46612a` | QQ 原 NapCat 会话恢复、B站评论链路、DSH 伙伴入口 | 抖音→DSH 本机分享及回话已实机通过；收回临时许可导致的侧栏报红已实装修复，原本机许可有效。QQ 已实测三种消息并补验 NapCat 重启后自动快速登录同一账号、OneBot 重连。B站账号核验通过，评论收发待实机。 |
| **V1 运行时退役收口 2026-11-16** | ~/.codex/worktrees/surfcore-live-channels/surfcore-mac | feat/live-channels-acceptance | QQ、通用记忆和共用桥接管理 | 本机已装 a86cdbe，QQ 原账号与 V2 Host 已复核。审计 207/207，B 站和抖音实机待后续。见 docs/cases/2026-11-16-v1-runtime-retirement.md。 |
| **dev 修复：`publish-dev` 同步文档版本字 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-dev-build` | `dev` @ 本批 HEAD（以 `git log --oneline -6` 现读为准） | 根治「发一次 dev 构建，仓库 HEAD 的 `doc-facts` 必红」：发布脚本只改 package.json/README/CHANGELOG，漏改被 `doc-facts` 逐字校验的 `docs/ROADMAP.md` 与 `docs/guides/DSH_SETUP.md` 版本字；抽出 `scripts/publish-dev-doc-sync.mjs` 的 `syncDocVersions()`，发布时自动同步并 git add | ✅ 已提交入库 `dev`（修复 + 文档/清单）：`node scripts/test-dev-publish.mjs` → `TEST_EXIT=0`（临时目录红→绿功能自证）、`npm run doc-facts` → `EXIT=0`；随 dev 推送（快进）；随下一次 dev 构建带上 |
| **dev 测试构建 v0.9.0-dev.2：发布 + 镜像同步 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-dev-build` | `dev` @ `0a6488c`（构建 `53f71db` → 远端合成 `76310d7` → 合并 `0a6488c`） | 按 §1.5 在 `dev` 发 Pre-release `v0.9.0-dev.2`（含 setup-dsh 基座 bundle 修复 + 抖音零帧边界修复），并把远端 dev 镜像与本地对齐 | ✅ 已发布：tag `v0.9.0-dev.2` @ 远端 `76310d7`（本地 `53f71db`，tree 相同 `9118306…`）、Release 为 Pre-release；三条门禁全过（本地 `--verify-ref HEAD` 1115/1115 问题 0、远端 `verify-remote-manifest` 一致 1115/不符 0/缺失 0、`/releases/latest` 仍是 `v0.9.0`）；远端 `main` 未动（`5face06`）；发布后补了文档版本同步（`docs/ROADMAP.md`/`docs/guides/DSH_SETUP.md` → `0.9.0-dev.2`，根因见 `docs/PITFALLS.md` #160），此后 dev 提交顺推，当前 dev 头以 `git ls-remote origin refs/heads/dev` 现读为准 |
| **dev 修复：抖音共享记录零帧边界 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-dev-build` | `dev` @ `255c3e7`（修复 `91206f0` + 文档 `602f5ff` + 清单 `255c3e7` + 回填文档提交） | 把共享记录的 `frameSamples` 下界从 1 改成 0，与账本 `validCoverage` 的 0..3 对齐（抽不到画面帧的抖音项不再被判成 `DOUYIN_CHAT_STORAGE`）；补边界断言：0 可分享并原样保留、6/-1/1.5/'3' 必须拒绝 | ✅ 已提交（先红 `RED_EXIT=1` → 修后 `EXIT=0`；反向重放有牙；分享/抖音全家桶 12 条 `EXIT=0`；全量门禁八步全 `EXIT=0`：audit 207/207、manifest 1115/1115 问题 0）；本批与 setup-dsh 批已随 **dev 远端镜像同步**推到 `Rock-Connotation/surfcore-mac` 的 `dev`：`c5da206 → edf41fd`（快进，无强推；tree `0228a2f`），远端 `main` 未动（`5face06`）；此后 dev 提交按同一方式推送，当前远端状态以 `git ls-remote origin refs/heads/dev` 现读为准 |
| **稳定版 v0.9.0 发布 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-main-090`（临时工作树，发布完成后移除） | `main` @ `9424cb7` → 远端 `29d8ff9`（tag `v0.9.0`） | 按 `docs/RELEASE.md` 发稳定版：合 dev→main、bump `0.9.0`、九步门禁、Data API 推 main + 手工补 tag + 建 Release、三条门禁、发布记录 | ✅ 已发布 `v0.9.0`（非 Pre-release、`--latest`）；main 已合回 `dev`（dev = `6f96eab`）；三条门禁全过（远端 `verify-remote-manifest v0.9.0` 一致 1113/不符 0/缺失 0） |
| **dev 修复：setup-dsh 补基座 bundle 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-dev-build` | `dev` @ `c7b459b`（`6f96eab` → `37aa526` → `82eace6` → `c7b459b`） | 修"全新 profile 装完停在 `pending (waiting for service: …)`"：`scripts/setup-dsh.mjs` 缺基座时补 `@deepseek-ai/dsh-base` + 外壳 bundle；隔离宿主验收测试不再自己补基座、改为断言安装器写全 | ✅ 已提交入库 `dev`（`37aa526` 修复 + `82eace6` 文档 + `c7b459b` 清单 1113→1114）：先红 `RED_EXIT=1` → 修后 `EXIT=0`（AC1–AC3/AC6–AC8 PASS）；audit 207/207、regressions 全部通过、memory-v2 50、lint 0、doc-facts ✅、manifest 1114/1114 问题 0；本批已随 dev 远端镜像同步推到远端 `dev`（`c5da206 → edf41fd`，快进） |
| **V1 退役四轮：持久接管与抖音查询 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-r4` | `feat/v1-retirement-r4` @ `7839039`（基于 dev） | ①方案 A 真持久接管（重启后按原 requestId 重放未 dispatch 任务）②取消后 reflection 可查询原操作编号 ③越界帧数上游取回校验 | ✅ 已完成并合入 `dev`（merge `db17ec3`；功能分支 @ `59bead0`）：R4-A 合同 51→52 场景、R4-B 已交付并反向重放、R4-C 经核实关闭；冻结门禁 audit 205/205、memory-v2 50、插件 37、verify-ref HEAD 1109/1109 问题 0；G7 Mac 实机另起一轮；**G7 实机非侵入批已合入 `dev`**（merge `c74470d`；功能分支 @ `7839039`）：实机捕到 5 个 `PPID=1` 的 CLI 孤儿并定位到 `plugins/surfcore/tools/bili.mjs` 只转发信号不自退，修成有界退出 + 升级 SIGKILL（先红 7s → 修后 3–4s 退出、audit 206/206、插件套件 exit 0），用户安装的桥接 `51037` 按其批准未动；隔离实例实机留待下一轮；**dev 测试构建 `v0.9.0-dev.1` 已发布**（2026-11-15，本会话兼任发布会话）：tag/Pre-release `v0.9.0-dev.1` @ `c5da206`（仓库 `Rock-Connotation/surfcore-mac`，远端 dev 分支 `748afe6 → c5da206`），本地构建提交 `06edb3d` 与远端发布提交 tree 逐字节相同；三条门禁 = 本地 `--verify-ref HEAD` 1111/1111 问题 0、远端 `verify-remote-manifest` 一致 1111/不符 0/缺失 0、Release 为 Pre-release（`/releases/latest` 不含）；版本线 dev = `0.9.0-dev.1`、stable 目标 `0.9.0`（未发）；测试机切 dev 通道后点「检查更新」 |
| **G7 第二阶段：隔离实例真实宿主验收 2026-11-15** | `/Users/shizihan/Daily/Github/surfcore-g7-phase2` | `feat/g7-phase2-host-acceptance`（基于 dev @ `a234f4b`） | 在隔离 `DSH_HOME`/profile 里装本工作树的 SurfCore，用真实应用二进制起 `@deepseek-ai/dsh-desktop-host`，验收真实 loader 激活、shutdown 零残留、守门进程内零非回环外联 | ✅ 已合入 `dev`（merge `1db3ed9`；功能分支 @ `d6a68a3`）：AC1–AC3/AC6–AC8 PASS、AC4/AC5 环境阻断、AC9 反向重放红→绿、`npm run test:audit` 207/207 |
| **V1 退役三轮审查修复 2026-11-13** | `/Users/shizihan/Daily/Github/surfcore-v1-retirement-r3` | `feat/v1-retirement-r3` @ `1125d3e`（基于 dev） | 第三轮复审 P1/F01–F05 + N01、P2/F08+F10、F12/F13 收口（只做离线修复与门禁；Mac 实机另立一轮） | ✅ 已完成并合入 dev（merge `ad65bc9`；功能分支 `feat/v1-retirement-r3` @ `9d7e235`）：冻结快照门禁全绿 —— test:audit 204/204、regressions 17/17、memory-v2 48/48、插件套件 exit 0（PASS 37 ordinary scripts；native/UI 未跑）、lint:failures/doc-facts/verify-ref HEAD/preset patches exit 0；case 见 docs/cases/2026-11-15-v1-retirement-r3-offline-fixes.md；下一轮：Mac 实机（G7） |
| **V1 退役与二轮审查 2026-11-13** | 工作树已合并收口（分支保留） | 已合入 dev（合并提交 + 清单 0a35a93） | 六项 V1 破坏式删除 + R01–R10 审查收口 + 二轮审查（F01–F12：模式阻断可见性/DM稳定pending/ACK/调度退役生命周期/单轮V2写回） | ✅ 完成：主树未跟踪 2026-11-12/ 已隔离至 _backups；合并后主树 npm run test:audit 195/195、test:regressions 17/17、test:memory-v2 48/48、v2-real-integration 12/12、lint:failures 退出0（债务658≤669）、doc-facts 退出0、verify-ref HEAD 一致（1096项 0问题）；case 见 docs/cases/2026-11-12-v1-retirement.md；未 bump/未发布 |
| **PRD 拍板修订 2026-11-12** | 工作树已清理（分支 `feat/prd-revision` 保留） | 已合入 dev（合并 4638e28 + 清单 c3d388f） | PRD/IMPROVEMENTS/ARCHITECTURE 拍板修订（docs/product/ 四份）+ V1 清单盘点（只盘不删）+ 设置分叉核查（结论：无分叉）+ 合并 feat/doc-facts 回 dev | ✅ 完成：合并后主树 audit 195/195、lint 退出0、doc-facts 退出0、verify-ref HEAD 一致；case+交接块见 docs/cases/2026-11-12-prd-revision.md；未 bump/未发布；入口文档改写与"默认只开QQ"待另立批次 |
| **A6 失败可见性 2026-11-12** | 工作树已清理（分支 `feat/a6-failure-visibility` 保留） | 已合入 dev（合并 480d720 + 清单 6447888） | lint-failures 静态检查+棘轮基线；B站扫码/更新/TTS/语音包 P0 链路补 code+hint；client.js catch 审计 | ✅ 完成：合并后主树 audit 195/195、lint 退出0（债务669入册）、verify-ref HEAD 一致；case+交接块见 docs/cases/2026-11-12-a6-failure-visibility.md；未 bump/未发布；产品拍板「默认只开QQ」待另立批次 |
| **文档事实校正与 doc-facts 2026-11-12** | 工作树已清理（分支 `feat/doc-facts` 保留） | 已合入 dev（合并 8b14402，含于清单 c3d388f） | A2 平台事实与易腐数字校正；A3 离线文档校验脚本（口径：控制台按出现次数、src 含 presets）；A1 文档表达（不删渠道） | ✅ 完成：合并后 doc-facts 退出 0、audit 195/195；case 见 docs/cases/2026-11-12-doc-facts-and-platform-correction.md；未 bump/未发布 |
| **功能提交与安全清理 2026-11-12** | 主目录；两个临时worktree已移除 | `dev`；main保持9eb4028 | 四批功能提交、合并复核、无用目录清理 | ✅ 完成：audit195/协议17/完整插件/Memory49/Phase A–E全过；仅保留主树与dev/main；用户明确不备份，七目录及归档中间副本已删，真实运行数据未动；见清理case |
| **本地 Agent 审查与实施 2026-11-11** | `/Users/shizihan/Daily/Github/surfcore-mac` | `refactor`（历史分支已删，成果已入main/dev），基线 `748afe6` | 阶段 A-E：目的受众/终态取消/V2时间与摘录/TaskHarness准入/任务账本/文件整理/受限命令/Mac原生应用/自主生活 | ✅ 完成：Phase A/B/C/D/E 全阶段实施与独立验收；audit 191/191、regressions 17/17、memory-v2 47/47全绿；保持V1默认、未发布 |
| **QQ V2 不回复根治 2026-11-11** | `../surfcore-qq-reply-fix` | `fix/qq-reply-discovery`，748afe6 | scope契约/Native正式组合/私有发送回执/失败可见/生产适配器/测试隔离/原角色恢复 | 已收工：tree3927fa47实装400项一致+官方HMR/桥接28234；app8/预算50亿/revision4。真实私聊语音1105838883、群@1904687227双读回，用户确认播放和回复；原生QQ同页预览取消/历史许可L2确认与去重已验。audit195/协议17/插件完整覆盖+Memory34/SDK离线及官方包消费通过。四批提交4b86c0d/03e4581/7227f5f/2b9d625已合dev；本轮按用户要求无备份清理独立树，运行数据与回滚保留，未发布。 |
| **记忆层 V2 2026-11-09** | `../surfcore-memory-v2`（已清理） | `feat/memory-v2`（已删） | P0–P4；来源/四渠道/事务/生命周期/迁移与门禁 | ✅ 完成：工程实施与验收全量通过，已合入本地 dev（2026-11-11）。QQ Native/Bridge闭环、Bili托管单轮与退役ACK、P4脱敏迁移预览全过；套件47/47、audit 187/187、regressions 17/17全绿；保持V1默认。已按用户确认清理临时树与分支。 |
| **Harness请求修复 2026-11-11** | ../surfcore-harness-throttle | fix/harness-throttle；基线dev17c9b1f | 本机bili冷却配置/原生原会话验收/断点记录 | ✅ 完成：原生原会话回复成功、离线限流5项、Node24 audit187/187、diff-check通过；业务树未改、未提交/不安装V2/不发布 |
| **QQ语音分群额度 2026-11-10** | `../surfcore-voice-quota-integrated` | `feat/voice-quota-integrated`，基线17c9b1f | 日500/月90万、CONFIG_STALE、群停答恢复及语气提示朗读修复 | 主代理完成，run 1；语气提示两provider过滤及桥接错误回归通过，audit191/协议17/插件/离线App包通过；20:08实装e319350a，357文件一致，桥接27748在线，配置/两账哈希不变；20:16查明收尾为PI_AI_ERROR/SSE坏JSON，原会话续跑与SDK离线验证通过，未改Host；无真实TTS/测试外发/UI/提交发布 |
| **火山语音接手续作 2026-11-08** | `../surfcore-volc-voice` | `feat/volc-voice-mac`，基线94a4a78 | 冻结候选、常用安装、受控语音验收与废弃构建隔离 | ✅ 完成：最终tree25c95975，audit187/协议17/插件67/TTS14与窄复核通过；隔离/常用4749一致；修复真实流式WAV后原生合成0.99秒，MCP注册/仅主人QQ1条读回+手机播放确认；6次24字预留保留；废弃构建/缓存清理，源码/原程序/数据可回滚；普通DSH/QQ运行，不提交发布 |
| **火山语音 2026-11-08** | `../surfcore-volc-voice` | `feat/volc-voice-mac`，基线94a4a78 | 火山TTS 2.0离线适配与Mac语音管理；仅指定工作树 | 火山provider、密钥管理/UI、QQ发送与可选容器内联已实现；QQ配置事务、草稿戳及规则部分更新补修后，Node24隔离audit 187/187、协议17项、完整插件通过；可冻结为离线测试候选，仍待独立复核和真实验收；路线已记ROADMAP，案例已补录终止帧与多WAV离线边界；提交后安装清单与实机未完成；未主动访问真实凭据、云API或容器，未发送QQ；一次Host测试可能请求本机桥接状态，首轮夹具曾读写树根config/state且原状态未核验，另有假夹具曾写系统临时目录；详见案例；未部署、提交或发布 |
| **语音管理解耦 2026-11-08** | 主目录；临时voice-host树已清 | 已合main 6da9b6d，修复497598a/实装00f5c45；临时分支已删 | Host/旧桥接共享管理、UI/概览/启停及实机 | ✅ 完成：audit176/176、协议17、完整插件/独立V3及窄增量、349制品一致/6074持久不变；QQ关闭原生列表200/未配置失败明确，常用正常无debug启动；不选引擎、不新增模型/外发、不发布 |
| **本地主线与磁盘收口 2026-11-08** | 主目录 | main，功能合并5c748d0 | 合并/保全/41工作树与分支清理 | ✅ 已完成；只保留main/1目录，221文件保全，ASR逐SHA压缩；三门禁通过，常用cwd已迁回，无远端/版本动作 |
| **伙伴自然分享与聊天 UI 2026-11-07** | ../surfcore-sharing-ui | feat/sharing-ui；已合组合树 | 日记分享、侧栏未读、本机回复及生命周期 | **已合main，分支/worktree已清理**；历史交付记录：✅ worker完成；主线统一revision/初始定位补修、UI30/旧UI11/真实controller/独立V3与原生常用验收通过；实装f882468，无版本变更 |
| **自然分享组合 2026-11-07** | `../surfcore-companion-sharing` | `feat/companion-sharing`，基线3ab73bd；实装f882468 | DSH自然分享/可回复/共享额度与实机组合 | **已合main，分支/worktree已清理**；历史交付记录：✅ 已交付常用：348制品一致，2真实观看+1接话/重启通过，11/12保留；日常开启、无debug正常运行；完整门禁/独立复核通过，无外发/发布 |
| **抖音陪伴升级 2026-11-07** | `../surfcore-companion`；媒体/引擎/外观/召回各独立树 | `feat/douyin-companion`，基线244eba1 | 已确认prompt的人格/媒体理解/日记/有界调度与组合验收 | **已合main，分支/worktree已清理**；历史交付记录：✅ 已交付常用DSH；少女原生显示/完整音轨/新进程真实回忆通过，8/12请求、8上游200，原13插件保留；上海12:30/20:30日常开，QQ/B站关；stage退休，无发布；长期观察未验 |
| **经历后自然分享引擎 2026-11-07** | ../surfcore-sharing-engine | feat/sharing-engine；已合组合树 | opt-in开场与纯文本HY3 adapter | **已合main，分支/worktree已清理**；历史交付记录：✅ V3独立复核/原反例红绿，完整门禁及真实2视觉+1文本通过；主线重生清单，11/12旧账保留 |
| **抖音推荐失败定位 2026-11-07** | `../surfcore-readiness` | `fix/macos-readiness`，功能faa7976，实装6c88e72 | 首页初始化/确认翻页/最终身份刷新与取消边界 | **已合main，分支/worktree已清理**；历史交付记录：已收工：严格service与官方App原生按钮均获5条原固定feed；audit174/174、回归/插件、红绿和独立复审通过。330实装文件一致、670持久文件未变；本轮模型/互动0，旧账不增。新副本渠道关闭、8进程/2端口及锁全停；原profile/常用App保留，无发布 |
| **macOS收口 2026-11-07** | `../surfcore-readiness` | `fix/macos-readiness`，基线eca92c1，已验程序d8fe7e1 | Hy4根因、Hy3补验、记忆来源、隐私核清、抖音来源 | **已合main，分支/worktree已清理**；历史交付记录：已收工：B站Hy3回忆逐字通过；QQ重启普通私聊官方/平台/手机一致；audit174/174、完整插件/构建、strict隐私0。最终4/4客户端、4上游、原QQ9/9文本，旧账保留；owned实例/代理/桥接/固定容器/8端口全停，常用App和其它5容器不动。抖音推荐在后续补修行已验；自动注入/迁移、睡眠24h等仍未验；无发布 |
| **QQ 常驻/审批 2026-11-07** | `../surfcore-qq-resident`；全部独立worker保留 | `feat/qq-resident`，实装0502afa | 手动后台、审批/问答与安全恢复 | **已合main，分支/worktree已清理**；历史交付记录：本轮有界验收收口：注册/3MCP、后台私聊、允许/拒绝/文字问答/取消、过期零LLM、完整stop/扫码resume、无debug实际私聊双端及Quit9进程退出后恢复通过。audit169/169及回归/插件0，325文件一致；11/12模型、19/30文本，诊断和QR清场，独立受控实例留开。选项A/24h/睡眠未验，不续额、不发布 |
| **QQ macOS 补齐 2026-11-07** | `../surfcore-macos-implementation`；worker独立qq-model/qq-host/qq-runtime/qq-gateway保留 | `feat/macos-implementation`，程序e013302，文档后续 | QQ传输、原生宿主与模型失败保护/真实私聊 | **已合main，分支/worktree已清理**；历史交付记录：受控私聊收口：扫码/包内SDK/官方App/Hy4/QQ回执及用户收到均通过；2/3模型含自动标题、1/6文本；audit164/164、回归/插件0、Astra R2无新增P1/P2；实例/代理/容器/端口全停，数据保留、默认选择恢复，常用App不动；群/问答审批/常驻未验，未发布 |
| **B站自主单轮补验 2026-11-07** | `../surfcore-macos-implementation`；worker独立round/receipts/partial-review保留 | `feat/macos-implementation`，程序744d64a，文档后续 | Host受控单轮、评分/动态失败可见、显式部分续评与真实App | **已合main，分支/worktree已清理**；历史交付记录：本轮收口：Hy4真实自主选题及范围临时点评通过、仅一条测试动态匿名读回通过；正式评分/主观记忆/其它外发未验。audit164/164、回归/插件0；3次Hy4，实例/端口关闭，常用App不动；未发布 |
| **macOS 工具与文档整理** | `../surfcore-tooling-docs` | `docs/tooling-macos`（基线 `0deb826`） | 开发工具路由、macOS 设计归档、开发提示词；仅文档 | **已合main，分支/worktree已清理**；历史交付记录：文档及提示词完成，按功能分三批本地提交、未推送；audit 首轮 136/143，安装修正后 1 项复测通过、余 6 项；插件更新器基线失败；本地设计另行交接 |
| **macOS 首期实施 2026-11-06** | `../surfcore-macos-implementation` | `feat/macos-implementation`（交接0c51bf2，本克隆无dev） | WP0–WP5，独立数据根，本地提交 | **已合main，分支/worktree已清理**；历史交付记录：b9已真实官方App/只读扫码/96秒无字幕ASR/人工记忆闭环/角色护栏/退出恢复/包回滚；原App与常用profile不动，无外发或付费模型。新数字全零幻觉补修通过局部与独立审阅，最终47e7e73：audit163/163、回归/插件通过；原生零PCM/241秒/96秒B站复验、Finder隔离启动/关窗与退出完成；实例和端口已关闭、数据保留；设备/质量矩阵未全验，未发布；收工关闭测试调试端口 |
| **协调/发布**（本对话） | `<REPOSITORY_ROOT>` | `dev` | 规则、登记表、合并、发版 | 进行中 |
| **bug 修复** | `<WORKTREE_ROOT>` | `fix/release-0.8.7` @ `e20a464` | 3c99c54..e20a464 的修复 | ✅ 已在 dev 历史内；等新交接 |
| **Minecraft 拓展** | `<WORKTREE_ROOT>` | `feat/minecraft` @ `f3bd46f` | MC 平台适配器/工具集/卡片/记忆 scope | ⏸ 已从 dev 撤回，分支保留；等完成 |
| **向量记忆** | `<WORKTREE_ROOT>` | `feat/vector-memory` @ `9e7e737` | 向量记忆交接书 + docs 索引 | ⏸ 已从 dev 撤回，分支保留；等完成 |
| **更新本地改动修复**（协调代做） | `<WORKTREE_ROOT>` | `fix/update-local-modifications` @ `3a7aaa9` | 本地改动「备份并覆盖」出口 + deterministic + 诊断 | ✅ 已合并 `d75dea8`；**未发布**，等 bug 修复交接 |
| **小红书平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-xiaohongshu` | 只读 adapter/身份/记忆/prompt/卡片 | 🕒 交接已写，待启动 |
| **贴吧平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-tieba` | 先解决内置 `tieba` 占位；只读 adapter | 🕒 交接已写，待启动 |
| **抖音账号/推荐流 2026-11-07** | `../surfcore-douyin`；browser worker独立树 `../surfcore-douyin-browser` | `feat/douyin-channel`，基线320b2d7 | Context7/GitHub调研、独立浏览器扫码、身份核验和真实推荐流只读 | **已合main，分支/worktree已清理**；历史交付记录：已启动：用户优先账号登录与推荐流；F2低层feed可参考但无扫码，Download API v5非个人推荐方案。选择独立profile浏览器路径验证；QQ既有受控常驻不动，不沿用其剩余模型预算，无发布 |
| **微信平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-wechat` | 先确认公众号/个人微信；个人微信不做自动化 | 🕒 交接已写，待启动 |

### 本轮“合并后又撤回”记录（用户要求：未完成，不进下一版）

| 分支 | 原合并 | 撤回提交 | 现状 |
| --- | --- | --- | --- |
| `feat/minecraft` | `961c21a` | `9c31d7b` | 分支 `f3bd46f` 保留；dev 已移除 MC 代码 |
| `feat/vector-memory` | `a52c03a` | `02ca250` | 分支 `9e7e737` 保留；dev 已移除交接书 |
| `fix/release-0.8.7` | 无需合并（`e20a464` 已是 dev 祖先） | — | 保留在 dev |

另：MC 的 UI 原本混在 `4d2d7c3`，本轮用一个单独提交从 `dev` 移除（不 rewrite 历史）。
**MC 完成后再合并时，需要把 UI 作为新提交重新加回**（因为 dev 已删除，分支本身没有新增这段）。

### 本轮已合并、未发布

| 内容 | 合并提交 | 状态 |
| --- | --- | --- |
| 本地改动「备份并覆盖」修复 | `d75dea8` | 已进 dev；`b1e8e7d` 清单/验证；**未发 dev.11**，等 bug 修复会话下次交接 |

当前 `dev`：`b1e8e7d`（干净，126/126，625 files）；最新已发布仍是 **dev.10**；稳定版 `0.8.6`。

## 2. 当前遗留

1. MC 的 handoff `2026-11-02-mc-agent-integration-batch1.md` 已从主工作区移到
   `_backups/2026-11-02-mc-agent-integration-batch1.md`；MC 会话需要的话从那里取，或重新提交。
2. MC 分支 `feat/minecraft` 里仍有 UI 的历史内容，但 dev 已删；合并前要确认 UI 重新加回。
3. 向量记忆只有交接书，等实现时另开 `feat/vector-memory-impl`。
4. bug 修复的新交接还没到；到之前不构建、不发版。

## 3. 各会话接下来要做的

### 3.1 bug 修复会话

- `e20a464` 已在 dev；当前 dev 已回到“只有 bug 修复 + 协调文档”的干净状态；
- 继续修 bug 请从最新 `dev` 切 `fix/<topic>`，在 `surfcore-bugfix` 工作树里跑测试；
- 完成一个可合并单元后，按 §4 发合并请求。

### 3.2 Minecraft 会话

- 你的 `f3bd46f` 还在 `feat/minecraft`，没有丢；但**已从 dev 撤回**；
- 继续在 `surfcore-mc` 工作树完成 preset / 事件泵 / 进程托管；
- 完成并自测后，**把 UI 作为新提交加回**（dev 已移除 `McTab`），再发合并请求；
- 合并前先 `git merge dev` 跟上最新，解决可能冲突。

### 3.3 向量记忆会话

- `9e7e737` 还在 `feat/vector-memory`，没有丢；但**已从 dev 撤回**；
- 等实现阶段另开 `feat/vector-memory-impl`；交接书本身可等实现完成后再一起合。

## 4. 合并请求格式（各会话发给协调会话）

```text
【合并请求】
分支：feat/<topic>
commit：<hash>
范围：<一句话>
改到的文件：<列表>
测试：test:audit <N/N>；插件测试 <0 失败 / 具体>
风险/未验证：<...>
是否已 rebase/merge 最新 dev：<是/否>
```

协调会话收到后：

1. `git show --stat <hash>` 核对范围；
2. 在独立工作树/临时目录跑测试（不污染主工作区）；
3. `git merge --no-ff` 到 `dev`；
4. 从合并后的 HEAD 重生成 `release/install-manifest.json`（单独提交）；
5. 更新本表状态。

## 5. 决策记录

| 时间 | 决策 |
| --- | --- |
| 2026-11-02 14:40 | 确立“一会话一工作树”；主工作区只做协调/发布；禁止 `git add -A`；合并/重启/发版串行 |
| 2026-11-02 14:40 | 已污染的 `4d2d7c3` 不 rewrite 历史，记录在案，后续 MC 补干净提交 |
| 2026-11-02 14:40 | 本对话成为唯一协调/发布会话；各会话通过本表 + 合并请求交接 |
| 2026-11-02 15:05 | 曾合并 vector（a52c03a）与 MC（961c21a）；后按用户“未完成，先不发”撤回 |
| 2026-11-02 15:10 | 撤回两个合并（9c31d7b / 02ca250），并从 dev 移除 4d2d7c3 带来的 MC UI；分支保留，等完成再合 |
| 2026-11-02 15:55 | 修复 dev.10 本地改动卡更新：加「备份并覆盖」出口 + deterministic + 诊断，合并 d75dea8 |
| 2026-11-02 16:08 | 用户要求“先不发”，等 bug 修复会话下次交接再决定 dev.11 |
| 2026-11-03 04:05 | 发布 v0.8.7（0.8.6 以来全部 dev，74 commits / 105 files）；远端 main 90872a7，镜像 f849cc4；归档 678/0；main 已合回 dev |

## 2026-11-10 合并 worktree 清理规则核验

用户授权默认清理已完成并合并的临时 worktree，规则见多会话工作流 §4.1。本次未删除目录：

| 路径 | 核验结果 | 处置 |
| --- | --- | --- |
| `/Users/shizihan/Daily/Github/surfcore-mac` | 主工作区，15 个未跟踪条目 | 保留 |
| `/Users/shizihan/Daily/Github/surfcore-memory-v2` | 本会话，118 个 tracked/untracked 状态条目，仍实施中 | 保留 |
| `/Users/shizihan/Daily/Github/surfcore-volc-voice` | 47 个未提交状态条目及 ignored 内容 | 保留 |
| `/Users/shizihan/Daily/Github/surfcore-voice-quota-500` | 干净，但 reflog 显示 17:35:58 刚从 HEAD 新建；无交付/合并证据 | 保留新任务树 |

这些分支 HEAD 均为 `94a4a78dcb48b1d7433f07754b9714d75da7e1e5`，祖先关系不能证明任务交付。以上数字是核验时快照，后续删除前必须重查。未清理备份、分支或其他会话内容；本次释放 0 字节。
