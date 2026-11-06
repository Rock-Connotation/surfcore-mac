import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function GateAlertModal(');
const end = source.indexOf('// 通用错误报告弹窗', start);
assert.ok(start > 0 && end > start);
const state = []; let cursor = 0; let attempts = 0;
const h = (type, props, ...children) => ({ type, props: { ...props, children } });
const context = vm.createContext({ h, Btn: 'button', useState(value) {
  const i = cursor++; if (!(i in state)) state[i] = value;
  return [state[i], next => { state[i] = next; }];
}, api: async () => {
  attempts++;
  if (attempts === 1) throw Object.assign(new Error('注册失败'), { code: 'DSH_REPAIR_FAILED', hint: '检查脚本后重试' });
  return { ok: true, requiresRestart: true, hint: '请完全退出并重开 DSH' };
} });
vm.runInContext(source.slice(start, end) + '\nglobalThis.renderModal = GateAlertModal;', context);
const event = { id: 'fixture', level: 'L2', gate: 'dsh', event: 'dsh-profile-mcp-missing' };
function render() { cursor = 0; return context.renderModal({ event }); }
function flatten(node) { return node && typeof node === 'object' ? [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(flatten)] : []; }
function repair(tree) { return flatten(tree).find(node => node.type === 'button' && node.props.children[0] === '修复 DSH 注册（MCP / bundle）'); }
let tree = render(); assert.equal(repair(tree).props.disabled, false);
await repair(tree).props.onClick(); tree = render();
assert.equal(repair(tree).props.disabled, false, '失败后必须允许用户修正后重试');
assert.ok(JSON.stringify(tree).includes('检查脚本后重试'), '失败的下一步必须在当前弹窗可见');
await repair(tree).props.onClick(); tree = render();
assert.equal(attempts, 2); assert.equal(repair(tree).props.disabled, true, '成功写回后避免重复注册');
assert.ok(JSON.stringify(tree).includes('请完全退出并重开 DSH'));
console.log('DSH repair modal: failure actionable/retryable; success restart guidance: PASS');
