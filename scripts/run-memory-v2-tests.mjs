import { readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const matchAt = args.indexOf('--match');
const match = matchAt < 0 ? '' : args[matchAt + 1];
const pluginOnly = args.includes('--plugin');
const knownArgs = new Set(['--list', '--plugin', '--match']);
if (match === undefined || match.startsWith('--') || args.some((arg, i) => !knownArgs.has(arg) && !(matchAt >= 0 && i === matchAt + 1))) {
  console.error('Usage: npm run test:memory-v2 -- [--list] [--plugin] [--match name]');
  process.exit(2);
}
// These entries load a real Host, browser, or automatically launch Electron.
const integration = new Set([
  'scripts/test-memory-v2-host-runtime.mjs',
  'scripts/test-memory-v2-runtime.mjs',
  'scripts/test-memory-v2-ui-visual.mjs',
  'plugins/surfcore/scripts/test-memory-v2-native-root.mjs',
  'plugins/surfcore/scripts/test-memory-v2-bili-agent.mjs',
  'plugins/surfcore/scripts/test-memory-v2-bili-host-native.mjs',
]);
const dirs = pluginOnly ? ['plugins/surfcore/scripts'] : ['scripts', 'plugins/surfcore/scripts'];
const candidates = dirs.flatMap(dir => readdirSync(path.join(root, dir))
  .filter(name => /^test-memory-v2.*\.mjs$/.test(name))
  .map(name => `${dir}/${name}`)).sort();
const selected = candidates.filter(name => !integration.has(name) && name.includes(match));
if (!selected.length) {
  console.error(`No ordinary Memory V2 tests match ${JSON.stringify(match)}. Use --list to inspect the suite.`);
  process.exit(2);
}
if (listOnly) {
  selected.forEach(name => console.log(`ordinary ${name}`));
  candidates.filter(name => integration.has(name)).forEach(name => console.log(`separate ${name}`));
  console.log(`Selected ${selected.length} ordinary scripts; native and UI acceptance remains separate.`);
  process.exit(0);
}
const env = { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' };
for (const name of Object.keys(env)) {
  if (/^SURFCORE_.*NATIVE/.test(name)) delete env[name];
}
const testHome = mkdtempSync(path.join(os.tmpdir(), 'surfcore-memory-tests-'));
const started = Date.now();
for (const name of selected) {
  const isolatedHome = path.join(testHome, path.basename(name, '.mjs'));
  mkdirSync(isolatedHome, { recursive: true });
  const run = spawnSync(process.execPath, [name], {
    cwd: root, env: { ...env, DSH_HOME: isolatedHome }, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    console.error(`FAIL ${name}: ${run.error?.message || `exit ${run.status}`}`);
    console.error(`${run.stdout || ''}${run.stderr || ''}`.slice(-12000));
    console.error(`Next: run ${JSON.stringify(process.execPath)} ${name} for the full failure.`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
}
console.log(`PASS ${selected.length} ordinary scripts in ${((Date.now() - started) / 1000).toFixed(1)}s; native/UI acceptance not run.`);
