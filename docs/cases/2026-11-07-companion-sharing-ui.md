# 看完后的本机伙伴分享与可回复聊天

## 现象

- 用户希望视频看完后能自然分享一个新发现，在 DSH 内直接回复；原发现日记、少女立绘、原操作错误和角色切换/关页护栏都要保留。
- 旧页面只有发现日记与受控观看操作，没有分享开场、未读入口或本机聊天；DSH 侧栏也没有伙伴入口。
- 本次影响限于 DSH 内的日记页与侧栏入口。聊天只基于共享 API 返回的新开场，不从旧日记生成新经历；UI 不向 QQ、B站或抖音发送消息，也不切换会话或当前模型。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | macOS；本 worker 未启动真实 DSH 或 profile |
| SurfCore 版本 | 基线 `3ab73bd`；没有改版本号 |
| 安装方式 | 独立 Git worktree `../surfcore-sharing-ui`，分支 `feat/sharing-ui` |
| 其它相关版本 | DeepSeek Harness 官方 Node `24.21.0`；Playwright 本机 loopback fixture |

## 根因

- 代码位置：[douyin-companion-page.mjs](../../plugins/surfcore/lib/douyin-companion-page.mjs)（sharing 状态机从 101 行起）、[companion-sharing-client.mjs](../../plugins/surfcore/lib/companion-sharing-client.mjs)（挂载入口从 12 行起）、[client.js](../../plugins/surfcore/lib/client.js)（`apply` 从 7043 行起）。
- 原页面只认发现/观看接口；即使本机服务已有分享状态，页面也没有消费新分享、确认已读或提交回复的交互。侧栏插槽也没有注册伙伴动作。
- 既有日记页面会轮询角色状态并加载角色立绘；因此分享 API 与角色状态同时异步时，旧角色响应可能迟到。新的 UI 必须以主日记状态的角色 id/epoch 为权威，并在换角和 pagehide 时取消旧请求。

## 完整逻辑（给用户看的那一遍）

- **链路**：DSH 插件 `client.js` 的 `apply` 通过同源 `import('/dsh-surfcore/api/douyin/companion-sharing-client')` 挂载 `sidebar.footer.action`。轻量入口只轮询本机 `GET /dsh-surfcore/api/douyin/companion-sharing` 并显示未读数；用户点入口后才创建指向 `/dsh-surfcore/api/douyin/companion-page#conversation` 的 iframe。日记页先从原 `/companion` 状态取得当前角色，再读取 sharing 状态；确认已读、回复和取消都只写回同一个本机 sharing endpoint。控制器/service 负责持久状态与实际回复，不由 UI 拼造开场或调模型。其它旧日记读者仍使用原 `/companion` 接口。
- **机制**：sharing GET 是只读状态；GET 不触发模型。开场、提问、历史和角色名用 `textContent` 或 React 文本节点显示。未读只在用户点击“我看到了”或“回一句”后 ACK，后台轮询和隐藏 iframe 不会清掉未读。每个 POST 显式带 `action:'ack'|'reply'|'cancel'`，由 controller 按 action 分派；仅有 `openingId` / `requestId` / `text` 字段不会执行操作。POST 成功后会递增分享请求序号并 abort 旧 GET，再渲染 POST 返回值；这样旧快照不会撤销已读 ACK 或覆盖新回复。回复先生成 UUID `requestId`，连同 `openingId`、`characterId`、`characterEpoch` 与最多 1000 字正文提交；发送中禁止重复点击，不会自动重发。service 的单次模型等待上限为 180 秒，UI 等待 185 秒以留回包时间；超时保留输入并提示刷新核对既有结果，不要重发同一条消息。普通 POST 失败保留输入并显示 `code / error / hint`。`DOUYIN_CHAT_CHARACTER_REQUIRED` 会清角色分享、消息、草稿并禁用输入；`DOUYIN_STALE_CHARACTER` 会立即收起旧分享、清草稿并暂时禁用回复和新一轮，主 companion 状态重新确认后才继续读状态，不重放旧操作，原 `code / error / hint` 保留。迟到 POST 先核对 `pagehide`、主页面角色 id/epoch，再处理服务错误，避免旧角色错误清掉新角色。取消收到其它实例拒绝时继续显示 active 并保留错误，不假报已取消。sharing 响应只有在 id/epoch 仍匹配主日记页面当前角色时才可显示；切角/清角会清开场、历史和草稿、增加序号并 abort 旧请求。pagehide 会终止轮询和请求，迟到结果不能恢复页面或发起最终刷新。active 聊天同时禁用“再发现一轮”，避免两个作业互相争用。
- **爆炸半径**：1 个 DSH renderer 进程 × 2 个本地 UI 读者（侧栏入口与日记/聊天页）× 1（失败在用户界面报告）= **2 分**。UI 只访问新约定的本机 HTTP 端点；本实现和本次测试不访问真实 profile、凭据、模型或外部平台，也不读写平台账号。用户显式发送回复时由本机 service 按其服务契约处理；fixture 不执行这一步的模型调用。
- **取舍**：路线 A 重写现有日记为一套新前端，会同时触碰立绘、日记、操作错误和现有角色/关页时序，收益不足以抵消兼容风险。路线 B 在既有页面追加独立聊天区，只在 `apply` 增加一个动态模块挂载，聊天状态和原观看状态各自保留，回滚只需回退 UI 提交。本次采用 B。只添加日记内链接会缺少用户要求的 DSH 侧栏未读入口，因此没有采用。
- **生效与重启**：DSH 插件 `client.js` 读取 `apply` 并通过宿主 `sidebar.footer.action` slot 注册入口；同源模块由分享 service 以 JavaScript MIME 提供。更新插件后需重新加载插件或重启 DSH，再刷新日记页。真实 `0.2.2-rc.1` footer slot 的挂载验收由父会话执行，本 worker 仅用本机 fixture 验证注册与清理。

## 修法

- 在原日记页追加“看完后 · 留在本机”聊天区；显示 API 提供的新开场、一个轻问题、近期消息、已读按钮和回复/取消表单。`start` 在聊天 active 时禁用；原观看按钮、少女立绘、日记、原 `#error`、轮询与 role/pagehide 保护继续工作。
- 新增浏览器 ESM `mountSharingEntry(ctx, React)`：`order: 7` 注册侧栏入口、未读标记和仅按点击打开的浮层 iframe；5 秒串行 GET 带 timeout；清理时注销 slot、停止轮询并卸载 iframe。
- `client.js apply` 只增加异步 import 接线。模块加载失败时侧栏显示固定 code、错误说明和“重载入口”操作；apply 已 dispose 后，迟到 import 不得再注册 slot。
- 回滚：回退本地 UI 提交即可恢复原有日记/侧栏；不需要删除或迁移服务数据。不要通过 UI 重试来绕开后端幂等错误。

## 验证

- 官方 Node 24 运行 `plugins/surfcore/scripts/test-companion-sharing-ui.mjs`：本机 loopback HTTP + Chromium，30 项通过；fixture 仿照 production controller 严格分派 `action`，缺失/未知值返回 `DOUYIN_CHAT_ACTION`。旧 UI 下 ACK 请求曾以 `action:undefined` 被拒，绿版断言 ACK/reply/cancel 分别发送正确 action。另用受控 GET gate 验证旧同角色快照不能撤销 ACK 或抹除新回复；受控 main GET 验证 canonical REQUIRED/STALE 错误时旧分享和草稿立即收起；虚拟计时把 185 秒映射到本地短等待，断言服务 180 秒额度契约、保留草稿、无自动重发；忽略 AbortSignal 的本机夹具验证迟到 canonical POST 错误不能清除新角色或复活 pagehide 页面。其余覆盖 XSS 文本、UUID/角色戳、重复发送闸、普通失败保留输入、取消与迟到结果、其它实例取消拒绝、active 禁用新一轮、跨 endpoint 换角、清角、375px、侧栏 slot、未读标记、关闭/卸载 iframe、动态 import 错误和 apply dispose。
- 官方 Node 24 运行 `plugins/surfcore/scripts/test-douyin-companion-ui.mjs`：既有日记/立绘/操作错误与角色/关页用例保持通过。
- 官方 Node 24 运行 `scripts/test-audit.mjs`：**174/174** 通过；新增 UI fixture 直接运行，未改 `package.json`、audit 注册、版本或 manifest。
- 失败路径断言：`SHARING_TEMPORARY_FAILURE` 显示 code/error/hint、输入保持；`DOUYIN_CHAT_OTHER_INSTANCE` 不清 active；canonical REQUIRED/STALE 码清理或退休角色分享状态并保留原文；185 秒超时提示刷新核对、禁止自动重发；模块 import 失败显示 `COMPANION_SHARING_CLIENT_LOAD_FAILED` 与重载按钮。
- 本 worker 未使用真实 DSH/profile、真实网络、模型或平台账号；真实 sidebar slot、真实原生对话与重启后历史验证由父会话负责，不将 fixture 作为原生验收。

## 遗留 / 后续

- 父会话需组合本地分享 service 的 Host 路由，再在真实 DSH 0.2.2-rc.1 确认 footer slot、原生浮层、回复与重启历史。
- 后端可能回 `DOUYIN_CHAT_INTERRUPTED` 或跨实例取消错误；UI 原样保留 code/error/hint，不自动重发。完整长期体验与其它 profile/设备矩阵不在本 worker 证据范围内。

## 可转发发布交接块

```text
【编辑会话交接】
主题：看完后的本机伙伴分享、未读侧栏入口与可回复聊天
分支：feat/sharing-ui
基线：3ab73bd
文件：plugins/surfcore/lib/douyin-companion-page.mjs、plugins/surfcore/lib/companion-sharing-client.mjs、plugins/surfcore/lib/client.js（仅 apply 接线）、plugins/surfcore/scripts/test-companion-sharing-ui.mjs、docs/cases/2026-11-07-companion-sharing-ui.md、docs/PITFALLS.md（本功能一条）、docs/COORDINATION.md（本会话行）。
接口：消费父服务约定的 GET/POST /dsh-surfcore/api/douyin/companion-sharing；同源 API、角色 id/epoch、openingId、UUID requestId。GET 不触发模型；回复只在用户点击发送后提交；失败保留输入并显示 code/error/hint，无自动重发。
验证：本机 UI fixture 23 项通过；既有 test-douyin-companion-ui 通过；test:audit 174/174。测试只访问 loopback fixture，没有真实 DSH/profile、模型或平台外发。
影响与生效：只增加 DSH 侧栏和原日记页本机对话 UI；更新插件后重载 SurfCore/重启 DSH。后端 Host 路由及真实 footer slot/原生交互/重启历史由父会话组合验收。
回滚：回退本地 UI 提交；不触碰服务持久数据。
未验：真实 DSH 0.2.2-rc.1 slot 注册、原生 iframe 布局与跨重启 history，不宣称已原生验收或已发布。
```
