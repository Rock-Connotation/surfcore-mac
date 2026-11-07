import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createDouyinApi } from '../lib/douyin-api.mjs';

let character = { id: 'fixture', epoch: 1 }, effects = 0, changeDuringRead = false;
const service = {
  status: async () => ({ ok: true, character, enabled: true, state: 'idle' }),
  setEnabled: async () => { effects++; return { ok: true }; },
  beginLogin: async () => { effects++; return { ok: false, code: 'LOGIN_REQUIRED', error: '登录未完成', hint: '在专用窗口扫码' }; },
  confirmAccount: async () => { effects++; return { ok: true }; },
  closeLogin: async () => ({ ok: true }),
};
const handler = createDouyinApi({ service, getCharacter: () => character, observeFeed: async () => {
  effects++;
  if (changeDuringRead) character = { ...character, epoch: 2 };
  return { ok: true, items: [{ id: 'fixture-video' }] };
} });
async function call(body, { method = 'POST', origin, contentType = 'application/json', raw, handler: target = handler } = {}) {
  const bytes = raw ?? (body == null ? '' : JSON.stringify(body));
  const req = Readable.from([Buffer.from(bytes)]);
  req.method = method; req.headers = { host: '127.0.0.1:1234', 'content-type': contentType, ...(origin ? { origin } : {}) };
  const response = { status: 0, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
  await target(req, response); return response;
}
const context = { characterId: 'fixture', characterEpoch: 1 };
const deny = (response, code) => { assert.equal(response.body.ok, false); assert.equal(response.body.code, code); assert.ok(response.body.error && response.body.hint); };
assert.equal((await call(null, { method: 'GET' })).body.enabled, true);
deny(await call({ action: 'enable', enabled: true, ...context }, { origin: 'https://untrusted.invalid' }), 'ORIGIN_REJECTED');
deny(await call({ action: 'enable', enabled: true, ...context }, { contentType: 'text/plain' }), 'JSON_REQUIRED');
deny(await call(null, { raw: '{' }), 'JSON_INVALID');
deny(await call([], {}), 'REQUEST_INVALID');
deny(await call({ action: 'enable', enabled: true, ...context, characterEpoch: 0 }), 'CHARACTER_STALE');
deny(await call({ action: 'arbitrary-browser-command', ...context }), 'DOUYIN_ACTION_INVALID');
assert.equal(effects, 0, 'denied calls must not reach browser service');
deny(await call({ action: 'login', ...context }), 'LOGIN_REQUIRED');
const ok = await call({ action: 'read', ...context, url: 'https://untrusted.invalid', limit: 999 });
assert.equal(ok.status, 200); assert.equal(ok.body.items.length, 1);
changeDuringRead = true;
const stale = await call({ action: 'read', ...context });
deny(stale, 'CHARACTER_STALE'); assert.equal(stale.status, 409); assert.equal(stale.body.items, undefined);
character = { id: 'fixture', epoch: 1 };
let protectedTransition = false, disabled = false, transitions = 0;
const protectedHandler = createDouyinApi({ getCharacter: () => character,
  service: { ...service, setEnabled: async value => { if (!value) { assert.equal(protectedTransition, true); disabled = true; } return { ok: true }; } },
  cancelCompanion: async () => { assert.equal(protectedTransition, true); return { ok: true }; },
  withTransition: async action => { transitions++; protectedTransition = true; try { return await action(); } finally { protectedTransition = false; } },
});
assert.equal((await call({ action: 'enable', enabled: false, ...context }, { handler: protectedHandler })).status, 200);
assert.equal(disabled, true); assert.equal(protectedTransition, false); assert.equal(transitions, 1);
await call({ action: 'enable', enabled: true, ...context }, { handler: protectedHandler });
assert.equal(transitions, 1, 'enabling must not cancel a live conversation');
console.log('Douyin API origin, schema, failure hints and late-role result checks passed');
