import { readdirSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
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
// R05（干净克隆门禁）：evaluation-kernel 读取 evaluation 生成的 V1 基线报告；
// 按名字排序会把 kernel 排在 evaluation 前面。显式编排依赖：基线脚本先跑，
// 并把本轮生成的隔离报告路径通过 SURFCORE_MEMORY_V2_BASELINE 传给 kernel。
const baselineScript = 'scripts/test-memory-v2-evaluation.mjs';
const kernelScript = 'scripts/test-memory-v2-evaluation-kernel.mjs';
const selected = candidates.filter(name => !integration.has(name) && name.includes(match));
if (selected.includes(kernelScript) && !selected.includes(baselineScript)) selected.unshift(baselineScript);
if (selected.includes(kernelScript)) {
  // kernel 排在 evaluation 之后（无论字母序）。
  const i = selected.indexOf(kernelScript), j = selected.indexOf(baselineScript);
  if (j > i) { selected.splice(j, 1); selected.splice(i, 0, baselineScript); }
}
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
let baselineReportPath = null;
const started = Date.now();
for (const name of selected) {
  const isolatedHome = path.join(testHome, path.basename(name, '.mjs'));
  mkdirSync(isolatedHome, { recursive: true });
  let baselinePath = null;
  const runEnv = { ...env, DSH_HOME: isolatedHome };
  if (name === kernelScript) {
    // 从本轮 evaluation 的输出里取刚生成的基线报告（隔离目录，不依赖未跟踪的本地历史）。
    baselinePath = baselineReportPath;
    if (!baselinePath || !existsSync(baselinePath)) {
      console.error(`FAIL ${name}: V1 evaluation baseline was not produced in this run.`);
      process.exit(1);
    }
    runEnv.SURFCORE_MEMORY_V2_BASELINE = baselinePath;
  }
  const run = spawnSync(process.execPath, [name], {
    cwd: root, env: runEnv, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    console.error(`FAIL ${name}: ${run.error?.message || `exit ${run.status}`}`);
    console.error(`${run.stdout || ''}${run.stderr || ''}`.slice(-12000));
    console.error(`Next: run ${JSON.stringify(process.execPath)} ${name} for the full failure.`);
    process.exit(1);
  }
  if (name === baselineScript) {
    // evaluation 脚本在 stdout 打印 JSON，其中 report 为本轮生成的隔离基线路径。
    try {
      const json = run.stdout.slice(run.stdout.indexOf('{')).trim();
      const parsed = JSON.parse(json);
      if (parsed?.status === 'PASS' && parsed.report) baselineReportPath = path.resolve(root, parsed.report);
    } catch {}
  }
  console.log(`PASS ${name}`);
}
console.log(`PASS ${selected.length} ordinary scripts in ${((Date.now() - started) / 1000).toFixed(1)}s; native/UI acceptance not run.`);
