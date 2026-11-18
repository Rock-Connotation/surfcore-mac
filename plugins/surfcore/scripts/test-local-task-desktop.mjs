// Comprehensive unit & adversarial tests for Desktop mode (ptc preset + CUA + isolated Chrome MCP),
// QQ approval waterfall (user-questions/request & approval/request), and Owner private chat handoff.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  resolveChromeProfileDir,
  resolveChromeDevtoolsCommand,
  isPersonalChromeDir,
  buildChromeDevtoolsArgs,
} from '../../../src/mcp-chrome-devtools.js';
import { parseLocalTaskIntent } from '../../../src/core/local-task-intent.js';
import { createLocalTaskService, LOCAL_TASK_DOMAIN } from '../lib/local-task-service.mjs';
import { createLocalTaskRunner, extractTaskImagePaths } from '../lib/local-task-runner.mjs';
import {
  mountDesktopGate,
  taskDesktopDenyReason,
  taskGateIsLive,
  isDesktopToolAllowed,
  DESKTOP_PRESET_ID,
} from '../lib/local-task-gate.mjs';
import { createLocalTaskInteractions } from '../lib/local-task-interactions.mjs';
import { createQQV2ReplyHost } from '../lib/qq-v2-reply-host.mjs';
import { createQQV2NativeLedger } from '../lib/qq-v2-native-ledger.mjs';
import { createAgentBudgetMiddleware } from '../lib/memory-v2-agent-budget.mjs';
import { createTokenBudgetService } from '../lib/token-budget.js';
import { createTaskBudget } from '../lib/local-task-budget.mjs';

let checks = 0;
function pass(name) {
  checks++;
  console.log(`PASS ${name}`);
}

function makeMemoryDomain() {
  const store = new Map();
  return {
    table() {
      return {
        get: (k) => store.get(k),
        keys: () => [...store.keys()],
        entries: () => [...store.entries()],
        get size() { return store.size; },
        async put(k, v) {
          LOCAL_TASK_DOMAIN.tables.tasks.valueSchema.parse(v);
          store.set(k, v);
        },
        async delete(k) { return store.delete(k); },
      };
    },
    async close() {},
  };
}

// ── 1. Chrome DevTools MCP profile isolation ──────────────────────────────────
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-chrome-iso-'));
  try {
    const dshHome = path.join(tmpHome, '.dsh');
    const resolved = resolveChromeProfileDir({ env: {}, home: tmpHome, dshHome });
    assert.equal(resolved, path.resolve(dshHome, 'surfcore', 'chrome-profile'));
    assert.equal(isPersonalChromeDir(resolved, { home: tmpHome }), false);

    const personalMac = path.join(tmpHome, 'Library', 'Application Support', 'Google', 'Chrome');
    const personalLinux = path.join(tmpHome, '.config', 'google-chrome');
    assert.equal(isPersonalChromeDir(personalMac, { home: tmpHome }), true);
    assert.throws(
      () => resolveChromeProfileDir({ env: { SURFCORE_CHROME_PROFILE_DIR: personalMac }, home: tmpHome, dshHome }),
      (err) => err?.code === 'CHROME_PROFILE_PERSONAL_FORBIDDEN',
    );
    assert.throws(
      () => resolveChromeProfileDir({ env: { SURFCORE_CHROME_PROFILE_DIR: path.join(personalLinux, 'Default') }, home: tmpHome, dshHome }),
      (err) => err?.code === 'CHROME_PROFILE_PERSONAL_FORBIDDEN',
    );

    const args = buildChromeDevtoolsArgs({ profileDir: resolved, env: {} });
    assert.ok(args.includes(`--user-data-dir=${resolved}`));
    assert.ok(args.includes('--no-usage-statistics'));
    assert.ok(args.includes('--no-performance-crux'));
    assert.ok(!args.some((a) => a.includes('auto-connect') || a.includes('9222')));
    assert.throws(
      () => buildChromeDevtoolsArgs({ profileDir: resolved, extraArgs: ['--auto-connect'] }),
      (err) => err?.code === 'CHROME_DEVTOOLS_CONNECT_FORBIDDEN',
    );
    assert.throws(
      () => buildChromeDevtoolsArgs({ profileDir: resolved, extraArgs: ['--browserUrl=http://127.0.0.1:9222'] }),
      (err) => err?.code === 'CHROME_DEVTOOLS_CONNECT_FORBIDDEN',
    );
    assert.throws(
      () => resolveChromeDevtoolsCommand({ repoRoot: tmpHome, env: { QQ_BRIDGE_TEST_LIVE: '0' }, home: tmpHome }),
      (err) => err?.code === 'CHROME_DEVTOOLS_NOT_INSTALLED',
    );
    const liveLaunch = resolveChromeDevtoolsCommand({ repoRoot: tmpHome, env: {}, home: tmpHome, dshHome });
    assert.ok(liveLaunch.prefixArgs.includes('--prefer-offline'));
    const dshRuntimeBin = path.join(dshHome, 'dsh-runtimes', 'desktop-mcp-local', 'chrome-devtools-mcp-1.13.0', 'node_modules', 'chrome-devtools-mcp', 'out', 'Default', 'gen', 'src', 'bin', 'chrome-devtools-mcp.js');
    fs.mkdirSync(path.dirname(dshRuntimeBin), { recursive: true });
    fs.writeFileSync(dshRuntimeBin, '// dsh cached binary\n');
    const dshLaunch = resolveChromeDevtoolsCommand({ repoRoot: tmpHome, env: { QQ_BRIDGE_TEST_LIVE: '0' }, home: tmpHome, dshHome });
    assert.deepEqual(dshLaunch, { command: process.execPath, prefixArgs: [dshRuntimeBin] });
    pass('Chrome DevTools MCP enforces isolated profile and rejects personal Chrome connection flags');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

// ── 2. Intent parser: files-only shorthand + t<7hex> approval replies ─────────
{
  assert.deepEqual(
    parseLocalTaskIntent('文件任务：整理目录', { owner: '10001' }),
    { kind: 'submit', goal: '整理目录', mode: 'files-only', owner: '10001' },
  );
  assert.deepEqual(
    parseLocalTaskIntent('通过 t1a2b3c4', { owner: '10001' }),
    { kind: 'answer', id: 't1a2b3c4', decision: 'allow', owner: '10001' },
  );
  assert.deepEqual(
    parseLocalTaskIntent('始终允许 tABCDEF1', { owner: '10001' }),
    { kind: 'answer', id: 'tabcdef1', decision: 'always', owner: '10001' },
  );
  assert.deepEqual(
    parseLocalTaskIntent('拒绝 t0011223', { owner: '10001' }),
    { kind: 'answer', id: 't0011223', decision: 'reject', owner: '10001' },
  );
  assert.deepEqual(
    parseLocalTaskIntent('t99aabb1 选第二个方案'),
    { kind: 'answer', id: 't99aabb1', answerText: '选第二个方案', owner: null },
  );
  // 8-hex gateway IDs and plain chat must never hit local-task answer
  assert.equal(parseLocalTaskIntent('通过 abcd1234'), null);
  assert.equal(parseLocalTaskIntent('abcd1234 随便聊聊'), null);
  assert.equal(parseLocalTaskIntent('通过一下谢谢'), null);
  pass('Local-task intent parser handles files-only shorthand and t<7hex> replies without hijacking chat or gateway IDs');
}

// ── 3. Desktop gate, runner (ptc preset), assistant summary capture, & unload attack ──
{
  let n = 0;
  const domain = makeMemoryDomain();
  const service = createLocalTaskService({ domain, newId: () => `td-${++n}` });

  const badMode = await service.submitTask({
    trustedActor: { userId: 'owner-1' },
    source: { botId: 'b', channel: 'private', conversationId: 'owner', messageId: 'm0' },
    text: 'bad mode',
    workspaceId: 'w',
    mode: 'root-shell',
  });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.code, 'TASK_MODE_INVALID');

  const agentMap = new Map();
  const ownLayerMap = new Map();
  const restrictedByAgent = new Map();
  const toolGuards = [];
  const listeners = new Map();
  const effects = [];
  const prompts = [];
  const cancels = [];

  const mockCtx = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => listeners.get(evt)?.delete(fn);
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effects.push(cleanup);
      return () => cleanup?.();
    },
    get: (name) => ({ agents: { get: (id) => agentMap.get(id) } })[name] ?? null,
    tools: {
      definitions(agent) {
        const sid = agent.session.id;
        const base = [
          'read', 'write', 'edit', 'bash', 'cua', 'ask_user_question',
          'mcp__surfcore-chrome__navigate_page', 'mcp__surfcore-chrome__click',
          'mcp__chrome-devtools__click',
          'mcp__snowluma__qq_send_private_message', 'subagent', 'schedule_create',
        ];
        const denied = restrictedByAgent.get(sid) ?? new Set();
        const own = ownLayerMap.get(sid) ? [...ownLayerMap.get(sid).keys()] : [];
        return [...base.filter((t) => !denied.has(t)), ...own].map((name) => ({ name }));
      },
      schemas(agent) {
        return agent ? [{ name: 'run_code' }] : [];
      },
      layers: {
        peek(scope) {
          const sid = scope?.session?.id ?? scope?.id;
          return sid && ownLayerMap.has(sid) ? { tools: { data: ownLayerMap.get(sid) } } : undefined;
        },
      },
      guard(fn) {
        toolGuards.push(fn);
        return () => {
          const i = toolGuards.indexOf(fn);
          if (i >= 0) toolGuards.splice(i, 1);
        };
      },
    },
  };

  let runner;
  const desktopPolicy = mountDesktopGate(mockCtx, {
    ownsSession: (id) => Boolean(runner?.ownsSession?.(id)),
    isHealthy: () => true,
  });

  // Manual user ptc session exists BEFORE desktop task runs
  const manualSid = 'manual-ptc-1';
  agentMap.set(manualSid, {
    id: manualSid,
    session: { id: manualSid, header: { cwd: '/tmp' } },
    ctx: {
      preset: 'ptc',
      tools: {
        restrict({ deny }) {
          if (!restrictedByAgent.has(manualSid)) restrictedByAgent.set(manualSid, new Set());
          for (const d of deny) restrictedByAgent.get(manualSid).add(d);
        },
      },
    },
  });
  ownLayerMap.set(manualSid, new Map([['clutch_new_worktree', {}]]));

  let eventCb = null;
  let seq = 0;
  let finishedDelivered = null;
  runner = createLocalTaskRunner({
    service,
    sessionController: {
      async create({ agentPreset }) {
        assert.equal(agentPreset, DESKTOP_PRESET_ID);
        const sid = `sess-ptc-${++seq}`;
        restrictedByAgent.set(sid, new Set());
        ownLayerMap.set(sid, new Map([['clutch_new_worktree', {}]]));
        agentMap.set(sid, {
          id: sid,
          session: { id: sid, header: { cwd: '/tmp/ws' } },
          ctx: {
            preset: 'ptc',
            tools: {
              restrict({ deny }) {
                for (const d of deny) restrictedByAgent.get(sid).add(d);
              },
            },
          },
        });
        return { sessionId: sid };
      },
      async prompt(req) {
        prompts.push(req);
        return { accepted: true };
      },
      async cancel(req) {
        cancels.push(req.sessionId);
        return { accepted: true };
      },
    },
    agents: { get: (id) => agentMap.get(id) },
    agentPresets: { composedPreset: (c) => c?.preset },
    tools: mockCtx.tools,
    subscribe: (fn) => { eventCb = fn; return () => { eventCb = null; }; },
    workspaceRoot: '/tmp/ws',
    newRequestId: () => `req-${Date.now()}-${Math.random()}`,
    budget: createTaskBudget(),
    onSessionCreated: ({ task, sessionId }) => {
      if (task.mode === 'desktop') desktopPolicy.prepareSessionAgent(sessionId);
    },
    onFinished: async (task) => { finishedDelivered = task; },
  });
  runner.attach();

  assert.equal(taskGateIsLive('ptc'), true);
  const sub = await service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: '1', userId: '1' },
    source: { botId: 'b', channel: 'private', conversationId: '1', messageId: 'm-desk-1' },
    text: '打开 Chrome 查今天头条并总结',
    workspaceId: 'owner',
    mode: 'desktop',
    origin: 'chat',
  });
  assert.equal(sub.ok, true);
  assert.equal(sub.task.mode, 'desktop');

  const dis = await runner.dispatch(sub.task.taskId);
  assert.equal(dis.ok, true, JSON.stringify(dis));
  assert.ok(prompts[0].content[0].text.includes('mcp__surfcore-chrome__*'));

  // Verify foreign tools purged/restricted on owned desktop session, allowed tools live
  const ownedDefs = mockCtx.tools.definitions(agentMap.get(dis.sessionId)).map((d) => d.name);
  assert.ok(ownedDefs.includes('cua'));
  assert.ok(ownedDefs.includes('mcp__surfcore-chrome__navigate_page'));
  assert.ok(!ownedDefs.includes('mcp__chrome-devtools__click'));
  assert.ok(!ownedDefs.includes('mcp__snowluma__qq_send_private_message'));
  assert.ok(!ownedDefs.includes('subagent'));
  assert.ok(!ownedDefs.includes('schedule_create'));
  assert.ok(!ownedDefs.includes('clutch_new_worktree'));

  // Verify runtime guard allows Chrome/CUA/edit and blocks QQ MCP/subagent, and allows manual PTC session freely
  const runGuards = (exec) => toolGuards.map((g) => g(exec)).find((r) => typeof r === 'string');
  assert.equal(runGuards({ name: 'mcp__surfcore-chrome__click', agent: agentMap.get(dis.sessionId) }), undefined);
  assert.match(runGuards({ name: 'mcp__chrome-devtools__click', agent: agentMap.get(dis.sessionId) }), /白名单/);
  assert.equal(runGuards({ name: 'cua', agent: agentMap.get(dis.sessionId) }), undefined);
  assert.equal(runGuards({ name: 'edit', arguments: { file_path: '/Users/someone/Downloads/a.txt' }, agent: agentMap.get(dis.sessionId) }), undefined);
  assert.match(runGuards({ name: 'mcp__snowluma__qq_send_private_message', agent: agentMap.get(dis.sessionId) }), /白名单/);
  assert.equal(runGuards({ name: 'subagent', agent: agentMap.get(manualSid) }), undefined, 'manual ptc session untouched');
  assert.ok(ownLayerMap.get(manualSid).has('clutch_new_worktree'), 'manual ptc own layer untouched');

  // Verify assistant message capture feeds resultSummary & describeTask
  await eventCb({ id: dis.sessionId }, {
    seq: 1,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已打开首页，标题为 Example Domain。' }] } },
  });
  await eventCb({ id: dis.sessionId }, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(finishedDelivered?.executionStatus, 'succeeded');
  assert.equal(finishedDelivered?.resultSummary, '已打开首页，标题为 Example Domain。');
  assert.match(service.describeTask(finishedDelivered), /结果：已打开首页，标题为 Example Domain。/);

  // Attack test P0-2 for desktop gate unload: start 2nd desktop task while separate host backup guard is active,
  // unload desktop gate -> task stops & late tool call during/after gate unload is denied fail-closed
  toolGuards.push((exec) => {
    const sid = exec?.agent?.session?.id;
    if (!sid || !runner?.ownsSession?.(sid)) return undefined;
    const t = service.findBySessionId(sid);
    const healthy = taskGateIsLive('ptc') && t && !t.stopRequest && t.executionStatus === 'running';
    return taskDesktopDenyReason(exec, { healthy });
  });
  const sub2 = await service.submitTask({
    trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: '1', userId: '1' },
    source: { botId: 'b', channel: 'private', conversationId: '1', messageId: 'm-desk-2' },
    text: '长时间桌面操作',
    workspaceId: 'owner',
    mode: 'desktop',
  });
  const dis2 = await runner.dispatch(sub2.task.taskId);
  assert.equal(dis2.ok, true);
  for (const cleanup of effects.splice(0)) cleanup();
  assert.equal(taskGateIsLive('ptc'), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cancels.includes(dis2.sessionId), 'unloading desktop gate cancels running desktop session');
  assert.match(runGuards({ name: 'cua', agent: agentMap.get(dis2.sessionId) }), /已卸载|已停止/);

  runner.detach();
  pass('Desktop gate, PTC verification, manual session isolation, resultSummary capture, and unload kill-switch');
}

// ── 4. local-task-interactions: CUA app consent, mouse approval, ask_user, approval/request ──
{
  const domain = makeMemoryDomain();
  const service = createLocalTaskService({ domain, newId: (() => { let n = 0; return () => `ti-${++n}`; })() });
  const sub = await service.submitTask({
    trustedActor: { userId: 'owner-1' },
    source: { botId: 'b', channel: 'private', conversationId: 'owner-1', messageId: 'mi1' },
    text: '控制 Safari',
    workspaceId: 'owner',
    mode: 'desktop',
  });
  await service.attachSession({ taskId: sub.task.taskId, sessionId: 'sess-owned-1', requestId: 'req-i1' });

  const handlers = new Map();
  const cleanups = [];
  const bridgeMessages = [];
  const interactions = createLocalTaskInteractions({
    scoped: {
      on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt); },
      effect(fn) { cleanups.push(fn()); },
    },
    service,
    ownsSession: (sid) => sid === 'sess-owned-1',
    callBridge: async (url, { body }) => {
      bridgeMessages.push({ url, body });
      return { ok: true, status: 200, data: { ok: true } };
    },
  });

  // Non-owned session must pass straight through to next()
  let nextCalled = 0;
  const passthroughRes = await handlers.get('approval/request')(
    { agent: { session: { id: 'manual-session' } }, toolName: 'bash', reason: 'test' },
    async () => { nextCalled++; return 'from-desktop-ui'; },
  );
  assert.equal(passthroughRes, 'from-desktop-ui');
  assert.equal(nextCalled, 1);

  // Owned cua-app-access with Allow for this session + Always allow
  const qPromise = handlers.get('user-questions/request')({
    agent: { session: { id: 'sess-owned-1' } },
    questions: [{
      id: 'cua-app-access',
      question: 'Allow computer use to launch if needed, read, capture, and control Safari?',
      detail: 'Manage app permissions for all sessions on the plugin page.',
      options: [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }],
      intent: {
        kind: 'approval',
        approve: 'Allow for this session',
        reject: 'Deny',
        always: 'Always allow',
        subject: { name: 'Safari' },
      },
    }],
  }, async () => { assert.fail('must not fall through for owned task'); });

  await new Promise((r) => setTimeout(r, 15));
  const pending1 = interactions.listPending();
  assert.equal(pending1.length, 1);
  assert.equal(bridgeMessages.length, 1);
  assert.ok(bridgeMessages[0].body.message.includes(pending1[0].id));

  // Non-owner actor cannot answer
  const forbid = interactions.answer({ id: pending1[0].id, decision: 'allow', actor: { userId: 'stranger-2' } });
  assert.equal(forbid.code, 'TASK_ACTOR_FORBIDDEN');

  const alwaysRes = interactions.answer({ id: pending1[0].id, decision: 'always', actor: { userId: 'owner-1' } });
  assert.equal(alwaysRes.ok, true);
  assert.deepEqual(await qPromise, { answers: [{ id: 'cua-app-access', selected: ['Always allow'] }] });

  // cua-mouse-control does NOT allow 'always'
  const mPromise = handlers.get('user-questions/request')({
    agent: { session: { id: 'sess-owned-1' } },
    questions: [{
      id: 'cua-mouse-control',
      question: 'Allow pointer move?',
      detail: 'Mouse control',
      options: [{ label: 'Allow for this session' }, { label: 'Deny' }],
      intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny' },
    }],
  }, async () => {});
  await new Promise((r) => setTimeout(r, 10));
  const mId = interactions.listPending()[0].id;
  assert.equal(interactions.answer({ id: mId, decision: 'always' }).code, 'TASK_INTERACTION_ALWAYS_UNAVAILABLE');
  assert.equal(interactions.answer({ id: mId, decision: 'reject' }).ok, true);
  assert.deepEqual(await mPromise, { answers: [{ id: 'cua-mouse-control', selected: ['Deny'] }] });

  // approval/request allowed-once + abort cancellation
  const aPromise = handlers.get('approval/request')({
    agent: { session: { id: 'sess-owned-1' } },
    toolName: 'bash',
    reason: 'Run outside workspace',
  }, async () => 'unavailable');
  await new Promise((r) => setTimeout(r, 10));
  const aId = interactions.listPending()[0].id;
  assert.equal(interactions.answer({ id: aId, decision: 'allow' }).ok, true);
  assert.equal(await aPromise, 'allowed-once');

  const ac = new AbortController();
  const abortPromise = handlers.get('user-questions/request')({
    agent: { session: { id: 'sess-owned-1' } },
    signal: ac.signal,
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
  }, async () => {});
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(abortPromise, (e) => e?.code === 'ASK_CANCELLED');
  assert.equal(interactions.listPending().length, 0);

  for (const fn of cleanups) fn?.();
  pass('local-task-interactions bridges CUA, mouse control, ask_user_question, and sandbox approvals cleanly');
}

// ── 5. QQ V2 Reply Host: qq_dispatch_local_task ledger conformance & Owner-only gating ──
{
  const codec = {
    AssistantStreamAccumulator: class { push(v) { return structuredClone(v); } },
    BlockAssembler: class {
      content = [];
      push(c) { if (c.type === 'block-end') this.content.push(c.block); if (c.type === 'finish') this.replayState = c.replayState; }
      blocks() { return this.content; }
    },
    createSystemMessage: (text) => ({ id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } }),
    createUserMessage: ({ source, content }) => ({ id: randomUUID(), role: 'user', source, content }),
    createAssistantMessage: ({ source, content }) => ({ id: randomUUID(), role: 'assistant', source, content }),
    createToolResultMessage: ({ callId, content, isError }) => ({ id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content, isError }),
  };

  async function runReplyScenario({ key, localTaskCap }) {
    const dispatches = [];
    const sends = [];
    let observedSpecs = [];
    const ctx = { get: (n) => (n === 'llm' ? { resolveModelInfo: async (provider, id) => ({ provider, id }) } : { currentSelection: () => ({ provider: 'p', model: 'm' }) }) };
    const host = createQQV2ReplyHost({
      ctx,
      memoryV2: { adapter: {}, getRouting: () => ({ ok: true, backend: 'v2' }) },
      tokenBudget: {},
      getCharacter: () => ({ id: 'hongdou', epoch: 1 }),
      getQQIdentity: async () => ({ ok: true, verified: true, accountId: '100', allowedGroups: ['200'], allowedPrivates: ['300'] }),
      compilePersona: () => ({ ok: true, text: '红豆人设', digest: 'hd' }),
      dispatchLocalTask: async (arg) => {
        dispatches.push(arg);
        return { ok: true, taskId: 'task-chat-1', queued: false, text: '已受理本机任务 task-chat-1' };
      },
      loadEnvironment: async () => ({ nativeModules: {}, nativeCodec: codec, llm: {}, getLlmHookContext: () => ctx }),
      createSource: ({ bridge, toolSpecs, validateOwnedToolContext }) => {
        observedSpecs = toolSpecs;
        // Real ledger MUST accept exact toolSpecs + projected JSON schemas
        const ledger = createQQV2NativeLedger({
          nativeCodec: codec,
          corePersona: '红豆人设',
          toolSpecs,
          validateOwnedToolContext,
        });
        let job;
        return {
          prepareReplyPrompt: async (input) => {
            job = input.job;
            await bridge.exportNativeSources(input.key);
            ledger.seed({ sessionId: job.sessionId, requestId: job.requestId, content: [{ type: 'text', text: '主人消息' }] });
            return { ok: true, content: [{ type: 'text', text: '主人消息' }] };
          },
          captureModelOutput: async () => ({ ok: true }),
          captureToolResult: async () => ({ ok: true }),
          prepareSend: async (input) => bridge.authorizeSend(input),
          recordSent: async (input) => bridge.recordSent(input.lease, { text: input.text, messageId: input.messageId, deliveryState: input.deliveryState }),
          retireJob: async () => { await bridge.retire(); return { ok: true }; },
        };
      },
      createOwner: async (options) => {
        const sid = 'owned-' + randomUUID();
        const messages = [
          codec.createSystemMessage('红豆人设'),
          codec.createUserMessage({ source: { kind: 'user-rpc', requestId: 'r1' }, content: [{ type: 'text', text: '主人消息' }] }),
        ];
        return {
          sessionId: sid,
          validateOwnedToolContext: () => ({ ok: true }),
          followup() {},
          async whenIdle() {
            const dispatchTool = options.tools.find((t) => t.name === 'qq_dispatch_local_task');
            if (dispatchTool) {
              // Ensure exact schema compatibility with qq-v2-native-ledger
              const ledger = createQQV2NativeLedger({
                nativeCodec: codec,
                corePersona: '红豆人设',
                toolSpecs: observedSpecs,
                validateOwnedToolContext: () => ({ ok: true }),
              });
              ledger.seed({ sessionId: sid, requestId: 'r1', content: [{ type: 'text', text: '主人消息' }] });
              const projectedTools = options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
              const opt = { provider: 'p', model: 'm', messages, toolHistory: { tools: [], updates: [] }, tools: projectedTools, sessionId: sid, signal: undefined };
              const hash = createHash('sha256').update(JSON.stringify({ messages, toolHistory: opt.toolHistory, tools: projectedTools })).digest('hex');
              assert.equal(ledger.validateInput({ options: opt, request: { sessionId: sid, inputDigest: hash }, preparedConfig: { provider: 'p', model: 'm' } }).ok, true);

              const execRes = JSON.parse(await dispatchTool.execute({ goal: '用 Chrome 打开 example.com', mode: 'desktop' }, { callId: 'c1', arguments: { goal: '用 Chrome 打开 example.com', mode: 'desktop' } }));
              assert.equal(execRes.ok, true);
              assert.equal(execRes.taskId, 'task-chat-1');
            }
            await options.sourceAuthority.captureModelOutput({ phase: 'chunk', chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '好呀，我帮你安排上啦~' } } });
            await options.sourceAuthority.captureModelOutput({ phase: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } });
            await options.sourceAuthority.captureModelOutput({ phase: 'complete' });
          },
          async retire() {},
        };
      },
      callBridge: async (_p, { body }) => {
        if (body.action === 'capabilities') {
          return { ok: true, status: 200, data: { ok: true, voice: { enabled: true, maxChars: 120 }, localTask: { enabled: localTaskCap, mode: 'desktop' } } };
        }
        if (body.action === 'authorize') return { ok: true, status: 200, data: { ok: true, lease: 'l1' } };
        if (body.action === 'send') { sends.push(body.text); return { ok: true, status: 200, data: { ok: true, messageId: 'm1', deliveryState: 'delivered' } }; }
        return { ok: true, status: 200, data: { ok: true } };
      },
    });
    host.submit({ key, requestId: 'r1', characterId: 'hongdou', characterEpoch: 1 });
    await host.whenIdle();
    const receipt = host.getReceipt('r1');
    await host.close();
    return { dispatches, sends, observedSpecs, receipt };
  }

  // Owner private chat gets qq_dispatch_local_task + qq_send_voice, passes native ledger schema equality
  const ownerRun = await runReplyScenario({ key: 'private:300', localTaskCap: true });
  assert.equal(ownerRun.receipt.ok, true, JSON.stringify(ownerRun.receipt));
  assert.deepEqual(ownerRun.observedSpecs.map((s) => s.name), ['qq_dispatch_local_task', 'qq_send_voice']);
  assert.equal(ownerRun.dispatches.length, 1);
  assert.equal(ownerRun.dispatches[0].origin, 'chat');

  // Group chat NEVER gets qq_dispatch_local_task even if capability flag were erroneously true!
  const groupRun = await runReplyScenario({ key: 'group:200', localTaskCap: true });
  assert.deepEqual(groupRun.observedSpecs.map((s) => s.name), ['qq_send_voice']);
  assert.equal(groupRun.dispatches.length, 0);

  // Disabled capability NEVER exposes qq_dispatch_local_task in private chat
  const disabledRun = await runReplyScenario({ key: 'private:300', localTaskCap: false });
  assert.deepEqual(disabledRun.observedSpecs.map((s) => s.name), ['qq_send_voice']);
  assert.equal(disabledRun.dispatches.length, 0);

  pass('qq_dispatch_local_task passes strict QQ Native Ledger verification and stays strictly gated to Owner private chat');
}

// 6. Screenshot path extraction (including tool/result fallback & SHA-256 dedupe), unsafe blocking, and background dispatch
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-img-test-'));
  const ws = path.join(tmpDir, 'workspace');
  const other = path.join(tmpDir, 'desktop');
  const sshDir = path.join(tmpDir, '.ssh');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(sshDir, { recursive: true });
  try {
    const png1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 1, 1, 2, 3, 4]);
    const png2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 2, 5, 6, 7, 8]);
    const wsShot = path.join(ws, 'example_com.png');
    const wsCopy = path.join(ws, 'copy.png');
    const desktopShot = path.join(other, 'shot with spaces.png');
    const fakePng = path.join(ws, 'not-really.png');
    const unsafeShot = path.join(sshDir, 'id_rsa.png');
    fs.writeFileSync(wsShot, png1);
    fs.writeFileSync(wsCopy, png1);
    fs.writeFileSync(desktopShot, png2);
    fs.writeFileSync(fakePng, 'plain text pretending to be png');
    fs.writeFileSync(unsafeShot, png2);

    const found = extractTaskImagePaths(
      [`已保存到 \`copy.png\` 与 \`${desktopShot}\`，忽略 \`${fakePng}\` 和 \`${unsafeShot}\``, `Saved ${wsShot}`],
      { workspaceRoot: ws },
    );
    assert.deepEqual(found, [fs.realpathSync(wsCopy), fs.realpathSync(desktopShot)]);

    // Background dispatch returns before slow sessionController.create resolves, and async create error closes task cleanly
    const domain = makeMemoryDomain();
    const service = createLocalTaskService({ domain, newId: () => 'task-bg-1' });
    let releaseCreate;
    let finishedTask = null;
    const runner = createLocalTaskRunner({
      service,
      sessionController: {
        create: async () => new Promise((_, reject) => {
          releaseCreate = () => reject(new Error('chrome startup timed out'));
        }),
        prompt: async () => ({ accepted: true }),
        cancel: async () => ({ accepted: true }),
      },
      subscribe: () => () => {},
      isGateLive: () => true,
      subscribeGate: () => () => {},
      subscribeDesktopGate: () => () => {},
      workspaceRoot: ws,
      newRequestId: () => 'req-bg-1',
      onFinished: async (task) => { finishedTask = task; },
    });
    await service.submitTask({
      trustedActor: { platform: 'qq', botId: 'b', channel: 'private', conversationId: 'u', userId: 'u' },
      source: { botId: 'b', channel: 'private', conversationId: 'u', messageId: 'm-bg' },
      text: '后台派发验证',
      workspaceId: 'owner',
      mode: 'desktop',
    });
    const bg = await runner.dispatch('task-bg-1', { background: true });
    assert.equal(bg.ok, true);
    assert.equal(bg.async, true);
    assert.equal(finishedTask, null, 'background dispatch must not block waiting for slow session create');
    releaseCreate();
    for (let i = 0; i < 20 && !finishedTask; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(finishedTask?.executionStatus, 'failed');
    assert.equal(finishedTask?.error?.code, 'TASK_SESSION_CREATE_FAILED');
    assert.ok(finishedTask?.error?.hint);
    pass('extractTaskImagePaths deduplicates & validates PNG headers, and background dispatch does not block caller');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 7. qq-v2-reply-host & memory-v2-agent-budget preserve safe diagnostic codes without leaking raw secret strings
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-diag-test-'));
  const secretMsg = 'SECRET_API_LEAK_TOKEN_999';
  const budget = createTokenBudgetService({ dshHome: tmpDir, qqStateDir: path.join(tmpDir, 'qq') });
  try {
    await budget.ensureReady();
    const role = { id: 'hongdou', epoch: 1 };
    const options = Object.freeze({ sessionId: 'qq-diag-1', provider: 'fixture-provider', model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
    const req = {
      requestId: 'diag-req-1',
      jobId: 'qq-diag-1',
      category: 'qq',
      purpose: 'conversation',
      role: 'hongdou',
      epoch: 1,
      providerRouteId: 'fixture-route',
      model: 'fixture-model',
      priceSnapshot: { reliable: true, currency: 'CNY', version: 'fixture-v1', rates: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0.1, cacheWriteTokens: 1 } },
      estimatedTokens: 100,
      sessionId: 'qq-diag-1',
      inputDigest: createHash('sha256').update(JSON.stringify(options.messages)).digest('hex'),
    };
    const scope = {
      request: req,
      prepareInput: async () => ({ ok: false, code: 'MEMORY_QQ_IDENTITY_UNAVAILABLE' }),
      validate: async () => true,
      admitNetwork: async (d) => d(),
    };
    const middleware = createAgentBudgetMiddleware({
      tokenBudget: budget,
      getCharacter: () => role,
      isAgentLoopRequest: (v) => v === options,
      getScope: (v) => (v === options ? scope : undefined),
      isManagedSession: (id) => id === 'qq-diag-1',
    });
    let caughtAuth = null;
    try {
      for await (const _c of middleware.stream(options, () => (async function* () {})())) {}
    } catch (err) {
      caughtAuth = err;
    }
    assert.equal(caughtAuth?.code, 'MODEL_NOT_AUTHORIZED');
    assert.equal(caughtAuth?.cause?.code, 'MEMORY_QQ_IDENTITY_UNAVAILABLE');
    assert.equal(caughtAuth?.cause?.stage, 'prepare');
    assert.equal(JSON.stringify(caughtAuth).includes('MEMORY_QQ_IDENTITY_UNAVAILABLE'), false, 'non-enumerable cause keeps public JSON unchanged');

    let blockedReport = null;
    const host = createQQV2ReplyHost({
      ctx: {
        get(name) {
          if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
          if (name === 'llm') return { resolveModelInfo: async () => ({ provider: 'p', id: 'm' }) };
          return null;
        },
      },
      memoryV2: {
        getRouting: () => ({ backend: 'v2' }),
        adapter: { name: 'v2' },
        prepareContext: async () => ({ ok: false, code: 'MEMORY_SOURCE_PENDING', error: 'pending', hint: 'wait' }),
        verifyPrepared: async () => ({ ok: true }),
      },
      tokenBudget: budget,
      getCharacter: () => role,
      getQQIdentity: async () => ({ ok: true, verified: true, accountId: '999', allowedGroups: [], allowedPrivates: ['300'] }),
      callBridge: async () => ({ ok: true, status: 200, data: { ok: true, voice: { enabled: false }, localTask: { enabled: false } } }),
      loadEnvironment: async () => ({ nativeModules: {}, llm: {}, getLlmHookContext: () => ({}), nativeCodec: { createUserMessage: (x) => x } }),
      compilePersona: () => ({ ok: true, text: '红豆', digest: 'hd' }),
      createSource: () => ({
        prepareReplyPrompt: async () => ({ ok: true, content: [{ type: 'text', text: 'hi' }] }),
        captureModelOutput: async () => ({ ok: true }),
        captureToolResult: async () => ({ ok: true }),
        prepareSend: async () => ({ ok: true, lease: 'l1' }),
        recordSent: async () => ({ ok: true }),
        retireJob: async () => ({ ok: true }),
      }),
      createOwner: async ({ onAgentError }) => ({
        sessionId: 'qq-diag-1',
        validateOwnedToolContext: () => ({ ok: true }),
        followup() {},
        async whenIdle() {
          const inner = Object.assign(new Error(secretMsg), { code: 'MEMORY_PREPARED_STALE', stage: 'dispatch' });
          const reported = { code: 'MODEL_INVOKE_FAILED', error: 'err', hint: 'hint' };
          Object.defineProperty(reported, 'cause', { value: inner });
          onAgentError(reported);
        },
        async retire() {},
      }),
      onBlocked: (r) => { blockedReport = r; },
    });
    host.submit({ key: 'private:300', requestId: 'r-diag', characterId: 'hongdou', characterEpoch: 1 });
    await host.whenIdle();
    const receipt = host.getReceipt('r-diag');
    await host.close();
    assert.equal(receipt.code, 'MODEL_INVOKE_FAILED');
    assert.equal(blockedReport.diagnostic, 'MODEL_INVOKE_FAILED <- dispatch:MEMORY_PREPARED_STALE');
    assert.equal(JSON.stringify(blockedReport).includes(secretMsg), false, 'diagnostics must NEVER leak raw secret exception messages');
    pass('memory-v2-agent-budget & qq-v2-reply-host preserve safe cause codes without leaking raw error text');
  } finally {
    budget.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(`\n${checks} desktop/CUA/Chrome/chat-handoff checks passed`);
