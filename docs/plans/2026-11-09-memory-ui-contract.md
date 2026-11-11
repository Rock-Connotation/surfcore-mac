# P4：既有记忆卡内的 V2 运行管理契约

2026-11-09。设计依据：`/Users/shizihan/Downloads/SurfCore_Memory_Design_20261109.md` §§6.4–6.6、7、8。范围为现有设置窗口的记忆卡区域，沿用 `client.js` 的 React、按钮、颜色、排版、浅深色 tokens；其他设置面板保持原行为。

## 链路与取舍

`MemoryTab` → `MemoryV2Panel` 加载包装器 → 同源 `GET /dsh-surfcore/api/memory-v2/panel-client` → `createMemoryV2Panel(React, { api, Btn, fmtTime })`。包装器传入当前角色 key 与可选 `overview.memoryV2`，实际管理能力仍以加载后的 status 为准。模块仅在记忆页打开时加载，无外部资源、模型调用或后台轮询。模块加载失败在原位置显示 `MEMORY_PANEL_NOT_READY` 和“重载 V2 入口”。

选择独立、注入宿主依赖的小模块，而非把整个管理器继续堆入 7000 行 client：前者复用生产 React 和视觉 tokens，可直接做隔离行为测试，增加一个 Host 静态模块路由；后者省路由，但客户端维护与测试耦合更重。Parent 负责模块路由及全部后端适配。

当 status.backend 为 `v1`，原记忆卡及全量卡的设置/整理语义保持不变，V2 明确标为影子管理。当后端为 `v2`，隐藏旧卡的写入入口；双向脱敏同步面板仍保留。页面不会自行启用 V2；启用按钮始终关闭，Windows/精确 Node 的未知门槛仍显示为未知。

## HTTP 边界

所有路径位于 `/dsh-surfcore/api` 下。JSON 返回 `ok:false` 时，即使 HTTP 200，界面也必须显示 `code / error / hint`。缺少字段显示“未知”或空列表，不推断成功数、覆盖度、免费成本。每个请求上限 12 秒；刷新/重试均由用户显式发起。

`GET /memory-v2/status` 最小成功结构：

```js
{
  ok: true,
  backend: 'v1' | 'v2',
  revision,
  storeGeneration,
  character: { id, epoch, name },
  capabilities: {
    shadow, activation, backup, restore, purge,
    organize, identity, migration, removeHot, correct?
  }, // 每项只有 true 才开放对应操作
  worker: { state, code?, error?, hint? },
  counts?: { sources?, committed?, rejected?, review? },
  queue?: { pending?, highWater?, unsavedSince? },
  lastSuccessfulIngest?,
  lastReceipt?: { source?, selection?, index? },
  backups: [{ id, label?, verified? }],
  operations: [{ operationId, action?, state?, phase?, hint? }],
  policies: [{ id, label? }],
  approvedConversations: [{
    id, label?,
    processorScopes?: ['local' | 'configured_model' | { id, label }]
  }],
  bindings?: [{ id, platform, accountId, personId }],
  budget?: { settled?, reserved?, unknownHolds?, cost? },
  migration?: {
    snapshot?, highWater?, checkpoint?, imported?, quarantined?,
    gates?: { windows?, exactNode? }
  },
  storage?: {
    activeBytes?, hardLimitBytes?, spoolBytes?, indexBytes?, vector?,
    media?, backupBytes?, freeBytes?
  }
}
```

来源接纳 `accepting / queued_durable / committed / commit_unknown / failed`、认识选取 `candidate / review / committed / reused` 与索引 `ready / pending` 分开呈现，没有以单一绿色“记住了”合并。后台错误在当前页面可见并带下一步。

`POST /memory-v2/manage` 统一请求：

```js
{
  action,
  payload,
  expectedRevision,
  operationId, // 新的显式操作生成 UUID；预览与执行复用同一个
  characterId,
  characterEpoch
}
```

actualPayload 为实际执行参数，不含 `preview` 与 `payloadDigest` 元字段。递归按对象 key 排序、保留数组顺序后的 JSON UTF-8 SHA-256 为 payloadDigest。预览请求 payload 为 `{ ...actualPayload, payloadDigest, preview?: true }`。专用预览名不加 preview 字段，通用操作预演加 `preview:true`。成功预览必须精确返回：

```js
{ ok: true, revision: expectedRevision, payloadDigest, preview: { ... } }
```

UI 不把 payloadDigest 当作 core previewDigest。Host 缓存同一 operationId 对应的 core previewDigest、实控角色/epoch、具体选项，执行时复核。执行 payload 为 `{ ...actualPayload, payloadDigest }`，沿用预览 operationId、修订与角色。UI 显示实际载荷、摘要、角色、状态修订和操作编号，只有再次点击“确认执行…”才发送执行。预览过期或状态变化需要重新预演，不自动重付费。

| 界面操作 | 预览 action | 执行 action | actualPayload | capability |
| --- | --- | --- | --- | --- |
| 备份 | preview_backup | backup | `{}` | backup |
| 恢复 | preview_restore | restore | `{ backupId }` | restore |
| 删除来源与派生 | preview_delete | request_delete | `{ mode:'delete_roots', recordId, recordRevision }` | purge |
| 移出热记忆 | remove_hot + preview:true | remove_hot | `{ recordId, recordRevision }` | removeHot（独立且默认 false） |
| 禁止再次使用 | suppress + preview:true | suppress | `{ recordId, recordRevision }` | purge |
| 纠正认识 | correct + preview:true | correct | `{ recordId, recordRevision, content }` | correct（独立且默认 false） |
| 继续清理 | continue_delete + preview:true | continue_delete | `{ operationId: 原清理任务编号 }` | purge |
| 影子迁移 | preview_migration | migrate | `{ snapshotId: migration.snapshot }` | migration |
| 配置共享 | configure_policy + preview:true | configure_policy | `{ conversationId, processorScope }` | shadow |
| 撤回共享 | revoke_policy + preview:true | revoke_policy | `{ policyId }` | shadow |
| 从此账号登记人物 | create_person + preview:true | create_person | `{ platform, accountId }`（无 personId） | identity |
| 关联账号 | bind_account + preview:true | bind_account | `{ platform, accountId, personId }` | identity |
| 解除关联 | unbind_account + preview:true | unbind_account | `{ bindingId }` | identity |
| 手动额外整理 | organize + preview:true | organize | `{ optIn:true, manual:true }` | organize |
| 恢复处理 | resume + preview:true | resume | `{}` | shadow |

预览展示的可选字段：`sources / derivedVersions / retainedCopies / postBackupSources / quarantine / accessRevoked / activeStorePurged / retainedCopiesPurged / currentControls / budget`。未提供即显示未知，不补零。恢复说明当前控制和额度不回退、备份后新来源合并、缺控制只可隔离；删除说明访问停止→活跃库清理→受管理副本清理分别确认，手动导出等不受管理副本不在承诺内。

纠正能力不能由 `shadow:true` 推断。当前后端的纠正控制仅接受已经持久化的替代版本指针，不接受自由文本；本 UI 保留未来真实版本创建工作流的载荷形状，只有后端显式返回 `capabilities.correct:true` 才可预览或发送正文，当前生产适配必须保持 false/缺省。

提交返回 `commit_unknown`、`MEMORY_COMMIT_UNCERTAIN`、`MEMORY_COMMIT_UNKNOWN`，或网络/超时/5xx 结果不确定时，保留原操作编号并锁住新 mutation，等待显式“核对提交状态”：

```js
GET /memory-v2/receipt?operationId=SAME_ID
// 成功形态：
{ ok:true, operationId:SAME_ID, state:'committed' | 'failed' | 'commit_unknown', receipt?: { state, code?, error?, hint? } }
```

阶段识别同时检查 result、result.receipt、异常 e.data 及 e.data.receipt；`retry:query_receipt`、`sourceState:commit_unknown`、`operationState:unknown|completed_before_cancel` 都强制保留原编号。包括 HTTP200 `ok:false / MEMORY_WORKER_DIED`，以及 HTTP409 `CHARACTER_EPOCH_STALE / sourceState:committed / operationState:completed_before_cancel`；不能因通用错误码或已经提交的 sourceState 清空未知操作。即使 `ok:true` 或回执包含旧的 committed 别名，规范阶段仍优先，继续查询原回执。

回执编号不匹配显示 `MEMORY_OPERATION_CONFLICT`；不会另造编号重发 mutation。已提交仅称“已确认提交”，具体清理/索引阶段仍看 status，不宣称全部完成。status.operations 中的 commit_unknown 也可恢复待核对入口。角色/epoch 或修订变化使旧预览不能执行；后端必须继续承担跨角色竞态和权限复核。

`GET /memory-v2/search?q=...&limit=20`：仅管理员检查当前角色。响应 `{ ok, records:[{ id, revision, kind, content, certainty, status, validFrom?, validTo?, recordedAt?, roots?, links?, coverage? }], code?, error?, hint? }`。UI 只渲染最多返回的当前角色记录，不把管理员检查历史加入 prompt，不提供 SQL、文件或任意路径输入。备份/会话/处理范围/已有记录从后端列表选取；人物关联必须填平台稳定账号与人物编号，不按昵称自动合并、不扩大跨域权限。

## 验证与视觉证据

行为测试直接执行生产 `createMemoryV2Panel`，以轻量 hooks 夹具检查稳定 operationId、重复确认、原编号回执、能力关闭、可见结构化错误、失败不轮询、摘要不匹配、角色/epoch 与修订变化、当前角色搜索和独立管理动作：

```bash
node plugins/surfcore/scripts/test-memory-v2-ui.mjs
node plugins/surfcore/scripts/test-client-contract.mjs
npm run test:memory-card-wiring
npm run test:memory-card
npm run test:audit
node --check plugins/surfcore/lib/client.js
node --check plugins/surfcore/lib/memory-v2-panel.mjs
git diff --check
```

真实组件浏览器夹具只绑定 `127.0.0.1` 随机端口，在自己的新 headless Chrome context 中运行，阻断所有非夹具源请求；不访问当前 DSH 或生产浏览器、不连接模型、不安装依赖。用本机已有 React19/react-dom/scheduler 的 node_modules 路径：

```bash
MEMORY_UI_REACT_DEPS=/existing/node_modules node scripts/test-memory-v2-ui-visual.mjs
```

该夹具使用实际生产 client、模块和 ReactDOM，不是静态 After mockup。固定情景为 V1 当前卡 + V2 影子库、可靠排队来源/待审认识/待完成索引、额度不足可行动错误、未完成清理。浅色，桌面 1440×1000、手机 390×844。Before 在首次源文件编辑前由原组件生成；After 两轮合计（完整构建后首轮检查→一次修复批次→一次确认），未增加后续视觉轮次。自动检查横向无溢出、键盘聚焦可见、输入标签、禁用启用 V2、真实搜索、一次 mutation 及原编号回执、HTTP200 失败可见。

成对捕获与请求证据：

- `_backups/memory-v2-ui/before-desktop-light.png`
- `_backups/memory-v2-ui/before-mobile-light.png`
- `_backups/memory-v2-ui/after-desktop-light.png`
- `_backups/memory-v2-ui/after-mobile-light.png`
- `_backups/memory-v2-ui/before-evidence.json`
- `_backups/memory-v2-ui/after-evidence.json`

Before/After 的浏览器 viewport、主题、旧卡数据与场景相同；fullPage 高度随新增内容变化。截图是隔离 mock API 的生产组件验收，不能证明生产后端已就绪。测试所用 Node 为本机 v26.5.1；此结果不构成最低精确 Node 或 Windows 的 P0 证据。

## 生效、回滚与交接

编辑不会自动安装或重启。Parent 完成 Host 路由/权限/核心适配后，在隔离后端验收：模块路由 JS MIME、真实返回形状、角色切换拒绝、预览缓存与过期、未知账单与回执、删除阶段、恢复屏障、迁移 ACL 隔离、V1 旧控件与 V2 的路由隔离。发布会话另行安装并刷新设置窗口。

原 client 备份位于 `_backups/memory-v2-ui/original/client.js`。回滚仅撤销本任务 client 的 30 行 glue 与新增模块/测试/契约文档，保留父任务并行改动；无需迁移用户数据。Parent 负责总 case、发布交接、后端集成及制品清单，本 UI 子任务不触及这些越界文件。

## 本次执行结果（P4-UI run1/3）

- `test-memory-v2-ui.mjs`：通过；稳定操作编号、未知回执、能力关闭、可见结构化失败、角色/修订竞态与当前角色检查。
- 真实组件浏览器 Before/After：两端通过；After 请求证据 5 条（2 次 status + 1 次预览 + 1 次执行 + 1 次原编号回执），另含搜索、权限字段及故障断言。无页面脚本错误。
- 既有 `test-client-contract.mjs`、`test-memory-card-wiring.mjs`：通过。
- `npm run test:memory-card`：29/29 通过；`npm run test:audit`：176/176 脚本通过。
- 四个 JS/MJS 文件语法检查、`git diff --check`：通过。
- 最终一次 `impeccable detect --json plugins/surfcore/lib/client.js plugins/surfcore/lib/memory-v2-panel.mjs` 返回 `[]`；完整证据 `_backups/memory-v2-ui/impeccable-detect.json`。
- 首轮发现的夹具导航断言位置不正确已在唯一修复批次调整；最终确认无未处理 UI 发现。后端与生产接通验证仍交由 Parent，不把隔离 mock 结果计为生产能力。

### R6 定向返修（P4-UI run2/3）

父代理独立验收已接受原四张成对捕获与布局。本轮只修状态逻辑/能力门控及测试文档，不改样式、不新增截图或视觉轮次。返修前五文件副本保存在 `_backups/memory-v2-ui/pre-review-run2/`。

1. 提取 `requiresReceipt`，覆盖规范阶段、嵌套回执、HTTP200 ok:false、HTTP409 提交后取消、传输失败；未知时锁住后续预览与提交，保留原 operationId，只显式查询原回执；错误原 code/hint 同时保持可见。
2. `correct` 采用独立 capability，缺省/false 时即使 shadow:true、输入非空也不发送任何预览或正文。正向测试与视觉夹具显式声明 correct:true 以代表未来已实现真正版本创建工作流。

定向状态测试、既有 client-contract、模块/测试/视觉脚本语法及 git diff --check 均通过。按父代理指示不重复昂贵审计或已接受的视觉捕获；原最终 impeccable `[]` 证据保留，未重复检测。返修增量补丁位于 `_backups/memory-v2-ui/run2-review-repair.patch`。

### 独立移出热记忆能力冻结（P4-UI-CAPABILITY run1/3）

`remove_hot` 只接受 status.capabilities.removeHot===true；缺省/false 都关闭，不再由 purge:true 推断。Management `getRuntimeStatus` 将显式返回 removeHot；当前 core 没有 remove_hot，必须返回 false。`suppress / request_delete / continue_delete` 继续跟随各自现有 purge 门控。本次生产改动仅为 capabilities 映射的 `remove_hot: 'purge'` → `remove_hot: 'removeHot'`，不改样式、控件或 client.js。

修改前四文件已备份到 `_backups/memory-v2-ui/capability-run1/before-source/`。新增夹具模式 `--capability-before` 使用该真实旧模块、`--capability-after` 使用实际新模块；同一真实 production client、同一 ReactDOM、同一 `purge:true / removeHot:false` 数据及已检索记录、浅色、1440×1000 / 390×844。Before 在修改 production 模块前生成，没有复用旧 V1 截图。一批次完整 Before/After 已生成并检查；桌面各为1440×1000，手机 fullPage各为390×1189（viewport390×844），无横向溢出。

证据目录 `_backups/memory-v2-ui/capability-run1/`：`before-desktop-light.png / after-desktop-light.png / before-mobile-light.png / after-mobile-light.png`，以及 `before-evidence.json / after-evidence.json`。两个 JSON 的 scenario、fixtureState、viewports、theme、client hash、fixture hash 完全一致；生产模块差异经逐字校验仅是上述单个映射，页面脚本错误均为空。

定向测试覆盖 removeHot 缺省/false/true：关闭时直接调用 disabled handler 也无任何预览或执行请求；true 可发送 remove_hot 预览；purge:true 时 suppress 与 root delete 仍可预览。此前规范回执未知阶段、原编号锁和正确能力门控的全部断言继续通过。client-contract、语法与 git diff --check 通过。不重复昂贵审计。最终本 brief 一次 impeccable detect 结果存放 `impeccable-detect.json`；生产单行补丁 `capability-ui.patch`，本 brief 四文件完整增量 `capability-task.patch`。

复现成对捕获：

```bash
MEMORY_UI_REACT_DEPS=/existing/node_modules node scripts/test-memory-v2-ui-visual.mjs --capability-before
MEMORY_UI_REACT_DEPS=/existing/node_modules node scripts/test-memory-v2-ui-visual.mjs --capability-after
```

### 从已验证账号登记人物（P4-UI-PERSON-REGISTRATION run1/3）

现有身份表单新增「预览从此账号登记人物」，沿用现有按钮、平台与稳定账号字段；不要求填写关联人物编号。空账号（含空白）或 identity 能力关闭时按钮禁用，直接调用处理器也不能发送请求。旧 bind_account / unbind_account 载荷与人工填写已有编号的流程不变。

登记动作精确为 `create_person`，实际载荷仅 `{platform,accountId}`；预览沿用同一 action 加 payload.preview=true，客户端计算真实载荷 SHA-256，并复用同一 operationId、expectedRevision、characterId、characterEpoch 发实际确认：

```js
{ action: 'create_person',
  payload: { platform: 'qq', accountId: '<稳定账号>', payloadDigest: '<actual canonical payload SHA-256>', preview: true },
  expectedRevision, operationId, characterId, characterEpoch }
// 明确确认后复用以上编号、角色、修订与摘要，仅移除 preview:true。
```

预览说明建立新人物及该账号的锚点绑定，不按昵称合并、不自动扩大跨平台权限。UI 不生成人物编号、不伪造预览或绑定；Core 必须检验账号来自当前角色已经持久化且可验证的稳定来源 actor，不能把任意输入字符串变成 authority。不支持或来源不满足时完整显示服务的 code/error/hint。只有服务返回的 status.bindings 显示真实人物编号，供原有关联流程人工使用，不增加人物列表或权限表单。

明确提交成功后仅该动作自动 GET status 并应用实际绑定；若结果未知，保持原 operationId 锁，显式核对回执确认 committed 后再 GET status。刷新失败可见且可手动刷新，不重新登记、不伪称未保存。此分支复用原规范阶段检测和角色/epoch 过期防护。

修改前四文件副本：`_backups/memory-v2-ui/person-registration-run1/before-source/`。本轮生产 UI 只改面板模块，未改 client.js、样式或其他面板。成对证据目录同为 `person-registration-run1/`：`{before,after}-{desktop,mobile}-light.png`、`{before,after}-evidence.json`。Before 使用修改前真实模块；After 使用当前真实模块。两者相同 production client、fixture hash、fixtureState、浅色、1440×1000 / 390×844，身份页展开且稳定账号相同、personId 为空；桌面 fullPage1440×1000，手机 fullPage390×1237（viewport390×844）。全部四图已检查且无横向溢出、无页面脚本错误，新增按钮沿用既有布局。

状态测试通过：空账号/identity:false 直接处理器零请求；identity:true 真实预览和提交使用同 UUID、CAS角色、摘要、无 personId；服务不支持显示 code/hint 且不提交；未知登记锁住再次操作，原编号回执确认后刷新真实绑定；此前 removeHot/correct 能力及规范未知阶段测试继续通过。浏览器 After 请求记录为 status×2、create_person预览、create_person单次确认、status刷新，共5条；该登记服务是隔离模拟 API，仅证明 UI 传输与呈现，不宣称真实 Core 已接通。

定向 UI 测试、client-contract、三文件语法检查和 git diff --check 通过。按工单未运行全量 audit/ASR。最终本工单唯一一次 impeccable detect 结果记录 `person-registration-run1/impeccable-detect.json`；增量补丁为 `person-registration-ui.patch`（模块）和 `person-registration-task.patch`（四文件）。

复现捕获使用现有本地 React 依赖路径：

```bash
MEMORY_UI_REACT_DEPS=/existing/node_modules node scripts/test-memory-v2-ui-visual.mjs --person-before
MEMORY_UI_REACT_DEPS=/existing/node_modules node scripts/test-memory-v2-ui-visual.mjs --person-after
```
