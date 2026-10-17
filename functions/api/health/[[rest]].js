/**
 * /api/health 前缀的兜底路由文件（与 api/logger/[[rest]].js 同理）：
 * Pages 的路由匹配是精确匹配，基础文件只生成 routePath="/api/health"，
 * 这个 [[rest]] 文件让任意子路径与尾斜杠也命中上者，分发逻辑仍只有一份。
 */
export { onRequest } from '../health.js';
