#!/usr/bin/env node
// Offline, reproducible configuration. Fetch/authenticate the fixed source separately.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const expected = '946fcce07b6dcd0331c8cc609192aeff5e1924f8';
const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('Usage on darwin-arm64: node scripts/prepare-macos-media.mjs <clean-ffmpeg-source> <new-output-directory>');
  process.exit(2);
}
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
const run = (command, args, options = {}) => {
  const r = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (r.error || r.status !== 0) throw new Error(`${command} failed: ${r.error?.message || r.status}`);
};
const capture = (...args) => {
  const r = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout.trim();
};
if (capture('rev-parse', 'HEAD') !== expected || capture('status', '--porcelain')) throw new Error('Source must be clean and match the fixed FFmpeg commit.');
if (fs.existsSync(output)) throw new Error('Output exists; preserve it and choose a new directory.');
fs.mkdirSync(output, { recursive: true });
const build = path.join(output, 'build');
const prefix = path.join(output, 'runtime');
fs.mkdirSync(build);
const options = [`--prefix=${prefix}`, '--disable-autodetect', '--disable-network', '--disable-doc', '--disable-debug', '--enable-static', '--disable-shared', '--disable-ffplay'];
fs.writeFileSync(path.join(output, 'configuration.json'), JSON.stringify({ source: 'https://github.com/FFmpeg/FFmpeg.git', ref: 'n9.0.2', commit: expected, options, jobs: 4, signatureVerified: false }, null, 2) + '\n');
run(path.join(source, 'configure'), options, { cwd: build });
run('make', ['-j4'], { cwd: build });
run('make', ['install'], { cwd: build });
console.log(`Built: ${prefix}. Verify licensing, dependencies and media behavior before distribution.`);
