// 回归合同：plugins/surfcore/tools/bili.mjs 是「转发型包装进程」——收到 SIGTERM/SIGINT 后必须自己退出。
//
// 现场（2026-11-15 G7 实机取证，见 docs/cases/2026-11-15-mac-real-machine-g7-evidence.md）：
// 一个 `bili.mjs dm-await --once --json` 包装进程在子进程早已消失后仍存活 1.9 天，收到 SIGTERM 也不退出。
// 根因：旧 handler 只把信号转发给子进程，自己只在 child 'close' 里 process.exit —— 子进程不可中断/已消失时，
// 包装进程就永远活着（launchd 收养成 PPID=1 的孤儿）。
//
// 本测试用「故意忽略信号的子进程」把这个契约钉死：包装进程必须在有限时间内退出，并升级到 SIGKILL 清掉子进程。
// 子进程与包装脚本都放在隔离测试根里，仓库里的真实脚本不参与。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { testHome } from './isolate-test-home.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const sourceBili = path.join(repoRoot, 'plugins', 'surfcore', 'tools', 'bili.mjs')
const root = path.join(testHome, 'bili-cli-signal')
const pidFile = path.join(root, 'fake-child.pid')
const EXIT_GRACE_MS = 6000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function waitForExit(child, ms) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(ms).then(() => null),
  ])
}

let wrapper = null
let fakePid = null
let failed = false

try {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'tools', 'commands'), { recursive: true })
  fs.copyFileSync(sourceBili, path.join(root, 'tools', 'bili.mjs'))
  fs.writeFileSync(path.join(root, 'tools', 'commands', 'dm-await.mjs'), [
    "// 故意忽略 SIGTERM/SIGINT，模拟真实 CLI 卡在不可中断等待里的样子",
    "import fs from 'node:fs'",
    "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {})",
    "fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(process.pid))",
    "console.log('FAKE_CHILD_READY')",
    "setInterval(() => {}, 1000)",
    '',
  ].join('\n'))

  wrapper = spawn(process.execPath, [path.join(root, 'tools', 'bili.mjs'), 'dm-await', '--once', '--json'], {
    env: { ...process.env, FAKE_CHILD_PID_FILE: pidFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  wrapper.stdout.on('data', (chunk) => { stdout += String(chunk) })

  for (let i = 0; i < 100 && !stdout.includes('FAKE_CHILD_READY'); i += 1) await sleep(100)
  assert.ok(stdout.includes('FAKE_CHILD_READY'), '夹具子进程没能启动（包装进程没有 spawn 成功）')
  fakePid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  assert.ok(Number.isSafeInteger(fakePid) && fakePid > 0, '拿不到夹具子进程 PID')
  assert.ok(alive(fakePid), '夹具子进程应当先活着')

  wrapper.kill('SIGTERM')
  const exit = await waitForExit(wrapper, EXIT_GRACE_MS)
  assert.ok(exit, `包装进程收到 SIGTERM 后必须在 ${EXIT_GRACE_MS}ms 内退出（现在仍存活 → 会变成 PPID=1 的孤儿）`)
  assert.equal(exit.code, 143, `包装进程的退出码应当是 143（SIGTERM），实际 ${exit.code}`)

  for (let i = 0; i < 50 && alive(fakePid); i += 1) await sleep(100)
  assert.equal(alive(fakePid), false, '忽略信号的子进程必须被升级到 SIGKILL 清掉')

  console.log('PASS bili.mjs 包装进程：转发信号后自己退出，并升级清掉死扛的子进程')
} catch (error) {
  failed = true
  console.error(`FAIL ${error?.message || error}`)
} finally {
  try { if (wrapper && wrapper.exitCode === null) wrapper.kill('SIGKILL') } catch {}
  try { if (fakePid && alive(fakePid)) process.kill(fakePid, 'SIGKILL') } catch {}
  await sleep(200)
  fs.rmSync(root, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
