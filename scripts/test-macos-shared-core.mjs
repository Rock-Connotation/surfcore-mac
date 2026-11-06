import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-core-'));
process.env.DSH_HOME = root;
const fixtureRepo = path.join(root, 'fixture-repo');
fs.mkdirSync(path.join(fixtureRepo, 'src'), { recursive: true });
fs.writeFileSync(path.join(fixtureRepo, 'config.json'), '{}');
fs.writeFileSync(path.join(fixtureRepo, 'src', 'bridge.js'), '');
process.env.SURFCORE_ROOT = fixtureRepo;
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

test('output write failure is visible for captured role, preserves cursor, and clears after successful replay', async () => {
 const oldRole = chars.readCurrentCharacter();
 assert.equal(oldRole.id, 'alpha');
 const before = JSON.parse(fs.readFileSync(role.memoryJson)).meta.experienceOffset;
 const pending = { ...mk('output-retry:1', { classification: 'public', legacyScope: 'bili' }), characterEpoch: oldRole.epoch };
 assert.equal(exp.appendExperienceEvent(role, pending).ok, true);
 const original = `${role.memoryPromptBili}.fixture-saved`;
 fs.renameSync(role.memoryPromptBili, original);
 fs.mkdirSync(role.memoryPromptBili);
 const running = host.runMemoryCardMaintenance({ now });
 await Promise.resolve();
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'beta', epoch: oldRole.epoch + 1, name: 'Beta' }));
 const failure = await running;
 assert.equal(failure.ok, false); assert.equal(failure.code, 'MEMORY_MAINTENANCE_FAILED'); assert.ok(failure.error && failure.hint);
 assert.equal(JSON.parse(fs.readFileSync(role.memoryJson)).meta.experienceOffset, before);
 assert.equal(host.memoryCardStatusNow().lastFailure, null);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: oldRole.epoch, name: 'Alpha' }));
 assert.equal(host.memoryCardStatusNow().lastFailure.code, failure.code);
 assert.ok(host.memoryCardSnapshot().status.lastFailure.hint);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'beta', epoch: oldRole.epoch + 1, name: 'Beta' }));
 assert.equal(host.memoryCardStatusNow().lastFailure, null);
 assert.equal(host.memoryCardSnapshot().status.lastFailure, null);
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'alpha', epoch: oldRole.epoch, name: 'Alpha' }));
 assert.equal(host.memoryCardStatusNow().lastFailure.code, failure.code);
 fs.renameSync(role.memoryPromptBili, `${role.memoryPromptBili}.fixture-blocked`);
 fs.renameSync(original, role.memoryPromptBili);
 const retried = await host.runMemoryCardMaintenance({ now });
 assert.equal(retried.ok, true); assert.equal(retried.addedExperience, 1);
 assert.equal(host.memoryCardStatusNow().lastFailure, null);
 assert.equal(host.memoryCardSnapshot().status.lastFailure, null);
 assert.match(context.buildCharacterContext({ scene: 'bili', audience: { channel: 'bili' } }).text, /output-retry:1/);
 const archived = fs.readFileSync(role.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(archived.filter((item) => item.eventId === 'output-retry:1').length, 1, 'replay must not append the same experience twice');
});

test('journal recovers completed append without rescanning archive or duplicating experience', async () => {
 const crypto = await import('node:crypto'); const gamma = chars.characterPaths('gamma');
 fs.mkdirSync(gamma.biliDir, { recursive: true });
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'gamma', epoch: 1, name: 'Gamma' }));
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const event = { ...mk('journal:complete', { classification: 'restricted' }), characterId: 'gamma', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(gamma, event).ok, true);
 const payload = Buffer.from(`${JSON.stringify({ id: 'journal-fixture-record', eventId: event.eventId, source: 'bili-experience', platform: 'bili', scope: 'restricted', text: event.content.summary, createdAt: event.occurredAt })}\n`);
 const stats = JSON.parse(fs.readFileSync(gamma.memoryFullStats)); const offset = fs.statSync(gamma.memoryFullJsonl).size;
 stats.pendingAppend = { offset, length: payload.length, digest: crypto.createHash('sha256').update(payload).digest('hex'), keys: [`event:${event.eventId}`], records: 1, chars: event.content.summary.length, counts: { owner: 0, bili: 1, qq: 0, other: 0 }, at: new Date(now).toISOString() };
 fs.writeFileSync(gamma.memoryFullStats, JSON.stringify(stats)); fs.appendFileSync(gamma.memoryFullJsonl, payload);
 const result = await host.runMemoryCardMaintenance({ now }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.addedExperience, 1);
 const lines = fs.readFileSync(gamma.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(lines.filter((record) => record.eventId === event.eventId).length, 1);
 const after = JSON.parse(fs.readFileSync(gamma.memoryFullStats)); assert.equal(after.pendingAppend, undefined); assert.equal(after.records, stats.records + 1);
});

test('partial journal append fails closed without truncating archive or advancing cursor', async () => {
 const crypto = await import('node:crypto'); const gamma = chars.characterPaths('gamma');
 const before = JSON.parse(fs.readFileSync(gamma.memoryJson)).meta.experienceOffset;
 const event = { ...mk('journal:partial', { classification: 'restricted' }), characterId: 'gamma', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(gamma, event).ok, true);
 const payload = Buffer.from('{"id":"partial-example"}\n'); const partial = payload.subarray(0, 8);
 const stats = JSON.parse(fs.readFileSync(gamma.memoryFullStats)); const offset = fs.statSync(gamma.memoryFullJsonl).size;
 stats.pendingAppend = { offset, length: payload.length, digest: crypto.createHash('sha256').update(payload).digest('hex'), keys: [`event:${event.eventId}`], records: 1, chars: 0, counts: { owner: 0, bili: 0, qq: 0, other: 1 }, at: new Date(now).toISOString() };
 fs.writeFileSync(gamma.memoryFullStats, JSON.stringify(stats)); fs.appendFileSync(gamma.memoryFullJsonl, partial);
 const failure = await host.runMemoryCardMaintenance({ now });
 assert.equal(failure.code, 'MEMORY_ARCHIVE_RECOVERY_REQUIRED'); assert.ok(failure.error && failure.hint);
 assert.equal(fs.statSync(gamma.memoryFullJsonl).size, offset + partial.length);
 assert.equal(JSON.parse(fs.readFileSync(gamma.memoryJson)).meta.experienceOffset, before);
 assert.equal(host.memoryCardSnapshot().status.lastFailure.code, failure.code);
});

test('snapshot replay after subsequent successful maintenance must not duplicate archived experience', async () => {
 const delta = chars.characterPaths('delta'); fs.mkdirSync(delta.biliDir, { recursive: true });
 fs.writeFileSync(delta.manifest, JSON.stringify({ id: 'delta', name: 'Delta', version: 1 }));
 fs.writeFileSync(delta.persona, '# Delta');
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'delta', epoch: 1, name: 'Delta' }));
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 chars.snapshotCharacter('delta', { slot: 'fixture', now });
 const event = { ...mk('snapshot:archive', { classification: 'restricted' }), characterId: 'delta', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(delta, event).ok, true);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 chars.restoreSnapshot('delta', 'fixture', { now: now + 1000 });
 const newer = { ...mk('snapshot:new', { classification: 'restricted' }), characterId: 'delta', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(delta, newer).ok, true);
 assert.equal((await host.runMemoryCardMaintenance({ now: now + 2000 })).ok, true);
 const entries = fs.readFileSync(delta.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(entries.filter((entry) => entry.eventId === event.eventId).length, 1);
 assert.equal(entries.filter((entry) => entry.eventId === newer.eventId).length, 1);
});

test('replaced or truncated experience inbox fails closed without moving archive watermark', async () => {
 const delta = chars.characterPaths('delta'); const before = JSON.parse(fs.readFileSync(delta.memoryFullStats)).experienceArchiveOffset;
 const bytes = fs.readFileSync(delta.experienceInbox); const original = `${delta.experienceInbox}.original`;
 fs.renameSync(delta.experienceInbox, original); fs.writeFileSync(delta.experienceInbox, bytes);
 let failure = await host.runMemoryCardMaintenance({ now });
 assert.equal(failure.code, 'EXPERIENCE_ARCHIVE_INBOX_MISMATCH'); assert.ok(failure.hint);
 assert.equal(JSON.parse(fs.readFileSync(delta.memoryFullStats)).experienceArchiveOffset, before);
 fs.renameSync(delta.experienceInbox, `${delta.experienceInbox}.replacement`); fs.renameSync(original, delta.experienceInbox);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 assert.equal(host.memoryCardSnapshot().status.lastFailure, null);
 fs.truncateSync(delta.experienceInbox, 0);
 failure = await host.runMemoryCardMaintenance({ now });
 assert.equal(failure.code, 'EXPERIENCE_CURSOR_AHEAD'); assert.ok(failure.hint);
 assert.equal(JSON.parse(fs.readFileSync(delta.memoryFullStats)).experienceArchiveOffset, before);
 fs.writeFileSync(delta.experienceInbox, bytes);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
});

test('legacy layout without current character or experience inbox remains maintainable', async () => {
 const currentFile = path.join(chars.CHARACTERS_DIR, 'current.json');
 fs.renameSync(currentFile, `${currentFile}.fixture-saved`);
 const result = await host.runMemoryCardMaintenance({ now });
 assert.equal(result.ok, true, JSON.stringify(result));
 assert.equal(host.memoryCardStatusNow().lastFailure, null);
 fs.renameSync(`${currentFile}.fixture-saved`, currentFile);
});

test('B站 aggregation backup failure is actionable in the affected role status', async () => {
 const epsilon = chars.characterPaths('epsilon'); fs.mkdirSync(epsilon.biliDir, { recursive: true });
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'epsilon', epoch: 1, name: 'Epsilon' }));
 fs.writeFileSync(path.join(epsilon.biliDir, 'scores.json'), '{}');
 fs.mkdirSync(path.join(epsilon.biliDir, 'bili-memory.json'));
 const result = await host.runMemoryCardMaintenance({ now });
 assert.equal(result.ok, false); assert.equal(result.code, 'BILI_AGGREGATE_BACKUP_FAILED'); assert.ok(result.error && result.hint);
 assert.equal(host.memoryCardSnapshot().status.lastFailure.code, result.code);
 assert.equal(fs.existsSync(epsilon.memoryJson), false);
});

test('journal and card commits sync files before rename and directories before reporting success', async () => {
 const durable = chars.characterPaths('durable'); fs.mkdirSync(durable.biliDir, { recursive: true });
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'durable', epoch: 1, name: 'Durable' }));
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const event = { ...mk('durable:order', { classification: 'restricted' }), characterId: 'durable', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(durable, event).ok, true);
 const events = []; const files = new Map(); const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, rename: fs.renameSync };
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); files.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { files.delete(fd); return original.close.call(this, fd); };
 fs.fsyncSync = function (fd) { events.push(['sync', files.get(fd)]); return original.sync.call(this, fd); };
 fs.renameSync = function (from, to) { events.push(['rename', String(from), String(to)]); return original.rename.call(this, from, to); };
 try { assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true); }
 finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; fs.renameSync = original.rename; }
 const journalSync = events.findIndex((e) => e[0] === 'sync' && e[1]?.startsWith(`${durable.memoryFullStats}.`) && e[1].endsWith('.tmp'));
 const journalRename = events.findIndex((e) => e[0] === 'rename' && e[2] === durable.memoryFullStats);
 const archiveSync = events.findIndex((e) => e[0] === 'sync' && e[1] === durable.memoryFullJsonl);
 const journalDirSync = events.findIndex((e, i) => i > journalRename && i < archiveSync && e[0] === 'sync' && e[1] === durable.memoryDir);
 const stagedSync = events.findIndex((e) => e[0] === 'sync' && e[1]?.startsWith(`${durable.memoryJson}.maintain-`) && !e[1].endsWith('.tmp'));
 const cardRename = events.findIndex((e) => e[0] === 'rename' && e[2] === durable.memoryJson);
 const cardDirSync = events.findIndex((e, i) => i > cardRename && e[0] === 'sync' && e[1] === durable.memoryDir);
 assert.ok(journalSync >= 0 && journalSync < journalRename && journalRename < journalDirSync && journalDirSync < archiveSync, JSON.stringify(events));
 assert.ok(stagedSync >= 0 && stagedSync < cardRename && cardRename < cardDirSync, JSON.stringify(events));
});

test('journal fsync failure rejects before archive append and preserves retry', async () => {
 const durable = chars.characterPaths('durable');
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const beforeSize = fs.statSync(durable.memoryFullJsonl).size;
 const beforeCursor = JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset;
 const event = { ...mk('durable:journal-failure', { classification: 'restricted' }), characterId: 'durable', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(durable, event).ok, true);
 const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync }; const files = new Map(); let injected = false;
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); files.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { files.delete(fd); return original.close.call(this, fd); };
 fs.fsyncSync = function (fd) { const file = files.get(fd); if (!injected && file?.startsWith(`${durable.memoryFullStats}.`) && file.endsWith('.tmp')) { injected = true; const e = new Error('fixture I/O'); e.code = 'EIO'; throw e; } return original.sync.call(this, fd); };
 let failure;
 try { failure = await host.runMemoryCardMaintenance({ now }); }
 finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; }
 assert.equal(injected, true); assert.equal(failure.code, 'MEMORY_MAINTENANCE_FAILED'); assert.ok(failure.hint);
 assert.equal(fs.statSync(durable.memoryFullJsonl).size, beforeSize); assert.equal(JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset, beforeCursor);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 assert.equal(fs.readFileSync(durable.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.eventId === event.eventId).length, 1);
});

test('directory fsync error after card rename reports uncertain commit and blocks receipt cleanup until synced', async () => {
 const durable = chars.characterPaths('durable');
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const event = { ...mk('durable:dir-failure', { classification: 'restricted' }), characterId: 'durable', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(durable, event).ok, true);
 const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, rename: fs.renameSync }; const files = new Map(); let renamed = false; let injected = false;
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); files.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { files.delete(fd); return original.close.call(this, fd); };
 fs.renameSync = function (from, to) { const result = original.rename.call(this, from, to); if (String(to) === durable.memoryJson) renamed = true; return result; };
 fs.fsyncSync = function (fd) { if (renamed && !injected && files.get(fd) === durable.memoryDir) { injected = true; const e = new Error('fixture I/O'); e.code = 'EIO'; throw e; } return original.sync.call(this, fd); };
 let failure;
 try { failure = await host.runMemoryCardMaintenance({ now }); }
 finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; fs.renameSync = original.rename; }
 assert.equal(injected, true); assert.equal(failure.code, 'MEMORY_COMMIT_UNCERTAIN'); assert.ok(failure.hint);
 const receipt = JSON.parse(fs.readFileSync(durable.memoryFullStats)).uncommittedArchiveKeys;
 assert.ok(receipt.includes(`event:${event.eventId}`));
 const blockedFiles = new Map(); let blocked = false;
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); blockedFiles.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { blockedFiles.delete(fd); return original.close.call(this, fd); };
 fs.fsyncSync = function (fd) { if (!blocked && blockedFiles.get(fd) === durable.memoryDir) { blocked = true; const e = new Error('fixture I/O'); e.code = 'EIO'; throw e; } return original.sync.call(this, fd); };
 try { const rejected = await host.runMemoryCardMaintenance({ now }); assert.equal(rejected.ok, false); assert.ok(rejected.hint); }
 finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; }
 assert.equal(blocked, true); assert.ok(JSON.parse(fs.readFileSync(durable.memoryFullStats)).uncommittedArchiveKeys.includes(`event:${event.eventId}`));
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 assert.equal(host.memoryCardStatusNow().lastFailure, null);
 assert.equal(fs.readFileSync(durable.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.eventId === event.eventId).length, 1);
});

test('journal directory fsync failure happens before archive append and is recoverable', async () => {
 const durable = chars.characterPaths('durable');
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const beforeSize = fs.statSync(durable.memoryFullJsonl).size;
 const beforeCursor = JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset;
 const event = { ...mk('durable:journal-dir-failure', { classification: 'restricted' }), characterId: 'durable', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(durable, event).ok, true);
 const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, rename: fs.renameSync }; const files = new Map(); let journalRenamed = false; let injected = false;
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); files.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { files.delete(fd); return original.close.call(this, fd); };
 fs.renameSync = function (from, to) { const result = original.rename.call(this, from, to); if (String(to) === durable.memoryFullStats) journalRenamed = true; return result; };
 fs.fsyncSync = function (fd) { if (journalRenamed && !injected && files.get(fd) === durable.memoryDir) { injected = true; const e = new Error('fixture I/O'); e.code = 'EIO'; throw e; } return original.sync.call(this, fd); };
 let failure;
 try { failure = await host.runMemoryCardMaintenance({ now }); }
 finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; fs.renameSync = original.rename; }
 assert.equal(injected, true); assert.equal(failure.code, 'MEMORY_MAINTENANCE_FAILED'); assert.ok(failure.hint);
 assert.equal(fs.statSync(durable.memoryFullJsonl).size, beforeSize);
 assert.equal(JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset, beforeCursor);
 assert.ok(JSON.parse(fs.readFileSync(durable.memoryFullStats)).pendingAppend);
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 assert.equal(fs.readFileSync(durable.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.eventId === event.eventId).length, 1);
});

test('directory fsync only tolerates explicit unsupported codes, not I/O failure', async () => {
 const { syncDurableDirectory } = await import('../src/memory-card.js');
 const originalSync = fs.fsyncSync;
 try {
   fs.fsyncSync = () => { const error = new Error('fixture unsupported'); error.code = 'EINVAL'; throw error; };
   assert.doesNotThrow(() => syncDurableDirectory(root));
   fs.fsyncSync = () => { const error = new Error('fixture I/O'); error.code = 'EIO'; throw error; };
   assert.throws(() => syncDurableDirectory(root), { code: 'EIO' });
 } finally { fs.fsyncSync = originalSync; }
});

test('archive append fsync failure must be synced again before recovery clears journal or advances cursor', async () => {
 const durable = chars.characterPaths('durable');
 fs.writeFileSync(path.join(chars.CHARACTERS_DIR, 'current.json'), JSON.stringify({ id: 'durable', epoch: 1, name: 'Durable' }));
 assert.equal((await host.runMemoryCardMaintenance({ now })).ok, true);
 const before = JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset;
 const event = { ...mk('durable:archive-sync-recovery', { classification: 'restricted' }), characterId: 'durable', characterEpoch: 1 };
 assert.equal(exp.appendExperienceEvent(durable, event).ok, true);
 const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync }; const fds = new Map(); let injected = 0;
 fs.openSync = function (file, ...args) { const fd = original.open.call(this, file, ...args); fds.set(fd, String(file)); return fd; };
 fs.closeSync = function (fd) { fds.delete(fd); return original.close.call(this, fd); };
 fs.fsyncSync = function (fd) {
   if (fds.get(fd) === durable.memoryFullJsonl && injected < 2) { injected++; const error = new Error('fixture archive fsync I/O'); error.code = 'EIO'; throw error; }
   return original.sync.call(this, fd);
 };
 let first; let second;
 try {
   first = await host.runMemoryCardMaintenance({ now });
   assert.equal(first.ok, false); assert.ok(first.code && first.hint);
   assert.ok(JSON.parse(fs.readFileSync(durable.memoryFullStats)).pendingAppend);
   assert.equal(JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset, before);
   second = await host.runMemoryCardMaintenance({ now });
   assert.equal(second.code, 'MEMORY_ARCHIVE_RECOVERY_REQUIRED'); assert.ok(second.hint);
   assert.ok(JSON.parse(fs.readFileSync(durable.memoryFullStats)).pendingAppend);
   assert.equal(JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset, before);
 } finally { fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; }
 assert.equal(injected, 2);
 const recovered = await host.runMemoryCardMaintenance({ now }); assert.equal(recovered.ok, true);
 assert.equal(JSON.parse(fs.readFileSync(durable.memoryFullStats)).pendingAppend, undefined);
 assert.ok(JSON.parse(fs.readFileSync(durable.memoryJson)).meta.experienceOffset > before);
 assert.equal(fs.readFileSync(durable.memoryFullJsonl, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.eventId === event.eventId).length, 1);
});
