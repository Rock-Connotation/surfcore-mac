/**
 * V1 退役三轮复审 P2/F01 辅项的常驻合同测试：模式保存回执必须诚实。
 *
 * 事实：模式先落盘，再向桥接确认。桥接没在跑（连接失败）**不等于**模式非法。
 * 旧实现把离线连接失败解释成 409 / QQ_MODE_INVALID，于是一个已经合法保存的请求
 * 对调用方显示成"非法、被拒"——这正是"失败可见"不能变成"失败可以撒谎"。
 *
 * 断言：①离线时 200 + applied:false + QQ_MODE_SAVED_PENDING_BRIDGE（不得 409/QQ_MODE_INVALID）
 *      ②带空格的合法模式按与桥接相同的 trim 语义归一，并原样落盘
 *      ③退役值仍是 409/QQ_MODE_RETIRED，非法值仍是 400/QQ_MODE_INVALID
 *      ④在线桥接确认后 200/applied:true、模式落盘、桥接恰好调用一次
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-mode-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-mode-dsh-'));
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'roles'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture bridge placeholder\n');
fs.writeFileSync(path.join(tempRoot, 'roles', '角色.md'), '# 角色卡\n\n测试用。\n');
// consolePort 指向一个必然没人监听的端口：本测试要的就是"桥接没在跑"。
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: [] },
  consolePort: 59999,
}, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect() { return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};
apply(ctx);

function fakeRes() {
  return {
    statusCode: 200,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(method, p, body) {
  const route = routes.find((r) => r.path === '/dsh-surfcore/api');
  const res = fakeRes();
  await route.handler(fakeReq(method, `/dsh-surfcore/api${p}`, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

function findModeFile() {
  return [
    path.join(tempRoot, 'state', 'mode.json'),
    path.join(tempDsh, 'surfcore', 'state', 'mode.json'),
  ].find((file) => fs.existsSync(file));
}

try {
  // ① 合法模式 + 桥接未运行：已保存待应用，不得假报"非法/被拒"。
  const saved = await invoke('POST', '/mode', { mode: ' simulation ' });
  assert.equal(saved.status, 200, `桥接未运行不得返回非 200（实际 ${saved.status} / ${saved.data.code ?? ''}）`);
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.applied, false);
  assert.equal(saved.data.code, 'QQ_MODE_SAVED_PENDING_BRIDGE');
  assert.ok(saved.data.hint && saved.data.hint.length > 5, 'hint 必须给出下一步');
  assert.equal(saved.data.mode, 'simulation', '带空格的合法模式必须按桥接侧同样的 trim 语义归一');

  // ② 模式确实落盘（先落盘、后确认的语义不能被这次修复改掉）。
  const modeFile = findModeFile();
  assert.ok(modeFile, 'mode.json 必须已写入');
  assert.equal(JSON.parse(fs.readFileSync(modeFile, 'utf8')).mode, 'simulation');

  // ③ 退役值与非法值仍然 fail-closed。
  const retired = await invoke('POST', '/mode', { mode: 'reserved' });
  assert.equal(retired.status, 409);
  assert.equal(retired.data.code, 'QQ_MODE_RETIRED');
  assert.ok(retired.data.hint && retired.data.hint.length > 5);

  // ④ 在线桥接确认：必须 applied:true、落盘、且只调用桥接一次。
  const modeCalls = [];
  const bridgeServer = http.createServer((req, res) => {
    let payload = '';
    req.on('data', (chunk) => { payload += chunk; });
    req.on('end', () => {
      modeCalls.push({ method: req.method, url: req.url, body: payload ? JSON.parse(payload) : null });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => bridgeServer.listen(0, '127.0.0.1', resolve));
  const configPath = path.join(tempRoot, 'config.json');
  const offlineConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...offlineConfig, consolePort: bridgeServer.address().port }, null, 2));
  let applied;
  try {
    applied = await invoke('POST', '/mode', { mode: 'chat' });
  } finally {
    fs.writeFileSync(configPath, JSON.stringify(offlineConfig, null, 2));
    await new Promise((resolve) => bridgeServer.close(resolve));
  }
  assert.equal(applied.status, 200);
  assert.equal(applied.data.ok, true);
  assert.equal(applied.data.applied, true, '在线桥接确认后必须 applied:true');
  assert.notEqual(applied.data.code, 'QQ_MODE_SAVED_PENDING_BRIDGE');
  assert.equal(JSON.parse(fs.readFileSync(findModeFile(), 'utf8')).mode, 'chat');
  assert.equal(modeCalls.length, 1, '桥接必须恰好被调用一次');
  assert.equal(modeCalls[0].method, 'POST');
  assert.equal(modeCalls[0].url, '/api/mode');
  assert.deepEqual(modeCalls[0].body, { mode: 'chat' });

  const bogus = await invoke('POST', '/mode', { mode: 'bogus' });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.data.code, 'QQ_MODE_INVALID');
  assert.ok(bogus.data.hint && bogus.data.hint.length > 5);

  console.log('PASS QQ mode save stays honest offline and online (saved-pending / applied-once)');
  process.exit(0);
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`);
  process.exit(1);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempDsh, { recursive: true, force: true });
}