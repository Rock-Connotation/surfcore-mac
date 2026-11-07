# 本地分支与 worktree 收敛到 main（2026-11-08）

## 结果与范围

用户明确要求合并本地主分支，并清理已合并分支/worktree以释放磁盘。初始42个worktree、42条本地分支，最终保留原主目录和main各1个，移除41个worktree/41条主题分支。本克隆原本没有dev，因此未为清理再创建新分支。该请求是对本轮本地主线收敛的明确授权；版本仍0.8.8，远端/tag/Release均未改，不能把本地main名称当作新版本发布证明。

最终功能来自昨天已实装/验收的914bd28（实际程序f882468）。正常功能合并1719200后，再以5c748d0收拢冗余摘取历史；两次合并所得文件树与914bd28逐字节相同。所有旧分支提交均是main祖先，之后才使用`git branch -d`，没有强删未合并提交。

## 完整逻辑

1. **链路**：仓库共用.git对象库→42个工作目录→根依赖、未提交文件、忽略的验收/备份资料。Git引用本身很小；多轮ASR测试复制的大音频才是主要占用。常用DSH的程序/资料在用户目录，但App启动cwd还指向旧工作树，必须先正常改从保留主目录启动，再清除旧目录。
2. **机制**：先固定每树HEAD/status及占用，生成并验证全引用Git bundle。逐文件保存221份未提交/未跟踪原件、二进制diff与hash；辨别已在最终历史中的版本和被后续修复替代的中间态，不用旧稿覆盖较新的已验收实现。独有_backups、设计、research和state原样rename到仓库外私有归档，inode/device核验一致；根node_modules可由lockfile重建，主目录离线重装一份。大ASR夹具先tar.gz，再从归档逐文件计算SHA并复核源未变化，完全一致后移除源目录。完整清单和恢复说明位于私有归档。
3. **爆炸半径**：1个共用Git对象库×42个工作目录；另有1个常用DSH的cwd引用。属于磁盘/历史整理，不改业务接口、模型路由、身份、记忆格式或受众权限。常用348程序文件一致，原13插件版本、人格/少女立绘、分享原件和11次手动消费账本保留；昨晚的运行记录不回退到旧快照。
4. **取舍**：A（采用）以最终验收分支为代码权威，普通合并其功能，再对已证明摘取等价的旧分支做仅历史收拢；收益是最终代码不倒退且所有旧提交可追溯，成本为patch/blob核验、备份与组合检查，Git bundle和中间稿可恢复。B逐树把旧脏文件重新提交并普通重放；会把已被修复的中间态/旧登记重新带回、制造大量文档冲突，成本和回归风险更高。对13条非祖先分支，普通patch-id已证明其它摘取等价；剩余engine/UI的6提交另逐文件证明其源码/测试与真实集成提交blob完全相同，只有文档组合差异。仅这些冗余历史使用ours策略，结果tree不变。
5. **生效与重启**：先确认常用DSH在设置页、没有进行中的观看/接话且engine无活锁，按精确PID/出生时间/启动参数正常Quit，再以同一profile、无debug、cwd=保留主目录重新启动。旧失败作业属于终态，不应误认仍在执行。读取实际cwd/安装hash并看原生截图核验；未清用户目录、凭据或运行记忆。旧worktree全部移除后，再核对主目录与单一分支。
6. **验证**：5c748d0代码冻结后，官方Node24运行`npm run test:audit`、`npm run test:regressions`、`npm run test:plugin`，最终174/174、17项和完整插件均exit0。首轮audit173/174：离线`npm ci --ignore-scripts`跳过了仓库已有SDK ESM补丁。先备份两个依赖dist，执行原`patch-snowluma-sdk.mjs`（只修本地node_modules，不写~/.dsh），定向健康测试通过，再完整重跑三门禁。未改业务代码/测试或放宽断言。最终文档/清单另提交，并对Git对象清单、严格隐私及空白复核；程序源不变，详细日志见归档。
7. **回滚与残余**：所有代码仍在main及全引用bundle；使用`git bundle list-heads`定位原引用，恢复到新的recover分支。未提交中间态由working原件/patch/hash恢复，私有ignored资料及压缩夹具按原相对路径取回并核验。不要将旧消费账本覆盖当前用户目录。旧私有证据路径改为归档索引读取；归档不是活跃profile，不应直接运行其中旧配置。无新模型请求/平台外发，无远端推送、发版或稳定性扩展验收。

## 失败处理及核对边界

实际删除前重新核对HEAD/status、main祖先关系及未提交原件hash；任一变化立即停止该树清理并保留现场，不用force绕过校验。`worktree remove --force`仅用于已完整保全的脏中间态与已识别的根依赖，不用于丢弃独有源码。分支删除始终`-d`。归档校验失败不删除源；资料存于仓库外0700私有根，不进Git。没有新增产品失败路径，沿用现有界面的code/error/hint行为。

## 证据与用户验证

- 主目录执行`git worktree list`及`git branch --format='%(refname:short)'`应各只有1项/main。
- `git diff 914bd28 5c748d0 --exit-code`应无差异；后来只加本次文档及派生清单。
- 私有索引：`<GITHUB_PARENT>/_surfcore-cleanup-20261108/README.md`；包括inventory、merge-proof、cherry-pick-code-proof、working-preservation、worktree-removal、branches-deleted、fixture manifests、checks-main-final、runtime-final及FINAL-RESULTS。
- 磁盘实际可用空间在FINAL-RESULTS保留前后数值，不用du的APFS克隆逻辑总量冒充实际释放量。独有验收/登录备份集中保留，未为追求数字删除。

## 可转发发布交接块

```text
【本地整理交接，未发布】
主题：42个本地分支/worktree集中到main，清理41个主题分支和41个工作树
功能基线：914bd28；普通功能合并1719200、已摘取历史收拢5c748d0，文件tree与基线完全相同；后续只文档/安装清单
范围：仓库历史、工作目录、重复依赖/测试夹具及私有资料归档；未改业务接口/模型/人格记忆
验证：官方Node24 audit174/174、regressions17、完整plugin exit0；SDK离线重装漏补丁已按原postinstall补齐并完整复测；最终manifest/严格隐私见HANDOFF
运行：常用DSH保持原348文件/13插件/人格少女立绘/分享/额度，正常启动cwd改为保留主目录；无debug/新增模型/平台外发
恢复：全引用Git bundle+逐文件未提交原件/patch+原样ignored资料+逐SHA压缩夹具均在仓库外私有归档；禁止恢复旧账本抹掉当前消费
版本/远端：0.8.8未变；本地main包含未发布功能，不代表Release；没有push/tag/发版
```
