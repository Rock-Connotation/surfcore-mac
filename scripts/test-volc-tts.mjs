import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synthesizeToFile } from '../src/voice-tts.js';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volc-test-'));
const key = 'offline-fixture-key';
const wav = Buffer.alloc(48);
wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
const frame = JSON.stringify({ code: 0, message: '中文 } \\"', data: wav.toString('base64') });
const terminal = JSON.stringify({ code: 20000000, message: 'ok', data: null });
function mock(chunks, status = 200) {
  return async (url, options) => {
    assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Api-Key'], key);
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
    const body = JSON.parse(options.body);
    assert.equal(body.req_params.speaker, 'zh_female_xiaohe_uranus_bigtts');
    assert.equal(body.req_params.text, '你好');
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    } }), { status });
  };
}
const options = { text: '你好', apiKey: key, provider: 'volc', outDir,
  get budget() {
    const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volc-budget-')), 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ socialV2: { voice: { tts: { enabled: true, route: 'cloud', cloudProvider: 'volc', volcKeyId: 'fixture-id' } } } }));
    return { configFile, keyId: 'fixture-id' };
  } };

test('跨任意字节分片和多个JSON对象合成音频', async () => {
  const bytes = Buffer.from(frame + '\n' + terminal);
  const result = await synthesizeToFile({ ...options, fetchImpl: mock([...bytes].map(b => Uint8Array.of(b))) });
  assert.deepEqual(fs.readFileSync(result.path), wav);
  assert.equal(result.cached, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
});

test('音频分布在多个完整JSON对象时仍正确拼接', async () => {
  const records = [wav.subarray(0, 17), wav.subarray(17)].map(data => JSON.stringify({ code: 0, data: data.toString('base64') }));
  const result = await synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(records.join('') + terminal)]) });
  assert.deepEqual(fs.readFileSync(result.path), wav);
});

test('多个完整 WAV 头按 PCM 格式合并音频并生成标准 WAV', async () => {
  const second = Buffer.from(wav);
  second.set([1, 2, 3, 4], 44);
  const stream = Buffer.concat([wav, second]);
  const records = [stream.subarray(0, 20), stream.subarray(20, 62), stream.subarray(62)]
    .map(data => JSON.stringify({ code: 0, data: data.toString('base64') }));
  const result = await synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(records.join('') + terminal)]) });
  const audio = fs.readFileSync(result.path);
  assert.equal(audio.readUInt32LE(4), 44);
  assert.equal(audio.readUInt32LE(40), 8);
  assert.deepEqual(audio.subarray(44), Buffer.concat([wav.subarray(44), second.subarray(44)]));
});

test('多段 8 位 PCM 按头部格式和奇数字节填充合并', async () => {
  const part = Buffer.from(wav);
  part.writeUInt16LE(8, 34); part.writeUInt16LE(1, 32); part.writeUInt32LE(24000, 28);
  part.writeUInt32LE(3, 40); part.set([10, 20, 30, 0], 44);
  const payload = JSON.stringify({ code: 0, data: Buffer.concat([part, part, part]).toString('base64') }) + terminal;
  const result = await synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(payload)]) });
  const audio = fs.readFileSync(result.path);
  assert.equal(audio.readUInt16LE(34), 8); assert.equal(audio.readUInt32LE(40), 9);
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  assert.deepEqual([...audio.subarray(44)], [10, 20, 30, 10, 20, 30, 10, 20, 30, 0]);
});

test('火山完成帧后的未知长度PCM WAV含LIST元数据可修复长度', async () => {
  const list = Buffer.alloc(34); list.write('LIST'); list.writeUInt32LE(26, 4); list.write('INFOISFT', 8); list.writeUInt32LE(14, 16); list.write('Lavf58.76.100', 20);
  const stream = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  stream.writeUInt32LE(0xffffffff, 4); stream.writeUInt32LE(0xffffffff, 74);
  const payload = [stream.subarray(0, 55), stream.subarray(55, 80), stream.subarray(80)].map(data => JSON.stringify({code:0,data:data.toString('base64')})).join('');
  const result = await synthesizeToFile({...options,fetchImpl:mock([Buffer.from(payload + terminal)])});
  const audio = fs.readFileSync(result.path);
  assert.equal(audio.readUInt32LE(4),audio.length-8); assert.equal(audio.readUInt32LE(74),4);
  assert.deepEqual(audio.subarray(78),wav.subarray(44));
  for(const bad of [stream.subarray(0,-1), (()=>{const b=Buffer.from(stream);b.writeUInt16LE(6,20);return b;})(), (()=>{const b=Buffer.from(stream);b.writeUInt32LE(1000,40);return b;})()]) {
    await assert.rejects(synthesizeToFile({...options,fetchImpl:mock([Buffer.from(JSON.stringify({code:0,data:bad.toString('base64')})+terminal)])}),e=>e.code==='VOICE_VOLC_FAILED'&&Boolean(e.hint));
  }
  await assert.rejects(synthesizeToFile({...options,fetchImpl:mock([Buffer.from(payload)])}),e=>e.code==='VOICE_VOLC_FAILED'&&Boolean(e.hint));
});

test('多段 WAV 格式不一致、压缩格式和损坏数据均拒绝落盘', async () => {
  const before = fs.readdirSync(outDir);
  const differentRate = Buffer.from(wav); differentRate.writeUInt32LE(16000, 24); differentRate.writeUInt32LE(32000, 28);
  const compressed = Buffer.from(wav); compressed.writeUInt16LE(6, 20);
  const unaligned = Buffer.from(wav); unaligned.writeUInt32LE(3, 40);
  const forged = Buffer.concat([wav, wav]); forged.writeUInt32LE(forged.length - 8, 4);
  const streams = [Buffer.concat([wav, differentRate]), Buffer.concat([compressed, compressed]),
    Buffer.concat([wav, unaligned]), Buffer.concat([wav, wav.subarray(0, 46)]), forged];
  for (const stream of streams) {
    const body = JSON.stringify({ code: 0, data: stream.toString('base64') }) + terminal;
    await assert.rejects(synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(body)]) }), e => e.code === 'VOICE_VOLC_FAILED' && Boolean(e.hint));
  }
  assert.deepEqual(fs.readdirSync(outDir), before);
});

test('完整JSON但WAV提前结束不能报告成功或落盘', async () => {
  const before = fs.readdirSync(outDir);
  for (const [offset, size] of [[4, 140], [40, 104], [4, 0xffffffff], [40, 0xffffffff]]) {
    const truncated = Buffer.from(wav);
    truncated.writeUInt32LE(size, offset);
    const body = JSON.stringify({ code: 0, data: truncated.toString('base64') }) + terminal;
    await assert.rejects(synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(body)]) }), e => e.code === 'VOICE_VOLC_FAILED' && Boolean(e.hint));
  }
  assert.deepEqual(fs.readdirSync(outDir), before);
});

test('完整 WAV 但缺少合成结束帧时不得成功或落盘', async () => {
  const before = fs.readdirSync(outDir);
  await assert.rejects(synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(frame)]) }), e => e.code === 'VOICE_VOLC_FAILED' && Boolean(e.hint));
  assert.deepEqual(fs.readdirSync(outDir), before);
});

test('结束帧后的数据、重复结束帧和结束帧携带音频均拒绝', async () => {
  const before = fs.readdirSync(outDir);
  for (const body of [frame + terminal + frame, frame + terminal + terminal,
    frame + JSON.stringify({ code: 20000000, data: wav.toString('base64') }), terminal]) {
    await assert.rejects(synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(body)]) }), e => e.code === 'VOICE_VOLC_FAILED' && Boolean(e.hint));
  }
  assert.deepEqual(fs.readdirSync(outDir), before);
});

test('坏响应、状态错误和截断均不落文件，不泄露密钥', async () => {
  const before = fs.readdirSync(outDir);
  for (const data of ['{"code":123,"message":"offline-fixture-key"}', frame.slice(0, -1), '{"code":0,"data":"!!"}']) {
    await assert.rejects(synthesizeToFile({ ...options, fetchImpl: mock([Buffer.from(data)]) }), e => {
      assert.equal(e.code, 'VOICE_VOLC_FAILED');
      assert.ok(e.hint);
      assert.ok(!e.message.includes(key));
      return true;
    });
  }
  assert.deepEqual(fs.readdirSync(outDir), before);
});

test('密钥与字数在发请求前校验', async () => {
  let called = false;
  const fetchImpl = () => { called = true; throw new Error('must not call'); };
  for (const override of [{ apiKey: '' }, { apiKey: 'a\nb' }, { text: '字'.repeat(121) }]) {
    await assert.rejects(synthesizeToFile({ ...options, ...override, fetchImpl }), e => Boolean(e.code && e.hint));
  }
  assert.equal(called, false);
});

test('取消未返回的请求', async () => {
  const abort = new AbortController();
  const pending = synthesizeToFile({ ...options, signal: abort.signal, fetchImpl: () => new Promise(() => {}) });
  abort.abort();
  await assert.rejects(pending, e => e.code === 'VOICE_VOLC_TIMEOUT' && Boolean(e.hint));
});

test('取消卡住的响应流', async () => {
  const abort = new AbortController();
  const pending = synthesizeToFile({ ...options, signal: abort.signal, fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })) });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, e => e.code === 'VOICE_VOLC_TIMEOUT' && Boolean(e.hint));
});

test('未指定 provider 仍使用旧 voxd 协议', async () => {
  const result = await synthesizeToFile({ text: '旧路径', outDir, baseUrl: 'http://127.0.0.1:8765', fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8765/v1/speak/file');
    assert.equal(JSON.parse(options.body).text, '旧路径');
    return new Response(wav);
  } });
  assert.deepEqual(fs.readFileSync(result.path), wav);
});
