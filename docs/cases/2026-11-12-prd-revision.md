# Case 2026-11-12 · PRD 拍板修订（定位/双平台/默认QQ/无分级/V1清单）

> 对应规则：`AGENTS.md` 铁律 1.6（讲透逻辑）、铁律 8（文档同步）。本批为**纯文档批次**（不改业务代码），另含 feat/doc-facts 合并回 dev。

## 现象

用户把 PRD v0.1 的六项「待确认」一次性拍板：①核心是数字角色分身、渠道是出口；②Windows/macOS 双平台一等公民、Linux 未验证；③默认入口是 QQ；④无高级/普通用户之分、设置窗口完全一致、V1 系列过时最终删除；⑤桌宠降级；⑥无商业化打算。要求修订 PRD 与 IMPROVEMENTS，并做三项核查（B 设置分叉核查、C V1 清单、D doc-facts 合并）。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / 版本 | macOS；dev 0.8.8（未 bump，本批不发布） |
| 工作树 | `../surfcore-prd-revision`，分支 `feat/prd-revision`（基线 dev 790c1d3） |
| 输入 | `2026-11-12/prd-scan/outputs/`（PRD/IMPROVEMENTS/ARCHITECTURE v0.1 扫描稿，用户上传产物，只读对待） |

## 完整逻辑（给用户看的那一遍）

- **链路**：本批只新增 `docs/product/` 四份文档（PRD.md / IMPROVEMENTS.md / ARCHITECTURE.md / V1-INVENTORY.md），不改任何 `src/`、`plugins/` 业务代码与配置；上游是 2026-11-12 的六条拍板 + A6 批次 case 里的四条补充拍板，下游是后续批次（入口文档改写、默认只开 QQ、V2 转正→V1 分批退役）。
- **机制**：拍板逐条落档的方式是「决议记录表（PRD §7.1）+ 正文对应章节改写」双落点：正文改状态与优先级，决议表留痕可追溯。B/C 两项核查**以 grep 实证为准，不凭文档判断**：
  - **B 结论（无分叉）**：设置窗口 15 个标签是静态数组 `TABS`（`plugins/surfcore/lib/client.js:6938-6954`），导航用无条件 `TABS.map` 渲染（`:7215`），标签切换是静态 if 链（`:7187-7202`）；全库 grep `advanced|expertMode|userTier|高级用户|userLevel` 仅命中「全部参数」标签页命名与测试变量，无按用户类型/feature flag 控制可见性的分叉。**现状已符合拍板 ④ 的"设置窗口完全一致"。**
  - **C 结论（V1 清单）**：全库 grep `\bv1\b|V1`（去噪后）识别出 8 个真 V1 面与 8 类第三方协议版本号（不是 V1 系列，明确排除）。按「删了最安全→删了最痛」排序：①人格卡 v1/v2 文案过滤层 → ②Memory V2 内部 legacy 分支 → ③QQ 一代仿真（v1 preset + reserved）→ ④V1 记忆后端本体 → ⑤B站 V1 链路 → ⑥QQ V1 发送链路。**关键依赖链**：QQ V2 回复要求 Memory 路由为 v2（`qq-v2-reply-host.mjs:42`），故 ④⑤⑥ 全压在「Memory V2 转正+数据迁移」这条前置链上；④ 的数据载体是角色包 `memory/` 用户数据，⑤ 是 `logs/bili-bot/` 账本，删除必须走铁律 6 隔离备份。
- **爆炸半径**：纯文档新增 1 个目录 4 个文件 + case/队列/登记表；不碰运行时、不碰用户数据、不碰密钥、不花钱；读者是产品/开发会话与发布会话。报错面为 0（无接口改动）。
- **取舍**：
  - 路线 A（本批）：产物落 `docs/product/`（新增独立目录），v0.1 扫描稿保留在 `2026-11-12/`（未跟踪产物目录）不动。收益：入 git 可追溯、可被 doc-facts/发布流程管到；成本：与扫描稿两处并存；回滚：revert 即可。
  - 路线 B（放弃）：直接改写根 README/插件 README/ROADMAP 一并落拍板。收益：一步到位；成本：入口文档改写会牵动插件 README 的安装/配置段落，且「默认只开 QQ」尚未实施，README 先改会与代码行为不一致（文档说默认 QQ、实际默认 QQ+B站）——**文档不能跑到事实前面**；留作下一批。
  - 路线 C（放弃）：把 V1 清单塞进 IMPROVEMENTS 附录。收益：少一个文件；成本：清单是给用户圈定删除范围的决策件，需要独立演进（圈定后逐项打勾），混在评估文档里不利追踪；独立成 `V1-INVENTORY.md`。
- **生效与重启**：纯文档，无进程需要重启；`docs/product/` 属 git 追踪文件，随合并进 dev。
- **D 项（doc-facts 合并）**：拍板口径（控制台路径按出现次数、src 引用含 presets）核实已在 `scripts/doc-facts.mjs` 头部「口径」注释中逐条写明（a3f281f 已含），实现与口径一致，无需再改脚本；本批做的是把 feat/doc-facts 合并回 dev 并从合并后 HEAD 重生成清单。

## 修法（产出物）

- `docs/product/PRD.md` v0.2：定位重写（§1.1 分身本体/渠道出口）；双平台一等公民入 §1.4/§6.2；默认入口 QQ 入 §2.3/P0-7（标注现状差距与迁移待办）；无用户分级入 §2.1（含 B 核查结论）；桌宠降级（§4.2 G + §五降级段）；抖音暂缓（⏸️）；火山 TTS 第一梯队（§4.2 F）；商业化删除并反向入边界（§1.4「不做商业化」）；功能清单状态新增 🗄️已过时/⏸️暂缓 口径；待确认清单改为拍板决议记录表。
- `docs/product/IMPROVEMENTS.md` v0.2：摘要表加状态列；A1 拍板+残留待办（入口文档改写，明确"文档不跑到事实前面"的理由）；A2/A3 标 feat/doc-facts 待合并；A4 改写为 V1 退役路径；A6 标完成；新增「不要在 V2 转正前删 V1」禁令。
- `docs/product/ARCHITECTURE.md` v0.2：§6 状态语义更新（🗄️/⏸️/⬇️），一代仿真/B站 V1/记忆 V1/QQ v1 路径标 🗄️；§8 数字对照注明已交给 doc-facts。
- `docs/product/V1-INVENTORY.md`：范围排除表 + 6 项清单（位置/引用/波及/数据依赖/建议动作）+ 依赖链一句话。
- 未删除任何代码/配置/数据；未 bump version；未打 tag/发布/推仓库。

## 验证

- B 核查实证：`grep -rn "advanced|expertMode|userTier|高级用户"` 全库仅 client.js 标签命名与 admin-identity 测试命中；`client.js:7215` `TABS.map` 无条件渲染。
- C 盘点实证：每项位置均给出文件:行，grep 可复核。
- 门禁：合并后主树 `npm run test:audit`（预期 195/195）、`npm run lint:failures`（退出 0）、`npm run doc-facts`（退出 0）、`node scripts/release-manifest.mjs --verify-ref HEAD`（问题 0 个）。
- 没验证到的部分：V1 清单未逐行核每个模块的完整调用图（按入口+主要消费方盘点）；「入口文档改写」未做（理由见取舍 B）。

## 遗留 / 后续

1. 三份入口文档按拍板改写（README / plugins/surfcore/README / ROADMAP 范围闸）——等「默认只开 QQ」实施后一起改，避免文档领先事实。
2. 默认只开 QQ：改默认值 + 老用户迁移（不能静默关已开的 B站）。
3. V1 删除：等用户按 V1-INVENTORY 圈定范围，另立批次 + 铁律 6 隔离备份；前置是 Memory V2 转正。
4. 火山 TTS 真实计费/音质验收（第一梯队）。
