// 08 记忆库权限回归：宽松 umask 下首次建库、重开、记录保留。
// 断言：专属目录 0700，SQLite 主库与 -journal 伴生文件 0600，共享父目录权限不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryService } from '../src/core/memory-v2-service.js';
import { hardenDir } from '../src/state-acl.mjs';
import { checkLifecycleControl } from '../src/core/memory-v2-lifecycle.js';

const posix = process.platform !== 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-memory-permissions-'));

// R2-08: exercise the real Windows branch with an offline icacls/whoami double.
async function withFakeWindows({ acl, username, whoami = 'CORP\\ci-runner' }, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldPath = process.env.PATH, oldUser = process.env.USERNAME;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-fake-win-'));
  const aclFile = path.join(bin, 'acl.txt'), log = path.join(bin, 'calls.log');
  fs.writeFileSync(aclFile, acl);
  fs.writeFileSync(path.join(bin, 'icacls'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_ACL_LOG"\nif [ "$#" -eq 1 ]; then cat "$FAKE_ACL_FILE"; fi\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'whoami'), `#!/bin/sh\nprintf '%s\\n' '${whoami}'\n`, { mode: 0o755 });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  process.env.FAKE_ACL_LOG = log;
  process.env.FAKE_ACL_FILE = aclFile;
  if (username === undefined) delete process.env.USERNAME; else process.env.USERNAME = username;
  try {
    const value = await fn();
    return { value, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor); else delete process.platform;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldUser === undefined) delete process.env.USERNAME; else process.env.USERNAME = oldUser;
    delete process.env.FAKE_ACL_LOG; delete process.env.FAKE_ACL_FILE;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}
const previousUmask = process.umask(0o022);
process.on('exit', () => process.umask(previousUmask));

let count = 0;
const onlyFilter = process.env.R2_PERM_ONLY;
function test(name, fn) {
  if (onlyFilter && !name.includes(onlyFilter)) return Promise.resolve();
  return Promise.resolve().then(fn).then(() => { count++; console.log(`ok ${count} - ${name}`); });
}
const good = (value) => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const mode = (file) => fs.statSync(file).mode & 0o777;
const services = [];

function instance(name) {
  const dir = path.join(root, name);
  const stateDir = path.join(dir, 'state'), charactersDir = path.join(dir, 'characters');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(charactersDir, { recursive: true });
  // 模拟本项目常见的共享父目录：0755，V2 不得改动它。
  if (posix) { fs.chmodSync(stateDir, 0o755); fs.chmodSync(charactersDir, 0o755); }
  const character = { id: 'app', epoch: 1 };
  const config = { stateDir, charactersDir, getCharacter: () => ({ ...character }), authorizeManagement: (value) => value === 'permission-test' };
  const f = { dir, stateDir, charactersDir, character, config, service: createMemoryService(config) };
  services.push(f);
  return f;
}
const policy = { policyId: 'private', approved: true, audiences: [['local', 'app:one', 'local:person']], processingGrants: [{ grantId: 'grant', providerRouteId: 'local:test' }] };
const base = { channel: 'local', conversationKey: 'app:one', sourceAccountKey: 'local:person', requesterAccountKey: 'local:person', audiencePolicyId: 'private', providerRouteId: 'local:test', processingGrantId: 'grant' };
const adminContext = async (f) => good(await f.service.host.captureAdminContext(base, 'permission-test')).context;

async function assertPrivateLayout(f) {
  const control = path.join(f.stateDir, 'memory-control.sqlite');
  const roleDir = path.join(f.charactersDir, f.character.id, 'memory');
  const role = path.join(roleDir, 'memory-v2.sqlite');
  const lifecycle = path.join(f.stateDir, 'memory-v2-lifecycle'), backups = path.join(lifecycle, 'backups');
  for (const file of [control, role]) assert.ok(fs.existsSync(file), `${file} should exist`);
  if (!posix) return { control, roleDir, role };
  assert.equal(mode(control), 0o600, `control database ${control}`);
  assert.equal(mode(role), 0o600, `role database ${role}`);
  assert.equal(mode(roleDir), 0o700, `role directory ${roleDir}`);
  assert.equal(mode(lifecycle), 0o700, `lifecycle directory ${lifecycle}`);
  assert.equal(mode(backups), 0o700, `backup directory ${backups}`);
  // 共享父目录保持原值，未被 V2 越权收紧。
  assert.equal(mode(f.stateDir), 0o755, `shared state directory ${f.stateDir}`);
  assert.equal(mode(f.charactersDir), 0o755, `shared characters directory ${f.charactersDir}`);
  return { control, roleDir, role };
}

try {
  await test('first open under umask 022 creates private directories and databases, then retains records after reopen', async () => {
    const f = instance('retained');
    good(await f.service.initialize());
    let ctx = await adminContext(f);
    good(await f.service.host.configurePolicy(ctx, policy, ctx.controlRevision, 'permission-policy'));
    const first = await assertPrivateLayout(f);
    await f.service.close();

    // 重开：同一目录、同一账户；已有库必须仍可打开且记录仍在。
    f.service = createMemoryService(f.config);
    good(await f.service.initialize());
    ctx = await adminContext(f);
    const status = good(await f.service.host.admin.status(ctx));
    assert.deepEqual(status.policies, [{ policyId: 'private', approved: true }]);
    await assertPrivateLayout(f);

    // -journal 伴生文件：SQLite 用主库权限创建它；在事务内直接核对。
    if (posix) {
      await f.service.close();
      const db = new DatabaseSync(first.role);
      try {
        db.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; UPDATE metadata SET commitSequence=commitSequence+1 WHERE id=1;');
        assert.ok(fs.existsSync(`${first.role}-journal`), 'a DELETE journal should exist inside the write transaction');
        assert.equal(mode(`${first.role}-journal`), 0o600, `${first.role}-journal`);
        db.exec('COMMIT');
      } finally { db.close(); }
      f.service = createMemoryService(f.config);
      good(await f.service.initialize());
    }
  });

  await test('an existing shared database is tightened to 0600 without touching its parents', async () => {
    const f = instance('existing');
    good(await f.service.initialize());
    await adminContext(f);
    await f.service.close();
    if (posix) {
      // 模拟旧版本留下的宽松文件。
      fs.chmodSync(path.join(f.stateDir, 'memory-control.sqlite'), 0o644);
      fs.chmodSync(path.join(f.charactersDir, f.character.id, 'memory', 'memory-v2.sqlite'), 0o644);
    }
    f.service = createMemoryService(f.config);
    good(await f.service.initialize());
    // 角色库是懒加载的：重新建立管理上下文才会再次打开它并执行收紧。
    await adminContext(f);
    await assertPrivateLayout(f);
    await f.service.close();
  });

  await test('an unsafe control-store path fails with visible permissions code, error and hint', async () => {
    const f = instance('unsafe');
    const victim = path.join(f.dir, 'elsewhere.sqlite');
    fs.writeFileSync(victim, '', { mode: 0o600 });
    fs.symlinkSync(victim, path.join(f.stateDir, 'memory-control.sqlite'));
    const result = await f.service.initialize();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MEMORY_PERMISSIONS_UNSAFE', JSON.stringify(result));
    assert.ok(result.error && result.hint, JSON.stringify(result));
    assert.equal(fs.readFileSync(victim).length, 0, 'the symlink target must not be opened as a database');
  });

  await test('R2-08 Windows: an explicit wide SID grant cannot be silently reported as hardened', async () => {
    const dir = path.join(root, 'win-wide'); fs.mkdirSync(dir, { recursive: true });
    const acl = `${dir} CORP\\ci-runner:(F)  SYSTEM:(F)  BUILTIN\\\\Administrators:(F)  *S-1-5-32-545:(F)\n`;
    const { value } = await withFakeWindows({ acl, username: 'ci-runner' }, () => hardenDir(dir));
    assert.equal(value.ok, false, JSON.stringify(value));
    assert.equal(value.code, 'MEMORY_PERMISSIONS_UNSAFE', JSON.stringify(value));
    assert.ok(value.error && value.hint, JSON.stringify(value));
  });

  await test('R2-08 Windows: hardening resolves a stable principal and preserves the three-account grant contract', async () => {
    const dir = path.join(root, 'win-principal'); fs.mkdirSync(dir, { recursive: true });
    const acl = `${dir} CORP\\ci-runner:(F)  SYSTEM:(F)  BUILTIN\\\\Administrators:(F)\n`;
    const { value, calls } = await withFakeWindows({ acl, username: '' }, () => hardenDir(dir));
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.match(calls, /CORP\\ci-runner:F/);
    assert.match(calls, /SYSTEM:F/);
    assert.match(calls, /Administrators:F/);
  });

  await test('R2-08 lifecycle: a symlinked private directory is rejected with a visible permissions receipt', async () => {
    const dir = path.join(root, 'lifecycle-symlink');
    const stateDir = path.join(dir, 'state'), charactersDir = path.join(dir, 'characters');
    fs.mkdirSync(stateDir, { recursive: true });
    const id = 'app-00000000000000000000000000000000';
    const memoryDir = path.join(charactersDir, id, 'memory');
    fs.mkdirSync(path.join(memoryDir, 'generations'), { recursive: true });
    const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.chmodSync(outside, 0o700);
    fs.symlinkSync(outside, path.join(memoryDir, 'quarantine'));
    fs.writeFileSync(path.join(stateDir, 'memory-v2.lifecycle.json'), JSON.stringify({ format: 1, minimumCompatibleKernel: 2, minimumControlRevision: 0, characters: [id] }));
    assert.throws(() => checkLifecycleControl(stateDir, charactersDir), (error) => {
      assert.equal(error.code, 'MEMORY_PERMISSIONS_UNSAFE', JSON.stringify(error));
      assert.ok(error.error && error.hint, JSON.stringify(error));
      return true;
    });
  });

  console.log(`Memory V2 permissions: ${count} checks passed; runtime ${process.version}`);
} finally {
  for (const f of services) { try { await f.service.close(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
  process.umask(previousUmask);
}