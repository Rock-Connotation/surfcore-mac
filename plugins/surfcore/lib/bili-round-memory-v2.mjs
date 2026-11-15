// F05：完整受控单轮的评分/点评/经历写回正式 V2，而不是已退役的旧记忆卡。
// operationId 由 jobId 派生；提交点前后的中断都查同一原回执，不新建 ID 重放 ingest、
// 不重跑整轮、不重复评分。这里只做写回事务，Host/角色/授权由装配方提供。
import { createHash } from 'node:crypto';

const problem = (code, error, hint) => ({ ok: false, code, error, hint });
const operationIdFor = jobId => `bili-round:${String(jobId).replace(/^round-/, '')}:memory`;
const eventIdFor = (operationId, name) => `${operationId}:${name}`;

function fact(operationId, name, content, producerSeq) {
  // 每个事件需要独立的 operationId（store 按 eventId/sourceKey/operationId 查重），
  // 但同一轮沿用同一个 ingest operationId，保证幂等查询的是原回执。
  const eventOperationId = eventIdFor(operationId, name);
  return { eventId: eventOperationId, operationId: eventOperationId,
    sourceKey: eventOperationId, producerId: 'bili:controlled-round',
    segmentId: operationId, producerSeq, content, certainty: 'observed', attribution: 'action' };
}

export function createBiliRoundMemoryV2Writer({ adapter, scope, getCharacter } = {}) {
  if (!adapter || typeof scope !== 'function' || typeof getCharacter !== 'function') throw new TypeError('Bili round V2 writer requires a real adapter, scope resolver and character reader.');
  const writes = new Map();
  async function resolvedScope() {
    const value = await scope();
    if (value?.ok !== true || typeof value.conversationKey !== 'string') {
      return { ok: false, code: value?.code || 'BILI_V2_ROUND_SCOPE_UNAVAILABLE',
        error: value?.error || '当前单轮没有已核验的 V2 记忆会话。', hint: value?.hint || '在记忆页按当前角色、账号、精确模型与完整公开来源集合预览并批准后再发起单轮。' };
    }
    return value;
  }
  async function queryReceipt(operationId) {
    const target = await resolvedScope();
    if (!target.ok) return target;
    const captured = await adapter.capture({ conversationKey: target.conversationKey });
    if (captured?.ok !== true) return captured;
    try { return await adapter.receipt(captured.handle, operationId); }
    finally { await Promise.resolve(adapter.release(captured.handle)).catch(() => {}); }
  }
  async function write(input) {
    const target = await resolvedScope();
    if (!target.ok) return target;
    const role = getCharacter();
    if (!role || role.id !== input.characterId || Number(role.epoch) !== Number(input.characterEpoch)) {
      return problem('CHARACTER_EPOCH_STALE', '单轮记忆写回时角色已切换。', '保留评分事实，以当前角色重新发起新活动；原事件不会进入新角色。');
    }
    const operationId = operationIdFor(input.jobId);
    const facts = [
      fact(operationId, 'score', `受控单轮评分已确认：${input.score?.score} 分；理由：${input.score?.reason}；账本：${JSON.stringify(input.score?.entry ?? null)}`, 1),
      fact(operationId, 'review', `受控单轮点评：${input.review?.commentary}；草稿：${input.review?.dynamicText}`, 2),
      fact(operationId, 'material', `受控单轮素材覆盖：${JSON.stringify(input.material ?? null)}`, 3),
    ];
    // 同一 operationId 绑定同一批事件；进程内重复调用不新建 ID、不重复写。
    const digest = createHash('sha256').update(JSON.stringify({ operationId, facts, conversationKey: target.conversationKey })).digest('hex');
    let write = writes.get(operationId);
    if (write && write.digest !== digest) return problem('MEMORY_DIGEST_CONFLICT', '原单轮记忆操作已绑定不同内容。', '用原 operationId 查询回执；不要改用新 ID 重放。');
    if (!write) {
      write = { digest, promise: (async () => {
        const captured = await adapter.capture({ conversationKey: target.conversationKey });
        if (captured?.ok !== true) return { ...captured, operationId };
        try {
          const ingested = await adapter.ingest(captured.handle, facts, operationId);
          if (ingested?.ok !== true) return { ...ingested, operationId };
          return { ok: true, operationId, receipt: ingested };
        } finally { await Promise.resolve(adapter.release(captured.handle)).catch(() => {}); }
      })() };
      writes.set(operationId, write);
    }
    const result = await write.promise;
    if (result?.ok === true) return { ok: true, operationId, receipt: result.receipt };
    // 提交未知只查原回执；失败或查不到都保留评分事实，不自动重跑整轮。
    const receipt = await queryReceipt(operationId);
    const confirmed = receipt?.ok === true && receipt.sourceState === 'committed' && receipt.operationState === 'completed';
    if (confirmed) return { ok: true, operationId, receipt };
    return { ok: false, code: result?.code || 'ROUND_MEMORY_UNCONFIRMED',
      error: result?.error || '评分已确认，但 V2 记忆提交未确认。',
      hint: `用原 operationId ${operationId} 查询回执；不会重跑整轮或重复评分。`,
      operationId, receipt: receipt?.ok === true ? receipt : null };
  }
  return Object.freeze({ operationIdFor, queryReceipt, write });
}
