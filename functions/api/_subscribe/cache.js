/**
 * 解析结果内存缓存：同一订阅被「解析并保存」与「重新解析」重复请求时不必再抓一遍。
 * 多 isolate 不共享，TTL 只有 5 分钟，过期后自然重新抓。
 */

/** 单次解析最多缓存多少条：超限按插入序淘汰 */
const MAX_CACHE_ENTRIES = 200;

/** 缓存有效期（毫秒） */
const CACHE_TTL_MS = 5 * 60 * 1000;

const parseCache = new Map();

/** 命中且未过期返回结果，否则删掉过期项并返回 null */
export function readCache(url) {
  const hit = parseCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    parseCache.delete(url);
    return null;
  }
  return hit.value;
}

/** 写入缓存并淘汰最旧条目（Map 保持插入序，第一个 key 就是最旧的） */
export function writeCache(url, value) {
  parseCache.delete(url);
  parseCache.set(url, { at: Date.now(), value });
  while (parseCache.size > MAX_CACHE_ENTRIES) {
    const oldest = parseCache.keys().next();
    if (oldest.done) break;
    parseCache.delete(oldest.value);
  }
}
