# 零帧样本不再被误判为"记录损坏"：共享记录与账本统一 `frameSamples` 0..3

> 日期：2026-11-15 · 分支：`dev`（本批直接在 `dev` 上做，随下一批合入）· 前置：`v0.9.0` 已发布
> 改动：`plugins/surfcore/lib/companion-sharing-store.mjs`（共享记录的 `frameSamples` 下界 1 → 0）、`plugins/surfcore/scripts/test-companion-sharing.mjs`（补两条边界断言）
> 目标：把"检索路径"上同一条值的允许区间对齐到生产者（账本）与显示层的契约，别再让正常数据被当成损坏。

## 1. 现象与背景

抖音陪伴的一条**已完成项**如果画面一帧都没取到（`coverage.frameSamples === 0`），模型把它当"小发现"分享出去时，记录写入失败：

```
{"ok":false,"code":"DOUYIN_CHAT_STORAGE","error":"本机伙伴对话记录暂时不可用，原记录未重置。","hint":"保留角色的 sharing.jsonl，检查权限或文件完整性后刷新。"}
```

这句话在说"你的本机记录坏了"，可事实是**这条数据完全正常**——`frameSamples: 0` 是账本允许的取值。用户被指向了无关的排查（改权限、查 `sharing.jsonl` 完整性）。

## 2. 完整逻辑

### 2.1 链路

- **生产**：`plugins/surfcore/lib/douyin-companion.mjs:494` 写 `coverage: { ...coverage, visualCoverage: 'sparse', frameSamples: images.length, status: 'partial' }`（抽样帧数可以是 0）；`:388` 的跳过项写 `frameSamples: 0`。落盘前过 `plugins/surfcore/lib/douyin-companion-ledger.mjs` 的 `validCoverage`：`Number.isSafeInteger(frameSamples) && frameSamples >= 0 && frameSamples <= 3`。
- **读回**：`readLedger()`（`plugins/surfcore/lib/douyin-companion-ledger.mjs:102`）先 `validateLedger(...)` 再返回，所以交给下游的值一定落在 0..3。
- **消费**：`plugins/surfcore/lib/companion-sharing.mjs:144` 把 `item.coverage.frameSamples` 抄进共享记录；`plugins/surfcore/lib/companion-sharing-store.mjs` 的 `checkRecord` 落盘前再校验一次。
- **显示**：`plugins/surfcore/lib/douyin-companion-page.mjs:66` 的 `frameCoverage(value)`：`1..3` 显示 "N 张稀疏画面"，其余（含 0）显示 "稀疏画面数量未确认"。
- **别的读者**：`plugins/surfcore/lib/memory-v2-host.mjs` 的适配器只做字段白名单与句柄校验，不认识 `coverage` 这类领域字段——领域区间由上面这条链上的模块各自负责。

### 2.2 机制（为什么会出现"正常数据被判损坏"）

同一个值，三处区间不一致：

| 位置 | 允许区间 | 对 0 的处理 |
| --- | --- | --- |
| 账本 `validCoverage`（生产者契约） | 0..3 | 合法 |
| 页面 `frameCoverage`（显示契约） | 1..3 显示，其余降级 | "未确认" |
| 共享存储 `checkRecord`（本次要改的） | **1..3** | 抛 `unavailable()` → `DOUYIN_CHAT_STORAGE` |

`checkRecord` 的 `>= 1` 比生产者契约更严，于是**合法数据在检索路径上被拒**，而且拒绝方式是最容易误导人的那种：`problem()`（`plugins/surfcore/lib/douyin-companion-utils.mjs`）把校验失败统一说成"记录暂时不可用"。

### 2.3 爆炸半径

进程数 ×1（插件进程内的一条校验）· 读者：共享记录文件 `sharing.jsonl`（append-only，一个角色一份）· 影响面：**任何"抽不到画面帧"的抖音项**（`visualCoverage: 'sparse'` 且 `frameSamples: 0`，例如帧解码全部失败）· 不碰用户数据、密钥、不花钱、不重启、不回滚数据（失败发生在 append 前的校验，文件没被写过）。

### 2.4 取舍（至少两条，说明为什么选这条）

- **A（选）**：把共享存储的下界改成 0，与账本 `validCoverage` 的 0..3 对齐；上界与"必须是整数"保持不变。收益：正常数据不再被拒；显示层本来就会把 0 渲染成"未确认"，语义一致。成本：一行 + 两条断言。风险：低——放宽的是**已经被账本验证过**的区间，且越界值（6/-1/1.5/'3'）仍被拒。
- **B（否决）**：保留 `>= 1`，但把失败换成带 `code`/`hint` 的产品错误（"这条记录没有画面样本，无法分享"）。收益：报文更诚实；成本：一条正常记录仍然分享不了，等于把"数据合法但功能不给用"固化下来，还要新增用户可见文案与分支。
- **C（否决）**：在抄写点（`companion-sharing.mjs:144`）把 0 改写成 1 或丢掉字段来绕过校验。收益：零；成本：把"没取到画面"伪装成"取到 1 帧"，正是审计口径里禁止的"未知伪装成已知"。

### 2.5 生效与重启

插件代码，改完由宿主在下一次加载插件时生效（本机测试用自带 node 直接跑脚本即可；真实实例需重启宿主或等插件重载）。数据无需迁移：历史记录里的 0 现在可以被正常读取与分享。

## 3. 验证

**先红**（未改存储时，只加断言）：

```
$ node plugins/surfcore/scripts/test-companion-sharing.mjs
RED_EXIT=1 elapsed=1s
AssertionError [ERR_ASSERTION]: 零帧样本必须可以共享：{"ok":false,"code":"DOUYIN_CHAT_STORAGE",…}
```

**修后绿**：

```
$ node plugins/surfcore/scripts/test-companion-sharing.mjs
GREEN_EXIT=0 elapsed=1s
Companion sharing: persisted dialogue, dedupe, role and shared budget passed
```

**反向重放**（证明边界断言不是空跑）：把存储上界临时放宽成 `frameSamples > 99` →

```
REVERSE_EXIT=1
AssertionError [ERR_ASSERTION]: Missing expected exception: frameSamples=6 必须被共享存储拒绝
```

还原后 `shasum -a 256 plugins/surfcore/lib/companion-sharing-store.mjs` 与改动后逐字一致（`b8eca697a76ce833d318cb06c815bafe0ca9892eef0cbb1c6c3fe310976a937a`）。

**相邻回归**（串行，避免并发争抢导致的假红）：12 条全部 `EXIT=0`。

### 3.1 相邻回归明细（串行 12 条，全部 `EXIT=0`）

| 脚本 | 结果 |
| --- | --- |
| `test-companion-sharing.mjs` | `EXIT=0`（本批主测试，先红证据见上） |
| `test-companion-sharing-race.mjs` | `EXIT=0`（跨进程付费调用唯一性仍成立） |
| `test-companion-sharing-ui-controller.mjs` | `EXIT=0` |
| `test-companion-sharing-ui.mjs` | `EXIT=0` |
| `test-memory-v2-sharing.mjs` | `EXIT=0` |
| `test-douyin-coverage-r3.mjs` | `EXIT=0`（页面把越界值 6 渲染成 `分享6音轨完整 · 稀疏画面数量未确认`） |
| `test-douyin-companion.mjs` | `EXIT=0` |
| `test-douyin-companion-host.mjs` | `EXIT=0` |
| `test-douyin-companion-recall.mjs` | `EXIT=0` |
| `test-douyin-companion-ui.mjs` | `EXIT=0` |
| `test-douyin-reflection-receipt.mjs` | `EXIT=0` |
| `test-douyin-errors-r3.mjs` | `EXIT=0` |

日志：`/tmp/g7p4-family.log`。

### 3.2 全量门禁

（提交后回填：`npm run test:audit`、`npm run test:regressions`、`npm run test:memory-v2`、`npm run lint:failures`、`npm run doc-facts`、`node scripts/test-agent-preset-patches.mjs --check`、`node scripts/release-manifest.mjs --verify-ref HEAD`、`npm --prefix plugins/surfcore test`）

## 4. 回滚与残余

- **回滚**：把 `companion-sharing-store.mjs` 的 `frameSamples < 0` 改回 `< 1` 即回到旧行为（一行）；测试中的两条断言随之失败，属预期。
- **残余**：`plugins/surfcore/lib/memory-v2-host.mjs` 的适配器层仍然只做字段/句柄校验，不理解 `coverage` 这类领域字段——这是设计分工，不是缺陷；但**新增领域字段时必须同时检查生产/消费两侧的区间是否一致**（本次就是不一致）。另外，`frameSamples` 的"0 与 1..3"目前只靠各模块自带区间守住，没有单一常量，将来若再加消费者，仍可能出现同类漂移。
