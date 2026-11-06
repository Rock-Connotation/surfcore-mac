# macOS 首期组合：Host 接线、制品与验收边界

状态：WP1–WP5 实现已组合；本机离线与原生资产验证通过，官方 App 装载、真实 B站和 Finder 生命周期待验。版本仍为 0.8.8，不是发布记录。提交以 HANDOFF 顶部候选为准；本页保留设计 06 的编号，不新建进度系统。

## 完整逻辑

1. **链路**：官方 desktop Host 的 `plugins/surfcore/lib/index.js` 创建唯一 ASR 服务、B站媒体父作业和受保护 HTTP 入口；设置页与 CLI 使用同一个实例。B站 API 提交先经 `PlatformRegistry.observe` 检查渠道状态与固定活动身份，再获取分 P 媒体、提交 ASR、写观看历史、追加受限 ExperienceEvent，由 Host 单写者投影记忆。下一次 B站上下文读取统一卡；QQ 不可见这条受限观察。设置页显示作业、处理范围、末段文本、取消/恢复与经历失败重试；记忆页显示按角色绑定的最近维护失败与重试。
2. **机制**：本地 ASR 恢复产生关联新尝试时，API/CLI 返回新 jobId 与新状态；B站父作业保持原 ID。CLI 请求用当前 Host 生成的本机令牌，发现文件 0600、感知目录 0700；管理界面复用原 DSH 管理认证。服务端校验来源、角色及 epoch、受管素材真实路径。configure/persist/rollback 与提交共享串行门；本地请求不能自称公开 B站材料。B站下载/抽帧单槽，ASR 推理单槽，退出只取消本实例的受管进程；错误保留 code/error/hint。通用渠道 execute 未接外发实现，现有预算、静默和互动回执仍由原工具守闸。
3. **爆炸半径**：Host、CLI、设置页、bridge 是不同读者，状态串角或失去取消会形成高影响静默错误；本次新增目录在 SurfCore 数据根，涉及角色记忆、作业、素材与本地模型路径。隔离测试不读取真实账号，不调用模型供应商或外发。未改版本、tag、远端、真实 profile 或当前 App 进程。
4. **取舍**：A 让每个 CLI 自行下载和识别，接线少但长命令超时、重复推理和退出所有权难解；B 由 Host 管理持久父/子作业，增加状态与生命周期成本，获得统一取消、重启和结果归属。选 B。制品选择保留仓库相对布局并内置运行依赖；把散文件复制为插件虽小，却会依赖包外 `src` 和开发机 node_modules。模型/原生运行时另作有摘要的资产，不把机器与账号资料塞进 npm 包。
5. **生效与重启**：需将最终 npm 制品装入官方 App 的 desktop profile，再由 App 重新装载 Host/客户端。QQ bridge 若使用新源码也需单独重启；QQ 关闭时不需启动它。当前仅观察到官方 App 正在运行，未启动第二实例或重启共享实例。`DSH_HOME` 与 `--user-data-dir` 可以隔离 profile、用户目录和单例锁，但官方 App 会使用共享 macOS 日志目录并启动清理旧崩溃日志，不能称完全无副作用的并行启动。
6. **验证**：组合 `npm run test:audit` 156/156；新增渠道接线后须最终复跑。插件全套、regressions 和 HTTP 链路结果见下方证据。真实中文样本在官方 Node24.21.0、便携 FFmpeg/FFprobe、便携 whisper、small 模型、纯系统 PATH、无 DYLD、中文空格新目录中，CPU/Metal 均处理 0–6463ms 无缺口；文本仍有错字。清晰 AISHELL 两条样本的 base/small 对比只有局部基线，small 为本机安装候选，未形成全面准确率门槛。
7. **回滚与残余**：代码备份在主树 `_backups/20261106-macos-wp0/`，子任务各自 case 有原始证据。回滚先停止新任务、保存新增经历/作业，再还原上一制品和兼容快照；不得删除整个数据根。真实 profile 安装前保全配置、安装记录及共享日志，明确恢复路径；尚未执行真实迁移。Intel、Windows、新旧其他 macOS、Finder、休眠/唤醒与真实账号仍待验；不能宣告首期全部完成。

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

环境 E1：本机 macOS26.6.2/Apple M4/arm64；开发树 Node26。E2：官方 App 随附 Node24.21.0 + 便携媒体/whisper + small，纯系统 PATH；E2 仍不是 GUI App。以下“夹具通过”仅限列明输入，不能转写成实机通过。目标为最终组合候选（HANDOFF 指向 final-results.json 记录 SHA），原始基线 52ced0f；安装到 App 的提交另记。

| 编号 | 输入 / 预期 | 实际与状态 | 证据 |
| --- | --- | --- | --- |
| CORE-T01 | 同角色 local/B站/QQ 身份一致 | 夹具通过，共享上下文、id/epoch/revision | shared-core 7/7 |
| CORE-T02 | 超长核心卡，总预算及层保留 | 夹具通过，分层预留/裁剪诊断 | shared-core / persona tests |
| CORE-T03 | QQ/B站均关闭，核心仍维护 | 夹具通过，Host 本地维护与目的读取 | shared-core |
| CORE-T04 | QQ关闭，B站账本→经历→卡→下次上下文 | 夹具通过四环；真实 B站未执行 | composed-perception-host-channel.log / shared-core |
| CORE-T05 | 重复导入/完成不重复消费 | 夹具通过，事件/游标重放一次 | shared-core / Host integration |
| CORE-T06 | 长作业中切角色 | 夹具通过，拒绝旧 epoch、固定原角色；真实 UI 待验 | ASR service / bili-media-host |
| CORE-T07 | 私密/未知材料进入公开上下文 | 夹具通过，restricted/未知 fail closed | shared-core / API |
| CORE-T08 | 清理可再生缓存不删人格记忆 | 缓存范围/lease 夹具通过；全程清理后证据状态实机未执行 | shots-cache / bili frames |
| CORE-T09 | 模拟新 local adapter | 夹具通过，提交受限事件与允许视图，不复制核心 | channel-contract 8/8 |
| CORE-T10 | 登出/绑定变化保留核心 | 真实账号未执行 | 待 App 登录验收 |
| CORE-T11 | 退出重启恢复，过期活动不补发 | 持久队列和 life 夹具通过；真实 App 重启未执行 | ASR service / shared-core |
| ASR-T01 | 无字幕中文到末尾 | E2 两轮实际处理6463ms；真实 B站片未执行 | native result.json |
| ASR-T02 | 有字幕视频 force 仍调 ASR | 夹具通过，未用字幕替代识别 | bili-media |
| ASR-T03 | P2 音轨/字幕/画面/历史一致 | 夹具通过，真实多P待验 | bili-media / Host integration |
| ASR-T04 | 全 durl，跨段不归零 | 夹具通过所有分段/映射；真实平台待验 | bili-media |
| ASR-T05 | DASH仅音轨 | 夹具通过，不要求视频轨 | bili-media |
| ASR-T06 | 中间失败/截断 | 夹具通过 partial/failed 与缺口 | bili-media / ASR service |
| ASR-T07 | 超过工具等待的长作业 | 241秒合成音频分块/异步状态夹具通过 | ASR service |
| ASR-T08 | 静音/音乐/低声/BGM | 精确静音与空文本 unknown 夹具通过；BGM短中文实测；完整质量集未执行 | ASR service / shared-asr |
| ASR-T09 | 分块边界/真实重复句 | 偏移与重叠去重夹具通过；长中文边界未实测 | ASR service |
| ASR-T10 | 取消/退出/恢复 | 实际 fixture 子进程退出与重启队列通过；App生命周期待验 | ASR service / bili lifecycle |
| ASR-T11 | 同音频并发 | 夹具通过，共享推理与独立消费者 | ASR service |
| ASR-T12 | 改模型/语言/访问范围 | 夹具通过，摘要与缓存隔离 | ASR service |
| ASR-T13 | 缺模型/损坏/错误架构 | 失败分支夹具通过；E2 缺资产实际 failed+hint | ASR service / native result.json |
| ASR-T14 | 本地/B站共用且ASR不读Cookie | 组合夹具通过；E2本地真实识别通过；真实B站待验 | Host integration / native result.json |
| MAC-T01 | Finder与终端能力同源 | 终端/纯系统PATH通过；Finder未执行 | runtime / native result.json |
| MAC-T02 | 实际.app资源Node，缓存未备 | 实际探测24.21与能力通过 | runtime case |
| MAC-T03 | Electron Node模式显式环境 | 选择/隔离环境夹具通过；实际Electron版本只读核验 | node-path tests |
| MAC-T04 | Edge/Chrome位置与错误路径 | 路径/能力夹具通过；真实扫码未执行 | bili-qr-login tests |
| MAC-T05 | 扫码成功/取消/过期/早退 | owned子进程错误/退出夹具通过；真实扫码未执行 | bili-qr-login tests |
| MAC-T06 | 扫错账号原凭据不变 | 既有身份校验夹具；真实扫码未执行 | 插件测试 / 待实机 |
| MAC-T07 | 显式媒体路径、缺失与不可执行 | E1/E2实际工具与失败夹具通过 | runtime-media / native-assets |
| MAC-T08 | 中文空格/自定义数据根 | E2真实服务通过；设置页/CLI/App同根待验 | native result.json |
| MAC-T09 | QQ未启用不阻断核心/B站 | doctor+Host夹具通过，未启动QQ | doctor / Host integration |
| MAC-T10 | 关窗/真正退出/热重载 | 服务dispose/锁重试夹具通过；App未执行 | ASR service |
| MAC-T11 | desktop安装重启、Host和client可见 | 未执行；共享日志副作用和profile需授权 | 本页安装方案 |
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

## 待授权的最小实机步骤

先完成最终 git 对象包、摘要、独立解包与官方 Node 装载；再申请具体动作：

1. 保全官方 App 共享日志后，以独立 DSH_HOME 与 user-data-dir 启动同一官方 App，不退出用户当前实例。安装只进入测试 desktop profile，QQ、B站自动活动和更新检查保持关闭，不复制真实账号；用新角色验证 Host/client、成功/失败显示和退出重启。
2. 人工在该实例完成 B站扫码（不读取/抄录凭据），明确只读选定视频；用本地 small/Metal 执行无字幕视频和末尾核对、记忆闭环。评论、点赞、动态、分享与付费模型调用均不包含在此步骤。
3. 真实常用 desktop profile 的安装/重启是另一个影响对象，需要具体安装前快照及恢复清单。不要把用户选择官方 App 当作已经授权这一配置写入。

停止测试时只退出新实例；测试目录和新增经历保留。共享日志如有轮转变化，保留启动前完整副本，不以恢复覆盖正在写入的日志。

## 可转发发布交接块

```text
文件：Host index/client/perception-api，共享core/ASR/B站媒体/运行层/更新身份及打包脚本、对应测试和case；完整清单见功能提交。
验证：组合audit156/156、插件全套与regressions通过；新增渠道接线后的最终结果见HANDOFF；E2真实中文CPU/Metal完整覆盖；HTTP fixture记忆闭环通过。
建议：功能性minor候选，最终版本由发布会话/用户决定；本批不bump、不tag、不push、不发布。
层级：新增共享上下文、经历、渠道运行与感知作业接口；旧metadata/scope/记忆/预算兼容。package安装由DSH更新，源码安装独立身份绑定。
完整逻辑与爆炸半径：本case七步与各WP case。失败：设置页显示code/error/hint，作业取消/恢复、经历重试；CLI不吞Host失败，缺资产不回落云端。
未验证：官方App安装/Finder/生命周期、真实B站无字幕闭环、Intel/Windows/其他macOS、全面中文质量、正式分发签名与LGPL源码提供。当前不满足首期全部完成/发布条件。
回滚：先保留新增经历/作业与当前数据，再停止本实例，恢复上一制品和兼容快照；不可清空.dsh或角色目录。
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
