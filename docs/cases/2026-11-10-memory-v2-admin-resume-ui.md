# Memory V2 按原管理员编号恢复与不可信回执

状态：2026-11-10，HY4 run2/3 经协调者独立验收；隔离真实 React UI通过，生产组合及桌面安装仍待后续。保持 V1 默认。

## 完整逻辑

1. **链路**：`plugins/surfcore/lib/memory-v2-panel.mjs` 读取 Host `status.operations`，对未完成的 correct/create_person/bind_account/unbind_account/remove_hot 使用原 operationId 请求 `/memory-v2/admin-resume` 预览再确认。Host management 将原私有 context 交给实际 `adminResumer.resume`；生命周期恢复仍走原入口。界面、管理 HTTP 与 Worker 的证据分开记录。
2. **机制**：普通新建操作会生成新编号，恢复必须复用原编号与原摘要；纠正内容只由管理员输入，不能补造。run1 两个独立 RED 揭示：trim 改变内容导致 core exact actualPayloadDigest 冲突；confirm 回执编号不同虽然报错，却清掉了待核对态，页面提示一个不存在的按钮。run2 仅用 trim 判空、摘要和提交保留原字符串；回执不可信转原ID待核对，查询前禁用新 mutation，查询只发 GET，不自动重发。
3. **影响面**：本轮生产逻辑只改一处前端 panel（1 入口 × 1 读者 × 可见错误系数1）；通过既有受认证 HTTP 间接操作当前角色库。隔离验证没有用户数据写入、模型调用、平台发送或安装。API认证、角色/epoch/revision与摘要CAS均保留，能力缺失保持灰色。
4. **取舍**：沿用已有 Host 恢复协议与管理员原文输入，改动小、隐私面明确；让后端持久化恢复原文需要额外存储及接口设计。本次选择前者，恢复操作沿用原编号，不新增平行任务或扩大正文持久化。
5. **生效与重启**：修改前端组件与测试，实际桌面 Host 需在最终制品安装后重新加载前端。当前仅在隔离浏览器运行生产组件，尚未改 desktop profile 或重启公共 Host；最终安装目标为 DeepSeek Harness.app。
6. **验证**：Node24 跑 `plugins/surfcore/scripts/test-memory-v2-panel-resume.mjs`（11组）及 `test-memory-v2-ui.mjs`，协调者的原错回执与首尾空白探针均通过。旧管理35场景、admin22在前轮独立通过；run2两套实际React happy/conflict `scripts/test-memory-v2-ui-visual.mjs` 通过，1440×1000和390×844、light。每组Before/After的场景、状态、client/fixture摘要、视口与主题相同，仅panel摘要改变；冲突态能见原ID/核对按钮、禁止新mutation、按原ID GET后解锁且无重复POST。
7. **回滚与残余**：保留 `_backups/memory-v2-panel-admin-resume/{before-source,run1}` 与协调者证据，不删除原任务、凭据或数据。需要回滚时先保全现状再恢复对应panel字节。实际运行时装配、会话退役、完整迁移和最终联合门禁还未完成，不将隔离UI成功当成桌面已安装。

## 独立证据

- `_backups/memory-v2-coordinator/panel-resume-independent/{mismatched-receipt-red,exact-content-red}.log`：两条原始RED；`mismatched-receipt-probe.mjs`、`exact-content-probe.mjs`保留复验入口。
- `_backups/memory-v2-coordinator/panel-resume-run2-independent/verification.json`：两独立探针、panel、旧UI、实际React happy/conflict 全部0；各项单独日志与最终截图同目录。
- `_backups/memory-v2-panel-admin-resume/{visual,visual-conflict}`：两组同场景双视口Before/After；当前panel SHA256 `a663d750bd50675e06bc50a49a98afb8904457918680db5f9d213b189ac7a283`。

## 可直接转发的发布交接块

改动：Memory V2 按原管理员编号恢复、纠正原文保真、不可信回执只查原编号并阻止重复提交。
范围：生产panel、两份UI测试、恢复契约及本case；后端认证与数据格式不变。
验证：原两条独立RED转GREEN；11组普通断言、旧UI与真实React happy/conflict双视口通过。前轮实际管理35/admin22通过；最终全仓门禁仍待冻结后运行。
生效：尚未安装；后续仅安装至DeepSeek Harness.app desktop，不切生产V2、不自动迁移。
回滚：先保全现状，再恢复before-source/run1对应字节；原操作与用户数据保留。
版本/提交/发布：未改版本、未提交、未发布；整体P0–P4未完成。
