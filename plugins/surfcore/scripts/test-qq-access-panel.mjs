import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testRoot = mkdtempSync(path.join(os.tmpdir(), 'surfcore-qq-access-'));
process.env.DSH_HOME = path.join(testRoot, 'dsh');
mkdirSync(process.env.DSH_HOME, { recursive: true });
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const { createQQAccessPanel } = await import('../lib/qq-access-panel.mjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const routeA = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', accountId: '2125387192' };
const target = { id: 'qq-private-42', label: 'QQ 私聊 42', replyAccess: { approved: false, ...routeA, code: 'MEMORY_POLICY_DENIED' }, processorScopes: [{ id: 'exact-model', label: '仅此会话与所示精确模型' }] };
const status = ({ roleId = 'role-a', epoch = 3, revision = 7, candidate = target } = {}) => ({
  ok: true, backend: 'v2', character: { id: roleId, epoch, name: '小白鲸' }, revision,
  approvedConversations: [candidate],
});
const actualPreview = (targetRow = target, character = { id: 'role-a', epoch: 3 }) => ({
  conversationId: targetRow.id,
  conversationKey: `qq:${targetRow.replyAccess.accountId}:private:42`,
  accountId: targetRow.replyAccess.accountId,
  provider: targetRow.replyAccess.provider,
  model: targetRow.replyAccess.model,
  characterId: character.id,
  characterEpoch: character.epoch,
});

function fixture(handle, { dirty = false, draftAllow = {}, save = async () => ({ ok: true, platformStart: { qq: true }, bridge: { ok: true } }), roleKey = 'role-a' } = {}) {
  const cells = []; let cursor = 0; let tree = null;
  let currentDirty = dirty;
  const pendingEffects = []; const calls = []; const saves = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => {
      const index = cursor++;
      cells[index] ??= { value: initial };
      return [cells[index].value, value => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; }];
    },
    useRef: initial => { const index = cursor++; cells[index] ??= { current: initial }; return cells[index]; },
    useEffect: (effect, deps) => {
      const index = cursor++; const old = cells[index];
      if (!old || !old.deps || deps.some((value, offset) => old.deps[offset] !== value)) {
        old?.cleanup?.(); cells[index] = { deps };
        pendingEffects.push(() => { cells[index].cleanup = effect(); });
      }
    },
  };
  function Btn() {}
  const Panel = createQQAccessPanel(React, { api: async (path, options = {}) => { calls.push({ path, ...options }); return handle(path, options, calls); }, Btn, fmtTime: value => `时间 ${value}` });
  const render = () => {
    cursor = 0; tree = Panel({ dirty: currentDirty, roleKey, draftAllow, onSave: async value => { saves.push(value); const result = await save(value); if (result?.ok === true) currentDirty = false; return result; } });
    for (const effect of pendingEffects.splice(0)) effect();
    return tree;
  };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : node == null || node === false ? '' : String(node);
  const button = label => { const found = nodes(tree).find(node => (node.type === Btn || node.type === 'button') && text(node) === label); assert.ok(found, `button ${label} exists`); return found; };
  const click = async label => { const item = button(label); assert.notEqual(item.props.disabled, true, `${label} enabled`); await item.props.onClick?.(); render(); };
  render();
  return { calls, saves, render, text: () => text(tree), nodeText: text, button, click, nodes: () => nodes(tree), ready: async () => { await flush(); render(); } };
}

try {
  // Mount and ordinary status reads are read-only. No save or policy operation is inferred from the QQ allowlist.
  {
    let statusReads = 0;
    const f = fixture(async path => { assert.equal(path, '/memory-v2/status?channel=qq'); statusReads++; return status(); }, { dirty: true });
    await f.ready();
    assert.equal(statusReads, 1);
    assert.equal(f.saves.length, 0);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.match(f.text(), /已在 QQ 白名单，当前模型待确认/);
    assert.match(f.text(), /deepseek-v4\.1-flash/);
  }

  // V1 keeps the legacy whitelist behavior and never offers a new model-grant action.
  {
    const legacy = { ...status({ candidate: target, revision: 4 }), backend: 'v1' };
    const old = fixture(async path => ({ ...legacy, approvedConversations: [target] }));
    await old.ready();
    assert.match(old.text(), /当前使用旧版记忆；白名单保存并生效后按原规则回复/);
    assert.equal(old.nodes().some(node => old.nodeText(node) === '保存并启用回复'), false);
    assert.equal(old.calls.filter(call => call.path === '/memory-v2/manage').length, 0);
  }

  // A newly added draft whitelist target is saved and refreshed in this card, then still requires a separate explicit row preview.
  {
    let saved = false;
    const f = fixture(async (path, options) => {
      if (path.includes('/status')) return saved ? status() : { ...status(), approvedConversations: [] };
      if (path === '/memory-v2/manage' && options.body.payload.preview) return { ok: true, revision: 7, payloadDigest: options.body.payload.payloadDigest, expiresAt: Date.now() + 120_000, preview: { qqAccessPreview: actualPreview() } };
      throw new Error(`unexpected request ${path}`);
    }, { dirty: true, draftAllow: { private: ['42'] }, save: async () => { saved = true; return { ok: true, platformStart: { qq: true }, bridge: { ok: true } }; } });
    await f.ready();
    assert.match(f.text(), /这项白名单改动尚未保存/);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage').length, 0);
    await f.click('保存白名单并刷新');
    assert.deepEqual(f.saves, [true]);
    assert.match(f.text(), /请核对当前账号和模型/);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage').length, 0, 'saving a new whitelist target never creates a model grant');
    await f.click('保存并启用回复');
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage').length, 1, 'a second explicit row click creates only a preview');
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length, 0);
  }

  // A dirty whitelist draft saves and restarts first; the exact target gets a preview, then an explicit confirm and readback.
  {
    let committed = false;
    const f = fixture(async (path, options) => {
      if (path.includes('/status')) return status({ revision: committed ? 8 : 7, candidate: { ...target, replyAccess: { ...target.replyAccess, approved: committed, ...(committed ? { policyId: 'policy-exact' } : {}) } } });
      if (path === '/memory-v2/manage' && options.body.payload.preview) return {
        ok: true, revision: options.body.expectedRevision, payloadDigest: options.body.payload.payloadDigest,
        expiresAt: Date.now() + 120_000, preview: { action: 'configure_policy', qqAccessPreview: actualPreview() },
      };
      if (path === '/memory-v2/manage') { committed = true; return { ok: true, operationId: options.body.operationId, state: 'committed' }; }
      if (path.startsWith('/memory-v2/receipt?')) return { ok: true, operationId: new URLSearchParams(path.split('?')[1]).get('operationId'), state: 'committed' };
      throw new Error(`unexpected request ${path}`);
    }, { dirty: true });
    await f.ready();
    await f.click('保存并启用回复');
    assert.deepEqual(f.saves, [true]);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage').length, 1, `${f.text()} ${JSON.stringify(f.calls.map(call => call.path))}`);
    assert.equal(f.calls.find(call => call.path === '/memory-v2/manage').body.action, 'configure_policy');
    const previewCall = f.calls.find(call => call.path === '/memory-v2/manage');
    assert.deepEqual(Object.keys(previewCall.body.payload).sort(), ['conversationId', 'payloadDigest', 'preview', 'processorScope'].sort());
    assert.deepEqual({ conversationId: previewCall.body.payload.conversationId, processorScope: previewCall.body.payload.processorScope }, { conversationId: 'qq-private-42', processorScope: 'exact-model' });
    assert.equal(previewCall.body.payload.payloadDigest, digest({ conversationId: 'qq-private-42', processorScope: 'exact-model' }));
    assert.match(f.text(), /请核对后明确确认/);
    assert.match(f.text(), /QQ 账号.*2125387192/);
    assert.match(f.text(), /deepseek-v4\.1-flash/);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length, 0, 'preview never commits');
    await f.click('确认启用回复');
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length, 1);
    assert.equal(f.calls.filter(call => call.path.startsWith('/memory-v2/receipt?')).length, 1);
    assert.match(f.text(), /当前模型处理许可已生效/);
    assert.match(f.text(), /已确认/);
  }

  // A preview built for a different live provider/model/account is rejected and refreshed for a new explicit review.
  {
    const routeB = { provider: 'other-provider', model: 'other-model', accountId: '99887766' };
    let reads = 0;
    const f = fixture(async (path, options) => {
      if (path.includes('/status')) return ++reads < 3 ? status() : status({ candidate: { ...target, replyAccess: { ...target.replyAccess, ...routeB } } });
      if (path === '/memory-v2/manage') return { ok: true, revision: options.body.expectedRevision, payloadDigest: options.body.payload.payloadDigest, expiresAt: Date.now() + 120_000,
        preview: { action: 'configure_policy', qqAccessPreview: { ...actualPreview(), ...routeB, conversationKey: 'qq:99887766:private:42' } } };
      throw new Error(`unexpected request ${path}`);
    });
    await f.ready(); await f.click('保存并启用回复');
    assert.match(f.text(), /QQ_POLICY_PREVIEW_CHANGED/);
    assert.match(f.text(), /other-provider \/ other-model/);
    assert.equal(f.nodes().some(node => f.nodeText(node) === '确认启用回复'), false);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length, 0);
    assert.equal(reads, 3, 'status was reloaded after the actual preview route changed');
  }

  // Saving with a failed bridge restart cannot proceed to a policy preview or claim that activation succeeded.
  {
    const f = fixture(async path => path.includes('/status') ? status() : (() => { throw new Error(`unexpected request ${path}`); })(), {
      dirty: true, save: async () => ({ ok: true, platformStart: { qq: true }, bridge: { ok: false, code: 'BRIDGE_RESTART_FAILED', error: '重启失败', hint: '检查桥接日志' } }),
    });
    await f.ready(); await f.click('保存并启用回复');
    assert.match(f.text(), /BRIDGE_RESTART_FAILED/);
    assert.match(f.text(), /检查桥接日志/);
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage').length, 0);
  }

  // An uncertain commit retains the original operation and allows receipt queries only, never another commit.
  {
    let operationId; let removed = false;
    const f = fixture(async (path, options) => {
      if (path.includes('/status')) return removed ? { ...status({ roleId: 'role-uncertain' }), approvedConversations: [] } : status({ roleId: 'role-uncertain' });
      if (path === '/memory-v2/manage' && options.body.payload.preview) return { ok: true, revision: 7, payloadDigest: options.body.payload.payloadDigest, expiresAt: Date.now() + 120_000, preview: { qqAccessPreview: actualPreview(target, { id: 'role-uncertain', epoch: 3 }) } };
      if (path === '/memory-v2/manage') { operationId = options.body.operationId; return { ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: '提交结果未知', hint: '只查原回执', operationId, state: 'commit_unknown', retry: 'query_receipt' }; }
      if (path.startsWith('/memory-v2/receipt?')) return { ok: false, code: 'MEMORY_RECEIPT_UNRESOLVED', error: '回执仍未知', hint: '稍后查原回执', operationId, state: 'commit_unknown', operationState: 'unknown', retry: 'query_receipt' };
      throw new Error(`unexpected request ${path}`);
    }, { roleKey: 'role-uncertain' });
    await f.ready(); await f.click('保存并启用回复'); await f.click('确认启用回复');
    assert.match(f.text(), /结果还待核对/);
    const commitCount = f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length;
    assert.equal(commitCount, 1);
    removed = true;
    await f.click('刷新白名单与模型状态');
    assert.match(f.text(), /没有已保存且可选择的 QQ 群或私聊/);
    await f.click('核对操作回执');
    assert.equal(f.calls.filter(call => call.path === '/memory-v2/manage' && !call.body.payload.preview).length, commitCount);
    assert.equal(f.calls.filter(call => call.path.startsWith('/memory-v2/receipt?')).length, 2);
    assert.match(f.text(), /MEMORY_RECEIPT_UNRESOLVED/);
  }

  console.log('QQ access panel tests passed: read-only mount, save→preview→confirm, route-change fence, restart failure, uncertain receipt-only recovery.');
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
