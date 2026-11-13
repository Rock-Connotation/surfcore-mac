// 测试隔离前置（2026-11-13 F07 加固）。
//
// 历史事故：ESM 静态 import `character-persona.js` 在赋值 `DSH_HOME` 之前求值，夹具把
// 角色写进真实 `~/.dsh`。首行 import 解决了「未设置 DSH_HOME」这一种情况，但**继承的**
// `DSH_HOME` 仍可能是 symlink 别名或已有 custom 用户数据根；旧 helper 直接信任它。
//
// 契约（刚性）：
//   · 普通测试永远新建专属根；不信任继承的 `DSH_HOME`。
//   · 跨进程共享根必须由父测试用 createTestRoot() 创建，并显式传
//     `SURFCORE_TEST_ROOT` / `SURFCORE_TEST_ROOT_OWNER` / `SURFCORE_TEST_ROOT_PID`；
//     根内 `.surfcore-test-root.json` 的 owner/pid 必须与父进程一致，canonical path 匹配。
//   · 在任何业务模块 import 前完成校验；路径不可信直接抛错，不创建/修权限/迁移/清理。
//   · 导出的 `testHome` 是唯一可用根；所有 factory 路径从它派生。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const realHome = path.resolve(os.homedir(), '.dsh');
const markerName = '.surfcore-test-root.json';

function canonical(value) {
  const resolved = path.resolve(String(value ?? ''));
  let real;
  try { real = fs.realpathSync(resolved); } catch { return { resolved, real: null }; }
  return { resolved, real };
}

function requireOwnedRoot(candidate, owner) {
  const { resolved, real } = canonical(candidate);
  if (!real) throw new Error('Unsafe test root: path does not exist or cannot be resolved.');
  const homeDir = path.resolve(os.homedir());
  if (real === realHome || real === homeDir || resolved === realHome || resolved === homeDir) {
    throw new Error(`Refusing to use the real home as a test root (${real}).`);
  }
  if (real.startsWith(realHome + path.sep) || real.startsWith(homeDir + path.sep)) {
    throw new Error(`Refusing a test root inside the real home (${real}).`);
  }
  // macOS /var -> /private/var 是系统 tmp 标准别名；realpath 后必须仍在系统 tmp 内，
  // 且下面的 owner marker 必须匹配。任意用户数据目录别名会因 tmp 边界被拒绝。
  const tmp = fs.realpathSync(os.tmpdir());
  if (real !== tmp && !real.startsWith(tmp + path.sep)) {
    throw new Error(`Refusing a test root outside the system temp dir (${real}).`);
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(real, markerName), 'utf8')); }
  catch { throw new Error(`Test root has no ownership marker: ${real}. Create it with createTestRoot() in the parent test.`); }
  if (record.owner !== owner || record.pid !== Number(process.env.SURFCORE_TEST_ROOT_PID)) {
    throw new Error(`Test root owner mismatch: ${real}. Inherited/custom roots are not accepted.`);
  }
  return real;
}

/** 父测试显式创建并验证归属的共享根；子进程通过 SURFCORE_TEST_ROOT* 继承它。 */
export function createTestRoot(label = 'surfcore-test') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${label}-`));
  const owner = crypto.randomUUID();
  const record = { version: 1, owner, pid: process.pid, createdAt: new Date().toISOString(), kind: 'surfcore-owned-test-root' };
  fs.writeFileSync(path.join(root, markerName), JSON.stringify(record) + '\n', { mode: 0o600 });
  return {
    root,
    env: {
      SURFCORE_TEST_ROOT: root,
      SURFCORE_TEST_ROOT_OWNER: owner,
      SURFCORE_TEST_ROOT_PID: String(process.pid),
    },
  };
}

function newOwnedRoot(prefix) {
  // macOS /var 是 /private/var 的 symlink；store 的目录链 lstat 会拒绝 symlink。
  // 从一开始就落在 realpath(tmpdir) 下，保证所有下游看到普通目录。
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${prefix}-`));
  const record = { version: 1, owner: crypto.randomUUID(), pid: process.pid, createdAt: new Date().toISOString(), kind: 'surfcore-owned-test-root' };
  fs.writeFileSync(path.join(root, markerName), JSON.stringify(record) + '\n', { mode: 0o600 });
  return { root, record };
}

let testHome, testHomeRecord;
const shared = process.env.SURFCORE_TEST_ROOT;
const owner = process.env.SURFCORE_TEST_ROOT_OWNER;
if (shared) {
  if (!owner) throw new Error('SURFCORE_TEST_ROOT requires SURFCORE_TEST_ROOT_OWNER from the parent test.');
  testHome = requireOwnedRoot(shared, owner);
  testHomeRecord = JSON.parse(fs.readFileSync(path.join(testHome, markerName), 'utf8'));
} else {
  const created = newOwnedRoot('surfcore-test-home');
  testHome = created.root;
  testHomeRecord = created.record;
}

/** 当前进程已验证根的共享 env；父测试可把它传给自己的子进程。 */
export function shareTestRoot() {
  return {
    SURFCORE_TEST_ROOT: testHome,
    SURFCORE_TEST_ROOT_OWNER: testHomeRecord.owner,
    SURFCORE_TEST_ROOT_PID: String(testHomeRecord.pid),
  };
}

// 绝不把继承的 DSH_HOME 当测试根；业务模块看到的一定是本模块验证过的路径。
process.env.DSH_HOME = testHome;
// 不改 HOME：os.homedir() 必须继续指向真实用户目录，否则子进程会把共享测试根
// 误判成 home 并拒绝；业务模块只需要 DSH_HOME / USERPROFILE 指向隔离根。
process.env.USERPROFILE = testHome;
process.env.SURFCORE_QQBOT_ROOT = path.join(testHome, 'qqbot');

export { testHome };
export const realDshHome = realHome;
