import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createDouyinBrowser } from '../lib/douyin-browser.mjs';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'douyin-browser-test-'));
const profile = path.join(root, 'profile');
const endpoint = 'https://www.douyin.com/aweme/v1/web/tab/feed/?private=hidden';
const home = 'https://www.douyin.com/?recommend=1&from_nav=1';
class FakePage {
  urls = []; keys = []; text = ''; editable = false; tutorialClicked = false;
  source = 'fixture:video-0'; sourceSequence = 0; playerReady = true; hydrated = true; keyBeforeHydration = false;
  keyboard = { press: async key => { this.keys.push(key); await this.onKey?.(); if(this.dropInitialKey && this.keys.length===1)return; if(this.lateGuide && !this.didLateGuide){this.didLateGuide=true;this.text='滚动“鼠标”或点按“键盘上下键”查看更多推荐视频';return;} if (!this.hydrated) this.keyBeforeHydration = true; if (this.hydrated && !this.blockAdvance) this.source = `fixture:video-${++this.sourceSequence}`; } };
  async goto(url) { this.urls.push(url); if (this.hydrationText) { this.text = ''; this.playerReady = false; this.hydrated = false; setImmediate(() => { this.text = this.hydrationText; this.playerReady = true; this.hydrated = true; }); } }
  async waitForFunction(fn, arg) {
    if (this.waitGate) await this.waitGate;
    await this.onWait?.(arg);
    let clock = 0;
    const box = () => ({ x: 0, y: 0, width: 1000, height: 700, right: 1000, bottom: 700 });
    const v = { getBoundingClientRect: box, closest: selector => selector === '#quickPlayer' && page.quickPlayer ? {} : null, get currentSrc() { return page.source; }, get readyState() { return page.playerReady ? 4 : 0; } };
    const page = this;
    const offscreen = { currentSrc:'fixture:preloaded', readyState:4, getBoundingClientRect:()=>({x:0,y:801,width:1000,height:700,right:1000,bottom:1501}) };
    const sandbox = { document: { querySelectorAll: () => [offscreen,v], body:{get innerText(){return page.text;}} }, innerWidth:1280, innerHeight:800, getComputedStyle: () => ({display:'block',visibility:'visible'}), performance: {now:()=>clock}, requestAnimationFrame: cb => setImmediate(()=>{clock+=100;cb(clock);}) };
    const predicate = vm.runInNewContext(`(${fn.toString()})`, sandbox);
    for (let i=0;i<20;i++) { const value = predicate(arg); assert(!value || typeof value.then !== 'function','polling predicate must be synchronous like the real SDK'); if (value) return { jsonValue:async()=>JSON.parse(JSON.stringify(value)), dispose:async()=>{} }; await new Promise(r=>setImmediate(r)); clock += 100; }
    throw Object.assign(new Error('fixture timeout'),{name:'TimeoutError'});
  }
  async close() { this.closed = true; }
  isClosed() { return false; }
  async evaluate(fn) { return fn.toString().includes('navigator.userAgent') ? 'Mozilla/5.0 Test Chrome/156.0.0.0' : fn.toString().includes('activeElement') ? this.editable : { title: '抖音', url: 'https://www.douyin.com/', text: this.text }; }
  getByRole(role, options) { assert.equal(role,'button'); assert.equal(options.name,'我知道了'); assert.equal(options.exact,true); return { isVisible: async () => !this.missingGuideButton, click: async () => { this.tutorialClicked = true; if (!this.keepGuide) this.text = ''; }, waitFor:async({state})=>{ if(state==='visible'&&this.missingGuideButton)throw new Error('guide absent'); if(state==='hidden'&&this.keepGuide)throw new Error('guide remains'); } }; }
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
const firstNavigation = await browser.loadRecommendations(); assert.equal(firstNavigation.keyStepsSent,8); assert.match(firstNavigation.mediaUserAgent,/^Mozilla\//); assert(ctx.page.tutorialClicked); assert.equal(ctx.page.keys.length,8); assert.equal(ctx.page.urls.at(-1),home);
ctx.page.hydrationText = '滚动“鼠标”或点按“键盘上下键”查看更多推荐视频'; ctx.page.tutorialClicked = false;
const hydrated = await browser.loadRecommendations();
assert.equal(hydrated.ok,true); assert(ctx.page.tutorialClicked,'late guide must be dismissed after hydration'); assert.equal(ctx.page.keyBeforeHydration,false,'never send keys before the player is ready');
ctx.page.hydrationText = ''; ctx.page.text = ''; ctx.page.quickPlayer = true;
const beforePreviewKeys = ctx.page.keys.length, previewOnly = await browser.loadRecommendations();
assert.equal(previewOnly.code, 'DOUYIN_PAGE_NOT_READY'); assert(previewOnly.hint); assert.equal(ctx.page.keys.length, beforePreviewKeys, 'SSR quickPlayer cannot prove interactive recommendation readiness'); ctx.page.quickPlayer = false;
ctx.page.hydrationText = ''; ctx.page.text = '滚动“鼠标”或点按“键盘上下键”查看更多推荐视频'; ctx.page.keepGuide = true;
const beforeGuideKeys = ctx.page.keys.length, guideFailure = await browser.loadRecommendations();
assert.equal(guideFailure.code,'DOUYIN_TUTORIAL_NOT_DISMISSED'); assert(guideFailure.error && guideFailure.hint); assert.equal(ctx.page.keys.length,beforeGuideKeys); ctx.page.keepGuide = false;
ctx.page.text = ''; ctx.page.playerReady = false; const beforeReadyKeys = ctx.page.keys.length, notReady = await browser.loadRecommendations();
assert.equal(notReady.code,'DOUYIN_PAGE_NOT_READY'); assert(notReady.error && notReady.hint); assert.equal(ctx.page.keys.length,beforeReadyKeys); ctx.page.playerReady = true;
ctx.page.blockAdvance = true; const beforeAdvanceKeys = ctx.page.keys.length, notAdvanced = await browser.loadRecommendations();
assert.equal(notAdvanced.code,'DOUYIN_VIDEO_NOT_ADVANCED'); assert(notAdvanced.error && notAdvanced.hint); assert.equal(ctx.page.keys.length,beforeAdvanceKeys+2,'only one initial recovery is allowed, then stop on an unconfirmed transition'); ctx.page.blockAdvance = false;
const beforeEditableKeys = ctx.page.keys.length;
ctx.page.text = '请完成安全验证'; const verification = await browser.loadRecommendations(); assert.equal(verification.code,'DOUYIN_VERIFICATION_REQUIRED'); assert(verification.hint);
ctx.page.text = ''; ctx.page.editable = true; assert.equal((await browser.loadRecommendations()).keyStepsSent,0); assert.equal(ctx.page.keys.length,beforeEditableKeys);
// A guide mounted after the key can block one input; recovery is bounded to one extra key.
const lateGuideBrowser = createDouyinBrowser({profileDir:path.join(root,'late-guide'),browserPath:'/fake/chrome',launchPersistentContext:launch,timeouts:{command:1000,close:30}});
assert((await lateGuideBrowser.start()).ok); const lateGuideContext=contexts.at(-1); lateGuideContext.page.lateGuide=true;
const lateGuideResult=await lateGuideBrowser.loadRecommendations(); assert.equal(lateGuideResult.ok,true); assert.equal(lateGuideResult.keyStepsSent,9); assert.equal(lateGuideContext.page.keys.length,9); assert(lateGuideContext.page.tutorialClicked); assert((await lateGuideBrowser.close()).ok);
// A single initial lost key recovers; a fresh fixed feed stops traversal at once.
ctx.page.editable=false; ctx.page.keys=[]; ctx.page.dropInitialKey=true;
ctx.page.onKey=async()=>{if(ctx.page.keys.length===6){emit(endpoint,{data:'{"status_code":0,"aweme_list":[{"aweme_id":"1"}]}'});await new Promise(r=>setImmediate(r));}};
const recovered=await browser.loadRecommendations(); assert.equal(recovered.ok,true); assert.equal(recovered.keyStepsSent,6,'five confirmed transitions and one recovered initial key');
ctx.page.onKey=undefined; ctx.page.dropInitialKey=false;
// Old receipt cannot stop a new operation, and later failures never get recovery keys.
ctx.page.keys=[]; const cap=await browser.loadRecommendations(); assert.equal(cap.keyStepsSent,8);
ctx.page.keys=[]; ctx.page.onKey=async()=>{if(ctx.page.keys.length===2)ctx.page.blockAdvance=true;};
const laterFailure=await browser.loadRecommendations(); assert.equal(laterFailure.code,'DOUYIN_VIDEO_NOT_ADVANCED'); assert.equal(ctx.page.keys.length,2); ctx.page.onKey=undefined;ctx.page.blockAdvance=false;
// A receipt arriving during readiness must prevent another input; one arriving
// after a non-advancing key still completes, without bypassing cancellation.
const fresh=async()=>{emit(endpoint,{data:'{"status_code":0,"aweme_list":[{"aweme_id":"2"}]}'});await new Promise(r=>setImmediate(r));};
ctx.page.keys=[];let waits=0;ctx.page.onWait=async()=>{if(++waits===4){await fresh();ctx.page.blockAdvance=true;}};
const between=await browser.loadRecommendations();assert.equal(between.ok,true,JSON.stringify(between));assert.equal(between.keyStepsSent,1);ctx.page.onWait=undefined;ctx.page.blockAdvance=false;
ctx.page.keys=[];ctx.page.onKey=async()=>{if(ctx.page.keys.length===2){await fresh();ctx.page.blockAdvance=true;}};
const atFailedAdvance=await browser.loadRecommendations();assert.equal(atFailedAdvance.ok,true);assert.equal(atFailedAdvance.keyStepsSent,2);ctx.page.onKey=undefined;ctx.page.blockAdvance=false;
// A timed-out command must not resume input when its pending readiness wait resolves.
const expiredBrowser = createDouyinBrowser({profileDir:path.join(root,'expired-command'),browserPath:'/fake/chrome',launchPersistentContext:launch,timeouts:{command:15,close:30}});
assert((await expiredBrowser.start()).ok); const expiredContext = contexts.at(-1); let releaseWait;
expiredContext.page.waitGate = new Promise(resolve=>{releaseWait=resolve;});
const expiredCommand = await expiredBrowser.loadRecommendations(); assert.equal(expiredCommand.code,'BROWSER_TIMEOUT');
releaseWait(); await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(expiredContext.page.keys.length,0,'timed-out command must not send late keys');
assert((await expiredBrowser.close()).ok);
// Close timeout keeps ownership, but never permits the in-flight action to send input.
const closingBrowser = createDouyinBrowser({profileDir:path.join(root,'closing-command'),browserPath:'/fake/chrome',launchPersistentContext:launch,timeouts:{command:500,close:15}});
assert((await closingBrowser.start()).ok); const closingContext = contexts.at(-1); let releaseClosingWait;
closingContext.page.waitGate = new Promise(resolve=>{releaseClosingWait=resolve;});
const closingCommand = closingBrowser.loadRecommendations(); await new Promise(resolve=>setImmediate(resolve)); closingContext.blockClose=true;
assert.equal((await closingBrowser.close()).code,'BROWSER_CLOSE_TIMEOUT'); releaseClosingWait(); await closingCommand;
assert.equal(closingContext.page.keys.length,0,'closing command must not send late keys'); closingContext.finishClose(); await new Promise(resolve=>setImmediate(resolve));
const beforeLateBodies = bodies.length, late = emit(endpoint,{delayed:true}); await new Promise(r=>setImmediate(r));
fs.writeFileSync(path.join(profile,'login-data'),'keep'); ctx.blockClose = true;
const timed = await browser.close(); assert.equal(timed.code,'BROWSER_CLOSE_TIMEOUT'); assert(timed.hint); assert(fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal((await duplicate.start()).code,'PROFILE_LOCKED');
late(); await new Promise(r=>setImmediate(r)); assert.equal(bodies.length,beforeLateBodies);
ctx.emit('close'); assert(fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal((await duplicate.start()).code,'PROFILE_LOCKED');
ctx.finishClose(); await new Promise(r=>setImmediate(r)); assert(!fs.existsSync(path.join(profile,'.surfcore-douyin.lock'))); assert.equal(fs.readFileSync(path.join(profile,'login-data'),'utf8'),'keep');
assert((await browser.start()).ok); ctx=contexts.at(-1); emit(endpoint); await new Promise(r=>setImmediate(r)); assert.equal(bodies.length,beforeLateBodies+1); assert.notEqual(bodies[0].meta.sessionId,bodies.at(-1).meta.sessionId); assert((await browser.close()).ok);
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
