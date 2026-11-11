# Bili V2：真实 comment/DM worker 的固定意图传输

状态：HY4 run1/3 交付后协调者独立验收通过，生产 index 接线与平台实际形状验证未完成。

## 完整逻辑

1. **链路**：typed tool 启动真实 comment.mjs/dm.mjs 子进程，经 attachBiliV2Worker 解码固定意图，交由 Host official factory 处理。此前只验证简化 CLI 脚本，没有证明真实命令符合该协议。
2. **机制**：真实 comment 在 worker 端增加 WBI query，严格固定 endpoint 解码会提前拒绝；两命令还携带 worker Cookie/CSRF。managed 模式改为固定 URL、业务载荷和 content-type，由 Host 的同一凭据快照确认账号、生成 CSRF。Host 拒绝或未知回执以 code/error/hint/unknown 返回，命令输出结构化派生回执后退出，不自动重发。业务目标、正文和原有私信入站/互动/额度闸保留。
3. **爆炸半径**：两命令加一离线集成测试；涉及 worker→Host 两进程的一个受控出口，失败可见系数 1，局部 2×1×1。没有真实凭据、外网或平台发送。stdout 是派生回执，绝不作为新 observed 原件入库。
4. **取舍**：放宽 decoder 允许 query/worker 凭据会破坏 Host 所有权；选择 command 内最小 managed 分支，沿用已通过 69 项的 official adapter。未托管 V1 保留 WBI/worker Cookie/CSRF 路径，两条 V1 用例实际执行 fake fetch 验证。
5. **生效与重启**：CLI 随下次经完整门禁的桌面插件安装生效；本次未安装、未改 profile、未重启。未请求或执行平台验证。
6. **验证**：`node plugins/surfcore/scripts/test-memory-v2-bili-write-workers.mjs` 独立 Node24 10/10。实际 fork、IPC decoder、official factory 均使用真实代码；仅官方 URL 白名单 fake fetch。成功各 1 次 Host POST、worker 直连 POST=0；互动关闭、入站条件、账号不符、凭据切换、Host epoch 拒绝均 0 POST；POST 后 unknown 为 POST=1/dispatch=1，未重发。Host epoch 是错误透传测试，不宣称 CLI stale 检测已经实测。
7. **回滚与残余**：两命令预编辑备份和 diff/log 在 `_backups/memory-v2-bili-write-workers/`，恢复前隔离当前字节；不改 dispatcher 或转回 V1 以掩盖 V2 失败。生产 getScope、完整 typed 来源、VIDEO/dm-history/read today 与总门禁仍在父任务；新 factory 每 job 的组合与 native/平台外形状尚待验证。

## 证据

协调者独立日志：`_backups/memory-v2-coordinator/bili-retirement-cleanup-20261110/write-workers-accepted.log`；子端 RED/GREEN、两 Node 结果及 V1/未知回执证据在 worker 备份目录。

## 可转发发布交接块

- 版本/提交：未改、未提交；不能作为整套 Memory V2 完成或已安装证据。
- 改动：真实 comment/DM managed CLI 固定意图、Host 唯一凭据/CSRF、可消费失败回执，V1 路径保留。
- 验证：协调者实际 fork→IPC→official factory 10/10，外网/provider/native/付费/平台发送全 0。
- 生效/回滚：完整 P0–P4 后安装 desktop；两命令预编辑备份可恢复，保留其它 Memory V2 未提交改动。
