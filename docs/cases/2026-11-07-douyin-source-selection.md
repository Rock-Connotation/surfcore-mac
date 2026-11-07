# 案例：抖音账号与推荐流来源选型（研究与盘点）

本案例只记录 2026-11-07 的来源研究与路线选择，不是功能完成、发布或真实推荐验收报告。可复查的私有脱敏研究位于独立工作树 `_backups/20261107-douyin/research-open-source.md` 和 `ssr-source-notes.md`；这两份材料不随发布物分发。没有在本案例复制账号、Cookie、截图或真实推荐内容。

## 完整逻辑

1. **链路**：目标是用户在独立浏览器完成抖音登录，读取该账号真实推荐，再按授权对选定素材做媒体处理和共享本地 ASR。宿主的 [平台注册表](../../plugins/surfcore/lib/platforms.js) 目前内置 QQ、B站和 planned 贴吧；本树已有抖音服务、浏览器和数据模块，实际 Host 组合与验收仍由主线完成。渠道盘点见 [状态表](../guides/CHANNEL-STATUS-2026-11-07.md)。
2. **机制**：账号、访客与作者作品是不同数据语义。F2 的 [`fetch_user_feed_videos`](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/handler.py#L1711) 实际使用 `UserPost` 和 `fetch_user_post`；其 [`fetch_post_feed`](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/crawler.py#L245) 调用首页 feed 接口但无法从静态代码证明与登录账号的真实推荐一致。上下文查询和 GitHub 固定源码研究完成；无证据表明 F2 提供所需本地扫码状态。
3. **影响面**：推荐属于账号上下文，错误归属会污染角色和后续素材；浏览器 profile 与 Cookie 含敏感登录态。研究不读取用户资料、不发消息、不调用模型；后续动作必须有明确渠道、角色、来源、授权和隐私边界。
4. **取舍**：A，独立浏览器 profile 由用户扫码、只读可见个人推荐；收益是可直接核对账号与页面，成本是浏览器生命周期和页面变化，风险是卡片与预加载数据错配，关闭适配器即可回滚。B，F2 Python helper 使用登录态调用低层 feed；潜在结构化数据较方便，但要传递敏感 Cookie、维护 Python 原生依赖与签名，推荐语义和稳定性未验证，撤出 helper 可回滚。选择 A 先验证，保留 B 为未证明的备选。[Download API v5](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/5aa03528d2e974a0de23faf86597b5af3420df55/documents/en/11-api.md) 使用较重的 PostgreSQL/Redis 服务架构，已查端点未证明个人首页 feed 或本地扫码；不把相关视频当个人推荐。yzfly 已归档，云 ASR 示例不符合本地 ASR 目标；不整体引入。GPL-3.0-or-later 的 [MaiBot 插件](https://github.com/mailchunian8395-arch/maibot-plugin-douyin-surf/tree/40bf0c56c443e877a26b2391ffdf255bd3c35f71) 仅作架构参考，不复制 GPL 代码到 MIT 工程；它的推荐路径依赖自然网络响应，搜索页 SSR 兜底不能证明推荐首屏字段归属。
5. **生效与重启**：本提交只含文档，无运行时代码、配置或版本变动，不需要重启。主线选择 `playwright-core@1.65.0`（[Apache-2.0，Node >=20](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/package.json)），core 不负责下载浏览器；依赖接线和进程生命周期要由实现分支验证。
6. **验证**：本案例依据仓库源文件、既有 Context7 查询和上述固定 GitHub 源码；文档链接及变更检查只验证材料可引用，不能证明平台登录、真实推荐或 ASR。后续必须在授权的独立账号/profile 验证扫码及恢复、真实账号和当前可见推荐对应、切角/退出取消、失败 code/hint、受控媒体和 ASR，分别记录不可用场景。
7. **回滚与残余**：文档提交可以单独 revert；不删除 profile、原始研究或用户数据。浏览器平台风控、页面变化、真实首屏来源、macOS/Windows 差异及长期稳定性尚待验。功能未验收，不能称抖音已接通。

## 发布交接块

- 类型：文档与来源研究；不含功能实现、依赖或版本变更。
- 影响：提供其他渠道真实状态、抖音路线比较与后续验收边界；不改变现有 QQ/B站行为。
- 验证：静态核对源码和固定上游资料、本地链接和空白检查通过；不构成真实浏览器、账号、推荐、媒体或 ASR 验收。`npm run test:audit` 在该独立树退出 1（125/169 scripts）：缺少 `js-yaml`，ASR Host 夹具返回 `ASR_DISK_SPACE_LOW`；测试时本卷可用约 503 MiB。未安装依赖或清理用户数据，组合门禁由主线处理。
- 发布前：由实施主线完成组合检查和真实验收，并核对发布清单；本提交本身不授权发布。
- 回滚：单独回退本文档提交，不清除用户数据或独立浏览器资料。
