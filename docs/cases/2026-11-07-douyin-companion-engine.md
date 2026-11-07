# 抖音陪伴：有界单轮与持久调度引擎

## 现象

- 需求：把当前角色的首页推荐作为素材，结合本机语音转写与稀疏画面采样，输出角色偏好、理由、摘要和仅供用户查看的草稿，并经Host唯一记忆维护者写入来源与发生时刻。
- 复现步骤：在本机fixture调用 `start(context)`；轮询 `status(context)`；手动验收成功后才可 `configure(context,{enabled:true})`；本机调用 `tick()` 只在上海时间12:30或20:30启动日常轮次。
- 影响面：本次新增服务尚未接入真实UI或平台运行链路。专项仅在隔离临时目录中运行；没有读取账号、真实推荐、模型服务或真实 `~/.dsh`，模型/平台请求数为0。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS；本分支未安装到DSH |
| SurfCore 版本 | 基线0.8.8；未改版本号 |
| 安装方式 | 未安装；独立工作树离线验证 |
| 其它相关版本 | 候选基线244eba1；官方Node 24.21.0 |

## 根因

- 代码位置：`plugins/surfcore/lib/douyin-companion.mjs`（轮次状态机）、`plugins/surfcore/lib/douyin-companion-ledger.mjs`（全局原子账本与独占锁）、`plugins/surfcore/lib/douyin-companion-utils.mjs`（来源、文本、覆盖范围白名单）。
- 问题链条：单轮媒体感知、模型调用与记忆写入跨多个异步回调。若未固定角色世代、持久预留额度或在每个异步边界重新检查取消状态，角色切换/重启后可能继续调用模型、把结果写给新角色、重复消费额度，或把媒体私有URL/base64/提示词写进可轮询状态。
- 为什么之前没发现：这是新增引擎；目前推荐流读取已有实机验收，但“ASR + 稀疏帧 + 角色点评 + 记忆”本身没有真实运行验收。

## 完整逻辑（给用户看的那一遍）

- **链路**：主线控制器调用本模块的 `start/status/cancel/configure`；引擎依次调用 `readiness → readFeed → perceive → buildContext → modelCall → recordMemory`。主线提供的模型回调固定走 `surfcore-companion-hy3 / workbuddy/hy3`，记忆回调仍由Host唯一维护者负责。本次写集合没有接入控制器、HTTP API、设置页或平台动作。
- **机制**：每轮捕获 `{characterId, characterEpoch}`；start/configure/status/cancel都核验调用上下文里的角色世代，排队期间已过期的操作不会重绑到新角色。异步回调前后都核对角色与AbortSignal，50ms本地监视器在模型等待期间发现世代切换后立即取消。`withTransition` 先取消并等待当前轮收尾，再运行角色/渠道切换动作；`configure(false)`也通过相同的串行切换闸门，取消并等待活动之后才持久关闭日常。记忆回调收到同一个AbortSignal并有界等待。媒体条目最多2条；feed时长仅用于下载前筛选，perceive返回的实际视频时长必须是安全整数且 `0 < durationMs <= 120000`，转写请求与处理范围都必须准确连续覆盖 `[0, actualDuration]` 才算音轨完整，不能用feed元数据或容差补齐。ASR状态必须是`speech`才可通过验收。每条必须同时有语音文本和1至3个有效稀疏帧才可调用多模态模型。语音覆盖不足的点评标为partial；稀疏图像始终标为`sparse`，不声称覆盖全片视觉。模型只接受精确四字段JSON：`feeling`（`like/mixed/neutral/dislike`）、`reason`（最多240字）、`summary`（最多500字）、`draft`（最多300字）。输出含URL、图片数据或疑似密钥会整体拒绝；来源ID、净化后的来源页URL和感知发生时刻由本地可信代码附加。草稿不外发。
- **爆炸半径**：单个本机引擎、一个 `stateDir/douyin-companion/ledger.json` 和Host记忆接口；每轮最多2条、硬上限4次模型调用，单次最多8192输出token/180秒。手动验收客户端请求上限12次，日常每角色每日最多2轮×4次请求，共8次；所有模型调用先持久预留，失败也计入。日常默认关闭，只有当前世代达到可解释验收后才允许手动开启。引擎不驻留外部daemon，不调用平台互动或外发接口。
- **取舍**：①把额度放角色快照，写入/测试简单，但快照回档会恢复额度；②把额度、作业、窗口放全局账本，隔离角色日常额度并让手动验收上限跨重启/回档持续。本实现采用②。①用一次性长定时器，代码少但重启或错过窗口会误补跑；②由宿主本机在固定窗口调用 `tick()` 并持久记录窗口尝试，本实现采用②；错过窗口不会补跑。实例锁失效时自动抢占更方便，但并发观察与删除可能误伤新锁；本实现fail-closed，要求检查PID后保留证据并手动隔离失效锁。
- **生效与重启**：模块本身不创建常驻调度器；主线需在本机存活期间按需调用 `tick()`。主线组合后加载新插件代码需重启/重载对应DSH实例。账本位于 `stateDir/douyin-companion/`，必须映射到不会随角色快照恢复的全局状态目录。账本损坏、权限错误或锁损坏时状态返回结构化错误，不降级到零额度。确认旧锁PID已退出后，只移动锁文件到隔离位置；不重置账本。

## 修法

- 改了什么：新增 `createDouyinCompanion({stateDir,getCharacter,readFeed,perceive,modelCall,buildContext,recordMemory,readiness,now,...})`，返回 `start/status/cancel/configure/tick/withTransition/dispose`。账本通过同目录临时文件、fsync和rename原子替换；`wx`独占锁贯穿整个活动，避免多实例重复预留。全局12次验收计数与角色ID下按日累计的8次日常请求、两轮额度不随角色epoch或进程重启清零。每个媒体尝试在等待感知前先写入白名单作业项；感知、素材、模型或记忆失败都会把结构化code/error/hint落在该条和作业上并终止后续视频，日常失败持久暂停。作业和状态只投影白名单字段，不保留媒体源、图片base64、转写正文、提示词或模型usage。
- 失败呈现：常见code包括 `DOUYIN_NO_QUALIFIED_MATERIAL`、`DOUYIN_FRAMES_UNAVAILABLE`、`DOUYIN_MODEL_OUTPUT_PRIVACY`、`DOUYIN_CANCELLED`、`DOUYIN_STALE_CHARACTER`、`DOUYIN_DAILY_PAUSED`、`DOUYIN_STATE_UNAVAILABLE`、`DOUYIN_LOCK_INVALID` 与 `DOUYIN_COMPANION_BUSY`；失败结果均带 `error` 与可操作 `hint`。日常失败会关闭开关、持久暂停、标记该窗口已尝试；必须用户显式 `configure(...,{enabled:true})` 才能恢复，原失败窗口仍不重跑。
- 为什么选这个方案：同一文件内的小状态机降低了回调间生命周期复杂度；账本单独拆分以限制写入面和审查边界；纯离线fixture可以验证配额、锁、来源投影与取消，不需要消耗真实模型预算。
- 回滚方式：主线可以移除控制器接线/关闭开关并回退功能提交；保留全局账本和失败证据，不删除状态目录。下一次再启用前核对原账本，不从0重建。

## 验证

- `npm run test:audit`（官方Node 24.21.0）：174/174脚本通过。
- `node plugins/surfcore/scripts/test-douyin-companion.mjs`（官方Node 24.21.0）：输出 `Douyin companion engine offline fixtures passed`。
- 4个新增JS文件的 `node --check` 与 `git diff --check` 通过。
- Astra 对 V2 冻结源码/测试的独立复审：9组主要反例通过，涵盖旧角色排队请求、覆盖与no-speech验收、记忆取消/超时、actual duration、3帧上限、活动中关闭开关和日常第二条感知失败；复审未发现新的P1/P2。
- 专项fixture覆盖双素材上限、精确上海窗口与不补跑、全局计数重启保留、媒体URL/base64/prompt不落账本、无合格素材零模型调用、缺帧/无语音跳过、音轨范围只覆盖1ms不能验收、`no-speech`不能通过、feed时长与实际媒体时长不同时按实际范围验收、帧数最多3张、模型隐私拒绝、失败预算预留、排队旧角色上下文、取消/角色切换/transition/关闭渠道后不迟到模型或记忆写入、记忆超时、第二条感知失败的日常持久暂停、跨实例锁冲突、损坏账本不重置、日常失败暂停与显式恢复；新增失败断言检查 `code/error/hint`。
- **完整插件套件由组合会话执行**：本独立工作树首次 `npm test` 因未链接 `node_modules` 在旧 `compat.js` 用例报缺少 `js-yaml`；按主线要求不重复运行整套，组合候选验收待主线结果。此项不影响已通过的本引擎专项与审计门禁。
- 手工/集成：没有调用真实抖音、浏览器、Host模型、Magpie或`~/.dsh`。主线UI字段映射、固定HY3实际调用、Host实际记忆与真实素材覆盖仍待组合验收。

## 遗留 / 后续

- 需要补的测试：主线组合时把专项目录加入最终必要检查清单；核对UI能展示partial、暂停原因、日用量和手动恢复动作。
- 需要改的文档：本case提供独立可转发交接；组合落地后由主线更新HANDOFF与对应的组合验收记录。

## 可转发发布交接块

```text
改动文件：plugins/surfcore/lib/douyin-companion.mjs、plugins/surfcore/lib/douyin-companion-ledger.mjs、plugins/surfcore/lib/douyin-companion-utils.mjs、plugins/surfcore/scripts/test-douyin-companion.mjs、docs/cases/2026-11-07-douyin-companion-engine.md
验证结果：官方Node24 npm run test:audit 174/174；Douyin companion离线专项通过；Astra V2独立复审9组主要反例通过、无新增P1/P2；新增JS语法检查及空白检查通过。完整plugin npm test留给组合会话执行。
版本建议：minor（功能完整接入并验收时）；本编辑提交不改版本、不发版。
改动层级：实现层；新增独立ESM接口；公开接口为createDouyinCompanion返回start/status/cancel/configure/tick/withTransition/dispose。主线集成前尚无运行用户。
逻辑与爆炸半径：见docs/cases/2026-11-07-douyin-companion-engine.md「完整逻辑」；本机单实例、最多2条素材/轮、手动验收12客户端请求全局累计上限、日常每角色每日8请求上限，失败请求预留计入，无外发。
失败路径：所有专项失败分支检查code/error/hint；缺帧、无语音/无合格素材不调模型，模型输出URL/疑似密钥整体拒绝；每日失败持久暂停，必须显式configure恢复；损坏账本或锁fail-closed。
回滚：回退功能提交或移除主线接线，关闭日常开关；保留全局账本、已用额度与作业证据，不重置、不删除。
未验证：真实抖音媒体/ASR/稀疏帧、固定HY3模型实际响应、Host记忆真实写入、设置页和角色切换实机路径；完整plugin suite由组合会话验收。
```
