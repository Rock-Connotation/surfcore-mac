# 抖音回忆保留完整感受理由

## 现象

- 真实抖音经历已经写入记忆；新角色上下文能显示视频编号，却看不到完整感受理由。
- 复现：新建一次经历后，调用正式 `createCompanionMemory.buildContext()` 查看下一轮上下文。
- 影响面：新写的抖音观看理由可能在卡片渲染时被截掉；已有追加式经历、用户记忆和其他渠道均不需要改写。回滚只需回退程序提交。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS / DSH 0.2.1-rc.5（本轮未启动） |
| SurfCore 版本 | 0.8.8（未改版本号） |
| 安装方式 | 独立 Git 工作树 `feat/companion-recall-detail` |
| 其它相关版本 | 官方 Node v24.21.0 |

## 根因

- 代码位置：`plugins/surfcore/lib/douyin-companion-memory.mjs` 写经历事件；`src/core/experience.js` 追加并校验事件；`plugins/surfcore/lib/memory-card.js` 维护记忆卡；`src/memory-card.js` 渲染记忆；`src/core/context.js` 构造新上下文。
- 问题链条：理由曾拼在 `content.summary` 末尾。入卡后，清楚记录的摘要只渲染 130 字、鲜明记录 200 字；摘要稍长时，理由整体落在截断位置之后。视频编号与发生时间由独立字段渲染，所以仍可见。
- 为什么之前没发现：既有 Host 用例的摘要很短，摘要截断前就包含了理由片段；缺少“长摘要 + 完整有界理由 + 新上下文”的真实生产链回归。

## 完整逻辑（给用户看的那一遍）

1. **链路**：DSH Host 中的抖音陪伴把观看经历交给 `createCompanionMemory.recordMemory()`。它通过 `appendExperienceEvent()` 追加到当前角色的 `experience-inbox.jsonl`。插件记忆维护器读取并验证收件箱，把事件投影到 `memory-card.json`。之后 `buildCharacterContext()` 重新读取卡片，并按当前 audience 调用记忆渲染器。
2. **机制**：摘要负责概括，理由与覆盖信息属于细节。过去把两者拼成一个摘要；渲染器为了控制上下文预算截短摘要，因而丢掉尾部理由。现在理由留在事件 `content.details`，摘要原样单独保存。只有抖音来源、记忆仍为 clear/vivid 且非 private 时，渲染器才在摘要后显示细节；它先经过 `visibleFor()` 的受众过滤。
3. **爆炸半径**：1 个 Host 记忆写入进程 × 5 类上下文读者（抖音、本地、QQ、B站、桌宠）× 静默遗漏系数 3 = 15 分。修复只增加受众准许的抖音/本地上下文细节；QQ、B站、桌宠继续因 `allowedContexts` 不可见。没有读写真实 profile、密钥或模型请求，也没有收费动作。
4. **取舍**：路线 A 使用现有经历事件的 `summary/details` 与记忆卡 renderer，沿用去重、衰减、权限和审计链，改动小且可通过回退一个提交恢复。路线 B 在新上下文中另读原始抖音任务账本，虽能快速拼回理由，却绕过统一卡片的衰减与受众规则，并多维护一套数据源，因此不采用。
5. **生效与重启**：`douyin-companion-memory.mjs` 与 `memory-card.js` 在 DSH Host 插件加载时读取。部署这份程序代码后需重启 DSH Host，再由下一次抖音活动写入和新的角色上下文验证。本轮只跑离线 fixture，没有重启真实 Host。
6. **验证**：新专项先在旧代码下失败，证实真实链路生成的新上下文缺少完整理由；修复后通过两条 300–500 字摘要、两条 240 字理由的离线生产链测试，并确认两条记录的来源编号、ISO 时间、音轨缺口与稀疏画面说明都留在默认 1800 字记忆预算内。专项还断言 QQ/B站/桌宠不见新理由或编号，模糊/私密记录不恢复完整理由。
7. **回滚与残余**：回退本次修复提交即可恢复旧渲染行为；不修改两条既有真实经历，不自动补写其历史原因。上线前仍需由主 Agent 在隔离真实环境完成新一轮抖音活动与新上下文回读；本轮没有实机、真实账号或模型验收。

## 修法

- `recordMemory()` 把 `value.summary` 单独写入 `content.summary`，将最多 240 字理由、音轨完整/缺口状态、1–3 帧稀疏取样数量及未取样范围说明合并为不超过 350 字的 `content.details`。缺帧数或超出 1–3 的值显示“取样帧数未确认”，不夹成一个看似有效的数量。
- `recordLine()` 仅为 clear/vivid 且非 private 的 Douyin 记录显示经过记忆脱敏的细节；不改变 `visibleFor()`、其他渠道的摘要默认值、旧自由文本上下文或统一人格。
- 回滚：`git revert <本次提交 SHA>`；不需迁移或改写已存在的记忆数据。

## 验证

- 新专项：旧实现下失败于“新上下文缺少完整 reason”；修复后 `plugins/surfcore/scripts/test-douyin-companion-recall.mjs` 通过，并覆盖 6 帧无效输入不会被呈现为 3 帧。
- fixture 设置 `DSH_HOME` 和 `USERPROFILE` 后，在子进程中才动态导入角色与记忆模块；全部数据写入 OS 临时目录，无网络、无模型请求、无真实 profile 写入。
- 已验证生产链：`recordMemory()` → 实际 append-only 经历收件箱 → `runMemoryCardMaintenance()` → 全新 `buildContext()`。
- `scripts/test-macos-shared-core.mjs` 22/22；`scripts/test-persona-layers.mjs` 通过；`npm run test:memory-card` 29/29；`npm run test:memory-card-wiring` 通过；既有 Companion Host 专项通过。Host/UI 既有测试文件未改。
- 项目锁文件要求 `js-yaml@^4.3.2`。测试期间仅为本工作树建立了被 Git 忽略的 `node_modules` symlink，指向本机现成的匹配依赖；没有安装或访问网络。随后 `npm run test:audit` 汇总 174/174；该 audit 在最后的帧数边界收紧前运行，边界改动之后重新通过了新专项。
- 实机/真实账号新一轮验收：未在本分支执行，交由集成主 Agent。

## 发布交接

```text
改动文件：plugins/surfcore/lib/douyin-companion-memory.mjs、src/memory-card.js、plugins/surfcore/scripts/test-douyin-companion-recall.mjs、plugins/surfcore/package.json、docs/cases/2026-11-07-douyin-recall-reasons.md。未改版本号、manifest、现有 Host/UI 测试或真实记忆数据。
验证：新专项先在旧实现下失败、修复后通过；共享核心 22/22、人格分层、记忆卡 29/29、wiring、既有 Host 均通过。`npm run test:audit` 为 174/174（该 audit 早于最后帧数边界收紧；新专项在边界收紧后重新通过）。
改动层级：实现层；ExperienceEvent v1 字段未变，摘要与细节职责明确，其他 audience 权限不变。影响：DSH Host 的记忆写入及上下文读取，静默遗漏风险按 1 writer × 5 audience × 3 = 15 估算；无用户数据、密钥、模型请求或费用触达。
建议发布级别：修复补丁；发布会话自行定版本。完整逻辑：本文件“完整逻辑”七步。失败路径：旧行为由新专项断言捕获；不完整音轨保留缺口与可能漏句提示，画面明确标为稀疏取样；非法样本计数不会被改写成有效帧数。尚未验证：隔离真实环境中的新一轮抖音活动、下一轮真实 DSH 上下文及 Host 重启后效果。
回滚：回退修复提交即可；没有记忆迁移，历史真实条目不改写。
```


## 集成实机与新进程模型回忆（父会话）

c49721f已在官方DSH0.2.2-rc.1独立实例实装。真实原生按钮轮次保存两条新抖音经历；正常退出App后，新Node进程调用生产buildContext，完整reason与视频编号均存在（2115字符完整角色上下文）。没有重写旧两条经历。

随后按新账本预留第5/12次请求，以固定Magpie→WorkBuddy HY3 low、8192输出上限/180秒、无客户端重试进行真实回忆。HTTP200/finish stop、用量持久落账，最近视频7704235831154967673的编号、ISO时刻、完整理由以及稀疏画面限制四项全部匹配。独立Magpie记录证明5笔累计请求各一次上游200；新增实际视频请求包含图像数据，重启后的请求未依赖启动环境中的占位密钥。

音轨覆盖仍为partial，28ms/2ms尾段缺口保持原记录，模型回忆成功不等于完整音轨手动门闸通过。发布交接补充：真实写入→正常退出→新进程生产上下文→真实HY3回忆已通过；常用profile迁入和音轨完整门闸仍以组合case最终状态为准。私有证据：recall-*.json中phase complete且reservedClientOrdinal=5的报告、model-accounting-current.json；不把模型正文写入公共材料。
