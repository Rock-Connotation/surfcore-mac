import { createHash } from 'node:crypto';
import { COMPANION_ROUTE } from './douyin-companion-model.mjs';
import { readMemoryRouting, deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { buildCharacterContext, prepareCharacterContext } from '../../../src/core/context.js';
import { appendExperienceEvent } from '../../../src/core/experience.js';
import { characterPaths, SURFCORE_DIR } from '../../../src/character-persona.js';

const imageDigest = frame => createHash('sha256').update(String(frame.dataUrl ?? '')).digest('hex').match(/.{16}/g);

export function createCompanionMemory({ getCharacter, maintainMemory, stateDir = SURFCORE_DIR, memoryV2 } = {}) {
  const current = context => { const role = getCharacter(); return role?.id === context.characterId && role?.epoch === context.characterEpoch; };
  const stale = () => ({ ok: false, code: 'COMPANION_CHARACTER_STALE', error: '角色已变化，本次经历未投影到新角色。', hint: '保留原活动记录，以当前角色发起新活动。' });
  const failure = (code, error, hint = '检查Host记忆权限与活动状态，清退旧会话后重新发起；不会回退旧记忆。') => ({ ok: false, code, error, hint });
  function routing() {
    try {
      const route = (memoryV2?.getRouting ?? (() => readMemoryRouting({ stateDir })))();
      return route?.ok === true && ['v1', 'v2'].includes(route.backend) ? route : route?.ok === false ? route : failure('MEMORY_ROUTING_INVALID', '可信记忆路由无效。');
    } catch { return failure('MEMORY_ROUTING_INVALID', '可信记忆路由读取失败。'); }
  }
  const adapter = memoryV2?.adapter;
  async function requireOk(result) {
    const value = await result;
    if (value?.ok !== true) throw Object.assign(new Error(value?.error || 'Host记忆操作未确认。'), value?.ok === false ? value : failure('MEMORY_HOST_FAILED', 'Host记忆操作未确认。'));
    return value;
  }
  async function capture(context, conversationKey) {
    // Capture is called before this function's first await; Host pins the role synchronously too.
    const role = getCharacter();
    if (role?.id !== context.characterId || role?.epoch !== context.characterEpoch) return requireOk(stale());
    if (!adapter || ['capture', 'ingest', 'receipt', 'prepare', 'validate', 'verifyPrepared', 'bindActualInput', 'release'].some(key => typeof adapter[key] !== 'function')) return requireOk(failure('MEMORY_ADAPTER_REQUIRED', 'V2缺少可信抖音记忆适配器。'));
    const pending = adapter.capture({ conversationKey });
    const captured = await requireOk(pending);
    if (!current(context)) { adapter.release(captured.handle); return requireOk(stale()); }
    const expected = deriveMemoryProviderRouteId(COMPANION_ROUTE);
    if (!expected.ok || captured.sourceStamp?.providerRouteId !== expected.providerRouteId) { adapter.release(captured.handle); return requireOk(failure('COMPANION_ROUTE_MISMATCH', '抖音原始上下文的授权路由与固定provider/model不一致。')); }
    return { ...captured, context: { ...context }, conversationKey, refs: [], receipts: [] };
  }
  async function validate(session, prepared = false) {
    if (!current(session.context)) return requireOk(stale());
    const route = routing();
    if (!route.ok || route.backend !== 'v2') return requireOk(route.ok ? failure('MEMORY_ROUTING_CHANGED', '活动期间记忆路由已变化。') : route);
    return requireOk(adapter.validate(session.handle, prepared ? session.preparedHandle : undefined));
  }
  function admitNetwork(session, dispatch, { signal } = {}) {
    if (typeof adapter?.withNetworkAdmission !== 'function') return requireOk(failure('MODEL_NETWORK_UNSUPPORTED', 'Host缺少原始句柄的串行网络准入接口。'));
    if (!current(session.context)) return requireOk(stale());
    const route = routing();
    if (!route.ok || route.backend !== 'v2') return requireOk(route.ok ? failure('MEMORY_ROUTING_CHANGED', '记忆路由已经变化。') : route);
    return adapter.withNetworkAdmission(session.handle, dispatch, { signal });
  }
  async function ingest(session, events, operationId) {
    await validate(session);
    const result = await requireOk(adapter.ingest(session.handle, events, operationId));
    const receipt = result.receipt ?? result;
    if (receipt?.sourceState !== 'committed') return requireOk(failure('MEMORY_SOURCE_UNCONFIRMED', '原始经历尚未确认保存。', '查询原操作回执；不会自动重新提交或调用模型。'));
    const refs = receipt.eventRefs;
    if (!Array.isArray(refs) || !refs.length) return requireOk(failure('MEMORY_SOURCE_REFS_REQUIRED', 'Host回执缺少已保存原文的精确引用。'));
    await requireOk(adapter.bindActualInput(session.handle, refs));
    session.refs.push(...refs); session.receipts.push(receipt);
    return { ok: true, refs, receipt };
  }
  const event = (session, identity, kind, content, extra = {}) => ({
    eventId: `${identity}:${kind}`, operationId: `${identity}:${kind}`, sourceKey: `${identity}:${kind}`, producerId: 'douyin-companion',
    segmentId: kind, producerSeq: 1, occurredAt: session.observedAt, observedAt: session.observedAt, timePrecision: 'exact', content, ...extra,
  });
  async function observe(session, { jobId, activityId, entry, perceived, images }) {
    session.observedAt = perceived.observedAt; session.identity = `douyin:${jobId}:${entry.id}:v1`;
    const coverage = { transcript: perceived.transcript?.coverage ?? {}, speechState: perceived.transcript?.speechState ?? 'unknown',
      frames: images.map(frame => ({ atMs: frame.atMs, sha256: imageDigest(frame) })), visualCoverage: 'sparse', warnings: perceived.warnings ?? [] };
    const { text: _text, ...transcriptMetadata } = perceived.transcript ?? {};
    const observation = JSON.parse(JSON.stringify({ ...perceived, transcript: transcriptMetadata,
      frames: (perceived.frames ?? []).map(frame => { const { dataUrl: _data, ...metadata } = frame; return { ...metadata, sha256: imageDigest(frame) }; }) }));
    return ingest(session, [
      event(session, session.identity, 'author', perceived.transcript?.text ?? '', { subject: `douyin-object:${entry.id}`, speaker: 'external-author:unknown', certainty: 'reported', attribution: 'quote', coverage: { ...coverage, observation }, evidenceRefs: [{ sourceUrl: entry.url }] }),
      event(session, session.identity, 'processing', JSON.stringify({ activityId, role: session.context.characterId, epoch: session.context.characterEpoch, processed: coverage }), { subject: session.context.characterId, speaker: session.context.characterId, certainty: 'observed', attribution: 'action', coverage }),
    ], `${session.identity}:source`);
  }
  async function prepareStep(session, input) {
    await validate(session);
    const built = await requireOk(prepareCharacterContext({ ...session.context, scene: 'douyin', audience: { channel: 'douyin', conversationKey: session.conversationKey }, includeLife: false, includePurpose: false },
      { adapter, handle: session.handle, query: String(input).slice(0, 6000) }));
    session.preparedHandle = built.preparedHandle;
    return built;
  }
  async function bindStep(session, { system, prompt, images }) {
    await validate(session, true);
    const content = JSON.stringify({ system, prompt, images: images.map(frame => ({ atMs: frame.atMs, sha256: imageDigest(frame) })) });
    return ingest(session, [event(session, session.identity, 'model-input', content, { subject: session.context.characterId, speaker: session.context.characterId, certainty: 'observed', attribution: 'action' })], `${session.identity}:model-input`);
  }
  async function reflect(session, value) {
    await validate(session);
    return ingest(session, [event(session, session.identity, 'reflection', JSON.stringify(value), { subject: session.context.characterId, speaker: session.context.characterId, certainty: 'reported', attribution: 'reflection', coverage: value.coverage })], `${session.identity}:reflection`);
  }
  async function blocked(session, error, detail = {}) {
    const value = { ...failure(error?.code || 'MEMORY_HOST_FAILED', error?.error || error?.message || 'V2活动已阻止。', error?.hint), ...detail };
    let proof;
    try { proof = await memoryV2?.onBlocked?.({ ...value, handle: session?.handle, characterId: session?.context.characterId ?? detail.characterId, characterEpoch: session?.context.characterEpoch ?? detail.characterEpoch }); } catch {}
    if (proof?.ok !== true || proof.retired !== true) return failure('MEMORY_RETIREMENT_UNCONFIRMED', 'V2活动已阻止，但Host尚未确认旧会话清退。', `检查清退回执并停止采用旧结果；原失败：${value.code}。`);
    return value;
  }
  function release(session) { if (session?.handle) adapter?.release(session.handle); }
  function buildContext(context) {
    const route = routing();
    if (!route.ok) return route;
    if (route.backend === 'v2') return failure('MEMORY_PREPARATION_REQUIRED', 'V2必须按本次实际输入准备记忆。');
    // Life/purpose free text has no audience metadata. Only the memory card can
    // prove a record is visible to this newly introduced channel.
    return buildCharacterContext({ ...context, scene: 'douyin', audience: { channel: 'douyin' }, includeLife: false, includePurpose: false,
      task: { summary: '按已获取的音轨与稀疏画面形成真实感受，记录覆盖范围与理由；只生成本机日记和草稿。' } });
  }
  async function recordMemory(context, value, { signal } = {}) {
    const route = routing();
    if (!route.ok) return route;
    if (route.backend === 'v2') return failure('MEMORY_PREPARATION_REQUIRED', 'V2经历必须通过已捕获的句柄保存。');
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
  return { buildContext, recordMemory, routing, capture, observe, prepareStep, bindStep, validate, admitNetwork, reflect, blocked, release };
}
