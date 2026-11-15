# QQ Native 语音与白名单启用流程

## 现象与证据

用户配置火山语音且白名单含群1135502130，但要求语音只收到文字、群@无回复，并质疑为何Codex似在处理QQ。上轮真实文字链路已通过：Native session qq-v2-native-fec83151-2312-47cc-8ce7-0b88b5d27c1e、实际1073 Token、QQ回执1262259894，get_msg读回与Core正文SHA256 c21456e8e9299bbcde04d25286570c19e82a9fa5c9247453bf6302376390f682 一致。00:51后两条新入站自动取得QQ回执，没有管理唤醒；Codex只做诊断控制，DSH Host的Native Owner才是运行时。

## 根因与完整逻辑

1. **链路**：OneBot入站→QQ桥接触发→Core来源与模型处理授权→DSH插件NativeOwner→回复意图→私有发送租约→共享TTS/媒体传输→OneBot回执→Core记录。QQ设置页是用户入口，Core是唯一处理授权事实，模型不能指定收件人、路径、令牌、provider。
2. **机制**：文字恢复时新Host只装配tools=[]，私有send只接收text，旧MCP语音工具虽注册也不属于此NativeOwner。直接接旧sendVoiceForV2又会依赖旧state.sessions并重复授权记账。另一个根因是白名单设置只保存接入许可，V2处理许可在记忆页，且保存没有给出“尚不能回复”的状态，形成产品契约断层。
3. **影响面**：Host与桥接两进程，QQ设置/NativeOwner/旧语音调用三类读者；原静默=2×3×3=18。涉及用户消息、模型及火山计费、QQ外发，须保留各自额度/精确受众/角色epoch/未知结果不重发。旧人格、会话、配置、账本均保留。
4. **路线比较**：A直接复用旧HTTP/MCP入口，改动小但撞旧会话权限、双记账、25秒超时，长期成本和回滚风险高。B复用共享音频发送层，按调用方保持唯一记忆事务，Native增加一个有界语音意图工具，QQ页复用正式预览/提交/回执；工作量适中，边界一致，可回装旧程序，采用B。不新增TTS服务/平行白名单/自动补发机制。
5. **生效**：源码由已安装插件Host和桥接读取；程序通过官方SurfCore热重载与桥接入口生效，不需要整App重启。网页模块重开QQ设置后加载。安装前备份旧程序和当前数据标识，不能覆盖最新配置/密钥/账本。
6. **验证**：先隔离脚本对准语音未接线/重复意图/取消/超时/白名单未启用/模型变化，真实安装SDK以假模型+假QQ回执验证工具见证与Core账本；再audit、协议回归、插件测试；最后实际私聊语音与白名单群@，逐条get_msg核对，手机播放仍需用户确认。
7. **回滚与残余**：只回装上一程序备份，不恢复旧用户配置或重置费用/用量。包管理profile声明仍指旧包，重装可能覆盖本地候选；发布会话从最终提交重建后走正式发布门禁。本轮真实语音、群@及原生QQ卡片预览/取消已完成；不据此宣称长期/跨平台全矩阵验收。

## 权限与预算实际变更

用户先后明确批准：仅私聊2125387192；恢复app/红豆epoch8；QQ每日5,000,000,000 Token、人民币上限留空；本轮仅新增群1135502130及该群已授权记忆给当前magpie/workbuddy/deepseek-v4.1-flash。群配置本来存在，没有由代理新增白名单。正式处理许可操作cc605a2f-8952-4ec5-acc2-2ab4dd67ed5a及独立回执committed/completed、revision4。其它私聊155仍撤销，其他群/本机伙伴未授权。未来UI必须由用户看见具体目标/模型后确认，加载或普通保存不得暗批全部名单。

## 验证记录（历史中间记录；最终结果见下）

- Host与channel回归先红后绿；实际SDK voice cycle通过，5 fake calls/75 fake tokens、0network/0platformWrites，日志在仓库外任务证据voice-sdk-debug2.log。调试诊断已移除，最终日志待刷新。
- QQ scoped管理测试先红（新状态误用admin摘要policies，没有授权域明细），改用Core原生resolveAudience判定唯一匹配后绿；不复制授权解析规则。

## 可直接转发的发布交接

现象：V2 Native文字链路缺语音装配，QQ白名单保存与模型处理许可分离而无有效状态反馈。修法：复用Core授权事实与共享TTS/QQ传输，Native单条意图/唯一发送回执/取消期限；在QQ设置同入口预览确认并核对启用状态。范围：QQ Native及QQ设置，不新增服务，不改版本，不发布。当前为未提交候选；最终tree、门禁、安装哈希和真实语音/群@证据须本轮结束补齐，不应据当前中间记录发布。回滚仅程序，保留最新角色/配置/密钥/记忆/消息/额度。

## 追加：用户截图的反复 L2 许可提醒

生产reportMemoryBlocked把所有MEMORY_POLICY_DENIED都当fault，事件中心默认L2；虽然写了dedupeKey，record仍每次生成UUID，新轮询会成为新弹窗，确认单条不能解决。该错误说明许可闸门正常拒绝，属于待配置的可行动状态。修法在共享事件中心只把memory-v2/fault/blocked/MEMORY_POLICY_DENIED归为L1，仍进入通知和对应设置，不打断；真实安全/来源/预算异常级别不降。生产者显式选择持久语义去重（角色epoch、渠道、会话、代码和提示全部相同才复用原ID），已确认的相同状态重启后不重新弹，变化的对象仍单独记录。旧事件不删除；仅用户此次要求处理的同类历史许可提醒通过正式ack入口确认。

QQ Host和channelMemory携带准确渠道；路由异常按真实入口标记本机伙伴/QQ/B站/抖音，错误文案指出对象和当前入口，不再诱导批准其它渠道。新Host语音朗读意图共用spokenText规范化，Core正文与TTS实际朗读相同；退役RPC失败仍必须执行所有Owner清理。

测试：test-gate-events先红L2→绿L1/持久去重/确认后跨重启不再未读/不同渠道新事件/guard-missing仍L3；test-memory-v2-alerts对实际Host报告函数+真实事件store验证5次轮询只1事件1日志、准确QQ会话与入口、无原错误明文泄漏、本机伙伴不诱导其它渠道扩权、真正Native失败仍L2。

## 最终验收：2026-11-12 01:49（Asia/Shanghai）

- 最终冻结tree3927fa47d90265e5ae6db33310935005efa75e90，400条制品清单在构建、安装后均0不符；官方App pnpm离线消费候选tgz成功并能导入SurfCore/SDK。官方HMR两次applied，五份profile声明SHA不变，未重启整个App。正式QQ重启PID28234。
- audit195/195、协议17通过；初次插件并行Bili120ms夹具超时在串行复核通过；续跑完整基线插件命令通过，末尾Memory出现本轮API错误分支不必要URL全局依赖，改为路径文本分类后实际Bili生命周期及全部34Memory插件脚本通过。原失败日志保留，不声称初次npmtest为exit0。最后代码变动仅消除上述不必要全局依赖；对应真实UI/API、失败报告定向及diff-check通过。
- 源码最终独立复核无剩余阻断；真实安装SDK隔离使用5次假模型调用/75假Token、生产Host文字和语音各1个假QQ回执、外网0/真实平台写入0。JSON Schema与toolSpecs同源，完整输出才发送；中间解释/最终文字不重复外发。真实源码归属已证明桥接父进程官方DSH Host，正常推理不依赖Codex进程。
- 用户新私聊17:46:14Z、新群@17:46:28Z自动处理；私聊Native会话两模型请求1374+1451Token、群Native会话一请求1365Token，共4190Token，均app/epoch8、magpie/workbuddy/deepseek-v4.1-flash，金额null未知。没有管理唤醒、模拟入站或自动重试。QQ1105838883的get_msg为private/record，QQ1904687227为group/text，发送方787661104一致。群原文平台88字符，Core规范化87字符；使用同一redactContent规范化后完全一致，差异为Core既有重复换行折叠，未篡改发送内容。
- 火山TTS账本最后预留17:46:32.122Z；安装后仅此一笔，本月本机预留668字不是云端账单。真实新WAV为pcm_s16le/24000Hz/单声道/5.423458秒。用户已明确确认“语音能正常播放，群里也回复了”。
- 真实原生QQ页面显示群1135502130和私聊212许可已确认、155仍待确认；只读155预览显示实际模型/登录账号/app8，点击取消后显示“没有提交”；回读revision4且155未批准。没有替用户默认批准整个名单。预览过期、模型/账号变化、未知回执、目标消失等负例由真实控制器离线测试覆盖。
- 对用户截图所属历史MEMORY_POLICY_DENIED L2通过正式ack接口分两批共400项确认，未删除原事件、未ack-all。原生窗口已观察弹窗消失；最终接口可见L2/L3=0。新程序仅将精确许可拒绝作为L1设置提示并持久去重，不削弱源校验或自动授权。
- 实装回滚目录：~/.dsh/_backups/qq-voice-access-2026-11-11T174009786Z/program-previous；原ack文件亦在同备份内。回滚仅程序并走官方HMR/QQ重启，不覆写新增消息/策略/角色/密钥/用量。未发布、未bump/tag/push、未在主目录合并；所有编辑保留独立树。
- 开发期无codebase-memory-mcp可用，采用定向rg与实际调用者检索；证据与构建在仓库外`../_surfcore-qq-reply-backups-20261111/`，关键文件FINAL-VOICE-ACCESS.json、voice-and-group-real-acceptance.json、installed-voice-access.json、candidate-voice-final.patch、candidate-voice-final-tree.txt及各门禁日志。

## 最终可直接转发的发布交接块

```text
改了哪些文件：QQ Host/Source组合、Core Native channel、bridge共享语音传输/旧租约包装、voice-tts的共享朗读规范化、memory-v2-runtime/management的QQ scoped真实授权状态与预览、client+qq-access-panel、gate-events持久去重/准确分级、对应回归及案例文档；完整明确路径见外部candidate-voice-paths.json。
测过什么/结果：audit195/195，协议17，插件完整命令覆盖与最终Memory34/34通过；初始失败与串行续跑如案例保留；真实SDK离线5fakecalls/75tokens/1voicefakeACK/0network；官方离线包消费成功；实装400清单0不符；真实QQ语音record/群@text双get_msg，用户确认可播放且群回复；原生卡片预览/取消和L2消失已验。
建议patch还是minor：建议patch（恢复既有QQ/语音能力并修复配置启用与通知故障），具体版本由发布会话决定；当前0.8.8不变。
case路径：docs/cases/2026-11-12-qq-native-voice-access.md；上轮基础回复案例docs/cases/2026-11-11-qq-v2-native-reply.md。
改动层级/兼容：实现装配+私有Host RPC/QQ设置接口增量；旧Voice数值messageId和旧Memory事务保留，V1不增加审批；不开放通用本机工具或任意发送目标。
完整逻辑与爆炸半径：见case七步；两进程/三类读者，涉及消息、模型/TTS计费与QQ外发；保持当前角色epoch/精确受众/独立额度/唯一租约/真实回执。
失败路径：QQ卡片显示具体目标、当前模型、未启用或code/error/hint；预览/确认/回执独立，未知只查原编号；取消/超时不迟到发语音，发送前失败释放预留，未知ACK不重发，已ACK后本地记账失败保留送达并可行动告警；真正安全异常仍L2/L3。失败分支均有针对性断言。
还有什么没验证：长期运行与跨平台矩阵不在本轮验收；本地程序候选尚未提交/正式发布，profile包声明仍指旧包，重新包管理安装可覆盖；发布会话需合入本地dev、从最终提交重建清单与制品并执行发布三门禁，不直接发布脏树快照。
最终候选：3927fa47d90265e5ae6db33310935005efa75e90（sourceCommit:null，本地未提交tree）；回滚只程序，保留最新用户数据/预算。
```

> 2026-11-12 本地收拢：本case中的临时工作树与历史测试资料已按用户明确“不备份”要求删除；有效源码已按功能提交合入dev，当前程序和真实数据保留。提交与清理结果见[本地收拢case](2026-11-12-functional-commits-and-safe-cleanup.md)。
