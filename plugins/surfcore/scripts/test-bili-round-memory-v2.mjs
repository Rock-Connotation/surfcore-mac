// F05：完整单轮评分事实写回正式 V2 的离线回归。
// 用真实 MemoryService/Host（隔离根 + 正式 preview/commit 授权），不联网、不调模型、不碰真实 ~/.dsh。
import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { createMemoryService } from '../../../src/core/memory-v2-service.js';
import { createMemoryHost } from '../lib/memory-v2-host.mjs';
import { createBiliRoundMemoryV2Writer } from '../lib/bili-round-memory-v2.mjs';

const home = fs.realpathSync(testHome);
const stateDir = path.join(home, 'surfcore');
const charactersDir = path.join(stateDir, 'characters');
const role = { id: 'app', epoch: 8 };
const management = Symbol('bili-round-memory-v2');
const routeId = deriveMemoryProviderRouteId({ provider: 'fixture-provider', model: 'fixture-model' }).providerRouteId;
const conversationKey = 'bili:9:public:round';

fs.mkdirSync(path.join(charactersDir, role.id), { recursive: true });
fs.writeFileSync(path.join(charactersDir, 'current.json'), JSON.stringify({ version: 1, ...role }));
const service = createMemoryService({ stateDir, charactersDir, getCharacter: () => role, authorizeManagement: value => value === management });
assert.equal((await service.initialize()).ok, true);
const admin = async () => (await service.host.captureAdminContext({ channel: 'bili', conversationKey, sourceAccountKey: 'bili:9:actor:9',
  requesterAccountKey: 'bili:9:actor:9', providerRouteId: routeId, purpose: 'conversation',
  audiencePolicyId: 'management', processingGrantId: 'management' }, management)).context;
const status = await service.getStatus();
const policy = { policyId: 'bili-round-policy', approved: true,
  audiences: [['bili', conversationKey, 'bili:9:actor:9']], processingGrants: [{ grantId: 'round-grant', providerRouteId: routeId }] };
assert.equal((await service.host.configurePolicy(await admin(), policy, status.revision, 'bili-round-policy')).ok, true);
const host = createMemoryHost({ memoryService: service, getCharacter: () => role, handleTtlMs: 300000,
  resolveIdentity: ({ channel, conversationKey: requested, purpose }) => ({ channel, conversationKey: requested, purpose,
    sourceAccountKey: 'bili:9:actor:9', requesterAccountKey: 'bili:9:actor:9', providerRouteId: routeId }) });
const adapter = host.createAdapter({ channel: 'bili', principal: { source: 'bili-round-memory-v2' }, canBindInput: true });

const input = { jobId: 'round-00000000-0000-4000-8000-000000000001', characterId: role.id, characterEpoch: role.epoch,
  score: { confirmed: true, score: 15, reason: '表达清楚', entry: { bv: 'BV1234567890', score: 15 } },
  review: { commentary: '这段讲解清楚。', dynamicText: '分享这段讲解。' }, material: { coverageComplete: true } };
const good = value => { assert.equal(value?.ok, true, JSON.stringify(value)); return value; };
const bad = (value, code) => { assert.equal(value?.ok, false, JSON.stringify(value)); assert.equal(value.code, code); assert.ok(value.error && value.hint); return value; };

try {
  const writer = createBiliRoundMemoryV2Writer({ adapter, scope: async () => ({ ok: true, conversationKey }), getCharacter: () => role });
  const operationId = writer.operationIdFor(input.jobId);

  // 能力/授权缺失：readiness 前置拒绝，写回不得调用模型/媒体。
  const noScope = createBiliRoundMemoryV2Writer({ adapter, scope: async () => ({ ok: false, code: 'BILI_V2_ROUND_SCOPE_UNAPPROVED', error: '未授权', hint: '先批准' }), getCharacter: () => role });
  bad(await noScope.write(input), 'BILI_V2_ROUND_SCOPE_UNAPPROVED');

  // 提交成功：真实 receipt 可查、completed、事件确实落库。
  const written = good(await writer.write(input));
  assert.equal(written.operationId, operationId);
  assert.equal(written.receipt.sourceState, 'committed');
  assert.equal(written.receipt.operationState, 'completed');
  assert.equal(written.receipt.eventRefs.length, 3);
  const queried = good(await writer.queryReceipt(operationId));
  assert.equal(queried.operationId, operationId);
  assert.equal(queried.sourceState, 'committed');

  // 进程内重复调用：同 operationId、不新建 ID、不重复写；真实库只有一次 receipt。
  const again = good(await writer.write(input));
  assert.equal(again.operationId, operationId);
  assert.equal(again.receipt.commitSequence, written.receipt.commitSequence);
  const dbStatus = good(await service.getStatus());
  assert.equal(dbStatus.characters.find(row => row.characterId === role.id).eventCount, 3);

  // 同 ID 换内容：冲突，不重放 ingest。
  bad(await writer.write({ ...input, score: { ...input.score, score: 20 } }), 'MEMORY_DIGEST_CONFLICT');

  // 提交未知：只查原 operationId；已提交事实承认，不重跑整轮/不重复评分。
  let failFirst = true;
  const uncertainAdapter = { ...adapter,
    ingest: async (handle, batch, id) => {
      // 真实提交已完成，但调用方只看到「提交未知」：必须靠原 operationId 查回执确认。
      const real = await adapter.ingest(handle, batch, id);
      return failFirst ? (failFirst = false, { ok: false, code: 'MEMORY_COMMIT_UNCERTAIN', error: '提交未确认', hint: '查原回执', operationId: id, retry: 'query_receipt' }) : real;
    } };
  const uncertainty = createBiliRoundMemoryV2Writer({ adapter: uncertainAdapter, scope: async () => ({ ok: true, conversationKey }), getCharacter: () => role });
  const uncertainJob = { ...input, jobId: 'round-00000000-0000-4000-8000-000000000002' };
  const uncertain = good(await uncertainty.write(uncertainJob));
  assert.equal(uncertain.operationId, uncertainty.operationIdFor(uncertainJob.jobId), '提交未知必须查原 ID，不新建');
  assert.equal(uncertain.receipt.sourceState, 'committed');

  // 角色切换：保留评分事实，不写进新角色。
  const stale = createBiliRoundMemoryV2Writer({ adapter, scope: async () => ({ ok: true, conversationKey }), getCharacter: () => ({ id: 'other', epoch: 9 }) });
  bad(await stale.write({ ...input, jobId: 'round-00000000-0000-4000-8000-000000000003' }), 'CHARACTER_EPOCH_STALE');

  console.log('PASS F05 Bili round writes score/review/material into real V2 with queryable receipt; unknown commit queries original operation only');
} finally {
  host.close();
  await service.close();
}
