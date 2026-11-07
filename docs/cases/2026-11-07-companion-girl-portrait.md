# 抖音小白鲸日记接入本机少女鲸鱼娘立绘

## 现象

- 日记页此前以原创小白鲸 SVG 作为角色图像；本轮用户明确选了较修长的少女鲸鱼娘立绘。
- 旧图是共享在页面里的动物插画，不能表达当前角色，也不能随角色 epoch 切换。
- 影响范围：仅 DSH 内的抖音陪伴日记页和固定的角色立绘读取接口；不新增插件、人格、记忆、平台外发或模型请求。

## 根因

- 日记 HTML 将 SVG 与角色数据写在同一页面常量里，角色 ID/epoch 只约束日记状态与按钮，不约束图像资源。
- 页面对活动角色变化没有资源级的清除、请求取消和失败显示逻辑。

## 完整逻辑（给用户看的那一遍）

- **链路**：DSH 插件 `index.js` 只把 `/api/douyin/companion-portrait` 精确交给陪伴 controller；日记页在读到当前角色后，请求同源立绘接口并显式带上 `characterId`、`characterEpoch`。Controller 复核请求 stamp 与当前角色一致，再读取 `characters/<id>/appearance/companion-portrait.webp`。图片只供日记页显示，不进入作业、模型请求或记忆。
- **机制**：接口只接受固定文件名，不接受调用方传路径或 URL。角色 ID 必须符合角色目录规则；从 DSH 根目录到角色文件的每一层都检查为真实目录/普通文件且不是符号链接。读取时使用 `O_NOFOLLOW`（平台提供时），再比对文件身份；大小最多 4 MiB，并检查 WebP 的 `RIFF` 与 `WEBP` 签名。请求前后再次确认角色 epoch，避免切角过程中把旧图挂到新角色上。页面以 `no-store` 获取图片，5 秒 AbortController 同时限制 fetch 与响应体读取；换角时中断旧请求，关页时永久退休页面、清空排队重试并撤销页面创建的 blob URL，迟到的状态/操作结果不得再触发请求或改写界面。
- **爆炸半径**：1 个 DSH 插件进程 × 2 个本地读写方（页面与 controller）× 1（错误在图像区域可见）= **2**。接口只读当前角色私有图片，不读取凭据、不改角色数据、不产生模型或平台调用。缺图、签名/大小错误、路径不安全、超时都返回结构化错误或显示对应立绘区域提示；用户可点现有“刷新”重试，刷新进行中会排队一次重试。
- **取舍**：路线 A 把社区立绘复制进页面或打包资源，制作简单，但会把个人社区素材变成共享/公开资源，且角色之间无法独立换图；路线 B 使用当前角色私有 `appearance/companion-portrait.webp`，增加一个小型只读接口和角色切换生命周期处理，角色身份同源、可单独替换并且不进入仓库制品。本次采用 B。回滚只需撤回页面/controller/精确路由变更；角色私有图片保持不动。
- **生效与重启**：controller/index 改动需重载 SurfCore 插件或重启 DSH；日记页刷新后通过 `no-store` 重新加载。单独更换当前角色的私有 WebP 不需要重新打包，但应点日记页“刷新”。
- **验证**：官方 Node 24：`scripts/test-douyin-companion-host.mjs` 通过，覆盖当前角色 200、旧 epoch、目录穿越、缺图、文件符号链接、模拟读取失败、超限/无效签名、跨源请求和其它路径请求体不被读取；`scripts/test-douyin-companion-ui.mjs` 通过，覆盖角色 stamp、超时可见并由现有刷新按钮重试、旧角色迟到响应不覆盖新状态、角色清除、保存的 partial 观看经历、未通过的手动验收下一步、慢轮询与原操作错误粘性；`scripts/test-audit.mjs` 为 **174/174**。完整审计发生在 5 秒立绘超时用例加入前；之后 Host/UI 均已单独复跑，最终组合审计待父会话完成。
- **回滚与残余**：回滚这组代码提交即可恢复旧日记页，不会删除或改写角色私有图片。当前仅 Host/Playwright fixture 证明接口和页面状态；这棵工作树没有启动 DSH，也没有声称已在真实 DSH 展示图片。父会话另行安装的角色私有立绘为 103,678 字节，SHA-256 `a090bd51056da8fac49128a570a9f071f86768008c546e9391ed6cef015e66fc`，不纳入源码、安装包或本提交；来源归属跟随私有角色素材保存。

## 修法

- 日记页移除动物 SVG，改为响应式角色图片，桌面最大宽 220px、最大高 260px，窄屏缩到 120px；idle / thinking / happy / rest 有轻微状态变化，遵守减少动态偏好。图片使用 `object-fit: contain` 和可访问名称“少女鲸鱼娘立绘”。
- 新增 `douyin-companion-portrait.mjs` 固定路径读取器；controller 增加同源、epoch-stamped WebP GET，错误只暴露 code/error/hint，不泄露绝对路径、来源 URL 或凭据。
- 页面为读取失败提供内联状态；现有刷新按钮可手动重试。换角和清角会清除旧图；部分观看经历即便以 `partial` 结束，只要记忆已保存且作业没有失败，就使用 happy 视觉状态；音轨覆盖和首次验收仍分别说明，不将稀疏画面误报成音轨完整。
- 页面收到 `pagehide` 后进入永久关闭态；待处理状态轮询与操作完成时都会检查该状态，不能启动最终刷新或执行排队的立绘重试。页面关闭期间出现的图像解码/网络结果也不能回写状态或重新显示图片。
- 改动路径：
  - `plugins/surfcore/lib/douyin-companion-portrait.mjs`
  - `plugins/surfcore/lib/douyin-companion-controller.mjs`
  - `plugins/surfcore/lib/douyin-companion-page.mjs`
  - `plugins/surfcore/lib/index.js`（仅精确 companion 路由分发条件）
  - `plugins/surfcore/scripts/test-douyin-companion-host.mjs`
  - `plugins/surfcore/scripts/test-douyin-companion-ui.mjs`

## 验证

- Host：官方 Node 24 运行 `plugins/surfcore/scripts/test-douyin-companion-host.mjs`，通过。
- UI：官方 Node 24 运行 `plugins/surfcore/scripts/test-douyin-companion-ui.mjs`，覆盖既有角色切换、超时可见/刷新重试、partial 成功、粘性操作错误，并新增“状态请求挂起 + 排队手动重试 + pagehide”与“操作请求挂起 + pagehide”两种竞态；关闭后状态/图片请求数不再增长，迟到的操作错误不会重新显示。
- Audit：官方 Node 24 运行 `scripts/test-audit.mjs`，**174/174** 通过；新增超时/lifecycle 用例后已单独复跑 Host/UI，待父会话执行最终组合门禁。
- 真实 DSH UI、角色切换和真实 WebP 解码：本分支未执行，由父会话按其真实 UI 验收负责。

## 遗留 / 后续

- 父会话需把本 case 加入 `docs/cases/README.md`，组合后重跑最终 audit，并在真实 DSH 中核对已安装的私有角色立绘。
- 不把本地社区图片复制到 `assets/`、插件目录、发布清单或任意公共包。

## 可转发发布交接块

```text
【编辑会话交接】
主题：抖音小白鲸日记接入当前角色的少女鲸鱼娘本机立绘
文件：新增固定路径 WebP 读取器；更新现有日记页与 companion controller（含 pagehide 永久退休护栏）；index.js 仅加入 exact-prefix 路由；增加 Host/UI 回归与本 case。
接口：既有日记状态/操作契约不变；新增同源 GET，必须提供当前 characterId + characterEpoch；失败均有 code/error/hint。未新增依赖、模型调用或外发。
验证：Host 与 UI 专项通过；UI 覆盖 pagehide 时待状态请求/排队重试及待操作结束，不产生后续状态或图片请求；Node 24 test:audit 为 174/174（5 秒超时与 pagehide 竞态随后通过专项复跑，最终组合审计待父会话）。
影响与重启：只影响 DSH 内日记图片；重载 SurfCore 插件/重启 DSH 后刷新页面生效。私有角色图不在源码与发布包。
回滚：回滚本功能提交即可；保留用户角色图片及 attribution。
未验：真实 DSH 与真实角色素材显示由组合会话验收；不视为已发布或已在真实 UI 验收。
```

## 原生显示比例补修（父会话）

182418c包在真实官方DSH中已读取并解码103678字节原WebP（1024×1024），角色app/epoch4、昵称小白鲸、旧记忆及2/12计数保持。父会话最终组合audit174/174、回归/完整插件、842清单和严格隐私全部通过，原pagehide P2经独立V2七组反例关闭。但原生截图发现：容器按iframe视口24vw缩到约124px，却固定260px高并底部对齐，形成上部大块留白，少女立绘偏小。

路线A调整展示容器，宽220px且不超过内容42%，按方形原图自然比例显示，窄屏120px；成本两处CSS，原文件不变，回装上一包可退。路线B重绘/裁改图片会改变用户选定原画和其比例，还增加素材维护成本，未采用。临时原生CSS预览已显示约198×198px、全身清晰且无高空框；最终代码需重新构建/实装，不把临时预览当已安装。

新增实际浏览器几何断言：桌面宽度≥180px且方形图不出现高空框，375px窄屏保持自然比例。新断言对旧CSS立即失败，修复后已与既有超时/角色/粘性错误/关页断言一起通过。仅影响日记图像展示（一个页面读者，显式错误系数1）；控制器、身份/受众/记忆/额度与请求生命周期代码不变。发布交接补充：页面CSS、同一UI专项、本case；表层补修随少女立绘功能提交，重启插件加载；图片仍是本机资料，回滚保留图片与调用账本。


## 最终候选原生外观复验（c49721f）

- 官方原生 App 独立实例正式安装 c49721f：343制品文件逐字节一致，6317持久文件安装前后不变。没有将临时CSS预览当作正式安装证据。
- 静态页面实际解码原WebP1024×1024，少女完整显示，自然比例/扩大容器生效；当前app/epoch4、昵称小白鲸、旧记忆和2/12计数保持。原始素材及来源只保存在角色私有appearance中。
- 仅对本轮独立副本的图片做可逆rename，真实刷新后出现COMPANION_PORTRAIT_MISSING、隐藏旧图并提示点刷新/重新配置。原字节恢复且hash一致后再次实际点击刷新，1024×1024图片恢复。测试没有模型调用，计数仍2/12。
- 最终组合audit174/174、完整插件、严格隐私退出0，Git清单842/842；完整回归在182418c通过，后续仅比例CSS/布局断言/刷新文字变化，无协议变更。独立pagehide V2七组反例关闭，旧版本同fixture失败。
- 私有证据：native/girl-final-before.png与native/girl-final-acceptance.json。真实角色切换没有额外操作，epoch竞态由专项/独立审查覆盖；常用DSH尚未迁入。

交接补充：本case上述“父会话待验”条目已由组合会话完成原生静态图片显示、缺图可见错误与刷新恢复；保留角色切换实机未验边界。图片不随发布物分发，版本仍0.8.8，不发布。
