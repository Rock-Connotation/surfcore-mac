const SHARING_ENDPOINT = '/dsh-surfcore/api/douyin/companion-sharing';
const CONVERSATION_URL = '/dsh-surfcore/api/douyin/companion-page#conversation';
const SLOT = 'sidebar.footer.action';
const SLOT_ID = 'surfcore-companion-sharing';

function describeFailure(value) {
  const failure = value && typeof value === 'object' ? value : {};
  return [failure.code || 'SHARING_READ_FAILED', failure.error || '本机伙伴状态读取失败。', failure.hint || '点“重载状态”重试。']
    .filter(Boolean).join(' · ');
}

export function mountSharingEntry(ctx, React) {
  if (!ctx?.slots?.inject || !ctx?.slots?.register || !React?.createElement) {
    throw new TypeError('DSH sidebar slot context and React are required');
  }

  const h = React.createElement.bind(React);
  let disposed = false;
  let unregister = null;
  let injectCleanup = null;
  const pollCleanups = new Set();
  const frames = new Set();

  function SharingEntry() {
    const [snapshot, setSnapshot] = React.useState(null);
    const [readFailure, setReadFailure] = React.useState(null);
    const [opened, setOpened] = React.useState(false);
    const [reload, setReload] = React.useState(0);

    React.useEffect(() => {
      let stopped = false;
      let timer = null;
      let controller = null;
      let inFlight = false;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        controller?.abort();
        controller = null;
        window.removeEventListener('pagehide', stop);
      };
      pollCleanups.add(stop);
      window.addEventListener('pagehide', stop, { once: true });

      const schedule = () => {
        if (!stopped) timer = window.setTimeout(() => { timer = null; void poll(); }, 5000);
      };
      const poll = async () => {
        if (stopped || inFlight || disposed) return;
        inFlight = true;
        const requestController = new AbortController();
        controller = requestController;
        const timeout = window.setTimeout(() => requestController.abort(), 5000);
        try {
          const response = await fetch(SHARING_ENDPOINT, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: requestController.signal,
          });
          let data = {};
          try { data = await response.json(); } catch {}
          if (stopped || disposed) return;
          if (!response.ok || data.ok === false) {
            setSnapshot(null);
            setReadFailure(data);
          } else if (!data.character?.id || !Number.isInteger(data.character.epoch) || !data.value || !Array.isArray(data.value.openings)) {
            setSnapshot(null);
            setReadFailure({ code: 'SHARING_RESPONSE_INVALID', error: '本机伙伴状态格式不完整。', hint: '点“重载状态”重试；持续失败时检查 SurfCore 插件。' });
          } else {
            setSnapshot(data);
            setReadFailure(null);
          }
        } catch (error) {
          if (!stopped && !disposed) {
            setReadFailure(requestController.signal.aborted
              ? { code: 'SHARING_READ_TIMEOUT', error: '读取本机伙伴状态超过 5 秒，已停止等待。', hint: '点“重载状态”重试。' }
              : { code: 'SHARING_READ_FAILED', error: '本机伙伴状态暂时无法读取。', hint: '检查 DSH 本地连接后点“重载状态”重试。' });
          }
        } finally {
          window.clearTimeout(timeout);
          if (controller === requestController) controller = null;
          inFlight = false;
          if (!stopped && !disposed) schedule();
        }
      };

      void poll();
      return () => {
        stop();
        pollCleanups.delete(stop);
      };
    }, [reload]);

    const unread = Math.max(0, Math.floor(Number(snapshot?.value?.unread) || 0));
    const lastError = snapshot?.value?.lastError;
    const visibleFailure = readFailure || lastError;
    const retry = () => {
      setReadFailure(null);
      setReload(value => value + 1);
    };
    const openConversation = () => setOpened(true);
    const closeConversation = () => setOpened(false);
    const frameRef = node => {
      if (node) frames.add(node);
      else frames.delete(node);
    };

    return h(React.Fragment, null,
      h('button', {
        type: 'button',
        id: 'surfcore-companion-sharing-entry',
        className: 'surfcore-companion-sharing-entry',
        'aria-label': unread ? '打开伙伴对话，未读 ' + unread + ' 条' : '打开伙伴对话',
        'aria-haspopup': 'dialog',
        'aria-expanded': opened,
        onClick: openConversation,
        style: { display: 'inline-flex', alignItems: 'center', gap: '7px', border: '0', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', padding: '8px 10px', borderRadius: '8px' },
      },
      h('span', { 'aria-hidden': 'true' }, '伙伴'),
      unread ? h('span', { 'aria-hidden': 'true', style: { minWidth: '18px', height: '18px', borderRadius: '999px', padding: '0 5px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-alias-brand-primary, #356fe0)', color: 'var(--dsw-alias-bg-base, white)', fontSize: '11px', lineHeight: '18px' } }, unread > 99 ? '99+' : String(unread)) : null),
      visibleFailure ? h('div', { role: 'status', 'aria-live': 'polite', style: { maxWidth: '240px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #b42318)' } },
        h('span', null, describeFailure(visibleFailure)),
        h('button', { type: 'button', onClick: retry, style: { marginLeft: '6px', color: 'inherit', cursor: 'pointer' } }, '重载状态')) : null,
      opened ? h('div', {
        role: 'dialog',
        'aria-label': '伙伴对话',
        'aria-modal': false,
        style: { position: 'fixed', zIndex: 10000, right: '16px', bottom: '16px', width: 'min(430px, calc(100vw - 24px))', height: 'min(660px, calc(100vh - 24px))', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2, #ccd4dc)', borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', boxShadow: '0 12px 40px rgba(0,0,0,.28)' },
      },
      h('div', { style: { minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 10px 4px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2, #ccd4dc)' } },
        h('strong', null, '伙伴对话'),
        h('button', { type: 'button', 'aria-label': '关闭伙伴对话', onClick: closeConversation, style: { border: '0', background: 'transparent', color: 'inherit', fontSize: '20px', cursor: 'pointer', padding: '4px 8px' } }, '×')),
      h('iframe', { ref: frameRef, title: '与伙伴聊天', src: CONVERSATION_URL, style: { flex: '1 1 auto', width: '100%', minHeight: '0', border: '0', background: 'Canvas' } })) : null,
    );
  }

  const clearRegistration = () => {
    const cleanup = unregister;
    unregister = null;
    if (typeof cleanup === 'function') cleanup();
  };
  injectCleanup = ctx.slots.inject(SLOT, () => {
    if (disposed) return;
    unregister = ctx.slots.register({ name: SLOT, id: SLOT_ID, order: 7 }, SharingEntry);
    return clearRegistration;
  });

  return () => {
    if (disposed) return;
    disposed = true;
    for (const stop of [...pollCleanups]) stop();
    for (const frame of frames) {
      try { frame.src = 'about:blank'; } catch {}
    }
    if (typeof injectCleanup === 'function') injectCleanup();
    clearRegistration();
  };
}
