import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createFrameSheet } from '../tools/lib/bili-media.mjs'
import { ffmpegPath } from '../tools/lib/ffmpeg.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-frames-'))
const ffmpeg = process.env.TEST_FFMPEG || ffmpegPath()
if (!ffmpeg || !fs.existsSync(ffmpeg)) { console.log('SKIP: real FFmpeg fixture requires an installed FFmpeg'); process.exit(0) }
const source = path.join(root, 'input.mp4')
execFileSync(ffmpeg, ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=4', '-c:v', 'mpeg4', source])
let calls = []
const frame = await createFrameSheet({ mediaPath: source, sourceDurationMs: 4000, bvid: 'BV1234567890', page: 2, outputDir: root, grid: '2x1', ffmpegPath: ffmpeg, keepMedia: true, subtitleEvery: 1, sceneDetector: async (_file, threshold) => { calls.push(threshold); return [800, 3000] } })
assert.deepEqual(calls, [0.3]); assert.deepEqual(frame.samples.map(x => x.sourceTimeMs), [800, 3000]); assert.ok(frame.samples.every(x => x.snapped))
assert.ok(fs.statSync(frame.sheet).size > 0); assert.ok(fs.statSync(frame.subtitleStrip).size > 0)
const uniform = await createFrameSheet({ mediaPath: source, sourceDurationMs: 4000, bvid: 'BV1234567890', page: 2, outputDir: root, grid: '2x1', ffmpegPath: ffmpeg, uniform: true, sceneDetector: () => { throw new Error('uniform must not detect scenes') } })
assert.deepEqual(uniform.samples.map(x => x.sourceTimeMs), [1000, 3000])
console.log('real ffmpeg frame sheet, scene snapping, uniform mode and subtitle strip passed')
