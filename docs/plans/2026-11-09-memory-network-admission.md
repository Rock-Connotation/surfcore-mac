# Memory V2：私有 Host 网络准入与实际 LLM route 取证

日期：2026-11-10；工作树 `/Users/shizihan/Daily/Github/surfcore-memory-v2`。本轮只改 Host adapter、其隔离测试和本文。API/client/core/index/QQ/B站/预算代码未改；V1 不因此切换。没有读取正常 profile、模型路由配置或凭据，没有模型调用、平台发送、服务重启或安装包写入。

## 私有 adapter 合约

新增 JavaScript 方法：`adapter.withNetworkAdmission(handle, dispatchFunction, { signal } = {})`，是私有 Host JS seam，**不是 HTTP RPC 或 client validation ACK**。

- handle 必须是该 adapter 仍持有、未释放、未过期且当前角色/epoch 匹配的原句柄。传给 kernel 的是句柄保留的原始 `entry.context`，不克隆，不接受 caller-provided context、角色或管理权限。
- 先等待该 handle 先前的 `pending` 操作（包括 prepare/bindActualInput）。AbortSignal 能立即取消这个等待；不能把取消排在未完成绑定之后。
- 然后调用真实 `service.host.withNetworkAdmission(originalCtx, wrappedDispatch, { signal })`；kernel 与控制写入、生命周期共用 FIFO fence，最终检查完整实际输入 manifest、权限、角色、源/准备包期限。
- `wrappedDispatch` 在 kernel 同步调用它时再次执行 `entry(handle)`。因此在 kernel 队列中被 release/close 的 H 句柄不能借先前检查继续发起请求。
- 这个方法不使用普通 `operation()` 的响应后角色过滤，也不把网络 Promise 存进 `value.pending`。kernel 将已发起请求的 Promise 装箱后释放 fence，在 fence 外等待响应；后续控制写入和生命周期不必等待提供方响应。
- 回调实际调用后，原始返回对象、同步抛出和异步拒绝均交给调用方，不克隆、不转成 `ok:false`、不按新角色丢弃。调用方必须先做 usage/预算记账，再检查当前角色并决定是否采纳正文。

`dispatchFunction` 必须在自身第一次 await 之前启动实际网络，或调用实际流 iterator 的第一次 `.next()`。只返回一个尚未启动的 lazy iterable 不构成发起请求。Host 不通过猜测 async function 类型来证明这个契约；调用方和真实模型集成测试负责证明。

回调调用前的拒绝是带 `code/error/hint` 的 Error。包括 `MEMORY_HANDLE_STALE`、`CHARACTER_EPOCH_STALE`、`MEMORY_NETWORK_DISPATCH_REQUIRED`、`MEMORY_ADMISSION_SIGNAL_INVALID`、`MEMORY_ADMISSION_ABORTED`，以及真实 kernel 返回的权限/manifest/期限错误。kernel hook 缺失时为 `MEMORY_NETWORK_ADMISSION_UNSUPPORTED`，提示不要发起请求、保留 V1、先验证安装 Host hook。回调已调用后的提供方错误保持原对象，供内部记账/诊断；没有新增公开原始错误日志或 RPC。

HTTP action 白名单保持原样。隔离 HTTP 测试明确拒绝 `action: "withNetworkAdmission"`，以及 `dispatch`、`dispatchFunction`、`function` body 字段；`memory-v2-api.mjs` 和 client 未改。

## 为什么采用这个 seam

现象：普通验证与实际请求之间可能插入撤权；普通 H `operation()` 等到网络响应后再检查角色，还可能吞掉已经产生 usage 的结果。原因是验证快照不等于实际同步 dispatch 边界，输入绑定、控制提交和提供方响应分别发生在不同时间。

采用原始上下文 + kernel 同一 FIFO fence 的最终同步 dispatch：H 只补句柄生命周期与前序绑定等待，核心权限判定留给真实 kernel；响应离开 fence 后仍保留记账信息。收益是清楚的所有权、可取消等待和受控回调；成本是调用方必须正确启动实际请求并完整处理 usage。另一条路线是先 await validate/ACK 再在 adapter 外发请求：代码短，但留下检查到使用的竞态，也无法保证撤权提交与真正 dispatch 的顺序，因此不采用。

回滚：停止使用该私有 seam，保留 V1 与当前未发起的请求；按下方备份恢复本轮两个代码文件。不要用普通 validation ACK 绕过此方法，也不要为回滚触碰正常 profile。

## 隔离行为证据

测试使用真实 `createMemoryService`、SQLite worker、Host adapter 和自己的 `127.0.0.1:0` HTTP server。Worker 暂停夹具只延迟一条真实签名消息的发送，放行后仍由实际 worker 计算结果；没有伪造 kernel 成功返回。生命周期退役只操作本轮夹具句柄与角色 getter，不代表真实 DSH 会话退役验收。

| 验收点 | 实际覆盖 |
| --- | --- |
| 原始上下文 | 正常 H 句柄成功；管理上下文被 `MEMORY_ADMIN_REQUIRED` 拒绝；克隆真实 context 被 `MEMORY_CONTEXT_UNTRUSTED` 拒绝 |
| 句柄与 callback | foreign adapter、sourceStamp 当句柄、release、expiry 均零 callback；无 hook、无 callback、无效 signal 均结构化拒绝 |
| 完整实际 manifest | 先准备 violet，再准备 amber；最后 prepared 只含 amber，而保留的完整 manifest 有两项。只让 violet 过期，准入返回 `MEMORY_SOURCE_STALE`，零 callback |
| revoke-first | 预先捕获 admin 后直接提交真实撤权，确保 mutation 已排入 fence，再请求准入；撤权完成，旧 context 被拒，零 callback |
| 真正网络与 fence 释放 | 同步 callback 发起自己 HTTP server 的 fetch；server 已收到请求但扣住响应时，真实 revoke 能完成。随后角色变成 Beta，原 usage 结果仍抵达调用方，且为同一对象 |
| 原始 usage/error | 每次 callback 只调用一次；同步 provider error 与异步 rejected error 保持对象 identity 和 usage，不被响应后角色检查覆盖 |
| H 队列中的 release/close | 延迟另一 handle 的真实 ingest RPC，使准入进入 kernel 队列；release/close 目标 H 后放行 mutation，最终 wrapper 返回 `MEMORY_HANDLE_STALE`，零 callback |
| 前序绑定取消 | 实际 bind wrapper 尚未放行时 AbortSignal 使 H 等待在 300ms 内拒绝；再放行绑定，夹具干净退出 |
| 生命周期死锁 | 实际 delete 的退役回调等待 job-idle；另一个准入已进入 kernel hook 队列。abort 在 300ms 内结算，job-idle 得到释放，真实删除完成，零 callback |
| RPC 不扩权 | 现有受保护 loopback API 拒绝 admission action 与 function/dispatch 字段 |

最终证据：`_backups/memory-v2-host-network-admission/final-a37294bb-d9f1-4378-8314-2fe0e205ba8a/results.json`，含精确命令、退出码、四份 stdout/stderr 与核心源码 SHA256 快照。所有夹具保留，无删除。

从本工作树运行以下两个 target；每个命令分别用 bundled Node 和 CLI Node：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-memory-v2-host.mjs
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' scripts/test-memory-v2-client.mjs
'/opt/homebrew/bin/node' plugins/surfcore/scripts/test-memory-v2-host.mjs
'/opt/homebrew/bin/node' scripts/test-memory-v2-client.mjs
```

结果：bundled `v24.21.0` 与 CLI `v26.5.1` 的 Host 各 `13/13`、client 各 `6/6`，全部 exit0；两个 JS 文件在两种 runtime 上的四次 `--check` 通过。之前两次调试失败来自新夹具遗漏 producer IDs、以及 async admin capture 导致 mutation 尚未排队；均修正夹具，未改 core 契约。最终没有降低拒绝断言。

编辑前备份：`_backups/memory-v2-host-network-admission/before-df7799f0-959c-4896-9b54-86c1c8177580`，保留原相对路径与 SHA256 manifest。本轮没有生产环境重启需求。

## 已安装 dsh-llm 公共 API 的只读取证

安装包：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/`，版本 `0.2.2-rc.1`。`package.json` 的 main 是 `lib/index.js`；主 JS SHA256 为 `8e541fc98a11897706a122fde1db42f8b2a41b3b354ba3fcb932e9a16929ac6a`。源码导出 `LlmRuntime`，也作为 default。以下路径均相对这个包根目录。

只读取了本包源码、package metadata 和生成的公共 typert metadata，没有展开依赖链。使用 Python 按 ASAR offset 读取，并用 `ELECTRON_RUN_AS_NODE=1` 的已安装 Electron 执行 `node:fs` 只读复核。没有导入/启动 Host、LLM service 或 adapter，没有读取 profile/config。

包声明的 `lib/types/index.d.ts`、`lib/typert.host.d.ts` 在实际 archive 和 Electron 文件视图中都不存在，不能声称已经检查到独立 .d.ts 原文。`lib/typert.host.js` 保存了公共方法签名：

- `:242-243`：`async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>`。
- `:256-257`：`async prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall>`。
- `:263-264`：`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`。

| 源码位置 | 事实与使用边界 |
| --- | --- |
| `lib/index.js:2225-2266`；可读副本 `lib/types/index.js:752-802` | `prepareCall` 在 await adapter.prepareCall 之前捕获 exact provider registration；返回 frozen `config` 与一次性 `stream`。stream 校验实际 options 的 call config，复用捕获的 registration/adapterCall，而非重新按当前 registry 选 adapter |
| `lib/types/index.js:608-625`、`:650-651` | resolved model metadata 必须保持 `provider === registration.provider.id`、`id === model`；返回 exact provider/id。该包不把 opaque model alias 解析成另一个 model id |
| `lib/types/index.js:698` | standalone capability/config query 不绑定之后的 dispatch；其注释明确指向 prepareCall。仅 resolveModelInfo/resolveCall 后再普通 stream 不能证明 pinning |
| `lib/index.js:2314-2323`；`lib/types/index.js:856-874` | `adapterStream` 是 async generator。普通 stream 在第一次迭代时选择 registration 并 await adapter.prepareCall；prepared 分支直接采用捕获的 registration、modelInfo、config 和 dispatch |
| `lib/index.js:2401`；`lib/types/index.js:959-960` | `streamWithRegistration(options, prepared)` 在 JS 内部存在，并进入 `llm/stream` waterfall；未列入本包公共 typert 方法签名，内部 prepared.registration 对象也不由公共 prepareCall 暴露。不要手工伪造此内部对象来 pin route |
| `lib/types/index.js:906-918` | adapter.stream 的 iterable 还会构造 iterator 并调用 next；仅创建 stream 不等于发出请求。adapter failure 可能变成 terminal chunks，消费与 usage 处理不能只关注 Promise rejection |

在已得到实际可信 exact config 的前提下，route ID 应来自 `deriveMemoryProviderRouteId({ provider: preparedCall.config.provider, model: preparedCall.config.model })`，再以同一 preparedCall 做 dispatch。不要从未解析的 `options.model`、显示名称或默认 alias 猜测 route。prepareCall 的 adapter metadata lookup 本身是可异步的；本轮没有执行它或声称它一定不做 I/O。

本包内没有发现默认 alias / defaultModel / fallbackModel 选择的公共 API；`registration(provider)` 只查 exact registered provider。**无法仅凭此包从 opaque alias 确认全局实际默认模型或外部 fallback 的最终 route。** 外层选择器、waterfall middleware 与 provider serializer 不在本次有界查证内。父任务必须先拿到其实际选择结果，再 prepare/pin；若 fallback 换 provider/model，则需要新的 exact prepared route 与对应授权，不能复用原 route grant。这里不新增产品决策或修改路由代码。

## 父任务仍需整合与验证

将真实 QQ/Host inference 的完整实际输入绑定到该 H handle；实际调用方必须在 callback 内启动 fetch/第一次 iterator.next，并在 fence 外完整记账 usage，再做角色/权限变更后的正文采纳判断。父任务还需把实际选中 provider/model 接到 shared derive helper，验证默认 alias、fallback、waterfall 与真实 provider 的 pinning；本轮只证明安装包源码合约及隔离 HTTP/worker 行为。正常已安装 SurfCore 的全链路、真实模型、实际会话退役、Windows 与精确 Node22.13 均未据此宣布通过。发布交接：仅私有 H seam、隔离行为测试和源码取证；不改版本、不发布、不切换 V1。
