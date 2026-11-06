// Exercise the packed artifact and the official App's pnpm in a fresh, isolated fixture.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const option = (flag) => { const i = process.argv.indexOf(flag); return i < 0 ? '' : process.argv[i + 1]; };
const suppliedPayload = option('--payload');
const fixtureArg = option('--fixture');
if (Boolean(suppliedPayload) !== Boolean(fixtureArg)) throw new Error('请同时提供 --payload 和 --fixture，或都不提供');
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = suppliedPayload ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-package-lifecycle-'));
const payload = suppliedPayload ? path.resolve(suppliedPayload) : path.join(evidence, 'build', 'package');
const fixture = fixtureArg ? path.resolve(fixtureArg) : path.join(evidence, 'consumer-fixture');
if (!suppliedPayload) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-plugin-package.mjs'), '--ref', option('--ref') || 'HEAD', '--out', path.join(evidence, 'build')], { cwd: root, stdio: 'inherit' });
}
if (fs.existsSync(fixture)) throw new Error('隔离目录已存在，保留现有证据');
fs.mkdirSync(fixture, { recursive: true });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const metadata = readJson(path.join(payload, 'package.json'));
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(metadata.scripts?.[name], undefined, `消费者生命周期 ${name}`);
assert.notEqual(readJson(path.join(payload, 'npm-shrinkwrap.json')).packages[''].hasInstallScript, true);
const manifest = readJson(path.join(payload, 'artifact-manifest.json'));
for (const [name, digest] of Object.entries(manifest.files)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(payload, name))).digest('hex'), digest, `manifest ${name}`);
}
const patched = fs.readFileSync(path.join(payload, 'node_modules/@snowluma/sdk/dist/index.js'), 'utf8');
assert.match(patched, /from '\.\/client\/api-client\.js'/, 'SDK ESM 兼容补丁已物化');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', fixture], { cwd: payload, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const tarball = path.join(fixture, packed[0].filename);
const app = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const pnpm = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
assert.ok(fs.existsSync(app) && fs.existsSync(pnpm), '需要目标官方 App 的 pnpm');
const consumer = path.join(fixture, 'consumer');
fs.mkdirSync(consumer);
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-consumer', version: '1.0.0', private: true, type: 'module' }));
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SURFCORE|QQBOT|DSH)(?:_|$)/i.test(key)));
const env = { ...inheritedEnv, DSH_HOME: path.join(fixture, 'dsh-home'), HOME: fixture, XDG_CACHE_HOME: path.join(fixture, 'cache'), XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_DATA_HOME: path.join(fixture, 'data'), ELECTRON_RUN_AS_NODE: '1', npm_config_userconfig: path.join(fixture, 'npmrc'), npm_config_globalconfig: path.join(fixture, 'global-npmrc') };
const output = execFileSync(app, ['--expose-internals', pnpm, 'add', '--offline', '--store-dir', path.join(fixture, 'pnpm-store'), tarball], { cwd: consumer, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
fs.writeFileSync(path.join(fixture, 'pnpm-install.log'), output);
assert.doesNotMatch(output, /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/);
const installed = path.join(consumer, 'node_modules/surfcore');
for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(readJson(path.join(installed, 'package.json')).scripts?.[name], undefined);
assert.match(fs.readFileSync(path.join(installed, 'node_modules/@snowluma/sdk/dist/index.js'), 'utf8'), /from '\.\/client\/api-client\.js'/);
const script = "await import('surfcore'); await import('./node_modules/surfcore/node_modules/@snowluma/sdk/dist/index.js'); console.log('consumer module imports OK')";
const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: consumer, encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 });
console.log(output.trim());
console.log(loaded.trim());
console.log(`PASS lifecycle-free bundle: ${tarball}`);
