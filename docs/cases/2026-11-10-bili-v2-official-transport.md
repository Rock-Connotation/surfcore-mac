# Bili V2 official transport：同凭据快照与最后一刻关闭检查

日期：2026-11-10。状态：可注入模块69项普通回归独立通过；生产组合/真实官方网络/桌面安装未完成。

## 完整逻辑

1. **链路**：Host 私有 getCredentials/getScope → official transport → source-runtime 的身份/官方原文/revalidate，或 agent runtime 的已审批网络发送。共享 guardedFetch 只有 officialGet 和最终 POST 两个调用方，统一覆盖所有官方请求。
2. **机制**：旧 confirmAccount、source GET、dynamic WBI 与 POST 可分别取不同凭据；getAccount 绑定A后换B，原独立探针仍POST B。run3把每次操作的 cookie/bili_jct 拷贝冻结到私有ctx，全部请求共用该快照，网络前只重读比对，send用同ctx的nav核对boundMid。独立审查又复现 await读取期间 close 后仍GET1次并成功，故在最后await之后、fetch之前复用 ensureOpen 检查。
3. **爆炸半径**：Host 网络边界的读取和写入均受影响；错误可造成跨账号发送或已关闭任务继续联网。实际验证全部使用内存假凭据/假官方响应；未接触真实凭据、发送或花钱。私有快照不回传、不日志/哈希，worker不能注入。
4. **取舍**：只在某个send外层补nav仍会在后续await更换凭据；全局currentCredentials会让并发操作串户。选择操作局部快照与共享最终网络检查，复用现有校验、固定端点和错误格式；不增加依赖、超时缓存或新权限。
5. **生效**：当前仅源码与隔离测试生效，公共Host未改。最终应通过联合门禁后按用户指定安装至 DeepSeek Harness.app 的desktop profile；不得将这次模块验收视为已安装或已切换V2。
6. **验证**：`node plugins/surfcore/scripts/test-memory-v2-bili-official-transport.mjs` →69项；保留44原用例+14项run2+7项run3+4项关闭/取消时序。原账户探针→0 POST/account-changed；晚close/abort探针→0 fetch/closed或aborted，均code/error/hint。原RED、GREEN与语法检查在 `_backups/memory-v2-coordinator/bili-official-late-close/`；原65项独立日志在 `bili-official-final-independent/`。独立探针含相对导入，须从仓库根用Node `--input-type=module`经STDIN执行。
7. **回滚与残余**：先保全当前文件和SHA，再恢复该证据目录的原三文件备份并复跑；旧版存在已证明漏洞，只供比较，不能作为通过验收的版本安装。剩余index/getScope/VIDEO/dm-history/其它通知/真实命令异常呈现/native联合门禁由主工单继续跟进；V1默认、无自动fallback/生产迁移。

## 可转发交接块

- 内容：Bili官方传输同账号凭据快照、Host CSRF/WBI、禁止重定向与精确评论原文；最后await之后检查关闭/取消。
- 验证：独立69项通过；原跨账号探针0 POST，晚关闭/取消探针0 fetch。实际worker和完整来源证明是另一套证据，见相邻managed-worker案例。
- 边界：未提交/未发布/未安装，生产组合与最终仓库门禁待完成；无真实网络、凭据、发送、付费或公共Host重启。

## 精度与缺字段补造的独立复核（2026-11-10）

链路：scheduler/CLI selector → 官方 hydrate → 原件 wire；复核发现 String(unsafe numeric ID) 可把已舍入值认证为原件，评论又允许缺失坐标取selector默认值。爆炸半径为同一官方源模块的账号/对象匹配，可能形成错误proof；无平台实际写入。取舍：仅补msg_key成本低但留下同类ID路径；选择统一精确ID转换并要求评论四坐标来自原件。两种RED均证明原来ok:true，修后76项及真实写worker10项通过，额外7项保留safe整数与19位字符串正例。所有改动只在隔离测试；最终安装后重载插件Host，V1默认不变。回滚备份与RED/GREEN见 `_backups/memory-v2-coordinator/bili-official-exact-identifiers-20261110/`；生产Bili组合、native联合门禁仍待办。

交接增量：官方传输现为76项；原同凭据/CSRF/redirect/晚取消护栏保留，新增 BILI_OFFICIAL_ID_UNSAFE 与 BILI_OFFICIAL_ORIGINAL_INCOMPLETE；无提交/版本/发布，安装目标仍是 desktop。
