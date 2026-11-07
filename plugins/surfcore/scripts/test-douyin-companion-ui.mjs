import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';

let posts = [], getRequests = 0, portraitRequests = [], character = { id: 'alpha', epoch: 1, name: '小白鲸' };
const failures = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ui-'));
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const testStartedAt = Date.now();
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(douyinCompanionPage); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/dsh-surfcore/api/douyin/companion-portrait') {
    portraitRequests.push(url.pathname + url.search);
    if (portraitRequests.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 5600));
      if (req.destroyed || res.destroyed) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'FIXTURE_PORTRAIT_MISSING', error: '当前角色还没有本机立绘。', hint: '点刷新重试。' })); return;
    }
    if (url.searchParams.get('characterId') === 'beta') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (req.destroyed || res.destroyed) return;
    }
    res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(webp); return;
  }
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    posts.push(JSON.parse(body)); res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'FIXTURE_LIMIT', error: '本轮额度已用完', hint: '查看已有日记，不会自动重试。' })); return;
  }
  getRequests++;
  // Intentionally slower than the fixture's poll interval: refresh must not starve itself.
  await new Promise(resolve => setTimeout(resolve, 120));
  if (!character) {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'COMPANION_CHARACTER_REQUIRED', error: '当前没有活动角色。', hint: '在角色页载入伙伴。' })); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, character, readiness: { ok: true }, value: {
    acceptance: { callsUsed: 2, remaining: 10, manualAccepted: false }, daily: { enabled: false, paused: false, calls: 0, rounds: 0 }, activeJob: null,
    recentJobs: character.id === 'alpha' ? [{ jobId: 'fixture', state: 'partial', items: [
      { id: '123456', url: 'https://www.douyin.com/video/123456', title: '海洋小发现', occurredAt: new Date().toISOString(), summary: '<img src=x onerror=alert(1)>喜欢缓慢游动的小鱼', reason: '看见取样里的尾鳍', draft: '一段只留在本机的草稿', partial: true, state: 'partial', memorySaved: true, coverage: { transcriptComplete: false, frameSamples: 3 } },
      { id: '345678', url: 'https://www.douyin.com/video/345678', title: '另一段小发现', state: 'partial', partial: true, memorySaved: true, coverage: { transcriptComplete: false, frameSamples: 2 } },
      { id: '234567', url: 'https://www.douyin.com/video/234567', title: '跳过的长视频', state: 'skipped', hint: '超过两分钟上限。' },
    ] }] : [],
  } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath = findBrowser()?.executable; assert.ok(executablePath);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, ms) => interval(fn, Math.min(ms, 60)); });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('当前伙伴：小白鲸').waitFor();
  await page.getByText(/COMPANION_PORTRAIT_TIMEOUT/).waitFor();
  assert.equal(await page.locator('#portrait').isHidden(), true, 'failed portrait stays hidden instead of showing a fallback');
  assert.match(await page.locator('#portrait-status').textContent(), /刷新.*重试/);
  assert.equal(portraitRequests[0], '/dsh-surfcore/api/douyin/companion-portrait?characterId=alpha&characterEpoch=1', 'portrait GET must carry the current role stamp');
  assert.equal(await page.locator('#acceptance').textContent(), '2 / 12');
  assert.match(await page.locator('#diary').textContent(), /尾鳍/);
  assert.equal(await page.locator('#diary img').count(), 0, 'model text cannot become HTML');
  assert.match(await page.locator('#diary').textContent(), /部分音轨覆盖 · 3张稀疏画面/);
  assert.match(await page.locator('#notice').textContent(), /部分观看经历已保存；本轮音轨尾部不完整，首次手动验收尚未通过/);
  assert.match(await page.locator('#notice').textContent(), /再手动体验一轮音轨完整的视频/);
  assert.equal(await page.locator('body').getAttribute('data-state'), 'completed', 'partial saved experiences use the happy state without claiming full audio');
  await page.getByRole('button', { name: '刷新' }).click();
  await page.waitForFunction(() => { const image = document.getElementById('portrait'); return !image.hidden && image.complete && image.naturalWidth > 0; });
  assert.equal(portraitRequests[1], portraitRequests[0], 'existing refresh control retries the failed role portrait');
  assert.match(await page.locator('#portrait-status').textContent(), /当前角色的本机立绘/);
  assert.match(await page.locator('#diary').textContent(), /已跳过 · 未形成观看经历/);
  await page.getByRole('button', { name: '一起发现一轮' }).click();
  await page.waitForFunction(() => document.getElementById('error').textContent.includes('查看已有日记'));
  await page.waitForTimeout(300);
  assert.match(await page.getByRole('alert').textContent(), /查看已有日记/, 'polling must retain an actionable operation failure');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0], { action: 'start', characterId: 'alpha', characterEpoch: 1 });
  character = { id: 'beta', epoch: 2, name: '另一个伙伴' };
  await page.getByText('当前伙伴：另一个伙伴').waitFor();
  assert.equal(await page.locator('#diary .entry').count(), 0, 'new role cannot retain old diary');
  await page.waitForFunction(() => !document.getElementById('portrait').hidden && document.getElementById('portrait').complete && document.getElementById('portrait').naturalWidth > 0);
  assert.equal(portraitRequests.at(-1), '/dsh-surfcore/api/douyin/companion-portrait?characterId=beta&characterEpoch=2', 'role epoch change requests the new role portrait');
  character = null;
  await page.getByText('当前没有已载入角色').waitFor();
  await page.waitForTimeout(1700);
  assert.equal(await page.locator('#portrait').isHidden(), true, 'clearing the role removes the old portrait');
  assert.equal(await page.locator('#portrait').getAttribute('src'), null);
  assert.match(await page.locator('#portrait-status').textContent(), /未显示旧立绘/);
  assert.doesNotMatch(await page.locator('#portrait-status').textContent(), /TIMEOUT|COMPANION_PORTRAIT_LOAD_FAILED/, 'late response from the retired role cannot overwrite role-clear status');
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.ok(getRequests < (Date.now() - testStartedAt) / 100 + 2, 'slow polling must remain serialized against the 120ms fixture response');
  await page.screenshot({ path: path.join(dir, 'companion-ui.png') });
  console.log(JSON.stringify({ ok: true, checks: ['slow-poll', 'escaped-diary', 'sticky-action-failure', 'portrait-role-stamp', 'portrait-timeout-visible-and-refresh-retry', 'late-retired-role-response-ignored', 'partial-success-happy-state', 'manual-gate-next-step', 'role-clear'], screenshot: path.join(dir, 'companion-ui.png') }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
