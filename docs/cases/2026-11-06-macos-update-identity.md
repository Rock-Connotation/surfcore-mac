# macOS 安装身份与 pending 绑定（WP5，2026-11-06）

## 现象与根因

启动时恢复旧更新只依赖 pending 的自报目标，源码、fork 与包管理安装并存时可能向错误安装执行旧任务。原测试从工作树启动助手，目标却指向临时目录，无法证明助手自身安装与目标绑定。

## 完整逻辑

1. **链路**：显式源码初始化脚本核验 Git 根、origin 和 HEAD，写 `.surfcore-install.json`；更新服务排队时读取目标身份与实际 `package.json` 版本。Host 恢复任务时传可信安装根和 Node 描述符；助手根据自身脚本路径重新确定安装根，再校验后才复制或合并。读者包括更新服务和助手；包构建身份由主会话接线。
2. **机制**：canonical 目标、来源仓库、安装种类、更新所有者和实际版本必须一致；包管理器所有的安装拒绝自更新。旧 pending 缺字段或不匹配时写带 code/error/hint 的 `.failed`，原任务保留，防止自动重试覆盖；显式初始化不会覆盖已有身份。
3. **爆炸半径**：每个恢复助手最多影响一个目标目录，错误有提示；不修改真实 profile、账号或资金。助手复制规则保留配置、角色及目标独有文件，并排除安装根 roles/model/models/perception 用户资产；同名产品目录如 src/perception 仍更新。
4. **取舍**：只核对路径改动小但不能区分来源/所有权；只核对来源不能排除同源多安装。选路径和身份组合，需显式初始化旧源码安装，但可在失败时安全暂停；回滚成本是恢复原更新代码、保留身份与 pending 供后续检查。
5. **生效与重启**：更新服务和助手的代码在宿主下一次加载后生效；本次没有安装、重启 DSH 或更改真实用户数据。
6. **验证**：`node scripts/test-install-identity.mjs`、`node scripts/test-update-apply-result.mjs`、插件 `test-update-helper-env.mjs` 和 `test-updates.mjs` 均 exit 0；插件 `npm test` exit 0，`npm run test:audit` 144/144 exit 0。真实助手在隔离副本中覆盖并保留配置、角色、同名模型和新增数据；先运行碰撞夹具时 roles、models、model、perception 四项失败，修复后专项 exit 0；Windows robocopy 仅验证源/目标根的完整路径参数，未实机执行。跨安装、来源、所有者、版本不符均拒绝并保留 pending。恢复使用注入的独立假运行时，验证参数和环境；无身份旧任务、托管包和跨安装恢复均暂停。`node --check` 与 `git diff --check` 通过。
7. **回滚与残余**：改动前文件备份在本工作树 `_backups/20261106-identity-tests/` 与此前 `ignored_backups/2026-11-06-update-identity-before-repair/`；回退前先保护后续修改，按文件恢复，不删除用户数据。尚未完成主会话组合、真实 DSH 重启/升级及 Windows 实机、迁移回滚演练。此前完整门禁早于本次根目录保护修复，组合后需重跑。

## 发布交接块

```text
改了哪些文件：src/install-identity.js、scripts/initialize-install-identity.mjs、plugins/surfcore/lib/updates.js、scripts/apply-update.mjs，以及更新与身份测试和本 case
测过什么、结果如何：身份/真实隔离助手 focused 测试通过；插件 npm test exit 0；npm run test:audit 144/144；主会话组合后需重新验证
建议 patch 还是 minor：patch；更新恢复安全边界（版本由发布会话决定）
case 文档路径：docs/cases/2026-11-06-macos-update-identity.md
改动层级：安装身份、排队/恢复绑定、助手根目录校验、运行时描述符
完整逻辑与爆炸半径：见本 case“完整逻辑”
失败路径：身份不符写结构化 .failed 并保留 pending，不运行旧任务
还有什么没验证：真实 DSH、Windows、组合制品、迁移回滚；不宣称 WP5 整体完成
接收位置：feat/macos-update-identity；主会话组合后复核
```
