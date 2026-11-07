const SECRET_TEXT = /\b(?:bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session|password|secret|sessdata|cookie|authorization)\s*[:=]\s*\S+)|eyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{16,}/i;
const URL_TEXT = /(?:https?:\/\/|www\.)\S+/i;
const BASE64_TEXT = /data:[^\s;,]+;base64,|\b[A-Za-z0-9+/]{160,}={0,2}\b/i;

export class CompanionError extends Error {
  constructor(code, error, hint) { super(error); this.code = code; this.hint = hint; }
}
export const problem = (code, error, hint) => new CompanionError(code, error, hint);
export function check(condition, code, error, hint) { if (!condition) throw problem(code, error, hint); }
export function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function safeCode(value, fallback = 'DOUYIN_COMPANION_FAILED') {
  const code = String(value ?? '');
  return /^DOUYIN_[A-Z0-9_]{1,72}$/.test(code) ? code : fallback;
}
export function safeDisplayText(value, max = 500, { allowUrl = false } = {}) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || SECRET_TEXT.test(text) || BASE64_TEXT.test(text) || (!allowUrl && URL_TEXT.test(text))) return '';
  return text;
}
export function safeModelText(value, max, allowEmpty = false) {
  check(typeof value === 'string', 'DOUYIN_MODEL_OUTPUT_INVALID', '模型输出字段必须是文本。', '检查模型 JSON 格式后重新手动发起。');
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  check(text.length <= max && (allowEmpty || text.length > 0), 'DOUYIN_MODEL_OUTPUT_INVALID', '模型输出长度或内容无效。', '检查模型 JSON 格式后重新手动发起。');
  check(!SECRET_TEXT.test(text) && !URL_TEXT.test(text) && !BASE64_TEXT.test(text), 'DOUYIN_MODEL_OUTPUT_PRIVACY', '模型输出包含链接、图片数据或疑似密钥，已拒绝保存。', '检查输出字段后重新发起；草稿不会自动发送。');
  return text;
}
export function scrubPromptText(value, max) {
  return String(value ?? '').slice(0, max)
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[URL omitted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session|password|secret|sessdata|cookie|authorization)\s*[:=])\s*\S+/gi, '$1 [secret omitted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [secret omitted]')
    .replace(/eyJ[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{16,}/gi, '[secret omitted]')
    .replace(/data:[^\s;,]+;base64,\S+/gi, '[image data omitted]');
}
export function normalizeRole(raw) {
  if (!isRecord(raw)) return null;
  const id = String(raw.id ?? '').trim(), epoch = Number(raw.epoch);
  if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id) || URL_TEXT.test(id) || SECRET_TEXT.test(id) || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  return { id, epoch };
}
export const roleKey = id => JSON.stringify(String(id));
export function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw problem('DOUYIN_CLOCK_INVALID', '本地时间不可用。', '检查系统时间后重新发起。');
  return date.toISOString();
}
function rangeList(value, durationMs) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const range of value.slice(0, 100)) {
    if (!isRecord(range)) continue;
    const startMs = range.startMs ?? range.start, endMs = range.endMs ?? range.end;
    if (Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && startMs >= 0 && endMs > startMs && endMs <= durationMs) out.push({ startMs, endMs });
  }
  return out;
}
export function safeSourceUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const host = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !(host === 'douyin.com' || host.endsWith('.douyin.com'))) return '';
    url.search = ''; url.hash = '';
    const canonical = url.toString();
    return canonical.length <= 2048 && !SECRET_TEXT.test(canonical) ? canonical : '';
  } catch { return ''; }
}
export function safeSourceId(value) {
  const id = String(value ?? '').trim();
  return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id) && !URL_TEXT.test(id) && !SECRET_TEXT.test(id) ? id : '';
}
export function frameImage(value, durationMs) {
  if (!isRecord(value)) return null;
  const atMs = value.atMs, dataUrl = String(value.dataUrl ?? '');
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > durationMs || dataUrl.length > 4_000_000) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) ? { atMs, dataUrl } : null;
}
export function cleanCoverage(transcript, durationMs) {
  const input = isRecord(transcript?.coverage) ? transcript.coverage : {};
  const requestedRanges = rangeList(input.requestedRanges, durationMs), processedRanges = rangeList(input.processedRanges, durationMs), missingRanges = rangeList(input.missingRanges, durationMs);
  const requestedValid = Array.isArray(input.requestedRanges) && input.requestedRanges.length > 0 && requestedRanges.length === input.requestedRanges.length;
  const processedValid = Array.isArray(input.processedRanges) && input.processedRanges.length > 0 && processedRanges.length === input.processedRanges.length;
  const missingValid = Array.isArray(input.missingRanges) && missingRanges.length === input.missingRanges.length;
  const fullRange = ranges => {
    let cursor = 0;
    for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
      if (range.startMs !== cursor) return false;
      cursor = range.endMs;
    }
    return cursor === durationMs;
  };
  const complete = input.complete === true && requestedValid && processedValid && missingValid && missingRanges.length === 0 && fullRange(requestedRanges) && fullRange(processedRanges);
  return { complete, requestedRanges, processedRanges, missingRanges, speechState: safeDisplayText(transcript?.speechState, 48) || 'unknown' };
}
export function shanghaiParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw problem('DOUYIN_CLOCK_INVALID', '本地时间不可用。', '检查系统时间后重新发起。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const result = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${result.year}-${result.month}-${result.day}`, hour: result.hour, minute: result.minute };
}
