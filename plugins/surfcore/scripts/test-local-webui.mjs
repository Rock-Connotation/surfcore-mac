import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openLocalUrl } from '../lib/local-webui.js';

const url = 'http://127.0.0.1:5100';
const calls = [];
const fake = (error = null) => (command, args, options, callback) => {
  calls.push({ command, args, options });
  queueMicrotask(() => callback(error, '', ''));
};
for (const invalid of ['http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:5100/a', 'http://127.0.0.1:5100?token=x', 'http://name@127.0.0.1:5100', 'http://localhost:5100', 'https://127.0.0.1:5100', 'http://127.0.0.1:5100\n']) {
  const before = calls.length;
  const result = await openLocalUrl(invalid, { platform: 'darwin', run: fake() });
  assert.equal(result.ok, false); assert.equal(result.opened, false);
  assert.ok(result.code && result.error && result.hint);
  assert.equal(calls.length, before, 'bad URL must never spawn');
}
let result = await openLocalUrl(url, { platform: 'darwin', run: fake() });
assert.equal(result.ok, true); assert.equal(result.opened, true);
assert.equal(calls.at(-1).command, '/usr/bin/open'); assert.deepEqual(calls.at(-1).args, [url]);
result = await openLocalUrl(url, { platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe', run: fake() });
assert.equal(result.ok, true); assert.equal(calls.at(-1).command, 'C:\\Windows\\System32\\cmd.exe');
assert.deepEqual(calls.at(-1).args, ['/d', '/c', 'start', '""', `"${url}"`]);
assert.equal(calls.at(-1).options.windowsVerbatimArguments, true);
result = await openLocalUrl(url, { platform: 'linux', run: fake() });
assert.equal(result.ok, true); assert.equal(calls.at(-1).command, 'xdg-open'); assert.deepEqual(calls.at(-1).args, [url]);
for (const error of [Object.assign(new Error('ENOENT secret'), { code: 'ENOENT' }), Object.assign(new Error('exit secret'), { code: 1 })]) {
  result = await openLocalUrl(url, { platform: 'darwin', run: fake(error) });
  assert.equal(result.ok, false); assert.equal(result.opened, false);
  assert.ok(result.code && result.error && result.hint);
  assert.ok(result.error.includes(url) && result.hint.includes(url));
  assert.ok(!JSON.stringify(result).includes('secret'));
}
result = await openLocalUrl(url, { platform: 'darwin', run: () => { throw Error('private'); } });
assert.equal(result.ok, false); assert.ok(result.error && result.code && result.hint);
const before = calls.length;
result = await openLocalUrl(url, { platform: 'freebsd', run: fake() });
assert.equal(result.ok, false); assert.equal(calls.length, before); assert.ok(result.error.includes(url));
const index = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
assert.equal((index.match(/await openLocalUrl\(webui\.url\)/g) || []).length, 2, 'both callers await actual outcome');
assert.ok(index.includes('...openResult') && index.includes('opened: openResult.opened'), 'failure reaches API');
const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.ok(client.includes('toast(res.ok ? `✓ ${res.message ?? "完成"}` : `✗ ${res.error ?? "失败"}`)'), 'direct action displays API error and manual URL');
console.log('PASS local WebUI: loopback-only, platform commands, async errors and caller wiring');
