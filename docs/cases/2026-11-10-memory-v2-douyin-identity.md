# Memory V2 抖音实时官方身份接线

状态：代码接线与隔离测试通过；尚未安装桌面 Host，V1 默认不变。不是整套 P0–P4 完成声明。

## 完整逻辑

1. 链路：`plugins/surfcore/lib/index.js` 将 `getPlatformState('douyin')` 连接到现有 `douyin.readOfficialIdentity({characterId,characterEpoch})`，由 `memory-v2-runtime.mjs` 解析身份，再交 `memory-v2-host.mjs` 做授权。服务未构造或平台启动闸门关闭时返回未验证；闭包先声明，避免读取后声明服务的 TDZ。
2. 机制：公开 status 中的绑定后缀不是当前登录态证据。现有 getter 启动专用浏览器，核对本会话 SELF、取得请求水位、重新导航取得更新 SELF，核对账号和角色后先关闭浏览器再返回最小身份；关闭失败不能返回 verified。新接线每次调用 getter，不缓存身份。候选列表遇到未验证抖音跳过该候选，其他渠道仍可管理。
3. 爆炸半径：一个插件 Host 及现有浏览器服务；共同 Memory Host 只增加固定 `MEMORY_IDENTITY_BUSY` 文案，原回执优先级/权限/来源校验不变。任意上游 error/hint 不透传；测试以 PRIVATE_PLATFORM 哨兵验证无泄漏。未操作真实浏览器、凭据或生产记忆。
4. 取舍：复用公开绑定 status 成本低但不能证明鲜活账号；调用已独立验收 getter 会多一次浏览器核验，能复用其会话/水位/关闭护栏。选择后者。忙碌错误采用固定白名单文案，避免放宽通用 Host 错误清洗。
5. 生效与重启：代码将在最终门禁与合并后安装到 DeepSeek Harness.app desktop profile；届时需重载插件 Host。此次未安装、未重启，网页不是安装目标；不自动开启 shadow/V2 或正式迁移。
6. 验证：Node24 执行 `plugins/surfcore/scripts/test-memory-v2-runtime.mjs`、`test-memory-v2-host.mjs`、`test-douyin-service.mjs` 全部通过。runtime 新增真实 Worker 下的鲜活读取/忙碌固定提示/其他候选不受影响/恢复后重新读取；原影子闸门仍拒绝，provider 0。Host 原13组安全测试通过；抖音既有 fake-browser 身份反例保留。证据见 `_backups/memory-v2-coordinator/douyin-platform-wiring-20261110/`：RED 原来返回 MEMORY_IDENTITY_REQUIRED，最终固定忙碌码与 hint 通过。尚未声称实际桌面/Bili/QQ联合链路通过。
7. 回滚与残余：同证据目录按原相对路径保存 index/runtime/host/test 备份；审核后仅恢复本次差异，保留继承的脏改动。getter 无缓存，忙碌时等待平台操作结束重试；实际生命周期、迁移、总门禁和安装仍在总计划中。

## 可转发的发布交接块

- 范围：Memory V2 抖音官方实时身份生产 reader 与固定忙碌失败；无版本/提交/发布。
- 关键文件：`plugins/surfcore/lib/index.js`、`memory-v2-runtime.mjs`、`memory-v2-host.mjs`，对应 runtime 测试。
- 验证：runtime/Host13组/Douyin service PASS；fake browser/隔离 Worker，不是实际桌面安装验收。
- 用户目标：最终安装 desktop，V1 默认，正式迁移/切换另行预览确认。总任务仍未完成。
