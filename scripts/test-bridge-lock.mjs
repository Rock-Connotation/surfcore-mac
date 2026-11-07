import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
const source = fs.readFileSync(fileURLToPath(new URL('../src/bridge.js', import.meta.url)), 'utf8')
const start = source.indexOf('const LOCK_FILE = path.join(STATE_DIR, \'bridge.lock\');')
const end = source.indexOf('// ── 工具', start)
assert.ok(start >= 0 && end > start)
const code = source.slice(start, end) + '\nglobalThis.testApi = { consolePortInUse, acquireLock, releaseLock }'
const failures = []
function scenario(name, fn) { try { fn(); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) } }
function harness({ platform = 'linux', command = () => '', alive = true, denied = false, replaceOnRecovery = false, port = 3100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-test-'))
  const proc = { platform, pid: 4242, kill() { if (denied) { const error = new Error('denied'); error.code = 'EPERM'; throw error } if (!alive) { const error = new Error('missing'); error.code = 'ESRCH'; throw error } }, exit(code) { throw Object.assign(new Error(`exit ${code}`), { exitCode: code }) } }
  const mockFs = replaceOnRecovery ? { ...fs, mkdirSync(p, options) { const value = fs.mkdirSync(p, options); if (String(p).endsWith('.recovery')) { fs.renameSync(path.join(dir, 'bridge.lock'), path.join(dir, 'original-saved')); fs.writeFileSync(path.join(dir, 'bridge.lock'), '7777') } return value } } : fs
  const messages = []
  const context = vm.createContext({ fs: mockFs, path, crypto, STATE_DIR: dir, CONFIG_FILE: 'unused', readJsonSafe: () => ({ consolePort: port }), process: proc, console: { error(message) { messages.push(message) } }, execFileSync: command })
  vm.runInContext(code, context)
  return { ...context.testApi, lock: path.join(dir, 'bridge.lock'), dir, messages }
}
scenario('failed POSIX commands are unknown and fail closed', () => { const h = harness({ command: program => { if (program === 'sh') return ''; throw new Error('unavailable') } }); assert.equal(h.consolePortInUse(), true) })
scenario('ESTABLISHED connection is not LISTEN', () => { const h = harness({ command: () => 'tcp4 0 0 127.0.0.1.3100 127.0.0.1.55100 ESTABLISHED\n' }); assert.equal(h.consolePortInUse(), false) })
scenario('LISTEN is detected', () => { const h = harness({ command: () => 'tcp4 0 0 127.0.0.1.3100 *.* LISTEN\n' }); assert.equal(h.consolePortInUse(), true) })
scenario('live pre-listen owner retains lock', () => { const h = harness({ command: () => '' }); fs.writeFileSync(h.lock, '1234'); try { h.acquireLock() } catch {} assert.equal(fs.readFileSync(h.lock, 'utf8'), '1234') })
scenario('empty POSIX output is unknown', () => { const h = harness({ command: () => '' }); assert.equal(h.consolePortInUse(), true) })
scenario('malformed row is unknown', () => { const h = harness({ command: () => 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN broken\n' }); assert.equal(h.consolePortInUse(), true) })
scenario('header-only is confirmed no listener', () => { const h = harness({ command: () => 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n' }); assert.equal(h.consolePortInUse(), false) })
scenario('Linux ss exact listening port', () => { const h = harness({ command: () => 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:3100 0.0.0.0:*\n' }); assert.equal(h.consolePortInUse(), true) })
scenario('Darwin netstat exact listening port', () => { const h = harness({ platform:'darwin', command: () => 'Proto Recv-Q Send-Q Local Address Foreign Address (state)\ntcp4 0 0 127.0.0.1.3100 *.* LISTEN\n' }); assert.equal(h.consolePortInUse(), true) })
scenario('fallback when ss fails', () => { const h = harness({ command: p => { if(p === 'ss') throw new Error('not found'); return 'Proto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 127.0.0.1:3100 0.0.0.0:* LISTEN\n' } }); assert.equal(h.consolePortInUse(), true) })
scenario('EPERM cannot displace live POSIX owner', () => { const h = harness({denied:true, command: () => 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n'}); fs.writeFileSync(h.lock,'1234'); try { h.acquireLock() } catch {} assert.equal(fs.readFileSync(h.lock,'utf8'),'1234') })
for (const content of ['', 'not-a-pid']) scenario(`POSIX incomplete lock ${JSON.stringify(content)} is preserved`, () => { const h = harness({alive:false}); fs.writeFileSync(h.lock,content); assert.throws(() => h.acquireLock(), {exitCode:2}); assert.ok(h.messages.some(x => x.includes('归档') && x.includes('启动进程'))); assert.equal(fs.readFileSync(h.lock,'utf8'),content); assert.ok(!fs.readdirSync(h.dir).some(x => x.startsWith('bridge.lock.stale-'))) })
scenario('Windows legacy empty lock can be archived', () => { const h = harness({platform:'win32'}); fs.writeFileSync(h.lock,''); h.acquireLock(); assert.equal(fs.readFileSync(h.lock,'utf8'),'4242'); assert.ok(fs.readdirSync(h.dir).some(x => x.startsWith('bridge.lock.stale-'))) })
scenario('dead owner is archived and lock acquired', () => { const h = harness({alive:false}); fs.writeFileSync(h.lock,'1234'); h.acquireLock(); assert.equal(fs.readFileSync(h.lock,'utf8'),'4242'); const archive=fs.readdirSync(h.dir).find(x=>x.startsWith('bridge.lock.stale-')); assert.ok(archive); assert.equal(fs.readFileSync(path.join(h.dir,archive),'utf8'),'1234'); h.releaseLock(); assert.ok(!fs.existsSync(h.lock)); assert.ok(fs.existsSync(path.join(h.dir,archive))) })
scenario('competing recovery cannot replace lock', () => { const h = harness({alive:false}); fs.writeFileSync(h.lock,'1234'); fs.mkdirSync(h.lock+'.recovery'); try { h.acquireLock() } catch {} assert.equal(fs.readFileSync(h.lock,'utf8'),'1234') })
scenario('replacement while waiting for recovery is not displaced', () => { const h = harness({alive:false,replaceOnRecovery:true}); fs.writeFileSync(h.lock,'1234'); try { h.acquireLock() } catch {} assert.equal(fs.readFileSync(h.lock,'utf8'),'7777'); assert.equal(fs.readFileSync(path.join(h.dir,'original-saved'),'utf8'),'1234') })
scenario('other listener port does not match', () => { const h = harness({command: () => 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 127.0.0.1:13100 0.0.0.0:*\n'}); assert.equal(h.consolePortInUse(),false) })
scenario('Windows existing probe retained', () => { const h = harness({platform:'win32', command: () => 'TCP  0.0.0.0:3100  0.0.0.0:0  LISTENING 1234\n'}); assert.equal(h.consolePortInUse(),true); fs.writeFileSync(h.lock,'1234'); try { h.acquireLock() } catch {} assert.equal(fs.readFileSync(h.lock,'utf8'),'1234') })
// Owned ephemeral loopback listener: no real bridge, account, or network service.
if (process.platform === 'darwin') {
  const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'] })
  try {
    const [chunk] = await once(child.stdout, 'data'); const port = Number(String(chunk).trim()); assert.ok(port > 0)
    scenario('actual owned loopback listener detected', () => { const h = harness({platform:'darwin', port, command: execFileSync}); assert.equal(h.consolePortInUse(),true) })
  } finally { child.kill(); await once(child,'exit') }
}
if (failures.length) { console.error(`${failures.length} failed`); process.exitCode = 1 }
