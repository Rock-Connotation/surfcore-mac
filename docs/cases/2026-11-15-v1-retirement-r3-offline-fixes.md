# V1 退役三轮复审离线修复（R3：F01–F05、N01、P2/F08+F10）

> 工作树 `/Users/shizihan/Daily/Github/surfcore-v1-retirement-r3`（分支 `feat/v1-retirement-r3`），基线 `dev` @ `1125d3e`。
> 复审来源：`/Users/shizihan/Downloads/SurfCore_V1_Retirement_Reaudit_b7316ca_20261113.md`（第三轮，判定"不可验收、不建议合并"）。
> 本轮只做**离线修复 + 常驻门禁**；**已提交到 `feat/v1-retirement-r3` @ `6feea46`，未合 dev、未 bump/发布**。Mac 实机（G7）另立一轮。

## 现象

- 用户可见的四个症状（复审文档实测）：
  1. 正常 QQ 轮询（`checkDsh` 每 5 秒刷模式）会把已发出的语音判成 `MEMORY_QQ_DELIVERY_UNKNOWN` —— **语音被误取消**；
  2. owner 发「任务状态」「取消任务」等管理消息**平台 0 次发送**，却返回 `MEMORY_PRESET_UNSAFE`/`OWNER_REPLY_SEND_FAILED`；产物交付平台只回 `{}` 时账本**写成 delivered**；
  3. B站：退役后重建 Runtime，同一天的重试与**不同日期**的两份计划都被压成同一个 `requestId` → `BILI_V2_JOB_REUSED`，模型调用 0、任务再不执行；
  4. 抖音：无 proof 的状态响应把 canary 文案原样透出、保存未确认记录错配到别的角色；预检把"读不了文件"报成"不是有效 JSON"。
- 复现步骤（离线，全部走真实代码路径）：
  - `node scripts/test-qq-admission-r3.mjs`（F01）、`node scripts/test-owner-delivery-r3.mjs`（F02）；
  - `node plugins/surfcore/scripts/test-memory-v2-bili-round-runtime-r3.mjs`（F05）；
  - `node plugins/surfcore/scripts/test-douyin-errors-r3.mjs`、`test-preflight-io-r3.mjs`（F10/F08）。
- 影响面：不丢历史数据、不动用户角色包/记忆/配置/授权/额度；但会让"该发的语音不发、该发的回执不发、该跑的作息不跑"，且账本把**未知**写成**已送达**——属于"静默错误"，比报错更危险。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS 26.6.2 (Darwin 25.6.0) arm64；DSH 自带 node **v24.21.0**（系统 node v26.5.1 仅作对照） |
| SurfCore 版本 | 0.8.8（插件 0.8.8） |
| 分支 / 工作树 | `feat/v1-retirement-r3` @ `1125d3e`（基于 `dev`），工作树 `../surfcore-v1-retirement-r3` |
| 时区 | Asia/Shanghai（`test-night-schedule`/`test-token-guard`/`test-token-budget` 本机 3/3 通过） |

## 完整逻辑

### 1. 链路（谁调谁，谁读它）

- **QQ 准入**：`src/bridge.js`（`applyModeSource` → `invalidateModeAdmission` → `modeRevision`）→ `src/core/qq-native-channel.js`（job 持 `admissionRevision`）→ `src/core/memory-v2-qq.js`（`authorizeSend` 发 lease / `recordSent` 消费 / `invalidatePreparation` 提交代际）→ `plugins/surfcore/lib/qq-v2-reply-host.mjs`（owner 作业）→ `plugins/surfcore/lib/memory-v2-api.mjs`（HTTP `qqReply` / 新增 `qqReplyCancel`）← `src/core/memory-v2-client.js`（`requestQQReply` / 新增 `cancelQQReply`）。读这份准入状态的还有 `src/bridge.js` 的 TTS 复核点与 owner 入站 `captureSource` 之后的分支。
- **管理回执**：`src/bridge.js`（命令入口 → 受控管理发送）→ `src/task-harness.js`（`executeDeliveryStep` 按回执写 `ledger.delivery`）→ 平台替身/真实平台。UI 只读账本投影。
- **B站事件身份**：`plugins/surfcore/lib/scheduler.js`（生成 `requestId`）→ `plugins/surfcore/lib/bili-v2-host.mjs`（`enqueue`/`getStatus`）→ `plugins/surfcore/lib/bili-v2-agent.mjs`（registry 去重 `BILI_V2_JOB_REUSED`）。
- **抖音/预检**：`plugins/surfcore/lib/douyin-companion.mjs`（状态投影）→ `douyin-companion-ledger.mjs`（校验器）→ `plugins/surfcore/lib/index.js:3960` 展开成 HTTP JSON；`src/core/memory-v2-preflight.js` 的消费者是 `plugins/surfcore/lib/index.js`、`scripts/test-v2-real-integration.mjs` 与新测试。

### 2. 机制（为什么会这样）

- **F01**：把"本次轮询时间"当成了"权限语义代数"。`applyModeSource` 每次读到模式就 `modeRevision += 1`，而这个数被当作"本次准入是否仍然有效"的凭证；于是**同一个有效模式的下一次轮询**就让在途语音的凭证过期 → 语音被取消。另一半是 lease 的**生命周期漏口**：`sendLeases` 里的 lease 只有 `recordSent` 会消费，`retire` 只删外层 `active`，所以"进入 blocked 之后旧 lease 仍能发送成功"。
- **F02**：管理消息与产物交付走的是两条不同的发送路径，只有交付那条接了新回执；而且判定用了 `ok !== false`，平台回 `{}`（`{ok:true, delivery:'unknown'}`）也会被当成已送达。
- **F03/N01**：`durable: true` 是 scheduler 由 `accepted:true + jobId/sessionId` **自己合成**的；registry 只存 5 个标识字段，重启后没有重放输入；非 DM 的哈希只看 `kind/slotId/at/...`，不含日期，所以不同日期的两份计划算出同一个 ID。
- **F04**：`execFile` 被 abort 只结束了回调，子命令自己 `spawnSync` 的后代不在等待范围；retire 见到 tick Promise 排空就报成功，等于"取消"被当成了"退出"。
- **F10/F08**：快手面（`publicError`）只做凭据清洗，不做语义映射；`terminalFailures` 的值里没有 `jobId/角色/epoch`，投影却拿 `row.jobId` 去比，`undefined === undefined` 命中任意旧记录；预检把 `readFileSync` 与 `JSON.parse` 放在同一个 `catch` 里，所以"没有权限读"被报成"不是有效 JSON"。

### 3. 爆炸半径

- 进程数 × 读者数 × 静默系数：QQ 侧改动落在 **桥接进程**（1 个），读者包括 TTS 复核、owner 入站、Native 作业、Host owner、插件 HTTP 面；B站侧落在 **插件进程**；抖音/预检落在插件进程与桥接的预检调用点。
- 是否碰用户数据/密钥/花钱：**都不碰**。没有迁移用户记忆、没有改授权与额度、没有调用付费模型（离线替身）、没有写真实 `~/.dsh`；测试根全部落在 `testHome()`/`os.tmpdir()`。
- 静默风险：本轮**降低**——原本"未知被写成 delivered"、"退役被报成成功"这类静默成功，现在都变成结构化 `ok:false + code + error + hint`。

### 4. 取舍（为什么走这条路线）

- **准入代数**：①"删掉所有 revision 检查"能立刻让语音不再被误取消，但会同时放行"退役/blocked 之后旧 lease 仍可发送"——**收益是假的**；②"只在真实语义变化时推进代数 + 把代数绑到 job/lease/请求、每个关键 await 后复核"改动面更大，但两个方向同时成立。选 ②。
- **取消在途 Native 作业**：①复用宿主级 `retire()`（简单，但它会把 `transition` 全程置位，影响后续提交语义）；②新增**专用取消入口**（`qqReplyCancel` + `cancelAll`，只撤这一个作业）。选 ②，并补 AC：进入 blocked 取消、恢复到正常 chat 后**新**请求必须仍能正常发送。
- **F03**：①(A) 真持久接管——要把来源坐标、阶段、重放输入写进 registry 并在重启后重放，属跨模块新能力；②(B) 诚实降级——不再合成 `durable:true`，状态写成 `accepted-needs-retry`/`unknown` 且可查。本轮选 **B**（用户已拍板），A 留待下一轮；选 B 的收益是**消除假声明**，代价是"重启后不会自动跑起来"这件事被明说。
- **迟到 prepare 竞态**：①等待"旧 prepare 自己跑完"无时间上界；②在提交点只加作用域守卫（无法阻止覆盖）；③**每 key 单调整数代数 + 提交点复核**（`release(previous.handle)` 前与 `active.set` 前），失配返回 `MEMORY_QQ_ADMISSION_CANCELLED` 且不碰 `active`。选 ③。
- **抖音越界帧数**：①只改测试让它别看见（等于遮住产品缺陷）；②复用记忆叙述层同一道 1..3 门控、越界时改说"稀疏画面数量未确认"。选 ②（保守、不虚假声明）。

### 5. 生效与重启

- 改动落在**桥接进程**（`src/bridge.js`、`src/core/*`）与**插件进程**（`plugins/surfcore/lib/*`）：要生效需重启 QQ 桥接与 DSH 插件（重启矩阵见 12 课 §8）。
- 本轮**没有重启任何真实进程**（离线门禁）；门禁脚本自带隔离 root，不读真实 `~/.dsh`。
- 需要重新生成的文件：`release/install-manifest.json`（提交后跑 `node scripts/release-manifest.mjs`，新增 10 个 r3 测试文件要进清单）。

### 6. 验证

```
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"   # DSH 自带 node v24.21.0（该目录只有 node）
npm run test:audit                    # 204/204，exit 0（基线 195 + 新增 9 条 r3 常驻合同测试）
npm run test:regressions              # 17/17，exit 0
npm run test:memory-v2                # 48/48，exit 0
npm --prefix plugins/surfcore test    # exit 0，末行 PASS 37 ordinary scripts in 39.4s; native/UI acceptance not run.
npm run lint:failures                 # exit 0
npm run doc-facts                     # exit 0（桥接行数 18257→18318 已同步）
node scripts/release-manifest.mjs --verify-ref HEAD   # 1096/1096，问题 0 个
npm run test:preset-patches           # exit 0
```

关键**先红→修后绿**成对证据（都在报告与 `/tmp` 日志里留档）：

- F01：反向重放去掉提交点复核 → `FAIL AssertionError: late preparation overwrote newer active`（exit 1）→ 恢复后 SHA `576670db…` 逐字一致 → 13 条断言全过。
- F01 lease：修前 `recordSent` 返回 `{ok:true,acceptance:'committed'}`（旧 lease 仍能发）→ 修后 `MEMORY_SOURCE_LEASE_REQUIRED`；原 Host handle `validate` → `MEMORY_HANDLE_STALE`。
- F02：修前 `platform sends=[] + MEMORY_PRESET_UNSAFE` → 修后 `sends=[{"id":10001,"text":"当前会话暂无任务记录。"}]`；unknown 修前账本 `status:completed/delivery.delivered/messageId:null` → 修后 `code:OWNER_REPLY_UNKNOWN` + `status:unknown` 且二次执行不重发。
- F02 ACK 入账（本轮 Lead 补做反向重放）：把 `messageId: acknowledged ? sendReceipt.messageId : null` 反向成 `messageId: null` → `FAIL ... null !== 9001`（exit 1）→ 恢复后 SHA `e03403c5…` 逐字一致 → exit 0。
- F03/N01：先红 `FAIL 未知 schema 保留原字节: Expected "actual" to be strictly unequal to: 0`；`durable: true` 生产命中只剩用量持久化参数（无 B站作业回执生产者）。
- F04：修前 `childAliveAtAck=true pendingAfter=1` → 修后 `false/0`；deadline 修前拿不到 `close` → 修后 `BILI_SCHEDULER_RETIRE_TIMEOUT` 且放行后同实例重试成功。
- F05：修前 readiness `BILI_V2_ROUND_SCOPE_UNAPPROVED`、start 409、模型调用 0 → 修后集合 0→1、readiness ok、start 200、两次调用只见获批 BV；未批准 BV 与 route 变更都在调用前被拒。
- 预检：修前 EACCES → `corrupt/MEMORY_ROUTING_INVALID/problem=json` → 修后 `unreadable/MEMORY_PREFLIGHT_UNREADABLE` + `ioCode`，真损坏 JSON 仍 `corrupt`。
- 越界帧数：修前 DOM 渲染"6 张稀疏画面" → 修后"稀疏画面数量未确认"（真实 Chromium DOM 断言，缺浏览器会硬失败而不是静默跳过）。

### 7. 回滚与残余

- 回滚：改动已落在 6 个提交（`6c2b581` F01/F02、`ef30eb5` B站、`c8e2e28` 抖音/预检、`74390e3` 预算与模式回执、`1eff636` 测试与文档、`6feea46` 清单），按提交逐条 `git revert` 即可；共涉及 44 个已跟踪文件 + 11 个新增文件。
- 残余（必须留给下一轮）：
  1. **取消后的 reflection 写入没有保存原操作编号** —— 调用方无法按编号查回"可能已提交"的写入（违反"同一原操作可查询"标准）；本轮按"撤销后续检查 + 可查询终态"的口径诚实标注，产品接口缺口待修；
  2. 越界帧数的**上游取回路径**仍不校验 0..3（本轮只防御展示层）；
  3. 真实跨进程付费调用唯一性**未验证**（测试已改成不宣称 PASS）；
  4. Mac 实机（Native SDK/长 TTS/真实 CLI 后代/真实卸载）与真实 QQ·B站账号链路；
  5. 方案 A（真持久接管）。

## 失败路径（用户看到什么 / 下一步点什么）

| 场景 | 修前 | 修后 |
| --- | --- | --- |
| 桥接没在运行，用户保存模式 | `HTTP 409` + `QQ_MODE_INVALID`（已保存却报"非法"） | `HTTP 200` + `applied:false` + `QQ_MODE_SAVED_PENDING_BRIDGE` + hint「已保存；QQ 桥接未运行，启动后自动生效」 |
| owner 在群里发任务命令 | 无回复 | 受限系统回复：`[权限拦截] 群聊环境禁止执行电脑任务…请切换至 QQ 私聊` |
| 交付回执未知 | 账本写 `delivered` | `status:unknown` + `code:OWNER_REPLY_UNKNOWN` + hint「先查询平台消息和任务状态，不要自动重发」 |
| B站作业无法持久接管 | 声称已接管 | `BILI_V2_NOT_DURABLE`：明说"没有持久接管凭证"，提示按原作业编号查询、不要另建编号 |
| 预检读不了配置 | "不是有效 JSON" | `MEMORY_PREFLIGHT_UNREADABLE` + `ioCode`，hint「检查状态目录与文件权限后重新预检」 |

## 改动层级

- 实现层：准入代数、lease 生命周期、管理发送与账本、B站身份与退役协议、单轮来源集合、抖音投影、预检错误分类。
- 接口层：**向后兼容**。新增 `qqReplyCancel` action 与 `cancelQQReply` 客户端方法、新增错误码（`MEMORY_QQ_ADMISSION_CANCELLED`、`MEMORY_QQ_JOB_STALE`、`OWNER_REPLY_UNKNOWN/REJECTED`、`BILI_V2_NOT_DURABLE`、`MEMORY_PREFLIGHT_UNREADABLE`、`MEMORY_SOURCE_RECEIPT_INVALID`、`QQ_MODE_SAVED_PENDING_BRIDGE`）；**旧错误码 `MEMORY_PREFLIGHT_ROUTE_UNREADABLE` 已无消费者**（全仓 grep 只有新测试断言新码）。取消成功语义保持 `ok:true,state:'cancelled'` 不变。
- 建议版本：跟随下一轮一起出 **minor**（用户可见行为变化：语音不再被误取消、管理消息真的送达、B站不再假称已接管）。

## 未验证

见上文"残余"1–5。特别声明：**插件套件全绿不含 native/UI 验收**（末行自述 `native/UI acceptance not run.`），真实 Native SDK 在 `app.asar` 内普通 Node 无法解析，归 G7 Mac 实机。
