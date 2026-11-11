import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBiliV2VideoMetadata } from '../lib/bili-v2-video-metadata.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER_SRC = path.join(HERE, '..', 'lib', 'bili-v2-video-metadata.mjs')
const VIEW_BASE = 'https://api.bilibili.com/x/web-interface/view'
const BV = 'BV1xx411c7mD'
const OTHER_BV = 'BV9yy422d8nE'
const AID = '99887766'
const DIGIT19 = '1234567890123456789'
const ROUNDED19 = String(Number(DIGIT19))
const UNSAFE_NUM = Number(DIGIT19)
const OWNER_MID = '1234567'
const PUBDATE = 1700000000
const ISO = '2023-11-14T22:13:20.000Z'
const TITLE = 'SYNTHETIC TITLE'
const DESC = 'SYNTHETIC DESC'
const OWNER_NAME = 'SYNTHETIC_OWNER'

let count = 0
const test = async (name, fn) => {
  await fn()
  count += 1
  console.log('PASS ' + name)
}

const baseData = (overrides = {}) => ({
  bvid: BV,
  aid: AID,
  title: TITLE,
  desc: DESC,
  owner: { mid: OWNER_MID, name: OWNER_NAME },
  pubdate: PUBDATE,
  stat: { view: 42, SECRET_BODY_CANARY: 'raw-stat' },
  pic: 'SECRET_BODY_CANARY',
  pages: [{ cid: 1, duration: 99 }],
  duration: 99,
  tname: 'SECRET_BODY_CANARY',
  cookie: 'SYNTHETIC_COOKIE_VALUE',
  SECRET_BODY_CANARY: 'raw-body',
  ...overrides,
})
const okBody = (data = baseData(), overrides = {}) => ({ code: 0, message: '0', data, ...overrides })

const fakeGet = (body, throwError) => {
  const calls = []
  const officialGet = async (...args) => {
    calls.push(args)
    if (throwError) throw throwError
    return body
  }
  return { officialGet, calls }
}

const expected = (overrides = {}) => ({
  bvid: BV, aid: AID, authorMid: OWNER_MID, title: TITLE, desc: DESC,
  ownerName: OWNER_NAME, pubdate: PUBDATE, occurredAt: ISO, ...overrides,
})

const collectKeys = (obj, out = []) => {
  if (!obj || typeof obj !== 'object') return out
  for (const k of Object.keys(obj)) {
    out.push(k)
    collectKeys(obj[k], out)
  }
  return out
}

const assertSuccess = (result, exp) => {
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result).sort(), ['aid', 'authorMid', 'bvid', 'coverage', 'occurredAt', 'ok', 'wire'])
  assert.equal(result.coverage, 'text-only')
  assert.equal(result.bvid, exp.bvid)
  assert.equal(result.aid, exp.aid)
  assert.equal(result.authorMid, exp.authorMid)
  assert.equal(result.occurredAt, exp.occurredAt)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.wire))
  assert.ok(Object.isFrozen(result.wire.owner))
  assert.deepEqual(Object.keys(result.wire).sort(), ['aid', 'bvid', 'desc', 'owner', 'pubdate', 'title'])
  assert.deepEqual(Object.keys(result.wire.owner).sort(), ['mid', 'name'])
  assert.equal(result.wire.bvid, exp.bvid)
  assert.equal(result.wire.aid, exp.aid)
  assert.equal(result.wire.title, exp.title)
  assert.equal(result.wire.desc, exp.desc)
  assert.equal(result.wire.owner.mid, exp.authorMid)
  assert.equal(result.wire.owner.name, exp.ownerName)
  assert.equal(result.wire.pubdate, exp.pubdate)
  const flat = JSON.stringify(result)
  assert.ok(!flat.includes('SECRET_BODY_CANARY'), 'raw body leaked')
  assert.ok(!flat.includes('SYNTHETIC_COOKIE'), 'cookie leaked')
  const keys = collectKeys(result)
  for (const forbidden of ['verified', 'audience', 'route', 'scope', 'provenance', 'root', 'full', 'stat', 'pic', 'pages', 'duration', 'cid', 'tname', 'cookie', 'message', 'code', 'data']) {
    assert.ok(!keys.includes(forbidden), 'unproven/extra key leaked: ' + forbidden)
  }
}

const assertFailure = (result, code) => {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.deepEqual(Object.keys(result).sort(), ['code', 'error', 'hint', 'ok'])
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
  assert.equal(typeof result.hint, 'string')
  assert.ok(result.hint.length > 0)
  assert.ok(Object.isFrozen(result))
  const flat = JSON.stringify(result)
  assert.ok(!flat.includes('SECRET_BODY_CANARY'), 'body leaked into failure')
  assert.ok(!flat.includes('SYNTHETIC_COOKIE'), 'cookie leaked into failure')
  assert.ok(!flat.includes('SECRET_EXCEPTION_MESSAGE'), 'exception message leaked')
}

async function run() {
  await test('BV selector: fixed URL, Host-only closure, frozen text-only wire, verbatim text', async () => {
    const { officialGet, calls } = fakeGet(okBody(baseData({ title: '  SYNTHETIC TITLE  ' })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assert.equal(r.ok, true, 'helper must implement the frozen video metadata adapter')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].length, 1, 'officialGet receives exactly one URL, no credentials/options')
    assert.equal(calls[0][0], VIEW_BASE + '?bvid=' + BV)
    assertSuccess(r, expected({ title: '  SYNTHETIC TITLE  ' }))
  })

  await test('aid selector: fixed ?aid= URL, exact decimal aid', async () => {
    const { officialGet, calls } = fakeGet(okBody())
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: AID }, officialGet })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], VIEW_BASE + '?aid=' + AID)
    assertSuccess(r, expected())
  })

  await test('19-digit decimal string aid preserved verbatim (no Number conversion)', async () => {
    const { officialGet, calls } = fakeGet(okBody(baseData({ aid: DIGIT19 })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: DIGIT19 }, officialGet })
    assert.equal(calls[0][0], VIEW_BASE + '?aid=' + DIGIT19)
    assertSuccess(r, expected({ aid: DIGIT19 }))
    assert.ok(!JSON.stringify(r).includes('e+'))
  })

  await test('safe integer aid normalised to exact decimal string', async () => {
    const { officialGet } = fakeGet(okBody(baseData({ aid: 99887766 })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: 99887766 }, officialGet })
    assertSuccess(r, expected({ aid: '99887766' }))
  })

  await test('19-digit owner.mid string preserved verbatim', async () => {
    const { officialGet } = fakeGet(okBody(baseData({ owner: { mid: DIGIT19, name: OWNER_NAME } })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertSuccess(r, expected({ authorMid: DIGIT19 }))
  })

  await test('occurredAt derived from original pubdate seconds, not now', async () => {
    const { officialGet } = fakeGet(okBody(baseData({ pubdate: PUBDATE + 1 })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertSuccess(r, expected({ pubdate: PUBDATE + 1, occurredAt: '2023-11-14T22:13:21.000Z' }))
  })

  // run2 日期判据：ECMA-262 TimeClip 上限 8.64e15 ms / 1000 = 8640000000000 秒；超过即 Date 不可表示。
  await test('run2 RED: MAX_SAFE_INTEGER pubdate yields fixed ORIGINAL_INCOMPLETE, never RangeError', async () => {
    const { officialGet, calls } = fakeGet(okBody(baseData({ pubdate: Number.MAX_SAFE_INTEGER })))
    let r
    try {
      r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    } catch (error) {
      assert.fail('pubdate beyond Date range must not throw: ' + error.name + ' ' + error.message)
    }
    assertFailure(r, 'BILI_VIDEO_ORIGINAL_INCOMPLETE')
    assert.equal(calls.length, 1)
  })

  await test('run2: Date max seconds 8640000000000 stays a legal original (TimeClip ms/1000)', async () => {
    const { officialGet, calls } = fakeGet(okBody(baseData({ pubdate: 8640000000000 })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertSuccess(r, expected({ pubdate: 8640000000000, occurredAt: '+275760-09-13T00:00:00.000Z' }))
    assert.equal(calls.length, 1)
  })

  await test('run2: one second past Date max 8640000000001 refused without throw or leak', async () => {
    const { officialGet, calls } = fakeGet(okBody(baseData({ pubdate: 8640000000001 })))
    let r
    try {
      r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    } catch (error) {
      assert.fail('out-of-range pubdate must not throw: ' + error.name + ' ' + error.message)
    }
    assertFailure(r, 'BILI_VIDEO_ORIGINAL_INCOMPLETE')
    assert.equal(calls.length, 1)
  })

  await test('run2: ordinary pubdate 1700000000 keeps verbatim ISO, no now/summary substitution', async () => {
    const { officialGet } = fakeGet(okBody(baseData({ pubdate: PUBDATE, desc: DESC })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertSuccess(r, expected({ pubdate: PUBDATE, occurredAt: ISO }))
    assert.equal(r.occurredAt, ISO)
  })

  await test('legally empty desc and owner.name are accepted', async () => {
    const { officialGet } = fakeGet(okBody(baseData({ desc: '', owner: { mid: OWNER_MID, name: '' } })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertSuccess(r, expected({ desc: '', ownerName: '' }))
  })

  await test('unsafe numeric response aid rejected even when rounded selector string matches', async () => {
    assert.equal(Number.isSafeInteger(UNSAFE_NUM), false)
    assert.equal(String(UNSAFE_NUM), ROUNDED19)
    const { officialGet, calls } = fakeGet(okBody(baseData({ aid: UNSAFE_NUM })))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: ROUNDED19 }, officialGet })
    assertFailure(r, 'BILI_VIDEO_ID_UNSAFE')
    assert.equal(calls.length, 1)
  })

  await test('unsafe numeric response owner.mid / aid rejected', async () => {
    const cases = [
      baseData({ owner: { mid: UNSAFE_NUM, name: OWNER_NAME } }),
      baseData({ aid: UNSAFE_NUM }),
    ]
    for (const data of cases) {
      const { officialGet } = fakeGet(okBody(data))
      const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
      assertFailure(r, 'BILI_VIDEO_ID_UNSAFE')
    }
  })

  await test('unsafe numeric selector aid rejected before any GET', async () => {
    const { officialGet, calls } = fakeGet(okBody())
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: UNSAFE_NUM }, officialGet })
    assertFailure(r, 'BILI_VIDEO_ID_UNSAFE')
    assert.equal(calls.length, 0)
  })

  await test('returned bvid/aid mismatch with selector is refused', async () => {
    const a = fakeGet(okBody(baseData({ bvid: OTHER_BV })))
    assertFailure(await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet: a.officialGet }), 'BILI_VIDEO_SELECTOR_MISMATCH')
    const b = fakeGet(okBody())
    assertFailure(await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: '111' }, officialGet: b.officialGet }), 'BILI_VIDEO_SELECTOR_MISMATCH')
  })

  await test('missing/invalid original fields and non-object data are refused', async () => {
    const badData = [
      baseData({ owner: undefined }),
      baseData({ owner: null }),
      baseData({ owner: { name: OWNER_NAME } }),
      baseData({ owner: { mid: OWNER_MID, name: 7 } }),
      baseData({ owner: { mid: 'abc', name: OWNER_NAME } }),
      baseData({ title: undefined }),
      baseData({ title: '' }),
      baseData({ title: 7 }),
      baseData({ desc: undefined }),
      baseData({ desc: 7 }),
      baseData({ pubdate: undefined }),
      baseData({ pubdate: '1700000000' }),
      baseData({ pubdate: 0 }),
      baseData({ pubdate: -1 }),
      baseData({ pubdate: UNSAFE_NUM }),
      baseData({ bvid: undefined }),
      baseData({ bvid: 7 }),
      baseData({ aid: undefined }),
      baseData({ aid: 'x' }),
    ]
    const bodies = badData.map((data) => okBody(data)).concat([
      { code: 0, data: null },
      { code: 0, data: 'x' },
      { code: 0, data: [] },
      { code: 0 },
    ])
    for (const body of bodies) {
      const { officialGet, calls } = fakeGet(body)
      const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
      assertFailure(r, 'BILI_VIDEO_ORIGINAL_INCOMPLETE')
      assert.equal(calls.length, 1)
    }
  })

  await test('summary/timestamp/model fields never substitute missing originals', async () => {
    const data = baseData({ desc: undefined, pubdate: undefined, summary: 'SECRET_BODY_CANARY', timestamp: PUBDATE, model_output: DESC })
    const { officialGet } = fakeGet(okBody(data))
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assertFailure(r, 'BILI_VIDEO_ORIGINAL_INCOMPLETE')
  })

  await test('non-0 code and missing code are refused with fixed failure', async () => {
    const bodies = [okBody(baseData(), { code: -400 }), okBody(baseData(), { code: undefined }), { code: 1, data: baseData() }]
    for (const body of bodies) {
      const { officialGet, calls } = fakeGet(body)
      const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
      assertFailure(r, 'BILI_VIDEO_CODE_REJECTED')
      assert.equal(calls.length, 1)
    }
  })

  await test('officialGet exception and unreadable body produce fixed failure without leaking error.message', async () => {
    const a = fakeGet(null, new Error('SECRET_EXCEPTION_MESSAGE SECRET_BODY_CANARY'))
    assertFailure(await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet: a.officialGet }), 'BILI_VIDEO_OFFICIAL_UNAVAILABLE')
    assert.equal(a.calls.length, 1)
    for (const body of [undefined, null, 'STRING', 7, []]) {
      const g = fakeGet(body)
      assertFailure(await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet: g.officialGet }), 'BILI_VIDEO_OFFICIAL_UNAVAILABLE')
    }
  })

  await test('extra selector fields are refused before any GET', async () => {
    const locators = [
      { kind: 'video', bvid: BV, extra: 1 },
      { kind: 'video', bvid: BV, aid: AID },
      { kind: 'video', bvid: BV, url: VIEW_BASE },
      { kind: 'video', aid: AID, officialGet: 'x' },
      { kind: 'video', bvid: BV, audience: 'public' },
    ]
    for (const locator of locators) {
      const { officialGet, calls } = fakeGet(okBody())
      const r = await readBiliV2VideoMetadata({ locator, officialGet })
      assertFailure(r, 'BILI_VIDEO_LOCATOR_INVALID')
      assert.equal(calls.length, 0)
    }
  })

  await test('non-fixed URL / query-injection locators are refused before any GET', async () => {
    const locators = [
      { kind: 'video', bvid: BV + '?aid=1&x=2' },
      { kind: 'video', bvid: BV + '#frag' },
      { kind: 'video', bvid: BV + '/../../x' },
      { kind: 'video', aid: AID + '&bvid=' + BV },
      { kind: 'video', aid: AID + '?x=1' },
    ]
    for (const locator of locators) {
      const { officialGet, calls } = fakeGet(okBody())
      const r = await readBiliV2VideoMetadata({ locator, officialGet })
      assertFailure(r, 'BILI_VIDEO_LOCATOR_INVALID')
      assert.equal(calls.length, 0)
    }
  })

  await test('bad locator shapes are refused before any GET', async () => {
    const sym = Symbol('extra')
    const withSymbol = { kind: 'video', bvid: BV, [sym]: 1 }
    const locators = [
      undefined, null, 'video', 7, [], {},
      { kind: 'comment', bvid: BV }, { kind: 'video' }, { kind: 'video', bvid: BV, aid: AID },
      { kind: 'video', bvid: 123 }, { kind: 'video', bvid: 'BVshort' }, { kind: 'video', bvid: '' },
      { kind: 'video', aid: '0' }, { kind: 'video', aid: '-5' }, { kind: 'video', aid: '1.5' },
      { kind: 'video', aid: ' 99887766 ' }, { kind: 'video', aid: 0 }, { kind: 'video', aid: -1 },
      { kind: 'video', aid: 1.5 }, { kind: 'video', aid: {} }, { kind: 'video', aid: true },
      Object.create(null), withSymbol,
    ]
    for (const locator of locators) {
      const { officialGet, calls } = fakeGet(okBody())
      const r = await readBiliV2VideoMetadata({ locator, officialGet })
      assertFailure(r, 'BILI_VIDEO_LOCATOR_INVALID')
      assert.equal(calls.length, 0)
    }
  })

  await test('invalid officialGet is refused before any call', async () => {
    for (const officialGet of [undefined, null, 'x', 7, {}]) {
      const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
      assertFailure(r, 'BILI_VIDEO_OFFICIAL_GET_INVALID')
    }
    assertFailure(await readBiliV2VideoMetadata(), 'BILI_VIDEO_OFFICIAL_GET_INVALID')
    assertFailure(await readBiliV2VideoMetadata({}), 'BILI_VIDEO_OFFICIAL_GET_INVALID')
  })

  await test('no retry: every response failure calls officialGet exactly once', async () => {
    const bodies = [okBody(baseData({ title: '' })), okBody(baseData(), { code: -400 }), okBody(baseData({ bvid: OTHER_BV }))]
    for (const body of bodies) {
      const { officialGet, calls } = fakeGet(body)
      const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
      assert.equal(r.ok, false)
      assert.equal(calls.length, 1)
    }
  })

  await test('Host URL allowlist: helper requests only the fixed view endpoint', async () => {
    const calls = []
    const officialGet = async (...args) => {
      calls.push(args)
      const url = args[0]
      if (url !== VIEW_BASE + '?bvid=' + BV && url !== VIEW_BASE + '?aid=' + AID) throw new Error('UNEXPECTED_NON_FIXED_URL')
      return okBody()
    }
    const a = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    const b = await readBiliV2VideoMetadata({ locator: { kind: 'video', aid: AID }, officialGet })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(calls.length, 2)
    assert.ok(calls.every((c) => c.length === 1))
  })

  await test('wire and return are deeply frozen; mutation throws', async () => {
    const { officialGet } = fakeGet(okBody())
    const r = await readBiliV2VideoMetadata({ locator: { kind: 'video', bvid: BV }, officialGet })
    assert.throws(() => { r.wire.title = 'MUTATED' })
    assert.throws(() => { r.wire.owner.mid = 'MUTATED' })
    assert.throws(() => { r.coverage = 'full' })
    assert.equal(r.coverage, 'text-only')
  })

  await test('helper source has no imports, network, credentials or placeholder tokens', () => {
    const src = fs.readFileSync(HELPER_SRC, 'utf8')
    for (const forbidden of ['fetch(', 'import ', 'require(', 'process.env', 'fs.', 'setTimeout', 'retry', 'wbi', '{{' + 'SECRET_']) {
      assert.ok(!src.includes(forbidden), 'helper source contains ' + forbidden)
    }
    assert.ok(src.includes('https://api.bilibili.com/x/web-interface/view'))
    assert.equal((src.match(/export async function readBiliV2VideoMetadata/g) || []).length, 1)
  })
}

try {
  await run()
  console.log('PASS Bili V2 video text metadata: ' + count + ' cases')
} catch (error) {
  console.log('FAIL ' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
}
