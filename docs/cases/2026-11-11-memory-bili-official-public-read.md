# Bili V2 官方公开来源与双步 Native 读取

日期：2026-11-11。状态：本阶段独立验收通过；Memory V2 总目标、生产切换和桌面安装仍未完成。

## 现象、根因与目标

feed/debrief 曾缺少官方原件接缝；CLI 摘要不能作为完整原件，也不能把一个公开对象的权限自动扩到另一对象。现按当前角色与 epoch、官方账号、精确模型路由及完整来源集合审批，把各原件与输出绑定在同一独立处理空间。新增来源必须重新审批，私信保持隔离。

## 完整逻辑

1. **链路与读者**：桌面 Host 的 `plugins/surfcore/lib/index.js` 提供固定 feed 候选读取，Host 在创建 Native SDK Root 前调用官方 transport 的 `inspectVideos`；官方 NAV 确认账号，view 获取 BV/aid/作者身份。Runtime 产生完整集合候选，Management 提交预览与审批。Source 按每个成员的内部 conversation alias 捕获真实 Worker 上下文、写入原件并绑定真实请求；Agent 的受控读取工具通过 `transport.read`，结果经 Source 进入下一次 Native 请求。Host、Runtime、Management、Source、Agent 是行为读者。
2. **机制与所有权**：集合摘要绑定角色/epoch/账号/模型及规范化完整 selectors。动态输出和每个成员使用集合专属别名，物理 sourceKey、官方 wire 与来源身份保持原样，避免旧单对象策略与新集合策略相交产生歧义。视频 record 为十个既有键，wire 为六个精确元数据键，coverage=text-only。prompt/live/send 不接受读入成员 selector；read 身份请求的 selector 位于顶层，禁止第二个兼容容器入口。工具只读获批成员，读入权不会变成评论写入权。
3. **爆炸半径**：主要为一个桌面 Host 进程及其一个 Memory Worker 线程，涉及五个行为读者；错误显式拒绝，按约定记为 1。隔离 Native 验收使用实际安装 SDK、默认模型服务、Worker 和预算；官方 HTTP 与模型响应均为模拟。生产用户数据、真实账号、付费服务和平台写入未参与。完整媒体、ASR 和下载没有被当成已覆盖。
4. **取舍**：直接复用 CLI 摘要成本低，但原件缺失、会提前记为已选，且无法证明完整身份；继续跨对象通用公开策略会扩大权限并触发多策略歧义。选择固定 locator → 官方文字元数据 → 确切集合独立审批，保留既有 Core 精确检查，增加一条有界接缝与审批成本，回滚只需恢复本阶段模块。feed 候选固定 `--json --no-remember`，审批前不写已选状态。
5. **生效与重启**：模块被桌面 Host 加载，最终安装后需按项目步骤重启插件 Host 并复核；当前没有安装或重启正在使用的桌面应用。V1 仍是生产默认，生产迁移与正式 V2 切换需要各自预览确认。
6. **验证与失败恢复**：下列隔离测试通过。未审批返回 `BILI_V2_PUBLIC_SET_APPROVAL_REQUIRED` 并提示打开记忆卡「身份与权限」、核对完整集合和精确模型；index 已验证把固定错误和下一步送到现有 L2 通知，不泄漏 provider 正文。前置释放失败保留原 handle 与故障，明确退役成功后才能重试；不会自动退回 CLI。Native 原件与工具结果绑定、预算入账、原角色和真实 route 检查均在实际工厂路径中验证。
7. **回滚与残余**：恢复 `_backups/memory-v2-coordinator/bili-official-independent/` 中本阶段备份及子代理原始 transport 备份，保持 V1；不得把合成预激活 fixture 当成生产切换回执。剩余为 Host 凭据/停用/Core 生命周期、正向 V2 手动回合、QQ Native/预算、可信导入/尾增量、完整门禁、提交/dev 合并和桌面安装。

## 验收命令与证据

Node 使用本机 Node24。命令均不访问生产平台：

```sh
node plugins/surfcore/scripts/test-memory-v2-bili-official-public-read.mjs
node plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs
node plugins/surfcore/scripts/test-memory-v2-bili-host.mjs
node plugins/surfcore/scripts/test-memory-v2-runtime.mjs
```

结果：新官方公开读取 11 场景、既有官方 transport 76 场景、完整 Host、真实 Worker Runtime 均通过。76 场景使用已有隔离 loopback 服务，旧测试文件未改。

原生命令需给 `DSH_HOME` 指定新的隔离目录，目录名包含 `bili-host-native`，并使用实际安装的 Electron Node：

```sh
ELECTRON_RUN_AS_NODE=1 SURFCORE_BILI_HOST_NATIVE=1 SURFCORE_BILI_HOST_PUBLIC_NATIVE=1 SURFCORE_BILI_HOST_PUBLIC_KIND=feed DSH_HOME=<新的隔离bili-host-native目录> '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --expose-internals plugins/surfcore/scripts/test-memory-v2-bili-host-native.mjs
```

`PUBLIC_KIND=debrief` 复核单视频场景。feed 为两个不同精确视频，各场景都是 3 次模拟调用、45 tokens，包含一次保留的旧评论路径及两次公开读取步骤。工具回包出现在下一次真实 Native 请求；workerForks/activeJobs/activeSources 均 0，externalNetwork=[]，platformWrites=0。fixture 显式预置 V2：syntheticPreactivatedDatabase=true，productionActivationVerified=false。

完整证据：`_backups/memory-v2-coordinator/bili-official-independent/`，包括普通三项日志、`native-public-final.log`、`native-public-feed-green.log`、`runtime-audience-order.log` 和 `verification.json`。

## 联合验收找到并修复的缺陷

- 前置释放错误地只认 boolean true；真实 Memory adapter 返回 `{ok:true}`。先用真实形状钉住 RED，再接纳同步成功回执，失败仍保留上下文并要求显式退役。
- Host 把受控读方法当成工厂顶层入口；实际入口为 `entry.official.transport.read`。真实 Native 第二步定位后修正。
- Management 将 Core 已排序的 audiences 与来源 selector 顺序直接比较，多视频集合误报 `MEMORY_POLICY_REQUIRED`。现在双方均经同一个 `validatePolicy` 规范化；真实 Worker 增加两视频三上下文审批回归。
- feed fixture 曾断言数字 BV 原文可见，而既有共享隐私规则会隐藏连续数字。只修正证据断言为第二个稳定物理 sourceKey，并验证其工具回包；Core 隐私规则及 Source 生产模块未改。

## 发布交接块（尚不具备整体发布条件）

改了什么：官方 NAV/view 元数据、精确来源集合身份、受控 feed/debrief 读取、Native 两步原件绑定；修复释放回执、读入口和审批排序。
涉及文件：官方 transport 与内部安全 DTO helper、新公开读测试/契约，Host、Management、Runtime 回归、Native fixture，以及本 case 和阶段文档。
验证结果：新 11 / 旧 76 / 完整 Host / Worker Runtime 通过；feed 与 debrief 各 3 模拟调用、45 tokens，CLI/外网/平台写入 0。
版本建议：由发布会话在总目标与三条发布门禁通过后决定；本编辑会话不 bump/tag/push。
完整逻辑与爆炸半径：见上文七项；无生产迁移、付费或外发。
失败路径：L2 固定 code 与可执行下一步、集合审批明确拒绝、未知退役持有原上下文；均有对应断言。
还没验证：实际全局生命周期和 QQ 等总目标、生产迁移/切换、完整门禁及桌面安装。
