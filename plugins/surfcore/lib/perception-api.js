import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isLoopbackReq, sameOrigin, safeEqual, readBody, json } from './http-guard.js';

const PREFIX = '/dsh-surfcore/perception-api';
const failure = (code, error, hint) => ({ ok: false, code, error, hint });
const publicJob = (job) => {
  if (!job) return null;
  const out = {};
  for (const key of ['jobId', 'state', 'stage', 'characterId', 'characterEpoch', 'activityId', 'createdAt', 'updatedAt', 'progress', 'result', 'part', 'frames', 'coverage', 'memoryState', 'memoryError', 'history', 'code', 'error', 'hint', 'warnings']) {
    if (job[key] !== undefined) out[key] = job[key];
  }
  return out;
};

/** One Host service, two transports: DSH-authenticated settings and a scoped local CLI token. */
export function createPerceptionApiService({ service, stateDir, currentDshUrl, getCharacter, getConfig = () => ({}), getChannels = async () => [], observeBili, resumeBili, configure }) {
  const root = path.join(stateDir, 'perception');
  const assets = path.join(root, 'assets');
  const secret = randomBytes(32).toString('hex');
  const hostFile = path.join(root, 'host.json');
  fs.mkdirSync(assets, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  function writeHostFile() {
    const raw = String(currentDshUrl() || '');
    if (!raw) return;
    const base = new URL(raw);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) return;
    const tmp = `${hostFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, baseUrl: base.origin, api: PREFIX, token: secret }), { mode: 0o600 });
    fs.renameSync(tmp, hostFile);
    fs.chmodSync(hostFile, 0o600);
  }
  function roleOf(job) { return { id: job?.characterId ?? job?.request?.characterId, epoch: job?.characterEpoch ?? job?.request?.characterEpoch }; }
  async function performDispatch(method, url, body = {}, trusted = false) {
    if (trusted && method === 'POST' && body.action === 'configure' && configure) return configure(body.config);
    const current = getCharacter();
    if (method === 'GET' && !url.searchParams.has('jobId')) {
      return { ok: true, status: await service.getStatus(), doctor: await service.doctor(), models: await service.listModels(), channels: await getChannels(),
        ...(trusted ? { config: getConfig() } : {}), jobs: (await service.listJobs({ characterId: current?.id, limit: 40 })).filter((j) => current && roleOf(j).id === current.id).map(publicJob) };
    }
    if (method === 'POST' && body.action === 'submit-bili') {
      const request = body.request;
      if (!current || request?.characterId !== current.id || request?.characterEpoch !== current.epoch) {
        return failure('CHARACTER_STALE', '角色已切换，不能提交旧角色任务', '刷新当前角色后重新提交');
      }
      const context = { characterId: current.id, characterEpoch: current.epoch, activityId: request.activityId };
      const result = observeBili ? await observeBili(request, context) : await service.submitBili(request);
      return result?.ok === false ? result : { ok: true, ...result };
    }
    const id = method === 'GET' ? url.searchParams.get('jobId') : body.jobId;
    if (method === 'POST' && body.action === 'submit') {
      const request = body.request;
      if (!current || request?.characterId !== current.id || request?.characterEpoch !== current.epoch) {
        return failure('CHARACTER_STALE', '角色已切换，不能提交旧角色任务', '刷新当前角色后重新获取素材并提交');
      }
      try {
        const file = fs.realpathSync(request.asset.localPath);
        const base = fs.realpathSync(assets);
        if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) throw new Error();
      } catch { return failure('ASSET_UNAVAILABLE', '素材不在本实例的感知资产目录', '重新获取素材到当前数据根的 perception/assets 后提交'); }
      // Local clients cannot upgrade private media to a public Bili experience.
      // Bili acquisition runs inside the Host adapter via submit-bili instead.
      const admitted = { ...request,
        source: { channel: 'local', objectId: String(request.asset.assetId || '') },
        provenance: { channel: 'local', sourceId: String(request.asset.assetId || ''), acquiredAtMs: Date.now() },
        visibility: { classification: 'restricted', allowedContexts: ['local'] },
      };
      const result = await service.submit(admitted);
      return result?.ok === false ? result : { ok: true, ...result };
    }
    const job = id ? await service.getJob(id) : null;
    if (!job) return failure('JOB_NOT_FOUND', '没有找到转写作业', '刷新作业列表后选择现有作业');
    if (!current || roleOf(job).id !== current.id) return failure('JOB_FORBIDDEN', '作业属于另一个角色', '切回原角色后查看其作业');
    if (method === 'GET') return { ok: true, job: publicJob(job) };
    if (method !== 'POST') return failure('METHOD_NOT_ALLOWED', '不支持此请求方法', '使用 GET 查询或 POST 提交作业操作');
    if (!['cancel', 'resume'].includes(body.action)) return failure('ACTION_INVALID', '未知感知操作', '选择提交、取消或恢复作业');
    if (body.action === 'resume' && roleOf(job).epoch !== current.epoch) {
      return failure('CHARACTER_STALE', '作业属于旧角色版本，不能恢复', '重新获取当前角色的素材并提交新作业');
    }
    // Retrying an already-acquired experience is local maintenance. Restarting Bili
    // acquisition must pass the same channel readiness gate as initial submission.
    const memoryOnly = ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(job.state) && ['pending', 'failed'].includes(job.memoryState);
    const result = body.action === 'resume' && String(job.jobId).startsWith('bili-') && !memoryOnly && resumeBili
      ? await resumeBili(job, { characterId: current.id, characterEpoch: current.epoch, activityId: job.activityId })
      : await service[body.action](id);
    if (result?.ok === false) return result;
    const resultId = body.action === 'resume' && result?.jobId ? result.jobId : id;
    return { ok: true, ...(result || {}), job: publicJob(await service.getJob(resultId)) };
  }
  // Shared across both transports: no submit/resume may enter a configure+persist rollback.
  let mutation = Promise.resolve();
  function dispatch(method, url, body, trusted) {
    if (method !== 'POST' || body?.action === 'cancel') return performDispatch(method, url, body, trusted);
    const result = mutation.then(() => performDispatch(method, url, body, trusted));
    mutation = result.catch(() => {});
    return result;
  }
  async function handle(req, res, url, { trusted = false } = {}) {
    const deny = (code, error, hint, status = 403) => json(res, status, failure(code, error, hint));
    if (!trusted && (!isLoopbackReq(req) || !safeEqual(req.headers['x-perception-token'], secret))) {
      deny('PERCEPTION_AUTH_REQUIRED', '感知服务认证失败', '确认官方 App 正在运行，再重新读取当前数据根的服务发现文件'); return;
    }
    if (!sameOrigin(req)) { deny('ORIGIN_REJECTED', '跨站感知请求被拒绝', '从 SurfCore 设置页重新执行此操作'); return; }
    if (!['GET', 'POST'].includes(req.method)) { deny('METHOD_NOT_ALLOWED', '不支持此请求方法', '使用 GET 查询或 POST 操作', 405); return; }
    try {
      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
          deny('JSON_REQUIRED', '写操作需要 JSON', '使用 application/json 提交作业操作', 415); return;
        }
        try { body = JSON.parse(await readBody(req, 256 * 1024)); }
        catch { deny('JSON_INVALID', '作业请求不是有效 JSON', '检查请求内容后重新提交', 400); return; }
      }
      const result = await dispatch(req.method, url, body, trusted);
      json(res, result.ok === false ? 400 : 200, result);
    } catch (error) {
      json(res, 400, failure(error.code || 'PERCEPTION_FAILED', error.error || '感知操作失败', error.hint || '刷新作业状态，检查本地模型与媒体工具后重试'));
    }
  }
  return { prefix: PREFIX, handle, writeHostFile, hostFile };
}
