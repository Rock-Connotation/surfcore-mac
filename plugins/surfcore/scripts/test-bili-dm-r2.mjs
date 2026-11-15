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
const SHIM = path.join(testHome, 'fetch-shim.mjs');
fs.writeFileSync(SHIM, [
  "import fs from 'node:fs';",
  "const file = process.env.SURFCORE_DM_TEST_SESSIONS;",
  "globalThis.fetch = async (url) => {",
  "  const u = new URL(String(url));",
  "  if (u.hostname !== 'api.vc.bilibili.com') throw new Error('UNEXPECTED_NETWORK');",
  "  let list = []; try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}",
  "  return { ok: true, status: 200, json: async () => ({ code: 0, data: { session_list: list } }) };",
  "};",
].join('\n') + '\n');

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

  const failed = results.filter((r) => !r.ok);
  console.log(`F03 DM r2: ${results.length - failed.length}/${results.length} cases`);
  if (failed.length) process.exitCode = 1;
} finally {
  try { scheduler.stop(); } catch {}
  setTimeout(() => process.exit(process.exitCode ?? 0), 30).unref?.();
}
