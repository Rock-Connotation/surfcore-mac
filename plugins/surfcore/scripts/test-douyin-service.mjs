import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDouyinService } from '../lib/douyin-service.mjs';

const SELF = '/aweme/v1/web/user/profile/self/', FEED = '/aweme/v1/web/tab/feed/';
const self = uid => ({ status_code: 0, user: { uid, sec_uid: 'sec', nickname: '测试' } });
const feed = { status_code: 0, aweme_list: Array.from({ length: 8 }, (_, i) => ({ aweme_id: String(i + 1), desc: '说明' })) };
const fail = (r, code) => { assert.equal(r.ok, false); assert.equal(r.code, code); assert.ok(r.error && r.hint); };
let config = {}, browsers = [], role = { id: 'role1', epoch: 1 };
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-service-test-'));
function browserFactory(opts) {
  let seq = 0, reloads = 0, recommendationLoads = 0, running = false;
  fs.mkdirSync(opts.profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(opts.profileDir, 'profile-sentinel'), 'preserve');
  const emit = (payload, pathname, n = ++seq, sessionId = 'session') => { seq = Math.max(seq, n); opts.onResponse(payload, { pathname, status: 200, requestSeq: n, sessionId, requestId: `r${n}`, requestStartedAt: n }); };
  const b = { opts, emit, get seq() { return seq; }, status: () => config.broken ? { ok: false, code: 'BROKEN', error: '连接失败', hint: '关闭浏览器' } : ({ ok: true, running, requestSeq: seq }),
    async start() { running = true; emit(self('123456'), SELF); return { ok: true }; },
    async reload() { reloads++; if (config.lateMismatch && reloads === 1) { emit(feed, FEED); emit(self('123456'), SELF); seq++; } else if (config.lateMismatch && reloads === 2) { emit(self('999999'), SELF, seq); emit(self('123456'), SELF); } else if (config.oldMismatch && reloads === 1) { emit(self('999999'), SELF, seq); emit(feed, FEED); emit(self('123456'), SELF); } else if (config.sequence && reloads === 1) { emit(feed, FEED); emit(self('123456'), SELF); emit(config.sequence === 'logout' ? { status_code: 0, is_login: false } : self('999999'), SELF); } else if (config.late && reloads === 1) { const old = seq; seq++; emit(feed, FEED, old); } else if (reloads === 1) { emit(config.feed ?? feed, FEED); emit(self(config.midUid ?? '123456'), SELF); } else emit(self(config.postUid ?? '123456'), SELF); return { ok: true }; },
    get recommendationLoads() { return recommendationLoads; },
    async loadRecommendations() { recommendationLoads++; if (config.failExtraRecommendations && recommendationLoads > 1) return { ok:false, code:'DOUYIN_VIDEO_NOT_ADVANCED', error:'重复翻页', hint:'身份复核只刷新首页' }; return this.reload(); },
    async snapshot() { if (config.invalidateOnSnapshot) { config.invalidateOnSnapshot = false; emit({ status_code: 0, is_login: false }, SELF); } return { ok: true, title: '请验证', text: '验证码', url: config.url ?? 'https://www.douyin.com/' }; },
    async close() { running = false; return config.closeFail ? { ok: false, code: 'CLOSE', error: '关闭失败', hint: '手动关闭' } : { ok: true }; } };
  browsers.push(b); return b;
}
const svc = createDouyinService({ stateDir, getCharacter: () => role, browserFactory, waitMs: 35 });
const ctx = () => ({ characterId: role.id, characterEpoch: role.epoch });
fail(await svc.readFeed(ctx()), 'DOUYIN_DISABLED');
assert.equal((await svc.setEnabled(true, ctx())).enabled, true);
let login = await svc.beginLogin(ctx());
assert.equal(login.candidate.nickname, '测试');
assert.doesNotMatch(JSON.stringify(login), /123456|sec|private/);
fail(await svc.confirmAccount({ ...ctx(), candidateId: 'wrong' }), 'DOUYIN_CANDIDATE_MISMATCH');
fail(await svc.readFeed(ctx()), 'DOUYIN_BUSY');
assert.equal((await svc.confirmAccount({ ...ctx(), candidateId: login.candidate.candidateId })).account.uidSuffix, '3456');
const accountPath = path.join(stateDir, 'characters/role1/douyin/account.json');
assert.equal(fs.statSync(accountPath).mode & 0o777, 0o600);
assert.equal((await svc.readFeed(ctx())).items.length, 5);
config = { failExtraRecommendations: true };
const singleLoad = await svc.readFeed(ctx()); assert.equal(singleLoad.ok,true,'final identity refresh must not paginate recommendations again'); assert.equal(browsers.at(-1).recommendationLoads,1);
config = { lateMismatch: true }; fail(await svc.readFeed(ctx()), 'DOUYIN_ACCOUNT_CHANGED');
config = { oldMismatch: true }; assert.equal((await svc.readFeed(ctx())).ok, true);
config = { sequence: 'other' }; fail(await svc.readFeed(ctx()), 'DOUYIN_ACCOUNT_CHANGED');
config = { sequence: 'logout' }; fail(await svc.readFeed(ctx()), 'DOUYIN_NEEDS_AUTH');
config = { broken: true }; fail(await svc.readFeed(ctx()), 'BROKEN');
config = { late: true }; fail(await svc.readFeed(ctx()), 'DOUYIN_FEED_UNAVAILABLE');
config = { midUid: '999999' }; fail(await svc.readFeed(ctx()), 'DOUYIN_ACCOUNT_CHANGED');
config = { postUid: '999999' }; fail(await svc.readFeed(ctx()), 'DOUYIN_ACCOUNT_CHANGED');
config = { feed: { status_code: 0, aweme_list: [] } }; fail(await svc.readFeed(ctx()), 'DOUYIN_FEED_EMPTY');
config = { feed: { something: true } }; fail(await svc.readFeed(ctx()), 'DOUYIN_FEED_INVALID');
config = {}; login = await svc.beginLogin(ctx());
let loginBrowser = browsers.at(-1), oldCandidate = login.candidate.candidateId;
loginBrowser.emit({ status_code: 0, is_login: false }, SELF);
assert.equal((await svc.status()).candidate, null);
fail(await svc.confirmAccount({ ...ctx(), candidateId: oldCandidate }), 'DOUYIN_CANDIDATE_MISMATCH');
loginBrowser.emit(self('999999'), SELF, 5);
loginBrowser.emit(self('123456'), SELF, 4);
assert.equal((await svc.status()).candidate.uidSuffix, '9999');
loginBrowser.emit(self('123456'), SELF, 6);
login = await svc.status();
assert.equal(login.candidate.uidSuffix, '3456');
config.invalidateOnSnapshot = true;
fail(await svc.confirmAccount({ ...ctx(), candidateId: login.candidate.candidateId }), 'DOUYIN_CANDIDATE_MISMATCH');
loginBrowser.emit(self('123456'), SELF, 8);
login = await svc.status();
assert.equal((await svc.confirmAccount({ ...ctx(), candidateId: login.candidate.candidateId })).ok, true);
assert.ok(fs.readdirSync(path.dirname(accountPath)).some(n => n.startsWith('account.json.backup-')));
config = { url: 'https://example.com/?secret=1' };
const outsideResult = await svc.beginLogin(ctx()); fail(outsideResult, 'DOUYIN_PAGE_UNEXPECTED');
assert.doesNotMatch(JSON.stringify(outsideResult), /example|secret|验证码/);
fail(await svc.status(), 'DOUYIN_PAGE_UNEXPECTED');
await svc.closeLogin(ctx()); config = {};
const old = ctx(); login = await svc.beginLogin(old); role = { id: 'role2', epoch: 2 };
fail(await svc.confirmAccount({ ...old, candidateId: login.candidate.candidateId }), 'DOUYIN_STALE');
assert.equal((await svc.status()).account, null);
await svc.invalidate();
assert.equal((await svc.setEnabled(true, ctx())).ok, true);
login = await svc.beginLogin(ctx());
const prior = browsers.at(-1); await svc.setEnabled(false, ctx()); prior.emit(self('123456'), SELF);
fail(await svc.confirmAccount({ ...ctx(), candidateId: login.candidate.candidateId }), 'DOUYIN_BUSY');
assert.equal((await svc.status()).candidate, null);
await svc.setEnabled(true, ctx()); await svc.beginLogin(ctx()); config = { closeFail: true };
fail(await svc.closeLogin(ctx()), 'CLOSE'); config = {}; assert.equal((await svc.dispose()).ok, true);
fail(await svc.status(), 'DOUYIN_STALE');
assert.ok(fs.existsSync(accountPath));
assert.equal(fs.readFileSync(path.join(stateDir, 'characters/role1/douyin/browser/profile-sentinel'), 'utf8'), 'preserve');
// A character directory symlink must not redirect state writes.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-outside-'));
fs.symlinkSync(outside, path.join(stateDir, 'characters', 'role3'));
role = { id: 'role3', epoch: 3 };
const guarded = createDouyinService({ stateDir, getCharacter: () => role, browserFactory });
fail(await guarded.setEnabled(true, ctx()), 'DOUYIN_STATE_ERROR');
assert.deepEqual(fs.readdirSync(outside), []);
role = { id: 'role2', epoch: 2 };
// Invalidation during startup must wait for and close only that owned browser.
let releaseStart, started, closed = 0, delayedCallback;
const delayed = createDouyinService({ stateDir, getCharacter: () => role, waitMs: 20, browserFactory: options => {
  delayedCallback = options.onResponse;
  return { start: () => new Promise(resolve => { releaseStart = resolve; started = true; }), close: async () => { closed++; return { ok: true }; }, status: () => ({ ok: true, running: true, requestSeq: 1 }), snapshot: async () => ({ ok: true, title: '', text: '' }) };
} });
await delayed.setEnabled(true, ctx());
const pending = delayed.beginLogin(ctx()); assert.equal(started, true);
const stopping = delayed.dispose();
delayedCallback(self('123456'), { pathname: SELF, status: 200, requestSeq: 1, sessionId: 'old' });
releaseStart({ ok: true });
fail(await pending, 'DOUYIN_STALE'); assert.equal((await stopping).ok, true); assert.equal(closed, 1);
// The transition gate spans every await of the host action.
config = {}; role = { id: 'role2', epoch: 2 };
const gated = createDouyinService({ stateDir, getCharacter: () => role, browserFactory, waitMs: 20 });
await gated.beginLogin(ctx());
const beforeCount = browsers.length, beforeSettings = fs.readFileSync(path.join(stateDir, 'characters/role2/douyin/settings.json'), 'utf8');
let releaseTransition, inside;
const gate = gated.withTransition(async () => { inside = true; await new Promise(resolve => { releaseTransition = resolve; }); role = { id: 'role4', epoch: 4 }; });
fail(await gated.beginLogin(ctx()), 'DOUYIN_TRANSITION');
await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(inside, true);
fail(await gated.readFeed(ctx()), 'DOUYIN_TRANSITION');
fail(await gated.setEnabled(false, ctx()), 'DOUYIN_TRANSITION');
fail(await gated.confirmAccount({ ...ctx(), candidateId: 'x' }), 'DOUYIN_TRANSITION');
assert.equal(browsers.length, beforeCount);
assert.equal(fs.readFileSync(path.join(stateDir, 'characters/role2/douyin/settings.json'), 'utf8'), beforeSettings);
releaseTransition(); await gate;
assert.equal((await gated.setEnabled(true, ctx())).ok, true);
assert.equal((await gated.beginLogin(ctx())).ok, true);
await gated.closeLogin(ctx());
let releaseNested;
const outer = gated.withTransition(async () => { await gated.withTransition(async () => {}); await new Promise(resolve => { releaseNested = resolve; }); });
await new Promise(resolve => setTimeout(resolve, 0));
fail(await gated.beginLogin(ctx()), 'DOUYIN_TRANSITION');
releaseNested(); await outer;
let releaseA, releaseB;
const firstGate = gated.withTransition(() => new Promise(resolve => { releaseA = resolve; }));
const secondGate = gated.withTransition(() => new Promise(resolve => { releaseB = resolve; }));
await new Promise(resolve => setTimeout(resolve, 0));
releaseA(); await firstGate;
fail(await gated.beginLogin(ctx()), 'DOUYIN_TRANSITION');
releaseB(); await secondGate;
await assert.rejects(gated.withTransition(async () => { throw new Error('host failed'); }), /host failed/);
assert.equal((await gated.beginLogin(ctx())).ok, true);
config = { closeFail: true };
await assert.rejects(gated.withTransition(async () => { throw new Error('must not run'); }), e => e.code === 'CLOSE' && !!e.hint);
config = {}; assert.equal((await gated.closeLogin(ctx())).ok, true);
await gated.dispose();
await assert.rejects(gated.withTransition(async () => {}), e => e.code === 'DOUYIN_STALE' && !!e.hint);
// --- readOfficialIdentity: frozen official current-account getter (HY4-DOUYIN-IDENTITY) ---
// Independent fake browser controls requestSeq / sessionId / close without touching the
// existing readFeed/login harness above.
const ID_OWNER = '123456';
const ID_OWNER_KEY = createHash('sha256').update(`douyin:${ID_OWNER}`).digest('hex');
const idStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-identity-test-'));
let idRole = { id: 'idrole1', epoch: 1 };
let idConfig = {}, idBrowsers = [];
const idCtx = () => ({ characterId: idRole.id, characterEpoch: idRole.epoch });
const idDir = path.join(idStateDir, 'characters', 'idrole1', 'douyin');
fs.mkdirSync(idDir, { recursive: true });
fs.writeFileSync(path.join(idDir, 'settings.json'), JSON.stringify({ enabled: true }));
const idBindingBytes = JSON.stringify({ identity: { uid: ID_OWNER, secUid: 'sec', nickname: '测试', accountKey: ID_OWNER_KEY } });
fs.writeFileSync(path.join(idDir, 'account.json'), idBindingBytes);
const idSettingsBytes = fs.readFileSync(path.join(idDir, 'settings.json'), 'utf8');

function idBrowserFactory(opts) {
  let seq = 0, running = false;
  fs.mkdirSync(opts.profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(opts.profileDir, 'profile-sentinel'), 'preserve');
  const emit = (payload, pathname, n = ++seq, sessionId = 'identity-session') => {
    seq = Math.max(seq, n);
    opts.onResponse(payload, { pathname, status: 200, requestSeq: n, sessionId, requestId: `id${n}`, requestStartedAt: n });
  };
  const b = {
    opts, emit, calls: { start: 0, reload: 0, loadRecommendations: 0, close: 0 },
    get seq() { return seq; },
    status: () => idConfig.broken ? { ok: false, code: 'BROKEN', error: '连接失败', hint: '关闭浏览器' } : ({ ok: true, running, requestSeq: seq }),
    async start() {
      running = true; b.calls.start++;
      emit(idConfig.startPayload ?? self(idConfig.startUid ?? ID_OWNER), idConfig.startPath ?? SELF);
      return idConfig.startResult ?? { ok: true };
    },
    async reload() {
      b.calls.reload++;
      const plan = idConfig.reloadPlan ?? 'fresh';
      if (plan === 'none') return { ok: true };
      if (plan === 'feedOnly') { emit(feed, FEED); return { ok: true }; }
      if (plan === 'oldSeq') { emit(self(ID_OWNER), SELF, 1); return { ok: true }; }
      if (plan === 'crossSession') { emit(self(ID_OWNER), SELF, seq + 1, 'other-session'); return { ok: true }; }
      if (plan === 'switch') { emit(self('999999'), SELF); return { ok: true }; }
      if (plan === 'switchAfter') { emit(self(ID_OWNER), SELF); emit(self('999999'), SELF); return { ok: true }; }
      if (plan === 'logout') { emit({ status_code: 0, is_login: false }, SELF); return { ok: true }; }
      if (plan === 'roleChange') { idRole = { id: 'idrole2', epoch: 2 }; emit(self(ID_OWNER), SELF); return { ok: true }; }
      emit(self(ID_OWNER), SELF);
      return { ok: true };
    },
    async loadRecommendations() { b.calls.loadRecommendations++; return this.reload(); },
    async snapshot() { return { ok: true, title: '', text: '', url: 'https://www.douyin.com/' }; },
    async close() { running = false; b.calls.close++; return idConfig.closeFail ? { ok: false, code: 'CLOSE', error: '关闭失败', hint: '手动关闭' } : { ok: true }; },
  };
  idBrowsers.push(b); return b;
}
const idSvc = createDouyinService({ stateDir: idStateDir, getCharacter: () => idRole, browserFactory: idBrowserFactory, waitMs: 30 });

assert.equal(typeof idSvc.readOfficialIdentity, 'function', 'readOfficialIdentity must be exported');
// 1. Success: exact minimal identity from a fresh SELF, nothing private, nothing written.
idConfig = {};
const idOk = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idOk.ok, true);
assert.deepEqual(Object.keys(idOk).sort(), ['accountId', 'ok', 'verified']);
assert.equal(idOk.verified, true);
assert.equal(idOk.accountId, ID_OWNER_KEY);
assert.match(idOk.accountId, /^[0-9a-f]{64}$/);
for (const key of ['uid', 'secUid', 'nickname', 'accountKey', 'identity', 'cookie', 'raw']) assert.equal(Object.hasOwn(idOk, key), false);
const idB1 = idBrowsers.at(-1);
assert.equal(idB1.calls.start, 1);
assert.equal(idB1.calls.reload, 1);
assert.equal(idB1.calls.loadRecommendations, 0);
assert.equal(idB1.calls.close, 1);
assert.equal(fs.readFileSync(path.join(idDir, 'account.json'), 'utf8'), idBindingBytes);
assert.equal(fs.readFileSync(path.join(idDir, 'settings.json'), 'utf8'), idSettingsBytes);
assert.equal(fs.existsSync(path.join(idB1.opts.profileDir, 'profile-sentinel')), true);
// 2. status() keeps its public projection: no raw identity leaks.
const idStatus = await idSvc.status();
assert.equal(idStatus.ok, true);
assert.deepEqual(Object.keys(idStatus.account).sort(), ['configured', 'nickname', 'uidSuffix']);
for (const key of ['uid', 'secUid', 'accountKey', 'accountId']) assert.equal(Object.hasOwn(idStatus.account, key), false);
// 3. Stored binding alone is insufficient: no new SELF after cutoff.
idConfig = { reloadPlan: 'none' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_NEEDS_AUTH');
// 4. Non-SELF response after cutoff is not proof.
idConfig = { reloadPlan: 'feedOnly' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_NEEDS_AUTH');
// 5. Old-seq replay is not proof.
idConfig = { reloadPlan: 'oldSeq' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_NEEDS_AUTH');
// 6. Cross-session SELF is not proof.
idConfig = { reloadPlan: 'crossSession' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_NEEDS_AUTH');
// 7. Account switch on the fresh SELF is blocked.
idConfig = { reloadPlan: 'switch' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_ACCOUNT_CHANGED');
// 8. Switch AFTER a valid fresh SELF is still blocked (late identityFailure overrides).
idConfig = { reloadPlan: 'switchAfter' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_ACCOUNT_CHANGED');
// 9. Lost login on the fresh SELF is blocked.
idConfig = { reloadPlan: 'logout' };
const idLogout = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idLogout.ok, false); assert.notEqual(idLogout.verified, true); assert.ok(idLogout.code && idLogout.error && idLogout.hint);
// 10. Mismatch on the initial SELF is blocked.
idConfig = { startUid: '999999' };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_ACCOUNT_CHANGED');
// 11. Non-SELF initial response is not proof.
idConfig = { startPath: FEED, startPayload: feed };
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_NEEDS_AUTH');
// 12. Concurrent active operation is refused.
idConfig = {};
assert.equal((await idSvc.beginLogin(idCtx())).ok, true);
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_BUSY');
assert.equal((await idSvc.closeLogin(idCtx())).ok, true);
// 13. Role/epoch change mid-op is refused.
idConfig = { reloadPlan: 'roleChange' };
const idRoleChanged = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idRoleChanged.ok, false); assert.notEqual(idRoleChanged.verified, true); assert.ok(idRoleChanged.hint);
idRole = { id: 'idrole1', epoch: 1 };
// 14. Transition gate is refused.
idConfig = {};
let idRelease;
const idGate = idSvc.withTransition(async () => { await new Promise(resolve => { idRelease = resolve; }); });
fail(await idSvc.readOfficialIdentity(idCtx()), 'DOUYIN_TRANSITION');
idRelease(); await idGate;
// 15. Browser start failure is surfaced.
idConfig = { startResult: { ok: false, code: 'START_FAIL', error: '启动失败', hint: '检查浏览器' } };
const idStartFail = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idStartFail.ok, false); assert.notEqual(idStartFail.verified, true); assert.ok(idStartFail.hint);
// 16. Broken browser status is surfaced.
idConfig = { broken: true };
const idBroken = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idBroken.ok, false); assert.notEqual(idBroken.verified, true); assert.ok(idBroken.hint);
// 17. Close failure is propagated and never becomes verified:true.
idConfig = { closeFail: true };
const idCloseFail = await idSvc.readOfficialIdentity(idCtx());
assert.equal(idCloseFail.ok, false);
assert.equal(idCloseFail.code, 'CLOSE');
assert.notEqual(idCloseFail.verified, true);
assert.ok(idCloseFail.error && idCloseFail.hint);
idConfig = {};
assert.equal((await idSvc.invalidate()).ok, true);
// 18. Disposed service is refused.
const idDisposedSvc = createDouyinService({ stateDir: idStateDir, getCharacter: () => idRole, browserFactory: idBrowserFactory, waitMs: 30 });
assert.equal((await idDisposedSvc.dispose()).ok, true);
fail(await idDisposedSvc.readOfficialIdentity(idCtx()), 'DOUYIN_STALE');
console.log('douyin service: ok');
