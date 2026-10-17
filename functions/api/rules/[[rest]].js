export { onRequest } from "../rules.js";

/**
 * /api/rules 前缀的兜底路由文件。
 *
 * rules 路由里有 /api/rules/:id（按 ID 读取/更新/删除），必须被路由命中
 * 而不是落到静态资源。原因与处理方式见 logger/[[rest]].js。
 */
