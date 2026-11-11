import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBiliV2OfficialTransport } from '../lib/bili-v2-official-transport.mjs';
import { attachBiliV2Worker, BILI_V2_ENDPOINTS } from '../tools/lib/bili-v2-dispatch.mjs';
import { redactContent } from '../../../src/core/memory-v2-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = path.join(HERE, '..', 'tools', 'commands');
const SHIM_PATH = path.join(os.tmpdir(), 'surfcore-bili-write-shim-' + process.pid + '.mjs');

const HOST_COOKIE_A = 'SESSDATA=HOST_ACCOUNT_A; bili_jct=HOST_CSRF_A';
const HOST_COOKIE_B = 'SESSDATA=HOST_ACCOUNT_B; bili_jct=HOST_CSRF_B';
const HOST_CSRF_A = 'HOST_CSRF_A';
const HOST_CSRF_B = 'HOST_CSRF_B';

const SHIM_SOURCE = String.raw`import fs from 'node:fs';
if (!globalThis.__biliWriteShim) {
  globalThis.__biliWriteShim = true;
  const LOG = process.env.SURFCORE_WORKER_TEST_REQUESTS || '';
  const rec = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); } catch {} };
  const NAV_MID = Number(process.env.SURFCORE_WORKER_TEST_NAV_MID || 9);
  const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
  const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08f87e641.png';
  const nav = () => ({ code: 0, data: { isLogin: true, mid: NAV_MID, uname: 'SYNTHETIC', wbi_img: { img_url: IMG, sub_url: SUB } } });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    const method = String((init && init.method) || 'GET').toUpperCase();
    const entry = { method, path: u.origin + u.pathname, search: u.search, cookie: (init && init.headers && init.headers.cookie) || '' };
    rec(entry);
    if (u.hostname !== 'api.bilibili.com' && u.hostname !== 'api.vc.bilibili.com') {
      rec({ denied: 'UNEXPECTED_WORKER_NETWORK', url: String(url) });
      throw new Error('UNEXPECTED_WORKER_NETWORK');
    }
    const SESSION = process.env.SURFCORE_WORKER_TEST_SESSION || 'ok';
    const TO = Number(process.env.SURFCORE_WORKER_TEST_TO || 22000);
    let body;
    if (u.pathname === '/x/web-interface/nav') body = nav();
    else if (u.pathname === '/x/relation') body = { code: 0, data: { attribute: 6 } };
    else if (u.pathname === '/session_svr/v1/session_svr/get_sessions') {
      let list = [];
      if (SESSION === 'ok') list = [{ talker_id: TO, last_msg: { sender_uid: TO, timestamp: Math.floor(Date.now() / 1000), content: JSON.stringify({ content: 'SYNTHETIC_INBOUND' }) }, account_info: { name: 'SYNTHETIC_PEER' } }];
      else if (SESSION === 'last-mine') list = [{ talker_id: TO, last_msg: { sender_uid: 9, timestamp: Math.floor(Date.now() / 1000), content: JSON.stringify({ content: 'SYNTHETIC_INBOUND' }) }, account_info: { name: 'SYNTHETIC_PEER' } }];
      body = { code: 0, data: { session_list: list } };
    }
    else if (u.pathname === '/x/v2/reply' || u.pathname === '/x/v2/reply/reply') body = { code: 0, data: { replies: [] } };
    else if (u.pathname === '/x/web-interface/view') body = { code: 0, data: { title: '', owner: { mid: 9 } } };
    else body = { code: 0, data: {} };
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } };
  };
}
`;

fs.writeFileSync(SHIM_PATH, SHIM_SOURCE);

const OFFICIAL_HOSTS = new Set(['api.bilibili.com', 'api.vc.bilibili.com']);
const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08f87e641.png';

async function runWorker(opts = {}) {
  const action = opts.action || 'comment';
  const text = opts.text || 'SYNTHETIC_TEST_MESSAGE';
  const oid = opts.oid || '11';
  const type = opts.type || '1';
  const root = opts.root || '0';
  const parent = opts.parent || '0';
  const to = opts.to || '22000';
  const managed = opts.managed !== false;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-write-worker-'));
  const surfcore = path.join(home, 'surfcore');
  const bili = path.join(surfcore, 'bili');
  fs.mkdirSync(path.join(surfcore, 'characters'), { recursive: true });
  fs.mkdirSync(bili, { recursive: true });
  fs.writeFileSync(path.join(bili, 'credentials.json'), JSON.stringify({ sessdata: 'SYNTHETIC_WORKER_COOKIE', bili_jct: 'SYNTHETIC_WORKER_CSRF', buvid3: 'SYNTHETIC_WORKER_DEVICE' }));
  const cfg = { notify: { type: 'none' }, interact: { enabled: true }, owner: { mid: '', name: '' }, ...(opts.configOverrides || {}) };
  fs.writeFileSync(path.join(surfcore, 'bili.config.json'), JSON.stringify(cfg));
  const requestsLog = path.join(home, 'worker-requests.log');
  fs.writeFileSync(requestsLog, '');

  const hostCalls = [];
  let hostNavCount = 0;
  let currentCredentials = { cookie: HOST_COOKIE_A, bili_jct: HOST_CSRF_A };
  const getCredentials = () => currentCredentials;
  const hostNavMid = opts.hostNavMid || (() => 9);

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    const isNav = u.pathname === '/x/web-interface/nav';
    if (isNav) hostNavCount += 1;
    hostCalls.push({ method, path: u.origin + u.pathname, search: u.search, cookie: init.headers?.cookie || '', body: init.body || '', redirect: init.redirect });
    assert.ok(OFFICIAL_HOSTS.has(u.hostname), 'official transport hit non-official host: ' + url);
    assert.equal(init.redirect, 'error', 'official transport must pin redirect:error');
    if (opts.switchCredentialsOnHostNav === hostNavCount) {
      currentCredentials = { cookie: HOST_COOKIE_B, bili_jct: HOST_CSRF_B };
    }
    let body;
    if (isNav) body = { code: 0, data: { isLogin: true, mid: hostNavMid(hostNavCount), wbi_img: { img_url: IMG, sub_url: SUB } } };
    else if (method === 'POST') body = { code: 0, message: '0', data: { rpid_str: '998877', rpid: 998877, msg_key: '112233' } };
    else body = { code: 0, data: {} };
    return { status: 200, ok: true, json: async () => structuredClone(body), text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } };
  };

  const api = createBiliV2OfficialTransport({
    getCredentials,
    getScope: () => ({ audience: action === 'dm' ? 'private' : 'public', target: { audience: 'public', kind: 'comment', type, oid, root, parent }, providerRouteId: 'fixture' }),
    fetchImpl,
    now: () => 1700000000000,
  });
  if (managed) await api.getAccount();

  const decodedList = [];
  let dispatchCount = 0;
  const dispatch = async (decoded) => {
    dispatchCount += 1;
    decodedList.push(decoded);
    if (opts.onDecoded) opts.onDecoded(decoded);
    if (opts.dispatchReject) {
      const e = new Error(opts.dispatchReject.error || 'Bili V2 Host dispatch did not complete.');
      e.code = opts.dispatchReject.code;
      e.error = opts.dispatchReject.error || 'Bili V2 Host dispatch did not complete.';
      e.hint = opts.dispatchReject.hint || 'Inspect the original action receipt before retrying.';
      e.unknown = false;
      throw e;
    }
    const result = await api.transport.send({ ...decoded.request, signal: undefined });
    if (!result || !Number.isInteger(result.http) || result.http < 200 || result.http > 599 || !Number.isSafeInteger(result.body?.code)) {
      const e = new Error('BILI_V2_RECEIPT_INVALID'); e.code = 'BILI_V2_RECEIPT_INVALID'; e.unknown = true; throw e;
    }
    if (opts.unknownAfterSend) {
      const e = new Error('BILI_V2_DISPATCH_UNKNOWN'); e.code = 'BILI_V2_DISPATCH_UNKNOWN';
      e.hint = 'Inspect the original action receipt; do not change action ID or retry.'; e.unknown = true; throw e;
    }
    const data = {};
    for (const key of ['dynamic_id', 'dynamic_id_str', 'dyn_id', 'dyn_id_str', 'rpid', 'rpid_str', 'msg_key']) {
      const v = result.body.data?.[key];
      if ((typeof v === 'string' || Number.isSafeInteger(v)) && /^\d{1,128}$/.test(String(v))) data[key] = v;
    }
    return { http: result.http, body: { code: result.body.code, message: result.body.code === 0 ? 'ok' : 'Platform rejected the request; inspect the original receipt.', data } };
  };

  const env = {
    ...process.env,
    DSH_HOME: home,
    SURFCORE_BILI_CONFIG: path.join(surfcore, 'bili.config.json'),
    SURFCORE_WORKER_TEST_REQUESTS: requestsLog,
    SURFCORE_WORKER_TEST_TO: to,
    SURFCORE_WORKER_TEST_SESSION: opts.workerSession || 'ok',
    NODE_OPTIONS: '--import ' + SHIM_PATH,
    ...(opts.env || {}),
  };
  if (managed) env.SURFCORE_BILI_V2_WORKER = '1';
  else delete env.SURFCORE_BILI_V2_WORKER;
  delete env.SURFCORE_EXPECTED_CHARACTER_ID;
  delete env.SURFCORE_EXPECTED_CHARACTER_EPOCH;

  let argv;
  if (action === 'comment') {
    argv = ['--oid', oid, '--type', type, '--referer', 'https://www.bilibili.com/opus/' + oid, '--message', text, '--root', root, '--parent', parent, '--auto', ...(opts.dry ? ['--dry'] : ['--go'])];
  } else {
    argv = ['--to', to, '--msg', text, '--auto', ...(opts.dry ? ['--dry'] : ['--go'])];
  }
  const script = path.join(COMMANDS, action === 'comment' ? 'comment.mjs' : 'dm.mjs');
  let child, detach = () => {};
  if (managed) {
    child = fork(script, argv, { execArgv: ['--import', SHIM_PATH], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env, cwd: home });
    detach = attachBiliV2Worker({ child, dispatch });
  } else {
    // V1 has NO ipc channel and NO worker env: dispatch falls through to the fake global fetch.
    child = spawn(process.execPath, [script, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: home });
  }

  let stdout = '', stderr = '', exitCode = null;
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  exitCode = await new Promise((resolve) => {
    let timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(124); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  detach();

  const shimCalls = fs.readFileSync(requestsLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  const result = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.__biliV2WriteResult).pop() || null;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  return { exitCode, stdout, stderr, decodedList, hostCalls, shimCalls, dispatchCount, result, api };
}

function diag(r) {
  return '\n--- stdout ---\n' + r.stdout + '\n--- stderr ---\n' + r.stderr + '\n--- result ---\n' + JSON.stringify(r.result) + '\n--- decoded ---\n' + JSON.stringify(r.decodedList) + '\n--- hostCalls ---\n' + JSON.stringify(r.hostCalls) + '\n--- shimCalls ---\n' + JSON.stringify(r.shimCalls);
}

let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log('PASS ' + name); }
const postCalls = (r) => r.hostCalls.filter((c) => c.method === 'POST');
const shimPosts = (r) => r.shimCalls.filter((c) => c.method === 'POST');

try {
  await test('real comment CLI reaches the frozen official transport with fixed intent and Host-only credentials', async () => {
    let decoded = null;
    const r = await runWorker({ action: 'comment', onDecoded: (d) => { decoded = d; } });
    assert.equal(r.exitCode, 0, 'comment must exit 0' + diag(r));
    assert.equal(r.dispatchCount, 1, 'exactly one dispatch' + diag(r));
    assert.ok(decoded, 'a decoded request must arrive' + diag(r));
    assert.equal(decoded.request.url, BILI_V2_ENDPOINTS.comment, 'fixed endpoint' + diag(r));
    assert.deepEqual(Object.keys(decoded.request.headers).sort(), ['content-type'], 'no worker cookie/authorization' + diag(r));
    assert.equal(decoded.payload.text, 'SYNTHETIC_TEST_MESSAGE', 'message preserved' + diag(r));
    assert.deepEqual(decoded.target, { audience: 'public', kind: 'comment', type: '1', oid: '11', root: '0', parent: '0' });
    assert.equal(postCalls(r).length, 1, 'exactly one Host POST' + diag(r));
    const post = postCalls(r)[0];
    assert.equal(post.cookie, HOST_COOKIE_A, 'Host cookie only' + diag(r));
    assert.ok(!post.cookie.includes('WORKER'), 'no worker cookie' + diag(r));
    assert.ok(new URLSearchParams(post.body).get('csrf') === HOST_CSRF_A, 'Host CSRF' + diag(r));
    assert.ok(!post.body.includes('WORKER'), 'no worker csrf' + diag(r));
    assert.equal(shimPosts(r).length, 0, 'no direct worker POST' + diag(r));
    assert.ok(r.result && r.result.ok === true, 'structured success' + diag(r));
    assert.equal(String(r.result.receipt.rpid), '998877', 'real receipt preserved' + diag(r));
    assert.equal(typeof redactContent(r.stdout), 'string', 'Bagent redactContent consumes stdout');
  });

  await test('real dm CLI reaches the frozen official transport with fixed intent and Host-only credentials', async () => {
    let decoded = null;
    const r = await runWorker({ action: 'dm', onDecoded: (d) => { decoded = d; } });
    assert.equal(r.exitCode, 0, 'dm must exit 0' + diag(r));
    assert.equal(r.dispatchCount, 1, 'exactly one dispatch' + diag(r));
    assert.equal(decoded.request.url, BILI_V2_ENDPOINTS.dm, 'fixed endpoint' + diag(r));
    assert.deepEqual(Object.keys(decoded.request.headers).sort(), ['content-type'], 'no worker credentials' + diag(r));
    assert.equal(decoded.payload.text, 'SYNTHETIC_TEST_MESSAGE', 'message preserved' + diag(r));
    assert.deepEqual(decoded.target, { audience: 'private', kind: 'dm', mid: '22000' });
    assert.equal(postCalls(r).length, 1, 'one Host POST' + diag(r));
    assert.equal(postCalls(r)[0].cookie, HOST_COOKIE_A, 'Host cookie only' + diag(r));
    assert.equal(shimPosts(r).length, 0, 'no direct worker POST' + diag(r));
    assert.ok(r.result && r.result.ok === true, 'structured success' + diag(r));
  });

  await test('interact disabled rejects both CLIs before any POST', async () => {
    for (const action of ['comment', 'dm']) {
      const r = await runWorker({ action, configOverrides: { interact: { enabled: false } } });
      assert.notEqual(r.exitCode, 0, action + ' must reject' + diag(r));
      assert.equal(postCalls(r).length, 0, action + ' no POST' + diag(r));
      assert.equal(r.dispatchCount, 0, action + ' no dispatch' + diag(r));
    }
  });

  await test('dm existing inbound-session gate rejects before any POST', async () => {
    for (const session of ['empty', 'last-mine']) {
      const r = await runWorker({ action: 'dm', workerSession: session });
      assert.notEqual(r.exitCode, 0, 'dm gate must reject (' + session + ')' + diag(r));
      assert.equal(postCalls(r).length, 0, 'no POST' + diag(r));
      assert.equal(r.dispatchCount, 0, 'no dispatch' + diag(r));
    }
  });

  await test('a Host role/epoch rejection is surfaced with code/error/hint and never becomes success', async () => {
    const r = await runWorker({ action: 'comment', dispatchReject: { code: 'STALE_CHARACTER', error: 'Bili V2 Host dispatch did not complete.', hint: '角色 epoch 已变化，重新捕获来源后再试。' } });
    assert.notEqual(r.exitCode, 0, 'must reject' + diag(r));
    assert.equal(postCalls(r).length, 0, 'no POST before Host rejection' + diag(r));
    assert.ok(r.result && r.result.ok === false, 'structured failure' + diag(r));
    assert.equal(r.result.code, 'STALE_CHARACTER', 'code preserved' + diag(r));
    assert.ok(r.result.error && r.result.hint, 'error/hint not swallowed' + diag(r));
  });

  await test('official account mismatch is refused before any POST', async () => {
    const r = await runWorker({ action: 'comment', hostNavMid: (n) => n === 1 ? 9 : 10 });
    assert.notEqual(r.exitCode, 0, 'must reject' + diag(r));
    assert.equal(postCalls(r).length, 0, 'no POST' + diag(r));
    assert.ok(r.result && r.result.ok === false, 'structured failure' + diag(r));
    assert.equal(r.result.code, 'BILI_OFFICIAL_ACCOUNT_CHANGED', 'real factory code' + diag(r));
    assert.ok(r.result.error && r.result.hint, 'error/hint preserved' + diag(r));
  });

  await test('official credential switch during send is refused before any POST', async () => {
    const r = await runWorker({ action: 'dm', switchCredentialsOnHostNav: 2 });
    assert.notEqual(r.exitCode, 0, 'must reject' + diag(r));
    assert.equal(postCalls(r).length, 0, 'no POST' + diag(r));
    assert.ok(r.result && r.result.ok === false, 'structured failure' + diag(r));
    assert.equal(r.result.code, 'BILI_OFFICIAL_CREDENTIALS_CHANGED', 'real factory code' + diag(r));
    assert.ok(r.result.error && r.result.hint, 'error/hint preserved' + diag(r));
  });

  await test('unknown after the POST is not reported as success and is not resent', async () => {
    const r = await runWorker({ action: 'comment', unknownAfterSend: true });
    assert.notEqual(r.exitCode, 0, 'must not be success' + diag(r));
    assert.equal(postCalls(r).length, 1, 'exactly one POST' + diag(r));
    assert.equal(r.dispatchCount, 1, 'no resend' + diag(r));
    assert.ok(r.result && r.result.ok === false, 'structured failure' + diag(r));
    assert.equal(r.result.code, 'BILI_V2_DISPATCH_UNKNOWN', 'unknown code' + diag(r));
    assert.ok(r.result.error && r.result.hint, 'error/hint preserved' + diag(r));
  });

  await test('V1 (no worker env) keeps the WBI-signed URL and worker cookie via fake fetch', async () => {
    const r = await runWorker({ action: 'comment', managed: false, dry: false });
    assert.equal(r.exitCode, 0, 'V1 send must exit 0' + diag(r));
    assert.equal(postCalls(r).length, 0, 'official transport unused in V1' + diag(r));
    const signed = r.shimCalls.filter((c) => c.method === 'POST' && c.path === 'https://api.bilibili.com/x/v2/reply/add');
    assert.ok(signed.length >= 1, 'V1 direct POST preserved' + diag(r));
    assert.ok(signed.some((c) => c.search.includes('w_rid=') && c.search.includes('wts=')), 'V1 WBI signature preserved' + diag(r));
    assert.ok(signed.some((c) => c.cookie.includes('WORKER')), 'V1 worker cookie preserved' + diag(r));
  });

  await test('V1 dm (no worker env) keeps the worker cookie and worker csrf via fake fetch', async () => {
    const r = await runWorker({ action: 'dm', managed: false, dry: false });
    assert.equal(r.exitCode, 0, 'V1 dm send must exit 0' + diag(r));
    assert.equal(postCalls(r).length, 0, 'official transport unused in V1' + diag(r));
    const posts = r.shimCalls.filter((c) => c.method === 'POST' && c.path === 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg');
    assert.ok(posts.length >= 1, 'V1 dm direct POST preserved' + diag(r));
    assert.ok(posts.some((c) => c.cookie.includes('WORKER')), 'V1 dm worker cookie preserved' + diag(r));
    assert.equal(shimPosts(r).length, posts.length, 'no other direct POST' + diag(r));
  });

  console.log(`PASS actual Bili write workers: ${count} ordinary cases`);
} catch (error) {
  console.error('FAIL ' + error.message);
  process.exit(1);
} finally {
  try { fs.rmSync(SHIM_PATH, { force: true }); } catch {}
}
