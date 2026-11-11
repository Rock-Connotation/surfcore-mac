import { sameOrigin, readBody, json } from './http-guard.js';
import { douyinCompanionPage } from './douyin-companion-page.mjs';
import { readCompanionPortrait } from './douyin-companion-portrait.mjs';

const fail = (code, error, hint) => ({ ok: false, code, error, hint });
export function createCompanionController({ engine, getCharacter, readiness }) {
  const capture = () => { const r = getCharacter(); return r ? { characterId: r.id, characterEpoch: r.epoch } : null; };
  const matches = c => { const r = capture(); return r && r.characterId === c?.characterId && r.characterEpoch === c?.characterEpoch; };
  const stale = () => fail('COMPANION_CHARACTER_STALE', '角色已变化，本次请求停止。', '刷新当前角色后重新操作。');
  async function handle(req, res, url) {
    const page = url.pathname === '/dsh-surfcore/api/douyin/companion-page';
    const portrait = url.pathname === '/dsh-surfcore/api/douyin/companion-portrait';
    if (!page && !portrait && url.pathname !== '/dsh-surfcore/api/douyin/companion') return false;
    if (!sameOrigin(req)) { json(res, 403, fail('COMPANION_ORIGIN', '跨站陪伴请求被拒绝。', '从 DSH 的 SurfCore 设置页重新操作。')); return true; }
    if (page && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(douyinCompanionPage); return true;
    }
    if (portrait) {
      if (req.method !== 'GET') { json(res, 405, fail('COMPANION_PORTRAIT_METHOD', '立绘接口只支持 GET。', '从小白鲸日记页刷新本机立绘。')); return true; }
      const context = capture();
      if (!context) { json(res, 409, fail('COMPANION_CHARACTER_REQUIRED', '当前没有活动角色。', '在角色页载入已确认的伙伴后再刷新立绘。')); return true; }
      const ids = url.searchParams.getAll('characterId'), epochs = url.searchParams.getAll('characterEpoch');
      const epochText = epochs[0], requestedEpoch = Number(epochText);
      if (ids.length !== 1 || epochs.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(epochText || '') || !Number.isSafeInteger(requestedEpoch) || requestedEpoch < 0 ||
        ids[0] !== context.characterId || requestedEpoch !== context.characterEpoch) {
        json(res, 409, stale()); return true;
      }
      const result = readCompanionPortrait(context.characterId);
      if (!matches(context)) { json(res, 409, stale()); return true; }
      if (!result.ok) {
        const status = result.code === 'COMPANION_PORTRAIT_MISSING' ? 404
          : result.code === 'COMPANION_PORTRAIT_INVALID' ? 415
            : result.code === 'COMPANION_PORTRAIT_READ_FAILED' ? 500 : 409;
        json(res, status, result); return true;
      }
      res.writeHead(200, {
        'content-type': 'image/webp', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-length': String(result.bytes.length),
      });
      res.end(result.bytes); return true;
    }
    if (page || !['GET', 'POST'].includes(req.method)) { json(res, 405, fail('COMPANION_METHOD', '请求方法不支持。', '使用小白鲸日记页的按钮。')); return true; }
    const context = capture();
    if (!context) { json(res, 409, fail('COMPANION_CHARACTER_REQUIRED', '当前没有活动角色。', '在角色页载入已确认的伙伴后再开始。')); return true; }
    let held;
    try {
      if (req.method === 'GET') {
        const value = held = await engine.status(context); const ready = await readiness(context);
        if (!matches(context)) { json(res, 409, stale()); return true; }
        if (!value.ok) { json(res, 409, value); return true; }
        const checked = engine.validateResponse ? await engine.validateResponse(context, value) : { ok: true };
        if (!matches(context)) { json(res, 409, stale()); return true; }
        if (!checked?.ok) { json(res, 409, checked); return true; }
        const role = getCharacter();
        json(res, 200, { ok: true, character: { id: role.id, epoch: role.epoch, name: role.name }, value, readiness: ready }); return true;
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) { json(res, 415, fail('COMPANION_JSON_REQUIRED', '陪伴操作需要 JSON。', '从日记页重新提交操作。')); return true; }
      let body;
      try { body = JSON.parse(await readBody(req, 8192)); } catch { json(res, 400, fail('COMPANION_JSON_INVALID', '请求格式无效。', '刷新日记页后重新提交。')); return true; }
      if (!matches(context) || !body || body.characterId !== context.characterId || body.characterEpoch !== context.characterEpoch) { json(res, 409, stale()); return true; }
      let result;
      if (body.action === 'start') result = await engine.start(context, { mode: 'acceptance' });
      else if (body.action === 'cancel') result = await engine.cancel(context);
      else if (body.action === 'configure' && typeof body.enabled === 'boolean') result = await engine.configure(context, { enabled: body.enabled });
      else result = fail('COMPANION_ACTION', '不支持这项陪伴操作。', '使用开始一轮、取消、启用或暂停按钮。');
      held = result;
      if (result?.ok && engine.validateResponse) { const checked = await engine.validateResponse(context, result); if (!checked?.ok) result = checked; }
      if (!matches(context)) result = stale();
      json(res, result?.ok ? 200 : 409, result ?? fail('COMPANION_RESULT', '操作未返回状态。', '刷新状态并检查现有活动，不要重复启动。'));
    } catch {
      json(res, 409, fail('COMPANION_OPERATION_FAILED', '本次陪伴请求未完成。', '刷新状态并核对已有活动和额度，不要重复启动。'));
    } finally { engine.releaseResponse?.(held); }
    return true;
  }
  return { handle };
}
