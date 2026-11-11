# HY4-DOUYIN-IDENTITY · 抖音官方当前账号窄 getter 契约（冻结）

> 工单：HY4-DOUYIN-IDENTITY run1/3（parent 消息 m00232）
> 本文件只冻结「接口 + 证明条件 + 失败语义」，不含接线代码。`index.js` / `memory-v2-runtime.mjs` / QQ 由 parent 独占接线。

## 1. 为什么需要这个 getter（问题，不是方案）

`plugins/surfcore/lib/memory-v2-runtime.mjs:63` 的 `resolveIdentity({channel:'douyin'})` 要求
`const state = await getPlatformState('douyin'); if (state?.verified === true && stable(state.accountId) && conversationKey === 'douyin:homepage-recommendation')`，
`:98` 的 `approvedConversations()` 用同一 state 添加 `douyin-private` / `douyin-local-sharing`。
生产组合 `plugins/surfcore/lib/index.js:250` **没有注入 `getPlatformState`**，默认 `() => null`（runtime.mjs:18）。
同时 `plugins/surfcore/lib/douyin-service.mjs` 现有公开面（`status()` → `view(c)` → `publicDouyinAccount(binding)`）只有
`{configured, nickname, uidSuffix}`，**是本地 `account.json` 的存储投影，不是官方当前账号**；
`readFeed()` 内部虽然做了 fresh SELF 三方校验，但 `:156` 只返回 `{ok:true, source, items}`，身份证明被丢弃。

parent 已明确：**禁止从 stored status/cookie 直接验证**；V2 任何失败必须 fail-closed（V1 只是初始路由，不得自动 fallback）。

## 2. 冻结接口

```
service.readOfficialIdentity(context)
  context: { characterId: string, characterEpoch: number }   // 复用既有 context 形状
  -> Promise<
       { ok: true,  verified: true, accountId: string }        // 精确 3 个键
     | { ok: false, code: string, error: string, hint: string } // 结构化失败
     >
```

- `accountId` = `parseDouyinSelf(...).identity.accountKey` = `sha256('douyin:'+uid)` 的 64 位 hex。
  它满足 runtime.mjs:11 `stable()` 的 `/^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/`，可直接作为 `getPlatformState` 返回的 `accountId`。
- **绝不输出** `uid` / `secUid` / `nickname` / `cookie` / raw identity / `binding` 全文。成功对象只有 3 个键。
- **不改变** `status()` / `account` 公开投影（`publicDouyinAccount` 保持 `{configured, nickname, uidSuffix}`）。
- **不写** `account.json` / `settings.json`；不修改 `candidate` / `pageState` 语义以外的持久化状态。
- `readFeed` / `readFeedForCompanion` / `beginLogin` / `confirmAccount` / `closeLogin` / `withTransition` / `invalidate` / `dispose` 行为全部保留。

## 3. 唯一允许的 verified=true 证明链

一次调用内，按序全部满足；任何一步不满足即结构化失败，**不得返回 `verified:true`**：

1. 入口守卫（与 `readFeed` 一致）：`transitionDepth === 0`、`matches(context)`、`!disposed`、`!active`、`enabled(context) === true`、`binding(context)?.identity` 存在。
   `binding` 只是**期望账号**（expectedIdentity），本身永远不是证明。
2. `makeOp(context, 'identity', account)` 建立独立 operation（复用既有 `generation` / `session` / `requestSeq` / `current()` 生命周期）。
3. `start(op)` 启动既有独立 browser；`findEvent(op, SELF, 0)` 取得**本次会话**首个官方 SELF 响应（`parseDouyinSelf` 强制 `sourcePath === '/aweme/v1/web/user/profile/self/'`），并 `same(first.identity, account)`。
4. 记录 `cutoff = browserStatus(op).requestSeq`，`op.identityCutoff = cutoff`，随后 `navigate(op, false)`（**reload，不翻页、不取 feed**）触发一次新的官方 SELF。
5. `findEvent(op, SELF, cutoff)` 只接受 `requestSeq > cutoff && sessionId === op.session` 的**新** SELF，再次 `same(fresh.identity, account)`。
6. `finish(op, {ok:true, verified:true, accountId: fresh.identity.accountKey})`：`finish` 先 `stop(op)`，**浏览器关闭失败原样传播**；`current(op)` 复核角色/epoch/操作代数；`op.identityFailure` 覆盖结果（收尾账号漂移也算失败）。

一律不能 `verified:true` 的反例（必须各有断言）：
开始/中途/收尾角色 epoch 变化、账号切换（新 SELF 与 binding 不一致）、stale（generation 变化）、
旧序号 replay（SELF requestSeq ≤ cutoff）、跨 session、非 SELF 路径、`is_login:false` / 解析失败、
`browserStatus` 不可用、关闭失败、`active` 已有 operation、`withTransition` 期间、`dispose()` 之后。

### 为什么必须「新 SELF 两次」

`plugins/surfcore/lib/douyin-data.mjs:3-4` 明确写了 parser 只验证形状、不验证来源/所有权；
`douyin-service.mjs:150` 已有注释 `Final ownership proof requires a fresh self response, not another feed traversal.`
`douyin-browser.mjs:131` 的 `requestSeq = ++requestSeq` 与 `:122` 的 `sessionId = randomUUID()` 提供了
「同会话 + 递增序号」的现成机制，`reload()` 走 `page.goto(HOME_URL)` 产生新的官方响应。
本 getter 复用它，不新造 browser API。

## 4. 失败契约（AGENTS.md §1.7）

所有失败 `{ok:false, code, error, hint}` 均含非空 `error` 与 `hint`（下一步动作）。
沿用 `douyin-service.mjs` 既有错误构造器，不新造错误码体系：
`DOUYIN_DISABLED` / `DOUYIN_NEEDS_AUTH` / `DOUYIN_STALE` / `DOUYIN_BUSY` / `DOUYIN_TRANSITION` /
`DOUYIN_ACCOUNT_CHANGED` / `DOUYIN_BROWSER_FAILED` / `DOUYIN_CLOSE_FAILED`（含底层 `browser.close()` 返回的原始 code）/ `DOUYIN_STATE_ERROR`。

## 5. 明确的浏览器行为与成本（RequiredEvidence）

- **会启动浏览器**：每次调用 `makeOp` → `browserFactory(...)` → `start(op)` → 独立 persistent browser（生产为 Playwright `launchPersistentContext`）。
- **会关闭浏览器**：所有退出路径经 `finish(op, ...)` → `stop(op)` → `op.browser.close()`；关闭失败不吞、原样返回（与 `readFeed` 一致）。
- **每次调用成本**：1 次 browser start + 1 次 reload（`page.goto` 首页）+ 1 次 close；**不加载推荐流、不下载媒体、不调用付费模型、不联网到真实抖音**（测试注入 fakeBrowser）。
- **并发**：与 `readFeed` / `beginLogin` 互斥（`active` → `DOUYIN_BUSY`）；`withTransition` 期间一律 `DOUYIN_TRANSITION`。
- **对比 `readFeed`**：`readFeed` 是 1 start + 2 navigate（含 feed 翻页）+ 1 close；getter 少一次 navigate、不取 feed，但**仍是重量级 I/O**。
  → 接线建议（parent 决定）：只在 `getPlatformState('douyin')` 被真正需要时调用，并考虑短 TTL 缓存；不要在每个 `resolveIdentity` 上无条件每次开浏览器。

## 6. 与 MemoryV2 runtime 的接线点（本工单不做）

```
// parent 独占：plugins/surfcore/lib/index.js:250 createMemoryV2Runtime({...})
getPlatformState: async channel => {
  if (channel !== 'douyin') return null;
  const result = await douyin.readOfficialIdentity(currentCharacterContext());
  return result.ok && result.verified === true
    ? { verified: true, accountId: result.accountId }
    : null;                       // fail-closed：绝不退化到 status/binding
},
```

失败返回 `null` 即 runtime.mjs:64 的 `if` 落空 → `resolveIdentity` 返回 `null` →
`memory-v2-host.mjs:177` 返回 `MEMORY_IDENTITY_REQUIRED`，V2 通道拒绝，不自动 fallback 到 V1 或旧历史。
冻结接口第 2 节规定 `accountId` **只传 `identity.accountKey` 本身**（即 `sha256hex` 对应的 64 位 hex，不含 `douyin:` 前缀）：
runtime.mjs:65 会自己拼 `douyin:${state.accountId}`；若误传带前缀的值，`sourceAccountKey` 会变成
`douyin:douyin:<hex>` 从而与绑定身份不一致。

## 7. 验收与证据路径

- RED → GREEN 日志：`_backups/memory-v2-douyin-identity/red.log` / `green.log`
- 原相关回归日志：`_backups/memory-v2-douyin-identity/regressions.log`
- diff：`_backups/memory-v2-douyin-identity/diff.txt`
- 测试文件：`plugins/surfcore/scripts/test-douyin-service.mjs`（已存在，就地追加；不新建 fixture 文件）
- 源码：`plugins/surfcore/lib/douyin-service.mjs`（唯一源码改动）
- 执行前备份：`_backups/memory-v2-douyin-identity/*.before`

## 8. 明确不做

不接线 `index.js` / `runtime.mjs` / QQ；不改 `douyin-api.mjs` 增加公开端点（getter 只对 Host 内部可信调用开放）；
不改 `publicDouyinAccount`；不打开真实浏览器/真实网络/真实凭据；不写测试以外的生产数据；不提交 git。

## 生产 reader 接线增量（2026-11-10）

`lib/index.js` 用 TDZ-safe 私有服务引用把 MemoryV2 getPlatformState('douyin') 接到 readOfficialIdentity，输入为调用时当前角色 ID/epoch；启动闸门关闭或服务未就绪不产生 verified。无公开status证明、无TTL缓存。runtime 对 DOUYIN 服务的 `DOUYIN_BUSY` 只映射固定 `MEMORY_IDENTITY_BUSY`，Host 保留通用错误清洗/回执优先级；候选列表跳过失败身份但不影响其他渠道。runtime/Host13组/服务测试通过，实际 desktop 安装与联合链路待总门禁。
