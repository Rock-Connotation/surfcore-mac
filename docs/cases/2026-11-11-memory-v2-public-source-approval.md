# Memory V2：按确切公开来源集合预览并审批

状态：Runtime/管理 API/界面接线的定向验收通过；纯派生 helper 第二轮与视频 Source 已独立接受，官方 Host 公共读取仍在实施。不是整个 Memory V2 或生产切换的完成证明。V1 默认、生产激活与迁移仍需独立预览确认。

## 完整逻辑

1. **链路**：Host 将实际角色、官方账号和精确模型核验后的集合交给 `plugins/surfcore/lib/memory-v2-runtime.mjs`；Runtime 重派生完整集合，向 `memory-v2-management.mjs` 提供单独的审批候选。管理接口核对当前角色、模型、完整成员与隐藏 policy，再向 `memory-v2-panel.mjs` 输出安全预览。用户在选择和最终预览两处都能看到完整 BV/aid、评论 rpid/坐标、作者、账号和模型；核心 Worker 继续执行既有精确 audience 权限。
2. **机制**：Core 不允许把一个公开对象的来源自动带进另一公开会话；其 audience 必须精确相等，重叠 policy 又会产生歧义。因此每个来源和动态输出使用绑定完整集合摘要的内部处理会话，各 alias 共用一项经单独审批的多 audience policy。真实 sourceKey、官方对象 ID、作者和原文不因此改变；新增成员、角色 epoch、账号或精确模型变化会得到另一个集合，旧批准不复用。普通通知和私信仍用其既有物理会话。
3. **影响面**：Host 插件进程与 WebGUI 渲染进程两端；Memory Worker 使用 node:worker_threads，不另算独立进程。主要行为读者为 Runtime、Management、Panel、Bagg 四模块，失败显式报告（粗粒度 2×4×1）。验证使用隔离 SQLite、合成平台状态和 loopback API；不读写生产记忆，不调用真实 provider，不发送平台消息。真实官方 Host 入口未接通的部分不能算验证通过。
4. **取舍**：用户选择确切集合逐次审批，排除同账号全公开来源自动共享。技术上选择集合专属 alias，复用现有 Core 精确匹配和多 audience grant；扩大 Core wildcard 或叠加旧对象 policy 会扩大权限或制造歧义。此方案的代价是集合变化必须重新审批，收益是批准对象清楚、跨集合无隐式复用，回滚也局限在适配层。
5. **生效与重启**：最终插件安装到 DeepSeek Harness.app 并重新加载后才生效；浏览器视图随插件版本重新加载。当前未安装、未重启公共 Host、未改变 desktop profile，保持 V1 默认。后续正式切换与数据迁移仍单独预览确认。
6. **验证**：Node24 `plugins/surfcore/scripts/test-memory-v2-runtime.mjs` 使用实际 Memory Worker，证明两个成员和一个输出各自 capture/release；扩展集合、私信、伪造集合及账号/模型/epoch 变化拒绝。该测试仅在隔离库合成开启 shadow，并恢复关闭，backend 始终 v1。management35、panel-resume、ui 回归通过。真实生产 React 组件使用同一完整 fixture、1440×1000 / 390×844、浅色 Before/After；19位 ID 不截断，完整列表可见，缺失最终来源预览显示 MEMORY_PREVIEW_INVALID 和非空 hint，不开放确认。审批预览移除旧的删除/清理统计，避免来源数与完整清单混淆；3次 configure_policy 请求全部 preview=true，实际批准 POST=0。
7. **回滚与残余**：修改前字节、日志、截图与来源 hash 保存在 `_backups/memory-v2-coordinator/bili-public-set-integration/`；先保全当前状态再恢复对应文件，不能删 policy 或用户数据。helper run1 的 getter/Proxy 缺口已退回run2修复，父端41例与7个独立拒绝/零回调探针通过。VIDEO-SOURCE run1普通39及实际SDK既有来源2/30回归也已接受；Host/index/接收观察增量见11日Host wiring case，官方公共读取联合与全仓门禁仍未完成。

## 受控读取接缝

`bili-v2-agent.mjs` 新增可选 Host transport.read 路径：typed feed/debrief 在 fork CLI 之前执行私有读回调，结果须非空且有界，再由 Source capture 并绑定后返回。回调拒绝时抛结构化错误并退休，不回落 CLI。两条实测回归把 CLI worker 改成落 marker 的诱饵，验证允许/拒绝两条路径都不启动它；Node24 原42+新2共44场景通过。该回调已在Host装配中注入，官方公共read实现和完整联合验收仍待，详见11日Host wiring case。证据 `_backups/memory-v2-coordinator/bili-scoped-read/agent-{red,green}.log`。

## 失败与恢复

无当前角色、账号或精确模型证明时不生成审批候选；完整集合或最终预览缺失/变化时当前界面展示 code/error/hint 并阻止确认。未经批准的新增来源保持拒绝，须重新核对确切集合并预览。原操作结果未知时继续沿用原 operationId 查询，不换编号重发；不以批准公开集合代替私信授权或生产迁移确认。

## 可直接转发的发布交接块

改动：Bili 公开动态按角色/账号/精确模型与完整公开来源集合单独预览审批；新增来源重批，私信隔离；V2 typed read 增加先捕获后返回且不回落 CLI 的接缝。
范围：Runtime、管理接口、现有记忆卡界面、Agent typed-read 接缝与定向测试；Core 精确 audience 规则不变。
验证：实际 Worker 的隔离集合权限、管理35项、panel/ui、Agent44场景通过；生产 React 同 fixture 桌面/移动 Before/After 和缺元数据失败可见通过；真实 provider/平台写入/实际 UI 批准 POST均0。
未完成：官方公共读取联合、手动单轮正向、实际全局生命周期、QQ等总目标与全量门禁；helper/VIDEO-SOURCE/Host接收观察和index的定向增量已接受，详见Host wiring case。不可据此发布或宣布P0–P4完成。
生效：尚未安装；最终安装目标 DeepSeek Harness.app desktop，保持V1，正式迁移/切换另行预览确认。
回滚：保全当前字节后恢复备份中的对应文件；不删除用户数据、policy或owner锁。


### 2026-11-11 10:48 官方公开读取与 feed/debrief Native 接受（总目标未完成）

Official run3/3 已独立接受：新11/旧76/完整Host/实际Worker Runtime均绿；实际安装SDK工厂的debrief及双视频feed分别3fakecalls/45tokens，下一步原生请求含受控工具回包，workerForks/jobs/sources0，外网与平台写入0。联合验收修复真实释放{ok:true}回执、transport.read挂载位置、Core规范化audiences比较三处缺陷。详见 docs/cases/2026-11-11-memory-bili-official-public-read.md，证据 _backups/memory-v2-coordinator/bili-official-independent/。fixture合成预激活，productionActivationVerified=false，生产V1默认；未安装未重启。

HY4两次失败已从保留会话记录独立核实为HTTP429 RATE_LIMIT/WorkBuddy配额或频率与bili_throttle_hold；没有证据称当前调用已恢复。经用户授权改用GPT6.1 Terra xhigh，当前Session未记录模型allowlist。QQ租约run2/3在办，补HTTP成功但缺少message_id的未知结果拒绝；Host角色/凭据/停用/Core生命周期、正向V2单轮、QQ Native/预算、可信导入尾增量、全门禁、中文提交确认/dev合并保全清树/桌面安装仍未完成。本增量覆盖之前Official/公共Native待验的阶段状态。
