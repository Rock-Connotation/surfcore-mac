# Bili V2 Host 组合入口（实施中，尚未生产接线）

## 状态与完整逻辑

1. **链路**：新增 `plugins/surfcore/lib/bili-v2-host.mjs`，入口为 createBiliV2Host，组合现有官方 transport、严格 trigger projector、source runtime、实际 native environment/root、Bili agent runtime。新普通回归为 `plugins/surfcore/scripts/test-memory-v2-bili-host.mjs`。index/scheduler 尚未引用；代码存在不代表生产接入或 native 验收。
2. **机制**：真实 Host 的 agentDefaultModel.currentSelection 与 llm.resolveModelInfo 必须精确一致，再计算 providerRouteId。每次平台状态都重新调用官方 NAV；异步前后验证角色、代次和当前模型。通知先严格投影为目标/selector，不把 text/title/summary 变成原件。pending request 只在实际冻结 job 到达 preparePrompt 时绑定，实际 native signal 再绑定发送，不用共享 currentJob。原生 prepared.config 从实际 owning call 读取；core 只读当前角色 persona.md，并传给实际 private root 和 source runtime。
3. **爆炸半径**：当前仅新增组合模块、回归和本 case，没有启动服务、改真实角色文件或重启桌面。生产接线后涉及 Host/native runtime、Worker、只读/写 worker 三个边界；错绑若静默会影响权限与预算，因此入口按原始 job/route/role/signal 拒绝，保留独立模块原有证明。
4. **取舍**：直接向大型 index 填充组合代码会把来源、权限与生命周期耦合在一起；另建小 facade 可复用已有证明与逐步测试，index 最终只持有回调。未另造 LLM/Worker/授权框架；metadata 仅解析真实选择，不能用 QQ 默认或 companion 固定路由代替。
5. **生效与重启**：尚未接入 index/scheduler、尚未安装桌面 Host，不触发真实运行。最终安装与重启待完整门禁；V1 默认不变，生产迁移/切换另需具体预览确认。
6. **验证**：普通回归 8 场景通过：惰性无写构造、精确解析与鲜活 NAV；foreign metadata；解析期间改模型/角色/关闭；NAV 期间改模型；非法/retired trigger；私有异常不泄漏且结构化报错。全局 fetch 围栏外网 0，只注入假官方 HTTP。缺入口的初始 RED 后，首轮发现 accountMid 被误取为 mid、机器码 scrubber 未允许 V2 中的数字，均按实际接口修复。更有行为 RED 证明 NAV 期间改模型时旧状态会返回 ok:true；补返回前 assertRoute 后 GREEN。native positive 与实际 Worker/预算的工厂联合验证未完成，不能引用先前手工组合的 2/2/30 代替。
7. **回滚与残余**：新增模块尚未被生产导入，保全后撤回引用/新增文件即可；旧文件没有 reset。证据 `_backups/memory-v2-coordinator/bili-host-composition/` 包含 ordinary-red/first/second/green/reviewed 与 nav-route-red/green，修改前版本逐步保全。代码中退役使用单一 in-flight promise，初始化清理失败保留实际对象供明确重试；其实际 native 验证仍待完成。独立 Bagg close 的 2 个 guard/hook 泄漏已另有 RED，等待其当前枚举工单释放文件再修。

## 失败与下一步

所有 facade 失败返回 ok:false/code/error/hint，并回调 onBlocked；自由 provider 异常文本不返回。已测试不存在隐式模型或 V1 fallback。生产当前页面的可见失败呈现、feed/debrief 文字来源接线、Host timer 见证、实际发送/退役与 native 联合门禁仍未完成。本 case 是实施证据，不是交付完成声明。

```bash
node plugins/surfcore/scripts/test-memory-v2-bili-host.mjs
```

预期 6 行 PASS，覆盖 8 个场景；尚不能据此批准生产入口。

## 可转发发布交接块

- 改动：新增 Bili Host 私有组合模块、8 场景回归、本 case，生产入口尚未接线。
- 建议版本：功能层随 Memory V2，由发布会话决定；本会话不 bump/tag/发布。
- 验证：普通回归与 NAV 改模型 RED/GREEN，真实 SDK 工厂/Worker/预算 positive 已通过下述隔离 native 增量，关闭与生产接线待验，发布门禁未跑全。
- 失败：结构化拒绝与不泄漏断言已通过；生产可见呈现待接入。
- 生效：最终桌面插件安装/重启后才可能使用，V1 默认保留。
- 回滚：保全目录如上，尚无生产引用；后续接线回滚只撤 facade 引用，保留用户库与旧 ID 拒绝登记。
- 交接结论：实施中，禁止据本记录宣称 Memory V2 完成或已安装。


## 2026-11-10 22:39 原生工厂增量（局部通过）

1. **链路**：新 `plugins/surfcore/scripts/test-memory-v2-bili-host-native.mjs` 经真实 Cordis 默认模型服务、`createBiliV2Host`、实际 loader/private root/AgentLoop、Memory runtime/Worker 和预算服务；只替换官方 HTTP 与 provider 传输。审批前拒绝且 providerCalls=0，使用实际管理接口批准候选后新作业完成 1 次调用、15 tokens。当前还未接 index/scheduler。
2. **机制**：普通 mock 未暴露 Source runtime 的 `state.job = freeze(clone(job))`。Host 把这个合法内部副本传给要求原对象的 `entryFor`，真实组合在 provider 前返回 `BILI_V2_SESSION_UNBOUND`。新增私有 `sourceRequest` 先核对完整 job 摘要，再用原 retained job 走原有角色/generation/route 和官方 scope 检查；不放宽模型、HTTP 或发送入口。核心 persona 上限同步为 NativeRoot 的 64 KiB。
3. **影响**：新增一个测试进程及其真实 Memory Worker；仅 Host 三个私有来源回调使用该桥接。隔离 `DSH_HOME`、合成配置和凭据；外网 0、平台写入 0、实际 provider/付费 0，不读写常用 profile。
4. **取舍**：删除全局对象身份检查会扩大权限；修改 Source snapshot 则会改变已验的防突变契约。采用限定在私有组件之间的完整摘要校验和原对象重绑，保留公开信任边界，回滚只需撤销局部桥接。
5. **生效**：测试直接加载工作树；桌面 Host 尚未安装/重启。生产路由仍 V1 默认。夹具直接在隔离库预置 `activeBackend=v2, shadowEnabled=1`，只模拟已激活环境，`productionActivationVerified=false`，不算迁移或正式激活通过。
6. **验证**：`native-third.log` 为真实绑定 RED；`ordinary-source-binding.log` 为 Node24 的 8 场景 GREEN；`native-source-binding.log` 为真实 SDK 工厂 GREEN：providerCalls=1、tokens=15、activeJobs=0、activeSources=0、externalNetwork=[]、platformWrites=0。统一收据 `_backups/memory-v2-coordinator/bili-host-composition/factory-native-verification.json`。Node24 普通命令保持原验法。native 必须用已安装 Electron 的 `--expose-internals`，显式 `ELECTRON_RUN_AS_NODE=1 SURFCORE_BILI_HOST_NATIVE=1`，且 `DSH_HOME` 指向本证据目录内新建的 `bili-host-native-<uuid>`；无此隔离条件脚本直接拒绝。
7. **回滚与残余**：桥接前字节快照与 `source-binding-review.diff` 在同一证据目录。关闭订阅/失败重试正在 HY4-BILI-CLOSE run1；视频 helper 尚待独立验收；feed/debrief、生产接线、角色生命周期和最终门禁尚未完成。不得把本次局部 native 通过宣称整个 Host 或 Memory V2 已完成。

### 本增量可转发交接块

- 改动：Host 私有来源 job 副本全字段校验后重绑原对象；persona 64 KiB；新增真实工厂 native 夹具。
- 验证：ordinary 8 场景 GREEN；实际 SDK/Memory Worker/预算 1 call/15 tokens，作业和来源 0，外网/平台写入 0。
- 限制：隔离库为测试预置激活状态，生产迁移激活未验证；关闭修复和生产接线仍待，未安装/提交/发布。
- 生效及回滚：最终 desktop 插件安装重启后才可能生效；局部字节快照可撤桥接，保留用户库与 managed-session 拒绝登记。


### 22:54 原生64KiB边界复验

真实Host工厂夹具新增超限分支已运行GREEN：65537字节核心人设返回BILI_V2_CORE_UNPROVEN、hint非空，providerCalls=0/activeJobs=0；恢复隔离核心文件后，审批前拒绝、审批后真实Memory Worker/预算的模拟provider 1call/15tokens、job/source0仍通过。证据native-core-boundary.log与native-core-boundary-verification.json；运行前后Bagg SHA相同，未读到子代理中间版本。本次不接受关闭修复，仍等HY4-BILI-CLOSE交回后独立审查/联合复验；生产预置激活限制不变。


### 2026-11-11 01:45 Host装配与VIDEO-SOURCE独立接受（总目标未完成）

PUBLIC-SET run2已接受：Node24 41例、独立7个descriptor/Proxy拒绝且回调0、Runtime实际Worker两成员/一输出仍绿。VIDEO-SOURCE run1已接受：production SHA 7d269ce119b1cbce60938dcad1bcecd4f1b981dad9124b67082ff8131d974f49，Source39/triggers/DM10及实际安装SDK既有来源2fakecalls/30tokens回归通过；未知shell拒绝、晚撤权阻断，job/handles/tools0，无外网/发送。record严格10键，sourceSelector在read身份请求顶层展开，prompt/live/send无selector。Host已接index/Runtime/scheduler/现有gate事件，接收观察真实工厂2fakecalls/30tokens；L2失败可见且不泄漏provider正文。旧单轮selected/explicit V2在读旧记忆前明确拒绝，正向托管仍未完成。详见 docs/cases/2026-11-11-memory-bili-host-wiring.md；证据 _backups/memory-v2-coordinator/bili-host-public-read/、bili-video-source-independent/。纯fixture预置V2，productionActivationVerified=false，生产V1默认且未安装。

在办：78d578a2 HY4-BILI-OFFICIAL-PUBLIC-READ run1/3（transport/test/contract三文件）；2524f6ab HY4-BILI-MANUAL-ROUND-FACTS run1/3只读查正向单轮/角色账号退休接缝，仅report.md可写。其后需公共视频Host完整普通/native联合、QQ native/send、实际生命周期、稳定源/importer/tail delta/生产迁移预览、总门禁、确认中文分组提交/dev合并保全清树/desktop安装。保留早期阶段记录作历史，本段覆盖其“helper/VIDEO-SOURCE尚待”状态。
