import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resumePendingApply } from '../plugins/surfcore/lib/updates.js';
import {
  initializeSourceInstallationIdentity,
  readInstallationIdentity,
  validatePending,
  writeInstallationIdentity,
} from '../src/install-identity.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-identity-'));
const sourceRepo = 'Rock-Connotation/surfcore-mac';
const setupInstall = (name, { version = '0.8.8', kind = 'source', owner = 'surfcore-updater', metadataVersion = version } = {}) => {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'surfcore', version }));
  fs.writeFileSync(path.join(root, '.surfcore-install.json'), JSON.stringify({
    schemaVersion: 1, sourceRepo, sourceCommit: 'abc', version: metadataVersion, kind, updateOwner: owner,
  }));
  return root;
};

try {
  const root = setupInstall('current', { metadataVersion: '0.8.6' });
  const other = setupInstall('other');
  const identity = readInstallationIdentity(root);
  assert.equal(identity.ok, true);
  assert.equal(identity.actualVersion, '0.8.8', '实际 package.json 版本独立读取');
  assert.equal(identity.identity.version, '0.8.6', '测试身份故意保留过期版本元数据');

  const pending = {
    kind: 'zip', target: root, sourceRepo, updateOwner: 'surfcore-updater',
    installationKind: 'source', fromVersion: '0.8.8',
  };
  assert.equal(validatePending(pending, { installRoot: root }).ok, true, '合法 pending 按 package.json 实际版本通过');
  assert.equal(validatePending(pending, { installRoot: other }).code, 'pending.target-mismatch', '另一真实安装不能接受 pending 自报的 target');
  for (const [key, value, code] of [
    ['target', path.join(root, 'other'), 'pending.target-mismatch'],
    ['sourceRepo', 'evil/repo', 'pending.sourceRepo-mismatch'],
    ['updateOwner', 'git', 'pending.updateOwner-mismatch'],
    ['installationKind', 'package', 'pending.installationKind-mismatch'],
    ['fromVersion', '0.8.7', 'pending.from-version-mismatch'],
  ]) {
    assert.equal(validatePending({ ...pending, [key]: value }, { installRoot: root }).code, code);
  }
  assert.equal(validatePending({ ...pending, fromVersion: '0.8.6' }, { installRoot: root }).code, 'pending.from-version-mismatch', '过期 identity.version 不能决定恢复来源版本');
  assert.equal(validatePending(pending, {}).code, 'pending.identity-missing', '没有 Host 提供可信根时 fail closed');

  const managerRoot = setupInstall('manager', { kind: 'package', owner: 'dsh-package-manager' });
  const managerPending = { ...pending, target: managerRoot, installationKind: 'package', updateOwner: 'dsh-package-manager' };
  assert.equal(validatePending(managerPending, { installRoot: managerRoot }).code, 'pending.owner-managed', 'package manager owned install cannot self-update');

  const missing = path.join(base, 'missing');
  fs.mkdirSync(missing, { recursive: true });
  fs.writeFileSync(path.join(missing, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.8.8' }));
  const missingResult = readInstallationIdentity(missing);
  assert.equal(missingResult.code, 'identity.missing');
  assert.ok(missingResult.error && missingResult.hint, '身份读取失败必须有 error 和 hint');

  const writeRoot = path.join(base, 'write-hook');
  fs.mkdirSync(writeRoot, { recursive: true });
  fs.writeFileSync(path.join(writeRoot, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.8.8' }));
  const written = writeInstallationIdentity(writeRoot, { kind: 'package', sourceRepo, updateOwner: 'dsh-package-manager', version: '0.1.0' });
  assert.equal(written.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(written.file, 'utf8')).version, '0.8.8', '显式写入也采用实际 package.json 版本');

  const sourceRoot = path.join(base, 'git-source');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.8.8' }));
  const git = (args) => execFileSync('git', ['-C', sourceRoot, ...args], { stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.name', 'SurfCore identity test']);
  git(['config', 'user.email', 'identity-test@example.invalid']);
  git(['remote', 'add', 'origin', 'git@github.com:Rock-Connotation/surfcore-mac.git']);
  git(['add', 'package.json']);
  git(['commit', '-qm', 'fixture']);
  const initialized = initializeSourceInstallationIdentity(sourceRoot);
  assert.equal(initialized.ok, true, initialized.error);
  assert.equal(initialized.identity.kind, 'source');
  assert.equal(initialized.identity.updateOwner, 'surfcore-updater');
  assert.equal(readInstallationIdentity(sourceRoot).ok, true);
  assert.equal(initializeSourceInstallationIdentity(sourceRoot).code, 'identity.exists', 'explicit initializer never overwrites an existing identity');

  // Resume runs only with a Host-supplied trusted root and a verified runtime descriptor.
  const stateDir = path.join(base, 'resume-state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'apply-update.mjs'), '// fixture: never executed');
  const pendingFile = path.join(stateDir, 'updates-pending.json');
  const record = path.join(base, 'runtime-record.json');
  const fakeRuntime = path.join(base, 'runtime.mjs');
  fs.writeFileSync(fakeRuntime, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), marker: process.env.SURFCORE_TEST_RUNTIME }));`);
  const resolver = () => ({ executable: process.execPath, argvPrefix: [fakeRuntime], envPatch: { SURFCORE_TEST_RUNTIME: 'injected' } });
  fs.writeFileSync(pendingFile, JSON.stringify(pending));
  assert.equal(resumePendingApply({ stateDir, installRoot: root, resolveNodeRuntime: resolver }), true);
  for (let i = 0; i < 100 && !fs.existsSync(record); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const launched = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.deepEqual(launched.args, [path.join(fs.realpathSync(root), 'scripts', 'apply-update.mjs'), '--pending', pendingFile]);
  assert.equal(launched.marker, 'injected');
  assert.equal(JSON.parse(fs.readFileSync(pendingFile)).waitPid, process.pid);
  for (const [candidate, trustedRoot, expected] of [
    [{ kind: 'zip', target: root }, root, 'pending.sourceRepo-mismatch'],
    [managerPending, managerRoot, 'pending.owner-managed'],
    [pending, other, 'pending.target-mismatch'],
  ]) {
    const original = JSON.stringify(candidate);
    fs.writeFileSync(pendingFile, original);
    assert.equal(resumePendingApply({ stateDir, installRoot: trustedRoot, resolveNodeRuntime: resolver }), false);
    const failed = JSON.parse(fs.readFileSync(`${pendingFile}.failed`, 'utf8'));
    assert.equal(failed.code, expected);
    assert.ok(failed.error && failed.hint);
    assert.equal(fs.readFileSync(pendingFile, 'utf8'), original, 'rejected pending remains untouched');
  }

  console.log('PASS install identity: trusted-root, package-version, provenance, owner, explicit initializer, and diagnostics checks');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
