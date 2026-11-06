/**
 * 主人 B站 账号扫码登录（只读偏好抓取用）。
 *
 * 为什么用本机 Edge/Chrome 而不是自己画二维码：
 *   仓库里没有 QR 生成库；而 B站 登录页本身会把二维码画成一张 data:image/png。
 *   用本机已有的 Edge/Chrome headless 打开官方登录页 → 取出二维码图片 → 轮询 cookie，
 *   不用把登录 URL 发给第三方二维码服务，也不用手工粘贴 cookie。
 *
 * 边界（写死）：
 *   · 只打开 B站 官方登录页；不填账号密码、不模拟点击登录按钮；
 *   · 登录成功后只把 cookie 存到 `owner-credentials.json`，**只给偏好抓取用**；
 *   · 不写日志、不回显 SESSDATA；`readOwnerAccount()` 只返回 mid/昵称/时间；
 *   · 校验扫码的 mid 是否等于配置里的 owner.mid；不一致就拒绝保存（防串号）。
 *
 * 依赖：本机可执行的 Microsoft Edge 或 Google Chrome；扫码只使用私有临时 profile。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { BILI_CRED, OWNER_BILI_CRED } from './paths.js';
import { readBiliConfig, saveBiliConfig } from './store.js';

const LOGIN_URL = 'https://passport.bilibili.com/login';
const SESSION_TTL_MS = 170_000;      // B站 二维码大约 180 秒过期，留 10 秒余量
const START_WAIT_MS = 20_000;        // 等浏览器/CDP 起来
const QR_WAIT_MS = 18_000;           // 等登录页画出二维码
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessions = new Map();

function browserCandidates({ env, platform, home }) {
  if (String(env.SURFCORE_EDGE ?? '').trim()) {
    return [{ path: String(env.SURFCORE_EDGE).trim(), name: 'configured browser', source: 'SURFCORE_EDGE', explicit: true }];
  }
  if (platform === 'darwin') {
    return [
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge', 'system-applications'],
      [path.join(home, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), 'Microsoft Edge', 'user-applications'],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome', 'system-applications'],
      [path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), 'Google Chrome', 'user-applications'],
    ].map(([file, name, source]) => ({ path: file, name, source }));
  }
  if (platform === 'win32') {
    return [
      [path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge', 'system-install'],
      [path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge', 'system-install'],
      [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '', 'Microsoft Edge', 'user-install'],
      [path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome', 'system-install'],
      [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '', 'Google Chrome', 'user-install'],
    ].filter(([file]) => file).map(([file, name, source]) => ({ path: file, name, source }));
  }
  return [
    ['/usr/bin/microsoft-edge', 'Microsoft Edge', 'system-install'],
    ['/usr/bin/google-chrome', 'Google Chrome', 'system-install'],
    ['/usr/bin/chromium', 'Chromium', 'system-install'],
    ['/usr/bin/chromium-browser', 'Chromium', 'system-install'],
  ].map(([file, name, source]) => ({ path: file, name, source }));
}

function checkBrowser(candidate, { platform, fsApi = fs, probe = probeBrowser }) {
  const file = path.resolve(candidate.path);
  try {
    const stat = fsApi.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: '不是普通文件' };
    if (platform !== 'win32') fsApi.accessSync(file, fs.constants.X_OK);
  } catch (error) {
    return { ok: false, reason: error?.code === 'EACCES' ? '没有执行权限' : '文件不存在或不可执行' };
  }
  const result = probe(file, { platform });
  return result?.ok ? { ...candidate, executable: file, version: result.version } : { ok: false, reason: result?.reason || '启动版本探测失败' };
}

function probeBrowser(executable, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(executable, ['--version'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true,
  });
  if (result?.error) return { ok: false, reason: result.error.message };
  if (result?.status !== 0) return { ok: false, reason: `版本探测退出码 ${result?.status ?? '未知'}` };
  return { ok: true, version: String(result.stdout || result.stderr || '').trim().slice(0, 160) };
}

export function findBrowser({
  env = process.env,
  platform = process.platform,
  home = env.HOME || env.USERPROFILE || os.homedir(),
  fsApi = fs,
  probe = probeBrowser,
} = {}) {
  const candidates = browserCandidates({ env, platform, home });
  for (const candidate of candidates) {
    const checked = checkBrowser(candidate, { platform, fsApi, probe });
    if (checked.executable) return checked;
    if (candidate.explicit) {
      const error = new Error(`SURFCORE_EDGE 指定的浏览器不可用：${candidate.path}（${checked.reason}）`);
      error.code = 'BROWSER_OVERRIDE_INVALID';
      error.hint = '确认 SURFCORE_EDGE 指向已安装且可执行的 Edge 或 Chrome 应用内程序，再重试扫码。';
      throw error;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(`浏览器调试端口没响应（${Math.round(timeoutMs / 1000)} 秒）`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message?.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('浏览器调试连接已关闭'));
      this.pending.clear();
    });
  }

  static connect(url) {
    if (typeof WebSocket !== 'function') return Promise.reject(new Error('当前运行时没有 WebSocket，无法驱动浏览器'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('连接浏览器调试端口超时')); }, 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器调试端口失败')); }, { once: true });
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('浏览器调试连接不可用'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 15_000).unref?.();
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result?.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

export function terminateQrBrowser(browser, {
  platform = process.platform,
  processApi = process,
  spawnImpl = spawn,
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!browser?.pid) return;
  if (platform === 'win32') {
    try { browser.kill('SIGTERM'); } catch {}
    const timer = schedule(() => {
      if (browser.exitCode != null || browser.signalCode != null) return;
      try {
        const killer = spawnImpl('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => {});
      } catch {}
    }, 400);
    timer?.unref?.();
    return;
  }

  // The process was started detached, so its process group contains only this QR session.
  // Never kill by browser name: that could terminate a user's daily browser.
  try { processApi.kill(-browser.pid, 'SIGTERM'); }
  catch { try { browser.kill('SIGTERM'); } catch {} }
  const timer = schedule(() => {
    if (browser.exitCode != null || browser.signalCode != null) return;
    try { processApi.kill(-browser.pid, 'SIGKILL'); }
    catch { try { browser.kill('SIGKILL'); } catch {} }
  }, 700);
  timer?.unref?.();
}

const killBrowser = (browser) => terminateQrBrowser(browser);

function removeDir(dir) {
  if (!dir) return;
  // 先同步删一次（大部分情况浏览器退出后就能删）；被占用再延迟重试，
  // 不要只排定时器 —— 进程紧接着退出时定时器不会跑，会留临时 profile。
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  for (const delay of [800, 2000]) {
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, delay).unref?.();
  }
}

/** 清掉上次崩溃/提前退出留下的临时浏览器 profile（超过 1 小时的才算）。 */
function cleanupStaleProfiles() {
  try {
    const root = os.tmpdir();
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('surfcore-bili-qr-')) continue;
      const dir = path.join(root, name);
      try {
        const stat = fs.statSync(dir);
        if (Date.now() - stat.mtimeMs > 3_600_000) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

function cleanupSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.timer) clearTimeout(session.timer);
  try { session.cdp?.close(); } catch {}
  killBrowser(session.browser);
  removeDir(session.profileDir);
}

export function closeAllQrLogins() {
  for (const id of [...sessions.keys()]) cleanupSession(id);
}

/** 二维码页里取「可见的」data:image/png（隐藏 canvas 是空白占位，不能用）。 */
async function waitForQrImage(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const image = await cdp.evaluate(`(() => {
        const imgs = [...document.querySelectorAll('img')];
        const hit = imgs.find((img) => {
          const src = String(img.src || '');
          const rect = img.getBoundingClientRect();
          return src.startsWith('data:image/png') && rect.width > 50 && rect.height > 50;
        });
        return hit ? hit.src : '';
      })()`);
      if (image && image.length > 2000) return image;
    } catch { /* 页面导航中，继续等 */ }
    await sleep(500);
  }
  return '';
}

function cookieHeaderOf(cookies) {
  const parts = [];
  if (cookies.SESSDATA) parts.push(`SESSDATA=${cookies.SESSDATA}`);
  if (cookies.bili_jct) parts.push(`bili_jct=${cookies.bili_jct}`);
  if (cookies.buvid3) parts.push(`buvid3=${cookies.buvid3}`);
  return parts.join('; ');
}

async function navAccount(cookies) {
  const cookie = cookieHeaderOf(cookies);
  if (!cookie) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        referer: 'https://www.bilibili.com/',
        cookie,
      },
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data?.data?.isLogin || !data.data.mid) return null;
    return { mid: String(data.data.mid), name: String(data.data.uname ?? '') };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 核查已保存的登录凭据：读文件 → 再问一次 B站 nav → 核对 mid。
 * 不是"信任扫码那一刻的结果"，而是每次都能重新验证（用户要求：要有核查机制）。
 * 返回 { ok, account:{mid,name}, savedAt } 或 { ok:false, code, error, hint }。
 */
export async function verifyStoredCredentials(target = 'owner') {
  const file = target === 'owner' ? OWNER_BILI_CRED : BILI_CRED;
  if (!fs.existsSync(file)) {
    return {
      ok: false, code: 'bili.no-credentials',
      error: `${target === 'owner' ? '主人' : '小肥鱼'}还没有扫码登录`,
      hint: '到「B站」页点「扫码登录」，扫完再核查',
    };
  }
  let cred = null;
  try { cred = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cred = null; }
  if (!cred?.sessdata) {
    return { ok: false, code: 'bili.bad-credentials', error: '凭据文件读不出来或缺少 SESSDATA', hint: '点「换号（清除旧凭据）」后重新扫码' };
  }
  const account = await navAccount({ SESSDATA: cred.sessdata, bili_jct: cred.bili_jct, buvid3: cred.buvid3 });
  if (!account) {
    return {
      ok: false, code: 'bili.cookie-expired',
      error: 'B站 返回“未登录”（cookie 过期、被踢下线，或网络不通）',
      hint: '先确认网络能访问 api.bilibili.com；仍失败就重新扫码登录',
    };
  }
  if (cred.mid && String(cred.mid) !== String(account.mid)) {
    return {
      ok: false, code: 'bili.mid-mismatch',
      error: `凭据里记的是 ${cred.mid}（${cred.name || '?'}），但 B站 现在返回 ${account.mid}（${account.name}）`,
      hint: '点「换号（清除旧凭据）」后重新扫码，避免张冠李戴',
    };
  }
  return { ok: true, account: { mid: String(account.mid), name: String(account.name || '') }, savedAt: String(cred.savedAt || '') };
}

function writeOwnerCredentials(cookies, account) {
  const payload = {
    version: 1,
    sessdata: cookies.SESSDATA,
    bili_jct: cookies.bili_jct,
    buvid3: cookies.buvid3 ?? '',
    mid: String(account.mid),
    name: String(account.name ?? ''),
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OWNER_BILI_CRED), { recursive: true });
  const tmp = `${OWNER_BILI_CRED}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, OWNER_BILI_CRED);
  return { mid: payload.mid, name: payload.name, savedAt: payload.savedAt };
}

/** 绑定小肥鱼自己的号：写回原来的 credentials.json，并把 nav 确认到的 self 落进配置。 */
function writeFishCredentials(cookies, account) {
  const payload = {
    sessdata: cookies.SESSDATA,
    bili_jct: cookies.bili_jct,
    buvid3: cookies.buvid3 ?? '',
    mid: String(account.mid),
    name: String(account.name ?? ''),
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(BILI_CRED), { recursive: true });
  const tmp = `${BILI_CRED}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, BILI_CRED);
  try {
    const bili = readBiliConfig().config;
    bili.self = { mid: payload.mid, name: payload.name };
    saveBiliConfig(bili);
  } catch { /* 配置写失败不影响凭据本身；下次保存设置会再写 */ }
  return { mid: payload.mid, name: payload.name, savedAt: payload.savedAt };
}

/**
 * 扫码账号归属校验（纯函数，单测覆盖）：
 *   · 主人目标：不能是鱼自己的号；配了 owner.mid 就必须完全一致；
 *   · 鱼目标：不能是主人的号；已有 self.mid 时不允许不声不响换号（新用户 self.mid 为空则放行）。
 * 返回 { ok:true } 或 { ok:false, status:'wrong-account', error }。
 */
export function validateQrAccount({ target = 'owner', account = {}, selfMid = '', ownerMid = '', expectedMid = '', expectedName = '', allowSameAsOwner = false } = {}) {
  const mid = String(account?.mid ?? '');
  if (!mid) return { ok: false, status: 'failed', error: '扫码后没读到 mid' };
  const who = `${account.name || mid}（${mid}）`;
  if (target === 'owner') {
    if (selfMid && mid === selfMid) {
      return { ok: false, status: 'wrong-account', error: `扫码的是小肥鱼自己的号（${who}），不是主人；请换主人的 B站 账号扫。` };
    }
    if (expectedMid && mid !== String(expectedMid)) {
      return { ok: false, status: 'wrong-account', error: `扫码的是 ${who}，不是配置里的主人 ${expectedName || ''}（${expectedMid}）` };
    }
    return { ok: true };
  }
  // 单账号用户（self.mid == owner.mid）本来就是一个号；新用户 self.mid 为空时，
  // 允许显式勾选「与主人同一个号」后再扫，避免把「只有一个小号」的新用户卡死。
  const sameAccountConfigured = Boolean(selfMid && ownerMid && String(selfMid) === String(ownerMid));
  if (!allowSameAsOwner && !sameAccountConfigured && ownerMid && mid === ownerMid) {
    return { ok: false, status: 'wrong-account', error: `扫码的是主人账号（${who}），不能当小肥鱼；请换小肥鱼的 B站 账号扫。如果你只有一个 B站 号（主人=小肥鱼），勾选「与主人同一个号」后重扫。` };
  }
  const mustBe = expectedMid || selfMid;
  if (mustBe && mid !== String(mustBe)) {
    // 2026-10-27 修：用户明确勾了「与主人同一个号」时，应该允许**换号**（主人=小肥鱼=新号），
    // 否则会卡死：管理员卡片已改成新号、小肥鱼还指着旧号 → 永远报"不是当前小肥鱼"。
    // 只放行"换成本人同一个号"（主人号），不放行换成任意第三个号（防被换人）。
    if (allowSameAsOwner && ownerMid && mid === String(ownerMid)) return { ok: true, switched: true };
    return { ok: false, status: 'wrong-account', error: `扫码的是 ${who}，不是当前小肥鱼 ${expectedName || ''}（${mustBe}）。要点：① 只想用同一个号（主人=小肥鱼）→ 勾选「与主人同一个号」再扫；② 要换到别的号 → 先点「清除旧 B站 凭据（归档）」再扫。` };
  }
  return { ok: true };
}

/** 只读：告诉设置页「小肥鱼账号登录过没有」，绝不回显 cookie。 */
export function readFishAccount() {  try {
    const data = JSON.parse(fs.readFileSync(BILI_CRED, 'utf8'));
    if (!data?.sessdata || !data?.bili_jct) return { configured: false };
    return { configured: true, mid: String(data.mid ?? ''), name: String(data.name ?? ''), savedAt: String(data.savedAt ?? '') };
  } catch {
    return { configured: false };
  }
}

export function readOwnerAccount() {
  try {
    const data = JSON.parse(fs.readFileSync(OWNER_BILI_CRED, 'utf8'));
    if (!data?.sessdata || !data?.bili_jct) return { configured: false };
    return {
      configured: true,
      mid: String(data.mid ?? ''),
      name: String(data.name ?? ''),
      savedAt: String(data.savedAt ?? ''),
    };
  } catch {
    return { configured: false };
  }
}

/**
 * 打开 B站 登录页并取出二维码。target='fish' 绑定小肥鱼自己的号，target='owner' 绑定主人号。
 * @returns {{id:string, image:string, expiresAt:number, expected:{mid:string,name:string}, target:string}}
 */
export async function startQrLogin({ target = 'owner', expectedMid = '', expectedName = '', allowSameAsOwner = false } = {}) {
  closeAllQrLogins();          // 同时只保留一个扫码会话，避免多个浏览器泄漏
  cleanupStaleProfiles();
  const browser = findBrowser();
  if (!browser) {
    const error = new Error('找不到可用的 Microsoft Edge 或 Google Chrome');
    error.code = 'BROWSER_NOT_FOUND';
    error.hint = '安装 Edge 或 Chrome，或设置 SURFCORE_EDGE 指向应用包内的可执行文件后重试扫码。';
    throw error;
  }
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-qr-'));
  const browserEnv = { ...process.env };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  let browserProcess;
  try { browserProcess = spawn(browser.executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=560,760',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32', env: browserEnv });
  } catch (error) {
    removeDir(profileDir);
    error.code ||= 'QR_BROWSER_START_FAILED';
    error.hint ||= `确认 ${browser.name} 可执行后重试扫码。`;
    throw error;
  }

  let sessionId = '';
  const browserFailure = new Promise((resolve) => {
    browserProcess.once('error', (error) => resolve({ ok: false, error: new Error(`启动${browser.name}失败：${error.message}`) }));
    browserProcess.once('exit', (code, signal) => resolve({
      ok: false,
      error: new Error(`${browser.name}在扫码准备完成前退出（${signal || code || '未知原因'}）`),
    }));
  });
  const cleanupAfterExit = () => { if (sessionId) cleanupSession(sessionId); };
  browserProcess.on('exit', cleanupAfterExit);
  browserProcess.on('error', cleanupAfterExit);
  let cdp = null;
  try {
    const startResult = await Promise.race([
      waitJson(`http://127.0.0.1:${port}/json/version`, START_WAIT_MS)
        .then(() => ({ ok: true }), (error) => ({ ok: false, error })),
      browserFailure,
    ]);
    if (!startResult.ok) throw startResult.error;
    const tabRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!tabRes.ok) throw new Error(`浏览器新建标签失败（HTTP ${tabRes.status}）`);
    const tab = await tabRes.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 760, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: LOGIN_URL });
    const image = await waitForQrImage(cdp, QR_WAIT_MS);
    if (!image) throw new Error('没等到二维码：B站 登录页可能被风控/改版，过一会儿重试或手动粘贴 cookie');
    if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
      throw new Error(`${browser.name}已退出，二维码会话没有建立成功`);
    }

    const id = `qr_${crypto.randomUUID()}`;
    const session = {
      id, browser: browserProcess, browserName: browser.name, cdp, profileDir, createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      target: target === 'fish' ? 'fish' : 'owner',
      expectedMid: String(expectedMid ?? '').trim(),
      expectedName: String(expectedName ?? '').trim(),
      allowSameAsOwner: allowSameAsOwner === true,
      timer: null,
    };
    session.timer = setTimeout(() => cleanupSession(id), SESSION_TTL_MS + 3_000);
    session.timer.unref?.();
    sessions.set(id, session);
    sessionId = id;
    return {
      id,
      image,
      expiresAt: session.expiresAt,
      target: session.target,
      expected: { mid: session.expectedMid, name: session.expectedName },
    };
  } catch (error) {
    try { cdp?.close(); } catch {}
    killBrowser(browserProcess);
    removeDir(profileDir);
    if (!error?.code) error.code = 'QR_BROWSER_START_FAILED';
    if (!error?.hint) error.hint = `确认 ${browser.name} 可执行且支持 headless/CDP，再重试扫码。`;
    throw error;
  }
}

/**
 * 轮询扫码结果。状态：waiting / scanned / confirmed / expired / wrong-account / failed。
 * 只有 confirmed 时才写 cookie 文件。
 */
export async function pollQrLogin(id) {
  const session = sessions.get(id);
  if (!session) return { ok: false, status: 'expired', error: '扫码会话不存在或已过期' };
  if (Date.now() > session.expiresAt) {
    cleanupSession(id);
    return { ok: true, status: 'expired' };
  }
  try {
    let text = '';
    try { text = String(await session.cdp.evaluate('document.body.innerText') ?? ''); } catch {}
    if (/二维码已失效|二维码失效|二维码过期/.test(text)) {
      cleanupSession(id);
      return { ok: true, status: 'expired' };
    }
    const scanned = /扫码成功|请在手机上确认|已扫码/.test(text);
    const all = await session.cdp.send('Network.getAllCookies');
    const cookies = {};
    for (const cookie of (all?.cookies ?? [])) {
      if (!/(^|\.)bilibili\.com$/.test(String(cookie.domain ?? ''))) continue;
      if (['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID'].includes(cookie.name)) cookies[cookie.name] = cookie.value;
    }
    if (cookies.SESSDATA && cookies.bili_jct) {
      const account = await navAccount(cookies);
      if (account) {
        const cfg = readBiliConfig().config ?? {};
        const verdict = validateQrAccount({
          target: session.target,
          account,
          selfMid: String(cfg.self?.mid ?? ''),
          ownerMid: String(cfg.owner?.mid ?? ''),
          expectedMid: session.expectedMid,
          expectedName: session.expectedName,
          allowSameAsOwner: session.allowSameAsOwner,
        });
        if (!verdict.ok) {
          cleanupSession(id);
          return {
            ok: false,
            status: verdict.status,
            account,
            expected: { mid: session.expectedMid, name: session.expectedName },
            error: verdict.error,
          };
        }
        const saved = session.target === 'fish' ? writeFishCredentials(cookies, account) : writeOwnerCredentials(cookies, account);
        cleanupSession(id);
        return { ok: true, status: 'confirmed', account: saved, target: session.target };
      }
    }
    return { ok: true, status: scanned ? 'scanned' : 'waiting' };
  } catch (error) {
    cleanupSession(id);
    return { ok: false, status: 'failed', error: String(error?.message ?? error) };
  }
}

export function cancelQrLogin(id) {
  cleanupSession(id);
  return { ok: true };
}
