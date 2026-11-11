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

export function createTaskHarness({
  ledger,
  reportsDir,
  safeFetchImpl = fetch,
  sendCallback = async () => ({ ok: true }),
  now = Date.now,
  log = () => {}
} = {}) {
  if (!ledger) throw new TypeError('ledger is required.');
  const resolvedReportsDir = path.resolve(reportsDir || './state/reports');

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

    const sources = [...(activeTask.sources || [])];
    for (const targetUrl of urls) {
      try {
        log(`[Harness] 抓取研究资料来源: ${targetUrl}`);
        const res = await safeFetchImpl(targetUrl, {
          headers: { 'User-Agent': 'SurfCore-ResearchBot/1.0' },
          signal: AbortSignal.timeout(10000)
        });
        const html = await res.text();
        // 简易文本提取与摘要
        const cleanText = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                              .replace(/<style[\s\S]*?<\/style>/gi, '')
                              .replace(/<[^>]+>/g, ' ')
                              .replace(/\s+/g, ' ')
                              .trim();
        const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
        const title = titleMatch ? titleMatch[1].trim() : targetUrl;
        const snippet = cleanText.slice(0, 300);

        sources.push({
          url: targetUrl,
          title,
          snippet,
          fetchedAt: now(),
          byteLength: Buffer.byteLength(cleanText)
        });
      } catch (err) {
        log(`[Harness] 抓取来源失败 [${targetUrl}]: ${err.message}`);
        sources.push({
          url: targetUrl,
          title: targetUrl,
          snippet: `[抓取失败: ${err.message}]`,
          fetchedAt: now(),
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

    const reportTitle = title || `研究报告：${activeTask.goal}`;
    const reportSummary = summary || `关于「${activeTask.goal}」的自动化调研与分析报告。`;

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

    if (findings.length > 0) {
      for (const f of findings) {
        lines.push(`### ${f.headline || '发现'}`);
        lines.push('');
        lines.push(f.content || '');
        lines.push('');
      }
    } else {
      lines.push('（从收集的原始来源材料中综合整理得出主要结论）');
      lines.push('');
    }

    lines.push('## 参考来源与证据清单 (Sources & Citations)');
    lines.push('');
    if (activeTask.sources?.length > 0) {
      lines.push('| # | 来源标题 | 链接 | 抓取时间 | 摘要 |');
      lines.push('|---|---|---|---|---|');
      activeTask.sources.forEach((s, idx) => {
        const fetchTime = s.fetchedAt ? new Date(s.fetchedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
        lines.push(`| ${idx + 1} | ${s.title.replace(/\|/g, '-')} | [查看链接](${s.url}) | ${fetchTime} | ${s.snippet.slice(0, 80).replace(/\|/g, '-')}… |`);
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
      summary: reportSummary
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

    if (!activeTask.artifact) {
      throw new Error(`Task ${task.taskId} has no generated artifact to deliver.`);
    }

    const { platform, conversationKey } = activeTask.requestor;
    const sourcesSummary = (activeTask.sources || [])
      .slice(0, 3)
      .map((s, idx) => `  ${idx + 1}. ${s.title}: ${s.url}`)
      .join('\n');

    const messageText = [
      `📋 任务完成：${activeTask.goal}`,
      `【任务编号】${activeTask.taskId}`,
      `【研究摘要】${activeTask.artifact.summary}`,
      `【产物文件】${activeTask.artifact.path} (${activeTask.artifact.sizeBytes} 字节，哈希 ${activeTask.artifact.sha256.slice(0, 8)}…)`,
      sourcesSummary ? `【核心来源】\n${sourcesSummary}` : ''
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
        artifact: activeTask.artifact
      });

      if (sendReceipt?.ok === false) {
        throw new Error(sendReceipt.error || 'Platform send rejected');
      }

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

      return { ok: true, status: 'delivered', messageText };
    } catch (err) {
      log(`[Harness] 发送交付失败/结果未知: ${err.message}`);
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
      return { ok: false, status: 'delivery_unknown', error: err.message };
    }
  }

  // 5. 编排端到端任务运行流水线
  async function runTaskPipeline({ requestor, goal, urls = [], findings = [] }) {
    // 准入检查
    const admission = checkAdmission({ requestor });
    if (!admission.ok) {
      return admission;
    }

    // 创建或复用任务
    const task = ledger.createTask({
      goal,
      type: 'research',
      requestor,
      steps: ['admission', 'research', 'synthesis', 'delivery']
    });

    // 若已经是已完成任务（幂等），直接返回原回执
    if (task.status === 'completed' && task.artifact && task.delivery?.status === 'delivered') {
      return { ok: true, taskId: task.taskId, status: 'completed', artifact: task.artifact, idempotent: true };
    }

    try {
      // 步骤 1：网页研究
      await executeResearchStep(task, { urls });

      // 步骤 2：报告生成
      const artifact = await executeSynthesisStep(task, { findings });

      // 步骤 3：回传私聊
      const delivery = await executeDeliveryStep(task);

      return {
        ok: delivery.ok,
        taskId: task.taskId,
        status: delivery.status === 'delivered' ? 'completed' : 'unknown',
        artifact,
        delivery
      };
    } catch (error) {
      log(`[Harness] Pipeline failure: ${error.message}`);
      ledger.updateTask(task.taskId, {
        status: 'failed',
        error: error.message
      });
      return {
        ok: false,
        taskId: task.taskId,
        status: 'failed',
        error: error.message
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
