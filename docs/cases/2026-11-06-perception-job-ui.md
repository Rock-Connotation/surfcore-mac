# 感知作业部分失败在设置页不可操作

## 现象与环境

官方 macOS App 候选的设置页实际显示某 ASR 作业 `partial`、进度 100%、缺失 1 段，但没有显示分块失败警告或恢复按钮；中断和取消项的结构化 `error.code` 被误显示成 `ASR_FAILED`。证据：主工作树 `_backups/20261106-macos-wp0/官方App 验收候选/native-ui-perception-loaded-body.txt`。该记录不是本次修复后的验证。

## 完整逻辑

1. **链路**：Host `/perception` 提供作业状态、`progress`、`coverage`、`warnings`、`result.warnings`、结构化 `error`；`PerceptionPanel` 展示作业卡，按钮向同一 API 提交 `resume` 或 `cancel`。Host、ASR 服务和已有权限门禁未改。
2. **机制**：旧卡片只显示缺口数量，未消费 warnings，恢复按钮只针对 interrupted/记忆失败；错误编码取外层 `job.code`，忽略实际 `job.error.code`。分块尝试计数可达到 100%，不证明请求音频已全部处理。新卡片展示具体缺口和警告的 code/message/hint；部分覆盖时将进度说明为已尝试分块，nested error code/hint 优先，partial/failed/interrupted 可恢复，cancelled 不提供恢复。所选详情只补材料，不以旧详情覆盖列表实时状态。
3. **影响面**：设置页作业卡与按钮，涵盖本地 ASR 和 B站父作业；不更改作业、账号、模型或外发行为。警告中的 URL 和常见令牌字段遮盖后再展示。
4. **取舍**：只增加字符串提示改动最少，但无法验证按钮动作或分清尝试进度；抽出同一份作业卡组件并以 React 元素夹具渲染，改动稍多，但可断言用户真正看到的字段和可执行动作。继续保留原列表和详情结构，不另造新页面。
5. **生效与重启**：变更进入候选插件并按官方 App 加载方式更新后生效；当前测试未操作或重启 App。实际页面验收由主会话在对应候选上完成。
6. **验证**：官方 App 内 Node 24.21.0 运行 `node --check plugins/surfcore/lib/client.js` 与 `node plugins/surfcore/scripts/test-client-contract.mjs` 均 exit 0；后者保留旧断言，实际渲染卡片并验证 partial 的准确缺口、100% 尝试标签、OUTPUT_INVALID/CHUNK_PROCESSING_FAILED 和回退警告、提示及 URL 隐藏；检查 failed/interrupted/cancelled 的真实嵌套 code/hint、恢复按钮与动作，以及记忆重试和陈旧详情不会重新启用恢复。`git diff --check` 通过。
7. **回滚与残余**：原始复制前文件在 `_backups/2026-11-06-perception-ui/`，可按文件恢复。夹具不证明真实 App 已加载新代码或真实识别质量；主会话需在最终组合运行完整门禁、重新加载 App 并检查真实状态。

## 发布交接

```text
【感知作业失败可见性】
现象：部分作业显示 100% 却缺材料，无警告与恢复入口；嵌套错误码被误写成 ASR_FAILED。
修法：展示警告/具体缺口和可执行建议，标明已尝试分块；partial/failed/interrupted 提供恢复，cancelled 不提供；使用嵌套错误码。
验证：官方 App Node 24.21.0 语法与组件渲染契约测试通过；未操作真实 App、账号或作业。
残余：最终插件组合及真实 App 页面待主会话验收；未发版。
回滚：恢复 _backups/2026-11-06-perception-ui/ 中两个测试前文件。
```
