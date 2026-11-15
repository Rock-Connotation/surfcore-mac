import { newCaseRoot, createRealV2Factory, assert, good, KEY, LOGIN, OWNER, fs, path, testHome } from './r2-v2-fixture.mjs';
const { root, stateDir } = newCaseRoot('admission');
process.once('exit', () => {
  if (fs.existsSync(root)) {
    assert.ok(fs.realpathSync(root).startsWith(testHome + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
process.env.DSH_HOME = root;
process.env.R2_CASE_ROOT = root;
process.env.R2_CASE_STATE_DIR = stateDir;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let synthStarted, synthContinue, pausedMethod, entered, resume, ownerEntered = deferred(), ownerResume = deferred(), ownerRetired = 0, internalLease, outboundCapture, pausePrepare = false, prepareEntered, prepareResume;
const f = await createRealV2Factory({ afterPrepareContext: async () => { if (pausePrepare) { pausePrepare = false; prepareEntered.resolve(); await prepareResume.promise; } }, onClientEvent: (name, event) => { if (name === 'capture' && event.args[1]?.sourceFacts?.direction === 'outbound') outboundCapture = event; }, createOwner: async () => {
  ownerEntered.resolve(); await ownerResume.promise;
  return { sessionId: 'controlled-owner', retire: async () => { ownerRetired++; }, validateOwnedToolContext: () => ({ ok: false }) };
}, afterMemoryCall: async (name, result) => {
  if (name === 'authorizeSend' && result.ok) internalLease = result.lease;
  if (name === pausedMethod) { pausedMethod = null; entered.resolve(); await resume.promise; }
}, synthesizeImpl: async request => {
  synthStarted.resolve(); await synthContinue.promise;
  fs.mkdirSync(request.outDir, { recursive: true });
  const file = path.join(request.outDir, 'voice.wav'); fs.writeFileSync(file, Buffer.alloc(44));
  return { path: file, cached: false, durationMs: 25 };
} });
const h = f.harness;
let mode = 'chat', objectId = 0;
h.api.settings.describe = async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode } }] } } });
const refresh = async value => { mode = value; await h.checkDsh(); };
const makeJob = async () => {
  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: String(++objectId), direction: 'inbound', text: '测试当前消息' }));
  good(await h.qqMemory.prepareReply({ key: KEY }));
  const job = good(h.nativeQQ.begin(KEY, f.role, 1)).request;
  const lease = good(await h.nativeQQ.request({ ...job, action: 'authorize', loginAccountId: LOGIN })).lease;
  return { job, lease };
};
try {
  await refresh('chat');
  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: '7001', text: '旧准备' }));
  pausePrepare = true; prepareEntered = deferred(); prepareResume = deferred();
  const oldPrepare = h.qqMemory.prepareReply({ key: KEY });
  await prepareEntered.promise;
  await refresh('reserved'); await refresh('chat');
  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: '7002', text: '新准备' }));
  good(await h.qqMemory.prepareReply({ key: KEY }));
  const beforeLate = good(await h.qqMemory.exportNativeSources(KEY));
  prepareResume.resolve();
  const oldPrepared = await oldPrepare;
  const afterLate = good(await h.qqMemory.exportNativeSources(KEY));
  assert.deepEqual(afterLate.packet.sources, beforeLate.packet.sources, `late preparation overwrote newer active: ${JSON.stringify(oldPrepared)}`);
  assert.equal(oldPrepared.code, 'MEMORY_QQ_ADMISSION_CANCELLED');
  console.log('PASS late preparation cannot overwrite new active');
  const before = h.modeAdmissionSnapshot(); await refresh('chat');
  assert.equal(h.modeAdmissionSnapshot().revision, before.revision, 'same effective mode must preserve permission generation');
  console.log('PASS same mode preserves generation');
  let { job, lease } = await makeJob();
  synthStarted = deferred(); synthContinue = deferred();
  let sending = h.nativeQQ.request({ ...job, action: 'send', lease, text: '语音测试', delivery: 'voice' });
  await synthStarted.promise; await refresh('chat'); synthContinue.resolve();
  const voice = await sending;
  assert.equal(voice.ok, true, `same mode checkDsh must not cancel TTS: ${JSON.stringify(voice)}`);
  console.log('PASS checkDsh same mode sends voice', JSON.stringify(voice));
  good(await h.nativeQQ.request({ ...job, action: 'complete', ok: true }));
  ({ job, lease } = await makeJob());
  await refresh('reserved'); await refresh('chat');
  const sends = f.platformSends.length;
  const old = await h.nativeQQ.request({ ...job, action: 'send', lease, text: '不应发送' });
  assert.ok(['MEMORY_QQ_JOB_STALE', 'MEMORY_SOURCE_LEASE_REQUIRED'].includes(old.code), JSON.stringify(old));
  assert.equal(f.platformSends.length, sends);
  console.log('PASS blocked recovery rejects old lease', JSON.stringify(old));
  const retainedLease = internalLease;
  const retainedHandle = outboundCapture.result.handle;
  const recordAfterCancel = await h.qqMemory.recordSent(retainedLease, { text: '不应记账', messageId: '9002', deliveryState: 'delivered' });
  assert.equal(recordAfterCancel.code, 'MEMORY_SOURCE_LEASE_REQUIRED', `discarded underlying lease must not record: ${JSON.stringify(recordAfterCancel)}`);
  assert.deepEqual(await h.qqMemory.discardSend(retainedLease), { ok: true, discarded: false });
  const released = await outboundCapture.client.validate(retainedHandle);
  assert.equal(released.ok, false, `discarded Host handle must be released: ${JSON.stringify(released)}`);
  console.log('PASS underlying lease discarded and Host handle released', JSON.stringify({ recordAfterCancel, released }));

  entered = deferred(); resume = deferred(); pausedMethod = 'captureSource';
  const inbound = h.handleIncoming('private', Number(OWNER), { self_id: Number(LOGIN), user_id: Number(OWNER), message_id: 1234, raw_message: '入站暂停测试', message: [{ type: 'text', data: { text: '入站暂停测试' } }], sender: { nickname: '主人' } }, h.cfg);
  await entered.promise; const priorSubmissions = f.nativeSubmissions.length;
  await refresh('reserved'); await refresh('chat'); resume.resolve(); await inbound;
  assert.equal(f.nativeSubmissions.length, priorSubmissions, 'captureSource recovery must not submit work');
  console.log('PASS captureSource blocked boundary prevents submission');

  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: String(++objectId), text: '准备阶段测试' }));
  entered = deferred(); resume = deferred(); pausedMethod = 'prepareReply';
  const prepared = h.deliverPromptNow(KEY, '测试', {});
  await entered.promise; const beforePrepare = f.nativeSubmissions.length;
  await refresh('reserved'); await refresh('chat'); resume.resolve();
  const preparedResult = await prepared;
  assert.equal(preparedResult.ok, false, JSON.stringify(preparedResult));
  assert.equal(f.nativeSubmissions.length, beforePrepare, 'prepareReply recovery must not submit work');
  console.log('PASS prepareReply blocked boundary prevents submission', JSON.stringify(preparedResult));

  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: String(++objectId), text: '授权阶段测试' }));
  good(await h.qqMemory.prepareReply({ key: KEY }));
  job = good(h.nativeQQ.begin(KEY, f.role, 2)).request;
  entered = deferred(); resume = deferred(); pausedMethod = 'authorizeSend';
  const authorizing = h.nativeQQ.request({ ...job, action: 'authorize', loginAccountId: LOGIN });
  await entered.promise; await refresh('reserved'); await refresh('chat'); resume.resolve();
  const authorized = await authorizing;
  assert.equal(authorized.ok, false, JSON.stringify(authorized));
  const staleRecord = await h.qqMemory.recordSent(internalLease, { text: '不可记账', messageId: '9003', deliveryState: 'delivered' });
  assert.equal(staleRecord.code, 'MEMORY_SOURCE_LEASE_REQUIRED');
  const staleHandle = await outboundCapture.client.validate(outboundCapture.result.handle);
  assert.equal(staleHandle.ok, false, JSON.stringify(staleHandle));
  console.log('PASS authorizeSend blocked boundary denies lease and releases handle', JSON.stringify({ authorized, staleRecord, staleHandle }));

  ({ job, lease } = await makeJob());
  synthStarted = deferred(); synthContinue = deferred();
  const beforeVoice = f.platformSends.length;
  sending = h.nativeQQ.request({ ...job, action: 'send', lease, text: '取消语音测试', delivery: 'voice' });
  await synthStarted.promise; await refresh('reserved'); synthContinue.resolve();
  const blockedVoice = await sending;
  assert.equal(blockedVoice.ok, false, JSON.stringify(blockedVoice)); assert.ok(blockedVoice.code && blockedVoice.hint);
  assert.equal(f.platformSends.length, beforeVoice);
  console.log('PASS blocked TTS cancels voice', JSON.stringify(blockedVoice));
  await refresh('chat');
  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: String(++objectId), text: '宿主取消测试' }));
  const submitted = good(await h.deliverPromptNow(KEY, '宿主取消测试'));
  let ownerTimer;
  try { await Promise.race([ownerEntered.promise, new Promise((_, reject) => { ownerTimer = setTimeout(() => reject(new Error('controlled owner was not reached: ' + JSON.stringify(f.replyHost.getReceipt(submitted.requestId)))), 5000); })]); }
  finally { clearTimeout(ownerTimer); }
  await refresh('reserved'); ownerResume.resolve();
  await f.replyHost.whenIdle();
  assert.equal(ownerRetired, 1, 'blocked must retire the in-flight owner');
  await refresh('chat');
  const oldCompletion = await h.nativeQQ.request({ ...f.nativeSubmissions.at(-1), action: 'sources' });
  assert.equal(oldCompletion.ok, false);
  console.log('PASS Host owner retired after blocked', JSON.stringify({ ownerRetired, oldCompletion, requestId: submitted.requestId }));
  good(await h.qqMemory.captureSource({ key: KEY, loginAccountId: LOGIN, actorAccountId: OWNER, objectId: String(++objectId), text: '恢复后的新输入' }));
  const fresh = good(await h.deliverPromptNow(KEY, '恢复后的新输入'));
  assert.notEqual(fresh.requestId, submitted.requestId);
  console.log('PASS fresh Host request accepted after recovery', JSON.stringify(fresh));
} catch (error) { console.error('FAIL', error?.stack ?? error); process.exitCode = 1; }
finally {
  synthContinue?.resolve();
  await f.close();
  assert.ok(fs.realpathSync(root).startsWith(testHome + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
