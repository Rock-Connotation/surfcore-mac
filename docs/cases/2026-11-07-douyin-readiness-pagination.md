# 抖音首页推荐：等待初始化、确认翻页与独立身份复核

## 现象与已证实根因

原已登录首页返回DOUYIN_FEED_UNAVAILABLE。只读基线：fresh self匹配原绑定账号，视频可见且实际播放，精确官方tab/feed请求0。操作前后截图均有新手引导；生产snapshot在goto(domcontentloaded)后立即读到tutorialCondition=false，8秒后真实引导出现。按钮角色实际可匹配，不能将问题归因于按钮选择器。旧逻辑随后连续发送4次下键，没有等待初始化、核对引导消失或确认画面切换。

独立副本对照：等待可见播放器就绪、关闭引导、逐次真实翻页，第4步取得原固定/aweme/v1/web/tab/feed/的HTTP200，生产parser得到5项。没有采用SSR、游客、作者作品或module/feed作为替代来源。

修复播放器时序后，真实service首轮已取得tab/feed，但最后身份复核再次调用loadRecommendations，多做一轮翻页并触发VIDEO_NOT_ADVANCED。最终身份复核只需刷新产生新self；不能忽略该错误或削弱账号校验来“修绿”。

## 完整逻辑

1. 链路：原生抖音设置页→鉴权API→角色service.readFeed→browser.start/loadRecommendations/reload→当前浏览器固定self/feed→生产parser→最多5条公开推荐字段。浏览器准备与分页由browser拥有；身份前/中/后及世代由service拥有。
2. 机制：domcontentloaded不等于视频/引导已挂载，连续下键也不等于4次切换。现在等待视口内面积最大的可见视频具备来源、可播放且位置稳定200ms，重读并关闭引导，再每次等新视频稳定后发下一键。轮询中若发现迟到引导先关闭，仅在原画面未切换时补发一次；再次受阻立即失败。最后身份复核用reload，仍要求大于cutoff的新self；身份变化/失效仍不可由后来的相同账号复活。
3. 范围：browser/service两个模块及对应测试，Host API/设置页仍读原契约；最多4次确认切换、1次迟到引导阻键补发（总按键最多5次）、5条结果，账号/来源/角色保护不改。正常页面浏览会影响该独立账号推荐历史；本轮不调用模型，不点赞/评论/转发，不写完整观看/ASR/主观记忆，原profile与脏树保留。
4. 取舍：固定sleep成本低但网络/动画变化仍可能吞键；采用有界的可见播放器稳定和真实切换判据。忽略第二次分页失败会掩盖错误；把最终身份复核改为既有reload，减少无用翻页且保留新身份响应。新增元数据仅在页面临时轮询参数中，不写页面全局、日志或结果里的媒体URL。
5. 生效：需安装新包并重启独立Host；抖音仍默认关闭，账号绑定保留。等待谓词同步执行，避免async Promise被当truthy的SDK陷阱；每个SDK句柄finally释放；guarded捕获当前context与命令active标志，超时finally撤销，异步链每次键/点击前再核对，关闭挂起/旧等待迟到均不能继续输入。超时/关闭仍按原锁与关闭确认规则处理，不删除未知锁。
6. 验证：拥有方新增延迟挂载夹具，旧代码明确红灯late guide未被关闭，修复绿灯；覆盖屏外预加载视频、引导点击不生效、视频未就绪、首个切换失败即停、迟到引导最多补1键、输入框焦点不发键。独立审查另复现超时后继续4键，新增真实拥有方等待夹具先红4!=0，取消标记补修后超时/关闭挂起均0键；同步predicate夹具也拒绝Promise，保持SDK语义一致。service新增最后复核不得二次翻推荐的夹具，旧实现红、改reload后绿；既有账号不匹配/迟到/退出/世代测试保留。真实生产service副本已完整通过：32837ms，1次推荐导航、原固定feed200/5项及3次新self，迟到引导路径实际发5键；service dispose成功。同源原生Host及组合门禁结果见收工。
7. 回滚：关闭本轮独立实例，回装上一包，保留新增账号/浏览器资料与所有旧账本；原件仅用于生成私有副本，不拿旧快照覆盖新数据。接口变化/风控、睡眠/长期稳定性、其它设备、视频ASR/互动仍不在本次通过范围。

## 失败可见与下一步

DOUYIN_PAGE_NOT_READY：等待独立浏览器首页视频显示后重试；DOUYIN_TUTORIAL_NOT_DISMISSED：在专用窗口关闭“我知道了”后重试；DOUYIN_VIDEO_NOT_ADVANCED：确认引导已关、视频能正常切换后重试。三者都有code/error/hint且测试断言；API/设置页沿用已有持续错误展示，不自动清空。验证码仍交还用户，源响应和账号不符继续拒绝。

## 收工实证：2026-11-07 10:41

- 代码faa7976、已验程序6c88e72，版本0.8.8；四个源码/测试文件与独立复审冻结hash一致。官方Node24 audit174/174、完整regressions/插件均exit0，815项Git对象清单问题0。原源码拥有方4类红绿日志、五项专项与独立VM复核均保留。
- 强审查发现并复现命令超时后继续发键P2；补命令active/context校验后同一复现extraKeys=0。独立追加检查：迟到引导吞首键最多5键/4次进展；首键已切换后出现引导保持4键；恢复再被拦2键即失败；验证码1键后停止、0次点击。最终无新增确认重大问题。
- 真实严格service副本32837ms通过、返回homepage-recommendation/5项；网络元数据为3个新self和原tab/feed200，正常关闭。旧service1/2失败没有覆盖或抹去。
- 同源自包含包SHA256 22ee50b67dae24c030ad02c4588b593e28841d54688c6ae6d3271d670f98b075；官方CLI离线装入全新DSH验收副本，330包文件一致、670持久文件安装前后未变。原测试profile只用于复制，常用实例不升级。
- 原生UI实测：设置→SurfCore→抖音，默认关闭/已绑定账号→实际勾选启用→实际点击“读取本页推荐”。只观察该UI的原fetch响应，不伪造响应或从脚本另投read；实际HTTP200/ok=true/source=homepage-recommendation/count5，DOM有5个官方视频链接、alerts为空，截图核对页面显示。读后state=idle、账号仍配置，证明专用浏览器正常关闭。
- 临时原生fetch观察器恢复并移除；实际取消勾选，enabled=false/state=idle/accountConfigured=true。原生PID菜单退出后8个owned进程全消失、2个监听端口关闭、整个本轮目录浏览器锁0、owned runtime0；常用App仍在。全部账号/副本/证据保留，没有删除未知锁。
- 本轮模型0、点赞/评论/转发0；旧模型4与QQ文本9账本未增量。正常浏览/翻页的推荐历史副作用保留，不宣称完整观看或点评。未新增睡眠/长时稳定性/Windows或其它设备证据，未发布/tag/push。
- 私有证据索引：20261107-douyin-readonly中的baseline/dismiss/paced结果、service-real、service-real2、service-real3、fix-review、checks-results、native-ui-result/native-success截图、native-final-state、cleanup-final及FINAL-RESULTS.json。原始账号/页面/签名信息不进入公开材料。

## 可直接转发的发布交接块（非发布授权）

```text
分支fix/macos-readiness；功能faa7976，已验证程序6c88e72，版本0.8.8不变；后续文档/清单见git log。
问题：DOM加载完成后立即读引导并连续发键，前端尚未初始化导致首页feed缺失；最后身份复核又额外翻页。新等待链若仅用Promise.race超时，会在返回后继续输入。
修法：browser等待最可见、可播放且位置稳定的视频，核实引导关闭，每键确认新视频；迟到引导最多补1个被阻键，最多4次确认切换/5键，再失败即停；同步轮询无页面全局，句柄finally释放；超时/关闭每次后续点击与按键均验证命令和context。service最后复核仅reload取新self，来源、cutoff、账号变化/失效和角色世代保护不变。
文件：plugins/surfcore/lib/douyin-{browser,service}.mjs，对应test-douyin-{browser,service}.mjs；ROADMAP/HANDOFF/PITFALLS/COORDINATION及本case。
验证：官方Node24 audit174/174、完整回归/插件、专项/拥有方红绿与独立强审查通过；Git对象清单815项问题0，严格隐私零命中。真实严格service和官方App原生按钮均返回5条原固定首页推荐，UI显示5链接、无错误，读后idle。
制品：同源包SHA256 22ee50b67dae24c030ad02c4588b593e28841d54688c6ae6d3271d670f98b075；CLI离线安装330文件一致、670持久文件未变，收工330文件复核一致。
影响：默认关闭渠道的浏览器时序补修，未扩大官方feed来源、账号受众或互动权限。正常翻页会影响专用账号推荐历史；本轮模型0、点赞/评论/转发0，旧预算不增量。
生效：升级同源包后完全重启Host；抖音启用后按原按钮手动读取。回滚重装旧制品，保留新账号资料/副本和所有旧账，不拿旧快照覆盖新数据。
终态：验收副本抖音关闭、账号保留；8owned进程/2端口/全部本轮浏览器锁已清零，常用App仍在，原profile及原脏树保留。临时UI观察器已移除，不进入制品。
残余：当前通过账号绑定与首页推荐文案读取；睡眠/长期稳定性、Windows等设备矩阵、完整视频观看/ASR/自主点评/互动未由本次证明。不是发布授权；由发布会话定版本并跑发布三门禁，本轮不bump/tag/push/Release。
```
