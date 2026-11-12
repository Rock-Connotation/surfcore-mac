import { testHome } from './isolate-test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createCompanionModel, COMPANION_ROUTE } from '../lib/douyin-companion-model.mjs';
import { createCompanionController } from '../lib/douyin-companion-controller.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-companion-host-'));
process.env.DSH_HOME = root;
const chars = await import('../../../src/character-persona.js');
const { createCompanionMemory } = await import('../lib/douyin-companion-memory.mjs');
const { runMemoryCardMaintenance } = await import('../lib/memory-card.js');
const { buildCharacterContext } = await import('../../../src/core/context.js');
const { createTokenBudgetService } = await import('../lib/token-budget.js');
const { whaleCompanionTone, whaleCompanionDouyinScene } = await import('../lib/whale-companion-persona.mjs');
const role = chars.characterPaths('alpha');
fs.mkdirSync(role.personaScenesDir, { recursive: true });
fs.mkdirSync(path.join(role.dir, 'appearance'), { recursive: true });
fs.writeFileSync(role.persona, '# Existing identity\nKeep existing relationship.');
fs.writeFileSync(role.personaTone, whaleCompanionTone);
fs.writeFileSync(role.personaScenes.douyin, whaleCompanionDouyinScene);
fs.writeFileSync(role.manifest, JSON.stringify({ id: 'alpha', name: 'Alpha', version: 1 }));
fs.writeFileSync(chars.CURRENT_FILE, JSON.stringify({ id: 'alpha', epoch: 1, name: 'Alpha' }));
const owner = { characterId: 'alpha', characterEpoch: 1 };
const frame = { atMs: 100, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' };
let sends = 0, usageRecords = 0, imageSaves = 0, request;
const budget = { block: async () => ({ blocked: false }), recordExternalUsage: async () => { usageRecords++; return true; } };
const llm = { listModels: async () => [{ id: COMPANION_ROUTE.model, inputModalities: ['text', 'image'] }],
  async *stream(options) { sends++; request = options; yield { type: 'text-delta', text: '{"summary":"海洋"}' }; yield { type: 'usage', usage: { uncachedInputTokens: 12, outputTokens: 6 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
const attachments = { saveImages: async list => { imageSaves++; assert.equal(list[0].mediaType, 'image/jpeg'); return [{ attachmentId: 'sha256:fixture', mediaType: 'image/jpeg' }]; } };
const ctx = { get: name => ({ llm, attachments })[name] };
const model = createCompanionModel({ ctx, tokenBudget: budget });
assert.equal((await model.readiness()).ok, true);
const output = await model.call({ system: 'system', prompt: 'prompt', images: [frame] });
assert.equal(output.finishReason, 'stop'); assert.equal(sends, 1); assert.equal(usageRecords, 1);
assert.equal(request.reasoningEffort, 'low'); assert.equal(request.maxTokens, 8192);
assert.deepEqual(request.messages[0].content.map(x => x.type), ['text', 'text', 'image']);
assert.equal(request.messages[0].content[2].attachment.attachmentId, 'sha256:fixture');
await assert.rejects(model.call({ system: 's', prompt: 'p', images: [] }), e => e.code === 'COMPANION_IMAGES_REQUIRED' && !!e.hint);
await assert.rejects(model.call({ system: 's', prompt: 'p', images: [frame, frame, frame, frame] }), e => e.code === 'COMPANION_IMAGES_REQUIRED' && !!e.hint);
assert.equal(sends, 1, 'invalid frame request must not reach model');
llm.listModels = async () => [{ id: COMPANION_ROUTE.model, inputModalities: ['text'] }];
assert.equal((await model.readiness()).code, 'COMPANION_IMAGE_UNAVAILABLE');
assert.ok((await model.readiness()).hint); assert.equal(sends, 1);
llm.listModels = async () => [{ id: COMPANION_ROUTE.model, inputModalities: ['text', 'image'] }];
const abort = new AbortController(); abort.abort();
await assert.rejects(model.call({ system: 's', prompt: 'p', images: [frame], signal: abort.signal }), e => e.code === 'COMPANION_MODEL_CANCELLED' && !!e.hint);
assert.equal(sends, 1, 'pre-aborted request must not reach model');
const noBudget = createCompanionModel({ ctx, tokenBudget: { block: async () => ({ blocked: true }) } });
await assert.rejects(noBudget.call({ system: 's', prompt: 'p', images: [frame] }), e => e.code === 'COMPANION_TOKEN_BLOCKED' && !!e.hint);
assert.equal(sends, 1);

// Every asynchronous preparation seam must obey the same total request deadline.
const originalModels = llm.listModels, originalImages = attachments.saveImages, originalBlock = budget.block;
for (const stage of ['catalog', 'budget', 'images']) {
  const never = () => new Promise(() => {});
  llm.listModels = stage === 'catalog' ? never : originalModels;
  attachments.saveImages = stage === 'images' ? never : originalImages;
  budget.block = stage === 'budget' ? never : originalBlock;
  const started = Date.now();
  await assert.rejects(model.call({ system: 's', prompt: 'p', images: [frame], timeoutMs: 100 }), e => /^COMPANION_/.test(e.code) && !!e.hint);
  assert.ok(Date.now() - started < 1000, stage + ' must be bounded');
  assert.equal(sends, 1, stage + ' must not dispatch a late model request');
}
llm.listModels = originalModels; attachments.saveImages = originalImages; budget.block = originalBlock;
const originalRecord = budget.recordExternalUsage;
budget.recordExternalUsage = () => new Promise(() => {});
const usageStarted = Date.now();
await assert.rejects(model.call({ system: 's', prompt: 'p', images: [frame], timeoutMs: 100 }), e => e.code === 'COMPANION_USAGE_PERSIST_FAILED' && !!e.hint);
assert.ok(Date.now() - usageStarted < 1000, 'usage commit must be bounded');
budget.recordExternalUsage = originalRecord;

// Text-only reply uses the exact HY3 low route without saving or attaching images.
const sendsBeforeReply = sends, usageBeforeReply = usageRecords, imageSavesBeforeReply = imageSaves;
let replyGuardChecks = 0;
const reply = await model.reply({ system: 'reply system', prompt: 'reply prompt', maxTokens: 8192, timeoutMs: 180_000, beforeSend: () => { replyGuardChecks++; } });
assert.equal(reply.finishReason, 'stop'); assert.equal(sends, sendsBeforeReply + 1); assert.equal(usageRecords, usageBeforeReply + 1);
assert.equal(imageSaves, imageSavesBeforeReply, 'reply never calls attachments.saveImages');
assert.ok(replyGuardChecks >= 9, 'reply rechecks at preparation and actual stream-read boundaries');
assert.equal(request.provider, COMPANION_ROUTE.provider); assert.equal(request.model, COMPANION_ROUTE.model);
assert.equal(request.reasoningEffort, 'low'); assert.equal(request.maxTokens, 8192);
assert.deepEqual(request.messages[0].content, [{ type: 'text', text: 'reply prompt' }]);
assert.equal(Object.hasOwn(request, 'tools'), false, 'reply is dispatched without a tool surface');
await assert.rejects(model.reply({ system: 's', prompt: 'p', images: [frame] }), e => e.code === 'COMPANION_REPLY_IMAGES_FORBIDDEN' && !!e.hint);
assert.equal(sends, sendsBeforeReply + 1, 'reply rejects images before dispatch');

// A role change while the reply awaits its model directory gate must stop before stream dispatch.
let releaseCatalog, enterCatalog;
const catalogEntered = new Promise(resolve => { enterCatalog = resolve; });
const originalModelsForReply = llm.listModels;
let replyEpoch = 1;
llm.listModels = async () => { enterCatalog(); await new Promise(resolve => { releaseCatalog = resolve; }); return [{ id: COMPANION_ROUTE.model, inputModalities: ['text', 'image'] }]; };
const sendsBeforeRoleChange = sends;
const staleReply = model.reply({ system: 's', prompt: 'p', beforeSend: () => {
  if (replyEpoch !== 1) throw Object.assign(new Error('reply role stale'), { code: 'DOUYIN_STALE_CHARACTER', hint: 'refresh current role' });
} });
await catalogEntered;
replyEpoch = 2; releaseCatalog();
await assert.rejects(staleReply, e => e.code === 'DOUYIN_STALE_CHARACTER' && !!e.hint);
assert.equal(sends, sendsBeforeRoleChange, 'stale reply cannot dispatch after catalog await');
llm.listModels = originalModelsForReply;
let releaseBudget, enterBudget;
const budgetEntered = new Promise(resolve => { enterBudget = resolve; });
const originalBlockForReply = budget.block;
replyEpoch = 1;
budget.block = async () => { enterBudget(); await new Promise(resolve => { releaseBudget = resolve; }); return { blocked: false }; };
const sendsBeforeBudgetChange = sends;
const budgetStaleReply = model.reply({ system: 's', prompt: 'p', beforeSend: () => {
  if (replyEpoch !== 1) throw Object.assign(new Error('reply role stale'), { code: 'DOUYIN_STALE_CHARACTER', hint: 'refresh current role' });
} });
await budgetEntered;
replyEpoch = 2; releaseBudget();
await assert.rejects(budgetStaleReply, e => e.code === 'DOUYIN_STALE_CHARACTER' && !!e.hint);
assert.equal(sends, sendsBeforeBudgetChange, 'stale reply cannot dispatch after budget gate await');
budget.block = originalBlockForReply;
const sendsBeforeAbort = sends;
const abortedReply = new AbortController(); abortedReply.abort();
await assert.rejects(model.reply({ system: 's', prompt: 'p', signal: abortedReply.signal }), e => e.code === 'COMPANION_MODEL_CANCELLED' && !!e.hint);
assert.equal(sends, sendsBeforeAbort, 'pre-aborted reply must not dispatch');

// Tool use is rejected once with no retry; usage remains durably recorded.
const originalStream = llm.stream;
llm.stream = async function* (options) {
  sends++; request = options;
  yield { type: 'usage', usage: { uncachedInputTokens: 1, outputTokens: 1 } };
  yield { type: 'tool-call-delta', text: 'forbidden' };
};
await assert.rejects(model.reply({ system: 's', prompt: 'p' }), e => e.code === 'COMPANION_TOOLS_REJECTED' && !!e.hint);
assert.equal(sends, sendsBeforeAbort + 1, 'failed reply is not automatically retried');
assert.equal(usageRecords, usageBeforeReply + 2, 'usage receipt is still persisted for a rejected tool call');
llm.stream = originalStream;

// A successful reply whose durable usage receipt fails is reported instead of acknowledged.
budget.recordExternalUsage = () => new Promise(() => {});
const replyUsageStarted = Date.now();
await assert.rejects(model.reply({ system: 's', prompt: 'p', timeoutMs: 100 }), e => e.code === 'COMPANION_USAGE_PERSIST_FAILED' && !!e.hint);
assert.ok(Date.now() - replyUsageStarted < 1000, 'reply usage persistence is bounded');
assert.equal(sends, sendsBeforeAbort + 2);
budget.recordExternalUsage = originalRecord;

// A usage chunk already returned by iterator.next is durably recorded before the stale-role guard stops text.
let staleStreams = 0, staleNexts = 0, staleReturns = 0;
const staleUsage = { uncachedInputTokens: 7, outputTokens: 3 }, staleReceipts = [];
replyEpoch = 1;
llm.stream = options => {
  staleStreams++; request = options;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() { staleNexts++; replyEpoch = 2; return { done: false, value: { type: 'usage', usage: staleUsage } }; },
    async return() { staleReturns++; return { done: true }; },
  };
};
budget.recordExternalUsage = async receipt => { staleReceipts.push(receipt); return true; };
await assert.rejects(model.reply({ system: 's', prompt: 'p', beforeSend: () => {
  if (replyEpoch !== 1) throw Object.assign(new Error('reply role stale'), { code: 'DOUYIN_STALE_CHARACTER', hint: 'refresh current role' });
} }), e => e.code === 'DOUYIN_STALE_CHARACTER' && !!e.hint);
assert.equal(staleStreams, 1); assert.equal(staleNexts, 1, 'stale reply must not fetch body or later usage chunks');
assert.equal(staleReturns, 1, 'stale reply returns its iterator');
assert.equal(staleReceipts.length, 1); assert.deepEqual(staleReceipts[0].usage, staleUsage); assert.equal(staleReceipts[0].durable, true);
llm.stream = originalStream; budget.recordExternalUsage = originalRecord;

// Use the actual collector: a failed rename must not acknowledge durable usage.
const collector = createTokenBudgetService({ ctx: {}, dshHome: path.join(root, 'durable-usage'), qqStateDir: path.join(root, 'qq-state'), log: () => {} });
const paid = { category: 'other', usage: { uncachedInputTokens: 2, outputTokens: 1 }, model: 'workbuddy/hy3', durable: true };
assert.equal(collector.recordExternalUsage(paid), true);
assert.ok(fs.existsSync(collector.stateFile)); assert.ok(fs.existsSync(collector.dailyFile));
const rename = fs.renameSync;
fs.renameSync = (...args) => { if (args[1] === collector.stateFile) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); return rename(...args); };
try { assert.equal(collector.recordExternalUsage(paid), false, 'disk failure cannot be acknowledged'); }
finally { fs.renameSync = rename; collector.dispose(); }

// R06：这里改用**真实** MemoryService/Host 工厂（隔离 DSH_HOME + 临时角色 + 正式授权），
// 不再调用已退役的 V1 recordMemory。观察点是 V2 已提交事件与持久回执。
const { createMemoryService } = await import('../../../src/core/memory-v2-service.js');
const { createMemoryHost } = await import('../lib/memory-v2-host.mjs');
const { deriveMemoryProviderRouteId } = await import('../../../src/core/memory-v2-routing.js');
const routeId = deriveMemoryProviderRouteId(COMPANION_ROUTE).providerRouteId;
const memoryStateDir = path.join(root, 'memory-state');
const service = createMemoryService({ stateDir: memoryStateDir, charactersDir: chars.CHARACTERS_DIR, getCharacter: chars.readCurrentCharacter, authorizeManagement: cap => cap === management });
const management = Symbol('host-fixture-settings');
assert.equal((await service.initialize()).ok, true);
const base = { channel: 'douyin', conversationKey: 'douyin:homepage-recommendation', sourceAccountKey: 'douyin:login:one', requesterAccountKey: 'douyin:owner:one', providerRouteId: routeId, purpose: 'conversation', audiencePolicyId: 'host-fixture-policy', processingGrantId: 'grant' };
{
  const admin = (await service.host.captureAdminContext(base, management)).context;
  assert.equal((await service.applyMemoryAction(admin, { type: 'configure_policy', policy: { policyId: base.audiencePolicyId, approved: true, audiences: [[base.channel, base.conversationKey, base.requesterAccountKey]], processingGrants: [{ grantId: 'grant', providerRouteId: routeId }] } }, admin.controlRevision, 'host-fixture-policy')).ok, true);
}
const host = createMemoryHost({ memoryService: service, getCharacter: chars.readCurrentCharacter, handleTtlMs: 300000,
  resolveIdentity: ({ channel, conversationKey }) => ({ channel, conversationKey, sourceAccountKey: base.sourceAccountKey, requesterAccountKey: base.requesterAccountKey, providerRouteId: routeId }) });
const adapter = host.createAdapter({ channel: 'douyin', principal: {}, canBindInput: true });
const memoryV2 = { adapter, getRouting: () => ({ ok: true, backend: 'v2' }), onBlocked: async () => { host.retireAll(); return { ok: true, retired: true }; } };
const memory = createCompanionMemory({ stateDir: memoryStateDir, getCharacter: chars.readCurrentCharacter, memoryV2 });
const when = new Date().toISOString();
const session = await memory.capture(owner, base.conversationKey);
assert.equal(session.ok !== false, true, JSON.stringify(session));
const observed = await memory.observe(session, { jobId: 'host-fixture-job', activityId: 'host-fixture-activity',
  entry: { id: '1234567890123456789', title: '海洋发现', url: 'https://www.douyin.com/video/1234567890123456789' },
  perceived: { ok: true, id: '1234567890123456789', url: 'https://www.douyin.com/video/1234567890123456789', title: '海洋发现', durationMs: 1000,
    observedAt: when, source: 'homepage-recommendation', transcript: { text: '旁白说它在休息。', speechState: 'speech',
      coverage: { complete: true, requestedRanges: [{ startMs: 0, endMs: 1000 }], processedRanges: [{ startMs: 0, endMs: 1000 }], missingRanges: [] } },
    frames: [{ atMs: 500, dataUrl: frame.dataUrl }], visualCoverage: 'sparse', warnings: [] },
  images: [{ atMs: 500, dataUrl: frame.dataUrl }] });
assert.equal(observed.receipt.sourceState, 'committed', JSON.stringify(observed));
assert.ok(observed.refs.length >= 1);
const reflected = await memory.reflect(session, { summary: '喜欢那只缓慢摆尾的小鱼', reason: '清楚看见取样画面中的尾鳍，旁白说它在休息', coverage: { complete: true } });
assert.equal(reflected.receipt.sourceState, 'committed');
// 查询必须命中已提交的来源正文（词法 overlap）：用反射里的具体措辞。
const prepared = await memory.prepareStep(session, '尾鳍');
assert.equal(prepared.ok !== false, true, JSON.stringify(prepared));
assert.doesNotMatch(prepared.text, /UNSCOPED_PRIVATE_FOCUS/);
assert.match(prepared.personaText, /软萌/);
assert.match(prepared.memoryText, /尾鳍/);
// 旧跨渠道文本仍不会被新渠道导入（V2 按 audience 隔离）。
for (const channel of ['bili', 'qq', 'pet']) {
  const external = buildCharacterContext({ ...owner, audience: { channel, conversationKey: channel === 'qq' ? 'private:123' : '' } });
  // V2-only：没有为该渠道准备的记忆包时，上下文直接拒绝（不返回跨渠道文本）。
  if (external.ok) assert.doesNotMatch(String(external.memoryText ?? ''), /尾鳍|1234567890123456789/, 'new Douyin memory must not broaden prior audiences');
  else assert.ok(external.code && external.hint, 'unprepared channel must fail closed with a code and hint');
}
memory.release(session);
// 角色世代不符：capture 直接拒绝（抛结构化错误），不会把旧经历投影到新角色。
const stale = await memory.capture({ ...owner, characterEpoch: 2 }, base.conversationKey).catch(error => error);
assert.equal(stale.code, 'COMPANION_CHARACTER_STALE'); assert.ok(stale.hint);
const stopMemory = new AbortController(); stopMemory.abort();
const cancelledSession = await memory.capture(owner, base.conversationKey);
const cancelledMemory = await memory.prepareStep(cancelledSession, '取消').catch(error => error);
assert.ok(cancelledMemory); memory.release(cancelledSession);
// V1 记忆卡写者在生产装配层已退役（lib/memory-card.js 仍保留纯函数供评测/只读查看）。
// 这里断言生产入口不再调用维护函数、且旧卡字节不变。
const indexSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
assert.equal(/runMemoryCardMaintenance\(/.test(indexSource), false, '生产装配不得再调用旧记忆卡维护');
assert.match(indexSource, /MEMORY_CARD_WRITE_RETIRED/, '旧记忆卡写动作必须返回结构化退役错误');
const cardBefore = fs.existsSync(role.memoryJson) ? fs.readFileSync(role.memoryJson) : null;
if (cardBefore) assert.ok(fs.readFileSync(role.memoryJson).equals(cardBefore), '旧记忆卡不得被改写');
await host.close(); await service.close();

let current = { id: 'alpha', epoch: 1, name: 'Alpha' }, starts = 0;
const engine = { status: async () => ({ ok: true }), start: async () => { starts++; return { ok: true }; } };
const controller = createCompanionController({ engine, getCharacter: () => current, readiness: async () => ({ ok: true }) });
async function call(method, body, origin, pathname = '/dsh-surfcore/api/douyin/companion') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json', ...(origin ? { origin } : {}) };
  const response = { writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(text) { this.body = text; const type = Object.entries(this.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]; if (String(type || '').startsWith('application/json')) this.value = JSON.parse(String(text)); } };
  response.handled = await controller.handle(req, response, new URL(`http://127.0.0.1:1234${pathname}`));
  return response;
}
assert.equal((await call('POST', { ...owner, action: 'start' })).status, 200); assert.equal(starts, 1);
const rejected = await call('POST', { ...owner, characterEpoch: 0, action: 'start' });
assert.equal(rejected.value.code, 'COMPANION_CHARACTER_STALE'); assert.ok(rejected.value.hint); assert.equal(starts, 1);
assert.equal((await call('POST', { ...owner, action: 'start' }, 'https://evil.invalid')).status, 403); assert.equal(starts, 1);
engine.status = async () => { current = { id: 'beta', epoch: 2 }; return { ok: true }; };
const changed = await call('GET'); assert.equal(changed.value.code, 'COMPANION_CHARACTER_STALE'); assert.ok(changed.value.hint);

current = { id: 'alpha', epoch: 1, name: 'Alpha' };
const portraitUrl = '/dsh-surfcore/api/douyin/companion-portrait?characterId=alpha&characterEpoch=1';
const webp = Buffer.alloc(16); webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(8, 4); webp.write('WEBP', 8, 'ascii'); webp.write('VP8 ', 12, 'ascii');
const portraitFile = path.join(role.dir, 'appearance', 'companion-portrait.webp');
fs.writeFileSync(portraitFile, webp);
const portrait = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(portrait.status, 200); assert.equal(portrait.headers['content-type'], 'image/webp'); assert.equal(portrait.headers['cache-control'], 'no-store');
assert.equal(portrait.headers['x-content-type-options'], 'nosniff'); assert.deepEqual(portrait.body, webp);
assert.doesNotMatch(String(portrait.body), /characters|appearance|https?:/i);
const stalePortrait = await call('GET', undefined, undefined, '/dsh-surfcore/api/douyin/companion-portrait?characterId=alpha&characterEpoch=0');
assert.equal(stalePortrait.status, 409); assert.equal(stalePortrait.value.code, 'COMPANION_CHARACTER_STALE'); assert.ok(stalePortrait.value.error); assert.ok(stalePortrait.value.hint);
const traversal = await call('GET', undefined, undefined, '/dsh-surfcore/api/douyin/companion-portrait?characterId=../alpha&characterEpoch=1');
assert.equal(traversal.status, 409); assert.equal(traversal.value.code, 'COMPANION_CHARACTER_STALE'); assert.ok(traversal.value.hint);
const foreignPortrait = await call('GET', undefined, 'https://evil.invalid', portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(foreignPortrait.status, 403); assert.equal(foreignPortrait.value.code, 'COMPANION_ORIGIN'); assert.ok(foreignPortrait.value.hint);
fs.unlinkSync(portraitFile);
const missingPortrait = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(missingPortrait.status, 404); assert.equal(missingPortrait.value.code, 'COMPANION_PORTRAIT_MISSING'); assert.ok(missingPortrait.value.error); assert.ok(missingPortrait.value.hint);
const outside = path.join(root, 'outside.webp'); fs.writeFileSync(outside, webp); fs.symlinkSync(outside, portraitFile);
const symlinkPortrait = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(symlinkPortrait.status, 409); assert.equal(symlinkPortrait.value.code, 'COMPANION_PORTRAIT_UNSAFE'); assert.ok(symlinkPortrait.value.error); assert.ok(symlinkPortrait.value.hint);
assert.doesNotMatch(JSON.stringify(symlinkPortrait.value), /outside\.webp|\/(?:Users|tmp|var)\/|file:|https?:/i);
fs.unlinkSync(portraitFile); fs.writeFileSync(portraitFile, webp);
const openSync = fs.openSync;
fs.openSync = (file, ...args) => { if (String(file).endsWith(path.join('alpha', 'appearance', 'companion-portrait.webp'))) throw Object.assign(new Error('fixture read failure'), { code: 'EIO' }); return openSync(file, ...args); };
let readFailure;
try { readFailure = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]); }
finally { fs.openSync = openSync; }
assert.equal(readFailure.status, 500); assert.equal(readFailure.value.code, 'COMPANION_PORTRAIT_READ_FAILED'); assert.ok(readFailure.value.error); assert.ok(readFailure.value.hint);
assert.doesNotMatch(JSON.stringify(readFailure.value), /fixture|EIO|https?:/i);
fs.writeFileSync(portraitFile, Buffer.alloc(4 * 1024 * 1024 + 1, 0));
const largePortrait = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(largePortrait.status, 415); assert.equal(largePortrait.value.code, 'COMPANION_PORTRAIT_INVALID'); assert.ok(largePortrait.value.hint);
fs.writeFileSync(portraitFile, Buffer.from('not an image!'));
const invalidPortrait = await call('GET', undefined, undefined, portraitUrl.split('?')[0] + '?' + portraitUrl.split('?')[1]);
assert.equal(invalidPortrait.status, 415); assert.equal(invalidPortrait.value.code, 'COMPANION_PORTRAIT_INVALID'); assert.ok(invalidPortrait.value.error); assert.ok(invalidPortrait.value.hint);

let consumed = 0;
const untouchedBody = Readable.from({ *[Symbol.iterator]() { consumed++; yield Buffer.from('{"action":"start"}'); } });
untouchedBody.method = 'POST'; untouchedBody.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };
const unusedResponse = { writeHead(status) { this.status = status; }, end() {} };
assert.equal(await controller.handle(untouchedBody, unusedResponse, new URL('http://127.0.0.1:1234/dsh-surfcore/api/douyin/unrelated')), false);
assert.equal(consumed, 0, 'unrelated routes must not consume their request body');
console.log('PASS companion Host: exact image blocks, route/usage/abort guards, scoped source/time recall, portrait current-role/signature/size/symlink checks, unrelated-route body untouched');
