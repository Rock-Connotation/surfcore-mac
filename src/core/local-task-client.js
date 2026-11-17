// 桥接 → Host 的本机任务通道客户端。和 `memory-v2-client.js` 同源做法：
// 每次请求都重读发现文件（Host 重启会换令牌/端口），只接受回环地址，
// 请求体与响应体都有字节上限，超时一律按"不知道结果"返回，绝不自动重发。
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = '/dsh-surfcore/local-task-api'
const fail = (code, error, hint) => ({ ok: false, code, error, hint })

function discovery(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error()
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    const base = new URL(value.baseUrl)
    if (value.version !== 1 || value.api !== PREFIX || value.scope !== 'qq' || !/^[a-f0-9]{64}$/.test(value.token ?? '') || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.pathname !== '/' || base.search || base.hash) throw new Error()
    return { url: `${base.origin}${PREFIX}`, token: value.token }
  } catch {
    throw fail('LOCAL_TASK_DISCOVERY_INVALID', '找不到或读不懂本机任务通道的发现文件', '确认 DSH 桌面端在运行；必要时重启 DSH 重新生成发现文件')
  }
}

export function createLocalTaskClient({ stateDir, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const file = path.join(stateDir ?? '', 'local-task', 'qq.json')
  if (!path.isAbsolute(file) || typeof fetchImpl !== 'function') throw new TypeError('Invalid local task client configuration.')
  async function request(body) {
    let target
    try { target = discovery(file) } catch (error) { return error }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(target.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-local-task-token': target.token },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const result = await response.json()
      if (!result || typeof result.ok !== 'boolean') return fail('LOCAL_TASK_RESPONSE_INVALID', '本机任务通道返回了看不懂的数据', '重启 DSH 后重试')
      return result
    } catch {
      // 超时/断连时我们不知道 Host 有没有处理：如实告诉用户"可能已受理"，不自动重发。
      return fail('LOCAL_TASK_HOST_UNAVAILABLE', '本机任务通道没有响应', '先发「本机任务列表」确认有没有这条；不要重复发送同一条任务')
    } finally { clearTimeout(timer) }
  }
  return Object.freeze({
    submit: (input) => request({ action: 'submit', ...input }),
    query: (taskId) => request({ action: 'query', ...(taskId ? { taskId } : {}) }),
    cancel: (taskId) => request({ action: 'cancel', ...(taskId ? { taskId } : {}) }),
  })
}
