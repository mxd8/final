/**
 * 多用户管理 API：/api/groups[/...]（管理员）。
 * 与 /api/users 共用一套实现（api/_users/routes.js 分发），独立文件只为
 * 让 Pages 的路由表（_routes.json）覆盖 /api/groups 子路径。
 * 本文件被 groups/[[rest]].js 复用，命中 /api/groups 全部子路径。
 */

import { resolveAdapter } from '../_utils/db/factory.js';
import { handleUsersRequest } from './_users/routes.js';

export async function onRequest(context) {
  const { adapter: db, response } = await resolveAdapter(context.env);
  if (response) return response;
  await db.ready;
  const url = new URL(context.request.url);
  return handleUsersRequest(context, db, url.pathname.replace(/\/+$/, '') || '/', context.request.method);
}
