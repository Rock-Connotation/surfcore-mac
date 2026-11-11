# Memory V2 Bili：生产入口装配、接收观察与视频 Source（阶段验收）

状态：已接受 PUBLIC-SET run2、VIDEO-SOURCE run1，以及实际 SDK 的既有来源回归和接收观察纵向夹具。官方公共读取仍在实施，不能据此宣布 feed/debrief 联合或 P0–P4 完成。未安装，V1 默认；正式激活/迁移另行预览确认。

## 完整逻辑

1. **链路**：插件 Host 的 `plugins/surfcore/lib/index.js` 创建 Bili Host，把 Memory Runtime 渠道 adapter、实际 default-model、预算、鲜活角色与凭据 getter 交给它；Runtime 权限候选从同一 Host 取平台事实，scheduler 将原始事件交给该 Host。原生作业经 Bagg→Source→真实 Memory Worker，并在实际 SDK 请求处验证输入。现有通知 API 读取 gate-events，沿用现有界面展示失败。`plugins/surfcore/lib/bili-round-controller.js` 的单轮路径经 scheduler 上下文构造器；本阶段只封住其 V1 默认读取，正向 V2 适配仍待办。
2. **机制**：公共 feed 候选只从固定 `feed --json --no-remember` 提取 BV，之后须由官方读取解析确切原件、派生完整集合并审批，再创建 Native Root；候选摘要不是来源。scheduler 的 night/live/attack/nudge 事件可作为 Host 自己收到的观察，使用私有逐作业记录和 `observed-receiver`，绝不冒充第三方完整原件。重验证须包含恰好一份原始观察 proof，既不允许省略也不允许重复。video 则严格使用公开 `text-only` 元数据，record 保持10键，无 provenance 新字段，pubdate先守 Date 上限再转 ISO。
3. **爆炸半径**：Host 与 WebGUI 两端，真实 Memory Worker 为 Host 的 worker thread；直接读者为 Runtime 权限候选、scheduler、受管理 Bagg、Source/native hook、旧单轮上下文和现有通知接口。遗漏路由会静默读旧记忆，按“静默=3”视为高影响；现在结构化拒绝并出 L2 通知。当前验证只读写隔离夹具，无真实用户迁移、provider调用或平台写入。
4. **取舍**：可把 scheduler 摘要伪装成官方原件，代码少但破坏来源契约；选择明确的接收观察，保留原事件、接收时间和逐作业所有权，代价是独立重验证。旧单轮可继续默认 V1 或先拒绝：选择后者，先关闭后端绕过，再独立完成托管正向路径。精确集合采用派生 namespace，避免与物理对象 policy 重叠导致 `MEMORY_AUDIENCE_AMBIGUOUS`；不修改 Core 的 exact audience 边界。
5. **生效与重启**：当前只是工作树代码与隔离进程验证。最终目标为 macOS DeepSeek Harness.app 桌面 Host；安装后重启桌面 Host 才装载 index/SDK 接线，WebGUI重新加载客户端。尚未执行安装、真实桌面重启或生产切换。
6. **验证**：bundled Node24 下 Source39（原32保留）、triggers、DM10通过；PUBLIC-SET41和独立descriptor/Proxy负例已通过。实际安装 SDK 的 Source回归为2次fake provider/30tokens，inputs2、outputs1，未知shell拒绝、调用中途撤权阻断输出，退出时jobs/handles/tools清零；它验证既有来源回归，不宣称公共视频整链已验。实际 Host factory的评论+接收观察夹具也是2次fakecall/30tokens、job/source0。`test-memory-v2-bili-round-fence.mjs` 验证selected/explicit V2和缺控制库均在旧人设/记忆读取前拒绝；V1分支保留。`test-memory-v2-bili-index.mjs` 经真实 index/Runtime Worker/管理HTTP路由，证明模型metadata失败会进入现有通知端点，code为 `BILI_V2_ROUTE_UNPROVEN`、L2且建议非空，原始provider异常正文不泄漏。host-smoke/platform-start-host和round既有回归通过。全部外网/平台写入为0；不是生产网络验收。
7. **回滚与残余**：本阶段修改前字节和日志在 `_backups/memory-v2-coordinator/bili-host-public-read/`，Source原字节在 `_backups/memory-v2-bili-video-source/original/`；先保全新增状态再恢复对应代码，不删除用户 policy/库。官方公共读取、Host完整普通/公共视频Native联合、手动单轮正向、QQ Native/send、全局实际生命周期、稳定来源/importer/tail delta、总门禁、分批提交与dev合并/清树/desktop安装仍未完成。角色/账号生命周期接线正在只读查证；未将发现的缺口当作已交付。

## 证据与限制

- Source父端审查与重跑：`_backups/memory-v2-coordinator/bili-video-source-independent/`；production SHA256 `7d269ce119b1cbce60938dcad1bcecd4f1b981dad9124b67082ff8131d974f49`。10键record与顶层spread selector以源码/契约为准，早期“11字段”的口头计数无效。
- Host接收观察：`_backups/memory-v2-coordinator/bili-host-public-read/native-receiver-final.log`，`actualHostFactory/actualDefaultModelService/actualMemoryRuntimeWorker/actualBudget=true`；隔离库预置V2，`syntheticPreactivatedDatabase=true, productionActivationVerified=false`。
- Bagg普通回归须显式运行 `node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs --ordinary`：父端44/44通过，证据 `bili-video-source-independent/agent-ordinary.log`。省略 `--ordinary` 会另外要求实际Host工具夹具，不可把其缺失误归为Source回归。
- 旧单轮/用户可见失败：同目录 `round-fence-final.log`、`index-memory-failure.log`。测试曾因夹具缺Root sentinel、reader floor错误、缺控制DB、模拟请求缺loopback socket等被安全拒绝，补齐夹具后通过，未把这些误判为产品回归。
- Host普通测试目前只跑 `--preflight-fences-only` 可满足子集，完整suite依赖正在实现的Official public-read；未将子集通过记为完整接受。全仓audit/regressions尚待所有边界稳定后统一执行。

## 发布交接块（阶段记录，暂不可发布）

改了哪些文件：Bili Host/Source、index/scheduler接线及对应fixture/契约/case；具体提交分组待总验收后展示确认。
测过什么、结果：Source39、PUBLIC-SET41、triggers/DM10、round旧回归、Host smoke、index L2失败、实际Source2/30和Host接收观察2/30；详见上文日志。
建议patch还是minor：随Memory V2整体评估，本阶段不可独立宣布可发布，不改版本/不打tag/不推送。
case文档路径：docs/cases/2026-11-11-memory-bili-host-wiring.md。
改动层级：Host装配与来源接口加法；V1默认不变，V2旧单轮默认上下文改为明确拒绝，正向适配仍待。
完整逻辑与爆炸半径：见完整逻辑第1至4项；无生产迁移、真实付费或发送。
失败路径：现有L2通知显示固定code和下一步；单轮结构化code/error/hint；两者均有回归断言。
还有什么没验证：官方公共读取及公共视频完整Native、实际全局生命周期、QQ等总目标和全仓门禁；未安装未生产激活。

### 01:57 显式隔离 Home 的复核

Source 原生回归已在独立 `DSH_HOME` 下再次通过：`_backups/memory-v2-coordinator/bili-video-source-independent/source-native-explicit-home.log`；2 次模拟调用、30 tokens、晚撤权阻断、未知 shell 拒绝、零外网与平台写入。该证据复核既有来源链路，公共视频联合 Host 验收仍未完成。完整结构化结果与临时 Home 位置见同目录 `verification.json.nativeSourceExplicitHome`。


### 2026-11-11 10:48 官方公开读取与 feed/debrief Native 接受（总目标未完成）

Official run3/3 已独立接受：新11/旧76/完整Host/实际Worker Runtime均绿；实际安装SDK工厂的debrief及双视频feed分别3fakecalls/45tokens，下一步原生请求含受控工具回包，workerForks/jobs/sources0，外网与平台写入0。联合验收修复真实释放{ok:true}回执、transport.read挂载位置、Core规范化audiences比较三处缺陷。详见 docs/cases/2026-11-11-memory-bili-official-public-read.md，证据 _backups/memory-v2-coordinator/bili-official-independent/。fixture合成预激活，productionActivationVerified=false，生产V1默认；未安装未重启。

HY4两次失败已从保留会话记录独立核实为HTTP429 RATE_LIMIT/WorkBuddy配额或频率与bili_throttle_hold；没有证据称当前调用已恢复。经用户授权改用GPT6.1 Terra xhigh，当前Session未记录模型allowlist。QQ租约run2/3在办，补HTTP成功但缺少message_id的未知结果拒绝；Host角色/凭据/停用/Core生命周期、正向V2单轮、QQ Native/预算、可信导入尾增量、全门禁、中文提交确认/dev合并保全清树/桌面安装仍未完成。本增量覆盖之前Official/公共Native待验的阶段状态。
