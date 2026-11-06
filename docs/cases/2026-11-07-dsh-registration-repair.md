# 原生 DSH 注册修复与包边界（2026-11-07）

## 完整逻辑

1. **链路**：设置页 POST `/dsh/repair` → Host 捕获当前安装根、明确 profile 与同一 DSH_HOME → 使用已验证 Node 运行 `scripts/setup-dsh.mjs` → 当前 profile 的三个 MCP 注册。成功后须完全退出重启 DSH。
2. **机制**：`rootPkg` 局部变量仅在版本函数内存在，旧修复处理器访问它导致实际弹窗 `rootPkg is not defined`。改用权威 `QQBOT_ROOT`；明确请求或 `DSH_PROFILE` 优先，缺省仅接受当前 DSH_HOME 内唯一已登记 SurfCore 的 profile。存在包清单但缺失或损坏安装身份时拒绝，避免误走源码安装；包身份路径只验证已安装包与 profile 的实际绑定，备份并原子替换托管 MCP 区块，替换前核对原始字节未被并发修改；不调用安装器、不重写包或依赖/链接。每个 MCP 显式继承该 DSH_HOME；显式旧数据根由已有解析器确认后保留。
3. **影响面**：只有用户触发注册修复时改选定 profile 的 `cordis.patch.yml` 及新增备份；不动 QQ/B站账号、角色、模型、包字节或其他 profile。源码模式沿用原有安装行为；真实 profile 仍需经授权的主线执行。
4. **取舍**：复用旧 setup 改动少但会重生成包资产、改写依赖并调用安装器；包模式只写受控区块成本略高，但可保持 pnpm 包链接和其它 provider。未知区块或区块外托管项拒绝并提示人工核对，避免破坏用户手改配置；如需迁移须针对其实际结构另做安全处理。
5. **生效**：Host 需重新加载包含修复的程序，修复 profile 后完全重启该 DSH；MCP 随该 profile 重载。未操作现有官方 App、进程或真实 profile。
6. **验证**：官方 Node24，临时 HOME/DSH_HOME、禁非回环。`host-red.log` 显示真实 Host 路由 `rootPkg is not defined`、500；`package-red.log` 显示包安装旧路径改写 profile 依赖，`identity-red.log` 显示包清单存在但身份缺失时误走源码流程，均 exit 1。修复后 `identity-green.log` exit 0。Host 夹具验证指定/唯一/歧义/非法 profile 和 Node 命令；实际 package fixture 两次执行验证三 MCP 唯一、原 profile package/链接/全部包文件哈希/六份旧备份/其它配置字节保持，模拟备份 EIO 和并发修改时不覆盖、绑定错误/歧义/混合及区块外直接/嵌套条目安全拒绝、fake dsh install 未调用。源码 checkout 兼容测试在隔离 git-archive 副本、显式 `QQ_BRIDGE_SKIP_DSH_INSTALL=1` 下通过；未加该变量的旧测试因当前安全策略将无 dsh CLI 视为失败而红，日志保留。增量前隔离 audit 161/167、exit 1：清单三个基线哈希不符，另五项媒体用例因测试最小 PATH 缺少运行时工具而失败；最终组合门禁由主线执行。
7. **回滚和残余**：失败前保留原文件；若已成功，先备份当前 patch，再手工从唯一的 `.bak-...` 恢复，重启对应 DSH。旧备份不清理。包模式若发现管理块之外的旧 MCP 或混合用户条目会安全停下；字节检查到 rename 间仍有很短的并发修改窗口；真实 profile 的结构、原生 UI 与安装回读仍由集成方另验。Windows 目录 fsync 不支持分支尚未实测。

## 两条路径

- 包安装：身份与 profile 实际链接通过 → 校验原补丁 → 独占备份及同步 → 原子替换三个 MCP 的托管块 → 完全重启。
- 源码安装：沿用原 `setup-dsh.mjs` 的 preset、链接与安装逻辑；它与包的只修复 MCP 语义不同。

## 发布交接

- **范围**：DSH 修复路由与包安装的最小 MCP 注册修复，不改版本、不发布。
- **验证**：组合 audit、regressions、插件及同源包门禁；用户明确授权后在独立 App profile 进行实际点击、备份和三 MCP 回读。
- **回滚**：保留 profile 全部备份，按上述过程恢复所选 patch；不删除或重链接包及用户数据。
