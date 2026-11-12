import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-package-repair-'));
const pkg = path.join(temp, 'package'), home = path.join(temp, 'dsh'), profile = path.join(home, 'profiles', 'fixture');
for (const dir of ['scripts', 'src', 'plugins/surfcore']) fs.mkdirSync(path.join(pkg, dir), { recursive: true });
for (const file of ['scripts/setup-dsh.mjs', 'scripts/build-agent-preset-patches.mjs', 'src/node-path.js', 'src/install-identity.js', 'src/qq-data-paths.js']) fs.copyFileSync(path.join(root, file), path.join(pkg, file));
fs.cpSync(path.join(root, 'dsh'), path.join(pkg, 'dsh'), { recursive: true });
fs.cpSync(path.join(root, 'plugins/surfcore/presets'), path.join(pkg, 'plugins/surfcore/presets'), { recursive: true });
fs.copyFileSync(path.join(root, 'plugins/surfcore/package.json'), path.join(pkg, 'plugins/surfcore/package.json'));
for (const file of ['mcp-snowluma-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js']) fs.writeFileSync(path.join(pkg, 'src', file), '// fixture\n');
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.8.8', type: 'module', main: './plugins/surfcore/lib/index.js' }));
fs.writeFileSync(path.join(pkg, '.surfcore-install.json'), JSON.stringify({ schemaVersion: 1, kind: 'package', sourceRepo: 'fixture/repo', updateOwner: 'dsh-package-manager' }));
fs.writeFileSync(path.join(pkg, 'artifact-manifest.json'), JSON.stringify({ schemaVersion: 1, files: {} }));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
fs.symlinkSync(pkg, path.join(profile, 'node_modules', 'surfcore'), 'dir');
const profilePkg = path.join(profile, 'package.json');
const packageBefore = JSON.stringify({ name: 'fixture-profile', dependencies: { surfcore: 'file:fixture.tgz', provider: 'preserve' }, dsh: { profile: { bundles: ['surfcore', 'provider'] } } }, null, 2) + '\n';
fs.writeFileSync(profilePkg, packageBefore);
const patch = path.join(profile, 'cordis.patch.yml');
fs.writeFileSync(patch, '# provider sentinel\n- insert:\n    - id: keep-provider\n      name: fixture-provider\n# === qq-bridge MCP BEGIN ===\n- insert:\n    - id: mcp-snowluma\n      name: old\n# === qq-bridge MCP END ===\n');
for (let i = 0; i < 6; i++) fs.writeFileSync(`${patch}.bak-fixture-${i}`, 'preserve');
const preset = path.join(pkg, 'plugins/surfcore/presets/qq-chat-v2.patch.yml'); fs.appendFileSync(preset, '\n# shipped-byte-sentinel\n'); const presetBefore = fs.readFileSync(preset);
function packageFiles(dir = pkg, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && entry.name === 'node_modules') continue;
    const relative = path.join(prefix, entry.name), file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, packageFiles(file, relative));
    else if (entry.isFile()) result[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    else result[relative] = `symlink:${fs.readlinkSync(file)}`;
  }
  return result;
}
const packageFilesBefore = packageFiles();
const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
const installMarker = path.join(temp, 'unexpected-install');
fs.writeFileSync(path.join(bin, 'dsh'), `#!/bin/sh\nprintf unexpected > '${installMarker}'\n`, { mode: 0o755 });
const env = { ...process.env, HOME: temp, USERPROFILE: temp, DSH_HOME: home, DSH_PROFILE: 'fixture', DSH_NODE: process.execPath, PATH: bin, QQ_BRIDGE_SKIP_DSH_INSTALL: '', SURFCORE_ROOT: '', SURFCORE_QQBOT_ROOT: '', QQBILI_QQBOT_ROOT: '' };
const run = (overrides = {}, args = ['fixture']) => spawnSync(process.execPath, [path.join(pkg, 'scripts/setup-dsh.mjs'), ...args], { encoding: 'utf8', env: { ...env, ...overrides } });
for (let i = 0; i < 2; i++) { const r = run(); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }
assert.equal(fs.readFileSync(profilePkg, 'utf8'), packageBefore, 'profile package must remain byte-identical');
assert.equal(fs.realpathSync(path.join(profile, 'node_modules', 'surfcore')), fs.realpathSync(pkg), 'installed package link must remain');
assert.deepEqual(fs.readFileSync(preset), presetBefore, 'shipped preset must remain unchanged');
assert.deepEqual(packageFiles(), packageFilesBefore, 'all shipped package bytes must remain unchanged');
assert.equal(fs.existsSync(installMarker), false, 'repair must never invoke dsh install');
assert.equal(fs.existsSync(path.join(pkg, 'state')), false, 'package must not gain state');
for (let i = 0; i < 6; i++) assert.equal(fs.readFileSync(`${patch}.bak-fixture-${i}`, 'utf8'), 'preserve');
const text = fs.readFileSync(patch, 'utf8'); assert.match(text, /# provider sentinel/);
const entries = yaml.load(text).flatMap((row) => row.insert ?? []);
for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
  const matches = entries.filter((entry) => entry.id === id); assert.equal(matches.length, 1);
  assert.equal(matches[0].config.env.DSH_HOME, home); assert.equal(path.dirname(fs.realpathSync(matches[0].config.args.at(-1))), fs.realpathSync(path.join(pkg, 'src')));
}
assert.equal(entries.find((entry) => entry.id === 'keep-provider').name, 'fixture-provider');
const beforeBackupFailure = fs.readFileSync(patch, 'utf8').replace('serverName: snowluma\n', 'serverName: changed-fixture\n'); fs.writeFileSync(patch, beforeBackupFailure);
const shim = path.join(temp, 'backup-failure.mjs');
fs.writeFileSync(shim, "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const copy = fs.copyFileSync; fs.copyFileSync = (...a) => { if (String(a[1]).includes('.bak-')) throw Object.assign(new Error('fixture backup failed'), { code: 'EIO' }); return copy(...a); }; syncBuiltinESMExports();\n");
let failed = run({ NODE_OPTIONS: `--import=${shim}` });
assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_BACKUP_FAILED/); assert.match(failed.stderr, /下一步/); assert.equal(fs.readFileSync(patch, 'utf8'), beforeBackupFailure);
const raceShim = path.join(temp, 'concurrent-change.mjs');
fs.writeFileSync(raceShim, "import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const copy = fs.copyFileSync; fs.copyFileSync = (...a) => { const result = copy(...a); if (String(a[1]).includes('.bak-')) fs.appendFileSync(a[0], '# concurrent edit\\n'); return result; }; syncBuiltinESMExports();\n");
failed = run({ NODE_OPTIONS: `--import=${raceShim}` });
assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PATCH_CHANGED/); assert.match(failed.stderr, /下一步/);
assert.equal(fs.readFileSync(patch, 'utf8'), beforeBackupFailure + '# concurrent edit\n');
const foreignInside = beforeBackupFailure.replace('# === qq-bridge MCP END ===', '- insert:\n    - id: foreign\n      name: preserve-me\n# === qq-bridge MCP END ===');
fs.writeFileSync(patch, foreignInside); failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PATCH_UNSAFE/); assert.equal(fs.readFileSync(patch, 'utf8'), foreignInside);
const foreignOutside = beforeBackupFailure + '- insert:\n    - id: mcp-snowluma\n      name: outside-owner\n';
fs.writeFileSync(patch, foreignOutside); failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PATCH_UNSAFE/); assert.equal(fs.readFileSync(patch, 'utf8'), foreignOutside);
for (const extra of ['- id: mcp-snowluma\n  name: direct\n', '- group:\n    nested:\n      - id: mcp-web-search-safe\n']) {
  const unsafe = beforeBackupFailure + extra; fs.writeFileSync(patch, unsafe);
  failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PATCH_UNSAFE/); assert.equal(fs.readFileSync(patch, 'utf8'), unsafe);
}
fs.writeFileSync(patch, '# comment-only sentinel\n'); const commentOnly = run(); assert.equal(commentOnly.status, 0, commentOnly.stderr); assert.match(fs.readFileSync(patch, 'utf8'), /^# comment-only sentinel/);
fs.writeFileSync(patch, beforeBackupFailure);
const identityFile = path.join(pkg, '.surfcore-install.json'), heldIdentity = `${identityFile}.held`;
fs.renameSync(identityFile, heldIdentity);
try {
  failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_IDENTITY_INVALID/); assert.match(failed.stderr, /下一步/); assert.equal(fs.readFileSync(patch, 'utf8'), beforeBackupFailure);
} finally { fs.renameSync(heldIdentity, identityFile); }
const second = path.join(home, 'profiles', 'other'); fs.mkdirSync(second);
fs.writeFileSync(path.join(second, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['surfcore'] } } }));
failed = run({ DSH_PROFILE: '' }, []); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PROFILE_AMBIGUOUS/); assert.equal(fs.readFileSync(patch, 'utf8'), beforeBackupFailure);
fs.unlinkSync(path.join(profile, 'node_modules', 'surfcore')); fs.symlinkSync(path.join(pkg, 'plugins/surfcore'), path.join(profile, 'node_modules', 'surfcore'), 'dir');
failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /DSH_REPAIR_PACKAGE_BINDING/); assert.equal(fs.readFileSync(patch, 'utf8'), beforeBackupFailure);
console.log('PASS packaged setup preserves installed bundle, provider, prior backups and package bytes');
