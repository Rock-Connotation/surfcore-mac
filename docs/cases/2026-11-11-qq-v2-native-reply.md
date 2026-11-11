# QQ 桥接运行但红豆不回复：V2 发现契约与 Native 执行装配

## 现象

用户给红豆发消息没有回复，QQ 桥接开关显示开启。2026-11-11 本机认证状态接口返回 `backend=v2`，私聊失败为 `MEMORY_DISCOVERY_INVALID`。OneBot 曾离线后恢复连接，不能把旧断线日志当作本次根因。

## 环境

- macOS / 官方 DeepSeek Harness.app；SurfCore 0.8.8，包安装 desktop profile。
- 独立工作树 `../surfcore-qq-reply-fix`，分支 `fix/qq-reply-discovery`，基线 `748afe6`。
- 主目录开工时有另一会话 A–E 未提交修改；本轮不清理、不回滚、不覆盖这些文件。
- 数据根 `~/.dsh/surfcore`；QQ 配置/桥接状态在 `~/.dsh/surfcore/qq`，两者用途不同。

## 根因

1. `memory-v2-runtime.mjs` 向共享数据根写受保护的 `memory-v2/qq.json`，但 `createQQMemoryBridge` 默认 client 使用 `qq-bridge` scope，读取 `qq-bridge.json`。目录根本身相同，错的是 scope/文件名，不应改数据根或放宽文件权限。
2. `bridge.js` 没有装配可信 Native session safety，默认安全门恒为 false。仅修发现文件，下一步仍会被 `MEMORY_PRESET_UNSAFE` 拒绝。已有 Native Owner/来源账本只是独立组件，并未正式装配到 QQ 生产入口。
3. V2 `/api/status` 提前返回精简对象，丢掉 root、OneBot 与管理状态；插件映射又丢掉 memoryV2 失败，UI 仅据进程存活显示“运行中”。这既隐藏失败，也让所有权检查无法确认该桥接。
4. 旧集成夹具把 Host scope 手动改成 `qq-bridge`，且提供只在夹具内成立的 safety callback，因此覆盖不到真实组合。

## 完整逻辑

1. **链路**：OneBot 入站 → bridge 的持久来源/授权准备 → 受保护 qq scope 的 typed `qqReply` → Host 私有 Native Owner + Core 召回/来源账本/预算 → 私有一次性发送租约 → OneBot 真正 ACK → 原角色回执。模型不接收控制台令牌或私有 RPC 能力。
2. **机制**：发现文件必须与发行方同 scope；生产 Native Owner 必须拥有真实 session、固定工具面、实际模型请求和完整 finish 证明。HTTP 200 仅表示传输成功，不能替代业务成功或 QQ 消息回执。
3. **爆炸半径**：桥接和 Host 两进程、消息入口与管理 UI 两类读者，原静默失败按 2×2×3=12 估算；影响 V2 群/私聊的文本回复。不改用户历史、密钥、额度或白名单，不新增合成；实际模型调用仍计入既有预算。
4. **取舍**：A 只修 scope，成本最低但仍必然被下一道安全门拒绝，不能完成修复。B 复用已有 Native Owner/Source Runtime 正式接线，新增有限的私有组合和传输，复杂度高于一行修复但能消除完整根因，采用。恒真 safety/通用会话回退/V1 自动降级都不满足既有安全契约。
5. **生效与重启**：桥接读取 `bridge.js`/QQ 工厂，Host 读取插件组合与 API；两者均需加载新程序。管理页需刷新模块。普通配置保存不能使旧 Node/Host 的代码热更新。实际生效状态见下方运行验收记录。
6. **验证**：生产 writer + 生产 QQ 工厂的回归先红 `MEMORY_DISCOVERY_INVALID`，再绿。新 Host 组合测试覆盖完整文本一次、无 finish/截断零发送、未知发送零重试、角色漂移、超时和退役。实际已安装 SDK + 真 Core + 私有桥接组合，3 次假模型调用/45 fake tokens、1 次假 QQ ACK、0 外网，正式 Native Host 生成路径通过。
7. **回滚与残余**：旧程序与新制品保存在仓库外任务备份目录；只回装程序并重新加载两进程，禁止恢复旧聊天/凭据/额度账本。V2 保持当前选择；Native 文本回复固定无通用本地工具，未把未验证工具开放给模型。真实 QQ/模型与原生页面验收须独立记录，不能用 fixture 冒充。

## 修法

- QQ 工厂明确 `scope: qq`；通用 MemoryClient 默认不变。
- V2 正式走 Host Native 作业，不再调用通用 `sessions.prompt`；遗留会话先清退、历史保留。
- 私有 Native RPC 拒绝 agent 请求，校验控制台鉴权、回环、Host、Origin、角色 epoch、作业编号、实时登录账号与白名单；一次性租约防止重复发送。
- 发送调用与原始回执写入由桥接连续执行。网络未知仍写 `delivery_unknown`，无自动重试；后续 record 只核对原回执。
- 退役保留已提交来源，避免在途新消息被旧作业清掉；完成只确认提交前的未读水位。
- 恢复完整管理状态，映射 `replyReady/replyFailure`；概览显示“回复受阻”、机器码和检查记忆权限入口。
- 完整插件门禁暴露了基线夹具缺陷：repair 夹具未执行 effect 清理，platform-start 夹具重复 import/声明且缺 Host origin。本轮保留隔离断言，修正夹具，不降低门禁。新工作树 Memory V2 kernel 评测先生成同一冻结语料 V1 baseline，不复制历史测量值。

## 验证

- Node 24 `npm run test:audit`：192/192。
- `npm run test:regressions`：17 项通过。
- `test-qq-native-channel.mjs`、生产 Host 组合脚本、桥接真实 VM/HTTP/Kernel 集成通过。
- 官方 Electron `SURFCORE_QQ_SOURCE_NATIVE=1`：实际 SDK/Core/来源账本 + 正式 Reply Host 成功；假模型、假平台，无真实外发。
- 本机制品：tree `266a7753aad0660297f1567bc8cb79ea379368fb`，399 项文件哈希（另含清单自身，共400文件）；官方 App pnpm 离线消费者安装、模块导入及 manifest 核对通过。版本保持 0.8.8，无发布。
- Memory V2 普通脚本 48/48 通过；完整插件 npm test exit 0（含33个插件侧V2脚本）；最终audit再次192/192。
- 证据目录：`../_surfcore-qq-reply-backups-20261111/`；Native 证据在本工作树 `_backups/memory-v2-coordinator/qq-source-runtime-independent/verification.json`。

## 运行验收 / 遗留

2026-11-11 23:00 左右已完成本机程序实装：官方pluginManager原安装请求因全profile依赖重算、访问registry/Git依赖超时；用原requestId查询并官方cancelInstall返回cancelled，原package/lock/cordis四份声明和394项旧程序哈希确认完整恢复。随后仅原子替换SurfCore程序：旧目录保留于 `~/.dsh/_backups/qq-native-reply-20261111T145559Z/program-previous`，新程序399项清单哈希一致、4份受保护配置/账本哈希不变、其他13插件声明不变。

本机包管理来源仍指旧tgz，未来执行profile包管理可能覆盖当前候选；新tgz保留在仓库外任务备份的package-lifecycle目录，需由后续包管理会话收口，不能把临时替换冒充官方安装成功。

额外实时只读核验：旧Host管理状态返回4个候选，但已批准policies为0。因此即使新程序重载成功，仍必须由用户在记忆页对目标QQ渠道及所示精确模型执行“预览→批准”，本轮不会静默创建处理授权。

当前Host/桥接仍在运行旧代码。原生窗口发现未发送草稿，已向用户请求保存后允许重启，未擅自关闭窗口；尚未真实QQ/真实模型验收，不宣称红豆已恢复。

## 可直接转发的发布交接

```text
改动：QQ V2 scope契约、正式Native文本回复组合、私有一次性发送及原角色回执、完整管理状态与可见失败；补回归与修复既有夹具。
验证：audit192/192；协议17项；真实安装SDK+Core+ReplyHost隔离闭环；官方离线包安装导入和399项manifest通过。完整插件exit0（含33插件侧V2）；MemoryV2全套48/48；真实运行结果见本case最终回填。
源码窄复核：未留下已证实P0/P1；失败可见、来源隔离、工具面、租约/unknown和epoch均有针对性验证；真实渠道待验。
建议：patch；不代定版本、不tag、不push、不Release。
case：docs/cases/2026-11-11-qq-v2-native-reply.md。
层级：内部执行/管理状态；V1默认与现有发现安全校验保留，已启用V2不自动降级。
完整逻辑与爆炸半径：见case，2进程/2类读者/原静默影响12。
失败：概览“回复受阻”+code+检查权限入口；缺finish/超时/撤销/漂移不发，未知发送不重发，均有失败断言。
未验证：以case最终运行验收段为准；本轮无公开发布。
```

### 2026-11-11 23:13 重启后续验收

用户报告已重启。新App Host为新进程，但旧桥接PID36377仍是22:11启动的孤儿，dshReady=false且仍提供旧精简状态。原程序已原子移入备份，因此旧进程cwd也指向program-previous；第一次所有权检查拒绝后未强杀，随后用保存的atomic-install回执确定原目录，精确核对cwd、exe、argv、锁文件及3100监听归属，才SIGTERM单进程。Host监督器随后自动启动新桥接PID46440（23:13），正确加载新目录、连接新Host；OneBot connected/accountOnline/good及dshReady均true、发现失败消失。主代理额外CLI start返回owner-unverified，未重复启动或结束新进程。进一步只读核验确认该CLI环境选择用户目录Node，而真实Host选择App内置Node，路径不同使严格所有权校验拒绝；官方Host相同的start入口随后返回ok=true/already=true，证明原生管理环境的进程归属正确。

原生App实际打开SurfCore概览可见新状态和PID；进入记忆→身份与权限、展开下拉确认4候选，选当前故障私聊生成预览，尚未执行。当前实际模型magpie / workbuddy/deepseek-v4.1-flash，policies仍0。已请求用户自行确认此私聊或明确授权代理确认，再从该QQ发送新消息；不批准群/其他私聊、不人工补发旧消息。真实模型及QQ发出回执继续待验。

### 原生授权界面复验

实际点击进入SurfCore→记忆→身份与权限，展开候选并选中当前故障私聊，选“仅此会话与所示精确模型”，生成“共享范围预览·尚未执行”，确认按钮留给用户。用户选择自行确认后发消息；其后误关界面，按用户新指令已重新打开同一预览，仍未代确认。

新Host的真实qq scope接口对错误角色的typed qqReply返回CHARACTER_EPOCH_STALE，证明已装配Native回调且错误角色被拒；0模型/0QQ外发。真实QQ的最终验收仍依赖用户完成授权和新消息。

授权预览重新打开后，额外用原生窗口截图确认：确认按钮最初在当前滚动区下方；已将蓝色“确认执行共享范围”滚到窗口中央。用户尚未执行批准时，实时只读轮询仍policies=0、无Native发送回执；未宣称真实回复完成。


### 用户确认后仍未回复：审批结果可见性补修

真实新入站已在桥接活动中出现，但仍为 MEMORY_POLICY_DENIED；Host revision=0/policies=0，原预览编号查询无已提交业务回执。确认没有落到策略表；现存证据不足以断定用户最后一次点击的具体 HTTP 错误，不归咎用户操作。

源码确认预览 TTL 为120000ms；界面既不展示有效期，提交时又立即撤掉底部确认卡，失败只写顶部提示，当前滚动位置容易看不到。采用原控制器返回 expiresAt、面板展示期限并在本地过期时拒绝提交、错误/待核对/成功提示滚入可见区并聚焦、共享授权/撤回成功后读取真实状态。保留服务端 TTL/CAS/角色检查和未知结果只查原回执；不自动续期或批准。另一方案延长/取消 TTL，只能掩盖过期且放大陈旧预览风险，未采用。

影响面：Host 管理控制器和其唯一管理面板；读取新状态不会花模型费用或发送QQ。面板文件由管理端按请求读取，但渲染器 ES 模块缓存须重新加载才能获得新UI；控制器新元数据须Host重新加载，旧Host仍可配合面板两分钟提示/错误可见性/提交后回读。不能把磁盘安装当作Host已加载。失败路径测试覆盖本地过期零提交、服务端过期错误code/hint、反馈滚动与焦点，以及真实策略状态回读；没有降低授权边界。代码回退用本次补修前备份，策略与新数据保留。

当前原生CUA能读窗口，但点击连续报 noWindowsAvailable，已尝试重绑定名称/路径/bundle及重置会话；未用替代UI自动化绕过。已请求用户手动打开身份与权限页；仍待有效预览确认、策略落盘、实际模型完成和QQ ACK。

发布交接补充：将本案例审批UI补修与QQ Native回复修复一并审阅；不改版本/不发布。有效期提示与失败可见性可以降低误判，但真实QQ回复尚未闭环，不能作为已恢复交付。


审批补修最终门禁：官方Node24 audit192/192、完整插件npm test（含33个Memory V2插件脚本）exit0；补修前协议17通过且本次没有协议/桥接代码再变。git diff --check通过。2026-11-11 23:44，仅更新已安装程序中的panel、management和两份制品元数据，候选tree=e99b1863678279cda4d090c5314cc8fb16f13279；399项逐文件一致、4份受保护用户文件与账本前后哈希不变。备份 `~/.dsh/_backups/qq-approval-ui-20261111T154434674Z`。未重启Host或渲染器；旧Host控制器仍运行，新panel文件已可由按请求读取入口提供，但当前renderer模块缓存未重载。需用户保存草稿后重新加载窗口/应用，取得新界面，按原定单私聊/精确模型重新预览并确认；不要求批准群或其他会话。真实model/QQ发送仍未验收。


### 继续确认后的真实错误已捕获

用户再次报告已点击并保留页面。实时Host仍revision0/policies0；原生AX明确显示 MEMORY_PREVIEW_REQUIRED（记忆管理请求未完成），不再仅为过期猜测。预览由代理先生成，用户经聊天往返后才点击，超过两分钟TTL；旧renderer未加载新反馈代码，错误仍在顶部。停止重复同一手动交接方式：已核对官方身份路由仍magpie / workbuddy/deepseek-v4.1-flash，准备只针对私聊1558596500的新预览，并询问用户是否明确改为由代理即时完成同一范围。当前尚未获代确认同意，未提交授权。


### 用户明确授权后的单私聊策略落盘

用户明确回复“同意，由你立即完成上述范围”。立即现读官方QQ身份确认仍为magpie / workbuddy/deepseek-v4.1-flash，再现读角色alpha/epoch7、revision0、policies0；生成新operationId并同进程预览→提交，没有复用过期预览。原操作265f8813-7b3d-4545-adbf-3440da5b89df的提交与独立查询均ok=true/sourceState=committed/operationState=completed/controlRevision=1/appliedControlRevision=1/applied=true。状态回读revision1、恰好一条policy，范围只qq-private-1558596500/exact-model。完整非密钥回执保存在任务外部证据包authorized-private-grant-result.json。没有批准群、其他私聊或本机伙伴。桥接已读到controlRevision1、dshReady=true，当前角色来源仍0；已请求用户发授权后一条新消息，继续验收真实模型和QQ ACK。


### 更正：新入站实际会话为2125387192

授权后一条新消息（23:54:55）的真实活动key是private:2125387192；23:31:04那条同样为private:2125387192，而历史22:xx失败是private:1558596500。此前代理误将历史key当作当前新消息，授权对象选择错误；上文“当前故障私聊155…”及23:31归属应按本段纠正，不能据此宣称QQ恢复。现读官方登录账号787661104，允许私聊两项均存在；当前已批准的155权限并不覆盖212，因此政策拒绝符合安全契约。0来源/0模型/0发送。

准备了撤回155的既有policy与仅批准212/exact-model的两项预览，均成功；已向用户说明对象错误并请求明确替换同意。未擅自新增212权限或撤回用户刚批准的权限；最终计划只保留实际发送账号的一条策略。


### 2026-11-12 Native运行时与角色污染的继续根治

正确账号212的授权已由用户批准，撤回155原操作35f91bae-61b6-4835-a562-7a7429e534f7确认applied/revision2，212新操作0c441a91-ddf7-4706-9a3b-435393c00991确认applied/revision3；历史撤销记录仍保留，因此policies数组长度不是有效授权数。面板提交后回读不再把历史策略总数称为已批准数量，展示修订并让用户核对逐项状态。

新入站23:58:00已入库（sources1），随后Native返回QQ_SOURCE_RUNTIME_ERROR。查明Source Runtime使用adapter.release(...).catch，但生产Host release同步返回对象；异常清理和退休均可TypeError并掩盖原始错误。测试人为把release包装为async，遮蔽了生产契约。改为共用await清理，QQ Core客户端同类路径一起支持同步/异步释放；测试去掉async伪装，并新增准备失败原code/hint必须保留的断言。正式SDK隔离闭环重新通过：3 fake calls/45 fake tokens/1 productionHostReply/0 external network/0 real QQ writes。真实原始推理错误仍需新程序加载后核对，不能认为已完全恢复。

另一项已证实的测试污染：该fixture在导入静态角色路径后，直接createCharacter/switchCharacter操作真实角色目录，未设DSH_HOME。角色指针目前alpha/epoch7（mtime20:17:35）；18:00备份已alpha/epoch5，污染早于本轮最新门禁；本轮23:43仍新增alpha-121到124。修复fixture在所有项目模块动态导入前设置独立DSH_HOME，MemoryV2总runner亦为每个子脚本建立隔离home；后续整个audit/npm test/协议均显式隔离。不得再以全绿掩盖用户目录写入风险。

原角色独立只读取证：历史11-07 current.json实物id=app/小白鲸/epoch4；当前app元数据名=红豆。现app/persona.md3538字节，SHA256=293d556292ce3ab7fd6530b10f832e9945bac6ccfe748064d8e75a9cf31cb670，与18:00备份一致。只证明人格文件一致，不代表全部记忆已验证。采用正式角色切换产生新epoch，保留所有Alpha及新来源；不复制旧指针、不回滚epoch或整份index。恢复与重新审批仍需用户明确同意后执行。


### 原角色正式恢复与切换闸门修复

用户明确同意恢复app/红豆后，正式load最初返回MEMORY_POLICY_DENIED/retirementRequired。根因：本机伙伴status因缺local grant设置sticky blocked，角色切换调用没有提供已有的retirementAcknowledged，因此未运行切换，形成与QQ授权无关的死锁。独立只读审查确认仅在私有switchCharacterEverywhere调用传ACK安全：QQ/Bili退役先确认，Sharing仍先阻止新工作/abort并等待active.done/释放retained views，Douyin等内层transition继续执行；所有新角色capture/validate/network admission不变。其它配置/恢复/渠道transition不传ACK，默认屏障仍保留。ACK只证明逻辑来源/回调退役，不能声称所有底层provider flight物理结束（既有100ms清理上限）。

回归红→绿：真实Host角色API fixture切V2且无任何policy，侧栏status确切MEMORY_POLICY_DENIED；正式load从失败变成功，策略完全不变、模型0；新角色status仍MEMORY_POLICY_DENIED。Sharing测试同时覆盖有/无ACK均等待实际模型回调settlement，迟到输出不保存；原始sticky/未知退役保护仍通过。测试fakeWebServer origin/loopback/realpath作真实管理前提，不放宽生产guard。

候选tree98b17f0ca87981c20b6e63367f61a79600db1475，399项校验一致，旧程序备份qq-role-barrier-20261111T161926045Z。官方pluginManager setBundleEnabled false/true均application=applied，Host active；无需整App重启，最终依赖和bundle列表与原profile一致。再次正式load成功，当前app/红豆/epoch8（2026-11-11T16:19:41Z），bridgeRestarted=true，旧桥接状态2文件归档。没有覆盖旧current/index或删除Alpha。新桥接PID40161、3100监听、dshReady=true、revision3、QQ typed记忆status正常；等待原角色下新消息真实闭环。


### 当前最终门禁与验收边界

2026-11-12最新audit192/192退出0，协议17退出0；全插件npm test因浏览器findBrowser的版本probe偶发失败停在test-douyin-companion-ui，单独重跑同UI测试退出0；严格从失败后的下一命令续跑全部剩余命令（含33个Memory插件脚本）退出0，没有跳过断言/调低门槛。角色API红绿与有/无ACK Sharing等待/释放/迟到输出测试通过。实际当前角色app8、V2事件0，仍待用户切回后新消息；SDK假模型与假ACK不能替代真实QQ闭环。

可直接转发的发布交接补充：候选98b17f0ca87981c20b6e63367f61a79600db1475（本地未提交树），修复QQ/Host scope不一致、Native生产组合与一次性发送回执、失败状态、审批TTL反馈/回读、同步release清理、测试用户目录隔离、正式角色切换的私有退役ACK。真实原角色已由用户批准恢复，无发布/版本更改。门禁与备份见本case；真实模型+QQ ACK待用户新入站，因此当前不作为已完成真实验收的发版依据。包管理器声明仍指向旧包，未来重装可覆盖本地程序候选；发布会话应从最终提交重新构建/走正式包安装，并保留最新用户配置/账本，不回滚用户新数据。

## 最终续修结论 2026-11-12 01:49

文字回复已由原角色app8真实验收，并有两次无管理唤醒的后续私聊；用户最终将QQ额度改为每日50亿Token/cny:null并明确新增仅群1135502130处理授权。后续Native语音/群@、白名单同页启用和重复许可L2全部修复实装，用户确认语音能播放、群有回复。最终tree3927fa47d90265e5ae6db33310935005efa75e90，400项一致，audit195/协议17/插件完整覆盖、真实SDK/官方离线制品与原生UI均已核对；详见2026-11-12-qq-native-voice-access.md的最终验收与交接块。本case前述待验/不改额度/未授权群仅表示当时边界，不能当作最终当前状态。

> 2026-11-12 本地收拢：本case中的临时工作树与历史测试资料已按用户明确“不备份”要求删除；有效源码已按功能提交合入dev，当前程序和真实数据保留。提交与清理结果见[本地收拢case](2026-11-12-functional-commits-and-safe-cleanup.md)。
