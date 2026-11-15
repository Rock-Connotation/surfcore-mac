import './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { findBrowser } from '../lib/bili-qr-login.mjs';
import { douyinCompanionPage } from '../lib/douyin-companion-page.mjs';

const role = { id: 'fixture', epoch: 1, name: '伙伴' };
const samples = [6, 1, 2, 3];
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(douyinCompanionPage); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('content-type', 'application/json');
  if (url.pathname.endsWith('/companion-sharing')) {
    res.end(JSON.stringify({ok:true, character:role, value:{revision:1, openings:samples.map(n=>({id:`opening-${n}`,sourceTitle:`分享${n}`,text:'fixture',coverage:{transcriptComplete:true,frameSamples:n}})),messages:[],active:null}}));
  } else if (url.pathname.endsWith('/companion')) {
    res.end(JSON.stringify({ok:true,character:role,readiness:{ok:true},value:{daily:{},acceptance:{},recentJobs:[{jobId:'fixture',state:'completed',items:samples.map(n=>({title:`日记${n}`,state:'completed',memorySaved:true,coverage:{transcriptComplete:true,frameSamples:n}}))}]}}));
  } else { res.writeHead(404); res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath = findBrowser()?.executable;
  assert.ok(executablePath, 'Chromium required for actual page rendering');
  browser = await chromium.launch({ headless:true, executablePath });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.opening-card').first().waitFor();
  await page.locator('#diary .entry').first().waitFor();
  const sharing = await page.locator('.opening-card').allTextContents();
  const diary = await page.locator('#diary .entry').allTextContents();
  console.log('rendered sharing:', JSON.stringify(sharing));
  console.log('rendered diary:', JSON.stringify(diary));
  assert.doesNotMatch(sharing[0], /6\s*张稀疏画面/);
  assert.doesNotMatch(diary[0], /6\s*张稀疏画面/);
  for (let i=1; i<samples.length; i++) {
    assert.ok(sharing[i].includes(`${samples[i]} 张稀疏画面`));
    assert.ok(diary[i].includes(`${samples[i]}张稀疏画面`));
  }
  console.log('PASS actual page coverage rendering');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
