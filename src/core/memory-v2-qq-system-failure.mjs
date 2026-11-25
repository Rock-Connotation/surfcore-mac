const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const KEY_RE = /^(group|private):[1-9][0-9]{0,19}$/;
const clean = (value, limit, fallback) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit) || fallback;

export function normalizeSystemFailure(raw, { redact = (value) => String(value ?? ''), now = Date.now() } = {}) {
  const key = String(raw?.key ?? '');
  if (!KEY_RE.test(key)) return null;
  const code = CODE_RE.test(String(raw?.code ?? '')) ? String(raw.code) : 'MEMORY_QQ_FAILED';
  return {
    key,
    code,
    error: clean(redact(raw?.error), 180, '当前操作未完成。'),
    hint: clean(redact(raw?.hint), 240, '检查本机状态后重新发送一条新消息。'),
    dedupeKey: `${key}|${code}`,
    at: now(),
  };
}

export function formatSystemFailureNotice(issue) {
  return `【系统提示】${issue.code}\n${issue.error}\n${issue.hint}\n这不是角色回复；处理后请重新发一条消息。`;
}

export function createSystemFailureQueue({ redact = (value) => String(value ?? ''), now = () => Date.now(), dedupeMs = 10 * 60 * 1000 } = {}) {
  const pending = new Map();
  const emitted = new Map();
  return {
    add(raw) {
      const issue = normalizeSystemFailure(raw, { redact, now });
      if (!issue) return null;
      const last = emitted.get(issue.dedupeKey);
      if (last !== undefined && issue.at - last < dedupeMs) return null;
      emitted.set(issue.dedupeKey, issue.at);
      const list = pending.get(issue.key) ?? [];
      if (!list.some((item) => item.dedupeKey === issue.dedupeKey)) list.push(issue);
      pending.set(issue.key, list);
      return issue;
    },
    list(key) { return [...(pending.get(key) ?? [])]; },
    ack(key, issue) {
      const list = pending.get(key);
      if (!list || !issue) return false;
      const next = list.filter((item) => item !== issue && item.dedupeKey !== issue.dedupeKey);
      if (next.length) pending.set(key, next); else pending.delete(key);
      return true;
    },
    keys() { return [...pending.keys()]; },
  };
}
