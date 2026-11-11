// Dependency injection keeps the production panel and its isolated fixture on the same React runtime.
export function createMemoryV2Panel(React, { api, Btn, fmtTime }) {
  const { createElement: h, useState, useRef, useEffect } = React;
  const labels = { accepting: '正在接纳', queued_durable: '已可靠排队，尚未入库', committed: '已提交', commit_unknown: '提交待核对', failed: '保存失败', candidate: '候选认识', review: '待审', reused: '沿用已有认识', ready: '索引可用', pending: '索引待完成', paused: '已暂停', idle: '空闲', running: '运行中', current: '当前版本', historical: '历史版本', reported: '来源自述', inferred: '推断，待核实', access_revoked: '已禁止使用', active_store_purged: '活跃库已清理', retained_copies_purged: '受管理副本已清理' };
  const text = value => value == null ? '未知' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const stateText = value => labels[value] || text(value);
  const list = value => Array.isArray(value) ? value : [];
  const fail = (value, fallback = 'MEMORY_REQUEST_FAILED') => ({ code: value?.code || fallback, error: value?.error || value?.message || '记忆服务暂时不可用', hint: value?.hint || '请刷新状态；若仍失败，检查 Host 记忆服务。' });
  const requiresReceipt = (value, transport = false) => {
    const envelopes = [value, value?.receipt, value?.data, value?.data?.receipt];
    const pending = envelopes.some(item => item && (
      item.retry === 'query_receipt' || item.sourceState === 'commit_unknown' ||
      ['unknown', 'completed_before_cancel'].includes(item.operationState) ||
      item.state === 'commit_unknown' ||
      ['MEMORY_COMMIT_UNCERTAIN', 'MEMORY_COMMIT_UNKNOWN'].includes(item.code)
    ));
    return pending || (transport && (value?.status >= 500 || !value?.code || ['TimeoutError', 'AbortError'].includes(value?.name)));
  };
  const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const digest = async payload => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload))))).map(n => n.toString(16).padStart(2, '0')).join('');
  const capabilities = { backup: 'backup', restore: 'restore', request_delete: 'purge', remove_hot: 'removeHot', suppress: 'purge', correct: 'correct', continue_delete: 'purge', migrate: 'migration', configure_policy: 'shadow', revoke_policy: 'shadow', create_person: 'identity', bind_account: 'identity', unbind_account: 'identity', organize: 'organize', resume: 'shadow', admin_resume: 'adminResume' };
  const previewActions = { backup: 'preview_backup', restore: 'preview_restore', request_delete: 'preview_delete', migrate: 'preview_migration' };
  const caption = { backup: '备份', restore: '恢复', request_delete: '删除来源与派生', remove_hot: '移出热记忆', suppress: '禁止再次使用', correct: '纠正认识', continue_delete: '继续清理', migrate: '影子导入', configure_policy: '共享范围', revoke_policy: '撤回共享', create_person: '登记人物', bind_account: '关联账号', unbind_account: '解除关联', organize: '额外整理', resume: '恢复处理', admin_resume: '按原编号恢复' };
  const publicSetReady = value => value && /^[a-f0-9]{64}$/.test(value.id) && typeof value.characterId === 'string' && Number.isSafeInteger(value.characterEpoch) &&
    typeof value.accountMid === 'string' && typeof value.providerRouteId === 'string' && typeof value.provider === 'string' && typeof value.model === 'string' &&
    value.outputTarget?.audience === 'public' && value.outputTarget?.kind === 'dynamic' && Array.isArray(value.selectors) && value.selectors.length > 0 && value.selectors.length <= 31 &&
    value.selectors.every(source => source && typeof source === 'object' && (source.kind === 'video' ? ['bvid', 'aid', 'authorMid'] : source.kind === 'comment' ? ['rpid', 'type', 'oid', 'root', 'parent', 'authorMid'] : ['invalid']).every(key => typeof source[key] === 'string'));
  const RESUME_ACTIONS = ['correct', 'create_person', 'bind_account', 'unbind_account', 'remove_hot'];
  const resumeable = op => !!op && op.complete === false && RESUME_ACTIONS.includes(op.action) && typeof op.operationId === 'string' && !!op.operationId;

  return function MemoryV2Panel({ initialStatus = null, roleKey = '', onStatus }) {
    const [status, setStatus] = useState(initialStatus?.ok === true ? initialStatus : null);
    const [tab, setTab] = useState('status');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState('');
    const [preview, setPreview] = useState(null);
    const [resume, setResume] = useState(null);
    const [resumeContent, setResumeContent] = useState('');
    const [uncertain, setUncertain] = useState(null);
    const [records, setRecords] = useState(null);
    const [query, setQuery] = useState('');
    const [correction, setCorrection] = useState('');
    const [backupId, setBackupId] = useState('');
    const [conversationId, setConversationId] = useState('');
    const [processorScope, setProcessorScope] = useState('');
    const [account, setAccount] = useState({ platform: 'qq', accountId: '', personId: '' });
    const [optIn, setOptIn] = useState(false);
    const lock = useRef(false);
    const version = useRef(0);
    const statusRef = useRef(status);
    const previewRef = useRef(null);
    const resumeRef = useRef(null);
    const uncertainRef = useRef(null);
    const mounted = useRef(true);
    const request = async (path, options) => {
      const result = await api(path, { ...options, signal: AbortSignal.timeout(12000) });
      if (result?.ok !== true) throw Object.assign(new Error(result?.error || '记忆请求未完成'), fail(result), { data: result });
      return result;
    };
    const applyStatus = result => {
      const previous = statusRef.current;
      if (previous?.character && (previous.character.id !== result.character?.id || previous.character.epoch !== result.character?.epoch)) { previewRef.current = null; setPreview(null); resumeRef.current = null; setResume(null); setResumeContent(''); setRecords(null); setError(fail({ code: 'MEMORY_CONTEXT_REQUIRED', error: '当前角色已经变化', hint: '确认新角色后重新检索、预览；旧操作不会提交。' })); }
      if (previous && typeof previous.revision === 'number' && typeof result.revision === 'number' && result.revision < previous.revision) return;
      const pending = list(result.operations).find(op => requiresReceipt(op) && op.operationId);
      if (!uncertainRef.current && pending) { uncertainRef.current = pending; setUncertain(pending); }
      statusRef.current = result; setStatus(result); onStatus?.(result);
    };
    const load = async () => {
      if (lock.current) return;
      lock.current = true; setBusy('status'); const generation = ++version.current;
      try { const result = await request('/memory-v2/status'); if (mounted.current && generation === version.current) { const changed = statusRef.current?.character && (statusRef.current.character.id !== result.character?.id || statusRef.current.character.epoch !== result.character?.epoch); applyStatus(result); if (!changed) setError(null); } }
      catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
      finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    useEffect(() => {
      mounted.current = true; version.current++; lock.current = false; statusRef.current = null; setStatus(null); setRecords(null); setPreview(null); setResume(null); setResumeContent(''); previewRef.current = null; resumeRef.current = null;
      if (uncertainRef.current) { setUncertain(uncertainRef.current); setError(fail({ code: 'MEMORY_COMMIT_UNCERTAIN', error: '先前操作仍待核对', hint: '使用原操作编号核对回执，不能重复提交。' })); }
      void load();
      return () => { mounted.current = false; version.current++; };
    }, [roleKey]);
    const allowed = action => statusRef.current?.ok === true && ['v1', 'v2'].includes(statusRef.current?.backend) && statusRef.current?.capabilities?.[capabilities[action]] === true && statusRef.current?.revision != null && !!statusRef.current?.character?.id && statusRef.current?.character?.epoch != null;
    const begin = async (action, payload = {}) => {
      if (lock.current || uncertainRef.current || !allowed(action)) return;
      lock.current = true; setBusy('preview'); setError(null); setNotice(''); setPreview(null); previewRef.current = null;
      const generation = version.current;
      try {
        const actualPayload = JSON.parse(JSON.stringify(payload));
        const payloadDigest = await digest(actualPayload);
        if (!mounted.current || generation !== version.current) return;
        const expectedRevision = statusRef.current.revision;
        const character = { ...statusRef.current.character };
        const operationId = crypto.randomUUID();
        const result = await request('/memory-v2/manage', { method: 'POST', body: { action: previewActions[action] || action, payload: { ...actualPayload, payloadDigest, ...(!previewActions[action] ? { preview: true } : {}) }, expectedRevision, operationId, characterId: character.id, characterEpoch: character.epoch } });
        if (!mounted.current || generation !== version.current) return;
        if (result.payloadDigest !== payloadDigest || result.revision !== expectedRevision || !result.preview || typeof result.preview !== 'object') throw fail({ code: 'MEMORY_PREVIEW_INVALID', error: '预览摘要或状态版本不匹配', hint: '重新读取状态并重新预览，不能执行旧预览。' });
        if (action === 'configure_policy' && actualPayload.conversationId?.startsWith('bili-public-set-')) {
          const expected = list(statusRef.current.approvedConversations).find(item => item.id === actualPayload.conversationId)?.sourceSetPreview;
          if (!publicSetReady(expected) || canonical(expected) !== canonical(result.preview.sourceSetPreview)) throw fail({ code: 'MEMORY_PREVIEW_INVALID', error: '完整公开来源集合与预览不匹配', hint: '刷新官方来源与当前角色、账号和模型，核对完整集合后重新预览。新增来源必须重新批准。' });
        }
        const next = { action, payload: actualPayload, payloadDigest, expectedRevision, operationId, character, details: result.preview };
        previewRef.current = next; setPreview(next);
      } catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
      finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    const markUnknown = (operation, result) => {
      uncertainRef.current = operation; setUncertain(operation);
      setError(fail({ code: result?.code || 'MEMORY_COMMIT_UNCERTAIN', error: result?.error || result?.message || '尚不能确认本次是否已提交', hint: `${result?.hint ? result.hint + ' ' : ''}点击「核对提交状态」。核对前请勿重新发起同一操作。` }));
    };
    const refreshCreatedPerson = async (operation, generation) => {
      if (operation.action !== 'create_person') return;
      try { const result = await request('/memory-v2/status'); if (mounted.current && generation === version.current) applyStatus(result); }
      catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
    };
    const execute = async () => {
      const operation = previewRef.current;
      if (lock.current || !operation || uncertainRef.current || !allowed(operation.action)) return;
      if (operation.expectedRevision !== statusRef.current.revision || operation.character.id !== statusRef.current.character?.id || operation.character.epoch !== statusRef.current.character?.epoch) { setError(fail({ code: 'MEMORY_POLICY_STALE', error: '状态已变化，预览已失效', hint: '重新预览后确认。' })); previewRef.current = null; setPreview(null); return; }
      lock.current = true; uncertainRef.current = operation; previewRef.current = null; setPreview(null); setBusy('execute'); const generation = version.current;
      try {
        const result = await request('/memory-v2/manage', { method: 'POST', body: { action: operation.action, payload: { ...operation.payload, payloadDigest: operation.payloadDigest }, expectedRevision: operation.expectedRevision, operationId: operation.operationId, characterId: operation.character.id, characterEpoch: operation.character.epoch } });
        if (!mounted.current || generation !== version.current) return;
        if (requiresReceipt(result)) markUnknown(operation, result);
        else { uncertainRef.current = null; setUncertain(null); setError(null); setNotice('服务已返回回执；请刷新状态查看具体阶段。'); await refreshCreatedPerson(operation, generation); }
      } catch (e) {
        if (!mounted.current || generation !== version.current) return;
        if (requiresReceipt(e, true)) markUnknown(operation, e);
        else { uncertainRef.current = null; setUncertain(null); setError(fail(e)); }
      } finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };

    const beginAdminResume = async operation => {
      if (lock.current || uncertainRef.current || !allowed('admin_resume')) return;
      if (!resumeable(operation)) { setError(fail({ code: 'MEMORY_OPERATION_NOT_FOUND', error: '未找到可按原编号恢复的未完成操作', hint: '刷新状态；生命周期任务仍使用「预览继续清理」，不生成新操作编号。' })); return; }
      const needsContent = operation.action === 'correct';
      const content = needsContent ? resumeContent : undefined;
      if (needsContent && !content.trim()) { setError(fail({ code: 'MEMORY_CORRECTION_CONTENT_REQUIRED', error: '需要最初确认的纠正原文', hint: '输入最初确认的纠正原文后，对同一原编号重新预览；不要生成替代文本或新操作编号。' })); return; }
      lock.current = true; setBusy('preview'); setError(null); setNotice(''); setPreview(null); previewRef.current = null; resumeRef.current = null; setResume(null);
      const generation = version.current;
      try {
        const payload = { operationId: operation.operationId, ...(content !== undefined ? { content } : {}) };
        const payloadDigest = await digest(payload);
        if (!mounted.current || generation !== version.current) return;
        const expectedRevision = statusRef.current.revision;
        const character = { ...statusRef.current.character };
        const result = await request('/memory-v2/admin-resume', { method: 'POST', body: { operationId: operation.operationId, characterId: character.id, characterEpoch: character.epoch, expectedRevision, payloadDigest, preview: true, ...(content !== undefined ? { content } : {}) } });
        if (!mounted.current || generation !== version.current) return;
        if (result.operationId !== operation.operationId || result.payloadDigest !== payloadDigest || result.revision !== expectedRevision || !result.preview || typeof result.preview !== 'object') throw fail({ code: 'MEMORY_PREVIEW_INVALID', error: '恢复预览摘要或状态版本不匹配', hint: '对同一原编号重新读取状态并重新预览，不能执行旧预览或新编号。' });
        const next = { operationId: operation.operationId, action: operation.action, content, payloadDigest, expectedRevision, character, details: result.preview };
        resumeRef.current = next; setResume(next);
      } catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
      finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    const confirmAdminResume = async () => {
      const operation = resumeRef.current;
      if (lock.current || !operation || uncertainRef.current || !allowed('admin_resume')) return;
      if (operation.expectedRevision !== statusRef.current.revision || operation.character.id !== statusRef.current.character?.id || operation.character.epoch !== statusRef.current.character?.epoch) { setError(fail({ code: 'MEMORY_POLICY_STALE', error: '状态已变化，恢复预览已失效', hint: '对同一原编号重新读取状态并重新预览；不要生成新操作编号。' })); resumeRef.current = null; setResume(null); return; }
      lock.current = true; setBusy('execute'); setError(null); setNotice(''); setResume(null); const generation = version.current;
      try {
        const result = await request('/memory-v2/admin-resume', { method: 'POST', body: { operationId: operation.operationId, characterId: operation.character.id, characterEpoch: operation.character.epoch, expectedRevision: operation.expectedRevision, payloadDigest: operation.payloadDigest, ...(operation.content !== undefined ? { content: operation.content } : {}) } });
        if (!mounted.current || generation !== version.current) return;
        if (result.operationId !== operation.operationId) {
          markUnknown(operation, { code: 'MEMORY_OPERATION_CONFLICT', error: '回执操作编号与原编号不符', hint: '保留原操作编号；不要重复发起或生成替代编号。' });
          return;
        }
        if (requiresReceipt(result)) markUnknown(operation, result);
        else { uncertainRef.current = null; setUncertain(null); setError(null); resumeRef.current = null; setNotice('已按原编号恢复；请刷新状态并核对原编号回执。'); }
      } catch (e) {
        if (!mounted.current || generation !== version.current) return;
        if (requiresReceipt(e, true) || e?.code === 'MEMORY_OPERATION_CONFLICT') markUnknown(operation, e);
        else { uncertainRef.current = null; setUncertain(null); setError(fail(e)); }
      } finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    const receipt = async () => {
      const operation = uncertainRef.current;
      if (lock.current || !operation) return;
      lock.current = true; setBusy('receipt'); const generation = version.current;
      try {
        const result = await request(`/memory-v2/receipt?operationId=${encodeURIComponent(operation.operationId)}`);
        if (!mounted.current || generation !== version.current) return;
        if (result.operationId !== operation.operationId) throw fail({ code: 'MEMORY_OPERATION_CONFLICT', error: '回执操作编号不匹配', hint: '保留原操作编号，检查 Host 后再次核对。' });
        const state = result.receipt?.state || result.state;
        if (requiresReceipt(result)) markUnknown(operation, result);
        else if (state === 'committed') { uncertainRef.current = null; setUncertain(null); setError(null); setNotice('已确认提交；具体完成阶段以回执为准。'); await refreshCreatedPerson(operation, generation); }
        else if (state === 'failed') { uncertainRef.current = null; setUncertain(null); setError(fail(result.receipt || result, 'MEMORY_OPERATION_FAILED')); }
        else markUnknown(operation);
      } catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
      finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    const search = async () => {
      if (lock.current || !status) return;
      lock.current = true; setBusy('search'); setError(null); const generation = version.current;
      try { const result = await request(`/memory-v2/search?q=${encodeURIComponent(query)}&limit=20`); if (mounted.current && generation === version.current) setRecords(list(result.records)); }
      catch (e) { if (mounted.current && generation === version.current) setError(fail(e)); }
      finally { if (mounted.current && generation === version.current) { lock.current = false; setBusy(''); } }
    };
    const button = (title, action, payload, disabled = false) => h(Btn, { kind: 'qbw-btn2', disabled: !!busy || !!uncertain || disabled || !allowed(action), onClick: () => { if (!disabled) return begin(action, payload); } }, title);
    const kv = (title, value) => h('div', { className: 'qbw-kv', key: title }, h('span', null, title), h('span', null, text(value)));
    const details = (title, fields) => h('details', null, h('summary', null, title), fields.map(([key, value]) => kv(key, value)));
    const section = (title, children) => h('section', { className: 'mv2-section' }, h('h4', null, title), children);
    const current = status || {};
    const selectedConversation = list(current.approvedConversations).find(c => c.id === conversationId);
    const scopes = list(selectedConversation?.processorScopes);
    const missingSetPreview = selectedConversation?.id?.startsWith('bili-public-set-') && !publicSetReady(selectedConversation.sourceSetPreview);
    const sourceSetView = (value, title) => publicSetReady(value) ? h('section', { className: 'qbw-rec-text', 'aria-label': title }, h('h5', null, title),
      kv('角色 / epoch', `${value.characterId} / ${value.characterEpoch}`), kv('B站账号 MID', value.accountMid), kv('精确模型', `${value.provider} / ${value.model}`),
      details('集合与模型路由摘要', [['集合 SHA-256', value.id], ['模型路由编号', value.providerRouteId]]),
      h('p', { className: 'qbw-hint' }, `仅下列 ${value.selectors.length} 项公开来源 → 公开文字动态。新增或替换来源、角色、账号或模型均须重新批准；私信保持隔离。视频只包含文字元数据，不含音视频。`),
      h('ol', null, value.selectors.map((source, index) => h('li', { key: index }, source.kind === 'video'
        ? `视频 ${source.bvid} · av${source.aid} · 作者 MID ${source.authorMid}`
        : `评论 ${source.rpid} · type ${source.type} / oid ${source.oid} / root ${source.root} / parent ${source.parent} · 作者 MID ${source.authorMid}`)))) : null;

    const resumeTargets = list(current.operations).filter(resumeable).slice(0, 20);
    const resumeRows = resumeTargets.map(op => h('div', { className: 'qbw-rec', key: op.operationId },
      h('div', null, h('b', null, `${caption[op.action] || op.action} · ${stateText(op.phase || op.state)}`), h('div', { className: 'qbw-hint' }, op.hint || '刷新状态查看下一阶段。'), h('small', null, op.operationId)),
      h(Btn, { kind: 'qbw-btn2', disabled: !!busy || !!uncertain || !allowed('admin_resume'), onClick: () => beginAdminResume(op) }, '预览按原编号恢复')));
    const resumeConfirm = resume ? h('section', { className: 'mv2-confirm', 'aria-label': '按原编号恢复预览' },
      h('h4', null, '按原编号恢复预览 · 尚未执行'),
      kv('原操作编号', resume.operationId), kv('原操作', caption[resume.action] || resume.action), kv('已确认阶段', stateText(resume.details?.phase)), kv('状态修订', resume.expectedRevision), kv('SHA-256 摘要', resume.payloadDigest),
      h('p', null, '确认后沿用同一原操作编号继续；恢复纠正认识时只使用管理员输入的最初原文。不生成新操作编号，也不自动重试。'),
      details('本次实际载荷与修订', [['实控角色', `${resume.character.name || resume.character.id} / ${resume.character.id} / epoch ${resume.character.epoch}`], ['原操作编号', resume.operationId], ['原操作', resume.action], ['纠正原文', resume.content], ['SHA-256 摘要', resume.payloadDigest], ['状态修订', resume.expectedRevision]]),
      h('div', { className: 'qbw-actions' }, h(Btn, { onClick: confirmAdminResume, disabled: !!busy || !!uncertain }, '确认按原编号恢复'), h(Btn, { kind: 'qbw-btn2', disabled: !!busy, onClick: () => { resumeRef.current = null; setResume(null); } }, '取消恢复预览'))) : null;
    return h('section', { className: 'qbw-card mv2-panel', 'aria-label': 'V2 记忆管理', 'aria-busy': !!busy },
      h('style', null, `.mv2-panel{margin-bottom:14px;overflow-wrap:anywhere}.mv2-panel *{min-width:0}.mv2-panel h3{font-size:15px;margin:0}.mv2-panel h4{font-size:13px;margin:0 0 8px}.mv2-panel p{max-width:72ch}.mv2-panel .mv2-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--qbw-line-soft)}.mv2-panel .qbw-kv{gap:16px;align-items:start}.mv2-panel .qbw-kv>span:last-child{text-align:right;max-width:66%;white-space:normal}.mv2-panel .qbw-input,.mv2-panel .qbw-select{max-width:100%;min-width:0}.mv2-panel label{display:block;margin:8px 0}.mv2-panel .qbw-rec>div:first-child{min-width:0}.mv2-panel summary{cursor:pointer;padding:8px 0}.mv2-panel :focus-visible{outline:2px solid var(--qbw-brand);outline-offset:3px}.mv2-panel ::selection{background:var(--qbw-brand);color:var(--qbw-on-brand)}.mv2-panel input{caret-color:var(--qbw-brand)}.mv2-panel button:disabled{opacity:.5;cursor:not-allowed}.mv2-panel .mv2-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}.mv2-panel .mv2-tabs button[aria-pressed=true]{border-color:var(--qbw-brand);color:var(--qbw-brand)}.mv2-panel .mv2-confirm{padding:12px;background:var(--qbw-surface-2);margin-top:14px}.mv2-panel .mv2-status{font-variant-numeric:tabular-nums}@media(max-width:480px){.mv2-panel .qbw-kv{flex-wrap:wrap}.mv2-panel .qbw-kv>span:last-child{max-width:100%;text-align:left}.mv2-panel .mv2-tabs button{flex:1 1 42%;white-space:normal}.mv2-panel .qbw-search input{min-width:0;width:100%;flex-basis:100%}}`),
      h('div', { className: 'qbw-meter-head' }, h('h3', null, current.backend === 'v2' ? 'V2 记忆管理' : 'V2 影子管理'), h(Btn, { kind: 'qbw-btn2', onClick: load, disabled: !!busy }, busy === 'status' ? '读取中…' : '刷新状态')),
      h('p', { className: 'qbw-hint' }, current.backend === 'v2' ? '当前由 V2 保存与检索。每个阶段单独确认。' : 'V1 继续作为当前记忆来源；此处单独检查 V2 影子库，不自动切换。'),
      error ? h('div', { role: 'alert', className: 'qbw-err' }, `${error.error} · ${error.code}；${error.hint}`) : null,
      notice ? h('p', { role: 'status', 'aria-live': 'polite' }, notice) : null,
      uncertain ? h('div', { className: 'qbw-warnbox' }, h('div', null, `待核对操作：${uncertain.operationId}`), h(Btn, { onClick: receipt, disabled: !!busy }, busy === 'receipt' ? '核对中…' : '核对提交状态')) : null,
      !status ? h('p', { role: 'status' }, busy ? '正在读取记忆状态与可用操作…' : '状态未知。请刷新状态；服务接通前无法执行管理操作。') : null,
      status && Object.values(current.capabilities || {}).some(value => value !== true) ? h('p', { className: 'qbw-hint' }, '灰色操作尚未开放：请刷新状态，或等待 Host 补齐对应能力与验证证据。') : null,
      h('nav', { className: 'mv2-tabs', 'aria-label': '记忆管理视图' }, [['status', '保存与待办'], ['records', '经历与当前认识'], ['privacy', '身份与权限'], ['recovery', '恢复与费用']].map(([id, label]) => h('button', { type: 'button', key: id, className: 'qbw-btn qbw-btn2', 'aria-pressed': tab === id, onClick: () => setTab(id) }, label))),
      status && tab === 'status' ? section('分阶段保存状态', h('div', { className: 'mv2-status' },
        kv('当前后端 / 角色', `${text(current.backend)} / ${text(current.character?.name || current.character?.id || current.role || current.characterId)}`), kv('最近成功接纳', current.lastSuccessfulIngest ? fmtTime(current.lastSuccessfulIngest) : '未知'),
        kv('来源保存', stateText(current.lastReceipt?.source)), kv('认识选取', stateText(current.lastReceipt?.selection)), kv('检索索引', stateText(current.lastReceipt?.index)),
        kv('待处理来源', current.queue?.pending), kv('已接纳 / 提交 / 拒绝', `${text(current.counts?.sources)} / ${text(current.counts?.committed)} / ${text(current.counts?.rejected)}`), kv('待审认识', current.counts?.review),
        kv('后台处理', stateText(current.worker?.state)), current.worker?.error || current.worker?.code ? h('div', { role: 'alert', className: 'qbw-warnbox' }, `${text(current.worker.error)} · ${text(current.worker.code)}；${current.worker.hint || '请刷新状态并检查后台处理。'}`) : null,
        details('容量与连续输入水位', [['活跃文字与队列', current.storage?.activeBytes], ['角色硬上限', current.storage?.hardLimitBytes], ['未确认队列', current.storage?.spoolBytes], ['词法缓存', current.storage?.indexBytes], ['向量缓存 / 模型', current.storage?.vector], ['原始媒体保留', current.storage?.media], ['受管理备份', current.storage?.backupBytes], ['磁盘剩余', current.storage?.freeBytes], ['连续输入水位', current.queue?.highWater], ['从何时起未保存', current.queue?.unsavedSince]]),
        h('p', { className: 'qbw-hint' }, '文字不因年龄自动删除；到硬上限会停止接纳，已有材料保留。未知指标不代表零。'),
        button('预览恢复处理', 'resume', {}),
        resumeRows.length ? section('按原编号恢复未完成的管理员操作', h('div', null,
          h('p', { className: 'qbw-hint' }, current.capabilities?.adminResume === true ? '沿用 Host 返回的未完成操作编号，重新预览后再确认；纠正认识必须由管理员输入最初确认的原文，不生成替代文本或新操作编号。生命周期任务仍使用「预览继续清理」。' : '按原编号恢复未开放：capabilities.adminResume=false；Host 尚未注入真实管理员恢复适配器。生命周期任务仍使用「预览继续清理」，不会自动重试或生成新编号。'),
          h('label', null, '最初确认的纠正原文 ', h('input', { className: 'qbw-input', 'aria-label': '最初确认的纠正原文', value: resumeContent, onChange: e => setResumeContent(e.target.value), placeholder: '仅恢复纠正任务时填写；输入最初确认的原文' })),
          resumeRows)) : null,
        section('待办与清理进度', list(current.operations).length ? list(current.operations).slice(0, 20).map(op => h('div', { className: 'qbw-rec', key: op.operationId }, h('div', null, h('b', null, stateText(op.state || op.phase)), h('div', { className: 'qbw-hint' }, op.hint || '刷新状态查看下一阶段。'), h('small', null, op.operationId)), button('预览继续清理', 'continue_delete', { operationId: op.operationId }, !['request_delete', 'continue_delete'].includes(op.action)))) : h('p', null, '没有返回待办记录。刷新可读取最新进度。')))) : null,
      status && tab === 'records' ? section('检查当前角色的经历与认识', h('div', null,
        h('p', { className: 'qbw-hint' }, '仅供当前角色管理员检查。正文不会因此加入模型提示词；历史版本与当前认识分别保留。'),
        h('form', { className: 'qbw-search', onSubmit: e => { e.preventDefault(); void search(); } }, h('input', { className: 'qbw-input', 'aria-label': '搜索当前角色记忆', placeholder: '输入经历或认识关键词', value: query, onChange: e => setQuery(e.target.value) }), h(Btn, { type: 'submit', disabled: !!busy }, busy === 'search' ? '搜索中…' : '搜索当前角色')),
        records === null ? h('p', null, '输入关键词，或直接搜索最近可见的记录。') : !records.length ? h('p', null, '当前角色没有匹配记录。可换一个关键词。') : records.map(record => h('article', { className: 'qbw-rec', key: `${record.id}:${record.revision}` }, h('div', null,
          h('div', { className: 'qbw-rec-title' }, `${stateText(record.status)} · 版本 ${text(record.revision)} · ${stateText(record.certainty)}`), h('div', { className: 'qbw-rec-text' }, text(record.content)),
          details('有效时间、证据与覆盖', [['记录编号', record.id], ['类型', record.kind], ['有效起 / 止', `${text(record.validFrom)} / ${text(record.validTo)}`], ['记录时间', record.recordedAt], ['证据根', record.roots], ['版本关联', record.links], ['媒体覆盖', record.coverage]]),
          h('label', null, '纠正后的认识 ', h('input', { className: 'qbw-input', value: correction, onChange: e => setCorrection(e.target.value), placeholder: '明确写出修正，保留原版关联' })),
          h('div', { className: 'qbw-actions' }, button('预览纠正认识', 'correct', { recordId: record.id, recordRevision: record.revision, content: correction }, !correction.trim()), button('预览移出热记忆', 'remove_hot', { recordId: record.id, recordRevision: record.revision }), button('预览禁止再次使用', 'suppress', { recordId: record.id, recordRevision: record.revision }), button('预览删除来源与派生', 'request_delete', { mode: 'delete_roots', recordId: record.id, recordRevision: record.revision }))))))) : null,
      status && tab === 'privacy' ? section('共享范围', h('div', null,
        h('p', { className: 'qbw-hint' }, '只可选择已批准会话及处理范围；撤回会阻止后续使用。同昵称不会自动合并，也不会自动授予跨平台权限。'),
        h('label', null, '允许共享的会话 ', h('select', { className: 'qbw-select', value: conversationId, onChange: e => { setConversationId(e.target.value); setProcessorScope(''); } }, h('option', { value: '' }, '选择已批准会话'), list(current.approvedConversations).map(c => h('option', { key: c.id, value: c.id }, c.label || c.id)))),
        h('label', null, '允许的处理范围 ', h('select', { className: 'qbw-select', value: processorScope, onChange: e => setProcessorScope(e.target.value) }, h('option', { value: '' }, '选择已批准处理范围'), scopes.map(s => h('option', { key: typeof s === 'string' ? s : s.id, value: typeof s === 'string' ? s : s.id }, typeof s === 'string' ? ({ local: '仅本机处理', configured_model: '当前已批准的模型' }[s] || s) : s.label)))),
        sourceSetView(selectedConversation?.sourceSetPreview, '选择的确切公开来源集合'),
        missingSetPreview ? h('p', { role: 'alert' }, 'MEMORY_POLICY_REQUIRED：完整来源集合预览不可用。刷新官方来源，核对账号和模型后重试。') : null,
        button('预览共享范围', 'configure_policy', { conversationId, processorScope }, !conversationId || !processorScope || missingSetPreview),
        list(current.policies).map(p => h('div', { className: 'qbw-rec', key: p.id }, h('span', null, p.label || p.id), button('预览撤回共享', 'revoke_policy', { policyId: p.id }))),
        section('人物账号关联', h('div', null, h('p', null, current.capabilities?.identity === true ? '明确填写平台稳定账号与已有的人物编号。关联不会扩大记忆权限。' : '人物关联能力尚未就绪；等待 Host 提供能力后再操作。'),
          h('label', null, '平台 ', h('select', { className: 'qbw-select', value: account.platform, onChange: e => setAccount({ ...account, platform: e.target.value }) }, ['qq', 'bili', 'douyin'].map(p => h('option', { key: p, value: p }, { qq: 'QQ', bili: 'B站', douyin: '抖音' }[p])))),
          h('label', null, '平台稳定账号 ', h('input', { className: 'qbw-input', value: account.accountId, onChange: e => setAccount({ ...account, accountId: e.target.value }), placeholder: '填写账号编号，不能填昵称' })),
          h('label', null, '关联人物编号 ', h('input', { className: 'qbw-input', value: account.personId, onChange: e => setAccount({ ...account, personId: e.target.value }), placeholder: '填写已有的人物编号' })),
          button('预览从此账号登记人物', 'create_person', { platform: account.platform, accountId: account.accountId }, !account.accountId.trim()),
          button('预览关联账号', 'bind_account', account, !account.accountId.trim() || !account.personId.trim()),
          list(current.bindings).map(b => h('div', { className: 'qbw-rec', key: b.id }, h('span', null, `${text(b.platform)} / ${text(b.accountId)} → ${text(b.personId)}`), button('预览解除关联', 'unbind_account', { bindingId: b.id }))))))) : null,
      status && tab === 'recovery' ? section('受管理备份与恢复', h('div', null,
        h('p', null, '仅选择受管理备份编号。恢复会合并备份后的新来源；当前权限、删除屏障与已消耗额度不会回退。缺少当前控制时只能隔离，不能激活。'),
        h('div', { className: 'qbw-actions' }, button('预览备份', 'backup', {}), h('label', null, '受管理备份 ', h('select', { className: 'qbw-select', value: backupId, onChange: e => setBackupId(e.target.value) }, h('option', { value: '' }, '选择备份'), list(current.backups).map(b => h('option', { key: b.id, value: b.id }, `${b.label || b.id} · ${b.verified === true ? '已校验' : '校验未知'}`)))), button('预览恢复', 'restore', { backupId }, !backupId)),
        !list(current.backups).length ? h('p', { className: 'qbw-hint' }, '尚无受管理备份。先预览并创建备份。') : null,
        section('迁移预演与切换门槛', h('div', null, kv('固定快照', current.migration?.snapshot), kv('高水位 / 检查点', `${text(current.migration?.highWater)} / ${text(current.migration?.checkpoint)}`), kv('导入 / 权限不明隔离', `${text(current.migration?.imported)} / ${text(current.migration?.quarantined)}`),
          h('p', null, '预演后只可导入影子库。切换须核对固定边界、最新权限、备份、旧写者停止与会话屏障；旧版本可能无法执行新权限，不能承诺直接回滚。'),
          button('预览迁移', 'migrate', { snapshotId: current.migration?.snapshot }, !current.migration?.snapshot),
          h(Btn, { disabled: true, kind: 'qbw-btn2', title: '需独立切换授权与 P0 证据' }, '启用 V2'), h('div', { className: 'qbw-hint' }, `启用暂不可用：Windows ${text(current.migration?.gates?.windows)}；精确 Node ${text(current.migration?.gates?.exactNode)}。需独立授权及完整切换证据。`))),
        section('额外整理与费用', h('div', null, kv('已结算', current.budget?.settled), kv('已预留', current.budget?.reserved), kv('用量未知占用', current.budget?.unknownHolds), kv('费用', current.budget?.cost == null ? '费用未知' : current.budget.cost),
          h('label', null, h('input', { type: 'checkbox', checked: optIn, onChange: e => setOptIn(e.target.checked) }), '我选择手动发起本次额外整理（可能产生费用）'), button('预览额外整理', 'organize', { optIn: true, manual: true }, !optIn), h('p', { className: 'qbw-hint' }, '不会自动启用整理。请求可能已计费时保留未知占用，不能按零费用重新发送。'))))) : null,
      status && tab === 'status' ? h('div', { className: 'qbw-actions' }, button('预览备份', 'backup', {}), h('span', { className: 'qbw-hint' }, '备份、恢复、迁移与费用见「恢复与费用」。')) : null,
      resumeConfirm,
      preview ? h('section', { className: 'mv2-confirm', 'aria-label': '操作预览' }, h('h4', null, `${caption[preview.action]}预览 · 尚未执行`),
        preview.action === 'configure_policy' ? null : [['来源数', preview.details.sources], ['受影响认识版本', preview.details.derivedVersions], ['受管理副本', preview.details.retainedCopies], ['备份后新增来源', preview.details.postBackupSources], ['隔离记录', preview.details.quarantine], ['访问停止', preview.details.accessRevoked], ['活跃库清理', preview.details.activeStorePurged], ['受管理副本清理', preview.details.retainedCopiesPurged], ['当前控制', preview.details.currentControls], ['当前额度', preview.details.budget]].map(([label, value]) => kv(label, value)),
        sourceSetView(preview.details.sourceSetPreview, '本次批准的确切公开来源集合'),
        h('p', null, preview.action === 'configure_policy' ? '只批准本预览展示的确切会话、公开来源集合与模型处理范围。任何来源或身份变化都须重新预览并批准。' : preview.action === 'create_person' ? '将从当前角色中已验证的稳定来源账号登记新人物并建立锚点绑定；不按昵称自动合并，也不自动扩大跨平台权限。人物编号由服务生成，提交后刷新关联列表。' : '移出热记忆只影响提示词选取；禁止使用会保留屏障；删除来源会传播到派生版本。访问停止 → 活跃库清理 → 受管理副本清理分别报告。手动导出及不受管理的副本无法代为清理。'),
        details('本次实际载荷与修订', [['实控角色', `${preview.character.name || preview.character.id} / ${preview.character.id} / epoch ${preview.character.epoch}`], ['操作', preview.action], ['载荷', preview.payload], ['SHA-256 摘要', preview.payloadDigest], ['状态修订', preview.expectedRevision], ['操作编号', preview.operationId]]),
        h('div', { className: 'qbw-actions' }, h(Btn, { onClick: execute, disabled: !!busy || !!uncertain }, `确认执行${caption[preview.action]}`), h(Btn, { kind: 'qbw-btn2', disabled: !!busy, onClick: () => { previewRef.current = null; setPreview(null); } }, '取消预览'))) : null);
  };
}
