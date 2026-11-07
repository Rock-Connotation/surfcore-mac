# 协作登记表（COORDINATION）

> **本表由“协调/发布会话”维护。任何会话开工、收工、换分支、准备合并，都必须更新自己那一行。**
> 规则见 [`docs/guides/MULTI-SESSION-WORKFLOW.md`](guides/MULTI-SESSION-WORKFLOW.md) 与 `AGENTS.md §1.9`。
> 更新时间：2026-11-02 16:08（Asia/Shanghai）

## 0. 当前协调人

**本对话（协调/发布会话）**：负责
- 审阅各会话的提交范围（`git diff --cached --stat` / `git show --stat`）；
- 把功能分支合并进 `dev`（`--no-ff`），合并后重生成清单；
- 发 dev 构建 / 稳定版（**必须用户明确说“发”**）；
- 维护本表与多会话规则。

工作区：`<REPOSITORY_ROOT>`（主工作区，**只用于协调、文档、发布；不接功能开发**）。

## 1. 活跃会话

| 会话 | 工作目录 | 分支 | 负责范围 | 状态 |
| --- | --- | --- | --- | --- |
| **macOS收口 2026-11-07** | `../surfcore-readiness` | `fix/macos-readiness`，基线eca92c1 | Hy4路由根因、Hy3补验、隐私命中核清、抖音来源 | 新一轮进行中：旧账不变；已批准本轮总4次客户端（已用2次保留）/内部重试另计、QQ文本累计最多8；记忆来源修复与静态隐私清理已组合，主Agent负责源码与runtime，独立审查进行中。无发布 |
| **QQ 常驻/审批 2026-11-07** | `../surfcore-qq-resident`；全部独立worker保留 | `feat/qq-resident`，实装0502afa | 手动后台、审批/问答与安全恢复 | 本轮有界验收收口：注册/3MCP、后台私聊、允许/拒绝/文字问答/取消、过期零LLM、完整stop/扫码resume、无debug实际私聊双端及Quit9进程退出后恢复通过。audit169/169及回归/插件0，325文件一致；11/12模型、19/30文本，诊断和QR清场，独立受控实例留开。选项A/24h/睡眠未验，不续额、不发布 |
| **QQ macOS 补齐 2026-11-07** | `../surfcore-macos-implementation`；worker独立qq-model/qq-host/qq-runtime/qq-gateway保留 | `feat/macos-implementation`，程序e013302，文档后续 | QQ传输、原生宿主与模型失败保护/真实私聊 | 受控私聊收口：扫码/包内SDK/官方App/Hy4/QQ回执及用户收到均通过；2/3模型含自动标题、1/6文本；audit164/164、回归/插件0、Astra R2无新增P1/P2；实例/代理/容器/端口全停，数据保留、默认选择恢复，常用App不动；群/问答审批/常驻未验，未发布 |
| **B站自主单轮补验 2026-11-07** | `../surfcore-macos-implementation`；worker独立round/receipts/partial-review保留 | `feat/macos-implementation`，程序744d64a，文档后续 | Host受控单轮、评分/动态失败可见、显式部分续评与真实App | 本轮收口：Hy4真实自主选题及范围临时点评通过、仅一条测试动态匿名读回通过；正式评分/主观记忆/其它外发未验。audit164/164、回归/插件0；3次Hy4，实例/端口关闭，常用App不动；未发布 |
| **macOS 工具与文档整理** | `../surfcore-tooling-docs` | `docs/tooling-macos`（基线 `0deb826`） | 开发工具路由、macOS 设计归档、开发提示词；仅文档 | 文档及提示词完成，按功能分三批本地提交、未推送；audit 首轮 136/143，安装修正后 1 项复测通过、余 6 项；插件更新器基线失败；本地设计另行交接 |
| **macOS 首期实施 2026-11-06** | `../surfcore-macos-implementation` | `feat/macos-implementation`（交接0c51bf2，本克隆无dev） | WP0–WP5，独立数据根，本地提交 | b9已真实官方App/只读扫码/96秒无字幕ASR/人工记忆闭环/角色护栏/退出恢复/包回滚；原App与常用profile不动，无外发或付费模型。新数字全零幻觉补修通过局部与独立审阅，最终47e7e73：audit163/163、回归/插件通过；原生零PCM/241秒/96秒B站复验、Finder隔离启动/关窗与退出完成；实例和端口已关闭、数据保留；设备/质量矩阵未全验，未发布；收工关闭测试调试端口 |
| **协调/发布**（本对话） | `<REPOSITORY_ROOT>` | `dev` | 规则、登记表、合并、发版 | 进行中 |
| **bug 修复** | `<WORKTREE_ROOT>` | `fix/release-0.8.7` @ `e20a464` | 3c99c54..e20a464 的修复 | ✅ 已在 dev 历史内；等新交接 |
| **Minecraft 拓展** | `<WORKTREE_ROOT>` | `feat/minecraft` @ `f3bd46f` | MC 平台适配器/工具集/卡片/记忆 scope | ⏸ 已从 dev 撤回，分支保留；等完成 |
| **向量记忆** | `<WORKTREE_ROOT>` | `feat/vector-memory` @ `9e7e737` | 向量记忆交接书 + docs 索引 | ⏸ 已从 dev 撤回，分支保留；等完成 |
| **更新本地改动修复**（协调代做） | `<WORKTREE_ROOT>` | `fix/update-local-modifications` @ `3a7aaa9` | 本地改动「备份并覆盖」出口 + deterministic + 诊断 | ✅ 已合并 `d75dea8`；**未发布**，等 bug 修复交接 |
| **小红书平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-xiaohongshu` | 只读 adapter/身份/记忆/prompt/卡片 | 🕒 交接已写，待启动 |
| **贴吧平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-tieba` | 先解决内置 `tieba` 占位；只读 adapter | 🕒 交接已写，待启动 |
| **抖音账号/推荐流 2026-11-07** | `../surfcore-douyin`；browser worker独立树 `../surfcore-douyin-browser` | `feat/douyin-channel`，基线320b2d7 | Context7/GitHub调研、独立浏览器扫码、身份核验和真实推荐流只读 | 已启动：用户优先账号登录与推荐流；F2低层feed可参考但无扫码，Download API v5非个人推荐方案。选择独立profile浏览器路径验证；QQ既有受控常驻不动，不沿用其剩余模型预算，无发布 |
| **微信平台**（待启动） | 计划 `<WORKTREE_ROOT>` | 计划 `feat/platform-wechat` | 先确认公众号/个人微信；个人微信不做自动化 | 🕒 交接已写，待启动 |

### 本轮“合并后又撤回”记录（用户要求：未完成，不进下一版）

| 分支 | 原合并 | 撤回提交 | 现状 |
| --- | --- | --- | --- |
| `feat/minecraft` | `961c21a` | `9c31d7b` | 分支 `f3bd46f` 保留；dev 已移除 MC 代码 |
| `feat/vector-memory` | `a52c03a` | `02ca250` | 分支 `9e7e737` 保留；dev 已移除交接书 |
| `fix/release-0.8.7` | 无需合并（`e20a464` 已是 dev 祖先） | — | 保留在 dev |

另：MC 的 UI 原本混在 `4d2d7c3`，本轮用一个单独提交从 `dev` 移除（不 rewrite 历史）。
**MC 完成后再合并时，需要把 UI 作为新提交重新加回**（因为 dev 已删除，分支本身没有新增这段）。

### 本轮已合并、未发布

| 内容 | 合并提交 | 状态 |
| --- | --- | --- |
| 本地改动「备份并覆盖」修复 | `d75dea8` | 已进 dev；`b1e8e7d` 清单/验证；**未发 dev.11**，等 bug 修复会话下次交接 |

当前 `dev`：`b1e8e7d`（干净，126/126，625 files）；最新已发布仍是 **dev.10**；稳定版 `0.8.6`。

## 2. 当前遗留

1. MC 的 handoff `2026-11-02-mc-agent-integration-batch1.md` 已从主工作区移到
   `_backups/2026-11-02-mc-agent-integration-batch1.md`；MC 会话需要的话从那里取，或重新提交。
2. MC 分支 `feat/minecraft` 里仍有 UI 的历史内容，但 dev 已删；合并前要确认 UI 重新加回。
3. 向量记忆只有交接书，等实现时另开 `feat/vector-memory-impl`。
4. bug 修复的新交接还没到；到之前不构建、不发版。

## 3. 各会话接下来要做的

### 3.1 bug 修复会话

- `e20a464` 已在 dev；当前 dev 已回到“只有 bug 修复 + 协调文档”的干净状态；
- 继续修 bug 请从最新 `dev` 切 `fix/<topic>`，在 `surfcore-bugfix` 工作树里跑测试；
- 完成一个可合并单元后，按 §4 发合并请求。

### 3.2 Minecraft 会话

- 你的 `f3bd46f` 还在 `feat/minecraft`，没有丢；但**已从 dev 撤回**；
- 继续在 `surfcore-mc` 工作树完成 preset / 事件泵 / 进程托管；
- 完成并自测后，**把 UI 作为新提交加回**（dev 已移除 `McTab`），再发合并请求；
- 合并前先 `git merge dev` 跟上最新，解决可能冲突。

### 3.3 向量记忆会话

- `9e7e737` 还在 `feat/vector-memory`，没有丢；但**已从 dev 撤回**；
- 等实现阶段另开 `feat/vector-memory-impl`；交接书本身可等实现完成后再一起合。

## 4. 合并请求格式（各会话发给协调会话）

```text
【合并请求】
分支：feat/<topic>
commit：<hash>
范围：<一句话>
改到的文件：<列表>
测试：test:audit <N/N>；插件测试 <0 失败 / 具体>
风险/未验证：<...>
是否已 rebase/merge 最新 dev：<是/否>
```

协调会话收到后：

1. `git show --stat <hash>` 核对范围；
2. 在独立工作树/临时目录跑测试（不污染主工作区）；
3. `git merge --no-ff` 到 `dev`；
4. 从合并后的 HEAD 重生成 `release/install-manifest.json`（单独提交）；
5. 更新本表状态。

## 5. 决策记录

| 时间 | 决策 |
| --- | --- |
| 2026-11-02 14:40 | 确立“一会话一工作树”；主工作区只做协调/发布；禁止 `git add -A`；合并/重启/发版串行 |
| 2026-11-02 14:40 | 已污染的 `4d2d7c3` 不 rewrite 历史，记录在案，后续 MC 补干净提交 |
| 2026-11-02 14:40 | 本对话成为唯一协调/发布会话；各会话通过本表 + 合并请求交接 |
| 2026-11-02 15:05 | 曾合并 vector（a52c03a）与 MC（961c21a）；后按用户“未完成，先不发”撤回 |
| 2026-11-02 15:10 | 撤回两个合并（9c31d7b / 02ca250），并从 dev 移除 4d2d7c3 带来的 MC UI；分支保留，等完成再合 |
| 2026-11-02 15:55 | 修复 dev.10 本地改动卡更新：加「备份并覆盖」出口 + deterministic + 诊断，合并 d75dea8 |
| 2026-11-02 16:08 | 用户要求“先不发”，等 bug 修复会话下次交接再决定 dev.11 |
| 2026-11-03 04:05 | 发布 v0.8.7（0.8.6 以来全部 dev，74 commits / 105 files）；远端 main 90872a7，镜像 f849cc4；归档 678/0；main 已合回 dev |
