import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDouyinBrowser } from './douyin-browser.mjs';
import { parseDouyinSelf, parseDouyinFeed, publicDouyinAccount } from './douyin-data.mjs';

const SELF = '/aweme/v1/web/user/profile/self/';
const FEED = '/aweme/v1/web/tab/feed/';
const error = (code, message, hint) => ({ ok: false, code, error: message, hint });
const stale = () => error('DOUYIN_STALE', '角色或操作已变化', '切回当前角色后重新操作。');
const busy = () => error('DOUYIN_BUSY', '抖音操作正在进行', '先完成或关闭当前操作。');
const transitioning = () => error('DOUYIN_TRANSITION', '角色正在切换或恢复', '等待角色操作完成后重试。');
const auth = () => error('DOUYIN_NEEDS_AUTH', '未取得当前账号的有效登录信息', '在独立浏览器中完成登录或验证后重试。');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createDouyinService({ stateDir, getCharacter, browserFactory = createDouyinBrowser, now = Date.now, waitMs = 20000 } = {}) {
  if (!path.isAbsolute(stateDir) || typeof getCharacter !== 'function') throw new Error('stateDir and getCharacter required');
  let generation = 0, active = null, candidate = null, disposed = false, transitionDepth = 0, lastError = null, pageState = 'idle';
  const role = () => { const r = getCharacter(); return r && { characterId: r.characterId ?? r.id, characterEpoch: r.characterEpoch ?? r.epoch }; };
  const matches = c => { const r = role(); return !!r && typeof r.characterId === 'string' && /^[A-Za-z0-9_-]+$/.test(r.characterId) && c?.characterId === r.characterId && c?.characterEpoch === r.characterEpoch; };
  const current = (op) => !disposed && transitionDepth === 0 && generation === op.gen && matches(op.context);
  const dir = c => path.join(stateDir, 'characters', c.characterId, 'douyin');
  function safeDirectory(c, create) {
    let base = stateDir;
    for (const segment of ['characters', c.characterId, 'douyin']) {
      base = path.join(base, segment);
      try { const stat = fs.lstatSync(base); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory'); }
      catch (e) { if (e.code !== 'ENOENT' || !create) throw e; fs.mkdirSync(base, { mode: 0o700 }); }
    }
    return base;
  }
  const read = (c, name) => { try { const target = path.join(safeDirectory(c, false), name); const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe file'); return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function write(c, name, value) {
    const base = safeDirectory(c, true);
    const target = path.join(base, name), temp = path.join(base, `.${name}.${randomUUID()}.tmp`);
    try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe file'); const backup = path.join(base, `${name}.backup-${Date.now()}-${randomUUID()}`); fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  }
  const enabled = c => read(c, 'settings.json')?.enabled === true;
  const binding = c => read(c, 'account.json');
  function ioError() { return error('DOUYIN_STATE_ERROR', '抖音本地状态读写失败', '检查角色目录权限和磁盘空间后重试。'); }
  function view(c) {
    try { const account = binding(c); return { ok: true, character: { id: c.characterId, epoch: c.characterEpoch }, enabled: enabled(c), account: account?.identity ? publicDouyinAccount(account.identity) : null, state: active && matches(active.context) ? pageState : 'idle', candidate: candidate && matches(candidate.context) && candidate.gen === generation ? { candidateId: candidate.id, ...publicDouyinAccount(candidate.identity) } : null, ...(lastError && active && matches(active.context) ? { lastError } : {}) }; } catch { return ioError(); }
  }
  async function stop(op) {
    if (!op) return { ok: true };
    if (op.stopping) return op.stopping;
    op.stopping = (async () => {
    if (op.starting) await op.starting.catch(() => {});
    let result; try { result = await op.browser.close(); } catch { result = error('DOUYIN_CLOSE_FAILED', '独立浏览器关闭失败', '手动关闭该浏览器后重试；资料会保留。'); }
    if (!result?.ok) { lastError = error(result?.code || 'DOUYIN_CLOSE_FAILED', result?.error || '独立浏览器关闭失败', result?.hint || '手动关闭该浏览器后重试；资料会保留。'); return lastError; }
    if (active === op) active = null;
    return { ok: true };
    })();
    const result = await op.stopping;
    if (!result.ok) op.stopping = null;
    return result;
  }
  async function cancel() { generation++; candidate = null; pageState = 'idle'; const op = active; const result = await stop(op); return result; }
  function makeOp(context, kind, expectedIdentity = null) {
    const op = { context: { ...context }, kind, gen: ++generation, events: [], session: null, browser: null, starting: null, selfSeq: 0, identityCutoff: 0, expectedIdentity, identityFailure: null };
    op.browser = browserFactory({ profileDir: path.join(dir(context), 'browser'), headless: false, onResponse(payload, meta) {
      if (!current(op) || active !== op || !meta || !Number.isSafeInteger(meta.requestSeq) || !meta.sessionId) return;
      if (op.session && op.session !== meta.sessionId) return;
      op.session ||= meta.sessionId;
      if (meta.pathname !== SELF && meta.pathname !== FEED) return;
      if (meta.pathname === FEED && meta.status !== 200) return;
      const parsed = meta.pathname === SELF ? (meta.status === 200 ? parseDouyinSelf(payload, { sourcePath: meta.pathname }) : auth()) : parseDouyinFeed(payload, { sourcePath: meta.pathname, limit: 5 });
      op.events.push({ meta, parsed }); if (op.events.length > 100) op.events.shift();
      if (meta.pathname === SELF && op.kind === 'login' && meta.requestSeq > op.selfSeq) {
        op.selfSeq = meta.requestSeq;
        candidate = parsed.ok ? { id: randomUUID(), identity: parsed.identity, context: op.context, gen: op.gen } : null;
        pageState = parsed.ok ? 'candidate' : 'login_required';
      }
      if (meta.pathname === SELF && op.kind === 'feed' && meta.requestSeq > op.identityCutoff && !op.identityFailure) {
        if (!parsed.ok) op.identityFailure = auth();
        else if (!same(parsed.identity, op.expectedIdentity)) op.identityFailure = error('DOUYIN_ACCOUNT_CHANGED', '读取时登录账号发生变化', '重新登录并确认账号。');
      }
    } });
    active = op; return op;
  }
  async function start(op) {
    try { op.starting = Promise.resolve(op.browser.start()); const result = await op.starting; op.starting = null; if (!current(op)) return stale(); if (!result?.ok) return result || auth(); return { ok: true }; }
    catch { op.starting = null; return current(op) ? error('DOUYIN_BROWSER_FAILED', '独立浏览器启动失败', '检查浏览器和资料目录后重试。') : stale(); }
  }
  function browserStatus(op) { try { const s = op.browser.status(); return s?.ok ? s : error(s?.code || 'DOUYIN_BROWSER_FAILED', s?.error || '独立浏览器连接异常', s?.hint || '关闭独立浏览器后重试；资料会保留。'); } catch { return error('DOUYIN_BROWSER_FAILED', '独立浏览器连接异常', '关闭独立浏览器后重试；资料会保留。'); } }
  async function findEvent(op, pathname, cutoff) {
    const deadline = now() + waitMs, wallDeadline = Date.now() + waitMs;
    do {
      if (!current(op)) return stale();
      if (op.identityFailure) return op.identityFailure;
      const state = browserStatus(op); if (!state.ok || !state.running) return state.ok ? error('DOUYIN_BROWSER_FAILED', '独立浏览器已停止', '关闭独立浏览器后重试；资料会保留。') : state;
      const event = op.events.find(e => e.meta.pathname === pathname && e.meta.requestSeq > cutoff && e.meta.sessionId === op.session);
      if (event) return event.parsed;
      if (now() >= deadline || Date.now() >= wallDeadline) break;
      await delay(Math.min(25, Math.max(1, wallDeadline - Date.now())));
    } while (true);
    return pathname === SELF ? auth() : error('DOUYIN_FEED_UNAVAILABLE', '未取得新的首页推荐', '确认账号已登录且首页可以正常显示，再重试。');
  }
  async function navigate(op) { try { const result = await (typeof op.browser.loadRecommendations === 'function' ? op.browser.loadRecommendations() : op.browser.reload()); if (!current(op)) return stale(); return result?.ok ? result : result || auth(); } catch { return current(op) ? error('DOUYIN_BROWSER_FAILED', '独立浏览器刷新失败', '检查浏览器后重试。') : stale(); } }
  const same = (a, b) => a && b && a.uid === b.uid && a.secUid === b.secUid && a.accountKey === b.accountKey;
  async function finish(op, result) { const closed = await stop(op); if (!closed.ok) return closed; return current(op) ? (op.identityFailure || result) : stale(); }
  function expectedPage(snap) { try { const u = new URL(snap.url); return u.protocol === 'https:' && u.hostname === 'www.douyin.com' && u.port === '' && u.pathname === '/'; } catch { return false; } }
  function unexpectedPage() { candidate = null; pageState = 'login_required'; return error('DOUYIN_PAGE_UNEXPECTED', '独立浏览器已离开抖音首页', '返回抖音官方首页并重新登录后重试。'); }
  return {
    async status() {
      const c = role(); if (!matches(c) || disposed) return stale();
      const op = active;
      if (op?.kind === 'login' && current(op) && !op.starting) {
        const state = browserStatus(op); if (!state.ok || !state.running) return state.ok ? auth() : state;
        let snap; try { snap = await op.browser.snapshot(); } catch { return error('DOUYIN_BROWSER_FAILED', '读取浏览器状态失败', '检查浏览器后重试。'); } if (!current(op)) return stale();
        if (!snap?.ok) return snap || auth();
        if (!expectedPage(snap)) return unexpectedPage();
        if (!candidate) pageState = /验证|验证码|安全检查|captcha|verify/i.test(`${snap.title} ${snap.text}`) ? 'verification_required' : 'login_required';
      }
      return view(c);
    },
    async setEnabled(value, context) {
      if (transitionDepth) return transitioning();
      if (typeof value !== 'boolean') return error('DOUYIN_INVALID', '开关值无效', '请选择开启或关闭。');
      if (!matches(context) || disposed) return stale();
      if (value && active) return busy();
      if (!value) { const result = await cancel(); if (!result.ok) return result; if (transitionDepth) return transitioning(); if (!matches(context) || disposed) return stale(); }
      try { write(context, 'settings.json', { enabled: value }); return view(context); } catch { return ioError(); }
    },
    async beginLogin(context) {
      if (transitionDepth) return transitioning();
      if (!matches(context) || disposed) return stale(); if (active) return busy();
      try { if (!enabled(context)) return error('DOUYIN_DISABLED', '抖音渠道未开启', '先开启抖音渠道。'); } catch { return ioError(); }
      candidate = null; lastError = null; pageState = 'login_required';
      let op; try { op = makeOp(context, 'login'); } catch { return error('DOUYIN_BROWSER_FAILED', '创建独立浏览器失败', '检查浏览器和资料目录后重试。'); } const result = await start(op);
      if (!result.ok) { if (current(op)) return finish(op, result); return result; }
      let snap; try { snap = await op.browser.snapshot(); } catch { return error('DOUYIN_BROWSER_FAILED', '读取浏览器状态失败', '检查浏览器后重试。'); } if (!current(op)) return stale();
      if (!snap?.ok) { lastError = snap || auth(); return lastError; }
      if (!expectedPage(snap)) return unexpectedPage();
      if (!candidate && /验证|验证码|安全检查|captcha|verify/i.test(`${snap.title} ${snap.text}`)) pageState = 'verification_required';
      return view(context);
    },
    async confirmAccount({ candidateId, ...context } = {}) {
      if (transitionDepth) return transitioning();
      if (!matches(context) || disposed) return stale(); const op = active;
      if (!op || op.kind !== 'login' || op.confirming || !current(op)) return busy();
      if (!candidate || candidate.id !== candidateId || candidate.gen !== op.gen) return error('DOUYIN_CANDIDATE_MISMATCH', '登录账号候选已失效', '重新检查浏览器中的账号后确认。');
      op.confirming = true;
      let snap; try { snap = await op.browser.snapshot(); } catch { op.confirming = false; return error('DOUYIN_BROWSER_FAILED', '读取浏览器状态失败', '检查浏览器后重试。'); }
      if (!current(op) || active !== op) return stale();
      if (!snap?.ok) { op.confirming = false; return snap || auth(); }
      if (!expectedPage(snap)) { op.confirming = false; return unexpectedPage(); }
      if (!candidate || candidate.id !== candidateId || candidate.gen !== op.gen) { op.confirming = false; return error('DOUYIN_CANDIDATE_MISMATCH', '登录账号候选已失效', '重新检查浏览器中的账号后确认。'); }
      try { write(context, 'account.json', { identity: candidate.identity }); } catch { op.confirming = false; return ioError(); }
      candidate = null; const result = await stop(op); if (!result.ok) return result; if (!current(op)) return stale(); candidate = null; pageState = 'idle'; return view(context);
    },
    async readFeed(context) {
      if (transitionDepth) return transitioning();
      if (!matches(context) || disposed) return stale(); if (active) return busy();
      let account; try { if (!enabled(context)) return error('DOUYIN_DISABLED', '抖音渠道未开启', '先开启抖音渠道。'); account = binding(context)?.identity; } catch { return ioError(); }
      if (!account) return auth();
      let op; try { op = makeOp(context, 'feed', account); } catch { return error('DOUYIN_BROWSER_FAILED', '创建独立浏览器失败', '检查浏览器和资料目录后重试。'); } pageState = 'reading'; let result = await start(op);
      if (!result.ok) return current(op) ? finish(op, result) : result;
      const first = await findEvent(op, SELF, 0); if (!first.ok) return finish(op, first);
      if (!same(first.identity, account)) return finish(op, error('DOUYIN_ACCOUNT_CHANGED', '当前登录账号与绑定账号不一致', '重新登录并确认账号。'));
      let state = browserStatus(op); if (!state.ok || !state.running) return finish(op, state.ok ? auth() : state);
      let cutoff = state.requestSeq; op.identityCutoff = cutoff; result = await navigate(op); if (!result.ok) return finish(op, result);
      const feed = await findEvent(op, FEED, cutoff); if (!feed.ok) return finish(op, feed);
      const afterFeed = await findEvent(op, SELF, cutoff); if (!afterFeed.ok) return finish(op, afterFeed);
      if (!same(afterFeed.identity, account)) return finish(op, error('DOUYIN_ACCOUNT_CHANGED', '读取时登录账号发生变化', '重新登录并确认账号。'));
      state = browserStatus(op); if (!state.ok || !state.running) return finish(op, state.ok ? auth() : state);
      cutoff = state.requestSeq; result = await navigate(op); if (!result.ok) return finish(op, result);
      const after = await findEvent(op, SELF, cutoff); if (!after.ok) return finish(op, after);
      if (!same(after.identity, account)) return finish(op, error('DOUYIN_ACCOUNT_CHANGED', '读取后登录账号发生变化', '重新登录并确认账号。'));
      if (!Array.isArray(feed.items) || !feed.items.length) return finish(op, error('DOUYIN_FEED_EMPTY', '首页推荐为空', '检查首页内容和账号状态后重试。'));
      return finish(op, { ok: true, source: 'homepage-recommendation', items: feed.items.slice(0, 5) });
    },
    async closeLogin(context) { if (transitionDepth) return transitioning(); if (!matches(context) || disposed) return stale(); if (!active || active.kind !== 'login') return busy(); return cancel(); },
    async withTransition(action) {
      if (disposed) { const failure = stale(); throw Object.assign(new Error(failure.error), failure); }
      if (typeof action !== 'function') { const failure = error('DOUYIN_INVALID', '角色操作无效', '重试角色切换或恢复。'); throw Object.assign(new Error(failure.error), failure); }
      transitionDepth++;
      try {
        const result = await cancel();
        if (!result.ok) throw Object.assign(new Error(result.error), result);
        if (disposed) { const failure = stale(); throw Object.assign(new Error(failure.error), failure); }
        return await action();
      } finally { transitionDepth--; }
    },
    async invalidate() { return cancel(); },
    async dispose() { disposed = true; return cancel(); },
  };
}
