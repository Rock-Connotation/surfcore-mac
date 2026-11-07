import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore 自测 '));
const root = path.join(temp, '中文 空格');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'bridge.js'), '');
const file = path.join(root, 'config.json');
const secret = 'fixture-private-value';
fs.writeFileSync(file, JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:4555', authToken: secret, authHeader: 'x-token', authPrefix: 'Bearer', allowRemote: true } }));
process.env.SURFCORE_ROOT = root;
process.env.DSH_HOME = path.join(temp, 'isolated-dsh');
const { QQ_CONFIG } = await import('../plugins/surfcore/lib/paths.js');
const { loadSelfTestClient, resolveSelfTestTarget } = await import('../src/self-test-target.js');
assert.equal(QQ_CONFIG, file);
let calls = 0;
const discover = async () => { calls++; return 'http://127.0.0.1:6789'; };
const cli = await resolveSelfTestTarget({ cliUrl: 'http://localhost:5555/', env: { DSH_WEB_URL: 'http://localhost:6666' }, discover });
assert.equal(cli.baseUrl, 'http://localhost:5555');
assert.equal(cli.auth.token, secret);
assert.equal(cli.auth.header, 'x-token');
assert.equal(cli.auth.prefix, 'Bearer');
assert.equal(cli.auth.allowRemote, true);
assert.equal(cli.auth.tokenExplicit, true);
assert.equal(calls, 0);
const env = await resolveSelfTestTarget({ env: { DSH_WEB_URL: 'http://localhost:6666' }, discover });
assert.equal(env.baseUrl, 'http://localhost:6666');
assert.equal(calls, 0);
assert.equal((await resolveSelfTestTarget({ env: {}, discover })).baseUrl, 'http://127.0.0.1:6789');
assert.equal((await resolveSelfTestTarget({ env: {}, discover: async () => null })).baseUrl, 'http://127.0.0.1:4555');
assert.equal((await resolveSelfTestTarget({ env: {}, discover: async () => { throw new Error('fixture'); } })).baseUrl, 'http://127.0.0.1:4555');
for (const options of [
  { cliUrl: 'bad', env: {}, discover },
  { env: { DSH_WEB_URL: 'http://u:password@localhost:1234' }, discover },
  { env: {}, configPath: path.join(temp, 'absent.json'), discover: async () => null },
]) {
  await assert.rejects(resolveSelfTestTarget(options), (error) => error.code === 'SELF_TEST_TARGET_INVALID' && Boolean(error.message) && Boolean(error.hint) && !error.message.includes(secret));
}
const remoteFile = path.join(temp, 'remote.json');
fs.writeFileSync(remoteFile, JSON.stringify({ dsh: { baseUrl: 'https://dsh.fixture.invalid', allowRemote: true } }));
const priorCalls = calls;
assert.equal((await resolveSelfTestTarget({ env: {}, configPath: remoteFile, discover })).baseUrl, 'https://dsh.fixture.invalid');
assert.equal(calls, priorCalls, 'local discovery must not replace an explicit remote configuration');
const malformed = path.join(temp, 'bad.json');
fs.writeFileSync(malformed, '{');
await assert.rejects(resolveSelfTestTarget({ cliUrl: 'http://localhost:1234', configPath: malformed }), (error) => error.code === 'SELF_TEST_CONFIG_INVALID' && Boolean(error.hint));
await assert.rejects(loadSelfTestClient(async () => { throw new Error('synthetic missing dependency'); }), (error) => error.code === 'SELF_TEST_DEPENDENCY_MISSING' && Boolean(error.message) && Boolean(error.hint));
const childEnv = { ...process.env, SURFCORE_QQBOT_ROOT: root, DSH_HOME: path.join(temp, 'isolated-dsh') };
delete childEnv.SURFCORE_ROOT;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { QQ_CONFIG } from './plugins/surfcore/lib/paths.js'; import { resolveSelfTestTarget } from './src/self-test-target.js'; const result = await resolveSelfTestTarget({env:{},discover:async()=>null}); if (QQ_CONFIG !== process.env.EXPECTED_CONFIG || result.baseUrl !== 'http://127.0.0.1:4555') process.exit(1);`], {
  cwd: path.resolve(import.meta.dirname, '..'), env: { ...childEnv, EXPECTED_CONFIG: file }, encoding: 'utf8',
});
assert.equal(child.status, 0, 'SURFCORE_QQBOT_ROOT must select the shared config');
assert.equal(child.stdout, '', 'credentials must not be printed');
assert.ok(!child.stderr.includes(secret));
console.log('PASS self-test target resolution and actionable failures');
