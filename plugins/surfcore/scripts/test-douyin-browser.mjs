import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDouyinBrowser } from '../lib/douyin-browser.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'douyin-browser-test-'));
const profile = path.join(root, 'profile');
const endpoint = 'https://www.douyin.com/aweme/v1/web/tab/feed/?private=hidden';
const home = 'https://www.douyin.com/?recommend=1&from_nav=1';
class FakePage {
  urls = []; keys = []; text = ''; editable = false; tutorialClicked = false;
  keyboard = { press: async key => this.keys.push(key) };
  async goto(url) { this.urls.push(url); }
  async close() { this.closed = true; }
  isClosed() { return false; }
  async evaluate(fn) { return fn.toString().includes('activeElement') ? this.editable : { title: '抖音', url: 'https://www.douyin.com/', text: this.text }; }
  getByRole() { return { isVisible: async () => true, click: async () => { this.tutorialClicked = true; } }; }
  async screenshot() { if (this.failScreenshot) throw Object.assign(new Error('private secret'), {code:'EIO'}); return Buffer.from('jpeg'); }
}
class FakeContext extends EventEmitter {
  page = new FakePage(); extraPage = new FakePage(); blockClose = false;
  pages() { return [this.page, this.extraPage]; }
  async route(pattern, fn) { this.routePattern = pattern; this.routeHandler = fn; }
  async close() { this.closeCalls = (this.closeCalls || 0) + 1; if (this.blockClose) return new Promise((resolve, reject) => { this.finishClose = resolve; this.rejectClose = reject; }); this.emit('close'); }
}
const contexts = [], launches = [], bodies = [], metadata = [];
const launch = async (dir, options) => { launches.push({dir, options}); const ctx = new FakeContext(); contexts.push(ctx); return ctx; };
const browser = createDouyinBrowser({profileDir: profile, browserPath:'/fake/chrome', launchPersistentContext:launch, timeouts:{close:30, command:1000}, onResponse:(body, meta)=>bodies.push({body,meta}), onRequest:meta=>metadata.push(meta)});
assert((await browser.start()).ok);
let ctx = contexts.at(-1);
assert.equal(ctx.page.urls[0], home); assert.equal(ctx.routePattern, '**/*'); assert(ctx.extraPage.closed);
assert.deepEqual(launches[0].options.args, ['--restore-last-session']); if (process.platform === 'darwin') assert.deepEqual(launches[0].options.ignoreDefaultArgs, ['--password-store=basic', '--use-mock-keychain']);
assert.equal(launches[0].options.serviceWorkers, 'block'); assert.equal(launches[0].options.env.DEBUG, undefined); assert.equal(launches[0].options.env.PWDEBUG, undefined); assert.equal(launches[0].options.viewport.width,1280);
assert.equal(fs.statSync(profile).mode & 0o077, 0);
const duplicate = createDouyinBrowser({profileDir:profile, browserPath:'/fake/chrome', launchPersistentContext:launch});
assert.equal((await duplicate.start()).code,'PROFILE_LOCKED');
function emit(url, { redirect = false, serviceWorker = false, size = 4, data = '{"ok":true}', missing = false, delayed = false } = {}) {
  const req = {url:()=>url, redirectedFrom:()=>redirect ? {} : null, redirectedTo:()=>null, sizes:async()=>({responseBodySize:size})};
  let resolveBody;
  const res = {request:()=>req, url:()=>url, status:()=>200, fromServiceWorker:()=>serviceWorker, body:()=> delayed ? new Promise(r=>{resolveBody=r;}) : Promise.resolve(Buffer.from(data))};
  if (!missing) ctx.emit('request',req);
  ctx.emit('response',res);
  return () => resolveBody?.(Buffer.from(data));
}
emit(endpoint); emit(endpoint,{serviceWorker:true}); emit(endpoint,{redirect:true}); emit(endpoint,{missing:true}); emit(endpoint,{size:9*1024*1024}); emit(endpoint,{size:1,data:' '.repeat(8*1024*1024+1)}); emit('https://www.douyin.com/aweme/v1/web/related/feed/'); emit('https://evil.test/aweme/v1/web/tab/feed/');
await new Promise(r=>setImmediate(r));
assert.equal(bodies.length,1); assert.equal(bodies[0].body.ok,true); assert(bodies[0].meta.requestSeq > 0); assert(bodies[0].meta.requestStartedAt > 0); assert(bodies[0].meta.requestId); assert(bodies[0].meta.sessionId); assert(!JSON.stringify(metadata).includes('private'));
assert(metadata.every(x=>x.sessionId===bodies[0].meta.sessionId));
assert.equal((await browser.snapshot()).url,'https://www.douyin.com/');
assert.equal((await browser.screenshot()).mimeType,'image/jpeg');
ctx.page.failScreenshot = true; const failedScreenshot = await browser.screenshot(); assert.equal(failedScreenshot.code, 'BROWSER_ERROR'); assert(failedScreenshot.hint && !failedScreenshot.error.includes('secret')); ctx.page.failScreenshot = false;
ctx.page.text = '滚动“鼠标”或点按“键盘上下键”查看更多推荐视频';
assert.equal((await browser.loadRecommendations()).keyStepsSent,4); assert(ctx.page.tutorialClicked); assert.equal(ctx.page.keys.length,4); assert.equal(ctx.page.urls.at(-1),home);
ctx.page.text = '请完成安全验证'; const verification = await browser.loadRecommendations(); assert.equal(verification.code,'DOUYIN_VERIFICATION_REQUIRED'); assert(verification.hint);
ctx.page.text = ''; ctx.page.editable = true; assert.equal((await browser.loadRecommendations()).keyStepsSent,0); assert.equal(ctx.page.keys.length,4);
const late = emit(endpoint,{delayed:true}); await new Promise(r=>setImmediate(r));
fs.writeFileSync(path.join(profile,'login-data'),'keep'); ctx.blockClose = true;
const timed = await browser.close(); assert.equal(timed.code,'BROWSER_CLOSE_TIMEOUT'); assert(timed.hint); assert(fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal((await duplicate.start()).code,'PROFILE_LOCKED');
late(); await new Promise(r=>setImmediate(r)); assert.equal(bodies.length,1);
ctx.emit('close'); assert(fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal((await duplicate.start()).code,'PROFILE_LOCKED');
ctx.finishClose(); await new Promise(r=>setImmediate(r)); assert(!fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal(fs.readFileSync(path.join(profile,'login-data'),'utf8'),'keep');
assert((await browser.start()).ok); ctx=contexts.at(-1); emit(endpoint); await new Promise(r=>setImmediate(r)); assert.equal(bodies.length,2); assert.notEqual(bodies[0].meta.sessionId,bodies[1].meta.sessionId); assert((await browser.close()).ok);
const disconnectedProfile = path.join(root, 'disconnected');
const disconnectedBrowser = createDouyinBrowser({profileDir:disconnectedProfile,browserPath:'/fake/chrome',launchPersistentContext:launch,timeouts:{close:30}});
assert((await disconnectedBrowser.start()).ok); const disconnectedContext = contexts.at(-1);
disconnectedContext.emit('close');
assert.equal(disconnectedBrowser.status().code,'BROWSER_DISCONNECTED');
const unknown = await disconnectedBrowser.close(); assert.equal(unknown.code,'BROWSER_UNKNOWN_EXIT'); assert(unknown.error && unknown.hint); assert.equal(disconnectedContext.closeCalls,undefined);
assert(fs.existsSync(path.join(disconnectedProfile,'.surfcore-douyin.lock'))); assert.equal((await disconnectedBrowser.start()).code,'BROWSER_DISCONNECTED');
const failedProfile = path.join(root,'failed-close');
const failedBrowser = createDouyinBrowser({profileDir:failedProfile,browserPath:'/fake/chrome',launchPersistentContext:launch,timeouts:{close:30}});
assert((await failedBrowser.start()).ok); const failedContext = contexts.at(-1); failedContext.blockClose = true;
const attempt = failedBrowser.close(); await new Promise(r=>setImmediate(r)); failedContext.emit('close'); failedContext.rejectClose(new Error('transport disconnected'));
const closeFailed = await attempt; assert.equal(closeFailed.code,'BROWSER_CLOSE_FAILED'); assert(closeFailed.hint); assert(fs.existsSync(path.join(failedProfile,'.surfcore-douyin.lock')));
assert.equal((await failedBrowser.close()).code,'BROWSER_CLOSE_FAILED'); assert.equal(failedContext.closeCalls,1);
const foreign = path.join(root,'foreign'); fs.mkdirSync(foreign,{mode:0o700}); fs.writeFileSync(path.join(foreign,'data'),'keep');
const result = await createDouyinBrowser({profileDir:foreign,browserPath:'/fake/chrome',launchPersistentContext:launch}).start(); assert.equal(result.code,'PROFILE_FOREIGN'); assert(result.hint);
const link = path.join(root,'link'); fs.symlinkSync(profile,link); assert.equal((await createDouyinBrowser({profileDir:link,browserPath:'/fake/chrome',launchPersistentContext:launch}).start()).code,'PROFILE_UNSAFE');
console.log('douyin browser mock tests passed');
