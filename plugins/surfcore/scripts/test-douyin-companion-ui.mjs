import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';

let posts = [], getRequests = 0, character = { id: 'alpha', epoch: 1, name: '小白鲸' };
const failures = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ui-'));
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(douyinCompanionPage); return; }
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    posts.push(JSON.parse(body)); res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'FIXTURE_LIMIT', error: '本轮额度已用完', hint: '查看已有日记，不会自动重试。' })); return;
  }
  getRequests++;
  // Intentionally slower than the fixture's poll interval: refresh must not starve itself.
  await new Promise(resolve => setTimeout(resolve, 120));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, character, readiness: { ok: true }, value: {
    acceptance: { callsUsed: 2, remaining: 10 }, daily: { enabled: false, paused: false, calls: 0, rounds: 0 }, activeJob: null,
    recentJobs: character.id === 'alpha' ? [{ jobId: 'fixture', state: 'completed', items: [{ id: '123456', url: 'https://www.douyin.com/video/123456', title: '海洋小发现', occurredAt: new Date().toISOString(), summary: '<img src=x onerror=alert(1)>喜欢缓慢游动的小鱼', reason: '看见取样里的尾鳍', draft: '一段只留在本机的草稿', partial: true, state: 'partial', coverage: { transcriptComplete: true, frameSamples: 3 } }, { id: '234567', url: 'https://www.douyin.com/video/234567', title: '跳过的长视频', state: 'skipped', hint: '超过两分钟上限。' }] }] : [],
  } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath = findBrowser()?.executable; assert.ok(executablePath);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, ms) => interval(fn, Math.min(ms, 20)); });
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('当前伙伴：小白鲸').waitFor();
  assert.equal(await page.locator('#acceptance').textContent(), '2 / 12');
  assert.match(await page.locator('#diary').textContent(), /尾鳍/);
  assert.equal(await page.locator('#diary img').count(), 0, 'model text cannot become HTML');
  assert.match(await page.locator('#diary').textContent(), /音轨处理完整 · 3张稀疏画面/);
  assert.match(await page.locator('#diary').textContent(), /已跳过 · 未形成观看经历/);
  await page.getByRole('button', { name: '一起发现一轮' }).click();
  await page.waitForFunction(() => document.getElementById('error').textContent.includes('查看已有日记'));
  await page.waitForTimeout(300);
  assert.match(await page.getByRole('alert').textContent(), /查看已有日记/, 'polling must retain an actionable operation failure');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0], { action: 'start', characterId: 'alpha', characterEpoch: 1 });
  character = { id: 'beta', epoch: 2, name: '另一个伙伴' };
  await page.getByText('当前伙伴：另一个伙伴').waitFor();
  assert.equal(await page.locator('#diary .entry').count(), 0, 'new role cannot retain old diary');
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.ok(getRequests < 20, 'slow polling must remain serialized');
  await page.screenshot({ path: path.join(dir, 'companion-ui.png') });
  console.log(JSON.stringify({ ok: true, checks: ['slow-poll', 'escaped-diary', 'visible-failure', 'epoch-payload', 'role-clear'], screenshot: path.join(dir, 'companion-ui.png') }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
