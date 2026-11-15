# V1 退役四轮（R4：接管重驱动合同 + 取消后回执可查）

> 工作树 `/Users/shizihan/Daily/Github/surfcore-r4`（分支 `feat/v1-retirement-r4`），基线 `dev` @ `07efab6`（R3 已合入）。
> 用户 2026-11-15 定的范围：「先三个代码项，再 G7 实机」；G7 边界＝**只开隔离实例**，不动正式环境。
> 本轮状态：已提交 `feat/v1-retirement-r4` @ `59bead0`，并已合入 `dev` @ `db17ec3`（merge）；未 bump/tag/发布。

## 现象

R3 留下三个待办（都不是"崩了"，而是"说不清"）：

1. **取消后查不到原操作**：抖音聊天的反思写入（reflection）在取消后可能**已经提交**，但作业账本不记录它的 `operationId`，调用方拿不到编号去查 Host 回执 —— 违反"同一原操作在中断/取消/重启后可查询"这条验收标准。
2. **越界帧数**：R3 只修了显示层（越界值改渲染成"稀疏画面数量未确认"），上游取回路径是否还漏值没有定论。
3. **方案 A 真持久接管**：R3 选择方案 B（全仓不再合成 `durable: true`，状态诚实降级）。本轮要回答的是：进程重启后，**生产 scheduler 会不会用原 `requestId` 重驱动**重启前留在 `pre_dispatch` 的接管任务？

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / Node | macOS 26.6.2 (Darwin 25.6.0) arm64；DSH 自带 node **v24.21.0**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin`，该 bin 只有 `node`，没有 npm） |
| 依赖 | `node_modules` 软链主工作树（lockfile 零差异）；全程禁 `npm ci/install/rebuild` |
| 真实账号/服务 | 未启动、未发送、未扫码；所有替身只顶替外部 I/O，被验链路走真实代码 |

## 完整逻辑

### 1. 链路（谁调谁，谁读它）

- **R4-A（重驱动）**：`plugins/surfcore/lib/scheduler.js:345` `const requestId = typeof opts.requestId === 'string' && opts.requestId ? opts.requestId : stableRequestId(input)` → `:348` `biliV2Agent.query({ requestId })` 查原作业 → `:354` `biliV2Agent.enqueue({ requestId, input, signal: effective })`；Host 侧落到 `plugins/surfcore/lib/bili-v2-agent.mjs:330-360` 的复用守卫：**上一笔仍是 `pre_dispatch`、且输入/原始输入/scope/组数逐字节相同、且没有活作业**时，允许用原 `requestId` 重新 `enqueue`，然后 `persist(job, { …, phase: 'pre_dispatch' })`。夜/提醒路径在 `:609`/`:635`/`:843`/`:864` 用 `row.requestId`（即**原编号**）传下去。
- **R4-B（可查询）**：`plugins/surfcore/lib/douyin-companion.mjs:498` 在调用 `v2.reflect(...)` **之前**写入 `item.reflectionOperation = { operationId: v2.reflectionOperationId(session), state: 'unknown' }` 并落账本；写入成功后置 `'completed'`；新增 `queryReflection(context, operationId)`（`:868`）供取消后按原编号查回执。`plugins/surfcore/lib/douyin-companion-memory.mjs:104` 提供 `reflectionOperationId(session) = \`${session.identity}:reflection\`` 与 `receipt(session, operationId)`；账本校验在 `plugins/surfcore/lib/douyin-companion-ledger.mjs:79`。

### 2. 机制（为什么会这样）

- R4-A：重驱动的能力**本来就在**（R3 的 F03 方案 B 落地时顺手把"原输入/来源坐标/阶段/组数"持久化进了 registry，并把 `durable: true` 的合成删除）。真正缺的是**证据**：没有一条测试证明"生产 scheduler + 真重建 Runtime + 原编号"这条路会把 prompt 真的送进会话。缺证据的后果很实际——下一个人会以为这里靠的是 `durable: true` 回执，或者反过来以为自己写的新 ID 会被接受。
- R4-B：取消的语义边界是"撤销后续检查 + 可查询终态"，**不是回滚已提交写入**。既然无法保证"取消 ⇒ 一定没写入"，就必须给出**查得回原操作**的入口；否则用户看到 `state:'cancelled'` 却无从确认服务端到底收没收到 —— 这正是"用未知冒充已取消"。

### 3. 爆炸半径

- R4-A：**零产品改动**。只往共享夹具加一条 scenario（`plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs`，51 → 52 场景）。不碰用户数据、密钥、额度。
- R4-B：改 3 个抖音侧库文件 + 加 1 个测试。账本新增**可选**字段 `reflectionOperation`（旧账本 `undefined` 一律放行，向后兼容）；取消的对外语义不变（仍 `ok:true, state:'cancelled'`, `memorySaved:false`）；`adapter.receipt` 是既有能力（`src/core/memory-v2-client.js:97`）。不动 `memory-v2-host.mjs`、不动 QQ/B站链路。

### 4. 取舍（为什么走这条路线）

- R4-A 有两条路线：**(a) 只做静态核对**（"代码看起来支持"）——成本最低，但等于拿"看起来对"当验收，正是 R3 被判不可验收的原因；**(b) 在既有真实夹具里补一条 scheduler 层 scenario**（本轮选择）——成本是一次真重建 Runtime 的测试，换来"原编号能被重驱动、prompt 提交数 0→1、unknown 后不再重投"的可复现证据；**(c)** 另造独立脚本用正则改写整套测试再 `spawnSync`（子代理先做的方案，已被我否掉并隔离：脆弱、慢、不清理 scratch、不可维护）。
- R4-B 有两条路线：**(a) 改成"取消后禁止写入"**——需要动 memory-v2 ingest 层与 Host 契约，且物理上做不到（写入可能已提交），只会把"查不到"变成"假装没有"；**(b) 写前登记操作编号 + 提供按编号查询**（本轮选择）——不动契约，把未知变成可查。**收益不佳就回退**在这里是明确的：(a) 成本高、收益是负的。
- R4-C **不修**：`plugins/surfcore/lib/douyin-companion.mjs:416` 已经 `.slice(0, MAX_FRAME_SAMPLES)`，`:420`/`:493` 的 `images.length` 天然 ≤3，账本又要求 0..3 —— 边界内没有可修缺陷；要"造红"只能反向掉那道守卫，那是造证据，不做。真实残余只是取回路径不校验（见下）。

### 5. 生效与重启

- R4-A：测试文件，无需重启任何东西；`node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs --ordinary` 即可复现（退出码 0，末行 `PASS Bili native runtime: 52 scenarios`）。
- R4-B：改的是 DSH 插件侧库文件，**要重启 DSH / 重载插件**才在大盘生效；抖音侧的取消/查询路径随之更新。

### 6. 验证（命令 + 期望输出）

```
# R4-A：新 scenario 的三段原始输出（自带 node）
node plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs --ordinary
SCHEDULER_RESTART_BEFORE  {"id":"bili-v2-ed04cb31…","prepareCalls":1,"promptSubmissions":0,"providerCalls":0}
SCHEDULER_RESTART_AFTER   {"id":"bili-v2-ed04cb31…","prepareCalls":2,"promptSubmissions":1,"providerCalls":1}
SCHEDULER_RESTART_UNKNOWN {"phase":"unknown","enqueues":2,"providerCalls":1}
PASS scheduler re-drives the original pre-dispatch ID through a rebuilt runtime
PASS Bili native runtime: 52 scenarios (v24.21.0, actualHostTools=false)

# R4-A 反向重放（证明这条合同真的会红）：把 bili-v2-agent.mjs:344 的
#   previous.entry.phase !== 'pre_dispatch'
# 临时改成 !== '__resume_disabled__' → RED_EXIT=1（1 秒内）
#   BILI_V2_JOB_REUSED "This original job was already submitted; inspect its receipt."
#   AssertionError: pre-dispatch denial must resume the original ID
# 还原后 SHA 与改动前逐字一致 f67ff48365fc41705f9a16e3aae6c5076d6e3b3b985793f3a67ebf240ba29095

# R4-B：先红 → 修后绿
CANCELLED_JOB  {"operationId":"douyin:…:reflection","recorded":null,"state":"cancelled","memorySaved":false}   # 修前
CANCELLED_JOB  {"operationId":"douyin:…:reflection","recorded":{"operationId":"douyin:…:reflection","state":"unknown"},…}
HOST_RECEIPT   {"ok":true,"operationId":"douyin:…:reflection","sourceState":"committed","operationState":"completed"}
STALE_FAILURE  {"ok":false,"code":"DOUYIN_STALE_CHARACTER","error":"请求中的角色或世代已过期。","hint":"刷新当前角色后重新发起；过期上下文不会绑定到新角色。"}
QUERY_FAILURE  {"ok":false,"code":"DOUYIN_RECEIPT_NOT_FOUND","error":"没有找到该角色的反思操作编号。","hint":"查看原作业状态并使用其中的操作编号。"}
PASS real host cancelled reflection receipt
```

冻结快照门禁（自带 node，全员停手后单跑）：

| 命令 | 结果 |
| --- | --- |
| `npm run test:audit` | **205/205 exit 0** |
| `npm run test:regressions` | exit 0 |
| `npm run test:memory-v2` | `PASS 50 ordinary scripts in 85.8s` exit 0 |
| `npm --prefix plugins/surfcore test` | `PASS 37 ordinary scripts in 25.4s` exit 0 |
| `npm run lint:failures` | exit 0 |
| `npm run doc-facts` | exit 0（文档数字与代码一致） |
| `node scripts/release-manifest.mjs --verify-ref HEAD` | 1107/1107，问题 0 |
| `node scripts/test-agent-preset-patches.mjs --check` | exit 0 |

### 7. 回滚与残余

- 回滚：R4-B 是三个抖音库文件的加法式改动（账本可选字段 + 一个查询函数），`git revert` 后旧账本仍可读（`reflectionOperation === undefined` 一律放行）；R4-A 是**加**一条测试，删掉即回到 51 场景。
- 残余（本轮**没有**验证）：
  1. **真实 Agent 自动调用模型**：`providerCalls` 是离线流回调计数、`promptSubmissions` 是夹具会话计数 —— 不构成"真模型被调用"的证明；归 G7 实机。
  2. 取回路径 `plugins/surfcore/lib/memory-v2-host.mjs:220-223` 不校验 `frameSamples ∈ 0..3`；两个消费者已诚实降级（`companion-sharing-store.mjs:34` 判 `unavailable()`、`douyin-companion-memory.mjs:142` 与 `douyin-companion-page.mjs:67` 显示"未确认"），但**取回层本身**仍可透出越界值。
  3. `ELECTRON_RUN_AS_NODE=1`（真实宿主给的环境变量）下 `plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs:198` 会 `AssertionError false !== true`；普通 node 与 DSH 自带 node 都通过 —— 属环境敏感性，需 G7 实机定性。
  4. 反向重放的红灯级联停在**更早**的 enqueue 级 fixture（`:203`），我的 scheduler 级 scenario 坐在同一道复用守卫后面，因此"这条 scenario 单独会红"没有被隔离证明（要隔离就得反向 scheduler 的编号来源，会牵动它前面多条 fixture）。

## 失败路径（用户看到什么 / 下一步点什么）

| 场景 | 用户看到 | 下一步 |
| --- | --- | --- |
| 取消后想确认到底写没写 | 原作业状态里带 `operationId` + `state:'unknown'`，可查真实 Host 回执 | 用原编号查询；不要新建编号重做 |
| 查回执时角色/世代已换 | `DOUYIN_STALE_CHARACTER`（中文 error + hint："刷新当前角色后重新发起"） | 刷新角色后重新发起 |
| 编号不属于当前角色 | `DOUYIN_RECEIPT_NOT_FOUND`（error + hint"查看原作业状态并使用其中的操作编号"） | 从原作业状态复制编号 |
| 页面拿到越界帧数 | 显示"稀疏画面数量未确认"（不声明没有依据的帧数） | 无需操作；上游取回层校验待下一轮 |

## 改动层级

- **接口向后兼容**：账本新增可选字段（旧账本可读可迁移）；取消的对外返回形状不变；`queryReflection` 是新增入口，不改既有 `cancel`/`reflect` 签名。
- **无新增错误码语义冲突**：`DOUYIN_STALE_CHARACTER`、`DOUYIN_RECEIPT_NOT_FOUND` 均带 `ok:false` 三件套（code/error/hint），前端可直接展示。
- **建议版本**：与 R3 同批（minor）。用户可见差异＝"取消后能查回原操作"与"越界帧数不再被页面声明"。

## 未验证

- G7 Mac 实机（隔离实例）：真实 Native SDK 发送、DSH 所带 node 的真实解析、长 TTS 跨轮询、DM 子进程退出、真实 Agent 是否自动调用模型。
- 真实 QQ / B站账号链路（本轮一律未启动、未发送）。
- `ELECTRON_RUN_AS_NODE=1` 下 native 契约脚本变红的环境定性。
- 取回路径 `memory-v2-host.mjs:220-223` 的 `frameSamples` 校验。
- 真实跨进程单次付费调用（R3 的抖音竞态测试仍标 NOT VERIFIED）。
