// 本地任务执行准入与网页研究编排 Harness
// 职责：
// 1. 独立执行准入：仅验证身份的主人可发起电脑/研究任务，普通群聊与网页内容严防提权；
// 2. 网页研究：受控获取来源、记录真实 URL/时间戳/内容摘要；
// 3. 产物生成：核验文件路径、字节数、哈希，确认物理落盘；
// 4. 平台回传：准确跟踪发送回执，失败/未知绝不虚假声称成功。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { safeFetch } from './safe-fetch.js';

// 研究来源的受控读取上限：safe-fetch 在读取阶段按字符截断，并保留 truncated 标记。
const RESEARCH_MAX_CHARS = 50000;
const RESEARCH_SNIPPET_CHARS = 600;

const SYSTEM_RESTRICTED_ROOTS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/Library',
  '/Applications',
  '/private/etc',
  '/private/var/db',
  '/private/var/root',
  '/private/var/log'
];

export function isSystemRestrictedPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return true;
  const resolved = path.resolve(targetPath);
  if (resolved === '/' || resolved === '') return true;
  // 允许合法的临时目录（macOS 上的 /private/var/folders 与 /private/tmp）
  if (resolved.startsWith('/private/var/folders') || resolved.startsWith('/private/tmp') || resolved.startsWith('/tmp')) {
    return false;
  }
  for (const sysRoot of SYSTEM_RESTRICTED_ROOTS) {
    if (resolved === sysRoot || resolved.startsWith(sysRoot + path.sep)) {
      return true;
    }
  }
  return false;
}

function cleanHtmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html, fallback) {
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(String(html ?? ''));
  return titleMatch ? titleMatch[1].trim() : fallback;
}

/**
 * 统一受控抓取契约：生产实现返回 {url,statusCode,body,truncated}；
 * 兼容旧测试替身/原生 Response 的 {text()} 形态，避免调用方各自判断。
 */
async function normalizeResearchResult(result, requestedUrl) {
  if (!result || typeof result !== 'object') throw new Error('抓取结果无效');
  const url = String(result.url || requestedUrl);
  const statusCode = Number(result.statusCode ?? result.status ?? 200);
  let body = '';
  if (typeof result.body === 'string') {
    body = result.body;
  } else if (typeof result.text === 'function') {
    body = String(await result.text());
  } else if (result.body && typeof result.body.text === 'function') {
    body = String(await result.body.text());
  } else if (result.body !== undefined && result.body !== null) {
    body = String(result.body);
  }
  return { url, statusCode, body, truncated: Boolean(result.truncated) };
}

export function createTaskHarness({
  ledger,
  reportsDir,
  safeFetchImpl = safeFetch,
  sendCallback = async () => ({ ok: true }),
  now = Date.now,
  log = () => {}
} = {}) {
  if (!ledger) throw new TypeError('ledger is required.');
  const resolvedReportsDir = path.resolve(reportsDir || './state/reports');

  // 账本读写失败必须变成结构化失败交给入口展示；绝不吞成空账本继续执行任务。
  function ledgerFailure(error, extra = {}) {
    return {
      ok: false,
      code: 'TASK_LEDGER_UNAVAILABLE',
      error: error?.error || error?.message || '本机任务账本不可读。',
      hint: error?.hint || '保留任务账本文件，检查文件和读写权限后重试。',
      ...extra
    };
  }

  // 1. 独立执行准入检查
  function checkAdmission({ requestor, action = 'research', targetPath = '', allowedRoots = [] } = {}) {
    if (!requestor || typeof requestor !== 'object') {
      return {
        ok: false,
        code: 'ADMISSION_DENIED',
        error: '缺少请求者身份。',
        hint: '仅已验证身份的主人私聊可发起电脑与研究任务。'
      };
    }

    // 铁律：普通群聊与普通社交会话不得获得电脑控制或执行权限
    if (requestor.platform === 'qq' && requestor.conversationKey?.startsWith('group:')) {
      return {
        ok: false,
        code: 'ADMISSION_GROUP_DENIED',
        error: '群聊环境禁止执行电脑任务或直接产生本地副作用。',
        hint: '请切换至 QQ 私聊由管理员直接发起任务。'
      };
    }

    if (!requestor.isOwner) {
      return {
        ok: false,
        code: 'ADMISSION_OWNER_REQUIRED',
        error: '非管理员无权发起电脑执行任务。',
        hint: '请联系系统管理员通过主人私聊发起。'
      };
    }

    // 路径越界与系统受限目录检查
    if (targetPath) {
      const resolvedTarget = path.resolve(targetPath);
      if (isSystemRestrictedPath(resolvedTarget)) {
        return {
          ok: false,
          code: 'ADMISSION_PATH_RESTRICTED',
          error: `目标路径 [${targetPath}] 属于系统受限目录，严禁访问。`,
          hint: '请将操作限制在已授权的工作目录或项目沙箱中。'
        };
      }
      if (allowedRoots && allowedRoots.length > 0) {
        const inAllowed = allowedRoots.some(root => resolvedTarget.startsWith(path.resolve(root)));
        if (!inAllowed) {
          return {
            ok: false,
            code: 'ADMISSION_PATH_RESTRICTED',
            error: `目标路径 [${targetPath}] 超出已授权白名单范围。`,
            hint: `允许的目录范围为：${allowedRoots.join(', ')}`
          };
        }
      } else if (!resolvedTarget.startsWith(resolvedReportsDir) && !resolvedTarget.startsWith(path.resolve('./output')) && !resolvedTarget.startsWith(path.resolve('./sandbox')) && !resolvedTarget.startsWith(path.resolve('./state'))) {
        return {
          ok: false,
          code: 'ADMISSION_PATH_RESTRICTED',
          error: `目标路径 [${targetPath}] 超出安全报告工作区范围。`,
          hint: `允许的报告目录为 ${resolvedReportsDir}`
        };
      }
    }

    return { ok: true, code: 'ADMISSION_GRANTED' };
  }

  // 2. 网页研究步骤：抓取网页并记录来源
  async function executeResearchStep(task, { urls = [], query = '' } = {}) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    ledger.updateTask(task.taskId, {
      status: 'executing',
      intent: { action: 'web_research', urls, query }
    });

    // 每次执行只认本次实际抓到的来源；旧摘录不得冒充本次成功证据。
    const sources = [];
    for (const targetUrl of urls) {
      let normalized = null;
      try {
        log(`[Harness] 抓取研究资料来源: ${targetUrl}`);
        // 生产默认走 src/safe-fetch.js：目标地址检查、逐跳重定向复核、正文上限都在那里。
        normalized = await normalizeResearchResult(
          await safeFetchImpl(targetUrl, RESEARCH_MAX_CHARS),
          targetUrl
        );
        if (!(normalized.statusCode >= 200 && normalized.statusCode < 300)) {
          throw Object.assign(new Error(`HTTP ${normalized.statusCode || '未知'}`), {
            statusCode: normalized.statusCode
          });
        }
        const html = normalized.body;
        const cleanText = cleanHtmlToText(html);
        const authWallOnly = /^(?:login|sign in|log in|登录|please log in|access denied|forbidden)$/i.test(cleanText);
        if (!cleanText || authWallOnly) {
          throw Object.assign(new Error('来源正文为空，无法作为研究证据'), { code: 'SOURCE_EMPTY_BODY' });
        }
        sources.push({
          url: normalized.url,
          requestedUrl: targetUrl,
          title: extractTitle(html, normalized.url),
          snippet: cleanText.slice(0, RESEARCH_SNIPPET_CHARS),
          fetchedAt: now(),
          byteLength: Buffer.byteLength(cleanText),
          statusCode: normalized.statusCode,
          truncated: normalized.truncated,
          ok: true
        });
      } catch (err) {
        log(`[Harness] 抓取来源失败 [${targetUrl}]: ${err.message}`);
        sources.push({
          url: normalized?.url || targetUrl,
          requestedUrl: targetUrl,
          title: targetUrl,
          snippet: '',
          fetchedAt: now(),
          statusCode: normalized?.statusCode ?? err?.statusCode ?? null,
          ok: false,
          error: err.message
        });
      }
    }

    ledger.updateTask(task.taskId, { sources });
    return sources;
  }

  // 3. 报告生成步骤：合成 Markdown 并严格核验文件落盘
  async function executeSynthesisStep(task, { title, summary, findings = [] } = {}) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    fs.mkdirSync(resolvedReportsDir, { recursive: true });
    const reportFileName = `report-${activeTask.taskId}.md`;
    const reportFilePath = path.join(resolvedReportsDir, reportFileName);

    const allSources = Array.isArray(activeTask.sources) ? activeTask.sources : [];
    const usableSources = allSources.filter(s => !s?.error && typeof s?.snippet === 'string' && s.snippet.trim());
    const failedSources = allSources.filter(s => s?.error);

    // 没有可用正文就没有“研究结论”。绝不能生成占位句后仍标记完成并投递。
    if (usableSources.length === 0) {
      const detail = failedSources.length
        ? failedSources.map(s => `${s.url}${s.statusCode ? `（HTTP ${s.statusCode}）` : ''}：${s.error}`).join('；')
        : '没有可读取的来源正文';
      throw Object.assign(new Error(`本次来源均不可用：${detail}`), {
        code: 'RESEARCH_NO_SOURCES',
        hint: '确认网址可访问后重试，或补充新的来源网址；本次未生成成功报告。',
        sources: allSources
      });
    }

    const reportTitle = title || `研究报告：${activeTask.goal}`;
    const reportSummary = summary || `本次研究成功读取 ${usableSources.length} 个来源${failedSources.length ? `，另有 ${failedSources.length} 个来源失败` : ''}；以下结论仅基于本次抓取到的可读片段。`;

    const lines = [
      `# ${reportTitle}`,
      '',
      `- **任务编号**：\`${activeTask.taskId}\``,
      `- **研究目标**：${activeTask.goal}`,
      `- **生成时间**：${new Date(now()).toISOString()}`,
      `- **请求来源**：${activeTask.requestor?.platform} (${activeTask.requestor?.userId})`,
      '',
      '## 摘要 (Executive Summary)',
      '',
      reportSummary,
      '',
      '## 关键发现 (Key Findings)',
      ''
    ];

    // 每条结论都附「来源摘录」：摘录直接来自本次成功抓取的正文，并给出可复核链接。
    const excerptFindings = usableSources.map((s, idx) => ({
      headline: `来源摘录 ${idx + 1}：${s.title}`,
      content: `「${s.snippet}」\n\n来源：${s.url}${s.truncated ? '（正文超过读取上限，仅摘录可见片段）' : ''}`
    }));
    const reportFindings = [...findings, ...excerptFindings];
    for (const f of reportFindings) {
      lines.push(`### ${f.headline || '发现'}`);
      lines.push('');
      lines.push(f.content || '');
      lines.push('');
    }

    lines.push('## 参考来源与证据清单 (Sources & Citations)');
    lines.push('');
    if (allSources.length > 0) {
      lines.push('| # | 来源标题 | 链接 | 抓取时间 | 状态 | 摘录 |');
      lines.push('|---|---|---|---|---|---|');
      allSources.forEach((s, idx) => {
        const fetchTime = s.fetchedAt ? new Date(s.fetchedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
        const status = s.error
          ? `失败：${s.error}`
          : `HTTP ${s.statusCode ?? 200}${s.truncated ? '（截断）' : ''}`;
        const title = String(s.title || s.url || '').replace(/\|/g, '-');
        const excerpt = String(s.snippet || '').slice(0, 120).replace(/\|/g, '-');
        lines.push(`| ${idx + 1} | ${title} | ${s.url || '-'} | ${fetchTime} | ${status.replace(/\|/g, '-')} | ${excerpt} |`);
      });
    } else {
      lines.push('*（本次研究暂无外部网络引文来源）*');
    }
    lines.push('');

    const content = lines.join('\n');
    const bytes = Buffer.from(content, 'utf8');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    // 原子写入文件
    const tmpPath = path.join(resolvedReportsDir, `.${reportFileName}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmpPath, bytes, { mode: 0o644 });
    fs.renameSync(tmpPath, reportFilePath);

    // 验证文件落盘与完整性
    if (!fs.existsSync(reportFilePath)) {
      throw new Error(`Report file was not found on disk after writing: ${reportFilePath}`);
    }
    const stat = fs.statSync(reportFilePath);
    if (stat.size !== bytes.length) {
      throw new Error(`Report file size mismatch on disk: expected ${bytes.length}, got ${stat.size}`);
    }

    const artifact = {
      path: reportFilePath,
      fileName: reportFileName,
      sha256,
      sizeBytes: stat.size,
      summary: reportSummary,
      sourceCount: usableSources.length,
      failedSourceCount: failedSources.length,
      evidence: usableSources.map(s => ({
        url: s.url,
        title: s.title,
        snippet: s.snippet.slice(0, 300),
        statusCode: s.statusCode ?? 200,
        truncated: Boolean(s.truncated)
      }))
    };

    ledger.updateTask(task.taskId, { artifact });
    return artifact;
  }

  // 4. 平台回传步骤：格式化回送私聊并严格确认回执
  async function executeDeliveryStep(task) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    if (activeTask.delivery?.status === 'delivered') {
      return { ok: true, status: 'delivered', messageId: activeTask.delivery.messageId, idempotent: true };
    }
    if (['delivering', 'delivery_unknown', 'rejected'].includes(activeTask.delivery?.status)) {
      return { ok: false, status: 'delivery_unknown', code: 'OWNER_REPLY_UNKNOWN', error: '此前的送达结果未知。', hint: '查询平台消息和任务状态，不要自动重发。' };
    }

    if (!activeTask.artifact) {
      throw new Error(`Task ${task.taskId} has no generated artifact to deliver.`);
    }

    const { platform, conversationKey } = activeTask.requestor;
    const allSources = activeTask.sources || [];
    const usableSources = allSources.filter(s => !s?.error && typeof s?.snippet === 'string' && s.snippet.trim());
    const failedSources = allSources.filter(s => s?.error);
    const sourcesSummary = usableSources
      .slice(0, 3)
      .map((s, idx) => `  ${idx + 1}. ${s.title}: ${s.url}`)
      .join('\n');
    const failedSummary = failedSources.length
      ? `【失败来源】${failedSources.length} 个：${failedSources.slice(0, 3).map(s => `${s.url}${s.statusCode ? `（HTTP ${s.statusCode}）` : ''}`).join('，')}`
      : '';

    const messageText = [
      `📋 任务完成：${activeTask.goal}`,
      `【任务编号】${activeTask.taskId}`,
      `【研究摘要】${activeTask.artifact.summary}`,
      `【产物文件】${activeTask.artifact.path} (${activeTask.artifact.sizeBytes} 字节，哈希 ${activeTask.artifact.sha256.slice(0, 8)}…)`,
      sourcesSummary ? `【核心来源】\n${sourcesSummary}` : '',
      failedSummary
    ].filter(Boolean).join('\n');

    ledger.updateTask(task.taskId, {
      delivery: {
        platform,
        targetKey: conversationKey,
        status: 'delivering',
        at: now()
      }
    });

    try {
      log(`[Harness] 发送任务交付通知到 ${conversationKey}...`);
      const sendReceipt = await sendCallback({
        platform,
        conversationKey,
        text: messageText,
        taskId: task.taskId,
        phase: 'delivery',
        artifact: activeTask.artifact,
        task: activeTask
      });

      const acknowledged = sendReceipt?.ok === true
        && (!sendReceipt?.delivery || sendReceipt.delivery === 'delivered')
        && sendReceipt?.messageId != null;

      let latestTask = null;
      let postSendLedgerError = null;
      try {
        latestTask = ledger.getTask(task.taskId);
      } catch (readError) {
        postSendLedgerError = readError;
        log('[Harness] 回执后读取任务账本失败: ' + readError.message);
      }

      if (latestTask?.status === 'cancelled') {
        try {
          ledger.updateTask(task.taskId, {
            delivery: {
              platform,
              targetKey: conversationKey,
              status: acknowledged ? 'delivered' : 'delivery_unknown',
              messageId: acknowledged ? sendReceipt.messageId : null,
              at: now()
            }
          });
        } catch (recordError) {
          log('[Harness] 取消态回执写入账本失败: ' + recordError.message);
        }
        return { ok: false, status: 'cancelled', code: 'TASK_CANCELLED', error: '任务在回执期间已取消。', hint: '查询平台消息和任务状态，不要自动重发。' };
      }
      if (!acknowledged) {
        const rejected = sendReceipt?.delivery === 'rejected';
        const result = { ok: false, status: rejected ? 'rejected' : 'delivery_unknown', code: sendReceipt?.code || (rejected ? 'OWNER_REPLY_REJECTED' : 'OWNER_REPLY_UNKNOWN'), error: sendReceipt?.error || '送达结果未知。', hint: sendReceipt?.hint || '查询任务和平台消息，不要自动重发。' };
        try {
          ledger.updateTask(task.taskId, { status: 'unknown', error: result.error, delivery: { platform, targetKey: conversationKey, status: result.status, messageId: null, error: result.error, at: now() } });
        } catch (recordError) {
          log('[Harness] 未知/拒绝回执写入账本失败: ' + recordError.message);
        }
        return result;
      }

      let recorded = !postSendLedgerError;
      if (recorded) {
        try {
          ledger.updateTask(task.taskId, {
            status: 'completed',
            delivery: {
              platform,
              targetKey: conversationKey,
              status: 'delivered',
              messageId: sendReceipt?.messageId || null,
              at: now()
            }
          });
        } catch (recordError) {
          recorded = false;
          log('[Harness] 回执已送达但账本未能记录: ' + recordError.message);
        }
      }
      if (!recorded) {
        return {
          ok: true,
          status: 'delivery_unknown',
          taskId: task.taskId,
          delivery: 'delivered',
          messageId: sendReceipt.messageId,
          code: 'DELIVERY_RECEIPT_UNRECORDED',
          error: '消息已送达，但任务账本未能记录回执。',
          hint: '请核对任务 ' + task.taskId + ' 的平台消息和状态；不要自动重发。',
          messageText
        };
      }
      return { ok: true, status: 'delivered', messageText };
    } catch (err) {
      log(`[Harness] 发送交付失败/结果未知: ${err.message}`);
      try {
        ledger.updateTask(task.taskId, {
          status: 'unknown',
          error: `Delivery error: ${err.message}`,
          delivery: {
            platform,
            targetKey: conversationKey,
            status: 'delivery_unknown',
            error: err.message,
            at: now()
          }
        });
      } catch (recordError) {
        log('[Harness] 交付异常后写入账本失败: ' + recordError.message);
      }
      return { ok: false, status: 'delivery_unknown', code: 'OWNER_REPLY_UNKNOWN', error: err.message, hint: '查询任务和平台消息，不要自动重发。' };
    }
  }

  // 5. 编排端到端任务运行流水线
  async function runTaskPipeline({ requestor, goal, urls = [], findings = [], taskId }) {
    // 准入检查
    const admission = checkAdmission({ requestor });
    if (!admission.ok) {
      return admission;
    }

    const urlList = (Array.isArray(urls) ? urls : [])
      .filter(url => typeof url === 'string' && url.trim())
      .map(url => url.trim());

    // 仅关键词、还没有可核验网址：先提示补齐，不建单、不执行、也不复用旧任务。
    if (!urlList.length && !taskId) {
      return {
        ok: false,
        code: 'RESEARCH_URLS_REQUIRED',
        error: '仅有研究目标，缺少可核验的来源网址。',
        hint: '请补充网址后重试，例如：任务：<研究目标> https://example.com'
      };
    }

    // 创建或复用任务。账本不可读时这里必须停住：不能执行研究，也不能投递报告。
    let task;
    try {
      task = ledger.createTask({
        ...(taskId ? { taskId } : {}),
        goal,
        type: 'research',
        requestor,
        steps: ['admission', 'research', 'synthesis', 'delivery']
      });
    } catch (error) {
      log(`[Harness] 任务账本创建失败，已停止执行: ${error.message}`);
      return ledgerFailure(error, { taskId: taskId || null, status: 'failed' });
    }

    if (task.requestor?.conversationKey !== requestor.conversationKey || String(task.requestor?.userId) !== String(requestor.userId) || task.goal !== goal) {
      return { ok: false, status: 'rejected', code: 'TASK_OWNER_MISMATCH', error: '任务归属或目标不匹配。', hint: '查询原任务后使用正确的请求身份。' };
    }
    if (task.status === 'cancelled') {
      return { ok: false, taskId: task.taskId, status: 'cancelled', code: 'TASK_CANCELLED', error: '任务已取消。', hint: '查询任务状态；如需执行请新建任务。' };
    }
    if (['delivering', 'delivery_unknown', 'rejected'].includes(task.delivery?.status)) {
      return { ok: false, taskId: task.taskId, status: 'unknown', code: 'OWNER_REPLY_UNKNOWN', error: '此前的送达结果尚未确认。', hint: '查询平台消息和任务状态，不要自动重发。' };
    }

    // 若已经是已完成任务（幂等），直接返回原回执
    if (task.status === 'completed' && task.artifact && task.delivery?.status === 'delivered') {
      return { ok: true, taskId: task.taskId, status: 'completed', artifact: task.artifact, idempotent: true };
    }

    // 只有研究目标/关键词、没有可核验网址：不拿空来源合成报告。
    if (!urlList.length) {
      const error = Object.assign(new Error('仅有研究目标，缺少可核验的来源网址。'), {
        code: 'RESEARCH_URLS_REQUIRED',
        hint: '请补充网址后重试，例如：任务：<研究目标> https://example.com'
      });
      try {
        ledger.updateTask(task.taskId, { status: 'failed', error: error.message });
      } catch (ledgerError) {
        return ledgerFailure(ledgerError, { taskId: task.taskId, status: 'failed' });
      }
      return { ok: false, taskId: task.taskId, status: 'failed', code: error.code, error: error.message, hint: error.hint };
    }

    try {
      // 步骤 1：网页研究
      await executeResearchStep(task, { urls: urlList });

      // 步骤 2：报告生成
      const artifact = await executeSynthesisStep(task, { findings });

      // 步骤 3：回传私聊
      const delivery = await executeDeliveryStep(task);

      return {
        ok: delivery.ok,
        taskId: task.taskId,
        status: delivery.status === 'delivered' ? 'completed' : delivery.status === 'cancelled' ? 'cancelled' : 'unknown',
        artifact,
        delivery
      };
    } catch (error) {
      let current = null;
      try { current = ledger.getTask(task.taskId); } catch {}
      if (current?.status === 'cancelled') {
        return { ok: false, taskId: task.taskId, status: 'cancelled', code: 'TASK_CANCELLED', error: '任务已取消。', hint: '查询任务状态；如需执行请新建任务。' };
      }
      log(`[Harness] Pipeline failure: ${error.message}`);
      try {
        ledger.updateTask(task.taskId, {
          status: 'failed',
          error: error.message
        });
      } catch (ledgerError) {
        // 账本在流水线中途损坏/不可写：不再读写账本，直接向入口返回可展示的失败。
        log(`[Harness] 任务账本不可用，无法记录失败状态: ${ledgerError.message}`);
        return ledgerFailure(ledgerError, { taskId: task.taskId, status: 'failed' });
      }
      return {
        ok: false,
        taskId: task.taskId,
        status: 'failed',
        code: error?.code || 'TASK_PIPELINE_FAILED',
        error: error.message,
        hint: error?.hint || '检查来源网址、报告目录写入权限和本机任务账本后重试。'
      };
    }
  }

  // 6. 文件整理执行步骤：有界操作与严格白名单校验
  async function executeFilePlan(task, { plan = [], allowedRoots = [] } = {}) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    if (!Array.isArray(plan) || plan.length === 0) {
      return { ok: false, code: 'FILE_PLAN_EMPTY', error: '文件整理计划为空。', hint: '请提供包含操作项的文件整理计划。' };
    }

    // 预检：校验计划中所有涉及路径
    for (const op of plan) {
      if (!op || typeof op !== 'object') {
        return { ok: false, code: 'FILE_PLAN_INVALID', error: '文件计划包含无效条目。', hint: '操作项需包含 action, source 或 target。' };
      }
      if (op.source) {
        const check = checkAdmission({ requestor: activeTask.requestor, targetPath: op.source, allowedRoots });
        if (!check.ok) return check;
      }
      if (op.target) {
        const check = checkAdmission({ requestor: activeTask.requestor, targetPath: op.target, allowedRoots });
        if (!check.ok) return check;
      }
    }

    ledger.updateTask(task.taskId, {
      status: 'executing',
      intent: { action: 'file_operations', count: plan.length }
    });

    const results = [];
    for (const op of plan) {
      const { action, source, target, overwrite = false } = op;
      try {
        if (action === 'create_dir') {
          const resolvedTarget = path.resolve(target);
          fs.mkdirSync(resolvedTarget, { recursive: true });
          results.push({ action, target: resolvedTarget, status: 'success' });
        } else if (action === 'copy') {
          const resolvedSource = path.resolve(source);
          const resolvedTarget = path.resolve(target);
          if (!fs.existsSync(resolvedSource)) {
            throw new Error(`源文件不存在: ${resolvedSource}`);
          }
          if (fs.existsSync(resolvedTarget) && !overwrite) {
            throw new Error(`目标文件已存在且未设置覆盖: ${resolvedTarget}`);
          }
          fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
          fs.copyFileSync(resolvedSource, resolvedTarget);
          results.push({ action, source: resolvedSource, target: resolvedTarget, status: 'success' });
        } else if (action === 'move') {
          const resolvedSource = path.resolve(source);
          const resolvedTarget = path.resolve(target);
          if (!fs.existsSync(resolvedSource)) {
            throw new Error(`源文件不存在: ${resolvedSource}`);
          }
          if (fs.existsSync(resolvedTarget) && !overwrite) {
            throw new Error(`目标文件已存在且未设置覆盖: ${resolvedTarget}`);
          }
          fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
          fs.renameSync(resolvedSource, resolvedTarget);
          results.push({ action, source: resolvedSource, target: resolvedTarget, status: 'success' });
        } else if (action === 'delete') {
          const resolvedSource = path.resolve(source);
          if (fs.existsSync(resolvedSource)) {
            // 铁律：删改必隔离，备份/隔离到 state/quarantine
            const quarantineDir = path.resolve('./state/_quarantine');
            fs.mkdirSync(quarantineDir, { recursive: true });
            const backupName = `${path.basename(resolvedSource)}.${now()}.${crypto.randomUUID().slice(0, 6)}.bak`;
            const backupPath = path.join(quarantineDir, backupName);
            fs.renameSync(resolvedSource, backupPath);
            results.push({ action, source: resolvedSource, quarantinedTo: backupPath, status: 'success' });
          } else {
            results.push({ action, source: resolvedSource, status: 'skipped_not_found' });
          }
        } else {
          results.push({ action, error: `不支持的操作类型: ${action}`, status: 'failed' });
        }
      } catch (err) {
        log(`[Harness] 文件操作失败 [${action}]: ${err.message}`);
        results.push({ action, source, target, status: 'failed', error: err.message });
      }
    }

    const allSucceeded = results.every(r => r.status === 'success' || r.status === 'skipped_not_found');
    ledger.updateTask(task.taskId, {
      status: allSucceeded ? 'completed' : 'failed',
      artifact: {
        type: 'file_operations_summary',
        total: plan.length,
        executed: results.filter(r => r.status === 'success').length,
        results
      }
    });

    return {
      ok: allSucceeded,
      taskId: task.taskId,
      status: allSucceeded ? 'completed' : 'failed',
      results
    };
  }

  // 7. 脚本与终端执行步骤：安全审查、有界超时与输出截断
  const DANGEROUS_COMMAND_PATTERNS = [
    /\brm\s+-[rf]{1,2}\s+\/(?:\s|$)/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    />\s*\/dev\/[a-z0-9]+/i
  ];

  async function executeCommandStep(task, { command, args = [], cwd = './sandbox', timeoutMs = 15000, env = {} } = {}) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    // 准入检查
    const admission = checkAdmission({ requestor: activeTask.requestor });
    if (!admission.ok) return admission;

    // 命令安全性检查
    const fullCommandLine = `${command} ${args.join(' ')}`.trim();
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(fullCommandLine)) {
        return {
          ok: false,
          code: 'COMMAND_SECURITY_BLOCKED',
          error: `检测到高风险或危险破坏性指令: ${fullCommandLine}`,
          hint: '系统禁止执行可能破坏操作系统的根级破坏性命令。'
        };
      }
    }

    const resolvedCwd = path.resolve(cwd || './sandbox');
    if (isSystemRestrictedPath(resolvedCwd)) {
      return {
        ok: false,
        code: 'ADMISSION_PATH_RESTRICTED',
        error: `工作目录 [${resolvedCwd}] 属于系统受限路径。`,
        hint: '请在项目安全工作目录中执行命令。'
      };
    }
    fs.mkdirSync(resolvedCwd, { recursive: true });

    ledger.updateTask(task.taskId, {
      status: 'executing',
      intent: { action: 'command_execution', command, args, cwd: resolvedCwd }
    });

    return new Promise((resolve) => {
      const startTime = now();
      let stdoutChunks = [];
      let stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      const MAX_OUTPUT_BYTES = 8192;

      let child;
      let killTimer = null;
      let hardKillTimer = null;

      try {
        child = spawn(command, args, {
          cwd: resolvedCwd,
          env: { ...process.env, ...env }
        });
      } catch (err) {
        ledger.updateTask(task.taskId, {
          status: 'failed',
          error: err.message
        });
        return resolve({ ok: false, code: 'COMMAND_SPAWN_FAILED', error: err.message });
      }

      child.stdout?.on('data', (chunk) => {
        if (stdoutLen < MAX_OUTPUT_BYTES * 2) {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      });

      child.stderr?.on('data', (chunk) => {
        if (stderrLen < MAX_OUTPUT_BYTES * 2) {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
        }
      });

      const cleanupTimers = () => {
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
      };

      killTimer = setTimeout(() => {
        log(`[Harness] 命令执行超时 (${timeoutMs}ms)，尝试终止 PID ${child.pid}...`);
        child.kill('SIGTERM');
        hardKillTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL');
            }
          } catch {}
        }, 1000);
      }, timeoutMs);

      child.on('close', (exitCode, signalCode) => {
        cleanupTimers();
        const durationMs = now() - startTime;
        let stdoutBuf = Buffer.concat(stdoutChunks);
        if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
          const head = stdoutBuf.subarray(0, 4096);
          const tail = stdoutBuf.subarray(stdoutBuf.length - 2048);
          const notice = Buffer.from('\n[...output truncated due to length...]\n');
          stdoutBuf = Buffer.concat([head, notice, tail]);
        }
        let stderrBuf = Buffer.concat(stderrChunks);
        if (stderrBuf.length > MAX_OUTPUT_BYTES) {
          const head = stderrBuf.subarray(0, 4096);
          const tail = stderrBuf.subarray(stderrBuf.length - 2048);
          const notice = Buffer.from(`\n[...stderr truncated due to length (${stderrBuf.length} bytes)...]\n`);
          stderrBuf = Buffer.concat([head, notice, tail]);
        }
        const stdoutStr = stdoutBuf.toString('utf8');
        const stderrStr = stderrBuf.toString('utf8');
        const succeeded = exitCode === 0;

        const cmdResult = {
          command,
          args,
          cwd: resolvedCwd,
          exitCode,
          signalCode,
          durationMs,
          stdout: stdoutStr,
          stderr: stderrStr
        };

        ledger.updateTask(task.taskId, {
          status: succeeded ? 'completed' : 'failed',
          artifact: {
            type: 'command_execution_result',
            ...cmdResult
          },
          error: succeeded ? null : (signalCode ? `Terminated with signal ${signalCode}` : `Exited with code ${exitCode}`)
        });

        resolve({
          ok: succeeded,
          taskId: task.taskId,
          status: succeeded ? 'completed' : 'failed',
          result: cmdResult
        });
      });

      child.on('error', (err) => {
        cleanupTimers();
        ledger.updateTask(task.taskId, {
          status: 'failed',
          error: err.message
        });
        resolve({
          ok: false,
          taskId: task.taskId,
          status: 'failed',
          error: err.message
        });
      });
    });
  }

  // 8. Mac 本地应用控制：通过 macOS 原生能力（open / osascript / shortcuts）
  async function executeMacAppStep(task, { appName, action = 'open', script = '', args = [], timeoutMs = 15000 } = {}) {
    const activeTask = ledger.getTask(task.taskId);
    if (!activeTask || activeTask.status === 'cancelled') {
      throw new Error(`Task ${task.taskId} is cancelled or not found.`);
    }

    const admission = checkAdmission({ requestor: activeTask.requestor });
    if (!admission.ok) return admission;

    ledger.updateTask(task.taskId, {
      status: 'executing',
      intent: { action: 'mac_app_control', appName, appAction: action }
    });

    let cmd = 'open';
    let cmdArgs = [];
    if (action === 'open') {
      cmd = 'open';
      cmdArgs = ['-a', appName, ...args];
    } else if (action === 'applescript') {
      cmd = 'osascript';
      cmdArgs = ['-e', script];
    } else if (action === 'shortcut') {
      cmd = 'shortcuts';
      cmdArgs = ['run', appName, ...args];
    } else {
      return { ok: false, code: 'MAC_APP_ACTION_UNKNOWN', error: `不支持的 Mac 应用控制动作: ${action}` };
    }

    return executeCommandStep(task, {
      command: cmd,
      args: cmdArgs,
      timeoutMs
    });
  }

  // 9. 阶段 E：自主低风险日常活动编排与透明记录
  async function runAutonomousIdleActivity({ type = 'reflection_log', note = '', metadata = {} } = {}) {
    const taskId = `auto-${crypto.randomUUID().slice(0, 8)}`;
    const task = ledger.createTask({
      taskId,
      type: 'autonomous',
      goal: `自主低风险日常活动: ${type}`,
      requestor: { platform: 'local', userId: 'self', conversationKey: 'local:autonomous', isOwner: true },
      steps: ['inspect', 'log']
    });

    const timestamp = now();
    const entry = {
      timestamp,
      type,
      note: note || `日常活动: ${type}`,
      metadata
    };

    ledger.updateTask(taskId, {
      status: 'completed',
      artifact: {
        type: 'autonomous_activity',
        entry
      }
    });

    log(`[Autonomous] 鱼完成日常低风险活动: ${type} - ${note}`);
    return {
      ok: true,
      taskId,
      status: 'completed',
      entry
    };
  }

  return {
    checkAdmission,
    executeResearchStep,
    executeSynthesisStep,
    executeDeliveryStep,
    executeFilePlan,
    executeCommandStep,
    executeMacAppStep,
    runAutonomousIdleActivity,
    runTaskPipeline,
    resolvedReportsDir
  };
}
