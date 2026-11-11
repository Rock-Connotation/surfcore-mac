# Bili V2 视频文字元数据 adapter 契约（HY4-BILI-VIDEO-METADATA）

状态：run2/3 ready · 3 个新文件 · 普通测试 27/27（system Node v26.5.1 + bundled Node v24.21.0）；native fixture / 真实 Host / 外网 / 付费 / 平台发送 / 派生 / 安装 / commit / 全量 gates 均 0。

## 边界与冻结接口

- 新增 `plugins/surfcore/lib/bili-v2-video-metadata.mjs`：纯函数模块，零 import、零网络、零凭据、零持久化、零重试。
- 冻结签名 `export async function readBiliV2VideoMetadata({ locator, officialGet } = {})`。
- `officialGet` 是父端 Host 内部闭包，只接受一个固定官方 GET URL；沿用父端同快照 NAV / 关闭 / 撤销保护。helper 不自己 fetch、不读凭据、不做 WBI、不派生 scope。
- 端点仅 `https://api.bilibili.com/x/web-interface/view?bvid=<exact BV>` 或 `?aid=<exact decimal>`；`?aid=` 形式在 repo 现无使用，按父端冻结的 GET 形式实现，不另猜端点。repo 现有 view 字段来源 `plugins/surfcore/tools/lib/bili-media.mjs:108-126`、`plugins/surfcore/tools/verify/dryrun.mjs:16-24`、`plugins/surfcore/tools/commands/video-content.mjs:30-32`。
- 既有 source/official/Bagent/index/scheduler 全部只读，未编辑（属父端或另一 active child）。

## selector 与固定 URL

- 只接受严格同键集对象 `{ kind: 'video', bvid: <BV> }` 或 `{ kind: 'video', aid: <positive exact decimal string | safe int> }`。
- `bvid` 必须 `/^BV[A-Za-z0-9]{10}$/`；`aid` 必须 `/^[1-9][0-9]{0,29}$/` 或 `Number.isSafeInteger(v) && v > 0`（转字符串）。
- 拒绝：额外字段 / 同时给两个 id / Symbol 键 / `Object.create(null)` / 非 video kind / 注入字符（`? & # / ..`）/ `0`、`-1`、`1.5`、`true`、对象、空串、前导零、空格。这些在调用 `officialGet` 前拒绝（0 call）。
- unsafe numeric selector（`Number.isInteger && !Number.isSafeInteger`）→ `BILI_VIDEO_ID_UNSAFE`，同样 0 call；绝不 `String()` 造伪精确 ID。
- 生成 URL 后再以 `FIXED_URL` 正则复核，非法则 `BILI_VIDEO_ENDPOINT_DENIED`。

## 官方原件校验（text-only，不宣称 full）

- `officialGet(url)` 恰好调用一次、恰好一个参数；异常或不可读 body → `BILI_VIDEO_OFFICIAL_UNAVAILABLE`（不泄漏 `error.message`、官方 body、凭据）。
- 严格 `code === 0`，否则 `BILI_VIDEO_CODE_REJECTED`。
- `data` 必须是纯对象；逐字段校验：`bvid`（BV 正则）、`aid`（exactId）、`owner.mid`（exactId）、`owner.name`（字符串，可空）、`title`（非空字符串，逐字保留不 trim）、`desc`（字符串，可空）、`pubdate`（`Number.isSafeInteger && >0` 的秒值）。
- 任一数字 ID 为 unsafe numeric → `BILI_VIDEO_ID_UNSAFE`，**先于**任何 `String()` 比较；即使 `String(unsafe) === selector` 仍拒绝（精度陷阱）。
- 字段缺失/类型错/空 title/`pubdate` 非安全数字 → `BILI_VIDEO_ORIGINAL_INCOMPLETE`；`summary` / `timestamp` / `model_output` 绝不替代 `desc` / `pubdate`。
- **run2 修复**：`pubdate` 还须满足 ECMA-262 TimeClip 可表示范围 `0 < pubdate <= 8640000000000` 秒（即 `Date` 上限 `8.64e15` ms / 1000）。`Number.MAX_SAFE_INTEGER` 等 safe-positive 但超范围的秒值在 `new Date(pubdate*1000).toISOString()` 会抛 `RangeError: Invalid time value`；run1 缺此校验导致未捕获异常，违反固定 `ok:false/code/error/hint` 契约。现统一归入 `invalid` → 返回 `BILI_VIDEO_ORIGINAL_INCOMPLETE`，不抛异常、不泄漏、不重试、officialGet 仍恰好 1 次。保留最大合法 Date（8640000000000 秒 → `+275760-09-13T00:00:00.000Z`），越界一秒（8640000000001）明确拒绝；只按 Date 可表示性判定，不引入年份业务限制。
- 返回的 `bvid` / `aid` 与 selector 不一致 → `BILI_VIDEO_SELECTOR_MISMATCH`。
- 永不按摘要、时间戳、模型输出补原件；不因失败重试。

## 返回形状（成功）

```
Object.freeze({
  ok: true,
  bvid, aid, authorMid, occurredAt,        // occurredAt = new Date(pubdate*1000).toISOString()
  coverage: 'text-only',
  wire: Object.freeze({
    bvid, aid, title, desc,
    owner: Object.freeze({ mid, name }),
    pubdate,
  }),
})
```

- 顶层恰好 7 键；`wire` 恰好 6 键；`wire.owner` 恰好 2 键；三者全部 `Object.freeze`（mutation 抛错）。
- 仅这些文字原字段，逐字不 trim 重写；不含完整 raw body、Cookie、`stat`/`pic`/`pages`/`duration`/`cid`/`tname`、`message`/`code`/`data`，也不含 `verified`/`audience`/`route`/`scope`/`provenance`/`root`/`full`。
- 只声明这些文字字段的覆盖，**不宣称视频/音轨/帧/全部元数据 full**。账号/对象/受众/route 验证属父端调用方，helper 不假称已证明；不拼造 Memory provenance/root。

## 结构化失败（固定，不泄漏）

`Object.freeze({ ok: false, code, error, hint })`，恰好 4 键；`error` 固定为 `Bili V2 video text metadata was refused.`，`hint` 为每 code 固定文案：

| code | 触发 |
| --- | --- |
| `BILI_VIDEO_OFFICIAL_GET_INVALID` | `officialGet` 非函数（含无参 / `{}`） |
| `BILI_VIDEO_LOCATOR_INVALID` | selector 形状/键集/值非法（0 call） |
| `BILI_VIDEO_ENDPOINT_DENIED` | 生成 URL 不属固定白名单 |
| `BILI_VIDEO_OFFICIAL_UNAVAILABLE` | GET 抛错或 body 不可读 |
| `BILI_VIDEO_CODE_REJECTED` | 官方 `code !== 0` |
| `BILI_VIDEO_ID_UNSAFE` | 数字 ID 精度丢失（selector 或响应） |
| `BILI_VIDEO_SELECTOR_MISMATCH` | 响应 bvid/aid 与 selector 不符 |
| `BILI_VIDEO_ORIGINAL_INCOMPLETE` | 原件文字字段缺失/非法 |

## 普通测试与 RED→GREEN 证据

- `plugins/surfcore/scripts/test-memory-v2-bili-video-metadata.mjs`：27 用例（run1 23 项全部保全 + run2 新增 4 项），纯内存 fake `officialGet`，无网络、无真实凭据、无发送。
- RED run1：`surfcore-hy4-video-run1-red.log` → `RED_EXIT=1`，首失败 `FAIL AssertionError: helper must implement the frozen video metadata adapter`，PASS 0（stub 仅返回 `BILI_VIDEO_NOT_IMPLEMENTED`）。
- GREEN run1：`surfcore-hy4-video-run1-green.log` → `GREEN_EXIT=0` / 23 cases；`surfcore-hy4-video-run1-node24.log` → `NODE24_EXIT=0` / 23 cases。
- RED run2（日期越界）：`surfcore-hy4-video-run2-red.log` → `RUN2_RED_EXIT=1`，首失败 `FAIL AssertionError: pubdate beyond Date range must not throw: RangeError Invalid time value`，前 6 项 PASS 后失败（23 旧断言未动）。
- GREEN：`surfcore-hy4-video-run2-green.log` → GREEN_EXIT=0 / 27 cases；`surfcore-hy4-video-run2-node24.log` → NODE24_EXIT=0 / 27 cases；`node --check` 双文件通过；CRLF/TAB/行尾空格/末尾换行 4 项全 0。
- run2 4 键失败实证 `surfcore-hy4-video-run2-failure-proof.log`：`{"ok":false,"code":"BILI_VIDEO_ORIGINAL_INCOMPLETE","error":"Bili V2 video text metadata was refused.","hint":"Required original text fields are missing or invalid; summaries are not accepted."}`，`keys:["code","error","hint","ok"]`、`frozen:true`、`calls:[1]`（无异常、无泄漏、无重试）；普通 1700000000 仍逐字 `2023-11-14T22:13:20.000Z`。
- 证据目录 `_backups/memory-v2-bili-video-metadata/`：run1/run2 RED stub 与测试快照、RED/GREEN/Node24 日志、helper GREEN diff、run2 契约正文。

## 未覆盖（父端决定，不扩本工单）

- 父端 Host facade 接线 / 新 source kind / typed target / 权限 / native 或 index 激活不在本 helper；本测试全为 fake `officialGet`，未验证真实官方响应字段在生产网络下的取值。
- 视频/音轨/帧等二进制内容未取，也无意宣称 full；`?aid=` 端点形式按父端冻结构造，repo 现有 CLI 只用 `?bvid=`。
- source 文字安全、实际模型准入由父端已有 redactor 与 source proof 处理；host 快照/关闭/撤销保护由父端 `officialGet` 闭包提供，helper 未复现其时序。
- 关联事实（父端 m01715，仅记录不处理）：`msgfeed.mjs:41-60 replyCoordinates` 把 raw `root_id/source_id/target_id` 转成 POST 写坐标，输出 `root/parent` 不是 incoming 原件自身坐标；top 级 incoming rpid31/rawroot0/target0 会输出 root31,parent31，而 official 原件 root0,parent0。父端负责 preserve sourceRoot 与同 type/oid 不同 thread 坐标的验证 + Host 接线，本工单仅视频文字元数据。
