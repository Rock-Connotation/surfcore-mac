// V1 退役后（R10）：本夹具改为真实 V2 工厂（隔离 DSH_HOME + 正式授权 + 预置来源）。
// race/platform 测试的业务断言（跨进程幂等、平台边界 fsync）保持不变。
import { testHome } from './isolate-test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createCompanionSharing } from '../lib/companion-sharing.mjs';
import { createDouyinCompanionStore } from '../lib/douyin-companion-ledger.mjs';
import { createSharingV2Fixture } from './sharing-v2-fixture.mjs';

export const jobId = 'douyin-11111111-1111-4111-8111-111111111111';
export const context = { characterId: 'alpha', characterEpoch: 1 };
export const request = { openingId: `${jobId}:123456`, requestId: '22222222-2222-4222-8222-222222222222', text: '聊聊刚才的纸箱。' };
export async function fixture({ root = fs.realpathSync(fs.mkdtempSync(path.join(testHome, 'sharing-fixture-'))), seed = true } = {}) {
  const role = { id: 'alpha', epoch: 1 }, calls = [], now = () => new Date('2026-11-07T06:00:00Z');
  const v2 = await createSharingV2Fixture({ root, role });
  const ledger = createDouyinCompanionStore(v2.stateDir, () => now().toISOString());
  if (seed) ledger.writeLedger({ version: 1, acceptanceCalls: 8,
    roles: { '"alpha"': { characterId: 'alpha', acceptedEpoch: 1, enabled: true, paused: false, lastError: null, days: {} } },
    jobs: { [jobId]: { jobId, mode: 'acceptance', state: 'partial', phase: 'finished', characterId: 'alpha', characterEpoch: 1,
      createdAt: now().toISOString(), updatedAt: now().toISOString(), completedAt: now().toISOString(), calls: 2,
      acceptanceQualified: true, scheduleDate: null, scheduleWindow: null,
      items: [{ id: '123456', url: 'https://www.douyin.com/video/123456', title: '纸箱', durationMs: 17000,
        occurredAt: now().toISOString(), state: 'partial', memorySaved: true, partial: true,
        coverage: { status: 'partial', transcriptComplete: true, missingRanges: 0, visualCoverage: 'sparse', frameSamples: 3, warningCount: 0, acceptanceQualified: true },
        feeling: 'like', reason: '纸箱里的小窝。', summary: '猫钻进纸箱。', draft: '', ...v2.proof }] } } });
  const service = createCompanionSharing({ stateDir: v2.stateDir, getCharacter: () => role, now,
    readiness: async () => ({ ok: true }), buildContext: async () => ({ ok: true, text: '本机隔离夹具。' }),
    memoryV2: v2.memoryV2, getModelRequest: v2.getModelRequest,
    modelReply: async value => { calls.push(value); await value.beforeSend?.(); return { text: '本机模拟回复。', finishReason: 'stop' }; } });
  return { root, ledger, service, calls, v2 };
}
export const opening = f => f.service.record(context, { jobId, id: '123456', share: '这只猫把纸箱当成小窝啦。', question: '你觉得怎么样？' });
