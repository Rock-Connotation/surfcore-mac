# Bili V2 托管动态 worker 的固定意图与完整回执

状态：共享接缝及隔离验收通过；尚未安装到公共 DSH，Bili V2 生产装配仍未完成。

## 现象与根因

普通 native 工具 fixture 使用简化命令，未覆盖真实 dynamic CLI 的账户、动作编号、签名和回执约束。实际 worker 会要求 `--expected-mid`，拒绝带冒号的动作编号；又会自行附加 WBI query 和 Cookie 头，与 Host 固定 endpoint、私有凭据契约冲突。Host 的成功回执白名单还缺少官方 `dyn_id_str`，即使发送成功也会在下游失去确认 ID。

## 完整逻辑

1. 链路：`bili-v2-source-runtime.mjs` 验证官方身份及 sourceStamp 后把已有私有 accountMid 返回同一 Host 内的 B runtime；`bili-v2-agent.mjs` 给固定 dynamic 子进程传预计账号与稳定动作 ID；真实 CLI 通过 `bili-v2-dispatch.mjs` IPC 提交固定写入意图，Host transport 回传的官方 ID 经白名单再进入原命令的回执事务。模型输出与写回执仍走 derived 分支，不能作为 observed root。
2. 机制：来源私有 state 的 accountMid 已由原身份/角色/epoch/账户/会话/route 证明绑定。新增的是成功返回元数据，不接受 job 声明替代身份。托管路径不自行预签、不转发 Cookie；Host 负责 CSRF/WBI/最终凭据，worker 原有身份、互动、额度、凭据变化和重复动作闸保留。源码的请求身份、prepared.config、完整 history/tools、nonce 和祖先引用判据未改。
3. 爆炸半径：Host B runtime 与固定 dynamic worker 两类进程；来源消费者仅同一私有 runtime。unmanaged V1 保留原签名和头。测试仅使用临时 DSH_HOME、合成凭据、fake provider/transport，外部平台写入为零。
4. 取舍：放宽 dispatcher 接受任意 query/凭据头会扩大边界，故不选；统一让 unmanaged V1 也改用新 Host 则增加迁移与回滚成本。采用托管模式的固定意图分支，并传递已经验证的私有预计账号，改动与责任保持局部。
5. 生效与重启：源文件只在新 B runtime/worker 加载时读取。本轮没有安装或重启公共 DSH；以后经独立授权安装后，新建 runtime/轮次生效，旧会话仍需按实际退休屏障处理。
6. 验证：先用真实 fork+IPC 命令复现 `BILI_DYNAMIC_UNKNOWN`，修复后固定 endpoint/无凭据头/重复 ID/账号不符/互动关闭通过。Host 回执回归先出现 `undefined` 而非 `1234567890123456789`，补齐官方 ID 后通过。既有 dynamic receipt CLI 全套通过，source 普通拒绝 28 项保留。独立真实 Host typed tool fixture 36 场景通过，但其中 isolatedRoot 明确 fakeSourceValidatorOnly；完整来源 native 另跑且通过 2 providerCalls、2 sourceCount、30 tokens、usage 后撤销阻断、无 derivedPersisted、无外部请求/平台写入。普通运行时为 34 场景。命令与日志见下。
7. 回滚与残余：修改前副本在 `_backups/memory-v2-coordinator/bili-worker-seam-20261110/`，按文件恢复会回到原接缝，不能视为可启用状态。official transport 第三轮凭据快照仍待独立复核；生产 index/完整 hydration、comment/DM 真实命令接口、today 的真实读取来源、QQ/Douyin、退休/importer/切换和联合门禁均未因此完成。V1 继续默认。

## 失败与下一步

身份缺失在 Host 以 `BILI_V2_IDENTITY_UNPROVEN` 拒绝，提示恢复 source-owned 官方身份；真实 CLI 账号变化仍为 `BILI_DYNAMIC_IDENTITY_CHANGED`。发起后未知回执仍为未知，保留原 actionId 并核查，不能自动重发。失败测试断言 code/error/hint，未把拒绝当验收成功。

## 验收命令与证据

- `node plugins/surfcore/scripts/test-memory-v2-bili-worker.mjs`：真实 fork+IPC，合成官方 transport。
- `node plugins/surfcore/scripts/test-bili-dynamic-receipt.mjs`：既有 unmanaged CLI 保护和回执事务。
- `node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs`：34 普通场景；实际 Host 需显式 `SURFCORE_BILI_ACTUAL_HOST_FIXTURE=1 SURFCORE_BILI_ISOLATED_ROOT_FIXTURE=1 ELECTRON_RUN_AS_NODE=1`，用已安装 Electron `--expose-internals` 运行，36 场景。
- `SURFCORE_BILI_SOURCES_NATIVE=1 ELECTRON_RUN_AS_NODE=1 <Electron> --expose-internals plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs`：独立完整来源验收；不消耗子代理的 native 配额。
- 日志：`_backups/memory-v2-coordinator/bili-worker-seam-20261110/{red.log,receipt-red.log,green-*.log,receipt-green.log,receipt-native-green.log,source-native-independent.log,verification.json}`。源码语法和 whitespace 检查单独记录；最终 audit/regressions/插件门禁待实现冻结后执行。

## 可直接转交发布会话的交接块

- 改动：Bili 托管动态只提交固定意图；来源已验证账号传入 CLI，稳定动作编号通过原校验；Host 保留官方 dyn_id_str。
- 文件：source runtime、B runtime、dynamic 命令；新增真实 worker 回归及扩展 B runtime 回执回归。dispatcher ACL 与来源证明判据未放宽。
- 验证：34普通/36实际Host工具场景、28来源拒绝和完整 native 2 calls/2 sources/30 tokens；工具 fixture 的 fake source 与完整证明分开记录。
- 失败：身份/互动/重复动作继续拒绝，未知发送结果保留动作 ID，不自动重试。仍需完成生产组合器与其余 P0–P4，再做联合门禁。
- 版本/提交/安装：本增量未改版本、未提交、未发布、未安装到公共 DSH。总体 Memory V2 属功能变更，版本和发布授权另议。案例即本文。
