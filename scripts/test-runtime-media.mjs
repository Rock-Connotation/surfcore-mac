// Media runtime discovery is deterministic with local executables; no download or account call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireFfmpeg, resolveMediaRuntime } from '../plugins/surfcore/tools/lib/ffmpeg.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-media-runtime-'));
const bin = path.join(root, 'bin');
const ffmpeg = path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const probe = (_file, { kind, platform }) => ({
  ok: true,
  version: `${kind} version 8.0.0`,
  platform,
  arch: 'arm64',
  capabilities: kind === 'ffmpeg'
    ? { audioFilters: true, resample: true }
    : { streamInspection: true, jsonOutput: true },
});
const writeExecutable = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  try { fs.chmodSync(file, 0o755); } catch {}
};

try {
  writeExecutable(ffmpeg);
  writeExecutable(ffprobe);
  const runtime = resolveMediaRuntime({ env: { PATH: bin }, platform: 'linux', probe });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.ffmpegPath, fs.realpathSync(ffmpeg));
  assert.equal(runtime.ffprobePath, fs.realpathSync(ffprobe));
  assert.equal(runtime.ffmpeg.version, 'ffmpeg version 8.0.0');
  assert.equal(runtime.ffmpeg.source, 'PATH');
  assert.equal(runtime.ffmpeg.arch, 'arm64');

  const explicitFailure = resolveMediaRuntime({
    env: { PATH: bin, FFMPEG: path.join(root, 'missing-ffmpeg'), FFPROBE_PATH: ffprobe },
    platform: 'linux', probe,
  });
  assert.equal(explicitFailure.ok, false);
  assert.equal(explicitFailure.code, 'MEDIA_RUNTIME_OVERRIDE_INVALID');
  assert.equal(explicitFailure.ffmpeg.code, 'MEDIA_RUNTIME_OVERRIDE_INVALID');
  assert.ok(explicitFailure.error);
  assert.ok(explicitFailure.hint);
  assert.equal(explicitFailure.ffprobePath, fs.realpathSync(ffprobe));

  const capabilityFailure = resolveMediaRuntime({
    env: { PATH: bin },
    platform: 'linux',
    probe: (file, context) => ({
      ...probe(file, context),
      capabilities: context.kind === 'ffmpeg'
        ? { audioFilters: true, resample: false }
        : { streamInspection: false, jsonOutput: true },
    }),
  });
  assert.equal(capabilityFailure.ok, false);
  assert.equal(capabilityFailure.code, 'MEDIA_CAPABILITY_MISSING');
  assert.match(capabilityFailure.error, /aresample/);
  assert.ok(capabilityFailure.hint);

  const original = process.env.FFMPEG;
  try {
    process.env.FFMPEG = path.join(root, 'missing-require-ffmpeg');
    assert.throws(() => requireFfmpeg(), (error) => {
      assert.equal(error.code, 'MEDIA_RUNTIME_OVERRIDE_INVALID');
      assert.ok(error.hint);
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.FFMPEG;
    else process.env.FFMPEG = original;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('✅ FFmpeg/FFprobe runtime tests passed');
