# Bili DM trigger 精确 msgKey 投影契约

状态：HY4-BILI-DM-TRIGGER run1/3 完成。窄补丁，仅 3 个文件：`plugins/surfcore/tools/commands/dm-await.mjs`（唯一源码改动）、`plugins/surfcore/scripts/test-memory-v2-bili-dm-trigger.mjs`（新）、本文档（新）。未接生产 V2、未跑 native、未联网、未读真实 `~/.dsh` 凭据、未发生平台写入。普通 10/10 PASS（system Node v26.5.1 + bundled Node v24.21.0）。

## 根因

`dm-await.mjs` 已经通过官方 `get_sessions?session_type=1&group_id=0&count=50&mobi_app=web` 拿到每个会话的 `last_msg`，但三处 JSON 投影都没带 `last_msg.msg_key`：

- `--any` 命中分支 `items.push({ mid, name, text, ts, unread, isOwner })`（原 `:76-83`）
- owner 分支 `poll()` 返回 `{ ok, ts, text, fromOwner, unread }`（原 `:129`）
- owner 命中 `JSON.stringify({ hit:true, mid:OWNER, name, text, ts })`（原 `:147`）

`scheduler.js:928` 用 `dm-await --once --json [--any]` 取这个输出作为 dm-notification 触发输入，因此 `msgKey` 在 CLI 投影这一层就已经丢失，后续 Host 投影无法得到可验证的精确私信 ID。`source-map/report.md` §6 已记录 dm-notification 只有 `mid/name/text/ts/unread/isOwner`（或 owner 的 `mid/name/text/ts`），无 `msgKey`；`bili-v2-official-transport.mjs` 的 `LOCATOR_KEYS.dm = ['kind','mid','msgKey']` 需要它。

## 三层区分（不可混淆）

1. **official 原始字段**：`get_sessions` 响应的 `session_list[].last_msg.msg_key`。只有 `bili-v2-official-transport.mjs` 的 `officialDm` hydrate 才产出 `coverage:'full'` 的 wire（`{msg_key, sender_uid, receiver_id, msg_type, content}`）。
2. **CLI 输出投影**：本次新增的 `msgKey`。它是**通知触发侧的 selector 坐标**，不是 full wire；正文 `text` 仍是 `parsed(last_msg.content)` 的截取投影，身份/正文仍必须由 Host 重新官方 GET 确认。
3. **scheduler 再次投影**：`scheduler.js` 把 `dm-await` 的 JSON 放进 `promptBili` 第 4 参数的 `input.items`。本次不改 scheduler；Host 后续投影由协调者决定 seam。

## 精确 ID 规则（唯一新增纯函数 `exactMsgKey(last)`）

`const v = last?.msg_key`：

- `typeof v === 'string'`：仅当 `/^[1-9][0-9]*$/` 命中才**原样返回字符串**，因此 19 位十进制 ID 完整保留，不做 `Number()`、不截断、不补零。
- `typeof v === 'number'`：仅当 `Number.isSafeInteger(v) && v > 0` 才 `String(v)`。
- 其它（缺失、`undefined`、`null`、`''`、`'   '`、含空格/`-`/`0x` 的字符串、对象、数组、布尔、负数、`0`、小数、超出 `MAX_SAFE_INTEGER` 的 unsafe number）一律 `undefined`。

`undefined` 时三处投影用 `...(msgKey === undefined ? {} : { msgKey })` 省略该键，**不用 `ts`/`text`/`mid` 猜、不 `String()` 造伪精确 ID、不写诊断**。后续 V2 投影拿到缺 `msgKey` 的记录应显式拒绝（见「未覆盖」）。三个投影点各自调用 `exactMsgKey`，都取自**本次同一个 `last_msg`**，不跨会话、不跨轮次缓存。

## V1 行为保持

`mid/name/text/ts/unread/isOwner`（`--any`）、`mid/name/text/ts`（owner）、`seen` 水位、首次基线 `FIRST_ANY`、owner/`--any`/`--once`/`--json`/`--baseline`、`SELF`/`<1000`/`sender===SELF`/`ts<=seen` 过滤、超时、退出码、stdout 仍是单行合法 JSON —— 全部不改。新增字段**只有** `msgKey`，且仅在官方 `last_msg.msg_key` 精确可信时出现。非 `--json` 的 `DM_HIT` 文本行不变。

## 普通测试（实际 CLI subprocess，零外网）

`test-memory-v2-bili-dm-trigger.mjs` 经**真实入口** `plugins/surfcore/tools/bili.mjs dm-await ...`（与 `scheduler.js:928` 同链路，`spawnSync` 继承 `NODE_OPTIONS --import` shim）运行：隔离 `mkdtemp` 的 `DSH_HOME` + 合成 `credentials.json` + 合成 `bili.config.json`（`owner.mid=22000`、`self.mid=9`）+ `SURFCORE_BILI_CONFIG`。shim 覆盖 `globalThis.fetch`，**只允许** `api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions` 的 GET，其余记 `UNEXPECTED_WORKER_NETWORK` 并抛错；`assertClean` 校验所有请求 host/path/method、无 `denied`、stdout 不含凭据/wire/hint/error 诊断。

10 例：① 19 位字符串 msgKey 原样 + V1 六字段；② 正 safe-integer `9988776655` → `'9988776655'`；③ 缺 `msg_key` 不产 `msgKey`；④ 13 种非法值（空/空格/带空格/`-5`/`0x10`/对象/数组/null/负数/0/小数/unsafe number/布尔）逐会话全部不产 `msgKey` 且保留旧字段；⑤ 自己最后消息不当来信；⑥ `seen` 已读不当来信；⑦ 无 state 的 `FIRST_ANY` 基线；⑧ owner 命中带精确 msgKey + V1 字段；⑨ owner 非本人来信不命中；⑩ owner unsafe `msg_key` 命中但不带 `msgKey`。

## RED → GREEN 证据

- RED（`dm-await.mjs` 未改）：`RED_EXIT=1`，`FAIL AssertionError [ERR_ASSERTION]: 19-digit decimal ID must be preserved verbatim`，`+ undefined - <19 位值>`，`:131` → `:121` → `:124`。
- GREEN：system `GREEN_EXIT=0 / PASS Bili DM trigger: 10 cases`；bundled Node24 `NODE24_EXIT=0 / 10 cases`。
- `node --check` 两文件 OK；CRLF/TAB/trailing-WHITESPACE = 0、末尾换行 True。
- 相关旧测试未删断言：`test-memory-v2-bili-write-workers` 10/10 EXIT=0、`test-memory-v2-bili-official-transport` 76/76 EXIT=0（协调者冻结模块的当前用例数）。
- 备份/日志/关键 diff 全在 `_backups/memory-v2-bili-dm-trigger/`：`run1-20261110-2022-dm-await.mjs`（改前）、`run1-20261110-2049-dm-await.pre-green.mjs`（GREEN 前再次备份）、`surfcore-hy4-dm-run1-{red,green,node24}.log`、`surfcore-hy4-dm-run1-dm-await.diff`、`reg-*.log`。

## 未覆盖 / 交回协调者

1. `bili-v2-official-transport.mjs:363-379` `officialDm` 的 `String(last.msg_key)` 精度缺口：协调者拥有该 module，本次不越界；Host 侧 hydrate 仍可能把 19 位数值 `msg_key` 精度截断。
2. `scheduler.js` dm-notification 的 V2 `input.items` 仍是通知投影（带 `mid/name/text/ts...`，本次后可能带 `msgKey`），不是 official wire；Host 侧 `projectBiliTriggerToLocators` 必须要求 `msgKey` + 同凭据官方 `get_sessions` 复核，缺 `msgKey` 显式 `BILI_OFFICIAL_SELECTOR_UNTRUSTED`，禁止静默 fallback 到「最新一条」或按作者猜。
3. `source-map/report.md` 的 msgfeed 坐标纠正（协调者 m01715）：`msgfeed.mjs:41-60 replyCoordinates` 把 raw `root_id/source_id/target_id` 转成 POST 写坐标，top 级 incoming `rpid31/root0/target0` 会输出 `root31,parent31`，而 official 原件是 `root0,parent0`；父端负责 preserve `sourceRoot` 与同 `type/oid` 不同 thread 坐标的验证 + Host 接线。本次仅 DM `msgKey`，未改 msgfeed/scheduler/official。
4. `dm-await` 的 `get_sessions` 只覆盖每个会话的**最后一条** `last_msg`；私信历史（非最后一条）仍无 selector，Host 不得伪造。
5. 真实 B 站响应形状未验证：所有 `session_list`/`last_msg`/`msg_key` 均为合成 fixture；官方对该字段是字符串还是数值、是否存在超 `MAX_SAFE_INTEGER` 的数值形态，仅静态规则覆盖，无真实官方对照。
6. 生产 V2 组合仍 UNWIRED（`lib/index.js:436 startSchedulerNow()` 未传 `biliV2Agent`），本补丁只让 CLI 层保留 selector，不启用 V2。
