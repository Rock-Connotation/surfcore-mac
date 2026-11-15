# setup-dsh 不再产出"装了也起不来"的 profile：为全新 profile 补 DSH 基座 bundle

> 日期：2026-11-15 · 分支：`dev`（修复在 `dev` 上做，随下一批合入）· 前置：`v0.9.0` 已发布
> 改动：`scripts/setup-dsh.mjs`（补基座 bundle）、`scripts/test-audit-setup.mjs`（示例断言跟进）、`scripts/test-surfcore-isolated-host.mjs`（不再自己补基座，改为断言安装器写全）
> 目标：让"独立 `DSH_HOME` + 全新 profile"这条安装路径真的可用，而不是装完停在 `pending (waiting for service: …)`。

## 1. 现象与背景

G7 第二阶段做隔离宿主验收时，真实打包宿主里 `surfcore` / `qq-mode` 全部停在：

```
surfcore (surfcore): pending (waiting for service: sessionController)
qq-mode (…/node_modules/surfcore/qq-mode/index.js): pending (waiting for service: settings)
```

补上 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 后立刻正常（当时是**在测试里手写**这两个 bundle 才变绿的）。根因不在插件，而在**我们的安装器**：`scripts/setup-dsh.mjs` 给一个 DSH 从未初始化过的 profile 只写了 `surfcore` 一个 bundle。这个坑此前被测试自己掩盖了 —— 见 §2.6。

`docs/guides/DEV-TESTING.md` §0 要求测试机用独立 `DSH_HOME`；照这条口径在一台干净机器（或一个新 profile 名）上装 SurfCore，就会踩到。

## 2. 完整逻辑

### 2.1 链路

- 写入方：`scripts/setup-dsh.mjs` 的 `patchProfilePackage(links)`（`/Users/shizihan/Daily/Github/surfcore-dev-build/scripts/setup-dsh.mjs:406`）：profile `package.json` 不存在时用模板 `bundles: []`，随后只追加 `BUNDLE_NAMES = ['surfcore']`（`:213`），再跑 `dsh plugin --profile <p> install`。
- 读取方：DSH 桌面宿主按 `<profile>/package.json` 的 `dsh.profile.bundles` 展开 bundle 层；`@deepseek-ai/dsh-base` 提供 `webServer`/`credentials`/`connection`/`sessionController`/`settings` 这些被插件 `inject` 的服务，`@deepseek-ai/dsh-web-app` 提供外壳。
- 别的读者：`scripts/uninstall.mjs`、`scripts/detect-profile.mjs`、`scripts/test-dsh-health.mjs`、`plugins/surfcore/scripts/test-dsh-repair.mjs`、`docs/guides/DEV-TESTING.md`（都只按"profile 存在 + surfcore 在 bundles 里"判断，不关心基座）。

### 2.2 机制（为什么缺基座就起不来）

DSH 自己创建 profile 时会把基座写进 `bundles`，实机三个 profile 就是证据：

| profile | `dsh.profile.bundles` |
| --- | --- |
| `desktop` | `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","billion-context",…,"surfcore"]` |
| `headless` | `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]` |
| `web` | `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@tt-a1i/archify-dsh",…]` |

也就是说 **`@deepseek-ai/dsh-base` 是每个 profile 的第一项**，第二项是"外壳"bundle（GUI 是 `dsh-web-app`，无头是 `dsh-headless`）。当 `setup-dsh` 在一个 DSH 没建过的 profile 上跑时，`bundles` 里没有基座 → 宿主不会加载提供服务的插件 → `surfcore`（`inject = ['webServer','connection','sessionController']`）与 `qq-mode`（`settings`）永远 `pending`；宿主最终以 `startup failed: 1 required plugin did not activate` 结束。

### 2.3 爆炸半径

进程数 ×1（安装器）· 读者：profile `package.json` 的 `bundles`（宿主 loader 直接读）· 影响面：**任何"全新 `DSH_HOME` / 全新 profile 名"的安装**（本机 dev 测试、志愿者测试机、将来的一次性实例）· 不碰用户数据、密钥、不花钱 · 已由 DSH 创建的 profile（`desktop`/`headless`/`web`）行为**逐字不变**。

### 2.4 取舍（两条路线）

- **A（采纳）**：基座缺失时按名字规则补 `@deepseek-ai/dsh-base` + 外壳 bundle，并打印一行可见日志。收益：全新 profile 装完即可用；成本：安装器要知道"基座"这两个名字；风险：若将来 DSH 改名，这里会写错名 —— 用"只在缺基座时补、已有列表一字不动"把风险限制在"DSH 没建过的 profile"这一种情况。
- **B（否决）**：检测到基座缺失就 **fail-closed** 报 `DSH_PROFILE_NOT_INITIALIZED` + 提示"先用 DSH 建 profile"。收益：安装器不与宿主 bundle 命名耦合；成本：按 `DEV-TESTING.md` §0 做隔离测试的人**先撞墙再读文档**，而且这个失败发生在"最不该要求用户懂内部 bundle"的时刻（和 §1.7「失败必须可见且可行动」相悖）。

### 2.5 生效与重启

`setup-dsh` 是安装/修复入口，改完即生效：重跑 `node scripts/setup-dsh.mjs <profile>` 就会补上基座。**已经装坏过的 profile 不会自愈**（除非重跑安装器或用 DSH 自己重建 profile）——这是本修复的边界。

### 2.6 验证（先红后绿 + 反例）

先前之所以没发现：`scripts/test-surfcore-isolated-host.mjs` **自己**写 `profilePackage.dsh.profile.bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','surfcore']`（旧 `:62`），正好把安装器的缺口补掉了 → 测试绿、产品坑仍在。本批把这行换成断言，于是这条测试变成安装路径的常驻回归。

- **先红**（安装器未修、测试已改为断言）：`node scripts/test-surfcore-isolated-host.mjs` → `RED_EXIT=1`，`AssertionError`：实际 `["surfcore"]` vs 期望 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","surfcore"]`（日志 `/tmp/g7p3-red1.log`）。
- **修后绿**：`GREEN_EXIT=0`，`AC1/AC2/AC3/AC6/AC7/AC8 = PASS`（AC2 真实宿主 `ready`、AC3 真实 loader 激活 `surfcore`+`qq-mode`），AC4/AC5 仍记"环境阻断"（HTTP 面与页面渲染需要真桌面外壳）；日志 `/tmp/g7p3-green1.log`。
- **干净 `DSH_HOME` 直证**：`HOME=/tmp/g7p3-home DSH_HOME=/tmp/g7p3-home/.dsh QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs freshprofile` → 日志 `[setup-dsh] profile 不是 DSH 创建的（缺基座 bundle），已补：@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app`，profile `bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","surfcore"]`。
- **反例（不该动的不动）**：①重跑同一 profile → 补基座日志 0 行、bundles 不变（幂等）；②`setup-dsh headless` → 外壳取 `@deepseek-ai/dsh-headless`（按名字规则）；③构造与实机同形的 profile（`["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","billion-context"]`）→ 补基座 0 行，只把 `surfcore` 追加到末尾。
- **相邻回归**：`scripts/test-audit-setup.mjs`（期望值跟进，见 §4）、`scripts/test-setup-dsh-idempotent.mjs`（`✅ setup-dsh.mjs 幂等性测试通过`）、`scripts/test-setup-dsh-package.mjs`（`PASS packaged setup preserves installed bundle…`）、`scripts/test-node-path.mjs`、`scripts/test-dsh-health.mjs`、`plugins/surfcore/scripts/test-dsh-repair.mjs`、`plugins/surfcore/scripts/test-doctor.mjs` 全 exit 0；`npm run test:regressions` 全部通过。

### 2.7 回滚与残余

- 回滚：本批是独立提交（安装器 + 2 个测试），`git revert` 即可回到"安装器不碰基座"的旧行为（旧行为对 DSH 已建的 profile 无差别）。
- 残余：①HTTP 健康面/页面渲染仍需在真桌面外壳内取证（AC4/AC5）；②若 DSH 未来改基座 bundle 名，这里要跟着改（代码里只有一处常量）；③"已经装坏的既有 profile"不自愈，需要重跑安装器。

## 3. 失败路径

本改动不新增失败码；它把"装完必然起不来"变成"装完就能起来"，并把动作写进日志（`profile 不是 DSH 创建的（缺基座 bundle），已补：…`）。安装器原有的失败处理（`fatal` + `下一步：…`、profile 回滚 `已回滚 profile`、`verifyProfileAfterInstall` 的"丢失 bundles"文案）保持不变。

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `scripts/setup-dsh.mjs` | `:209-215` 新增 `DSH_BASE_BUNDLE` 与 `dshSurfaceBundle()`（`headless` → `dsh-headless`，否则 `dsh-web-app`）；`patchProfilePackage` 内（`:428-432`）在 bundles 规范化之后、追加 `links` 之前：基座缺失则前插 `[base, surface]` 并打日志 |
| `scripts/test-audit-setup.mjs` | `:68` 期望值由 `['existing','surfcore']` 改为 `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','existing','surfcore']`（fixture 的 profile 就是"非 DSH 创建"，关键断言仍是 `existing` 未丢、`surfcore` 追加、顺序不重排） |
| `scripts/test-surfcore-isolated-host.mjs` | 旧 `:62` 的"测试自己补基座"改为 `assert.deepEqual(profilePackage.dsh.profile.bundles, ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','surfcore'], …)` —— 让这条测试真正覆盖安装器 |

## 5. 未验证残余

- 真桌面外壳内的 HTTP `/dsh-surfcore/health` 与页面渲染（对应 AC4/AC5）；本批未改变它们的结论。
- 非 Node 子进程（Electron/Chromium）出站仍未做系统级审计。
- DSH 未来版本的基座 bundle 命名变化未纳入契约测试（只在本仓一处常量 + 实机三 profile 采样为证）。
