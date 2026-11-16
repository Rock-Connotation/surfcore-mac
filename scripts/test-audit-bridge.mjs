import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run, options) {
  const h = await bridgeHarness(options);
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('retired unrestricted mode cannot create a QQ model session', async h => {
  h.setMode('closed-agent');
  await assert.rejects(h.ensureSession('private:123'), { code: 'MEMORY_PRESET_UNSAFE' });
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.nativeReplies.length, 0);
});

await test('queued send rechecks allowlist at transport time', async h => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});

await test('accepted QQ reply queues Native instead of selecting models or submitting prompts', async h => {
  h.api.sessions.selectModel = () => assert.fail('legacy model selection');
  h.api.sessions.prompt = () => assert.fail('legacy prompt');
  const queued = await h.deliverPrompt('private:123', 'old queued string');
  assert.equal(queued.ok, true);
  assert.equal(queued.providerAdmissionCoverage, 'native-owner');
  assert.equal(h.calls.nativeReplies.length, 1);
  assert.ok(!JSON.stringify(h.calls.nativeReplies).includes('old queued string'));
});

await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = 'fixture-retired-session';
    h.state.sessions['private:123'] = sessionId;
    h.state.sessionPolicies['private:123'] = { seed: true };
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await assert.rejects(h.sendStickerV2('group:456', 'fixture-sticker'), { code: 'MEMORY_PRESET_UNSAFE' });
    assert.equal(body, undefined);
    console.log('PASS unauthorised sticker sending cannot reach OneBot');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true, trigger: {who:'anyone'} } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, fs.realpathSync(path.join(audioDir, 'hello.mp3')), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 指向库内文件
    const sent = await h.sendVoiceTransport('group:456', okPath.path, { guard: true });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, fs.realpathSync(path.join(audioDir, 'hello.mp3')), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.ok(!h.calls.http.some(c => c.url.endsWith('/fetch_ptt_text')));

    const verification = await h.verifyVoiceMessageSent(sent.messageId);
    assert.equal(verification.confirmed, true);
    assert.equal(verification.duration, 3);
    assert.equal(verification.file, undefined);

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // A declined memory lease has no network side effects. The Native suite
    // exercises successful authorised synthesis and per-conversation limits.
    const gatewayCalls = h.calls.http.length;
    await assert.rejects(h.sendVoiceForV2('group:456', 'hello.mp3'), { code: 'MEMORY_PRESET_UNSAFE' });
    assert.equal(h.calls.http.length, gatewayCalls);

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceTransport('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: { ...voiceOn, socialV2: { ...voiceOn.socialV2, voice: { ...voiceOn.socialV2?.voice, maxPerMinute: 10 } } } });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceTransport('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceTransport('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceTransport('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, trigger: {who:'anyone'}, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceTransport('group:456', h.resolveVoicePathForV2(path.join(libraryDir, 'inside.mp3')).path, { guard: true });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': h.getSocialV2State('group:456').agentToken };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    const adminJson = JSON.parse(adminOk.body || '{}');
    assert.ok(Array.isArray(adminJson.models), '模型目录接口必须返回 models 数组（目录不可用也要是空数组）');
    assert.ok(Array.isArray(adminJson.providers), '模型目录接口必须返回 providers 数组');
    const badModel = await call('/api/dsh/model', 'POST', adminOnly, {});
    assert.equal(badModel.status, 400, '缺少 provider/model 必须 400，不能静默保存');
    assert.equal(JSON.parse(badModel.body || '{}').code, 'MODEL_REQUIRED');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('fish guard blocks reserved2 sends when the group is overfished', async (h) => {
  h.setMode('reserved2');
  h.cfg.fishGuard = {
    ...h.cfg.fishGuard, enabled: true, maxFish: 3, maxConsecutiveFish: 99,
    maxFishMessages: 99, maxFishRatio: 1, minSample: 100, cooldownMs: 60_000, blockSends: true,
  };
  const key = 'group:456';
  const now = Date.now();
  const st = h.getSocialV2State(key);
  st.recentMessages = [
    { sender: '测试肥鱼', userId: '1', time: now - 3000, fish: true },
    { sender: '大肥鱼', userId: '2', time: now - 2000, fish: true },
    { sender: 'fish', userId: '3', time: now - 1000, fish: true },
    { sender: '真人', userId: '9', time: now - 500 },
  ];
  const block = h.fishGuardSendBlock(key, st);
  assert.ok(block, '3 条不同的鱼应触发硬拦');
  // 管理员/被直接叫到时放行（只放一条，冷却仍在）
  st.unread = [{ isOwner: true, time: now }];
  assert.equal(h.fishGuardSendBlock(key, st), null, '管理员消息应放行');
  st.unread = [];
  // 窗口清空 + 清掉冷却 → 恢复
  st.recentMessages = [{ sender: '真人', userId: '9', time: now }];
  delete st.fishGuard;
  delete st.fishGuardBypass;
  assert.equal(h.fishGuardSendBlock(key, st), null, '干净窗口应放行');
});

await test('retired slang derivation has a recoverable error and never sends old chat to a model', async h => {
  const result = await h.runSlangExtraction('private:123');
  assert.equal(result.code, 'MEMORY_DERIVATION_UNAVAILABLE');
  assert.ok(result.hint);
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.prompts.length, 0);
});

if (failures) process.exitCode = 1;
