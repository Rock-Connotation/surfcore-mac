// V2-only 测试夹具（2026-11-12）。
//
// context.js 的 V1 记忆卡注入已随 V1 退役删除：buildCharacterContext 现在只接受
// 由 Host 适配器签发的准备包（memoryContext / preparedMemory / memoryQuery /
// verifyPreparedMemory）。旧「账本 → 记忆卡 → 上下文」用例仍要断言卡片内容，
// 就把 renderMemoryCard 的结果包成一个合法的 V2 准备包传进去 —— 测的是新契约，
// 不在生产代码里复活旧后端。
import { CONTEXT_FIELDS, digest } from '../src/core/memory-v2-contract.js';
import { loadMemoryCard, normalizeMemoryCardConfig, renderMemoryCard } from '../src/memory-card.js';
import { readCurrentCharacter } from '../src/character-persona.js';

/** 把一段文本包成 buildCharacterContext 认可的（同步校验过的）V2 准备包。 */
export function preparedMemoryView(text, { characterId, characterEpoch = 1, channel = 'local', conversationKey = '', query = 'fixture-query' } = {}) {
  const current = readCurrentCharacter();
  const id = String(characterId ?? current?.id ?? '');
  const epoch = Number(characterEpoch ?? current?.epoch ?? 1);
  const context = Object.fromEntries(CONTEXT_FIELDS.map((key) => [key, key]));
  Object.assign(context, { characterId: id, capturedEpoch: epoch, channel, conversationKey, purpose: 'conversation' });
  const prepared = {
    ...context,
    schemaVersion: 2,
    queryDigest: digest(query),
    expiresAt: Date.now() + 60_000,
    eventWatermark: 0,
    evidenceIds: [],
    inputManifest: [],
    text: String(text ?? ''),
    budget: { estimated: true },
  };
  return { memoryContext: context, preparedMemory: prepared, memoryQuery: query, verifyPreparedMemory: () => ({ ok: true }) };
}

/** 旧链路的卡片渲染结果：只用于给上面的准备包供文本，不再被生产 context 直接读取。 */
export function cardText(paths, { channel = 'bili', conversationKey = '', maxChars = 0 } = {}) {
  const card = loadMemoryCard({ json: paths.memoryJson });
  const platform = ['qq', 'bili', 'pet', 'local', 'douyin'].includes(channel) ? channel : 'restricted';
  const effectivePlatform = platform === 'qq' && !conversationKey ? 'restricted' : platform;
  return renderMemoryCard(card, {
    platform: effectivePlatform,
    conversationKey,
    config: normalizeMemoryCardConfig({}),
    maxChars,
  });
}
