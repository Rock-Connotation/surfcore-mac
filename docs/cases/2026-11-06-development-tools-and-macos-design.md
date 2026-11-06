# 开发工具路由

## 现象与根因

用户要求按本机安装与其他项目高频实践选择适合 SurfCore 的工具。仓库缺少开发侧入口，产品 QQ/B站工具权限不能直接复用为开发工具清单。

## 完整逻辑

1. 链路：AGENTS → DEVELOPMENT-TOOLS.md → 当前工具/skill；docs/README.md 提供人读入口。
2. 机制：按任务触发；本机安装、MCP 配置、会话暴露和实际成功分别判定；历史抽样是线索。
3. 影响：仅开发规则与文档，运行进程改动数 0；无用户数据、凭据和费用策略变更。
4. 取舍：全部放进 AGENTS 易过时且占常驻上下文；本次选简短入口加专项指南，维护与回滚成本低。
5. 生效：后续 Agent 读取即生效，无需重启 DSH。
6. 验证：工具/skill 安装核验及其他项目 12 会话抽样；暂存候选的 Markdown 链接与空白检查。未改运行时，复用本会话原始门禁结果：audit 首轮 136/143；补齐 postinstall 后 SnowLuma 用例 9/9，其余 6 项未解决；插件更新器在未修改基线同样失败。测试日志在 `_backups/20261106-tooling-docs/`。
7. 回滚：编辑前文件有备份；恢复前保留后续修改；新增指南可隔离移出。工具存在不代表对本项目实际调用成功。

## 发布交接块

```text
改了哪些文件：AGENTS.md、docs/README.md、docs/PITFALLS.md、docs/guides/DEVELOPMENT-TOOLS.md、docs/cases/README.md、本 case。
测过什么、结果如何：暂存文档链接和空白检查；运行时门禁结果如上，未全绿。
建议 patch 还是 minor：纯文档，不单独发布、不 bump。
case 文档路径：docs/cases/2026-11-06-development-tools-and-macos-design.md
改动层级：开发指引，无运行时 API 变更。
完整逻辑与爆炸半径：见本 case；运行进程改动数 0。
失败路径：指南明确工具缺失时的替代路线与证据缺口；没有新增运行时分支。
还有什么没验证：工具未逐一对本项目调用；平台适配与门禁修复另行实施。
```
