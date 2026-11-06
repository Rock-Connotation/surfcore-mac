# 渠道现状与未接入清单（2026-11-07）

这是源码与设计盘点，不表示实际账号已配置或在线。基准为本工作树 `212eaa3`；其他工作树的实现与运行验收仍在推进，不能用本表代替最终组合验收。QQ/B站此前的真实使用记录属于特定隔离环境和时点，见 [HANDOFF](../HANDOFF.md)，不代表所有安装都已连接。

| 渠道 | 当前证据与状态 | 下一步边界 |
| --- | --- | --- |
| QQ、B站 | [平台注册表](../../plugins/surfcore/lib/platforms.js) 定义为内置 `active`；实际启用、认证和健康状态取决于安装与配置。 | 各自按真实目标环境验证，不把注册状态当成在线证据。 |
| 抖音 | 当前工作树已有 [账号服务](../../plugins/surfcore/lib/douyin-service.mjs)、[浏览器](../../plugins/surfcore/lib/douyin-browser.mjs)、[数据层](../../plugins/surfcore/lib/douyin-data.mjs) 的进行中实现；尚不能仅凭源码宣称完成接入。 | 人工绑定专用账号，验证真实个人推荐、身份隔离、关闭与恢复以及错误提示；组合实现和真实验收由主线负责。 |
| 百度贴吧 | 注册表 `planned`，[manifest](../../plugins/surfcore/platforms/tieba/manifest.json) 是占位；[交接方案](../handoffs/2026-11-02-tieba-platform.md) 非已实现适配器。 | 先解决 planned 内置平台注册与加载接线，再按授权推进只读能力。 |
| 微信、小红书 | 分别有 [微信提案](../handoffs/2026-11-02-wechat-platform.md) 和 [小红书提案](../handoffs/2026-11-02-xiaohongshu-platform.md)，未见对应内置渠道适配器。 | 提案需要独立设计、授权与实现；不能把外部程序配置示例当作本项目已接入。 |
| 企业微信、飞书、钉钉 | [通知命令](../../plugins/surfcore/tools/commands/notify.mjs) 支持对应 webhook 的单向发送报文，不是双向渠道接入。 | 双向会话、身份和状态需要另行设计及验证。 |
| 微博 | [平台说明](../../plugins/surfcore/platforms/README.md) 记录 2026-10-23 用户决定不做，旧占位已移除。 | 如重新接入，需要新的需求与设计。 |

## 抖音选型与验收

用户选择优先账号登录与个人推荐。F2 的高层 `fetch_user_feed_videos` 虽有推荐字样，实际读取指定作者作品；其低层 `tab/feed` 方法存在，但没有证明返回当前登录账号的真实推荐。Evil0ctal Download API v5 是包含 PostgreSQL、Redis 及可选浏览器和下载侧车的服务，单一账号推荐目标下维护成本高，已查路由也没有证明个人首页推荐或本地扫码支持。详见 [选型案例](../cases/2026-11-07-douyin-source-selection.md)。

主线选择使用独立浏览器 profile，让用户本人完成扫码与安全验证，再只读可核对的推荐页面；已选 `playwright-core@1.65.0` 作为浏览器控制依赖。其 [包元数据](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/package.json) 声明 Apache-2.0 和 Node >=20；core 不自动下载浏览器，需要明确指定受控浏览器。此选型不证明本工作树已经集成或真实验收通过。

推荐读取应绑定已确认账号与当前角色，切换、退出或状态不明时停止并提示；不读取其他浏览器 profile，不输出 Cookie、签名链接、账号标识或私密内容。只把可归属于当前页面的卡片当作推荐；预加载、搜索结果、作者作品和相关视频不能冒充当前卡片。可见但无法可靠对应的内容应报告证据不足。素材进入现有共享本地 ASR 前仍需受控下载与完整性验证；不自动点赞、评论、分享或调用付费模型。登录、推荐、媒体、ASR 和 UI 的实际验收均需分别记录。
