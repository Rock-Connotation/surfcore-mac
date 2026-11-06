import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveQqDataPaths } from '../src/qq-data-paths.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore 包数据 '));
const dshHome = path.join(tmp, '隔离 dsh');
const repo = path.resolve(import.meta.dirname, '..');
function makePackage(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'plugins/surfcore'), { recursive: true });
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(repo, 'plugins/surfcore/lib'), path.join(root, 'plugins/surfcore/lib'), { recursive: true });
  fs.cpSync(path.join(repo, 'plugins/surfcore/tools/lib'), path.join(root, 'plugins/surfcore/tools/lib'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(root, 'config.example.json'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'surfcore', version: '0.8.8', type: 'module' }));
  fs.writeFileSync(path.join(root, '.surfcore-install.json'), JSON.stringify({ schemaVersion: 1, kind: 'package', sourceRepo: 'fixture', updateOwner: 'dsh-package-manager' }));
  return root;
}
function runStore(root, action, cwd = root) {
  const target = pathToFileURL(path.join(root, 'plugins/surfcore/lib/store.js')).href;
  const program = action === 'save'
    ? `const s=await import(${JSON.stringify(target)}); s.saveQqConfig({ownerQQ:'1000000001'});`
    : `const s=await import(${JSON.stringify(target)}); if(s.readQqConfig().config.ownerQQ !== '1000000001') process.exit(9);`;
  const env = { ...process.env, HOME: tmp, DSH_HOME: dshHome };
  delete env.SURFCORE_ROOT; delete env.SURFCORE_QQBOT_ROOT; delete env.QQBILI_QQBOT_ROOT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd, env, encoding: 'utf8' });
  assert.equal(child.status, 0, `isolated store ${action} failed: ${child.stderr}`);
  assert.equal(child.stdout, '');
}
const first = makePackage('程序 甲');
const env = { HOME: tmp, DSH_HOME: dshHome };
const data = resolveQqDataPaths({ programRoot: first, env });
assert.equal(data.kind, 'package');
assert.equal(data.installationKind, 'package');
assert.equal(data.config, path.join(dshHome, 'surfcore', 'qq', 'config.json'));
assert.equal(data.stateDir, path.join(dshHome, 'surfcore', 'qq', 'state'));
assert.equal(data.personaDir, path.join(dshHome, 'surfcore', 'qq', 'roles'));
assert.notEqual(data.config, path.join(dshHome, 'surfcore', 'config.json'));
runStore(first, 'save');
fs.mkdirSync(data.stateDir, { recursive: true }); fs.writeFileSync(path.join(data.stateDir, 'fixture.json'), '{"kept":true}');
fs.mkdirSync(data.personaDir, { recursive: true }); fs.writeFileSync(path.join(data.personaDir, '角色卡.md'), 'fixture role');
const second = makePackage('程序 乙');
const replacement = resolveQqDataPaths({ programRoot: second, env });
assert.equal(replacement.config, data.config);
assert.equal(fs.readFileSync(path.join(replacement.stateDir, 'fixture.json'), 'utf8'), '{"kept":true}');
assert.equal(fs.readFileSync(path.join(replacement.personaDir, '角色卡.md'), 'utf8'), 'fixture role');
runStore(second, 'read');
const unrelated = path.join(tmp, '无关工作目录'); fs.mkdirSync(path.join(unrelated, 'src'), { recursive: true });
fs.writeFileSync(path.join(unrelated, 'src/bridge.js'), ''); fs.writeFileSync(path.join(unrelated, 'config.json'), '{}');
runStore(second, 'read', unrelated);
const source = path.join(tmp, '源码'); fs.mkdirSync(source);
assert.equal(resolveQqDataPaths({ programRoot: source, env }).config, path.join(source, 'config.json'));
const legacy = path.join(tmp, '显式 旧根'); fs.mkdirSync(path.join(legacy, 'src'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'src/bridge.js'), 'legacy bridge'); fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ownerQQ:'1000000002'}));
fs.mkdirSync(path.join(legacy, 'state')); fs.writeFileSync(path.join(legacy, 'state', 'fixture.json'), 'legacy state');
for (const key of ['SURFCORE_ROOT', 'SURFCORE_QQBOT_ROOT', 'QQBILI_QQBOT_ROOT']) {
  const explicit = resolveQqDataPaths({ programRoot: second, env: { ...env, [key]: legacy } });
  assert.equal(explicit.kind, 'explicit-legacy'); assert.equal(explicit.installationKind, 'package'); assert.equal(explicit.config, path.join(legacy, 'config.json'));
  const pathsUrl = pathToFileURL(path.join(second, 'plugins/surfcore/lib/paths.js')).href;
  const storeUrl = pathToFileURL(path.join(second, 'plugins/surfcore/lib/store.js')).href;
  const identityUrl = pathToFileURL(path.join(second, 'src/install-identity.js')).href;
  const program = `const fs=await import('node:fs'); const path=await import('node:path'); const p=await import(${JSON.stringify(pathsUrl)}); const s=await import(${JSON.stringify(storeUrl)}); const i=await import(${JSON.stringify(identityUrl)}); const expected=process.env.EXPECTED_ROOT, old=process.env.EXPECTED_LEGACY; const checks=[p.QQBOT_ROOT===expected,p.QQ_CONFIG===path.join(old,'config.json'),p.QQ_STATE_DIR===path.join(old,'state'),p.QQ_CONFIG_EXAMPLE===path.join(expected,'config.example.json'),i.readInstallationIdentity(p.QQBOT_ROOT).identity?.kind==='package',String(s.readQqConfig().config.ownerQQ)==='1000000002',fs.readFileSync(path.join(p.QQ_STATE_DIR,'fixture.json'),'utf8')==='legacy state',fs.readFileSync(path.join(p.QQBOT_ROOT,'src','bridge.js'),'utf8').includes('resolveQqDataPaths')]; if(checks.some(x=>!x)){process.stderr.write(JSON.stringify(checks));process.exit(9);}`;
  const childEnv = { ...process.env, HOME: tmp, DSH_HOME: dshHome, EXPECTED_ROOT: fs.realpathSync(second), EXPECTED_LEGACY: legacy };
  delete childEnv.SURFCORE_ROOT; delete childEnv.SURFCORE_QQBOT_ROOT; delete childEnv.QQBILI_QQBOT_ROOT; childEnv[key] = legacy;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: unrelated, env: childEnv, encoding: 'utf8' });
  assert.equal(child.status, 0, `package + ${key} must retain program root: ${child.stderr}`); assert.equal(child.stdout, '');
}
fs.writeFileSync(path.join(second, 'config.json'), '{"legacy":true}');
assert.throws(() => resolveQqDataPaths({ programRoot: second, env }), (error) => error.code === 'QQ_PACKAGE_LEGACY_DATA_FOUND' && error.message.includes(error.code) && error.message.includes(error.hint));
assert.equal(fs.readFileSync(path.join(second, 'config.json'), 'utf8'), '{"legacy":true}');
for (const name of ['state', 'roles']) {
  const oldRoot = path.join(tmp, `legacy-${name}`); fs.mkdirSync(path.join(oldRoot, name), { recursive: true });
  fs.writeFileSync(path.join(oldRoot, 'package.json'), JSON.stringify({ name: 'surfcore', version: '1', type: 'module' }));
  fs.writeFileSync(path.join(oldRoot, '.surfcore-install.json'), JSON.stringify({ schemaVersion: 1, kind: 'package', sourceRepo: 'fixture', updateOwner: 'dsh-package-manager' }));
  fs.writeFileSync(path.join(oldRoot, name, 'old-data'), 'preserve');
  assert.throws(() => resolveQqDataPaths({ programRoot: oldRoot, env }), (error) => error.code === 'QQ_PACKAGE_LEGACY_DATA_FOUND' && error.message.includes(error.hint));
  assert.equal(fs.readFileSync(path.join(oldRoot, name, 'old-data'), 'utf8'), 'preserve');
}
console.log('PASS package QQ data survives replacement and legacy data remains intact');
