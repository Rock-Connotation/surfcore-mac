# QQ macOS 基础私聊验收与交接（2026-11-07）

**基础私聊已真实跑通**：用户常用 QQ → 独立 NapCat 小号 → 官方 DeepSeek Harness App → Magpie WorkBuddy Hy4 → 小号回复常用 QQ。官方 App 显示对应会话、输入和回复；平台 `get_msg` 读回账号/正文一致，用户确认手机收到 `qq链路验收通过-1107`。

这是唯一白名单私聊、测试角色与有界费用的实证。群聊、真实提问/审批往返、图片/语音、常用 profile 安装及持续在线未验；不称 QQ 全能力完成。版本仍0.8.8，未推送、打tag或发布。

## 程序、环境和制品

- 工作树 `../surfcore-macos-implementation`，`feat/macos-implementation`，基线864245b；worker独立qq-model/qq-host/qq-runtime/qq-gateway均保留。
- 功能提交：a611b6a（macOS WebUI打开及异步错误）、e013302（QQ模型失败准入、固定路由与界面建议）。**实际程序/制品源 `e013302ea39c53e59703b8b15d499a824fadbf1a`**；后续文档和清单提交不改变该程序字节。
- 目标是官方 `/Applications/DeepSeek Harness.app` 0.2.2-rc.1 的独立profile；App Node24.21.0，macOS/Apple Silicon。没有用网页代替DSH，没有修改QQ.app或常用App/profile。
- NapCat.Onebot4.18.42/v11，包内SDK1.14.20；镜像固定arm64摘要 `149fae81e2ccec10e5d1be2f9f86a1a2d6e1d5c70691f892dce00b7328f2ca72`，启动脚本与已审上游逐字相同。使用本机已有Colima Docker，仅新建本轮容器/网络，原3个容器保留。
- 自包含包SHA256 `daebaf6b95a9901605448476d385e7d5fbf84caa22fb0071212283f2b3b11996`，10,536,983字节、4605归档项、consumer lifecycle为空。官方CLI离线安装exit0，安装前后319持久文件不变；收工再核324包文件全部一致。

## 完整逻辑

1. **链路**：OneBot正向WS → 包内`src/bridge.js`入站/白黑名单/模式 → 当前角色与QQ上下文 → `ensureSession`/DSH `selectModel` → `session/prompt` → 事件流 → 出站守卫 → OneBot → QQ。Host负责设置与桥接子进程；上游HTTP/WS在验收时都经过同一私有文本网关。`ensureSession`的4个实际调用点为控制台通知、排队投递、批量唤醒与普通入站；源码定位见[模型case](2026-11-07-qq-model-selection.md)。
2. **机制**：旧WebUI直接spawn Windows cmd.exe、先报opened再异步ENOENT；旧模型准入忽略failed返回，可能对未知模型继续prompt。前者改按平台等待受限打开器回执，后者在新建/复用共同入口停止失败，并把code/error/hint传到QQ、接口和两处界面。固定供应商可显式设`dsh.allowModelFallback=false`，缓存键纳入策略，缺省保留旧兼容。旧黑话学习的直接选模型路径不在本修复内，验收关闭该功能。
3. **爆炸半径**：打开器为1个Host×2个读者×静默系数3＝6；模型准入为1个bridge×4个调用点×静默系数3＝12。新失败显式报告，不继续推理。真实测试另涉及一个QQ账号/一个收信目标、最多3请求/每次8192输出tokens、最多6条文本；所有群、自动研究、purpose/greetings、B站联动与巡航关闭。私有代理约束经过它的流量，不能当作全机防火墙。
4. **取舍**：原生NapCat Mac安装器需修改QQ.app入口并共享登录库；已有Docker的独立容器有约570MiB下载和协议验证成本，但任务数据可隔离、能单独停止，因此选择容器。复用现有OneBot协议，不新写QQ协议或假装SnowLuma有macOS原生发行。代码修复分别选择小型可注入打开器和共同会话准入，避免逐个prompt散补。
5. **生效/重启**：新包已在独立官方App加载，桥接执行包内程序。账号扫码由用户完成，用户在原生页输入并确认唯一常用号；保全页面草稿后通过既有重新读取、加入白名单和保存完成。启动早期页面曾有fetch failed且草稿未落盘，未保留原失败请求，不能确定根因；接口复查200，重读后保存正确，未改成固定HTTP端口绕过官方scheme认证。
6. **验证**：官方Node24下audit164/164、regressions、完整插件exit0（checks-2-ui-final），临时HOME/DSH_HOME且禁非回环网络。专项先红后绿；实际UI提示逻辑9/9；Astra R2无新增实质P1/P2。真实扫码、HTTP认证、SDK WS身份、原生启动、模型路由、QQ消息回执和手机可见均通过；详见下表。
7. **回滚/残余**：所有备份和运行材料在本地`_backups/20261107-qq/`。收工先关闭平台启动开关并显式停止独立QQ桥接，再退出拥有的App/子进程、代理、扫码页与容器；全部相关端口关闭，常用App及Host保留。恢复了独立profile原默认DeepSeek模型，只恢复该选择，账号、角色、会话、用量和回执保留。B站凭据摘要未变。代码可用旧B站package-4离线包回退，先备份并保持QQ关闭，不覆盖新增数据。其它能力与常驻安装仍需对象/预算明确的验收。

## 真实验收与原始证据

| 项目 | 结果 | 本地证据（相对于本轮_backups根） |
| --- | --- | --- |
| Mac打开器异步ENOENT | 旧实现红；新专项绿 | worker qq-host原始日志；[专项case](2026-11-07-qq-macos-webui.md) |
| 模型选择失败及缓存策略 | 新旧会话四场景零prompt；策略切换及UI红绿通过 | worker qq-model原始日志；ui-*.log；[专项case](2026-11-07-qq-model-selection.md) |
| 组合检查 | audit164/164、回归、完整插件均0 | checks-2-ui-final/results.json |
| 官方安装与同源 | 319持久文件未变，324包文件一致 | package-1/official-cli-install.json；final-results.json |
| 小号扫码/接口认证 | 真实Chrome扫码页完成；无认证403、有认证200且online | runtime/qr-page-visible.jpg；SDK及身份私有记录 |
| 包内SDK与NapCat | 正向WS读回同一账号，不发送 | sdk-readonly-redacted.log |
| 原生设置/启动 | 唯一私聊/无群，chat模式，DSH/QQ均ready，包内bridge | native-target-save.json；native-qq-start.json |
| 常用号→DSH→小号回复 | 一条真实私聊；get_msg账号/正文一致，用户确认收到 | first-qq-reply.private.json；first-reply-summary.json；QQ预算及events日志 |
| 官方App会话可见 | 对应会话、用户输入及助手回复均可见 | native-qq-thread.jpg；native-thread-visible.json |
| 真实WorkBuddy路由 | 2笔Hy4，HTTP200/stop，累计未超3 | magpie-first-trace.json；model-budget.json；model-status-after-first.json |
| 第二笔请求来源 | 实际会话有session/title-llm-request，同一Hy4路由、首条messageSeq | actual-title-request-evidence.json |
| 收工恢复 | App/桥接/代理/容器停止、端口全关闭、默认选择恢复 | runtime-stop.json；stop-e013302.json；default-model-restore.json |

两笔请求包括主回复及**官方App自动标题**，不是两条QQ回复。Magpie口径输入/输出分别为404/1341和2577/1961；不能把单条QQ消息算成一次模型请求，也不从目录零价格推断金额。余1次预算未使用，发送为1/6；本轮没有追加提问、审批或群测试。

## 运行中的问题与处理边界

- 初次外层sandbox-exec与Electron内置沙箱冲突，测试renderer退出。保全日志；SIGTERM无响应的仅本轮孤儿经独立userData核对后回收，改用官方App默认安全设置启动成功。未使用Electron --no-sandbox；外层沙箱尝试不算隔离通过。
- 仅回传工具QR图片时用户看不到；改为回环专用扫码页，凭据留服务端，实际Chrome截图及人工ask完成后才记为显示/登录成功。该页只辅助QQ登录，DSH仍是原生App。
- 私有文本网关曾被Astra R3发现部分listen失败提前释放锁，已实际红绿修复；R4确认等待listener/WS/待握手socket关闭，失败保留锁。最终SHA074be8b1…，完整假上游测试通过。它不进入发布包，不代替产品完整NapCat适配器；未知发送结果应停桥接对账，本轮无unknown。
- 两个平台关闭后的显式停止与退出按拥有进程核验；不把配置已保存等同子进程已退出。共享App日志先保全，不用旧日志覆盖常用App的新写入。

上游路线依据：[NapCat Docker](https://github.com/NapNeko/NapCat-Docker)、[Mac安装器](https://github.com/NapNeko/NapCat-Mac-Installer)、[SnowLuma发行](https://github.com/SnowLuma/SnowLuma/releases)。当前仅实测此Mac、此App/SDK/镜像与基础私聊，不能外推其他系统、版本或扩展动作。

## 可直接转发的发布交接块

```text
改了哪些文件：macOS受限WebUI打开器与Host调用；QQ模型失败准入/可选禁止目录替代；设置页/控制台hint；相关测试、三份case与项目状态文档
程序/制品源：e013302ea39c53e59703b8b15d499a824fadbf1a（功能a611b6a、e013302）；后续文档清单不改程序
测过什么、结果如何：官方Node24 audit164/164、regressions/完整插件均0；专项红绿、UI提示9/9；Astra R2无新增P1/P2；官方App+独立NapCat真实单私聊经Hy4回复、平台读回及用户收到确认
实际费用/外发边界：2/3次Hy4，含1次官方自动标题；1/6条文本；全部正常stop，无其他QQ动作
建议patch还是minor：修复建议patch，版本由发布会话决定；本轮仍0.8.8且未发布
case路径：docs/cases/2026-11-07-qq-macos-integration.md及QQ模型/WebUI专项case
改动层级/兼容：Host打开命令与桥接准入/失败展示；allowModelFallback缺省兼容，Windows原逻辑保留
完整逻辑/爆炸半径：见本case七步；群工具与隐私scope不扩大
失败路径：MODEL_APPLY_FAILED/error/hint、手动本机WebUI地址；失败分支红绿与实际渲染断言
回滚/残余：旧包和数据备份保留；进程/端口停止、默认模型恢复；群、真实提问/审批、媒体/语音、常用profile及持续运行未验，跨平台真机打开器未验
发布注意：私有代理、账号数据、截图/日志不进发布物；自包含依赖许可边界沿macOS首期case处理，不因本轮实测自动获得公开分发许可
```
