# Memory V2：旧来源稳定标识记账

状态：私有登记模块独立接受；没有连接生产观察器、导入器或激活路径。

## 1. 链路

`src/core/memory-v2-legacy-registry.js` 提供 `openLegacyRegistry({filePath,create=false})`，返回 read/register。可信进程内 Host 传入已经独立验证的 logicalStreamKey 与不透明 segmentIdentity；模块生成稳定 UUID，read 返回规划器现有 streamRegistry 映射。

## 2. 机制

同一标识对重复登记返回原 ID；任一已绑定键或身份出现矛盾就拒绝。独立 SQLite 使用 BEGIN IMMEDIATE、唯一约束、严格 schema、版本/application 检查、quick_check 和有序 checksum，DELETE journal + synchronous EXTRA。创建排他且同步父目录；不覆盖已有登记库。提交回执不确定返回 `LEGACY_REGISTRY_COMMIT_UNKNOWN`，保留原库/日志，重新打开同库核对。

## 3. 影响面

当前只有新模块及隔离测试调用，没有实际来源、角色、ACL 或用户数据写入。登记只确认映射一致性；物理替换、历史身份、权限、回滚或恶意重写证明均由后续可信 Host 契约承担。checksum 只检测不一致，不能替代授权。

## 4. 取舍

选择事务数据库持久化不透明映射，获得并发冲突和不确定提交后的原映射查询。路径/inode/hash 无法证明段世系，拒绝用它们生成迁移权威。物理观察与 Core 导入分开实现，避免把测试传入的标识误当真实历史证明。

## 5. 生效

模块目前未接生产，无需重启或配置。使用与当前 Core 相同的 node:sqlite 前提，Node24 已验证。V1 保持默认。

## 6. 验证

Node24 `scripts/test-memory-v2-legacy-registry.mjs` 独立通过：重开/幂等、明确不同段、矛盾绑定、缺身份、锁争用、COMMIT 前后丢回执、损坏字节保全；规划器消费映射后仍 `importReady:false`，未知权威进入 quarantine/authorization:not-issued。

原 `scripts/test-memory-v2-migration-plan.mjs` 独立通过22 checks、39合成来源。证据 `_backups/memory-v2-coordinator/legacy-registry-independent/`；契约见 `docs/plans/2026-11-11-memory-legacy-registry-contract.md`。

## 7. 回滚与残余

新模块未接生产，可在保持 V1 时撤下新文件。登记库不得自动删除、重建或回滚。真实 Host 来源观察、旧跨度 checkpoint、Core 私有导入、可见迁移预览和尾增量切换仍待完成，需要独立预览授权。

## 发布交接块

- 范围：可信 Host 提供的不透明身份映射记账。
- 文件：新增 registry 模块、隔离测试、契约及本 case。
- 验证：新登记测试、原规划器22/39通过；生产导入/观察未实现。
- 状态：模块接受，总目标未完成，未提交/安装/激活；不可据此发布。
