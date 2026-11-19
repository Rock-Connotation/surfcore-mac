# 2026-11-19 R2 复审补齐、本机任务审批 403 修复与双线合流

## 现象

1. **R2 复审发现 4 处缺口**（基线 `fix/review-2026-11-19-r2@2df50c0`）：
   - **P1（#04）**：`src/task-harness.js` 在 `sendCallback` 成功拿到平台 `messageId` 后，裸调 `ledger.getTask(task.taskId)`；若此时账本损坏或不可读，异常落入 `catch` 再裸调 `ledger.updateTask` 抛到 `runTaskPipeline`，最终 `src/bridge.js` 给主人回复「执行状态暂无法核对，未投递报告」，在**实际已送达**后谎报未投递。
   - **P2（#04）**：`executeDeliveryStep` 只拦截 `['delivery_unknown', 'rejected']`，漏拦 `'delivering'`；直接调用会对卡在 `delivering` 的任务二次重发。
   - **P2（#08）**：Windows `src/state-acl.mjs` 的 `hardenFile()` 只有 `/inheritance:r` + `/grant:r`，缺少 `/remove:g ...PERMISSIVE_SIDS`，无法自动移除旧库文件的显式宽主体授权。
   - **P2（#06）**：`scripts/apply-update.mjs` 新增 `verifiedFiles` 路径过滤写成 `parts.length === 1 && rootUserDirs.includes(parts[0])`（漏拦 `models/xxx` 等目录内子文件），且边验边复制无 preflight 预检。
2. **本机任务（红豆操作 Mac）P1 审批拦截**（基线 `feat/local-task-t01t08@76565be`）：
   - `plugins/surfcore/lib/local-task-interactions.mjs` 转发 `approval/request` / `user-questions/request` 到 `POST /api/notify/owner` 时未带任务标识，`src/bridge.js` 落入全站 `SENSITIVE_RE`（拦截一切 `/Users/...`）；只要 `bash` 升权或提问说明含桌面/工作区路径，桥接返回 `403 NOTIFY_SENSITIVE`，`notifyOwner` 仅记日志，主人 QQ 收不到 `t<7hex>` 确认消息，任务干等至超时。
3. **双线割裂**：本机 DSH 实际运行 `feat/local-task-t01t08`（从旧 `d46612a` 分叉），未包含 11/19 的 R1/R2 修复（实查本机 `~/.dsh/surfcore/memory-control.sqlite` 仍为 `0644`）。

## 完整逻辑（七步）

1. **链路**：
   - QQ 研究送达：`src/bridge.js` `handleIncoming` → `src/task-harness.js` `runTaskPipeline` / `executeDeliveryStep` → `sendOwnerManagementReply` → `src/task-ledger.js`。
   - 本机任务交互确认：DSH `approval/request` / `user-questions/request` → `plugins/surfcore/lib/local-task-interactions.mjs` `notifyOwner` → `POST /api/notify/owner`（`src/bridge.js`）→ `src/sensitive.js` `hasSensitiveTaskOutput` → 主人 QQ 私聊 → `parseLocalTaskIntent`（`通过/始终允许/拒绝 t<7hex>`）→ `local-task-api.mjs`。
   - Windows 文件 ACL：`src/core/memory-v2-store.js` / `memory-v2-lifecycle.js` → `src/state-acl.mjs` `hardenFile`。
   - 客户端更新落盘：`plugins/surfcore/lib/updates.js` → `scripts/apply-update.mjs` `copyZip(staging, target, verifiedFiles)`。
2. **机制**：
   - 送达边界必须按「发送前 / 发送后」分层：一旦 `sendCallback` 返回已确认 `messageId`，后续任何账本读/写失败都属于「送达已发生、记账未完成（`DELIVERY_RECEIPT_UNRECORDED`）」，绝不能回退成「未投递 / failed」。
   - `/api/notify/owner` 只对带合法 `taskResult.taskId` 放行常规工作区/桌面路径，却把同属本机任务链路的交互确认 `t<7hex>` 漏在严格 `SENSITIVE_RE` 分支，导致正常路径触发 403 且被静默吞错。
   - Windows `icacls` 中 `/grant:r` 仅替换同主体 ACE，必须配 `/remove:g` 才能清掉已有显式 `Everyone` / `Users` / `Authenticated Users` ACE。
3. **爆炸半径**：
   - R2 补修：`src/task-harness.js`（QQ 桥接单进程，静默=3 误报未投递或重发）、`src/state-acl.mjs`（Windows 记忆库初始化）、`scripts/apply-update.mjs`（客户端更新器）；均不触碰真实用户数据或密钥。
   - 交互确认修复：`local-task-interactions.mjs` + `src/bridge.js` `/api/notify/owner`；仅对 `x-console-token` 认证且携带合法 `taskInteraction.id`（`^t[a-f0-9]{7}$`）的请求启用 `hasSensitiveTaskOutput`，仍严格拦截 Secret、凭据赋值、`.ssh/.aws/.env`、`~/.dsh` 内部目录、系统目录与密钥扩展名；普通日记通知仍走严格 `SENSITIVE_RE`。
4. **取舍**：
   - 方案 A（采用）：先在独立工作树 `surfcore-r2-followup` 补齐 R2 四处缺口并合入 `dev`，再在独立工作树 `surfcore-local-task-integrated` 修掉审批 403 并把最新 `dev` 合并进本机任务分支，一次性解清 9 处文件冲突，不碰正在运行的 `surfcore-local-task` 活进程目录。
   - 方案 B（放弃）：直接放宽全站 `SENSITIVE_RE` 或直接在正在运行的 `surfcore-local-task` 目录就地合并。前者会削弱普通出站/日记审计，后者会在活进程运行中热覆盖源码引发不可控竞态。
5. **生效与重启**：
   - 本批位于独立分支 `feat/local-task-integrated`（`dev` 已先合入 R2 复审补齐）。
   - 要在当前本机红豆生效：将本机工作区切换或合入 `dev`/更新 `~/.dsh/plugins/surfcore` 指向后，重启 DSH 桌面端与 `src/bridge.js`（重启后 `memory-control.sqlite` 将在初始化时自动收紧至 `0600`）。
6. **验证**：
   - R2 补修分支（`fix/review-2026-11-19-r2-followup` @ `b9df4c2`）：`test:audit` 208/208、`test:regressions` 17/17、`lint:failures` 0、`doc-facts` 0、`release-manifest --verify-ref HEAD` 1123/1123 问题 0；合入 `dev` @ `8d66d8a` 后 `--verify-ref HEAD` 1123/1123 问题 0。
   - 合流分支（`feat/local-task-integrated`）：见下方实测结果（含新增 post-send 账本损坏防误报、`delivering` 防重发、Windows `hardenFile` `/remove:g`、`apply-update` preflight/目录拦截、真实 DSH Desktop Host + 真实 `src/bridge.js` 审批 `/Users/...` 200 放行与 `.ssh` 403 拦截）。
7. **回滚与残余**：
   - 回滚：未发布、未改版本号、未动正在运行的 `surfcore-local-task` 目录；代码回滚直接 `git revert` 对应提交即可。
   - 残余：真机切换 `~/.dsh/plugins/surfcore`、重启运行中的 DSH + QQ 桥接、真实手机 QQ 自然对话端到端操控桌面/Chrome 闭环与 Windows 真机 `icacls` 仍待授权后实测。

## 发布交接块（可直接转发）

```
【发布批次：2026-11-19 · R2 复审补齐 + 本机任务审批 403 修复与双线合流】
- 目的：关闭 R2 复审 4 处缺口（送达后读账本损坏误报未投递、delivering 防重发、Windows hardenFile 去宽权、
  apply-update 路径过滤与 preflight），修复本机任务交互确认含 /Users 路径被 403 静默拦截卡死问题，
  并将 dev（R1+R2）与本机任务桌面操控分支合流。
- 改动层级：实现层 + 测试/文档；无破坏性对外接口变更。/api/notify/owner 新增可选 taskInteraction 标识。
- 覆盖提交：dev 已合入 R2 与复审补齐（8d66d8a）；合流候选在分支 feat/local-task-integrated（见交付报告最终 HEAD）。
- 验证：隔离 Node 24.21.0 下 test:audit、test:regressions、test-local-task-desktop-host（真实 DSH Desktop Host + 真实 bridge.js）、
  test-release-manifest-guard、lint:failures、doc-facts、release-manifest --verify-ref HEAD 与 git archive --verify 全部通过。
- 未验证：切换本机活 DSH/桥接后的真实手机 QQ 桌面操控闭环、Windows 真机 ACL、线上 tag 归档包。
- 回滚：未发布、未改活目录；按提交 revert 即可。
- 生效：切换/安装新分支并重启 DSH 桌面端与 src/bridge.js。
- case：docs/cases/2026-11-19-qq-r2-followup-and-local-task-integration.md
```
