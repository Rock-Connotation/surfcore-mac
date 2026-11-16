import { newCaseRoot, createRealV2Factory, inbound, assert, fs, path, crypto, testHome, OWNER, KEY, GROUP_KEY, LOGIN } from './r2-v2-fixture.mjs';
const { root, stateDir } = newCaseRoot('owner-delivery');
process.env.DSH_HOME = root;
process.env.R2_CASE_ROOT = root;
process.env.R2_CASE_STATE_DIR = stateDir;
let reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
const f = await createRealV2Factory({ platformReply: () => typeof reply === 'function' ? reply() : reply });
const h = f.harness;
let failures = 0;
async function test(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures++; console.error('FAIL', name, e.message); } }
const requestor = { platform: 'qq', userId: OWNER, conversationKey: KEY, isOwner: true };
try {
  await test('status reaches platform', async () => {
    const text = '任务状态'; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sent = f.platformSends.slice(before);
    console.log('platform sends=' + JSON.stringify(sent));
    console.log('memoryV2Failures.code=' + JSON.stringify(h.memoryV2Failures.get(KEY)?.code ?? null));
    assert.ok(sent.length >= 1, 'owner task status must reach the platform');
  });
  await test('cancel reaches platform', async () => {
    const task = h.taskLedger.createTask({ goal: 'cancel fixture', requestor });
    const text = `取消任务 ${task.taskId}`; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    console.log('cancel=' + JSON.stringify({ status: h.taskLedger.getTask(task.taskId).status, sends: f.platformSends.length - before, failure: h.memoryV2Failures.get(KEY)?.code ?? null }));
    assert.ok(f.platformSends.length > before, 'cancel receipt must reach platform');
  });
  await test('start and failure reach platform', async () => {
    fs.writeFileSync(path.join(h.temp, 'state', 'reports'), 'block report directory');
    const text = '任务：failure fixture'; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sends = f.platformSends.slice(before);
    console.log('start/failure=' + JSON.stringify({ sends, failure: h.memoryV2Failures.get(KEY)?.code ?? null }));
    assert.ok(sends.some(s => JSON.stringify(s.text).includes('收到电脑研究任务')), 'start receipt must reach platform');
    assert.ok(sends.some(s => JSON.stringify(s.text).includes('任务失败')), 'failure receipt must reach platform');
  });
  await test('unknown remains queryable and undelivered', async () => {
    const task = h.taskLedger.createTask({ goal: 'unknown receipt', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    reply = { status: 'ok', retcode: 0, data: {} };
    const before = f.platformSends.length;
    const result = await h.taskHarness.executeDeliveryStep(task);
    const saved = h.taskLedger.getTask(task.taskId);
    console.log('unknown receipt=' + JSON.stringify({ result, status: saved.status, delivery: saved.delivery, sends: f.platformSends.length - before }));
    assert.equal(saved.delivery.status, 'delivery_unknown');
    assert.equal(saved.delivery.messageId ?? null, null);
    assert.equal(f.platformSends.length - before, 1);
    assert.ok(result.code && result.hint);
    assert.equal(h.taskLedger.getTask(task.taskId).goal, 'unknown receipt');
    const again = await h.taskHarness.executeDeliveryStep(task);
    assert.equal(again.status, 'delivery_unknown');
    assert.ok(again.code && again.hint);
    assert.equal(f.platformSends.length - before, 1);
    console.log('unknown retry sends=' + (f.platformSends.length - before));
  });
  await test('ack id is persisted', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const task = h.taskLedger.createTask({ goal: 'known receipt', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    const result = await h.taskHarness.executeDeliveryStep(task);
    const saved = h.taskLedger.getTask(task.taskId);
    console.log('ack ledger=' + JSON.stringify({result, status: saved.status, delivery: saved.delivery}));
    assert.equal(saved.delivery.status, 'delivered'); assert.equal(saved.delivery.messageId, 9001);
  });
  await test('rejection is structured', async () => {
    reply = { status: 'failed', retcode: 100, data: {} };
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '拒绝测试', phase: 'status' });
    console.log('rejected=' + JSON.stringify(result));
    assert.equal(result.ok, false); assert.equal(result.delivery, 'rejected'); assert.ok(result.code && result.error && result.hint);
  });
  await test('all long reply segments acknowledged', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const before = f.platformSends.length;
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: 'x'.repeat(5000), phase: 'status' });
    console.log('long reply=' + JSON.stringify({ result, sends: f.platformSends.length - before }));
    assert.equal(result.delivery, 'delivered');
    assert.equal(f.platformSends.length - before, 2);
  });
  await test('cancel during delivery retains cancellation', async () => {
    const task = h.taskLedger.createTask({ goal: 'cancel race', requestor });
    h.taskLedger.updateTask(task.taskId, { artifact: { summary: 'fixture', path: '/tmp/fixture', sizeBytes: 10, sha256: '12345678' } });
    let resolveReply, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const pendingReply = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { entered(); return pendingReply; };
    const send = h.taskHarness.executeDeliveryStep(task);
    await started;
    h.taskLedger.cancelTask(task.taskId);
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    const result = await send; const saved = h.taskLedger.getTask(task.taskId);
    console.log('cancel race=' + JSON.stringify({ result, status: saved.status, delivery: saved.delivery }));
    assert.equal(saved.status, 'cancelled'); assert.equal(result.code, 'TASK_CANCELLED'); assert.ok(result.hint);
    assert.equal(saved.delivery.status, 'delivered'); assert.equal(saved.delivery.messageId, 9001);
  });
  await test('blocked mode permits owner management send', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'reserved' } }] } } });
    await h.checkDsh(); assert.ok(h.getModeBlocked());
    const before = f.platformSends.length;
    const result = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '模式阻断通知', phase: 'status' });
    console.log('blocked send=' + JSON.stringify({ result, sends: f.platformSends.length - before }));
    assert.equal(result.delivery, 'delivered'); assert.equal(f.platformSends.length - before, 1);
    h.clearModeBlock(); h.setMode('chat');
  });
  await test('wrong target and cancelled delivery fail closed', async () => {
    const bad = await h.sendOwnerManagementReply({ conversationKey: 'private:42', text: '禁止', phase: 'status' });
    const task = h.taskLedger.createTask({ goal: 'cancelled', requestor }); h.taskLedger.cancelTask(task.taskId);
    const cancelled = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '禁止', taskId: task.taskId, phase: 'delivery' });
    console.log('denials=' + JSON.stringify({ bad, cancelled }));
    for (const result of [bad, cancelled]) { assert.equal(result.ok, false); assert.equal(result.delivery, 'rejected'); assert.ok(result.code && result.error && result.hint); }
  });
  await test('unknown delivery does not send failure notice', async () => {
    const reports = path.join(h.temp, 'state', 'reports');
    assert.ok(fs.realpathSync(reports).startsWith(root + path.sep));
    fs.renameSync(reports, path.join(h.temp, 'state', 'reports-blocker'));
    let n = 0;
    reply = () => ++n === 1 ? { status: 'ok', retcode: 0, data: { message_id: 9001 } } : { status: 'ok', retcode: 0, data: {} };
    const before = f.platformSends.length;
    const text = '任务：unknown pipeline';
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sent = f.platformSends.slice(before);
    const task = h.taskLedger.listTasks({ conversationKey: KEY, limit: 1 })[0];
    console.log('unknown pipeline=' + JSON.stringify({ sends: sent, taskStatus: task.status, delivery: task.delivery }));
    assert.equal(sent.length, 2); assert.ok(!sent.some(item => JSON.stringify(item.text).includes('任务失败')));
    assert.equal(task.delivery.status, 'delivery_unknown'); assert.equal(task.delivery.messageId, null);
  });
  await test('cancellation during start keeps task cancelled', async () => {
    let enter, resolveReply;
    const started = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { enter(); return pending; };
    const before = f.platformSends.length;
    const text = '任务：cancel start';
    const running = h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    await started;
    const task = h.taskLedger.listTasks({ conversationKey: KEY, limit: 1 })[0];
    const cancelled = h.taskLedger.cancelTask(task.taskId);
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    await running;
    const final = h.taskLedger.getTask(task.taskId);
    console.log('start cancellation=' + JSON.stringify({ before: cancelled.status, after: final.status, sends: f.platformSends.length - before }));
    assert.equal(cancelled.status, 'cancelled'); assert.equal(final.status, 'cancelled'); assert.equal(f.platformSends.length - before, 1);
  });
  await test('new failure codes include actionable hints', async () => {
    const empty = await h.sendOwnerManagementReply({ conversationKey: KEY, text: '', phase: 'status' });
    assert.equal(empty.code, 'OWNER_REPLY_EMPTY'); assert.ok(empty.hint);
    const task = h.taskLedger.createTask({ goal: 'original goal', requestor });
    const mismatch = await h.taskHarness.runTaskPipeline({ taskId: task.taskId, requestor, goal: 'different goal' });
    assert.equal(mismatch.code, 'TASK_OWNER_MISMATCH'); assert.ok(mismatch.hint);
    let enter, resolveReply;
    const started = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { resolveReply = resolve; });
    reply = () => { enter(); return pending; };
    const first = h.sendOwnerManagementReply({ conversationKey: KEY, text: '排队首条', phase: 'status' });
    await started;
    const second = h.sendOwnerManagementReply({ conversationKey: KEY, text: '排队第二条', phase: 'status' });
    h.cfg.ownerQQ = '99999';
    resolveReply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    await first;
    const changed = await second;
    h.cfg.ownerQQ = OWNER;
    assert.equal(changed.code, 'OWNER_REPLY_CONTEXT_CHANGED'); assert.ok(changed.hint);
    console.log('failure codes=' + JSON.stringify({ empty, mismatch, changed }));
  });
  await test('foreign task details are not disclosed', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const foreign = h.taskLedger.createTask({ goal: 'FOREIGN_PRIVATE_GOAL', requestor: { platform: 'qq', userId: '42', conversationKey: 'private:42', isOwner: true } });
    const text = `任务状态 ${foreign.taskId}`; const before = f.platformSends.length;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const sent = f.platformSends.slice(before);
    console.log('foreign status=' + JSON.stringify(sent));
    assert.ok(!JSON.stringify(sent).includes('FOREIGN_PRIVATE_GOAL'), 'foreign task contents must not be disclosed');
  });
  await test('foreign task cancellation has no side effect', async () => {
    const foreign = h.taskLedger.createTask({ goal: 'foreign cancel', requestor: { platform: 'qq', userId: '42', conversationKey: 'private:42', isOwner: true } });
    const beforeTask = h.taskLedger.getTask(foreign.taskId); const before = f.platformSends.length;
    const text = `取消任务 ${foreign.taskId}`;
    await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
    const afterTask = h.taskLedger.getTask(foreign.taskId); const sent = f.platformSends.slice(before);
    console.log('foreign cancel=' + JSON.stringify({ before: beforeTask.status, after: afterTask.status, sends: sent }));
    assert.deepEqual(afterTask, beforeTask, 'foreign task ledger must remain unchanged');
  });
  await test('terminal task cancellation reports actual status', async () => {
    const results = [];
    for (const status of ['completed', 'failed']) {
      const task = h.taskLedger.createTask({ goal: `terminal ${status}`, requestor });
      h.taskLedger.updateTask(task.taskId, { status });
      const before = f.platformSends.length; const text = `取消任务 ${task.taskId}`;
      await h.handleIncoming('private', Number(OWNER), inbound({ raw_message: text, message: [{ type: 'text', data: { text } }] }), h.cfg);
      const sent = f.platformSends.slice(before); const actual = h.taskLedger.getTask(task.taskId).status;
      console.log('terminal cancel=' + JSON.stringify({ actual, sends: sent }));
      results.push({ status, actual, sent });
    }
    for (const item of results) { assert.equal(item.actual, item.status); assert.ok(!JSON.stringify(item.sent).includes('状态已置为 cancelled'), 'terminal task must not claim cancellation'); }
  });
  await test('non-owner rejection uses system reply', async () => {
    reply = { status: 'ok', retcode: 0, data: { message_id: 9001 } };
    const admission = h.taskHarness.checkAdmission({ requestor: { platform: 'qq', userId: '42', conversationKey: GROUP_KEY, isOwner: false } });
    console.log('non-owner admission=' + JSON.stringify(admission));
    assert.equal(admission.ok, false); assert.ok(admission.code && admission.error && admission.hint);
    const text = '任务状态'; const before = f.platformSends.length;
    await h.handleIncoming('group', 90001, inbound({ user_id: 42, group_id: 90001, self_id: Number(LOGIN), raw_message: text, message: [{ type: 'text', data: { text } }], sender: { user_id: 42, nickname: '访客' } }), h.cfg);
    console.log('non-owner sends=' + JSON.stringify(f.platformSends.slice(before)));
    assert.ok(f.platformSends.length > before, 'non-owner must receive restricted system rejection');
  });
  await test('owner QQ directory request lists regular file names and delivers a deduplicated ACK', async () => {
    const readRoot = path.join(h.temp, 'state', 'task-files');
    const directory = path.join(readRoot, '验收 样本');
    const sibling = path.join(h.temp, 'state', 'task-files-other');
    fs.mkdirSync(path.join(directory, 'subfolder'), { recursive: true });
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(directory, '文件甲.txt'), 'CONTENT_MUST_NOT_BE_SENT');
    fs.writeFileSync(path.join(directory, 'file-b.md'), '');
    fs.writeFileSync(path.join(directory, 'subfolder', 'recursive.txt'), '');
    fs.writeFileSync(path.join(sibling, 'outside.txt'), '');
    if (process.platform !== 'win32') {
      fs.symlinkSync(sibling, path.join(readRoot, 'escape'));
      fs.symlinkSync(path.join(sibling, 'outside.txt'), path.join(directory, 'link.txt'));
    }
    const command = target => `任务：列出文件 "${target}"`;
    const packet = (target, messageId, extra = {}) => inbound({
      message_id: messageId,
      raw_message: command(target),
      message: [{ type: 'text', data: { text: command(target) } }],
      ...extra,
    });
    const send = args => h.handleIncoming('private', Number(OWNER), args, h.cfg);
    reply = { status: 'ok', retcode: 0, data: { message_id: -9002 } };
    const initial = f.platformSends.length;
    const nativeBefore = f.nativeSubmissions.length;
    const first = packet(directory, 812001);
    await Promise.all([send(first), send(first)]);
    assert.equal(f.platformSends.length, initial + 1);
    const text = JSON.stringify(f.platformSends.at(-1).text);
    assert.match(text, /Mac 目录清单/);
    assert.match(text, /文件甲\.txt/);
    assert.match(text, /file-b\.md/);
    assert.doesNotMatch(text, /CONTENT_MUST_NOT_BE_SENT|recursive\.txt|link\.txt|outside\.txt/);
    const task = h.taskLedger.listTasks({ conversationKey: KEY, limit: 1 })[0];
    assert.equal(task.type, 'directory_list');
    assert.equal(task.delivery.status, 'delivered');
    assert.equal(task.delivery.messageId, -9002);
    assert.equal(task.intent.displayed, 2);
    await send(packet(sibling, 812002));
    assert.match(JSON.stringify(f.platformSends.at(-1).text), /TASK_DIRECTORY_NOT_ALLOWED/);
    if (process.platform !== 'win32') {
      await send(packet(path.join(readRoot, 'escape'), 812003));
      assert.match(JSON.stringify(f.platformSends.at(-1).text), /TASK_DIRECTORY_NOT_ALLOWED/);
    }
    const beforeDenied = f.platformSends.length;
    await h.handleIncoming('group', 90001, packet(directory, 812004, { group_id: 90001 }), h.cfg);
    await send(packet(directory, 812005, { self_id: 123456 }));
    assert.equal(f.platformSends.length, beforeDenied, 'group or wrong account must not deliver a directory result');
    assert.equal(f.nativeSubmissions.length, nativeBefore, 'directory instructions must not enter a Native chat job');
  });
  if (process.platform !== 'win32') await test('owner QQ file read delivers exact text within the granted directory only', async () => {
    const readRoot = path.join(h.temp, 'state', 'task-files');
    const scopeName = '文件正文测试';
    const directory = path.join(readRoot, scopeName);
    const another = path.join(readRoot, '另一个目录');
    fs.mkdirSync(path.join(directory, 'nested'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(another, { mode: 0o700 });
    const grant = `${readRoot}.text-directory`;
    const file = path.join(directory, 'alpha-notes.txt');
    const body = '  正文保留 🐾\n第二行\n';
    fs.writeFileSync(file, body, { mode: 0o600 });
    fs.writeFileSync(path.join(another, 'alpha-notes.txt'), 'OUTSIDE_SCOPE');
    fs.writeFileSync(path.join(directory, 'nested', 'nested.txt'), 'OUTSIDE_SCOPE');
    fs.writeFileSync(path.join(directory, 'large.txt'), '猫'.repeat(801));
    fs.writeFileSync(path.join(directory, 'binary.txt'), Buffer.from([0xff]));
    fs.writeFileSync(path.join(directory, 'control.txt'), '[CQ:at,qq=42]');
    fs.symlinkSync(path.join(another, 'alpha-notes.txt'), path.join(directory, 'link.txt'));
    fs.linkSync(path.join(another, 'alpha-notes.txt'), path.join(directory, 'hard.txt'));
    const packet = (target, messageId, extra = {}) => {
      const text = `任务：读取文件 "${target}"`;
      return inbound({ message_id: messageId, raw_message: text, message: [{ type: 'text', data: { text } }], ...extra });
    };
    const send = args => h.handleIncoming('private', Number(OWNER), args, h.cfg);
    const response = () => JSON.stringify(f.platformSends.at(-1).text);
    const checkFailure = async (target, messageId, code) => {
      const count = f.platformSends.length;
      await send(packet(target, messageId));
      assert.equal(f.platformSends.length, count + 1);
      assert.ok(response().includes(code) && response().includes('。'));
      assert.doesNotMatch(response(), /OUTSIDE_SCOPE|正文保留|\[CQ:at/);
    };
    reply = { status: 'ok', retcode: 0, data: { message_id: -9003 } };
    await checkFailure('alpha-notes.txt', 813001, 'TASK_FILE_SCOPE_REQUIRED');
    fs.writeFileSync(grant, `${scopeName}\n`, { mode: 0o600, flag: 'wx' });
    const initial = f.platformSends.length;
    const nativeBefore = f.nativeSubmissions.length;
    const first = packet('alpha-notes.txt', 813002);
    await Promise.all([send(first), send(first)]);
    assert.equal(f.platformSends.length, initial + 1);
    assert.ok(response().includes(JSON.stringify(`【正文开始】\n${body}\n【正文结束】`).slice(1, -1)));
    const tasks = h.taskLedger.listTasks({ conversationKey: KEY, limit: 30 }).filter(task => task.type === 'file_read');
    const done = tasks.find(task => task.status === 'completed');
    assert.equal(done.delivery.messageId, -9003);
    assert.deepEqual(done.intent, { bytes: Buffer.byteLength(body) });
    assert.doesNotMatch(JSON.stringify(tasks), /正文保留|alpha-notes\.txt|文件正文测试/);
    await send(packet(file, 813003));
    assert.ok(response().includes('正文保留'));
    for (const [index, [target, code]] of [
      [path.join(another, 'alpha-notes.txt'), 'TASK_FILE_NOT_ALLOWED'],
      ['nested/nested.txt', 'TASK_FILE_NOT_ALLOWED'],
      ['link.txt', 'TASK_FILE_NOT_ALLOWED'],
      ['hard.txt', 'TASK_FILE_NOT_ALLOWED'],
      ['large.txt', 'TASK_FILE_TOO_LARGE'],
      ['binary.txt', 'TASK_FILE_TEXT_INVALID'],
      ['control.txt', 'TASK_FILE_TEXT_BLOCKED'],
      ['missing.txt', 'TASK_FILE_NOT_FOUND'],
    ].entries()) await checkFailure(target, 813010 + index, code);
    const beforeDenied = f.platformSends.length;
    await h.handleIncoming('group', 90001, packet('alpha-notes.txt', 813020, { group_id: 90001 }), h.cfg);
    await h.handleIncoming('private', 42, packet('alpha-notes.txt', 813021, { user_id: 42 }), h.cfg);
    await send(packet('alpha-notes.txt', 813022, { self_id: 123456 }));
    assert.equal(f.platformSends.length, beforeDenied);

    let entered, unblock;
    const blockerEntered = new Promise(resolve => { entered = resolve; });
    const blockerReply = new Promise(resolve => { unblock = resolve; });
    reply = () => { entered(); return blockerReply; };
    const blocker = h.sendOwnerManagementReply({ conversationKey: KEY, text: '队列占位', phase: 'status' });
    await blockerEntered;
    const queued = send(packet('alpha-notes.txt', 813023));
    try {
      const taskId = `mac-read-${crypto.createHash('sha256').update(JSON.stringify([LOGIN, KEY, '813023'])).digest('hex').slice(0, 16)}`;
      for (let attempt = 0; attempt < 200 && h.taskLedger.getTask(taskId)?.delivery?.status !== 'delivering'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(h.taskLedger.getTask(taskId)?.delivery?.status, 'delivering');
      fs.renameSync(grant, `${grant}.revoked`);
    } finally {
      reply = { status: 'ok', retcode: 0, data: { message_id: -9003 } };
      unblock(reply);
      await Promise.all([blocker, queued]);
    }
    assert.equal(f.platformSends.length, beforeDenied + 2);
    assert.match(response(), /TASK_FILE_SEND_SCOPE_CHANGED/);
    assert.doesNotMatch(response(), /正文保留/);
    assert.equal(f.nativeSubmissions.length, nativeBefore);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  });
  if (process.platform !== 'win32') await test('owner QQ creates a complete file once and preserves existing entries', async () => {
    const state = path.join(h.temp, 'state');
    const readRoot = path.join(state, 'task-files');
    fs.chmodSync(state, 0o700);
    fs.chmodSync(readRoot, 0o700);
    const scopeName = '文件新建验收';
    const directory = path.join(readRoot, scopeName);
    fs.mkdirSync(directory, { mode: 0o700 });
    const grant = `${readRoot}.create-directory`;
    const target = path.join(directory, 'qq-test.txt');
    const original = ' 红豆写入测试 🐾\n  ';
    const packet = (name, body, messageId, extra = {}) => {
      const text = `任务：新建文件 ${name} 写入 ${body}`;
      return inbound({ message_id: messageId, raw_message: text, message: [{ type: 'text', data: { text } }], ...extra });
    };
    const send = args => h.handleIncoming('private', Number(OWNER), args, h.cfg);
    const response = () => JSON.stringify(f.platformSends.at(-1).text);
    const checkFailure = async (event, code) => {
      const count = f.platformSends.length;
      await send(event);
      assert.equal(f.platformSends.length, count + 1);
      assert.match(response(), new RegExp(code));
      assert.doesNotMatch(response(), /红豆写入测试/);
    };
    const nativeBefore = f.nativeSubmissions.length;
    reply = { status: 'ok', retcode: 0, data: { message_id: -9004 } };
    await checkFailure(packet('qq-test.txt', original, 814001), 'TASK_CREATE_SCOPE_REQUIRED');
    assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(grant, `${scopeName}\n`, { mode: 0o600, flag: 'wx' });
    const initial = f.platformSends.length;
    const first = packet('qq-test.txt', original, 814002);
    await Promise.all([send(first), send(first)]);
    assert.equal(f.platformSends.length, initial + 1);
    assert.match(response(), /Mac 文件已新建.*qq-test\.txt/);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(target).nlink, 1);
    const done = h.taskLedger.listTasks({ conversationKey: KEY, limit: 8 }).find(task => task.type === 'file_create' && task.status === 'completed');
    assert.equal(done.delivery.messageId, -9004);
    assert.deepEqual(done.intent, { effect: 'created', name: 'qq-test.txt', bytes: Buffer.byteLength(original) });
    assert.doesNotMatch(JSON.stringify(done), /红豆写入测试/);

    await checkFailure(packet('qq-test.txt', 'rewrite attempt', 814003), 'TASK_CREATE_EXISTS');
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    const outside = path.join(readRoot, 'outside.txt');
    fs.symlinkSync(outside, path.join(directory, 'link.txt'));
    await checkFailure(packet('link.txt', 'payload', 814004), 'TASK_CREATE_EXISTS');
    assert.equal(fs.readlinkSync(path.join(directory, 'link.txt')), outside);
    await checkFailure(packet('../outside.txt', 'payload', 814005), 'TASK_CREATE_NAME_INVALID');
    await checkFailure(packet(outside, 'payload', 814006), 'TASK_CREATE_NAME_INVALID');
    await checkFailure(packet('large.txt', '猫'.repeat(801), 814007), 'TASK_CREATE_TEXT_TOO_LARGE');
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(path.join(directory, 'large.txt')), false);
    const beforeDenied = f.platformSends.length;
    await h.handleIncoming('group', 90001, packet('unauthorized.txt', 'payload', 814010, { group_id: 90001 }), h.cfg);
    await h.handleIncoming('private', 42, packet('unauthorized.txt', 'payload', 814011, { user_id: 42 }), h.cfg);
    await send(packet('unauthorized.txt', 'payload', 814012, { self_id: 123456 }));
    assert.equal(f.platformSends.length, beforeDenied);
    assert.equal(fs.existsSync(path.join(directory, 'unauthorized.txt')), false);

    reply = { status: 'ok', retcode: 0, data: {} };
    const missingAck = packet('ack-unknown.txt', 'Local effect', 814020);
    await send(missingAck);
    const afterUnknown = f.platformSends.length;
    await send(missingAck);
    assert.equal(f.platformSends.length, afterUnknown);
    assert.equal(fs.readFileSync(path.join(directory, 'ack-unknown.txt'), 'utf8'), 'Local effect');
    const uncertain = h.taskLedger.listTasks({ conversationKey: KEY, limit: 10 }).find(task => task.intent?.name === 'ack-unknown.txt');
    assert.equal(uncertain.intent.effect, 'created');
    assert.equal(uncertain.delivery.status, 'delivery_unknown');
    reply = { status: 'ok', retcode: 0, data: { message_id: -9004 } };
    const query = `任务状态 ${uncertain.taskId}`;
    await send(inbound({ message_id: 814021, raw_message: query, message: [{ type: 'text', data: { text: query } }] }));
    assert.match(response(), /文件已新建.*ack-unknown\.txt/);
    assert.match(response(), /delivery_unknown/);
    fs.renameSync(grant, `${grant}.revoked`);
    await checkFailure(packet('revoked.txt', 'payload', 814022), 'TASK_CREATE_SCOPE_REQUIRED');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['ack-unknown.txt', 'link.txt', 'qq-test.txt']);
    assert.ok(!fs.readdirSync(state).some(name => name.startsWith('.task-create-')));
    assert.equal(f.nativeSubmissions.length, nativeBefore);
  });
} finally {
  await f.close();
  assert.ok(fs.realpathSync(root).startsWith(testHome + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
