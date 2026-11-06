import { sameOrigin, readBody, json } from './http-guard.js';

const fail = (code, error, hint) => ({ ok: false, code, error, hint });

/** Mounted only beneath the DSH-authenticated settings API; no public CLI token. */
export function createDouyinApi({ service, getCharacter, observeFeed = context => service.readFeed(context) }) {
  return async function handle(req, res) {
    if (!sameOrigin(req)) return json(res, 403, fail('ORIGIN_REJECTED', '跨站抖音请求被拒绝。', '从 SurfCore 抖音设置页重新操作。'));
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, fail('METHOD_NOT_ALLOWED', '不支持此请求方法。', '使用设置页查询或操作。'));
    try {
      if (req.method === 'GET') {
        const result = await service.status();
        return json(res, result.ok === false ? 400 : 200, result);
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        return json(res, 415, fail('JSON_REQUIRED', '抖音操作需要 JSON。', '从设置页重新提交。'));
      }
      let body;
      try { body = JSON.parse(await readBody(req, 16 * 1024)); }
      catch { return json(res, 400, fail('JSON_INVALID', '请求格式无效。', '刷新设置页后重新提交。')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, fail('REQUEST_INVALID', '请求格式无效。', '刷新设置页后重新提交。'));
      const context = { characterId: body.characterId, characterEpoch: body.characterEpoch };
      const matches = () => { const current = getCharacter(); return current && current.id === context.characterId && current.epoch === context.characterEpoch; };
      if (!matches()) return json(res, 409, fail('CHARACTER_STALE', '角色已切换，本次操作已停止。', '刷新当前角色后重新操作。'));
      let result;
      if (body.action === 'enable' && typeof body.enabled === 'boolean') result = await service.setEnabled(body.enabled, context);
      else if (body.action === 'login') result = await service.beginLogin(context);
      else if (body.action === 'confirm' && typeof body.candidateId === 'string') result = await service.confirmAccount({ ...context, candidateId: body.candidateId });
      else if (body.action === 'read') result = await observeFeed(context);
      else if (body.action === 'close') result = await service.closeLogin(context);
      else return json(res, 400, fail('DOUYIN_ACTION_INVALID', '不支持这项抖音操作。', '使用启用、登录、确认账号、读取推荐或关闭窗口。'));
      // Do not add an awaited status read after a completed old-role operation.
      if (!matches()) return json(res, 409, fail('CHARACTER_STALE', '角色已切换，旧结果未返回当前页面。', '刷新当前角色后重新操作。'));
      if (!result || typeof result.ok !== 'boolean') result = fail('DOUYIN_RESULT_INVALID', '抖音操作没有返回有效状态。', '刷新设置页并检查专用浏览器。');
      return json(res, result.ok === false ? 400 : 200, result);
    } catch {
      return json(res, 400, fail('DOUYIN_OPERATION_FAILED', '抖音操作未完成。', '检查专用登录窗口和当前角色后重试；已有资料会保留。'));
    }
  };
}
