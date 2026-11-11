/**
 * HY4-BILI-DM-TRIGGER run1/3 — 实际 CLI 子进程 + 隔离 DSH_HOME + fetch shim。
 * 验证 dm-await --once --json [--any] 的 msgKey 精确投影与 V1 行为保持。
 * 全程合成数据；无外网、无真实凭据、无平台发送。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BILI = path.join(HERE, '..', 'tools', 'bili.mjs');
const SHIM = path.join(os.tmpdir(), 'surfcore-bili-dm-trigger-shim-' + process.pid + '.mjs');

const SHIM_LINES = [
  "import fs from 'node:fs';",
  "if (!globalThis.__dmTriggerShim) {",
  "  globalThis.__dmTriggerShim = true;",
  "  const LOG = process.env.SURFCORE_DM_TEST_LOG || '';",
  "  const RAW = process.env.SURFCORE_DM_TEST_SESSIONS || '[]';",
  "  const NL = String.fromCharCode(10);",
  "  const rec = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + NL); } catch {} };",
  "  globalThis.fetch = async (url, init) => {",
  "    const u = new URL(String(url));",
  "    rec({ method: String((init && init.method) || 'GET'), host: u.hostname, path: u.pathname });",
  "    if (u.hostname !== 'api.vc.bilibili.com' || u.pathname !== '/session_svr/v1/session_svr/get_sessions') {",
  "      rec({ denied: 'UNEXPECTED_WORKER_NETWORK', url: String(url) });",
  "      throw new Error('UNEXPECTED_WORKER_NETWORK');",
  "    }",
  "    let list = []; try { list = JSON.parse(RAW); } catch {}",
  "    return { ok: true, status: 200, json: async () => ({ code: 0, data: { session_list: list } }), headers: { get: () => 'application/json' } };",
  "  };",
  "}",
];
fs.writeFileSync(SHIM, SHIM_LINES.join('\n') + '\n');
process.on('exit', () => { try { fs.rmSync(SHIM, { force: true }); } catch {} });

const TS = 1700000000;
const OWNER = '22000';
const SELF = '9';
const DIGIT19 = '1234567890123456789';
const UNSAFE_NUMBER = 12345678901234567890;

const mkSession = (o = {}) => ({
  talker_id: o.talker ?? 33000,
  account_info: { name: o.name ?? 'SYNTHETIC_PEER' },
  unread_count: o.unread ?? 1,
  last_msg: {
    sender_uid: o.sender ?? 33000,
    timestamp: o.ts ?? TS,
    content: JSON.stringify({ content: 'SYNTHETIC_INBOUND' }),
    ...('msgKey' in o ? { msg_key: o.msgKey } : {}),
  },
});

async function run({ sessions = [], args = ['--once', '--json', '--any'], state, config } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-dm-trigger-'));
  const bili = path.join(home, 'surfcore', 'bili');
  fs.mkdirSync(bili, { recursive: true });
  fs.writeFileSync(path.join(bili, 'credentials.json'), JSON.stringify({
    sessdata: 'SYNTHETIC_DM_COOKIE', bili_jct: 'SYNTHETIC_DM_CSRF', buvid3: 'SYNTHETIC_DM_BUVID',
  }));
  const configPath = path.join(home, 'surfcore', 'bili.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config || {
    owner: { mid: OWNER, name: 'SYNTHETIC_OWNER' }, self: { mid: SELF }, notify: { type: 'none' },
  }));
  if (state !== undefined) fs.writeFileSync(path.join(bili, 'dm-await-state.json'), JSON.stringify(state));
  const reqLog = path.join(home, 'requests.log');
  fs.writeFileSync(reqLog, '');
  const env = {
    ...process.env,
    DSH_HOME: home,
    SURFCORE_BILI_CONFIG: configPath,
    SURFCORE_DM_TEST_SESSIONS: JSON.stringify(sessions),
    SURFCORE_DM_TEST_LOG: reqLog,
    NODE_OPTIONS: '--import ' + SHIM,
  };
  delete env.SURFCORE_EXPECTED_CHARACTER_ID;
  delete env.SURFCORE_EXPECTED_CHARACTER_EPOCH;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BILI, 'dm-await', ...args], {
      env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let requests = [];
      try { requests = fs.readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      resolve({ code, stdout, stderr, requests });
    });
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

const jsonOut = (r) => {
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'stdout must be exactly one line: ' + JSON.stringify(r.stdout));
  return JSON.parse(lines[0]);
};

const assertClean = (r) => {
  assert.ok(r.requests.length >= 1, 'expected at least one official GET');
  for (const q of r.requests) {
    assert.equal(q.denied, undefined, 'no denied network: ' + JSON.stringify(q));
    assert.equal(q.host, 'api.vc.bilibili.com');
    assert.equal(q.path, '/session_svr/v1/session_svr/get_sessions');
    assert.equal(q.method, 'GET');
  }
  assert.ok(!/SYNTHETIC_DM_COOKIE|SESSDATA|wire|bili_jct|hint|error/i.test(r.stdout),
    'stdout must not carry sensitive diagnostics: ' + JSON.stringify(r.stdout));
};

let pass = 0;
const test = async (name, fn) => { await fn(); pass += 1; console.log('PASS ' + name); };

try {
  await test('--any 19-digit string msg_key is preserved verbatim + V1 fields + zero external network', async () => {
    const r = await run({ sessions: [mkSession({ msgKey: DIGIT19 })], state: { seen: {} } });
    assert.equal(r.code, 0, r.stderr);
    const out = jsonOut(r);
    assert.equal(out.hit, true);
    assert.equal(out.items.length, 1);
    const item = out.items[0];
    assert.equal(item.msgKey, DIGIT19, '19-digit decimal ID must be preserved verbatim');
    assert.equal(item.mid, '33000');
    assert.equal(item.name, 'SYNTHETIC_PEER');
    assert.equal(item.text, 'SYNTHETIC_INBOUND');
    assert.equal(item.ts, TS);
    assert.equal(item.unread, 1);
    assert.equal(item.isOwner, false);
    assertClean(r);
  });

  await test('--any positive safe-integer msg_key becomes an exact decimal string', async () => {
    const r = await run({ sessions: [mkSession({ msgKey: 9988776655 })], state: { seen: {} } });
    assert.equal(r.code, 0, r.stderr);
    const item = jsonOut(r).items[0];
    assert.equal(item.msgKey, '9988776655');
    assert.equal(typeof item.msgKey, 'string');
    assertClean(r);
  });

  await test('--any missing msg_key emits no msgKey and does not guess from ts/text/mid', async () => {
    const r = await run({ sessions: [mkSession()], state: { seen: {} } });
    assert.equal(r.code, 0, r.stderr);
    const item = jsonOut(r).items[0];
    assert.ok(!('msgKey' in item), 'missing msg_key must not fabricate a field');
    assert.equal(item.mid, '33000');
    assert.equal(item.text, 'SYNTHETIC_INBOUND');
    assertClean(r);
  });

  await test('--any empty/object/negative/unsafe/whitespace msg_key never fabricates an ID', async () => {
    const variants = ['', '   ', '12 34', '-5', '0x10', {}, [], null, -5, 0, 1.5, UNSAFE_NUMBER, true];
    const sessions = variants.map((v, i) => mkSession({ talker: 40000 + i, sender: 40000 + i, msgKey: v }));
    const r = await run({ sessions, state: { seen: {} } });
    assert.equal(r.code, 0, r.stderr);
    const out = jsonOut(r);
    assert.equal(out.items.length, variants.length);
    for (const item of out.items) {
      assert.ok(!('msgKey' in item), 'invalid msg_key must omit the field: ' + JSON.stringify(item));
      assert.ok('mid' in item && 'text' in item && 'ts' in item && 'unread' in item && 'isOwner' in item);
    }
    assertClean(r);
  });

  await test('--any own last message is not treated as incoming', async () => {
    const r = await run({ sessions: [mkSession({ sender: Number(SELF), msgKey: '9988' })], state: { seen: {} } });
    const out = jsonOut(r);
    assert.equal(out.hit, false);
    assert.equal(out.items.length, 0);
    assertClean(r);
  });

  await test('--any already-seen message is not treated as incoming', async () => {
    const r = await run({ sessions: [mkSession({ msgKey: '9988' })], state: { seen: { '33000': TS } } });
    const out = jsonOut(r);
    assert.equal(out.hit, false);
    assert.equal(out.items.length, 0);
    assertClean(r);
  });

  await test('--any FIRST_ANY baseline is preserved (fresh state, no hit)', async () => {
    const r = await run({ sessions: [mkSession({ msgKey: '9988' })] });
    const out = jsonOut(r);
    assert.equal(out.hit, false);
    assert.equal(out.baseline, true);
    assert.equal(out.items.length, 0);
    assertClean(r);
  });

  await test('owner branch --once --json carries exact msgKey + V1 fields', async () => {
    const r = await run({
      sessions: [mkSession({ talker: Number(OWNER), sender: Number(OWNER), name: 'SYNTHETIC_OWNER', msgKey: DIGIT19 })],
      args: ['--once', '--json'], state: { lastSeen: 0 },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = jsonOut(r);
    assert.equal(out.hit, true);
    assert.equal(out.msgKey, DIGIT19);
    assert.equal(out.mid, OWNER);
    assert.equal(out.name, 'SYNTHETIC_OWNER');
    assert.equal(out.text, 'SYNTHETIC_INBOUND');
    assert.equal(out.ts, TS);
    assertClean(r);
  });

  await test('owner branch non-owner last message does not hit', async () => {
    const r = await run({
      sessions: [mkSession({ talker: Number(OWNER), sender: 99999, msgKey: '9988' })],
      args: ['--once', '--json'], state: { lastSeen: 0 },
    });
    const out = jsonOut(r);
    assert.equal(out.hit, false);
    assert.ok(!('msgKey' in out));
    assertClean(r);
  });

  await test('owner branch unsafe msg_key hits but omits msgKey', async () => {
    const r = await run({
      sessions: [mkSession({ talker: Number(OWNER), sender: Number(OWNER), msgKey: UNSAFE_NUMBER })],
      args: ['--once', '--json'], state: { lastSeen: 0 },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = jsonOut(r);
    assert.equal(out.hit, true);
    assert.ok(!('msgKey' in out), 'unsafe number must not become a fake exact ID');
    assertClean(r);
  });

  console.log('PASS Bili DM trigger: ' + pass + ' cases');
} catch (error) {
  console.log('FAIL ' + String((error && error.stack) || error));
  process.exitCode = 1;
}
