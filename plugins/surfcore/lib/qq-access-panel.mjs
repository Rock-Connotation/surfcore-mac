const pendingOperations = new Map();

const array = value => Array.isArray(value) ? value : [];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const errorValue = (value, fallbackCode = 'QQ_ACCESS_REQUEST_FAILED', fallbackHint = '刷新状态后再试；未确认前不要重复提交。') => ({
  code: nonempty(value?.code) ? value.code : fallbackCode,
  error: nonempty(value?.error) ? value.error : nonempty(value?.message) ? value.message : 'QQ 处理授权请求未完成。',
  hint: nonempty(value?.hint) ? value.hint : fallbackHint,
});
const asError = (value, code, hint) => Object.assign(new Error(errorValue(value, code, hint).error), errorValue(value, code, hint), { data: value });

function groupFor(id) {
  const group = /^qq-group-([0-9]{1,20})$/.exec(String(id || ''));
  if (group) return { kind: '群', recipient: group[1], conversationKey: accountId => `qq:${accountId}:group:${group[1]}` };
  const person = /^qq-private-([0-9]{1,20})$/.exec(String(id || ''));
  if (person) return { kind: '私聊', recipient: person[1], conversationKey: accountId => `qq:${accountId}:private:${person[1]}` };
  return null;
}

function candidateFor(status, id) {
  const row = array(status?.approvedConversations).find(item => item?.id === id);
  const kind = groupFor(id);
  const access = row?.replyAccess;
  const scope = array(row?.processorScopes).find(item => item?.id === 'exact-model');
  if (!row || !kind || !access || typeof access.approved !== 'boolean' || !nonempty(access.provider) || !nonempty(access.model) || !/^[1-9][0-9]{0,19}$/.test(String(access.accountId || '')) || !scope) return null;
  const character = status?.character;
  if (!character || !nonempty(character.id) || !Number.isSafeInteger(character.epoch) || character.epoch < 1 || !Number.isSafeInteger(status?.revision) || status.revision < 0) return null;
  return {
    id: row.id,
    label: nonempty(row.label) ? row.label : `QQ${kind.kind} ${kind.recipient}`,
    kind: kind.kind,
    recipient: kind.recipient,
    conversationKey: kind.conversationKey(String(access.accountId)),
    accountId: String(access.accountId),
    provider: access.provider,
    model: access.model,
    approved: access.approved,
    policyId: nonempty(access.policyId) ? access.policyId : '',
    character: { id: character.id, epoch: character.epoch, name: nonempty(character.name) ? character.name : '' },
    revision: status.revision,
  };
}

function draftTargets(allow, savedRows) {
  const saved = new Set(array(savedRows).map(row => row?.id));
  const result = new Map();
  for (const [field, prefix, label] of [['groups', 'qq-group-', 'QQ群'], ['private', 'qq-private-', 'QQ私聊']]) {
    for (const raw of array(allow?.[field])) {
      const id = String(raw);
      if (!/^[0-9]{1,20}$/.test(id)) continue;
      const targetId = `${prefix}${id}`;
      if (!saved.has(targetId)) result.set(targetId, { id: targetId, label: `${label} ${id}` });
    }
  }
  return [...result.values()];
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.id === right.id && left.conversationKey === right.conversationKey &&
    left.accountId === right.accountId && left.provider === right.provider && left.model === right.model &&
    left.character?.id === right.character?.id && left.character?.epoch === right.character?.epoch);
}

function samePreviewIdentity(reviewed, actual) {
  return Boolean(actual && actual.conversationId === reviewed.id && actual.conversationKey === reviewed.conversationKey &&
    actual.accountId === reviewed.accountId && actual.provider === reviewed.provider && actual.model === reviewed.model &&
    actual.characterId === reviewed.character.id && actual.characterEpoch === reviewed.character.epoch);
}

function needsReceipt(value) {
  return [value, value?.receipt, value?.data, value?.data?.receipt].some(item => item && (
    item.retry === 'query_receipt' || item.sourceState === 'commit_unknown' || item.state === 'commit_unknown' ||
    item.complete === false || item.applied === false ||
    ['unknown', 'completed_before_cancel'].includes(item.operationState) ||
    ['MEMORY_COMMIT_UNCERTAIN', 'MEMORY_COMMIT_UNKNOWN'].includes(item.code)
  ));
}

function previewChangedError() {
  return {
    code: 'QQ_POLICY_PREVIEW_CHANGED',
    error: '实际预览中的 QQ 账号或模型已变化，本次没有启用。',
    hint: '已重新读取当前对象；核对最新账号和模型后，再重新预览并明确确认。',
  };
}

export function createQQAccessPanel(React, { api, Btn, fmtTime = value => value } = {}) {
  if (!React?.createElement || typeof api !== 'function' || !Btn) throw new TypeError('Invalid QQ access panel dependencies.');
  const { createElement: h, useState, useRef, useEffect } = React;
  const kv = (label, value) => h('div', { className: 'qbw-kv', key: label }, h('span', null, label), h('span', null, String(value ?? '—')));

  return function QQAccessPanel({ roleKey = '', dirty = false, onSave, draftAllow = {} } = {}) {
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState('');
    const [preview, setPreview] = useState(null);
    const [uncertain, setUncertain] = useState(null);
    const statusRef = useRef(null);
    const previewRef = useRef(null);
    const uncertainRef = useRef(null);
    const mounted = useRef(true);
    const version = useRef(0);
    const lock = useRef(false);

    const current = generation => mounted.current && generation === version.current;
    const setStatusValue = value => { statusRef.current = value; setStatus(value); };
    const readStatus = async () => {
      const value = await api('/memory-v2/status?channel=qq', { method: 'GET', signal: AbortSignal.timeout(12000) });
      if (value?.ok !== true) throw asError(value, 'MEMORY_STATUS_UNAVAILABLE', '检查 QQ 白名单、角色和 SurfCore Host；状态未知时不能启用处理许可。');
      if (!value.character || !nonempty(value.character.id) || !Number.isSafeInteger(value.character.epoch) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.approvedConversations) || value.backend !== 'v2' || value.readiness === 'blocked') {
        throw asError({ code: 'MEMORY_STATUS_INVALID', error: 'QQ 处理授权状态缺少角色、修订号或对象列表。', hint: '刷新状态；状态完整前不会提交授权。' });
      }
      if (roleKey && value.character.id !== roleKey) throw asError({ code: 'CHARACTER_EPOCH_STALE', error: '当前角色已变化。', hint: '等待 QQ 页刷新到当前角色，再重新读取状态。' });
      return value;
    };
    const refresh = async (generation = version.current) => {
      const value = await readStatus();
      if (current(generation)) {
        setStatusValue(value);
        const outstanding = [...pendingOperations.values()].find(item => item.character.id === value.character.id && item.character.epoch === value.character.epoch);
        if (!uncertainRef.current && outstanding) {
          uncertainRef.current = outstanding;
          setUncertain(outstanding);
          setError({ code: 'MEMORY_COMMIT_UNCERTAIN', error: '有一笔 QQ 处理授权结果待核对。', hint: '只查询原操作回执；核对前不要重新提交。' });
        }
      }
      return value;
    };
    const saveDirtyConfig = async () => {
      if (!dirty) return;
      if (typeof onSave !== 'function') throw asError({ code: 'QQ_CONFIG_SAVE_UNAVAILABLE', error: '白名单尚有未保存改动。', hint: '保存 QQ 白名单后再预览处理许可。' });
      const saved = await onSave(true);
      if (saved?.ok !== true) throw asError(saved, 'QQ_CONFIG_SAVE_FAILED', '查看页面保存错误；白名单和桥接状态确认成功后再预览。');
      if (saved?.platformStart?.qq === false) throw asError({ code: 'QQ_BRIDGE_DISABLED', error: 'QQ 启动开关已关闭，桥接没有重启。', hint: '先打开 QQ 启动开关并保存，再启用当前模型处理许可。' });
      if (saved?.bridge?.ok !== true) throw asError(saved?.bridge || { code: 'QQ_BRIDGE_RESTART_UNCONFIRMED', error: '白名单已保存，但 QQ 桥接重启未确认成功。', hint: '检查 QQ 桥接状态并修复启动问题后，再重新预览。' }, 'QQ_BRIDGE_RESTART_UNCONFIRMED', '检查 QQ 桥接状态并修复启动问题后，再重新预览。');
    };

    useEffect(() => {
      mounted.current = true;
      const generation = ++version.current;
      lock.current = false;
      statusRef.current = null;
      previewRef.current = null;
      uncertainRef.current = null;
      setStatus(null); setPreview(null); setUncertain(null); setError(null); setNotice(''); setBusy('status');
      void refresh(generation).catch(value => { if (current(generation)) setError(errorValue(value)); })
        .finally(() => { if (current(generation)) setBusy(''); });
      return () => { mounted.current = false; version.current++; };
    }, [roleKey]);

    const showStaleAndRefresh = async (generation, message = '状态已变化，本次没有提交。') => {
      previewRef.current = null; setPreview(null);
      try {
        const fresh = await refresh(generation);
        if (current(generation)) setNotice(message);
        return fresh;
      } catch (value) {
        if (current(generation)) setError(errorValue(value));
        return null;
      }
    };

    const begin = async targetId => {
      if (lock.current || uncertainRef.current || !statusRef.current || previewRef.current) return;
      const generation = version.current, reviewedStatus = statusRef.current, reviewed = candidateFor(reviewedStatus, targetId);
      if (!reviewed) { setError({ code: 'QQ_POLICY_TARGET_UNAVAILABLE', error: '所选 QQ 会话没有完整的当前模型信息。', hint: '刷新状态；只会对仍在白名单内且有精确模型的对象显示启用入口。' }); return; }
      if (reviewed.approved) { setNotice(`「${reviewed.label}」的当前模型处理许可已经确认。`); return; }
      lock.current = true; setBusy('preview'); setError(null); setNotice(''); setPreview(null); previewRef.current = null;
      try {
        await saveDirtyConfig();
        if (!current(generation)) return;
        const fresh = await refresh(generation);
        const candidate = candidateFor(fresh, targetId);
        if (!candidate || !sameIdentity(reviewed, candidate)) {
          setError(previewChangedError());
          await showStaleAndRefresh(generation, '当前对象已刷新；请重新核对显示的 QQ 账号和模型。');
          return;
        }
        if (candidate.approved) { setNotice(`「${candidate.label}」的当前模型处理许可已经确认。`); return; }
        const payload = { conversationId: candidate.id, processorScope: 'exact-model' };
        const payloadDigest = await digest(payload);
        if (!current(generation)) return;
        const operationId = globalThis.crypto?.randomUUID?.();
        if (!operationId) throw asError({ code: 'CRYPTO_UNAVAILABLE', error: '无法生成安全操作编号。', hint: '重载 DSH 页面后再试；不会提交没有唯一编号的操作。' });
        const result = await api('/memory-v2/manage', { method: 'POST', signal: AbortSignal.timeout(12000), body: {
          action: 'configure_policy', payload: { ...payload, payloadDigest, preview: true }, expectedRevision: fresh.revision,
          operationId, characterId: fresh.character.id, characterEpoch: fresh.character.epoch,
        } });
        if (!current(generation)) return;
        if (result?.ok !== true) throw asError(result, 'MEMORY_PREVIEW_FAILED', '刷新 QQ 状态后重新预览；预览不会自动提交。');
        const actual = result.preview?.qqAccessPreview;
        if (result.payloadDigest !== payloadDigest || result.revision !== fresh.revision || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !samePreviewIdentity(candidate, actual)) {
          setError(previewChangedError());
          await showStaleAndRefresh(generation, '已读取服务端实际预览，但账号或模型与刚才查看的不一致；没有启用。');
          return;
        }
        const operation = { action: 'configure_policy', payload, payloadDigest, expectedRevision: fresh.revision, operationId,
          character: { id: fresh.character.id, epoch: fresh.character.epoch }, reviewed: candidate, actual, details: result.preview, expiresAt: result.expiresAt };
        previewRef.current = operation; setPreview(operation);
      } catch (value) { if (current(generation)) setError(errorValue(value)); }
      finally { if (current(generation)) { lock.current = false; setBusy(''); } }
    };

    const markUnknown = (operation, value) => {
      pendingOperations.set(operation.operationId, operation);
      uncertainRef.current = operation; setUncertain(operation);
      setError({ ...errorValue(value, 'MEMORY_COMMIT_UNCERTAIN', '只查询原操作回执；核对前不要再次提交。'),
        hint: `${errorValue(value).hint} 点击「核对操作回执」；核对前不要再次提交。` });
    };

    const finishFromReceipt = async (operation, receipt, generation) => {
      if (receipt?.operationId !== operation.operationId) {
        markUnknown(operation, { code: 'MEMORY_OPERATION_CONFLICT', error: '回执编号与本次操作不一致。', hint: '保留原操作编号，只重试查询回执。' });
        return;
      }
      if (needsReceipt(receipt)) { markUnknown(operation, receipt); return; }
      if (receipt?.ok !== true || receipt?.state !== 'committed') {
        if (receipt?.state === 'failed') {
          pendingOperations.delete(operation.operationId); uncertainRef.current = null; setUncertain(null); setError(errorValue(receipt, 'MEMORY_OPERATION_FAILED', '检查错误提示后再决定下一步；不要重复提交已完成的操作。'));
          return;
        }
        markUnknown(operation, receipt);
        return;
      }
      pendingOperations.delete(operation.operationId); uncertainRef.current = null; setUncertain(null);
      setNotice('服务端回执已确认提交；正在核对当前 QQ 白名单和模型状态。');
      try {
        const fresh = await refresh(generation);
        if (!current(generation)) return;
        const candidate = candidateFor(fresh, operation.reviewed.id);
        if (candidate && candidate.approved && sameIdentity(operation.reviewed, candidate)) {
          setError(null);
          setNotice(`已确认：「${candidate.label}」的当前模型处理许可已生效（${candidate.provider} / ${candidate.model}）。`);
        } else {
          setError({ code: 'QQ_POLICY_READBACK_UNCONFIRMED', error: '提交回执已确认，但当前状态没有确认这项 QQ 模型许可。', hint: '查看白名单、账号和当前模型；不要重复提交同一授权。' });
          setNotice('操作已提交，当前状态仍待核对。');
        }
      } catch (value) {
        if (current(generation)) {
          setNotice('提交回执已确认，但最新状态读取失败；不要重复提交。');
          setError(errorValue(value, 'QQ_POLICY_READBACK_FAILED', '刷新 QQ 处理授权状态后核对；不要重复提交。'));
        }
      }
    };

    const queryReceipt = async () => {
      const operation = uncertainRef.current;
      if (!operation || lock.current) return;
      lock.current = true; setBusy('receipt'); setError(null);
      const generation = version.current;
      try {
        const receipt = await api(`/memory-v2/receipt?operationId=${encodeURIComponent(operation.operationId)}`, { method: 'GET', signal: AbortSignal.timeout(12000) });
        if (!current(generation)) return;
        await finishFromReceipt(operation, receipt, generation);
      } catch (value) {
        if (current(generation)) markUnknown(operation, value);
      } finally { if (current(generation)) { lock.current = false; setBusy(''); } }
    };

    const confirm = async () => {
      const operation = previewRef.current;
      if (!operation || lock.current || uncertainRef.current) return;
      if (Date.now() >= operation.expiresAt) {
        previewRef.current = null; setPreview(null);
        setError({ code: 'MEMORY_PREVIEW_REQUIRED', error: '预览已过期，本次没有提交。', hint: '重新核对对象和当前模型，再预览并确认。' });
        return;
      }
      lock.current = true; setBusy('confirm'); setError(null); setNotice('');
      const generation = version.current;
      try {
        const fresh = await refresh(generation);
        if (!current(generation)) return;
        const candidate = candidateFor(fresh, operation.reviewed.id);
        if (fresh.revision !== operation.expectedRevision || fresh.character.id !== operation.character.id || fresh.character.epoch !== operation.character.epoch || !candidate || !sameIdentity(operation.reviewed, candidate) || candidate.approved) {
          previewRef.current = null; setPreview(null);
          if (candidate?.approved && sameIdentity(operation.reviewed, candidate)) setNotice(`「${candidate.label}」的当前模型处理许可已经确认；没有重复提交。`);
          else {
            setError({ code: 'MEMORY_POLICY_STALE', error: '预览后的白名单、账号、角色或模型状态已变化，本次没有提交。', hint: '已重新读取当前状态；核对显示的对象和模型后，再重新预览。' });
          }
          return;
        }
        if (Date.now() >= operation.expiresAt) {
          previewRef.current = null; setPreview(null);
          setError({ code: 'MEMORY_PREVIEW_REQUIRED', error: '预览已过期，本次没有提交。', hint: '重新核对对象和当前模型，再预览并确认。' });
          return;
        }
        previewRef.current = null; setPreview(null);
        uncertainRef.current = operation; setUncertain(operation); pendingOperations.set(operation.operationId, operation);
        let result;
        try {
          result = await api('/memory-v2/manage', { method: 'POST', signal: AbortSignal.timeout(12000), body: {
            action: operation.action, payload: { ...operation.payload, payloadDigest: operation.payloadDigest }, expectedRevision: operation.expectedRevision,
            operationId: operation.operationId, characterId: operation.character.id, characterEpoch: operation.character.epoch,
          } });
        } catch (value) {
          markUnknown(operation, value);
          await queryReceiptFor(operation, generation);
          return;
        }
        if (!current(generation)) return;
        if (result?.operationId && result.operationId !== operation.operationId) {
          markUnknown(operation, { code: 'MEMORY_OPERATION_CONFLICT', error: '服务端回执编号与本次操作不一致。', hint: '只查询原操作回执；不要重发。' });
          return;
        }
        if (result?.ok !== true && !needsReceipt(result)) {
          pendingOperations.delete(operation.operationId); uncertainRef.current = null; setUncertain(null); setError(errorValue(result, 'MEMORY_POLICY_COMMIT_FAILED', '查看错误提示；如服务端表示结果待核对，只查询原操作回执。'));
          return;
        }
        if (needsReceipt(result)) {
          markUnknown(operation, result);
          await queryReceiptFor(operation, generation);
          return;
        }
        await queryReceiptFor(operation, generation);
      } catch (value) {
        if (current(generation)) setError(errorValue(value));
      } finally { if (current(generation)) { lock.current = false; setBusy(''); } }
    };

    const queryReceiptFor = async (operation, generation) => {
      try {
        const receipt = await api(`/memory-v2/receipt?operationId=${encodeURIComponent(operation.operationId)}`, { method: 'GET', signal: AbortSignal.timeout(12000) });
        if (!current(generation)) return;
        await finishFromReceipt(operation, receipt, generation);
      } catch (value) { if (current(generation)) markUnknown(operation, value); }
    };

    const refreshButton = async () => {
      if (lock.current) return;
      lock.current = true; setBusy('status'); setError(null); setNotice('');
      const generation = version.current;
      try { await refresh(generation); }
      catch (value) { if (current(generation)) setError(errorValue(value)); }
      finally { if (current(generation)) { lock.current = false; setBusy(''); } }
    };

    const saveDraftTarget = async targetId => {
      if (lock.current || uncertainRef.current) return;
      lock.current = true; setBusy(dirty ? 'save' : 'status'); setError(null); setNotice('');
      const generation = version.current;
      try {
        await saveDirtyConfig();
        const fresh = await refresh(generation);
        const candidate = candidateFor(fresh, targetId);
        if (!candidate) throw asError({ code: 'QQ_POLICY_TARGET_NOT_FOUND', error: '保存后状态仍未返回这个 QQ 白名单对象。', hint: '检查 QQ 账号、白名单和当前模型路由，再刷新状态；处理许可不会自动启用。' });
        setNotice(`白名单已保存并刷新「${candidate.label}」。请核对当前账号和模型，再单独点击「保存并启用回复」。`);
      } catch (value) { if (current(generation)) setError(errorValue(value)); }
      finally { if (current(generation)) { lock.current = false; setBusy(''); } }
    };

    const rows = array(status?.approvedConversations).filter(row => /^qq-(?:group|private)-/.test(String(row?.id || '')));
    const drafts = draftTargets(draftAllow, rows);
    const errorBox = error ? h('div', { className: 'qbw-warnbox', role: 'alert', tabIndex: -1 },
      h('b', null, error.error), h('div', null, error.code), h('div', null, error.hint)) : null;
    return h('div', { className: 'qbw-card', style: { marginTop: '10px' } },
      h('h4', null, '白名单内的回复设置'),
      h('p', { className: 'qbw-hint' }, 'QQ 白名单决定哪些群或私聊可以进入；在这里明确选择对象后，才会为所示的当前模型启用处理许可。启用状态不代表 QQ 连接或语音发送状态。'),
      status ? h('div', { className: 'qbw-hint', role: 'status' }, `当前角色：${status.character.name || status.character.id} · 状态修订 ${status.revision}`) : null,
      h('div', { className: 'qbw-actions', style: { borderTop: 'none', marginTop: '4px', paddingTop: '0' } },
        h(Btn, { kind: 'qbw-btn2', onClick: refreshButton, disabled: !!busy }, busy === 'status' ? '正在读取…' : '刷新白名单与模型状态')),
      errorBox,
      notice ? h('div', { className: 'qbw-hint', role: 'status', 'aria-live': 'polite' }, notice) : null,
      busy === 'status' && !status ? h('div', { className: 'qbw-hint', role: 'status' }, '正在读取当前 QQ 白名单和模型状态…') : null,
      status && rows.length === 0 && drafts.length === 0 ? h('div', { className: 'qbw-hint' }, '没有已保存且可选择的 QQ 群或私聊。先在上方白名单加入对象并保存，再刷新这里。') : null,
      rows.map(row => {
        const candidate = candidateFor(status, row.id);
        // V2-only（V1 退役）：不再有「旧版记忆」分支，后端不是 v2 或未就绪时 readStatus 已拒绝。
        const active = candidate?.approved === true;
        const pending = candidate?.approved === false;
        const isPreview = preview?.reviewed.id === row.id;
        const isUncertain = uncertain?.reviewed.id === row.id;
        const stateText = active ? '当前模型处理许可已确认' : pending ? '已在 QQ 白名单，当前模型待确认' : '模型或会话信息未知，暂不可操作';
        return h('div', { key: row.id, className: 'qbw-item', style: { display: 'block', marginTop: '8px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' } },
            h('div', null,
              h('div', { className: 'qbw-label' }, row.label || row.id),
              h('div', { className: 'qbw-hint' }, stateText),
              candidate ? h('div', { className: 'qbw-hint' }, `${candidate.provider} / ${candidate.model} · QQ 账号 ${candidate.accountId} · 对象 ${candidate.kind} ${candidate.recipient}`) : null),
            active ? h('span', { className: 'qbw-badge ok' }, '已确认') : null,
            pending && !isPreview && !isUncertain ? h(Btn, { kind: 'qbw-btn2', disabled: !!busy || !!uncertain, onClick: () => begin(row.id) }, '保存并启用回复') : null),
          isPreview ? h('div', { className: 'qbw-warnbox', style: { marginTop: '8px' }, role: 'group', 'aria-label': 'QQ 处理许可预览' },
            h('b', null, '请核对后明确确认'),
            kv('目标会话', `${preview.actual.conversationId} · ${preview.actual.conversationKey}`),
            kv('QQ 账号', preview.actual.accountId),
            kv('处理模型', `${preview.actual.provider} / ${preview.actual.model}`),
            kv('角色版本', `${preview.actual.characterId} / ${preview.actual.characterEpoch}`),
            kv('处理范围', '仅此 QQ 会话 + exact-model'),
            kv('预览有效至', fmtTime(new Date(preview.expiresAt).toISOString())),
            h('div', { className: 'qbw-actions' },
              h(Btn, { kind: 'qbw-btn', disabled: !!busy, onClick: () => confirm() }, '确认启用回复'),
              h(Btn, { kind: 'qbw-btn2', disabled: !!busy, onClick: () => { previewRef.current = null; setPreview(null); setError(null); setNotice('本次预览已取消，没有提交。'); } }, '取消'))
          ) : null,
          isUncertain ? h('div', { className: 'qbw-warnbox', style: { marginTop: '8px' }, role: 'alert' },
            h('b', null, '这笔操作的结果还待核对。'),
            h('div', null, `操作编号：${uncertain.operationId}`),
            h(Btn, { kind: 'qbw-btn2', disabled: !!busy, onClick: () => queryReceipt() }, busy === 'receipt' ? '正在核对回执…' : '核对操作回执')) : null);
      }),
      drafts.map(row => h('div', { key: row.id, className: 'qbw-item', style: { display: 'block', marginTop: '8px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap' } },
          h('div', null, h('div', { className: 'qbw-label' }, row.label),
            h('div', { className: 'qbw-hint' }, dirty ? '这项白名单改动尚未保存；保存后会读取实际 QQ 账号和模型，不会自动启用处理许可。' : '当前状态列表还没有这个对象；重新读取后再决定下一步。')),
          h(Btn, { kind: 'qbw-btn2', disabled: !!busy || !!uncertain, onClick: () => saveDraftTarget(row.id) }, dirty ? '保存白名单并刷新' : '重新读取此对象')))),
      uncertain && !rows.some(row => row.id === uncertain.reviewed.id) ? h('div', { className: 'qbw-warnbox', role: 'alert' },
        h('b', null, '有一笔 QQ 处理授权结果待核对。'),
        h('div', null, `原目标：${uncertain.reviewed.label} · 操作编号：${uncertain.operationId}`),
        h('div', null, '只查询原操作回执；核对前不要重复提交。'),
        h(Btn, { kind: 'qbw-btn2', disabled: !!busy, onClick: () => queryReceipt() }, busy === 'receipt' ? '正在核对回执…' : '核对操作回执')) : null);
  };
}

async function digest(payload) {
  if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== 'function') throw asError({ code: 'CRYPTO_UNAVAILABLE', error: '无法计算安全预览摘要。', hint: '重载 DSH 页面后再试；不会提交未校验的预览。' });
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)))))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
