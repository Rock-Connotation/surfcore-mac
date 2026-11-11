# QQ V2 原文接缝：完整 producer 导出、文本分片与私有 Host context

日期：2026-11-11。状态：三个工程边界已独立验收；真实 QQ Source / Native / Bridge 组合尚未完成，未安装。

## 1. 链路

`src/core/memory-v2-qq.js` 的 `prepareReply` 原本只保留渲染文本和初始 manifest，无法向独立 Host 提供全部原始分片。新增私有 `exportNativeSources(key)` 保留已选记录的快照，重读同一批已提交 spool，导出事件与原回执引用。它不增加 HTTP/RPC 或模型工具入口。生产调用者尚未接线。

`plugins/surfcore/lib/qq-v2-source-packet.mjs` 的 `buildQQV2SourcePacket(input = {})` 负责验证并组织这些文本，保留每个来源的 actor 和方向。`memory-v2-runtime.mjs` 允许进程内 `channelMemory('qq')` 提交 sourceFacts、绑定实际引用并经同步网络 callback 准入。旧远程 QQ adapter 与新私有 adapter 的句柄不能互用。

## 2. 机制与失败

导出要求当前 V2 prepared packet、原 issued handle 和相同角色/epoch/路由；等待 Host 验证前后检查 packet 是否被替换或退役。每份 spool 的当前字节长度必须等于 committed cursor，所有事件必须与原 refs 按顺序一一匹配，身份、producer、segment、delivery、分片总数/索引及重组 wholeDigest 都必须一致。缺片、附加事件、篡改、过期和竞态均返回 `ok:false` 与 code/error/hint，不输出部分材料。

文本构造器在读取数据前拒绝 Proxy、getter、非 JSON 对象、符号和循环引用；描述符复制使用普通 JSON 对象，以兼容 Core 的 canonical digest。它校验角色、具体会话、私聊 actor、出站账号、分片与 payloadDigest/ref 对应关系，输出深冻结的 text-only 内容。上限为七份来源、128 个 event refs、2 MiB serialized sources；超限拒绝，不截断。原件、manifest 和 caller-visible 副本互不共享可变对象。

两层都明确返回 `authority:'requires-kernel-binding'`。摘要相符只说明数据自洽；后续可信 Host 仍须用自己捕获的 context 重新绑定 refs、加入实际 Core 召回并逐次验证实际 Native 输入，在 Kernel fence 内发起网络请求。旧远程句柄不能被转移或冒充私有句柄。

## 3. 影响面

已有 QQ Bridge 准备包多保留一份 bounded 元数据快照；导出 API 尚无生产消费者。文本构造器与私有 QQ Host adapter 当前只有隔离测试消费者。没有新增平台发送、真实 provider 调用、生产迁移或用户状态写入；没有 UI 变更。

## 4. 取舍

备选是直接转发 `prepareReply.text`，成本较小，但渲染文本不足以恢复完整分片、actor 和原回执。采用私有原件导出加独立文本构造，成本是多一次有界 spool 读取与后续重新绑定，收益是能够检验完整材料、保持接口职责清晰，也不扩大旧 RPC 权限。

私有 adapter 只在新 capture 时刷新 QQ 登录态、白名单和路由。已签发 handle 的准入不会重新读取外部 QQ 状态；捕获之后的鲜活身份/世代变化必须由后续 Source / Host 组合显式退役和阻断，不能把本阶段当作该闭环已完成。

## 5. 生效与重启

未安装、未重启桌面 Host，V1 默认不变。最终组合及门禁通过后，才执行已授权的 macOS DeepSeek Harness.app 桌面插件安装。生产迁移和正式切换仍须具体预览确认。

## 6. 验证

Node24 定向命令与预期：

- `node plugins/surfcore/scripts/test-memory-v2-qq-host-context.mjs`：实际 Worker、两个明确批准 group、manifest 与 fence callback 正例；跨 adapter/RPC 句柄、身份/白名单/私聊/路由、撤权/角色/取消/过期负例通过。另跑既有 Runtime 与 Host 安全组，均通过。
- `node plugins/surfcore/scripts/test-memory-v2-qq-source-packet.mjs`：完整 UTF-8 多分片、多 actor、私聊隔离、篡改/乱序/缺片、未知 delivery 与 getter/Proxy 负例通过。
- `node scripts/test-memory-v2-qq-native-source-export.mjs`：合成 spool 与假 Host client，通过完整导出、wholeDigest、竞态、上限与副本隔离；直接使用真实文本构造器验证兼容性。
- 既有 `scripts/test-memory-v2-qq.mjs` 经只替换最后临时目录清理语句的只读 loader 运行通过；原文件 SHA 不变，临时 fixture 保留。首次 loader 错把 finally 整行替换，出现 `Unexpected end of input`，修正为只替换清理语句后通过。这是验收夹具错误，不是产品回归，也不应写成未变换的原命令通过。

证据：`_backups/memory-v2-coordinator/qq-host-context-independent/verification.json`、`qq-source-packet/green-hardened.log`、`qq-source-export-independent/verification.json`。最终文件 SHA 与测试结果留在各目录。该组没有实际 QQ 或来源 ACL / Native 全链路正例。

## 7. 回滚与残余

Core 导出前版本在 `_backups/memory-v2-qq-native-source-export/before/memory-v2-qq.js`；文本包 hardening 前快照在 `_backups/memory-v2-coordinator/qq-source-packet/`。回滚应按本组文件恢复，不能覆盖继承的其它未提交工作。私有 adapter、构造器、导出可分组移除，生产 V1 不受影响。

仍待：鲜活身份世代、实际 Native 完整输入/工具账本、真实 Core 召回、Source 来源与 ACL、Bridge 路由及发送联合。阶段通过不代表 Memory V2 可安装或发布。

## 可转发的发布交接块

- 批次：2026-11-11 QQ 私有 context 与原件导出；未提交，工程阶段，不可发布。
- 改动：完整 producer 分片/原 refs 私有导出；actor 保真的只读文本包；独立 QQ Host context 的绑定与 fence 能力。
- 验证：定向普通/实际 Worker 通过；旧 QQ 回归以清理保留 loader 通过；无真实 QQ、外网 provider 或生产切换。
- 生效：尚未安装，V1 默认；后续全链路验收后安装桌面插件，生产迁移/正式启用另行预览确认。
- 残余：实际 Source、Core 召回、Native/Bridge 与身份世代闭环尚未完成。
