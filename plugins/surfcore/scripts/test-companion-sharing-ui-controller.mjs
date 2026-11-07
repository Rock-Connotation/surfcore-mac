import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';
import { createSharingController } from '../lib/companion-sharing-controller.mjs';
import { createCompanionSharing } from '../lib/companion-sharing.mjs';
import { fixture, opening, context } from './sharing-fixture.mjs';

// Exercise the browser against the production controller and append-only service.
// Only the paid model boundary and unrelated watch/portrait endpoints are fixtures.
const f = fixture();
let role = { id: context.characterId, epoch: context.characterEpoch, name: '小白鲸' }, holdMainStatus = false;
await opening(f); await f.service.dispose();
let calls = 0, enteredSecond, releaseSecond;
const secondStarted = new Promise(resolve => { enteredSecond = resolve; });
const service = createCompanionSharing({ stateDir: f.root, getCharacter: () => role,
  now: () => new Date('2026-11-07T06:00:00Z'), readiness: async () => ({ ok: true }),
  buildContext: async () => ({ ok: true, text: '只包含本机夹具的观看经历。' }),
  modelReply: async () => {
    calls++;
    if (calls === 2) { enteredSecond(); return new Promise(resolve => { releaseSecond = resolve; }); }
    return { text: '纸箱里的小窝让我想聊聊它为什么安心。', finishReason: 'stop' };
  } });
function gate() {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  return { enter, started, wait: new Promise(resolve => { release = resolve; }), release: () => release() };
}
let nextReadGate = null, statusReads = 0, omitRevision = false;
const controller = createSharingController({ service: { ...service, status: async stamp => {
  statusReads++;
  const value = await service.status(stamp);
  if (nextReadGate) { const gate = nextReadGate; nextReadGate = null; gate.enter(); await gate.wait; }
  if (omitRevision) { const invalid = { ...value }; delete invalid.revision; return invalid; }
  return value;
} }, getCharacter: () => role });
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (await controller.handle(req, res, url)) return;
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(douyinCompanionPage); return; }
  if (url.pathname.endsWith('/companion-portrait')) { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(webp); return; }
  if (url.pathname.endsWith('/companion')) {
    if (holdMainStatus) return; // The other poll cannot rescue a stale sharing UI.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, character: role, readiness: { ok: true }, value: {
      acceptance: { callsUsed: 8, remaining: 4, manualAccepted: true }, daily: { enabled: false, calls: 0, rounds: 0 }, recentJobs: [], activeJob: null,
    } })); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: findBrowser().executable });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/#conversation`);
  await page.getByRole('button', { name: '我看到了', exact: true }).waitFor();
  const oldAck = gate(); nextReadGate = oldAck;
  await page.getByRole('button', { name: '我看到了', exact: true }).click();
  await oldAck.started;
  assert.equal((await service.status(context)).unread, 0, 'real ACK dispatcher persists the read receipt');
  const oldRead = gate();
  nextReadGate = oldRead;
  await page.locator('#refresh').click();
  await oldRead.started;
  await page.locator('#conversation-input').fill('这段材料里你最想聊什么？');
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await page.getByText('纸箱里的小窝让我想聊聊它为什么安心。', { exact: true }).waitFor();
  assert.equal(calls, 1); assert.equal(f.ledger.readLedger().acceptanceCalls, 9);
  assert.equal((await service.status(context)).messages.length, 2);
  oldRead.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#conversation-message-list .message').count(), 2,
    'an older same-role GET cannot erase the confirmed POST conversation');
  oldAck.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#conversation-message-list .message').count(), 2,
    'an older ACK POST cannot erase the confirmed reply POST conversation');
  await page.getByRole('button', { name: '已读', exact: true }).waitFor();
  const readsAfterAck = statusReads;
  await page.waitForTimeout(5200);
  assert(statusReads > readsAfterAck, 'polling continues after a POST with no in-flight GET');
  await page.locator('#conversation-input').fill('再聊一句，不过先停下。');
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await secondStarted;
  await page.getByRole('button', { name: '取消回复', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('conversation-status').textContent.includes('已取消'));
  const after = await service.status(context);
  assert.equal(after.active, null, 'real cancel dispatcher stops the owned operation');
  assert.equal(after.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(f.ledger.readLedger().acceptanceCalls, 10, 'cancel retains its reserved request');
  assert.equal(await page.locator('#conversation-input').inputValue(), '再聊一句，不过先停下。');
  releaseSecond({ text: '迟到回复不可见。', finishReason: 'stop' });
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('#conversation').textContent(), /迟到回复不可见/);
  await page.locator('#conversation-input').fill('接口失败时保留这句草稿。');
  omitRevision = true; await page.locator('#refresh').click();
  await page.waitForFunction(() => document.getElementById('sharing-error').textContent.includes('SHARING_RESPONSE_INVALID'));
  assert.match(await page.locator('#sharing-error').textContent(), /重新加载SurfCore插件后点刷新/, 'missing revision is a visible actionable contract failure');
  assert.equal(await page.locator('#conversation-input').inputValue(), '接口失败时保留这句草稿。');
  omitRevision = false;
  let staleEntered, staleRelease;
  const staleStarted = new Promise(resolve => { staleEntered = resolve; });
  nextReadGate = { enter: staleEntered, wait: new Promise(resolve => { staleRelease = resolve; }) };
  await page.locator('#refresh').click(); await staleStarted;
  role = { id: 'beta', epoch: 2, name: '另一伙伴' }; holdMainStatus = true; staleRelease();
  await page.waitForFunction(() => document.getElementById('sharing-error').textContent.includes('DOUYIN_STALE_CHARACTER'));
  assert.match(await page.locator('#sharing-error').textContent(), /刷新当前伙伴后再操作/, 'canonical stale retains its actionable hint');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true, 'canonical stale retires the composer while the main poll is held');
  assert.equal(await page.locator('#conversation-openings article').count(), 0);
  role = { id: context.characterId, epoch: context.characterEpoch, name: '小白鲸' }; holdMainStatus = false;
  await page.reload(); await page.getByText('纸箱里的小窝让我想聊聊它为什么安心。', { exact: true }).waitFor();
  role = null; holdMainStatus = true; await page.locator('#refresh').click();
  await page.waitForFunction(() => document.getElementById('sharing-error').textContent.includes('DOUYIN_CHAT_CHARACTER_REQUIRED'));
  assert.match(await page.locator('#sharing-error').textContent(), /先在角色页载入伙伴/, 'canonical required retains its actionable hint');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true, 'canonical required clears the old role without another endpoint responding');
  assert.equal(await page.locator('#conversation-openings article').count(), 0);
  assert.equal(await page.locator('#conversation-message-list .message').count(), 0);
  console.log('PASS browser + production sharing controller/service: ACK, reply, cancel, stale reads, canonical errors and durable quota');
} finally {
  await browser?.close(); await service.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(f.root, { recursive: true, force: true });
}
