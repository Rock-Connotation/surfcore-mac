import { createHash } from 'node:crypto';

// These parsers validate shape, not provenance or login ownership. The caller must
// use fresh responses from its fixed self/home endpoints and confirm identity.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const numericId = (value) => {
  const id = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return /^[0-9]{1,32}$/.test(id) && !/^0+$/.test(id) ? id : '';
};
const suffix = (id) => id.length > 4 ? id.slice(-4) : null;
const fail = (code, error, hint) => ({ ok: false, code, error, hint });

export function parseDouyinSelf(payload, options = {}) {
  if (!object(options) || options.sourcePath !== '/aweme/v1/web/user/profile/self/') {
    return fail('DOUYIN_SELF_SOURCE', '抖音账号来源无法确认', '重新从抖音账号页面获取登录信息');
  }
  if (!object(payload)) return fail('DOUYIN_SELF_INVALID', '抖音账号响应格式无效', '返回抖音重新登录后重试');
  let raw;
  if (payload.status_code === 0 && object(payload.user) && payload.user.is_login !== false && payload.user.is_guest !== true && payload.is_login !== false) {
    raw = { uid: payload.user.uid, secUid: payload.user.sec_uid, nickname: payload.user.nickname };
  } else {
    return fail('DOUYIN_SELF_UNAUTHENTICATED', '无法确认抖音账号已登录', '在抖音登录后重新获取账号信息');
  }
  const uid = numericId(raw.uid);
  const nickname = text(raw.nickname, 200);
  if (!uid || !nickname) return fail('DOUYIN_SELF_INVALID', '抖音账号信息缺少有效身份', '重新登录并确认当前账号后重试');
  const secUid = text(raw.secUid, 256);
  const accountKey = createHash('sha256').update(`douyin:${uid}`).digest('hex');
  return { ok: true, identity: { uid, secUid, nickname, accountKey } };
}

export function publicDouyinAccount(identity) {
  const uid = object(identity) ? numericId(identity.uid) : '';
  const nickname = object(identity) ? text(identity.nickname, 200) : '';
  return uid && nickname ? { configured: true, nickname, uidSuffix: suffix(uid) } : { configured: false };
}

export function parseDouyinFeed(payload, options = {}) {
  if (!object(options) || options.sourcePath !== '/aweme/v1/web/tab/feed/') {
    return fail('DOUYIN_FEED_SOURCE', '抖音推荐来源无法确认', '返回抖音首页刷新后重试');
  }
  const limit = options.limit === undefined ? 5 : options.limit;
  if (!Number.isInteger(limit) || limit < 1) return fail('DOUYIN_FEED_LIMIT', '推荐数量无效', '使用大于零的整数后重试');
  if (!object(payload) || payload.status_code !== 0 || !Array.isArray(payload.aweme_list)) {
    return fail('DOUYIN_FEED_INVALID', '抖音首页推荐响应无效', '返回抖音首页刷新后重试');
  }
  if (payload.aweme_list.length === 0) return fail('DOUYIN_FEED_EMPTY', '抖音首页暂未返回推荐', '刷新抖音首页后重试');
  const items = [];
  for (const item of payload.aweme_list.slice(0, Math.min(limit, 5))) {
    const id = object(item) ? numericId(item.aweme_id) : '';
    if (!id) return fail('DOUYIN_FEED_ITEM_INVALID', '首页推荐包含无效视频编号', '刷新抖音首页后重试');
    const description = text(item.desc, 2000);
    const projected = { id, url: `https://www.douyin.com/video/${id}`, title: description, description };
    if (object(item.author)) {
      const nickname = text(item.author.nickname, 200);
      const authorUid = numericId(item.author.uid);
      if (nickname) projected.author = { nickname, uidSuffix: suffix(authorUid) };
    }
    const duration = object(item.video) ? item.video.duration : undefined;
    if (Number.isSafeInteger(duration) && duration >= 0) projected.durationMs = duration;
    if (Number.isSafeInteger(item.create_time) && item.create_time > 0 && item.create_time <= 8640000000000) {
      projected.createdAt = new Date(item.create_time * 1000).toISOString();
    }
    items.push(projected);
  }
  return { ok: true, source: 'homepage-recommendation', items };
}
