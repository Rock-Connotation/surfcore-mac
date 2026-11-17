// QQ 自然语言入口的意图解析（纯函数，桥接里唯一判断"这句话是不是本机任务"的地方）。
//
// 只认三种显式说法，避免把普通聊天劫持成任务：
//   本机任务：<目标>                → submit
//   本机任务列表 / 本机任务状态 [号] → query
//   取消本机任务 [号]                → cancel
//
// 前面必须带「本机」二字：`任务：`、`任务状态`、`取消任务` 已经被 task-harness 占用，
// 同名就会把现有的远程任务入口吃掉；宁可多打两个字，也不要两条入口打架。
const SUBMIT = /^本机任务\s*[：:]\s*(?<goal>[\s\S]+)$/
const LIST = /^(?:本机任务列表|本机任务状态)\s*(?<taskId>\S*)$/
const CANCEL = /^取消本机任务\s*(?<taskId>\S*)$/

export function parseLocalTaskIntent(raw, { owner } = {}) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 2000) return null
  let match = SUBMIT.exec(text)
  if (match) {
    const goal = match.groups.goal.trim()
    if (!goal) return null
    return { kind: 'submit', goal, owner: owner ?? null }
  }
  match = LIST.exec(text)
  if (match) return { kind: 'query', taskId: match.groups.taskId || null, owner: owner ?? null }
  match = CANCEL.exec(text)
  if (match) return { kind: 'cancel', taskId: match.groups.taskId || null, owner: owner ?? null }
  return null
}
