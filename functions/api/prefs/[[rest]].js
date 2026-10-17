/**
 * /api/prefs 前缀的兜底路由文件。
 *
 * 子路径 /api/prefs/schema（建表语句）必须能被路由命中，否则会被当成
 * 静态资源返回 index.html。原因与处理方式见 logger/[[rest]].js。
 */
export { onRequest } from '../prefs.js';
