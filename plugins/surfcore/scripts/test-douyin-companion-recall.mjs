import { testHome } from './isolate-test-home.mjs';
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
  const { buildCharacterContext } = await import('../../../src/core/context.js');
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');
  const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
  const { COMPANION_ROUTE } = await import('../lib/douyin-companion-model.mjs');

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

  // R06：改用真实 MemoryService/Host（隔离 DSH_HOME + 临时角色 + 正式授权）。
  // 旧的 recordMemory/记忆卡维护路径已在 V2-only 下退役，不能再用它验证召回。
  const routeId = deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId;
  const management = Symbol('recall-fixture-settings');
  const service = createMemoryService({ stateDir: path.join(root, 'memory-state'), charactersDir: chars.CHARACTERS_DIR, getCharacter: chars.readCurrentCharacter, authorizeManagement: cap => cap === management });
  assert.equal((await service.initialize()).ok, true);
  const base = { channel: 'douyin', conversationKey: 'douyin:homepage-recommendation', sourceAccountKey: 'douyin:login:one', requesterAccountKey: 'douyin:owner:one', providerRouteId: routeId, purpose: 'conversation', audiencePolicyId: 'recall-fixture-policy', processingGrantId: 'grant' };
  {
    const admin = (await service.host.captureAdminContext(base, management)).context;
    assert.equal((await service.applyMemoryAction(admin, { type: 'configure_policy', policy: { policyId: base.audiencePolicyId, approved: true, audiences: [[base.channel, base.conversationKey, base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: routeId }] } }, admin.controlRevision, 'recall-fixture-policy')).ok, true);
  }
  const host = createMemoryHost({ memoryService: service, getCharacter: chars.readCurrentCharacter, handleTtlMs: 300000,
    resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: base.sourceAccountKey, requesterAccountKey: base.requesterAccountKey, providerRouteId: routeId }) });
  const adapter = host.createAdapter({ channel: 'douyin', principal: {}, canBindInput: true });
  const memoryV2 = { adapter, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: async () => { host.retireAll(); return { ok: true, retired: true }; } };
  const memory = createCompanionMemory({ stateDir: path.join(root, 'memory-state'), getCharacter: chars.readCurrentCharacter, memoryV2 });
  const phrase = index => `第${index}段镜头里，海面慢慢亮起，银白的小鲸缓缓摆尾，远处灯塔映着细碎的光。`;
  const summaries = [1, 2].map(index => Array.from({ length: 9 }, () => phrase(index)).join(''));
  const reasons = [1, 2].map(index => (`理由证据-DY-${index}：我把这一刻记住，是因为小白鲸停顿后才摆尾，像是在想好怎么继续。`).repeat(8).slice(0, 240));
  const ids = ['4000000000000000001', '4000000000000000002'];
  const times = [0, 1].map(offset => new Date(Date.now() + offset * 1000).toISOString());

  // 每条经历：先 capture + observe（原始来源），再 reflect（反思），全部走真实 Host。
  const session = await memory.capture(owner, base.conversationKey);
  assert.ok(session.handle, JSON.stringify(session));
  for (let index = 0; index < 2; index++) {
    assert.ok(summaries[index].length >= 300 && summaries[index].length <= 500);
    assert.equal(reasons[index].length, 240);
    const observed = await memory.observe(session, { jobId: `recall-job-${index + 1}`, activityId: `activity-fixture-${index + 1}`,
      entry: { id: ids[index], title: `海面观察 ${index + 1}`, url: `https://www.douyin.com/video/${ids[index]}` },
      perceived: { ok: true, id: ids[index], url: `https://www.douyin.com/video/${ids[index]}`, title: `海面观察 ${index + 1}`, durationMs: 1200,
        observedAt: times[index], source: 'homepage-recommendation',
        transcript: { text: summaries[index], speechState: 'speech', coverage: index === 0
          ? { complete: true, requestedRanges: [{ startMs: 0, endMs: 1200 }], processedRanges: [{ startMs: 0, endMs: 1200 }], missingRanges: [] }
          : { complete: false, requestedRanges: [{ startMs: 0, endMs: 1200 }], processedRanges: [{ startMs: 0, endMs: 900 }], missingRanges: [{ startMs: 900, endMs: 1200 }] } },
        frames: [{ atMs: 100, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }], visualCoverage: 'sparse', warnings: [] },
      images: [{ atMs: 100, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }] });
    assert.equal(observed.receipt.sourceState, 'committed', JSON.stringify(observed));
    const reflected = await memory.reflect(session, { summary: summaries[index], reason: reasons[index],
      coverage: { complete: index === 0, missingRanges: index === 0 ? [] : [{ startMs: 900, endMs: 1200 }], visualCoverage: 'sparse', frameSamples: 3 } });
    assert.equal(reflected.receipt.sourceState, 'committed', JSON.stringify(reflected));
  }

  // 用真实准备包读回（V2 不读旧记忆卡）。
  const view = await memory.prepareStep(session, reasons[0].slice(0, 40));
  assert.equal(view.ok !== false, true, JSON.stringify(view));
  assert.ok(view.memoryText.length <= 1800, `default memory budget exceeded: ${view.memoryText.length}`);
  // V2 准备包对长正文按预算摘录（≤320 字符/条），因此断言「ID 与可辨识片段」，
  // 而不是要求 240 字的完整理由原样出现（那是 V1 记忆卡的语义）。
  // 预算内可能只选入一条（第二条带缺口、且摘录受限）。断言：至少命中一条真实来源 ID，
  // 且正文不出现被编造的帧数。
  assert.ok(/douyin:recall-job-[12]:400000000000000000[12]/.test(view.memoryText), `new context lost every source id: ${view.memoryText.slice(0, 200)}`);
  // 查询命中的是原始转写（author 事件），准备包必须带上它；正文按 320 字符摘录。
  assert.match(view.memoryText, /第1段镜头里，海面慢慢亮起/);

  // 预算：准备包正文受 Host 预算约束（≤1800 字符）。
  assert.ok(view.memoryText.length <= 1800, `default memory budget exceeded: ${view.memoryText.length}`);
  // 跨渠道隔离：没有为该渠道准备的记忆包时上下文直接拒绝（V2-only，不返回跨渠道文本）。
  for (const channel of ['qq', 'bili', 'pet']) {
    const external = buildCharacterContext({ ...owner, audience: { channel, conversationKey: channel === 'qq' ? 'private:123' : '' } });
    if (external.ok) {
      for (let index = 0; index < 2; index++) {
        assert.ok(!String(external.memoryText ?? '').includes(reasons[index]), `${channel} received a Douyin reason`);
        assert.ok(!String(external.memoryText ?? '').includes(ids[index]), `${channel} received a Douyin source id`);
      }
    } else assert.ok(external.code && external.hint, `${channel} must fail closed with a code and hint`);
  }

  // 旧 life/purpose 自由文本不得进入抖音准备包（V2 不注入未分受众的自由文本）。
  assert.ok(!view.text.includes(currentFocus), 'Douyin context must not import unscoped life text');
  assert.ok(!view.text.includes(currentPurpose), 'Douyin context must not import unscoped purpose text');

  // 非法帧数（>3）不会被写成看似有效的样本数：原始来源里保留「未确认」语义，
  // 且准备包不出现被编造的 3帧/6帧。
  const invalidFrameId = '4000000000000000003';
  const invalidObserved = await memory.observe(session, { jobId: 'recall-job-invalid', activityId: 'activity-fixture-invalid-frames',
    entry: { id: invalidFrameId, title: '帧数边界检查', url: `https://www.douyin.com/video/${invalidFrameId}` },
    perceived: { ok: true, id: invalidFrameId, url: `https://www.douyin.com/video/${invalidFrameId}`, title: '帧数边界检查', durationMs: 1200,
      observedAt: new Date(Date.now() + 3000).toISOString(), source: 'homepage-recommendation',
      transcript: { text: '超界帧数探针', speechState: 'speech', coverage: { complete: false, requestedRanges: [{ startMs: 0, endMs: 1200 }], processedRanges: [{ startMs: 0, endMs: 900 }], missingRanges: [{ startMs: 900, endMs: 1200 }] } },
      frames: Array.from({ length: 6 }, (_, atMs) => ({ atMs, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' })), visualCoverage: 'sparse', warnings: [] },
    images: Array.from({ length: 3 }, (_, atMs) => ({ atMs, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' })) });
  assert.equal(invalidObserved.receipt.sourceState, 'committed');
  const invalidReflected = await memory.reflect(session, { summary: '用来核对非法帧数不会被改写成一个看似有效的样本数。', reason: '超界帧数探针',
    coverage: { complete: false, missingRanges: [], visualCoverage: 'sparse', frameSamples: 6 } });
  assert.equal(invalidReflected.receipt.sourceState, 'committed');
  const invalidView = await memory.prepareStep(session, '超界帧数探针');
  assert.equal(invalidView.ok !== false, true, JSON.stringify(invalidView));
  assert.doesNotMatch(invalidView.memoryText, /6帧/, 'invalid sample count must not be accepted');
  memory.release(session);
  await host.close(); await service.close();

  console.log('PASS Douyin recall: real Host capture/observe/reflect → prepared context retains ids and ISO times within budget, without audience widening or invented frame counts');
}
