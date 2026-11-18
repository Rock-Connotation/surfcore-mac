// QQ 自然语言入口的意图解析（纯函数，桥接里唯一判断"这句话是不是本机任务"的地方）。
//
// 只认显式本机任务与 t<7位hex> 交互确认说法，避免把普通聊天劫持成任务：
//   本机任务：<目标>                → submit（跟随配置 mode）
//   文件任务：<目标>                → submit（mode = 'files-only'）
//   本机任务列表 / 本机任务状态 [号] → query
//   取消本机任务 [号]                → cancel
//   补发本机任务 [号]                → redeliver
//   通过/始终允许/拒绝 t<7位hex>     → answer（CUA / 沙箱权限确认）
//   t<7位hex> <回答>                 → answer（ask_user_question）
//
// 前面必须带「本机」/「文件」二字：`任务：`、`任务状态`、`取消任务` 已经被 task-harness 占用，
// 同名就会把现有的远程任务入口吃掉；宁可多打两个字，也不要两条入口打架。
const SUBMIT = /^本机任务\s*[：:]\s*(?<goal>[\s\S]+)$/
const SUBMIT_FILES_ONLY = /^文件任务\s*[：:]\s*(?<goal>[\s\S]+)$/
const LIST = /^(?:本机任务列表|本机任务状态)\s*(?<taskId>\S*)$/
const CANCEL = /^取消本机任务\s*(?<taskId>\S*)$/
const REDELIVER = /^补发本机任务\s*(?<taskId>\S*)$/
const ANSWER_ALLOW = /^(?:通过|允许|同意|批准|allow)\s+(?<id>t[a-f0-9]{7})$/i
const ANSWER_ALWAYS = /^(?:始终允许|总是允许|永久允许|always)\s+(?<id>t[a-f0-9]{7})$/i
const ANSWER_REJECT = /^(?:拒绝|不通过|不同意|拒绝执行|deny|reject)\s+(?<id>t[a-f0-9]{7})$/i
const ANSWER_FREEFORM = /^(?<id>t[a-f0-9]{7})\s+(?<answerText>[\s\S]+)$/i

export function parseLocalTaskIntent(raw, { owner } = {}) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 2000) return null
  let match = SUBMIT.exec(text)
  if (match) {
    const goal = match.groups.goal.trim()
    if (!goal) return null
    return { kind: 'submit', goal, owner: owner ?? null }
  }
  match = SUBMIT_FILES_ONLY.exec(text)
  if (match) {
    const goal = match.groups.goal.trim()
    if (!goal) return null
    return { kind: 'submit', goal, mode: 'files-only', owner: owner ?? null }
  }
  match = LIST.exec(text)
  if (match) return { kind: 'query', taskId: match.groups.taskId || null, owner: owner ?? null }
  match = CANCEL.exec(text)
  if (match) return { kind: 'cancel', taskId: match.groups.taskId || null, owner: owner ?? null }
  match = REDELIVER.exec(text)
  if (match) return { kind: 'redeliver', taskId: match.groups.taskId || null, owner: owner ?? null }
  match = ANSWER_ALLOW.exec(text)
  if (match) return { kind: 'answer', id: match.groups.id.toLowerCase(), decision: 'allow', owner: owner ?? null }
  match = ANSWER_ALWAYS.exec(text)
  if (match) return { kind: 'answer', id: match.groups.id.toLowerCase(), decision: 'always', owner: owner ?? null }
  match = ANSWER_REJECT.exec(text)
  if (match) return { kind: 'answer', id: match.groups.id.toLowerCase(), decision: 'reject', owner: owner ?? null }
  match = ANSWER_FREEFORM.exec(text)
  if (match) {
    const answerText = match.groups.answerText.trim()
    if (!answerText) return null
    return { kind: 'answer', id: match.groups.id.toLowerCase(), answerText, owner: owner ?? null }
  }
  return null
}
