# macOS 更新器基线修复（2026-11-06）

## 现象

`npm test --prefix plugins/surfcore` 在 `scripts/test-updates.mjs:64` 因 `r.changelog` 为 `undefined` 中止；未修改基线同样复现。

## 根因与链路

`plugins/surfcore/lib/updates.js` 自动模式先比较 `path.resolve(git top)` 与 `path.resolve(dir)`。macOS 临时目录传入 `/var/folders/...`，Git 返回 `/private/var/folders/...`；字符串比较失败后错误降级为“目录在别的 git 仓库”，结果没有 `branch/behind/changelog`，测试第 64 行暴露该错误产品结果。更新链路是 `inspectComponent` → `inspectGitComponent` → `git fetch/rev-list/log`，结果被 UI/服务层读取。

## 完整逻辑

- **机制/影响**：仓库根比较必须用物理路径；此缺陷阻断 macOS 更新检查，但不触碰用户数据、密钥或费用（1 个检查进程及其读者，报错 1 分）。
- **取舍**：A 只改测试路径，无法修复真实用户的 `/var` 别名；B 产品比较使用 `fs.realpathSync`，覆盖真实与测试路径且只改一处，选 B。
- **生效/重启**：下次加载 `updates.js` 生效；运行中的宿主需按既有方式重载插件，本次未重启。

- **验证/回滚/残余**：见下两节；运行中的插件须重载才能读取新实现，当前只执行隔离验证。保留原件后按文件回退，不触碰用户配置。

## 修法与回滚

新增 `samePath(a,b)`，优先 `fs.realpathSync`、失败回退绝对路径比较，POSIX 保留大小写；用于自动识别和 git 检查的仓库根判断。回滚可恢复 `_backups/20261106-update-baseline/updates.js.orig`。

## 验证

- `node plugins/surfcore/scripts/test-updates.mjs`：exit 0，更新器回归全通过。
- `npm test --prefix plugins/surfcore`：exit 1；更新器通过，后续既有 `test-update-helper-env.mjs` 在 macOS 的 `node.exe` 断言失败并 exit 4。
- `npm run test:audit`：exit 1，104/143；`js-yaml` 缺失导致 `test-plugin-compat.mjs`、`test-snowluma-channel-gate.mjs` 失败，其他平台/基线失败未改。
- 日志与备份：`_backups/20261106-update-baseline/`。

## 发布交接块

```text
改了哪些文件：plugins/surfcore/lib/updates.js；docs/cases/2026-11-06-macos-updates-baseline.md；docs/cases/README.md；docs/COORDINATION.md
测过什么、结果如何：test-updates exit 0；插件全套被既有 macOS node.exe 断言阻断；test:audit 104/143
建议 patch 还是 minor：patch；仅修 macOS 路径识别
case 文档路径：docs/cases/2026-11-06-macos-updates-baseline.md
改动层级：更新器 git 根路径识别，无 API/业务策略变化
完整逻辑与爆炸半径：见本 case“完整逻辑”
失败路径：既有失败保持可见，无新增运行时失败分支
还有什么没验证：完整 audit 受依赖/平台基线失败影响；未做宿主重启或真实远端操作
接收位置：fix/macos-update-baseline；主会话按明确路径合并，不在本分支发布
```


## 主树组合核验（覆盖上述早期诊断状态）

依赖已正确安装；helperSpawnEnv 同时识别 `/` 与 `\` 分隔符，helper 测试按 import.meta.url 定位脚本。整合真实 POSIX helper 后，主树 `npm test --prefix plugins/surfcore` exit 0；没有 robocopy 测试替身。日志主树 `_backups/20261106-macos-wp0/plugins-combined.log`。最终 audit 待 HEAD 清单同步后执行；早期 104/143 只保留为依赖缺失时的历史记录，不是当前组合结果。
