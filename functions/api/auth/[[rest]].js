/**
 * 兜底路由：让 /api/auth 全部子路径命中上者（与 logger/[[rest]].js 同一机制）。
 */
export { onRequest } from '../auth.js';
