// Actual HTTP transport -> Bili parent -> shared queue -> experience -> memory -> next context.
// The Bili acquisition and recognition executable are deterministic local fixtures; no account calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
const evidence = path.resolve('_backups', `perception-host-${Date.now()}-${process.pid}`);
process.env.DSH_HOME = path.join(evidence, 'dsh');
const chars = await import('../src/character-persona.js');
const { appendExperienceEvent } = await import('../src/core/experience.js');
const { buildCharacterContext } = await import('../src/core/context.js');
const { cardText, preparedMemoryView } = await import('./test-v2-context-fixture.mjs');
// V2-only（2026-11-12）：context.js 不再直接读记忆卡，测试要把卡片文本包成 Host 准备包。
const view = (channel, conversationKey = '') => {
  const text = cardText({ memoryJson: path.join(stateDir, 'characters', chars.readCurrentCharacter().id, 'memory', 'memory-card.json') }, { channel, conversationKey });
  return buildCharacterContext({ scene: channel, audience: { channel, conversationKey }, ...preparedMemoryView(text, { channel, conversationKey }) });
};
const { runMemoryCardMaintenance } = await import('../plugins/surfcore/lib/memory-card.js');
const { createPerceptionService } = await import('../src/perception/index.js');
const { createBiliPerceptionService } = await import('../plugins/surfcore/lib/bili-perception.js');
const { createPerceptionApiService } = await import('../plugins/surfcore/lib/perception-api.js');
const { PlatformRegistry } = await import('../plugins/surfcore/lib/platforms.js');
const { createPerceptionClient } = await import('../plugins/surfcore/tools/lib/perception-client.mjs');
const { resolveMediaRuntime } = await import('../plugins/surfcore/tools/lib/ffmpeg.mjs');
const media = resolveMediaRuntime(); assert.equal(media.ok, true, media.hint);
const created = chars.createCharacter({ id: 'fixture', name: 'Fixture', personaText: '我是隔离验收角色。' });
chars.switchCharacter(created.character.id);
const role = chars.readCurrentCharacter();
const stateDir = path.join(process.env.DSH_HOME, 'surfcore');
fs.mkdirSync(evidence, { recursive: true });
const wav = path.join(evidence, 'input.wav');
execFileSync(media.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-ar', '16000', '-ac', '1', wav]);
const model = path.join(evidence, 'model.bin'); fs.writeFileSync(model, 'fixture-model');
const executable = path.join(evidence, 'recognizer.cjs');
fs.writeFileSync(executable, `#!/usr/bin/env node\nconst fs=require('fs'),args=process.argv.slice(2); if(args.includes('--version')) console.log('1.9.5-dev'); else fs.writeFileSync(args[args.indexOf('-of')+1]+'.json', JSON.stringify({transcription:[{offsets:{from:0,to:900},text:'外部材料测试'}]}));\n`, { mode: 0o755 });
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const asr = createPerceptionService({ dataRoot: stateDir, engine: { provider: 'whisper.cpp', executable, backend: 'cpu', model: { id: 'fixture', path: model, sha256: hash(model) } }, ffmpegPath: media.ffmpegPath, ffprobePath: media.ffprobePath, getCharacter: chars.readCurrentCharacter });
const events = [];
const service = createBiliPerceptionService({ asrService: asr, stateDir, getCharacter: chars.readCurrentCharacter, pollMs: 10,
  createApi: () => ({ fetchView: async () => ({ bvid: 'BV1Ab4y1N7cD', title: '隔离媒体', aid: 1, owner: {}, pages: [{ page: 1, cid: 1, duration: 1 }, { page: 2, cid: 2, duration: 1 }] }), fetchPlayurl: async () => ({}) }),
  prepareMedia: async ({ dataRoot }) => { fs.mkdirSync(dataRoot, { recursive: true }); const file = path.join(dataRoot, 'p2.wav'); fs.copyFileSync(wav, file); return { audio: { path: file, status: 'completed', contentSha256: hash(file), durationMs: 1000, acquiredRanges: [{ startMs: 0, endMs: 1000 }], timelineMap: [{ localStartMs: 0, localEndMs: 1000, sourceStartMs: 0, sourceEndMs: 1000 }] } }; },
  onExperience: async (event) => { events.push(event.eventId); const saved = appendExperienceEvent(chars.characterPaths(event.characterId), event); if (!saved.ok) return saved; return runMemoryCardMaintenance({}); },
});
const channels = new PlatformRegistry();
let biliEnabled = false;
channels.setRuntime('bili', { status: async () => ({ state: biliEnabled ? 'ready' : 'disabled' }),
  observe: async (request, context) => ({ ok: true, ...await service.submitBili({ ...request, ...context }) }) });
let api;
const server = http.createServer((req, res) => api.handle(req, res, new URL(req.url, 'http://127.0.0.1')));
try {
  await service.ready;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  api = createPerceptionApiService({ service, stateDir, getCharacter: chars.readCurrentCharacter, currentDshUrl: () => baseUrl, observeBili: (request, context) => channels.observe('bili', request, context) }); api.writeHostFile();
  const client = createPerceptionClient({ stateDir });
  const bad = await fetch(baseUrl + api.prefix); assert.equal(bad.status, 403);
  const request = { bvid: 'BV1Ab4y1N7cD', page: 2, cid: '2', characterId: role.id, characterEpoch: role.epoch, activityId: crypto.randomUUID(), asr: true, frames: false, languageHint: 'zh' };
  await assert.rejects(client.submitBili(request), (error) => error.code === 'CHANNEL_DISABLED' && Boolean(error.hint));
  assert.equal((await service.listJobs()).length, 0, 'disabled channel must not start media or ASR');
  biliEnabled = true;
  const submitted = await client.submitBili(request);
  let job;
  for (let i = 0; i < 400; i++) { job = await client.getJob(submitted.jobId); if (job.memoryState === 'completed' || job.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.equal(job.state, 'completed', JSON.stringify(job)); assert.equal(job.memoryState, 'completed', JSON.stringify(job));
  assert.equal(job.part.cid, '2'); assert.equal(job.coverage.complete, true); assert.equal(job.history.status, 'recorded');
  assert.ok(job.result.segments.length); assert.equal(job.request, undefined);
  const context = view('bili');
  assert.match(context.memoryText, /BV1Ab4y1N7cD P2/); assert.match(context.memoryText, /外部材料/);
  const qq = view('qq', 'group:123');
  assert.doesNotMatch(qq.memoryText, /BV1Ab4y1N7cD P2/);
  await runMemoryCardMaintenance({}); assert.equal(events.length, 1);
  console.log(JSON.stringify({ ok: true, scope: 'isolated HTTP + deterministic provider', jobId: job.jobId, cid: job.part.cid, coverage: job.coverage, memoryState: job.memoryState, nextContext: true, qqPrivate: true, evidence }));
} finally { await channels.dispose(); await service.dispose(); await new Promise(resolve => server.close(resolve)); }
