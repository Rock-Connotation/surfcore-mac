# QQ 模型选择失败后阻止投递（2026-11-07）

## 完整逻辑

1. **链路**：QQ 入站或后台唤醒通过 `ensureSession` 复用/创建 DSH 会话，`ensureChatModel` 调用 DSH `selectModel`，成功后才应提交 prompt。模型状态由 QQ 桥接写入本地 model-status，控制台可读取。
2. **机制**：原代码对已有会话只处理 not-found、新会话忽略选择返回值；选择失败仍会向未知实际模型提交 prompt。现在失败阻断新旧会话投递，返回 `MODEL_APPLY_FAILED`、error、hint；常规 QQ 消息获可行动提示，后台结果与状态保留失败。`dsh.allowModelFallback=false` 禁止模型不可用时改选目录中其他模型；缓存键包含该策略，切换时重新选择。缺省沿用旧兼容，不改变默认模型跟随与不支持思考强度时的回退。
3. **影响面**：仅 QQ 桥接的模型选用及失败提示；失败时不调用模型 prompt；不改用户配置、不连接真实 QQ 或模型供应商。模型或账号被配置错误时现在停止而不是继续未知模型。
4. **取舍**：逐个 prompt 调用点检查成本低但易漏唤醒/队列；在会话创建与复用共同的准入点阻断覆盖所有调用方，再由 QQ 消息入口和后台 API 提供提示。保留已建会话可在修复模型后重试，不改变安全 preset 与自动模型兜底的默认行为。
5. **生效**：桥接是独立进程，需集成对应源码或包并重启桥接；Host 设置页使用者还需能看到模型状态失败。未操作官方 App 或用户 profile。
6. **验证**：App 内 Node 二进制，临时 HOME/DSH_HOME 和系统沙箱禁非回环。`scripts/test-audit-bridge.mjs` 在修改前四项（新/旧会话 × 错误响应/异常）均 `1 !== 0`，即错误地发起一个 prompt（`_backups/20261107-qq-model/red-attempt3.log`，exit 1）。追测同一会话先兜底到替代模型再关闭兜底时，`policy-red.log` 显示错误的 `2 !== 1`；纳入缓存策略后的结果见 `policy-green.log`。测试还验证失败代码/提示、真实入站及控制台接口提示、不支持 effort 降级、默认目录兜底及禁止目录兜底。`scripts/test-dsh-model-follow.mjs` 8/8，exit 0。首次误选 App 的 node shell 包装器而 exit 127 的 red.log 保留。
7. **回滚和残余**：备份位于 `_backups/20261107-qq-model/`；若回滚，先停止使用该桥接、备份后恢复受控源码，用户配置与会话数据不删除。离线夹具不证明真实 QQ 接收、DSH 供应商路由或 macOS 运行时可用；旧额度/自动重试及实际外发需要另验。多进程模型配置热切换仍依各自状态读取。

主线修复Astra指出的设置页/控制台丢弃hint：两个实际渲染代码分别先红，补齐后9/9通过（主线_backups/20261107-qq/ui-*.log）。最终checks-2-ui-final的audit164/164、regressions及完整插件均exit0，Astra R2无新增实质P1/P2。

## 两条路径

- 成功：selectModel 成功（或原有兼容回退成功）→ 投递一次 prompt → 原有 QQ 出站闸门。
- 失败：selectModel 失败 → 不投 prompt，状态标记失败并含 hint；QQ 入站反馈错误，后台控制接口返回结构化结果。显式禁用目录兜底时不换其他 provider/model。

## 发布交接

- **范围**：QQ 模型选择失败阻断和可选禁用目录兜底；不修改版本、不发布。
- **验证**：合并后重跑组合 audit、regressions、插件及指定 provider 的真实路由；真实 QQ 对象和供应商费用须按既有授权确认。
- **回滚**：使用隔离备份恢复代码，保留用户配置和数据，重启桥接。


```text
改了哪些文件：src/bridge.js、scripts/audit-bridge-harness.mjs、scripts/test-audit-bridge.mjs、scripts/test-dsh-model-follow.mjs、plugins/surfcore/lib/client.js、public/console.html、本case
测过什么、结果如何：真实bridge VM先红后绿，失败0 prompt；策略热切换缓存红绿；实际UI提示逻辑9/9；最终audit164/164、回归、插件均0，Astra R2无新增实质P1/P2
建议patch还是minor：patch，版本由发布会话决定
case文档路径：docs/cases/2026-11-07-qq-model-selection.md
改动层级：桥接模型准入与错误展示；allowModelFallback缺省兼容
完整逻辑与爆炸半径：见本case七步；模型选择失败不产生推理请求
失败路径：MODEL_APPLY_FAILED/error/hint，QQ及后台接口与两个页面显示修复建议
还有什么没验证：实际QQ/指定供应商路由；旧黑话学习直接选模型的路径未在本轮修复，验收关闭黑话自动研究
```
