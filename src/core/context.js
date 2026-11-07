import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  characterPaths, characterPersonaMeta, isValidCharacterId, personaLayersForCharacter, readCurrentCharacter,
} from '../character-persona.js';
import { normalizeMemoryCardConfig, loadMemoryCard, renderMemoryCard } from '../memory-card.js';
import { buildPersonaIdentity, personaNameFromCard } from '../persona-identity.js';
import { composePersonaLayers, personaSceneFromKey } from '../persona-layers.js';
import { lifeContextText, readCharacterLifeState } from './life.js';
import { normalizePurposeState, summarizePurposeState } from '../purpose-engine.js';

const DEFAULT_BUDGET = Object.freeze({ maxChars: 6000, memory: 1800, life: 360, purpose: 360, task: 280 });

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function clip(text, max) {
  const value = String(text ?? '').trim();
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  return limit ? value.slice(0, limit) : '';
}

function layerText(file) {
  return file ? readText(file) : '';
}

function purposeText(file, maxChars) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return ''; }
  const state = normalizePurposeState(raw);
  const summary = summarizePurposeState(state);
  const lines = [];
  if (summary.lastPurpose) lines.push(`最近惦记：${summary.lastPurpose}`);
  for (const goal of summary.goals.slice(0, 3)) {
    if (goal.intent) lines.push(`目标：${goal.intent}${goal.nextStep ? `；下一步：${goal.nextStep}` : ''}`);
  }
  for (const item of summary.pending.slice(-3)) if (item.text) lines.push(`待继续：${item.text}`);
  return clip(lines.join('\n'), maxChars);
}

function safeBudget(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const supplied = raw.maxChars === undefined ? DEFAULT_BUDGET.maxChars : Number(raw.maxChars);
  const maxChars = Math.max(0, Math.min(20000, Math.round(Number.isFinite(supplied) ? supplied : DEFAULT_BUDGET.maxChars)));
  const reserves = raw.reserves && typeof raw.reserves === 'object' ? raw.reserves : {};
  const caps = {};
  for (const key of ['memory', 'life', 'purpose', 'task']) {
    const fallback = Math.min(DEFAULT_BUDGET[key], Math.round(maxChars * ({ memory: 0.3, life: 0.08, purpose: 0.08, task: 0.08 }[key])));
    caps[key] = Math.max(0, Math.min(maxChars, Math.round(Number(reserves[key] ?? raw[key] ?? fallback) || 0)));
  }
  // Preserve the persona budget first, then reduce optional context reserves if a small total is requested.
  const headers = 64;
  const minPersona = Math.min(800, Math.round(maxChars * 0.35));
  let spare = Math.max(0, maxChars - headers - minPersona);
  for (const key of ['task', 'purpose', 'life', 'memory']) {
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
  if (request.allowStale !== true && (!current || current.id !== requestedId || current.epoch !== requestedEpoch)) {
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
  const budget = safeBudget(request.budget);
  const includePersona = request.includePersona !== false;
  const includeMemory = request.includeMemory !== false;
  const includeLife = request.includeLife !== false;
  const includePurpose = request.includePurpose === true;
  const includeTask = request.includeTask !== false;
  const memoryConfig = normalizeMemoryCardConfig(request.memoryConfig ?? {});
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
      daily: layerSet.daily,
      identity,
      personaMode: request.personaMode ?? 'full',
      mode: request.mode ?? 'v2',
      maxChars: budget.persona,
      sceneId: scene,
      layerReserves: personaReserves,
    });
    personaText = composed.text;
    personaDiagnostics = composed;
  }

  let card = null;
  let memoryText = '';
  let memoryRevision = 'empty';
  if (includeMemory && budget.memory > 0) {
    try {
      const raw = fs.readFileSync(paths.memoryJson);
      memoryRevision = digest(raw);
      card = loadMemoryCard({ json: paths.memoryJson });
      const memoryPlatform = ['qq', 'bili', 'pet', 'local', 'douyin'].includes(channel) ? channel : 'restricted';
      // QQ without a conversation key has no safe private/shared view.
      const effectivePlatform = memoryPlatform === 'qq' && !conversationKey ? 'restricted' : memoryPlatform;
      memoryText = renderMemoryCard(card, {
        platform: effectivePlatform,
        conversationKey,
        config: memoryConfig,
        maxChars: budget.memory,
      });
    } catch {
      card = null;
    }
  }

  const lifeRead = includeLife ? readCharacterLifeState({ characterId: requestedId, characterEpoch: requestedEpoch }) : null;
  const lifeTextValue = lifeRead?.ok ? lifeContextText(lifeRead.state, budget.life) : '';
  const purposeTextValue = includePurpose ? purposeText(paths.purposeState, budget.purpose) : '';
  const taskText = includeTask ? clip(request.task?.summary ?? request.task?.purpose ?? '', budget.task) : '';
  const sections = [
    { kind: 'persona', text: personaText, chars: personaText.length, omitted: !personaText, layers: personaDiagnostics.layers, reserved: personaDiagnostics.reserved, truncated: personaDiagnostics.truncated },
    { kind: 'memory', text: memoryText, chars: memoryText.length, omitted: !memoryText },
    { kind: 'life', text: lifeTextValue, chars: lifeTextValue.length, omitted: !lifeTextValue },
    { kind: 'purpose', text: purposeTextValue, chars: purposeTextValue.length, omitted: !purposeTextValue },
    { kind: 'task', text: taskText, chars: taskText.length, omitted: !taskText },
  ];
  const headings = { persona: '【统一人格】', memory: '【统一记忆】', life: '【生活状态】', purpose: '【当前目的】', task: '【当前任务】' };
  const text = sections.filter((item) => item.text).map((item) => `${headings[item.kind]}\n${item.text}`).join('\n\n').slice(0, budget.maxChars);
  const personaRevision = digest(JSON.stringify({
    core: layerSet?.core ?? '',
    tone: layerSet?.tone ?? '',
    sceneText: layerSet?.scene ?? '',
    daily: layerSet?.daily ?? '',
    identity,
    scene,
  }));
  const lifeRevision = fs.existsSync(paths.lifeState) ? digest(JSON.stringify(lifeRead?.state ?? {})) : 'empty';
  const revision = digest(JSON.stringify({ requestedId, requestedEpoch, personaRevision, memoryRevision, lifeRevision, scene, channel, conversationKey, purposeTextValue, taskText, text }));
  return {
    ok: true,
    characterId: requestedId,
    characterEpoch: requestedEpoch,
    scene,
    personaRevision,
    memoryRevision,
    lifeRevision,
    revision,
    text,
    personaText,
    memoryText,
    lifeText: lifeTextValue,
    purposeText: purposeTextValue,
    sections: sections.map(({ text: _text, ...item }) => item),
    budget: { ...budget, used: text.length, remaining: Math.max(0, budget.maxChars - text.length) },
    errors: lifeRead && !lifeRead.ok ? [{ code: lifeRead.code, error: lifeRead.error, hint: lifeRead.hint }] : [],
  };
}
