const invalid = () => Object.assign(new Error('分群语音规则无效。'), {
  code: 'VOICE_GROUP_RULES_INVALID', hint: '检查群号是否重复、触发方式以及日额度（0至500），再保存。'
});

export function voiceGroupPoliciesFromRows(rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw invalid();
  const policies = {};
  for (const row of rows) {
    const id = String(row?.groupId ?? '').trim();
    if (!/^[1-9]\d{4,19}$/.test(id) || Object.hasOwn(policies, id) || !['owner', 'mention'].includes(row?.triggerWho) ||
        !Number.isSafeInteger(row?.maxPerDay) || row.maxPerDay < 0 || row.maxPerDay > 500) throw invalid();
    policies[id] = { triggerWho: row.triggerWho, maxPerDay: row.maxPerDay };
  }
  return policies;
}

export function voiceGroupPolicies(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return voiceGroupPoliciesFromRows(Object.entries(value).map(([groupId, rule]) => ({ ...rule, groupId })));
}

export function voiceMentionBlock({ ownerAt, mentionAt, lastSentAt, now = Date.now() }) {
  const requestedAt = Math.max(ownerAt || 0, mentionAt || 0);
  if (!requestedAt || now - requestedAt > 10 * 60 * 1000) return '请在群里 @ 红豆请求语音，再重试（有效期10分钟）。';
  if (lastSentAt >= requestedAt) return '这条请求已发送过语音，请再次 @ 红豆提出新请求。';
  return null;
}
