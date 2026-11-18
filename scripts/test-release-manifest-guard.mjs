// 审核 06 的离线验收：清单校验必须证明“归档自带的清单”，而不是工作区清单。
//
// 覆盖：
//   1) 全部匹配的离线候选（从 Git blob 原样物化）→ 目录校验退出 0；
//   2) 缺包内清单 / 无效清单 / 清单删条且数据文件同步删除 / 单文件内容错误 → 非零退出且报出路径；
//   3) 从另一个工作目录用显式 ref 校验；
//   4) verify-remote-manifest 的两个分支（远端清单 + 程序文件），含缺清单 / 坏清单 / 坏文件；
//   5) 清单结构校验（自引用、非法哈希、缺失字段）。
//
// 全部离线：远端 API 用 127.0.0.1 假服务；不访问真实 GitHub。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_REL, validateManifestShape, manifestScopeProblems, describeManifestDiff,
} from './release-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_SCRIPT = path.join(ROOT, 'scripts/release-manifest.mjs');
const REMOTE_SCRIPT = path.join(ROOT, 'scripts/verify-remote-manifest.mjs');

let failures = 0;
function ok(cond, label, extra = '') {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}${extra ? ` — ${extra}` : ''}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-manifest-guard-'));
const output = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// ── Git blob 物化（等价于“无文本转换的归档”）────────────────────────────────
function lsTree(ref) {
  const out = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '-z', '--full-tree', ref], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  });
  return out.toString('utf8').split(String.fromCharCode(0)).filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, rel: line.slice(tab + 1) };
  }).filter((e) => e.type === 'blob');
}

function catBlobs(shas) {
  const unique = [...new Set(shas)];
  const input = unique.join('\n') + '\n';
  const out = execFileSync('git', ['-C', ROOT, 'cat-file', '--batch'], { input, maxBuffer: 256 * 1024 * 1024 });
  const map = new Map();
  let offset = 0;
  for (const sha of unique) {
    const nl = out.indexOf(10, offset);
    if (nl < 0) throw new Error(`cat-file 输出不完整：${sha}`);
    const size = Number(out.slice(offset, nl).toString('utf8').split(' ')[2]);
    const start = nl + 1;
    map.set(sha, Buffer.from(out.subarray(start, start + size)));
    offset = start + size + 1;
  }
  return map;
}

function materialize(ref, dir) {
  const entries = lsTree(ref);
  const contents = catBlobs(entries.map((e) => e.sha));
  for (const entry of entries) {
    const abs = path.resolve(dir, entry.rel);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error(`不安全的树路径：${entry.rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents.get(entry.sha));
  }
  return { entries, contents };
}

function freshCandidate(name) {
  const dir = path.join(tmpRoot, name);
  materialize('HEAD', dir);
  return dir;
}

function runRelease(args, cwd = tmpRoot) {
  return spawnSync(process.execPath, [RELEASE_SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GH_TOKEN: '' },
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

// ── 1) 目录校验正例 + 指定 ref（cwd 在仓库外，模拟另一个 checkout）──────────
{
  const dir = freshCandidate('positive');
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status === 0, '目录校验正例退出 0', output(r));
  ok(/不符 0 \| 缺失 0/.test(r.stdout), '正例输出“不符 0 | 缺失 0”', r.stdout);

  const rDefault = runRelease(['--verify', dir]);
  ok(rDefault.status === 0, '目录校验默认 ref=HEAD 仍可用', output(rDefault));

  const headSha = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const rSha = runRelease(['--verify', dir, '--ref', headSha]);
  ok(rSha.status === 0, '显式提交 SHA 校验正例退出 0', output(rSha));

  const rRef = runRelease(['--verify-ref', headSha]);
  ok(rRef.status === 0 && /问题 0 个/.test(rRef.stdout), '--verify-ref 显式 SHA 问题 0 个', output(rRef));
}

// ── 2) 四种异常：必须非零退出且报出路径 ──────────────────────────────────────
{
  const dir = freshCandidate('missing-manifest');
  fs.rmSync(path.join(dir, MANIFEST_REL));
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status !== 0, '缺包内清单：非零退出', output(r));
  ok(output(r).includes(MANIFEST_REL), '缺包内清单：错误包含清单路径', output(r));
}
{
  const dir = freshCandidate('invalid-manifest');
  fs.writeFileSync(path.join(dir, MANIFEST_REL), '{ this is not json\n');
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status !== 0, '无效清单：非零退出', output(r));
  ok(output(r).includes(MANIFEST_REL), '无效清单：错误包含清单路径', output(r));
}
{
  const dir = freshCandidate('deleted-entry');
  const manifestAbs = path.join(dir, MANIFEST_REL);
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  delete manifest.files['package.json'];
  fs.writeFileSync(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(dir, 'package.json'));
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status !== 0, '清单删条 + 数据文件同步缺失：非零退出', output(r));
  ok(output(r).includes(MANIFEST_REL), '清单删条：错误包含清单路径', output(r));
  ok(output(r).includes('package.json'), '清单删条：错误包含被删条目路径', output(r));
}
{
  const dir = freshCandidate('bad-file');
  fs.appendFileSync(path.join(dir, 'package.json'), ' ');
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status !== 0, '单文件内容错误：非零退出', output(r));
  ok(output(r).includes('package.json'), '单文件内容错误：错误包含文件路径', output(r));
}
{
  // 清单未动、只删数据文件：逐文件缺失分支也要有路径。
  const dir = freshCandidate('missing-file');
  fs.rmSync(path.join(dir, 'package.json'));
  const r = runRelease(['--verify', dir, '--ref', 'HEAD']);
  ok(r.status !== 0, '数据文件缺失：非零退出', output(r));
  ok(/缺失：package\.json/.test(r.stdout), '数据文件缺失：输出缺失路径', r.stdout);
}

// ── 3) 清单结构自检（两个校验分支共用的纯函数）───────────────────────────────
{
  const tooMuch = validateManifestShape({ schemaVersion: 2, version: '', files: { [MANIFEST_REL]: 'x' } });
  ok(tooMuch.some((p) => p.includes('schemaVersion')), '结构校验：schemaVersion 异常');
  ok(tooMuch.some((p) => p.includes('version')), '结构校验：version 异常');
  ok(tooMuch.some((p) => p.includes(MANIFEST_REL)), '结构校验：检出清单自引用');
  ok(tooMuch.some((p) => p.includes('sha256')), '结构校验：检出非法哈希');
  ok(validateManifestShape(null).length > 0, '结构校验：非对象被拒');
  ok(validateManifestShape({ schemaVersion: 1, version: '1.0.0', files: {} }).length > 0, '结构校验：空 files 被拒');

  const scope = manifestScopeProblems({ a: 'x' }, ['a', 'b']);
  ok(scope.some((p) => p.includes('清单缺少：b')), '范围校验：检出被删条目');
  ok(manifestScopeProblems({ a: 'x' }, ['a', 'b', 'c']).length === 2, '范围校验：只报缺失项');
  const diff = describeManifestDiff(
    Buffer.from(JSON.stringify({ version: '1', files: { a: 'x', b: 'y' } })),
    Buffer.from(JSON.stringify({ version: '1', files: { a: 'x', c: 'z' } })),
  );
  ok(diff.some((p) => p.includes('多出条目：b')) && diff.some((p) => p.includes('缺少条目：c')), '字节差异：给出具体条目路径');
}

// ── 4) 05 行尾：工作区 / staged / 归档三者一致且为 CRLF ──────────────────────
// 审核 05 的实际清单：3 个 ASCII 启停脚本 + 2 个中文名停服脚本被 `*.bat text eol=crlf`
// 在归档阶段转成 CRLF，而 blob 是 LF。另把 2 个 .ps1 一并冻结为 CRLF 字节。
const WINDOWS_SCRIPTS = [
  'restart.bat',
  'start-with-dsh-port.bat',
  'start.bat',
  '停止QQ机器人-全部.bat',
  '停止QQ机器人.bat',
  'scripts/bootstrap.ps1',
  'scripts/stop-qq-bot.ps1',
];

function hasOnlyCrlf(buf) {
  const s = buf.toString('latin1');
  return s.includes('\r\n') && !/(^|[^\r])\n/.test(s) && !/\r(?!\n)/.test(s);
}

{
  const eolDir = path.join(tmpRoot, 'eol');
  fs.mkdirSync(eolDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: eolDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: eolDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: eolDir });
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(eolDir, '.gitattributes'));
  const worktree = new Map();
  for (const rel of WINDOWS_SCRIPTS) {
    const abs = path.join(eolDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = fs.readFileSync(path.join(ROOT, rel));
    fs.writeFileSync(abs, buf);
    worktree.set(rel, buf);
  }
  execFileSync('git', ['add', '-A'], { cwd: eolDir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: eolDir });
  const outDir = path.join(eolDir, 'out');
  fs.mkdirSync(outDir);
  execFileSync('git', ['archive', '--format=tar', 'HEAD', '-o', path.join(eolDir, 'a.tar')], { cwd: eolDir });
  execFileSync('tar', ['-xf', path.join(eolDir, 'a.tar')], { cwd: outDir });

  let allMatch = true;
  let allCrlf = true;
  for (const rel of WINDOWS_SCRIPTS) {
    const archived = fs.readFileSync(path.join(outDir, rel));
    const staged = execFileSync('git', ['show', `:${rel}`], { cwd: eolDir, maxBuffer: 32 * 1024 * 1024 });
    const wt = worktree.get(rel);
    if (!wt.equals(staged) || !staged.equals(archived)) allMatch = false;
    if (!hasOnlyCrlf(wt) || !hasOnlyCrlf(archived)) allCrlf = false;
    const attr = execFileSync('git', ['-c', 'core.quotepath=false', 'check-attr', 'text', 'eol', '--', rel], { cwd: ROOT, encoding: 'utf8' });
    if (!new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*text: unset`).test(attr) || !/eol: crlf/.test(attr)) allMatch = false;
  }
  ok(allMatch, '05：7 个 Windows 脚本 工作区=staged=归档 且 text 关闭/eol=crlf');
  ok(allCrlf, '05：7 个 Windows 脚本归档字节为纯 CRLF');
}

// ── 5) 合成远端 API：verify-remote-manifest 两个分支 ──────────────────────────
const { entries: headEntries, contents: headContents } = materialize('HEAD', path.join(tmpRoot, '_scratch'));
const remoteManifestBuf = headContents.get(headEntries.find((e) => e.rel === MANIFEST_REL).sha);
const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

function makeTree(entries) {
  return entries.map((e) => ({ path: e.rel, type: 'blob', sha: e.sha }));
}

function startFakeApi({ tree, blobs }) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const send = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/repos/fixture/repo/git/ref/tags/v1') return send({ object: { sha: COMMIT_SHA, type: 'commit' } });
    if (p === `/repos/fixture/repo/git/commits/${COMMIT_SHA}`) return send({ sha: COMMIT_SHA, tree: { sha: TREE_SHA } });
    if (p === `/repos/fixture/repo/git/trees/${TREE_SHA}`) return send({ sha: TREE_SHA, tree });
    const m = p.match(/^\/repos\/fixture\/repo\/git\/blobs\/([0-9a-f]+)$/);
    if (m) {
      const buf = blobs.get(m[1]);
      if (!buf) { res.writeHead(404); res.end('{}'); return undefined; }
      return send({ content: buf.toString('base64'), encoding: 'base64' });
    }
    res.writeHead(404);
    res.end('{}');
    return undefined;
  });
  return listen(server).then((port) => ({ server, port }));
}

async function withFakeApi(spec, fn) {
  const { server, port } = await startFakeApi(spec);
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// 远端校验必须用异步 spawn：假 API 服务器跑在本进程事件循环里，
// spawnSync 会阻塞事件循环导致服务器无法响应，子进程只能等到 30s 超时。
function runRemote(args, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REMOTE_SCRIPT, 'fixture/repo', 'v1', ...args], {
      cwd: tmpRoot,
      env: { ...process.env, GH_TOKEN: '', SURFCORE_GITHUB_API_BASE: `http://127.0.0.1:${port}` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

try {
  // 正例：远端清单与 HEAD 清单逐字节一致，全部 blob 哈希匹配。
  await withFakeApi({ tree: makeTree(headEntries), blobs: headContents }, async (port) => {
    const r = await runRemote(['--expected-ref', 'HEAD'], port);
    ok(r.status === 0, '远端正例退出 0', output(r));
    ok(/不符 0 · 缺失 0/.test(r.stdout), '远端正例输出“不符 0 · 缺失 0”', r.stdout);
    const rDefault = await runRemote([], port);
    ok(rDefault.status === 0, '远端默认 expected-ref=HEAD 仍可用', output(rDefault));
  });

  // 缺远端清单。
  await withFakeApi({
    tree: makeTree(headEntries.filter((e) => e.rel !== MANIFEST_REL)),
    blobs: headContents,
  }, async (port) => {
    const r = await runRemote([], port);
    ok(r.status !== 0, '远端缺清单：非零退出', output(r));
    ok(output(r).includes(MANIFEST_REL), '远端缺清单：错误包含清单路径', output(r));
  });

  // 远端清单被篡改（与预期对象不一致）。
  {
    const tampered = Buffer.from(`${JSON.stringify({ ...JSON.parse(remoteManifestBuf.toString('utf8')), version: '9.9.9' }, null, 2)}\n`);
    const tamperedSha = 'c'.repeat(40);
    const blobs = new Map(headContents);
    blobs.set(tamperedSha, tampered);
    const tree = makeTree(headEntries).map((e) => (e.path === MANIFEST_REL ? { ...e, sha: tamperedSha } : e));
    await withFakeApi({ tree, blobs }, async (port) => {
      const r = await runRemote([], port);
      ok(r.status !== 0, '远端坏清单：非零退出', output(r));
      ok(output(r).includes(MANIFEST_REL), '远端坏清单：错误包含清单路径', output(r));
      ok(/不一致/.test(output(r)), '远端坏清单：指出与预期对象不一致', output(r));
    });
  }

  // 远端删条目 + 数据文件同步删除：不能因为“清单里没有”就漏过。
  {
    const manifest = JSON.parse(remoteManifestBuf.toString('utf8'));
    delete manifest.files['package.json'];
    const tampered = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const tamperedSha = 'd'.repeat(40);
    const blobs = new Map(headContents);
    blobs.set(tamperedSha, tampered);
    const tree = makeTree(headEntries.filter((e) => e.rel !== 'package.json'))
      .map((e) => (e.path === MANIFEST_REL ? { ...e, sha: tamperedSha } : e));
    await withFakeApi({ tree, blobs }, async (port) => {
      const r = await runRemote([], port);
      ok(r.status !== 0, '远端删条+删文件：非零退出', output(r));
      ok(output(r).includes('package.json'), '远端删条+删文件：错误包含被删条目路径', output(r));
    });
  }

  // 远端单文件字节错误（清单不变，blob 内容被换）。
  {
    const victim = headEntries.find((e) => e.rel === 'package.json');
    const blobs = new Map(headContents);
    blobs.set(victim.sha, Buffer.from('tampered content\n'));
    await withFakeApi({ tree: makeTree(headEntries), blobs }, async (port) => {
      const r = await runRemote([], port);
      ok(r.status !== 0, '远端单文件错误：非零退出', output(r));
      ok(output(r).includes('不符：package.json'), '远端单文件错误：报出文件路径', output(r));
    });
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n✅ test-release-manifest-guard 通过');
