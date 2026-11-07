# 抖音推荐视频使用官方播放入口并校验完整下载（2026-11-07）

## 现象

- 媒体层从绑定账号固定首页 FEED 取得的第一条 Prime CDN 地址请求视频时，Node HTTPS 收到 HTTP 403。浏览器中相同推荐视频能正常播放。
- 原离线测试把响应头 `content-length: 8` 与实际 7 字节正文一起作为成功 fixture，下载器按实际文件大小返回成功，没有核对服务器声明长度。
- 影响是陪伴轮不能稳定取得推荐视频；不涉及账号写操作或已保存记忆，失败不会向模型提交视频。

## 环境

| 项 | 值 |
| --- | --- |
| 工作树 / 分支 | `surfcore-companion-media` / `feat/douyin-companion-media` |
| 基线 | `eade22a` |
| Node / 媒体工具 | 官方 Node 24；离线专项用本机 FFmpeg / FFprobe |
| 生效对象 | SurfCore Host；没有在本树启动 Host、浏览器或生产 ASR |

## 根因

- 下载器请求头使用 `User-Agent: SurfCore local media observer`，没有 Referer；主线的受控媒体请求显示，这种请求收到了 403。
- 主线从同一受信 FEED 的 `video.play_addr.url_list` 观察到精确的抖音签名播放入口：该入口 302 到允许的 Prime CDN，再用独立浏览器当前 UA 和固定抖音 Referer 返回 200、5,333,134 字节；不需要 Range。
- 旧下载器只确认落盘字节数等于已写字节数，没有将其与非空 `Content-Length` 对照，因此声明长度与实际正文不一致时仍可接受。
- 此前专项只用本地 HTTP fixture；成功 fixture 的声明长度正好等于正文长度，没有覆盖短正文。主线受控证据由主线保管于 `_backups/20261107-companion/redirect-header-result.json`，本次没有运行网络请求或读取签名 URL。

## 完整逻辑（七步）

1. **链路**：固定首页 browser 的 `loadRecommendations()` 返回本次已验证的浏览器 UA；service 仅在内部 `readFeedForCompanion()` 中消费，并把 UA 与原始 FEED 同项媒体地址放在私有 descriptor。公开 `readFeed()` 和其 metadata 投影不变。perception 验证 descriptor 后传给 `downloadDouyinMedia()`；媒体下载完成后才进入既有 FFprobe、FFmpeg 与本地 ASR。
2. **机制**：CDN 403 是请求身份/入口被拒绝的 HTTP 响应，放宽 `200` 校验无法生成可解码视频。现在从同一 FEED 的前 8 个 `play_addr.url_list` 候选里优先选精确的 `https://www.douyin.com/aweme/v1/play/` 签名入口；没有该入口时才用第一个既有 allowlist CDN。浏览器 UA 必须是 512 字符以内、可打印 ASCII 且以 `Mozilla/` 开头。下载每跳只发该 UA、固定 `Referer: https://www.douyin.com/` 和既有 Accept；不发 Cookie、Authorization 或 Range。仍要求原 HTTPS allowlist、DNS 公网校验与 IP pin、最多 3 次逐跳校验 redirect、128 MiB 和 120 秒限额；206 仍拒绝。最终正文实际字节数必须等于有效 `Content-Length`，不匹配时删除本轮文件并结构化失败。
3. **爆炸半径**：只影响单条首页推荐的内部读取和下载。Service 返回的媒体地址与 UA 不进入 public feed、状态、记忆、ASR provenance 或最终感知结果；没有新增请求服务、Cookie 或模型调用。下载、重定向和媒体处理仍受同一角色 epoch / signal 生命周期约束。
4. **取舍**：候选 A 是直接重试多个 CDN host/变体或引入更多浏览器请求头；会增加请求次数、超时与隐私/兼容分支，且现有实证显示第一方签名入口已可返回完整视频。候选 B 是复用已验证浏览器 UA、固定无凭据 Referer，并优先该 FEED 自带的精确官方播放入口；边界小、与受控证据一致，且保留原 allowlist 和 redirect 检查。采用 B，不加 Cookie、Range 或自动候选重试。
5. **生效与重启**：`douyin-browser.mjs` 在主线提交 `a4d3f97` 后已为成功的 `loadRecommendations()` 增加 `mediaUserAgent`；本提交的 service 消费该内部结果。两者组合后由 SurfCore Host reload 生效。此工作树未启动或重启 Host。
6. **验证**：离线专项验证同 FEED 签名入口优先、CDN fallback、公开/API/status 不暴露 UA/媒体地址、UA 缺失/无效时失败、perception 将合法 UA 传给下载器、固定 Referer 与 UA 每跳一致、无 Cookie/Authorization/Range、Content-Length 短正文被拒并清理、未请求 Range 却收到 206 时仍拒绝。另跑 service/data 专项和 `npm run test:audit`。主线受控实证见上面的私有元信息文件；本工作树未重跑媒体网络请求。
7. **回滚与残余**：回滚此功能提交可恢复旧下载头与旧 FEED descriptor；覆盖前四个源码/专项文件备份于 `_backups/20261107-douyin-media-playback/`。真实 CDN 请求实证来自主线；本树不调用模型，真实陪伴轮/生产 ASR/多设备仍未验。下载响应若无 `Content-Length`，仍要求文件写入和实际文件大小检查，但无法用声明长度做第二重对照。

## 修法

- `douyin-service.mjs`：从最初成功的推荐导航读取浏览器 UA，校验后仅附到内部陪伴 item；同一原始 FEED 候选优先第一方精确签名入口。
- `douyin-media.mjs`：加入严格 UA 校验、固定 Referer；保留本地 fixture 调用者原来的默认 UA。对生产 perception 强制要求 FEED UA；禁止 Cookie/Range，并核对实际正文与 Content-Length。
- `douyin-perception.mjs`：缺失/畸形 UA 结构化拒绝，下载时传入经过验证的 UA。
- 专项增加 UA 来源/隔离、第一方入口选择、redirect header、无凭据请求、错误长度与非 Range 206 断言。
- 回滚：在功能分支 revert 本提交；不清理 `_backups` 或其它未跟踪材料。

## 验证

- 自动化：官方 Node 24 下 `node plugins/surfcore/scripts/test-douyin-companion-media.mjs`、`test-douyin-service.mjs`、`test-douyin-data.mjs` 均通过。`npm run test:audit` 为 173/174；唯一失败是 `test-release-manifest.mjs` 的 `--verify-ref HEAD`：基线清单 815 项、当前 HEAD 跟踪文件 819 项，旧清单仍记录 `douyin-service.mjs` 哈希 `2dbdd9ad9d30`，当前 HEAD 为 `f8bbeee09b41`，并未纳入前一功能分支的新增文件。依本轮任务边界未改 `release/install-manifest.json`；主线合并后需按合并后 HEAD 重生成清单再验。
- 失败路径：无效/缺失 UA → `DOUYIN_MEDIA_USER_AGENT_INVALID`；长度不匹配 → `DOUYIN_MEDIA_LENGTH_MISMATCH`；意外 206 → `DOUYIN_MEDIA_HTTP_FAILED`；新增失败断言均检查 `error` 与 `hint` 并验证无媒体文件残留。
- 主线提供的受控网络证据：签名播放入口经 302 到 allowlist Prime CDN 后返回完整 200/5,333,134 字节；Range 不是成功的必要条件。此证据不是本子工作树运行所得。
- 没验证：本树没有联网、启动 browser/Host、读取账号/凭据、调用模型或操作平台；没有据此宣称生产陪伴媒体轮已完成。

## 遗留 / 后续

- 主线组合时需确认其 `loadRecommendations()` 成功结果含 `mediaUserAgent`，并执行组合 audit 与实际目标环境核查。
- 没有 Content-Length 的响应不能做声明长度对照；现有字节计数、落盘大小、FFprobe 与后续媒体覆盖检查仍生效。

## 发布交接块

```text
改了哪些文件：plugins/surfcore/lib/douyin-service.mjs；plugins/surfcore/lib/douyin-media.mjs；plugins/surfcore/lib/douyin-perception.mjs；plugins/surfcore/scripts/test-douyin-companion-media.mjs；docs/cases/2026-11-07-douyin-media-playback.md
测过什么、结果如何：官方 Node 24 下 Douyin media/service/data 专项通过；`npm run test:audit` 173/174，唯一失败是 HEAD release manifest 与基线跟踪文件集合/哈希不匹配，详情见「验证」。未改 manifest。本地未联网；主线另提供相同 FEED 签名入口 302→200 全字节证据。
建议 patch 还是 minor：功能修复；版本层级由发布会话按主线组合评估。
case 文档路径：docs/cases/2026-11-07-douyin-media-playback.md
改动层级：实现层；readFeedForCompanion 私有 descriptor 增加浏览器 UA，公开 readFeed/API metadata 契约不变；现有 perception 接口兼容但要求内部 item 携带可信 UA。
完整逻辑与爆炸半径：见本 case「完整逻辑（七步）」段；无 Cookie、模型调用、平台操作或新增外部服务。
失败路径：缺失/无效 UA、403/非200、声明长度与实际字节数不符、DNS/redirect/大小/取消均结构化返回 code/error/hint；新增失败有离线断言。
还有什么没验证：本树真实 CDN、目标 Host 与 ASR 组合、真实陪伴轮；主线需完成组合验收。
```
