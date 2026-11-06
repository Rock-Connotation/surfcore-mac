# B站动态发布结果与回执（2026-11-07）

## 完整逻辑

1. **链路**：`bili.mjs dynamic post` 经互动、身份及额度检查，在账号目录 `dynamic-actions/<actionId>.json` 独占持久化意图后调用平台；确认 ID 后在发前捕获的角色 B站目录写 `dynamic-receipts/<id>.json` 与 `quota.json`。意图记录绑定角色及 nav 账号；无角色时沿用旧账号目录。list/check/rm 不改。
2. **机制**：原命令对平台非零 code 仍退出 0，成功不记额度，dry 在检查之前退出。新路径将拒绝、未知、确认成功但本地对账失败分别返回 code/error/hint；同一 actionId 已有意图时只返回原结果或未知，不再次 POST。正式发送前重新检查角色 id/epoch 和账号凭据文件 hash，并将 nav 账号与审批账号 `--expected-mid` 比较；重放也核对记录的账号绑定。支持 `--action-id` 与结构化 `--json`（JSON 正式发布必须指定 actionId 和 expected-mid，账号 ID 不输出）。文件写入先 fsync 临时文件、rename、再同步目录；Windows 不支持目录同步时有兼容分支，尚未实测。
3. **影响面**：仅动态 post；真实外发一次至多一个 POST。涉及账号和本地角色账本，不写入凭据或正文。dry 会执行只读平台请求，但无 POST；在互动关闭、身份不安全、额度损坏时拒绝。
4. **取舍**：直接复用原 quota 子进程成本低，但其响应后重新选择角色可能记错账；选择固定角色目录并写兼容账本，保留独立 ID 回执，成本是沿用现有无跨进程锁账本的并发风险。未扩展其他平台动作。
5. **生效**：重新载入命令源文件的进程即可；当前安装包需由集成方重新打包并明确安排替换，未操作官方 App 或账号。
6. **验证**：`node plugins/surfcore/scripts/test-bili-dynamic-receipt.mjs` exit 0，使用隔离 DSH_HOME 与虚构凭据，子进程树经 NODE_OPTIONS 注入 fetch 白名单桩。覆盖拒绝、HTTP、解析、丢 ID、传输失败、同 ID 跨进程重放、损坏或未完成意图、角色 epoch 与凭据切换、审批账号不符及旧记录缺少账号绑定、落账、dry 三个闸门及 JSON CLI。隔离 HOME/DSH_HOME、限制非 loopback 出站的上一版 audit 日志 `/tmp/surfcore-receipt-audit.51wxw1/audit.log` 报告 163/163；脚本包装器在测试后误将 zsh 只读变量 `status` 赋值并退出 1，因此 npm 原始退出码未捕获。本轮追修后组合检查由集成方执行。
7. **回滚和残余**：恢复此批 2 个源码文件可回退命令；先保留 `dynamic-receipts` 和 `quota.json`，不得删除。已发出后进程在收到 ID 之前退出仍可能未知，需账号空间人工核对；并发命令共享 quota.json 无跨进程锁，不能承诺并发记账不丢。receipt 或 quota 写失败返回已确认 ID，要求人工对账而非重发。平台 UI、真实断电、Windows 目录 fsync 与真实账号外发均未验证。

## 两条路径

- dry：登录态/WBI 只读获取 → 互动、身份、额度检查 → 不发 POST；dry 通过不等同正式发布结果。
- go：通过检查 → 持久意图 → 最终身份核对 → 单次 POST → 明确拒绝、未知或带 ID 的确认 → 持久回执与额度成功后才报告成功；同一 actionId 重放始终不再 POST。新操作 ID 代表另一次外发，不能用它绕过未知结果。

## 隔离测试事故记录

首次执行 `node plugins/surfcore/scripts/test-bili-dynamic-receipt.mjs` 时，fetch 桩仅用 `--import` 注入 `bili.mjs` 父进程，未传入其启动的子进程；因此子进程可能尝试平台 nav GET，是否实际出网无法从现有证据确定。仅使用临时 DSH_HOME 与虚构凭据，且命令为 `--dry`，无 POST。随后改用 NODE_OPTIONS 向子进程树传播白名单 fetch 桩，未知请求立即报错并记录测试失败；未读取网络历史。

## 发布交接

- **范围**：动态 post 结果判定、角色固定回执与额度记录；无版本变更或发布。
- **验证**：执行上述隔离测试及集成方最终门禁；真实账号、安装包及 Windows 另行验收。
- **回滚**：恢复本批源码；保留所有新旧角色回执和额度账本。
- **发布要求**：集成方核对清单并按发布流程取得用户明确授权；未知结果或本地对账失败不得重发。


## 主线真实平台验收

用户明确批准指定测试账号及固定原文一条动态；25389e9安装候选执行一次POST，ID1267640197110038528。独立签名detail GET HTTP200/code0，作者与审批MID、正文均逐字匹配，账号级action意图已确认、角色quota仅一条。未评论/点赞/转发/QQ通知或删除；固定测试文案不算模型自主生成。证据及后续见[组合case](2026-11-07-bili-round-integration.md)，本机原始记录dynamic-go/readback.json。
