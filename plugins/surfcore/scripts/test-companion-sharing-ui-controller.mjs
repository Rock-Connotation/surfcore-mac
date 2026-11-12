import { testHome } from './isolate-test-home.mjs';
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
const f = await fixture();
let role = { id: context.characterId, epoch: context.characterEpoch, name: '小白鲸' }, holdMainStatus = false;
await opening(f); await f.service.dispose();
let calls = 0, enteredSecond, releaseSecond;
const secondStarted = new Promise(resolve => { enteredSecond = resolve; });
const service = createCompanionSharing({ stateDir: f.v2.stateDir, getCharacter: () => role,
  now: () => new Date('2026-11-07T06:00:00Z'), readiness: async () => ({ ok: true }),
  buildContext: async () => ({ ok: true, text: '只包含本机夹具的观看经历。' }),
  memoryV2: f.v2.memoryV2, getModelRequest: f.v2.getModelRequest,
  modelReply: async args => {
    calls++;
    await args.beforeSend?.();
    if (calls === 2) {
      enteredSecond();
      // 真实模型适配器尊重 cancel signal：abort 即结束，不会让 UI 等 5s 超时。
      return new Promise((resolve, reject) => {
        const onAbort = () => { args.signal.removeEventListener('abort', onAbort); reject(Object.assign(new Error('这次回复已停止。'), { code: 'DOUYIN_CHAT_CANCELLED', hint: '查看已经保存的对话和用量；不会自动重发。' })); };
        if (args.signal.aborted) return onAbort();
        args.signal.addEventListener('abort', onAbort, { once: true });
        releaseSecond = resolve;
      });
    }
    return { text: '纸箱里的小窝让我想聊聊它为什么安心。', finishReason: 'stop' };
  } });
function gate() {
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  return { enter, started, wait: new Promise(resolve => { release = resolve; }), release: () => release() };
}
let nextReadGate = null, statusReads = 0, omitRevision = false, firstMainStatus = true;
const initialMainGate = gate();
const controller = createSharingController({ service: { ...service, status: async stamp => {
  statusReads++;
  const value = await service.status(stamp);
  if (nextReadGate) { const gate = nextReadGate; nextReadGate = null; gate.enter(); await gate.wait; }
  if (omitRevision) { const invalid = { ...value }; delete invalid.revision;return invalid; }
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
    if (firstMainStatus) { firstMainStatus = false; initialMainGate.enter(); await initialMainGate.wait; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, character: role, readiness: { ok: true }, value: {
      acceptance: { callsUsed: 8, remaining: 4, manualAccepted: true }, daily: { enabled: false, calls: 0, rounds: 0 }, activeJob: null,
      recentJobs: [{ jobId: 'prior-diary', state: 'partial', items: [{ id: '765432', url: 'https://www.douyin.com/video/765432', title: '已有的长日记', state: 'partial', memorySaved: true, summary: '以前保存的日记。'.repeat(600), coverage: { transcriptComplete: true, frameSamples: 3 } }] }],
    } })); return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: findBrowser().executable });
  const page = await browser.newPage({ viewport: { width: 430, height: 660 } });
  page.setDefaultTimeout(5000);
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/#conversation`);
  await initialMainGate.started;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  initialMainGate.release();
  await page.getByRole('button', { name: '我看到了', exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('portrait').complete && document.getElementById('portrait').naturalWidth > 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const conversationHeading = await page.locator('#conversation-title').boundingBox();
  assert(conversationHeading.y >= 0 && conversationHeading.y + conversationHeading.height <= 660,
    'initial conversation hash remains in view after the async long diary and portrait render');
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
  // V2-only：删掉 revision 会让 controller 的 validateResponse 先拒绝（响应不再匹配
  // 已签发的 view lease），页面显示 DOUYIN_CHAT_RESPONSE_EXPIRED，而不是 V1 的
  // SHARING_RESPONSE_INVALID。两者都必须「可见且可行动」；这里按 V2 契约断言。
  await page.waitForFunction(() => /DOUYIN_CHAT_RESPONSE_EXPIRED|SHARING_RESPONSE_INVALID/.test(document.getElementById('sharing-error').textContent));
  assert.match(await page.locator('#sharing-error').textContent(), /刷新/, 'missing revision remains a visible actionable failure');
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
  // V2-only：上一阶段的响应摘要拒绝会留下 blocked 屏障（生产语义：未确认退役前
  // 不得继续读取）。显式确认退役后再 reload，与 switchCharacterEverywhere 顺序一致。
  const cleared = await service.withTransition(() => ({ ok: true }), { retirementAcknowledged: true });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  await page.reload(); await page.getByText('纸箱里的小窝让我想聊聊它为什么安心。', { exact: true }).waitFor();
  role = null; holdMainStatus = true; await page.locator('#refresh').click();
  await page.waitForFunction(() => document.getElementById('sharing-error').textContent.includes('DOUYIN_CHAT_CHARACTER_REQUIRED'));
  assert.match(await page.locator('#sharing-error').textContent(), /先在角色页载入伙伴/, 'canonical required retains its actionable hint');
  assert.equal(await page.locator('#conversation-input').isDisabled(), true, 'canonical required clears the old role without another endpoint responding');
  assert.equal(await page.locator('#conversation-openings article').count(), 0);
  assert.equal(await page.locator('#conversation-message-list .message').count(), 0);
  console.log('PASS browser + production sharing controller/service: ACK, reply, cancel, stale reads, canonical errors and durable quota');
} finally {
  try { await browser?.close(); } catch {}
  // V2 取消路径下 service.dispose() 可能等待已挂起的 modelReply；限时清理，
  // 测试进程必须有界退出（独立跑已 PASS，完整链里不能吊住后续门禁）。
  await Promise.race([service.dispose().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
  try { server.closeAllConnections(); } catch {}
  await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  try { fs.rmSync(f.root, { recursive: true, force: true }); } catch {}
  process.exitCode ??= 0;
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.();
}
