import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import { buildDouyinReflectionSystem, parseDouyinReflection } from '../lib/douyin-companion-reflection.mjs';

const legacy = { feeling: 'like', reason: '表达清晰。', summary: '分享了一种整理方法。', draft: '' };
const sharing = { ...legacy, share: '这段把整理方法讲得很轻松，我喜欢这个节奏。', question: '你平时会用类似的方法吗？' };
const json = value => JSON.stringify(value);

// Opt-out retains the original four-field schema and rejects additive keys.
assert.deepEqual(parseDouyinReflection(json(legacy)), legacy);
assert.throws(() => parseDouyinReflection(json(sharing)), error => error.code === 'DOUYIN_MODEL_JSON_INVALID' && !!error.hint);

// Opt-in has exactly six fields, bounded natural copy, and one non-coercive question.
assert.deepEqual(parseDouyinReflection(json(sharing), { sharingEnabled: true }), sharing);
for (const share of [
  '听到这个转折，我立刻笑了出来。',
  '最后那句催着大家下单的推销让我有点出戏。',
  '主播说“不回复”三个字时，我觉得有点紧张。',
]) {
  assert.equal(parseDouyinReflection(json({ ...sharing, share }), { sharingEnabled: true }).share, share);
}
for (const bad of [
  { ...sharing, extra: 'unknown' },
  { ...sharing, share: '感受'.repeat(241) },
  { ...sharing, share: '打开 https://example.invalid/secret' },
  { ...sharing, share: '这里拿到了 api_key=abcd1234secret' },
  { ...sharing, summary: '图片 data:image/jpeg;base64,YWJj' },
  { ...sharing, question: '你怎么看？？' },
  { ...sharing, question: '务必回答我一下？' },
  { ...sharing, share: '你必须立刻回复我。' },
  { ...sharing, share: '请你转发这条视频。' },
  { ...sharing, share: '请你转发这条视频吧。' },
  { ...sharing, share: '你必须立刻回复我的问题。' },
]) {
  assert.throws(() => parseDouyinReflection(json(bad), { sharingEnabled: true }), error => /^(?:DOUYIN_MODEL_JSON_INVALID|DOUYIN_MODEL_OUTPUT_[A-Z_]+|DOUYIN_SHARING_OUTPUT_INVALID)$/.test(error.code) && !!error.hint);
}

const legacySystem = buildDouyinReflectionSystem();
assert.match(legacySystem, /仅有 feeling、reason、summary、draft 四个字段/);
assert.doesNotMatch(legacySystem, /share、question/);
const sharingSystem = buildDouyinReflectionSystem({ sharingEnabled: true });
assert.match(sharingSystem, /软萌、温柔/); // Used only as the approved fallback when the active context has no persona section.
assert.match(sharingSystem, /最多240字/);
assert.match(sharingSystem, /最多100字/);
assert.match(sharingSystem, /不得编造共同经历、用户偏好、用户真实情绪/);
assert.match(sharingSystem, /稀疏关键帧/);
assert.match(sharingSystem, /不调用工具/);
assert.match(sharingSystem, /WorkBuddy HY3/);

console.log('Companion sharing reflection schema fixtures passed');
