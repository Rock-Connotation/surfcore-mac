import { BILI_CRED } from './paths.js';
import { addCandidate, detectCandidatesFromText } from './align.js';
import { readJson } from './store.js';

/** 从 B 站公开回复/@ 里找 QQ 号候选。需要 cookie；失败只记录不抛。 */
export async function scanBiliFeedForCandidates({ maxPages = 2 } = {}) {
  try {
    const { pullFeed, makeHeaders } = await import('../tools/lib/msgfeed.mjs');
    const credentials = readJson(BILI_CRED, null);
    if (!credentials?.sessdata || !credentials?.bili_jct) {
      return { ok: false, code: 'ALIGN_BILI_ACCOUNT_REQUIRED', error: 'B 站账号未登录，无法扫描候选。', hint: '在 B 站设置页登录后重新扫描。', added: 0 };
    }
    const headers = makeHeaders(credentials);
    const items = [];
    for (const kind of ['reply', 'at']) {
      try {
        const page = await pullFeed(kind, { headers, pages: maxPages });
        items.push(...(page.items ?? []));
      } catch {}
    }
    let added = 0;
    for (const item of items.slice(0, 400)) {
      const text = String(item?.text ?? item?.content ?? '');
      const hit = detectCandidatesFromText({
        platform: 'bili',
        text,
        author: { id: String(item?.mid ?? ''), name: String(item?.who ?? item?.uname ?? '') },
        source: 'bili-public-feed',
        counterpartPlatform: 'qq',
      });
      for (const candidate of hit) {
        if (addCandidate(candidate)) added += 1;
      }
    }
    const state = { at: new Date().toISOString(), scanned: items.length, added };
    return { ok: true, ...state };
  } catch (error) {
    return { ok: false, code: 'ALIGN_BILI_SCAN_FAILED', error: String(error?.message ?? error), hint: '检查 B 站连接后重新扫描。', added: 0 };
  }
}
