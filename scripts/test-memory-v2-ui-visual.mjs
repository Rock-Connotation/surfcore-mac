import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { deriveBiliV2PublicSourceSet } from '../plugins/surfcore/lib/bili-v2-public-source-set.mjs';
import { deriveMemoryProviderRouteId } from '../src/core/memory-v2-routing.js';

const root = resolve(import.meta.dirname, '..');
const capabilityBefore = process.argv.includes('--capability-before');
const capabilityScenario = capabilityBefore || process.argv.includes('--capability-after');
const personBefore = process.argv.includes('--person-before');
const personScenario = personBefore || process.argv.includes('--person-after');
const adminResumeBefore = process.argv.includes('--admin-resume-before');
const conflictBefore = process.argv.includes('--admin-resume-conflict-before');
const conflictScenario = conflictBefore || process.argv.includes('--admin-resume-conflict-after');
const adminResumeScenario = adminResumeBefore || process.argv.includes('--admin-resume-after') || conflictScenario;
const publicSetBefore = process.argv.includes('--public-set-before');
const publicSetScenario = publicSetBefore || process.argv.includes('--public-set-after');
const artifacts = resolve(root, process.env.MEMORY_UI_ARTIFACTS || (conflictScenario ? '_backups/memory-v2-panel-admin-resume/visual-conflict' : adminResumeScenario ? '_backups/memory-v2-panel-admin-resume/visual' : personScenario ? '_backups/memory-v2-ui/person-registration-run1' : capabilityScenario ? '_backups/memory-v2-ui/capability-run1' : '_backups/memory-v2-ui'));
const deps = process.env.MEMORY_UI_REACT_DEPS;
assert.ok(deps, 'Set MEMORY_UI_REACT_DEPS to an existing local node_modules containing React 19 and react-dom; the fixture never installs or downloads dependencies.');
const before = process.argv.includes('--before');
const serve = process.argv.includes('--serve');
const requests = [];
const capabilities = { shadow: true, correct: true, activation: false, backup: true, restore: true, purge: true, removeHot: false, organize: true, identity: true, migration: true };
export const status = { ok: true, backend: 'v2', readiness: 'ready', revision: 7, storeGeneration: 'shadow-1', characterId: 'fixture-role', role: '夹具角色', character: { id: 'fixture-role', epoch: 1, name: '夹具角色' }, capabilities,
  worker: { state: 'paused', code: 'MEMORY_BUDGET_EXHAUSTED', error: '额外整理额度不足，来源仍保留', hint: '查看费用与预留，或等待下一周期。' },
  lastSuccessfulIngest: '2026-11-09T12:00:00Z', counts: { sources: 24, committed: 20, rejected: 1, review: 3 },
  queue: { state: 'queued_durable', pending: 3 }, lastReceipt: { source: 'queued_durable', selection: 'review', index: 'pending' },
  backups: [{ id: 'backup-fixture-1', label: '今日影子备份', verified: true }], operations: [{ operationId: 'delete-fixture', action: 'request_delete', state: 'access_revoked', hint: '活跃库及受管理副本仍待清理。' }],
  policies: [], approvedConversations: [{ id: 'qq:group:fixture', label: '已批准的测试群', processorScopes: ['local'] }], bindings: [],
  budget: { settled: 2, reserved: 1, unknownHolds: 1 }, migration: { snapshot: 'snapshot-fixture', highWater: 24, checkpoint: 20, imported: 20, quarantined: 2, gates: { windows: 'unknown', exactNode: 'unknown' } } };
if (adminResumeScenario) { capabilities.adminResume = true; status.operations.push({ operationId: 'admin-resume-fixture-1', action: 'correct', complete: false, phase: 'intent_confirmed', hint: '按原编号恢复预览待确认；需输入最初确认的纠正原文。' }); }
let publicSetPreview;
if (publicSetScenario) {
  const binding = { characterId: 'fixture-role', characterEpoch: 1, accountMid: '9', providerRouteId: deriveMemoryProviderRouteId({ provider: 'fixture-provider', model: 'fixture-model' }).providerRouteId };
  const set = deriveBiliV2PublicSourceSet({ ...binding, selectors: [{ kind: 'video', bvid: 'BV1234567890', aid: '123', authorMid: '9007199254740993123' },
    { kind: 'comment', rpid: '9007199254740993124', type: '1', oid: '11', root: '0', parent: '0', authorMid: '8' },
    { kind: 'video', bvid: 'BVabcdefghij', aid: '456', authorMid: '7' }], outputTarget: { audience: 'public', kind: 'dynamic' } });
  assert.equal(set.ok, true, JSON.stringify(set));
  publicSetPreview = { ...binding, id: set.id, provider: 'fixture-provider', model: 'fixture-model', selectors: set.selectors, outputTarget: set.outputTarget };
  status.approvedConversations = [{ id: `bili-public-set-${set.id}`, label: set.label, sourceSetPreview: publicSetPreview, processorScopes: [{ id: 'exact-model', label: '仅此来源集合与所示精确模型' }] }];
}
const records = [{ id: 'record-fixture', revision: 2, kind: 'understanding', content: '她现在喜欢在周末看海；早期偏好保留为历史版本。', certainty: 'reported', status: 'current', validFrom: '2026-11-01', recordedAt: '2026-11-09', roots: ['source-fixture'], links: [{ id: 'earlier-fixture', relation: 'supersedes' }], coverage: { audio: 'partial', frames: 'sampled' } }];
const legacy = { status: { chars: 1480, maxChars: 60000, percent: 2.5, levelLabel: '正常', lastMaintenanceAt: '2026-11-09T12:00:00Z', counts: { vivid: 4, clear: 8 } }, config: {}, records: [], markdown: '' };
const fixtureState = structuredClone({ status, records, legacy });
const panelPath = publicSetBefore ? '_backups/memory-v2-coordinator/bili-public-set-integration/ui-before/memory-v2-panel.mjs' : conflictBefore ? '_backups/memory-v2-panel-admin-resume/run1/memory-v2-panel.run1.mjs' : adminResumeBefore ? '_backups/memory-v2-panel-admin-resume/before-source/plugins/surfcore/lib/memory-v2-panel.mjs' : personBefore ? '_backups/memory-v2-ui/person-registration-run1/before-source/plugins/surfcore/lib/memory-v2-panel.mjs' : capabilityBefore ? '_backups/memory-v2-ui/capability-run1/before-source/plugins/surfcore/lib/memory-v2-panel.mjs' : 'plugins/surfcore/lib/memory-v2-panel.mjs';
const panelSource = await readFile(resolve(root, panelPath), 'utf8');
const sourcePath = before ? '_backups/memory-v2-ui/original/client.js' : 'plugins/surfcore/lib/client.js';
const wrappers = [['react', 'react/cjs/react.production.js'], ['scheduler', 'scheduler/cjs/scheduler.production.js'], ['react-dom', 'react-dom/cjs/react-dom.production.js'], ['react-dom/client', 'react-dom/cjs/react-dom-client.production.js']];
const bundle = 'const modules={};const require=n=>modules[n];' + (await Promise.all(wrappers.map(async ([name, file]) => `(()=>{const module={exports:{}};const exports=module.exports;${await readFile(resolve(deps, file), 'utf8')}\nmodules[${JSON.stringify(name)}]=module.exports;})();`))).join('\n') + '\nwindow.React=modules.react;window.ReactDOM=modules["react-dom/client"];';
const source = (await readFile(resolve(root, sourcePath), 'utf8')).replace('return module.exports;\n  },', 'exports.__fixture={MemoryCardPanel, CSS, MemoryV2Panel: typeof MemoryV2Panel === "function" ? MemoryV2Panel : null}; return module.exports;\n  },');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆面板 · 隔离夹具</title><style>:root{color-scheme:light;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#5b6472;--dsw-alias-border-l2:#d0d5dd;--dsw-alias-brand-primary:#2f6fed}body{margin:0;padding:16px;font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;background:#fff}main{max-width:1000px;margin:auto}*{box-sizing:border-box}</style><main><p>隔离夹具 · 实际生产记忆组件 · 模拟 API · 浅色</p><div id="root"></div></main><script src="/react.js"></script><script>window.__ModuleLoader__={load:({factory})=>{window.client=factory(n=>n==='react'?React:{});}};</script><script src="/client.js"></script><script>const F=client.__fixture;const style=document.createElement('style');style.textContent=F.CSS;document.head.append(style);const h=React.createElement;ReactDOM.createRoot(document.getElementById('root')).render(h(React.Fragment,null,F.MemoryV2Panel?h(F.MemoryV2Panel,{initialStatus:null}):null,h(F.MemoryCardPanel,{view:'summary',data:${JSON.stringify(legacy)},reload:async()=>{},busy:'',setBusy:()=>{},toast:()=>{},unified:{},setUnified:()=>{}})));</script></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (url.pathname === '/dsh-surfcore/api/memory-v2/panel-client') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(panelSource); return; }
  if (url.pathname === '/react.js' || url.pathname === '/client.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(url.pathname === '/react.js' ? bundle : source); return; }
  if (url.pathname.endsWith('/status')) { requests.push({ method: 'GET', path: url.pathname }); res.end(JSON.stringify(status)); return; }
  if (url.pathname.endsWith('/search')) { res.end(JSON.stringify({ ok: true, records })); return; }
  if (url.pathname.endsWith('/receipt')) { requests.push({ method: 'GET', path: url.pathname, operationId: url.searchParams.get('operationId') }); res.end(JSON.stringify({ ok: true, operationId: url.searchParams.get('operationId'), state: 'committed' })); return; }
  if (url.pathname.endsWith('/manage')) {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push(value);
    if (value.action.startsWith('preview_') || value.payload?.preview === true) { res.end(JSON.stringify({ ok: true, revision: 7, payloadDigest: value.payload.payloadDigest, preview: { sources: 2, derivedVersions: 3, retainedCopies: 1, postBackupSources: 4, currentControls: 'preserved', budget: 'preserved', quarantine: 2, ...(publicSetScenario && value.action === 'configure_policy' ? { sourceSetPreview: publicSetPreview } : {}) } })); return; }
    if (value.action === 'create_person') { status.bindings = [{ id: 'binding-from-mock', platform: value.payload.platform, accountId: value.payload.accountId, personId: 'person-from-mock-server' }]; status.revision = 8; res.end(JSON.stringify({ ok: true, state: 'committed' })); return; }
    res.end(JSON.stringify({ ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: '提交状态待核对', hint: '核对同一操作编号。', operationId: value.operationId, state: 'commit_unknown' })); return;
  }
  if (url.pathname.endsWith('/admin-resume')) {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push({ path: url.pathname, method: 'POST', ...value });
    if (value.preview === true) { res.end(JSON.stringify({ ok: true, operationId: value.operationId, revision: 7, payloadDigest: value.payloadDigest, preview: { operationId: value.operationId, action: 'correct', phase: 'intent_confirmed' } })); return; }
    if (conflictScenario) { res.end(JSON.stringify({ ok: true, operationId: 'replacement-uuid', complete: true, state: 'committed' })); return; }
    res.end(JSON.stringify({ ok: true, operationId: value.operationId, complete: true, state: 'committed' })); return;
  }
  if (url.pathname === '/requests') { res.end(JSON.stringify(requests)); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
if (serve) { console.log(url); } else {
  let browser;
  try {
    await mkdir(artifacts, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: process.env.MEMORY_UI_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ colorScheme: 'light', serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height }); await page.goto(url); await page.getByText('记忆卡', { exact: true }).waitFor();
      if (!before) await page.getByText('V2 影子管理', { exact: true }).waitFor();
      if (capabilityScenario) {
        await page.getByRole('button', { name: '经历与当前认识', exact: true }).click();
        await page.getByRole('button', { name: '搜索当前角色', exact: true }).click();
        await page.getByText(records[0].content, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '预览移出热记忆', exact: true }).isEnabled(), capabilityBefore, 'removeHot:false is independent of purge:true after repair');
        for (const name of ['预览禁止再次使用', '预览删除来源与派生']) assert.equal(await page.getByRole('button', { name, exact: true }).isEnabled(), true);
      }
      if (personScenario) {
        await page.getByRole('button', { name: '身份与权限', exact: true }).click();
        await page.getByLabel('平台稳定账号').fill('fixture-account-7');
        assert.equal(await page.getByRole('button', { name: '预览关联账号', exact: true }).isEnabled(), false);
        const register = page.getByRole('button', { name: '预览从此账号登记人物', exact: true });
        if (personBefore) assert.equal(await register.count(), 0);
        else assert.equal(await register.isEnabled(), true);
      }
      if (adminResumeScenario && !conflictScenario) {
        const resume = page.getByRole('button', { name: '预览按原编号恢复', exact: true });
        if (adminResumeBefore) assert.equal(await resume.count(), 0, 'before: no admin-resume entry');
        else assert.equal(await resume.isEnabled(), true, 'after: adminResume:true enables original-ID resume');
      }
      if (conflictScenario) {
        await page.getByLabel('最初确认的纠正原文').fill('她喜欢周末看海（最初确认的纠正原文）');
        await page.getByRole('button', { name: '预览按原编号恢复', exact: true }).click();
        await page.getByText('按原编号恢复预览 · 尚未执行', { exact: true }).waitFor();
        await page.getByRole('button', { name: '确认按原编号恢复', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'MEMORY_OPERATION_CONFLICT' }).waitFor();
        const pending = page.getByText('待核对操作：admin-resume-fixture-1', { exact: true });
        const check = page.getByRole('button', { name: '核对提交状态', exact: true });
        const newMutation = page.getByRole('button', { name: '预览按原编号恢复', exact: true });
        if (conflictBefore) {
          assert.equal(await pending.count(), 0, 'before: mismatched receipt hides original-ID pending state');
          assert.equal(await check.count(), 0, 'before: original-ID receipt query unavailable');
          assert.equal(await newMutation.isEnabled(), true, 'before: new mutation wrongly still allowed');
        } else {
          await pending.waitFor();
          assert.equal(await check.isEnabled(), true, 'after: original-ID receipt query is available');
          assert.equal(await newMutation.isDisabled(), true, 'after: new mutation disabled until receipt check');
        }
      }
      if (publicSetScenario) {
        await page.getByRole('button', { name: '身份与权限', exact: true }).click();
        await page.getByLabel('允许共享的会话').selectOption(status.approvedConversations[0].id);
        await page.getByLabel('允许的处理范围').selectOption('exact-model');
        await page.getByRole('button', { name: '预览共享范围', exact: true }).click();
        const approval = page.getByRole('region', { name: '操作预览', exact: true }); await approval.waitFor();
        const complete = approval.getByRole('region', { name: '本次批准的确切公开来源集合', exact: true });
        if (publicSetBefore) assert.equal(await complete.count(), 0, 'before: complete source list was absent from the approval');
        else {
          await complete.waitFor(); assert.equal(await complete.locator('li').count(), 3);
          for (const value of ['BV1234567890', 'BVabcdefghij', '9007199254740993123', '9007199254740993124', 'fixture-provider / fixture-model']) assert.ok((await complete.textContent()).includes(value));
          assert.ok((await complete.textContent()).includes('私信保持隔离'));
          assert.equal(await approval.getByText('活跃库清理', { exact: true }).count(), 0, 'Sharing approval must not display deletion cleanup statistics.');
        }
      }
      await page.screenshot({ path: resolve(artifacts, `${before || capabilityBefore || personBefore || adminResumeBefore || conflictBefore || publicSetBefore ? 'before' : 'after'}-${device}-light.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${device} horizontal overflow`);
    }
    if (!before && !capabilityScenario && !personScenario && !adminResumeScenario && !publicSetScenario) {
      await page.getByRole('button', { name: '刷新状态', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '保存与待办');
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
      await page.getByRole('button', { name: '预览备份', exact: true }).click();
      await page.getByRole('button', { name: '确认执行备份', exact: true }).waitFor();
      await page.getByRole('button', { name: '确认执行备份', exact: true }).dblclick();
      await page.getByRole('button', { name: '核对提交状态', exact: true }).click();
      await page.getByText('已确认提交；具体完成阶段以回执为准。', { exact: true }).waitFor();
      const mutations = requests.filter(r => r.action === 'backup'); assert.equal(mutations.length, 1);
      assert.equal(requests.find(r => r.action === 'preview_backup').operationId, mutations[0].operationId);
      assert.equal(requests.find(r => r.path?.endsWith('/receipt')).operationId, mutations[0].operationId);
      await page.getByRole('button', { name: '经历与当前认识', exact: true }).click();
      await page.getByRole('button', { name: '搜索当前角色', exact: true }).click();
      await page.getByText(records[0].content, { exact: true }).waitFor();
      await page.getByRole('button', { name: '恢复与费用', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '启用 V2', exact: true }).isEnabled(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'recovery mobile overflow');
      await page.getByRole('button', { name: '身份与权限', exact: true }).click();
      await page.getByLabel('允许共享的会话').selectOption('qq:group:fixture');
      await page.getByLabel('允许的处理范围').selectOption('local');
      assert.equal(await page.getByRole('button', { name: '预览共享范围', exact: true }).isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'privacy mobile overflow');
      await page.route('**/memory-v2/status', route => route.fulfill({ json: { ok: false, code: 'MEMORY_FIXTURE_OFFLINE', error: '隔离服务不可用', hint: '请刷新状态' } }));
      await page.reload();
      await page.getByRole('alert').filter({ hasText: 'MEMORY_FIXTURE_OFFLINE' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '预览备份', exact: true }).count(), 0);
    }
    if (personScenario && !personBefore) {
      await page.getByRole('button', { name: '预览从此账号登记人物', exact: true }).click();
      await page.getByText('将从当前角色中已验证的稳定来源账号登记新人物并建立锚点绑定；不按昵称自动合并，也不自动扩大跨平台权限。人物编号由服务生成，提交后刷新关联列表。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '确认执行登记人物', exact: true }).dblclick();
      await page.getByText('qq / fixture-account-7 → person-from-mock-server', { exact: true }).waitFor();
      const register = requests.filter(r => r.action === 'create_person');
      assert.equal(register.length, 2); assert.equal(register[0].payload.preview, true); assert.equal(register[1].payload.preview, undefined);
      assert.equal(register[0].operationId, register[1].operationId); assert.equal(register[1].characterId, 'fixture-role'); assert.equal(register[1].characterEpoch, 1);
      assert.equal(register[1].payload.personId, undefined);
      assert.equal(register[1].payload.payloadDigest, createHash('sha256').update(JSON.stringify({ accountId: 'fixture-account-7', platform: 'qq' })).digest('hex'));
      assert.equal(requests.filter(r => r.method === 'GET' && r.path?.endsWith('/status')).length, 3, 'successful registration reloads real returned bindings');
    }
    if (adminResumeScenario && !adminResumeBefore && !conflictScenario) {
      await page.getByLabel('最初确认的纠正原文').fill('她喜欢周末看海（最初确认的纠正原文）');
      await page.getByRole('button', { name: '预览按原编号恢复', exact: true }).click();
      await page.getByText('按原编号恢复预览 · 尚未执行', { exact: true }).waitFor();
      await page.getByRole('button', { name: '确认按原编号恢复', exact: true }).click();
      await page.getByText('已按原编号恢复；请刷新状态并核对原编号回执。', { exact: true }).waitFor();
      const resumes = requests.filter(r => r.path?.endsWith('/admin-resume'));
      assert.equal(resumes.length, 2);
      assert.equal(resumes[0].operationId, 'admin-resume-fixture-1');
      assert.equal(resumes[0].preview, true);
      assert.equal(resumes[0].characterId, 'fixture-role');
      assert.equal(resumes[0].characterEpoch, 1);
      assert.equal(resumes[0].expectedRevision, 7);
      assert.equal(resumes[1].operationId, resumes[0].operationId);
      assert.equal(resumes[1].preview, undefined);
      assert.equal(resumes[1].payloadDigest, resumes[0].payloadDigest);
      assert.equal(requests.filter(r => r.action === 'correct' || r.action === 'resume').length, 0, 'no /manage mutation for admin resume');
    }
    if (conflictScenario && !conflictBefore) {
      const postsBefore = requests.filter(r => r.path?.endsWith('/admin-resume')).length;
      await page.getByRole('button', { name: '核对提交状态', exact: true }).click();
      await page.getByText('已确认提交；具体完成阶段以回执为准。', { exact: true }).waitFor();
      assert.equal(requests.filter(r => r.path?.endsWith('/admin-resume')).length, postsBefore, 'receipt lookup sends zero repeat POST');
      assert.equal(await page.getByRole('button', { name: '预览按原编号恢复', exact: true }).isEnabled(), true, 'mutation unlocked after original-ID receipt query');
      const receipts = requests.filter(r => r.path?.includes('/receipt'));
      assert.equal(receipts.length, 1, 'exactly one original-ID receipt GET');
      assert.equal(receipts[0].operationId, 'admin-resume-fixture-1');
    }
    if (publicSetScenario && !publicSetBefore) {
      await page.getByRole('button', { name: '取消预览', exact: true }).click();
      await page.route('**/memory-v2/manage', async route => {
        const response = await route.fetch(), value = await response.json();
        if (value.preview) delete value.preview.sourceSetPreview;
        await route.fulfill({ response, json: value });
      });
      await page.getByRole('button', { name: '预览共享范围', exact: true }).click();
      const alert = page.getByRole('alert'); await alert.waitFor(); assert.match(await alert.textContent(), /MEMORY_PREVIEW_INVALID/); assert.match(await alert.textContent(), /重新预览/);
      assert.equal(await page.getByRole('button', { name: '确认执行共享范围', exact: true }).count(), 0);
      assert.equal(requests.filter(value => value.action === 'configure_policy' && value.payload?.preview !== true).length, 0, 'No approval may be committed after incomplete preview.');
    }
    assert.deepEqual(errors, []);
    await writeFile(resolve(artifacts, `${before || capabilityBefore || personBefore || adminResumeBefore || conflictBefore || publicSetBefore ? 'before' : 'after'}-evidence.json`), JSON.stringify({ scenario: publicSetScenario ? 'actual production panel, exact public source list and current role/account/model, explicit preview only' : conflictScenario ? 'replacement operationId on confirm: original-ID pending receipt state, real React before/after' : adminResumeScenario ? 'actual production panel, original admin operation ID resume, fixed fixture role and incomplete correct task' : personScenario ? 'actual current V2 identity section, verified-account transport fixture, empty personId' : capabilityScenario ? 'actual current V2 panel records, purge:true/removeHot:false, fixed fixture role' : 'actual production panel, simulated API, v1 plus v2 shadow, fixed fixture role',
      fixtureState: capabilityScenario || personScenario || adminResumeScenario || publicSetScenario ? fixtureState : undefined,
      sourceHashes: { client: createHash('sha256').update(source).digest('hex'), panel: createHash('sha256').update(panelSource).digest('hex'), fixture: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex') }, viewports: [[1440, 1000], [390, 844]], theme: 'light', errors, requests }, null, 2));
    console.log(`PASS ${before || capabilityBefore || personBefore || adminResumeBefore || conflictBefore || publicSetBefore ? 'Before' : 'After'} desktop/mobile real component evidence; requests=${requests.length}`);
  } finally { await browser?.close(); await new Promise(r => server.close(r)); }
}
