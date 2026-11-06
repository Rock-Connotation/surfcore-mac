#!/usr/bin/env node
// Preserve the source layout inside the artifact; no imports escape its package root.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const ref = option('--ref', 'HEAD');
const output = path.resolve(option('--out', path.join(root, '_backups', `plugin-package-${Date.now()}`)));
if (fs.existsSync(output)) throw new Error('输出目录已存在，请选择新目录以保留原制品');
const git = (...argv) => execFileSync('git', ['-C', root, ...argv], { maxBuffer: 64 * 1024 * 1024 });
const commit = git('rev-parse', `${ref}^{commit}`).toString().trim();
const files = git('ls-tree', '-rz', '--name-only', commit).toString().split('\0').filter(Boolean);
const pluginPrefix = 'plugins/surfcore/';
const payload = path.join(output, 'package');
fs.mkdirSync(payload, { recursive: true });
const hashes = {};
function put(relative, bytes, mode = 0o644) {
  const target = path.join(payload, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode });
  hashes[relative] = crypto.createHash('sha256').update(bytes).digest('hex');
}
for (const relative of files) {
  if (!(/^(src|scripts|dsh)\//.test(relative) || relative.startsWith(pluginPrefix) || ['config.example.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(relative))) continue;
  if (relative.startsWith('scripts/test-') || relative.startsWith('scripts/probe-') || relative.startsWith(`${pluginPrefix}scripts/`)) continue;
  let bytes = git('show', `${commit}:${relative}`);
  if (relative === `${pluginPrefix}cordis.patch.yml`) {
    bytes = Buffer.from(bytes.toString().replace(/(\bname:\s*)\.\//g, `$1./${pluginPrefix}`));
  }
  const tree = git('ls-tree', commit, '--', relative).toString();
  if (tree.startsWith('120000')) throw new Error(`制品不接受源码符号链接：${relative}`);
  put(relative, bytes, tree.startsWith('100755') ? 0o755 : 0o644);
}
const source = JSON.parse(git('show', `${commit}:package.json`));
const plugin = JSON.parse(git('show', `${commit}:${pluginPrefix}package.json`));
const prefixPaths = (value) => typeof value === 'string' && value.startsWith('./') ? `./${pluginPrefix}${value.slice(2)}`
  : Array.isArray(value) ? value.map(prefixPaths)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, prefixPaths(v)])) : value;
const metadata = { ...plugin, main: prefixPaths(plugin.main), exports: prefixPaths(plugin.exports), dsh: prefixPaths(plugin.dsh),
  scripts: { postinstall: source.scripts.postinstall }, dependencies: { ...source.dependencies, ...plugin.dependencies },
  bundledDependencies: Object.keys({ ...source.dependencies, ...plugin.dependencies }),
  files: ['src', 'scripts', 'dsh', 'plugins', 'config.example.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.surfcore-install.json', 'artifact-manifest.json', 'npm-shrinkwrap.json'] };
put('package.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
const lock = JSON.parse(git('show', `${commit}:package-lock.json`));
lock.name = plugin.name;
lock.version = plugin.version;
lock.packages[''].version = plugin.version;
lock.packages[''].name = plugin.name;
lock.packages[''].dependencies = metadata.dependencies;
put('npm-shrinkwrap.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n'));
put('.surfcore-install.json', Buffer.from(JSON.stringify({ schemaVersion: 1, sourceRepo: 'Rock-Connotation/surfcore-mac', sourceCommit: commit,
  version: plugin.version, kind: 'package', updateOwner: 'dsh-package-manager' }, null, 2) + '\n'));
put('artifact-manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, sourceCommit: commit, files: { ...hashes } }, null, 2) + '\n'));
// npm ignores .npmrc in published packages; freeze the original legacy-peer-deps graph here
// and bundle the installed runtime dependencies so the consumer needs no implicit flags.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: payload, stdio: 'inherit' });
console.log(JSON.stringify({ sourceCommit: commit, payload, files: Object.keys(hashes).length, bundled: metadata.bundledDependencies }));
