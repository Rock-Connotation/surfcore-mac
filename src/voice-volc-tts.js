// 火山语音 2.0：固定官方地址，流式响应有界解析；错误不包含服务端正文或密钥。
import crypto from 'node:crypto';
import { reserveVolcBudget } from './voice-volc-budget.js';

const URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const SPEAKER = 'zh_female_xiaohe_uranus_bigtts';
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_AUDIO = 20 * 1024 * 1024;

function failure(code, message, hint) {
  return Object.assign(new Error(message), { code, hint });
}

function completeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  if (buf.readUInt32LE(4) + 8 !== buf.length) return false;
  let offset = 12, format = false, data = false;
  while (offset + 8 <= buf.length) {
    const type = buf.toString('ascii', offset, offset + 4);
    if (type === 'RIFF') return false;
    const size = buf.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > buf.length || end + (size & 1) > buf.length) return false;
    if (type === 'fmt ') format = size >= 16;
    if (type === 'data' && size > 0) data = true;
    offset = end + (size & 1);
  }
  return offset === buf.length && format && data;
}

// The real stream uses unknown RIFF/data sizes; only the success frame makes EOF authoritative.
function normalizeStreamingWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE' || buf.readUInt32LE(4) !== 0xffffffff) return null;
  let offset = 12, fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4), size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      if (!fmt || size !== 0xffffffff) return null;
      const bytes = buf.length - offset - 8, align = fmt.readUInt16LE(12);
      const channels = fmt.readUInt16LE(2), bits = fmt.readUInt16LE(14), rate = fmt.readUInt32LE(4);
      if (fmt.readUInt16LE(0) !== 1 || channels < 1 || channels > 8 || rate !== 24000 ||
          ![8, 16, 24, 32].includes(bits) || align !== channels * bits / 8 ||
          fmt.readUInt32LE(8) !== rate * align || bytes < 1 || bytes % align !== 0) return null;
      const out = Buffer.alloc(buf.length + (bytes & 1)); buf.copy(out);
      out.writeUInt32LE(out.length - 8, 4); out.writeUInt32LE(bytes, offset + 4);
      return completeWav(out) ? out : null;
    }
    const end = offset + 8 + size + (size & 1);
    if (end > buf.length) return null;
    if (id === 'fmt ' && !fmt && size === 16) fmt = buf.subarray(offset + 8, offset + 24);
    else if (id !== 'LIST' || !fmt) return null;
    offset = end;
  }
  return null;
}

function normalizeWav(buf) {
  if (completeWav(buf)) return buf;
  const streaming = normalizeStreamingWav(buf);
  if (streaming) return streaming;
  let offset = 0, fmt = null, total = 0;
  const parts = [];
  while (offset < buf.length) {
    if (offset + 12 > buf.length || buf.toString('ascii', offset, offset + 4) !== 'RIFF') return null;
    const end = offset + 8 + buf.readUInt32LE(offset + 4);
    if (end > buf.length || end - offset < 44) return null;
    const part = buf.subarray(offset, end);
    if (!completeWav(part)) return null;
    let localFmt = null, samples = null, pos = 12;
    while (pos < part.length) {
      const id = part.toString('ascii', pos, pos + 4);
      const size = part.readUInt32LE(pos + 4);
      const value = part.subarray(pos + 8, pos + 8 + size);
      if (id === 'fmt ' && !localFmt && !samples && size === 16) localFmt = value;
      else if (id === 'data' && localFmt && !samples && size > 0) samples = value;
      else return null;
      pos += 8 + size + (size & 1);
    }
    if (!localFmt || !samples || (fmt && !fmt.equals(localFmt))) return null;
    const channels = localFmt.readUInt16LE(2), rate = localFmt.readUInt32LE(4);
    const bits = localFmt.readUInt16LE(14), align = localFmt.readUInt16LE(12);
    if (localFmt.readUInt16LE(0) !== 1 || channels < 1 || channels > 8 || rate !== 24000 ||
        ![8, 16, 24, 32].includes(bits) || align !== channels * bits / 8 ||
        localFmt.readUInt32LE(8) !== rate * align || samples.length % align !== 0) return null;
    fmt = localFmt;
    total += samples.length;
    if (total + 44 + (total & 1) > MAX_AUDIO) return null;
    parts.push(samples);
    offset = end;
  }
  if (parts.length < 2) return null;
  const out = Buffer.alloc(44 + total + (total & 1));
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); fmt.copy(out, 20); out.write('data', 36); out.writeUInt32LE(total, 40);
  let written = 44;
  for (const part of parts) { part.copy(out, written); written += part.length; }
  return out;
}

export async function synthesizeVolc({ text, apiKey, budget, timeoutMs = 60000, signal, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[^\x21-\x7e]/.test(apiKey) || apiKey.length > 4096)
    throw failure('VOICE_VOLC_KEY_INVALID', '火山语音密钥未配置或格式无效。', '在语音设置中重新输入 API Key。');
  if (typeof text !== 'string' || !text.trim() || text.length > 120)
    throw failure('VOICE_VOLC_TEXT_INVALID', '合成文字为空或超过120字。', '输入不超过120字的文字后重试。');
  if (signal?.aborted) throw failure('VOICE_VOLC_TIMEOUT', '火山语音请求已取消。', '需要时手动重试。');
  const timeout = Math.min(120000, Math.max(1000, Number(timeoutMs) || 60000));
  const abort = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  const frames = [];
  let rawBytes = 0, audioBytes = 0, frameCount = 0, frame = '', depth = 0, quoted = false, escaped = false, finished = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function parse(input) {
    for (const ch of input) {
      if (!depth) {
        if (/\s/.test(ch)) continue;
        if (ch !== '{') throw new Error('frame');
        depth = 1; frame = '{'; continue;
      }
      frame += ch;
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (!depth) {
        if (++frameCount > 8192) throw new Error('frames');
        const obj = JSON.parse(frame);
        if (!obj || finished) throw new Error('frame');
        // The V3 HTTP protocol reports synthesis completion separately from audio chunks.
        if (obj.code === 20000000) {
          if (obj.data != null) throw new Error('terminal');
          finished = true;
        } else if (obj.code !== 0) throw new Error('provider');
        if (obj.data != null && obj.data !== '') {
          if (typeof obj.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(obj.data)) throw new Error('base64');
          const part = Buffer.from(obj.data, 'base64');
          audioBytes += part.length;
          if (audioBytes > MAX_AUDIO) throw new Error('size');
          frames.push(part);
        }
        frame = '';
      }
    }
  }
  const withAbort = promise => new Promise((resolve, reject) => {
    if (abort.aborted) return reject(new Error('abort'));
    const onAbort = () => reject(new Error('abort'));
    abort.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => abort.removeEventListener('abort', onAbort));
  });
  const request = reserveVolcBudget({ ...budget, text: text.trim(), requireSelection: true, startRequest: () => {
    try {
      return Promise.resolve(fetchImpl(URL, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': crypto.randomUUID() },
        body: JSON.stringify({ req_params: { text: text.trim(), speaker: SPEAKER, audio_params: { format: 'wav', sample_rate: 24000 } } }),
        signal: abort
      }));
    } catch (e) { return Promise.reject(e); }
  } });
  let response, reader;
  try {
    response = await withAbort(request);
    if (!response.ok || !response.body?.getReader) throw new Error('http');
    reader = response.body.getReader();
    while (true) {
      const result = await withAbort(reader.read());
      if (result.done) break;
      rawBytes += result.value.byteLength;
      if (rawBytes > MAX_RESPONSE) throw new Error('size');
      parse(decoder.decode(result.value, { stream: true }));
    }
    parse(decoder.decode());
    if (depth || !finished || !audioBytes) throw new Error('incomplete');
    const audio = normalizeWav(Buffer.concat(frames, audioBytes));
    if (!audio) throw new Error('wav');
    return audio;
  } catch {
    throw failure(abort.aborted ? 'VOICE_VOLC_TIMEOUT' : 'VOICE_VOLC_FAILED',
      abort.aborted ? '火山语音请求超时或已取消。' : '火山语音合成失败。',
      '检查网络、API Key 和语音资源授权后手动重试。');
  } finally {
    if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
  }
}
