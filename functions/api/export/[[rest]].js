/**
 * /api/export 前缀的兜底路由文件（Pages 的「路径参数」文件）。
 *
 * Pages 的路由匹配是精确匹配，functions/api/export.js 只会生成
 * routePath="/api/export"，命中不了 /api/export/policy 这类子路径——
 * 子路径会落到静态资源返回 index.html。文件名带 [[rest]] 参数后，
 * 生成的 routePath 是 "/api/export/:rest*"，子路径统一转发给基础函数。
 */

export { onRequest } from '../export.js';
