/**
 * /api/ai 子路径兜底路由（如 /api/ai/config）。
 * Pages Functions 只匹配到文件级路由，子路径统一转发给上级分发器，
 * 保证新加端点时无需改动 _routes.json（机制详见 api/logger/[[rest]].js）。
 */

export { onRequest } from '../ai.js';
