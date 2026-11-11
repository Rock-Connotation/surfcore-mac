import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BILI_V2_ENDPOINTS, attachBiliV2Worker } from '../tools/lib/bili-v2-dispatch.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-managed-worker-'));
const home = path.join(dir, 'dsh'), surf = path.join(home, 'surfcore');
fs.mkdirSync(path.join(surf, 'bili'), { recursive: true });
fs.writeFileSync(path.join(surf, 'bili', 'credentials.json'), JSON.stringify({ sessdata: 'SYNTHETIC_WORKER_COOKIE', bili_jct: 'SYNTHETIC_WORKER_CSRF', buvid3: 'SYNTHETIC_WORKER_DEVICE' }));
const config = path.join(surf, 'bili.config.json');
fs.writeFileSync(config, JSON.stringify({ interact: { enabled: true } }));
const navLog = path.join(dir, 'requests.jsonl');
const shim = path.join(dir, 'official-fixture.mjs');
fs.writeFileSync(shim, `import fs from 'node:fs';
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(process.env.SURFCORE_WORKER_TEST_REQUESTS, JSON.stringify({url:String(url),method:init.method||'GET'})+'\\n');
  if (String(url)!=='https://api.bilibili.com/x/web-interface/nav'||init.method==='POST') throw Error('UNEXPECTED_WORKER_NETWORK');
  return {json:async()=>({code:0,data:{mid:9,isLogin:true,wbi_img:{img_url:'https://example.invalid/abcdefghijklmnopqrstuvwxyz.png',sub_url:'https://example.invalid/abcdefghijklmnopqrstuvwxyz.png'}}})};
};
`);
const script = fileURLToPath(new URL('../tools/commands/dynamic.mjs', import.meta.url));
const requests = [];
async function run(actionId, expectedMid = '9', text = 'SYNTHETIC_MANAGED_DYNAMIC') {
  const env = { ...process.env, DSH_HOME: home, SURFCORE_BILI_CONFIG: config, SURFCORE_BILI_V2_WORKER: '1', SURFCORE_WORKER_TEST_REQUESTS: navLog };
  delete env.SURFCORE_EXPECTED_CHARACTER_ID; delete env.SURFCORE_EXPECTED_CHARACTER_EPOCH;
  const child = fork(script, ['post', '--text', text, '--json', '--go', '--auto', '--action-id', actionId, '--expected-mid', expectedMid], {
    execPath: process.execPath, execArgv: ['--import', shim], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  });
  // No current character is configured in this isolated legacy-shaped CLI fixture.
  const off = attachBiliV2Worker({ child, dispatch: async decoded => {
    requests.push(decoded);
    assert.equal(decoded.request.url, BILI_V2_ENDPOINTS.dynamic);
    assert.deepEqual(decoded.request.headers, { 'content-type': 'application/json' });
    assert.equal(decoded.payload.body.content.contents[0].raw_text, text);
    assert.ok(!JSON.stringify(decoded).includes('SYNTHETIC_WORKER_COOKIE'));
    return { http: 200, body: { code: 0, data: { dyn_id_str: '1234567890123456789' } } };
  } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }),
      new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(Error('managed worker timeout')); }, 10000); }),
    ]);
    return { code, result: JSON.parse(stdout), stderr };
  } finally { clearTimeout(timer); off(); }
}
const first = await run('fixture-dynamic');
assert.equal(first.code, 0, JSON.stringify(first));
assert.equal(first.result.ok, true);
assert.equal(requests.length, 1);
const replay = await run('fixture-dynamic');
assert.equal(replay.result.replayed, true);
assert.equal(requests.length, 1, 'same action ID never dispatches twice');
const mismatch = await run('fixture-wrong-account', '10');
assert.equal(mismatch.result.code, 'BILI_DYNAMIC_IDENTITY_CHANGED');
assert.ok(mismatch.result.error && mismatch.result.hint);
assert.equal(requests.length, 1);
fs.writeFileSync(config, JSON.stringify({ interact: { enabled: false } }));
const disabled = await run('fixture-disabled');
assert.equal(disabled.result.code, 'BILI_INTERACT_DISABLED');
assert.ok(disabled.result.error && disabled.result.hint);
assert.equal(requests.length, 1);
const network = fs.readFileSync(navLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
assert.ok(network.every(row => row.method === 'GET' && row.url.endsWith('/nav')));
assert.equal(network.length, 3, 'managed path performs identity checks without fetching worker WBI material');
console.log('PASS actual managed dynamic worker: fixed intent, Host-only credentials/signature, stable receipt, account and interaction guards; synthetic official transport only');
console.log('Evidence:', dir);
