# Bili V2：触发原件坐标与回复坐标分开

## 现象与根因

B站通知输出的 root/parent 已被 `replyCoordinates` 归一为待发送回复的坐标。把它们直接当作收到的原评论坐标，会将顶层原评论的 root=0/parent=0 错写成 root=31/parent=31。DM 也必须保留同一条官方 last_msg 的精确 msgKey；缺少 selector 时不能从摘要猜原文。

环境：未提交 feat/memory-v2、Node 24；未安装桌面 Host。触发投影不是身份验证器，官方 transport 和 Memory Host 仍负责账号、对象、权限与完整来源证明。

## 完整逻辑

1. **链路**：`plugins/surfcore/tools/lib/msgfeed.mjs` 保留原始 `sourceRoot`，旧 root/parent 继续供 V1 回复使用；`plugins/surfcore/lib/bili-v2-triggers.mjs` 把受信 scheduler DTO 投影为分组后的 source locator 与 send scope。official transport 再按 locator 读取完整原件，Source Runtime 校验其身份、wire 和来源证明。
2. **机制**：原 root_id=0/source_id=31/target_id=0 表示收到顶层评论 31；原件 locator 必须 root=0/parent=0，而回复 sink 必须 root=31/parent=31。二者同一 OID，现有对象作用域已允许，不需要放宽到别的对象。评论作者/source ID、DM msgKey 等 selector 只来自触发原字段，title/text/coverage 等摘要声明不进入 locator。
3. **爆炸半径**：通知命令与插件 Host 两个边界消费者；旧字段保留，新投影失败显式拒绝。离线夹具不碰用户数据、实际凭据或平台写入。省略原坐标会造成难以发现的错误来源匹配，故缺字段不能猜测或降级成 full。
4. **取舍**：复用旧 root/parent 改动少但语义错误；修改旧字段会破坏 V1。采用新增 sourceRoot 和小型纯投影，保留旧输出并拒绝缺失字段，回滚局部明确。没有增加跨对象或私聊权限。
5. **生效与重启**：模块独立测试已通过，生产 Bili Host/scheduler 组合仍待接线；当前不会启动平台。最终桌面 Host 安装后才读取新插件；V1 默认不变。
6. **验证**：先用真实 pullFeed + fake official HTTP 复现 `undefined !== '0'` 的 RED。GREEN 验证原坐标/回复坐标、分组/去重/冻结、19 位字符串、安全整数、空/33 条/不支持 kind/缺失或不安全 ID 拒绝。真实 official transport 的 fake HTTP 联合测试取得 root=0/parent=0 的完整正文，并证明原件与回复 31 同会话；变更 OID 拒绝，POST=0。旧 test-msgfeed-oid 继续通过。
7. **回滚与残余**：修改前 msgfeed 与 RED/GREEN 在 `_backups/memory-v2-coordinator/bili-trigger-projection-20261110/`；保全后可撤回投影入口并恢复旧 producer，新模块不接入即可禁用。不更改用户记录。DM producer 的精确 msgKey 工单、feed/debrief 来源、Host timer 证明和生产失败可见性仍需分别验收。

## 接口与失败验证

`projectBiliV2Trigger({ input, providerRouteId } = {})` 仅接受 comment-notification/dm-notification、1–32 条、合法精确 route。成功返回深冻结的 `{ok:true, groups:[{scope:{audience,target,providerRouteId}, input:{kind,items}}]}`。未知 kind 返回 `BILI_V2_TRIGGER_UNSUPPORTED`，不完整/不安全 selector 返回 `BILI_V2_TRIGGER_UNPROVEN`；均带 error/hint，要求恢复完整官方 selector 后发起新作业，禁止用摘要补原件。

```bash
node plugins/surfcore/scripts/test-memory-v2-bili-triggers.mjs
node plugins/surfcore/scripts/test-msgfeed-oid.mjs
```

证据：上述备份目录中的 `official-joint-green.log` 与 `verification.json`。没有真实平台读取/发送、真实 provider、桌面安装或全仓门禁结论。生产调用方当前界面的可见失败仍是接线验收项。

## 可转发发布交接块

- 文件：msgfeed 新 sourceRoot、bili-v2-triggers 模块/测试与本 case。
- 结果：实际 producer 离线 RED/GREEN、旧 OID 用例、真实 official 实现的受控 HTTP 联合测试通过；零 POST/真实外网/provider。
- 建议：随 Memory V2 整体评估 minor，版本由发布会话决定；不发布尚未接线的中间态。
- 层级与兼容：新增内部触发 DTO，V1 字段/回复坐标保持。失败明确拒绝未证明 locator，未放宽账号/对象/受众权限。
- 残余：生产 Host、feed/debrief、timer 与当前页面错误呈现、联合门禁和桌面实装待完成。
