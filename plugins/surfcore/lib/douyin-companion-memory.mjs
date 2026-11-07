import { buildCharacterContext } from '../../../src/core/context.js';
import { appendExperienceEvent } from '../../../src/core/experience.js';
import { characterPaths } from '../../../src/character-persona.js';

export function createCompanionMemory({ getCharacter, maintainMemory }) {
  const current = context => { const role = getCharacter(); return role?.id === context.characterId && role?.epoch === context.characterEpoch; };
  const stale = () => ({ ok: false, code: 'COMPANION_CHARACTER_STALE', error: '角色已变化，本次经历未投影到新角色。', hint: '保留原活动记录，以当前角色发起新活动。' });
  function buildContext(context) {
    // Life/purpose free text has no audience metadata. Only the memory card can
    // prove a record is visible to this newly introduced channel.
    return buildCharacterContext({ ...context, scene: 'douyin', audience: { channel: 'douyin' }, includeLife: false, includePurpose: false,
      task: { summary: '按已获取的音轨与稀疏画面形成真实感受，记录覆盖范围与理由；只生成本机日记和草稿。' } });
  }
  async function recordMemory(context, value, { signal } = {}) {
    const cancelled = () => ({ ok: false, code: 'COMPANION_MEMORY_CANCELLED', error: '本次记忆整理已取消。', hint: '保留取消前已确认的经历，以当前角色查看活动状态。' });
    if (signal?.aborted) return cancelled();
    if (!current(context)) return stale();
    if (!/^[0-9]{1,32}$/.test(String(value.id)) || !value.activityId || !value.summary || !value.reason) {
      return { ok: false, code: 'COMPANION_MEMORY_INVALID', error: '本次经历缺少视频编号、感受或理由。', hint: '检查活动证据，不会凭推荐标题补写观看经历。' };
    }
    const at = value.occurredAt || value.observedAt;
    const missingRanges = Array.isArray(value.coverage?.missingRanges) ? value.coverage.missingRanges.length : null;
    const audioCoverage = value.coverage?.complete === true && missingRanges === 0
      ? '音轨完整处理，未见缺口'
      : (missingRanges === null
        ? '音轨覆盖未确认，可能漏句'
        : `音轨部分覆盖${missingRanges ? `，${missingRanges}段缺口` : ''}，可能漏句`);
    const frameSamples = Number.isSafeInteger(value.coverage?.frameSamples) && value.coverage.frameSamples >= 1 && value.coverage.frameSamples <= 3
      ? value.coverage.frameSamples
      : null;
    const frameCoverage = frameSamples === null
      ? '画面稀疏取样，取样帧数未确认；只代表已取样画面，不推断未取样部分。'
      : `画面稀疏取样，${frameSamples}帧；只代表已取样画面，不推断未取样部分。`;
    const details = `理由：${String(value.reason).trim().slice(0, 240)}；${audioCoverage}。${frameCoverage}`.slice(0, 350);
    const appended = appendExperienceEvent(characterPaths(context.characterId), {
      schemaVersion: 1, eventId: `douyin:${value.activityId}:${value.id}`, ...context, activityId: value.activityId,
      occurredAt: at, observedAt: at, source: { channel: 'douyin', objectId: value.id }, kind: 'reflection',
      visibility: { classification: 'restricted', allowedContexts: ['douyin', 'local'] },
      content: { title: value.title, summary: value.summary, details, tags: ['观看感受', '稀疏画面'], type: 'reflection' },
      evidenceRefs: [{ sourceUrl: `https://www.douyin.com/video/${value.id}` }], attribution: { subject: 'self', certainty: 'reported' },
    });
    if (!appended.ok) return appended;
    if (signal?.aborted) return cancelled();
    if (!current(context)) return stale();
    const maintained = await maintainMemory({ signal, expectedCharacter: context });
    if (signal?.aborted) return cancelled();
    if (!current(context)) return stale();
    if (maintained?.ok === false) return maintained;
    return { ok: true, eventId: appended.eventId };
  }
  return { buildContext, recordMemory };
}
