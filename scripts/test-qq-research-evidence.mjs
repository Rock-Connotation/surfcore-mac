// QQ 研究证据与受控抓取回归（审查 03/04）：
//   1) 生产装配必须走 src/safe-fetch.js 的受控契约（url/statusCode/body/truncated）；
//   2) 结论只能来自本次成功抓取的具体片段；全失败不生成成功报告、不记 completed；
//   3) 混合来源同时列出成功与失败；空正文按失败处理；仅关键词提示补充网址；
//   4) 平台回执未知维持 delivery_unknown，重试不自动重发。
// 全部使用隔离临时目录与假抓取/假平台，不访问真实网络、QQ 或 DSH。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskLedger } from '../src/task-ledger.js';
import { createTaskHarness } from '../src/task-harness.js';
import { safeFetch } from '../src/safe-fetch.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const created = [];
let passed = 0;

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surfcore-${label}-`));
  created.push(dir);
  return dir;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pass(label) {
  passed += 1;
  console.log(`PASS ${label}`);
}

const requestor = {
  platform: 'qq',
  userId: '10001',
  conversationKey: 'private:10001',
  isOwner: true
};

const SOURCE_URL = 'https://source.example/a';
const PHRASE = '量子比特纠错取得突破，研究团队公布了可复现的新结果。';

function htmlWith(text, title = '量子计算进展') {
  return `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
}

function makeHarness({ responses, sendImpl }) {
  const dir = tempDir('research');
  const ledger = createTaskLedger({ stateDir: path.join(dir, 'state') });
  const fetchCalls = [];
  const sends = [];
  const harness = createTaskHarness({
    ledger,
    reportsDir: path.join(dir, 'reports'),
    safeFetchImpl: async (url, maxChars) => {
      fetchCalls.push({ url, maxChars });
      const response = responses[url];
      if (typeof response === 'function') return response(url);
      if (response instanceof Error) throw response;
      if (!response) throw new Error(`unexpected URL: ${url}`);
      return response;
    },
    sendCallback: async (payload) => {
      sends.push(payload);
      return sendImpl ? sendImpl(payload) : { ok: true, messageId: 'mid-1' };
    }
  });
  return { dir, ledger, harness, fetchCalls, sends };
}

try {
  // 1. 有材料且有结论：结论可定位到来源片段，产物哈希与落盘一致。
  {
    const { ledger, harness, fetchCalls, sends } = makeHarness({
      responses: {
        [SOURCE_URL]: {
          url: SOURCE_URL,
          statusCode: 200,
          body: htmlWith(PHRASE),
          truncated: true
        }
      }
    });
    const result = await harness.runTaskPipeline({
      requestor,
      goal: '调研量子计算纠错进展',
      urls: [SOURCE_URL]
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, SOURCE_URL);
    assert.equal(fetchCalls[0].maxChars, 50000, '必须把受控正文上限传给 safe-fetch');
    assert.ok(result.artifact, '必须有产物');
    assert.equal(result.artifact.sourceCount, 1);
    assert.equal(result.artifact.failedSourceCount, 0);
    assert.ok(result.artifact.evidence[0].snippet.includes(PHRASE), '证据必须包含来源正文片段');
    assert.equal(result.artifact.evidence[0].truncated, true);
    const disk = fs.readFileSync(result.artifact.path);
    assert.equal(result.artifact.sha256, sha256(disk), '产物哈希必须与磁盘一致');
    const report = disk.toString('utf8');
    assert.ok(report.includes('来源摘录'), '报告必须标注来源摘录');
    assert.ok(report.includes(PHRASE), '结论必须能定位到来源片段');
    assert.ok(report.includes(SOURCE_URL), '报告必须给出可复核链接');
    assert.ok(report.includes('正文超过读取上限'), '截断来源必须明确标注');
    assert.equal(ledger.getTask(result.taskId).status, 'completed');
    assert.equal(ledger.getTask(result.taskId).delivery.status, 'delivered');
    assert.equal(sends.length, 1);
    assert.ok(sends[0].text.includes('任务完成'));
    assert.ok(sends[0].text.includes(SOURCE_URL));
    pass('有材料且有结论：片段可追溯、产物哈希一致、模拟送达成功');
  }

  // 2. 唯一来源 HTTP 503：失败反馈、0 份成功报告、任务不得 completed。
  {
    const { ledger, harness, sends } = makeHarness({
      responses: {
        [SOURCE_URL]: { url: SOURCE_URL, statusCode: 503, body: '<html>busy</html>', truncated: false }
      }
    });
    const result = await harness.runTaskPipeline({
      requestor,
      goal: '调研唯一来源失败',
      urls: [SOURCE_URL]
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'RESEARCH_NO_SOURCES');
    assert.ok(result.error.includes('HTTP 503'), '失败原因必须包含 HTTP 状态');
    assert.ok(result.error.includes(SOURCE_URL), '失败原因必须包含来源网址');
    assert.ok(result.hint && result.hint.includes('重试'), '必须给出下一步');
    assert.equal(sends.length, 0, '全部来源失败时成功报告发送数必须为 0');
    const saved = ledger.getTask(result.taskId);
    assert.equal(saved.status, 'failed');
    assert.notEqual(saved.status, 'completed');
    assert.equal(saved.artifact, null);
    assert.equal(saved.sources.length, 1);
    assert.equal(saved.sources[0].ok, false);
    assert.equal(saved.sources[0].statusCode, 503);
    assert.ok(!fs.existsSync(path.join(harness.resolvedReportsDir, `report-${result.taskId}.md`)));
    pass('唯一来源 503：结构化失败、0 次投递、任务 failed');
  }

  // 3. 混合来源：成功来源生成结论，失败来源同时列出。
  {
    const okUrl = 'https://source.example/ok';
    const badUrl = 'https://source.example/bad';
    const { ledger, harness, sends } = makeHarness({
      responses: {
        [okUrl]: { url: okUrl, statusCode: 200, body: htmlWith(PHRASE, '成功来源'), truncated: false },
        [badUrl]: { url: badUrl, statusCode: 502, body: '<html>bad gateway</html>', truncated: false }
      }
    });
    const result = await harness.runTaskPipeline({
      requestor,
      goal: '调研混合来源',
      urls: [okUrl, badUrl]
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.artifact.sourceCount, 1);
    assert.equal(result.artifact.failedSourceCount, 1);
    const report = fs.readFileSync(result.artifact.path, 'utf8');
    assert.ok(report.includes(PHRASE));
    assert.ok(report.includes(okUrl));
    assert.ok(report.includes(badUrl));
    assert.ok(report.includes('失败：HTTP 502'), '报告必须列出失败来源与状态');
    assert.equal(sends.length, 1);
    assert.ok(sends[0].text.includes('【失败来源】1 个'), '回执必须列出失败来源数量');
    assert.equal(ledger.getTask(result.taskId).sources.filter(s => s.ok === false).length, 1);
    pass('混合来源：成功结论 + 失败来源均可见');
  }

  // 4. 空正文：不能当作证据，也不能生成成功报告。
  {
    const { harness, sends } = makeHarness({
      responses: {
        [SOURCE_URL]: { url: SOURCE_URL, statusCode: 200, body: '   \n\t  ', truncated: false }
      }
    });
    const result = await harness.runTaskPipeline({
      requestor,
      goal: '调研空正文',
      urls: [SOURCE_URL]
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'RESEARCH_NO_SOURCES');
    assert.ok(result.error.includes('来源正文为空'));
    assert.ok(result.hint);
    assert.equal(sends.length, 0);
    pass('空正文按失败处理，0 次成功投递');
  }

  // 4b. 本次只有失败来源时，旧摘录不得充当本次成功证据。
  {
    const OLD = 'https://source.example/old';
    const NEW = 'https://source.example/only-503';
    const { dir, ledger, harness, fetchCalls, sends } = makeHarness({ responses: {
      [OLD]: { statusCode: 200, body: htmlWith('旧资料'), truncated: false },
      [NEW]: { statusCode: 503, body: '', truncated: false }
    } });
    const task = ledger.createTask({ goal: '旧摘录不得计入本次', type: 'research', requestor, steps: ['admission', 'research', 'synthesis', 'delivery'] });
    ledger.updateTask(task.taskId, { sources: [{ url: OLD, requestedUrl: OLD, title: '旧来源', snippet: '旧资料', fetchedAt: 1, byteLength: 6, statusCode: 200, ok: true }] });
    const result = await harness.runTaskPipeline({ taskId: task.taskId, requestor, goal: task.goal, urls: [NEW] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RESEARCH_NO_SOURCES');
    assert.ok(result.error.includes('HTTP 503'));
    assert.equal(fetchCalls.length, 1);
    assert.equal(sends.length, 0);
    const saved = ledger.getTask(task.taskId);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.artifact ?? null, null);
    assert.ok(!(saved.sources || []).some(s => s.ok && s.url === OLD), '旧摘录不得留在本次来源中');
    const reports = path.join(dir, 'reports');
    assert.ok(!fs.existsSync(reports) || fs.readdirSync(reports).length === 0);
    pass('本次仅有失败来源时旧摘录不得计入成功');
  }

  // 4c. 受控结构、旧 text() 与原生 Response 三种形态都必须读到真实正文。
  {
    const CONTROL = 'https://source.example/controlled';
    const LEGACY = 'https://source.example/legacy-text';
    const STANDARD = 'https://source.example/standard-response';
    const snippets = ['受控结构正文可复现。', '旧接口正文可复现。', '标准响应正文可复现。'];
    const responses = {
      [CONTROL]: { statusCode: 200, body: htmlWith(snippets[0]), truncated: false },
      [LEGACY]: { status: 200, url: LEGACY, text: async () => htmlWith(snippets[1]) },
      [STANDARD]: new Response(htmlWith(snippets[2]), { status: 200 })
    };
    const { harness, sends } = makeHarness({ responses });
    for (let i = 0; i < snippets.length; i += 1) {
      const url = [CONTROL, LEGACY, STANDARD][i];
      const result = await harness.runTaskPipeline({ requestor, goal: '三形态正文 ' + url, urls: [url] });
      assert.equal(result.ok, true, result.error || '');
      assert.equal(result.artifact.sourceCount, 1);
      assert.ok(result.artifact.evidence[0].snippet.includes(snippets[i]));
      assert.ok(!JSON.stringify(result).includes('[object ReadableStream]'));
    }
    assert.equal(sends.length, 3);
    pass('三种抓取返回形态均读取真实正文');
  }

  // 4d. 仅有 Login 标题的页面不是研究证据。
  {
    const LOGIN = 'https://source.example/login';
    const { harness, sends } = makeHarness({ responses: {
      [LOGIN]: { statusCode: 200, body: '<html><head><title>Login</title></head><body></body></html>', truncated: false }
    } });
    const result = await harness.runTaskPipeline({ requestor, goal: '登录页 ' + LOGIN, urls: [LOGIN] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RESEARCH_NO_SOURCES');
    assert.ok(result.error.includes('来源正文为空'));
    assert.equal(sends.length, 0);
    pass('仅 Login 标题页面不得完成');
  }

  // 5. 仅关键词：明确提示补充网址，保留重试；不执行、不投递成功报告。
  {
    const { ledger, harness, sends } = makeHarness({ responses: {} });
    const result = await harness.runTaskPipeline({
      requestor,
      goal: '量子计算最新进展'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RESEARCH_URLS_REQUIRED');
    assert.ok(result.hint.includes('请补充网址'), '必须明确提示补充网址');
    assert.equal(result.taskId ?? null, null, '仅关键词不得创建工单');
    assert.equal(sends.length, 0);
    assert.equal(ledger.listTasks({ conversationKey: requestor.conversationKey }).length, 0);
    pass('仅关键词：先提示补充网址，未创建工单、未投递报告');
  }

  // 6. 送达未知：维持 delivery_unknown；重试不自动重发。
  {
    const { ledger, harness, sends } = makeHarness({
      responses: {
        [SOURCE_URL]: { url: SOURCE_URL, statusCode: 200, body: htmlWith(PHRASE), truncated: false }
      },
      sendImpl: async () => ({ ok: false, error: 'platform timeout' })
    });
    const first = await harness.runTaskPipeline({
      requestor,
      goal: '调研送达未知',
      urls: [SOURCE_URL]
    });
    assert.equal(first.ok, false);
    assert.equal(first.status, 'unknown');
    assert.ok(first.delivery.code && first.delivery.hint);
    const saved = ledger.getTask(first.taskId);
    assert.equal(saved.status, 'unknown');
    assert.equal(saved.delivery.status, 'delivery_unknown');
    assert.equal(sends.length, 1);
    const second = await harness.runTaskPipeline({
      requestor,
      goal: '调研送达未知',
      urls: [SOURCE_URL],
      taskId: first.taskId
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'OWNER_REPLY_UNKNOWN');
    assert.ok(second.hint);
    assert.equal(sends.length, 1, '送达未知后重试不得自动重发');
    assert.equal(ledger.getTask(first.taskId).delivery.status, 'delivery_unknown');
    pass('送达未知维持 delivery_unknown，重试不重发');
  }

  // 7. 正式 QQ 入口：仅关键词提示补充网址；带网址时生产装配实际调用受控抓取。
  {
    const responses = new Map();
    const fetchCalls = [];
    const h = await bridgeHarness({
      config: {
        ownerQQ: 10001,
        allow: { private: ['10001'], groups: [] },
        deny: { private: [], groups: [], users: [] },
        slang: { enabled: false },
        socialV2: { tokenGuard: { enabled: false } }
      },
      globals: {
        safeFetch: async (url, maxChars) => {
          fetchCalls.push({ url, maxChars });
          const response = responses.get(url);
          if (!response) throw new Error(`unexpected URL: ${url}`);
          return response;
        }
      }
    });
    try {
      h.bot.sendPrivateMessage = async (id, message) => {
        h.calls.sent.push({ kind: 'private', id, text: message });
        return { status: 'ok', retcode: 0, data: { message_id: 9001 } };
      };
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

      const keywordSends = await send('任务：量子计算最新进展');
      assert.equal(keywordSends.length, 1, '仅关键词只回一条补网址提示');
      assert.ok(keywordSends.some(item => String(item.text).includes('请补充网址')), '入口必须提示补充网址');
      assert.ok(!keywordSends.some(item => String(item.text).includes('收到电脑研究任务')), '未创建工单不得声称已开始执行');
      assert.ok(!keywordSends.some(item => String(item.text).includes('任务完成')));
      assert.equal(fetchCalls.length, 0, '仅关键词不得发起抓取');
      assert.equal(h.taskLedger.listTasks({ conversationKey: 'private:10001' }).length, 0, '仅关键词不得建单或复用旧任务');

      responses.set('https://source.example/bridge', {
        url: 'https://source.example/bridge',
        statusCode: 200,
        body: htmlWith(PHRASE, '入口来源'),
        truncated: false
      });
      const urlSends = await send('任务：调研量子计算 https://source.example/bridge');
      assert.equal(fetchCalls.length, 1, '正式入口必须实际调用受控抓取');
      assert.deepEqual(fetchCalls[0], { url: 'https://source.example/bridge', maxChars: 50000 });
      assert.ok(urlSends.some(item => String(item.text).includes('任务完成')), '成功路径必须投递报告摘要');
      const tasks = h.taskLedger.listTasks({ conversationKey: 'private:10001', limit: 10 });
      const completed = tasks.find(task => task.goal.includes('调研量子计算'));
      assert.ok(completed, '必须能在账本中查到任务');
      assert.equal(completed.status, 'completed');
      assert.equal(completed.delivery.status, 'delivered');
      const report = fs.readFileSync(completed.artifact.path, 'utf8');
      assert.ok(report.includes(PHRASE), '入口报告必须包含来源片段');

      responses.set('https://source.example/bridge-fail', {
        url: 'https://source.example/bridge-fail',
        statusCode: 503,
        body: '<html>busy</html>',
        truncated: false
      });
      const failedSends = await send('任务：调研失败来源 https://source.example/bridge-fail');
      assert.ok(failedSends.some(item => String(item.text).includes('[任务失败]') && String(item.text).includes('HTTP 503')), 'QQ 入口必须收到失败反馈');
      assert.ok(failedSends.some(item => String(item.text).includes('下一步')));
      assert.ok(!failedSends.some(item => String(item.text).includes('任务完成')), '全失败不得投递成功报告');
      const failedTask = h.taskLedger.listTasks({ conversationKey: 'private:10001', limit: 10 })
        .find(task => task.goal.includes('调研失败来源'));
      assert.ok(failedTask);
      assert.equal(failedTask.status, 'failed', '全失败任务不得记 completed');
      pass('QQ 入口：关键词提示补网址，带网址走受控抓取并完成；503 失败可见且不投递');
    } finally {
      await h.close();
    }
  }

  // 8. 正式装配仍走 src/safe-fetch.js 的受控契约；测试替身只用于受控抓取，不替代正式策略。
  {
    const harnessSrc = fs.readFileSync(new URL('../src/task-harness.js', import.meta.url), 'utf8');
    const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    const safeSrc = fs.readFileSync(new URL('../src/safe-fetch.js', import.meta.url), 'utf8');
    assert.match(harnessSrc, /import\s+\{\s*safeFetch\s*\}\s+from\s+'\.\/safe-fetch\.js'/);
    assert.match(harnessSrc, /safeFetchImpl\s*=\s*safeFetch/);
    assert.match(bridgeSrc, /safeFetchImpl:\s*safeFetch/);
    assert.match(safeSrc, /export async function safeFetch\(urlString, maxChars = 50000\)/);
    assert.match(safeSrc, /const MAX_REDIRECTS = 5/);
    await assert.rejects(() => safeFetch('ftp://example.com/a'), /仅允许 http\/https/);
    await assert.rejects(() => safeFetch('https://example.com/a', 0), /maxChars 必须为正整数/);
    await assert.rejects(() => safeFetch('http://127.0.0.1:9/'), /禁止访问内网\/本机地址/);
    pass('正式抓取装配与目标/限额/内网策略保持原样');
  }

  console.log(`\n${passed} 组 QQ 研究证据测试通过。`);
} finally {
  for (const dir of created) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
