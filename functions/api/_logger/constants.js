/**
 * /api/logger 路由共用常量与小工具。
 */

export const TAG = 'api/logger';

/** 只读路由允许被浏览器缓存 30 秒 */
export const CACHE_OK = { 'Cache-Control': 'public, max-age=30' };

/** 写操作后必须立刻能看到最新数据 */
export const NO_CACHE = { 'Cache-Control': 'no-store' };

export const READ_PATHS = new Set([
  '/api/logger',
  '/api/logger/stats',
  '/api/logger/export',
  '/api/logger/export-summary',
  '/api/logger/schema',
  '/api/logger/meta'
]);

export const WRITE_PATHS = new Set([
  '/api/logger/hit',
  '/api/logger/hits',
  '/api/logger/update',
  '/api/logger/delete',
  '/api/logger/exclude',
  '/api/logger/batch',
  '/api/logger/clear',
  '/api/logger/clear-empty'
]);

/** 容忍尾随斜杠，避免脚本少写一段路径拿到 404 */
export function normalizePath(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/** 命中次数下限：非正整数或 <=1 一律按 0（不过滤）处理 */
export function readMinCount(params) {
  const raw = Number(params.get('min-count'));
  if (!Number.isFinite(raw)) return 0;
  const value = Math.floor(raw);
  return value > 1 ? value : 0;
}

/** 最近 N 天过滤：非正整数一律按 0（不过滤）处理，与前端快捷档位保持一致 */
export function readLastDays(params) {
  const raw = Number(params.get('last-days'));
  if (!Number.isFinite(raw)) return 0;
  const value = Math.floor(raw);
  return value > 0 ? value : 0;
}
