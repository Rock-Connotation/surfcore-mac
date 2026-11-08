# SurfCore语音管理解除QQ桥接依赖

## 现象与确认根因

用户在SurfCore现有语音页看到“语音服务不可达（桥接是否在运行？）：fetch failed”。当前DSH在运行，QQ控制台3100无监听，安装配置的桥接自启关闭；两次真实本机GET均ECONNREFUSED。原handleVoice、概览voicePacksSnapshot、独立启停及sample-open查询均依赖QQ，所以与尚未选择云端/本地引擎无关。

用户授权收集资料并修复依赖，明确引擎配置稍后选择。本轮不启QQ/B站/抖音任务、不选引擎/下载模型/填密钥/实际TTS或麦克风、不调用付费模型、不发布版本。

## 完整逻辑

1. **链路**：原语音页→Host `/voice/*`→QQ3100→voice-packs；改为语音页/概览/单独启停→Host→共享voice-management→现有voice-packs/配置。旧QQ控制台的管理路由也复用同一模块；QQ发送/库/自动回读仍保留桥接边界。
2. **机制**：语音管理与消息泵是不同职责。共享控制器不导入QQ会话或模型；显式configFile固定保存目标，避免Host cwd导致写错文件。管理器按包路径/manifest配置复用，普通配置保存不清空安装/导入进度；两个管理入口的写操作按归属协调。读取状态不启动桥接/引擎、不自动创建配置。未配置自检显式失败；健康检查失败不继续合成，无自动换路。
3. **爆炸半径**：Host与旧桥接两进程×页面/概览/启停/旧控制台四类读者。共享配置、已有包和凭据必须保持同源，不能为了独立入口复制出第二套用户配置。接口结构不扩到QQ发送权限；错误code/error/hint在当前语音页显示。
4. **取舍**：采用Host内复用控制器，收益是去掉3100必需依赖且复用现有UI/安装逻辑，成本为共享适配/归属/路径合同与专项；回装原包即可退，资料不迁移。另起常驻控制服务虽然集中所有权，但新增端口鉴权/进程监督/升级合同，当前收益不足，未采用。官方资料与provider差异见[资料与边界](../guides/VOICE-MANAGEMENT.md)。
5. **生效与重启**：插件Host/index、client、共享src及旧bridge管理路由需同源更新后重启。不会替用户安装/启动语音引擎。Mac对旧Windows启停脚本给可行动的不兼容提示，保留云端/本地配置入口，不能宣称已经有Mac引擎支持。
6. **验证**：已新增实际apply(ctx)Host路由反例，旧版在QQ关闭时返回502，改后列表200/两包未安装、规则可读、概览管理ok、独立启动给未安装而非桥接错误；无新QQ进程。服务专项覆盖配置保留/坏配置不覆盖、进度缓存、两管理实例互斥、未配置零请求、健康失败零合成、固定route一次合成及Mac平台拒绝。独立V3及两个极窄增量复核无剩余已证实P1/P2；最终组合与原生结果见下方收口记录。
7. **回滚与残余**：回装97deaba前程序，保留最新用户资料/包/凭据/用量。没有格式迁移，不用回滚人格、记忆或消费账本。真实TTS质量、密钥/音色配置、引擎安装、语音输入及QQ发送均不属于本轮验收；当前交付终点是原生管理入口在QQ关闭时可用，未配置失败明确。

## 已有测试夹具问题

完整插件首轮停在test-pet-chat：fixture在import时读取真实DSH_HOME，受到用户实际关闭桌宠对话的配置影响。97deaba归档同样失败，证明与语音解耦无关。仅修该测试：先设临时DSH_HOME并显式配置聊天开启，再动态导入真实模块；不改桌宠业务代码/断言，隔离后通过。

## 可直接转发的发布交接块

```text
主题：SurfCore语音管理解除QQ桥接依赖（建议patch，未发布）
范围：src/voice-management.js新共享控制器；voice-packs显式配置路径、voice-tts取消信号；bridge管理路由、插件Host/client/概览/启停；专项及旧夹具隔离、文档
身份：修复497598a；冻结候选/实际安装00f5c45；合并main 6da9b6d；后续仅文档/清单，版本0.8.8不变
验证：Node24 audit176/176、协议回归17、完整npm --prefix plugins/surfcore test、服务12、实际Host红绿、独立V3及JSON/UI窄增量复核、strict privacy零命中；Git对象清单865/问题0
实机：官方CLI安装349文件一致/6074持久文件安装前后不变；QQ关闭时列表/规则200、两包未安装；实际点击自检显示VOICE_TTS_DISABLED与配置建议，旧fetch failed消失；普通无debug启动恢复
层级/兼容：实现与Host接口适配；包/规则字段保留、createVoicePacks新增可选configFile；Host自检仅所选引擎/合成，不再检查QQ投递；旧QQ诊断/发送边界保留
完整逻辑/影响面：见本case七步；Host和旧控制台共享管理、配置归属/任务缓存需同源安装
失败路径：当前页展示code/error/hint；坏JSON/坏配置、归属竞争、未配置/健康失败、Mac旧Windows包拒绝、迟到/重载均有反例；未知状态不伪报停止
未验：真实云端/本地引擎、音质/音色/费用、实际下载安装/合成、麦克风、QQ语音发送、跨设备/长期运行
生效/回滚：已同源安装并重启；旧安装程序有私有备份，可离线回装，不覆盖最新用户资料/消费账本
发布纪律：不bump/tag/push/Release；后续发布会话按RELEASE.md现读、定版并验真实制品
```

## 独立审查与修正记录

V1独立审查确认5处P2：旧settle释放新锁、旧锁双进程回收竞态、关闭后迟到健康回执继续合成、重载丢取消入口、概览停止把未知状态当成功。全部保留原反例并修复：写操作revision复查；旧死owner记录保持不可变，所有竞争者派生同一后继地址并以完整文件硬链接排他发布；每句柄AbortSignal和关闭检查；同进程session复用进度但退休句柄不复活；启停对状态读取失败返回code/hint。

V2再发现配置刷新并发重建管理器导致进度/取消丢失，V3在await前后复查manager身份/key/revision，只有一个请求可替换实例。相同反例旧红新绿，原5项仍绿；官方Node24服务12/12及实际Host路由通过，六核心文件哈希稳定。死owner锚点不自动删除，链深上限32，损坏归属记录失败关闭并给人工检查路径；没有为了自动恢复清空未知锁或用户资料。

协议夹具因新增共享模块导入缺少VM绑定而失败，已将真实createVoiceManagement注入原有audit-bridge-harness，不改原回归断言，17项重新通过。完整插件已在V2执行通过；V3缓存修正后按最终冻结候选再做组合检查。

最终audit首轮发现旧test-launch-components仍强制要求VOICE_BRIDGE_DOWN，恰好断言了本轮要消除的依赖。删除此单条过时源码字符串断言，保留其余启动合同；已注册的实际Host行为夹具以QQ关闭时列表200、未安装可行动失败和状态未知不报停止成功替代旧合同。不是把生产实现改回依赖桥接，也未降低真实行为覆盖。

同轮174/176的另一项为test-voice-diagnostics源码检查旧代理文字。保留全部错误分类、既有QQ换路及前端断言，仅移除已被真实Host/服务专项替代的旧代理字符串断言。两项均属新合同替换，最终完整audit重新执行；失败原日志保留。

## 最终收口（2026-11-08，Asia/Shanghai）

- **候选与组合检查**：00f5c45（生产修复497598a）完成官方Node24 `npm run test:audit` 176/176；`npm run test:regressions` 17项/exit0；`npm --prefix plugins/surfcore test` 完整exit0；`npm run privacy-scan:strict` 零命中；`git diff --check` 无问题。生产冻结后只修两条过时源码断言并补文档/清单，原失败174/176日志保留，最终audit完整重跑通过。
- **独立证据**：V1五处/V2一处已修，V3及最后JSON/UI窄增量无剩余已证实P1/P2。原反例、两OS进程互斥、迟到请求/重载/缓存刷新均复核。Host畸形JSON400且code/hint非空、跨域403、连接鉴权401优先；instrumented fetch为0。
- **实际制品**：从00f5c45 Git对象构建，经官方CLI离线安装；349程序文件及manifest自身一致，6074持久文件安装前后无变化。常用profile的其它依赖声明、cordis/patch字节、304既有已安装依赖版本均保持。
- **原生验收**：在同一个常用DSH、QQ3100关闭下，实际语音页读包/规则均200，两包installed/running均false，旧桥接fetch failed不可见。未配置aiEnabled=false时实际点击“开始自检”，当前页显示VOICE_TTS_DISABLED、语音合成尚未开启及“选择本地或云端…不需要启动QQ”建议；未选路/装包/下载/合成或发平台消息。8765/8767与3100全闭；模型账本仍11/12。
- **用户资料**：配置、凭据、角色/立绘/分享与记忆正文保留。首次运行中备份至正常Quit期间，原记忆维护只更新了JSON的updatedAt/lastMaintenanceAt及两份Markdown的更新时间；剥离这些明确时间戳后内容完全一致。未将旧备份覆盖回去；安装前后6074文件零变化另行证明安装不写用户资料。
- **生效与清理**：常用已正常Quit调试实例并恢复无debug普通启动，cwd主目录，临时调试端口确认关闭。6da9b6d普通合并到main；已从合并HEAD重建清单。单个临时树/分支均删除，当前只有main/主目录；测试生成的ignored证据/state及node_modules链接先移入私有证据目录，无独有资料丢失，原主树.serena保留。
- **私有证据入口**：仓库外`<GITHUB_PARENT>/_surfcore-voice-host-20261108/`，含audit-frozen/plugin-frozen/regressions-final日志、独立审查报告、install-ready-result、native-management/native-self-check截图、profile/资料保持与normal-final结果、common-before备份、preserved-worktree-ignored。不随公开仓库分发，不把本机凭据写入case。

**怎么复核**：打开常用DSH → 设置 → SurfCore → 语音，QQ关闭时仍可看到语音包和配置；引擎未配置时“开始自检”明确提示先配置，不应出现桥接fetch failed。下一步由用户选择云端或本地，再按[官方资料与接口边界](../guides/VOICE-MANAGEMENT.md)制定适配与独立验收。
