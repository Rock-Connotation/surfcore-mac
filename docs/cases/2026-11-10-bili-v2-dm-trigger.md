# Bili V2：DM 触发保留精确 msgKey

## 现象、根因与完整逻辑

1. **链路**：scheduler 读取 `bili.mjs dm-await --any` 输出，owner 分支也能独立输出 JSON；原 producer 仅保留 mid/name/text/ts 等通知投影，丢失官方 last_msg.msg_key。V2 官方读取必须以同一来信的精确 msgKey 定位，不能按摘要认证原件。
2. **机制**：`plugins/surfcore/tools/commands/dm-await.mjs` 新增纯函数 exactMsgKey，十进制正整数字符串原样保留，正安全整数才转字符串；unsafe number、对象、空值等不构造新 ID。any、poll 和 owner JSON 三处仅在有效时增加 msgKey。seen、首基线、本人/来信过滤、退出码和原 JSON 字段保留。
3. **爆炸半径**：一个 CLI producer 和两个消费边界（scheduler/独立 owner 调用）；新增字段向后兼容。原通知仍可供 V1 使用，V2 缺 selector 必须拒绝，不把旧 text 当 full。离线测试只写隔离 DSH_HOME，不读取实际凭据、不发消息或调用 provider。
4. **取舍**：从时间戳/摘要生成 msgKey 能消除缺字段报错却无法证明原件；强制所有旧通知失败会改变 V1 行为。采用可选精确字段与 V2 严格消费者，改动小、可回滚，完整原件仍由 Host fresh account + 官方 GET 验证。
5. **生效与重启**：尚未安装桌面 Host。最终升级后，后续新 CLI 子进程读取此代码，scheduler 的 V2 消费接线仍待完成；不改现有平台启停和 V1 默认。
6. **验证**：RED 为 19 位 ID 应原样保留却得到 undefined。子代理与父端独立 Node24 均运行真实 bili.mjs dm-await，10/10 通过：19 位字符串、安全整数、缺字段、13 类非法值、本人消息、已读/首基线、owner 命中与非 owner 过滤。fetch shim 只允许官方 get_sessions GET，stdout 恰为单行 JSON、无凭据泄漏。父端读实际 diff 并确认只新增可选字段，git diff --check=0。
7. **回滚与残余**：原件/RED/GREEN 在 `_backups/memory-v2-bili-dm-trigger/`，父端复验在 `_backups/memory-v2-coordinator/dm-trigger-independent/node24.log`。保全后恢复原 dm-await 即可撤回新字段，不回滚用户 seen 状态。真实 get_sessions 字段类型、历史私信读取、V2 生产组合/当前页面失败呈现与最终全仓门禁未验。

## 失败与验证命令

无效 msg_key 只省略新增字段，V1 通知继续；后续严格 V2 projector 返回 code/error/hint，要求取得完整官方 selector 后发起新作业，不允许按摘要重绑定。只看当前 CLI 通知成功不代表原件或 V2 成功。

```bash
node plugins/surfcore/scripts/test-memory-v2-bili-dm-trigger.mjs
```

子代理交回时提及的旧 officialDm `String(last.msg_key)` 精度缺口已由父端此前 officialId 守卫修复并验收 76 项；原件/回复坐标也已由 sourceRoot + projector 单独验证，不能把旧观察当作仍未处理的问题。

## 可转发发布交接块

- 文件：dm-await、10 场景回归、DM trigger 契约与本 case。
- 结果：真实 CLI 隔离测试父端 10/10，旧过滤与 JSON 输出保持，无实际外网/provider/平台写入。
- 建议：单点修复可作 patch，实际随 Memory V2 合并时由发布会话决定版本；本会话不发布。
- 层级与兼容：新增可选内部 DTO 字段，V1 向后兼容；完整逻辑与影响面见上文。
- 失败与残余：V2 缺 selector 拒绝已有投影测试；生产消费、用户界面呈现、最终门禁与桌面实装待完成。
