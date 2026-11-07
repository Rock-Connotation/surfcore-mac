# 经历后的本机分享开场与文字回复

## 现象

- 已有抖音点评会把偏好、理由、总结和草稿写进角色记忆；新增需求是在记忆落盘后，为本机日记生成一条自然开场和一个轻问题，并允许同页本机文字回复。
- 复现：使用 `recordSharing` opt-in 运行一条离线推荐；生成开场仍只使用原图像点评调用，记忆确认后才写分享记录。另用模型 adapter 的 `reply` 验证文字请求不保存或发送图片。
- 影响面：只影响选择接入 `recordSharing` 的本机引擎。未启用时保留旧四字段模型协议和账本 v1。失败不会撤销已保存的经历记忆，也不会自动补发或自动重试。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | 离线 fixture；没有启动或读取真实 DSH |
| SurfCore 版本 | `feat/sharing-engine`，基线 `3ab73bd` |
| 安装方式 | 独立本机 Git worktree |
| 其它相关版本 | 官方 Node `v24.21.0`；所有 LLM/附件/日记回调均为 fixture |

## 根因

- 代码位置：`plugins/surfcore/lib/douyin-companion.mjs`、新增 `douyin-companion-reflection.mjs`、`douyin-companion-model.mjs`。
- 原点评 JSON 只有 `feeling/reason/summary/draft`；本地 ledger v1 对 job/item 采用严格字段集。把开场直接塞进 ledger 会破坏老账本契约；增加第二次点评调用则会消耗已有每轮预算，并使开场与实际材料脱节。
- adapter 原 `call` 强制需要图像，无法承载同页文字回复。让“无图”标志绕过图像校验会削弱现有多模态约束；需要独立 text-only `reply`，但复用同一受界请求/用量路径。
- 目录查询、额度检查等异步等待期间，角色可能切换，而50ms rolewatch尚未触发。模型发送前和读取流的实际微任务内必须再做同步角色 guard。

## 完整逻辑（给用户看的那一遍）

- **链路**：本机推荐素材经已有 `perceive` 输入到一次固定HY3图像点评。只有模型返回合法 JSON 且 `recordMemory` 成功、`memorySaved` 已持久化后，engine 才调用可选 `recordSharing(context,payload,{signal})`。payload包含原 job/source/title/发生时刻/覆盖范围和开场文本；分享服务负责追加到独立 `sharing.jsonl`。`createCompanionModel.reply` 为同页回复提供 text-only 固定HY3请求，回复预算与分享存储由父级共享 service 预留与维护。
- **JSON契约**：无 `recordSharing` 时严格为 `feeling`（`like|mixed|neutral|dislike`）、`reason`（≤240字）、`summary`（≤500字）、`draft`（≤300字，可空）。启用时同一个响应严格增加 `share`（≤240字）与 `question`（≤100字、恰好一个以问号结尾的问题）；拒绝额外字段、链接、疑似凭据、图片数据、多个问题、催促式问题。开场只传给分享回调，不写入旧 job/item 或状态投影。
- **机制**：分享 schema/system 从 engine 移到 `douyin-companion-reflection.mjs`。旧路径继续使用原四字段契约；当前上下文的`sections[kind=persona]`（或`personaText`）作为可信本机身份/表达参考，记忆独立作为外部data；没有当前persona时才使用已批准的 `whaleCompanionTone` fallback。分享路径同时加抖音场景约束，要求只说材料支持的感受，不编造共同经历、用户偏好或真实情绪。partial音轨和稀疏画面信息会原样进入prompt；模型被要求说明局部理解，不声称看过全片。写开场失败固定返回 `DOUYIN_SHARING_SAVE_FAILED`、可见 `error/hint`，保留 `memorySaved` 并沿用daily暂停机制。
- **文字回复**：`reply({system,prompt,signal,maxTokens,timeoutMs,beforeSend?})` 不接受图像块、不调用 `attachments.saveImages`；仍检查HY3图像能力readiness、总额度、≤8192输出、≤180秒及持久用量。固定 provider/model 与 `reasoningEffort:'low'`，tool-call拒绝、不会自动重试。reply不负责共享验收/日常请求reservation；父service须先reserve现有预算。`beforeSend`只作为本机内部同步guard，目录与额度await之后、stream创建前、每个iterator读取微任务前后执行。
- **爆炸半径**：改动位于一个engine进程、一个模型adapter和可选本机分享回调；没有平台外发、没有新增模型轮次、没有真实模型/网络/DSH调用。旧ledger严格schema、既有日记记忆和状态投影保持原样。外部callback必须用`signal`和当前role/epoch防止取消/切角后的迟到写入；分享存储建议按`jobId+id`幂等，以覆盖成功追加后进程崩溃、job尚未收尾的窗口。
- **取舍**：路线A把`share/question`加入ledger v1，改严格旧schema且让旧作业与新显示字段耦合；路线B用opt-in callback，在同一次点评产生文案、记忆成功后写独立追加存储。选B，旧调用保持原行为，也避免额外模型请求。文字回复单设`reply`；不放宽 `call` 的1–3图像要求，避免无图flag绕过。
- **生效与重启**：这些代码在SurfCore插件被宿主加载时生效；本轮没有真实DSH/Host运行验收。父service完成接线后需按其同页分享/reply组合case验证，并重启对应测试Host进程；不要把离线fixture当作DSH验收。

## 修法

- `douyin-companion-reflection.mjs` 集中输出schema、安全校验和 opt-in 表达约束；engine 在成功持久化 `memorySaved` 后才guarded调用分享回调，未启用回调时继续解析原四字段。
- model adapter 用同一个bounded stream/use计量helper 增加纯文本 `reply`；不触图片附件保存，不创建第二个route，不在adapter里reserve共享budget。`beforeSend`同步guard贯穿实际dispatch/read边界。
- 回滚方式：从 `feat/sharing-engine` 删除本次提交/回到 `3ab73bd`；分享存储由父service单独持有，不在此分支改动。无外部状态需要恢复。

## 验证

- 红绿：新增engine开场断言最初因旧schema拒绝六字段而失败；`reply`首次测试因adapter无该方法失败；新增目录切角测试最初未触发拒绝且观察到dispatch。实现后本范围三项fixture全绿。
- 自动化命令（官方 Node 24）：

  ```bash
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-douyin-companion.mjs
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-companion-sharing-reflection.mjs
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' plugins/surfcore/scripts/test-douyin-companion-host.mjs
  PATH='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin':"$PATH" npm run test:audit
  ```

- 失败分支fixture覆盖：分享回调失败为`DOUYIN_SHARING_SAVE_FAILED`且daily暂停；记忆失败不产生开场；取消/切epoch不迟到追加；错误/隐私/长度/额外JSON字段被拒绝并带hint；模型tool-call拒绝、usage落盘失败可见；目录和额度await期间role变更零dispatch；预取消不发请求；reply不保存图片。
- 没验证：真实HY3内容质量、宿主同页聊天UI、父service追加存储/reply预算账本和实际DSH重启体验；均不由此引擎fixture宣称通过。

## 遗留 / 后续

- 父service需将回调接入role-local追加式分享存储，落盘字段按job/source/发生时间存档；reply调用前依父契约原子reserve acceptance剩余4次、每日最多8次，并保留现有8/12旧账。
- 宿主UI需展示开场/轻问题、允许用户在同页回复；模型调用由父service传同步`beforeSend`复核角色与signal。真实UI与重启验收由组合工作树负责。

## 可转发发布交接块

```text
改动：抖音点评增加opt-in分享开场/轻问题回调；提取反思JSON schema；HY3 adapter新增纯文本reply与实际dispatch/read的同步角色guard。旧四字段契约、ledger v1、原多模态call的1–3帧要求不变。
文件：plugins/surfcore/lib/douyin-companion.mjs；plugins/surfcore/lib/douyin-companion-reflection.mjs；plugins/surfcore/lib/douyin-companion-model.mjs；plugins/surfcore/scripts/test-douyin-companion.mjs；plugins/surfcore/scripts/test-douyin-companion-host.mjs；plugins/surfcore/scripts/test-companion-sharing-reflection.mjs；docs/cases/2026-11-07-companion-sharing-engine.md；docs/PITFALLS.md；docs/COORDINATION.md。
验证：官方Node24运行三项离线专项通过；`npm run test:audit`结果见提交记录。真实HY3/DSH/UI及父级分享store/reply账本未由本工单验证。
接口字段：引擎可选recordSharing(context,{jobId,mode,id,title,occurredAt,share,question,coverage},{signal})，仅在memorySaved持久后调用；模型输出启用时六字段（feeling/reason/summary/draft/share/question）。model.reply({system,prompt,signal,maxTokens,timeoutMs,beforeSend?})，text-only、固定HY3 low，不负责budget reservation。
失败：回调失败DOUYIN_SHARING_SAVE_FAILED，保留memorySaved、daily沿旧逻辑暂停；reply拒绝tool-call/无法落用量时返回结构化错误；切角色目录/额度等待fixture发送数为0。
爆炸半径/回滚：仅本机插件实现与fixture，无真实外部动作、无模型调用；从提交回滚即可，不涉及数据恢复。
```
