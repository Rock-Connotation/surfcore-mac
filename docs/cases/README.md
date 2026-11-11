# 案例索引（每次修 bug 都要在这里留一条）

> 规矩：**修完一个 bug，必须写一份 case 记录并在此登记**（模板见 [`_TEMPLATE.md`](_TEMPLATE.md)）。
> 目的：下次遇到相似现象能直接搜到「当时怎么定位、怎么修的、怎么验证的」，
> 而不是从头再猜一遍。只写结论不算记录，至少要有：现象、根因、修法、验证、影响面。

| 日期 | 案例 | 一句话 | 版本 |
| --- | --- | --- | --- |
| 2026-11-11 | [Bili 受控单轮所选模型正向 V2 接线与退役 ACK](2026-11-11-memory-v2-bili-manual-round.md) | 模型路由校验派生、V2 上下文纯净构建与调度器退役 ACK 闭环 | 验收通过，未安装 |
| 2026-11-11 | [Memory V2 迁移盘点安全预览暴露与隔离区完整性](2026-11-11-memory-v2-migration-preview.md) | 管理面板 cleanPreview 安全透出统计指标，隔离区严格保留且未获批准不切生产 | 验收通过，未安装 |
| 2026-11-11 | [QQ V2 原生来源运行时与 Bridge 联合闭环](2026-11-11-memory-v2-qq-source-runtime.md) | 来源包/Core召回/Native Owner/账本与单次租约闭环，普通4例与实际Native探针通过 | 阶段验收，未安装 |
| 2026-11-11 | [Bili V2 Native 记忆召回与输出 Finish 完整性](2026-11-11-memory-v2-bili-native-recall.md) | 强制核验 Core prepared recall 文本与 manifest，输出 complete 严格要求合法 finish | 模块验收，未安装 |
| 2026-11-11 | [QQ V2 Native 语法账本：全集路由与 tool-calls 完成](2026-11-11-memory-v2-qq-native-ledger.md) | 支持完整合法 Core 路由全集、正常 tool-calls 结束判定及非负 safe integer 块索引 | 模块验收，未安装 |
| 2026-11-11 | [QQ Native owner：实际所有权与前置预算](2026-11-11-memory-v2-qq-native-owner.md) | owner独立SDK通过；来源/Bridge仍待接线 | 模块接受，未安装 |
| 2026-11-11 | [Native Root 可重试退役](2026-11-11-memory-v2-native-retirement-ack.md) | 原资源失败重试、创建竞态、12例与实际SDK Root通过 | 阶段接受，未安装 |
| 2026-11-11 | [Bili 凭据退役屏障](2026-11-11-memory-bili-credential-retirement.md) | 保存前ACK、换号归档可恢复、10例及通知回归通过 | 阶段接受，未安装 |
| 2026-11-11 | [旧来源稳定标识记账](2026-11-11-memory-v2-legacy-registry.md) | SQLite不透明身份映射；原规划器22/39通过，未接生产观察/导入 | 模块接受，未安装 |
| 2026-11-11 | [Memory Bili Host装配与接收观察](2026-11-11-memory-bili-host-wiring.md) | Source39与实际SDK2/30、index L2失败和旧单轮后端护栏；公开读取联合已通过 | 阶段验收，未安装 |
| 2026-11-10 | [Bili Host组合入口：实施中](2026-11-10-bili-v2-host-composition.md) | ordinary与局部native工厂通过（合成预激活夹具）；index装配增量见11日case，公开读取联合已通过；全生命周期仍待 | 未完成 |
| 2026-11-10 | [Bili V2 DM selector保真](2026-11-10-bili-v2-dm-trigger.md) | 真实CLI10项、19位msgKey原样、非法值省略且保留V1过滤 | 模块接受，生产组合待办 |
| 2026-11-10 | [Memory V2 真实宿主加载](2026-11-10-memory-v2-native-environment.md) | 11真实模块、owner/privateRoot/close，以及经loader的完整来源2/2/30 | 模块接受，生产组合待办 |
| 2026-11-10 | [Bili V2 原件与回复坐标](2026-11-10-bili-v2-trigger-projection.md) | sourceRoot保真、严格selector、同OID原件0与回复31的联合验证 | 未安装，Host接线待办 |
| 2026-11-10 | [Memory V2 抖音鲜活身份接线](2026-11-10-memory-v2-douyin-identity.md) | 真实getter接线、固定忙碌提示、权限候选隔离；无身份缓存 | 未安装，联合门禁待办 |
| 2026-11-10 | [Bili V2 退役上下文释放](2026-11-10-bili-v2-retirement.md) | 实际退役 ACK 后释放活跃引用，37/30 项与 2/2/30 native | 模块验收，生产组合待办 |
| 2026-11-10 | [Bili V2 真实写命令](2026-11-10-bili-v2-write-workers.md) | comment/DM 实际 fork+IPC+official 10项；Host-only凭据与未知不重发 | 未安装 |
| 2026-11-10 | [Memory V2 原ID恢复 UI](2026-11-10-memory-v2-admin-resume-ui.md) | 原文摘要保真、不可信回执查原ID并阻止重复提交；真实React双视口对比 | 隔离UI验收，生产组合待办 |
| 2026-11-10 | [Bili V2 同凭据官方传输](2026-11-10-bili-v2-official-transport.md) | 76项；跨账号0 POST、晚关闭/取消0 fetch、精确ID与完整坐标 | 模块独立验收，生产组合待办 |
| 2026-11-10 | [Bili V2 托管动态 worker](2026-11-10-bili-v2-managed-worker.md) | 固定意图、来源账号传递与官方回执 ID，普通/实际Host/完整来源分层验证 | 未安装，P0–P4续做 |
| 2026-11-10 | [合成 ASR 测试音频清理](2026-11-10-synthetic-audio-cleanup.md) | 55 批逐内容压缩保全后移除，实测释放约 11.10 GiB | 无版本/生产变更 |
| 2026-11-08 | [语音管理解除QQ依赖](2026-11-08-voice-management-independence.md) | Host共享管理、失败可行动、配置保持与并发归属 | 门禁/独立复核/常用原生通过，未配引擎/未发布 |
| 2026-11-08 | [本地主线与worktree收口](2026-11-08-local-worktree-consolidation.md) | 合并历史、保全中间稿、42→1分支/工作树与磁盘回收 | 三门禁通过，本地未发布 |
| 2026-11-07 | [自然分享与DSH本机接话组合](2026-11-07-companion-natural-sharing.md) | 追加对话、同源API、共享额度与幂等 | 门禁/独立复核/2观看1接话/常用重启通过，11/12 |
| 2026-11-07 | [自然分享引擎与纯文本回复](2026-11-07-companion-sharing-engine.md) | 同一视觉请求生成开场、人格分层与用量 | 独立V3与真实视觉/文本通过，已组合 |
| 2026-11-07 | [DSH内分享与回复界面](2026-11-07-companion-sharing-ui.md) | 未读入口、同页回复、角色与退出护栏 | UI30/真实控制器/独立V3/常用原生通过 |
| 2026-11-07 | [少女鲸鱼娘迁入常用DSH](2026-11-07-companion-common-migration.md) | 白名单迁入、inbox身份重绑、保留插件账户与额度 | 常用原生模型/记忆及无debug重启通过 |
| 2026-11-07 | [少女鲸鱼娘本机立绘](2026-11-07-companion-girl-portrait.md) | 按角色/epoch读取本机WebP，超时/切角/失败可行动 | 原生少女显示/缺图与刷新恢复通过 |
| 2026-11-07 | [抖音完整感受理由召回](2026-11-07-douyin-recall-reasons.md) | 摘要与理由分存，清晰非私密条目按受众投影 | 离线红绿与真实新进程HY3完整回忆通过 |
| 2026-11-07 | [抖音少女鲸鱼娘陪伴组合](2026-11-07-douyin-companion-integration.md) | 统一身份、ASR/稀疏帧/日记/额度与本机形象 | 完整音轨/实际回忆/常用迁入通过，日常已启用 |
| 2026-11-07 | [抖音有界活动与调度](2026-11-07-douyin-companion-engine.md) | 持久12次验收、每日两轮、转场取消与失败暂停 | 专项与独立V2通过 |
| 2026-11-07 | [抖音音轨与稀疏关键帧](2026-11-07-douyin-companion-media.md) | 固定首页材料、严格下载、实际时长与完整性边界 | 真实ASR/3帧通过，尾部缺口保留partial |
| 2026-11-07 | [抖音交互播放器就绪](2026-11-07-douyin-interactive-readiness.md) | 排除SSR quickPlayer，等待可交互推荐应用 | 专项与真实固定feed通过 |
| 2026-11-07 | [直接模型用量持久确认](2026-11-07-direct-usage-durability.md) | durable opt-in保留旧批处理默认，失败不回true | 故障注入与独立复核通过 |
| 2026-11-07 | [抖音新回执与首键恢复](2026-11-07-douyin-navigation-receipt.md) | 新feed在await中到达也停止，8/9键有界 | V2复审及真实3键5项通过 |
| 2026-11-07 | [抖音官方播放入口与字节核验](2026-11-07-douyin-media-playback.md) | 同feed官方跳转、公开UA/固定Referer、长度一致 | 真实200下载及独立复核通过 |
| 2026-11-07 | [抖音官方 App 接线](2026-11-07-douyin-native-integration.md) | 独立账号、手动推荐、身份/角色/退出边界与设置页 | 实施中，真实账号推荐待复验 |
| 2026-11-07 | [渠道盘点与抖音选型](2026-11-07-douyin-source-selection.md) | Context/GitHub 来源及浏览器与 API 路线比较 | 研究完成，功能另行验收 |
| 2026-11-07 | [QQ 过期交互编号](2026-11-07-qq-expired-interaction.md) | 严格模式无 pending 的编号回复可见拒绝，不进入模型或记忆 | 专项及真实迟答零模型增量通过 |
| 2026-11-07 | [DSH 注册修复按钮](2026-11-07-dsh-registration-repair.md) | 安装根/profile 明确；包安装只补 MCP，保留代码和链接 | 专项、原生点击与重启MCP通过 |
| 2026-11-07 | [DSH 健康检查实例范围](2026-11-07-dsh-health-scope.md) | 只核对当前 DSH_HOME/profile；健康后确认旧 L2 | 专项、当前profile真实复核/L2解除通过 |
| 2026-11-07 | [自包含包 QQ 模式路径](2026-11-07-package-patch-anchor.md) | 移除构建器重复前缀，保留 patch 相对锚定；官方函数变异验证 | 专项及官方CLI重装325文件一致通过 |
| 2026-11-07 | [QQ 有界手动恢复](2026-11-07-qq-manual-recovery.md) | 同源安装、PID所有权、缓存登录失败后扫码resume、无调试状态 | 完整stop/恢复、无debug退出及私聊双端通过 |
| 2026-11-07 | [QQ 手动常驻与审批交互](2026-11-07-qq-resident-approval.md) | 所有权启停、启动锁和带编号交互；独立官方 App 受控验收 | 有界验收收口，真实交互/恢复私聊双端通过 |
| 2026-11-07 | [QQ macOS 组合与传输准备](2026-11-07-qq-macos-integration.md) | 独立容器、宿主入口与模型失败保护；官方App真实单私聊及用户收到 | 受控私聊通过，其它待验 |
| 2026-11-07 | [QQ 模型选择失败停止投递](2026-11-07-qq-model-selection.md) | 新旧会话模型失败均停止，固定模型可禁止目录替代 | 专项/组合及真实Hy4私聊通过 |
| 2026-11-07 | [QQ macOS WebUI 打开](2026-11-07-qq-macos-webui.md) | 按平台等待打开命令回执，失败可行动且无未监听ENOENT | 专项/组合通过，跨平台真机待验 |
| 2026-11-07 | [部分素材显式续评](2026-11-07-bili-provisional-review.md) | 已选视频仅对已处理范围生成临时点评，保留缺口且不正式评分 | 真实范围临时点评通过，完整门槛保留 |
| 2026-11-07 | [B站受控单轮组合](2026-11-07-bili-round-integration.md) | 官方App内两次无工具模型选题/点评、调度隔离及真实动态验收边界 | 真实选题/临时点评及一条动态通过，保留未验 |
| 2026-11-07 | [B站自主单轮状态机](2026-11-07-bili-controlled-round.md) | 完成材料后才点评、身份冻结、评分读回与取消 | 真实选题通过，完整自主评分未通过 |
| 2026-11-07 | [B站动态回执](2026-11-07-bili-dynamic-receipts.md) | 审批账号、固定动作意图、未知不重发和角色记账 | 一条测试动态真实通过，其它外发待验 |
| 2026-11-06 | [ASR全零静音幻觉](2026-11-06-asr-exact-pcm-silence.md) | 严格PCM全零时跳过推理，非零与部分范围保守处理 | 原生零/长/语音通过 |
| 2026-11-06 | [ASR核心区间重试](2026-11-06-asr-boundary-core-retry.md) | 严格校验、有界重解码、跨界句保留与派生缓存隔离 | 原生241秒通过 |
| 2026-11-06 | [感知作业失败界面](2026-11-06-perception-job-ui.md) | 缺失范围、警告原因与恢复操作可见 | 原生成功/失败/恢复通过 |
| 2026-11-06 | [人格编辑器角色隔离](2026-11-06-persona-editor-role-epoch.md) | id/epoch重建、旧响应禁止保存、明确重新读取入口 | 原生切角/保存通过 |
| 2026-11-06 | [人格API身份护栏](2026-11-06-persona-api-epoch.md) | 过期草稿在任何备份/写入前409拒绝 | HTTP及原生409通过 |
| 2026-11-06 | [B站生命周期夹具](2026-11-06-bili-lifecycle-fixture.md) | 显式测试Node、就绪信号与取消后的子进程退出 | 夹具通过 |
| 2026-11-06 | [包安装生命周期](2026-11-06-macos-package-lifecycle.md) | 构建时物化SDK补丁，官方pnpm离线安装无需脚本审批 | 隔离通过 |
| 2026-11-06 | [包安装持久数据](2026-11-06-macos-package-data-paths.md) | 程序根与数据根分开，设置和旧根恢复不切换代码 | 隔离通过 |
| 2026-11-06 | [持久数据读者](2026-11-06-macos-package-data-consumers.md) | 账单、语音、搜索与端口缓存共用数据路径 | 隔离通过 |
| 2026-11-06 | [macOS Host组合与编号验收](2026-11-06-macos-host-integration.md) | 共享队列、界面、制品与44项验收边界 | 本机关键链路通过，矩阵未全验 |
| 2026-11-06 | [macOS共享核心](2026-11-06-macos-shared-core.md) | Host单写记忆、经历、上下文、life与渠道契约 | 本地候选 |
| 2026-11-06 | [macOS运行时](2026-11-06-macos-runtime.md) | 统一Node、浏览器所有权、媒体工具与分层诊断 | 本地候选 |
| 2026-11-06 | [共享本地ASR](2026-11-06-macos-shared-asr.md) | 完整范围、持久队列、取消恢复与真实CPU/Metal | 本机App实测 |
| 2026-11-06 | [B站分P媒体](2026-11-06-macos-bili-media.md) | DASH/全durl、字幕cid、Host父作业与经历 | 只读账号实测，保留partial |
| 2026-11-06 | [安装身份与更新](2026-11-06-macos-update-identity.md) | 绑定安装根/来源/所有者，拒绝跨安装pending | 隔离通过 |
| 2026-11-06 | [原生媒体资产](2026-11-06-macos-native-assets.md) | 固定源码构建arm64媒体工具，保留许可/签名边界 | 本机通过 |
| 2026-11-06 | [回复静默计时夹具](2026-11-06-reply-wait-timing.md) | 比较服务端静默截止，抵抗请求调度误报 | 夹具通过 |
| 2026-11-06 | [macOS WP0 基线与隔离](2026-11-06-macos-wp0.md) | 真实路径预期、离线配置与首期环境 | 实施中 |
| 2026-11-06 | [macOS 平台更新基线](2026-11-06-macos-platform-baseline.md) | ZIP 安全解压、POSIX helper 与 Windows 边界 | 组合通过，未发布 |
| 2026-11-06 | [macOS 更新检查路径](2026-11-06-macos-updates-baseline.md) | 规范路径比较与跨系统可执行名 | 组合通过，未发布 |
| 2026-11-06 | [本地 Agent 开发提示词](2026-11-06-macos-development-prompt.md) | 将设计工作包接成可执行交接，保留实机验收与发布边界 | 文档，未发布 |
| 2026-11-06 | [开发工具路由与 macOS 设计归档](2026-11-06-development-tools-and-macos-design.md) | 项目相关工具按任务调用；8 份设计原稿保留本地资料边界 | 文档，未发布 |
| 2026-11-03 | [人格语气层重复/未进目的提示词](2026-11-03-persona-tone-dedup.md) | tone 不再回退 core；相同内容去重；purpose 接语气层 | 待发布 |
| 2026-11-03 | [群里的 #sl 刷屏指令不唤醒 SurfCore](2026-11-03-ignore-hash-commands.md) | 非主人纯 # 短指令过滤；主人/@/引用放行 | 待发布 |
| 2026-11-03 | [B站 @ 鱼不在“我那一层”回复](2026-11-03-bili-at-floor-reply.md) | @ 一级评论补 root=source；digest 给 @ 打坐标；修 resolveLatestReply | 待发布 |
| 2026-11-03 | [晚注册的全局危险工具没有补装 QQ Schema 限制](2026-11-03-qq-guard-late-tools.md) | 监听 tools/change 补 restrict；幂等 + 防重入 | 待发布 |
| 2026-11-03 | [QQ 工作区不跟随 DSH 默认模型](2026-11-03-follow-default-model.md) | 跟随 modelCatalog.default；不认 effort 时去掉重试；两套 UI 都有提示 | 待发布 |
| 2026-11-03 | [私聊「不回我」：回访吃掉额度且用尽不可见](2026-11-03-wake-quota-visible.md) | 回访不计次；wakeGuard 上界面/体检；体检用桥接状态 | 待发布 |
| 2026-11-03 | [桌宠对话一直 400：孤立代理项](2026-11-03-lone-surrogate-400.md) | 截断不劈 emoji + 发送前 wellFormed 兜底 | 待发布 |
| 2026-11-03 | [DSH 0.2.x 凭据结构变化导致 web_search 回退 Bing](2026-11-03-web-search-credentials.md) | 认 records + 账号凭据；token 只发 api.deepseek.com | 待发布 |
| 2026-11-03 | [DSH Desktop 下找不到真正的 node.exe](2026-11-03-dsh-desktop-node-path.md) | 加安装目录候选；scheduler/setup 共用解析 | 待发布 |
| 2026-11-03 | [人格卡住址规则误报](2026-11-03-persona-address-false-positive.md) | 住址只在赋值语境命中；枚举“住址、联系方式”放行 | 待发布 |
| 2026-11-03 | [SnowLuma 掉线期间回复被丢 + 早安假成功](2026-11-03-outbox-greeting-probe.md) | 出站 outbox 上线补发；早安先探活再记已发 | 待发布 |
| 2026-11-03 | [B站记忆旧数据回退 + 管理员输入框超框](2026-11-03-bili-memory-fallback-admin-css.md) | 角色级优先、账号级只读回退；输入框 border-box + max-width | 待发布 |
| 2026-11-03 | [同一客户端包被两条 Loader 行解析：DSH 启动 fatal](2026-11-03-client-multi-source.md) | qq-mode 拆成 host-only 嵌套包；体检加 COMPAT_CLIENT_MULTI_SOURCE | 待发布 |
| 2026-11-03 | [语音页找不到总闸 /「发语音」工具](2026-11-03-voice-switch-location.md) | 语音页顶部直接放两个开关；提示改到真实位置 | 待发布 |
| 2026-11-03 | [DSH 0.2.1-rc.5 上 B站生物钟的兼容问题（6 条）](2026-11-03-bili-rc5-compat.md) | 补 agentPreset；provider 目录 fallback；日记/记忆改角色级 | 待发布 |
| 2026-11-03 | [体检把 SnowLuma 配置当运行状态，固定误报 onebot-rejected](2026-11-03-doctor-snow-state.md) | 体检改读 bridge.snowluma；未运行显示 bridge-not-running | 待发布 |
| 2026-11-03 | [B站生物钟会话永远落在「未分组」](2026-11-03-bili-workspace-grouping.md) | 新会话走 workspaceId；旧会话保留不强行迁移；cwd 改专用目录 | 待发布 |
| 2026-11-02 | [zip 安装首次自动更新被 evidence-insufficient 卡死](2026-11-02-zip-update-bootstrap.md) | 清单已按 git blob；首次 zip 更新显式确认+先备份 | 待发布 |
| 2026-11-02 | [schemastery 3.18.3+ volatile 包装：测试红 / 配置值静默丢失](2026-11-02-schemastery-volatile.md) | 统一 unwrapSchemaValue；mode/ownerQQ 不再变成 [object Object] | 待发布 |
| 2026-11-02 | [B站监听 TDZ 已修，但程序错误仍被一行日志吞掉](2026-11-02-listen-error-visibility.md) | listenerCfg/limits 改名；ReferenceError/TypeError 带类型+stack；回归测试 | 待发布 |
| 2026-11-02 | [宿主只有 /api/events 快照：桥接 0 帧](2026-11-02-events-snapshot-fallback.md) | remote.mux 404 才降级轮询；正常宿主推送不变；端口探测看 /api/status | 待发布 |
| 2026-11-02 | [模型设置选不了 / 选了无法证明真的加载](2026-11-02-model-settings-trust.md) | 宿主补 /dsh/model 代理；selectModel 回执入状态；UI 区分保存/接受/使用 | 待发布 |
| 2026-11-02 | [多群记忆串：A 群的事被记成 B 群](2026-11-02-memory-sharing-circles.md) | 默认隔离；封闭互通圈；每条记忆带群名/ID；私聊永不进群 | 待发布 |
| 2026-11-02 | [群聊 @ 机器人不唤醒](2026-11-02-qq-group-at-detection.md) | 原始 at 段判断；@我+@别人仍唤醒；self_id 回退 | 待发布 |
| 2026-11-02 | [B站监听变量重名/跨午夜/全角冒号](2026-11-02-bili-listen-time-window.md) | 修复监听 TDZ；共享时间窗；群错误只私聊 | 待发布 |
| 2026-11-02 | [B站视频缓存无限增长](2026-11-02-bili-shots-cache-retention.md) | 默认删原片；shots 按天/总量清理；目录可配 | 待发布 |
| 2026-11-02 | [更新完成又提示更新 + 进度条只闪一下网速](2026-11-02-update-idempotency-progress.md) | staged dismiss 修正；阶段进度；重启提示 | 待发布 |
| 2026-11-02 | [QQ 高级设置经常保存失败](2026-11-02-qq-settings-save-stamps.md) | 保存后同步 stamps；warning 不再当 error | 待发布 |
| 2026-11-02 | [DSH 安装后 profile bundles 被裁剪](2026-11-02-dsh-profile-install-rollback.md) | 备份/原子写/安装后核对/自动回滚 | 待发布 |
| 2026-11-02 | [人格语气层被核心覆盖](2026-11-02-persona-tone-core-fallback.md) | tone 必须读 persona.tone.md；未知层 warning | 待发布 |
| 2026-11-02 | [人格卡智能拆分 layer is not defined](2026-11-02-persona-classify-layer.md) | 删除未定义变量；完整草稿；内部错误可见 | 待发布 |
| 2026-11-02 | [商城表情取图失败 + 非多模态看图报错](2026-11-02-emoji-market-fallback.md) | p.qpic/标签兜底；非多模态文字路径 | 待发布 |
| 2026-11-02 | [备份轮转 keep=40 不生效](2026-11-02-backup-prune-regex.md) | 真实文件名解析；按组保留；失败可见 | 待发布 |
| 2026-11-02 | [记忆卡总在回忆第一天](2026-11-02-memory-recent-first.md) | recent 不再被 owner/initial 挤空；最近优先 | 待发布 |
| 2026-11-01 | [记忆卡初次相遇无法取消置顶/忘记](2026-11-01-memory-anchor-unpin.md) | 拆开 firstMet/pinned；可取消；可删除；reload 失败可见 | 待发布 |
| 2026-11-01 | [wait 积压消息不立即返回](2026-11-01-wait-backlog-batch.md) | 有未读立即返回；有界批量；群聊折叠/私聊保留 | 待发布 |
| 2026-11-01 | [四类动态清空前缀仍带固定开头](2026-11-01-bili-dynamic-prefix-config.md) | 配置路径同源；空前缀清旧前缀；提示词不再要求 | 待发布 |
| 2026-11-01 | [黑话学习 turn 永远超时](2026-11-01-slang-learner-wait.md) | waiter 先注册；兼容缺 turn/start；超时不再误删会话 | 待发布 |
| 2026-11-01 | [语音提示词写死默认关闭](2026-11-01-voice-prompt-default-off.md) | 不再写死；按工具/错误码；动态语音状态 | 待发布 |
| 2026-11-01 | [通知/QQ推送/沉默逛/年龄闸](2026-11-01-notify-qq-silent-browse.md) | 桌面通知修复；QQ 推送；只看不说；不挖坟；闸门错误带 hint | 待发布 |
| 2026-11-01 | [管理员温柔模式默认关闭 + 风险确认](2026-11-01-admin-gentle-default-off.md) | 默认不勾选；开启弹风险；关闭可选丢弃上下文；不再叫管理员 | 待发布 |
| 2026-10-31 | [限制失败可见性](2026-10-31-limit-ux.md) | 频率/鱼群/Token 上限给出设置路径和错误报告 | 待发布 |
| 2026-10-31 | [记忆卡手动操作修复](2026-10-31-memory-card-act.md) | item 未定义；toast 阻断 reload | 待发布 |
| 2026-10-31 | [UI 区域按钮化](2026-10-31-ui-area-modal.md) | 高级设置区域收成按钮/弹窗；群管理进高级 | 待发布 |
| 2026-10-31 | [SnowLuma 启动告警](2026-10-31-snowluma-startup-warning.md) | 未启动不要弹断线；连过再断才告警 | 待发布 |
| 2026-10-31 | [快照/工具面/step guard](2026-10-31-tool-snapshot-profile.md) | 合并读取、prompt sections、profile、close 幂等 | 待发布 |
| 2026-10-31 | [群分层 + 人格语气/智能拆分](2026-10-31-group-tiers-tone.md) | 小群积极、大群严格；tone 默认不载核心；人格卡拆分草稿 | 待发布 |
| 2026-10-31 | [question 不再绕过每日配额](2026-10-31-question-direct-gate.md) | 普通“你…吗”不再无限唤醒；@/名字/私聊仍可绕过 | 待发布 |
| 2026-10-31 | [A+B 账单 Markdown](2026-10-31-billing-md.md) | 角色/群/私聊账单；自动刷新；不含正文 | 待发布 |
| 2026-10-31 | [Phase 3 backlog 上限](2026-10-31-backlog-cap.md) | 启动补唤醒默认 5→3，可配置；保留未读 | 待发布 |
| 2026-10-31 | [Phase 1A 调用链](2026-10-31-call-chain.md) | wake→turn→tool 路径；close/send/backlog 分布；只读 | 待发布 |
| 2026-10-31 | [Phase 0A 上下文/成本遥测](2026-10-31-context-telemetry.md) | 只测量：唤醒/模型/工具/prompt 分段；不改行为 | 待发布 |
| 2026-10-31 | [人格卡分层](2026-10-31-persona-layers.md) | 核心/日常/场景；QQ群聊/私聊/B站/桌宠；手动编辑、预算与快照 | 待发布 |
| 2026-10-31 | [一键启动 SurfCore + 一键停止](2026-10-31-one-click-launch-stop.md) | QQ/B站/桌宠/语音多选；语音本地/云端；每项结果与停止；状态统一 | 待发布 |
| 2026-10-30 | [语音包被误放进 zip 自动更新](2026-10-30-voice-pack-no-auto-update.md) | 语音包没有 package.json/清单 → 从自动更新移除，改语音页手动重新导入 | 待发布 |
| 2026-10-30 | [SnowLuma 断线时主动唤醒空烧](2026-10-30-snowluma-channel-gate.md) | 唤醒前查发送通道；断开/连续失败不创建 DSH 会话；L2 事件 + 建议 | 待发布 |
| 2026-10-30 | [闸门事件中心 + 单轮 L3 止血](2026-10-30-gate-events-turn-guard.md) | 重复 compress / 步数 / 回合内额度到顶 → cancel-only + 直接通知；L0-L3 事件中心 | 待发布 |
| 2026-10-30 | [插件冲突体检](2026-10-30-plugin-compat-check.md) | 第三方 compress 被 QQ 白名单拒 → 只读体检报工具/压缩冲突；未知插件标 unknown | 待发布 |
| 2026-10-29 | [设置称呼「弥叭」仍叫管理员](2026-10-29-admin-display-name-projection.md) | QQ 投影只写 ownerQQ，桥接兜底把「管理员」当称呼 → 完整投影 + 空串兜底 | 待发布 |
| 2026-10-29 | [原生浏览选中文目录后导入报不存在](2026-10-29-browse-chinese-path.md) | PowerShell stdout GBK 被 Node 当 UTF-8 → 路径乱码；改 UTF-8 临时文件 | 待发布 |
| 2026-10-29 | [云端参考音频“下载”没反应](2026-10-29-cloud-sample-download.md) | 接口 200 但 `<a target=_blank>` 被宿主拦 → fetch+Blob，加「打开所在目录」 | 待发布 |
| 2026-10-29 | [语音包离线导入](2026-10-29-voice-pack-offline-import.md) | 只有“改安装目录”且静默失败 → 校验/复制/备份/回滚/结构化错误，本地+云端 | 待发布 |
| 2026-10-29 | [提问回答无身份来源 + 特权操作无审计](2026-10-29-owner-question-audit.md) | question 不读 isOwner、DSH 单选不许 selected+custom → custom-only；7 类主人审计 | 待发布 |
| 2026-10-29 | [SnowLuma 装在自定义目录检测不到](2026-10-29-snowluma-detect-manual-path.md) | 检测只猜固定目录 + 手动入口藏在 QQ 页 → 概览加「浏览…」，路径归一 | 待发布 |
| 2026-10-29 | [云端语音包凭据不能随包分发](2026-10-29-voice-cloud-credentials.md) | 安装包复制 example 时会带上开发者的火山 AppID/AccessKey → 新装一律清空、强制自填 | 待发布 |
| 2026-10-28 | [更新导致 DSH 硬崩](2026-10-28-update-crash.md) | 进程内覆盖自己的安装目录 → 宿主被终止（0xFFFF7003） | v0.6.12 |
| 2026-10-28 | [本地语音装完不可用（位置/import/工具）](2026-10-28-voice-pack-layout-and-imports.md) | 归档解压落点、jieba_fast、MCP 工具快照 | v0.6.22 |
| 2026-10-28 | [语音包卡在依赖安装 50 分钟](2026-10-28-voice-install-stuck-deps.md) | 依赖阶段无百分比、无耗时、无取消、pip 走官方源 | v0.6.21 |
| 2026-10-28 | [语音安装没有进度条](2026-10-28-voice-progress-lost.md) | 每请求新建服务实例，安装进度被请求生命周期吞掉 | v0.6.20 |
| 2026-10-28 | [点更新没反应，版本不变](2026-10-28-update-helper-never-runs.md) | Electron 宿主 spawn .mjs 静默退出，助手从未执行 | v0.6.19 |
| 2026-10-28 | [语音包装完不可用（嵌套/启不动/停不掉）](2026-10-28-voice-pack-install-start.md) | flatten 判定看 config.toml、bat 里 pause、stop 假设单对象 | v0.6.18 |
| 2026-10-28 | [桌宠安装一直无效（无报错）](2026-10-28-pet-install-silent-fail.md) | 只认根目录 package.json + 失败残留被安全闸拦 + 报错不显眼 | v0.6.17 |
| 2026-10-28 | [语音包「安装完成」但只有 490KB](2026-10-28-voice-install-false-complete.md) | 前端谎报完成 + 后端无完整性校验 + 只读属性 | v0.6.13 |
| 2026-10-28 | [语音包「装了却说没装」](2026-10-28-voice-pack-not-detected.md) | 包在别的目录（旧 cwd 默认）→ 只认一个目录 | v0.6.10 |
| 2026-10-28 | [本地语音包默认音色 503](2026-10-28-voice-default-voice-missing.md) | `voices/`、`voicepack/` 被 .gitignore 排除，没随包分发 | v0.6.8 |
| 2026-10-28 | [SnowLuma 一直检测不到](2026-10-28-snowluma-detect.md) | 填根目录时取了 dirname，候选全错 | v0.6.11 |
| 2026-10-27 | [桌宠 125% 缩放拖动漂移](2026-10-27-pet-drag-drift.md) | `setPosition` 在缩放屏上让窗口每帧变大 | 桌宠 v0.2.3 |
| 2026-10-27 | [桌宠拖拽永不结束](2026-10-27-pet-drag-never-ends.md) | 指针离开窗口后收不到 `pointerup` | 桌宠 v0.2.1 |

> 更早的坑（更新检查误报、主题对比度、桌宠数据被删等）见 [`../PITFALLS.md`](../PITFALLS.md)；
> 那份是"按坑记"，这里按"按 bug 记"，两者互补。

- [2026-11-11 Memory V2 确切公开来源集合审批](2026-11-11-memory-v2-public-source-approval.md)：真实 Worker 权限与完整预览、同场景桌面/移动证据；Host/官方读取及双步 Native 已验，全局生命周期仍在办。
- [macOS候选收口](2026-11-07-macos-readiness.md)：独立候选、审查与实机验收边界。

- [QQ编号回答提示](2026-11-07-qq-answer-hint.md)：消除占位词歧义，真实处理函数验证精确选项。

- [B站精确播放时间线](2026-11-07-bili-precise-timeline.md)：区分整数声明与精确范围，保留真实缺尾和转场护栏。

- [Bili V2 关闭与显式重试](2026-11-10-bili-v2-close.md)：退休及订阅确认后释放 owner；42场景与实际 native 联合复验通过。
- [Bili V2 视频文字元数据](2026-11-10-bili-v2-video-metadata.md)：固定 view / text-only、精确 ID、日期越界固定错误；helper run2 已验，生产接线待。

- [Bili V2 官方公开读取与双步 Native](2026-11-11-memory-bili-official-public-read.md)：精确集合、元数据 text-only、审批排序及释放 ACK；feed/debrief 实际工厂各 3 模拟调用/45 tokens。
- [QQ 私有 context、文本包与原件导出](2026-11-11-memory-v2-qq-source-plumbing.md)：完整 producer 分片/原 refs 私有导出、actor 保真的只读文本包与独立 QQ Host context。
- [QQ Native owner 私有所有权](2026-11-11-memory-v2-qq-native-owner.md)：实际 Native agent 私有所有权、动态角色/模型/工具检查、真实预算前置 gate 与完整退役。
- [QQ Native 输出观察与取消](2026-11-11-memory-v2-qq-native-observation.md)：实际流分阶段观察、原配置/请求/分片检查、工具 guard witness、等待实际取消后卸载确认。
