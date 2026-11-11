# QQ Memory V2：官方身份只读前置接口

状态：2026-11-10，P2-QQ-OFFICIAL-IDENTITY-READ run 1/3。只补 Host 身份读取前置条件，不启用 QQ Memory V2，不改变现有发送、模型会话或 native proof 规则。

## 链路与原因

认证 Host 通过现有私有 `callBridge` 调用 QQ 桥接控制台；桥接从当前配置的 SnowLuma OneBot 查询官方账号，并返回当前内存配置白名单。Host 将一次响应中的身份与可选 route 作为同一快照，分别供 `getQQState` 和 `getQQRoute(state)` 使用。

旧桥接只在 WebSocket open 时调用 `bot.getLoginInfo()` 更新 `selfUserId`，它是昵称识别/历史用途的缓存；ownerQQ 也是操作者配置。两者都不能证明当前官方登录账号。`qqMemory` 生产 factory 没有完整的 fresh 官方身份 getter。

两条方案的取舍：直接复用缓存成本低，但账号切换后会错误归属；每次从当前配置的 OneBot 查询增加三个短只读请求，但可发现断线、未知账号和查询期间换号。此处选择后者，整次网络读取共用 2500 ms timeout，不发平台消息验证。

## HTTP ABI

```http
GET /api/memory-v2/identity
x-console-token: <现有控制台令牌>
```

只允许现有控制台鉴权、回环来源、合法 Host；若携带 Origin，必须与本次 HTTP Host 同源。带任意 `x-agent-token` 或 `x-agent-call` 的请求一律拒绝，包括同时携带有效控制台令牌的请求。只接受 GET。query/body 不提供账号、白名单、route 或授权事实。

成功响应严格为：

```js
{
  ok: true,
  verified: true,
  accountId: '100',
  allowedGroups: ['900'],
  allowedPrivates: ['200'],
  route: { provider: 'configured-provider', model: 'configured-model' }, // 可省略
}
```

返回账号和白名单均为无前导零的正十进制字符串，最多 20 位；数字型官方账号必须是安全整数。白名单只从当前 `cfg.allow.groups/private` 取得，去重后返回；没有隐式加入 ownerQQ、请求参数或任意群。空白名单保持为空，不展开 `allowAllWhenEmpty` 成全局授权。

成功不返回昵称、token、凭据、会话、内存来源或其它配置。失败为 `{ok:false,code,error,hint}`，不带 verified:true；提示先确认 SnowLuma 在线和当前官方账号，需记忆处理授权时在 QQ 设置选择明确 provider/model 后重试。

## 官方身份与 route 的证明范围

桥接按当前 `cfg.snowluma.httpUrl` 和现有 accessToken 认证配置依次 POST `get_login_info`、`get_status`、`get_login_info`。每次都校验 HTTP 成功、OneBot status=ok、retcode=0 及对象型 data。只有 online 严格为 true、两次官方 user_id 相同且有效时才继续。查询前后对网关、认证、allowlist 与 QQ 模型配置快照作一致性比较；变化即失败，不混配新旧账号和配置。上游响应内容及异常详情不写入返回错误。

route 使用现有模型配置语义：`ensureChatModel` 已通过 `followsDefaultModel()` 和 `effectiveChatModel` 读取 cfg.dsh。这个只读端点仅在 `cfg.dsh.followDefaultModel === false`、cfg.dsh.provider/model 通过共享 `deriveMemoryProviderRouteId` 精确字符串校验时返回原样 pair；不修剪、不改大小写、不拼默认值。provider/model 可以包含斜线和 Unicode，Host 仍须使用共享派生函数。

跟随 DSH 默认模型或 pair 无效时省略 route。缓存默认模型、fallback 或已有 session selection 均不作为此端点的 route 依据。Host 必须保持缺 route 的 QQ 授权候选关闭；账号 verified 不等于获得处理授权。该字段描述当前显式配置目标，不声称某次模型网络请求已使用它；后续真实 selected route 与 native proof 门槛保持原契约。

## 失败与边界

- 401 / MEMORY_QQ_IDENTITY_UNAUTHORIZED：控制台令牌缺失或不匹配。
- 403 / MEMORY_QQ_IDENTITY_FORBIDDEN：Host、Origin、loopback 或 Agent 调用隔离失败。
- 405 / MEMORY_QQ_IDENTITY_METHOD：不是 GET。
- 503 / MEMORY_QQ_IDENTITY_UNAVAILABLE：网关未配置、HTTP/OneBot 信封不合法、查询失败或超时。
- 503 / MEMORY_QQ_OFFLINE：无法确认官方账号在线。
- 503 / MEMORY_QQ_IDENTITY_INVALID：官方账号无效。
- 503 / MEMORY_QQ_IDENTITY_CHANGED：本次两次官方登录查询的账号不一致。
- 503 / MEMORY_QQ_CONFIG_CHANGED：查询期间配置变化。
- 503 / MEMORY_QQ_ALLOWLIST_INVALID：当前白名单含无效身份值。

影响范围是桥接控制台的一个只读端点及 Host 后续调用者；不写生产身份缓存、配置、会话或数据库，不产生模型费用。Host 对处理 grant、policy、binding 与最终网络时序仍负责，不能把这份短时查询当成永久授权。

## 验证、生效和回滚

`node scripts/test-memory-v2-qq-integration.mjs` 和 bundled Node 同一脚本使用实际桥接 handler + 合成 OneBot HTTP 服务，检查：有效控制台、坏 token、Agent 两种标记、Host、Origin、loopback、owner/cache/query 不构成身份、fresh 换号、配置白名单变化、显式 pair 和默认模式、省略 route、offline/未知/非法响应、查询期间换号、非 GET。原有真实 Host/kernel/HTTP 但 fake DSH/OneBot 的 QQ 集成场景仍运行，包括 605 来源、撤销、epoch 恢复和生产 native proof 默认拒绝。

首轮新增测试先获得 404（端点尚未实现），实现后通过。测试不访问实际 OneBot、模型、生产 profile 或 ASR。未执行全量 audit、安装、重启、实际授权或发布。

源码生效需要未来经授权重启 QQ 桥接；本任务不执行重启。回滚仅移除新增 helper/分支及对应测试/doc，或恢复本任务备份的窄差异；不倒退先前冻结的 QQ 安全逻辑，不恢复其它会话正在修改的文件。最终 diff 和哈希交父会话独立验收。
