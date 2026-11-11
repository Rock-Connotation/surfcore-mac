# Bili V2 官方来源/写入 transport 契约

状态：HY4-BILI-OFFICIAL run3/3（协调者 R6 独立验收的跨账号 RED 已修复）。三个新增文件（模块、普通测试、本契约），**未接入生产 index/runtime，未启用 V2，未跑 native，未联网、未读取真实凭据、未发生真实平台写入**。普通 65/65 PASS（44 原有 + 14 条 run2 返工 + 7 条 run3 凭据快照，含 1 条接入冻结 `createBiliV2SourceRuntime` 的集成用例）；生产接线与独立 native 验收由协调者负责。run2 三项：Host 独占 CSRF（cookie `bili_jct` 与 `getCredentials().bili_jct` 唯一一致、缺失/冲突无 POST 前可见拒绝、comment/dm `csrf`/`csrf_token` 由 Host 重写不改解码 target/payload、dynamic 纯函数 `officialWbiQuery` 用 Host CSRF + nav WBI 材料签名固定意图）、所有官方 GET/POST 强制 `redirect:'error'` 且重定向结构化拒绝、顶层评论 root=0 走 `/x/v2/reply` 主楼列表（非零 root 仍用 `/x/v2/reply/reply`）。run3 一项：每次公开操作使用**内部不可变 Host 凭据快照**（见「凭据快照」段）。

## 为什么单独做这一层

冻结的 `createBiliV2SourceRuntime` 只负责「证明」：`getIdentity` 给出账号/会话事实，`sourceTransport.hydrate` 给出完整官方原文记录，`revalidate` 在每次 provider 请求前复验，`prepareSend` 放行后由 `bili-v2-agent.mjs` 的 worker 调 `transport.send`。之前那一层用的是 fixture 假件；**真实 Host 必须有一层官方实现**：账号只能来自官方 nav、完整原文只能来自新的官方 GET、写请求只能打到固定官方端点且由 Host 凭据构建 header。本模块就是这一层，把 `getCredentials`/`getScope`/`fetchImpl` 三个闭包留给 Host 私有注入。

两条硬规则来自协调者：`不读通知摘要当原文`、`不读 worker stdout 当可信源`。因此：

- 通知/摘要/stdout 只允许贡献**受限标识符**（rpid、type、oid、root、parent、authorMid、动态 id、私信 peer+msg_key、通知 id），任何 `message`/`content`/`coverage`/`identity`/`proof` 声明一律丢弃或整体拒绝；
- 完整原文必须是一次**新的官方 GET**，按精确 id 命中，校验作者/坐标/删除态/多媒体覆盖；找不到精确 rpid 时绝不复用 `msgfeed.mjs:112-135 resolveLatestReply` 的「取作者最后一条」兜底（那会认错 rpid）；
- `coverage: 'full'` 只由官方 GET 产生；`notification`/`telemetry` 只能是 `observed-receiver`，且 wire 里只有标识符、没有摘要正文。

## 冻结接口

```js
createBiliV2OfficialTransport({
  getCredentials,            // Host 闭包；返回 { cookie, bili_jct? }，永不外泄
  getScope,                  // Host 私有登记：getScope(job) -> { audience, target, providerRouteId }
  fetchImpl = globalThis.fetch,
  now = Date.now,
})
// -> {
//   getIdentity({ job, action, target?, signal }),
//   getAccount({ signal } = {}),                 // DELTA：无 job 的官方账号查询
//   sourceTransport: { hydrate({ job, selector, signal }), revalidate({ job, sources, signal }) },
//   transport: { send(request) },
//   close(), getStatus(),
// }
```

- factory 只供 Host 私有调用，不注册为模型工具、不通过 RPC 暴露。四个注入项必须是函数，否则构造即抛 `BILI_OFFICIAL_UNSUPPORTED`。
- 每次**公开操作开始时**调用一次 `getCredentials()`，`readSnapshot` 把 `cookie`（1..8192 字符串）与 `bili_jct`（Host CSRF 源，见 send 段）按值拷进 `Object.freeze` 的私有快照；该操作的全部官方请求都用这一份快照，不读取/不回显其它字段。`guardedFetch` 在每次网络请求前用 `assertStable` 重读并**只比对私有值**（cookie/bili_jct 相等），不一致 → `BILI_OFFICIAL_CREDENTIALS_CHANGED`；重读对象从不用于 header，也不记录/暴露/哈希凭据。所有失败与 `getStatus()` 都不含凭据。
- `getScope(job)` 必须返回 `exact` 的 `{audience, target, providerRouteId}`，`target` 服从 `targetValid`（与 source-runtime:38-40 同形），`target.audience === scope.audience`，且 `scope.providerRouteId === job.providerRouteId`。**scope 不从 model/request 任意数据认领**，也不信任 `job.accountMid` 之类的账号声明。
- `getAccount({signal})` 是 parent `memory-v2-runtime.getPlatformState('bili')` 需要的 job-less 官方查询：只返回 `{ok:true, accountMid}` 或结构化失败，**不含凭据**；复用与 `getIdentity` 完全相同的 `confirmAccount` nav helper。`getStatus()` 只是计数/结构化错误，**不得当作身份校验**。

## 身份与会话

- 每次 `getIdentity`/`getAccount`/`hydrate`/`revalidate` 都真的请求 `https://api.bilibili.com/x/web-interface/nav`，要求 `code===0 && data.isLogin===true && /^\d{1,30}$/.test(String(data.mid))`；首次成功把 mid 绑定到本 factory（`boundMid`），之后任何账号切换 → `BILI_OFFICIAL_ACCOUNT_CHANGED`。不使用 TTL，不缓存 nav 结果。
- `getIdentity` 返回 source-runtime `identity()` 所需的精确形状：
  `{ ok:true, accountMid, conversationKey, sourceAccountKey, requesterAccountKey, providerRouteId, audience, target }`；`sourceAccountKey` 与 `requesterAccountKey` 均为 `bili:${mid}:actor:${mid}`，`providerRouteId` 取 `job.providerRouteId`。
- `conversationKey`：comment=`bili:${mid}:public:${target.oid}`，dynamic=`bili:${mid}:public:dynamic`，dm=`bili:${mid}:private:${target.mid}`。`target` 显式给出时用该 target 作为 sink，`prompt`/`read`(undefined) 时用 `scope.target`；`assertTargetInScope` 禁止 private→public 升级、禁止换 kind、禁止把评论换到别的 oid/type、禁止把私信改投别的 peer。

## hydrate：完整原文的取得

selector 为 `{kind:'trigger', input}` 或 `{kind:'tool', action, args, stdout}`。

- trigger：`input.items[]` 必须是受限 locator，`strictLocator` 用 `exact(item, LOCATOR_KEYS[kind])` 拒绝任何额外键（body/identity/coverage/proof 声明）；`input.coverage === 'full'` 直接拒绝——完整覆盖只能由官方 GET 给出。空 items → `BILI_OFFICIAL_TARGET_MISSING`。
- tool：`toolLocators` 只从 `args`/`stdout`（字符串先 JSON.parse）投影出受限 ID，丢弃其它所有键；`feed`/`debrief`/`today` 的 VIDEO 输出无法用冻结 schema 表达 → `BILI_OFFICIAL_SCOPE_UNSUPPORTED`（带 `scope`），并登记进 `getStatus().unimplementedScopes`，**不伪造 full、不藏字段**。
- 每条 official record 都是新官方 GET：
  - comment（run2 双端点）：root=0 顶层评论走主楼列表 `https://api.bilibili.com/x/v2/reply?type=&oid=&pn=1..6&ps=20&sort=2`（与 `verify/comment-exists.mjs:59-80`、`fish-guard.mjs:301` 同源），非零 root 的子回复走 `https://api.bilibili.com/x/v2/reply/reply?type=&oid=&root=&ps=20&pn=1..6`。两路都精确 `String(rpid_str ?? rpid) === locator.rpid`（绝不复用 `msgfeed.mjs` 的「取作者最后一条」兜底），删除/空文本 → `BILI_OFFICIAL_ORIGINAL_DELETED`；`pictures` 非空 → `BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED`；`member.mid` 与 selector `authorMid` 不符 → `BILI_OFFICIAL_AUTHOR_MISMATCH`；6 页未命中 → `BILI_OFFICIAL_PAGINATION_NOT_FOUND`。wire 只保留 source-runtime:79-107 校验所需的受限字段。
  - dynamic：`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=&features=itemOpusStyle`，`id_str` 精确匹配、`module_author.mid` 数字；`major != null || additional != null` → 多媒体不覆盖；wire 的 `module_dynamic.major/additional` 固定为 `null`。
  - dm：`https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=50&mobi_app=web`，按 `talker_id` 找 peer，`last_msg.msg_key` 必须精确等于 selector `msgKey`，`sender_uid === peer`、`receiver_id === 当前 nav mid`、`msg_type===1`、`content` 为可解析文本。**历史（非 last）私信在仓库中没有可信的单条 GET** → `dm-history` 登记 + `SCOPE_UNSUPPORTED`，不编造端点。
  - `notification`/`telemetry`：官方 `https://api.bilibili.com/x/msgfeed/reply` 按 id 确认存在，wire 仅 `{id, kind}`（标识符），`authorMid = 当前账号 mid`、`coverage='observed-receiver'`，摘要正文不进 wire。
- 记录 `sourceKey = bili:${kind}:${objectId}`，`wireDigest = biliV2InputDigest({value: wire})`，`revision = r-${wireDigest.slice(0,16)}`，proof = `{sourceKey, revision, objectId, authorMid, audience, target, wireDigest}`。一次请求至多 32 条、禁止重复 sourceKey。proof 按 `job.jobId` 分桶登记（`registry: Map<jobId, Map<sourceKey,{proof,locator}>>`）。

## revalidate：撤销检测不是 TTL

`valid()` 在每次 provider 请求前把本 job 的全部 proof 传回。`revalidate` 必须：

1. 重新走一次官方 nav（含账号切换检测）；
2. 只接受**本 factory、本 job** `hydrate` 登记过的 proof：未知/伪造/重复 → `BILI_OFFICIAL_PROOF_UNREGISTERED`，被改过 → `BILI_OFFICIAL_PROOF_TAMPERED`，少一条 → `BILI_OFFICIAL_PROOF_SET_MISMATCH`（另一个 job 的 proof 既不接受也不计入完备性）；
3. 对每条 proof **重新发一次官方 GET**，比对 `wireDigest`/`objectId`/`authorMid`/`audience`/`target`/`revision`：变了 → `BILI_OFFICIAL_SOURCE_CHANGED`，删除或分页找不到 → `BILI_OFFICIAL_SOURCE_REVOKED`；
4. 全部一致才返回 `{ok:true, unchanged:true}`。没有任何「未过期就跳过」的分支。

## send：固定端点 + Host 凭据

worker（`bili-v2-agent.mjs:237-285`）传 `{action,url,method,headers,body,signal}` 并要求 `{http,int 200..599, body:{code:safe int}}`。

- 先丢弃 `signal`（`decodeBiliV2Request` 内部 `structuredClone` 不能克隆 AbortSignal）与**全部 worker headers**，用 `decodeBiliV2Request({action,url,method,headers:{},body})` 复用冻结解码器：端点必须精确等于 `BILI_V2_ENDPOINTS[action]`、无 userinfo/hash、action/body/method 全校验。
- worker 自带的 `authorization`/`host`/`x-forwarded-*`/`forwarded`/`via` 等凭据/路由头 → `BILI_OFFICIAL_HEADER_DENIED`；worker 自带 `cookie` 被整体丢弃（不进 deny 名单，否则真实 worker 请求会被误拒），实际请求头只由**本操作不可变快照**的 `cookie` + 固定 UA/Referer/Content-Type 构建，worker 无法覆盖 Host cookie 或目的地。
- Host 独占 CSRF（run2）：`hostCsrf(credentials)` 从 `getCredentials().bili_jct` 与 cookie 中所有 `bili_jct=` 段收集取值，**必须唯一一致**：0 个 → `BILI_OFFICIAL_CSRF_UNAVAILABLE`，>1 个或格式异常 → `BILI_OFFICIAL_CSRF_CONFLICT`，两者都在发任何 POST 之前拒绝。comment/dm：用 `URLSearchParams` 把 body 内 `csrf`（及存在的 `csrf_token`）全部重写为 Host CSRF，解码器 target/payload 不变（解码器本就忽略这两键），worker 自带 csrf 无法生效。
- dynamic 固定意图 WBI 签名（run2）：解码器仍用原始固定 URL 校验（worker 自带 `?w_rid/...` 查询串 → `BILI_V2_ENDPOINT_DENIED`）；真实 POST URL 由常量 `BILI_V2_ENDPOINTS.dynamic` + 纯函数 `officialWbiQuery({csrf, imgUrl, subUrl, wts})` 生成（复用 `dynamic.mjs:58` 的 `MIXIN_TAB`/`keyOf`/md5），WBI 材料来自新一次官方 nav `data.wbi_img`，缺失 → `BILI_OFFICIAL_WBI_UNAVAILABLE` 且无 POST。body 原样透传；签名只用 Host CSRF，不读 worker 凭据/URL。
- 所有官方 GET/POST 一律 `redirect:'error'`（run2）：`guardedFetch` 把 fetch 抛出的 `unexpected redirect` 与 3xx / `redirected===true` 统一收敛为 `BILI_OFFICIAL_REDIRECT_DENIED`，固定端点绝不跟随到未知来源。
- 实际 POST 到上述固定端点/签名 URL（不是 `request.url`），返回 `{http, body:{code, message?, data?}}`。**不做发送后二次官方核验**（避免把「发送回执」误当来源）；回执不合类型 → `BILI_OFFICIAL_RECEIPT_INVALID`。
- `transport.send` 对失败**抛**带 `code/error/hint` 的错误（worker 按异常路径处理）；其余方法一律**返回** `{ok:false, code, error, hint}`（`wrapResult`），符合 source-runtime `good()` 的取值方式与 §1.7 结构化失败要求。

## 凭据快照（run3 根因与修复）

协调者 R6 独立验收的可执行 RED：`getAccount()` 用 fake A 官方 nav(mid9) 绑定，再把 `getCredentials` 改到 fake B(mid10)，`transport.send(comment)` 仍以 B cookie 真实 POST（`navChecks` 仍为 1）。**根因**：`credentialsFor` 返回可变原对象；`confirmAccount` 只验证一份凭据，而 `officialGet`/`sendImpl`/dynamic 第二 nav 又各自可取另一份；public `send` 完全未核验账号，因此跨账号写入可在同一 factory 内发生。

修复（仅本模块）：

- `beginOperation(signal)` 在每个公开 `getIdentity`/`getAccount`/`hydrate`/`revalidate`/`send` 开头 `ensureOpen` 后，一次性取 `getCredentials()` 并 `Object.freeze` 出「按值拷贝」的私有快照 `ctx={snapshot,signal}`；`ctx` 只在该操作调用栈里传递，作为局部量而非单一全局 `currentCredentials`，并发操作互不串户；`request`/`job` 的任何字段都无法注入快照（快照只来自 Host 闭包）。
- 该操作的官方 nav、全部源 GET、WBI nav 与 POST 共用 `ctx.snapshot` 构建 header/CSRF：`officialHeaders(ctx.snapshot)`、`hostCsrf(ctx.snapshot)`、`officialGet(url, ctx)`、`guardedFetch(url, init, ctx)`。`guardedFetch` 在**每次网络请求前**先 `await assertStable(ctx)`：重读 `getCredentials()`，用 `sameCredentials` 只比对 `cookie`/`bili_jct` 私有值，不一致或重读抛错 → `BILI_OFFICIAL_CREDENTIALS_CHANGED`/`BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE`，在下一次 fetch 之前拒绝；重读对象不用于 header，不记录/暴露/哈希凭据。可变返回对象在 await 期间原地更改、revalidate 与 dynamic WBI 窗口内的切换均被钉住。
- `send` 用**同一 ctx** 调 `confirmAccount(ctx)`：官方 nav GET 与 factory 已绑定 `boundMid` 比对，账号切换 → `BILI_OFFICIAL_ACCOUNT_CHANGED` 且无 POST（钉住跨操作切换）；随后 csrf/WBI/POST 仍用同一快照，绝不再取别的凭据。
- `freshPerRead` 等值新对象、`Promise.all` 并发、job/request 注入字段、输出不泄密均有定向断言；源 GET/POST 端点、解码器、其余失败码与 source-runtime 集成断言全部保持。

## 结构化失败（全部带 code + error + hint）

`BILI_OFFICIAL_UNSUPPORTED`（构造）、`BILI_OFFICIAL_CLOSED`、`BILI_OFFICIAL_ABORTED`、`BILI_OFFICIAL_CREDENTIALS_UNAVAILABLE`、`BILI_OFFICIAL_CREDENTIALS_CHANGED`（run3：操作内凭据/账号切换，下一次网络请求前拒绝）、`BILI_OFFICIAL_LOGIN_REQUIRED`、`BILI_OFFICIAL_ACCOUNT_CHANGED`、`BILI_OFFICIAL_SCOPE_MISMATCH`、`BILI_OFFICIAL_TARGET_INVALID`、`BILI_OFFICIAL_TARGET_ESCALATION`、`BILI_OFFICIAL_TARGET_MISSING`、`BILI_OFFICIAL_SELECTOR_UNTRUSTED`、`BILI_OFFICIAL_SCOPE_UNSUPPORTED`（带 `scope`）、`BILI_OFFICIAL_OFFICIAL_UNAVAILABLE`、`BILI_OFFICIAL_PAGINATION_NOT_FOUND`、`BILI_OFFICIAL_ORIGINAL_DELETED`、`BILI_OFFICIAL_MULTIMEDIA_NOT_COVERED`、`BILI_OFFICIAL_AUTHOR_MISMATCH`、`BILI_OFFICIAL_COVERAGE_UNPROVEN`、`BILI_OFFICIAL_PROOF_UNREGISTERED`、`BILI_OFFICIAL_PROOF_TAMPERED`、`BILI_OFFICIAL_PROOF_SET_MISMATCH`、`BILI_OFFICIAL_SOURCE_REVOKED`、`BILI_OFFICIAL_SOURCE_CHANGED`、`BILI_OFFICIAL_ENDPOINT_DENIED`、`BILI_OFFICIAL_HEADER_DENIED`、`BILI_OFFICIAL_REQUEST_INVALID`、`BILI_OFFICIAL_RECEIPT_INVALID`、`BILI_OFFICIAL_CSRF_UNAVAILABLE`、`BILI_OFFICIAL_CSRF_CONFLICT`、`BILI_OFFICIAL_WBI_UNAVAILABLE`、`BILI_OFFICIAL_REDIRECT_DENIED`、`BILI_OFFICIAL_FAILED`（兜底）。`getStatus()` 只给计数/结构化错误/未实现 scope，无账号 mid、无凭据、无正文。

## 普通测试与 RED→GREEN 证据

`plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs`：69 条普通用例（44 原有 + 14 条 run2 定向返工 + 7 条 run3 不可变凭据快照 + 4 条协调者关闭/取消时序回归），fake `fetchImpl` 带严格 URL 白名单（6 个官方 GET + 3 个固定 POST），内存假凭据 `SESSDATA=HOST_ONLY_SECRET_VALUE`，`job()` 故意塞 `accountMid:'999'` 用来证明账号只认 nav。覆盖：getAccount nav/不泄密、登录失败、身份精确形状、忽略 job 声称账号、显式 target sink、private/dynamic conversationKey、private→public 升级、跨 private peer、非法 target、scope 路由不符、getIdentity 内账号切换、凭据缺失、comment 通知→full+notification、dynamic full、dm full、telemetry observed-receiver、作者/rpid 不符、摘要不能当原文、截断/多媒体、删除、分页不兜底、目标缺失、selector 信任声明、tool stdout 声明被忽略、feed/debrief/today 结构化 unsupported 并登记、完整 revalidate 重取、proof 篡改/伪造 root/丢集合、revalidate 账号切换、无 TTL 的撤销、send 固定端点+Host 头、任意 URL、非法 action/method、头注入、worker Cookie 不能覆盖、凭据不可用、dynamic/dm 端点、全入口 abort、close 后全拒、getStatus 非身份校验、每条失败都有 code/error/hint 且不泄密、无未经批准 URL；run2 追加：Host CSRF 冲突/缺失/重复凭据、worker csrf 重写不改 target/payload、Host WBI 签名动态写、worker 自带签名 URL 被拒、WBI 材料缺失、全 fetch `redirect:'error'`、真实回环 302 不跟随、root=0 主楼列表精确 rpid、非零 root 子楼端点、主楼删除/多媒体/作者不符仍拒；以及 **冻结 `createBiliV2SourceRuntime` 集成用例**（假 adapter/codec，无 ASAR、无 native）：`preparePrompt` 通过真实 `identity()/hydrate()/valid()/revalidate()` 链，`sourceCount===2`、`derivedPersisted===false`、正文含 `Complete official original.`、无 `OFFICIAL_RESPONSE_CANARY`。run3 追加 `accountFixture()`（fake A/B 账号、可原地更改/重指向/等值新对象/并发/注入字段）：跨账号凭据在 POST 前拒绝（与协调者独立 RED 同源）、可变凭据对象在 await 中原地更改在下一次 GET 前拒绝、revalidate 期间重指向在重取 proof 前拒绝、dynamic 第二 nav/WBI 窗口切换在 POST 前拒绝、每次读取等值新对象不破坏操作、并发操作各自独立快照不串户、job/request 注入 `credentials`/`snapshot`/`cookie` 无效且 `getStatus()` 与所有输出不泄密。

- run1 RED/GREEN（历史）：12 行 stub → `RED_EXIT=1`/0 PASS；完整实现 → `GREEN_EXIT=0`/44 PASS。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-{red,green}.log`。
- run2 RED（定向）：在 run1 完整 lib 上追加 14 条新用例，`RED_EXIT=1`，`PASS_LINES=44`（原有用例全过），首个失败 `FAIL Host CSRF mismatch between bili_jct and Cookie is refused before any POST :: Error: expected transport.send to reject`。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run2-red.log`。
- run2 GREEN：`GREEN_EXIT=0`，`PASS_LINES=59`（58 用例 + 汇总行），尾行 `PASS Bili official transport: 58 ordinary cases`。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run2-green.log`。
- 节点：`node --check` 两个 .mjs 均 OK；普通测试在 system Node v26.5.1 与 bundled Node v24.21.0 均 `EXIT=0`/59 PASS，从 `/tmp/surfcore-hy4-official-work` 运行；三文件 CRLF/tab/trailing-ws/末换行全部 0 问题。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run2-node24.log`。
- run3 RED（凭据快照）：在 run2 GREEN lib 上追加 7 条新用例，`RED_EXIT=1`，`PASS_LINES=58`（原 58 全过），首个失败 `FAIL cross-account Host credentials are refused before any POST (account-switch RED) :: Error: expected transport.send to reject`。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run3-red.log`。
- 协调者独立 RED 复验：`_backups/memory-v2-coordinator/bili-account-snapshot-probe.mjs`（getAccount 绑 A/mid9 → getCredentials 改 B/mid10 → send(comment)）在 run3 GREEN 上 `PROBE_EXIT=0`，`{"identityAccount":"9","outcomeOk":false,"code":"BILI_OFFICIAL_ACCOUNT_CHANGED","postAccounts":[],"navChecks":2}`，0 个 POST。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run3-probe.log`。
- run3 GREEN：`GREEN_EXIT=0`，`PASS_LINES=66`（65 用例 + 汇总行），尾行 `PASS Bili official transport: 65 ordinary cases`；bundled Node v24.21.0 `NODE24_EXIT=0`/66 PASS。日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-run3-{green,node24}.log`，diff `surfcore-hy4-official-run3-{lib,test}.diff`。

## 未覆盖 / 待协调者接线的接口（全部如实列出）

1. **生产接线未做**（越界）：`plugins/surfcore/lib/index.js` 等共享文件必须构造本 factory，把 Host 私有 `getCredentials`/`getScope`/`fetchImpl` 注入 `createBiliV2SourceRuntime` 与 `createBiliV2AgentRuntime`；本 ticket 只交付可注入实现与契约。
2. **`getScope(job)` 的 Host 登记来源未实现**：谁按 job 注册 `{audience,target,providerRouteId}`、如何与 `job.providerRouteId` 对齐、private job 怎样绑定 peer，由协调者定义。模块只做严格校验。
3. **VIDEO 输出未实现**：`feed`/`debrief`/`today` 与历史私信 `dm-history` 返回结构化 `unsupported` 并登记 `unimplementedScopes`。要支持它们必须扩展冻结的 source-runtime wire/target schema（共享接缝，越界），不能在本模块伪造 full。
4. **dynamic worker 共享接缝已由协调者修复**：managed 分支固定 endpoint、无 worker Cookie/WBI，动态操作 ID 和 `--expected-mid` 已补齐，官方 `dyn_id_str` 现可穿过 Host 白名单。真实 fork/旧 CLI/实际 Host 的独立证据见 `docs/cases/2026-11-10-bili-v2-managed-worker.md`。本 official factory 与全部生产 worker 的联合端到端接线仍待验收；dynamic detail 的真实官方网络未验证。
5. **通知种类只覆盖 `reply` msgfeed**：点赞/@/系统通知等其它 receiver 观测未实现，遇到会 `PAGINATION_NOT_FOUND`。
6. **一个 factory 绑定一个账号 mid**（`boundMid`）：设计上每次任务用新 factory；若同一 factory 要合法服务多账号，需重新设计绑定粒度。
7. **`transport.send` 失败以抛错传播**：接线时需确认 `attachBiliV2Worker` 的 dispatch 异常路径会把 `code/hint` 呈现给用户（§1.7），不要被 worker 静默吞掉。
8. **native 验收本 ticket 额度 0**：未跑 ASAR/ELECTRON_RUN_AS_NODE native cycle，未跑独立公共 Host，未验证真实官方响应字段与真实网络；本层与冻结 source-runtime、worker、生产 index 的端到端 native 由协调者独立一次验收。
9. **仓库级门禁**：按 AGENTS.md §1.5 需 `npm run test:audit`（及涉及的 `npm run test:regressions`）；本 ticket 只读运行其输出、不修改其它文件。两条均已实测 exit 0（`Audit suite: 176/176 scripts passed.`、`R1–R16 全部通过`），日志 `_backups/memory-v2-bili-official/surfcore-hy4-official-{audit,regressions}.log`。
10. **`docs/cases/*.md` 与发布交接块未写**：AGENTS.md §1.6 的 case 记录/可转发交接块属于「用户可见行为变化的提交」；本 ticket 是未接线的可注入实现、无 commit，且写边界只有三个新文件。生产接线那一轮由协调者补 case 与交接块。

## 交接

- 三个新文件均为未跟踪（`??`），无 commit/push；备份与日志在 `_backups/memory-v2-bili-official/`（gitignored）。run2 改动前的三文件快照为 `run2-20261110-170500-*`，run3 改动前为 `run3-20261110-1806-*`；RED/GREEN/Node24 日志为 `surfcore-hy4-official-run{2,3}-*.log`，协调者独立 RED 复验为 `surfcore-hy4-official-run3-probe.log`。
- 回滚：先保全当前三文件与 SHA，再按对应已验收备份恢复并重跑定向回归；不要直接删除当前继承的新文件。`_backups/.../green-bili-v2-official-transport.mjs`、`run2-20261110-170500-*` 与 `pre-*` 备份可供比对。
- 复验命令（普通、无 native）：
  `node --check plugins/surfcore/lib/bili-v2-official-transport.mjs && node plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs`
  预期 `PASS Bili official transport: 69 ordinary cases`，退出码 0。


## 协调者独立验收与末轮收口（2026-11-10）

run3 原账户切换探针已独立复跑：`BILI_OFFICIAL_ACCOUNT_CHANGED`、`postAccounts:[]`、`navChecks:2`。随后独立审查复现：`assertStable` 等待 getCredentials 期间调用 close，仍启动1次GET并返回成功。三轮工单上限已用完，协调者按回退规则在原范围收口：仅在共享 `guardedFetch` 的最后一个 await 后加 `ensureOpen(ctx.signal)`；复用原关闭/取消错误，不扩展接口或放宽权限。新增4个 first GET/final POST × close/abort 反例均通过，总69项通过；独立晚关闭/取消探针均0 fetch。证据 `_backups/memory-v2-coordinator/bili-official-late-close/`，原账户探针及原65项证据在 `bili-official-final-independent/`。该结论只接受可注入模块，不表示生产index、完整video来源、实际官方网络或桌面安装已完成。

## 精确 ID 与原件坐标增量（2026-11-10）

当前独立普通测试76项（原69保留，新增7）：unsafe numeric msg_key 即使匹配已舍入selector也拒绝；type/oid/root/parent 四字段缺失逐个拒绝，禁止从selector补写full；19位字符串/safe整数正例保真。官方各ID统一只接受字符串或安全数值转换，非安全数值为 BILI_OFFICIAL_ID_UNSAFE，缺原件坐标为 BILI_OFFICIAL_ORIGINAL_INCOMPLETE。真实写worker10项仍通过。仅fake official transport/实际CLI，尚未声称生产接线完成。
