import crypto from 'node:crypto';

const required = process.env.SURFCORE_BILI_V2_WORKER === '1' || typeof process.send === 'function';
export const BILI_V2_ENDPOINTS = Object.freeze({
  comment: 'https://api.bilibili.com/x/v2/reply/add',
  dynamic: 'https://api.bilibili.com/x/dynamic/feed/create/dyn',
  dm: 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
});
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const fail = (code, hint, unknown = false) => Object.assign(new Error('Bili V2 Host dispatch did not complete.'), { ok: false, code, error: 'Bili V2 Host dispatch did not complete.', hint, unknown });

export function decodeBiliV2Request(request) {
  const item = structuredClone(request);
  if (!item || typeof item.action !== 'string' || !BILI_V2_ENDPOINTS[item.action] || typeof item.body !== 'string' || item.body.length > 262144 || item.method !== 'POST') throw fail('BILI_V2_REQUEST_INVALID', 'Use one supported typed Bili write tool.');
  const url = new URL(item.url);
  if (url.href !== BILI_V2_ENDPOINTS[item.action] || url.username || url.password || url.hash) throw fail('BILI_V2_ENDPOINT_DENIED', 'Use the fixed endpoint for this Bili action.');
  let target, payload;
  if (item.action === 'dynamic') {
    const body = JSON.parse(item.body);
    if (!body?.dyn_req || body.dyn_req.scene !== 1 || !Array.isArray(body.dyn_req.content?.contents)) throw fail('BILI_V2_REQUEST_INVALID', 'Only a text dynamic is supported.');
    target = { audience: 'public', kind: 'dynamic' };
    payload = { body: body.dyn_req };
  } else {
    const body = new URLSearchParams(item.body);
    if ([...new Set(body.keys())].some((key) => body.getAll(key).length !== 1)) throw fail('BILI_V2_REQUEST_INVALID', 'Duplicate target or payload parameters are not accepted.');
    const id = (key, optional = false) => { const value = body.get(key); if (optional && (!value || value === '0')) return '0'; if (!value || !/^\d{1,30}$/.test(value)) throw fail('BILI_V2_REQUEST_INVALID', 'The actual platform target is invalid.'); return value; };
    if (item.action === 'comment') {
      const type = id('type');
      if (!['1', '11', '17'].includes(type) || !body.get('message')) throw fail('BILI_V2_REQUEST_INVALID', 'Use a supported comment type and text.');
      target = { audience: 'public', kind: 'comment', type, oid: id('oid'), root: id('root', true), parent: id('parent', true) };
      payload = { text: body.get('message') };
    } else {
      const content = JSON.parse(body.get('msg[content]') ?? '{}');
      if (typeof content.content !== 'string' || !content.content) throw fail('BILI_V2_REQUEST_INVALID', 'A text private message is required.');
      target = { audience: 'private', kind: 'dm', mid: id('msg[receiver_id]') };
      payload = { text: content.content };
    }
  }
  return freeze({ request: { action: item.action, url: item.url, method: 'POST', headers: { ...item.headers }, body: item.body }, target, payload });
}

export async function biliV2Fetch(action, url, init) {
  if (!required) return fetch(url, init);
  if (!process.connected || typeof process.send !== 'function') throw fail('BILI_V2_IPC_UNAVAILABLE', 'The managed worker lost its Host link; do not retry automatically.');
  const request = { action, url: String(url), method: init?.method, headers: { ...init?.headers }, body: String(init?.body ?? '') };
  decodeBiliV2Request(request);
  const id = crypto.randomUUID();
  const receipt = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(fail('BILI_V2_DISPATCH_UNKNOWN', 'Inspect the original action receipt before retrying.', true)), 30_000);
    const finish = (error, value) => { clearTimeout(timer); process.off('message', receive); process.off('disconnect', disconnected); error ? reject(error) : resolve(value); };
    const disconnected = () => finish(fail('BILI_V2_DISPATCH_UNKNOWN', 'The Host link closed after submission; inspect the original receipt.', true));
    const receive = (message) => {
      if (message?.kind !== 'surfcore-bili-v2-result' || message.id !== id) return;
      if (!message.ok) return finish(fail(message.code || 'BILI_V2_DISPATCH_DENIED', message.hint || 'Review Host source and target permissions.', message.unknown === true));
      finish(null, message);
    };
    process.on('message', receive); process.once('disconnect', disconnected);
    process.send({ kind: 'surfcore-bili-v2-dispatch', id, request }, (error) => { if (error) finish(fail('BILI_V2_DISPATCH_UNKNOWN', 'Inspect the original action receipt before retrying.', true)); });
  });
  if (!Number.isInteger(receipt.http) || receipt.http < 200 || receipt.http > 599 || !receipt.body || typeof receipt.body !== 'object') throw fail('BILI_V2_RECEIPT_INVALID', 'Inspect the original action receipt; do not resend.', true);
  return new Response(JSON.stringify(receipt.body), { status: receipt.http, headers: { 'content-type': 'application/json' } });
}

export function attachBiliV2Worker({ child, dispatch, signal }) {
  const seen = new Set();
  const receive = async (message) => {
    if (message?.kind !== 'surfcore-bili-v2-dispatch' || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) return;
    const respond = (value) => { if (child.connected) child.send({ kind: 'surfcore-bili-v2-result', id: message.id, ...value }, () => {}); };
    if (seen.has(message.id) || signal?.aborted) return respond({ ok: false, code: 'BILI_V2_DISPATCH_DENIED', hint: 'This action was already submitted or cancelled.' });
    seen.add(message.id);
    try { const result = await dispatch(decodeBiliV2Request(message.request)); respond({ ok: true, ...result }); }
    catch (error) { respond({ ok: false, code: typeof error?.code === 'string' ? error.code : 'BILI_V2_DISPATCH_UNKNOWN', hint: typeof error?.hint === 'string' ? error.hint : 'Inspect the original action receipt before retrying.', unknown: error?.unknown !== false }); }
  };
  child.on('message', receive);
  return () => child.off('message', receive);
}
