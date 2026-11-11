# QQ V2 Native owner：保留实际所有权、在调用前拦截并确认卸载

日期：2026-11-11。状态：owner 能力独立验收通过；QQ V2 全链路未完成，尚未安装或正式切换。

## 1. 链路

新模块 `plugins/surfcore/lib/qq-v2-native-owner.mjs` 由可信 Host 构造，复用共享 Native Root 创建实际 agent，保留 session/preset/handle；实际 SDK `llm/stream` 经现有预算中间件和独立来源能力后进入 adapter。现有 `src/core/memory-v2-qq.js` 需要的安全检查尚未与它接线，旧 Bridge 提交路径不因此获得 Native 所有权证明。

## 2. 机制与失败

只有私有 Root 中保留的实际 agent、SDK 请求品牌、原始请求作用域、当前角色/epoch、精确 provider/model、私有 preset、当前工具定义与 schema 同时匹配才允许继续。每次来源准备、验证和实际 dispatch 前重检。预算在 adapter 前保留/准入并记录实际 usage。来源回调必须独立核验全部实际输入；fixture 的 true 不构成 QQ 来源证明。

工具快照同时钉住继承的 execute/render 等执行回调；不合格 tools 列表返回 `QQ_NATIVE_OWNER_INVALID`，角色/Native 检查异常返回固定 `QQ_NATIVE_SESSION_UNSAFE`，均带 code/error/hint。安全谓词返回 false。退役立即封闭准入，再等共享 Root 全部清理确认；失败保留原 Root 重试。

## 3. 影响面

新增 Host 私有能力与隔离测试，目前生产读者为零；实际测试仅独立 Host fixture。未来 QQ 接线会使用共享 Root，因此已另行完成共享退役修复。此次没有真实 QQ 发送、付费 provider 调用或用户状态修改。

## 4. 取舍

远程 session ID/preset/取消 accepted 无法证明实际 agent 所有权及 unload ACK；复用保留 handle 的隔离 Root 可以直接检查和退役。选择后者，成本是后续必须接通真实来源权限、实际输入以及 Bridge 路由，不能把布尔 metadata 当作这些证明。

## 5. 生效与重启

未安装、未重启桌面 Host，V1 保持默认。此模块目前没有生产调用入口，新增文件不自动启用 QQ V2。最终集成和门禁通过后才执行已授权的桌面安装；生产迁移/切换仍需单独预览确认。

## 6. 验证

使用 Node24 执行 `node plugins/surfcore/scripts/test-memory-v2-qq-native-owner.mjs`：16 普通场景通过。再执行同脚本 `--native`：独立实际 SDK 通过，1 次假 provider 调用、15 tokens、1 次来源 gate，2/2 hook 注册/移除，确认实际卸载。负例包含错误角色、错误模型、额外 scoped 工具、来源拒绝、实际预算不足，provider 次数均不增加。

证据：`_backups/memory-v2-coordinator/qq-native-owner-independent/{ordinary.log,native.log,verification.json}`。测试前后最终源文件与脚本 SHA 不变；记录明示 sourceIntegration=false、bridgeIntegration=false。该阶段此前仓库审计176/176与桥接回归通过，新增 owner 又单独复验。

## 7. 回滚与残余

本模块尚未接线，回滚可隔离新增模块/测试/契约；共享 Root 的修复单独保留。原始版本及第二轮前快照在 `_backups/memory-v2-qq-native-owner/`，本次文档备份在独立验收目录。

真实 QQ 来源/附件/历史/多 actor ACL、Bridge 会话与发送路由、跨重启退役屏障和 Core 生命周期联合验收仍未完成。Parent 后续建立可信来源接入点；未完成前继续拒绝 V2 实际推理，不能用 fixture 来源能力上线。

## 可转发的发布交接块

- 批次：2026-11-11 QQ Native owner；未提交，当前工作树阶段，不可单独宣布 Memory V2 完成或发布。
- 改动：实际 Native agent 私有所有权、动态角色/模型/工具检查、真实预算前置 gate 与完整退役。
- 验证：普通16场景；安装中 SDK 隔离假调用1次/15tokens；hook2/2；无外网或平台发送。
- 生效：待全链路完成后安装并重新加载桌面插件；V1 默认，生产切换单独确认。
- 残余：来源、Bridge、ACL、实际发送及恢复仍待联合验收。
