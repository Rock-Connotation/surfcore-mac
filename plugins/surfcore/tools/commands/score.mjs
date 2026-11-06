// 同一 BV 同一天保留最高分；写入必须经过备份、原子替换与读回。
import { recordScore, todayScores, bestToday } from '../lib/scores.mjs'
const argv = process.argv.slice(2), opt = {}, pos = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) { pos.push(a); continue }
  const key = a.slice(2)
  if (['json', 'today', 'best'].includes(key)) { opt[key] = true; continue }
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) opt[key] = true
  else { opt[key] = value; i++ }
}
const json = opt.json === true
function output(value) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`)
  else if (value.ok === false) process.stderr.write(`${value.code}：${value.error}\n建议：${value.hint}\n`)
  else if (value.action === 'list') {
    process.stdout.write(`今天评过的（${value.items.length} 条，从高到低）：\n`)
    for (const x of value.items) process.stdout.write(`  ${String(x.score).padStart(2)}/20  ${x.bv}  ${x.title || ''}  ${x.reason || ''}\n`)
    if (opt.best && value.best) process.stdout.write(`\n最高分：${value.best.bv}（${value.best.score}/20）\nBV:${value.best.bv}\n`)
  } else process.stdout.write(`✓ 已核对评分：${value.entry.bv} → ${value.entry.score}/20${value.entry.score !== value.requestedScore ? '（保留同日较高分）' : ''}\n`)
}
try {
  if (opt.today || opt.best) {
    const items = todayScores(), best = bestToday()
    if (!items.length) throw Object.assign(new Error('今天还没有评分。'), { code: 'SCORES_EMPTY', hint: '先为视频评分后再查看。' })
    output({ ok: true, action: 'list', items, best })
  } else {
    const bv = String(pos[0] ?? '').trim(), score = Number(opt.score)
    if (!/^BV[0-9A-Za-z]{10}$/.test(bv) || typeof opt.score !== 'string' || !Number.isFinite(score) || score < 0 || score > 20) throw Object.assign(new Error('BV 或评分无效。'), { code: 'SCORE_INVALID', hint: '使用 score <BV> --score 0-20 [--reason 理由]。' })
    recordScore({ bv, score, reason: String(opt.reason ?? ''), title: String(opt.title ?? '') })
    const entry = todayScores().find(item => item.bv === bv)
    if (!entry || Number(entry.score) < score) throw Object.assign(new Error('写入后无法确认评分。'), { code: 'SCORES_VERIFY_FAILED', hint: '检查原账本及备份后再决定是否重试。' })
    output({ ok: true, action: 'record', requestedScore: score, entry })
  }
} catch (error) {
  output({ ok: false, code: String(error.code || 'SCORES_FAILED'), error: String(error.message || '评分失败。'), hint: String(error.hint || '检查角色评分账本后重试。') })
  process.exitCode = 1
}
