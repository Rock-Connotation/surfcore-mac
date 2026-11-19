// 生成 / 校验发布包的安装清单：每个文件的 sha256。
//
// 关键约束（2026-10-30 第二次事故）：
//   清单里的哈希必须等于 **Git 提交里的内容**（= GitHub archive 里的字节），
//   不能取工作目录里的文件：Windows 下工作区常是 CRLF，而 git 提交/归档是 LF，
//   两边 sha256 必然不同 → 用户下载的包永远校验失败。
//   所以这里用 `git cat-file` 读 HEAD（或指定 ref）的 blob 字节来算哈希。
//
// 2026-11-19 审核 06：目录校验必须先证明 **归档自带的清单**，再证明程序文件。
//   旧实现读工作区的 release/install-manifest.json，所以把包内清单整个删掉仍能通过。
//   现在 `--verify <dir>` 会：
//     1) 要求 <dir>/release/install-manifest.json 存在；
//     2) 其字节必须与固定提交（--ref，默认 HEAD）里的清单 blob 完全一致；
//     3) 检查结构（schemaVersion / version / files / sha256 格式 / 不得自引用）；
//     4) 清单条目必须与固定提交的程序文件集合完全相等（删条目+删文件不能蒙混）；
//     5) 再逐文件比对字节。
//   清单自身由固定提交证明，因此清单里不含自己的哈希，也不存在自引用。
//
// 用法：
//   node scripts/release-manifest.mjs                        # 用 HEAD 生成 release/install-manifest.json
//   node scripts/release-manifest.mjs --verify-ref v0.7.11   # 校验某 ref 的清单与 blob 是否一致（发版门禁）
//   node scripts/release-manifest.mjs --verify <dir> [--ref <ref>]
//                                                            # 校验解压目录；<ref> 是预期发布提交（默认 HEAD）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_REL = 'release/install-manifest.json';

export const EXCLUDE_DIRS = new Set([
  'state', 'backups', '_backups', 'node_modules', '.git', 'logs', 'staging', 'pet', 'characters',
  'voice-packs', 'dist', 'video', 'release', 'tmp-update',
  // 内容/个人数据目录：不进公开镜像，也不进清单（它们不是"我们的代码文件"）
  'roles', 'assets', 'audio', 'pet', 'characters', 'examples',
]);
export const EXCLUDE_FILES = new Set([
  'config.json', 'bili.config.json', 'updates-pending.json',
  '.installed-meta.json', '.installed-manifest.json',
  // 本机诊断产物，不属于发布内容
  'obs-diag.json',
]);

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function isManagedRel(rel) {
  const parts = rel.split('/');
  if (parts.some((x) => EXCLUDE_DIRS.has(x))) return false;
  if (EXCLUDE_FILES.has(parts[parts.length - 1])) return false;
  if (rel === MANIFEST_REL) return false;
  return true;
}

export function filterTracked(list) {
  return list.filter(isManagedRel);
}

/** 枚举目录里所有“会被安装包带上去”的受管文件，复用发布端的排除规则。 */
export function listManagedFiles(dir) {
  const dirAbs = path.resolve(dir);
  const found = [];
  const visit = (abs) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = path.relative(dirAbs, path.join(abs, ent.name)).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (isManagedRel(rel + '/.probe')) visit(path.join(abs, ent.name));
      } else if ((ent.isFile() || ent.isSymbolicLink()) && isManagedRel(rel)) {
        found.push(rel);
      }
    }
  };
  visit(dirAbs);
  return found.sort();
}

/**
 * 校验清单结构。返回问题列表（空数组 = 通过）。
 * 只做与 ref 无关的检查；与固定提交的字节/文件集比对由调用方完成。
 */
export function validateManifestShape(manifest, label = MANIFEST_REL) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [`${label}：不是 JSON 对象`];
  }
  if (manifest.schemaVersion !== 1) {
    problems.push(`${label}：schemaVersion 必须为 1（实际 ${JSON.stringify(manifest.schemaVersion)}）`);
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    problems.push(`${label}：version 缺失或不是非空字符串`);
  }
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    problems.push(`${label}：files 缺失或不是对象`);
    return problems;
  }
  const keys = Object.keys(files);
  if (keys.length === 0) problems.push(`${label}：files 为空`);
  for (const [rel, hash] of Object.entries(files)) {
    if (rel === MANIFEST_REL) problems.push(`${label}：清单不得包含自身（${MANIFEST_REL}）`);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      problems.push(`${label}：${rel} 的哈希不是 64 位小写 sha256`);
    }
  }
  return problems;
}

/** 清单条目集合必须与固定提交的程序文件集合完全相等。 */
export function manifestScopeProblems(files, tracked) {
  const problems = [];
  const trackedSet = new Set(tracked);
  for (const rel of Object.keys(files ?? {})) {
    if (!trackedSet.has(rel)) problems.push(`清单多出：${rel}`);
  }
  for (const rel of tracked) {
    if (!(rel in (files ?? {}))) problems.push(`清单缺少：${rel}`);
  }
  return problems;
}

function listTracked(ref) {
  const out = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', '-z', ref], { encoding: 'buffer' });
  return out.toString('utf8').split(String.fromCharCode(0)).filter(Boolean);
}

/** 用一次 git cat-file --batch 取出所有 blob 的字节，返回 { rel: sha256 } */
function hashBlobs(ref, files) {
  const input = files.map((rel) => `${ref}:${rel}`).join('\n') + '\n';
  const out = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input, maxBuffer: 256 * 1024 * 1024 });
  const filesHash = {};
  let offset = 0;
  for (const rel of files) {
    const nl = out.indexOf(10, offset);
    if (nl < 0) throw new Error(`git cat-file 输出不完整（${rel}）`);
    const header = out.slice(offset, nl).toString('utf8');
    const parts = header.split(' '); // <sha> <type> <size>
    if (parts.length !== 3) throw new Error(`无法解析 blob 头：${header}（${rel}）`);
    const size = Number(parts[2]);
    const start = nl + 1;
    const blob = out.subarray(start, start + size);
    if (blob.length !== size) throw new Error(`blob 长度不符：${rel}`);
    filesHash[rel] = sha256(blob);
    offset = start + size + 1; // 跳过 blob 后的换行
  }
  return filesHash;
}

function gitShow(ref, rel) {
  return execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], { maxBuffer: 256 * 1024 * 1024 });
}

function trackedFiles(ref) {
  return filterTracked(listTracked(ref));
}

function refVersion(ref) {
  return JSON.parse(gitShow(ref, 'package.json').toString('utf8')).version;
}

function printProblems(problems, limit = 20) {
  for (const p of problems.slice(0, limit)) console.log(`  ✗ ${p}`);
}

/** 字节不一致时尽量给出具体条目路径，便于定位是清单被删条/改哈希还是整份清单被替换。 */
export function describeManifestDiff(actualBuf, expectedBuf, limit = 10) {
  const out = [];
  let actual;
  let expected;
  try {
    actual = JSON.parse(actualBuf.toString('utf8'));
    expected = JSON.parse(expectedBuf.toString('utf8'));
  } catch {
    return out;
  }
  const af = actual?.files && typeof actual.files === 'object' ? actual.files : {};
  const ef = expected?.files && typeof expected.files === 'object' ? expected.files : {};
  for (const rel of Object.keys(af)) if (!(rel in ef)) out.push(`包内清单多出条目：${rel}`);
  for (const rel of Object.keys(ef)) if (!(rel in af)) out.push(`包内清单缺少条目：${rel}`);
  for (const rel of Object.keys(af)) {
    if (rel in ef && af[rel] !== ef[rel]) out.push(`包内清单哈希不符：${rel}`);
  }
  if (actual?.version !== expected?.version) {
    out.push(`包内清单版本不符：${actual?.version} vs ${expected?.version}`);
  }
  return out.slice(0, limit);
}

function verifyAt(ref) {
  let manifestBuf;
  try {
    manifestBuf = gitShow(ref, MANIFEST_REL);
  } catch {
    console.error(`✗ 无法读取 ${ref} 的清单：${MANIFEST_REL}`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    console.error(`✗ 清单不是合法 JSON：${MANIFEST_REL}（${e.message}）`);
    return 1;
  }
  const problems = validateManifestShape(manifest, MANIFEST_REL);
  if (problems.length) {
    console.log(`verify-ref ${ref}: 清单结构无效（${MANIFEST_REL}）`);
    printProblems(problems);
    return 1;
  }
  const tracked = trackedFiles(ref);
  const expected = hashBlobs(ref, tracked);
  const files = manifest.files;
  problems.push(...manifestScopeProblems(files, tracked));
  for (const [rel, want] of Object.entries(files)) {
    if (!(rel in expected)) continue; // 已由 manifestScopeProblems 报"清单多出"
    if (expected[rel] !== want) {
      problems.push(`哈希不符：${rel}（清单 ${want.slice(0, 12)} / 实际 ${expected[rel].slice(0, 12)}）`);
    }
  }
  const version = refVersion(ref);
  if (manifest.version !== version) problems.push(`${MANIFEST_REL}：清单版本 ${manifest.version} 与 package.json ${version} 不一致`);
  console.log(`verify-ref ${ref}: 清单 ${Object.keys(files).length} 个，跟踪文件 ${tracked.length} 个，问题 ${problems.length} 个`);
  printProblems(problems);
  if (problems.length) return 1;
  console.log('✅ 清单与该 ref 的内容逐字节一致');
  return 0;
}

function verifyDir(dir, ref) {
  const dirAbs = path.resolve(dir);
  const manifestAbs = path.join(dirAbs, MANIFEST_REL);
  if (!fs.existsSync(manifestAbs)) {
    console.error(`✗ 缺少包内清单：${MANIFEST_REL}（${manifestAbs}）`);
    return 1;
  }
  let expectedBuf;
  try {
    expectedBuf = gitShow(ref, MANIFEST_REL);
  } catch {
    console.error(`✗ 无法读取 ${ref} 的清单：${MANIFEST_REL}`);
    return 1;
  }
  const manifestBuf = fs.readFileSync(manifestAbs);
  if (!manifestBuf.equals(expectedBuf)) {
    console.error(`✗ 包内清单与 ${ref} 的清单字节不一致：${MANIFEST_REL}（包内 ${manifestBuf.length} 字节 / 预期 ${expectedBuf.length} 字节）`);
    printProblems(describeManifestDiff(manifestBuf, expectedBuf));
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    console.error(`✗ 包内清单不是合法 JSON：${manifestAbs}（${e.message}）`);
    return 1;
  }
  const problems = validateManifestShape(manifest, MANIFEST_REL);
  if (problems.length) {
    console.log(`verify-dir ${dirAbs}: 包内清单结构无效（${MANIFEST_REL}）`);
    printProblems(problems);
    return 1;
  }
  const tracked = trackedFiles(ref);
  const trackedSet = new Set(tracked);
  const files = manifest.files;
  problems.push(...manifestScopeProblems(files, tracked));
  for (const rel of listManagedFiles(dirAbs)) {
    if (!trackedSet.has(rel)) problems.push('目录多出未受清单保护的程序文件：' + rel);
  }
  const version = refVersion(ref);
  if (manifest.version !== version) problems.push(`${MANIFEST_REL}：清单版本 ${manifest.version} 与 package.json ${version} 不一致`);

  let ok = 0;
  const bad = [];
  const missing = [];
  for (const [rel, want] of Object.entries(files)) {
    if (!trackedSet.has(rel)) continue; // 已报"清单多出"
    const abs = path.join(dirAbs, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (!stat.isFile()) {
      missing.push(rel);
      continue;
    }
    const hash = sha256(fs.readFileSync(abs));
    if (hash === want) ok += 1;
    else bad.push(rel);
  }

  console.log(`verify-dir ${dirAbs} (ref ${ref}): ok ${ok} | 不符 ${bad.length} | 缺失 ${missing.length} | 问题 ${problems.length}`);
  for (const rel of bad.slice(0, 10)) console.log(`  ✗ 不符：${rel}`);
  for (const rel of missing.slice(0, 10)) console.log(`  ✗ 缺失：${rel}`);
  printProblems(problems);
  if (bad.length || missing.length || problems.length) return 1;
  console.log('✅ 目录内容与清单一致');
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const verifyRefIdx = args.indexOf('--verify-ref');
  const verifyDirIdx = args.indexOf('--verify');
  let ref = 'HEAD';
  const refIdx = args.indexOf('--ref');
  if (refIdx >= 0 && args[refIdx + 1]) ref = args[refIdx + 1];

  if (verifyRefIdx >= 0) {
    process.exitCode = verifyAt(args[verifyRefIdx + 1] || 'HEAD');
    return;
  }
  if (verifyDirIdx >= 0) {
    process.exitCode = verifyDir(args[verifyDirIdx + 1] || '.', ref);
    return;
  }

  // ── 生成模式 ─────────────────────────────────────────────────────────────
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...listTracked('HEAD')], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes(MANIFEST_REL))
    .join('\n')
    .trim();
  if (dirty) {
    console.error('[release-manifest] 工作区有未提交改动：清单按 HEAD 生成，未提交内容不会进包');
    console.error(dirty.split('\n').slice(0, 10).join('\n'));
    process.exitCode = 1;
  }

  const tracked = filterTracked(listTracked('HEAD'));
  const files = hashBlobs('HEAD', tracked);
  const version = refVersion('HEAD');
  const out = { schemaVersion: 1, version, source: 'git:HEAD', generatedAt: new Date().toISOString(), files };
  const target = path.join(root, MANIFEST_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`install-manifest: ${Object.keys(files).length} files, version ${version} (source=git HEAD) -> ${target}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv);
