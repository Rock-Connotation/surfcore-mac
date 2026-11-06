# macOS 自包含包生命周期阻断（2026-11-06）

## 现象与根因

官方 App 内 pnpm 11 离线安装 tgz 时已添加文件，却返回 `ERR_PNPM_IGNORED_BUILDS`：包构建器把源码仓库 `postinstall` 写入了消费者元数据。此前源码安装用它修复 SnowLuma SDK 发行包的 ESM 相对导入缺少扩展名；包安装不应要求用户批准构建脚本。

## 完整逻辑

1. **链路**：`scripts/build-plugin-package.mjs` 从指定 Git 对象组装包元数据和清单，`npm ci` 在隔离 payload 安装内嵌依赖，随后显式调用 payload 的 `scripts/patch-snowluma-sdk.mjs`；`npm pack` 将依赖打包供官方 App pnpm 离线安装。源仓库的 `postinstall` 保持原样。
2. **机制**：产物 `package.json` 无消费者生命周期入口，shrinkwrap 根节点不再误标 `hasInstallScript`；构建时 `npm ci --ignore-scripts` 禁止隐式生命周期，构建器主动执行 SDK 修补，失败则中止。清单在最终 package.json 和 shrinkwrap 写入之后生成，测试逐项核对哈希。依赖内容不包含在该既有清单中。
3. **爆炸半径**：一份新包 × 一个安装目标；SDK 是嵌入式依赖，改动只影响新制品，不改真实 profile、用户数据、账号或资金。其他依赖的生命周期在构建时不执行，目标功能需结合完整运行时验证。
4. **取舍**：让消费者批准 pnpm build 使安装依赖本机安全配置，也会在默认官方流程失败；构建时固化 SDK 修补可以保持安装无需批准，代价是构建必须显式维护兼容补丁并在依赖变化时验收。选后者；按文件还原构建器可回滚。
5. **生效与重启**：重新构建并安装的新 tgz 生效；源码 checkout postinstall 未改变。本次没有修改或重启真实 DSH profile。
6. **验证**：基于 `3a480c396bd872d1ba96b36aee25bbfa359d8407` 运行 `node scripts/build-plugin-package.mjs --ref 3a480c3 --out _backups/20261106-lifecycle-package-candidate` exit 0，SDK 修补 13 文件。`node scripts/test-plugin-package-lifecycle.mjs --payload _backups/20261106-lifecycle-package-candidate/package --fixture _backups/20261106-lifecycle-offline-fixture-final` exit 0：检验生命周期字段、清单摘要和 SDK 修补；npm pack 后用官方 App 内 pnpm 11.28.5 在全新隔离 store 执行 `add --offline`，退出 0，SurfCore 和 SDK 模块 import 成功。未修改 pnpm 安全配置或批准构建脚本。
7. **回滚与残余**：构建脚本是从主会话当前版本复制后修改；主会话可按明确路径回退，保留新旧制品。Windows、实际 profile、UI 及完整组合门禁待主会话验证；隔离 npm/pnpm 成功不等于真实宿主功能已验收。专项测试使用官方 App 的 macOS 路径，需要该 App 和可供构建的 npm 依赖缓存/网络。

## 发布交接块

```text
改了哪些文件：scripts/build-plugin-package.mjs、scripts/test-plugin-package-lifecycle.mjs、本 case
测过什么、结果如何：指定 Git 提交构建 exit 0；官方 App pnpm 11.28.5 全新隔离 store 离线安装 exit 0；产物模块 import 与清单校验通过
建议 patch 还是 minor：patch；版本由发布会话决定
case 文档路径：docs/cases/2026-11-06-macos-package-lifecycle.md
改动层级：构建期固化 SDK 修补；产物不提供消费者生命周期脚本
完整逻辑与爆炸半径：见本 case
失败路径：构建或显式 SDK 补丁失败中止，禁止以批准 pnpm builds 绕过
还有什么没验证：Windows、真实 App profile、组合后的完整门禁和运行功能
接收位置：主会话按明确路径组合，重新构建并验证
```
