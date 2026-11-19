// 任务账本保护回归（审查 01）：
//   1) 缺文件才允许初始化；截断 JSON、结构错误、读取错误必须 TASK_LEDGER_UNAVAILABLE；
//   2) 失败后原文件字节/摘要不变，任务数不变；
//   3) QQ 入口（创建/查询/取消）失败可见，执行与报告投递次数为 0。
// 仅使用隔离临时目录与夹具 bot，不访问真实 QQ/DSH/网络。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskLedger } from '../src/task-ledger.js';
import { createTaskHarness } from '../src/task-harness.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const created = [];
let passed = 0;

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surfcore-${label}-`));
  created.push(dir);
  return dir;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pass(label) {
  passed += 1;
  console.log(`PASS ${label}`);
}

function assertLedgerError(fn, label) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, 'TASK_LEDGER_UNAVAILABLE', `${label}: code`);
    assert.ok(typeof error?.error === 'string' && error.error.length > 0, `${label}: error 必须非空`);
    assert.ok(typeof error?.hint === 'string' && error.hint.length > 0, `${label}: hint 必须非空`);
    return true;
  }, `${label}: 必须抛出 TASK_LEDGER_UNAVAILABLE`);
}

const requestor = {
  platform: 'qq',
  userId: '10001',
  conversationKey: 'private:10001',
  isOwner: true
};

function legacyTask(taskId, goal) {
  return {
    taskId,
    type: 'research',
    goal,
    requestor: { ...requestor },
    status: 'completed',
    steps: [],
    currentStepIndex: 0,
    intent: null,
    approval: null,
    sources: [],
    artifact: null,
    delivery: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  };
}

try {
  // 1. 缺文件：允许初始化并正常创建。
  {
    const dir = tempDir('ledger-missing');
    const ledger = createTaskLedger({ stateDir: dir });
    const task = ledger.createTask({ taskId: 'task-missing', goal: '缺文件时创建', requestor });
    assert.equal(task.status, 'queued');
    assert.equal(ledger.getTask('task-missing').goal, '缺文件时创建');
    assert.ok(fs.existsSync(path.join(dir, 'tasks.json')));
    pass('缺文件时创建账本并保留任务');
  }

  // 2. 合法旧账本：可读，新增任务不覆盖旧记录。
  {
    const dir = tempDir('ledger-legacy');
    const file = path.join(dir, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [legacyTask('task-old', '旧账本任务')] }, null, 2));
    const ledger = createTaskLedger({ stateDir: dir });
    assert.equal(ledger.getTask('task-old').goal, '旧账本任务');
    ledger.createTask({ taskId: 'task-new', goal: '新任务', requestor });
    const ids = ledger.listTasks().map(task => task.taskId);
    assert.ok(ids.includes('task-old'), '旧任务必须保留');
    assert.ok(ids.includes('task-new'), '新任务必须写入');
    pass('合法旧账本可读，新增任务不覆盖旧记录');
  }

  // 3. 坏账本：所有读写入口 fail-closed，原字节/摘要不变，不残留临时文件。
  function assertBadLedger(label, bytes) {
    const dir = tempDir(`ledger-${label}`);
    const file = path.join(dir, 'tasks.json');
    fs.writeFileSync(file, bytes);
    const before = fs.readFileSync(file);
    const beforeDigest = digest(before);
    const ledger = createTaskLedger({ stateDir: dir });
    assertLedgerError(() => ledger.createTask({ goal: '新任务', requestor }), `${label} create`);
    assertLedgerError(() => ledger.getTask('task-old'), `${label} get`);
    assertLedgerError(() => ledger.updateTask('task-old', { status: 'completed' }), `${label} update`);
    assertLedgerError(() => ledger.listTasks(), `${label} list`);
    assertLedgerError(() => ledger.findActiveTask('private:10001'), `${label} active`);
    assert.deepEqual(fs.readFileSync(file), before, `${label}: 原字节必须不变`);
    assert.equal(digest(fs.readFileSync(file)), beforeDigest, `${label}: 摘要必须不变`);
    assert.deepEqual(fs.readdirSync(dir), ['tasks.json'], `${label}: 不残留临时文件`);
  }
  assertBadLedger('truncated', '{"version":1,"tasks":[{"taskId":"task-old"');
  assertBadLedger('structure', JSON.stringify({ version: 1, tasks: {} }));
  assertBadLedger('future-version', JSON.stringify({ version: 999, tasks: [{}] }));
  assertBadLedger('bad-record', JSON.stringify({ version: 1, tasks: [{ taskId: 'task-old', status: 'bogus' }] }));
  pass('截断 JSON、结构错误、未来版本与坏记录均 fail-closed，原字节/摘要不变');

  // 4. 确定的读取错误：非 root 用 000 权限；root 下用同名目录制造 EISDIR。
  {
    const dir = tempDir('ledger-read-error');
    const file = path.join(dir, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      tasks: [legacyTask('task-a', '任务 A'), legacyTask('task-b', '任务 B')]
    }, null, 2));
    const before = fs.readFileSync(file);
    const notRoot = typeof process.getuid !== 'function' || process.getuid() !== 0;
    if (notRoot) {
      fs.chmodSync(file, 0o000);
      try {
        const ledger = createTaskLedger({ stateDir: dir });
        assertLedgerError(() => ledger.createTask({ goal: '新任务', requestor }), 'read create');
        assertLedgerError(() => ledger.listTasks(), 'read list');
      } finally {
        fs.chmodSync(file, 0o600);
      }
      assert.deepEqual(fs.readFileSync(file), before, '读取失败后原字节必须不变');
      assert.equal(createTaskLedger({ stateDir: dir }).listTasks().length, 2, '任务数必须不变');
      pass('确定的读取错误 fail-closed，恢复后原字节与任务数不变');
    } else {
      fs.rmSync(file);
      fs.mkdirSync(file);
      try {
        const ledger = createTaskLedger({ stateDir: dir });
        assertLedgerError(() => ledger.createTask({ goal: '新任务', requestor }), 'read create');
        assertLedgerError(() => ledger.listTasks(), 'read list');
      } finally {
        fs.rmdirSync(file);
        fs.writeFileSync(file, before);
      }
      assert.deepEqual(fs.readFileSync(file), before);
      pass('确定的读取错误 fail-closed（root 用 EISDIR 变体）');
    }
  }

  // 5. Harness 流水线：账本不可读时直接结构化失败，研究/投递 0 次。
  {
    const dir = tempDir('ledger-pipeline');
    const file = path.join(dir, 'tasks.json');
    const broken = '{"version":1,"tasks":[{"taskId":"task-old"';
    fs.writeFileSync(file, broken);
    const before = fs.readFileSync(file);
    const ledger = createTaskLedger({ stateDir: dir });
    let sends = 0;
    const harness = createTaskHarness({
      ledger,
      reportsDir: path.join(dir, 'reports'),
      safeFetchImpl: async () => { throw new Error('不应触达抓取'); },
      sendCallback: async () => { sends += 1; return { ok: true, messageId: 1 }; }
    });
    const result = await harness.runTaskPipeline({ requestor, goal: '账本损坏时不得执行 https://source.example/blocked', urls: ['https://source.example/blocked'] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'TASK_LEDGER_UNAVAILABLE');
    assert.ok(result.error && result.hint, '失败必须带 error/hint');
    assert.equal(sends, 0, '不得投递报告');
    assert.deepEqual(fs.readFileSync(file), before, '流水线失败后账本原字节不变');
    pass('流水线遇坏账本结构化失败，抓取/投递 0 次');
  }

  // 6. 真实 QQ 入口（VM 夹具）：创建/查询/取消都失败可见，不执行、不投递。
  {
    const broken = '{"version":1,"tasks":[{"taskId":"task-old"';
    const h = await bridgeHarness({
      config: {
        ownerQQ: 10001,
        allow: { private: ['10001'], groups: [] },
        deny: { private: [], groups: [], users: [] },
        slang: { enabled: false },
        socialV2: { tokenGuard: { enabled: false } }
      },
      files: { 'state/tasks.json': broken }
    });
    try {
      const ledgerPath = path.join(h.temp, 'state', 'tasks.json');
      const before = fs.readFileSync(ledgerPath);
      const send = async (raw) => {
        const from = h.calls.sent.length;
        await h.handleIncoming('private', 10001, {
          post_type: 'message',
          message_type: 'private',
          self_id: 10001,
          user_id: 10001,
          message_id: crypto.randomInt(1e6, 2e6),
          raw_message: raw,
          message: [{ type: 'text', data: { text: raw } }],
          sender: { user_id: 10001, nickname: '主人' }
        }, h.cfg);
        return h.calls.sent.slice(from);
      };
      const assertVisibleFailure = (sends, label) => {
        assert.equal(sends.length, 1, `${label}: 只回一条失败提示`);
        const text = String(sends[0].text);
        assert.match(text, /\[任务账本不可用\]/, `${label}: 必须有可见标记`);
        assert.match(text, /TASK_LEDGER_UNAVAILABLE/, `${label}: 必须有原因编号`);
        assert.match(text, /下一步/, `${label}: 必须给下一步`);
        assert.ok(!text.includes('收到电脑研究任务'), `${label}: 不得声称已创建工单`);
        assert.ok(!text.includes('任务完成'), `${label}: 不得声称完成`);
      };
      assertVisibleFailure(await send('任务：调研量子计算 https://source.example/r2'), '创建');
      assertVisibleFailure(await send('任务状态'), '查询');
      assertVisibleFailure(await send('取消任务'), '取消');
      const reportsDir = path.join(h.temp, 'state', 'reports');
      assert.ok(!fs.existsSync(reportsDir) || fs.readdirSync(reportsDir).length === 0, '不得生成报告');
      assert.deepEqual(fs.readFileSync(ledgerPath), before, 'QQ 入口失败后账本原字节不变');
      pass('QQ 入口创建/查询/取消失败可见，执行与投递 0 次');
    } finally {
      await h.close();
    }
  }

  // 7. 第二次读取失败：管理回执用已发生动作的快照，不再读账本改口。
  {
    const baseConfig = {
      ownerQQ: 10001,
      allow: { private: ['10001'], groups: [] },
      deny: { private: [], groups: [], users: [] },
      slang: { enabled: false },
      socialV2: { tokenGuard: { enabled: false } }
    };
    const makeOwnerBridge = async (options = {}) => {
      const h = await bridgeHarness({ config: baseConfig, ...options });
      const send = async (raw) => {
        const from = h.calls.sent.length;
        await h.handleIncoming('private', 10001, {
          post_type: 'message', message_type: 'private', self_id: 10001,
          user_id: 10001, message_id: crypto.randomInt(1e6, 2e6),
          raw_message: raw, message: [{ type: 'text', data: { text: raw } }],
          sender: { user_id: 10001, nickname: '主人' }
        }, h.cfg);
        return h.calls.sent.slice(from);
      };
      return { h, send };
    };
    const secondReadError = Object.assign(new Error('第二次读取账本失败'), {
      code: 'TASK_LEDGER_UNAVAILABLE',
      error: '第二次读取账本失败。',
      hint: '按任务编号重新查询，不要重复执行。'
    });

    // 7a. 查询：入口已读到任务，但详情回执的二次读取失败，仍须显示详情。
    {
      const { h, send } = await makeOwnerBridge();
      try {
        const task = h.taskLedger.createTask({ goal: '二次读取查询', requestor });
        const originalGetTask = h.taskLedger.getTask.bind(h.taskLedger);
        let reads = 0;
        h.taskLedger.getTask = (...args) => {
          reads += 1;
          if (reads === 2) throw secondReadError;
          return originalGetTask(...args);
        };
        const sends = await send('任务状态 ' + task.taskId);
        assert.equal(sends.length, 1, '查询详情只回一条');
        const text = String(sends[0].text);
        assert.ok(text.includes('【任务详情】' + task.taskId), text);
        assert.ok(!text.includes('[任务账本不可用]'), text);
        h.taskLedger.getTask = originalGetTask;
        assert.equal(h.taskLedger.getTask(task.taskId).status, 'queued');
        pass('查询详情二次读取失败仍按已读快照回执');
      } finally { await h.close(); }
    }

    // 7b. 取消：写入已生效，回执二次读取失败，仍须明确说已取消。
    {
      const { h, send } = await makeOwnerBridge();
      try {
        const task = h.taskLedger.createTask({ goal: '二次读取取消', requestor });
        const originalCancel = h.taskLedger.cancelTask.bind(h.taskLedger);
        const originalGetTask = h.taskLedger.getTask.bind(h.taskLedger);
        let cancelled = false;
        h.taskLedger.cancelTask = (...args) => {
          const res = originalCancel(...args);
          if (res) cancelled = true;
          return res;
        };
        h.taskLedger.getTask = (...args) => {
          if (cancelled) throw secondReadError;
          return originalGetTask(...args);
        };
        const sends = await send('取消任务 ' + task.taskId);
        assert.equal(sends.length, 1, '取消回执只回一条');
        const text = String(sends[0].text);
        assert.ok(text.includes('任务 [' + task.taskId + '] 状态已置为 cancelled'), text);
        assert.ok(!text.includes('[任务账本不可用]'), text);
        cancelled = false;
        assert.equal(h.taskLedger.getTask(task.taskId).status, 'cancelled');
        pass('取消写入生效后二次读取失败仍按已发生事实回执');
      } finally { await h.close(); }
    }

    // 7c. 创建后账本才坏：启动回执与失败回执都不再读账本；恢复后仍可查/取消。
    {
      const GOOD_BYTES = JSON.stringify({
        version: 1,
        tasks: [legacyTask('task-old', '旧任务')]
      }, null, 2);
      const BROKEN = '{"version":1,"tasks":[{"taskId":"task-old"';
      const { h, send } = await makeOwnerBridge({
        files: { 'state/tasks.json': GOOD_BYTES },
        globals: {
          safeFetch: async (url) => ({ url, statusCode: 200, body: '<html>ok</html>', truncated: false })
        }
      });
      try {
        const ledgerPath = path.join(h.temp, 'state', 'tasks.json');
        const originalCreate = h.taskLedger.createTask.bind(h.taskLedger);
        let createdTask = null;
        let goodBytes = null;
        let corruptOnce = true;
        h.taskLedger.createTask = (...args) => {
          const task = originalCreate(...args);
          if (corruptOnce) {
            corruptOnce = false;
            createdTask = task;
            goodBytes = fs.readFileSync(ledgerPath);
            fs.writeFileSync(ledgerPath, BROKEN);
          }
          return task;
        };
        const sends = await send('任务：创建后才坏 https://source.example/r2');
        assert.ok(createdTask, '入口必须已创建工单');
        assert.ok(sends.some(s => String(s.text).includes('收到电脑研究任务')), '创建回执必须按已发生事实显示');
        assert.ok(!sends.some(s => String(s.text).includes('[任务账本不可用]')), '已创建工单不得改口为账本不可用');
        assert.equal(fs.readFileSync(ledgerPath, 'utf8'), BROKEN, '账本变坏后不得被回执覆写');

        fs.writeFileSync(ledgerPath, goodBytes);
        assert.equal(h.taskLedger.getTask(createdTask.taskId).status, 'queued', '任务应保留排队状态');
        const statusSends = await send('任务状态 ' + createdTask.taskId);
        assert.ok(statusSends.some(s => String(s.text).includes('【任务详情】' + createdTask.taskId)));
        const cancelSends = await send('取消任务 ' + createdTask.taskId);
        assert.ok(cancelSends.some(s => String(s.text).includes('任务 [' + createdTask.taskId + '] 状态已置为 cancelled')));
        assert.equal(h.taskLedger.getTask(createdTask.taskId).status, 'cancelled');
        pass('创建后账本变坏仍保留排队任务，恢复后可按编号查询取消');
      } finally { await h.close(); }
    }

    // 7d. 初始坏账本 + 可执行网址任务：不得抓取，也不得投递任何报告。
    {
      const BAD = '{"version":999,"tasks":[{}]}';
      const fetchCalls = [];
      const { h, send } = await makeOwnerBridge({
        files: { 'state/tasks.json': BAD },
        globals: {
          safeFetch: async (url, maxChars) => {
            fetchCalls.push({ url, maxChars });
            return { url, statusCode: 200, body: '<html>不应执行</html>', truncated: false };
          }
        }
      });
      try {
        const ledgerPath = path.join(h.temp, 'state', 'tasks.json');
        const originalBytes = fs.readFileSync(ledgerPath);
        const sends = await send('任务：坏账本不执行 https://source.example/blocked');
        assert.equal(fetchCalls.length, 0, '坏账本时不得抓取');
        const reportSends = sends.filter(s => /任务完成|研究摘要|产物文件/.test(String(s.text)));
        assert.equal(reportSends.length, 0, '坏账本时不得投递报告');
        assert.ok(sends.some(s => String(s.text).includes('[任务账本不可用]')), '必须显示账本不可用');
        const reportsDir = path.join(h.temp, 'state', 'reports');
        assert.ok(!fs.existsSync(reportsDir) || fs.readdirSync(reportsDir).length === 0, '不得生成报告');
        assert.deepEqual(fs.readFileSync(ledgerPath), originalBytes, '坏账本字节不得被改写');
        pass('初始坏账本带回址任务零抓取、零报告投递');
      } finally { await h.close(); }
    }
  }

  console.log(`\n${passed} 组任务账本保护测试通过。`);
} finally {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
