// 真实浏览器（Playwright Chromium）+ 真实插件 HTTP 路由（handleLocalTasks）+ 真实 client.js（LocalTasksTab）端到端测试。
// 全程使用临时 DSH_HOME 与本地回环 HTTP，绝不接触真实 ~/.dsh 或真实 QQ。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ui-'))
const qqRoot = path.join(tmp, 'qq-fixture')
const wsRoot = path.join(tmp, 'workspace')
fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'surfcore'), { recursive: true })
fs.mkdirSync(wsRoot, { recursive: true })
fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '')
fs.writeFileSync(path.join(tmp, 'surfcore', 'config.json'), JSON.stringify({ version: 1, platforms: { start: { qq: false, bili: false } } }))

process.env.DSH_HOME = tmp
process.env.USERPROFILE = tmp
process.env.SURFCORE_ROOT = qqRoot
process.env.SURFCORE_LOCAL_TASK_ROOT = wsRoot
process.env.SURFCORE_SKIP_AUTOSTART = '1'
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1'
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1'

let bridgeFail = true
let bridgeNotifyCount = 0
let sessionCounter = 0

const bridgeReqs = []
// 启动真实本地回环模拟桥接控制台，让插件的 real callBridge / deliver / redeliver 状态机全链路运行，不打桩覆写
const bridgeServer = http.createServer((req, res) => {
  bridgeReqs.push(`${req.method} ${req.url} fail=${bridgeFail}`)
  if (req.url === '/api/notify/owner' && req.method === 'POST') {
    if (bridgeFail) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bridge down (test injected)' }))
      return
    }
    bridgeNotifyCount += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, receipt: { messageId: 900 + bridgeNotifyCount } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
})
await new Promise((r) => bridgeServer.listen(0, '127.0.0.1', r))
const bridgePort = bridgeServer.address().port
fs.writeFileSync(path.join(qqRoot, 'config.json'), JSON.stringify({ consolePort: bridgePort }))

// 必须在设好 DSH_HOME / SURFCORE_ROOT 之后再动态加载插件模块，防止 paths.js 在静态 import 期缓存 ~/.dsh
const { findBrowser } = await import('../lib/bili-qr-login.mjs')
const { createLocalTaskGate } = await import('../lib/local-task-gate.mjs')
const { getLocalTasks } = await import('../lib/local-task-host.mjs')
const { apply: applyPlugin } = await import('../lib/index.js')

const routes = []
const effects = []
const listeners = []

function makeMockDomainStore(seed = []) {
  const store = new Map()
  for (const rec of seed) store.set(rec.taskId, rec)
  let rejectNext = false
  let unknownNext = false
  return {
    store,
    setUnknownNext(v) { unknownNext = v },
    setRejectNext(v) { rejectNext = v },
    async open(spec) {
      return {
        spec,
        table: () => ({
          get: (k) => store.get(k),
          keys: () => [...store.keys()],
          entries: () => [...store.entries()],
          get size() { return store.size },
          async put(k, v) {
            spec.tables.tasks.valueSchema.parse(v)
            if (unknownNext) {
              unknownNext = false
              const e = new Error('ambiguous write')
              e.code = 'unknown-state'
              throw e
            }
            if (rejectNext) {
              rejectNext = false
              throw new Error('simulated failure')
            }
            store.set(k, v)
          },
          async delete(k) { return store.delete(k) },
        }),
        async close() {},
      }
    },
  }
}

const domainFactory = makeMockDomainStore()

const services = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  connection: { requestRejection: () => false },
  storageDomain: domainFactory,
  agents: { get: (id) => ({ id, ctx: { preset: 'local-task' }, session: { id, header: { cwd: wsRoot } } }) },
  agentPresets: { composedPreset: (c) => c?.preset ?? 'local-task' },
  tools: {
    schemas: () => [{ name: 'read' }, { name: 'write' }],
    guard: () => () => {},
  },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({ sessionId: `sess-ui-${++sessionCounter}` }),
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
  },
}

const ctx = {
  ...services,
  get: (name) => services[name] ?? null,
  effect: (fn) => { effects.push(fn()); return () => {} },
  on: (name, fn) => { listeners.push({ name, fn }); return () => {} },
  inject(deps, cb) {
    const missing = deps.filter((d) => !services[d])
    if (missing.length) return () => {}
    cb({ ...ctx, ...services })
    return () => {}
  },
}

let disposeGate
createLocalTaskGate({ root: wsRoot }).apply({
  tools: services.tools,
  effect: (fn) => { disposeGate = fn() },
  on: ctx.on,
  get: ctx.get,
})

// 挂载真实 SurfCore 插件，使 `/dsh-surfcore/api/local-tasks` 与其他路由真实注册
applyPlugin(ctx)
await new Promise((r) => setTimeout(r, 50))

const lt = getLocalTasks()
assert.equal(lt.ok, true, '本机任务服务必须在插件加载后就绪')

// 用真实 service/runner 预置 2 条任务：
//   t1: 已完成但投递 uncertain（供设置页测试「补发结果」+「原生会话」）
//   t2: 运行中（供设置页测试「停止」按钮）
const actor = { platform: 'qq', botId: 'b1', channel: 'private', conversationId: 'owner', userId: 'owner-1' }
const sub1 = await lt.service.submitTask({
  trustedActor: actor,
  source: { botId: 'b1', channel: 'private', conversationId: 'owner', messageId: 'm1' },
  text: '把会议纪要整理成周报',
  workspaceId: 'w1',
})
await lt.runner.dispatch(sub1.task.taskId)
// 先标成 succeeded + uncertain delivery
await lt.service.finish({ taskId: sub1.task.taskId, status: 'succeeded', resultRefs: ['dsh-session:sess-ui-1'] })
await lt.service.recordDelivery({
  taskId: sub1.task.taskId,
  delivery: {
    deliveryId: 'dlv-uncertain-1',
    kind: 'result',
    recipient: { channel: 'private', userId: 'owner-1' },
    payload: '任务结果',
    state: 'uncertain',
    attemptedAt: new Date().toISOString(),
  },
})
const sub2 = await lt.service.submitTask({
  trustedActor: actor,
  source: { botId: 'b1', channel: 'private', conversationId: 'owner', messageId: 'm2' },
  text: '统计项目目录文档',
  workspaceId: 'w1',
})
await lt.runner.dispatch(sub2.task.taskId)

const clientJsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/client.js')
const clientJsSource = fs.readFileSync(clientJsPath, 'utf8')

// 极简可更新 DOM React 运行时，直接在真实 Chrome 中挂载并交互真实的 client.js
const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SurfCore LocalTasks UI Test</title></head>
<body>
<div id="root"></div>
<script>
(() => {
  const componentHooks = new Map();
  let currentHooks = null;
  let hookIdx = 0;
  let rootComp = null;
  let scheduled = false;
  const pendingEffects = [];

  function depsChanged(prev, next) {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return next.some((d, i) => !Object.is(d, prev[i]));
  }

  function getHooksFor(pathKey, fn) {
    let entry = componentHooks.get(pathKey);
    if (!entry || entry.fn !== fn) {
      if (entry) {
        for (const h of entry.slots) { try { h?.cleanup?.(); } catch {} }
      }
      entry = { fn, slots: [] };
      componentHooks.set(pathKey, entry);
    }
    return entry.slots;
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => {
        if (Array.isArray(c)) c.forEach(push);
        else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
      };
      children.forEach(push);
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const slots = currentHooks;
      const idx = hookIdx++;
      if (!(idx in slots)) {
        const slot = { value: typeof init === 'function' ? init() : init };
        slot.set = (next) => {
          const val = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(val, slot.value)) {
            slot.value = val;
            schedule();
          }
        };
        slots[idx] = slot;
      }
      return [slots[idx].value, slots[idx].set];
    },
    useRef(init) {
      const slots = currentHooks;
      const idx = hookIdx++;
      if (!(idx in slots)) slots[idx] = { current: init };
      return slots[idx];
    },
    useCallback(fn, deps) {
      const slots = currentHooks;
      const idx = hookIdx++;
      const prev = slots[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        slots[idx] = { fn, deps };
      }
      return slots[idx].fn;
    },
    useMemo(fn, deps) {
      const slots = currentHooks;
      const idx = hookIdx++;
      const prev = slots[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        slots[idx] = { val: fn(), deps };
      }
      return slots[idx].val;
    },
    useEffect(fn, deps) {
      const slots = currentHooks;
      const idx = hookIdx++;
      const prev = slots[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        slots[idx] = { deps, cleanup: prev?.cleanup };
        pendingEffects.push({ slot: slots[idx], fn });
      }
    },
  };

  function toDom(vnode, pathKey, activePaths) {
    if (vnode == null || vnode === false || vnode === true) return document.createDocumentFragment();
    if (typeof vnode === 'string' || typeof vnode === 'number') return document.createTextNode(String(vnode));
    if (Array.isArray(vnode)) {
      const frag = document.createDocumentFragment();
      vnode.forEach((c, i) => frag.appendChild(toDom(c, pathKey + '[' + i + ']', activePaths)));
      return frag;
    }
    if (vnode.type === React.Fragment) return toDom(vnode.children, pathKey + '.frag', activePaths);
    if (typeof vnode.type === 'function') {
      const compKey = pathKey + ':' + (vnode.type.name || 'anon') + ':' + (vnode.props?.key ?? '');
      activePaths.add(compKey);
      const prevHooks = currentHooks;
      const prevIdx = hookIdx;
      currentHooks = getHooksFor(compKey, vnode.type);
      hookIdx = 0;
      const out = vnode.type({ ...(vnode.props || {}), children: vnode.children });
      currentHooks = prevHooks;
      hookIdx = prevIdx;
      return toDom(out, compKey, activePaths);
    }
    const el = document.createElement(vnode.type);
    for (const [k, v] of Object.entries(vnode.props || {})) {
      if (v == null || k === 'key' || k === 'children') continue;
      if (k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'disabled' || k === 'checked' || k === 'readOnly' || k === 'multiple') {
        el[k] = Boolean(v);
      } else if (k === 'value') {
        el.value = v;
      } else {
        el.setAttribute(k, String(v));
      }
    }
    vnode.children.forEach((c, i) => el.appendChild(toDom(c, pathKey + '/' + vnode.type + '[' + i + ']', activePaths)));
    return el;
  }

  function render() {
    scheduled = false;
    pendingEffects.length = 0;
    const activePaths = new Set();
    const dom = toDom(React.createElement(rootComp, {}), 'root', activePaths);
    for (const [k, entry] of [...componentHooks.entries()]) {
      if (!activePaths.has(k)) {
        for (const h of entry.slots) { try { h?.cleanup?.(); } catch {} }
        componentHooks.delete(k);
      }
    }
    document.getElementById('root').replaceChildren(dom);
    for (const item of pendingEffects.splice(0)) {
      try { item.slot.cleanup?.(); } catch {}
      item.slot.cleanup = item.fn();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(render);
  }

  let loadedSection = null;
  window.__ModuleLoader__ = {
    load({ factory }) {
      const mod = factory((id) => {
        if (id === 'react') return React;
        return {};
      });
      loadedSection = mod.QQBIliWhaleSection;
    },
  };
  window.__mountSurfcore = () => {
    rootComp = loadedSection;
    render();
  };
})();
</script>
<script src="/client.js"></script>
<script>window.__mountSurfcore();</script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
    return
  }
  if (u.pathname === '/client.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
    res.end(clientJsSource)
    return
  }
  // 把 /dsh-surfcore/api/* 分发给真实插件注册的路由；
  // 特别是 /dsh-surfcore/api/local-tasks 直接跑在真实 handleLocalTasks 上！
  if (u.pathname === '/dsh-surfcore/api/overview') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '0.9.0-dev.2', bridge: { running: false, ok: false }, bili: { available: false, enabled: false }, platformStart: { qq: false, bili: false }, scheduler: { running: false } }))
    return
  }
  if (u.pathname === '/dsh-surfcore/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, qq: {}, bili: {}, unified: {}, stamps: {} }))
    return
  }
  if (u.pathname === '/dsh-surfcore/api/token-budget') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, limits: {}, alertedToday: null, alert: null }))
    return
  }
  if (u.pathname === '/dsh-surfcore/api/local-tasks') {
    const apiRoute = routes.find((r) => r.path === '/dsh-surfcore/api' || u.pathname.startsWith(r.path))
    if (!apiRoute) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'ROUTE_MISSING', error: 'no route' }))
      return
    }
    await apiRoute.handler(req, res)
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

let browser
let page
const pageErrors = []
try {
  const browserInfo = findBrowser()
  if (!browserInfo?.executable) {
    console.log('SKIP: Chromium browser not found')
    process.exit(0)
  }
  browser = await chromium.launch({ headless: true, executablePath: browserInfo.executable })
  page = await browser.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(baseUrl)
  await page.getByRole('button', { name: '本机任务' }).waitFor()
  await page.getByRole('button', { name: '本机任务' }).click()

  // 1. 列表加载：显示两条任务与「回传未知」「执行中」，且说明发起入口在 QQ（绝不出现第二个发起输入框）
  await page.getByText('把会议纪要整理成周报').waitFor()
  await page.getByText('统计项目目录文档').waitFor()
  await page.getByText('回传未知').waitFor()
  await page.getByText('发起入口在 QQ 私聊').waitFor()
  assert.equal(await page.locator('input, textarea').count(), 0, '设置页不得偷偷出现第二个发起入口')

  // 2. 点击「原生会话」按钮 → 返回真实 dshSessionId 并在 toast 显示
  const row1 = page.locator('tr', { hasText: sub1.task.taskId })
  await row1.getByRole('button', { name: '原生会话' }).click()
  await page.locator('.qbw-toast').getByText('原生会话：sess-ui-1').waitFor()

  // 3. 点击「补发结果」失败路径 → 页面 toast 必须可见展示 code + error + hint（不吞错）
  await row1.getByRole('button', { name: '补发结果' }).click()
  await page.locator('.qbw-toast').getByText(/LOCAL_TASK_DELIVERY_UNCERTAIN.*桥接未确认发送成功.*先核对 QQ 私聊是否收到/).waitFor()

  // 4. 恢复桥接后再次点击「补发结果」 → 更新为「已回传」且不再有「补发结果」按钮；期间不得新建会话
  const sessionsBeforeRedeliver = sessionCounter
  bridgeFail = false
  await row1.getByRole('button', { name: '补发结果' }).click()
  await page.locator('.qbw-toast').getByText(`已补发任务 ${sub1.task.taskId} 的结果`).waitFor()
  await row1.getByText('已回传').waitFor()
  assert.equal(await row1.getByRole('button', { name: '补发结果' }).count(), 0)
  assert.equal(bridgeNotifyCount, 1, '补发成功必须经真实 callBridge 发送一次')
  assert.equal(sessionCounter, sessionsBeforeRedeliver, '补发结果不得新建会话或重新执行文件工具')

  // 5. 点击运行中任务 t2 的「停止」按钮 → 状态变「已取消」且「停止」按钮消失
  const row2 = page.locator('tr', { hasText: sub2.task.taskId })
  await row2.getByRole('button', { name: '停止' }).click()
  await page.locator('.qbw-toast').getByText('已请求停止').waitFor()
  await row2.getByText('已取消').waitFor()
  assert.equal(await row2.getByRole('button', { name: '停止' }).count(), 0)

  // 6. unknown-state 隔离告警条 + 点击「重开并核对」恢复
  domainFactory.setUnknownNext(true)
  const qFail = await lt.service.submitTask({
    trustedActor: actor,
    source: { botId: 'b1', channel: 'private', conversationId: 'owner', messageId: 'm-q' },
    text: '触发域隔离',
    workspaceId: 'w1',
  })
  assert.equal(qFail.code, 'TASK_STORE_QUARANTINED')
  await page.getByRole('button', { name: '刷新' }).click()
  await page.getByText(/存储域写入结果不明，已隔离暂停派发/).waitFor()
  await page.getByRole('button', { name: '重开并核对' }).click()
  await page.locator('.qbw-toast').getByText('已重新打开并核对存储域').waitFor()
  assert.equal(await page.getByText(/存储域写入结果不明，已隔离暂停派发/).count(), 0)

  assert.deepEqual(pageErrors, [], `页面不应有 JS 报错：${pageErrors.join('; ')}`)
  console.log('PASS Risk-2 真实浏览器 + 真实 /dsh-surfcore/api/local-tasks 路由 + LocalTasksTab 全部交互与失败可见性通过')
} catch (err) {
  try {
    const { QQ_CONFIG } = await import('../lib/paths.js')
    const { consoleBase } = await import('../lib/bridge.js')
    console.error('UI_TEST_DIAG:', JSON.stringify({
      bridgePort,
      QQ_CONFIG,
      qqConfigContent: fs.readFileSync(QQ_CONFIG, 'utf8'),
      consoleBase: consoleBase(),
      bridgeReqs,
      bridgeNotifyCount,
      toastTexts: typeof page !== 'undefined' ? await page.locator('.qbw-toast').allTextContents() : [],
      task1Deliveries: lt.service.queryTask({ taskId: sub1.task.taskId }).task?.deliveries,
    }, null, 2))
  } catch {}
  throw err
} finally {
  await browser?.close()
  server.close()
  bridgeServer.close()
  for (const d of effects) try { await d?.() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { disposeGate?.() } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}
