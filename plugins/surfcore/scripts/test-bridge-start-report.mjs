// Execute the actual Host route branch; no App, profile or child process is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const begin = source.indexOf("    if (action === 'start-qq') {");
const end = source.indexOf("    if (action === 'start-bili') {", begin);
assert.ok(begin > 0 && end > begin);
const branch = source.slice(begin, end);
for (const failure of [
  { ok: false, code: 'BRIDGE_OWNER_UNVERIFIED', error: '无法确认进程归属', hint: '检查锁文件与桥接日志。' },
  { ok: false, error: '旧版本启动失败' },
]) {
  let response;
  const route = vm.runInNewContext(`(async () => { ${branch} })`, {
    action: 'start-qq', req: {}, res: {},
    platformStartEnabled: () => true,
    currentDshUrl: () => 'http://127.0.0.1:12345',
    startBridge: async () => failure,
    launchSnowLuma: async () => ({ ok: true, skipped: true }),
    json: (_res, status, body) => { response = { status, body }; },
  });
  await route();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, failure.error);
  assert.ok(response.body.code && response.body.hint);
  if (failure.hint) assert.equal(response.body.hint, failure.hint);
}
console.log('bridge start route preserves actionable failures: PASS');
