import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTaskLedger } from '../src/task-ledger.js';
import { createTaskHarness, isSystemRestrictedPath } from '../src/task-harness.js';

console.log('--- Phase D & E Verification Suite ---');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-phase-de-'));
const sandboxDir = path.join(tmpDir, 'sandbox');
fs.mkdirSync(sandboxDir, { recursive: true });

try {
  const ledger = createTaskLedger({ stateDir: path.join(tmpDir, 'state') });
  const harness = createTaskHarness({
    ledger,
    reportsDir: path.join(tmpDir, 'reports')
  });

  // ==========================================
  // D1: File Operations Plan & Boundary Safety
  // ==========================================
  console.log('\n[D1] Testing File Operations Plan and Boundaries...');

  // 1. Path restriction tests
  assert.equal(isSystemRestrictedPath('/System/Library/Fonts'), true, '/System must be restricted');
  assert.equal(isSystemRestrictedPath('/usr/local/bin'), true, '/usr must be restricted');
  assert.equal(isSystemRestrictedPath('/etc/passwd'), true, '/etc must be restricted');
  assert.equal(isSystemRestrictedPath('/Applications/Safari.app'), true, '/Applications must be restricted');
  assert.equal(isSystemRestrictedPath(sandboxDir), false, 'Sandbox directory must not be restricted');

  const fileTask = ledger.createTask({
    goal: '整理下载目录测试文件',
    type: 'file',
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true }
  });

  // 2. Reject system path in plan
  const sysPathPlan = [
    { action: 'copy', source: path.join(sandboxDir, 'test.txt'), target: '/System/Library/malicious.txt' }
  ];
  const sysPathRes = await harness.executeFilePlan(fileTask, {
    plan: sysPathPlan,
    allowedRoots: [sandboxDir]
  });
  assert.equal(sysPathRes.ok, false);
  assert.equal(sysPathRes.code, 'ADMISSION_PATH_RESTRICTED');
  console.log('✔ File plan strictly rejects system-restricted paths');

  // 3. Reject path outside allowedRoots
  const outsidePathPlan = [
    { action: 'copy', source: path.join(sandboxDir, 'test.txt'), target: '/var/tmp/outside.txt' }
  ];
  const outsidePathRes = await harness.executeFilePlan(fileTask, {
    plan: outsidePathPlan,
    allowedRoots: [sandboxDir]
  });
  assert.equal(outsidePathRes.ok, false);
  assert.equal(outsidePathRes.code, 'ADMISSION_PATH_RESTRICTED');
  console.log('✔ File plan strictly rejects paths outside allowedRoots');

  // 4. Reject group chat requests for file operations
  const groupTask = ledger.createTask({
    goal: '群聊尝试整理文件',
    type: 'file',
    requestor: { platform: 'qq', userId: '20002', conversationKey: 'group:88888', isOwner: false }
  });
  const groupFileRes = await harness.executeFilePlan(groupTask, {
    plan: [{ action: 'create_dir', target: path.join(sandboxDir, 'sub') }],
    allowedRoots: [sandboxDir]
  });
  assert.equal(groupFileRes.ok, false);
  assert.equal(groupFileRes.code, 'ADMISSION_GROUP_DENIED');
  console.log('✔ Group chats strictly denied file operation permissions');

  // 5. Valid file operations: create_dir, copy, move, delete (quarantine)
  const srcFile = path.join(sandboxDir, 'source.txt');
  fs.writeFileSync(srcFile, 'Hello file operations', 'utf8');

  const validPlan = [
    { action: 'create_dir', target: path.join(sandboxDir, 'organized') },
    { action: 'copy', source: srcFile, target: path.join(sandboxDir, 'organized', 'copied.txt') },
    { action: 'move', source: path.join(sandboxDir, 'organized', 'copied.txt'), target: path.join(sandboxDir, 'organized', 'final.txt') },
    { action: 'delete', source: srcFile }
  ];

  const validPlanRes = await harness.executeFilePlan(fileTask, {
    plan: validPlan,
    allowedRoots: [sandboxDir]
  });
  assert.equal(validPlanRes.ok, true, 'Valid file plan must succeed');
  assert.equal(validPlanRes.status, 'completed');
  assert.ok(fs.existsSync(path.join(sandboxDir, 'organized', 'final.txt')), 'Moved final file must exist');
  assert.equal(fs.readFileSync(path.join(sandboxDir, 'organized', 'final.txt'), 'utf8'), 'Hello file operations');
  assert.equal(fs.existsSync(srcFile), false, 'Original source file must be moved/deleted');

  // Check quarantine backup
  const quarantineDir = path.resolve('./state/_quarantine');
  assert.ok(fs.existsSync(quarantineDir), 'Quarantine backup directory must exist');
  console.log('✔ File plan successfully created dir, copied, moved, and safely quarantined deleted files');

  // ==========================================
  // D2: Command Execution & Sandboxed Terminal
  // ==========================================
  console.log('\n[D2] Testing Command Execution & Sandboxed Terminal...');

  const cmdTask = ledger.createTask({
    goal: '运行测试脚本',
    type: 'command',
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true }
  });

  // 1. Dangerous command blocking
  const dangerousCmdRes = await harness.executeCommandStep(cmdTask, {
    command: 'rm',
    args: ['-rf', '/'],
    cwd: sandboxDir
  });
  assert.equal(dangerousCmdRes.ok, false);
  assert.equal(dangerousCmdRes.code, 'COMMAND_SECURITY_BLOCKED');
  console.log('✔ High-risk destructive commands (rm -rf /) blocked by security filter');

  // 2. Safe command execution
  const safeCmdRes = await harness.executeCommandStep(cmdTask, {
    command: 'node',
    args: ['-e', 'console.log("Safe script output from Mac");'],
    cwd: sandboxDir
  });
  assert.equal(safeCmdRes.ok, true, 'Safe command must succeed');
  assert.equal(safeCmdRes.status, 'completed');
  assert.equal(safeCmdRes.result.exitCode, 0);
  assert.ok(safeCmdRes.result.stdout.includes('Safe script output from Mac'));
  assert.ok(safeCmdRes.result.durationMs >= 0);
  console.log('✔ Safe command successfully executed and recorded exit code, duration, and stdout');

  // 3. Output truncation for large outputs
  const largeOutputRes = await harness.executeCommandStep(cmdTask, {
    command: 'node',
    args: ['-e', 'console.log("X".repeat(15000));'],
    cwd: sandboxDir
  });
  assert.equal(largeOutputRes.ok, true);
  assert.ok(largeOutputRes.result.stdout.includes('[...output truncated due to length...]'),
    'Large output must be truncated');
  console.log('✔ Oversized command output correctly bounded and truncated');

  // 4. Command timeout handling
  const timeoutCmdRes = await harness.executeCommandStep(cmdTask, {
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 10000);'],
    cwd: sandboxDir,
    timeoutMs: 300
  });
  assert.equal(timeoutCmdRes.ok, false);
  assert.ok(timeoutCmdRes.result.signalCode === 'SIGTERM' || timeoutCmdRes.result.signalCode === 'SIGKILL',
    'Timed-out command must be terminated by signal');
  console.log('✔ Command timeout bounded and process cleanly terminated');

  // ==========================================
  // D3: Native Mac App Controls
  // ==========================================
  console.log('\n[D3] Testing Native Mac App Controls...');

  const appTask = ledger.createTask({
    goal: '控制 Mac 原生应用',
    type: 'mac_app',
    requestor: { platform: 'qq', userId: '10001', conversationKey: 'private:10001', isOwner: true }
  });

  // 1. Unknown action rejection
  const unknownActionRes = await harness.executeMacAppStep(appTask, {
    appName: 'Finder',
    action: 'unsupported_action'
  });
  assert.equal(unknownActionRes.ok, false);
  assert.equal(unknownActionRes.code, 'MAC_APP_ACTION_UNKNOWN');

  // 2. AppleScript action test (query System Events or simple calculation)
  const appleScriptRes = await harness.executeMacAppStep(appTask, {
    appName: 'AppleScript',
    action: 'applescript',
    script: 'return 40 + 2'
  });
  assert.equal(appleScriptRes.ok, true);
  assert.equal(appleScriptRes.result.exitCode, 0);
  assert.ok(appleScriptRes.result.stdout.trim() === '42');
  console.log('✔ Native Mac AppleScript execution succeeded and returned expected calculation');

  // ==========================================
  // E1: Autonomous Life Rhythm & Activity Timeline
  // ==========================================
  console.log('\n[E1] Testing Autonomous Life Rhythm & Activity Timeline...');

  const idleActivity = await harness.runAutonomousIdleActivity({
    type: 'reflection_log',
    note: '回顾今天的调研与代码审查进展，整理思维草稿',
    metadata: { mood: 'peaceful', topic: 'architecture' }
  });

  assert.equal(idleActivity.ok, true);
  assert.equal(idleActivity.status, 'completed');
  assert.ok(idleActivity.taskId.startsWith('auto-'));
  assert.equal(idleActivity.entry.type, 'reflection_log');

  const taskInLedger = ledger.getTask(idleActivity.taskId);
  assert.ok(taskInLedger, 'Autonomous task must be recorded in ledger');
  assert.equal(taskInLedger.type, 'autonomous');
  assert.equal(taskInLedger.requestor.platform, 'local');
  // Must NOT have delivery target to external groups
  assert.equal(taskInLedger.delivery, null);
  console.log('✔ Autonomous idle activity transparently recorded in local ledger without external broadcast');

  console.log('\n========================================');
  console.log('All Phase D & E tests passed successfully!');
  console.log('========================================');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
