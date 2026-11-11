# Memory V2：真实宿主加载器与完整来源证明联通

## 现象与环境

Memory V2 已有私有 native root 和来源校验，但手写模块映射的夹具不能证明插件生产代码能够经真实 Host loader 获得相同能力。裸包名又会随调用方 baseUrl 解析到错误目录。环境为 macOS、DeepSeek Harness.app 内置 Cordis/LLM SDK；代码位于未提交的 feat/memory-v2 工作树，尚未安装。

## 完整逻辑

1. **链路**：`plugins/surfcore/lib/memory-v2-native-environment.mjs` 经 Host `ctx.loader.import` 导入资源目录中固定的 11 个 SDK 模块，保留真实 `ctx.get('llm').ctx`；`memory-v2-native-root.mjs` 用这些模块构造独立根。来源 native 夹具使用同一加载函数，再连接实际 Memory Worker、AgentLoop、工具和 token budget。
2. **机制**：包名解析依赖 caller baseUrl，固定资源 file URL 消除此不确定性。LLM 服务的 traceable proxy 每次读取可以不同，不能把代理对象直接相等当作 owner 证据；必须核对真实 Context、同宿主 root、实际 prepareCall/stream、保留的 owner 和不同的私有 root。缺导出/错误 root/导入失败均拒绝，不能用 clone 或注入的假能力补齐。
3. **爆炸半径**：一个插件 Host 入口、一个私有 root 消费者，失败显式阻止 V2。夹具另有真实 Memory Worker 和受控命令子进程；无生产 profile/用户数据改写、真实 provider 或平台发送。进程数随夹具阶段不同，不能把单进程模块检查称为完整链路。
4. **取舍**：裸包名导入代码短，但 caller 路径变化会失败；修改 Host baseUrl 会影响其它插件。采用 resourcesPath 派生的固定包路径，成本是明确校验 SDK 导出，收益是复用真实 loader 且不修改 Host baseUrl；移除尚未接线的入口并回装原插件即可撤回。
5. **生效与重启**：当前仅模块和隔离夹具验收；生产 index/Bili Host 接线仍待完成。最终安装应使用 desktop profile，并重启读取该插件的桌面 Host；现在不重启、不改 V1 默认。
6. **验证**：普通 9 组覆盖缺能力、路径、跨 root、导入失败和能力注入拒绝。父端独立真实 native 验证 11 模块、相同 owner、不同私有 root、关闭后 activeHandles/activeTools=0；零 agent/prompt/provider/network。随后来源夹具通过同一 loader：30 个普通用例、2 provider 调用、2 次实际输入准入、2 个来源、1 个提交输出、30 tokens；未知 shell 拒绝、usage 后撤销阻止正文、实际 SessionStore ID 消失及活跃引用归零，`actualEnvironmentLoader:true`。两次 provider 调用均为内存 fake adapter，来源也为受控 fake transport；不冒充真实平台或真实模型验收。
7. **回滚与残余**：原来源夹具备份在 `_backups/memory-v2-coordinator/native-environment-source-joint/`，新加载器原始 RED/GREEN 在 `_backups/memory-v2-native-environment/`。保全后可撤回测试接线/禁用新加载入口；不回滚用户账本。Bili 生产装配、QQ、安全可见报告、真实生命周期及全套门禁未完成。

## 失败路径与可执行验证

加载器失败统一带 `ok:false/code=MEMORY_NATIVE_ROOT_UNSUPPORTED/error/hint`；建议恢复所需桌面 SDK 模块后再启动新作业，禁止回退旧历史。普通测试钉住结构化拒绝。失败进入用户当前页面的最终呈现仍由生产调用方接线验收，不把测试日志当 UI 证明。

```bash
node plugins/surfcore/scripts/test-memory-v2-native-environment.mjs
ELECTRON_RUN_AS_NODE=1 SURFCORE_MEMORY_V2_NATIVE_ENVIRONMENT=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals plugins/surfcore/scripts/test-memory-v2-native-environment.mjs
ELECTRON_RUN_AS_NODE=1 SURFCORE_BILI_SOURCES_NATIVE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals plugins/surfcore/scripts/test-memory-v2-bili-sources.mjs
```

父端证据：`_backups/memory-v2-coordinator/native-environment-independent/{ordinary,native}.log`、`_backups/memory-v2-coordinator/native-environment-source-joint/{ordinary,native}.log`。子代理唯一 native 尝试因代理比较失败，计 1/1；修正版由父端独立执行，没有重分类额度。全仓 audit/regressions 留到冻结后统一执行。

## 可转发发布交接块

- 文件：native-environment 模块/测试/契约、来源 native 测试与本 case。
- 结果：普通 9/30、独立真实 loader/root/close、来源 native 2 calls/2 sources/30 tokens 全通过；无真实外网/付费/平台写入。
- 建议：随 Memory V2 接口级变更整体评估 minor，版本由发布会话决定；不单独发布半接线模块。
- 层级与兼容：内部 Host 能力加载接口；V1 默认保持。完整逻辑/影响面见上文。
- 失败：结构化拒绝已验；最终页面可见性、生产装配、全仓门禁及桌面实装仍待完成。
