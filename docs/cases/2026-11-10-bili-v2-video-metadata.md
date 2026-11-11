# Bili V2 视频文字元数据：固定官方读取与日期失败边界

状态：helper 模块 run2 已独立接受；生产来源/作用域/native/index 接线仍待。V1 默认不变。

## 完整逻辑

1. **链路**：`plugins/surfcore/lib/bili-v2-video-metadata.mjs` 导出 `readBiliV2VideoMetadata({ locator, officialGet } = {})`，上游须提供 Host 私有官方 GET closure 和精确 video selector。仅调用固定官方 `https://api.bilibili.com/x/web-interface/view?bvid=...` 或 `?aid=...`，一次一参，不自建 fetch、凭据、WBI 或重试。下游收到冻结的选定文字字段；尚未连入 Source runtime，不能当完整影音原件。
2. **机制**：输入必须是精确两键 `{kind:'video',bvid}` 或 `{kind:'video',aid}`。官方 code=0，返回 BV/aid 与 selector 匹配，owner.mid/aid 保持精确十进制字符串，安全整数才允许转字符串。title/desc/name 和原始 pubdate 必须存在；title 原文、空 desc/name 均按原件保留。`coverage='text-only'`，无音轨/帧/字幕或全量 body。run1 只判 safe-positive 秒值，MAX_SAFE_INTEGER 仍超过 Date 可表示范围，导致 `RangeError: Invalid time value`；run2 加 TimeClip 最大秒值 8640000000000，越界走固定 `BILI_VIDEO_ORIGINAL_INCOMPLETE`。
3. **影响**：helper 不创建进程、网络、来源身份、受众或库记录；读取者目前是对应普通测试，生产消费者未接。选定字段无 cookie/raw body/无关扩展，ID 不经不安全 Number 转换。后续 Host 必须另行实施账号/角色/路由/精确对象/关闭和撤销保护，此模块不授予权限。
4. **取舍**：返回 CLI 推荐摘要更省调用，但不能证明原件字段；获取全部视频媒体成本与用途不符。采用一次固定 view 读取选定文字字段，诚实标注 text-only。对时间只限制可表示性，未加入未经要求的年份业务限制或按 now/summary 补齐。
5. **生效与重启**：工作树测试直接加载；目前生产无引用，不需要也未执行桌面重启/安装。最终 desktop 插件接线安装后才可能使用；原 V1 `score --today` 未动。
6. **验证**：父端 Node24 执行 `plugins/surfcore/scripts/test-memory-v2-bili-video-metadata.mjs`，27/27 PASS；另独立检查 MAX_SAFE_INTEGER 和 8640000000001 结构化拒绝、8640000000000 成功为 `+275760-09-13T00:00:00.000Z`，每例 GET 恰为1。原 23 用例保留。证据 `_backups/memory-v2-coordinator/video-metadata-independent/{node24-run1.log,pubdate-red.log,node24-run2.log,pubdate-green.log,verification.json}`；子代理两轮 RED/GREEN 与精确 diff 位于 `_backups/memory-v2-bili-video-metadata/`。全部使用 fake officialGet，外网/provider/平台写入为0。
7. **回滚与残余**：三个新增 helper/test/contract 可先保全再撤引用；当前无生产消费者或 schema/data 迁移。Host transport、跨公开来源与作业的授权、feed/debrief、native 联合、最终门禁尚未验收；真实官方响应未查询，?aid 形式按冻结契约构造，不声称真实线上验证。任何 ok:false 固定 code/error/hint，下游仍须在现有页面可见展示。

## 可转发发布交接块

- 改动：新增固定 view 视频文字元数据 helper、27场景测试及日期越界结构化拒绝。
- 验证：Node24 父端27/27、另3日期边界、GET计数1；子代理Node24/26 GREEN，旧23断言保留。
- 限制：仅 fake officialGet，text-only；生产 Source/Host/权限/native/页面未接，不证明影音处理或线上官方接口。
- 生效/回滚：尚无生产引用，桌面未安装重启；撤引用前保全新增3文件，不碰用户库和旧来源。
- 发布：随 Memory V2 功能由发布会话定版本；本会话不 bump/tag/推送/发布。
