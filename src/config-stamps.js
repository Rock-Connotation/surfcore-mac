// 配置文件版本戳按内容计算，避免同尺寸及时间戳碰撞。
// 用途：设置页保存时带上加载时的戳；服务端发现文件已经变了 → 409，而不是整份回写把别人的修改覆盖掉
//（2026-10-29 复盘：面板整份回写会把控制台刚改的语音开关覆盖回 false）。
import fs from 'node:fs';
import crypto from 'node:crypto';

/** 返回内容摘要；文件不存在或读不到返回 ''。 */
export function fileStamp(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 判断"提交时带的戳"是否已过期。
 * 规则：
 *   - 调用方没带戳（旧客户端）→ 不过期（兼容，允许保存）；
 *   - 服务端当前读不到文件 → 不过期；
 *   - 都拿到了但不相等 → 过期（配置被别处改过）。
 */
export function isStale(provided, current) {
  if (!provided || !current) return false;
  return String(provided) !== String(current);
}
