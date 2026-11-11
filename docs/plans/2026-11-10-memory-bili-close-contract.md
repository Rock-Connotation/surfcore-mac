# 2026-11-10 Bili V2 私有运行时关闭契约（HY4-BILI-CLOSE）

## 1. 现状问题

`plugins/surfcore/lib/bili-v2-agent.mjs` 的 `createBiliV2AgentRuntime` 在初始化时注册两处长期订阅：
`:198` `guardOff = ctx.tools.guard(guard)`、`~:203` `hookOff = hookContext.on('llm/stream', ...)`；
惰性 `startPreset()` 另产生 `presetOff`。旧 `close()` 形如
    async function close() { if (closed) return; try { await retire(); } finally { closed = true; try { await presetOff?.(); } finally { owner?.close(); } } }
从不调用 `hookOff`/`guardOff`，且 `finally` 在 `retire()` 失败时仍然标记 `closed=true` 并释放 owner，
后续 `close()` 因 `if (closed) return` 直接返回，无法重试。
父端独立 RED `_backups/memory-v2-coordinator/bili-close-subscriptions/red-result.json`：
`{"status":{"ok":false,"managedSessions":0,"activeJobs":0},"retainedSubscriptions":2,"unregistered":[]}`。

## 2. 冻结语义（本阶段）

- 成功 `close()` 顺序固定：`retire()` → `await hookOff()` → `await guardOff()` → `await presetOff()` → `owner.close()` → `closed=true`。三者各只注销一次；preset 未注册时跳过；owner 最后释放。
- `getStatus().ok = !fault && !closed && !shuttingDown`；`base()` 在 `closed || shuttingDown || owner?.issue()` 时抛既有 `BILI_V2_UNAVAILABLE`。`shuttingDown` 在首次 `close()` 时置位，失败后保持，阻断新 `enqueue` 与迟到 `llm/stream` 输出。
- 失败：`retire()` 或任一 disposer 抛错时，不标记 `closed`、不释放 owner、不清空未成功的 disposer；`closeTask` 清空使外部显式 `close()` 可重试，只补未完成项，不重放已 ACK 项、不重发。错误经既有 `issue()` 结构化（`ok:false` + `code` + `error` + `hint`），沿用 `BILI_V2_RETIRE_FAILED`。
- 并发：`closeTask` 共享同一 in-flight 退休/cleanup；成功后的重复 `close()` 幂等返回 `undefined`（调用兼容）。
- 不用 `finally` 吞 `retire()` 失败；失败的 disposer 不当作已 ACK。
- `retire()`/`finish()`/`releaseState()` 不调用 `base()`/`check()`，故 `shuttingDown` 不破坏退休与显式重试路径；`finish(state)` 的 `.catch` 复位 `state.finishing` 是重试能完成的前提。

## 3. ordinary 验收矩阵（`plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs`）

fixture 以 `trackedOff(name, dispose)` 记录注销顺序/次数到 `unregistered[]`，`offFailures` 可注入单个 disposer 拒绝，`ownerLock` 暴露 `path.join(registryPath + '.owner','token-budget-owner.lock')`。新增 4 例（均 `if (!native)`）：

1. 无作业 `close()` → `unregistered===['hook','guard']`、`guards/hooks` 清空、owner lock 消失、`getStatus().ok===false`、再次 `close()` 不增。
2. `archiveSession` 拒绝 ACK → `close()` 抛 `BILI_V2_RETIRE_FAILED`；owner lock 仍在、`activeJobs===1`、`unregistered===[]`、guard/hook 仍在、新 `enqueue` 与迟到 stream 均 `BILI_V2_UNAVAILABLE`；恢复 ACK 后显式 `close()` 重试完成 → `activeJobs===0`、`unregistered===['hook','guard','preset']`、owner lock 消失。
3. `Promise.all([close(),close(),close()])` → `unregistered===['hook','guard']`（不双注销），重复 `close()` 不变。
4. `offFailures.add('guard')` → `close()` 抛 `BILI_V2_RETIRE_FAILED`；`unregistered===['hook']`、`guards.length===1`、owner lock 仍在；清除后显式重试 → `unregistered===['hook','guard','preset']`、全部清空。

READ-ENUM 已接受的 38 例、`--ordinary` 门控、默认/native 显式行为全部保留。

## 4. 明确不做 / 父端后续项

- 不碰 Source、`memory-v2-native-root.mjs`、Host factory、index/scheduler、transport、`score --today`。
- 本工单 0 native、0 实际 Host、0 provider/外网/平台发送；完整 actual stream hook 路径由父端 Bili/QQ 组合独立复验。
- 按父端 m01673 的 3 文件边界，本契约只更新当下设计；`docs/cases/*.md`、`docs/PITFALLS.md`、`docs/ROADMAP.md` 的 case/发布交接由父端统一补。
- 证据：`_backups/memory-v2-bili-close/`（`original/`、`red-agent.log`、`green-agent.log`、`regression-*.log`、`prod.diff`、`test.diff`、`result.md`）。测试以 `CLOSE-EVIDENCE` 行打印注销顺序/次数、owner 持有、held/retry 后 `activeJobs`，非自述。
