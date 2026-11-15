// B站生物钟会话归组：新会话走 workspaceId；旧会话不强行迁移。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BILI_WORKSPACE_TITLE, biliSessionCreateParams, biliWorkspacePath } from '../plugins/surfcore/lib/bili-workspace.js';

const base = 'C:\\Users\\test\\.dsh';
assert.equal(biliWorkspacePath(base), path.join(base, 'surfcore', 'state', 'bili-agents'));
assert.equal(BILI_WORKSPACE_TITLE, 'B站生物钟');
assert.deepEqual(biliSessionCreateParams({ workspaceId: 'ws-1', cwd: 'C:\\tmp' }), { workspaceId: 'ws-1' },
  '有 workspaceId 时不能再传 cwd（两者互斥）');
assert.deepEqual(biliSessionCreateParams({ workspaceId: 'ws-1', agentPreset: 'standard' }), { workspaceId: 'ws-1', agentPreset: 'standard' },
  'workspace 与 preset 可以同时存在');
assert.deepEqual(biliSessionCreateParams({ cwd: 'C:\\tmp' }), { cwd: 'C:\\tmp' },
  '旧版没有工作区服务时才退回 cwd');

const scheduler = fs.readFileSync('plugins/surfcore/lib/scheduler.js', 'utf8');
// V1 退役（2026-11-12）：B站 会话由 V2 Host 管理，scheduler 不再建 DSH 会话/工作区。
assert.ok(!scheduler.includes('ensureBiliWorkspace'), 'V1 工作区装配已删除');
assert.ok(!scheduler.includes('resolveBiliAgentPreset'), 'V1 preset 解析已删除');
assert.ok(!scheduler.includes('biliSessionCreateParams'), 'V1 workspace/cwd 选择器已删除');
assert.ok(scheduler.includes('biliV2Agent.enqueue'), '唤醒必须走 V2 Host');
assert.ok(!scheduler.includes("path.join(biliDir, 'whale-diary.md')"), 'V1 手抄日记提示词已删除');

const index = fs.readFileSync('plugins/surfcore/lib/index.js', 'utf8');
assert.ok(!index.includes('workspacePath: biliWorkspace'), 'V1 工作区参数已删除');
assert.ok(!index.includes('cwd: biliWorkspace'), 'V1 fallback cwd 已删除');

const bridge = fs.readFileSync('src/bridge.js', 'utf8');
const memory = fs.readFileSync('src/bili-memory.js', 'utf8');
assert.ok(bridge.includes('biliDir: CHARACTER_ID ? characterPaths(CHARACTER_ID).biliDir : null'),
  'bridge 必须把当前角色的 biliDir 传给记忆');
assert.ok(memory.includes('if (biliDir) paths.bili = biliDir'),
  '记忆模块必须支持角色级 biliDir');
assert.ok(memory.includes("ledgerFile('whale-diary.md')") && memory.includes("ledgerFile('scores.json')"),
  '角色级缺文件时必须回退账号级账本');
console.log('✅ B站会话工作区归组测试通过');
