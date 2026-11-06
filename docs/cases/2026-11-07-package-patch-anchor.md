# 自包含包 QQ 模式入口重复路径（2026-11-07）

## 现象与根因

官方 App 插件详情显示 `qq-mode` 未运行，入口路径包含两次 `plugins/surfcore`。源码 bundle patch 的 `./qq-mode/index.js` 原本相对于 patch 文件有效；自包含包构建器又在 patch 文本里添加一次 `./plugins/surfcore/`，但元数据本已将 patch 本身定位到 `plugins/surfcore/cordis.patch.yml`。官方加载器以 patch 所在目录解析相对名称，因此路径重复。

## 完整逻辑

1. **链路**：`scripts/build-plugin-package.mjs` 从指定 Git 对象复制源码并改写包根元数据；`dsh.bundle.patch` 指向包内 `plugins/surfcore/cordis.patch.yml`。官方 DSH `dsh-app-boot` 加载 patch 后，`anchorInsertedPluginNames` 用 patch 文件目录定位每个插入项的相对 `name`；`qq-mode` 独立模块负责提供 QQ 设置命名空间。
2. **机制**：构建器不应将包根相对路径再写入 patch 内部。现删除仅有的 patch 文本改写，源码 patch 字节原样复制；元数据 `main`、`exports`、`dsh` 的包根前缀逻辑和消费者无生命周期策略保留。
3. **爆炸半径**：一个 bundle 安装的 `qq-mode` Loader 行；旧包该行无法加载，其余三行可运行；本修复不读取或迁移 QQ 账号、角色、配置或数据。
4. **取舍**：保留 patch 位置并移除重复改写只改构建器一处、成本和回滚小；把 patch 移到包根还需改声明、其他路径及清单，风险更高。采用前者。
5. **生效与重启**：必须从合入后的源提交重新构建制品并在独立官方 App 安装、重载，再读回四组件状态；本次没有改真实 profile 或重启 App。
6. **验证**：官方 App Node 24.21.0 下运行 `scripts/test-package-patch-anchor.mjs`。旧构建器对 `425f837` 的隔离构建红测 exit 1，官方 App 中提取的锚定函数得到 `.../plugins/surfcore/plugins/surfcore/qq-mode/index.js`；删除改写后 exit 0，解析为唯一正确入口，源码 patch 字节一致、嵌套 group 相同锚定、旧前缀变异在同一断言下失败，其他元数据路径与全部 bundle patch 存在、消费者生命周期为空。测试以临时 no-op npm 替代依赖安装，未连网。非 macOS 或无官方 App 时仅用标明的可移植锚定参考，不能当作官方实机证明。
7. **回滚与残余**：旧构建器副本和红绿日志在 `_backups/20261107-package-anchor/`；保留新旧制品后可按文件恢复。测试没有运行实际插件、完整打包/安装或真实 App，组件运行状态、完整 audit/regressions/plugin 与正式制品验证待主会话组合完成。

## 发布交接块

```text
改了哪些文件：scripts/build-plugin-package.mjs、scripts/test-package-patch-anchor.mjs、本 case
测过什么、结果如何：官方 Node24 下原构建红测 exit 1、修复后离线锚定及变异测试 exit 0；组合门禁与实际App待主会话
建议 patch 还是 minor：patch；版本由发布会话决定
case 文档路径：docs/cases/2026-11-07-package-patch-anchor.md
改动层级：自包含包 bundle patch 路径，保留包元数据与消费者生命周期策略
完整逻辑与爆炸半径：见本 case
失败路径：路径不匹配、源字节漂移、旧前缀变异或 metadata 缺文件均使专项失败
还有什么没验证：完整制品构建安装、官方 App 四组件状态、Windows实机及组合门禁
接收位置：fix/qq-package-anchor；主会话组合后复验
```
