// 本机伙伴对话的 V2 测试工厂（2026-11-12 V1 退役 R10）。
//
// 旧的 sharing/race/platform 测试用 V1 路径验证「持久化、幂等、预算、取消、跨实例锁」。
// 这些是**业务行为**，不能因为 V1 退役就删掉；但也不能再走已删除的 v1 perform 分支。
// 这里提供一个真实 MemoryService/Host 的隔离工厂，让同一批行为断言跑在 V2 上：
//   · 隔离 DSH_HOME 与角色目录（导入前设置，绝不读真实 ~/.dsh）；
//   · 正式 preview/commit 批准 local 会话（不直接改 SQLite）；
//   · 预置一条真实的来源事件，返回可绑定的 refs/receipts 供账本使用。
//
// 只用于测试；不联网、不调模型、不写用户数据。
import { testHome } from './isolate-test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {{ root?: string, role?: {id:string, epoch:number}, conversationKey?: string }} input
 */
export async function createSharingV2Fixture({ root, role = { id: 'alpha', epoch: 1 }, conversationKey } = {}) {
  // 复用 isolate-test-home 已隔离的 home 根，避免再次指向真实目录。
  // 传入 root 时**复用同一个目录**（跨进程 race 测试需要两个进程看到同一份控制库/账本）；
  // 只有未传 root 时才新建。
  const home = root
    ? (fs.existsSync(root) ? fs.realpathSync(root) : (fs.mkdirSync(root, { recursive: true, mode: 0o700 }), fs.realpathSync(root)))
    : fs.realpathSync(fs.mkdtempSync(path.join(testHome, 'sharing-v2-')));
  process.env.DSH_HOME = home;
  const chars = await import('../../../src/character-persona.js');
  // 生产装配里 sharing 的 stateDir 就是 STATE_DIR（= home/surfcore），角色也住在同一
  // 棵树下（characters/<id>）。这里保持同构：stateDir 一律取 home/surfcore，
  // 这样 createSharingStore 与 MemoryService 看到的是同一份角色目录。
  const stateDir = path.join(home, 'surfcore');
  const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
  const { COMPANION_ROUTE } = await import('../lib/douyin-companion-model.mjs');
  const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
  const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');

  const dir = path.join(chars.CHARACTERS_DIR, role.id);
  fs.mkdirSync(path.join(dir, 'persona.scenes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.md'), '# Alpha\n温柔、有主见的小白鲸。');
  fs.writeFileSync(path.join(dir, 'persona.scenes', 'local.md'), '本机伙伴场景：自然简短。');
  fs.mkdirSync(path.dirname(chars.CURRENT_FILE), { recursive: true });
  fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ version: 1, ...role }));
  const getCharacter = () => role;

  const routeId = deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId;
  const key = conversationKey ?? `local:companion-sharing:${role.id}`;
  const management = Symbol('sharing-v2-fixture');
  const service = createMemoryService({ stateDir, charactersDir: chars.CHARACTERS_DIR, getCharacter, authorizeManagement: value => value === management });
  const init = await service.initialize();
  if (init?.ok !== true) throw new Error(`fixture memory init failed: ${JSON.stringify(init)}`);

  const facts = { channel: 'local', conversationKey: key, sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', providerRouteId: routeId, purpose: 'conversation' };
  const admin = async () => (await service.host.captureAdminContext({ ...facts, audiencePolicyId: 'management', processingGrantId: 'management' }, management)).context;
  // operationId 每次唯一：同一隔离根被第二个进程复用时（跨进程 race 测试），
  // 旧的 'fixture:policy' 已绑定第一次的请求摘要，会报 MEMORY_DIGEST_CONFLICT。
  const status = await service.getStatus();
  const configured = await service.host.configurePolicy(await admin(), {
    policyId: 'sharing-fixture-policy', approved: true,
    audiences: [['local', key, 'local:owner']],
    processingGrants: [{ grantId: 'local-grant', providerRouteId: routeId }],
  }, status.revision, `fixture:policy:${process.pid}:${Date.now()}`);
  if (configured?.ok !== true) throw new Error(`fixture policy failed: ${JSON.stringify(configured)}`);

  const host = createMemoryHost({ memoryService: service, getCharacter, handleTtlMs: 300000,
    resolveIdentity: ({ channel, conversationKey: requested, purpose }) => ({ channel, conversationKey: requested, purpose,
      sourceAccountKey: 'local:owner', requesterAccountKey: 'local:owner', providerRouteId: routeId }) });
  const adapter = host.createAdapter({ channel: 'local', principal: { source: 'sharing-v2-fixture' }, canBindInput: true });

  // 预置一条真实来源（openings 必须能通过 provenance 校验）。
  const captured = await adapter.capture({ conversationKey: key });
  if (captured?.ok !== true) throw new Error(`fixture capture failed: ${JSON.stringify(captured)}`);
  const receipt = await adapter.ingest(captured.handle, [{ eventId: 'fixture:opening', operationId: 'fixture:opening-source',
    sourceKey: 'fixture:opening', producerId: 'sharing-fixture', segmentId: 'fixture:segment', producerSeq: 1,
    content: '猫钻进纸箱，只有三帧稀疏取样。', certainty: 'observed', attribution: 'action' }], 'fixture:opening-ingest');
  if (receipt?.ok !== true) throw new Error(`fixture ingest failed: ${JSON.stringify(receipt)}`);
  adapter.release(captured.handle);
  // 持久账本（douyin-companion-ledger）的 receipt 契约要求 phase 字段；
  // adapter 直接返回的是内核回执，补上 phase 后才可入库。
  const proof = { memoryV2Refs: receipt.eventRefs, memoryV2Receipts: [{ ...receipt, phase: 'source' }] };

  const memoryV2 = {
    adapter,
    getRouting: () => ({ ok: true, backend: 'v2' }),
    onBlocked: async () => { host.retireAll(); return { ok: true, retired: true }; },
  };
  const getModelRequest = ({ jobId, activityId, characterId, characterEpoch, providerRouteId, model }) => ({
    requestId: jobId, jobId, category: 'other', purpose: 'conversation',
    role: characterId, epoch: characterEpoch, providerRouteId, model, estimatedTokens: 1000,
  });

  return {
    home, stateDir, key, routeId, service, host, adapter, memoryV2, getModelRequest, proof,
    async close() { host.close(); await service.close(); },
  };
}
