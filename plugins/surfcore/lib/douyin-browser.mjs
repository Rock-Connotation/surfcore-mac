import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowser } from './bili-qr-login.mjs';

const HOME_URL = 'https://www.douyin.com/';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const HOSTS = new Set(['www.douyin.com', 'douyin.com', 'passport.douyin.com']);
const PATHS = new Set(['/aweme/v1/web/tab/feed/', '/aweme/v1/web/user/profile/self/', '/passport/web/account/info/', '/passport/web/account/info']);
const fail = (code, error, hint) => Object.assign(new Error(error), { code, hint });
const problem = (code, error, hint) => ({ ok: false, code, error, hint });
function safeError(e) { return problem(e.code || 'BROWSER_ERROR', e.code ? e.message : '浏览器操作失败', e.hint || '检查浏览器和私有目录后重试。'); }
function safeUrl(raw) { try { const u = new URL(raw); return { host: u.hostname, pathname: u.pathname, protocol: u.protocol }; } catch { return null; } }

// Only creates a private directory; existing profiles or locks are never removed as recovery.
function acquireProfile(dir) {
  if (!path.isAbsolute(dir)) throw fail('PROFILE_INVALID', '浏览器资料目录必须是绝对路径', '选择独立的私有资料目录。');
  const resolved = path.resolve(dir);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const s = fs.lstatSync(current); if (s.isSymbolicLink() || !s.isDirectory()) throw fail('PROFILE_UNSAFE', '资料路径包含符号链接或非目录', '选择没有符号链接的私有目录。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; fs.mkdirSync(current, { mode: 0o700 }); }
  }
  const s = fs.lstatSync(resolved);
  if ((typeof process.getuid === 'function' && s.uid !== process.getuid()) || (process.platform !== 'win32' && (s.mode & 0o077))) throw fail('PROFILE_UNSAFE', '资料目录不属于当前用户或权限过宽', '检查目录所有者和权限后重试。');
  const lock = path.join(resolved, '.surfcore-douyin.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw fail('PROFILE_LOCKED', '资料目录已被占用或存在未知锁', '先确认原浏览器已退出，再由管理员检查锁文件。'); throw e; }
  const identity = fs.fstatSync(fd);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  fs.closeSync(fd);
  const unlock = () => { try { const now = fs.lstatSync(lock); if (!now.isSymbolicLink() && now.ino === identity.ino && now.dev === identity.dev) fs.unlinkSync(lock); } catch {} };
  try {
    const marker = path.join(resolved, '.surfcore-douyin-profile');
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(resolved).some(name => name !== '.surfcore-douyin.lock')) throw fail('PROFILE_FOREIGN', '资料目录不是已登记的抖音独立目录', '选择一个新的空目录，保留原有资料。');
      fs.writeFileSync(marker, 'surfcore-douyin-profile-v1\n', { flag: 'wx', mode: 0o600 });
    } else {
      const ms = fs.lstatSync(marker);
      if (!ms.isFile() || ms.isSymbolicLink() || ms.size > 64 || (typeof process.getuid === 'function' && ms.uid !== process.getuid()) || fs.readFileSync(marker, 'utf8') !== 'surfcore-douyin-profile-v1\n') throw fail('PROFILE_FOREIGN', '资料目录的归属标记无效', '选择一个新的空目录，保留原有资料。');
    }
  } catch (e) { unlock(); throw e; }
  return unlock;
}

export function createDouyinBrowser({ profileDir, browserPath, headless = false, onResponse, onRequest, timeouts = {} } = {}) {
  let child, sessionId, release, browserName = '', buffer = Buffer.alloc(0), nextId = 0, running = false, starting = false, disconnected = false, closing = false, exitPromise;
  const pending = new Map(), tracked = new Map(), starts = new Map(), recent = [];
  let requestSeq = 0;
  const timeout = timeouts.command ?? 10000, closeTimeout = timeouts.close ?? 5000;
  const resetPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fail('BROWSER_CLOSED', '浏览器连接已关闭', '重新启动浏览器后重试。')); } pending.clear(); };
  const disconnect = () => { disconnected = true; running = false; buffer = Buffer.alloc(0); starts.clear(); tracked.clear(); resetPending(); };
  function command(method, params = {}, session = sessionId) {
    if (disconnected || !child || !child.stdio[3]?.writable) return Promise.reject(fail('BROWSER_CLOSED', '浏览器连接已关闭', '重新启动浏览器后重试。'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('CDP_TIMEOUT', '浏览器操作超时', '检查浏览器是否响应，再重试。')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0', (e) => { if (e) disconnect(); });
    });
  }
  function receive(message) {
    if (message.id) { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(fail('CDP_ERROR', '浏览器拒绝操作', '检查浏览器状态后重试。')) : p.resolve(message.result || {}); return; }
    if (message.sessionId !== sessionId) return;
    const p = message.params || {};
    if (message.method === 'Network.requestWillBeSent') {
      const id = p.requestId, u = safeUrl(p.request?.url);
      if (typeof id !== 'string' || id.length > 256) return;
      if (p.redirectResponse) { starts.delete(id); tracked.delete(id); return; }
      if (!u || u.protocol !== 'https:' || !HOSTS.has(u.host)) return;
      if (starts.size >= 200) starts.delete(starts.keys().next().value);
      starts.set(id, { requestId: id, sessionId, requestSeq: ++requestSeq, requestStartedAt: Date.now(), host: u.host, pathname: u.pathname });
    }
    if (message.method === 'Network.requestServedFromCache') { const started = starts.get(p.requestId); if (started) started.cached = true; tracked.delete(p.requestId); }
    if (message.method === 'Network.responseReceived') {
      const u = safeUrl(p.response?.url), status = p.response?.status;
      if (!u || u.protocol !== 'https:' || !HOSTS.has(u.host)) return;
      const started = starts.get(p.requestId);
      if (!started || started.host !== u.host || started.pathname !== u.pathname) return;
      const { requestId, requestSeq, requestStartedAt } = started;
      const meta = { pathname: u.pathname.slice(0, 256), status: Number(status) || 0, requestId, sessionId, requestSeq, requestStartedAt };
      recent.push(meta); if (recent.length > 40) recent.shift();
      try { onRequest?.(meta); } catch {}
      if (!started.cached && !p.response?.fromDiskCache && !p.response?.fromServiceWorker && !p.response?.fromPrefetchCache && PATHS.has(u.pathname) && /(?:^|\/)json(?:\s*;|$)/i.test(p.response?.mimeType || '')) { if (tracked.size >= 100) tracked.delete(tracked.keys().next().value); tracked.set(p.requestId, meta); }
    }
    if (message.method === 'Network.loadingFailed') { tracked.delete(p.requestId); starts.delete(p.requestId); }
    if (message.method === 'Network.loadingFinished' && tracked.has(p.requestId)) {
      const meta = tracked.get(p.requestId); tracked.delete(p.requestId); starts.delete(p.requestId);
      if (p.encodedDataLength > MAX_BODY) return;
      command('Network.getResponseBody', { requestId: p.requestId }).then(result => {
        if (disconnected) return;
        const body = result.base64Encoded ? Buffer.from(result.body || '', 'base64') : Buffer.from(result.body || '', 'utf8');
        if (body.length > MAX_BODY) return;
        try { const json = JSON.parse(body.toString('utf8')); Promise.resolve(onResponse?.(json, meta)).catch(() => {}); } catch {}
      }).catch(() => {});
    } else if (message.method === 'Network.loadingFinished') starts.delete(p.requestId);
  }
  function consume(chunk) {
    if (disconnected) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) { const end = buffer.indexOf(0); if (end < 0) break; const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); if (frame.length > MAX_FRAME) { disconnect(); child?.stdio[4]?.destroy(); return; } try { receive(JSON.parse(frame.toString('utf8'))); } catch {} }
    if (buffer.length > MAX_FRAME) { buffer = Buffer.alloc(0); disconnect(); child?.stdio[4]?.destroy(); }
  }
  async function start() {
    if (child && disconnected) return problem('BROWSER_DISCONNECTED', '浏览器连接已中断，原进程尚未退出', '关闭独立浏览器并等待退出后重新启动。');
    if (running || starting || child) return problem('BROWSER_RUNNING', '浏览器已经启动或正在关闭', '先关闭当前浏览器再重试。');
    starting = true; disconnected = false;
    try {
      release = acquireProfile(profileDir);
      const found = browserPath ? { executable: browserPath, name: path.basename(browserPath) } : findBrowser();
      if (!found?.executable || !path.isAbsolute(found.executable)) throw fail('BROWSER_NOT_FOUND', '未找到可用浏览器', '安装 Chrome 或 Edge 后重试。');
      browserName = found.name || 'Browser';
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(found.executable, ['--remote-debugging-pipe', `--user-data-dir=${path.resolve(profileDir)}`, '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env, windowsHide: true });
      const owned = child;
      exitPromise = new Promise(resolve => { owned.once('close', () => { if (!closing) disconnected = true; else disconnected = false; running = false; resetPending(); starts.clear(); tracked.clear(); if (child === owned) { child = undefined; release?.(); release = undefined; } resolve(); }); });
      owned.on('error', disconnect);
      owned.stdio[4].on('data', consume); owned.stdio[4].on('error', disconnect); owned.stdio[4].on('close', disconnect); owned.stdio[3].on('error', disconnect); owned.stdio[3].on('close', disconnect);
      const target = await command('Target.createTarget', { url: 'about:blank' }, null);
      const attached = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null); sessionId = attached.sessionId;
      await command('Network.enable'); await command('Page.enable'); await command('Page.navigate', { url: HOME_URL }); running = true;
      return { ok: true, browserName: found.name || 'Browser' };
    } catch (e) {
      if (child) { try { await command('Browser.close', {}, null); } catch {} }
      else { release?.(); release = undefined; }
      return safeError(e);
    } finally { starting = false; }
  }
  async function guarded(action) { if (disconnected) return problem('BROWSER_DISCONNECTED', '浏览器连接已中断', '关闭独立浏览器并等待退出后重新启动。'); if (!running) return problem('BROWSER_NOT_RUNNING', '浏览器未启动', '先启动浏览器。'); try { return await action(); } catch (e) { return safeError(e); } }
  return {
    start,
    reload: () => guarded(async () => { await command('Page.navigate', { url: HOME_URL }); return { ok: true }; }),
    snapshot: () => guarded(async () => { const result = await command('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,url:location.origin+location.pathname,text:(document.body?.innerText||"").slice(0,12000)})', returnByValue: true }); const v = JSON.parse(result.result?.value || '{}'); const u = safeUrl(v.url); return { ok: true, title: String(v.title || '').slice(0, 300), url: u ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 1000) : '', text: String(v.text || '').slice(0, 12000) }; }),
    screenshot: () => guarded(async () => { const result = await command('Page.captureScreenshot', { format: 'png' }); return { ok: true, png: result.data }; }),
    status: () => ({ ...(disconnected ? problem('BROWSER_DISCONNECTED', '浏览器连接已中断', '关闭独立浏览器并等待退出后重新启动。') : { ok: true }), running, browserName: child ? browserName : '', requestSeq, recent: recent.slice() }),
    close: async () => { if (!child) return { ok: true }; closing = true; running = false; const ownedExit = exitPromise; let closeError; try { if (disconnected) { child.stdio[3]?.end(); } else { await command('Browser.close', {}, null); child?.stdio[3]?.end(); } } catch (e) { closeError = e; } const exited = await Promise.race([ownedExit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), closeTimeout))]); closing = false; return exited ? { ok: true } : closeError ? safeError(closeError) : problem('BROWSER_CLOSE_TIMEOUT', '浏览器未正常退出', '手动关闭此独立浏览器后重试；资料会保留。'); },
  };
}
