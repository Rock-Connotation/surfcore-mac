import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';

let role = { id: 'alpha', epoch: 4, name: '小白鲸' }, activeOpening;
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const posts = [], errors = [], cancelledRequests = new Set();
let unread = true, replyGate = null, replyFailure = null, replyWrongCharacter = false, remoteActive = null, nextSharingGate = null, sharingGetCount = 0, failSharingModule = false, sharingModuleGate = null;
const opening = activeOpening = {
  id: 'opening-1', jobId: 'job-1', sourceId: 'BV1fixture', sourceTitle: '海边的小鱼',
  occurredAt: '2026-11-07T06:00:00.000Z',
  text: '我刚看到一群小鱼靠着礁石游过。<img src=x onerror=alert(1)>',
  question: '你觉得它们为什么停在那里？',
  coverage: { transcriptComplete: true, frameSamples: 3 }, unread: true,
};
let messages = [];
function value() { return { openings: activeOpening ? [{ ...activeOpening, unread }] : [], messages: [...messages], active: remoteActive, unread: unread ? 1 : 0, lastError: null }; }
function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
function responseValue() { return { ok: true, character: role, value: value() }; }
function makeGate() {
  let markStarted, release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { started, wait, markStarted: () => markStarted(), release: () => release() };
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
    if (!role) { send(res, 409, { ok: false, code: 'COMPANION_CHARACTER_REQUIRED', error: '当前没有活动角色。', hint: '在角色页载入伙伴。' }); return; }
    send(res, 200, { ok: true, character: role, readiness: { ok: true }, value: {
      acceptance: { callsUsed: 1, remaining: 11, manualAccepted: true },
      daily: { enabled: false, paused: true, calls: 0, rounds: 0 }, activeJob: null,
      recentJobs: role.id === 'alpha' ? [{ jobId: 'diary-1', state: 'completed', items: [{ id: 'v1', title: '已经看过的小鱼', summary: '记录在本机的日记。', memorySaved: true, coverage: { transcriptComplete: true, frameSamples: 3 } }] }] : [],
    } }); return;
  }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-sharing' && req.method === 'GET') {
    sharingGetCount++;
    const snapshot = role ? responseValue() : null;
    if (nextSharingGate) { const gate = nextSharingGate; nextSharingGate = null; gate.markStarted(); await gate.wait; if (req.destroyed || res.destroyed) return; }
    if (!role) { send(res, 409, { ok: false, code: 'COMPANION_CHARACTER_REQUIRED', error: '当前没有活动角色。', hint: '在角色页载入伙伴。' }); return; }
    send(res, 200, snapshot || responseValue()); return;
  }
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-sharing' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); posts.push(data);
    if (!role || data.characterId !== role.id || data.characterEpoch !== role.epoch) {
      send(res, 409, { ok: false, code: 'COMPANION_CHARACTER_STALE', error: '角色已变化。', hint: '刷新伙伴状态后再继续。' }); return;
    }
    if (data.openingId && !Object.hasOwn(data, 'text')) {
      unread = false; send(res, 200, responseValue()); return;
    }
    if (data.requestId && !Object.hasOwn(data, 'text')) {
      if (remoteActive?.requestId === data.requestId) { send(res, 409, { ok: false, code: 'DOUYIN_CHAT_OTHER_INSTANCE', error: '这条回复由另一个实例发起。', hint: '回到原实例取消，或等待它结束。' }); return; }
      cancelledRequests.add(data.requestId); send(res, 200, responseValue()); return;
    }
    if (data.requestId && Object.hasOwn(data, 'text')) {
      if (replyGate) { const gate = replyGate; replyGate = null; await gate.wait; }
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
    send(res, 400, { ok: false, code: 'FIXTURE_UNKNOWN_ACTION', error: '未知操作。', hint: '检查请求体。' }); return;
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
  await page.getByRole('button', { name: '我看到了' }).click();
  await page.waitForFunction(() => document.querySelector('#conversation-openings button[disabled][aria-label="已读"]'));
  assert.ok(posts.some(post => post.openingId === opening.id && post.characterId === role.id && post.characterEpoch === role.epoch), 'explicitly acknowledging the opening carries the active role stamp');

  await page.setViewportSize({ width: 375, height: 760 });
  const composer = await page.locator('#conversation-form').boundingBox();
  assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= 375, 'conversation composer fits a 375px viewport');
  assert.equal(await page.locator('#conversation-input').getAttribute('maxlength'), '1000');

  const gate = (() => { let release; return { wait: new Promise(resolve => { release = resolve; }), release: () => release() }; })();
  replyGate = gate;
  await page.locator('#conversation-input').fill('我喜欢它们靠在一起的样子。');
  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByRole('button', { name: '取消回复' }).waitFor({ state: 'visible' });
  const reply = posts.find(post => Object.hasOwn(post, 'text'));
  assert.ok(reply, 'reply POST reaches the same-origin fixture');
  assert.match(reply.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'reply carries a UUID request stamp');
  assert.equal(reply.openingId, opening.id);
  assert.equal(reply.characterId, role.id); assert.equal(reply.characterEpoch, role.epoch);
  assert.equal(await page.getByRole('button', { name: '发送回复' }).isDisabled(), true, 'a pending reply cannot be sent twice');
  await page.getByRole('button', { name: '发送回复' }).evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
  assert.equal(posts.filter(post => Object.hasOwn(post, 'text')).length, 1, 'replayed click events do not duplicate the request');
  await page.getByRole('button', { name: '取消回复' }).click();
  await page.waitForFunction(() => document.getElementById('conversation-status').textContent.includes('已取消'));
  assert.ok(posts.some(post => post.requestId === reply.requestId && !Object.hasOwn(post, 'text') && !post.openingId), 'cancel uses the same request id without creating another reply');
  assert.equal(await page.locator('#conversation-input').inputValue(), '我喜欢它们靠在一起的样子。', 'cancel preserves the draft');
  gate.release();
  await page.waitForTimeout(100);
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

  replyWrongCharacter = true;
  await page.locator('#conversation-input').fill('我只想把这句话留给当前伙伴。');
  await page.getByRole('button', { name: '发送回复' }).click();
  await page.getByRole('alert').filter({ hasText: 'COMPANION_CHARACTER_STALE' }).waitFor();
  assert.equal(await page.locator('#conversation-input').inputValue(), '我只想把这句话留给当前伙伴。', 'a success envelope for a different role is rejected and preserves the draft');
  assert.equal(await page.getByRole('button', { name: '发送回复' }).isDisabled(), false, 'a rejected role stamp does not leave the composer stuck');

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

  const staleGate = makeGate(); nextSharingGate = staleGate;
  await page.getByRole('button', { name: '刷新' }).click(); await staleGate.started;
  role = { id: 'beta', epoch: 5, name: '海蓝' };
  activeOpening = { id: 'opening-beta', jobId: 'job-beta', sourceId: 'BV2fixture', sourceTitle: '礁石边的新发现', occurredAt: '2026-11-07T06:02:00.000Z', text: '海浪退去后，留下了一小片湿润的沙。', question: '你会把它留在日记里吗？', coverage: { transcriptComplete: true, frameSamples: 2 } };
  unread = true; messages = [];
  await page.getByText('当前伙伴：海蓝').waitFor();
  staleGate.release();
  await page.getByText('礁石边的新发现').waitFor();
  assert.doesNotMatch(await page.locator('#conversation-openings').textContent(), /海边的小鱼|我刚看到一群小鱼/, 'a delayed old-role snapshot cannot enter the new role conversation');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'role change clears prior messages');
  assert.equal(await page.locator('#conversation-input').inputValue(), '', 'role change clears the prior character draft');

  role = null;
  await page.getByText('当前没有已载入角色').waitFor();
  assert.equal(await page.locator('#conversation-openings').textContent(), '', 'clearing a role removes the old opening');
  assert.equal(await page.locator('#conversation-message-list').textContent(), '', 'clearing a role removes old messages');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true);
  assert.equal(await page.locator('#portrait').isHidden(), true);

  role = { id: 'gamma', epoch: 6, name: '小浪花' };
  activeOpening = { id: 'opening-gamma', jobId: 'job-gamma', sourceId: 'BV3fixture', sourceTitle: '新的潮汐', occurredAt: '2026-11-07T06:03:00.000Z', text: '一阵微风把海面吹出细细的波纹。', question: '你听见了什么？', coverage: { transcriptComplete: true, frameSamples: 1 } };
  unread = true; messages = [];
  await page.getByText('当前伙伴：小浪花').waitFor(); await page.getByText('新的潮汐').waitFor();
  const hideGate = makeGate(); nextSharingGate = hideGate;
  await page.getByRole('button', { name: '刷新' }).click(); await hideGate.started;
  const requestsAtHide = sharingGetCount;
  await page.evaluate(() => dispatchEvent(new Event('pagehide')));
  hideGate.release(); await page.waitForTimeout(180);
  assert.equal(sharingGetCount, requestsAtHide, 'pagehide aborts in-flight sharing reads and prevents queued polls');
  assert.equal(await page.locator('#conversation-status').textContent(), '日记页已关闭。');

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
  console.log(JSON.stringify({ ok: true, checks: ['opening-text-xss', 'opening-ack-role-stamp', 'existing-portrait-and-diary', 'reply-uuid-and-role-stamp', 'duplicate-send-guard', 'cancel-late-reply', 'failure-visible-and-draft-retained', 'no-automatic-retry', 'confirmed-reply', 'late-post-role-stamp-rejected', 'cross-instance-cancel-visible', 'chat-blocks-concurrent-discovery', 'role-switch-late-response', 'role-clear', 'pagehide-poll-cleanup', '375px-composer', 'sidebar-slot-and-unread', 'no-auto-popup-or-hidden-ack', 'dialog-close-cleanup', 'slot-dispose-poll-cleanup', 'dynamic-import-failure-visible', 'late-import-after-dispose-ignored', 'apply-cleanup-unregisters-slot'] }));
} finally {
  if (replyGate) replyGate.release();
  await page?.close();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
