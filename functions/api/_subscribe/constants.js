/**
 * /api/subscribe 路由共用常量与小工具。
 */

export const TAG = 'api/subscribe';

/** 只读响应可被浏览器缓存 30 秒 */
export const CACHE_OK = { 'Cache-Control': 'public, max-age=30' };

/** 抓取结果绝不缓存：否则改了订阅链接，浏览器会拿旧内容应付 */
export const NO_CACHE = { 'Cache-Control': 'no-store' };

export const READ_PATHS = new Set(['/api/subscribe', '/api/subscribe/schema']);

export const WRITE_PATHS = new Set(['/api/subscribe/parse', '/api/subscribe/save', '/api/subscribe/delete']);

/** 容忍尾随斜杠 */
export function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
