# publish-dev 同步文档版本字（2026-11-15 根治：发 dev 构建不再把 doc-facts 弄红）

## 0. 一句话

`scripts/publish-dev.mjs` 之前只改 `package.json` / `README.md` / `CHANGELOG.md`，漏掉 `docs/ROADMAP.md` 与 `docs/guides/DSH_SETUP.md` 里的版本字；而 `doc-facts` 对这两处做逐字等值校验，于是**每发一次 dev 构建仓库 HEAD 就红一次**。本轮把同步逻辑抽成可测的 `scripts/publish-dev-doc-sync.mjs`，由发布脚本调用，并在 `test-dev-publish.mjs` 里钉住「同步前红 → 同步后绿」。

## 1. 链路

- **进程/文件**：`scripts/publish-dev.mjs`（dev 构建发布：bump 版本 → commit → 生成清单 → Data API 上传 → 打 tag → 建 Pre-release）→ 改版本阶段在 `:100-113`（原行号）。
- **上游**：用户在 `dev` 分支上确认发 dev 构建 → 脚本读根 `package.json` 的 `core`（`x.y.z`），拼 `core-dev.N`。
- **下游**：`git add` 提交 → `release-manifest.mjs` → GitHub Data API 全量上传 → tag/Pre-release。
- **谁读这个文件/接口**：
  - `scripts/doc-facts.mjs:188-199` 对 `docs/ROADMAP.md`（`/当前版本：`([^`]+)`/`）与 `docs/guides/DSH_SETUP.md`（`/当前 `([0-9][^`]*)`/`）做**逐字等值**校验，与根 `package.json` 比较；
  - `scripts/test-version.mjs` 校验版本一致性；
  - `scripts/test-audit.mjs` 收录 `test-dev-publish.mjs`（设计契约测试）与 `test-version.mjs`，即两条门禁都从这里过。

## 2. 机制

**为什么会红**：dev 构建把根 `package.json` 的版本从 `0.9.0` 抬到 `0.9.0-dev.2`，但 `ROADMAP.md` / `DSH_SETUP.md` 里的版本字还停在 `0.9.0`。`doc-facts` 只比「文档里那个版本字 == package.json 版本」，不相等就报错，于是每次发布后 HEAD 的 `npm run doc-facts`（以及整条 `test:audit`）都是红的——**不是偶发，是结构性的**（`v0.9.0-dev.1` 那次也是手工补的，只是当时没意识到是发布脚本的必然产物）。

**为什么抽成独立模块**：`publish-dev.mjs` 是带网络与 git 写操作的发布脚本，不便在单测里直接跑；把纯文本同步逻辑抽到 `scripts/publish-dev-doc-sync.mjs`（导出 `syncDocVersions` + `DOC_VERSION_RULES`），发布脚本一行调用，测试脚本可以在临时目录里构造「文档版本字 ≠ 目标版本」的红态，跑一遍同步，断言转绿——**红→绿有牙，且不联网、不碰真实仓库**。

## 3. 爆炸半径

- 进程数 × 读者数：改动只在**发布会话**里触发（`publish-dev.mjs` 被调用时）；读者是 `doc-facts` / `test-version` 两条门禁。
- 静默风险：同步写不进 git（比如工作区有冲突、`git add` 漏了文件）→ 发布提交里文档版本字没跟上 → 门禁红，但发布仍会进行（脚本在 `--yes` 下不跑全量门禁，只跑清单校验）。
- 不碰用户数据/密钥/花钱：纯本地文本改写 + git 提交。

## 4. 取舍

| 路线 | 做法 | 结论 |
| --- | --- | --- |
| **A（选）** | 抽 `publish-dev-doc-sync.mjs`，发布脚本调用，`git add` 把两个文档也加进来；`test-dev-publish.mjs` 加功能自证（临时目录红→绿） | 收益：根治，以后发 dev 构建自动同步；成本：新增 1 个模块 + 测试 30 行；风险低，回滚就是删调用 + 还原文档 |
| **B（否决）** | 在 `publish-dev.mjs` 里直接内联两行 `String.replace` | 也能根治，但逻辑散在发布脚本里，测试只能做「源码里有没有这行」的弱断言，无法做红→绿功能自证 |
| **C（否决）** | 改 `doc-facts.mjs`，把两处文档版本校验改成「只比较 core 部分」 | 把校验放宽来迁就脚本，等于把「文档与代码一致」的契约降了等级；文档版本字错了也不再报错，风险更大 |

## 5. 生效与重启

- 谁读这个文件：`publish-dev.mjs`（发布会话调用）、`test-dev-publish.mjs`（门禁）。
- 要重启的进程：无（发布脚本是一次性 CLI，改完下次发 dev 构建即生效）。
- 已装用户的已发布快照不受影响：`v0.9.0-dev.2` 快照本身仍是红的（它在文档同步之前就上传了），修复在**下一次**发 dev 构建时才带上。

## 6. 验证

### 6.1 红→绿功能自证（`scripts/test-dev-publish.mjs`，临时目录）

```
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
node scripts/test-dev-publish.mjs
```

预期（本次实测）：`✅ publish-dev 调用文档版本字同步`、`✅ 同步覆盖两处文档`、`✅ 同步前两处文档版本字与目标版本不一致（红）`、`✅ 同步后两处文档版本字与目标版本一致（绿）`，末行 `✅ dev 通道发布链路通过`、`TEST_EXIT=0`。同步逻辑单独跑（临时目录）同样确认：`RED_COUNT=2`（文档 `0.9.0-dev.2` vs 目标 `9.9.9-dev.9`）→ `syncDocVersions` 后 `GREEN_COUNT=2`。

### 6.2 仓库现状门禁（HEAD）

```
npm run doc-facts > /tmp/g7p7-docfacts-pre.log 2>&1; echo DOCFACTS_EXIT=$?   # 0，✅ 所有文档数字与代码一致
npm run test:audit   # 207/207（含 test-dev-publish 与 test-version）
```

## 7. 回滚与残余

- **回滚**：`git revert` 本次提交即可；脚本调用与测试一起回退，无数据残留。
- **残余**：
  1. 已发布的 `v0.9.0-dev.2` 快照本身仍 `doc-facts` 红（文档同步在它之后才做）——下一次发 dev 构建时自然带上修复，无需回滚已发布物；
  2. `scripts/version.mjs` 的 `bump()` 同样只改 package.json/README/CHANGELOG，不碰那两处文档——但 `bump` 用于正式发布（main 上版本号 `0.9.0` 与文档一致，因为发布会话手工同步了），不是每个 bump 都过 `doc-facts`；若要彻底统一，可让 `version.mjs` 也调同一模块，本轮未做（避免扩大改动面）。
- **可转发交接块**：见 `docs/RELEASE-QUEUE.md` 对应批次。
