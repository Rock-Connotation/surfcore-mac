import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDouyinCompanion } from '../lib/douyin-companion.mjs';

import { deriveMemoryProviderRouteId } from '../../../src/core/memory-v2-routing.js';
import { CONTEXT_FIELDS, SCHEMA_VERSION, digest as memoryDigest } from '../../../src/core/memory-v2-contract.js';
import { COMPANION_ROUTE } from '../lib/douyin-companion-model.mjs';

// R06：导入前必须隔离 DSH_HOME 并建立当前角色。
// 以前本夹具没有设置 DSH_HOME，`prepareCharacterContext` 会读真实 ~/.dsh，
// 于是命中 CHARACTER_EPOCH_STALE，整个作业卡在 perceive —— 这是夹具缺陷，不是生产链缺陷。
// F07：唯一根由 isolate-test-home 在任何业务 import 前验证；不再晚改 DSH_HOME。
const FIXTURE_HOME = testHome;
const chars = await import('../../../src/character-persona.js');
function establishRole(role) {
  const dir = path.join(chars.CHARACTERS_DIR, role.id);
  fs.mkdirSync(path.join(dir, 'persona.scenes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.md'), '# Fixture persona\n\n本夹具角色的人格核心。');
  fs.writeFileSync(path.join(dir, 'persona.scenes', 'douyin.md'), '抖音场景：简短回应。');
  fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ version: 1, id: role.id, epoch: role.epoch, name: role.id }));
}

// V2-only（2026-11-12）：抖音陪伴引擎无条件走 Host 适配器；本离线夹具没有真实
// 控制库，注入一个最小可信适配器，让引擎的逐步链路可测。真实 V2 语义由
// test-memory-v2-douyin.mjs 用真实 Host 覆盖。
function fixtureMemoryV2({ getCharacter, hooks = {}, records = [] }) {
  const routeId = deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId;
  // 回执必须满足持久账本的完整契约（R06）：缺 ok/operationId/acceptance/selectionState/
  // indexState/retry/nextOffset 会让对象在保存前就被判为 DOUYIN_STATE_INVALID，
  // 而 catch 里又用同一个非法对象重试保存，于是磁盘停在 running/perceive。
  const receiptOf = (handle, events, seq) => {
    const eventIds = events.map((_, i) => `${handle}:${seq}:${i}`);
    return {
      ok: true, operationId: `${handle}:op:${seq}`, phase: seq, acceptance: 'volatile',
      sourceState: 'committed', selectionState: 'not_selected', indexState: 'ready',
      operationState: 'completed', retry: 'none', commitSequence: seq, nextOffset: null,
      eventIds,
      eventRefs: eventIds.map(id => ({ type: 'event', id, revision: 1, payloadDigest: 'a'.repeat(64) })),
    };
  };
  let seq = 0;
  const handles = new Map();
  const adapter = {
    capture: async ({ conversationKey } = {}) => {
      const handle = `fixture-handle-${++seq}`;
      handles.set(handle, { conversationKey: conversationKey ?? 'douyin:homepage-recommendation', seq: 0 });
      return { ok: true, handle, sourceStamp: { ...baseContext(), conversationKey: handles.get(handle).conversationKey, providerRouteId: routeId } };
    },
    validate: async () => ({ ok: true }),
    receipt: async (handle) => ({ ok: true, ...receiptOf(handle, [{}, {}], handles.get(handle)?.seq || 1) }),
    ingest: async (handle, events) => {
      if (typeof hooks.ingest === 'function') { const held = hooks.ingest({ handle, events }); if (held) return held; }
      const entry = handles.get(handle) ?? { seq: 0 }; entry.seq += 1; handles.set(handle, entry);
      const receipt = receiptOf(handle, events, entry.seq);
      // 记录真实入库事件：断言从这里看「V2 reflection 已提交」，而不是旧 recordMemory 计数。
      records.push({ handle, events, receipt });
      return { ok: true, receipt, eventIds: receipt.eventIds, eventRefs: receipt.eventRefs, ...receipt };
    },
    prepare: async (handle, query) => {
      const stamp = baseContext();
      // 准备包必须带完整 CONTEXT_FIELDS（validatePrepared 逐字段比对），且 text ≤ 1800。
      const prepared = { ...stamp, schemaVersion: SCHEMA_VERSION, queryDigest: memoryDigest(query), expiresAt: Date.now() + 60_000,
        eventWatermark: 0, evidenceIds: [], inputManifest: [], text: `角色${stamp.characterId}的记忆。`, budget: { estimated: true } };
      return { ok: true, prepared, preparedHandle: `${handle}:prepared`, inputManifest: [] };
    },
    // 同步校验：生产要求 verifyPrepared 同步返回（异步会被判 MEMORY_PREPARED_UNTRUSTED）。
    verifyPrepared: () => ({ ok: true }),
    bindActualInput: async () => ({ ok: true }),
    withNetworkAdmission: async (handle, dispatch) => dispatch(),
    release: async () => ({ ok: true }),
  };
  function baseContext() {
    const role = getCharacter();
    const ctx = Object.fromEntries(CONTEXT_FIELDS.map(key => [key, key]));
    return { ...ctx, characterId: role.id, capturedEpoch: role.epoch, channel: 'douyin', conversationKey: 'douyin:homepage-recommendation', purpose: 'conversation', providerRouteId: routeId };
  }
  return { adapter, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: async () => ({ ok: true, retired: true }) };
}

const roots = [];
const makeRoot = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-companion-test-')); roots.push(root); return root; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const mediaSource = 'https://cdn.private.invalid/video.mp4?signature=PRIVATE_MEDIA_SECRET';
const frame = { atMs: 500, dataUrl: 'data:image/png;base64,YWJj' };
const output = (overrides = {}) => JSON.stringify({ feeling: 'like', reason: '节奏清楚，表达有意思。', summary: '一段轻松的经验分享。', draft: '这段讲法挺有意思。', ...overrides });
const sharingOutput = (overrides = {}) => output({ share: '这段把复杂的想法讲得很轻巧，我喜欢这个节奏。', question: '你觉得这种讲法适合什么场景？', ...overrides });
const recommendation = (id = 'video-1', durationMs = 1000) => ({
  id,
  url: `https://www.douyin.com/video/${id}?tracking=PRIVATE_MEDIA_SECRET`,
  title: `推荐 ${id}`,
  durationMs,
  mediaSource,
  mediaUserAgent: 'Mozilla/5.0 SurfCore-ephemeral-browser-UA',
});

function fixture(options = {}) {
  const stateDir = options.stateDir ?? makeRoot();
  const context = { characterId: 'role-a', characterEpoch: 1 };
  const role = options.role ?? { id: 'role-a', epoch: 1 };
  // R06：导入前建立当前角色（隔离 home），否则准备包会因真实 ~/.dsh 的角色不一致而失败。
  if (!options.skipRoleSetup) establishRole(role);
  const time = options.time ?? { value: new Date('2026-11-07T03:00:00.000Z') };
  const calls = { models: [], memory: [], memoryWrites: [], shares: [], perceived: [], ready: 0, feeds: 0, v2: [] };
  const api = createDouyinCompanion({
    stateDir,
    getCharacter: () => role,
    memoryV2: options.memoryV2 ?? fixtureMemoryV2({ getCharacter: () => role, hooks: options.hooks, records: calls.v2 }),
    now: () => time.value,
    callbackTimeoutMs: options.callbackTimeoutMs ?? 180_000,
    readiness: async () => { calls.ready++; return options.readiness ? options.readiness(calls) : { ok: true }; },
    readFeed: async ctx => {
      calls.feeds++;
      assert.equal(ctx.characterId, role.id);
      assert.equal(ctx.characterEpoch, role.epoch);
      if (options.readFeed) return options.readFeed(calls, ctx);
      return { ok: true, items: options.feedItems ?? [recommendation('video-1'), recommendation('video-2'), recommendation('video-3')] };
    },
    perceive: async (item, ctx, { signal, activityId }) => {
      calls.perceived.push({ item, ctx, activityId });
      if (options.perceiveFailureId === item.id) throw new Error('media processing failed');
      if (options.perceive) return options.perceive(item, ctx, { signal, activityId, calls });
      return {
        ok: true, id: item.id, url: item.url, title: item.title, durationMs: options.actualDurationMs ?? item.durationMs,
        observedAt: '2026-11-07T03:01:02.000Z', source: 'homepage-recommendation',
        transcript: {
          text: '这段视频分享了一个简单做法。',
          coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: options.actualDurationMs ?? item.durationMs }], processedRanges: [{ startMs: 0, endMs: options.actualDurationMs ?? item.durationMs }], missingRanges: [] },
          speechState: 'speech',
        },
        frames: [frame], visualCoverage: 'sparse', warnings: [],
      };
    },
    buildContext: async ctx => options.buildContext ? options.buildContext(ctx) : ({ ok: true, text: `角色${ctx.characterId}的记忆。` }),
    // 逐步模型请求元数据：引擎在 V2 路径要求可信同步回调（R06）。
    getModelRequest: ({ jobId, activityId, characterId, characterEpoch, providerRouteId, model }) => ({
      requestId: `${activityId}:model`, category: 'other', purpose: 'organize', jobId,
      role: characterId, epoch: characterEpoch, providerRouteId, model, estimatedTokens: 100,
    }),
    modelCall: async args => {
      calls.models.push(args);
      assert.equal(args.maxTokens, 8192);
      assert.equal(args.timeoutMs, 180_000);
      assert.ok(args.signal instanceof AbortSignal);
      assert.ok(args.images.length > 0 && args.images.length <= 3);
      assert.ok(args.system.includes('外部数据'));
      assert.ok(args.system.includes('绝不发送'));
      if (options.modelCall) return options.modelCall(args, calls);
      return { text: output(), usage: { inputTokens: 99, outputTokens: 22 }, finishReason: 'stop' };
    },
    recordMemory: async (ctx, value, { signal }) => {
      calls.memory.push({ ctx, value });
      if (options.recordMemory) return options.recordMemory(ctx, value, { signal }, calls);
      if (signal.aborted) throw new Error('aborted');
      calls.memoryWrites.push(value);
      return { ok: true };
    },
    recordSharing: options.recordSharing ? async (ctx, value, { signal }) => {
      calls.shares.push({ ctx, value, signal });
      return options.recordSharing(ctx, value, { signal }, calls);
    } : undefined,
  });
  return { api, stateDir, context, role, time, calls, options };
}

async function finish(api, context, jobId, tries = 500) {
  for (let i = 0; i < tries; i++) {
    const status = await api.status(context);
    const job = status.recentJobs?.find(item => item.jobId === jobId);
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await wait(5);
  }
  assert.fail(`job did not finish: ${jobId}`);
}
async function finishStored(stateDir, jobId, tries = 500) {
  const file = path.join(stateDir, 'douyin-companion', 'ledger.json');
  for (let i = 0; i < tries; i++) {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    const job = ledger.jobs[jobId];
    if (job && !['queued', 'running'].includes(job.state)) return job;
    await wait(5);
  }
  assert.fail(`stored job did not finish: ${jobId}`);
}
function assertIssue(value, code) {
  assert.equal(value?.ok, false);
  assert.equal(value.code, code);
  assert.ok(typeof value.error === 'string' && value.error.length, `${code} error missing`);
  assert.ok(typeof value.hint === 'string' && value.hint.length, `${code} hint missing`);
  return value;
}
async function startAndFinish(f, options) {
  const started = await f.api.start(f.context, options);
  if (started.ok === false) return started;
  return finish(f.api, f.context, started.jobId);
}
const scenario = process.argv[2];
if (scenario === 'leak') {
  const f = fixture({ feedItems: [recommendation()], readFeed: calls => calls.feeds === 1 ? { ok: true, items: [recommendation()] } : { ok: false, code: 'DOUYIN_FEED_FAILED', error: 'CANARY_ERROR', hint: 'CANARY_HINT' } });
  assert.equal((await startAndFinish(f)).acceptanceQualified, true);
  assert.equal((await f.api.configure(f.context, { enabled: true })).ok, true);
  f.time.value = new Date('2026-11-07T04:30:00.000Z');
  const started = await f.api.tick();
  await finish(f.api, f.context, started.jobId);
  const s = await f.api.status(f.context);
  console.log('leak:', JSON.stringify(s.daily));
  assert.doesNotMatch(JSON.stringify(s.daily), /CANARY_/);
  assert.equal(s.daily.lastError.code, 'DOUYIN_FEED_FAILED');
  assert.ok(s.daily.lastError.hint && s.daily.windows['12:30'].error.hint);
  await f.api.dispose();
} else if (scenario === 'receipt') {
  const f = fixture({ feedItems: [recommendation()], hooks: { ingest: ({ events }) => {
    const eventIds = events.map((_, i) => `bad:${i}`);
    return { ok: true, receipt: { ok: true, operationId: 'operation-original', acceptance: 'volatile', sourceState: 'committed', selectionState: 'not_selected', indexState: 'ready', operationState: 'completed', retry: 'none', commitSequence: 1, eventIds, eventRefs: eventIds.map(id => ({ type: 'event', id, revision: 1, payloadDigest: 'a'.repeat(64) })) } };
  } } });
  const started = await f.api.start(f.context);
  const job = await finish(f.api, f.context, started.jobId);
  const s = await f.api.status(f.context);
  const disk = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'douyin-companion', 'ledger.json'), 'utf8'));
  console.log('receipt:', JSON.stringify({ job, saveUncertain:s.saveUncertain, disk:disk.jobs[started.jobId] }));
  assert.equal(job.code, 'MEMORY_SOURCE_RECEIPT_INVALID');
  assert.ok(job.hint);
  assert.equal(s.saveUncertain, undefined);
  assert.equal(disk.jobs[started.jobId].state, 'failed');
  await f.api.dispose();
} else if (scenario === 'ownership') {
  let fail = false;
  const rename = fs.renameSync;
  const f = fixture({ feedItems: [recommendation()], modelCall: () => { fail = true; throw new Error('injected model failure'); } });
  fs.renameSync = function (...args) { if (fail && String(args[1]).endsWith('/douyin-companion/ledger.json')) throw Object.assign(new Error('injected'), {code:'EIO'}); return rename.apply(this,args); };
  const started = await f.api.start(f.context);
  const job = await finish(f.api, f.context, started.jobId);
  const s = await f.api.status(f.context);
  f.role.epoch = 2;
  const newerEpoch = await f.api.status({characterId:'role-a',characterEpoch:2});
  assert.equal(newerEpoch.saveUncertain, undefined);
  f.role.id = 'role-b'; f.role.epoch = 2;
  const other = await f.api.status({characterId:'role-b',characterEpoch:2});
  fs.renameSync = rename;
  console.log('ownership:', JSON.stringify({job, saveUncertain:s.saveUncertain, other}));
  assert.equal(s.saveUncertain.code, 'DOUYIN_CHAT_SAVE_UNCERTAIN');
  assert.ok(s.saveUncertain.hint);
  assert.equal(s.saveUncertain.operationId, f.calls.v2.at(-1).receipt.operationId);
  assert.ok(s.saveUncertain.operationId);
  assert.notEqual(job.code, 'DOUYIN_INTERRUPTED');
  assert.equal(other.saveUncertain, undefined);
  await f.api.dispose();
}

if (scenario === 'valid') {
  const f = fixture({ feedItems: [recommendation()] });
  const job = await startAndFinish(f);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'douyin-companion', 'ledger.json'), 'utf8'));
  const stored = ledger.jobs[job.jobId];
  const ids = f.calls.v2.map(x => x.receipt.operationId);
  assert.equal(stored.state, 'partial');
  assert.deepEqual(stored.memoryV2Receipts.map(x => x.operationId), ids);
  console.log('valid receipt operationIds preserved:', JSON.stringify(ids));
  await f.api.dispose();
}
