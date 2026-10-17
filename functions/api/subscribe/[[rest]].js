/**
 * /api/subscribe 前缀的兜底路由文件（Pages 的「路径参数」文件）。
 *
 * 为什么必须有这个文件：Pages 的路由匹配用的是 path-to-regexp 的精确匹配
 * （end: true）。functions/api/subscribe.js 只会生成 routePath="/api/subscribe"，
 * 无法命中 /api/subscribe/parse、/api/subscribe/save 等子路径——生产环境的
 * _routes.json 里 include 只有 "/api/subscribe"，子路径会全部落到静态资源，
 * 返回 index.html（HTTP 200 但内容是 HTML），本地 pages dev 不读
 * _routes.json 所以查不出来。
 *
 * 文件名带 [[rest]] 参数后，wrangler 生成的 routePath 是 "/api/subscribe/:rest*"，
 * 这个模式既命中 /api/subscribe，也命中任意深度的子路径。
 * 这里直接转发给同名基础函数，路由分发逻辑仍然只有一份（单一职责）。
 */
export { onRequest } from '../subscribe.js';
