/**
 * /api/schema 前缀的兜底路由文件。
 *
 * 子路径 /api/schema/table/<name>（单表建表语句）必须能被路由命中，否则会被
 * 当成静态资源返回 index.html。原因与处理方式见 logger/[[rest]].js。
 */
export { onRequest } from '../schema.js';
