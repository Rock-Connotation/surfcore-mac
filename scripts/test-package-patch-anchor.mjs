// Offline structural test: run the real builder against Git blobs with a no-op npm,
// then exercise the official App's actual anchor function (or its portable fixture).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-patch-anchor-'));
const fakeBin = path.join(evidence, 'bin');
fs.mkdirSync(fakeBin);
if (process.platform === 'win32') fs.writeFileSync(path.join(fakeBin, 'npm.cmd'), '@exit /b 0\r\n');
else fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: evidence, DSH_HOME: path.join(evidence, 'dsh-home') };
const payload = path.join(evidence, 'build', 'package');
const ref = process.env.SURFCORE_TEST_REF || 'HEAD';
execFileSync(process.execPath, [path.join(root, 'scripts/build-plugin-package.mjs'), '--ref', ref, '--out', path.join(evidence, 'build')], { cwd: root, env, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
const meta = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'));
const patchRelative = meta.dsh.bundle.patch[0];
assert.equal(patchRelative, './plugins/surfcore/cordis.patch.yml');
const patchFile = path.join(payload, patchRelative);
const patch = fs.readFileSync(patchFile, 'utf8');
const match = /- id: qq-mode\s+name:\s*(\S+)/.exec(patch);
assert.ok(match, 'qq-mode bundle entry exists');
const expected = path.join(payload, 'plugins/surfcore/qq-mode/index.js');
const app = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const portable = `function anchorInsertedPluginNames(patches, file) {
  const base = dirname(resolve(file));
  const visit = (entry) => {
    if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../"))) entry.name = pathToFileURL(resolve(base, entry.name)).href;
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
  };
  for (const patch of patches) patch.insert?.forEach(visit);
  return patches;
}`;
let official = portable;
if (process.platform === 'darwin' && fs.existsSync(app)) {
  const script = `const fs=require('node:fs');const p='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';const s=fs.readFileSync(p,'utf8');const m=s.match(/function anchorInsertedPluginNames\\(patches, file\\) \\{[\\s\\S]*?\\n\\}/);if(!m)throw Error('official anchor unavailable');process.stdout.write(m[0]);`;
  official = execFileSync(app, ['--expose-internals', '-e', script], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  console.log('official App anchor extracted from installed app.asar');
} else console.log('official App anchor unavailable; portable reference only (native verification remains required)');
const anchor = vm.runInNewContext(`(${official})`, { dirname: path.dirname, resolve: path.resolve, isAbsolute: path.isAbsolute, pathToFileURL });
function anchored(name) {
  const patches = [{ insert: [{ id: 'qq-mode', name }, { group: true, config: [{ name: './qq-mode/index.js' }] }] }];
  anchor(patches, patchFile);
  return patches[0].insert;
}
const assertEntry = (name) => assert.equal(fileURLToPath(anchored(name)[0].name), expected, 'official patch-relative loader must resolve exact qq-mode entry');
const entries = anchored(match[1]);
assertEntry(match[1]);
assert.equal(fileURLToPath(entries[1].config[0].name), expected, 'nested group uses same patch anchor');
assert.ok(fs.statSync(expected).isFile());
const source = execFileSync('git', ['-C', root, 'show', `${ref}:plugins/surfcore/cordis.patch.yml`]);
assert.deepEqual(fs.readFileSync(patchFile), source, 'bundle patch must retain exact source bytes');
const bad = anchored('./plugins/surfcore/qq-mode/index.js');
assert.throws(() => assertEntry('./plugins/surfcore/qq-mode/index.js'), assert.AssertionError, 'old duplicated prefix fails the same assertion');
assert.equal(fs.existsSync(fileURLToPath(bad[0].name)), false, 'old path points to a missing file');
const sourceMeta = JSON.parse(execFileSync('git', ['-C', root, 'show', `${ref}:plugins/surfcore/package.json`], { encoding: 'utf8' }));
const prefix = (value) => typeof value === 'string' && value.startsWith('./') ? `./plugins/surfcore/${value.slice(2)}`
  : Array.isArray(value) ? value.map(prefix)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, prefix(v)])) : value;
assert.equal(meta.main, prefix(sourceMeta.main));
assert.deepEqual(meta.exports, prefix(sourceMeta.exports));
assert.deepEqual(meta.dsh, prefix(sourceMeta.dsh));
for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(meta.scripts?.[key], undefined);
for (const f of meta.dsh.bundle.patch) assert.ok(fs.statSync(path.join(payload, f)).isFile(), `declared patch exists: ${f}`);
console.log(`PASS patch anchor, unchanged source bytes, old-prefix mutation, metadata: ${evidence}`);
