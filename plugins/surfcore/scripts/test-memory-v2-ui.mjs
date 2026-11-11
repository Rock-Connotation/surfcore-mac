import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryV2Panel } from '../lib/memory-v2-panel.mjs';

const base = () => ({ ok: true, backend: 'v1', revision: 7, character: { id: 'alpha', epoch: 1, name: 'Alpha' }, capabilities: { shadow: true, correct: true, activation: false, backup: true, restore: true, purge: true, removeHot: true, organize: true, identity: true, migration: true }, worker: { state: 'idle' }, backups: [], operations: [], policies: [], approvedConversations: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(handle = async () => base()) {
  const cells = []; let cursor = 0; let tree; const effects = []; const calls = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => { const i = cursor++; cells[i] ??= { value: initial }; return [cells[i].value, value => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value; }]; },
    useRef: initial => { const i = cursor++; cells[i] ??= { current: initial }; return cells[i]; },
    useEffect: (effect, deps) => { const i = cursor++; const old = cells[i]; if (!old || deps.some((v, n) => old.deps[n] !== v)) { old?.cleanup?.(); cells[i] = { deps }; effects.push(() => { cells[i].cleanup = effect(); }); } },
  };
  function Btn() {}
  const Panel = createMemoryV2Panel(React, { Btn, fmtTime: String, api: async (path, options) => { calls.push({ path, ...options }); return handle(path, options); } });
  const render = (roleKey = 'alpha') => { cursor = 0; tree = Panel({ roleKey }); for (const effect of effects.splice(0)) effect(); return tree; };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : node == null || node === false ? '' : String(node);
  const button = label => { const found = nodes(tree).find(n => (n.type === Btn || n.type === 'button') && text(n) === label); assert.ok(found, `button ${label} exists`); return found; };
  const click = async label => { const target = button(label); assert.notEqual(target.props.disabled, true, `${label} enabled`); await target.props.onClick?.(); render(); };
  const input = label => nodes(tree).find(n => n.props['aria-label'] === label);
  const preview = body => ({ ok: true, revision: 7, payloadDigest: body.payload.payloadDigest, preview: { sources: 2, derivedVersions: 3, retainedCopies: 1 } });
  render();
  return { calls, render, text: () => text(tree), button, click, input, nodes: () => nodes(tree), ready: async () => { await flush(); render(); }, preview };
}

// A server-side uncertain commit must retain the concrete preview identity, even after a double click.
{
  let commit;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    if (path.includes('/receipt')) return { ok: true, operationId: commit.operationId, state: 'committed' };
    const body = options.body;
    if (body.action === 'preview_backup') return f.preview(body);
    commit = body;
    return { ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: '待核对', hint: '查询原编号', state: 'commit_unknown' };
  });
  await f.ready(); await f.click('预览备份');
  const confirm = f.button('确认执行备份').props.onClick;
  await Promise.all([confirm(), confirm()]); f.render();
  const mutations = f.calls.filter(c => c.body?.action === 'backup'); assert.equal(mutations.length, 1);
  const p = f.calls.find(c => c.body?.action === 'preview_backup').body;
  assert.equal(p.operationId, commit.operationId); assert.equal(commit.characterId, 'alpha'); assert.equal(commit.characterEpoch, 1);
  assert.equal(commit.payload.payloadDigest, createHash('sha256').update('{}').digest('hex'));
  assert.match(f.text(), /MEMORY_COMMIT_UNCERTAIN.*核对提交状态/s);
  await f.click('核对提交状态'); assert.equal(f.calls.at(-1).path, `/memory-v2/receipt?operationId=${commit.operationId}`);
  assert.match(f.text(), /已确认提交/);
}
// Optional values remain unknown and capability gates reject handler invocation too.
{
  const f = fixture(async () => ({ ...base(), capabilities: {}, counts: undefined, queue: undefined })); await f.ready();
  const disabled = f.button('预览备份'); assert.equal(disabled.props.disabled, true); await disabled.props.onClick();
  assert.equal(f.calls.length, 1); assert.match(f.text(), /未知/); assert.doesNotMatch(f.text(), /24 \/ 20/);
  await f.click('恢复与费用'); assert.equal(f.button('启用 V2').props.disabled, true); assert.match(f.text(), /费用未知/);
}
// Every HTTP-200 ok:false stays visible with its machine code and a next action; no polling flood.
{
  const f = fixture(async () => ({ ok: false, code: 'MEMORY_NOT_READY', error: '尚未就绪', hint: '请检查 Host' })); await f.ready();
  assert.match(f.text(), /尚未就绪.*MEMORY_NOT_READY.*请检查 Host/); await flush(); assert.equal(f.calls.length, 1);
}
// Network failure and malformed previews cannot create a mutation.
{
  const f = fixture(async (path, options) => path.includes('/status') ? base() : ({ ok: true, revision: 7, payloadDigest: 'wrong', preview: {} })); await f.ready(); await f.click('预览备份');
  assert.match(f.text(), /MEMORY_PREVIEW_INVALID.*重新读取状态/); assert.equal(f.calls.filter(c => c.body?.action === 'backup').length, 0);
  const offline = fixture(async () => { throw new TypeError('fetch failed'); }); await offline.ready();
  assert.match(offline.text(), /MEMORY_REQUEST_FAILED.*请刷新状态/); assert.equal(offline.calls.length, 1);
}
// A role/epoch change invalidates a previously accepted preview without reusing its payload.
{
  let current = base();
  const f = fixture(async (path, options) => path.includes('/status') ? structuredClone(current) : f.preview(options.body));
  await f.ready(); await f.click('预览备份'); const oldConfirm = f.button('确认执行备份').props.onClick;
  current = { ...base(), character: { id: 'beta', epoch: 2, name: 'Beta' } }; await f.click('刷新状态'); await oldConfirm(); f.render();
  assert.match(f.text(), /MEMORY_CONTEXT_REQUIRED.*旧操作不会提交/); assert.equal(f.calls.filter(c => c.body?.action === 'backup').length, 0);
}
// A changed revision is similarly fail closed; preview and actual payload never carry path/SQL controls.
{
  let current = base();
  const f = fixture(async (path, options) => path.includes('/status') ? structuredClone(current) : f.preview(options.body)); await f.ready(); await f.click('预览备份');
  current.revision = 8; await f.click('刷新状态'); await f.click('确认执行备份'); assert.match(f.text(), /MEMORY_POLICY_STALE/);
  assert.equal(f.calls.filter(c => c.body?.action === 'backup').length, 0);
}
// Search inspects only the current role; removal, suppression, correction and root deletion are separate actions.
{
  const f = fixture(async path => path.includes('/search') ? { ok: true, records: [{ id: 'r', revision: 2, status: 'current', certainty: 'inferred', content: '待核实的认识', roots: ['source'], links: ['old'], coverage: 'partial' }] } : base()); await f.ready();
  await f.click('经历与当前认识'); f.input('搜索当前角色记忆').props.onChange({ target: { value: '海 & 风' } }); f.render();
  const form = f.nodes().find(n => n.type === 'form'); form.props.onSubmit({ preventDefault() {} }); await flush(); f.render();
  assert.equal(f.calls.at(-1).path, '/memory-v2/search?q=%E6%B5%B7%20%26%20%E9%A3%8E&limit=20');
  assert.match(f.text(), /当前版本.*推断，待核实.*有效时间、证据与覆盖/s);
  const correctionInput = f.nodes().find(n => n.type === 'input' && n.props.placeholder === '明确写出修正，保留原版关联');
  correctionInput.props.onChange({ target: { value: '真实后端实现后才可提交的新版本认识' } }); f.render();
  assert.equal(f.button('预览纠正认识').props.disabled, false, 'explicit correct capability enables future genuine correction');
  for (const label of ['预览移出热记忆', '预览禁止再次使用', '预览删除来源与派生', '预览纠正认识']) assert.ok(f.button(label));
}
// Canonical service phases take precedence over HTTP status and generic error codes.
for (const [name, result, httpStatus] of [
  ['http200-worker-source', { ok: false, code: 'MEMORY_WORKER_DIED', error: '工作进程退出', hint: '按原编号核对', sourceState: 'commit_unknown', retry: 'query_receipt' }],
  ['http200-operation-unknown', { ok: false, code: 'MEMORY_WORKER_DIED', error: '未知执行结果', hint: '查询回执', operationState: 'unknown' }],
  ['http409-completed-before-cancel', { ok: false, code: 'CHARACTER_EPOCH_STALE', error: '角色版本变化', hint: '查询原回执', sourceState: 'committed', operationState: 'completed_before_cancel', retry: 'query_receipt' }, 409],
  ['oktrue-source-unknown', { ok: true, sourceState: 'commit_unknown' }],
  ['oktrue-nested-operation', { ok: true, receipt: { operationState: 'unknown' } }],
  ['okfalse-nested-completed', { ok: false, code: 'CHARACTER_EPOCH_STALE', error: '角色变化', hint: '查询回执', receipt: { sourceState: 'committed', operationState: 'completed_before_cancel' } }],
  ['retry-alone', { ok: true, retry: 'query_receipt' }],
]) {
  let operationId;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    if (path.includes('/receipt')) return { ok: true, operationId, state: 'committed' };
    if (options.body.action === 'preview_backup') return f.preview(options.body);
    operationId = options.body.operationId;
    if (httpStatus) throw Object.assign(new Error(result.error), { status: httpStatus, code: result.code, hint: result.hint, data: result });
    return result;
  });
  await f.ready(); await f.click('预览备份'); await f.click('确认执行备份');
  assert.equal(f.button('预览备份').props.disabled, true, `${name}: new mutation disabled`);
  const count = f.calls.length; await f.button('预览备份').props.onClick(); f.render();
  assert.equal(f.calls.length, count, `${name}: repeated handler cannot issue a preview or mutation`);
  assert.equal(f.calls.filter(c => c.body?.action === 'backup').length, 1, name);
  if (result.ok === false) { assert.match(f.text(), new RegExp(result.code), name); assert.match(f.text(), new RegExp(result.hint), name); }
  await f.click('核对提交状态');
  assert.equal(f.calls.at(-1).path, `/memory-v2/receipt?operationId=${operationId}`, name);
  assert.equal(f.calls.filter(c => c.body?.action === 'preview_backup').length, 1, name);
}
// Canonical receipt phases also override a misleading legacy committed alias.
{
  let operationId; let receiptCount = 0;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return base();
    if (path.includes('/receipt')) return ++receiptCount === 1
      ? { ok: true, operationId, state: 'committed', receipt: { operationState: 'unknown' } }
      : { ok: true, operationId, state: 'committed' };
    if (options.body.action === 'preview_backup') return f.preview(options.body);
    operationId = options.body.operationId; return { ok: true, operationState: 'unknown' };
  });
  await f.ready(); await f.click('预览备份'); await f.click('确认执行备份'); await f.click('核对提交状态');
  assert.equal(f.button('预览备份').props.disabled, true); assert.doesNotMatch(f.text(), /已确认提交/);
  await f.click('核对提交状态'); assert.match(f.text(), /已确认提交/);
  assert.deepEqual(f.calls.filter(c => c.path.includes('/receipt')).map(c => c.path), Array(2).fill(`/memory-v2/receipt?operationId=${operationId}`));
}
// Shadow capability alone cannot send plaintext into the content-free correction control interface.
for (const correct of [false, undefined]) {
  const current = base(); current.capabilities.correct = correct;
  const f = fixture(async path => path.includes('/search') ? { ok: true, records: [{ id: 'r', revision: 2, content: '旧认识' }] } : current);
  await f.ready(); await f.click('经历与当前认识');
  f.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await flush(); f.render();
  f.nodes().find(n => n.type === 'input' && n.props.placeholder === '明确写出修正，保留原版关联').props.onChange({ target: { value: '不可发送的自由文本' } }); f.render();
  assert.equal(f.button('预览纠正认识').props.disabled, true, 'shadow:true without correct:true stays disabled');
  const count = f.calls.length; await f.button('预览纠正认识').props.onClick(); f.render(); assert.equal(f.calls.length, count);
  assert.equal(f.calls.filter(c => c.body?.action === 'correct').length, 0);
}
// Removing from hot memory requires its own implemented capability, independent of purge.
for (const removeHot of [undefined, false, true]) {
  const current = base(); current.capabilities.removeHot = removeHot;
  const f = fixture(async (path, options) => {
    if (path.includes('/search')) return { ok: true, records: [{ id: 'r', revision: 2, content: '保留的来源与认识' }] };
    if (path.includes('/manage')) return f.preview(options.body);
    return current;
  });
  await f.ready(); await f.click('经历与当前认识');
  f.nodes().find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await flush(); f.render();
  const remove = f.button('预览移出热记忆'); assert.equal(remove.props.disabled, removeHot !== true);
  const count = f.calls.length; await remove.props.onClick(); f.render();
  if (removeHot === true) {
    assert.equal(f.calls.at(-1).body.action, 'remove_hot'); assert.equal(f.calls.at(-1).body.payload.preview, true);
    assert.equal(f.calls.at(-1).body.payload.recordId, 'r'); await f.click('取消预览');
  } else {
    assert.equal(f.calls.length, count, 'disabled handler issues zero preview/commit requests');
    assert.equal(f.calls.filter(c => c.body?.action === 'remove_hot').length, 0);
  }
  assert.equal(f.button('预览禁止再次使用').props.disabled, false); await f.click('预览禁止再次使用');
  assert.equal(f.calls.at(-1).body.action, 'suppress'); assert.equal(f.calls.at(-1).body.payload.preview, true); await f.click('取消预览');
  assert.equal(f.button('预览删除来源与派生').props.disabled, false); await f.click('预览删除来源与派生');
  assert.equal(f.calls.at(-1).body.action, 'preview_delete'); assert.equal(f.calls.at(-1).body.payload.mode, 'delete_roots');
}
// Registering a person accepts only a platform/account anchor, never a client-generated person id.
for (const identity of [true, false]) {
  const current = base(); current.capabilities.identity = identity;
  const f = fixture(async () => current); await f.ready(); await f.click('身份与权限');
  const register = f.button('预览从此账号登记人物'); assert.equal(register.props.disabled, true);
  let count = f.calls.length; await register.props.onClick(); f.render(); assert.equal(f.calls.length, count, 'empty account blocks direct handler');
  f.nodes().find(n => n.props.placeholder === '填写账号编号，不能填昵称').props.onChange({ target: { value: 'qq-anchor-7' } }); f.render();
  assert.equal(f.button('预览从此账号登记人物').props.disabled, !identity);
  assert.equal(f.button('预览关联账号').props.disabled, true, 'registration does not require or fabricate personId');
  if (!identity) { count = f.calls.length; await f.button('预览从此账号登记人物').props.onClick(); assert.equal(f.calls.length, count, 'identity:false blocks direct handler'); }
}
{
  let current = base();
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return structuredClone(current);
    const body = options.body;
    if (body.payload.preview) return f.preview(body);
    current = { ...base(), revision: 8, bindings: [{ id: 'real-binding', platform: 'qq', accountId: 'qq-anchor-7', personId: 'person-created-by-server' }] };
    return { ok: true, state: 'committed' };
  });
  await f.ready(); await f.click('身份与权限');
  f.nodes().find(n => n.props.placeholder === '填写账号编号，不能填昵称').props.onChange({ target: { value: 'qq-anchor-7' } }); f.render();
  await f.click('预览从此账号登记人物'); assert.match(f.text(), /已验证的稳定来源账号登记新人物.*不按昵称自动合并/s);
  await f.click('确认执行登记人物');
  const calls = f.calls.filter(c => c.body?.action === 'create_person'); assert.equal(calls.length, 2);
  const preview = calls[0].body; const commit = calls[1].body;
  assert.equal(preview.operationId, commit.operationId); assert.equal(commit.expectedRevision, 7);
  assert.equal(commit.characterId, 'alpha'); assert.equal(commit.characterEpoch, 1);
  const payloadDigest = createHash('sha256').update(JSON.stringify({ accountId: 'qq-anchor-7', platform: 'qq' })).digest('hex');
  assert.deepEqual(commit.payload, { platform: 'qq', accountId: 'qq-anchor-7', payloadDigest });
  assert.deepEqual(preview.payload, { platform: 'qq', accountId: 'qq-anchor-7', payloadDigest, preview: true });
  assert.equal(f.calls.at(-1).path, '/memory-v2/status'); assert.match(f.text(), /qq \/ qq-anchor-7 → person-created-by-server/);
}
{
  const f = fixture(async (path, options) => path.includes('/status') ? base() : { ok: false, code: 'MEMORY_ACTION_UNSUPPORTED', error: '当前账号没有可验证来源，无法登记人物', hint: '请先接纳该角色中可验证的稳定来源账号。' });
  await f.ready(); await f.click('身份与权限');
  f.nodes().find(n => n.props.placeholder === '填写账号编号，不能填昵称').props.onChange({ target: { value: 'unknown-account' } }); f.render();
  await f.click('预览从此账号登记人物'); assert.match(f.text(), /MEMORY_ACTION_UNSUPPORTED.*请先接纳该角色中可验证的稳定来源账号/);
  assert.equal(f.calls.filter(c => c.body?.action === 'create_person' && !c.body.payload.preview).length, 0);
}
{
  let current = base(); let operationId;
  const f = fixture(async (path, options) => {
    if (path.includes('/status')) return structuredClone(current);
    if (path.includes('/receipt')) { current = { ...base(), revision: 8, bindings: [{ id: 'receipt-binding', platform: 'qq', accountId: 'qq-anchor-7', personId: 'person-confirmed-by-receipt' }] }; return { ok: true, operationId, state: 'committed' }; }
    if (options.body.payload.preview) return f.preview(options.body);
    operationId = options.body.operationId;
    return { ok: false, code: 'MEMORY_WORKER_DIED', error: '登记结果待核对', hint: '查询原回执', sourceState: 'commit_unknown', retry: 'query_receipt' };
  });
  await f.ready(); await f.click('身份与权限');
  f.nodes().find(n => n.props.placeholder === '填写账号编号，不能填昵称').props.onChange({ target: { value: 'qq-anchor-7' } }); f.render();
  await f.click('预览从此账号登记人物'); await f.click('确认执行登记人物');
  assert.equal(f.button('预览从此账号登记人物').props.disabled, true); const count = f.calls.length; await f.button('预览从此账号登记人物').props.onClick(); assert.equal(f.calls.length, count);
  await f.click('核对提交状态');
  assert.equal(f.calls.find(c => c.path.includes('/receipt')).path, `/memory-v2/receipt?operationId=${operationId}`);
  assert.equal(f.calls.filter(c => c.body?.action === 'create_person' && !c.body.payload.preview).length, 1);
  assert.equal(f.calls.at(-1).path, '/memory-v2/status'); assert.match(f.text(), /person-confirmed-by-receipt/);
}
console.log('PASS memory-v2 UI: stable identity, uncertainty, disabled gates, structured failures, role/revision races, current-role inspection, canonical service phases, explicit correction gate, independent removeHot gate, verified-account person registration');
