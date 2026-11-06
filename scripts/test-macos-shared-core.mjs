import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-core-'));
process.env.DSH_HOME = root;
const chars = await import('../src/character-persona.js');
const exp = await import('../src/core/experience.js');
const context = await import('../src/core/context.js');
const life = await import('../src/core/life.js');
const host = await import('../plugins/surfcore/lib/memory-card.js');
const role = chars.characterPaths('alpha');
fs.mkdirSync(role.biliDir, { recursive: true });
fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: 1, name: 'Alpha' }));
fs.writeFileSync(role.manifest, JSON.stringify({ id: 'alpha', name: 'Alpha', version: 1 }));
fs.writeFileSync(role.persona, '# Alpha\n' + 'core'.repeat(3000));
fs.writeFileSync(role.personaTone, 'TONE-TEST');
fs.mkdirSync(role.personaScenesDir, { recursive: true });
fs.writeFileSync(role.personaScenes.bili, 'SCENE-TEST');
const now = Date.now();
const mk = (id, visibility, source = { channel: 'bili' }) => ({ schemaVersion: 1, eventId: id, characterId: 'alpha', characterEpoch: 1, occurredAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), source, visibility, content: { summary: '测试独特经历 ' + id }, attribution: { subject: 'self', certainty: 'observed' } });
test('QQ disabled: local ledger reaches experience, card and next context, repeat is deduplicated', async () => {
 fs.writeFileSync(path.join(role.biliDir, 'scores.json'), JSON.stringify({ '2026-11-06': [{ bv: 'BV1234567890', score: 16, reason: '有趣的海洋故事', at: new Date(now).toISOString() }] }));
 let res = await host.runMemoryCardMaintenance({ now }); assert.equal(res.ok, true, JSON.stringify(res));
 assert.ok(res.addedExperience > 0); const queue = exp.readExperienceInbox(role); assert.ok(queue.events.length);
 const view = context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' }, budget: { maxChars: 1200 } });
 assert.equal(view.ok, true); assert.ok(view.text.length <= 1200);
 for (const maxChars of [0, 1, 100]) assert.ok(context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' }, budget: { maxChars } }).text.length <= maxChars); assert.match(view.memoryText, /海洋故事/); assert.match(view.personaText, /TONE-TEST/); assert.match(view.personaText, /SCENE-TEST/);
 res = await host.runMemoryCardMaintenance({ now }); assert.equal(res.ok, true); assert.equal(res.addedExperience, 0); assert.equal(exp.readExperienceInbox(role).events.length, queue.events.length);
});
test('scope fail closed, duplicate event projection and pending replay', async () => {
 const privateEvent = mk('private:1', { classification: 'private' }, { channel: 'qq', conversationId: 'private:123' });
 assert.equal(exp.appendExperienceEvent(role, privateEvent).ok, true); assert.equal(exp.appendExperienceEvent(role, privateEvent).ok, true);
 assert.equal(exp.appendExperienceEvent(role, mk('restricted:1', {})).ok, true);
 assert.equal(exp.appendExperienceEvent(role, mk('local:1', { classification: 'public' }, { channel: 'local' })).ok, true);
 const res = await host.runMemoryCardMaintenance({ now }); assert.equal(res.ok, true, JSON.stringify(res)); assert.equal(res.addedExperience, 3);
 assert.match(context.buildCharacterContext({ scene: 'local', audience: { channel: 'local' } }).memoryText, /local:1/);
 const bili = context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' } }); assert.doesNotMatch(bili.text, /private:1|restricted:1/);
 const qq = context.buildCharacterContext({ scene: 'qq-private', audience: { channel: 'qq', conversationKey: 'private:123' } }); assert.match(qq.memoryText, /private:1/);
});
test('failed projection replays without advancing durable cursor', async () => {
 const pending = mk('retry:1', { classification: 'public', legacyScope: 'bili' });
 assert.equal(exp.appendExperienceEvent(role, pending).ok, true);
 const before = JSON.parse(fs.readFileSync(role.memoryJson)).meta.experienceOffset;
 fs.renameSync(role.memoryJson, role.memoryJson + '.saved');
 fs.mkdirSync(role.memoryJson);
 const failure = await host.runMemoryCardMaintenance({ now }); assert.equal(failure.ok, false); assert.equal(failure.code, 'MEMORY_CARD_CORRUPT'); assert.ok(failure.hint);
 fs.renameSync(role.memoryJson, role.memoryJson + '.blocked');
 fs.renameSync(role.memoryJson + '.saved', role.memoryJson);
 assert.equal(JSON.parse(fs.readFileSync(role.memoryJson)).meta.experienceOffset, before);
 const res = await host.runMemoryCardMaintenance({ now }); assert.equal(res.ok, true); assert.equal(res.addedExperience, 1);
 assert.match(context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' } }).text, /retry:1/);
});
test('in-flight maintenance stays on original character after switch', async () => {
 const other = chars.characterPaths('beta'); fs.mkdirSync(other.biliDir, { recursive: true });
 const pending = host.runMemoryCardMaintenance({ now });
 await Promise.resolve();
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'beta', epoch: 2, name: 'Beta' }));
 const result = await pending; assert.equal(result.ok, true); assert.equal(fs.existsSync(other.memoryJson), false);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: 1, name: 'Alpha' }));
});
test('snapshot restores life while preserving and replaying newer experiences', async () => {
 assert.equal(life.saveCharacterLifeState({ characterId: 'alpha', characterEpoch: 1 }, { currentFocus: '快照中的目标' }).ok, true);
 chars.snapshotCharacter('alpha', { slot: 'fixture', now });
 assert.equal(exp.appendExperienceEvent(role, mk('after-snapshot:1', { classification: 'public', legacyScope: 'bili' })).ok, true);
 assert.equal(life.saveCharacterLifeState({ characterId: 'alpha', characterEpoch: 1 }, { currentFocus: '后来目标' }).ok, true);
 chars.restoreSnapshot('alpha', 'fixture', { now: now + 1000 });
 assert.equal(life.readCharacterLifeState({ characterId: 'alpha' }).state.currentFocus, '快照中的目标');
 const res = await host.runMemoryCardMaintenance({ now: now + 2000 }); assert.equal(res.ok, true); assert.equal(res.addedExperience, 1);
 assert.match(context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' } }).text, /after-snapshot:1/);
});
test('content observations retain external attribution and separate activity coverage without exposure', async () => {
 const observation = (id, activityId, endMs) => ({ ...mk(id, endMs === 1000 ? { classification: 'restricted', allowedContexts: ['bili'] } : { classification: 'restricted' }, { channel: 'bili', objectId: 'cid:123' }),
   activityId, kind: 'content_observed', content: { summary: `外部作品已取得并处理 0-${endMs}ms，作者陈述：喜欢晴天` },
   evidenceRefs: [{ assetId: 'fixture-audio', sourceUrl: 'https://example.test/video?token=secret', startMs: 0, endMs }],
   attribution: { subject: 'external', certainty: 'observed' } });
 const first = observation('obs:first', 'activity:first', 1000);
 const second = observation('obs:second', 'activity:second', 2000);
 assert.equal(exp.appendExperienceEvent(role, first).ok, true);
 assert.equal(exp.appendExperienceEvent(role, first).ok, true);
 assert.equal(exp.appendExperienceEvent(role, second).ok, true);
 const inbox = exp.readExperienceInbox(role); const queued = inbox.events.find((event) => event.eventId === first.eventId);
 assert.equal(queued.attribution.subject, 'external'); assert.equal(queued.evidenceRefs[0].endMs, 1000);
 assert.equal(queued.evidenceRefs[0].sourceUrl, 'https://example.test/video');
 const result = await host.runMemoryCardMaintenance({ now }); assert.equal(result.ok, true);
 const card = JSON.parse(fs.readFileSync(role.memoryJson));
 const observed = card.records.filter((record) => ['obs:first', 'obs:second'].includes(record.eventId));
 assert.equal(observed.length, 2, 'same cid with distinct event IDs must not be discarded');
 assert.equal(observed[0].attributionSubject, 'external');
 assert.equal(observed[0].attributionCertainty, 'observed');
 assert.equal(observed[0].evidenceRefs[0].endMs, 1000);
 const bili = context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' } }).text;
 assert.match(bili, /外部材料（作者观点，非角色信念）/); assert.match(bili, /0-1000ms/); assert.doesNotMatch(bili, /0-2000ms/);
 for (const channel of ['local', 'pet']) {
   assert.doesNotMatch(context.buildCharacterContext({ scene: channel, audience: { channel } }).text, /喜欢晴天/);
 }
 assert.doesNotMatch(context.buildCharacterContext({ scene: 'qq-private', audience: { channel: 'qq', conversationKey: 'private:123' } }).text, /喜欢晴天/);
 assert.equal(exp.validateExperienceEvent({ ...first, visibility: { classification: 'restricted', allowedContexts: ['unknown'] } }).ok, false);
});
test('life operates without channels and old epoch context rejected', () => {
 assert.equal(life.saveCharacterLifeState({ characterId: 'alpha', characterEpoch: 1 }, { currentFocus: '独立生活目标' }).ok, true);
 assert.match(context.buildCharacterContext({ scene: 'local', audience: { channel: 'local' } }).text, /独立生活目标/);
 const coordinated = life.coordinateCharacterLife({ characterId: 'alpha', characterEpoch: 1 }, { channels: { qq: false, bili: false }, now });
 assert.equal(coordinated.ok, true); assert.equal(coordinated.activity.kind, 'local-maintenance'); assert.deepEqual(coordinated.availableChannels, []);
 const again = life.coordinateCharacterLife({ characterId: 'alpha', characterEpoch: 1 }, { channels: {}, now }); assert.equal(again.state?.activities?.length ?? coordinated.state.activities.length, coordinated.state.activities.length);
 chars.bumpEpoch('alpha'); assert.equal(context.buildCharacterContext({ characterId: 'alpha', characterEpoch: 1 }).code, 'CHARACTER_EPOCH_STALE');
});

test('experience read failures remain actionable and future life state is preserved', () => {
 const future = chars.characterPaths('future'); fs.mkdirSync(future.lifeDir, { recursive: true });
 const bytes = JSON.stringify({ version: 2, characterId: 'future', activities: [{ futureOnly: true }] });
 fs.writeFileSync(future.lifeState, bytes);
 for (const result of [exp.readExperienceInbox({}), exp.readExperienceInbox(role, { offset: Number.MAX_SAFE_INTEGER }), life.readCharacterLifeState({ characterId: 'future' }), life.saveCharacterLifeState({ characterId: 'future', characterEpoch: 1 }, { currentFocus: 'must not overwrite' })]) {
  assert.equal(result.ok, false); assert.ok(result.code && result.error && result.hint);
 }
 assert.equal(fs.readFileSync(future.lifeState, 'utf8'), bytes, 'future schema must remain byte-identical');
});
