# 抖音首页推荐的本地媒体感知（2026-11-07）

## 现象

- 抖音服务已能从绑定账号的固定首页推荐读取视频编号、标题和声明时长，但外部读取结果只公开这些 metadata。陪伴链路因此不能把实际推荐视频交给本地 ASR 和稀疏关键帧处理。
- 影响是陪伴轮拿不到真实视频的转写与画面。此变更不读取作者作品、相关视频或游客 feed，也不启用评论、点赞、私信、发布或分享。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS；未启动或重启 DSH |
| SurfCore 版本 | 0.8.8，版本号未修改 |
| 工作树 | `surfcore-companion-media`，基线 `244eba1` |
| Node / 媒体工具 | Node 24.21.0；本机 FFmpeg / FFprobe |
| 安装方式 | 未安装；仅本地离线 fixture 验证 |

## 根因

- [`douyin-service.mjs`](../../plugins/surfcore/lib/douyin-service.mjs#L105) 只保留 `parseDouyinFeed()` 投影后的推荐 metadata；`video.play_addr.url_list` 是播放所需的瞬态签名地址，原本没有内部读取接口。
- 共享 ASR 已有受管 `perception/assets` 路径和 `submit/getJob/cancel` 作业契约，但抖音没有本地媒体准备层，无法把已确认推荐的音轨交给该服务。
- 将播放地址加进通用 feed 投影会扩大到设置 API；把整份原始 JSON 送进陪伴状态又会把 cookie 或签名 URL 带入不应持有它们的对象。

## 完整逻辑（给用户看的那一遍）

- **链路**：独立抖音浏览器仍只观察固定 `/aweme/v1/web/tab/feed/` 与 self 端点。`readFeed()` 继续返回 metadata；新增的内部 `readFeedForCompanion(context)` 复用完全相同的绑定账号、角色 epoch、响应 cutoff 和三次 self 身份核验。只有内部操作暂时持有原 FEED 响应；媒体 descriptor 仅从该响应同一位置的 `video.play_addr.url_list` 按视频 ID 配对。之后 `createDouyinPerception({stateDir, asrService, getCharacter, ffmpegPath, ffprobePath, ...})` 下载本地临时视频、实际探测时长、抽取音轨和关键帧，再把音轨交给已有本地 ASR；转写和最多三张 JPEG 帧只返回当前陪伴轮。
- **机制**：CDN allowlist 仅包含已观测的 `*.douyinvod.com`，并允许唯一精确的签名跳转入口 `www.douyin.com/aweme/v1/play/`。URL 必须 HTTPS、无 userinfo/自定义端口/fragment；每次请求和最多三次 redirect 都重新检查 host，并将 DNS 解析固定到已核验的公网 IP。DNS 等待与本轮超时/取消 signal 竞争；取消后即使底层 lookup 延迟拒绝，也由已附加的 rejection handler 消费，不会再发请求。下载上限 128 MiB，未知或大于 120 秒的声明时长在下载前拒绝；下载后仍以 FFprobe 的视频和音轨实际时长复核，未知/超长视频跳过。成功结果的 `durationMs` 和 transcript 请求范围均按实际 FFprobe 视频时长取整；FFmpeg 只提取音轨，并从实际音轨/PCM 探测结果构造 ASR `acquiredRanges`；范围不足就保留 `complete:false` 和 `missingRanges`，不以首页声明时长补齐。关键帧按实际视频探测时长的 10%、50%、90% 采样，逐张用 FFprobe 确认 JPEG 且宽高均不超过 512。媒体临时目录为 `0700`、文件为 `0600`；正常完成或确认 ASR 已停止后清理。
- **时序与所有权**：每个异步阶段前后检查 `characterId + characterEpoch`。外部 signal 或角色过期会停止下载/FFmpeg；若已有 ASR 子作业，只取消本轮拥有的 job，并等待其进入终态后再返回。FFmpeg 通过共享 `runProcess` 接收 signal，该 helper 在取消时终止并等待子进程。若 ASR cancel 失败或超时且无法确认 job 已停止，本轮音轨和视频目录保留在隔离的临时资产目录中，返回含下一步的结构化错误；确认 ASR 终态后再清理，避免运行中的 ASR 丢失输入。ASR request 只包含 Douyin 视频编号、音轨摘要与本地路径，不含签名 `sourceUrl`；媒体 descriptor 不进入公开 API、状态、记忆或陪伴作业记录。
- **爆炸半径**：单轮处理一条视频；顺序运行下载、FFprobe / FFmpeg 子进程和一个已有 ASR job，不并行启动转码。公开调用者仍只能从 `readFeed()` 看到 metadata；新增签名 URL 只在 Host 内部 feed descriptor 与该轮下载器短暂存在。仅访问绑定账号首页返回的公开视频，不读私有 DSH 资料，不写平台，不调用外部模型或发送平台消息。模型调用 0，平台外发 0，真实浏览器 0。
- **取舍**：路线 A 给 `parseDouyinFeed()` 增加播放 URL，改动小，但会使签名地址沿通用 feed/API 投影外泄；路线 B 仅在内部 service operation 保留原始固定 FEED 响应，并由独立媒体模块验证来源、下载与清理，代码略多但不改变公开契约且能集中处理 SSRF、时长和取消。采用路线 B。外部签名服务/下载器会新增网络主体和凭据边界，不符合本轮既有本地 ASR 路线，因此没有加入。
- **生效与重启**：`index.js` 加载的 SurfCore 插件 Host 读取这些模块；合并后的程序需要由目标 Host 重新加载。此工作树没有启动、重启或安装 Host，也没有接触浏览器。陪伴引擎接线和组合验收由主线负责。
- **回滚与残余**：撤销本功能提交即可恢复基线 244eba1 的代码路径，不需要迁移角色数据或账户文件。每轮下载和解码文件清理；已有 ASR 服务中已完成的本地 job 仍按该服务原有账本保留。真实 CDN 返回、重定向链和真实视频下载/识别没有在本轮使用外部平台验收。

## 修法

- 在 `douyin-service.mjs` 中让 `readFeed()` 与 `readFeedForCompanion()` 共用严格读取路径；只有后者在固定 FEED 响应中取出经过 allowlist 验证的 `play_addr.url_list`。公开 metadata 投影没有改变。
- 新增 [`douyin-media.mjs`](../../plugins/surfcore/lib/douyin-media.mjs#L50)，实现精确 URL allowlist、HTTPS redirect 检查、公网 DNS 校验与 pin、大小/超时限制、FFprobe 时长解析、受 signal 管理的 FFmpeg 音轨和关键帧提取。
- 新增 [`douyin-perception.mjs`](../../plugins/surfcore/lib/douyin-perception.mjs#L147)，冻结角色和 activity 归属，复用已有 ASR 服务，结构化返回 transcript coverage、`speechState`、稀疏帧和可行动 warnings，不创建新的持久化陪伴 job。
- 新增离线专项 [`test-douyin-companion-media.mjs`](../../plugins/surfcore/scripts/test-douyin-companion-media.mjs)；没有新增依赖。
- **回滚方式**：在功能分支 revert 本功能提交；不要覆盖后续提交。版本号、tag、远端和发布状态均未改。

## 验证

- **自动化**：官方 Node 24.21.0 下 `npm run test:audit`：`Audit suite: 174/174 scripts passed`。另运行 `test-douyin-service.mjs`、`test-douyin-data.mjs`、`test-douyin-companion-media.mjs`，三项均输出 `ok`。
- **新增断言**：离线 FFmpeg 生成的完整与短音轨 fixture 分别验证完整覆盖与 `complete:false/missingRanges`；frame fixture 验证最多三张 JPEG、各边不超过 512。模拟了 FEED 响应延迟、SELF A→A→B→FEED B→A 时公开与陪伴读取都 sticky 拒绝、无效/未授权 host、IPv4/IPv6 loopback/private DNS、redirect 私网解析、停滞 DNS 的及时取消与迟到拒绝、文件超限、未知/超 120 秒实际时长、无帧 warning、角色 epoch 变化、ASR owned-job 取消等待、取消未确认时保留输入目录及 FFmpeg 进程结束。新增失败均断言 `code` 与非空 `hint`。
- **审查边界**：本轮未登录真实抖音、未下载真实平台视频、未调用生产 ASR 或模型、未启动 browser/Host 服务、未发平台消息。全量 audit 内已有的隔离 HTTP + deterministic-provider 测试属于本地 fixture，不代表生产模型或网络验收。主线另行处理了浏览器播放器就绪识别；不属于本工作树提交。
- **独立代码审查**：Astra V1 提出三项 P2：陪伴读取缺少 sticky 账号身份失败锁、DNS lookup 不受总时限/取消约束、ASR cancel 失败时仍删除输入目录。V2 对应不可变快照复核后全部关闭，无新增确认的 P1/P2；identity 反例两种读取均拒绝，DNS abort 约 13 ms / 总超时约 42 ms 且网络请求为 0，ASR 停止未确认时保留目录并仅在确认终态后清理。该证据来自离线审查 fixture，不代表真实媒体或生产 ASR 验收。
- **失败路径（当前轮接口）**：无/超长时长提示跳过该视频；CDN、DNS、redirect、下载、FFprobe、FFmpeg、ASR 或清理错误返回 `{ok:false,code,error,hint}`；不完整音轨返回成功的 partial coverage 与 warning；角色变化/取消会等待 owned ASR 作业收尾；无法确认 ASR 停止时返回 `DOUYIN_ASR_CANCEL_FAILED` 或 `DOUYIN_ASR_CANCEL_UNCONFIRMED` 并保留临时输入，提示先确认停止再清理。

## 遗留 / 后续

- 主线应接入 `readFeedForCompanion()` 和 `perceive()`，并对空转写或缺帧按引擎策略跳过；本分支没有改引擎、API、状态或记忆。
- 真实 feed 的 CDN host/redirect 响应仍需在只读实机环境逐项核对；未列入 allowlist 的 host 会结构化拒绝，确认来源后再单独调整。
- 完整组合回归与主线代码合并由主线负责；没有据此宣称真实媒体链路或陪伴轮已接通。

## 发布交接块

```text
改了哪些文件：plugins/surfcore/lib/douyin-service.mjs；plugins/surfcore/lib/douyin-media.mjs；plugins/surfcore/lib/douyin-perception.mjs；plugins/surfcore/scripts/test-douyin-companion-media.mjs；docs/cases/2026-11-07-douyin-companion-media.md
测过什么、结果如何：官方 Node24 test:audit 174/174；Douyin service/data/media 三专项通过；仅离线媒体 fixture。没有真实浏览器、生产 ASR/模型、平台外发或组合回归证据。
建议 patch 还是 minor：这是新的内部感知能力，发布会话结合主线组合结果评估版本层级；本编辑提交不改 version/tag/push。
case 文档路径：docs/cases/2026-11-07-douyin-companion-media.md
改动层级：实现层；新增 Host 内部方法 readFeedForCompanion(context) 与 createDouyinPerception(...).perceive(item, context, {signal, activityId})；现有 readFeed/API 公开契约保持兼容。
完整逻辑与爆炸半径：见本 case「完整逻辑」段。
失败路径：所有失败带 code/error/hint；partial coverage 和缺帧 warning 明确保留；取消等待 owned ASR job 与 FFmpeg 子进程收尾；ASR 停止未确认时保留输入目录并给出确认/清理步骤。失败断言见 test-douyin-companion-media.mjs。
还有什么没验证：真实抖音 CDN/redirect 下载、真实媒体与目标 ASR、主线引擎组合、真实浏览器/Host acceptance；V2独立审查是离线fixture结论，禁止把它说成实机通过。
```
