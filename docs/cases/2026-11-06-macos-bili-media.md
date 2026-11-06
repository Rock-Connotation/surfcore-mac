# macOS B 站媒体与共享转写接线（组合待验）

## 现象与环境

基线 `52ced0f`：旧 watch/debrief/subtitles 各取顶层 cid，watch 只取首个 durl；`--no-frames` 被初筛误用作浅看。多 P 因此可能把画面和字幕指向不同时间轴，缺字幕也没有实际共享 ASR。独立工作树 `feat/macos-bili`；不触碰真实账号或宿主 profile。

## 完整逻辑

1. 链路：CLI `bili.mjs` → 选 P / 字幕和媒体 `bili-media.mjs` → Host 受令牌保护的 perception API → B 站父作业取得素材 → 共享 ASR 子作业与作业状态；debrief 汇总素材，`watch-history.mjs` 写选定角色的分 P 历史。scheduler 初筛须显式 `--shallow`；材料实际完成后先写原角色历史，再以稳定 eventId 调用 Host 经历回调；未经取得的材料不生成经历。
2. 机制：媒体获取与抽帧同一时刻只运行一个父作业，排队可立即取消；运行中的取消等待受管子进程退出，晚到的 ASR 结果不能覆盖取消状态。`view.pages` 统一 page/cid/时长，校验冲突；DASH 音轨优先，否则按 durl 顺序取得所有分段，逐段下载、probe 和完整解码，保留缺口映射。字幕接口的 cid 冲突拒绝使用；字幕轨存在不证明覆盖所有讲话。选中的角色及 epoch 和 activityId 在网络等待前冻结。force 即使有字幕也提交 ASR；no-frames 只控制图片；`--no-history` 持久关闭父作业的观看历史和经历投影，作业状态查询不会补写账本。
3. 影响：涉及 B 站只读媒体、当前角色观看账本、Host 作业及本地可再生素材；Cookie/令牌不应输出，媒体下载不转发 Cookie。未经实际结果不得声称已听完；外发和互动预算门禁不由此链路改变。
4. 取舍：继续修原有独立三套路径成本低但重复选 P 易错；共享媒体适配器改动较大但可统一验证、明确回滚和后续维护。未引入外部下载器，以免新增凭据传递和运行依赖。
5. 生效：代码必须进入目标插件并重载 Host；本次未安装、重启或发布。运行时路径及 Host 路由由其他工作包提供，组合后须再次验证。
6. 验证：`node plugins/surfcore/scripts/test-bili-media.mjs` 覆盖 P2、冲突、错误 cid、DASH、缺段、截断、取消、历史升级及令牌/API；`node plugins/surfcore/scripts/test-bili-media-no-history.mjs` 以真实 CLI 和本机回环 Host 验证提交、完成及查询均不写历史/经历；`node plugins/surfcore/scripts/test-bili-media-lifecycle.mjs` 覆盖单槽、排队取消、真实 helper 退出和迟到结果；`node plugins/surfcore/scripts/test-bili-media-host.mjs` 覆盖异步父作业、取消、重启恢复、角色变更、经历重试和配置锁；`node plugins/surfcore/scripts/test-bili-media-frames.mjs` 在本机 FFmpeg 上验证场景吸附、均匀模式和字幕条实际输出。`node scripts/test-watch-history.mjs` 和 `node scripts/test-shots-cache.mjs` 验证旧历史及缓存策略。`npm run test:regressions` exit 0；`npm test --prefix plugins/surfcore` exit 0。首轮 audit 为 142/144，两个断言绑定旧子进程与旧临时路径，改为直接媒体和缓存行为后，重跑 144/144，exit 0；组合后仍须按最终文件重新执行。
7. 回滚与残余：源文件改动前备份在工作树 `_backups/2026-11-06-wp4-bili/`，可按文件恢复；不得清理用户数据。父作业接口、Host/核心组合、真实角色切换、真实无字幕视频、记忆闭环及 Windows 未验证；识别文本准确率未测。当前夹具不构成 App 或平台验收。

## 原因与未发现原因

旧实现以顶层字段和首段响应为前提，单 P 单段用例无法暴露跨 P 和中间缺段。新断言使用分 P 冲突及中间缺段夹具；仅测试文件存在不能证明完整覆盖。

## 发布交接（草稿，不代表可发布）

```text
【B 站媒体 / 共享 ASR 接线】
基线：52ced0f；工作树 feat/macos-bili，未提交、未发布。
变化：选 P/cid 校验、字幕与音轨同源、DASH / 全 durl 和缺口、分 P 历史、浅看/深读/force ASR、Host 父作业与共享 ASR 状态、实际材料后的受限经历。
验证：针对性夹具、观看历史和缓存用例通过；regressions 和插件测试通过；完整 audit 见最终组合记录。
阻塞：Host 组合、真实无字幕 ASR、记忆与真实 App/账号均未验；领取并恢复过期角色作业必须被拒绝。不可按完成或发布交付。
回滚：先保存新增数据，再按 _backups/2026-11-06-wp4-bili 及基线恢复代码；不删除角色、凭据、素材或模型。
```
