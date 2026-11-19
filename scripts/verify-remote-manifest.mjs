// 远程清单核对：直接读 GitHub 上某个 tag 的 **git blob**，逐文件比 sha256。
//
// 为什么需要它：`codeload.github.com` 在部分网络下会挂（下载卡住），但 `api.github.com`
// 仍然可用。归档 zip 的内容就是这些 blob（无 filter），所以按 blob 核对等价于核对归档，
// 而且能作为发版门禁的备用通道（AGENTS §1.8 第 3 条）。
//
// 2026-11-19 审核 06：不再信任工作区的 release/install-manifest.json。
//   1) 先把 tag 固定到提交，从该提交的树里读出远端 `release/install-manifest.json` blob；
//   2) 与**预期发布对象**（本地 --expected-ref，默认 HEAD）的清单 blob 逐字节核对；
//   3) 校验清单结构（schemaVersion/files/sha256/不得自引用）；
//   4) 按与本地校验相同的排除规则检查程序文件集合；
//   5) 再逐 blob 比 sha256。远端清单自身也走同一套异常检测。
//
// 离线测试可用 SURFCORE_GITHUB_API_BASE 指向本地假 API（只认这个变量，不会自动回退网络）。
//
// 用法：GH_TOKEN=... node scripts/verify-remote-manifest.mjs <owner/repo> <tag> [--expected-ref <ref>]
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_REL, filterTracked, validateManifestShape, manifestScopeProblems, describeManifestDiff, sha256,
} from './release-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let expectedRef = 'HEAD';
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--expected-ref') {
    expectedRef = args[i + 1] || 'HEAD';
    i += 1;
    continue;
  }
  positional.push(args[i]);
}
const repo = positional[0];
const tag = positional[1];
const token = process.env.GH_TOKEN;
if (!repo || !tag) {
  console.error('用法：verify-remote-manifest.mjs <owner/repo> <tag> [--expected-ref <ref>]');
  process.exit(2);
}

const apiBase = (process.env.SURFCORE_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'surfcore-verify', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function api(p) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const res = await fetch(`${apiBase}${p}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 403 || res.status === 429) throw new Error(`rate limited: ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return undefined;
}

async function blobBytes(blobSha) {
  const b = await api(`/repos/${repo}/git/blobs/${blobSha}`);
  const raw = String(b.content || '');
  return b.encoding === 'base64'
    ? Buffer.from(raw.replace(/\n/g, ''), 'base64')
    : Buffer.from(raw, 'utf8');
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

let tagRef;
try {
  tagRef = await api(`/repos/${repo}/git/ref/tags/${tag}`);
} catch (e) {
  fail(`无法读取 ${repo} 的 tag ${tag}：${e.message}`);
}
let commitSha = tagRef.object?.sha;
if (!commitSha) fail(`远端找不到 tag：${tag}`);
let commit = await api(`/repos/${repo}/git/commits/${commitSha}`).catch(() => null);
if (!commit?.tree) {
  const tagObj = await api(`/repos/${repo}/git/tags/${commitSha}`);
  commitSha = tagObj.object?.sha;
  if (!commitSha) fail(`tag ${tag} 无法解析到提交`);
  commit = await api(`/repos/${repo}/git/commits/${commitSha}`);
}
if (!commit?.tree?.sha) fail(`无法读取 ${tag} 对应提交 ${commitSha} 的树`);

const tree = await api(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
const blobs = new Map((tree.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]));

// 1) 远端清单必须存在，且与预期发布对象的清单 blob 逐字节一致。
const manifestSha = blobs.get(MANIFEST_REL);
if (!manifestSha) fail(`远端 ${tag} 缺少包内清单：${MANIFEST_REL}`);
const remoteManifestBuf = await blobBytes(manifestSha);
let expectedManifestBuf;
try {
  expectedManifestBuf = execFileSync('git', ['-C', root, 'show', `${expectedRef}:${MANIFEST_REL}`], { maxBuffer: 256 * 1024 * 1024 });
} catch {
  fail(`无法从本地 ${expectedRef} 读取清单：${MANIFEST_REL}`);
}
if (!remoteManifestBuf.equals(expectedManifestBuf)) {
  console.error(`✗ 远端清单与 ${expectedRef} 的清单字节不一致：${MANIFEST_REL}（远端 ${remoteManifestBuf.length} 字节 / 预期 ${expectedManifestBuf.length} 字节）`);
  for (const p of describeManifestDiff(remoteManifestBuf, expectedManifestBuf)) console.error(`  ✗ ${p}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(remoteManifestBuf.toString('utf8'));
} catch (e) {
  fail(`远端清单不是合法 JSON：${MANIFEST_REL}（${e.message}）`);
}
const problems = validateManifestShape(manifest, MANIFEST_REL);
if (problems.length) {
  console.error(`✗ 远端清单结构无效：${MANIFEST_REL}`);
  for (const p of problems.slice(0, 20)) console.error(`  ✗ ${p}`);
  process.exit(1);
}

// 2) 程序文件范围必须与远端树（同一排除规则）完全一致。
const tracked = filterTracked([...blobs.keys()]);
problems.push(...manifestScopeProblems(manifest.files, tracked));
if (problems.length) {
  console.error(`✗ 远端清单范围与 ${repo}@${tag} 的程序文件不一致：`);
  for (const p of problems.slice(0, 20)) console.error(`  ✗ ${p}`);
  process.exit(1);
}

// 3) 逐 blob 比 sha256。
const want = manifest.files;
const keys = Object.keys(want);
const missing = keys.filter((k) => !blobs.has(k));
const results = { ok: 0, mismatch: [] };
const CONCURRENCY = 8;
let idx = 0;
async function worker() {
  while (idx < keys.length) {
    const rel = keys[idx++];
    if (missing.includes(rel)) continue;
    const buf = await blobBytes(blobs.get(rel));
    if (sha256(buf) === want[rel]) results.ok += 1;
    else results.mismatch.push(rel);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`远程核对 ${repo}@${tag}（${commitSha.slice(0, 7)}，预期 ${expectedRef}）：清单 ${keys.length} 个 · 一致 ${results.ok} · 不符 ${results.mismatch.length} · 缺失 ${missing.length}`);
for (const rel of results.mismatch.slice(0, 10)) console.log(`  ✗ 不符：${rel}`);
for (const rel of missing.slice(0, 10)) console.log(`  ✗ 缺失：${rel}`);
if (results.mismatch.length || missing.length) process.exit(1);
console.log('✅ 远程存储的内容与安装清单逐字节一致');
