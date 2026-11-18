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
// 外部 OneBot/Docker NapCat 在线 + allowLaunch=false 时，launchSnowLuma 不能误报未开启 allowLaunch；
// B站受控单轮模式（controlled-only 且已登录）在一键启动中应视为就绪而不是报错未登录。
{
  const fnStart = source.indexOf('  function snowLumaOneBotPorts(');
  const fnEnd = source.indexOf('\n  // ── 启动完成弹窗', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  const portsHost = vm.runInNewContext(
    `(async () => {\n${source.slice(fnStart, fnEnd)}\nreturn { launchSnowLuma, snowLumaOneBotPorts };\n})()`,
    {
      URL,
      process: { env: {} },
      readQqConfig: () => ({ config: { snowluma: { allowLaunch: false, httpUrl: 'http://127.0.0.1:37600', wsUrl: 'ws://127.0.0.1:37601' } } }),
      portOpen: async (p) => p === 37600,
      fs: { existsSync: () => false, readFileSync: () => '' },
      path: { join: (...a) => a.join('/') },
    },
  );
  const { launchSnowLuma, snowLumaOneBotPorts } = await portsHost;
  assert.deepEqual([...snowLumaOneBotPorts()], [37600, 37601]);
  const onlineByBridge = await launchSnowLuma({ bridge: { snowluma: { connected: true, accountOnline: true } } });
  assert.equal(onlineByBridge.ok, true);
  assert.equal(onlineByBridge.already, true);
  const onlineByPort = await launchSnowLuma();
  assert.equal(onlineByPort.ok, true);
  assert.equal(onlineByPort.already, true);

  const biliFnStart = source.indexOf('  function biliLaunchOutcome(');
  const biliFnEnd = source.indexOf('\n  async function startComponent(', biliFnStart);
  assert.ok(biliFnStart > 0 && biliFnEnd > biliFnStart);
  const biliLaunchOutcome = vm.runInNewContext(`${source.slice(biliFnStart, biliFnEnd)}\nbiliLaunchOutcome`, {
    fs: { existsSync: () => true },
    BILI_CRED: '/fixture/cred.json',
  });
  const controlled = biliLaunchOutcome({ running: false, reason: 'controlled-only' });
  assert.equal(controlled.ok, true, 'controlled-only 且已登录不应判为启动失败');
  assert.match(controlled.message, /受控单轮模式/);
}

console.log('bridge start route preserves actionable failures: PASS');
