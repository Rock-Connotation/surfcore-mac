/**
 * R2/F03：B站 DM 稳定身份 / pending 重放 / 持久接管 ACK 的真实生产路径回归。
 *
 * 链路：真实 startScheduler.dmTick() → 真实 execFile(bili.mjs dm-await) 子进程
 *      （NODE_OPTIONS shim 把官方 get_sessions 替换成假响应，不发外网）→ 假 biliV2Agent
 *      记录 enqueue 的 requestId → 检查 scheduler 是否发 --ack 且只在确认接管后发。
 *
 * 反例（修复前）：同一 msgKey 的 requestId 随轮询时间/日期变化（input hash 含 observedAt/quotaDay）；
 *      scheduler 从不 --ack；pending 不重放；首次 --any 覆盖 owner pending。
 *
 * 全程本测试自建隔离根 + shareTestRoot() 跨进程；不碰真实 ~/.dsh、不联网、不发消息。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shareTestRoot, testHome } from './isolate-test-home.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BILI_MJS = path.join(HERE, '..', 'tools', 'bili.mjs');
const TS = 1700000000;
const OWNER = '22000';
const SELF = '9';
const MSG_KEY = '99001';
const SESSIONS_FILE = path.join(testHome, 'sessions.json');
const HISTORY_FILE = path.join(testHome, 'history.json');
const SHIM = path.join(testHome, 'fetch-shim.mjs');
// 历史接口按“最新一页 + end_seqno 向旧翻页”模拟；direction/overlap 用于验证正序/倒序/相邻页重叠。
fs.writeFileSync(SHIM, [
  "import fs from 'node:fs';",
  "const SESSIONS = process.env.SURFCORE_DM_TEST_SESSIONS;",
  "const HISTORY = process.env.SURFCORE_DM_TEST_HISTORY;",
  "const OFFLINE = process.env.SURFCORE_DM_TEST_OFFLINE === '1';",
  "const big = (v) => { try { return BigInt(String(v)); } catch { return null; } };",
  "globalThis.fetch = async (url) => {",
  "  if (OFFLINE) throw new Error('SYNTHETIC_OFFLINE');",
  "  const u = new URL(String(url));",
  "  if (u.hostname !== 'api.vc.bilibili.com') throw new Error('UNEXPECTED_NETWORK');",
  "  if (/fetch_session_msgs|get_session_msgs/.test(u.pathname)) {",
  "    let conf = {}; try { conf = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch {}",
  "    const talker = String(u.searchParams.get('talker_id') ?? '');",
  "    const peer = conf[talker] ?? conf['*'] ?? { messages: [] };",
  "    const pageSize = Number(peer.pageSize ?? conf.pageSize ?? 20) || 20;",
  "    const end = u.searchParams.get('end_seqno');",
  "    let msgs = Array.isArray(peer.messages) ? peer.messages.slice() : [];",
  "    msgs.sort((a, b) => { const x = big(a.msg_seqno), y = big(b.msg_seqno); return x === y ? 0 : (x < y ? -1 : 1); });",
  "    if (end) { const e = big(end); msgs = msgs.filter((m) => { const v = big(m.msg_seqno); return v !== null && e !== null && v < e; }); }",
  "    if (end && peer.failPage2) return { ok: true, status: 200, json: async () => ({ code: -400, message: 'SYNTHETIC_PAGE2_FAIL', data: {} }) };",
  "    const start = Math.max(0, msgs.length - pageSize);",
  "    let page = msgs.slice(start);",
  "    if (peer.overlap && start > 0) page = [msgs[start - 1], ...page];",
  "    const direction = peer.direction ?? conf.direction ?? 'desc';",
  "    if (direction !== 'asc') page = page.reverse();",
  "    return { ok: true, status: 200, json: async () => ({ code: 0, data: { messages: page, has_more: start > 0 ? 1 : 0 } }) };",
  "  }",
  "  let list = []; try { list = JSON.parse(fs.readFileSync(SESSIONS, 'utf8')); } catch {}",
  "  return { ok: true, status: 200, json: async () => ({ code: 0, data: { session_list: list } }) };",
  "};",
].join('\n') + '\n');
const writeHistory = (o) => fs.writeFileSync(HISTORY_FILE, JSON.stringify(o));
const historyMsg = (seq, o = {}) => ({
  msg_key: String(o.msgKey ?? (30000 + seq)), msg_seqno: String(seq),
  timestamp: o.ts ?? TS, sender_uid: Number(o.sender ?? OWNER), receiver_id: Number(SELF),
  msg_type: 1, content: JSON.stringify({ content: o.text ?? `m${seq}` }),
});

fs.mkdirSync(path.join(testHome, 'surfcore', 'bili'), { recursive: true });
const cfgPath = path.join(testHome, 'surfcore', 'bili.config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  owner: { mid: OWNER, name: 'SYNTHETIC_OWNER' }, self: { mid: SELF },
  listen: { dm: true, dmScope: 'owner', comment: false, live: false },
  night: { windows: [] },
}));
fs.writeFileSync(path.join(testHome, 'surfcore', 'bili', 'credentials.json'), JSON.stringify({
  sessdata: 'SYNTHETIC', bili_jct: 'SYNTHETIC', buvid3: 'SYNTHETIC',
}));
const stateFile = path.join(testHome, 'surfcore', 'bili', 'dm-await-state.json');
const readState = () => { try { const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return raw?.scopes?.owner ?? raw; } catch { return null; } };
const writeState = (o) => fs.writeFileSync(stateFile, JSON.stringify(o, null, 2) + '\n');
const sessions = (list) => fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list));
const mkSession = (o = {}) => ({
  talker_id: o.talker ?? Number(OWNER),
  account_info: { name: o.name ?? 'SYNTHETIC_PEER' },
  unread_count: o.unread ?? 1,
  last_msg: {
    sender_uid: o.sender ?? Number(OWNER),
    timestamp: o.ts ?? TS,
    content: JSON.stringify({ content: o.text ?? 'SYNTHETIC_INBOUND' }),
    ...(o.msgKey === undefined ? {} : { msg_key: o.msgKey }),
    ...(o.seq === undefined ? {} : { msg_seqno: String(o.seq) }),
  },
});

const enqueues = [];
let hostReply = async () => ({ ok: true, accepted: true });
const hostReceipts = new Map();
const host = {
  enqueue: async (job) => { enqueues.push(job); const result = await hostReply(job); if (result.receipt) hostReceipts.set(job.requestId, result.receipt); return result; },
  query: async ({ requestId }) => hostReceipts.has(requestId) ? { ok: true, found: true, state: 'accepted', receipt: hostReceipts.get(requestId) } : { ok: true, found: false },
  retire: async () => ({ ok: true, retired: true }),
};
const env = {
  ...process.env,
  ...shareTestRoot(),
  DSH_HOME: testHome,
  SURFCORE_BILI_CONFIG: cfgPath,
  SURFCORE_DM_TEST_SESSIONS: SESSIONS_FILE,
  SURFCORE_DM_TEST_HISTORY: HISTORY_FILE,
  NODE_OPTIONS: '--import ' + SHIM,
  DSH_NODE: process.execPath,
};
for (const key of Object.keys(env)) if (key.startsWith('SURFCORE_EXPECTED_CHARACTER')) delete env[key];
Object.assign(process.env, env);

const { startScheduler } = await import('../lib/scheduler.js');
const ctx = { get: () => null, sessionController: { cancel: async () => ({ ok: true }) } };
const scheduler = startScheduler(ctx, {
  dshHome: testHome, biliMjs: BILI_MJS, cwd: testHome,
  sessionId: 'bili-whale', memoryV2: { getRouting: () => ({ ok: true, backend: 'v2' }) },
  biliV2Agent: host, onMemoryBlocked: () => {}, log: () => {},
});

const tick = async () => { enqueues.length = 0; await scheduler.dmTick(); return [...enqueues]; };
const results = [];

// 批次 B 状态助手：采集边界/ACK 进度/本地 seq 全部显式写入，避免测试互相污染。
const scopeState = (o = {}) => ({ cursor: 0, seen: {}, pending: {}, receipts: {}, collect: {}, ackThrough: {}, seq: 0, historyIncomplete: {}, initialized: true, ...o });
const resetState = (owner = {}, all = {}) => {
  hostReceipts.clear();
  enqueues.length = 0;
  writeState({ version: 2, scopes: { owner: scopeState(owner), all: scopeState(all) } });
};
const pendingRow = (id, { msgKey, ts = TS, seq = 1, text = 'LOCAL_ORIGINAL', scope = 'owner' } = {}) => ({
  requestId: id, scope, state: 'observed', seq, order: `p:${seq}`,
  original: { mid: OWNER, name: 'SYNTHETIC_OWNER', msgKey, ts, text, order: `p:${seq}` },
});
const registryFile = path.join(testHome, 'surfcore', 'bili-v2-managed-sessions.json');
function grantReceipt(id, { state = 'accepted', sessionId = `session-${id}` } = {}) {
  const receipt = { requestId: id, durable: true, state, source: 'bili-v2-registry', jobs: [{ requestId: `internal-${id}`, sessionId, jobId: `job-${id}` }] };
  let registry = { version: 1, sessions: {} };
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch {}
  registry.sessions[sessionId] = { ...receipt.jobs[0], originalRequestId: id, phase: state === 'terminal' ? 'terminal' : 'accepted', groupCount: 1, receipt };
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  return receipt;
}
// 变体：语义等价但字节/坐标不同的伪造回执（用于“不匹配必须拒绝”）。
function durableReceiptForHost(job) {
  return { requestId: job.requestId, durable: true, state: 'accepted', source: 'bili-v2-registry', jobs: [{ requestId: `internal-${job.requestId}`, sessionId: `session-${job.requestId}`, jobId: `job-${job.requestId}` }] };
}
const test = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error) }); console.log('FAIL ' + name + ': ' + String(error?.message ?? error)); }
};

try {
  await test('真实 Host 与 scheduler 不凭 accepted 合成 durable', async () => {
    const hostSource = fs.readFileSync(path.join(HERE, '..', 'lib', 'bili-v2-host.mjs'), 'utf8');
    const schedulerSource = fs.readFileSync(path.join(HERE, '..', 'lib', 'scheduler.js'), 'utf8');
    assert.doesNotMatch(hostSource, /durable\s*:\s*true/);
    assert.doesNotMatch(schedulerSource, /durable\s*:\s*true/);
    assert.match(hostSource, /accepted-needs-retry/);
  });
  await test('未知 schema 保留原字节', async () => {
    const original = JSON.stringify({ version: 999, cursor: 123, sentinel: 'preserve' });
    fs.writeFileSync(stateFile, original);
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--query', 'missing', '--json'], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    const failure = JSON.parse(run.stdout); assert.equal(failure.ok, false); assert.equal(failure.code, 'BILI_DM_STATE_CORRUPT'); assert.ok(failure.error && failure.hint);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
  });
  await test('旧版损坏 pending 保留原字节', async () => {
    const original = JSON.stringify({ lastSeen: 123, seen: {}, pending: [{ sentinel: 'MUST_KEEP' }] });
    fs.writeFileSync(stateFile, original);
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--query', 'missing', '--json'], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    const failure = JSON.parse(run.stdout); assert.equal(failure.ok, false); assert.equal(failure.code, 'BILI_DM_STATE_CORRUPT'); assert.ok(failure.error && failure.hint);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
  });
  await test('合法旧版状态无损迁移到 v2', async () => {
    const prior = { mid: OWNER, ts: TS, msgKey: MSG_KEY, requestId: 'legacy-original-id', text: 'legacy-original' };
    writeState({ lastSeen: 100, seen: { [OWNER]: 100 }, pending: [prior] });
    sessions([]);
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.version, 2); assert.equal(state.scopes.owner.cursor, 100);
    assert.equal(state.scopes.owner.pending['legacy-original-id'].original.text, prior.text);
    assert.equal(JSON.parse(run.stdout).items[0].requestId, 'legacy-original-id');
  });
  await test('没有 receipt 的 ACK 不推进游标', async () => {
    const row = { requestId: 'notice', scope: 'owner', state: 'observed', original: { mid: OWNER, msgKey: MSG_KEY, ts: TS } };
    const empty = { cursor: 0, seen: {}, pending: {}, receipts: {}, initialized: true };
    writeState({ version: 2, scopes: { owner: { ...empty, pending: { notice: row } }, all: empty } });
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'notice', '--json'], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).scopes.owner.cursor, 0);
  });
  await test('owner 和 all 对同一官方消息使用同一 ID', async () => {
    const empty = { cursor: 0, seen: {}, pending: {}, receipts: {}, initialized: true };
    writeState({ version: 2, scopes: { owner: empty, all: empty } });
    sessions([mkSession({ msgKey: MSG_KEY })]);
    const owner = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' });
    const all = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--any', '--json'], { env, encoding: 'utf8' });
    assert.equal(owner.status, 0, owner.stderr); assert.equal(all.status, 0, all.stderr);
    assert.equal(JSON.parse(owner.stdout).items[0].requestId, JSON.parse(all.stdout).items[0].requestId);
  });
  await test('伪造回执不能消费 pending', async () => {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const id = Object.keys(state.scopes.owner.pending)[0];
    const fake = { requestId: id, durable: true, state: 'accepted', source: 'bili-v2-registry', jobs: [{ requestId: 'forged', sessionId: 'forged', jobId: 'forged' }] };
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', id, '--receipt', JSON.stringify(fake), '--json'], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).scopes.owner.cursor, 0);
  });
  await test('稳定 ID：同一通知跨轮询时间/日期/批次顺序不变，且只入队一次', async () => {
    sessions([mkSession({ msgKey: MSG_KEY })]);
    writeState({ lastSeen: 0, pending: [] });
    const first = await tick();
    assert.equal(first.length, 1, '第一轮命中必须入队一次');
    const firstId = first[0].requestId;
    assert.equal(typeof firstId, 'string');
    assert.ok(firstId.length > 0);
    const second = await tick();
    assert.equal(second.length, 1, '未 ACK 的同一通知必须仍可重放');
    assert.equal(second[0].requestId, firstId, '同一通知跨轮询时间必须保持同一稳定 ID');
  });

  await test('pending 优先重放首次不可变原件：自回复/消息退出列表后旧 pending 仍可投递', async () => {
    sessions([mkSession({ talker: Number(OWNER), sender: Number(SELF), name: 'SYNTHETIC_OWNER', msgKey: '99999' })]);
    const replayed = await tick();
    assert.equal(replayed.length, 1, 'pending 原件必须优先重放，不受当前列表变化影响');
    const input = replayed[0].input;
    const coord = input?.items?.[0]?.msgKey ?? input?.snapshot?.msgKey ?? input?.msgKey;
    assert.equal(coord, MSG_KEY, '重放的必须是第一次持久记录的不可变原件（msgKey 99001），不是新列表');
  });

  await test('普通 ok:true（无接管回执）不得 ACK：pending 保持', async () => {
    hostReply = async () => ({ ok: true });
    await tick();
    const st = readState();
    assert.ok(st && Object.keys(st.pending ?? {}).length >= 1, '普通 ok:true 不得清 pending / 推进游标');
    assert.equal(Number(st.cursor ?? st.lastSeen ?? 0), 0, '未确认接管时真实游标不得推进');
  });

  await test('确认接管回执后 ACK 持久提交，之后不再重复入队', async () => {
    hostReply = async (job) => {
      const receipt = { requestId: job.requestId, durable: true, state: 'accepted', source: 'bili-v2-registry', jobs: [{ requestId: 'internal-fixture', sessionId: 'session-fixture', jobId: 'job-fixture' }] };
      fs.writeFileSync(path.join(testHome, 'surfcore', 'bili-v2-managed-sessions.json'), JSON.stringify({ version: 1, sessions: { 'session-fixture': { ...receipt.jobs[0], originalRequestId: job.requestId, phase: 'accepted', groupCount: 1, receipt } } }));
      return { ok: true, accepted: true, receipt };
    };
    await tick();
    const st = readState();
    assert.ok(st && Number(st.cursor ?? st.lastSeen ?? 0) >= TS, '确认接管后必须 --ack 推进对应游标');
    assert.equal(Object.keys(st.pending ?? {}).length, 0, '确认接管后 pending 必须被消费');
    const again = await tick();
    assert.equal(again.length, 0, 'ACK 后旧通知不得重复入队');
  });

  await test('真实 Runtime 重启与持久注册表合同', async () => {
    const runtimeEnv = { ...env }; delete runtimeEnv.NODE_OPTIONS;
    const run = spawnSync(process.execPath, [path.join(HERE, 'test-memory-v2-bili-agent.mjs'), '--contract-only'], { env: runtimeEnv, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS durable runtime contract/);
    console.log(run.stdout.trim());
  });

  // ── 批次 B / 02：同会话同秒、跨轮询中间消息 ────────────────────────────────
  await test('02 同会话同秒 A、B 均进入 Host（第一条确认后第二条不丢）', async () => {
    resetState();
    hostReply = async (job) => ({ ok: true, accepted: true, receipt: grantReceipt(job.requestId) });
    writeHistory({ [OWNER]: { pageSize: 50, messages: [historyMsg(1, { msgKey: '2001', text: 'A', ts: TS }), historyMsg(2, { msgKey: '2002', text: 'B', ts: TS })] } });
    sessions([mkSession({ msgKey: '2001', ts: TS, text: 'A' })]);
    const first = await tick();
    assert.equal(first.length, 1, '第一条 A 必须进入 Host');
    assert.equal(first[0].input.items[0].text, 'A');
    sessions([mkSession({ msgKey: '2002', ts: TS, text: 'B' })]);
    const second = await tick();
    assert.equal(second.length, 1, '同秒、不同平台编号的 B 必须进入 Host');
    assert.equal(second[0].input.items[0].text, 'B');
    const st = readState();
    assert.equal(Object.keys(st.pending).length, 0, '两条都已取得回执并 ACK');
  });

  await test('02 两轮之间的同秒中间消息沿历史补齐（A/B/C 一次收齐）', async () => {
    resetState({ collect: { [OWNER]: { lastKey: '2000', lastTs: TS, order: 'p:1', updatedAt: null } }, seen: { [OWNER]: TS } });
    hostReply = async (job) => ({ ok: true, accepted: true, receipt: grantReceipt(job.requestId) });
    writeHistory({ [OWNER]: { pageSize: 50, messages: [
      historyMsg(1, { msgKey: '2000', text: 'PREVIOUS', ts: TS }),
      historyMsg(2, { msgKey: '2001', text: 'A', ts: TS }),
      historyMsg(3, { msgKey: '2002', text: 'B', ts: TS }),
      historyMsg(4, { msgKey: '2003', text: 'C', ts: TS }),
    ] } });
    sessions([mkSession({ msgKey: '2003', ts: TS, text: 'C' })]);
    const got = await tick();
    assert.deepEqual(got.map((job) => job.input.items[0].text), ['A', 'B', 'C'], '同秒中间消息必须全部补齐');
  });

  // ── 批次 B / 02：正序、倒序、相邻页重叠、跨页 N 条 ─────────────────────────
  for (const variant of [
    { name: '倒序+跨页', direction: 'desc', overlap: false },
    { name: '正序+跨页', direction: 'asc', overlap: false },
    { name: '相邻页重叠', direction: 'desc', overlap: true },
  ]) {
    await test(`02 采集 ${variant.name} 仍收齐 N 条`, async () => {
      resetState({ collect: { [OWNER]: { lastKey: '30001', lastTs: TS, order: 'p:1', updatedAt: null } }, seen: { [OWNER]: TS } });
      const messages = []
      for (let i = 1; i <= 6; i += 1) messages.push(historyMsg(i, { msgKey: String(30000 + i), text: `m${i}`, ts: TS }))
      writeHistory({ [OWNER]: { messages, pageSize: 2, direction: variant.direction, overlap: variant.overlap } });
      sessions([mkSession({ msgKey: '30006', ts: TS, text: 'm6' })]);
      const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const out = JSON.parse(run.stdout);
      assert.deepEqual(out.items.map((it) => it.text), ['m2', 'm3', 'm4', 'm5', 'm6'], `${variant.name}: 跨页消息必须按平台序号收齐`);
      assert.equal(new Set(out.items.map((it) => it.requestId)).size, out.items.length, '相邻页重叠不得产生重复身份');
    });
  }

  // ── 返工阶段 1：分页中断恢复——完整边界不跟着失败页移动 ────────────────────
  await test('R2-02 分页恢复：首轮入 4/5 但完整边界仍 1，恢复补齐 2/3 且 4/5 ID 不变', async () => {
    const msgs = []
    for (let i = 1; i <= 5; i += 1) msgs.push(historyMsg(i, { msgKey: String(1000 + i), text: `m${i}`, ts: TS }))
    resetState({ collect: { [OWNER]: { lastKey: '1001', lastTs: TS, order: 'p:1', updatedAt: null } }, seen: { [OWNER]: TS } })
    hostReply = async () => ({ ok: true })   // 不 ACK，pending 保留用于核对 ID
    writeHistory({ [OWNER]: { messages: msgs, pageSize: 2, failPage2: true } })
    sessions([mkSession({ msgKey: '1005', seq: 5, ts: TS, text: 'm5' })])
    const first = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr + first.stdout)
    const out1 = JSON.parse(first.stdout)
    assert.deepEqual(out1.items.map((it) => it.text), ['m4', 'm5'], '首轮可入 4、5')
    const id4 = out1.items.find((it) => it.text === 'm4').requestId
    const id5 = out1.items.find((it) => it.text === 'm5').requestId
    let st = readState()
    assert.equal(st.collect[OWNER].order, 'p:1', '完整边界在补齐前仍须停在 1')
    const gap = st.historyIncomplete?.[OWNER]
    assert.ok(gap?.code && gap?.error && gap?.hint, '缺口必须带 code/error/hint')

    writeHistory({ [OWNER]: { messages: msgs, pageSize: 2, failPage2: false } })
    const second = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr + second.stdout)
    const out2 = JSON.parse(second.stdout)
    const byText = Object.fromEntries(out2.items.map((it) => [it.text, it]))
    assert.ok(byText.m2 && byText.m3, '恢复轮必须新增 2、3')
    assert.equal(byText.m4?.requestId, id4, '4 必须保持原 requestId')
    assert.equal(byText.m5?.requestId, id5, '5 必须保持原 requestId')
    st = readState()
    assert.equal(st.collect[OWNER].order, 'p:5', '2–5 全部落盘后完整边界才到 5')
    assert.equal(st.historyIncomplete?.[OWNER], undefined, '补齐后缺口应清除')

    const third = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' })
    assert.equal(third.status, 0, third.stderr + third.stdout)
    const out3 = JSON.parse(third.stdout)
    assert.equal(new Set(out3.items.map((it) => it.requestId)).size, out3.items.length, '第三轮不得重复新增')
    assert.equal(readState().collect[OWNER].order, 'p:5', '第三轮完整边界不后退')
  })

  // ── 批次 B / 07：远端离线时仍交付本地 pending ──────────────────────────────
  await test('07 CLI：远端离线且 local pending=1 时仍输出原件并报告采集失败', async () => {
    resetState({ pending: { 'local-offline': pendingRow('local-offline', { msgKey: '40001', seq: 1, text: 'LOCAL_ORIGINAL' }) } });
    sessions([]);
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env: { ...env, SURFCORE_DM_TEST_OFFLINE: '1' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.collect.ok, false, '采集失败必须结构化表达');
    assert.ok(out.collect.code && out.collect.error && out.collect.hint, '失败必须带 code/error/hint');
    assert.equal(out.localPending, 1);
    assert.deepEqual(out.items.map((it) => it.text), ['LOCAL_ORIGINAL'], '本地原件不得因远端失败被丢弃');
  });

  await test('07 调度器：远端离线不阻断本地 pending 交付，并暴露采集失败', async () => {
    resetState({ pending: { 'local-scheduler': pendingRow('local-scheduler', { msgKey: '40002', seq: 1, text: 'LOCAL_SCHED' }) } });
    sessions([]);
    hostReply = async (job) => ({ ok: true, accepted: true, receipt: grantReceipt(job.requestId) });
    process.env.SURFCORE_DM_TEST_OFFLINE = '1';
    let got
    try { got = await tick() } finally { delete process.env.SURFCORE_DM_TEST_OFFLINE }
    assert.equal(got.length, 1, '离线时调度器仍必须交付已持久化 pending');
    assert.equal(got[0].input.items[0].text, 'LOCAL_SCHED');
    const failure = scheduler.status().dmCollectFailure;
    assert.ok(failure && failure.code === 'BILI_DM_COLLECT_FAILED' && failure.error && failure.hint, '采集失败必须可见且可行动');
    // 远端恢复后失败状态清除，且不再重复交付已 ACK 的本地原件。
    hostReply = async () => ({ ok: true });
    const recovered = await tick();
    assert.equal(recovered.length, 0, '已接管项不得产生第二次业务效果');
    assert.equal(scheduler.status().dmCollectFailure, null);
  });

  // ── 返工阶段 1：大队列分批 / 大序号 / 区间未证 ───────────────────────────
  await test('R2-07 大队列：100 条本地 pending 离线分批输出，调度器跨两轮稳定遍历', async () => {
    const pending = {}
    for (let i = 1; i <= 100; i += 1) pending[`bulk-${i}`] = pendingRow(`bulk-${i}`, { msgKey: String(50000 + i), seq: i, text: `bulk-${i}` })
    resetState({ pending })
    sessions([])
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'],
      { env: { ...env, SURFCORE_DM_TEST_OFFLINE: '1' }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    assert.equal(run.status, 0, run.stderr.slice(0, 500))
    const lines = run.stdout.split('\n').filter(Boolean)
    assert.ok(lines.length > 1, `100 条须分批输出，实际 ${lines.length} 行；bytes=${Buffer.byteLength(run.stdout)}`)
    const items = []
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 20 * 1024, `单行不得超过分批上限：${Buffer.byteLength(line, 'utf8')}`)
      const j = JSON.parse(line)
      assert.equal(j.ok, true, '每批都必须可独立解析且成功')
      items.push(...j.items)
    }
    assert.equal(items.length, 100, '批内条目总数必须是 100')
    assert.equal(new Set(items.map((it) => it.requestId)).size, 100, '不得因分批产生重复身份')
    assert.ok(lines.some((line) => JSON.parse(line).batch?.total === lines.length), '须带批次元信息')
    assert.equal(JSON.parse(lines.at(-1)).done, true, '最后一批须标记 done')

    hostReply = async () => ({ ok: true })   // 无回执，pending 保留用于第二轮重放
    process.env.SURFCORE_DM_TEST_OFFLINE = '1'
    let first, second
    try { first = await tick(); second = await tick() } finally { delete process.env.SURFCORE_DM_TEST_OFFLINE }
    const bulkFirst = first.filter((j) => String(j.requestId).startsWith('bulk-'))
    const bulkSecond = second.filter((j) => String(j.requestId).startsWith('bulk-'))
    assert.equal(bulkFirst.length, 100, `首轮须交付 100 条 bulk 原件，实际 ${bulkFirst.length}`)
    assert.equal(bulkSecond.length, 100, `第二轮仍须读完全部批，实际 ${bulkSecond.length}`)
    assert.deepEqual(new Set(bulkSecond.map((j) => j.requestId)), new Set(bulkFirst.map((j) => j.requestId)), '两轮身份集合须一致')
  })

  await test('R2-02 大序号：19 位 msg_seqno 原样保留并按数值排序', async () => {
    const seqs = ['9223372036854775800', '9223372036854775801', '9223372036854775802']
    resetState({ collect: { [OWNER]: { lastKey: '60001', lastTs: TS, order: `p:${seqs[0]}` } }, seen: { [OWNER]: TS } })
    writeHistory({ [OWNER]: { messages: seqs.map((seq, i) => historyMsg(seq, { msgKey: String(60001 + i), text: `m${i + 1}`, ts: TS + i })), pageSize: 20 } })
    sessions([mkSession({ msgKey: '60003', seq: seqs[2], ts: TS + 2, text: 'm3' })])
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr + run.stdout.slice(0, 300))
    const out = JSON.parse(run.stdout)
    assert.deepEqual(out.items.map((it) => it.text), ['m2', 'm3'], `大序号须按数值比较，不得字典序截断：${JSON.stringify(out.items.map((it) => it.text))}`)
    const orders = Object.values(readState().pending).map((row) => row.order)
    for (const seq of seqs.slice(1)) assert.ok(orders.some((order) => String(order).endsWith(seq)), `序号 ${seq} 须原样保留`)
  })

  await test('R2-02 has_more=0 但上一边界未覆盖时记录区间未证而非跳过', async () => {
    const msgs = [1, 2, 3].map((i) => historyMsg(i, { msgKey: String(70000 + i), text: `m${i}`, ts: TS }))
    resetState({ collect: { [OWNER]: { lastKey: '69999', lastTs: TS, order: 'p:0' } }, seen: { [OWNER]: TS } })
    writeHistory({ [OWNER]: { messages: msgs, pageSize: 20 } })
    sessions([mkSession({ msgKey: '70003', seq: 3, ts: TS, text: 'm3' })])
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr + run.stdout.slice(0, 300))
    const out = JSON.parse(run.stdout)
    assert.ok(out.items.some((it) => it.text === 'm2'), '到顶消息仍须在上一边界之后补齐')
    const gap = readState().historyIncomplete?.[OWNER]
    assert.equal(gap?.code, 'BILI_DM_HISTORY_RANGE_UNPROVEN', `has_more=0 不等于区间已覆盖：${JSON.stringify(gap)} / items=${JSON.stringify(out.items.map((it)=>it.text))}`)
    assert.equal(readState().collect[OWNER].order, 'p:0', `区间未证不得推进完整边界：${JSON.stringify(readState().collect[OWNER])}`)
  })

  // ── 批次 B / 11：保护验证（无回执拒绝、连续推进、作用域独立） ───────────────
  await test('11 ACK 只沿连续已处理范围推进：前面的未 ACK 项阻断游标', async () => {
    resetState({
      seq: 3,
      pending: {
        'notice-B': pendingRow('notice-B', { msgKey: '50001', ts: TS, seq: 1, text: 'B' }),
        'notice-C': pendingRow('notice-C', { msgKey: '50002', ts: TS + 1, seq: 2, text: 'C' }),
        'notice-D': pendingRow('notice-D', { msgKey: '50003', ts: TS + 2, seq: 3, text: 'D' }),
      },
      ackThrough: {},
    }, { pending: { 'all-only': pendingRow('all-only', { msgKey: '50009', ts: TS + 9, seq: 1, text: 'ALL', scope: 'all' }) }, seq: 1 });
    const beforeAll = JSON.stringify(JSON.parse(fs.readFileSync(stateFile, 'utf8')).scopes.all);
    const receiptC = grantReceipt('notice-C');
    const ackC = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'notice-C', '--receipt', JSON.stringify(receiptC), '--json'], { env, encoding: 'utf8' });
    assert.equal(ackC.status, 0, ackC.stderr + ackC.stdout);
    let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.scopes.owner.cursor, 0, 'B 未 ACK 时 C 的 ACK 不得推进游标');
    assert.equal(st.scopes.owner.ackThrough[OWNER], 0, '连续高水位必须停在 B 之前');
    assert.equal(JSON.stringify(st.scopes.all), beforeAll, 'owner 的 ACK 不得改动 all scope');

    const receiptB = grantReceipt('notice-B');
    const ackB = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'notice-B', '--receipt', JSON.stringify(receiptB), '--json'], { env, encoding: 'utf8' });
    assert.equal(ackB.status, 0, ackB.stderr + ackB.stdout);
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.scopes.owner.ackThrough[OWNER], 2, 'B、C 连续 ACK 后高水位到 2');
    assert.ok(st.scopes.owner.cursor >= TS, '连续前缀内的数值镜像才可推进');

    const receiptD = grantReceipt('notice-D');
    const ackD = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'notice-D', '--receipt', JSON.stringify(receiptD), '--json'], { env, encoding: 'utf8' });
    assert.equal(ackD.status, 0, ackD.stderr + ackD.stdout);
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.scopes.owner.ackThrough[OWNER], 3);
    assert.equal(Object.keys(st.scopes.owner.pending).length, 0);
    // 重启（新进程）后不重复投递已 ACK 项。
    sessions([]); writeHistory({});
    const again = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(again.stdout).items.length, 0, '重启后已 ACK 项不得再次进入队列');
  });

  await test('11 --scope 限定 ACK 不消费另一作用域的同一 pending', async () => {
    const row = (scope) => ({ ...pendingRow('same-id', { msgKey: '50020', seq: 1, text: 'SAME' }), scope });
    resetState({ pending: { 'same-id': row('owner') }, seq: 1 }, { pending: { 'same-id': row('all') }, seq: 1 });
    const receipt = grantReceipt('same-id');
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'same-id', '--scope', 'all', '--receipt', JSON.stringify(receipt), '--json'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(st.scopes.owner.pending['same-id'], 'owner 的同一 pending 必须保留');
    assert.equal(st.scopes.all.pending['same-id'], undefined, 'all 的 pending 已按 scope 消费');
    assert.equal(st.scopes.owner.cursor, 0, 'owner 游标不得被 all 的 ACK 推进');
    assert.equal(st.scopes.all.ackThrough[OWNER], 1);
  });

  await test('11 回执与 Host 原作业不匹配时拒绝 ACK', async () => {
    resetState({ pending: { 'notice-X': pendingRow('notice-X', { msgKey: '50010', seq: 1, text: 'X' }) }, seq: 1 });
    const receipt = grantReceipt('notice-X');
    receipt.jobs[0].jobId = 'tampered-job';
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--ack', 'notice-X', '--receipt', JSON.stringify(receipt), '--json'], { env, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    const out = JSON.parse(run.stdout);
    assert.equal(out.code, 'BILI_DM_RECEIPT_INVALID');
    assert.ok(out.error && out.hint);
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.scopes.owner.cursor, 0);
    assert.ok(st.scopes.owner.pending['notice-X'], '不匹配回执不得消费 pending');
  });

  await test('11 旧游标迁移后仍可继续收件，两个作用域互不覆盖', async () => {
    writeState({ version: 2, scopes: {
      owner: { cursor: 100, seen: { [OWNER]: 100 }, pending: {}, receipts: {}, initialized: true },
      all: { cursor: 0, seen: {}, pending: {}, receipts: {}, initialized: true },
    } });
    writeHistory({ [OWNER]: { pageSize: 50, messages: [historyMsg(1, { msgKey: '60001', ts: 90, text: 'LEGACY_OLD' }), historyMsg(2, { msgKey: '60002', ts: 102, text: 'LEGACY_NEW' })] } });
    sessions([mkSession({ msgKey: '60002', ts: 102, text: 'LEGACY_NEW' })]);
    const run = spawnSync(process.execPath, [BILI_MJS, 'dm-await', '--once', '--json'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.items.map((it) => it.text), ['LEGACY_NEW'], '旧 seen 时间戳作为重叠边界，只补其后的消息');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.scopes.owner.cursor, 100, '旧游标保留');
    assert.ok(st.scopes.owner.collect[OWNER], '新采集边界已建立');
    assert.equal(st.scopes.all.cursor, 0, 'all scope 未被 owner 迁移覆盖');
    assert.equal(Object.keys(st.scopes.all.pending).length, 0);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`F03 DM r2: ${results.length - failed.length}/${results.length} cases`);
  if (failed.length) process.exitCode = 1;
} finally {
  try { scheduler.stop(); } catch {}
  setTimeout(() => process.exit(process.exitCode ?? 0), 30).unref?.();
}
