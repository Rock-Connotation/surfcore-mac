import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findBrowser } from './bili-qr-login.mjs';

const HOME_URL = 'https://www.douyin.com/?recommend=1&from_nav=1';
const MAX_BODY = 8 * 1024 * 1024;
const PATHS = new Set(['/aweme/v1/web/tab/feed/', '/aweme/v1/web/user/profile/self/']);
const fail = (code, error, hint) => Object.assign(new Error(error), { code, hint });
const problem = (code, error, hint) => ({ ok: false, code, error, hint });
function safeError(e) { return e?.hint ? problem(e.code || 'BROWSER_ERROR', e.message, e.hint) : problem('BROWSER_ERROR', '浏览器操作失败', '检查浏览器和私有目录后重试。'); }
function safeUrl(raw) { try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && !u.port && !u.username && !u.password ? { host: u.hostname, pathname: u.pathname, protocol: u.protocol } : null; } catch { return null; } }

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

// Runs synchronously in the page. The per-wait argument holds polling state,
// avoiding page globals and the truthy-Promise trap of async waitForFunction predicates.
function stableHomepagePlayer(state) {
  const text = document.body?.innerText || '';
  if (/验证码|安全验证|人机验证|滑块验证/.test(text)) return { blocked: 'verification' };
  if (text.includes('滚动“鼠标”或点按“键盘上下键”查看更多推荐视频')) return { blocked: 'guide' };
  const candidates = [...document.querySelectorAll('video')].map(video => {
    const box = video.getBoundingClientRect(), style = getComputedStyle(video);
    const area = Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.x))
      * Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.y));
    // The server-rendered quickPlayer can already play while the interactive
    // recommendation application (and its navigation handlers) is not mounted.
    return { video, box, area, visible: !video.closest?.('#quickPlayer') && style.display !== 'none' && style.visibility === 'visible' };
  }).filter(x => x.visible && x.box.width > 120 && x.box.height > 120 && x.area > 0)
    .sort((a, b) => b.area - a.area);
  const item = candidates[0], source = item?.video.currentSrc;
  if (!item || !source || item.video.readyState < 2 || source === state.previousSource) { state.last = null; return false; }
  const rect = [item.box.x, item.box.y, item.box.width, item.box.height], last = state.last;
  if (!last || last.source !== source || rect.some((v, i) => Math.abs(v - last.rect[i]) > 0.5)) {
    state.last = { source, rect, at: performance.now() }; return false;
  }
  // Homepage prefetch/navigation debounce outlives the visible slide animation.
  // A stable second prevents the next key from cancelling that initialization.
  return performance.now() - last.at >= 1000 ? { source } : false;
}

export function createDouyinBrowser({ profileDir, browserPath, headless = false, onResponse, onRequest, timeouts = {}, launchPersistentContext } = {}) {
  let context, page, release, starting = false, closing = false, running = false, browserName = '', sessionId, requestSeq = 0;
  let records = new WeakMap(), disconnected = false, closeAttempt, lastFeedSeq = 0;
  const recent = [];
  const closeTimeout = timeouts.close ?? 5000;
  const alive = owned => context === owned && running && !closing && !disconnected;
  const bounded = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('BROWSER_TIMEOUT', '浏览器操作超时', '检查浏览器状态后重试。')), ms); })]); }
    finally { clearTimeout(timer); }
  };
  function closed(owned) {
    if (context !== owned) return;
    running = false; context = undefined; page = undefined; closing = false; disconnected = false; closeAttempt = undefined;
    records = new WeakMap(); release?.(); release = undefined;
  }
  async function response(owned, res) {
    try {
      if (!alive(owned)) return;
      const req = res.request(), record = records.get(req), u = safeUrl(res.url());
      if (!record || !u || req.redirectedFrom() || req.redirectedTo() || u.pathname !== record.pathname) return;
      const meta = { ...record, status: res.status() };
      recent.push(meta); if (recent.length > 40) recent.shift();
      try { onRequest?.(meta); } catch {}
      if (!PATHS.has(u.pathname) || res.fromServiceWorker()) return;
      const sizes = await req.sizes();
      if (!alive(owned) || sizes.responseBodySize > MAX_BODY) return;
      const body = await res.body();
      if (!alive(owned) || body.length > MAX_BODY) return;
      const json = JSON.parse(body.toString('utf8'));
      if (alive(owned) && meta.status === 200 && u.pathname === '/aweme/v1/web/tab/feed/'
          && json?.status_code === 0 && Array.isArray(json.aweme_list) && json.aweme_list.length) lastFeedSeq = Math.max(lastFeedSeq, record.requestSeq);
      if (alive(owned)) Promise.resolve(onResponse?.(json, meta)).catch(() => {});
    } catch { /* Missing, malformed or unavailable bodies are ignored. */ }
  }
  async function start() {
    if (disconnected) return problem('BROWSER_DISCONNECTED', '浏览器连接已中断且退出状态未知', '检查独立浏览器和占用锁，确认退出后由管理员处理。');
    if (context || starting) return problem('BROWSER_RUNNING', '浏览器已经启动或正在关闭', '先关闭当前浏览器再重试。');
    starting = true;
    try {
      release = acquireProfile(profileDir);
      const found = browserPath ? { executable: browserPath, name: path.basename(browserPath) } : findBrowser();
      if (!found?.executable || !path.isAbsolute(found.executable)) throw fail('BROWSER_NOT_FOUND', '未找到可用浏览器', '安装 Chrome 或 Edge 后重试。');
      browserName = found.name || 'Browser';
      const chromium = launchPersistentContext ? null : (await import('playwright-core')).chromium;
      const launch = launchPersistentContext || chromium.launchPersistentContext.bind(chromium);
      const names = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
      const allowed = new Set([...names, ...Object.keys(process.env).filter(k => /^LC_[A-Z_]+$/.test(k))]);
      const env = Object.fromEntries([...allowed].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
      const owned = await launch(path.resolve(profileDir), { executablePath: found.executable, headless, viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', env, args: ['--restore-last-session'], ...(process.platform === 'darwin' ? { ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'] } : {}) });
      context = owned; disconnected = false; closeAttempt = undefined; sessionId = randomUUID(); requestSeq = 0; lastFeedSeq = 0; recent.length = 0; records = new WeakMap();
      owned.on('close', () => {
        if (context !== owned) return;
        running = false;
        if (!closing) disconnected = true;
      });
      owned.on('request', req => {
        if (context !== owned || closing) return;
        const u = safeUrl(req.url()); if (!u) return;
        records.set(req, { pathname: u.pathname.slice(0, 256), requestId: randomUUID(), sessionId, requestSeq: ++requestSeq, requestStartedAt: Date.now() });
      });
      owned.on('response', res => { void response(owned, res); });
      // Enabling routing disables HTTP cache; service workers are blocked above.
      await owned.route('**/*', route => route.continue());
      const pages = owned.pages();
      page = pages[0] || await owned.newPage();
      for (const extra of pages.slice(1)) await extra.close();
      if (disconnected) throw fail('BROWSER_DISCONNECTED', '浏览器连接已中断且退出状态未知', '检查独立浏览器和占用锁，确认退出后由管理员处理。');
      running = true;
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: timeouts.command ?? 30000 });
      if (!alive(owned)) throw fail('BROWSER_CLOSED', '浏览器连接已关闭', '重新启动浏览器后重试。');
      return { ok: true, browserName };
    } catch (e) {
      if (context) { await close(); } else { release?.(); release = undefined; }
      return safeError(e);
    } finally { starting = false; }
  }
  async function guarded(action, defaultTimeout = 30000) {
    if (!running || !context || closing || page?.isClosed()) return problem('BROWSER_NOT_RUNNING', '浏览器未启动或已关闭', '先启动浏览器。');
    const owned = context; let active = true;
    const assertActive = () => { if (!active || !alive(owned)) throw fail('BROWSER_CLOSED', '浏览器操作已结束或已关闭', '重新启动独立浏览器后重试。'); };
    try { return await bounded(action(assertActive), timeouts.command ?? defaultTimeout); } catch (e) { return safeError(e); }
    finally { active = false; }
  }
  async function close() {
    if (!context) return { ok: true };
    if (disconnected) return problem('BROWSER_UNKNOWN_EXIT', '浏览器连接中断，无法确认进程退出', '检查独立浏览器和占用锁，确认退出后由管理员处理。');
    const owned = context; closing = true; running = false;
    if (!closeAttempt) {
      closeAttempt = Promise.resolve().then(() => owned.close()).then(() => { closed(owned); });
      // A late successful close may release the lock; an event alone never can.
      closeAttempt.catch(() => {});
    }
    try {
      await bounded(closeAttempt, closeTimeout);
      return { ok: true };
    } catch (e) { return problem(e?.code === 'BROWSER_TIMEOUT' ? 'BROWSER_CLOSE_TIMEOUT' : 'BROWSER_CLOSE_FAILED', '浏览器未确认退出', '检查独立浏览器和占用锁；资料与锁会保留。'); }
  }
  async function snapshot() {
    const v = await page.evaluate(() => ({ title: document.title, url: location.origin + location.pathname, text: (document.body?.innerText || '').slice(0, 12000) }));
    const u = safeUrl(v.url);
    return { ok: true, title: String(v.title || '').slice(0, 300), url: u ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 1000) : '', text: String(v.text || '').slice(0, 12000) };
  }
  return {
    start, close,
    reload: () => guarded(async () => { await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: timeouts.command ?? 30000 }); return { ok: true }; }),
    snapshot: () => guarded(snapshot),
    screenshot: () => guarded(async () => ({ ok: true, image: (await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false })).toString('base64'), mimeType: 'image/jpeg' })),
    loadRecommendations: () => guarded(async assertActive => {
      const feedCutoff = requestSeq;
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: timeouts.command ?? 30000 });
      const waitPlayer = async (previousSource, code, error, hint, timeout) => {
        assertActive(); let handle;
        try {
          handle = await page.waitForFunction(stableHomepagePlayer, { previousSource }, { timeout: Math.min(timeout, timeouts.command ?? 30000) });
          const value = await handle.jsonValue(); assertActive(); return value;
        } catch { throw fail(code, error, hint); }
        finally { await handle?.dispose().catch(() => {}); }
      };
      const clearGuide = async () => {
        assertActive(); const snap = await snapshot(); assertActive();
        if (/验证码|安全验证|人机验证|滑块验证/.test(snap.text)) throw fail('DOUYIN_VERIFICATION_REQUIRED', '抖音要求人工验证', '请在独立浏览器完成验证后重试。');
        if (!snap.text.includes('滚动“鼠标”或点按“键盘上下键”查看更多推荐视频')) return;
        const button = page.getByRole('button', { name: '我知道了', exact: true });
        try {
          await button.waitFor({ state: 'visible', timeout: 3000 }); assertActive();
          await button.click({ timeout: 3000 });
          assertActive(); await button.waitFor({ state: 'hidden', timeout: 3000 }); assertActive();
          if ((await snapshot()).text.includes('滚动“鼠标”或点按“键盘上下键”查看更多推荐视频')) throw new Error('guide remains');
        } catch { throw fail('DOUYIN_TUTORIAL_NOT_DISMISSED', '首页操作引导仍显示', '请在独立浏览器中关闭「我知道了」引导后重试。'); }
      };
      const rejectBlock = value => {
        if (value.blocked === 'verification') throw fail('DOUYIN_VERIFICATION_REQUIRED', '抖音要求人工验证', '请在独立浏览器完成验证后重试。');
        if (value.blocked === 'guide') throw fail('DOUYIN_TUTORIAL_NOT_DISMISSED', '首页操作引导仍显示', '请在独立浏览器中关闭「我知道了」引导后重试。');
        return value;
      };
      const readyPlayer = async timeout => {
        let value = await waitPlayer(undefined, 'DOUYIN_PAGE_NOT_READY', '抖音首页推荐页面尚未就绪', '等待首页推荐完成加载、上下翻页可用后重试。', timeout);
        if (value.blocked === 'guide') { await clearGuide(); value = await waitPlayer(undefined, 'DOUYIN_PAGE_NOT_READY', '抖音首页推荐页面尚未就绪', '等待首页推荐完成加载、上下翻页可用后重试。', timeout); }
        return rejectBlock(value);
      };
      assertActive(); const initial = await snapshot(); assertActive();
      if (/验证码|安全验证|人机验证|滑块验证/.test(initial.text)) return problem('DOUYIN_VERIFICATION_REQUIRED', '抖音要求人工验证', '请在独立浏览器完成验证后重试。');
      await readyPlayer(10000);
      await clearGuide();
      const editable = await page.evaluate(() => { const e = document.activeElement; return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); });
      assertActive(); let keyStepsSent = 0, recoveryHandled = false;
      if (!editable) for (let i = 0; i < 8 && lastFeedSeq <= feedCutoff; i++) {
        await clearGuide();
        const before = await readyPlayer(4000);
        const advance = async () => {
          assertActive(); if (lastFeedSeq > feedCutoff) return before;
          await page.keyboard.press('ArrowDown'); keyStepsSent++; assertActive();
          try { return await waitPlayer(before.source, 'DOUYIN_VIDEO_NOT_ADVANCED', '首页推荐视频未能切换', '确认独立浏览器的引导已关闭且视频可正常切换，再重试。', 4000); }
          catch (error) { assertActive(); if (lastFeedSeq > feedCutoff && error.code === 'DOUYIN_VIDEO_NOT_ADVANCED') return before; throw error; }
        };
        let after;
        try { after = await advance(); }
        catch (error) {
          // The first video can be ready before the application registers its
          // navigation handler. Re-read it before one bounded initial recovery;
          // a late transition never receives another key.
          assertActive();
          if (i !== 0 || recoveryHandled || error.code !== 'DOUYIN_VIDEO_NOT_ADVANCED') throw error;
          recoveryHandled = true; await clearGuide();
          const current = await readyPlayer(4000);
          after = current.source === before.source ? await advance() : current;
        }
        if (after.blocked === 'guide' && !recoveryHandled) {
          recoveryHandled = true; await clearGuide();
          const current = await readyPlayer(4000);
          after = current.source === before.source ? await advance() : current;
        }
        rejectBlock(after);
      }
      assertActive(); const mediaUserAgent = await page.evaluate(() => navigator.userAgent); assertActive();
      return { ok: true, keyStepsSent, mediaUserAgent };
    }, 60000),
    status: () => context && (!running || closing || page?.isClosed()) ? { ...problem('BROWSER_DISCONNECTED', '浏览器未处于可用状态', '检查独立浏览器和占用锁，确认退出后由管理员处理。'), running: false, browserName, requestSeq, recent: recent.slice() } : { ok: true, running: !!context && running, browserName: context ? browserName : '', requestSeq, recent: recent.slice() },
  };
}
