# 2026-11-10：QQ语音分群权限与持久额度

## 现象和根因

最初“呼唤红豆不回应”分为三个独立层次：NapCat容器虽然运行，但OneBot HTTP/WS尚未监听；恢复登录后，该群不在授权白名单；文字恢复后，语音仍沿用默认仅主人规则，群友的请求不具备发送权限。群白名单、语音触发权限、唤醒次数、语音发送次数和合成字数是不同的账，不能相互替代。

“语音额度用完”在群内出现过，但没有对应的实际错误回执。本机火山账本当时为2026-11月497字，最后两次预留在11月9日，不能据此认定月额度耗尽。旧代码仅有2次/分钟、10次/小时及100000字/月硬上限；发送次数在内存中，并无真正的500条/日账本。

## 已确认的行为

- 当前授权群1135502130使用`mention`：群友真实@机器人可请求语音；10分钟内有效，一条请求最多成功发一条语音。
- 每群可覆盖`owner`（仅主人）或`mention`（群友@）；`maxPerDay`为0至500，0表示不另加该群日限制。
- 所有群和私聊共同受500条/本地自然日限制；群额度不是额外赠送的总额度。未配置群保留全局触发方式，私聊默认仅主人。
- 火山本机月上限900000字，按UTC月；现有497字用量保留。分钟/小时配置为30/100，已有更低的显式设置仍可限制发送。
- 发送失败不算成功条数；已发起合成的字数预留不会因发送失败退回。网关结果不明时暂停新语音，凭回执对账，避免重复投递。

## 完整逻辑

1. **链路**：OneBot事件进入`src/bridge.js`，实际@和主人身份产生触发记录；AI的`src/mcp-snowluma-safe.js`调用桥接语音接口；合成前经过火山字数账，发出前经过发送账，再经NapCat发送record。设置页`plugins/surfcore/lib/client.js`通过Host语音管理接口修改规则；旧QQ控制台和Host复用`src/voice-management.js`。`src/voice-group-policy.js`统一校验分群规则，`src/voice-send-budget.js`统一管理成功发送账；对账CLI也是该账本的读写者。
2. **机制**：权限来自真实上游事件，不相信模型口述“有人@过”。串行发送队列和持久锁共同避免跨会话、跨进程超发；预留后再次检查发送闸门。只有非零、安全整数的OneBot message_id才确认成功；远端已接受但本地记账失败标记未知，禁止伪报成功。日界按本地成功时间，月界按UTC合成时间；群计数和总计数在同一文件提交。
3. **爆炸半径**：两个执行进程（Host、QQ桥接）和一个MCP适配进程；规则有两个管理入口、一个触发校验消费者、一个账本消费者，均共享实现。按“进程×读者×失败显式系数1”保守上界3×4×1=12。触及本机配置及额度账；不改变主人账号、私聊名单、密钥或历史合成账。合成有实际费用，本机月上限不代表云服务免费额度或账单金额。
4. **取舍**：只调配置成本低、回滚简单，但旧硬上限和缺失日计数使目标无法实现；复制每群独立账本会产生全局并发漏洞和复杂对账。选择同一持久账本中的群计数和总计数，额外代码有明确边界，失败时可凭证据恢复。源码先集成再构建完整包，保留原来的主人转交功能。
5. **生效与重启**：配置事务允许语音选择更新并递增选择版本；QQ桥接需重启以加载新代码。Host管理模块和客户端还须实际复查，不以安装器提示推断成功或失败。原生App是安装及验收目标；网页仅曾作为同一Host的管理入口，后按用户要求停止使用。桥接归属检查需同实际Node二进制，不能杀不明进程来绕过检查。
6. **验证**：完整audit191/191、协议17/17、全部插件测试exit0；覆盖500/501、重启、跨进程争抢、SIGKILL锁恢复、跨日/月、失败/未知、分群隔离、重复群号、无效额度、旧配置戳、页面草稿竞态。离线官方App pnpm安装及导入通过，实装artifact-manifest.json的357个条目全部SHA256一致。运行接口返回500/日及当前群mention/0，QQ账号在线、OneBot连接和dshReady均true。实际App设置页图形验收见下方状态。
7. **回滚与残余**：备份目录`~/.dsh/_backups/voice-group-quota-2026-11-10T10-28-46-853Z`保留旧程序、profile声明、配置及旧账本；只回退程序，不覆盖后续新增的密钥、聊天和额度。若回退旧代码，它不理解新日额度和分群规则，需明确恢复原触发策略；不得删除新账本来“解锁”。本轮未新增付费合成或向QQ发送验收消息，手机实际播放仍待用户新请求确认；此前11月8日合成、投递、手机播放成功不冒充本次证据。

## 安装和开账证据

- 独立工作树`../surfcore-voice-quota-integrated`，分支`feat/voice-quota-integrated`，基线`17c9b1fc6c4473395ee44a15ff495bd525fe1d86`。
- 冻结本地程序tree `f32823da2683e300e9c35cfc992fa12b77830837`，`sourceCommit:null`、`localCandidate:true`，版本仍0.8.8。临时Git index生成tree；没有提交、bump、tag、push或发布。
- `scripts/build-plugin-package.mjs --tree TREE --out DIR`支持未提交的不可变本地候选；发布仍走`--ref`的Git对象流程，二者互斥。
- 官方CLI拒绝操作Electron专管的desktop profile，随后通过App的插件管理服务安装本地tgz；包管理声明指向备份目录中的tgz，需保留该文件。
- 今日开账前只读查询授权的两位私聊和当前群的网关记录：私聊记录覆盖本地午夜，群授权发生在当日，均无当天机器人record消息。只保存数量和时间界限，不保存正文。因此以有证据的0开账；若无法证明历史，应保守初始化为500，而非任意清零。已有账本永不覆盖。
- 实装脚本和脱敏证据在工作树`_backups/`：`voice-history-evidence.json`、`deployment-backup.json`、`runtime-acceptance.json`、`accepted-audit.log`、`accepted-plugin.log`、`final-regressions.log`。

## 对账操作

先检查，不删除账本：

```bash
node scripts/voice-send-reconcile.mjs inspect --state-dir /absolute/qq/state
```

首次缺账且没有历史证据时，保守按当日500初始化：

```bash
node scripts/voice-send-reconcile.mjs initialize --state-dir /absolute/qq/state --confirm conservative
```

有完整历史证据时首次开账可额外传`--count 0 --evidence '证据摘要至少五个字符'`，只对不存在的账本生效，不用于重置。未知回执需先查网关，按inspect中的id对账：

```bash
node scripts/voice-send-reconcile.mjs resolve --state-dir /absolute/qq/state --id ID --confirm ID --result sent --accepted-at 2026-11-10T18:00:00+08:00 --evidence '已核实的网关回执摘要'
```

确认拒绝使用`--result rejected`，不填accepted-at。活跃预留不可对账；旧日期或无时区的时间拒绝。`VOICE_SEND_UNCERTAIN`、`VOICE_DAILY_LIMIT`、`VOICE_GROUP_DAILY_LIMIT`、`VOICE_GROUP_RULES_INVALID`均有非空hint；设置页显示保存失败并保留草稿。

## 原生App图形验收状态

已在实际App PID30216、主窗口7465、版本0.2.2-rc.1确认SurfCore 0.8.8与语音页：总闸和发语音工具已开，AX树含分群群号、触发方式、日额度、添加群规则和保存按钮。私有证据为工作树`_backups/native-voice-main.png`及同名`.txt`。用户随后明确要求自行配置，已停止所有界面操作并交付手动路径；未完成原生分群表单保存及同视口改前/改后比较，不宣称完整图形验收通过。早期1365×1000深色改前截图来自同一Host的设置页，不冒充原生App改前截图。实装清单及实际规则接口验收已通过。

## 可转发发布交接

```text
改了哪些文件：bridge/MCP保留已有转交能力；voice-group-policy/voice-send-budget新增；voice-management/voice-volc-budget/设置client/构建脚本及测试夹具。
测过什么、结果：audit191/191、协议17/17、全部插件通过；官方离线包安装导入通过；实装357制品哈希一致；QQ桥接已加载新分群规则并在线。
建议版本：minor（新增分群规则及持久发送额度；版本由发布会话决定，本轮未发布）。
case：docs/cases/2026-11-10-voice-group-quota.md。
改动层级：实现层+向后兼容规则接口；groupRules为可选新增字段，原触发配置默认保持；新账本首次开账必须有证据或保守满额。
完整逻辑与爆炸半径：见case七步；Host/桥接/MCP及共享管理/账本边界，保留账号密钥与旧用量。
失败路径：UI错误保留草稿；未知发送暂停并给对账hint；缺账/坏账保守拒绝，错误code/hint有断言。
未验证：本轮没有新增付费合成或QQ验收投递；按用户要求停止界面自动操作，原生分群保存与图形前后比较由用户手动验收，不能标作全部通过。
冻结程序tree：f32823da2683e300e9c35cfc992fa12b77830837（未提交候选，发布前先整理提交并从发布HEAD生成清单）。
```


## 2026-11-10 19:17 补修：保存触发规则误报 CONFIG_STALE

1. **链路**：App desktop profile加载`plugins/surfcore/lib/client.js`；`VoiceTab.load`读取`/voice/rules`，`CloudForm`独立保存价格/月额度，`saveRules`提交整表，父级`onVoiceConfigSaved`刷新主QQ设置草稿。后端`src/voice-management.js`在共享配置事务内比较整份配置SHA256。已检索这些调用者；本次只改客户端保存/父草稿同步，不改变后端接口或并发锁。
2. **机制与复现**：同页加载规则后先保存价格，配置戳已变，但规则草稿仍带旧戳；随后整表POST被拒绝。用真实`createVoiceManagement`控制器和实际客户端函数得到红测：`CONFIG_STALE · 语音规则已被其他操作修改。 · 保留未保存草稿，重新读取后处理冲突。`。这是可独立复现的前端基线失同步，不能据此把所有真实冲突都忽略。主QQ草稿的旧戳直接比较也会使成功保存后仍误报同步失败。
3. **爆炸半径**：改动到App客户端规则页和父QQ草稿两个读者；Host安装程序包，但桥接业务代码未变。失败仍在当前页面toast显示，草稿保留；不触发合成、不发QQ消息、不改账号或额度账本。真实Host同值保存前后完整QQ配置及SHA256一致。
4. **取舍与修法**：取消版本校验最短，却会覆盖其他修改，排除；给接口另造规则专属版本会扩大契约和调用点，本次不需要。复用已有`planVoiceRebase`：保存前GET最新规则，按“读取基线/当前草稿/远端”三方合并后带最新戳POST；同字段冲突保留草稿并报告`CONFIG_STALE`及非空hint。GET之后若再发生写入，后端CAS仍拒绝。成功后基线采用合并后的实际提交值，请求期间新编辑继续保留；父QQ草稿也用三方合并同步。
5. **生效与重启**：通过当前原生App Host的官方`pluginManager/installBundle`安装，desktop profile的SurfCore仍为0.8.8、本地未提交候选；程序tree `63fe0833a3a22a91b203035b588584714d1e11e1`。安装回执`enabled:true`、`changed:true`、`application:restart-required`、`restartReason:unmanaged-plugin`。App已提供新版`/plugins/??surfcore/client.js&rev=409788ea6783`，但不能据此声称已打开的原生窗口内存模块已更新。用户先记录未保存规则，完整退出并重开App后再保存。本轮遵守用户要求，不操作界面、不重启整个App；先前“保存规则无需重启”指配置热生效，不能用于插件页面代码更新。
6. **验证**：`node scripts/test-qq-draft-rebase.mjs` 10/10，通过真实控制器覆盖同页先保存价格、真正的分群冲突、读写竞争，以及请求期间新编辑和父草稿同步；旧实现红、新实现绿。`npm run test:audit` 191/191；`plugins/surfcore`内`npm test`全通过；官方App运行时离线安装和模块导入通过；实装357制品SHA256全部一致，相对上一实装只有`client.js`和安装元数据变化。实际App提供的新JS在隔离VM中执行并调用真实Host接口：构造旧视图戳、无草稿修改，成功合并当前价格并同值保存，toast为`✓ 触发规则已保存`，完整QQ配置与原值一致。此项不冒充原生按钮点击验收。无新增付费合成/QQ发送。
7. **回滚与残余**：完整旧程序、配置/账本只读备份和新tgz位于`~/.dsh/_backups/voice-stale-save-2026-11-10T11-13-28-516Z`。新tgz SHA256 `8cf5de2959a770dd27a5c768a86437b62651df5b8d99510d96dc1c8cc8fb1b0a`；保留它作为包管理来源。回滚应仅通过App插件管理安装旧程序候选，绝不恢复整个profile或旧聊天/账本。私有复现、审计、包验收、官方安装回执、App实际提供的JS和真实接口验收保存在工作树`_backups/stale-rules-*`。未验证用户重开App后的原生点击；无新增可见布局，原生界面由用户手动验收。

### 本轮可转发发布交接

```text
现象：语音页先保存价格/月额度，再保存触发规则，会因旧配置戳误报CONFIG_STALE。
修法：客户端保存前读取并三方合并；保留真实冲突/CAS、未保存草稿和请求期间的新编辑；修复父QQ草稿的版本同步。
程序tree：63fe0833a3a22a91b203035b588584714d1e11e1；本地0.8.8候选已装入原生App desktop，未commit/bump/tag/push/发布。
验证：定向10/10、audit191/191、插件全通过、官方离线安装导入通过、357实装哈希一致、App实际提供的新版JS+真实Host同值保存通过且完整QQ配置不变。
用户生效步骤：先记录未保存规则，完整退出并重开DeepSeek Harness.app，再保存规则；官方安装回执要求restart-required。本轮未替用户操作UI或重启App。
case：docs/cases/2026-11-10-voice-group-quota.md，19:17补修段；失败仍可见且保留草稿，无需改后端协议，无新增QQ消息或付费合成。
```


## 2026-11-10 19:49 运行时恢复：群 @ 到达但不回复

1. **链路**：群1135502130的真实@经OneBot→桥接PID35158→`state/sessions.json`绑定`session-0f2fcefd-b85d-4abf-8fed-ca4898188726`→App Host61774。19:33:55日志`atMention@seq52`证明入站和触发已到达；白名单、模型选择和dshReady正常。原生App重启后的安装候选仍为tree `63fe0833a3a22a91b203035b588584714d1e11e1`。
2. **机制**：Host官方`workspace/follow`只读基线证明目标会话在`archivedSessionIds`中；`session/page`证明第17–22等轮次以`reason.kind:blocked`结束，`session/list`显示`running:false`。App0.2.2-rc.1的`@deepseek-ai/dsh-api-session-controller/lib/index.js:3265`归档门在`agent/pre-step`返回reject，`@deepseek-ai/dsh-agent-loop/lib/index.js:747`据此结束为blocked，尚未调用模型。桥接保留`pendingWakeKey`，新@被暂存；30分钟租约不是正常响应时延。没有证据确定归档由谁、何时发起，不能归因于用户保存语音设置。
3. **影响面**：涉及Host与桥接2进程，归档注册表与群会话绑定2读者，群内静默=3，粗略半径2×2×3=12。解除归档只改一个会话；短暂重启桥接会让全部QQ连接重新建立，但不改账号、配置、群权限、聊天历史和额度。整个App没有重启。
4. **取舍**：新建群会话可避开归档，但需更换绑定且丢失当前对话上下文；解除原会话归档可保留全部历史，操作幂等且可通过官方归档接口回退。本轮选择后者，仅运行时恢复，不扩展桥接自动处理归档的产品行为。
5. **操作与生效**：先保存单目标归档状态、会话映射、社交状态和三份配置/账本SHA256到`~/.dsh/_backups/group-reply-recovery-2026-11-10T11-46-18-733Z`。官方`workspace/unarchiveSession`读回目标不再归档；随后设置任务范围`DSH_NODE`为ps证实的App Node路径，走桥接模块`stop()`所有权校验及`start({dshWebUrl:实际动态Host地址})`，新PID43590、dshReady/QQ在线正常。不手工kill，不改源代码、profile或API Key，不操作UI，也不发送人为测试消息。
6. **验证**：重连后19:46:53原会话补唤醒13条既有未读，第23轮进入真实模型执行，统计从37步增至40步。桥接19:47:04、19:47:22各返回2/2发送成功；OneBot只读`get_group_msg_history`读回红豆787661104发出的4条文本，消息id `152770038`、`674752348`、`1421140360`、`1212700127`，时间19:47:01/04/13/22。原群入口已恢复发言；没有冒充用户另造测试提问。原会话ID不变，config.json、voice-send-budget.json和volc-voice-budget.json逐字节哈希与恢复前一致。只保存发送元信息，验收记录不保存聊天正文。本轮只改文档与运行状态，运行时验证如上；没有把此前audit191/191冒充本轮新增代码测试。
7. **回滚与残余**：回退该归档状态应先确认会话无在途工作，再用官方`workspace/archiveSession`处理这个ID；不要恢复整份旧工作区注册表、配置或聊天。备份含`before.json`、`unarchive-receipt.json`和`after.json`。目前无法确定原归档操作者；宿主对归档会话停止运行是既有机制，整理QQ工作区时应保留正在绑定的群会话为未归档状态。无需重装插件，也无需再改语音额度。

### 本轮可转发交接（运行时恢复，无代码发布）

```text
现象：用户重开App并保存语音设置后，群@仍不回复。
根因：原群绑定的Host会话被归档，agent/pre-step拒绝，回合blocked；桥接繁忙标记残留使后续@排队。与账号在线、白名单和语音保存成功可同时发生。
处置：备份后官方unarchiveSession恢复单个原会话；通过所有权校验重启桥接并自动接续既有未读。保留原sessionId、聊天、账号、配置与额度，不重启App、不发人工测试消息。
验证：原群模型恢复执行；QQ网关读回4条红豆文本，19:47:01/04/13/22；config及两份额度账本SHA256不变，QQ/dshReady在线。
代码/版本：无新增程序改动，保持本地0.8.8候选tree63fe0833a3a22a91b203035b588584714d1e11e1；未commit/bump/tag/push/发布。
case：docs/cases/2026-11-10-voice-group-quota.md，19:49运行时恢复段。回滚只通过官方接口改回该单会话归档状态；不要覆盖全局注册表或旧聊天。原归档操作者/时间未证实。
```


## 2026-11-10 20:03：语音把【温柔】提示念成正文

状态：最终门禁、App官方安装、357个文件校验及新桥接验收全部完成。用户要求修复语音正文；本轮不做UI自动化，不请求真实合成，不发送QQ测试消息，不提交或发布。

### 完整逻辑

1. **链路**：QQ工具的text进入src/bridge.js中的synthesizeVoiceText，经src/voice-tts.js的synthesizeToFile，按provider进入voxd或src/voice-volc-tts.js。Host语音管理也调用同一synthesizeToFile；语音库音频不走文字合成。调用检索仅发现bridge及voice-management两个生产读者。
2. **机制**：原共享入口只对text做String/trim，随后原样写入请求正文、缓存键和火山字数预留。因此离线实际请求断言得到“【温柔】你好”而期望“你好”。在共享入口先清理成对方括号/圆括号中的明确语气或动作词，识别温柔、轻声、微笑、开心等及“语气：温柔”“温柔地说”等形式，随后统一校验、算缓存键和预留额度。未知标签与正常括号正文保留。清空后抛VOICE_TTS_TEXT_INVALID及可行动hint；桥接直接保留该错误，不把输入错误包装成voice.unknown或尝试换路。
3. **爆炸半径**：2个进程（QQ桥接、Host管理）×2类入口×静默文本变化系数3，按仓库保守口径12；实际实现修改2个文件。不会修改配置、密钥或旧账本，但未来火山预留按清理后的实际正文计费。过滤范围白名单且括号匹配长度有界，避免全删括号正文。正常“【通知】”“（两份）”“【温柔的夜晚】”有保留断言。
4. **取舍**：只改提示词成本低、可回滚，但已有会话及其它入口仍可能产出标签；在某一provider内过滤会漏掉另一条路线。选择共享TTS边界，覆盖两条路线而不添加依赖、配置或新接口。此修复不推断新音色或把标签映射为情感参数。
5. **生效与重启**：从隔离Git索引冻结源码tree构建本地0.8.8候选，通过App官方pluginManager安装到desktop profile。桥接是独立Node进程，须走原所有权验证stop/start后才载入新TTS模块。App安装器可能提示完整重启；是否已让QQ路径生效以新桥接及安装文件验收为准。没有UI/客户端组件改动。
6. **验证**：scripts/test-voice-tts.mjs在voxd和volc真实请求组装边界注入假fetch，断言前/中/尾提示清除、正常正文保留、缓存复用和火山字数仅计正文；仅提示词时网络调用0，实际bridgeHarness仍保留code/hint。红灯见_backups/tone-cues-red.log；桥接错误丢失红灯见_backups/tone-cues-bridge-red.log。最终test:audit 191/191、test:regressions全17项、plugins/surfcore完整npm test均exit 0；证据为_backups/tone-cues-final-audit.log、tone-cues-final-regressions.log、tone-cues-final-plugin.log、tone-cues-final-targeted.log。官方App离线pnpm消费及模块导入通过，见_backups/tone-cues-final-package-lifecycle.log。
7. **回滚与残余**：程序实装前保留完整旧package和最新profile声明及QQ配置/账本。回滚应对备份旧package通过官方管理入口恢复并重连桥接，不整份覆盖profile、不清账、不删除缓存。未请求真实云TTS或手机试听；白名单外的未知提示不会猜测删除，正常括号也不整段剥离。只过滤文字输入，不改已经录好的语音库音频。

### 发布交接块（本地修复，不等于公开发布）

- 改动：src/voice-tts.js统一过滤明确语气提示；src/bridge.js保留输入错误code/hint；scripts/test-voice-tts.mjs覆盖两个provider和实际桥接；本案例及COORDINATION同步。
- 结果：最终audit191/191、协议17/17、插件完整套件及App离线安装通过；安装tree e319350a0e9ac2d4dbce2b149a52d1cbe3e79684，357个文件校验一致。原生desktop仍为0.8.8，本地候选，不提交、不推送、不发Release。
- 建议：patch。实现层变更，原合成参数与返回值兼容；空正文新增明确结构化错误。
- 案例：docs/cases/2026-11-10-voice-group-quota.md本节；完整逻辑与保守爆炸半径见上方。
- 失败路径：清理后为空时code=VOICE_TTS_TEXT_INVALID，提示输入实际要说的话；回归覆盖code与非空hint，桥接不丢失提示。网络/鉴权/额度失败仍沿用现有行为。
- 未验：真实云合成、QQ额外外发及手机听音；未做UI操作。

### 本轮实装证据（20:08）

- 官方pluginManager/installBundle回执enabled=true、changed=true、application=restart-required、restartReason=unmanaged-plugin；不通过浏览器或原生UI点击。安装到/Users/shizihan/.dsh/profiles/desktop/node_modules/surfcore。
- 相对上一实装tree63fe0833a3a22a91b203035b588584714d1e11e1，仅src/voice-tts.js、src/bridge.js及来源记录.surfcore-install.json改变；357个清单文件均匹配。
- 制品SHA256：3c6382ce5ec976920335fb0f7d3fabd5de9f092ecd411a96bbb8ca59fb691765；完整旧程序、profile声明、配置/账本、安装及运行回执备份：/Users/shizihan/.dsh/_backups/voice-tone-cues-2026-11-10T12-07-17-751Z。配置、voice-send-budget.json、volc-voice-budget.json在安装及重连后哈希不变。
- 所有权检查stop/start成功，桥接43590→27748，running/dshReady/QQ connected/accountOnline全部true；实际安装目录的TTS模块两provider假fetch均将“【温柔】你好（微笑）”发为“你好”。离线实装验收见备份runtime-acceptance.json与_backups/tone-cues-runtime-acceptance.log。
- QQ实际合成进程已载入新代码。Host可能仍缓存模块，安装器的完整App重启提示保留；本轮没有擅自退出App，若需要全部Host模块刷新由用户正常退出重开。页面不变，无图形保存操作。
- 回滚候选：上一已验tgz为/Users/shizihan/.dsh/_backups/voice-stale-save-2026-11-10T11-13-28-516Z/surfcore-0.8.8.tgz（tree63fe0833）；可在App插件管理中安装此旧本地包并重连桥接，保留当前配置和账本，不能整份恢复旧profile。


## 2026-11-10 20:16：收尾回合显示“执行失败”——模型SSE数据解析异常

用户再次要求检查执行失败。此时语气提示补修已经实装且所有验收已成功，不能把模型回合中断误说成安装失败，也不能重复部署或清配置。

### 完整逻辑与恢复证据

1. **链路**：当前DSH会话session-511462ab-8f81-4a99-a495-6b1ab2d263ea → magpie-responses / codex/gpt-6.1-sol（reasoningEffort=high，运行投影所报）→ dsh-llm-pi-ai 0.2.2-rc.1 → @earendil-works/pi-ai 1.3.0 → openai 7.19.0 SSE解析器。运行投影只证明所选路由及网关报告，不独立证明上游模型身份。
2. **机制**：官方session/page的turn 20在20:10:38结束，reason.kind=error，code=PI_AI_ERROR，message为“Error reading response: malformed server-sent event JSON.”。原生App内openai/core/streaming.js:108对sse.data执行JSON.parse，失败后113抛出同一句SyntaxError；dsh-llm-pi-ai/lib/index.js:1465–1475没有将此文本归为已有可重试类别，保留通用PI_AI_ERROR。原始坏事件未保存，因此无法进一步证明是代理截断、上游格式还是其它传输来源。
3. **影响**：当轮模型执行停止，已经完成的工具操作不回滚。357文件实装验收、桥接27748在线及配置/两账哈希不变均在本次模型失败之前完成。本轮没有QQ桥接故障、TTS失败或安装回滚证据。中间turn 21为aborted/user；turn 22为用户重发后的恢复执行。
4. **取舍**：可以修改第三方SDK忽略坏事件，但可能丢正文或工具参数；也可以更换账号/模型，但没有认证或持久路由错误证据。选择保留正确的严格解析，沿用户原会话恢复执行并完成既有任务，不改App二进制、账号、provider或协议。本轮没有所谓永久修好上游坏帧的代码变更。
5. **生效/重启**：用户原会话同一模型路由已连续完成多轮step与tool/result（isError=false）。不重启App或桥接，不重放已完成安装，不额外发模型探针。
6. **验证**：用App实际openai/core/streaming.js导出的Stream.fromSSEResponse离线输入合法SSE，UTF-8逐字节分片能正确得到“你好”；输入无效JSON能精确重现同一错误；下一条合法SSE再次成功。全部断言通过，networkCalls=0。此证据确认错误边界及恢复能力，并不还原当时的原始坏帧。
7. **回滚/残余**：本轮仅补诊断记录，未修改宿主代码或配置，无需运行时回滚。持续性/再次发生概率未验证；未知坏帧不得静默跳过。语音修复已交付，不为这次收尾中断重复调用云TTS、QQ发送或安装器。

### 转发交接补充

- 本次“执行失败”属于模型回复流解析异常；语音修复制品e319350a、357文件校验与运行回执仍有效。
- 宿主程序/账号/模型/协议无改动，无新发布物；当前原入口已恢复执行，原始坏SSE事件来源未证实。
- 离线SDK解析验证通过；未发送真实上游探针、未花TTS额度，未做UI自动化。
