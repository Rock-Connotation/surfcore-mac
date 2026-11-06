# 开发工具与 skills 调用指南

本指南供维护 SurfCore 的开发 Agent 使用。适用范围是 Node.js ESM 桥接、DSH 插件、控制台、B 站、语音/桌宠，以及已获授权的 macOS 适配工作。
它不改变 QQ/B站运行时 Agent 的工具白名单；产品运行时工具见 [AGENT-TOOLS-AND-PRESETS.md](AGENT-TOOLS-AND-PRESETS.md)。

## 从任务选工具

先完成 [AGENTS.md](../../AGENTS.md) §0 的固定开工顺序，再按下表取当前任务需要的工具。已知路径的小改动直接读文件；只有独立子任务的收益明确时才委派。

| 任务触发 | 工具与调用位置 | 应得到的证据 / 不可用时的下一步 |
| --- | --- | --- |
| 不知道实现位置、要追跨文件调用链 | 若当前会话提供 `codebase-memory-mcp`，先检查索引，未索引则对当前工作树执行 `index_repository`；用 `search_graph` / `trace_path` / `get_code_snippet` / `query_graph` / `search_code` 定位 | 命中回到当前源码核实；服务未挂载时使用 `rg --files`、`rg -n` 和定向读取，明确检索覆盖 |
| 要查符号定义、读者或调用者 | 若提供 Serena，绑定当前工作树后使用其符号/引用查询；具体工具名以本会话发现结果为准 | 定义、调用点与影响面；没有 Serena 就按导出名和引用字面量搜索，不为单次检索安装服务 |
| 编辑代码或文档、运行测试 | `exec_command` / `functions.exec` 执行仓库命令；`apply_patch` 修改；长任务通过会话 ID 读取输出 | 修改前备份；明确写集合；保存退出码与失败摘要。工具命名随宿主变化，以实际提供的接口为准 |
| 使用第三方库、SDK 或 CLI 的当前接口 | Context7：先 `resolve_library_id`，再 `query_docs`，指定仓库锁定版本；不足时读官方文档或安装包源码 | 来源与适用版本；DSH 私有/预发布接口以实际宿主包为准，不能用其他版本示例替代 |
| 控制台/插件 Web UI 验收 | 需要用户真实 Chrome 与登录态时用 `huashu-chrome`；支持目标服务的连接器足够时优先连接器；隔离 fixture 自动回归用仓库 Playwright 脚本 | 实际点击 → 新快照/截图 → 状态或数值回读；fixture 与真实宿主验收分别记录 |
| DSH/macOS 原生窗口、授权弹窗、桌宠 | 当前可用的 Computer Use / `cua_repl`；或按 `huashu-mac-use` 技能操作 | 每次状态变化后重新读窗口；跨 Space、遮挡或权限阻塞时停在该动作，给出最小人工步骤 |
| DSH 插件加载、模型路由、协议兼容故障 | `agent-tool-diagnosis`；先读受影响日志、宿主/插件版本和已脱敏配置结构，再做最小复现 | 区分目录可见、插件运行、实际模型请求与路由成功；涉及调用费用/外发时沿用用户授权范围 |
| 查看 GitHub 问题或远端状态 | 有相应能力时用 GitHub 连接器；不足时用本机 `gh` / `git` | 当前仓库、分支与远端对象；PR、评论、推送、发布依各自授权执行 |
| 音频/视频与 ASR 工作包 | 先查实际 `ffmpeg` / `ffprobe`、Python/uv 与目标 ASR 后端；使用隔离样本做媒体检查 | 可执行路径、架构、完整覆盖与结果文件；仅已安装 FFmpeg 或 Python 不等于 ASR 模型已具备 |

工具缺失时在工作更新中说明缺少什么、采用了哪个替代、还有什么无法证明；不要把“本机装了”“配置声明了”“本会话能调用”“实际调用成功”写成同一状态。
不要为遵守本表而主动打开浏览器、启动 DSH、触发 B站 tick、下载模型或联系外部服务。

## 按意图加载 skills

本机通常从 `~/.agents/skills/<name>/SKILL.md`、`~/.codex/skills/<name>/SKILL.md` 与插件提供的技能目录读取。
先查当前会话技能目录并读入口，再执行流程；只读请求保持只读。`code-review`、`tdd`、`diagnosing-bugs` 按全局覆盖从 `~/.agents/skills/` 读取。

| 任务 | 选用 skill | SurfCore 中的用途 |
| --- | --- | --- |
| 跨会话继续、准备交接 | `project-resume` | 核对 HEAD、当前文件、上次验收与仍缺的证据 |
| 定位具体故障 | `diagnosing-bugs`；宿主/模型问题加 `agent-tool-diagnosis` | 先建立现象、根因与复现，再选修法 |
| 明确要求代码审查 | `code-review` | 固定比较基线，区分已有问题与新增回归 |
| 新增/修改测试 | 先读仓库测试入口；需要测试驱动时用 `tdd` | 本项目 Node fixture 与行为断言优先；不因其他项目高频就套用面向 Spring/Mockito 的测试技能 |
| Web 控制台真实验收 | `huashu-chrome` | 真实用户浏览器、控件交互与回读 |
| 隔离浏览器自动回归 | `playwright` 或 `e2e`，选匹配当前任务的一项 | `preview:console` / `test:console-ui` fixture 与流程回归 |
| macOS 原生应用操作 | `huashu-mac-use` | DSH 窗口、权限与桌宠 UI；遵循所用工具的实时文档 |
| 界面设计/交互改动 | `frontend-design`；动效用 `interaction-design`；无障碍用 `accessibility` | 插件设置页与浏览器控制台，按实际需求分别加载 |
| 文档层级、设计取舍与案例 | `documentation-and-adrs`；面向 Agent 的规则用 `writing-for-agents` | 沿用现有 `docs/guides/`、`docs/cases/` 和索引，不另造重复决策账本 |
| 用户要求提交/推送 | `git-commit`，按当前全局入口覆盖定位 | 中文功能提交、明确暂存路径、检查差异与发布边界 |

SwiftUI/iOS、Java/Spring、云部署、营销、Pets 等技能不会因本机存在而自动参与本项目。
设计稿只有在用户实际提出相应实现任务时，才触发 ASR、平台适配等工具；归档设计本身不触发开发。

## 验证放在改动之后

最低门禁是 `npm run test:audit`；碰协议/桥接加 `npm run test:regressions`；碰插件跑对应 `plugins/surfcore/scripts/test-*.mjs`，并满足仓库交付要求的插件测试。
准确脚本名、依赖版本从当前 `package.json` 与测试入口读取，不在本指南复制一整份命令清单。

- UI 变更按目标验证：离线 fixture 测试不能代替真实 DSH/Chrome。
- `probe:*`、安装注册、服务启停、任何写 `~/.dsh` 或可能发送消息的命令，调用前说明目的、预期与失败后果；运行时串行。
- 默认用隔离 fixture；真实账号动作、配置数据写入与发布沿用仓库授权边界。
- 门禁失败保留命令、退出码、失败位置和下一步；只对本次授权范围内的问题修复。历史失败不能通过删测试或降低断言变绿。
- 收工更新 handoff、case 与协作登记；纯文档不需要重启 DSH。

## 本机盘点与维护

工具/技能安装与会话可用性会变化。2026-11-06 的本机核验及其他项目近期调用抽样见本地 [工具盘点](../research/2026-11-06-development-tools.md)。
该记录按仓库规则不进入公开版本；其他机器没有这份记录时，直接根据当前工具列表、skill 目录与可执行路径核验即可。
频次只帮助选择默认入口，不能替代任务相关性，也不是把其他项目配置复制进 SurfCore 的理由。
