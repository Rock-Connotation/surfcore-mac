import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const qr = fs.readFileSync(new URL('../lib/bili-qr-login.mjs', import.meta.url), 'utf8');
const section = (source, start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
};
const pollSource = section(qr, 'export async function pollQrLogin(', 'export function cancelQrLogin(').replace('export ', '');
for (const mode of ['waiting', 'blocked', 'allowed', 'owner']) {
  const effects = [], session = { target: mode === 'owner' ? 'owner' : 'fish', expiresAt: Date.now() + 60000,
    cdp: { evaluate: async () => '', send: async () => ({ cookies: mode === 'waiting' ? [] : [{ domain: '.bilibili.com', name: 'SESSDATA', value: 'synthetic' }, { domain: '.bilibili.com', name: 'bili_jct', value: 'synthetic' }] }) } };
  const sandbox = { sessions: new Map([['login', session]]), cleanupSession: () => effects.push('cleanup'),
    navAccount: async () => ({ mid: '9' }), readBiliConfig: () => ({ config: {} }), validateQrAccount: () => ({ ok: true }),
    writeFishCredentials: () => { effects.push('fish-save'); return { mid: '9' }; },
    writeOwnerCredentials: () => { effects.push('owner-save'); return { mid: '10' }; } };
  const poll = vm.runInNewContext('(' + pollSource + ')', sandbox);
  const result = await poll('login', { withCredentialTransition: async operation => {
    effects.push('retire');
    if (mode === 'blocked') throw Object.assign(new Error('Retirement pending'), { code: 'BILI_V2_RETIRE_UNCONFIRMED', hint: 'Inspect original retirement.' });
    return operation();
  } });
  if (mode === 'waiting') assert.deepEqual(effects, []);
  else if (mode === 'blocked') { assert.deepEqual(effects, ['retire', 'cleanup']); assert.equal(result.ok, false); assert.equal(result.code, 'BILI_V2_RETIRE_UNCONFIRMED'); assert.ok(result.hint); }
  else if (mode === 'allowed') assert.deepEqual(effects, ['retire', 'fish-save', 'cleanup']);
  else assert.deepEqual(effects, ['owner-save', 'cleanup']);
  console.log('PASS actual QR polling: ' + mode + ' credential save boundary');
}
const handleSource = section(index, '  async function handleBili(', '  // ── 日志');
for (const action of ['cookie', 'account/reset']) {
  let transitions = 0, writes = 0;
  const sandbox = { biliRoundController: { handle: async () => false }, API_PREFIX: '/dsh-surfcore/api', readBody: async () => JSON.stringify({ action, sessdata: 'synthetic', bili_jct: 'synthetic', target: 'fish' }),
    json: () => {}, fs: new Proxy({}, { get: () => () => { writes++; } }), path: { dirname: () => '/fixture' },
    BILI_CRED: '/fixture/credentials.json', BACKUP_DIR: '/fixture/backup',
    biliMemoryHost: { withTransition: async () => { transitions++; throw Object.assign(new Error('Pending retirement'), { code: 'BILI_V2_RETIRE_UNCONFIRMED' }); } } };
  const handle = vm.runInNewContext('(' + handleSource + ')', sandbox);
  await assert.rejects(handle({ method: 'POST' }, {}, new URL('http://127.0.0.1/dsh-surfcore/api/bili/' + action)), error => error.code === 'BILI_V2_RETIRE_UNCONFIRMED');
  assert.equal(transitions, 1); assert.equal(writes, 0);
  console.log('PASS actual index ' + action + ': unconfirmed retirement prevents every credential write');
}
for (const mode of ['archive-failed', 'config-failed', 'success']) {
  const files = new Map([['/fixture/credentials.json', 'synthetic credentials'], ['/fixture/align.json', 'synthetic alignment']]);
  const response = {}, sandbox = { biliRoundController: { handle: async () => false }, API_PREFIX: '/dsh-surfcore/api',
    readBody: async () => JSON.stringify({ target: 'fish' }), json: (res, status, body) => { res.status = status; res.body = body; },
    biliMemoryHost: { withTransition: async operation => operation() }, BILI_CRED: '/fixture/credentials.json', ALIGN_FILE: '/fixture/align.json', BACKUP_DIR: '/fixture/backup', BILI_DIR: '/fixture',
    pluginLog: () => {}, randomUUID: () => 'isolated', maskPath: value => value, path: { join: (...args) => args.join('/'), extname: () => '.json' },
    readBiliConfig: () => ({ config: { self: { mid: '9' } } }), saveBiliConfig: () => { if (mode === 'config-failed') throw new Error('Synthetic write failure'); },
    fs: { existsSync: file => files.has(file), mkdirSync: () => {}, constants: { COPYFILE_EXCL: 1 },
      copyFileSync: (from, to) => files.set(to, files.get(from)),
      renameSync: (from, to) => { if (mode === 'archive-failed') throw new Error('Synthetic archive failure'); files.set(to, files.get(from)); files.delete(from); },
      rmSync: () => assert.fail('Account reset must preserve an archive, never discard credentials') } };
  const handle = vm.runInNewContext('(' + handleSource + ')', sandbox);
  const call = handle({ method: 'POST' }, response, new URL('http://127.0.0.1/dsh-surfcore/api/bili/account/reset'));
  if (mode !== 'success') await assert.rejects(call, error => error.code === (mode === 'archive-failed' ? 'BILI_V2_ACCOUNT_ARCHIVE_FAILED' : 'BILI_V2_ACCOUNT_RESET_FAILED') && Boolean(error.hint));
  else { await call; assert.equal(response.body.ok, true); assert.equal(response.body.archived.length, 2); }
  assert.ok([...files.values()].includes('synthetic credentials'));
  assert.equal(files.has('/fixture/credentials.json'), mode === 'archive-failed');
  console.log('PASS actual account reset: ' + mode + ', original credential bytes remain recoverable');
}
const routeSource = section(index, '  function route(kind, pathname, handler)', '  // ── 概览');
const registered = [], failures = [];
const route = vm.runInNewContext('(' + routeSource + ')', { disposers: [], ctx: { webServer: { register: item => { registered.push(item); } }, get: () => null },
  isLoopbackReq: () => true, sameOrigin: () => true, pluginLog: () => {}, reportMemoryBlocked: issue => failures.push(issue),
  json: (res, status, body) => { res.status = status; res.body = body; } });
route('prefix', '/fixture', async () => { throw Object.assign(new Error('Retirement pending'), { code: 'BILI_V2_RETIRE_UNCONFIRMED', hint: 'Inspect original retirement.' }); });
const response = {};
await registered[0].handler({ method: 'POST', headers: { 'content-type': 'application/json' } }, response);
assert.equal(response.status, 500); assert.equal(response.body.code, 'BILI_V2_RETIRE_UNCONFIRMED'); assert.ok(response.body.error && response.body.hint); assert.equal(failures.length, 1);
console.log('PASS actual API wrapper preserves actionable lifecycle code/hint and existing gate event');
