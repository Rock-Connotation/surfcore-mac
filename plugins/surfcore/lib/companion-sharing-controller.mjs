import fs from 'node:fs';
import { sameOrigin, readBody, json } from './http-guard.js';

const fail = (code, error, hint) => ({ ok: false, code, error, hint });
export function createSharingController({ service, getCharacter }) {
  const capture = () => { const r = getCharacter(); return r ? { characterId: r.id, characterEpoch: r.epoch } : null; };
  const matches = c => { const r = capture(); return r && r.characterId === c?.characterId && r.characterEpoch === c?.characterEpoch; };
  const stale = () => fail('DOUYIN_STALE_CHARACTER', '角色已变化，本次对话请求停止。', '刷新当前伙伴后再操作；不会续接到新角色。');
  async function handle(req, res, url) {
    const script = url.pathname === '/dsh-surfcore/api/douyin/companion-sharing-client';
    if (!script && url.pathname !== '/dsh-surfcore/api/douyin/companion-sharing') return false;
    if (!sameOrigin(req)) { json(res, 403, fail('DOUYIN_CHAT_ORIGIN', '跨站伙伴对话请求被拒绝。', '从DSH内伙伴入口重新打开。')); return true; }
    if (script) {
      if (req.method !== 'GET') { json(res, 405, fail('DOUYIN_CHAT_METHOD', '客户端模块只支持GET。', '从DSH重新打开伙伴入口。')); return true; }
      try {
        const source = fs.readFileSync(new URL('./companion-sharing-client.mjs', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(source);
      } catch { json(res, 503, fail('DOUYIN_CHAT_CLIENT_UNAVAILABLE', '伙伴入口模块尚未就绪。', '重新加载SurfCore插件后再打开；记录不会丢失。')); }
      return true;
    }
    if (!['GET', 'POST'].includes(req.method)) { json(res, 405, fail('DOUYIN_CHAT_METHOD', '不支持这项对话请求。', '使用伙伴页面的发送、停止或刷新按钮。')); return true; }
    const context = capture();
    if (!context) { json(res, 409, fail('DOUYIN_CHAT_CHARACTER_REQUIRED', '当前没有已载入的伙伴。', '先在角色页载入伙伴，再打开分享。')); return true; }
    const envelope = value => { const role = getCharacter(); return { ok: true, character: { id: role.id, epoch: role.epoch, name: role.name }, value }; };
    try {
      if (req.method === 'GET') {
        const value = await service.status(context);
        if (!matches(context)) json(res, 409, stale());
        else json(res, value.ok ? 200 : 409, value.ok ? envelope(value) : value);
        return true;
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) { json(res, 415, fail('DOUYIN_CHAT_JSON_REQUIRED', '对话操作需要JSON。', '从伙伴页面重新提交。')); return true; }
      let body;
      try { body = JSON.parse(await readBody(req, 8192)); }
      catch { json(res, 400, fail('DOUYIN_CHAT_JSON_INVALID', '对话请求格式无效或过长。', '刷新后用1000字以内的普通文字交流。')); return true; }
      if (!matches(context) || !body || body.characterId !== context.characterId || body.characterEpoch !== context.characterEpoch) { json(res, 409, stale()); return true; }
      let result;
      if (body.action === 'reply') result = await service.reply(context, { openingId: body.openingId, requestId: body.requestId, text: body.text });
      else if (body.action === 'ack') result = await service.ack(context, { openingId: body.openingId });
      else if (body.action === 'cancel') result = await service.cancel(context, { requestId: body.requestId });
      else result = fail('DOUYIN_CHAT_ACTION', '不支持这项伙伴操作。', '使用发送、停止或打开分享按钮。');
      if (!matches(context)) result = stale();
      if (result.ok && !result.value) result = { ...result, value: await service.status(context) };
      if (!matches(context)) result = stale();
      json(res, result.ok ? 200 : 409, result.ok ? envelope(result.value) : result);
    } catch { json(res, 409, fail('DOUYIN_CHAT_OPERATION_FAILED', '本次伙伴对话操作未完成。', '刷新查看已有记录和额度；不要重复发送同一条消息。')); }
    return true;
  }
  return { handle };
}
