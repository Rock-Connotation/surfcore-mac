import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--child') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-companion-recall-'));
  const child = spawnSync(process.execPath, [script, '--child', root], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: root, USERPROFILE: root },
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `fixture child exited ${child.status}`);
} else {
  const root = path.resolve(process.argv[3]);
  process.env.DSH_HOME = root;
  process.env.USERPROFILE = root;

  const chars = await import('../../../src/character-persona.js');
  const { createCompanionMemory } = await import('../lib/douyin-companion-memory.mjs');
  const { runMemoryCardMaintenance } = await import('../lib/memory-card.js');
  const { buildCharacterContext } = await import('../../../src/core/context.js');

  const role = chars.characterPaths('recallfixture');
  fs.mkdirSync(role.personaScenesDir, { recursive: true });
  fs.writeFileSync(role.persona, '# Existing identity\nCORE_COMPAT_SENTINEL');
  fs.writeFileSync(role.personaTone, 'PERSONA_COMPAT_SENTINEL');
  fs.writeFileSync(role.personaScenes.douyin, 'DOUYIN_SCENE_SENTINEL');
  fs.writeFileSync(role.manifest, JSON.stringify({ id: 'recallfixture', name: 'Recall Fixture', version: 1 }));
  fs.mkdirSync(path.dirname(chars.CURRENT_FILE), { recursive: true });
  fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ id: 'recallfixture', epoch: 1, name: 'Recall Fixture' }));

  const owner = { characterId: 'recallfixture', characterEpoch: 1 };
  const currentFocus = 'UNSCOPED_PRIVATE_FOCUS';
  const currentPurpose = 'UNSCOPED_PURPOSE_FOCUS';
  fs.mkdirSync(path.dirname(role.lifeState), { recursive: true });
  fs.writeFileSync(role.lifeState, JSON.stringify({ version: 1, characterId: owner.characterId, currentFocus }));
  fs.writeFileSync(role.purposeState, JSON.stringify({ lastPurpose: currentPurpose, goals: [], pending: [] }));

  const memory = createCompanionMemory({
    getCharacter: chars.readCurrentCharacter,
    maintainMemory: options => runMemoryCardMaintenance(options),
  });
  const phrase = index => `第${index}段镜头里，海面慢慢亮起，银白的小鲸缓缓摆尾，远处灯塔映着细碎的光。`;
  const summaries = [1, 2].map(index => Array.from({ length: 9 }, () => phrase(index)).join(''));
  const reasons = [1, 2].map(index => (`理由证据-DY-${index}：我把这一刻记住，是因为小白鲸停顿后才摆尾，像是在想好怎么继续。`).repeat(8).slice(0, 240));
  const ids = ['4000000000000000001', '4000000000000000002'];
  const times = [0, 1].map(offset => new Date(Date.now() + offset * 1000).toISOString());

  for (let index = 0; index < 2; index++) {
    assert.ok(summaries[index].length >= 300 && summaries[index].length <= 500);
    assert.equal(reasons[index].length, 240);
    const result = await memory.recordMemory(owner, {
      activityId: `activity-fixture-${index + 1}`,
      id: ids[index],
      title: `海面观察 ${index + 1}`,
      occurredAt: times[index],
      summary: summaries[index],
      reason: reasons[index],
      coverage: { complete: index === 0, missingRanges: index === 0 ? [] : [{ startMs: 900, endMs: 1200 }], visualCoverage: 'sparse', frameSamples: 3 },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  }

  // Re-read through the production context builder after append + card maintenance.
  const view = memory.buildContext(owner);
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.ok(view.memoryText.length <= 1800, `default memory budget exceeded: ${view.memoryText.length}`);
  for (let index = 0; index < 2; index++) {
    assert.ok(view.memoryText.includes(reasons[index]), `new context lost the complete reason for ${ids[index]}`);
    assert.ok(view.memoryText.includes(`抖音:${ids[index]}`), `new context lost the source id for ${ids[index]}`);
    assert.ok(view.memoryText.includes(times[index]), `new context lost the ISO event time for ${ids[index]}`);
  }
  assert.match(view.memoryText, /音轨部分覆盖，1段缺口，可能漏句/);
  assert.match(view.memoryText, /画面稀疏取样，3帧；只代表已取样画面，不推断未取样部分/);

  const inbox = fs.readFileSync(role.experienceInbox, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(inbox.length, 2);
  for (let index = 0; index < 2; index++) {
    assert.equal(inbox[index].content.summary, summaries[index], 'summary must remain separate from its reason');
    assert.ok(!inbox[index].content.summary.includes(reasons[index]));
    assert.ok(inbox[index].content.details.includes(reasons[index]));
    assert.ok(inbox[index].content.details.length <= 350, `Douyin detail exceeded its bound: ${inbox[index].content.details.length}`);
  }

  // Existing audiences do not receive this restricted Douyin record.
  for (const channel of ['qq', 'bili', 'pet']) {
    const external = buildCharacterContext({
      ...owner,
      audience: { channel, conversationKey: channel === 'qq' ? 'private:123' : '' },
    });
    for (let index = 0; index < 2; index++) {
      assert.ok(!external.memoryText.includes(reasons[index]), `${channel} received a Douyin reason`);
      assert.ok(!external.memoryText.includes(ids[index]), `${channel} received a Douyin source id`);
    }
  }

  // Legacy free-text life/purpose remains readable to its existing local caller,
  // while the Douyin adapter continues to exclude it.
  const legacyLocal = buildCharacterContext({ ...owner, audience: { channel: 'local' }, includePurpose: true });
  assert.ok(legacyLocal.text.includes(currentFocus));
  assert.ok(legacyLocal.text.includes(currentPurpose));
  assert.ok(!view.text.includes(currentFocus));
  assert.ok(!view.text.includes(currentPurpose));

  // Degraded/private records may keep their summary, but must never regain full reasons or IDs.
  const card = JSON.parse(fs.readFileSync(role.memoryJson, 'utf8'));
  const fuzzy = card.records.find(record => record.sourceId === ids[0]);
  const privateRecord = card.records.find(record => record.sourceId === ids[1]);
  assert.ok(fuzzy && privateRecord);
  fuzzy.clarity = 'fuzzy';
  privateRecord.private = true;
  privateRecord.visibilityClassification = 'private';
  privateRecord.allowedContexts = ['douyin'];
  fs.writeFileSync(role.memoryJson, JSON.stringify(card));
  const degraded = memory.buildContext(owner);
  assert.ok(degraded.memoryText.includes('细节记不清了'));
  for (let index = 0; index < 2; index++) {
    assert.ok(!degraded.memoryText.includes(reasons[index]), `fuzzy/private record ${ids[index]} regained its complete reason`);
    assert.ok(!degraded.memoryText.includes(`抖音:${ids[index]}`), `fuzzy/private record ${ids[index]} exposed its video id`);
  }

  const invalidFrameId = '4000000000000000003';
  const invalidFrame = await memory.recordMemory(owner, {
    activityId: 'activity-fixture-invalid-frames',
    id: invalidFrameId,
    title: '帧数边界检查',
    occurredAt: new Date(Date.now() + 3000).toISOString(),
    summary: '用来核对非法帧数不会被改写成一个看似有效的样本数。',
    reason: '超界帧数探针',
    coverage: { complete: false, missingRanges: [], visualCoverage: 'sparse', frameSamples: 6 },
  });
  assert.equal(invalidFrame.ok, true, JSON.stringify(invalidFrame));
  const invalidEvent = JSON.parse(fs.readFileSync(role.experienceInbox, 'utf8').trim().split('\n').at(-1));
  assert.match(invalidEvent.content.details, /取样帧数未确认/);
  assert.ok(!invalidEvent.content.details.includes('6帧') && !invalidEvent.content.details.includes('3帧'));
  assert.ok(invalidEvent.content.details.length <= 350);
  const invalidView = memory.buildContext({ ...owner, budget: { memory: 4000 } });
  const invalidLine = invalidView.memoryText.split('\n').find(line => line.includes(`抖音:${invalidFrameId}`));
  assert.ok(invalidLine, 'invalid sample count should remain traceable without becoming an accepted count');
  assert.match(invalidLine, /取样帧数未确认/);
  assert.doesNotMatch(invalidLine, /3帧|6帧/);

  console.log('PASS Douyin recall: append → maintenance → fresh context retains bounded reasons, IDs and ISO times without audience widening or invented frame counts');
}
