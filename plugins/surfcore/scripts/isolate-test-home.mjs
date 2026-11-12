// 测试隔离前置（2026-11-12 事故后刚性）。
//
// 事故：`test-companion-sharing.mjs` / `test-douyin-companion.mjs` 在静态 import
// `character-persona.js` **之后**才设置 `process.env.DSH_HOME`。ESM 的依赖在赋值语句
// 执行前就已求值，于是 `CHARACTERS_DIR` 被绑定到真实 `~/.dsh`，夹具把角色与当前指针
// 写进了用户数据目录。
//
// 规则：任何会触碰 `character-persona.js` / `paths.js` 的测试，必须在**第一条** import
// 就引入本模块，让它在其它模块求值前设置隔离 home：
//
//   import { testHome } from './isolate-test-home.mjs';
//
// 本模块只做三件事：建临时目录、设置 DSH_HOME/USERPROFILE、拒绝指向真实 home。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = path.join(os.homedir(), '.dsh');
const current = process.env.DSH_HOME;

// 如果调用方已显式设置了一个隔离目录，复用它；否则新建。
let home = current;
if (!home) home = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-test-home-'));

const resolved = path.resolve(home);
if (resolved === path.resolve(realHome) || resolved === path.resolve(os.homedir())) {
  throw new Error(`Refusing to run a test against the real home (${resolved}). Set DSH_HOME to an isolated temporary directory.`);
}
if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });

process.env.DSH_HOME = resolved;
process.env.USERPROFILE = resolved;
// 防止插件读到真实配置。
process.env.SURFCORE_QQBOT_ROOT ??= path.join(resolved, 'qqbot');

export const testHome = resolved;
export const realDshHome = realHome;
