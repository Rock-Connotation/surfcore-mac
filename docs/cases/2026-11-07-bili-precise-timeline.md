# B站精确播放时间轴修复（2026-11-07）

## 完整逻辑

1. 链路：`view.pages[].duration` 进入 `resolveBiliPart`，再由 Host/debrief 传入媒体准备；播放地址的 `timelength` 现在在同一条链路归一化后驱动分段时间轴、覆盖率、抽帧与 ASR。
2. 机制：pages 时长是整秒展示值，playurl.timelength 是选中 cid 的毫秒值。只有 `ceil(precise/1000)*1000 === declared`（或完全相等）才采用精确值；缺失时保持旧声明时长，存在但矛盾时 fail closed。
3. 爆炸半径：影响 B站 Host、CLI debrief、媒体分段与覆盖率判断；不触碰凭据、资金或外发。音频/视频仍分别校验，未把任一流的短时长伪装为完整。
4. 取舍：路线 A 只在下载后放宽差异会掩盖缺失；路线 B 在播放地址进入媒体准备前建立单一时间轴契约，保留严格 gap 检测并复用已取得 playurl，故采用 B。
5. 生效与重启：代码由 B站 Host/CLI 进程加载；下次启动对应进程即可生效，本次未运行真实 runtime。
6. 验证：官方 Node24 逐一运行 `plugins/surfcore/scripts/test-bili-media*.mjs`，5 个专项全部 exit 0；回归覆盖 175000 声明、174613 精确完整、同一精确元数据下实际媒体 174000 的 missing 613ms、缺少精确元数据、空/0/非法精确字段 fail closed，以及 Host 生命周期。原始旧实现没有精确归一化用例，无法在本轮留下独立旧版本红输出；新增断言直接钉住此前 387ms 假缺口与真实 613ms 缺口的区别。
7. 回滚与残余：回滚本提交即可恢复旧行为；真实 BV1GJnZ6MEFw 的 Host/debrief/round 组合与生产连接仍待主代理集成后复验。

## 发布交接块

- 分支：`fix/bili-timeline`
- 变更：精确 playurl 时间轴归一化、单次 playurl 传递、严格矛盾拒绝及离线回归。
- 验证：官方 Node24 `for f in plugins/surfcore/scripts/test-bili-media*.mjs; do ...; done`，5 个专项全部 exit 0。
- 未验证：真实 Host/debrief/round 与真实 B站素材；本轮仅离线 fake probe/download，未访问网络、凭据或 runtime；不发布、不改版本、不更新 manifest。


## 主线原始证据与边界补验

- 实际68358b8官方App选择BV1GJnZ6MEFw/P1/cid43075504281，view声明175000ms、同一playurl.timelength174613ms、dash.duration175秒。完整下载文件FFprobe：audio174613.333ms、video174600ms。父作业仅相对整数声明partial，模型只消耗选题1次；未正式评分/未外发。这补足了前轮仅知道“缺尾”的证据，不能回写旧候选为通过。
- 主线对Git对象68358b8的媒体模块运行实际prepareBiliMedia夹具，明确红灯175000!=174613；当前修复绿灯。相同精确元数据下实际174000仍缺613ms。日志timeline-owning-{red,green}.log和脚本在_backups/20261107-readiness。不是通过四舍五入处理范围。
- 主线另用移除新增await后角色检查的隔离变异件证明转场断言会红；修复绿灯。完整lifecycle用例同时覆盖取消，late playurl不能调用prepareMedia。初次测试错把STALE_CHARACTER的既有interrupted终态写成failed，已修正测试并保留失败日志；未修改产品终态迎合断言。
- DASH回归按真实audio174613/video174600形状断言：音轨完整、视频仍缺13ms；不能把音轨完整说成完整视频覆盖。本轮正式点评仅以完整音轨为依据，沿用原UI声明。
- 新补验授权累计上限：B站3次Hy4、QQ4次Hy4及原唯一私聊8文本，每次最多8192输出，不自动重试；旧账本保持11/12与19/30，不重置。私有代理分别拦截实际入口，cap3/cap4并发和cap8文本网关离线边界已验证。实际最终结果由本轮收口case补记。
