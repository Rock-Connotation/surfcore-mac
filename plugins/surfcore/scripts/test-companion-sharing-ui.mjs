import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';

let role = { id: 'alpha', epoch: 4, name: '小白鲸' }, activeOpening;
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const posts = [], postWaiters = [], errors = [], cancelledRequests = new Set();
let unread = true, replyGate = null, replyFailure = null, replyWrongCharacter = false, remoteActive = null, nextSharingGate = null, nextSharingFailure = null, nextCompanionGate = null, sharingGetCount = 0, companionGetCount = 0, failSharingModule = false, sharingModuleGate = null;
const opening = activeOpening = {
  id: 'opening-1', jobId: 'job-1', sourceId: 'BV1fixture', sourceTitle: '海边的小鱼',
  occurredAt: '2026-11-07T06:00:00.000Z',
  text: '我刚看到一群小鱼靠着礁石游过。<img src=x onerror=alert(1)>',
  question: '你觉得它们为什么停在那里？',
  coverage: { transcriptComplete: true, frameSamples: 3 }, unread: true,
};
let messages = [];
let stateRevision = 0, priorState = '';
function value() {
  const state = { openings: activeOpening ? [{ ...activeOpening, unread }] : [], messages: [...messages], active: remoteActive, unread: unread ? 1 : 0, lastError: null };
  const fingerprint = JSON.stringify({ role, ...state });
  if (fingerprint !== priorState) { stateRevision++; priorState = fingerprint; }
  return { revision: stateRevision, ...state };
}
function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function responseValue() { return { ok: true, character: role, value: value() }; }
function waitForPost(predicate) {
  const existing = posts.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => postWaiters.push({ predicate, resolve }));
}
function makeGate() {
  let markStarted, release, markSettled;
  const started = new Promise(resolve => { markStarted = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { markSettled = resolve; });
  return { started, wait, settled, markStarted: () => markStarted(), markSettled: () => markSettled(), release: () => release() };
}
const sharingHostPage = `<!doctype html><html><body><div id="root"></div><script type="module">
const root=document.getElementById('root'),states=[],effects=[],refs=[];let Component=null,stateIndex=0,effectIndex=0,refIndex=0,nextEffects=[],rendering=false,rerender=false,destroyed=false;
const React={Fragment:Symbol('Fragment'),createElement:(type,props,...children)=>({type,props:props||{},children}),
 useState(initial){const i=stateIndex++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],value=>{if(destroyed)return;const next=typeof value==='function'?value(states[i]):value;if(Object.is(next,states[i]))return;states[i]=next;render()}]},
 useEffect(effect,deps){const i=effectIndex++,old=effects[i],changed=!old||!deps||deps.length!==old.deps.length||deps.some((value,index)=>!Object.is(value,old.deps[index]));if(changed)nextEffects.push({i,effect,deps:deps||null})},
 useRef(initial){const i=refIndex++;if(!(i in refs))refs[i]={current:initial};return refs[i]}};
function node(value){if(value==null||typeof value==='boolean')return document.createTextNode('');if(Array.isArray(value)){const f=document.createDocumentFragment();for(const child of value){const n=node(child);if(n)f.append(n)}return f}if(typeof value==='string'||typeof value==='number')return document.createTextNode(String(value));if(value.type===React.Fragment)return node(value.children);if(typeof value.type==='function')return node(value.type(value.props||{}));const el=document.createElement(value.type);for(const [key,prop]of Object.entries(value.props||{})){if(key==='key'||key==='children'||prop==null)continue;if(key==='ref'){if(typeof prop==='function')prop(el);continue}if(key==='style'){Object.assign(el.style,prop);continue}if(key==='className'){el.className=prop;continue}if(key==='onClick'){el.addEventListener('click',prop);continue}if(['disabled','hidden','value'].includes(key)){el[key]=prop;continue}if(prop===false)continue;el.setAttribute(key,prop===true?'':String(prop))}for(const child of value.children){const n=node(child);if(n)el.append(n)}return el}
function render(){if(!Component||destroyed)return;if(rendering){rerender=true;return}rendering=true;stateIndex=effectIndex=refIndex=0;nextEffects=[];const tree=Component();root.replaceChildren(node(tree));for(const item of nextEffects){effects[item.i]?.cleanup?.();const cleanup=item.effect();effects[item.i]={deps:item.deps||[],cleanup}}rendering=false;if(rerender){rerender=false;queueMicrotask(render)}}
function unmount(){if(destroyed)return;destroyed=true;for(const effect of effects)effect?.cleanup?.();root.replaceChildren();Component=null}
window.__slotCalls=[];window.__slotRegistration=null;window.__slotUnregistered=0;
const ctx={slots:{inject(name,register){window.__slotCalls.push(name);const cleanup=register();return()=>cleanup?.()},register(metadata,component){window.__slotRegistration={...metadata};Component=component;render();let live=true;return()=>{if(!live)return;live=false;unmount();window.__slotUnregistered++}}}};
window.__sharingReady=(async()=>{const module=await import('/dsh-surfcore/api/douyin/companion-sharing-client');window.__sharingCleanup=module.mountSharingEntry(ctx,React);return true})().catch(error=>{window.__sharingSetupError=String(error);throw error});
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { send(res, 200, douyinCompanionPage, 'text/html;charset=utf-8'); return; }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-page') { send(res, 200, douyinCompanionPage, 'text/html;charset=utf-8'); return; }
  if (url.pathname === '/host') { send(res, 200, sharingHostPage, 'text/html;charset=utf-8'); return; }
  if (url.pathname === '/blank') { send(res, 200, '<!doctype html><html><body></body></html>', 'text/html;charset=utf-8'); return; }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-sharing-client') {
    if (failSharingModule) { send(res, 404, { ok: false, code: 'FIXTURE_MODULE_MISSING', error: 'module absent', hint: 'retry' }); return; }
    const source = await readFile(new URL('../lib/companion-sharing-client.mjs', import.meta.url));
    if (sharingModuleGate) { const gate = sharingModuleGate; sharingModuleGate = null; gate.markStarted(); await gate.wait; if (req.destroyed || res.destroyed) return; }
    send(res, 200, source, 'text/javascript;charset=utf-8'); return;
  }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-portrait') { send(res, 200, webp, 'image/webp'); return; }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion') {
    companionGetCount++;
    if (nextCompanionGate) { const gate = nextCompanionGate; nextCompanionGate = null; gate.markStarted(); await gate.wait; gate.markSettled(); if (req.destroyed || res.destroyed) return; }
    if (!role) { send(res, 409, { ok: false, code: 'COMPANION_CHARACTER_REQUIRED', error: '当前没有活动角色。', hint: '在角色页载入伙伴。' }); return; }
    send(res, 200, { ok: true, character: role, readiness: { ok: true }, value: {
      acceptance: { callsUsed: 1, remaining: 11, manualAccepted: true },
      daily: { enabled: false, paused: true, calls: 0, rounds: 0 }, activeJob: null,
      recentJobs: role.id === 'alpha' ? [{ jobId: 'diary-1', state: 'completed', items: [{ id: 'v1', title: '已经看过的小鱼', summary: '记录在本机的日记。', memorySaved: true, coverage: { transcriptComplete: true, frameSamples: 3 } }] }] : [],
    } }); return;
  }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-sharing' && req.method === 'GET') {
    sharingGetCount++;
    if (nextSharingFailure) { const failure = nextSharingFailure; nextSharingFailure = null; send(res, 409, { ok: false, ...failure }); return; }
    const snapshot = role ? responseValue() : null;
    if (nextSharingGate) { const gate = nextSharingGate; nextSharingGate = null; gate.markStarted(); await gate.wait; gate.markSettled(); if (req.destroyed || res.destroyed) return; }
    if (!role) { send(res, 409, { ok: false, code: 'DOUYIN_CHAT_CHARACTER_REQUIRED', error: '当前没有已载入的伙伴。', hint: '先在角色页载入伙伴，再打开分享。' }); return; }
    send(res, 200, snapshot || responseValue()); return;
  }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-sharing' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); posts.push(data);
    for (let index = postWaiters.length - 1; index >= 0; index--) {
      if (postWaiters[index].predicate(data)) postWaiters.splice(index, 1)[0].resolve(data);
    }
    if (!['reply', 'ack', 'cancel'].includes(data.action)) {
      send(res, 409, { ok: false, code: 'DOUYIN_CHAT_ACTION', error: '不支持这项伙伴操作。', hint: '使用发送、停止或打开分享按钮。' }); return;
    }
    if (!role || data.characterId !== role.id || data.characterEpoch !== role.epoch) {
      send(res, 409, { ok: false, code: 'COMPANION_CHARACTER_STALE', error: '角色已变化。', hint: '刷新伙伴状态后再继续。' }); return;
    }
    if (data.action === 'ack') {
      unread = false; send(res, 200, responseValue()); return;
    }
    if (data.action === 'cancel') {
      if (remoteActive?.requestId === data.requestId) { send(res, 409, { ok: false, code: 'DOUYIN_CHAT_OTHER_INSTANCE', error: '这条回复由另一个实例发起。', hint: '回到原实例取消，或等待它结束。' }); return; }
      cancelledRequests.add(data.requestId); send(res, 200, responseValue()); return;
    }
    if (data.action === 'reply') {
      if (replyGate) { const gate = replyGate; replyGate = null; gate.markStarted(); await gate.wait; gate.markSettled(); if (req.destroyed || res.destroyed) return; }
      if (cancelledRequests.has(data.requestId)) return;
      if (replyFailure) { const failure = replyFailure; replyFailure = null; send(res, 503, { ok: false, ...failure }); return; }
      if (replyWrongCharacter) { replyWrongCharacter = false; send(res, 200, { ok: true, character: { id: 'other', epoch: role.epoch + 1, name: '旧角色' }, value: value() }); return; }
      messages = [
        { id: 'message-user-1', requestId: data.requestId, role: 'user', text: data.text, at: '2026-11-07T06:01:00.000Z', openingId: data.openingId },
        { id: 'message-assistant-1', requestId: data.requestId, role: 'assistant', text: '也许它们在找一处安静的地方。', at: '2026-11-07T06:01:01.000Z', openingId: data.openingId },
      ];
      remoteActive = null;
      send(res, 200, responseValue()); return;
    }
    send(res, 400, { ok: false, code: 'FIXTURE_BAD_ACTION', error: '伙伴操作与请求字段不匹配。', hint: '检查 action 与操作字段。' }); return;
  }
  send(res, 404, { ok: false, code: 'FIXTURE_NOT_FOUND', error: 'fixture route missing', hint: 'update the test fixture' });
});

async function prepareApplyPage(applyPage, origin) {
  await applyPage.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await applyPage.addInitScript(() => {
    const React = {
      Fragment: Symbol('Fragment'), createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useCallback: fn => fn, useEffect: () => {}, useMemo: fn => fn(), useRef: value => ({ current: value }), useState: value => [value, () => {}],
    };
    window.__ModuleLoader__ = { load({ factory }) { window.__loadedSurfCore = factory(name => { if (name === 'react') return React; throw new Error('unexpected module: ' + name); }); } };
    window.__newApplyState = () => {
      const registrations = new Map(), cleanups = [];
      const ctx = {
        effect(callback) { cleanups.push(callback()); },
        slots: {
          inject(_name, callback) { let live = true; const cleanup = callback(); return () => { if (!live) return; live = false; cleanup?.(); }; },
          register(metadata, component) { registrations.set(metadata.id, { metadata, component }); return () => registrations.delete(metadata.id); },
        },
      };
      return { ctx, registrations, cleanups };
    };
    window.__applyState = window.__newApplyState();
  });
  await applyPage.goto(origin + '/blank');
  await applyPage.addScriptTag({ content: clientSource });
  await applyPage.evaluate(() => window.__loadedSurfCore.apply(window.__applyState.ctx));
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
  const executablePath = findBrowser()?.executable;
  assert.ok(executablePath, 'local fixture Chromium is available');
  browser = await chromium.launch({ headless: true, executablePath });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.__sharingTimeoutDelays = [];
    window.__shortenSharingTimeout = false;
    window.setTimeout = (callback, delay, ...args) => {
      if (window.__shortenSharingTimeout && delay === 185000) {
        window.__sharingTimeoutDelays.push(delay);
        return nativeSetTimeout(callback, 30, ...args);
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#conversation`);

  await page.locator('#conversation').waitFor({ state: 'visible', timeout: 4000 });
  await page.getByText('当前伙伴：小白鲸').waitFor();
  await page.getByText('海边的小鱼').waitFor();
  await page.getByText('你觉得它们为什么停在那里？').waitFor();
  assert.equal(await page.locator('#conversation img').count(), 0, 'shared diary text is rendered as text, never HTML');
  assert.equal(await page.locator('#portrait').isHidden(), false, 'the existing private portrait remains visible');
  assert.match(await page.locator('#diary').textContent(), /记录在本机的日记/, 'the original diary remains available');
  assert.equal(posts.some(post => post.openingId === opening.id), false, 'background reads do not mark an unseen opening as read');
  const staleAckGate = makeGate(); nextSharingGate = staleAckGate;
  await page.getByRole('button', { name: '刷新' }).click(); await staleAckGate.started;
  const ackPost = waitForPost(post => post.openingId === opening.id);
  await page.getByRole('button', { name: '我看到了' }).click();
  assert.equal((await ackPost).action, 'ack', 'ack requests use the production controller action contract');
  await page.waitForFunction(() => document.querySelector('#conversation-openings button[disabled][aria-label="已读"]'));
  assert.ok(posts.some(post => post.openingId === opening.id && post.characterId === role.id && post.characterEpoch === role.epoch), 'explicitly acknowledging the opening carries the active role stamp');
  staleAckGate.release(); await staleAckGate.settled; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.ok(await page.locator('#conversation-openings button[disabled][aria-label="已读"]').count(), 'an older unread GET cannot undo a confirmed ACK');

  await page.setViewportSize({ width: 375, height: 760 });
  const composer = await page.locator('#conversation-form').boundingBox();
  assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= 375, 'conversation composer fits a 375px viewport');
  assert.equal(await page.locator('#conversation-input').getAttribute('maxlength'), '1000');

  const gate = makeGate();
  replyGate = gate;
  await page.locator('#conversation-input').fill('我喜欢它们靠在一起的样子。');
  const replyPost = waitForPost(post => Object.hasOwn(post, 'text'));
  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByRole('button', { name: '取消回复' }).waitFor({ state: 'visible' });
  await gate.started;
  const reply = await replyPost;
  assert.ok(reply, 'reply POST reaches the same-origin fixture');
  assert.equal(reply.action, 'reply', 'reply requests use the production controller action contract');
  assert.match(reply.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'reply carries a UUID request stamp');
  assert.equal(reply.openingId, opening.id);
  assert.equal(reply.characterId, role.id); assert.equal(reply.characterEpoch, role.epoch);
  assert.equal(await page.getByRole('button', { name: '发送回复' }).isDisabled(), true, 'a pending reply cannot be sent twice');
  await page.getByRole('button', { name: '发送回复' }).evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
  assert.equal(posts.filter(post => Object.hasOwn(post, 'text')).length, 1, 'replayed click events do not duplicate the request');
  const cancelPost = waitForPost(post => post.requestId === reply.requestId && !Object.hasOwn(post, 'text'));
  await page.getByRole('button', { name: '取消回复' }).click();
  assert.equal((await cancelPost).action, 'cancel', 'cancel requests use the production controller action contract');
  await page.waitForFunction(() => document.getElementById('conversation-status').textContent.includes('已取消'));
  assert.ok(posts.some(post => post.requestId === reply.requestId && !Object.hasOwn(post, 'text') && !post.openingId), 'cancel uses the same request id without creating another reply');
  assert.equal(await page.locator('#conversation-input').inputValue(), '我喜欢它们靠在一起的样子。', 'cancel preserves the draft');
  gate.release(); await gate.settled; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.doesNotMatch(await page.locator('#conversation').textContent(), /也许它们在找一处安静的地方/, 'a late cancelled response cannot enter the conversation');

  replyFailure = { code: 'SHARING_TEMPORARY_FAILURE', error: '这条回复暂时没有完成。', hint: '检查后可以手动再试；系统不会自动重发。' };
  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByRole('alert').filter({ hasText: 'SHARING_TEMPORARY_FAILURE' }).waitFor();
  assert.equal(await page.locator('#conversation-input').inputValue(), '我喜欢它们靠在一起的样子。', 'a failed reply keeps the user text');
  await page.waitForTimeout(5200);
  assert.equal(posts.filter(post => Object.hasOwn(post, 'text')).length, 2, 'a failed reply is never automatically repeated');

  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByText('也许它们在找一处安静的地方。').waitFor();
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'a confirmed reply clears the input');
  assert.equal(await page.locator('#conversation-message-list [data-role="user"] .message-text').textContent(), '我喜欢它们靠在一起的样子。');
  assert.equal(await page.locator('#conversation-message-list [data-role="assistant"] .message-text').textContent(), '也许它们在找一处安静的地方。');

  const staleReplyGate = makeGate(); nextSharingGate = staleReplyGate;
  await page.getByRole('button', { name: '刷新' }).click(); await staleReplyGate.started;
  const newerReplyText = '我想把这阵潮汐也记下来。';
  const newerReplyPost = waitForPost(post => post.text === newerReplyText);
  await page.locator('#conversation-input').fill(newerReplyText);
  await page.getByRole('button', { name: '发送回复' }).click();
  assert.equal((await newerReplyPost).action, 'reply');
  await page.locator('#conversation-message-list [data-role="user"] .message-text').filter({ hasText: newerReplyText }).waitFor();
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'confirmed reply clears the draft before the old GET settles');
  staleReplyGate.release(); await staleReplyGate.settled; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.locator('#conversation-message-list [data-role="user"] .message-text').textContent(), newerReplyText, 'an older same-role GET cannot erase a confirmed reply');

  replyWrongCharacter = true;
  await page.locator('#conversation-input').fill('我只想把这句话留给当前伙伴。');
  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByRole('alert').filter({ hasText: 'DOUYIN_STALE_CHARACTER' }).waitFor();
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'a response for a different role retires the old draft');

  remoteActive = { requestId: 'other-instance-request', openingId: opening.id };
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByRole('button', { name: '取消回复' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#start').isDisabled(), true, 'a running conversation blocks starting another discovery round');
  await page.getByRole('button', { name: '取消回复' }).click();
  await page.getByRole('alert').filter({ hasText: 'DOUYIN_CHAT_OTHER_INSTANCE' }).waitFor();
  assert.match(await page.locator('#conversation-status').textContent(), /正在继续/);
  assert.doesNotMatch(await page.locator('#conversation-status').textContent(), /已取消/);
  remoteActive = null;
  await page.getByRole('button', { name: '刷新' }).click();
  await page.locator('#conversation-cancel').waitFor({ state: 'hidden' });

  const slowReplyText = '这条回复会比通常更慢一些。', postsBeforeSlowReply = posts.filter(post => Object.hasOwn(post, 'text')).length;
  const slowReplyGate = makeGate(); replyGate = slowReplyGate;
  const slowReplyPost = waitForPost(post => post.text === slowReplyText);
  await page.locator('#conversation-input').fill(slowReplyText);
  await page.evaluate(() => { window.__shortenSharingTimeout = true; });
  await page.getByRole('button', { name: '发送回复' }).click();
  const timedOutReply = await slowReplyPost; await slowReplyGate.started;
  await page.getByRole('alert').filter({ hasText: 'SHARING_REQUEST_TIMEOUT' }).waitFor({ timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__sharingTimeoutDelays.includes(185000)), true, 'the UI timeout covers the production 180-second reply budget plus response time');
  assert.match(await page.locator('#sharing-error').textContent(), /刷新核对已有结果.*不要重发同一条消息/);
  assert.equal(await page.locator('#conversation-input').inputValue(), slowReplyText, 'reply timeout preserves the user draft');
  assert.equal(posts.filter(post => Object.hasOwn(post, 'text')).length, postsBeforeSlowReply + 1, 'a timed-out reply is not automatically resent');
  slowReplyGate.release(); await slowReplyGate.settled; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await page.evaluate(() => { window.__shortenSharingTimeout = false; });
  assert.equal(posts.filter(post => Object.hasOwn(post, 'text')).length, postsBeforeSlowReply + 1, 'releasing the delayed fixture does not cause a retry');
  assert.equal(timedOutReply.action, 'reply');

  role = null; activeOpening = null; messages = []; unread = false;
  const requiredMainGate = makeGate(); nextCompanionGate = requiredMainGate;
  nextSharingFailure = { code: 'DOUYIN_CHAT_CHARACTER_REQUIRED', error: '当前没有已载入的伙伴。', hint: '先在角色页载入伙伴。' };
  await page.getByRole('button', { name: '刷新' }).click(); await requiredMainGate.started;
  await page.getByRole('alert').filter({ hasText: 'DOUYIN_CHAT_CHARACTER_REQUIRED' }).waitFor();
  assert.equal(await page.locator('#role').textContent(), '当前没有已载入角色');
  assert.equal(await page.locator('#conversation-openings').textContent(), '', 'the canonical no-character code clears old openings');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'the canonical no-character code clears old messages');
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'the canonical no-character code clears the old draft');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true, 'the canonical no-character code disables the composer');
  assert.match(await page.locator('#sharing-error').textContent(), /先在角色页载入伙伴/);
  requiredMainGate.release(); await requiredMainGate.settled; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.match(await page.locator('#sharing-error').textContent(), /DOUYIN_CHAT_CHARACTER_REQUIRED/, 'a later main status response does not erase the original sharing error');

  role = { id: 'beta', epoch: 5, name: '海蓝' };
  activeOpening = { id: 'opening-beta', jobId: 'job-beta', sourceId: 'BV2fixture', sourceTitle: '礁石边的新发现', occurredAt: '2026-11-07T06:02:00.000Z', text: '海浪退去后，留下了一小片湿润的沙。', question: '你会把它留在日记里吗？', coverage: { transcriptComplete: true, frameSamples: 2 } };
  unread = true; messages = [];
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByText('当前伙伴：海蓝').waitFor(); await page.getByText('礁石边的新发现').waitFor();

  role = { id: 'gamma', epoch: 6, name: '小浪花' };
  activeOpening = { id: 'opening-gamma', jobId: 'job-gamma', sourceId: 'BV3fixture', sourceTitle: '新的潮汐', occurredAt: '2026-11-07T06:03:00.000Z', text: '一阵微风把海面吹出细细的波纹。', question: '你听见了什么？', coverage: { transcriptComplete: true, frameSamples: 1 } };
  unread = true; messages = [];
  const staleMainGate = makeGate(); nextCompanionGate = staleMainGate;
  nextSharingFailure = { code: 'DOUYIN_STALE_CHARACTER', error: '角色已变化，本次对话请求停止。', hint: '刷新当前伙伴后再操作；不会续接到新角色。' };
  const postCountBeforeStaleGet = posts.length;
  await page.getByRole('button', { name: '刷新' }).click(); await staleMainGate.started;
  await page.getByRole('alert').filter({ hasText: 'DOUYIN_STALE_CHARACTER' }).waitFor();
  assert.equal(await page.locator('#conversation-openings').textContent(), '', 'stale status retires old openings while main role refresh is held');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'stale status retires old messages while main role refresh is held');
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'stale status clears the old draft while main role refresh is held');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true, 'stale status disables the composer until main role refresh completes');
  assert.equal(await page.locator('#start').isDisabled(), true, 'stale status disables starting another round until main role refresh completes');
  assert.equal(posts.length, postCountBeforeStaleGet, 'a stale GET never replays a sharing POST');
  staleMainGate.release(); await staleMainGate.settled;
  await page.getByText('当前伙伴：小浪花').waitFor(); await page.getByText('新的潮汐').waitFor();
  await page.getByRole('alert').filter({ hasText: 'DOUYIN_STALE_CHARACTER' }).waitFor();
  assert.equal(posts.length, postCountBeforeStaleGet, 'authoritative role reload does not replay the stale operation');

  const staleGate = makeGate(); nextSharingGate = staleGate;
  await page.getByRole('button', { name: '刷新' }).click(); await staleGate.started;
  role = { id: 'delta', epoch: 7, name: '海星' };
  activeOpening = { id: 'opening-delta', jobId: 'job-delta', sourceId: 'BV4fixture', sourceTitle: '礁石边的新发现', occurredAt: '2026-11-07T06:04:00.000Z', text: '海浪退去后，留下了一小片湿润的沙。', question: '你会把它留在日记里吗？', coverage: { transcriptComplete: true, frameSamples: 2 } };
  unread = true; messages = [];
  await page.getByText('当前伙伴：海星').waitFor();
  staleGate.release();
  await page.getByText('礁石边的新发现').waitFor();
  assert.doesNotMatch(await page.locator('#conversation-openings').textContent(), /新的潮汐|一阵微风吹出细细的波纹/, 'a delayed old-role snapshot cannot enter the new role conversation');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'role change clears prior messages');
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'role change clears the prior character draft');

  role = null;
  await page.getByText('当前没有已载入角色').waitFor();
  assert.equal(await page.locator('#conversation-openings').textContent(), '', 'clearing a role removes the old opening');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'clearing a role removes old messages');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true);
  assert.equal(await page.locator('#portrait').isHidden(), true);

  role = { id: 'epsilon', epoch: 8, name: '小海星' };
  activeOpening = { id: 'opening-epsilon', jobId: 'job-epsilon', sourceId: 'BV5fixture', sourceTitle: '新的潮汐', occurredAt: '2026-11-07T06:05:00.000Z', text: '一阵微风把海面吹出细细的波纹。', question: '你听见了什么？', coverage: { transcriptComplete: true, frameSamples: 1 } };
  unread = true; messages = [];
  await page.getByText('当前伙伴：小海星').waitFor(); await page.getByText('新的潮汐').waitFor();
  const hideGate = makeGate(); nextSharingGate = hideGate;
  await page.getByRole('button', { name: '刷新' }).click(); await hideGate.started;
  const requestsAtHide = sharingGetCount;
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  hideGate.release(); await page.waitForTimeout(180);
  assert.equal(sharingGetCount, requestsAtHide, 'pagehide aborts in-flight sharing reads and prevents queued polls');
  assert.equal(await page.locator('#conversation-status').textContent(), '日记页已关闭。');

  role = { id: 'zeta', epoch: 9, name: '小贝壳' };
  activeOpening = { id: 'opening-zeta', jobId: 'job-zeta', sourceId: 'BV6fixture', sourceTitle: '海风里的细沙', occurredAt: '2026-11-07T06:06:00.000Z', text: '海风把一小片细沙吹到了石头旁。', question: '你会记住这阵风吗？', coverage: { transcriptComplete: true, frameSamples: 1 } };
  unread = true; messages = [];
  const latePostPage = await browser.newPage({ viewport: { width: 375, height: 760 } });
  await latePostPage.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await latePostPage.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__lateSharingPostGate = null;
    window.__prepareLateSharingPost = () => {
      let markStarted, release;
      const started = new Promise(resolve => { markStarted = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      window.__lateSharingPostStarted = started;
      window.__releaseLateSharingPost = release;
      window.__lateSharingPostGate = { markStarted, released };
    };
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const gate = window.__lateSharingPostGate;
      if (!gate || init.method !== 'POST' || !String(url).includes('/companion-sharing')) return nativeFetch(input, init);
      window.__lateSharingPostGate = null;
      return nativeFetch(input, { ...init, signal: undefined }).then(async response => {
        const body = await response.text(), status = response.status, statusText = response.statusText, headers = Array.from(response.headers.entries());
        gate.markStarted();
        await gate.released;
        return new Response(body, { status, statusText, headers });
      });
    };
  });
  await latePostPage.goto(`http://127.0.0.1:${server.address().port}/#conversation`);
  await latePostPage.getByText('当前伙伴：小贝壳').waitFor(); await latePostPage.getByText('海风里的细沙').waitFor();
  replyFailure = { code: 'DOUYIN_CHAT_CHARACTER_REQUIRED', error: '当前没有已载入的伙伴。', hint: '先在角色页载入伙伴。' };
  const switchedPostText = '这句回复属于刚才的伙伴。', switchedPost = waitForPost(post => post.text === switchedPostText);
  await latePostPage.evaluate(() => window.__prepareLateSharingPost());
  await latePostPage.locator('#conversation-input').fill(switchedPostText);
  await latePostPage.getByRole('button', { name: '发送回复' }).click();
  await switchedPost; await latePostPage.evaluate(() => window.__lateSharingPostStarted);
  role = { id: 'eta', epoch: 10, name: '潮汐' };
  activeOpening = { id: 'opening-eta', jobId: 'job-eta', sourceId: 'BV7fixture', sourceTitle: '潮汐留下的纹路', occurredAt: '2026-11-07T06:07:00.000Z', text: '退去的潮水在沙地上留下了细细的纹路。', question: '哪一道纹路最像你今天的心情？', coverage: { transcriptComplete: true, frameSamples: 2 } };
  unread = true; messages = [];
  await latePostPage.getByRole('button', { name: '刷新' }).click();
  await latePostPage.getByText('当前伙伴：潮汐').waitFor(); await latePostPage.getByText('潮汐留下的纹路').waitFor();
  const readsBeforeLateError = companionGetCount;
  await latePostPage.evaluate(() => window.__releaseLateSharingPost());
  await latePostPage.waitForTimeout(80);
  assert.equal(await latePostPage.locator('#role').textContent(), '当前伙伴：潮汐', 'a late old-role canonical error cannot clear the new role');
  assert.match(await latePostPage.locator('#conversation-openings').textContent(), /潮汐留下的纹路/, 'a late old-role error cannot remove the new opening');
  assert.doesNotMatch(await latePostPage.locator('#sharing-error').textContent(), /DOUYIN_CHAT_CHARACTER_REQUIRED/, 'a late old-role error is ignored after the epoch changes');
  assert.equal(companionGetCount, readsBeforeLateError, 'a retired old-role POST error does not trigger another main refresh');

  replyFailure = { code: 'DOUYIN_CHAT_CHARACTER_REQUIRED', error: '当前没有已载入的伙伴。', hint: '先在角色页载入伙伴。' };
  const pagehidePostText = '这条迟到回复也不应复活页面。', pagehidePost = waitForPost(post => post.text === pagehidePostText);
  await latePostPage.evaluate(() => window.__prepareLateSharingPost());
  await latePostPage.locator('#conversation-input').fill(pagehidePostText);
  await latePostPage.getByRole('button', { name: '发送回复' }).click();
  await pagehidePost; await latePostPage.evaluate(() => window.__lateSharingPostStarted);
  await latePostPage.evaluate(() => dispatchEvent(new Event('pagehide')));
  assert.equal(await latePostPage.locator('#conversation-status').textContent(), '日记页已关闭。');
  await latePostPage.evaluate(() => window.__releaseLateSharingPost());
  await latePostPage.waitForTimeout(80);
  assert.equal(await latePostPage.locator('#conversation-status').textContent(), '日记页已关闭。', 'a late canonical POST error cannot replace the retired-page status');
  assert.equal(await latePostPage.locator('#sharing-error').textContent(), '', 'a late canonical POST error cannot surface after pagehide');
  assert.equal(await latePostPage.locator('#role').textContent(), '当前伙伴：潮汐', 'a late canonical POST error cannot clear the retired page role');
  await latePostPage.close();

  role = { id: 'host', epoch: 7, name: '小海星' };
  activeOpening = { id: 'opening-host', jobId: 'job-host', sourceId: 'BV4fixture', sourceTitle: '晚风里的浪', occurredAt: '2026-11-07T06:04:00.000Z', text: '晚风把海边变得安静。', question: '你想在这样的海边待一会儿吗？', coverage: { transcriptComplete: true, frameSamples: 2 } };
  unread = true; messages = [];
  const host = await browser.newPage({ viewport: { width: 375, height: 760 } });
  await host.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  host.on('pageerror', error => errors.push(error.message));
  await host.goto(`http://127.0.0.1:${server.address().port}/host`);
  await host.evaluate(() => window.__sharingReady);
  await host.getByRole('button', { name: /未读 1 条/ }).waitFor();
  assert.deepEqual(await host.evaluate(() => window.__slotCalls), ['sidebar.footer.action']);
  assert.deepEqual(await host.evaluate(() => ({ name: window.__slotRegistration.name, id: window.__slotRegistration.id, order: window.__slotRegistration.order })), { name: 'sidebar.footer.action', id: 'surfcore-companion-sharing', order: 7 });
  assert.equal(await host.locator('iframe').count(), 0, 'the sidebar entry does not interrupt or auto-open a conversation');
  const hostAckCount = posts.filter(post => post.openingId === 'opening-host').length;
  await host.getByRole('button', { name: /未读 1 条/ }).click();
  const iframe = host.locator('iframe'); await iframe.waitFor();
  assert.equal(await iframe.getAttribute('src'), '/dsh-surfcore/api/douyin/companion-page#conversation');
  await host.frameLocator('iframe').locator('#conversation').waitFor({ state: 'visible' });
  assert.equal(posts.filter(post => post.openingId === 'opening-host').length, hostAckCount, 'opening a hidden iframe does not acknowledge a share before it is seen');
  await host.getByRole('button', { name: '关闭伙伴对话' }).click(); await iframe.waitFor({ state: 'detached' });
  assert.equal(await host.locator('iframe').count(), 0, 'closing the floating dialog removes its iframe');
  await host.getByRole('button', { name: /未读 1 条/ }).click(); await host.locator('iframe').waitFor();
  await host.evaluate(() => window.__sharingCleanup());
  await host.waitForFunction(() => window.__slotUnregistered === 1);
  assert.equal(await host.locator('iframe').count(), 0, 'disposing the slot closes an open iframe');
  const hostRequestsAtDispose = sharingGetCount; await host.waitForTimeout(5200);
  assert.equal(sharingGetCount, hostRequestsAtDispose, 'disposing the entry stops polling');
  await host.close();

  failSharingModule = true;
  const applyPage = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await prepareApplyPage(applyPage, origin);
  await applyPage.waitForFunction(() => window.__applyState.registrations.has('surfcore-companion-sharing-load-error'));
  const failureText = await applyPage.evaluate(() => {
    const component = window.__applyState.registrations.get('surfcore-companion-sharing-load-error').component;
    const collect = node => node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : (node.children || []).map(collect).join('');
    return collect(component());
  });
  assert.match(failureText, /COMPANION_SHARING_CLIENT_LOAD_FAILED/);
  assert.match(failureText, /重载入口/, 'failed dynamic import shows a visible next action');
  failSharingModule = false;
  const importGate = makeGate(); sharingModuleGate = importGate;
  await applyPage.evaluate(() => {
    const component = window.__applyState.registrations.get('surfcore-companion-sharing-load-error').component;
    const tree = component();
    const button = tree.children.find(child => child?.type === 'button');
    window.__retryPromise = button.props.onClick();
  });
  await importGate.started;
  await applyPage.evaluate(() => window.__applyState.cleanups[1]?.());
  importGate.release(); await applyPage.evaluate(() => window.__retryPromise); await applyPage.waitForTimeout(120);
  assert.equal(await applyPage.evaluate(() => window.__applyState.registrations.has('surfcore-companion-sharing')), false, 'an import that resolves after apply disposal cannot register the slot');
  await applyPage.close();

  const applySuccessPage = await browser.newPage();
  await prepareApplyPage(applySuccessPage, origin);
  await applySuccessPage.waitForFunction(() => window.__applyState.registrations.has('surfcore-companion-sharing'));
  await applySuccessPage.evaluate(() => window.__applyState.cleanups[1]?.());
  assert.equal(await applySuccessPage.evaluate(() => window.__applyState.registrations.has('surfcore-companion-sharing')), false, 'successful mount cleanup unregisters the entry');
  await applySuccessPage.close();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ ok: true, checks: ['opening-text-xss', 'opening-ack-role-stamp', 'ack-old-get-no-unread-revival', 'existing-portrait-and-diary', 'reply-uuid-and-role-stamp', 'duplicate-send-guard', 'cancel-late-reply', 'failure-visible-and-draft-retained', 'no-automatic-retry', 'confirmed-reply', 'reply-old-get-no-message-erasure', 'late-post-role-stamp-rejected', 'cross-instance-cancel-visible', 'chat-blocks-concurrent-discovery', '185s-timeout-preserves-draft', 'canonical-required-clears-role', 'canonical-stale-retires-state', 'role-switch-late-response', 'role-clear', 'pagehide-poll-cleanup', 'late-post-role-switch-ignored', 'late-post-pagehide-ignored', '375px-composer', 'sidebar-slot-and-unread', 'no-auto-popup-or-hidden-ack', 'dialog-close-cleanup', 'slot-dispose-poll-cleanup', 'dynamic-import-failure-visible', 'late-import-after-dispose-ignored', 'apply-cleanup-unregisters-slot'] }));
} finally {
  if (replyGate) replyGate.release();
  await page?.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
