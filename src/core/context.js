import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  characterPaths, characterPersonaMeta, isValidCharacterId, personaLayersForCharacter, readCurrentCharacter,
} from '../character-persona.js';
import { buildPersonaIdentity, personaNameFromCard } from '../persona-identity.js';
import { composePersonaLayers, personaSceneFromKey } from '../persona-layers.js';
import { digest as memoryDigest, validatePrepared } from './memory-v2-contract.js';

const DEFAULT_BUDGET = Object.freeze({ maxChars: 6000, memory: 1800, task: 280 });

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function clip(text, max) {
  const value = String(text ?? '').trim();
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  let result = limit ? value.slice(0, limit) : '';
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function layerText(file) {
  return file ? readText(file) : '';
}

function safeBudget(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const supplied = raw.maxChars === undefined ? DEFAULT_BUDGET.maxChars : Number(raw.maxChars);
  const maxChars = Math.max(0, Math.min(20000, Math.round(Number.isFinite(supplied) ? supplied : DEFAULT_BUDGET.maxChars)));
  const reserves = raw.reserves && typeof raw.reserves === 'object' ? raw.reserves : {};
  const caps = {};
  for (const key of ['memory', 'task']) {
    const fallback = Math.min(DEFAULT_BUDGET[key], Math.round(maxChars * ({ memory: 0.3, task: 0.08 }[key])));
    caps[key] = Math.max(0, Math.min(maxChars, Math.round(Number(reserves[key] ?? raw[key] ?? fallback) || 0)));
  }
  // Preserve the persona budget first, then reduce optional context reserves if a small total is requested.
  const headers = 64;
  const minPersona = Math.min(800, Math.round(maxChars * 0.35));
  let spare = Math.max(0, maxChars - headers - minPersona);
  for (const key of ['task', 'memory']) {
    if (caps[key] <= spare) { spare -= caps[key]; continue; }
    caps[key] = spare;
    spare = 0;
  }
  const persona = Math.max(0, maxChars - headers - Object.values(caps).reduce((sum, value) => sum + value, 0));
  return { maxChars, persona, ...caps };
}

function readPinnedLayers(id, scene) {
  const layers = personaLayersForCharacter(id);
  if (!layers) return null;
  const sceneKey = String(scene ?? '').trim();
  const sceneFile = layers.scenes?.[sceneKey]
    || (/^[a-z][a-z0-9-]{0,31}$/.test(sceneKey) ? path.join(layers.scenesDir, `${sceneKey}.md`) : '');
  return {
    paths: layers,
    core: layerText(layers.core),
    tone: layerText(layers.tone),
    daily: layerText(layers.daily),
    scene: layerText(sceneFile),
  };
}

/** Prepare through a trusted adapter; callers still validate again before model, persistence and send. */
export async function prepareCharacterContext(request = {}, { adapter, handle, query } = {}) {
  const current = readCurrentCharacter();
  const pinned = { ...request, characterId: request.characterId ?? current?.id, characterEpoch: request.characterEpoch ?? current?.epoch };
  const failed = (code, error, hint) => ({ ok: false, code, error, hint, characterId: pinned.characterId, characterEpoch: pinned.characterEpoch, text: '', sections: [] });
  if (!current || current.id !== pinned.characterId || current.epoch !== pinned.characterEpoch) {
    return failed('CHARACTER_EPOCH_STALE', '准备开始时角色快照已经失效。', '清退旧会话并重新捕获角色后重试。');
  }
  if (!adapter || ['prepare', 'validate', 'verifyPrepared'].some(key => typeof adapter[key] !== 'function')) {
    return failed('MEMORY_ADAPTER_REQUIRED', '缺少可信记忆适配器。', '检查Host记忆服务与会话接线，不使用旧记忆回退。');
  }
  try {
    const budget = safeBudget({ ...request.budget, maxChars: Math.min(6000, request.budget?.maxChars ?? 6000) });
    const result = await adapter.prepare(handle, query, { memory: Math.min(1800, budget.memory), total: budget.maxChars });
    if (!result?.ok) return result?.ok === false ? result : failed('MEMORY_PREPARATION_FAILED', 'Host没有返回记忆准备结果。', '检查服务状态并查询原请求，不自动重试。');
    const validated = await adapter.validate(handle, result.preparedHandle);
    if (!validated?.ok) return validated?.ok === false ? validated : failed('MEMORY_PREPARED_UNTRUSTED', 'Host没有确认准备包。', '重新捕获当前会话并准备记忆。');
    if ((pinned.audience?.channel && pinned.audience.channel !== result.prepared.channel)
      || (pinned.audience?.conversationKey && pinned.audience.conversationKey !== result.prepared.conversationKey)) {
      return failed('MEMORY_PREPARED_STALE', '准备包不属于调用者固定的渠道或会话。', '丢弃旧句柄并按当前具体会话重新捕获，不跨会话复用。');
    }
    const built = buildCharacterContext({ ...pinned, memoryBackend: 'v2',
      audience: { ...pinned.audience, channel: result.prepared.channel, conversationKey: result.prepared.conversationKey },
      memoryContext: result.prepared, preparedMemory: result.prepared, memoryQuery: query,
      verifyPreparedMemory: value => adapter.verifyPrepared(handle, result.preparedHandle, value) });
    return built.ok ? { ...built, memoryHandle: handle, preparedHandle: result.preparedHandle,
      inputManifest: result.inputManifest ?? result.prepared.inputManifest } : built;
  } catch {
    return failed('MEMORY_PREPARATION_FAILED', '记忆准备或签发校验未完成。', '查看Host状态并清退旧会话，不回退到旧热卡或历史。');
  }
}

/**
 * Build a bounded, revision-tagged view of one character. This function is synchronous so callers
 * can capture role id/epoch before scheduling any asynchronous work; it never re-reads active paths.
 */
export function buildCharacterContext(request = {}) {
  const current = readCurrentCharacter(); // capture identity before reading or awaiting anything
  const requestedId = String(request.characterId ?? current?.id ?? '');
  const requestedEpoch = Number(request.characterEpoch ?? (current?.id === requestedId ? current.epoch : 0));
  const fail = (code, error, hint) => ({ ok: false, code, error, hint, characterId: requestedId, characterEpoch: requestedEpoch, text: '', sections: [] });
  if (!isValidCharacterId(requestedId)) {
    return fail('CHARACTER_CONTEXT_REQUIRED', '角色上下文缺少有效 characterId。', '先同步读取当前角色，再构造上下文请求。');
  }
  if (!Number.isInteger(requestedEpoch) || requestedEpoch < 1) {
    return fail('CHARACTER_EPOCH_REQUIRED', '角色上下文缺少有效 characterEpoch。', '提交任务前同步读取当前角色并固定 epoch。');
  }
  if (!current || current.id !== requestedId || current.epoch !== requestedEpoch) {
    return fail('CHARACTER_EPOCH_STALE', '角色已切换，上下文请求绑定的 epoch 已过期。', '重新捕获当前角色后再构造上下文。');
  }

  const paths = characterPaths(requestedId);
  const scene = String(request.scene ?? personaSceneFromKey(request.audience?.conversationKey ?? '', request.audience?.channel ?? '')).trim();
  const audience = request.audience && typeof request.audience === 'object' ? request.audience : {};
  const channel = String(audience.channel ?? scene ?? 'local').trim().toLowerCase();
  const conversationKey = String(audience.conversationKey ?? '').trim();
  const layerSet = readPinnedLayers(requestedId, scene);
  const meta = characterPersonaMeta(requestedId) ?? {};
  const identity = String(request.identity ?? buildPersonaIdentity({
    name: meta.name || personaNameFromCard(layerSet?.core ?? '', current?.name ?? '这个角色'),
    owner: String(audience.ownerName ?? '').trim() || '主人',
  }));
  const budget = safeBudget({ ...request.budget, maxChars: Math.min(6000, request.budget?.maxChars ?? 6000) });
  budget.memory = Math.min(1800, budget.memory);
  const includePersona = request.includePersona !== false;
  const includeMemory = request.includeMemory !== false;
  const includeTask = request.includeTask !== false;
  const personaReserves = request.budget?.layerReserves && typeof request.budget.layerReserves === 'object'
    ? request.budget.layerReserves
    : {
      identity: Math.min(180, budget.persona * 0.08),
      core: Math.min(1000, budget.persona * 0.42),
      tone: Math.min(260, budget.persona * 0.12),
      scene: Math.min(300, budget.persona * 0.14),
      daily: Math.min(160, budget.persona * 0.08),
    };
  let personaText = '';
  let personaDiagnostics = { layers: {}, reserved: {}, omitted: [], truncated: false };
  if (includePersona && layerSet) {
    const composed = composePersonaLayers({
      core: layerSet.core,
      tone: layerSet.tone,
      scene: layerSet.scene,
      daily: '',
      identity,
      personaMode: request.personaMode ?? 'full',
      maxChars: budget.persona,
      sceneId: scene,
      layerReserves: personaReserves,
    });
    personaText = composed.text;
    personaDiagnostics = composed;
  }

  let memoryText = '';
  let memoryRevision = 'empty';
  let memoryContext = null;
  let preparedMemory = null;
  if (includeMemory) {
    try {
      memoryContext = request.memoryContext;
      preparedMemory = request.preparedMemory;
      if (!memoryContext || memoryContext.characterId !== requestedId || memoryContext.capturedEpoch !== requestedEpoch
        || memoryContext.channel !== channel || memoryContext.conversationKey !== conversationKey) {
        return fail('MEMORY_PREPARED_STALE', '准备包与当前角色或具体会话不匹配。', '通过当前会话的Host适配器重新准备记忆，旧会话需要清退后再继续。');
      }
      if (typeof request.verifyPreparedMemory !== 'function') {
        return fail('MEMORY_PREPARED_UNTRUSTED', '缺少Host准备包的同步签发校验。', '使用当前Host适配器绑定的校验闭包；模型或HTTP正文不能提供此能力。');
      }
      const verified = request.verifyPreparedMemory(preparedMemory, memoryContext);
      if (verified?.ok !== true || typeof verified?.then === 'function') {
        return fail(verified?.code || 'MEMORY_PREPARED_UNTRUSTED', verified?.error || '准备包签发校验失败。', verified?.hint || '重新捕获会话并准备记忆，模型调用前仍须异步校验当前控制。');
      }
      validatePrepared(preparedMemory, memoryContext, Date.now());
      if (typeof request.memoryQuery !== 'string' || preparedMemory.queryDigest !== memoryDigest(request.memoryQuery)) {
        return fail('MEMORY_QUERY_MISMATCH', '准备包不属于本次提问。', '用当前获准问题重新准备记忆，不复用上一次问题的准备包。');
      }
      if (preparedMemory.text.length > budget.memory) {
        return fail('MEMORY_PREPARED_BUDGET', '准备包超过当前记忆预算。', '按当前上下文预算重新准备；不会截断可能包含否定或覆盖限制的摘录。');
      }
      memoryRevision = memoryDigest(preparedMemory);
      memoryText = preparedMemory.text;
    } catch (error) {
      return fail(error.code || 'MEMORY_PREPARED_INVALID', error.error || error.message || '记忆准备包无效。', error.hint || '刷新Host上下文并重新准备记忆。');
    }
  }

  const taskText = includeTask ? clip(request.task?.summary ?? request.task?.purpose ?? '', budget.task) : '';
  const sections = [
    { kind: 'persona', text: personaText, chars: personaText.length, omitted: !personaText, layers: personaDiagnostics.layers, reserved: personaDiagnostics.reserved, truncated: personaDiagnostics.truncated },
    { kind: 'memory', text: memoryText, chars: memoryText.length, omitted: !memoryText },
    { kind: 'task', text: taskText, chars: taskText.length, omitted: !taskText },
  ];
  const headings = { persona: '【统一人格】', memory: '【统一记忆】', task: '【当前任务】' };
  const text = clip(sections.filter((item) => item.text).map((item) => `${headings[item.kind]}\n${item.text}`).join('\n\n'), budget.maxChars);
  const personaRevision = digest(JSON.stringify({
    core: layerSet?.core ?? '',
    tone: layerSet?.tone ?? '',
    sceneText: layerSet?.scene ?? '',
    daily: '',
    identity,
    scene,
  }));
  const revision = digest(JSON.stringify({ requestedId, requestedEpoch, personaRevision, memoryRevision, scene, channel, conversationKey, taskText, text }));
  return {
    ok: true,
    characterId: requestedId,
    characterEpoch: requestedEpoch,
    scene,
    personaRevision,
    memoryRevision,
    memoryBackend: 'v2',
    memoryContext,
    preparedMemory,
    inputManifest: preparedMemory?.inputManifest ?? [],
    revision,
    text,
    personaText,
    memoryText,
    sections: sections.map(({ text: _text, ...item }) => item),
    budget: { ...budget, used: text.length, remaining: Math.max(0, budget.maxChars - text.length) },
    errors: [],
  };
}
