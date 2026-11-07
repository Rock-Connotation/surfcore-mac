import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function DouyinTab() {'), end = source.indexOf('    function BiliTab(', start);
assert.ok(start > 0 && end > start);
const hooks = [], intervals = []; let slot = 0, mounted = false;
const context = vm.createContext({
  useState(initial) { const i = slot++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
  useRef(initial) { const i = slot++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
  useEffect(fn) { slot++; if (!mounted) fn(); },
  setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {},
  h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }), Btn: 'button',
  api: async (_path, options) => {
    if (options?.method === 'POST') throw Object.assign(new Error('当前登录已失效'), { code: 'DOUYIN_NEEDS_AUTH', hint: '请打开专用窗口重新登录' });
    return { ok: true, character: { id: 'fixture', epoch: 1 }, enabled: true, account: { configured: true, nickname: '测试', uidSuffix: '1234' }, state: 'idle' };
  },
});
const component = vm.runInContext(`(${source.slice(start, end).trim()})`, context);
const render = () => { slot = 0; const tree = component(); mounted = true; return tree; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const nodes = (node) => typeof node === 'object' && node ? [node, ...node.children.flatMap(nodes)] : [];
render(); await settle();
let tree = render();
const button = nodes(tree).find(x => x.type === 'button' && x.children.includes('读取本页推荐'));
assert.ok(button && !button.props.disabled);
await button.props.onClick(); await settle();
tree = render();
const alert = () => nodes(tree).find(x => x.props.role === 'alert');
assert.match(alert().children.join(''), /DOUYIN_NEEDS_AUTH/);
assert.match(alert().children.join(''), /重新登录/);
intervals[0](); await settle(); tree = render();
assert.match(alert().children.join(''), /DOUYIN_NEEDS_AUTH/, 'successful polling must not erase an operation failure');
console.log('Douyin client keeps actionable operation failures visible after status polling');
