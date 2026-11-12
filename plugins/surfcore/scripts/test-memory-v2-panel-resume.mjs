import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryV2Panel } from '../lib/memory-v2-panel.mjs';

const OP = 'admin-resume-fixture-1';
const ORIGINAL = '她喜欢周末看海（最初确认的纠正原文）';
const INPUT = '最初确认的纠正原文';
const digestOf = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const previewOf = (operationId, action = 'correct') => ({ ok: true, operationId, revision: 7, payloadDigest: null, preview: { operationId, action, phase: 'intent_confirmed' } });
const base = (overrides = {}) => ({ ok: true, backend: 'v2', readiness: 'ready', revision: 7, character: { id: 'alpha', epoch: 1, name: 'Alpha' }, capabilities: { shadow: true, correct: true, activation: false, backup: true, restore: true, purge: true, removeHot: true, organize: true, identity: true, migration: true, adminResume: true }, worker: { state: 'idle' }, backups: [], policies: [], approvedConversations: [], operations: [{ operationId: OP, action: 'correct', complete: false, phase: 'intent_confirmed', hint: '纠正原文待重新确认。' }], ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(handle) {
  const cells = []; let cursor = 0, tree; const effects = [], calls = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, value => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value; }]; },
    useRef: initial => { const i = cursor++; cells[i] ??= { current: initial }; return cells[i]; },
    useEffect: (effect, deps) => { const i = cursor++; const old = cells[i]; if (!old || deps.some((v, n) => old.deps[n] !== v)) { old?.cleanup?.(); cells[i] = { deps }; effects.push(() => { cells[i].cleanup = effect(); }); } },
  };
  function Btn() {}
  const Panel = createMemoryV2Panel(React, { Btn, fmtTime: String, api: async (path, options) => { calls.push({ path, ...options }); return handle(path, options); } });
  const render = () => { cursor = 0; tree = Panel({ roleKey: 'alpha' }); for (const effect of effects.splice(0)) effect(); return tree; };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : node == null || node === false ? '' : String(node);
  const buttons = label => nodes(tree).filter(n => (n.type === Btn || n.type === 'button') && text(n) === label);
  const button = label => { const found = buttons(label)[0]; assert.ok(found, `button ${label} exists`); return found; };
  const click = async label => { const target = button(label); assert.notEqual(target.props.disabled, true, `${label} enabled`); await target.props.onClick?.(); render(); };
  const fill = (label, value) => { const target = nodes(tree).find(n => n.props['aria-label'] === label); assert.ok(target, `input ${label} exists`); target.props.onChange({ target: { value } }); render(); };
  render();
  return { calls, render, text: () => text(tree), button, buttons, click, fill, nodes: () => nodes(tree), ready: async () => { await flush(); render(); } };
}
const resumeCalls = f => f.calls.filter(c => c.path?.includes('/admin-resume'));
const confirmCalls = f => resumeCalls(f).filter(c => !c.body?.preview);

// 1. Same original ID for preview and confirm; correct needs the original text; exact body shape; no UUID.
{
  let preview, confirm;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    const body = options.body;
    if (body.preview === true) { preview = body; return { ...previewOf(OP), payloadDigest: body.payloadDigest }; }
    confirm = body; return { ok: true, operationId: OP, complete: true, state: 'committed' };
  });
  await f.ready();
  assert.ok(f.button('预览按原编号恢复'), '按原编号恢复入口存在');
  await f.click('预览按原编号恢复');
  assert.match(f.text(), /MEMORY_CORRECTION_CONTENT_REQUIRED/);
  assert.match(f.text(), /最初确认的纠正原文/);
  assert.equal(resumeCalls(f).length, 0, 'correct without original text issues zero requests');
  f.fill(INPUT, ORIGINAL);
  await f.click('预览按原编号恢复');
  assert.ok(preview, 'preview was sent');
  assert.equal(preview.operationId, OP);
  assert.equal(preview.characterId, 'alpha'); assert.equal(preview.characterEpoch, 1); assert.equal(preview.expectedRevision, 7);
  assert.equal(preview.preview, true); assert.equal(preview.content, ORIGINAL);
  assert.equal(preview.payloadDigest, digestOf({ content: ORIGINAL, operationId: OP }));
  assert.deepEqual(Object.keys(preview).sort(), ['characterEpoch', 'characterId', 'content', 'expectedRevision', 'operationId', 'payloadDigest', 'preview']);
  assert.equal(preview.action, undefined, 'no new action id');
  assert.match(f.text(), /按原编号恢复预览/); assert.match(f.text(), new RegExp(OP)); assert.match(f.text(), /intent_confirmed/);
  await f.click('确认按原编号恢复');
  assert.ok(confirm, 'confirm was sent');
  assert.equal(confirm.operationId, OP); assert.equal(confirm.preview, undefined);
  assert.equal(confirm.payloadDigest, preview.payloadDigest); assert.equal(confirm.content, ORIGINAL);
  assert.match(f.text(), /已按原编号恢复/);
}
// 2. adminResume capability is the real gate; disabled with an actionable reason, no hidden request.
{
  const current = base(); current.capabilities.adminResume = false;
  const f = fixture(async () => current); await f.ready();
  assert.equal(f.button('预览按原编号恢复').props.disabled, true);
  assert.match(f.text(), /adminResume=false/);
  const n = f.calls.length; await f.button('预览按原编号恢复').props.onClick(); f.render();
  assert.equal(f.calls.length, n, 'disabled handler sends nothing');
  assert.equal(resumeCalls(f).length, 0);
  assert.ok(f.button('预览恢复处理'), 'lifecycle resume entry is preserved');
}
// 3. Lifecycle tasks and completed admin tasks are not offered the new entry.
{
  const f = fixture(async () => base({ operations: [
    { operationId: 'delete-1', action: 'request_delete', complete: false, state: 'access_revoked' },
    { operationId: 'done-1', action: 'correct', complete: true, state: 'committed' },
  ] })); await f.ready();
  assert.equal(f.buttons('预览按原编号恢复').length, 0);
  assert.ok(f.button('预览继续清理'), 'lifecycle continue_delete entry is preserved');
}
// 4. Non-correct actions never carry content and digest only the original ID.
{
  let preview;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base({ operations: [{ operationId: 'person-1', action: 'create_person', complete: false, phase: 'intent_confirmed' }] });
    preview = options.body; return { ...previewOf('person-1', 'create_person'), payloadDigest: options.body.payloadDigest };
  });
  await f.ready(); f.fill(INPUT, '不该被发送的替代文本');
  await f.click('预览按原编号恢复');
  assert.equal(preview.content, undefined);
  assert.equal(preview.operationId, 'person-1');
  assert.equal(preview.payloadDigest, digestOf({ operationId: 'person-1' }));
}
// 5. Mismatched preview digest/revision fails closed with an actionable hint and no confirm.
{
  const f = fixture(async (path, options) => path.includes('/status') ? base() : ({ ok: true, operationId: OP, revision: 7, payloadDigest: 'wrong', preview: {} }));
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复');
  assert.match(f.text(), /MEMORY_PREVIEW_INVALID/); assert.match(f.text(), /同一原编号/);
  assert.equal(confirmCalls(f).length, 0);
}
// 6. Revision change after preview invalidates confirmation.
{
  let current = base();
  const f = fixture(async (path, options) => path.includes('/status') ? structuredClone(current) : ({ ...previewOf(OP), payloadDigest: options.body.payloadDigest }));
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复');
  current = base({ revision: 8 }); await f.click('刷新状态'); await f.click('确认按原编号恢复');
  assert.match(f.text(), /MEMORY_POLICY_STALE/); assert.equal(confirmCalls(f).length, 0);
}
// 7. Backend structured failure is visible with code + hint; no success and no confirm.
{
  const f = fixture(async path => path.includes('/status') ? base() : ({ ok: false, code: 'MEMORY_DIGEST_CONFLICT', error: '原文与原操作摘要不一致', hint: '输入最初确认的原文，对同一原编号重新预览。' }));
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复');
  assert.match(f.text(), /MEMORY_DIGEST_CONFLICT/); assert.match(f.text(), /同一原编号/);
  assert.equal(confirmCalls(f).length, 0); assert.doesNotMatch(f.text(), /已按原编号恢复/);
}
// 8. Unknown receipt keeps the original ID for receipt lookup and never claims success.
{
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    if (path.includes('/receipt')) return { ok: true, operationId: OP, state: 'committed' };
    if (options.body.preview) return { ...previewOf(OP), payloadDigest: options.body.payloadDigest };
    return { ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: '提交状态待核对', hint: '按原编号核对', retry: 'query_receipt', sourceState: 'commit_unknown' };
  });
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复'); await f.click('确认按原编号恢复');
  assert.match(f.text(), new RegExp(`待核对操作：${OP}`)); assert.doesNotMatch(f.text(), /已按原编号恢复/);
  await f.click('核对提交状态');
  assert.equal(f.calls.at(-1).path, `/memory-v2/receipt?operationId=${OP}`);
}
// 9. A replacement operationId on confirm is an UNTRUSTWORTHY receipt: keep the ORIGINAL ID pending.
{
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    if (path.includes('/receipt')) return { ok: true, operationId: OP, state: 'committed' };
    if (options.body.preview) return { ...previewOf(OP), payloadDigest: options.body.payloadDigest };
    return { ok: true, operationId: 'replacement-uuid', complete: true, state: 'committed' };
  });
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复'); await f.click('确认按原编号恢复');
  assert.match(f.text(), /MEMORY_OPERATION_CONFLICT/); assert.match(f.text(), /保留原操作编号/);
  assert.doesNotMatch(f.text(), /已按原编号恢复/);
  assert.match(f.text(), new RegExp(`待核对操作：${OP}`), 'original ID stays visible as pending');
  assert.ok(f.button('核对提交状态'), 'original-ID receipt query button exists');
  assert.equal(f.button('预览按原编号恢复').props.disabled, true, 'new mutation blocked before receipt check');
  const posts = resumeCalls(f).length;
  await f.click('核对提交状态');
  assert.equal(f.calls.at(-1).path, `/memory-v2/receipt?operationId=${OP}`);
  assert.equal(resumeCalls(f).length, posts, 'receipt lookup issues zero repeat POST');
  assert.match(f.text(), /已确认提交/);
  assert.equal(f.button('预览按原编号恢复').props.disabled, false, 'mutation unlocked after original-ID receipt query');
}
// 11. Exact original correction text: trim ONLY for the empty check; bytes preserved in preview, confirm and digest.
{
  const SPACED = `  ${ORIGINAL}  `;
  let preview, confirm;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    const body = options.body;
    if (body.preview === true) { preview = body; return { ...previewOf(OP), payloadDigest: body.payloadDigest }; }
    confirm = body; return { ok: true, operationId: OP, complete: true, state: 'committed' };
  });
  await f.ready();
  f.fill(INPUT, '   '); await f.click('预览按原编号恢复');
  assert.match(f.text(), /MEMORY_CORRECTION_CONTENT_REQUIRED/);
  assert.equal(resumeCalls(f).length, 0, 'whitespace-only original text issues zero requests');
  f.fill(INPUT, SPACED); await f.click('预览按原编号恢复');
  assert.equal(preview.content, SPACED, 'preview carries exact original bytes');
  assert.equal(preview.payloadDigest, digestOf({ content: SPACED, operationId: OP }), 'digest uses exact original bytes');
  await f.click('确认按原编号恢复');
  assert.equal(confirm.content, SPACED, 'confirm carries exact original bytes');
  assert.equal(confirm.payloadDigest, preview.payloadDigest);
  assert.match(f.text(), /已按原编号恢复/);
}
// 10. Cancelling the preview clears it without mutation.
{
  const f = fixture(async (path, options) => path.includes('/status') ? base() : ({ ...previewOf(OP), payloadDigest: options.body.payloadDigest }));
  await f.ready(); f.fill(INPUT, ORIGINAL); await f.click('预览按原编号恢复'); await f.click('取消恢复预览');
  assert.doesNotMatch(f.text(), /按原编号恢复预览/); assert.equal(confirmCalls(f).length, 0);
}
console.log('PASS memory-v2 panel admin resume: original operation ID only, exact resume body, adminResume gate, lifecycle preserved, no fabricated content, all failure paths visible with code+hint');
