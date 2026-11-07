# macOS 首期组合：Host 接线、制品与验收边界

状态：WP0–WP5 已组合；最终程序/制品候选 **47e7e73** 已在官方原生 App 0.2.2-rc.1 的独立 profile 完成本机关键链路验收。版本仍为0.8.8，未发布；设计06的设备、质量与外发矩阵尚未全部通过。b9a42b2为前轮实际证据，后文按候选区分；历史段落保留当时状态。
本轮实际平台为 macOS26.6.2 / Apple M4 arm64 / Electron44.7.0 / App 随附 Node24.21.0。原有常用 App 未重启、常用 profile 未修改；用户另行授权了共享日志备份、新实例/profile、本机 Electron 接口和现场扫码的只读测试账号。二维码、Cookie、令牌及签名媒体地址不入交接。

## 完整逻辑

1. **链路**：官方 desktop Host 的 `plugins/surfcore/lib/index.js` 创建唯一 ASR 服务、B站媒体父作业和受保护 HTTP 入口；设置页与 CLI 使用同一个实例。B站 API 提交先经 `PlatformRegistry.observe` 检查渠道状态与固定活动身份，再获取分 P 媒体、提交 ASR、写观看历史、追加受限 ExperienceEvent，由 Host 单写者投影记忆。下一次 B站上下文读取统一卡；QQ 不可见这条受限观察。设置页显示作业、处理范围、末段文本、取消/恢复与经历失败重试；记忆页显示按角色绑定的最近维护失败与重试。
2. **机制**：本地 ASR 恢复产生关联新尝试时，API/CLI 返回新 jobId 与新状态；B站父作业保持原 ID。CLI 请求用当前 Host 生成的本机令牌，发现文件 0600、感知目录 0700；管理界面复用原 DSH 管理认证。服务端校验来源、角色及 epoch、受管素材真实路径。configure/persist/rollback 与提交共享串行门；本地请求不能自称公开 B站材料。B站下载/抽帧单槽，ASR 推理单槽，退出只取消本实例的受管进程；错误保留 code/error/hint。通用渠道 execute 未接外发实现，现有预算、静默和互动回执仍由原工具守闸。
3. **爆炸半径**：Host、CLI、设置页、bridge 是不同读者，状态串角或失去取消会形成高影响静默错误；本次新增目录在 SurfCore 数据根，涉及角色记忆、作业、素材与本地模型路径。早期夹具不读取真实账号；后续用户现场扫码只绑定独立测试 profile，允许只读身份及公开视频。未调用宿主模型供应商或平台外发。未改版本、tag、远端、常用 profile 或原常用 App。
4. **取舍**：A 让每个 CLI 自行下载和识别，接线少但长命令超时、重复推理和退出所有权难解；B 由 Host 管理持久父/子作业，增加状态与生命周期成本，获得统一取消、重启和结果归属。选 B。制品选择保留仓库相对布局并内置运行依赖；把散文件复制为插件虽小，却会依赖包外 `src` 和开发机 node_modules。模型/原生运行时另作有摘要的资产，不把机器与账号资料塞进 npm 包。
5. **生效与重启**：需将最终 npm 制品装入官方 App 的 desktop profile，再由 App 重新装载 Host/客户端。QQ bridge 若使用新源码也需单独重启；QQ 关闭时不需启动它。已在用户授权后实际启动、安装和多次重启独立测试实例；原常用实例保持运行。`DSH_HOME` 与 `--user-data-dir` 可以隔离 profile、用户目录和单例锁，但官方 App 会使用共享 macOS 日志目录并启动清理旧崩溃日志，不能称完全无副作用的并行启动。
6. **验证**：最终47e7e73组合 `npm run test:audit` 163/163、regressions、完整插件套件均exit0，555个程序输入与git blob同源，清单756/756。官方App实际零PCM、241秒非零分块、96秒无平台字幕B站素材、原生UI与新进程记忆读回通过；前轮b9角色/恢复/回滚证据另列。插件全套、regressions 和 HTTP 链路结果见下方证据。真实中文样本在官方 Node24.21.0、便携 FFmpeg/FFprobe、便携 whisper、small 模型、纯系统 PATH、无 DYLD、中文空格新目录中，CPU/Metal 均处理 0–6463ms 无缺口；文本仍有错字。清晰 AISHELL 两条样本的 base/small 对比只有局部基线，small 为本机安装候选，未形成全面准确率门槛。
7. **回滚与残余**：代码备份在主树 `_backups/20261106-macos-wp0/`，子任务各自 case 有原始证据。回滚先停止新任务、保存新增经历/作业，再还原上一制品和兼容快照；不得删除整个数据根。独立测试 profile 已保全配置、安装记录与共享日志；官方 CLI 回滚旧包再装回新包，160 个持久文件摘要不变，包含新扫码绑定/评分/日记/记忆。旧包未执行，不将安装回滚说成降级数据迁移通过。Intel、Windows、其他macOS、直接双击常用App图标、热重载和休眠/唤醒仍待验；Finder显式环境启动器与关窗/真正退出已实测；不能宣告首期全部完成。

新增资源准入默认限制单素材2GiB、6小时、32个等待消费者；转码前按512MiB余量与预计PCM/分块空间预检，不自动删素材。已在运行的共享推理可增加消费者，不占等待名额。空间检查是时点估算，不是磁盘空间租约。

## 原始证据

证据路径均相对主工作树，特别注明者除外：

- `_backups/20261106-macos-wp0/audit-full-composition2.log`：156/156；首轮 155/156 的剩余静默计时夹具已修，见独立 timing case，不降低静默下界。
- `_backups/20261106-macos-wp0/plugins-final-composition2.log`：插件全套 exit 0；增加渠道入口/详情后最终结果另追加。
- `_backups/20261106-macos-wp0/regressions-full-composition2.log`：全部通过。首轮 R11 畸形 Markdown 性能阈值 536ms 超过既有 500ms，在并行负载结束后原断言、原代码重跑通过，首轮日志保留。
- `_backups/20261106-macos-wp0/composed-perception-host-channel.log`：真实 HTTP→渠道准入→B站父作业→共享 ASR 队列→观看历史→经历→记忆→下一上下文；素材获取与识别引擎是确定性夹具。渠道关闭时拒绝并不创建作业，开启后 P2/cid2 覆盖到尾、经历一次、B站可召回、QQ 不可读。
- `_backups/20261106-macos-wp0/{channel-contract-final,perception-api-final,client-contract-final}.log`：运行契约 8/8、HTTP 权限/epoch/配置串行/范围限制、客户端契约通过。
- ASR 真实资产组合：`../surfcore-macos-asr/_backups/原生 验证 Node24 20261106/result.json`，CPU 11945ms、Metal 2152ms，是两次单轮样本而非稳定性能统计；实际引擎日志分别确认 CPU 关闭 GPU、Metal MTL 后端和嵌入式库。
- FFmpeg/FFprobe 与便携 whisper 的源码、摘要、许可、平台边界见 native-assets 和 shared-asr case；未公证、未核验源码标签签名，不声称正式分发已就绪。
- 官方 App 只读源码：`app.asar/lib/main.js` 的 resolveDesktopPaths / claimDesktopSingleInstance / initDesktopPaths / pruneCrashReports。Electron44.7.0 的 [用户目录处理](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/app/electron_main_delegate.cc)、[锁与 userData 映射](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_app.cc)、[共享日志路径](https://raw.githubusercontent.com/electron/electron/v44.7.0/shell/browser/api/electron_api_app_mac.mm)。CUA 只读确认官方 App 有现存工作窗口；没有把网页或 Node import 当成 App 装载证据。

## 设计 06 编号验收

环境 E3：最终47e7e73的真实官方原生App独立profile，凭据由用户现场扫码，只读；E3新包结果与b9历史证据按文件名明确区分。

环境 E1：本机 macOS26.6.2/Apple M4/arm64；开发树 Node26。E2：官方 App 随附 Node24.21.0 + 便携媒体/whisper + small，纯系统 PATH；E2 仍不是 GUI App。以下“夹具通过”仅限列明输入，不能转写成实机通过。目标为最终组合候选（HANDOFF 指向 final-results.json 记录 SHA），原始基线 52ced0f；安装到 App 的提交另记。

| 编号 | 输入 / 预期 | 实际与状态 | 证据 |
| --- | --- | --- | --- |
| CORE-T01 | 同角色 local/B站/QQ 身份一致 | 夹具通过，共享上下文、id/epoch/revision | shared-core 7/7 |
| CORE-T02 | 超长核心卡，总预算及层保留 | 夹具通过，分层预留/裁剪诊断 | shared-core / persona tests |
| CORE-T03 | QQ/B站均关闭，核心仍维护 | 夹具通过，Host 本地维护与目的读取 | shared-core |
| CORE-T04 | QQ关闭，B站账本→经历→卡→下次上下文 | 真实96秒无字幕素材；人工评分/日记→实际Host导入→新Node的B站上下文召回，QQ视图隐藏；不是自主模型评价/实际模型回忆 | native-b9-memory-{input,maintain,readback}.json |
| CORE-T05 | 重复导入/完成不重复消费 | 夹具通过；实际Host重复maintain后事件数与6条卡ID保持不变 | native-b9-memory-dedup.json |
| CORE-T06 | 长作业中切角色 | 实际本地ASR运行中app/epoch2→artifact/epoch3；旧作业完成仍归app2、新角色查询JOB_FORBIDDEN、不写新卡；B站/QQ晚到仅夹具 | native-b9-role-isolation-result.json |
| CORE-T07 | 私密/未知材料进入公开上下文 | 夹具通过，restricted/未知 fail closed | shared-core / API |
| CORE-T08 | 清理可再生缓存不删人格记忆 | 缓存范围/lease 夹具通过；全程清理后证据状态实机未执行 | shots-cache / bili frames |
| CORE-T09 | 模拟新 local adapter | 夹具通过，提交受限事件与允许视图，不复制核心 | channel-contract 8/8 |
| CORE-T10 | 登出/绑定变化保留核心 | 真实账号未执行 | 待 App 登录验收 |
| CORE-T11 | 退出重启恢复，过期活动不补发 | 实际App退出回收Host/whisper，重启旧job interrupted，原生UI恢复为关联新尝试并覆盖241000ms；自治过期活动仍为夹具 | native-b9-recovery-result.json |
| ASR-T01 | 无字幕中文到末尾 | 最终47真实BV1WW411a7qQ/P1/cid27455257无平台字幕，whisper完整0–96000ms；末句经用户试听比对一致（繁简/标点归一），不是整段CER | native-47-bili-result.json / native-b9-real-bili-human-tail.json |
| ASR-T02 | 有字幕视频 force 仍调 ASR | 实际109秒口播有62行AI字幕，仍运行whisper；媒体末尾29ms未确认，partial如实保留 | native-b9-bili-readonly-result.json |
| ASR-T03 | P2 音轨/字幕/画面/历史一致 | 真实古诗P2/cid284493364：字幕、ASR、9帧、历史对齐，末尾390ms缺口；教程P2帧成功但ASR越界失败；弹幕实机未验，不能全通过 | native-b9-bili-{more,p2-poem}-result.json |
| ASR-T04 | 全 durl，跨段不归零 | 夹具通过所有分段/映射；真实平台待验 | bili-media |
| ASR-T05 | DASH仅音轨 | 真实96秒无字幕样本仅请求音轨，本地ASR完整；未因缺视频轨拒绝 | native-b9-bili-old-result.json |
| ASR-T06 | 中间失败/截断 | 夹具覆盖中间失败；真实音轨与页面时长差29/390/832ms均保留partial和精确缺口，未把差值直接认定真实截断 | 原生多样本结果 / bili-media / ASR service |
| ASR-T07 | 超过工具等待的长作业 | 最终47真实App以持久job处理241秒合成重复片段，提交即返回jobId、多次查询后两块完整；不是241秒自然B站长视频 | native-47-long-result.json |
| ASR-T08 | 静音/音乐/低声/BGM | 最终47真实10秒全零PCM为no_speech、0段、EXACT_ZERO_PCM；±1非零走推理由夹具钉住。一般静音/低声/音乐完整质量集仍未通过 | native-47-silence-result.json / exact-pcm-silence case |
| ASR-T09 | 分块边界/真实重复句 | 最终47在241秒合成重复片段完整处理、保留238500–240500ms跨界句并显示ASR_CORE_RETRY；自然重复讲话精度不作扩大保证 | native-47-long-result.json |
| ASR-T10 | 取消/退出/恢复 | 实际原生推理取消后退出；App退出回收、重启interrupted、原生恢复按钮产生linked新job并完成；取消为终态不恢复 | native-asr-result.json / native-b9-recovery-result.json |
| ASR-T11 | 同音频并发 | 夹具通过，共享推理与独立消费者 | ASR service |
| ASR-T12 | 改模型/语言/访问范围 | 夹具通过，摘要与缓存隔离 | ASR service |
| ASR-T13 | 缺模型/损坏/错误架构 | 失败分支夹具通过；E2 缺资产实际 failed+hint | ASR service / native result.json |
| ASR-T14 | 本地/B站共用且ASR不读Cookie | 最终47实际同一App Host处理本地241秒与真实B站96秒；ASR只收资产的边界由源码/契约断言覆盖 | native-47-{long,bili}-result.json / service tests |
| MAC-T01 | Finder与终端能力同源 | 实际Finder打开本地显式环境启动器→官方二进制，纯系统PATH/无DYLD仍为app-resources Node24、媒体/ASR就绪，新1000ms作业成功；未声称直接双击常用App默认profile | native-47-finder-{owner,result}.json / finder-launch-plan.json |
| MAC-T02 | 实际.app资源Node，缓存未备 | 实际探测24.21与能力通过 | runtime case |
| MAC-T03 | Electron Node模式显式环境 | 选择/隔离环境夹具通过；实际Electron版本只读核验 | node-path tests |
| MAC-T04 | Edge/Chrome位置与错误路径 | 实际隔离二维码显示并完成身份核验；错误路径与所有权仍由夹具覆盖 | native-b9-qr-verified.json / QR tests |
| MAC-T05 | 扫码成功/取消/过期/早退 | 用户现场扫码成功、只绑定fish、owner仍空；取消/过期/早退为夹具，未把成功样本扩大为全通过 | native-b9-qr-verified.json |
| MAC-T06 | 扫错账号原凭据不变 | 既有身份校验夹具；真实扫码未执行 | 插件测试 / 待实机 |
| MAC-T07 | 显式媒体路径、缺失与不可执行 | E1/E2实际工具与失败夹具通过 | runtime-media / native-assets |
| MAC-T08 | 中文空格/自定义数据根 | 实际官方设置页、随附Node CLI、Host、人格/作业/记忆均使用同一中文空格根；未写包内config/state/roles | 原生persona/ASR/memory与listener记录 |
| MAC-T09 | QQ未启用不阻断核心/B站 | 实际QQ关、B站ready、生物钟false，真实素材/人工账本/Host记忆维护成功；九项主动和外发开关关闭 | native-b9-readonly-ready.json / memory结果 |
| MAC-T10 | 关窗/真正退出/热重载 | 实际关窗销毁page但main/Host持续存活；真正退出回收owned进程与端口。运行中退出/恢复另有b9原生证据；热重载/睡眠未实测 | native-47-window-close-result.json / native-47-finder-stop.json |
| MAC-T11 | desktop安装重启、Host和client可见 | 最终47官方CLI离线安装/实际重启/原生client、Node、ASR、失败/恢复可见；新装前后206持久文件不变 | upgrade-47e7e73/upgrade-result.json / native-47 UI证据 |
| MAC-T12 | helper失败/旧pending | 真实隔离复制和身份拒绝通过；未动真实安装 | install-identity / update tests |
| ACTION-T01 | dry不写平台/成功额度 | 既有离线回归通过，未外发 | 插件+regressions |
| ACTION-T02 | 静默/额度/目标门禁 | 既有回归通过；通用execute未接外发 | 插件+channel-contract |
| ACTION-T03 | 指定目标成功互动回执 | 未执行，无外发对象授权 | 待单独授权 |
| ACTION-T04 | 超时结果unknown不盲重发 | 既有回执夹具通过；真实平台未执行 | 插件回执测试 |
| ACTION-T05 | 发布成功通知失败不重发 | 既有回执夹具通过；真实平台未执行 | 插件回执测试 |
| ACTION-T06 | 重试读取不重复外发 | 新链路无外发handler；经历稳定ID夹具通过 | bili-host / channel-contract |
| ACTION-T07 | Windows账号/路径/进程/更新 | 保留原代码与适用断言；Windows实机未执行 | node/QR/update tests |

## 额外只读检查

`privacy-scan --strict` 在最终候选前与冻结基线52ced0f均报告46处、逐项相同（历史Windows路径/占位标识等），不改规则或清理无关资料来转绿。日志 `privacy-final.log`、`privacy-baseline52.log` 保留在 WP0 证据目录。本次未发现新增扫描命中；该结果不等于公开发布隐私门禁已通过。

## 首次授权前的最小实机方案（历史，1/2已获授权并执行）

以下保留最初的授权边界；本轮已授权独立实例与只读扫码，常用profile仍不是同一对象：

1. 保全官方 App 共享日志后，以独立 DSH_HOME 与 user-data-dir 启动同一官方 App，不退出用户当前实例。安装只进入测试 desktop profile，QQ、B站自动活动和更新检查保持关闭，不复制真实账号；用新角色验证 Host/client、成功/失败显示和退出重启。
2. 人工在该实例完成 B站扫码（不读取/抄录凭据），明确只读选定视频；用本地 small/Metal 执行无字幕视频和末尾核对、记忆闭环。评论、点赞、动态、分享与付费模型调用均不包含在此步骤。
3. 真实常用 desktop profile 的安装/重启是另一个影响对象，需要具体安装前快照及恢复清单。不要把用户选择官方 App 当作已经授权这一配置写入。

停止测试时只退出新实例；测试目录和新增经历保留。共享日志如有轮转变化，保留启动前完整副本，不以恢复覆盖正在写入的日志。

## 可转发发布交接块

```text
程序/制品候选：47e7e7338658d3afc5a596ebf152060a3ec0c371；版本仍0.8.8。之后的收工文档提交不改变程序。
文件：共享core/ASR、Node/媒体/浏览器运行层、Host API与原生client、B站分P媒体/历史/经历、安装身份/自包含包；完整功能提交与独立case见案例索引。
验证：官方Node24下audit163/163、regressions和完整插件exit0；555程序输入与git逐blob匹配，manifest756/756。官方App独立profile中，10秒零PCM为no_speech/0段；241秒非零分块完整；96秒真实无字幕视频完整且末句人工核对；新进程记忆读回成立。
原生边界：角色切换/旧草稿/实际409、运行中取消和退出恢复、160文件包安装回滚保留数据来自b9；最终47升级206文件不变。Finder显式环境启动器与关窗后后台/真正退出均实测。
建议：功能性minor候选，版本由发布会话/用户决定。本批不bump、不tag、不push、不发布。
层级：新增共享上下文/经历/渠道与感知作业接口；旧metadata/scope/记忆/预算兼容。包安装由DSH更新，源码安装以身份和来源绑定。
完整逻辑与爆炸半径：本case七步及各WP/静音case。失败：原生界面展示code/error/hint与缺口/恢复；非法时间戳和无法确认的源尾段仍失败/partial；未填范围、未裁词、未自动上传云端。
未验证：直接双击常用App默认profile、插件热重载/物理睡眠、真实durl多段、全面质量门槛、Intel/Windows/其他macOS、真实外发、正式分发签名与LGPL源码交付。尚不能宣称设计06全面通过或直接发布。
回滚：先保留新增账号绑定/经历/作业，再停精确owned实例，恢复上一制品和兼容快照；不要清空DSH_HOME、覆盖常用profile或共享活动日志。旧包未执行，安装回滚不等于降级schema迁移。

```

## 冒烟脚本隔离修正

旧 `test-host-smoke.mjs` 标注只读，却默认加载真实路径，并在 apply / 身份对齐夹具中创建状态目录和日志。主线直接执行时确实继承了默认home；检查仅保留元数据，默认SurfCore根有9个顶层项，配置、凭据和当前角色文件均不存在，未启动真实App或渠道。记录 `default-home-test-write-inventory.json`；不按猜测删除这些文件。

选择让脚本自身创建临时DSH_HOME和假源码根，并在设置环境后动态import Host，避免ESM静态导入早于环境赋值；相比只要求调用者记得设环境变量，成本很小且更可靠。最终整套检查另有独立数据根。通过 `host-smoke-isolated-final.log` 证明修正版执行成功；默认home现存文件保持原样。此为测试隔离缺陷及其修复，不能把之前的运行描述成完全没有本机写入。

## 可审阅的本机候选目录

已预备 `_backups/20261106-macos-wp0/官方App 验收候选/acceptance-plan.json`：新DSH_HOME、独立Electron userData、便携whisper七组件、便携媒体两程序、small模型及中文样本均已复制并核对摘要；没有启动App。模型、原生资产和真实路径继续忽略，不进源码提交。默认关闭QQ/B站启动、更新、扩展和B站外发/通知；扫码与真实只读视频安排在明确的后续授权内。最终npm包及哈希在final-results.json记录。

## 真实官方App安装阶段补充

用户在候选3a480c3/包SHA c930ca23…准备完成后明确回复“我授权，请继续”，授权保全共享日志并在独立App/profile安装验收。原10份日志已复制保留，当前工作App PID29069没有重启或修改profile。先前“未启动”的结论仅属于该授权前快照。

新App隔离DSH_HOME/user-data-dir已实际初始化desktop profile。App自带CLI载体的desktop管理权限经源码核对并实际运行；首次 --offline add 下载0、加入surfcore后以ERR_PNPM_IGNORED_BUILDS拒绝根postinstall，bundle尚未启用。原始失败日志、启动PID与备份记录在本地“官方App 验收候选”目录，不把部分安装描述为成功。

修复路线与七步逻辑见新增的package-lifecycle、package-data-paths及package-data-consumers三个case。主线同时把设置页语音名校验、源码诊断与账本目录打开指向对应数据/程序路径。普通源码安装不搬迁；已验证包安装将可写QQ数据保存在DSH_HOME/surfcore/qq；活跃角色人格仍以characters为真相，旧包有数据时先保留并报可行动错误，不自动迁移。

CUA目前只能返回原同名App的窗口，未对其点击或配置写入；独立Electron调试控制方式已单独向用户询问。该工具限制不影响代码修补、组合测试和官方CLI本地安装。尚不能把启动了新App进程记为原生界面验收通过。

重启与回滚：新包只需重启本次记录PID的隔离App；不重启常用实例。旧候选包、旧profile安装过程、共享日志备份和新增数据全部保留。若候选失败，停本次实例并使用保留的隔离副本恢复；不覆盖当前用户日志，不迁移真实用户数据。

组合检查首轮141/161：18个桥接夹具因VM剥离import后未注入新解析器失败，已在共享harness注入生产解析器和相同隔离env；端口夹具建立真实有效旧根，保留所有归属/多活断言。另一个生命周期helper用env node且只等1秒，就绪断言失败；受限PATH可复现同断言及env node缺失，但原审计未记录子进程stderr，不能断言原失败仅由PATH造成。修正版用当前Node绝对路径、注册信号handler后发ready、有界等就绪且提前退出可见，始终校验取消/超时真的退出。原始失败日志保留，新组合结果另记。

修正版组合：官方Node24.21.0、新隔离DSH_HOME、便携媒体PATH下，audit161/161、regressions和完整插件测试全部exit0；原始结果 `_backups/20261106-macos-wp0/native-fixes/checks-20261106T140408Z/results.json` 含程序文件摘要，提交后校验同源。Astra独立审查关闭显式旧数据根/程序根错位P2，没有新实质发现；未将离线结果升级为原生界面通过。

## 原生界面与边界修复进展

b722222制品在官方App内确实加载Host与settings.section客户端。用户另行明确许可Electron接口，主线仅控制PID/loopback已核对的测试窗口；已有用户窗口没有点击或配置写入。共享日志备份、首次部分安装、最终CLI成功、手动启用测试bundle的profile备份、所有新旧候选均保留。实际App的Node诊断是24.21.0/app-resources，ASR独立于未配置TTS/关闭QQ。

本地中文4204ms实际结果逐字匹配13字参考；241s重复公开片段在原生推理中取消，响应前whisper退出。新作业在运行中退出测试App，Host/whisper均退出且原App存活；重启原作业interrupted，恢复产生新job但首块时间戳超界返回partial。取消为终态；第一次验收脚本把cancelled当resumable的拒绝记录保留，不修改产品规则迎合脚本。原始chunk0 241000ms最后offset到242000，chunk1跨界句被中心过滤，新增case记录一次strict core重解码及合并修复，不将coverage当准确率。

原生UI还暴露partial无原因/恢复按钮以及PersonaEditor在角色切换后保留旧草稿。已通过界面创建并加载app/epoch2，观察10秒后编辑器仍指artifact-check；没有点保存。新角色ASR列表为空、旧job查询返回JOB_FORBIDDEN，说明作业隔离正常但编辑器生命周期有缺陷。对应客户端key/匹配读取/冻结身份与Host409护栏已经组合；旧API省略字段兼容，实际新页面待重新安装后复验。

本轮独立Astra检查关闭queued迁移持久化静默吞错P2，复核人格请求完整body之后、写入之前的身份检查及同步路径快照；未发现新的实质缺陷。四个新增case含完整七步逻辑和发布交接，最终组合与原生证据仍统一在final-results.json。

本轮组合门禁已完成：官方Node24.21.0、独立DSH_HOME、便携媒体路径，audit162/162、regressions、完整插件测试均exit0。程序输入SHA-256保存在 `native-fixes/checks-20261106T144303Z/results.json`，本地功能提交后逐blob核验同源；新的npm包仍须实际官方CLI安装和原生界面复验，尚未以此门禁声称完成。

## b9a42b2 原生结果与静音补修

原生证据目录为 `_backups/20261106-macos-wp0/官方App 验收候选/`。b9包 SHA-256 `040b784d49433b0352674263e6192fd8c5c6bc93b2ccb9e53b9eaa1f7588bbf4`，官方pnpm11离线安装无生命周期审批，单独解包Host夹具也通过319项源码清单。新包不把运行依赖指向包外源码；账户和可写数据保留在测试DSH_HOME。

- 角色：原生保存先显示 `PERSONA_CORE_TOO_SHORT`，修正测试卡后成功落盘；运行中切角后编辑器立即读到目标卡，旧未保存标记消失。实际过期人格POST在备份/写入前409拒绝，两角色文件摘要未变化。
- 退出：只停止确认PID/userData的测试实例，原常用App持续存活。新作业 `008f380a-406f-4df0-9bd1-d277cb812bb3` 在退出时中断，重启后由原生恢复按钮创建 `e2dcf718-99e6-4e18-8855-9c990fce6bca` 并完整处理；auto识别尾块无文本保留为质量限制，不把这次生命周期成功等同边界文字准确。
- 回滚：官方CLI在测试App停止期间回退b722222、再装b9，160个选定持久文件（含新增账号绑定、模型、作业、人格和记忆）摘要不变。旧包未启动，不能宣称数据schema降级迁移验证。
- 平台：用户现场扫码，fish身份只读复核通过，owner未绑定。B站手动渠道ready时生物钟始终false；QQ、目的、桌宠聊天、QQ→B站、互动、动态、分享均关闭。读取完以普通设置保存关闭B站，之后才退出/切角。`SURFCORE_SKIP_AUTOSTART`不是全局调度禁用器，此顺序不能省略。
- 质量：真实无字幕96秒完整处理，用户确认末句“生活你给我压力，我还你奇迹”；只有结尾人工比对，不是全段准确率门槛。其他真实样本的partial/OUTPUT_INVALID照实保留，未扩大时间戳容差、裁掉越界句或填补未取到的源范围。
- 静音：10秒数字全零PCM实测产生8段生日歌幻觉，原脚本只断言完成和覆盖，错误地不足以验证静音语义。已保留原结果并增加严格PCM全零检测、空segments/no_speech断言、±1非零仍推理、畸形/旧缓存/取消测试；最终安装复验结果以静音case及final-results记录为准。

三个临时验收脚本曾分别误用URL pathname、遗漏必需asset摘要、依赖summary不返回的retryOf；另把auto识别结果必须出现末块文字当作生命周期判据。均保留原失败和修正后的独立结果，不改产品契约迎合脚本。它们不是对应产品故障；数字静音的真实错误则已转为必要修复。

发布交接：本批仍为0.8.8本地候选；建议功能性minor由发布会话决定。代码/接口与失败路径见本页七步及静音case；最终audit/回归/插件/清单、源码commit和制品摘要见HANDOFF与final-results。直接Finder启动、关窗/热重载/睡眠、真实durl多段、完整中文质量、Intel/Windows/其他macOS和真实外发未通过；不得直接发布或宣称首期全面完成。回滚须先保留扫码后新增数据，只操作独立实例，不覆盖常用profile或共享活动日志。

## 最终47e7e73实测收口

最终tgz SHA-256为 `dfc18295d9c8bfbc03669f804bd633cc91dfbe45245feb5a3a215ae714208e0c`，10,511,631字节/4600归档项/319项源码摘要。独立官方pnpm离线安装和消费者import通过；官方CLI安装后206持久文件摘要不变。新App真实处理三个输入：零PCM `0f1e8c0b-7f08-4e6f-b2b3-425706dc06e0`（no_speech/0段）、241秒 `f7d11d65-2360-4d9a-839a-5a5598c6f61c`（完整/58段/跨界保留/ASR_CORE_RETRY）、无字幕公开视频 `bili-f744080c-9acb-4bc4-8cff-08b066d531a9`（完整96000ms/经历完成/末句匹配人工参考）。原生设置页实际展开最后一项作业，确认completed、完整范围、末句与经历完成；静音说明截图 `native-47-silence-fixed.png`。

最终新进程仍召回人工评分和日记标记，目标BV的账本导入经历保持1条，QQ视图不见两标记。这里是上下文构造读回，不是发起模型供应商会话。原始幻觉、越界、partial和临时harness失败全部保留；新的harness曾有重复变量编译错误，修正后才产生真实job，不把该工具脚本错误记为产品失败。

Finder补验由用户打开可供CUA选择的窗口后执行：Computer Use打开验收launchers目录并调用精确文件的“打开访达项目”，随后核对官方二进制PID/隔离userData/loopback及Host归属。启动器只exec官方App，显式PATH=/usr/bin:/bin:/usr/sbin:/sbin且移除DYLD/ELECTRON_RUN_AS_NODE；原生诊断仍显示Node24.21.0/app-resources、ASR就绪，新1000ms静音作业成功。证据只支持这条受控Finder路线，不支持未授权的常用profile或无包装器图标路径。

精确owned renderer的window.close实际销毁页面，主进程与Host继续运行；随后只退出该测试实例，全部owned进程、debug50577和Host50610均关闭，原常用App持续存活。测试账户、人格、模型、记忆、作业及所有备份保留。最后状态与证据索引为 `native-47-finder-stop.json` 与本地 `final-results.json`。
