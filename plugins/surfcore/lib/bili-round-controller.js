// Explicit rounds share Bili's Host and context, without starting a free-tool session.
import { createBiliRoundService } from './bili-round.js';
import { biliRoundPage } from './bili-round-page.js';

const issue = (code, error, hint) => ({ ok: false, code, error, hint });
export function createBiliRoundController({ ctx, stateDir, tokenBudget, runBili, perception, getCharacter,
  buildContext, maintainMemory, readConfig, saveConfig, platformEnabled, legacyRunning, stopLegacy, json, readBody,
  createRound = createBiliRoundService }) {
  let restartRequired = false, transitions = 0;
  const current = () => transitions === 0 && platformEnabled() && readConfig().night?.controlledOnly === true ? getCharacter() : null;
  const round = createRound({ stateDir, ctx, tokenBudget, runBili,
    getJob: id => perception.getJob(id), cancelJob: id => perception.cancel(id),
    getCharacter: current, buildContext, maintainMemory });
  async function pause() {
    const wasRunning = legacyRunning();
    if (readConfig().night?.controlledOnly !== true) saveConfig({ night: { controlledOnly: true } });
    if (wasRunning) { restartRequired = true; await stopLegacy(); }
    return { ok: true, restartRequired };
  }
  async function cancelActive() {
    const snapshot = await round.status();
    for (const job of snapshot.jobs.filter(j => ['queued', 'running'].includes(j.state))) await round.cancel(job.jobId);
  }
  function beginTransition() {
    transitions++;
    let finished = false;
    return { ready: cancelActive(), finish() { if (!finished) { finished = true; transitions--; } } };
  }
  async function withTransition(operation) {
    const ticket = beginTransition();
    try { await ticket.ready; return await operation(); } finally { ticket.finish(); }
  }
  function ownerStamp() { const role = getCharacter(); return role ? role.id + ':' + role.epoch : ''; }
  function assertStamp(stamp) {
    if (ownerStamp() !== stamp) throw Object.assign(new Error('角色已切换'), { code: 'ROUND_FORBIDDEN', hint: '刷新当前角色的单轮状态。' });
  }
  function readiness() {
    if (transitions > 0) return issue('BILI_ROUND_TRANSITION', '正在切换角色或停止渠道。', '等待操作完成后再开始单轮。');
    if (restartRequired) return issue('BILI_ROUND_RESTART_REQUIRED', '旧巡航已停止，需要重启后开始单轮。', '重启此 App 实例；已有回执和草稿会保留。');
    if (readConfig().night?.controlledOnly !== true || legacyRunning()) return issue('BILI_ROUND_MODE_REQUIRED', '请先暂停自动巡航。', '点击“仅运行单轮”，按提示重启后再试。');
    if (!platformEnabled()) return issue('BILI_ROUND_CHANNEL_DISABLED', 'B站渠道尚未启用。', '启用 B站并保存；单轮模式会保持自动巡航暂停。');
    return { ok: true };
  }
  async function models() {
    const llm = ctx.get('llm');
    if (!llm?.listProviders || !llm?.listModels) return [];
    const out = [];
    for (const provider of llm.listProviders()) {
      const list = await llm.listModels(provider.id);
      for (const model of list ?? []) out.push({ provider: provider.id, model: model.id, name: model.name || model.id });
    }
    return out;
  }
  function assertOwner(job) {
    const role = getCharacter();
    if (!role || job.characterId !== role.id || Number(job.characterEpoch) !== Number(role.epoch)) {
      throw Object.assign(new Error('角色归属不符'), { code: 'ROUND_FORBIDDEN', hint: '以当前角色读取或取消自己的轮次。' });
    }
    return job;
  }
  async function handle(req, res, url) {
    if (!['/dsh-surfcore/api/bili/round', '/dsh-surfcore/api/bili/round-page'].includes(url.pathname)) return false;
    try {
      if (url.pathname.endsWith('/round-page') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(biliRoundPage); return true;
      }
      if (req.method === 'GET') {
        const stamp = ownerStamp();
        const jobId = url.searchParams.get('jobId');
        let value;
        if (jobId) value = assertOwner(await round.getJob(jobId));
        else { const raw = await round.status(); const role = getCharacter(); const jobs = raw.jobs.filter(j => role && j.characterId === role.id && Number(j.characterEpoch) === Number(role.epoch)); value = { ...raw, activeJobId: jobs.find(j => ['queued','running'].includes(j.state))?.jobId ?? null, jobs }; }
        const catalog = await models(); assertStamp(stamp);
        json(res, 200, { ok: true, value, readiness: readiness(), models: catalog }); return true;
      }
      if (req.method !== 'POST') { json(res, 405, issue('BILI_ROUND_METHOD', '请求方法不支持。', '使用设置页单轮按钮。')); return true; }
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.action === 'pause') { json(res, 200, await pause()); return true; }
      if (body.action === 'cancel') { const stamp = ownerStamp(); assertOwner(await round.getJob(body.jobId)); const result = await round.cancel(body.jobId); assertStamp(stamp); json(res, 200, result); return true; }
      if (body.action !== 'start') { json(res, 400, issue('BILI_ROUND_ACTION', '单轮操作无效。', '刷新设置页后重试。')); return true; }
      const ready = readiness();
      if (!ready.ok) { json(res, 409, ready); return true; }
      const stamp = ownerStamp(); const catalog = await models(); assertStamp(stamp);
      const afterCatalog = readiness(); if (!afterCatalog.ok) { json(res, 409, afterCatalog); return true; }
      if (!catalog.some(m => m.provider === body.provider && m.model === body.model)) {
        json(res, 400, issue('BILI_ROUND_MODEL_UNAVAILABLE', '所选模型不在当前 App 模型目录。', '检查该模型的连接和凭据后刷新目录。')); return true;
      }
      const result = await round.start({ provider: body.provider, model: body.model, maxTokens: body.maxTokens });
      json(res, result.ok === false ? 409 : 200, result); return true;
    } catch (error) {
      json(res, 400, issue(error.code || 'BILI_ROUND_FAILED', '单轮请求未完成。', error.hint || '刷新状态并检查现有轮次，不要重复启动。'));
      return true;
    }
  }
  return { handle, pause, cancelActive, beginTransition, withTransition, readiness, round, dispose: () => round.dispose() };
}
