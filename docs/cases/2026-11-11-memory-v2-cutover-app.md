# 大肥鱼（红豆）角色切回与 Memory V2 记忆引擎正式切入

日期：2026-11-11。状态：已完成大肥鱼角色指针恢复（app / 红豆，epoch 6）、全局冷备份、V2 控制库初始化、原子发布 V2 路由、QQ Bridge 热重载验证。

## 1. 链路

```text
角色指针 (~/.dsh/surfcore/characters/current.json)
      ↓ switchCharacter('app')
当前角色恢复为 app (红豆 / 自称「大肥鱼」, epoch 6)
      ↓
控制库 (~/.dsh/surfcore/memory-control.sqlite)
      ↓ activeBackend='v2', shadowEnabled=1
路由发布器 (writeMemoryRouting)
      ↓ 原子发布 routing.json (backend: 'v2')
~/.dsh/surfcore/memory-v2/routing.json & ~/.dsh/surfcore/qq/state/memory-v2/routing.json
      ↓
QQ Bridge (PID 30591) / DSH 插件 (memoryV2Runtime)
      ↓ 动态 /api/status 读取
memoryV2.backend === 'v2' (正式启用 V2 引擎)
```

## 2. 机制与大肥鱼记忆系统的变化

### (1) 大肥鱼当前状态排查
- 此前由于自动化测试运行，`characters/current.json` 曾被临时切为测试占位角色 `alpha`。
- 本次操作通过 `switchCharacter('app')`，原子切回真正的主人角色「红豆」（`app`，人设自称「这条鲸／小鲸鱼／大肥鱼」），epoch 由 5 步进至 6。
- 历史积累的完整 V1 记忆（包含 254KB `memory-card.json`、183KB `memory-card-full.jsonl`、70KB `memory-inbox.jsonl` 等共 517 条历史记录、180 条受保护锚点）全部完好在册。

### (2) V1 与 V2 记忆系统核心机制变化
1. **存储架构升级**：
   - **V1**：单文件 JSON（254KB）与行文本追加。每次更新必须整份重写 JSON，在崩溃或并发时存在损坏风险。
   - **V2**：SQLite 双层架构（全局 `memory-control.sqlite` 控制库 + 角色专属 `memory-v2.sqlite` WAL 事务库）。细粒度事务原子提交，告别全文件重写与损坏隐患。
2. **隐私隔离与来源确权**：
   - **V1**：私聊、群聊、B站公开动态与经历混存在同一份卡片中，仅靠后处理正则脱敏，存在跨场景穿透风险。
   - **V2**：每条记忆绑定 `channel`、`conversationKey`、`sourceAccountKey` 与 `providerRouteId` 精确路由，跨会话调用需显式授权与闸门审批。
3. **关键羁绊硬化防护**：
   - **V1**：在 60 天衰减与容量淘汰下容易误冲掉早期的重要羁绊记忆。
   - **V2**：`pinned`、`anchor`、`isInitial`、`firstMet`、`protected` 字段受到底层强保护，初见与核心人设不可被自动衰减冲刷。
4. **Token 经济与精确召回**：
   - **V1**：回复时粗暴把几千字的人格卡与记忆卡注入 Prompt，挤占 context 上限。
   - **V2**：基于倒排词索引（`terms`）与 `search_docs`，在 token 预算内动态构建最相关的记忆包。

## 3. 爆炸半径与数据保全

- **零数据损失**：V1 所有历史记忆原件均保留在 `characters/app/memory/` 目录中，不修改、不删除，作为物理不可变底账。
- **冷备份完备**：切入前已完整备份至 `~/.dsh/_backups/memory-v2-cutover-app-1794391232776`。
- **发布隔离**：仅在本地宿主目录发布 V2 路由，不触碰任何敏感密钥。

## 4. 取舍

- **方案 A（格式化重置 V2）**：清空所有记忆重建，成本最低但会破坏主人长期培养的大肥鱼羁绊，拒绝。
- **方案 B（双轨保留 + 路由原子切入 V2）**：保留 V1 物理底账，初始化 V2 控制库并切换持久路由，既享受 V2 稳定安全，又保留历史回溯可能。采纳方案 B。

## 5. 生效与验证

1. **路由验证**：
   - `readMemoryRouting({ stateDir })` 返回 `{ ok: true, backend: 'v2', descriptor: { schemaVersion: 1, backend: 'v2', controlRevision: 0, minCompatibleReader: 1 } }`。
2. **Bridge 验证**：
   - 桥接进程已热重启（PID 30591），HTTP 接口 `/api/status` 返回 `memoryV2.backend === 'v2'`。
3. **角色验证**：
   - `readCurrentCharacter()` 确认当前角色为 `app`（红豆 / 大肥鱼），epoch 6。

## 6. 回滚路径

若需回滚至 V1，无需重启电脑：
1. 调用 `writeMemoryRouting({ stateDir, status: { ok: true, activeBackend: 'v1', revision: 0, storeGeneration: '...', minCompatibleReader: 1 }, allowDowngrade: true })`；
2. 或直接恢复备份：`cp -r ~/.dsh/_backups/memory-v2-cutover-app-1794391232776/* ~/.dsh/surfcore/`；
3. 重启 QQ Bridge 即可平滑回到 V1。
