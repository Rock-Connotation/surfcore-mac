# 抖音预览播放器不能证明推荐页面可交互

范围：0.8.8 本地编辑；不发布。首页可播放但按键无切换，严格 FEED 为空。

## 完整逻辑

1. **链路**：DSH Host → douyin-service → douyin-browser → 官方首页；service仍固定三次新self与tab/feed证明，公开结果仍只投影metadata。
2. **机制**：服务器初始HTML的 `#quickPlayer` 已有currentSrc/readyState=4和稳定可见区域，推荐应用尚未初始化。旧谓词接纳预览后过早按键；独立诊断约5秒后预览才消失、应用播放器出现。
3. **爆炸半径**：1浏览器×2消费者（metadata/陪伴）×显式错误1=2；只调整就绪判据，不改变账号、来源或消费模型额度。
4. **取舍**：固定多等几秒易受网速影响；采用排除quickPlayer、继续等真实可视稳定播放器的语义判据。保留原命令超时及取消守卫，成本2行，可单独回退；不取SSR代替正式来源。
5. **生效**：Host重载新包后新浏览器操作采用新谓词；正在运行的旧调用不热换函数。
6. **验证**：`node plugins/surfcore/scripts/test-douyin-browser.mjs`通过；新增预览fixture要求PAGE_NOT_READY/hint与零按键。不可变旧源码/新源码VM红绿对照证明旧版会接纳预览，新版拒绝；真实独立副本严格service返回5条固定FEED。Astra Host V3复审无确认P1/P2。证据均在私有20261107-companion目录，不输出签名媒体地址。
7. **回滚与残余**：回装旧包或还原本文件即可，登录资料不回滚；网络慢/人工验证仍显式失败。只证明当前机当前网页来源成功，不代表视频理解或24小时运行。

## 发布交接块

```text
改动：douyin-browser.mjs排除SSR quickPlayer；浏览器专项新增零按键断言。
验证：专项、旧/新红绿、真实严格feed5项、独立Host V3复审通过；组合门禁见总集成case。
建议：patch，由发布会话决定；本轮无version/tag/push。
case：docs/cases/2026-11-07-douyin-interactive-readiness.md
层级：内部就绪机制，公开API兼容；影响两类读取者，身份与来源不放宽。
失败：PAGE_NOT_READY提示等待完整推荐加载；超时/关闭后无迟到按键。
残余：网络/设备/长期稳定性未全验，回滚保留登录和新账本。
```
