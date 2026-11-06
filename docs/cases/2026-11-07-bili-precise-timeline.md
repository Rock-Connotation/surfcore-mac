# B站精确播放时间轴修复（2026-11-07）

## 完整逻辑

1. 链路：`view.pages[].duration` 进入 `resolveBiliPart`，再由 Host/debrief 传入媒体准备；播放地址的 `timelength` 现在在同一条链路归一化后驱动分段时间轴、覆盖率、抽帧与 ASR。
2. 机制：pages 时长是整秒展示值，playurl.timelength 是选中 cid 的毫秒值。只有 `ceil(precise/1000)*1000 === declared`（或完全相等）才采用精确值；缺失时保持旧声明时长，存在但矛盾时 fail closed。
3. 爆炸半径：影响 B站 Host、CLI debrief、媒体分段与覆盖率判断；不触碰凭据、资金或外发。音频/视频仍分别校验，未把任一流的短时长伪装为完整。
4. 取舍：路线 A 只在下载后放宽差异会掩盖缺失；路线 B 在播放地址进入媒体准备前建立单一时间轴契约，保留严格 gap 检测并复用已取得 playurl，故采用 B。
5. 生效与重启：代码由 B站 Host/CLI 进程加载；下次启动对应进程即可生效，本次未运行真实 runtime。
6. 验证：官方 Node24 逐一运行 `plugins/surfcore/scripts/test-bili-media*.mjs`，全部 exit 0；回归覆盖 175000 声明、174613 精确完整、缺少精确元数据、174000 不一致 fail closed，以及 Host 生命周期。
7. 回滚与残余：回滚本提交即可恢复旧行为；真实 BV1GJnZ6MEFw 的 Host/debrief/round 组合与生产连接仍待主代理集成后复验。

## 发布交接块

- 分支：`fix/bili-timeline`
- 变更：精确 playurl 时间轴归一化、单次 playurl 传递、严格矛盾拒绝及离线回归。
- 验证：官方 Node24 `for f in plugins/surfcore/scripts/test-bili-media*.mjs; do ...; done`，5 个专项全部 exit 0。
- 未验证：真实 Host/debrief/round 与真实 B站素材；不发布、不改版本、不更新 manifest。
