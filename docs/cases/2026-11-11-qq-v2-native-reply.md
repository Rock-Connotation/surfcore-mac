# QQ 桥接运行但红豆不回复：V2 发现契约与 Native 执行装配

## 现象

用户给红豆发消息没有回复，QQ 桥接开关显示开启。2026-11-11 本机认证状态接口返回 `backend=v2`，私聊失败为 `MEMORY_DISCOVERY_INVALID`。OneBot 曾离线后恢复连接，不能把旧断线日志当作本次根因。

## 环境

- macOS / 官方 DeepSeek Harness.app；SurfCore 0.8.8，包安装 desktop profile。
- 独立工作树 `../surfcore-qq-reply-fix`，分支 `fix/qq-reply-discovery`，基线 `748afe6`。
- 主目录开工时有另一会话 A–E 未提交修改；本轮不清理、不回滚、不覆盖这些文件。
- 数据根 `~/.dsh/surfcore`；QQ 配置/桥接状态在 `~/.dsh/surfcore/qq`，两者用途不同。

## 根因

1. `memory-v2-runtime.mjs` 向共享数据根写受保护的 `memory-v2/qq.json`，但 `createQQMemoryBridge` 默认 client 使用 `qq-bridge` scope，读取 `qq-bridge.json`。目录根本身相同，错的是 scope/文件名，不应改数据根或放宽文件权限。
2. `bridge.js` 没有装配可信 Native session safety，默认安全门恒为 false。仅修发现文件，下一步仍会被 `MEMORY_PRESET_UNSAFE` 拒绝。已有 Native Owner/来源账本只是独立组件，并未正式装配到 QQ 生产入口。
3. V2 `/api/status` 提前返回精简对象，丢掉 root、OneBot 与管理状态；插件映射又丢掉 memoryV2 失败，UI 仅据进程存活显示“运行中”。这既隐藏失败，也让所有权检查无法确认该桥接。
4. 旧集成夹具把 Host scope 手动改成 `qq-bridge`，且提供只在夹具内成立的 safety callback，因此覆盖不到真实组合。

## 完整逻辑

1. **链路**：OneBot 入站 → bridge 的持久来源/授权准备 → 受保护 qq scope 的 typed `qqReply` → Host 私有 Native Owner + Core 召回/来源账本/预算 → 私有一次性发送租约 → OneBot 真正 ACK → 原角色回执。模型不接收控制台令牌或私有 RPC 能力。
2. **机制**：发现文件必须与发行方同 scope；生产 Native Owner 必须拥有真实 session、固定工具面、实际模型请求和完整 finish 证明。HTTP 200 仅表示传输成功，不能替代业务成功或 QQ 消息回执。
3. **爆炸半径**：桥接和 Host 两进程、消息入口与管理 UI 两类读者，原静默失败按 2×2×3=12 估算；影响 V2 群/私聊的文本回复。不改用户历史、密钥、额度或白名单，不新增合成；实际模型调用仍计入既有预算。
4. **取舍**：A 只修 scope，成本最低但仍必然被下一道安全门拒绝，不能完成修复。B 复用已有 Native Owner/Source Runtime 正式接线，新增有限的私有组合和传输，复杂度高于一行修复但能消除完整根因，采用。恒真 safety/通用会话回退/V1 自动降级都不满足既有安全契约。
5. **生效与重启**：桥接读取 `bridge.js`/QQ 工厂，Host 读取插件组合与 API；两者均需加载新程序。管理页需刷新模块。普通配置保存不能使旧 Node/Host 的代码热更新。实际生效状态见下方运行验收记录。
6. **验证**：生产 writer + 生产 QQ 工厂的回归先红 `MEMORY_DISCOVERY_INVALID`，再绿。新 Host 组合测试覆盖完整文本一次、无 finish/截断零发送、未知发送零重试、角色漂移、超时和退役。实际已安装 SDK + 真 Core + 私有桥接组合，3 次假模型调用/45 fake tokens、1 次假 QQ ACK、0 外网，正式 Native Host 生成路径通过。
7. **回滚与残余**：旧程序与新制品保存在仓库外任务备份目录；只回装程序并重新加载两进程，禁止恢复旧聊天/凭据/额度账本。V2 保持当前选择；Native 文本回复固定无通用本地工具，未把未验证工具开放给模型。真实 QQ/模型与原生页面验收须独立记录，不能用 fixture 冒充。

## 修法

- QQ 工厂明确 `scope: qq`；通用 MemoryClient 默认不变。
- V2 正式走 Host Native 作业，不再调用通用 `sessions.prompt`；遗留会话先清退、历史保留。
- 私有 Native RPC 拒绝 agent 请求，校验控制台鉴权、回环、Host、Origin、角色 epoch、作业编号、实时登录账号与白名单；一次性租约防止重复发送。
- 发送调用与原始回执写入由桥接连续执行。网络未知仍写 `delivery_unknown`，无自动重试；后续 record 只核对原回执。
- 退役保留已提交来源，避免在途新消息被旧作业清掉；完成只确认提交前的未读水位。
- 恢复完整管理状态，映射 `replyReady/replyFailure`；概览显示“回复受阻”、机器码和检查记忆权限入口。
- 完整插件门禁暴露了基线夹具缺陷：repair 夹具未执行 effect 清理，platform-start 夹具重复 import/声明且缺 Host origin。本轮保留隔离断言，修正夹具，不降低门禁。新工作树 Memory V2 kernel 评测先生成同一冻结语料 V1 baseline，不复制历史测量值。

## 验证

- Node 24 `npm run test:audit`：192/192。
- `npm run test:regressions`：17 项通过。
- `test-qq-native-channel.mjs`、生产 Host 组合脚本、桥接真实 VM/HTTP/Kernel 集成通过。
- 官方 Electron `SURFCORE_QQ_SOURCE_NATIVE=1`：实际 SDK/Core/来源账本 + 正式 Reply Host 成功；假模型、假平台，无真实外发。
- 本机制品：tree `266a7753aad0660297f1567bc8cb79ea379368fb`，399 项文件哈希（另含清单自身，共400文件）；官方 App pnpm 离线消费者安装、模块导入及 manifest 核对通过。版本保持 0.8.8，无发布。
- Memory V2 普通脚本 48/48 通过；完整插件 npm test exit 0（含33个插件侧V2脚本）；最终audit再次192/192。
- 证据目录：`../_surfcore-qq-reply-backups-20261111/`；Native 证据在本工作树 `_backups/memory-v2-coordinator/qq-source-runtime-independent/verification.json`。

## 运行验收 / 遗留

2026-11-11 23:00 左右已完成本机程序实装：官方pluginManager原安装请求因全profile依赖重算、访问registry/Git依赖超时；用原requestId查询并官方cancelInstall返回cancelled，原package/lock/cordis四份声明和394项旧程序哈希确认完整恢复。随后仅原子替换SurfCore程序：旧目录保留于 `~/.dsh/_backups/qq-native-reply-20261111T145559Z/program-previous`，新程序399项清单哈希一致、4份受保护配置/账本哈希不变、其他13插件声明不变。

本机包管理来源仍指旧tgz，未来执行profile包管理可能覆盖当前候选；新tgz保留在仓库外任务备份的package-lifecycle目录，需由后续包管理会话收口，不能把临时替换冒充官方安装成功。

额外实时只读核验：旧Host管理状态返回4个候选，但已批准policies为0。因此即使新程序重载成功，仍必须由用户在记忆页对目标QQ渠道及所示精确模型执行“预览→批准”，本轮不会静默创建处理授权。

当前Host/桥接仍在运行旧代码。原生窗口发现未发送草稿，已向用户请求保存后允许重启，未擅自关闭窗口；尚未真实QQ/真实模型验收，不宣称红豆已恢复。

## 可直接转发的发布交接

```text
改动：QQ V2 scope契约、正式Native文本回复组合、私有一次性发送及原角色回执、完整管理状态与可见失败；补回归与修复既有夹具。
验证：audit192/192；协议17项；真实安装SDK+Core+ReplyHost隔离闭环；官方离线包安装导入和399项manifest通过。完整插件exit0（含33插件侧V2）；MemoryV2全套48/48；真实运行结果见本case最终回填。
源码窄复核：未留下已证实P0/P1；失败可见、来源隔离、工具面、租约/unknown和epoch均有针对性验证；真实渠道待验。
建议：patch；不代定版本、不tag、不push、不Release。
case：docs/cases/2026-11-11-qq-v2-native-reply.md。
层级：内部执行/管理状态；V1默认与现有发现安全校验保留，已启用V2不自动降级。
完整逻辑与爆炸半径：见case，2进程/2类读者/原静默影响12。
失败：概览“回复受阻”+code+检查权限入口；缺finish/超时/撤销/漂移不发，未知发送不重发，均有失败断言。
未验证：以case最终运行验收段为准；本轮无公开发布。
```
