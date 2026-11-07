# QQ 有界手动常驻的真实恢复（2026-11-07）

本例记录官方 DeepSeek Harness 0.2.2-rc.1 独立 profile 的私有手动入口，不将验收助手当成公开产品。程序源 `0502afa`、版本仍为 0.8.8；模型和外发沿用本轮唯一对象及累计 12 次 Hy4 / 30 条文本，不能按天或重启重置。无开机自启。

## 完整逻辑

1. **链路**：`manual/manual.py` 管理独立 runner；runner 管理固定 NapCat 容器、模型预算代理和 QQ 文本网关。三个地址就绪并写入独立配置后，`launch-native.py --resident` 启动官方 App，Host 启动已安装 bridge。`resident-status.mjs` 读取该包 bridge 状态，并验证 Host 唯一回环监听的父链属于记录的 App。只有程序根、App、bridge、DSH、QQ 和模式同时匹配才返回 `RESIDENT_READY`。
2. **机制**：PID 或端口单独不能证明归属。App 身份绑定固定可执行文件、完整参数、user-data、DSH_HOME、source、PID 与 `lstart`；动作前再核验。停止先执行已安装 bridge 的强所有权检查，再对准确 PID 的原生菜单请求 Quit，确认退出后才 SIGTERM 自有 runner。原 10 秒 runner 等待不足，实际超时后服务稍后才全部退出；现改为单调时钟最多 55 秒，仍不强杀。App 内层最多 45 秒退出，外层控制器 120 秒避免提前截断正常收尾。
3. **影响面**：只涉及独立 App/profile、固定容器及本轮两份累计账本；不重建容器、不动 QQ.app 或常用 profile。配置只更新模型 baseURL 和 QQ httpUrl/wsUrl，保持 MCP 后缀原字节，并在写前解析完整 YAML；原件以 0600 备份。定时记忆维护与旧数据迁移保护开关继续保留，避免额外通知或未评估迁移。手动入口不代表无限期费用授权。
4. **取舍**：全自动登录启动能减少点击，但增加账号验证、费用和重复实例的处理范围；用户选择手动启动。缓存登录只在一次明确 start 中对批准小号尝试一次，失败或未知不自动重发。扫码后 `resume` 只读核对原账号和在线状态，复用现有服务而不重启 runner、不再次调用缓存登录。与继续保留 Electron 调试端口相比，resident 模式移除调试参数，使用系统进程和桥接状态核验，代价是不能靠 CDP 检查 UI。
5. **生效与实机结果**：完整 `stop` 已返回 STOPPED，独立 App、runner、代理、gate 均退出，旧监听全部关闭，容器停止；Quit 为 PID 绑定原生菜单，App 退出实测 908 毫秒。随后一次 `start` 返回 QUICK_LOGIN_FAILED 且 quickLoginAttempted=true，没有自动重试；用户在独立二维码页确认同一小号，`resume` 只读核验身份和在线后成功。无调试 App 实测无 remote-debugging 参数、主 App 无 TCP LISTEN，旧调试端口关闭；status 返回全部就绪。完整停止没有重置模型 10/12 和文本 17/30。
6. **验证**：官方 Node24 的程序源冻结检查为 audit169/169、regressions 与完整插件 exit0；325 个安装文件逐 SHA-256 匹配第四包，369 个持久文件安装前后不变。私有身份/status、24 项 manual、11 项缓存登录和 7 项 QR 离线检查通过，Astra 最终冻结审查无待修 P1/P2。扫码助手显式禁用环境代理；新增测试最初因假 HTTPHandler 未替换，误向本机发一次虚构 bearer 的只读 CheckLoginStatus 并收到 -1，未使用真实凭据、未调用模型或发送 QQ；已记录，之后全部 QR 测试禁止 socket 联网。真实资源与纯离线证据分开。
7. **回滚与残余**：保留原包、配置、启动记录、私有助手副本、账号、会话及新增账本；确认停止后按实际安装所有者恢复，不覆盖新数据或退额。身份不明、登录失败、配置部分提交、退出超时及未知回执均输出 code/error/hint，先核对再处理。`lstart` 秒级精度及进程/监听分步快照仍有窄竞态。最终普通私聊已由平台与用户手机双端确认，无调试Quit后9个自有进程退出、再resume就绪，细节见组合 case；不据此推断睡眠、全天在线、选项 A、群聊或媒体通过。

## 最终运行状态（05:43）

最终普通QQ走实际WorkBuddy Hy4 HTTP200，平台回复正文与用户手机一致；本轮11/12模型、19/30文本。随后无调试原生Quit（876毫秒）确认9个自有进程退出，复用已登录服务resume，最终status全部ready，独立实例保持运行。没有续额、开机自启或后台额外测试。

## 使用与失败恢复

私有入口位于本地 `_backups/20261107-qq-resident/manual/README.md`。从本工作树运行 `python3 _backups/20261107-qq-resident/manual/manual.py start|status|stop`；扫码完成接续用 `resume`。严格拒绝不认识的 PID、路径、账号和配置，不按名称全局结束进程。缓存登录失败时 App 保持关闭、已有服务保留，需要扫码后 resume；不反复 start，不删除 operation/runtime 锁或账本。

## 原始证据

私有 `_backups/20261107-qq-resident/`：`manual-final-stop.json`、`manual-full-stop-proof.json`、`last-owned-stop.json`、`manual-final-start.json`、`manual-final-resume.json`、`manual-final-status.json`、`final-resident-proof.json`、`final-install-proof.json`、`resident-final-review.md`、`qr-offline-test-incident.md`、`resident-native-quit-proof.json`、`final-running-proof.json`。原始凭据、二维码、完整配置和账户不进发布物。

## 可直接转发的发布交接块

```text
改了哪些文件：本例与组合 case 记录真实恢复；私有 manual/identity/status/QR 助手不进正式包
测过什么：完整 stop、缓存登录拒绝无重试、用户扫码后 resume、同源安装与无 debug 状态通过；最终收发见组合 case
建议：程序修复建议 patch；版本由发布会话决定，本轮不改版本、不发布
case：docs/cases/2026-11-07-qq-manual-recovery.md 和 qq-resident-approval.md
层级/兼容：受控私有运行管理；不变更公共接口或旧默认
完整逻辑/爆炸半径：见七步，只涉及独立 profile、固定容器与唯一对象
失败路径：结构化 code/error/hint；未知身份或结果拒绝，缓存登录不自动重试，备份保留
回滚/残余：保留账号与新数据，不重置预算；不等同于全天稳定、睡眠、开机自启或正式发布
```
