const VIEW_BASE = 'https://api.bilibili.com/x/web-interface/view'
const BV_PATTERN = /^BV[A-Za-z0-9]{10}$/
const AID_PATTERN = /^[1-9][0-9]{0,29}$/
// ECMA-262 TimeClip bound: Date is representable for |ms| <= 8.64e15, i.e. |seconds| <= 8640000000000.
const MAX_DATE_SECONDS = 8640000000000
const FIXED_URL = /^https:\/\/api\.bilibili\.com\/x\/web-interface\/view\?(bvid=BV[A-Za-z0-9]{10}|aid=[1-9][0-9]{0,29})$/
const ERROR = 'Bili V2 video text metadata was refused.'

const HINTS = Object.freeze({
  BILI_VIDEO_OFFICIAL_GET_INVALID: 'A Host-owned officialGet closure is required before reading video metadata.',
  BILI_VIDEO_LOCATOR_INVALID: 'Use exactly one video selector: { kind: "video", bvid } or { kind: "video", aid }.',
  BILI_VIDEO_ENDPOINT_DENIED: 'Only the fixed official view endpoint may be requested.',
  BILI_VIDEO_OFFICIAL_UNAVAILABLE: 'The official view response was unreadable; inspect the Host transport.',
  BILI_VIDEO_CODE_REJECTED: 'The official view endpoint did not return code 0.',
  BILI_VIDEO_ID_UNSAFE: 'An official numeric identifier lost integer precision; an exact decimal string is required.',
  BILI_VIDEO_SELECTOR_MISMATCH: 'The returned object does not match the requested selector.',
  BILI_VIDEO_ORIGINAL_INCOMPLETE: 'Required original text fields are missing or invalid; summaries are not accepted.',
})

const fail = (code) => Object.freeze({ ok: false, code, error: ERROR, hint: HINTS[code] })

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const exactId = (value) => {
  if (typeof value === 'string') return AID_PATTERN.test(value) ? { ok: true, value } : { ok: false, reason: 'invalid' }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return { ok: true, value: String(value) }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return { ok: false, reason: 'unsafe' }
  }
  return { ok: false, reason: 'invalid' }
}

const readLocator = (locator) => {
  if (!plainObject(locator)) return { ok: false, code: 'BILI_VIDEO_LOCATOR_INVALID' }
  const keys = Object.keys(locator)
  if (keys.length !== 2 || Object.getOwnPropertySymbols(locator).length !== 0) return { ok: false, code: 'BILI_VIDEO_LOCATOR_INVALID' }
  if (locator.kind !== 'video') return { ok: false, code: 'BILI_VIDEO_LOCATOR_INVALID' }
  const hasBvid = keys.includes('bvid')
  const hasAid = keys.includes('aid')
  if (hasBvid === hasAid) return { ok: false, code: 'BILI_VIDEO_LOCATOR_INVALID' }
  if (hasBvid) {
    if (typeof locator.bvid !== 'string' || !BV_PATTERN.test(locator.bvid)) return { ok: false, code: 'BILI_VIDEO_LOCATOR_INVALID' }
    return { ok: true, url: VIEW_BASE + '?bvid=' + locator.bvid, key: 'bvid', selector: locator.bvid }
  }
  const parsed = exactId(locator.aid)
  if (!parsed.ok) return { ok: false, code: parsed.reason === 'unsafe' ? 'BILI_VIDEO_ID_UNSAFE' : 'BILI_VIDEO_LOCATOR_INVALID' }
  return { ok: true, url: VIEW_BASE + '?aid=' + parsed.value, key: 'aid', selector: parsed.value }
}

export async function readBiliV2VideoMetadata({ locator, officialGet } = {}) {
  if (typeof officialGet !== 'function') return fail('BILI_VIDEO_OFFICIAL_GET_INVALID')
  const target = readLocator(locator)
  if (!target.ok) return fail(target.code)
  if (!FIXED_URL.test(target.url)) return fail('BILI_VIDEO_ENDPOINT_DENIED')

  let body
  try {
    body = await officialGet(target.url)
  } catch {
    return fail('BILI_VIDEO_OFFICIAL_UNAVAILABLE')
  }
  if (!plainObject(body)) return fail('BILI_VIDEO_OFFICIAL_UNAVAILABLE')
  if (body.code !== 0) return fail('BILI_VIDEO_CODE_REJECTED')
  const data = body.data
  if (!plainObject(data)) return fail('BILI_VIDEO_ORIGINAL_INCOMPLETE')

  const unsafe = []
  const invalid = []
  if (typeof data.bvid !== 'string' || !BV_PATTERN.test(data.bvid)) invalid.push('bvid')
  const aid = exactId(data.aid)
  if (!aid.ok) (aid.reason === 'unsafe' ? unsafe : invalid).push('aid')
  let mid = { ok: false, reason: 'invalid' }
  if (!plainObject(data.owner)) invalid.push('owner')
  else {
    mid = exactId(data.owner.mid)
    if (!mid.ok) (mid.reason === 'unsafe' ? unsafe : invalid).push('mid')
    if (typeof data.owner.name !== 'string') invalid.push('name')
  }
  if (typeof data.title !== 'string' || data.title.length === 0) invalid.push('title')
  if (typeof data.desc !== 'string') invalid.push('desc')
  const pubdate = data.pubdate
  if (typeof pubdate !== 'number' || !Number.isSafeInteger(pubdate) || pubdate <= 0 || pubdate > MAX_DATE_SECONDS) invalid.push('pubdate')
  if (unsafe.length > 0) return fail('BILI_VIDEO_ID_UNSAFE')
  if (invalid.length > 0) return fail('BILI_VIDEO_ORIGINAL_INCOMPLETE')

  if (target.key === 'bvid' && data.bvid !== target.selector) return fail('BILI_VIDEO_SELECTOR_MISMATCH')
  if (target.key === 'aid' && aid.value !== target.selector) return fail('BILI_VIDEO_SELECTOR_MISMATCH')

  const occurredAt = new Date(pubdate * 1000).toISOString()
  const owner = Object.freeze({ mid: mid.value, name: data.owner.name })
  const wire = Object.freeze({ bvid: data.bvid, aid: aid.value, title: data.title, desc: data.desc, owner, pubdate })
  return Object.freeze({ ok: true, bvid: data.bvid, aid: aid.value, authorMid: mid.value, occurredAt, coverage: 'text-only', wire })
}
