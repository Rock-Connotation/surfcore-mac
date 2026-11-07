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
const f = fixture(), role = { id: context.characterId, epoch: context.characterEpoch, name: '小白鲸' };
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
const controller = createSharingController({ service, getCharacter: () => role });
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (await controller.handle(req, res, url)) return;
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(douyinCompanionPage); return; }
  if (url.pathname.endsWith('/companion-portrait')) { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(webp); return; }
  if (url.pathname.endsWith('/companion')) {
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
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/#conversation`);
  await page.getByRole('button', { name: '我看到了', exact: true }).click();
  await page.getByRole('button', { name: '已读', exact: true }).waitFor();
  assert.equal((await service.status(context)).unread, 0, 'real ACK dispatcher persists the read receipt');
  await page.locator('#conversation-input').fill('这段材料里你最想聊什么？');
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await page.getByText('纸箱里的小窝让我想聊聊它为什么安心。', { exact: true }).waitFor();
  assert.equal(calls, 1); assert.equal(f.ledger.readLedger().acceptanceCalls, 9);
  assert.equal((await service.status(context)).messages.length, 2);
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
  console.log('PASS browser + production sharing controller/service: ACK, reply, cancel and durable quota');
} finally {
  await browser?.close(); await service.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(f.root, { recursive: true, force: true });
}
