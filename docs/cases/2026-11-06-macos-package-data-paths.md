# 包安装的 QQ 配置与状态脱离程序目录

## 现象、环境与根因

包管理器安装的 SurfCore 将可更新或共享的程序文件放在包目录；旧 `paths.js` 和 `src/bridge.js` 把 QQ 配置、状态和 fallback 角色绑定同一目录。设置页保存因此可能写入包目录，程序更新后又可能丢失或读到另一版本。源码安装中这一路径是既有约定，必须保持兼容。

## 完整逻辑

1. **链路**：包身份由 `src/install-identity.js` 验证，`src/qq-data-paths.js` 为插件、桥接和 QQ MCP 提供同一数据路径；插件 `QQ_CONFIG` 供 `store.saveQqConfig()` 原子写入；桥接按共享路径读配置、状态和 fallback 角色。程序、模板、预设仍使用原程序根，角色主链仍在原有 `characters` 目录。其他路径消费者需在最终集成中核对。
2. **机制**：合法 `kind=package` 且无显式旧根时使用 `$DSH_HOME/surfcore/qq/{config.json,state,roles}`，与统一配置 `$DSH_HOME/surfcore/config.json` 分开。源码和经过既有检查的显式旧根沿用原路径；包身份优先于无关 cwd。若包目录已有旧配置或非空状态/角色目录，抛 `QQ_PACKAGE_LEGACY_DATA_FOUND`，消息包含代码和备份、保留旧安装、显式旧根的下一步，不自动迁移。身份无效和检查失败也有代码与提示。
3. **影响面**：Host 设置保存、QQ 桥接、两个 QQ MCP 共享读写路径；错误会造成 QQ 配置或状态不一致。没有主动修改用户文件、登录账号或转移数据。旧包冲突会阻止加载，宿主实际可见性仍需验收。
4. **取舍**：继续把数据写包内实现简单，但包替换会损坏持久性；统一改到独立数据根成本是枚举所有读者与处理旧数据。选择共享解析，源码和显式旧根兼容；不自动搬迁以避免覆盖、丢失或混合不同安装的数据。
5. **生效**：安装集成后的程序并重新加载 DSH，桥接和相关 MCP 子进程重启后使用新路径；本次未运行真实宿主、桥接或账号。
6. **验证**：`node scripts/test-package-data-paths.mjs` 在临时目录使用真实 `store.saveQqConfig/readQqConfig` 保存并以另一份包程序重读，断言 config/state/roles 留存、源码和三种显式根、无关 cwd、旧配置/状态/角色阻断及可行动消息。`node scripts/test-audit-security-mcp.mjs`、`node scripts/test-qq-model-view.mjs`、`node scripts/test-mcp-servers-stdio.mjs` 通过；涉及的 JS 语法与 `git diff --check` 通过。MCP 使用隔离 stdio，未发消息。
7. **回滚与残余**：原改动前文件备份于 `_backups/20261106-package-data/preexisting/`；回滚需先核对集成代码及新数据位置，避免覆盖或孤立新配置。Windows 原生路径与正式应用启动未实测；需要主线整合其它直接读旧路径者并做完整组合审计、真实宿主失败提示和替换验收。

## 可转发发布交接

```text
改动：包安装的 QQ 配置/状态/fallback 角色改用 DSH_HOME/surfcore/qq；程序资产、源码安装及显式旧根兼容。
验证：隔离真实 store 保存/更换程序目录/读取通过；MCP stdio 与定向安全测试通过。完整集成门禁由主线执行。
版本建议：按完整 macOS 交付范围决定，由用户定版本；接口新增共享路径描述，原路径常量保留名称。
失败：发现旧包数据时返回 QQ_PACKAGE_LEGACY_DATA_FOUND，保留原文件并提示备份与显式旧根；实际宿主界面仍需核验。
未验：Windows 实机、真实 DSH 加载/包替换、其余旧路径消费者的整合。
case：docs/cases/2026-11-06-macos-package-data-paths.md。
```

## 包程序根与显式旧数据根的隔离

`kind` 描述数据来源时，包安装加显式旧根会得到 `explicit-legacy`，不能据此判断程序是否为包：否则插件会把旧数据根误当成程序根并启动旧 bridge 或读取旧模板。现另以 `installationKind` 表示已验证的安装类型，包安装固定新包程序根，显式旧根只控制 QQ 数据路径。隔离夹具对三种显式环境变量逐一验证实际插件路径、包身份、新 bridge/模板及旧配置/状态；`node scripts/test-package-data-paths.mjs` 和语法检查通过。未启动真实 bridge 或执行迁移。
