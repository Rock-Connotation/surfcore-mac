// QQ 自然语言入口的意图解析测试：只认三种显式说法，普通聊天一律不劫持。
import assert from 'node:assert/strict'
import { parseLocalTaskIntent } from '../src/core/local-task-intent.js'

let checks = 0
function pass(name) { checks++; console.log(`PASS ${name}`) }

// 1. 全角冒号
assert.deepEqual(
  parseLocalTaskIntent('本机任务：读三份纪要并合成周报'),
  { kind: 'submit', goal: '读三份纪要并合成周报', owner: null },
)
pass('全角冒号识别为提交')

// 2. 半角冒号 + 前后空白
assert.equal(parseLocalTaskIntent('  本机任务: 整理周报  ').goal, '整理周报')
pass('半角冒号与空白')

// 3. 多行目标保留
assert.ok(parseLocalTaskIntent('本机任务：读三份纪要\n然后写周报').goal.includes('\n'))
pass('多行目标保留')

// 4. 列表与状态
assert.deepEqual(parseLocalTaskIntent('本机任务列表'), { kind: 'query', taskId: null, owner: null })
assert.deepEqual(parseLocalTaskIntent('本机任务状态 task-abc'), { kind: 'query', taskId: 'task-abc', owner: null })
pass('列表与状态')

// 5. 取消与补发
assert.deepEqual(parseLocalTaskIntent('取消本机任务'), { kind: 'cancel', taskId: null, owner: null })
assert.deepEqual(parseLocalTaskIntent('取消本机任务 task-abc'), { kind: 'cancel', taskId: 'task-abc', owner: null })
assert.deepEqual(parseLocalTaskIntent('补发本机任务 task-abc'), { kind: 'redeliver', taskId: 'task-abc', owner: null })
pass('取消与补发识别')

// 6. 普通聊天绝不命中；尤其是 task-harness 已占用的三种说法
for (const text of [
  '任务好多啊', '这个任务你做一下', '今天的任务完成了没', '任务', '任务：', '早安', '',
  '任务：新建文件 qq-test.txt 写入 测试', '任务：读出这个文件的内容', '任务列表', '任务状态', '取消任务',
]) {
  assert.equal(parseLocalTaskIntent(text), null, `不该命中：${text}`)
}
pass('普通聊天与旧入口不劫持')

// 7. 超长文本不当任务（防止把整本聊天记录提交成目标）
assert.equal(parseLocalTaskIntent(`本机任务：${'啊'.repeat(2100)}`), null)
pass('超长文本拒绝')

console.log(`${checks} checks passed`)
