// 本地持久化任务账本 (Task Ledger)
// 集中管理电脑任务的身份、目标、步骤状态、执行前意图、审批关联、产物与平台交付回执。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VALID_STATUSES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'executing',
  'completed',
  'failed',
  'cancelled',
  'unknown'
]);

export function createTaskLedger({
  stateDir,
  fileName = 'tasks.json',
  now = Date.now
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new TypeError('stateDir must be an absolute or relative directory path.');
  }

  const resolvedDir = path.resolve(stateDir);
  const filePath = path.join(resolvedDir, fileName);

  function loadRaw() {
    try {
      if (!fs.existsSync(filePath)) return { version: 1, tasks: [] };
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.tasks)) return { version: 1, tasks: [] };
      return parsed;
    } catch {
      return { version: 1, tasks: [] };
    }
  }

  function saveAtomic(data) {
    fs.mkdirSync(resolvedDir, { recursive: true });
    const tmp = path.join(resolvedDir, `.${fileName}.${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  function createTask({
    taskId = `task-${randomUUID().slice(0, 8)}`,
    type = 'research',
    goal = '',
    requestor = { platform: 'qq', userId: '', conversationKey: '', isOwner: false },
    steps = []
  } = {}) {
    if (!goal || typeof goal !== 'string') {
      throw new Error('Task requires a non-empty goal.');
    }
    const current = now();
    const data = loadRaw();

    // 检查是否存在相同 taskId 的活跃任务（幂等性）
    const existing = data.tasks.find(t => t.taskId === taskId);
    if (existing) return existing;

    const task = {
      taskId,
      type: String(type || 'general'),
      goal: String(goal).trim(),
      requestor: {
        platform: String(requestor?.platform || 'qq'),
        userId: String(requestor?.userId || ''),
        conversationKey: String(requestor?.conversationKey || ''),
        isOwner: Boolean(requestor?.isOwner)
      },
      status: 'queued',
      steps: Array.isArray(steps) ? steps.map(s => ({
        name: typeof s === 'string' ? s : String(s.name || ''),
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        error: null
      })) : [],
      currentStepIndex: 0,
      intent: null,
      approval: null,
      sources: [],
      artifact: null,
      delivery: null,
      error: null,
      createdAt: current,
      updatedAt: current
    };

    data.tasks.push(task);
    saveAtomic(data);
    return task;
  }

  function getTask(taskId) {
    if (!taskId) return null;
    const data = loadRaw();
    return data.tasks.find(t => t.taskId === String(taskId)) || null;
  }

  function updateTask(taskId, patch = {}) {
    if (!taskId) return null;
    const data = loadRaw();
    const index = data.tasks.findIndex(t => t.taskId === String(taskId));
    if (index === -1) return null;

    const task = data.tasks[index];
    const current = now();

    if (patch.status !== undefined) {
      if (!VALID_STATUSES.has(patch.status)) {
        throw new Error(`Invalid task status: ${patch.status}`);
      }
      task.status = patch.status;
    }

    if (patch.steps !== undefined && Array.isArray(patch.steps)) {
      task.steps = patch.steps;
    }

    if (patch.currentStepIndex !== undefined) {
      task.currentStepIndex = patch.currentStepIndex;
    }

    if (patch.intent !== undefined) {
      task.intent = patch.intent;
    }

    if (patch.approval !== undefined) {
      task.approval = patch.approval;
    }

    if (patch.sources !== undefined && Array.isArray(patch.sources)) {
      task.sources = patch.sources;
    }

    if (patch.artifact !== undefined) {
      task.artifact = patch.artifact;
    }

    if (patch.delivery !== undefined) {
      task.delivery = patch.delivery;
    }

    if (patch.error !== undefined) {
      task.error = patch.error;
    }

    task.updatedAt = current;
    data.tasks[index] = task;
    saveAtomic(data);
    return task;
  }

  function listTasks({ status = null, conversationKey = null, limit = 50 } = {}) {
    const data = loadRaw();
    let result = data.tasks;
    if (status) {
      result = result.filter(t => t.status === status);
    }
    if (conversationKey) {
      result = result.filter(t => t.requestor?.conversationKey === conversationKey);
    }
    return result.slice(-limit).reverse();
  }

  function findActiveTask(conversationKey) {
    if (!conversationKey) return null;
    const data = loadRaw();
    const activeStatuses = new Set(['queued', 'running', 'awaiting_approval', 'executing']);
    return data.tasks.find(t =>
      t.requestor?.conversationKey === conversationKey && activeStatuses.has(t.status)
    ) || null;
  }

  function cancelTask(taskId, reason = 'cancelled_by_user') {
    const task = getTask(taskId);
    if (!task) return null;
    if (task.status === 'completed' || task.status === 'failed') {
      return task;
    }
    return updateTask(taskId, {
      status: 'cancelled',
      error: `Task cancelled: ${reason}`
    });
  }

  return {
    createTask,
    getTask,
    updateTask,
    listTasks,
    findActiveTask,
    cancelTask,
    filePath
  };
}
