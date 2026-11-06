// Verified NodeRuntime discovery: .app resources, Unix caches, explicit overrides,
// Electron Node mode, actionable failures, shell-safe Agent commands, and legacy path API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findNodeExe, isNodeExe, nodeRuntimeCommand, resolveNodeRuntime,
} from '../src/node-path.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-node-path-'));
const caps = { esm: true, fetch: true, abortSignalTimeout: true, webSocket: true };
const writeExecutable = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  try { fs.chmodSync(file, 0o755); } catch {}
};
const fakeProbe = (candidate, { env }) => ({
  ok: true,
  version: '24.21.0',
  platform: candidate.platform,
  arch: candidate.platform === 'darwin' ? 'arm64' : 'x64',
  capabilities: caps,
  env,
});

try {
  assert.equal(isNodeExe('node.exe'), true);
  assert.equal(isNodeExe('nodejs'), true);
  assert.equal(isNodeExe('DeepSeek Harness.exe'), false);

  // macOS .app: process.execPath is under Contents/MacOS, while Node is under
  // the sibling Contents/Resources. Use a Unicode/space path to lock in safe path handling.
  {
    const app = path.join(root, '安装 包', 'DeepSeek Harness.app');
    const execPath = path.join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
    const bundled = path.join(app, 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node');
    writeExecutable(execPath);
    writeExecutable(bundled);
    const runtime = resolveNodeRuntime({
      execPath, platform: 'darwin', env: {}, home: path.join(root, 'home'),
      dshHome: path.join(root, 'dsh'), resourcesPath: '', probe: fakeProbe,
    });
    assert.equal(runtime.executable, fs.realpathSync(bundled));
    assert.equal(runtime.kind, 'node');
    assert.equal(runtime.source, 'app-resources');
    assert.equal(runtime.version, '24.21.0');
    assert.equal(runtime.arch, 'arm64');
    assert.deepEqual(runtime.capabilities, caps);
  }

  // DSH Unix cache has no .exe suffix, and comes before the default home cache.
  {
    const dshHome = path.join(root, 'custom dsh');
    const cached = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node');
    writeExecutable(cached);
    const runtime = resolveNodeRuntime({
      execPath: path.join(root, 'other', 'Harness'), platform: 'darwin', env: {},
      home: path.join(root, 'home'), dshHome, resourcesPath: '', probe: fakeProbe,
    });
    assert.equal(runtime.executable, fs.realpathSync(cached));
    assert.equal(runtime.source, 'dsh-home-cache');
    assert.equal(findNodeExe({
      execPath: path.join(root, 'other', 'Harness'), platform: 'darwin', env: {},
      home: path.join(root, 'home'), dshHome, resourcesPath: '', probe: fakeProbe,
    }), fs.realpathSync(cached), '旧路径 API 应返回已验证的 Node executable');
  }

  // Windows .exe layout remains supported and goes through the same probe.
  {
    const install = path.join(root, 'windows', 'install');
    const host = path.join(install, 'DeepSeek Harness.exe');
    const bundled = path.join(install, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
    writeExecutable(host);
    writeExecutable(bundled);
    const runtime = resolveNodeRuntime({
      execPath: host, platform: 'win32', env: { PATH: '' },
      home: path.join(root, 'home-win'), dshHome: path.join(root, 'dsh-win'),
      programFiles: path.join(root, 'missing', 'node.exe'), probe: fakeProbe,
    });
    assert.equal(runtime.executable, fs.realpathSync(bundled));
    assert.equal(runtime.platform, 'win32');
    assert.equal(runtime.source, 'app-resources');
  }

  // PROGRAMFILES is a directory on Windows, not the node.exe executable itself.
  {
    const programFiles = path.join(root, 'Windows Program Files');
    const installed = path.join(programFiles, 'nodejs', 'node.exe'); writeExecutable(installed);
    const runtime = resolveNodeRuntime({ execPath: path.join(root, 'no-bundle', 'Harness'), platform: 'win32',
      env: { PATH: '', PROGRAMFILES: programFiles }, home: path.join(root, 'fallback-home'),
      dshHome: path.join(root, 'fallback-dsh'), resourcesPath: '', probe: fakeProbe });
    assert.equal(runtime.executable, fs.realpathSync(installed)); assert.equal(runtime.source, 'system-location');
  }

  // A nonstandard explicit filename is accepted only after executing the capability probe.
  {
    const envNode = path.join(root, 'custom', 'Runtime 节点');
    writeExecutable(envNode);
    const runtime = resolveNodeRuntime({
      execPath: path.join(root, 'none', 'Harness'), platform: 'darwin',
      env: { DSH_NODE: envNode, PATH: '' }, home: path.join(root, 'none-home'),
      dshHome: path.join(root, 'none-dsh'), probe: fakeProbe,
    });
    assert.equal(runtime.executable, fs.realpathSync(envNode));
    assert.equal(runtime.source, 'dsh-node-override');
  }

  // Electron Node mode is accepted only with a child-scoped env patch.
  {
    const host = path.join(root, 'Harness.app', 'Contents', 'MacOS', 'Harness');
    writeExecutable(host);
    let seenEnv;
    const hostElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const runtime = resolveNodeRuntime({
      execPath: host, platform: 'darwin', electronVersion: '41.0.0', env: { PATH: '' },
      home: path.join(root, 'electron-home'), dshHome: path.join(root, 'electron-dsh'),
      probe: (candidate, { env }) => {
        seenEnv = env;
        return fakeProbe(candidate, { env });
      },
    });
    assert.equal(runtime.kind, 'electron-node-mode');
    assert.deepEqual(runtime.envPatch, { ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(seenEnv.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, hostElectronRunAsNode, 'Electron Node mode must not mutate the host environment');
  }

  // A bad explicit override is a structured failure; it must not fall back to PATH/app Node.
  {
    const bad = path.join(root, 'bad', 'node');
    writeExecutable(bad);
    assert.throws(() => resolveNodeRuntime({
      execPath: path.join(root, 'other', 'Harness'), platform: 'darwin',
      env: { DSH_NODE: bad, PATH: '' }, home: path.join(root, 'missing-home'),
      dshHome: path.join(root, 'missing-dsh'),
      probe: () => ({ ok: false, reason: '版本 18.0.0 低于要求 v22.13.0' }),
    }), (error) => {
      assert.equal(error.code, 'NODE_RUNTIME_OVERRIDE_INVALID');
      assert.ok(error.hint);
      assert.ok(error.message.includes(bad));
      return true;
    });
  }

  // Electron mode receives env only in probe/child command; shell quoting preserves spaces,
  // apostrophes, Chinese paths, and the actual executable selected by the descriptor.
  {
    const runtime = {
      executable: path.join(root, "O'Neil 安装", 'DeepSeek Harness'),
      argvPrefix: [], envPatch: { ELECTRON_RUN_AS_NODE: '1' },
    };
    const command = nodeRuntimeCommand(runtime, path.join(root, "剧本's", 'bili.mjs'), ['watch', '有 空格'], { platform: 'darwin' });
    assert.ok(command.startsWith("ELECTRON_RUN_AS_NODE='1' "));
    assert.ok(command.includes("'\\''"), 'POSIX quote should escape embedded apostrophes');
    assert.ok(command.includes('有 空格'));
    assert.ok(!command.startsWith('node '), 'Agent command must use the resolved executable');
    const powershell = nodeRuntimeCommand(runtime, path.join(root, 'bili.mjs'), [], { platform: 'win32' });
    assert.ok(powershell.includes('$env:ELECTRON_RUN_AS_NODE'));
    assert.ok(powershell.includes('try { & '));
    assert.ok(powershell.includes("SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $oldEnv0, 'Process')"));
  }

  // Real child-process probe for the Node executing this focused test.
  if (isNodeExe(process.execPath)) {
    const runtime = resolveNodeRuntime({
      execPath: process.execPath, platform: process.platform,
      env: { PATH: '' }, home: path.join(root, 'real-home'), dshHome: path.join(root, 'real-dsh'),
      resourcesPath: '',
    });
    assert.equal(runtime.version, process.versions.node);
    assert.equal(runtime.platform, process.platform);
    assert.equal(runtime.arch, process.arch);
  }

  const setup = fs.readFileSync('scripts/setup-dsh.mjs', 'utf8');
  const scheduler = fs.readFileSync('plugins/surfcore/lib/scheduler.js', 'utf8');
  assert.ok(setup.includes('resolveNodeRuntime') && setup.includes('NODE_RUNTIME'), 'setup MCP command must use the shared runtime descriptor');
  assert.ok(scheduler.includes('resolveNodeRuntime') && scheduler.includes('nodeRuntimeCommand'), 'scheduler child and Agent command must share one runtime');
  assert.ok(!scheduler.includes('const TOOL_CMD = `node '), 'Agent command must not use bare node');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('✅ verified Node runtime tests passed');
