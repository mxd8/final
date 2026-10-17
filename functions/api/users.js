/**
 * 多用户管理 API：/api/users[/...] 与 /api/groups[/...]（管理员）。
 * 实现在 api/_users/routes.js；本文件被 users/[[rest]].js 复用，
 * 命中 /api/users 与 /api/groups 全部子路径。
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
