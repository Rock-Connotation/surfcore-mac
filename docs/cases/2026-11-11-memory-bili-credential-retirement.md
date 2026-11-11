# Bili Memory V2：凭据写入前确认旧作业退役

状态：后端局部验收通过；Core 全生命周期与总目标仍未完成。

## 1. 链路

实际插件 `index.js` 的 cookie、账号重置和扫码轮询进入 `bili-qr-login.mjs`。旧 Host 的 `withTransition` 在整个退役确认和账号变更期间阻止新任务；二维码等待与主人扫码保存保留原行为。

## 2. 机制

直接写 cookie 或重置账号会让旧 Native 作业继续携带原来源。扫码的真正写盘发生在账号验证后的 poll 内，单在 HTTP 入口等待会过早打断作业。现在 fish 保存接受 `withCredentialTransition` 私有回调，在实际保存前退役；cookie 与账号重置整个变更也经过同一屏障。退役失败时没有凭据写入。

换号旧凭据 rename 到时间戳加 UUID 的唯一备份目录，附属对齐文件排他复制。归档失败返回 `BILI_V2_ACCOUNT_ARCHIVE_FAILED`，配置清理失败返回 `BILI_V2_ACCOUNT_RESET_FAILED`；已归档字节保持可恢复。API catch 保留 BILI_V2_/MEMORY_/CHARACTER_ 的 code/error/hint，并进入既有 L2 记忆通知。

## 3. 影响面

修改一个插件 Host 的三条账号入口及扫码保存函数。没有运行实际扫码、导航请求、账号重置或凭据迁移。验证使用假 CDP、假 NAV 和内存文件系统。既有 API 失败展示消费结构化失败；本阶段未改变页面布局。

## 4. 取舍

采用保存前回调，让等待中的轮询不触发无用退役，并保留独立 QR 模块默认行为。整段轮询先退役会反复中断；仅保存后清理存在账号切换窗口，均不采用。rename 备份让后续配置失败也能找回原字节。

## 5. 生效

由桌面插件 Host 读取；完整门禁和安装后重载。本次未重启桌面应用，生产仍默认 V1。

## 6. 验证

Node24 运行 `plugins/surfcore/scripts/test-memory-v2-bili-lifecycle.mjs`：10例通过，覆盖等待/拒绝/允许/主人 QR，cookie/reset 拒绝时零写入，归档失败/配置失败/成功可恢复，以及实际 API 包装器的 code/hint/通知。

`node scripts/test-bili-qr-login.mjs`、完整 `test-memory-v2-bili-host.mjs`、实际 Runtime 的 `test-memory-v2-bili-index.mjs` 同时通过。证据在 `_backups/memory-v2-coordinator/bili-lifecycle/` 与 `native-retirement/{credentials,qr,index,host}.green.log`。没有外网或真实 provider。

## 7. 回滚与残余

源文件备份在 `_backups/memory-v2-coordinator/bili-lifecycle/`。实际换号恢复需停止相关作业，核对账号后从唯一备份恢复，保留后来产生的新账号文件。Core 回调、QQ Native 与迁移仍待完成；完整审计/桥接回归待运行。

## 发布交接块

- 范围：Bili 凭据变更前的退役 ACK、扫码保存屏障、可恢复归档和结构化失败。
- 文件：`index.js`、`bili-qr-login.mjs`、新增 lifecycle 测试与本 case。
- 验证：10例及 QR/完整 Host/实际 Runtime 通知回归通过。
- 状态：阶段接受，未提交/安装/激活，总目标未完成；禁止单独视为可发布。


### 2026-11-11 11:38 当前工作树阶段门禁通过

`npm run test:audit` 176/176 scripts passed；`npm run test:regressions` 全部通过。日志和receipt见 `_backups/memory-v2-coordinator/phase-gates-2026-11-11/`。最终 Root 普通12项、实际SDK1条假provider请求及完整Host复验均通过，见 native-retirement/verification.json。上述为当前阶段基线；QQ Native owner最终变更尚待独立Native复验，来源/Bridge/预算联合、Core生命周期、迁移尾增量与全目标验收仍未完成，不能进入提交/安装或生产切换。
