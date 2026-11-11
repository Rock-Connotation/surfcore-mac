import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../plugins/surfcore/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function VolcForm(');
const end = source.indexOf('    // 云端密钥表单', start);
assert(start >= 0 && end > start);
assert(source.includes('旧云包用量（不含火山直连）'));
assert(source.includes('旧云包估算剩余'));

test('火山表单独立启用、保存并回显本机月上限', async () => {
  const slots = [], calls = []; let cursor = 0, mounted = false, refreshes = 0, changed;
  const h = (type, props, ...children) => ({ type, props: props || {}, children });
  const api = async (url, options) => {
    calls.push({ url, body: options?.body });
    if (!options) return { selected: false, hasKey: false, monthlyLimit: 100000 };
    if (options.body.monthlyQuota === 7000) throw Object.assign(new Error('保存失败'), { code: 'VOICE_MANAGEMENT_BUSY', hint: '稍后重试' });
    if (options.body.monthlyQuota) return { selected: false, hasKey: false, monthlyLimit: options.body.monthlyQuota };
    return { selected: true, hasKey: true, monthlyLimit: 5000, route: 'cloud', ttsEnabled: true };
  };
  const context = vm.createContext({ h, api, Btn: function Btn() {},
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useEffect(fn) { if (!mounted) { mounted = true; fn(); } },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.VolcForm = VolcForm;', context);
  const render = () => { cursor = 0; return context.VolcForm({ onChanged: async result => { refreshes++; changed = result; return { ok: true }; } }); };
  const walk = (node, pred) => {
    if (!node || typeof node !== 'object') return null;
    if (pred(node)) return node;
    for (const child of node.children || []) { const result = walk(child, pred); if (result) return result; }
    return null;
  };
  let tree = render(); await new Promise(resolve => setImmediate(resolve)); tree = render();
  let quota = walk(tree, node => node.props.id === 'volc-month-limit');
  assert.equal(quota.props.value, '100000');
  quota.props.onChange({ target: { value: '5000' } }); tree = render();
  const save = walk(tree, node => node.children.includes('保存月上限'));
  await save.props.onClick(); tree = render();
  assert.equal(calls.at(-1).body.monthlyQuota, 5000);
  quota = walk(tree, node => node.props.id === 'volc-month-limit'); assert.equal(quota.props.value, '5000');
  quota.props.onChange({ target: { value: '7000' } }); tree = render();
  await walk(tree, node => node.children.includes('保存月上限')).props.onClick(); tree = render();
  assert(walk(tree, node => node.props.role === 'status' && node.children.some(value => typeof value === 'string' && value.includes('VOICE_MANAGEMENT_BUSY') && value.includes('稍后重试'))));
  assert(walk(tree, node => node.children.includes('当前生效：5000 字')));
  const activate = walk(tree, node => node.children.includes('选择火山并启用合成'));
  await activate.props.onClick(); tree = render();
  assert.equal(calls.at(-1).body.provider, 'volc'); assert.equal(calls.at(-1).body.activate, true); assert.equal(refreshes, 2);
  assert.equal(changed.route, 'cloud'); assert.equal(changed.ttsEnabled, true);
  assert(walk(tree, node => node.props.role === 'status' && node.children.some(value => typeof value === 'string' && value.includes('发送总闸'))));
  const password = walk(tree, node => node.props.type === 'password');
  password.props.onChange({ target: { value: 'fixture-key' } }); tree = render();
  await walk(tree, node => node.children.includes('使用原云端服务')).props.onClick();
  assert.equal(calls.at(-1).body.provider, 'voxd'); assert.equal(calls.at(-1).body.apiKey, '');
});
