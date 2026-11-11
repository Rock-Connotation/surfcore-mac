# Memory V2 桌面 Host 私有 native 环境加载适配 — 冻结契约

## 1. 问题
`createIsolatedNativeRoot` 要求调用方提供真实 Cordis 模块集合、真实 LLM facade 与其同步 owner context，
以及 dsh-llm 的 6 个 codec 类/函数。现有消费者（`test-memory-v2-bili-sources.mjs`、
`test-memory-v2-bili-agent.mjs`、`test-memory-v2-native-root.mjs`）把 11 个包用硬编码 `/Applications/...`
或 `createRequire` 在测试夹具里加载；生产组合侧还没有一个「只从桌面 Host 私有资源取真实模块」的入口。
本适配只负责**加载与校验**，不改 root factory、不改任何现有服务。

## 2. 冻结接口
```
export async function loadMemoryV2NativeEnvironment({ ctx, resourcesPath = process.resourcesPath } = {})
  -> Promise<Object.freeze({ nativeModules, nativeCodec, llm, getLlmHookContext })>
```
- 任何失败都 `throw` 一个 `Error`，且带 `ok:false`、`code:'MEMORY_NATIVE_ROOT_UNSUPPORTED'`、
  非空 `error`、非空 `hint`。**不返回降级对象、不继承父工具、不伪造通过。**
- 只允许从 `ctx` 与 `resourcesPath` 取值；公开请求/job 传入的 `nativeModules`/`nativeCodec`/`llm`/
  `moduleUrl` 等额外字段一律不读取（接口只有两个形参，其余键被忽略）。
- `nativeModules` 严格是 `memory-v2-native-root.mjs:10` 的 10 个函数 + `nativeExecutor` 命名空间 +
  `isAgentLoopRequest`；`nativeCodec` 严格是 dsh-llm 的 6 个导出。
- `llm = ctx.get('llm')`；`getLlmHookContext` 是闭包，永远返回**加载时捕获的同一个** `llm.ctx`。

## 3. 模块来源（唯一允许的做法）
- 固定 11 个包名：`cordis`、`dsh-session-projection`、`dsh-session`、`dsh-agent`、
  `dsh-system-prompt`、`dsh-tools`、`cordis-plugin-loader`、`dsh-agent-loop`、
  `dsh-agent-preset-registry`、`dsh-tool-executor-native`、`dsh-llm`。
- URL = `pathToFileURL(path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href`。
- 只经真实 `ctx.loader.import(url)` 加载。**不用 `require`/`createRequire`、不拷贝私有模块、不硬编码
  `/Applications`、不用 `process.cwd()`、不接受环境/调用方给的任意 URL 或包名。**
- 导出映射：`Context=cordis.Context`；9 个默认导出取 `.default`；`nativeExecutor` 取整命名空间
  （必须含 `apply` 函数）；`isAgentLoopRequest=dsh-llm.isAgentLoopRequest`；
  codec 6 项取 dsh-llm 同名导出。
- 资源缺失 / 导入失败 / 缺任一导出 → 结构化拒绝，并把包名写进 `error`。

## 4. 校验（缺一即拒绝）
1. `ctx` 有 `get` 与 `loader.import` 函数；`resourcesPath` 是非空绝对本地路径、无 URL scheme、
   无 `..` 穿越段。
2. 11 个命名空间全部可取；每个必需导出是 `function`；`nativeExecutor.apply` 是 `function`；
   6 个 codec 全是 `function`。
3. `llm.prepareCall`/`llm.stream` 是 `function`。
4. `owner = llm.ctx`：用**加载得到的** `nativeModules.Context.is(owner)` 判定为真实同步 Context；
   `owner.on` 是函数、非 thenable、`owner.root === ctx.root`。
5. 返回顶层对象与 `nativeModules`、`nativeCodec` 全部 `Object.freeze`；
   不改原 Host 模块 exports、不改 `ctx.baseUrl`、不改 `ctx.root`、不注册服务。

## 5. 普通测试矩阵（默认离线，不触发 native）
缺 ctx / 缺 loader / 缺或非法 resourcesPath / 导入失败 / 每个模块缺导出 / 每个 codec 缺导出 /
缺 `isAgentLoopRequest` / 缺 `nativeExecutor.apply` / 缺或坏 llm / 非真实或跨 root 或 thenable owner /
注入字段不被采信 / 最小良好环境的固定 URL 顺序、freeze、owner 闭包、零网络 URL、
`ctx.baseUrl`/`ctx.root`/模块导出未被改动。
不是「数导出个数」的镜像测试：每条都断言拒绝码或真实行为。

## 6. 唯一 native 试验（显式开关）
- 仅 `SURFCORE_MEMORY_V2_NATIVE_ENVIRONMENT=1` 且在 Electron Node 下运行；普通 runner
  （`scripts/run-memory-v2-tests.mjs:42`）会清掉该前缀变量，默认绝不执行。
- 独立实际 `new Context()`，挂真实 `dsh-system-prompt`/`dsh-tools`/`dsh-llm`/`cordis-plugin-loader`，
  `globalThis.fetch` 一律拒绝并记账。
- 经真实 `ctx.loader.import` 预载 11 个固定 URL，再调用本适配，断言 owner 保真、freeze、codec=6。
- **不注册任何 adapter、不调 provider、不生成 agent、不发 prompt**；本试验也**不证明**完整
  `llm/stream` hook 实际路径，那是父端后续 Bili/QQ 组合 native 验证的范围，此处不假称已证明。
- `ctx.get('llm')` 每次返回新的 Cordis traceable proxy，不能用 `assert.equal(env.llm, ctx.get('llm'))`
  比较对象身份（deep 比较会触发 proxy 的 `href` trap）。改断言 `prepareCall`/`stream` 为函数、
  `env.llm.ctx === env.getLlmHookContext()`、`ctx.get('llm').ctx === env.getLlmHookContext()`、
  `owner.root === ctx.root`、`Context.is(owner)`：真实能力与同一个同步 owner 缺一即失败，不做容错跳过。
- 把结果原样传入**未改动的** `createIsolatedNativeRoot`，断言 `isolated.ctx.root !== outer.root`、
  `isolated.getLlmHookContext() === owner`、干净 `close()`（有 `getStatus` 时 `activeHandles=0`、
  `activeTools=0`、`closed=true`）。
- 外网 0；不跑完整来源/Bagent 循环。

## 7. 明确不做
不改 `memory-v2-native-root.mjs`、`index.js`、Bagent、Source、runner、父端 probe；不新增依赖或注册框架；
不读 profile / 公共 Root / 真实凭据 / 平台；不 commit、不跑全局门禁、不发版。
边界外接口若必须变动 → clean hand_back 给 parent。

## 8. 证据与回滚
全部落在 `_backups/memory-v2-native-environment/`：`red.log`、`green.log`、`native.log`、
`static.log`、`result.md`、RED 候选备份、三文件 SHA。回滚 = 删除 3 个新文件（均为新增，
不覆盖任何既有文件），无需恢复其他模块。
