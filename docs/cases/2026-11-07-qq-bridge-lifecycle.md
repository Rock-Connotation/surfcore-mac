# QQ 桥接进程身份与常驻恢复（2026-11-07）

## 现象与修复

macOS/POSIX 下旧停止路径只看锁文件 PID 存活，可能向已复用的无关 PID 发 SIGTERM；启动路径只看端口，可能把任意监听当成成功。独立临时目录复现两者：真实 `start()` 遇无关监听错误返回 `ok:true`，真实 `stop()` 根据锁 PID 终止自有测试 sleeper；原始失败日志保存在工作树 `_backups/20261107-qq-lifecycle/red-foreign.log` 和 `red-pid.log`，不含真实用户数据。

## 完整逻辑

1. **链路**：官方 DSH Host 中 `plugins/surfcore/lib/index.js` 调用 `lib/bridge.js` 管理独立桥接进程；桥接的锁在当前 QQ 数据根的 `state/bridge.lock`，端口配置由 QQ 数据根读取。状态接口和 Host 的相关启动、停止、重启调用均复用同一管理器。
2. **机制**：锁只记录 PID，不证明它仍属于原桥接；TCP 端口开放也不证明服务身份。POSIX 现在要求同一 PID 的可执行文件与实际脚本参数匹配、PID 拥有目标 loopback 监听、认证状态的程序根匹配，才接受已运行或向其发送停止信号。执行 `ps` 和 `lsof` 均用参数数组，绝不通过 shell 拼接；路径 canonical 化。待停止 PID 贯穿核验，认证期间锁变化会拒绝；存活但无法核验的锁不会被杀，也不会谎报已停止。死亡锁不静默删除，原桥接启动路径负责处理。Windows 原停止路径保持不变；启动已有监听也要求认证状态与根匹配。
3. **影响面**：配置保存、手动启停、Host 的 120 秒自愈都调用相同管理器；发生冲突会返回 `BRIDGE_OWNER_UNVERIFIED`、错误与下一步，避免误操作。此修改不触碰账号、会话或平台消息。`index.js` 保存设置 warning 和 `start-qq` 顶层错误转译仍须组合方补全，否则部分 UI 可能丢 hint。
4. **取舍**：A 保持 PID/端口启停，兼容成本低但无法区分他进程；B 同时核验进程、监听、认证与安装根，成本是依赖本机进程工具且不确定时拒绝，收益是阻止已复现错误。选 B。Linux 还需 `lsof`；缺失或受限时安全拒绝。进程身份核验与 SIGTERM 之间仍有微小 PID 复用竞态，不宣称内核级原子保证。当前锁格式不能单独证明跨 profile 归属，认证、根和数据根锁共同提供证据，严格隔离仍需完整原生验证。
5. **生效与重启**：包中 Host 进程需加载更新后的 `bridge.js` 与 `bridge-process.js`；仅更换文件不保证已加载模块刷新。现存桥接无需被无条件终止。关窗不是退出；不增加登录启动或改变 App/Host 的卸载语义。
6. **验证**：官方内置 Node 24 的 `plugins/surfcore/scripts/test-bridge-process.mjs` 用临时中文空格和 shell 字符路径、loopback 假监听、可控自有子进程验证陌生监听拒绝、无关存活 PID 不杀、死亡锁保留、真实认证 owner 启停、检查失败拒绝、认证期间锁切换拒绝及不执行 shell。官方 Node 24 下隔离 HOME/DSH_HOME 与非回环网络禁止：`npm run test:audit` 164/164、`npm run test:regressions` 和插件完整 `npm test` 均 exit 0，日志位于 `_backups/20261107-qq-lifecycle/`；新测试尚需由组合方注册 audit。`release-manifest.mjs --verify .` 为 ok 767 / 不符 6 / 缺失 0（本次 bridge.js 一处加五个未修改的既有 bat 字节差异），组合后重新生成并验证；不把夹具等同真实 QQ、睡眠恢复或 24 小时常驻。
7. **回滚与残余**：恢复备份的旧 `bridge.js` 并移除新 helper 的引入即可回滚，但会恢复错误 PID 风险；保留状态和锁，不自动删除。真实 App 常驻、授权审批、NapCat/Colima 启停、睡眠及不同平台尚待组合环境验证。

## 失败与处理

`BRIDGE_OWNER_UNVERIFIED` 表示未能同时核对锁、进程、监听和认证状态；检查路径、令牌及目标进程身份后重试，不要手工结束未知 PID。进程停止出错或超时也返回 code/error/hint；已关闭的端口并不证明锁 PID 安全可杀。

## 发布交接

- 现象：陌生监听被当成 QQ 桥接；锁 PID 被复用时可能误杀无关进程。
- 变更：POSIX 启停前核验认证状态、精确进程及监听归属；异常 fail closed。Windows 停止方式保持原状。
- 验证：Node 24 隔离 fixture 及组合门禁结果见 `_backups/20261107-qq-lifecycle/`；最终制品与清单由组合会话生成。
- 边界：没有执行真实 QQ 或供应商请求，不等于全天常驻、跨系统或登录启动通过。无版本、tag、推送或发布。
