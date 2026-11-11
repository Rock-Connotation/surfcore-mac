# HY4-BILI-PUBLIC-SET · 纯 DTO 公开来源集合派生契约

来源工单 m02324；冻结接口原文见 `docs/plans/2026-11-10-memory-bili-host-contract.md:59-68`（「23:11 公开来源集合决定与接缝」）。本文只描述已实现的 helper 事实，不作产品建议、不扩权限。

## 1. 边界与冻结接口

- 仅 3 个新文件：`plugins/surfcore/lib/bili-v2-public-source-set.mjs`（helper）、`plugins/surfcore/scripts/test-memory-v2-bili-public-source-set.mjs`（ordinary 测试）、本文（契约）。证据在 `_backups/memory-v2-bili-public-source-set/`。
- 冻结签名：`deriveBiliV2PublicSourceSet({ characterId, characterEpoch, accountMid, providerRouteId, selectors, outputTarget } = {})`，同步返回普通对象。
- helper 是纯 DTO：仅两个 Node 内建 import —— `node:crypto` 的 `createHash` 与 `node:util` 的 `types`（`types.isProxy`，无外部依赖）。无 IO、无 fetch、无凭据、无 WBI、无 scope 派生、无持久化、无审批副作用，不声称 `verified`/原文/`provenance`/`full`。输入须来自 Host 官方读取，由调用方负责。
- helper 不授予任何权限；父端用返回的**完整 selector 列表**做明确审批预览，`label` 不当完整预览。

## 2. 顶层输入校验（全部不满足即固定失败）

- 顶层必须恰好 6 个键：`characterId, characterEpoch, accountMid, providerRouteId, selectors, outputTarget`，且为纯 `Object.prototype` 对象、无 Symbol 键、无 getter/非 enumerable 描述（用 `Object.getOwnPropertyDescriptors` 读 `.value`，getter 永不执行）。多/少键、数组、null 原型、class、任何 Proxy 都归失败。
- 描述符/Proxy 加固（run2，父端 m02446 5 个独立 RED）：`plainData` 在**任何** `getPrototypeOf`/`getOwnPropertyDescriptors`/`ownKeys` 陷阱之前先用内建 `types.isProxy(value)` 拒绝所有 Proxy（含无害 Proxy 与 revoked Proxy），陷阱零触发；结果用 `Object.create(null)` + `Object.defineProperty` 保存**全部**原始 own 键（含自有 `__proto__` 数据字段），使 `readExact` 的精确键数校验能抓到额外键，不会因原型 setter 丢键或污染 `Object.prototype`。
- `selectors` 改经 `plainArray`：拒绝 Proxy / 非 `Array.prototype`（array subclass）/ 自有 Symbol（含 `Symbol.iterator`）/ `length` 访问器 / 稀疏空洞 / 隐藏（非 enumerable）索引 / 额外 own 键 / 索引 getter；用读取到的 `descriptor.value` 重建新数组后再归一化，绝不对原数组 `for...of`（自定义 iterator 与索引 getter 永不执行）。顶/selector/outputTarget/array 四个边界都覆盖。
- `characterId`：字符串，`/^[a-z0-9][a-z0-9_-]{0,39}$/`（沿用 `src/core/memory-v2-contract.js:27-29`）。
- `characterEpoch`：`typeof number` 且 `Number.isSafeInteger` 且 `>0`。
- `accountMid`：精确正十进制 ID（见 §3）；safe int 归一为等价字符串。
- `providerRouteId`：字符串，`/^[A-Za-z0-9][A-Za-z0-9_:@./-]{0,255}$/`（沿用 `bili-v2-triggers.mjs:14`）。真实路由 `dsh-route:<64hex>`（`src/core/memory-v2-routing.js:8-12`）匹配该模式；route 只进入 SHA256，不直接进任何 key。
- `outputTarget`：必须恰好 `{audience:'public',kind:'dynamic'}`；不提供默认值，不扩原 policy audience。
- `selectors`：**先限长后去重**，原始数组长度 1..31（31 来源 + 1 输出 = 总 audience ≤ 32；32 个原始输入即便全重复也拒）。

## 3. 精确 ID 与 selector 归一化

- 精确 ID：字符串须匹配 `/^[1-9][0-9]{0,29}$/`（正 ID）；`root`/`parent` 额外允许 `'0'`（`/^(0|[1-9][0-9]{0,29})$/`）。数字仅接受 `Number.isSafeInteger` 且符号合法，再以 `String(value)` 复检正则后归一为字符串；19 位十进制字符串逐字保留、不 `Number()`；unsafe number / NaN / Infinity / 浮点 / 负数 / 0 / 对象 / 布尔全拒，绝不以 `String(v)` 造伪精确 ID。
- video selector 必须恰好 `{kind:'video',bvid,aid,authorMid}`：`bvid` 字符串匹配 `/^BV[A-Za-z0-9]{10}$/`（与 `bili-v2-video-metadata.mjs:2` 一致），`aid`/`authorMid` 为正精确 ID。
- comment selector 必须恰好 `{kind:'comment',rpid,type,oid,root,parent,authorMid}`：`type` ∈ `'1'|'11'|'17'`（或等价 safe int），`root`/`parent` 可 `0`，`rpid`/`oid`/`authorMid` 为正精确 ID。
- 其它 `kind`（含 DM）、额外字段、缺字段、数组冒充 plainobject、getter、Symbol 键一律拒绝。归一化不改原输入、不冻结原输入。

## 4. 稳定 canonical 与 id / key 派生

- `canonical()` 镜像 `src/core/memory-v2-contract.js:10-16`：标量 `JSON.stringify`，数组 `[..]`，对象按键排序 `{k:canonical(v)}`；非有限数归 `'null'`。`sha256(x)` = `createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex')`，输出 64 位小写 hex。
- selectors 归一化后按 `canonical(selector)` 去重，再按 canonical 字符串排序（置换/重复/「safe number ≡ 等价字符串」不改变集合）。
- `id = sha256({characterId, characterEpoch:String(epoch), accountMid, providerRouteId, selectors, outputTarget})`：角色 / epoch / 账号 / 路由 / 完整排序去重 selectors / 输出目标共同绑定；任一字段变更或增删 selector 都会改变 `id`，从而改变**全部**内部 keys，无法复用旧审批。
- `prefix = bili:<accountMid>:public-set:<id>`；`outputConversationKey = <prefix>:dynamic`；每个来源 `conversationKey = <prefix>:source:<sha256(canonical(selector))>`，与排序后 selectors 一一对应、每个物理 selector 仍保留、确定性、互不相同、无通配符。
- 这些是**集合专用内部 scope 命名空间**，不是平台原始会话 id，不是来源真实性证明；`accountMid` 与 `id` 已绑定，不同账号/不同集合天然隔离。

## 5. 返回形状

- 成功：`deepFreeze({ok:true, id, label, selectors, outputTarget, outputConversationKey, sourceConversations})`，恰好 7 个键；`selectors`/`outputTarget`/`sourceConversations` 及每个嵌套对象/数组全冻结。
- `label` ≤160 字符，仅概括「来源个数 / 账号 / 输出 public:dynamic（候选）」，不含任何 selector 原文、不含 raw body/Cookie/凭据、不声称已审批。
- `sourceConversations` 每项 `{selector, conversationKey}`，按 `selectors` 排序一一对应。
- 不返回 `verified`/`audience`/`route`/`scope`/`provenance`/`root`/`full`/raw body/无关字段。

## 6. 结构化失败（固定 4 键）

- 单一共享冻结对象 `FAILURE = {ok:false, code:'BILI_V2_PUBLIC_SET_INVALID', error:固定, hint:固定非空}`；所有失败路径返回同一个对象，故逐次 `deepEqual`。
- `error`/`hint` 为常量字符串，绝不带原始 input/body/凭据/自由 `error.message`。
- 不抛异常、不返回半集合；顶层 `try/catch` 兜住异常输入（含 throwing Proxy）仍返回 `FAILURE`。

## 7. Ordinary 测试 RED → GREEN

- 红：helper 为占位 `BILI_V2_PUBLIC_SET_INVALID/Not implemented.`，测试首例 `positive` 失败（`RED_EXIT=1`，0 PASS），日志 `_backups/memory-v2-bili-public-source-set/run1-red.log`。
- 绿：实现 §2-§6；34 个 `test()` 覆盖：正例形状/7 键/64hex id/key 格式、label 不漏原文与审批声明、全层 deepfreeze + mutation throws、determinism、19 位逐字、safe int≡string、accountMid 归一、unsafe 数（含 19 位 number / 2**53 / NaN / Infinity / 浮点 / 负 / 0）全坐标拒、comment root/parent 0 与 type 1/11/17、置换/重复/等价归一不变 id、角色/epoch/mid/route/增删 selector 变 id 与全 keys、同 selector 跨集合隔离、31+output=32 / 32 输入拒 / 32 重复拒、额外/缺失/DM/未知/数组/null 原型/class/Symbol selector 拒、非法 BV/id/type、getter 不执行（3 处 `calls===0`）、原输入不修改不冻结、失败固定 4 键无泄漏、outputTarget exact 无默认、顶层校验（含 `'a\u0000b'` / 257 长 route）、throwing Proxy 不抛、source key 确定且无通配、helper 源码无 IO/www/凭据/`fetch(`/`process.env`/`{{` 且含 `from 'node:crypto'` 与恰好 1 个导出。
- 结果：system Node `v26.5.1` 与 bundled Node `v24.21.0` 均 `PASS Bili V2 public source set: 34 cases`（`GREEN_EXIT=0` / `NODE24_EXIT=0`）；两文件 `node --check` OK；CRLF/TAB/尾空格/末换行 4 门 0；`git diff --check` 0。
- 过程中出现过一次测试自身缺陷：加 selector 后 `assertAllKeysChanged` 误要求来源数相等（`2 !== 1`）；改为 `sameCount` 参数允许新增来源合法增长并补一条 3-key 断言，未削弱任何断言伪通过。

## 8. 未覆盖（父端拥有，不在本工单写 scope）

- Host facade 接线、Runtime 集合候选/多 audience/重派生身份隔离、真实 Worker 测试、管理 API 完整集合预览、可见 UI 之前/之后场景证据、native/index 激活与真实 official 读取——全部由父端负责。
- helper 不验证官方原件真实性、不读写快照、不派生 provider route、不落 provenance/root；这些输入由父端 Host 提供与守护。
- 契约不新增框架、通配符、「所有公开来源持续共享」或私信参与；私信始终隔离（m02324 产品决定）。

## 9. run2 描述符/Proxy 加固（m02446，同 3 文件）

- 父端 run1 未接受：Node24 独立 5 个真实 RED（`_backups/memory-v2-coordinator/bili-public-set-integration/helper-descriptors-red.json`）显示自有 `__proto__` 字段、数组索引 getter、`Symbol.iterator` getter、顶层/selector 无害 Proxy 都被接受且触发回调。根因：run1 `plainData` 结果用 `{}` + `result[key]=descriptor.value`（自有 `__proto__` 触发原型 setter 丢键）、`derive` 直接对原数组 `length`/`for...of`（getter/iterator 执行）、`plainData` 先 `getPrototypeOf`（Proxy 陷阱）。
- 修法见 §2：内建 `types.isProxy` 前置拒绝、`Object.create(null)` 安全存键、新增 `plainArray` 用描述符重建数组。无外部依赖、无框架、不改变 §1/§3–§6 的冻结返回/失败/无 IO 语义；`FAILURE` 仍是单一共享 4 键冻结对象，非法输入不抛、不改、不冻原输入、不污染原型。
- 新增 7 个 ordinary 测试（共 41）：自有 `__proto__` 四边界拒、无害 Proxy 四边界拒且 `calls===0`、数组索引 getter/`Symbol.iterator` getter/索引访问器拒且 `calls===0`、plainobject 访问器三边界拒且 `calls===0`、array subclass/稀疏/隐藏索引/额外键拒、敌意输入不改不冻不污染原型、所有敌意失败为同一固定 4 键对象（互相 `deepEqual`）。原 34 断言全部保留，未删断言、未改断言伪通过。
- RED：helper 仍为 run1 版本时，Node26 与 Node24 均 `RED_EXIT=1`、0 PASS，首失败 `FAIL AssertionError [ERR_ASSERTION]: root own __proto__: ok false`（`true !== false`）。GREEN：system Node `v26.5.1` 与 bundled Node `v24.21.0` 均 `PASS Bili V2 public source set: 41 cases`（`GREEN_EXIT=0` / `NODE24_EXIT=0`）；两文件 `node --check` OK；CRLF/TAB/尾空格/末换行 4 门 0；`git diff --check` 0；helper `{{`=0、单一 `export function deriveBiliV2PublicSourceSet`、`from 'node:crypto'` 保留。
- 证据 `_backups/memory-v2-bili-public-source-set/`：`run2-pre-{helper.mjs,test.mjs,contract.md}`（改动前字节快照）、`run2-{red,red-node24,green,green-node24}.log`、`run2-{helper,test,contract}.diff`、`run2-{helper.mjs,test.mjs,contract.md}` 快照、`result.md`。
- 仍未覆盖（父端拥有）：Host facade / Runtime 集合候选 / 管理 API 完整预览 / 可见 UI 之前之后 / native+index 激活 / 真实 official 读取与审批副作用，均不在本 helper 写 scope。
