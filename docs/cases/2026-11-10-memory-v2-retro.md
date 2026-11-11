# Memory V2 接续过慢复盘（2026-11-10）

## 证据与判断

读取本次协调者及两位 HY4 的 `session.v4.jsonl.zstd` 原始事件；仅统计时间、usage、工具完成记录，不复制提示词或凭据。模型步骤按同 turn/step 的 step/start 至 assistant/message 配对；工具累计与子代理并发累计不是总墙钟，不能相加解释整段时间。

1. 首要：Bili HY4 截至取样模型步骤累计约 4.9 小时、工具任务累计约 138 秒；最长模型步骤约 11.6 分钟，provider 报告输出约 146 万 tokens（包括推理）。瓶颈在长推演与反复探索；测试计算量不是主要时间项。该路由当前只列出 high，保持用户限定的 HY4，不尝试其他模型或继承绕行。
2. 调度：首次 source hand_back 把合成的 bash/seq 反例当实际 Host 差异；协调者后来用真实 Host 投影确认只是工具名排序。official 首版普通 44 条通过后，才补审 Host CSRF、redirect 与 top-level reply 接缝，带来第二轮。实现前应先固定实际调用样本和认证归属。
3. 导航与输出：HANDOFF 3102 行、PITFALLS 4258 行；启动规则说“60 行”，实际 AGENTS 163 行。大段读取与重复总结增加上下文压力。新增短入口，历史只定向查，保留完整追溯。
4. 自动检查：root audit 的显式列表、插件原 npm test 都没有接 Memory V2；没有 .github/workflows 或 .husky。此轮接入插件 npm test 和根定向入口；CI/pre-commit 尚未建立，仍是后续环境候选，不声称已有远端门禁。
5. 缓存：协调者前 84 请求共 14.04M input、13.35M cached，命中 95.1%；19 次压缩净节省约 9.36M token。重压缩有 209.7K token 重付，但不是本次小时级等待的主要解释。缓存统计不能证明网络延迟或推理时间。

## 已落实

- 两位现有 HY4 收到同一收敛约束：一轮一个具体动作、每三轮增量回报、越界具体 hand_back、最终最多 15 行；保持安全断言和 native 配额。
- `scripts/run-memory-v2-tests.mjs` 发现普通 Memory V2 脚本，支持 --match/--list/--plugin；固定隔离真实 Host、Electron 自动启动和浏览器验收，并清除 native 环境开关。插件 npm test 追加普通脚本，根新增 test:memory-v2。
- 原实施计划顶部加入当前状态、短入口、接缝先行和定向验证命令；修正已经过期的“只能 Sol、等待 HY4”阻塞描述。

## 完整逻辑

1. 链路：本地 package.json → 普通 runner → 现有模块测试；插件 npm test 在原链尾追加 runner。业务、模型、桥接运行时没有改变。
2. 机制：缩短反馈范围并暴露漏接测试；真实 native/UI 单独保留，避免普通检查意外启动真实 Host 或耗尽一次性配额。
3. 爆炸半径：开发检查与交接导航；不读生产数据、不外发、不调用模型。完整门禁仍在组合冻结后由协调者独立执行。
4. 取舍：采用复用已有测试与 npm 接线，成本低；全局规则重写/公共 Host 推理预算改造影响更大，本次不执行。CI/hook 可后续接同一普通入口。
5. 生效：下一条 npm 命令和下一份工单即可使用，无需重启或安装公共 DSH。HY4 单请求生成上限未由工具暴露；流程收敛能否降低后续模型耗时须再取样，不能预先承诺倍数。
6. 验证：运行 --list、定向 ordinary 和完整 ordinary；语法与 whitespace 检查。执行结果追加下方。该结果不替代原任务 native、平台组合或最终 audit/regressions。
7. 回滚：覆盖前备份在 `_backups/memory-v2-coordinator/retro-*/`；按明确文件恢复 package/plan，新增 runner/case 可先归档。保留其他工单脏改动。没有修改公共运行时、版本、提交或发布。

## 可转交发布会话的交接块

- 性质：开发流程/测试入口，无用户运行时行为变化；不改版本、不提交、不推送。
- 文件：scripts/run-memory-v2-tests.mjs、根和插件 package.json、Memory V2 实施计划及本 case。
- 结果：见下方验证；普通套件与 native/UI 分离，原 Memory V2 总目标仍未完成。
- 失败：runner 非零退出，显示失败脚本和尾部日志以及单脚本重跑命令；不把拒绝/跳过标成真实集成成功。
- 残余：没有实际远端 CI；HY4 仅 high、每请求输出预算不可由现有派发工具设定；后续延迟改善尚未量化。

## 验证记录

- 普通入口：23/23 脚本，86.5 秒；真实 native/UI 未运行。
- --list 与 --plugin --list：范围正确；缺失 --match 参数、未知参数、无匹配：均退出 2，给出操作提示。
- runner 语法检查、git diff --check：通过。根/插件版本保持 0.8.8，既有 test 链完整保留。
- 原始日志计量摘要：`_backups/memory-v2-coordinator/retro-20261110-172351/timing-summary.json`。截止用户提出 retro 的 17:15:29：协调者 82 steps / 1814.5s model / 7.2s settled tools；Bili 180 / 17515.7s / 138.3s；渠道 74 / 5270.4s / 194.6s。是分会话累计，不能跨并发会话相加作墙钟。
- `npm run test:regressions`：17/17，通过，2.8 秒。
- `npm run test:audit`：175/176，102.8 秒；`scripts/test-perception-service.mjs:88` 预期 partial 却为 failed。单独重跑在 :36 预期 completed 却为 failed。两份隔离 job.json 都记录 `ASR_DISK_SPACE_LOW`（resources 阶段），不是断言需放宽；实测仅余 545.4 MiB。完整日志见同备份目录 test:audit.log，单项失败 fixture 原样保留。
- 总门禁受磁盘空间阻塞；遵守保留既有未提交改动与备份的约束，不清理、不修改 ASR 资源预检。先完成其余工程，空间恢复后补单项和总审计。此轮没有真实 native/UI/平台外发；不标 Memory V2 总目标完成。
