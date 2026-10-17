/**
 * 鉴权 API：/api/auth（登录会话与管理员引导）。
 *
 *   POST /api/auth/bootstrap | /login | /logout | /change-password
 *   GET  /api/auth/me
 *
 * 分发逻辑只保留路径 → 处理函数的映射，实现在 api/_auth/routes.js。
 * 本文件同时被 auth/[[rest]].js 复用，命中 /api/auth 全部子路径。
 */

import { methodNotAllowed, notFound, errorResponse } from '../_utils/http.js';
import { resolveAdapter } from '../_utils/db/factory.js';
import {
  handleBootstrap, handleLogin, handleLogout, handleMe, handleChangePassword
} from './_auth/routes.js';

const TAG = 'api/auth';

const POST_PATHS = new Set(['bootstrap', 'login', 'logout', 'change-password']);
const GET_PATHS = new Set(['me']);

export async function onRequest(context) {
  const { adapter: db, response } = await resolveAdapter(context.env);
  if (response) return response;

  const url = new URL(context.request.url);
  const method = context.request.method;
  const sub = url.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/+$/, '');
  const isRoot = url.pathname === '/api/auth' || url.pathname === '/api/auth/';

  try {
    await db.ready;

    if (isRoot) return methodNotAllowed(method, 'GET, POST');
    if (method === 'POST' && POST_PATHS.has(sub)) {
      if (sub === 'bootstrap') return await handleBootstrap(context, db);
      if (sub === 'login') return await handleLogin(context, db);
      if (sub === 'logout') return await handleLogout(context, db);
      if (sub === 'change-password') return await handleChangePassword(context, db);
    }
    if (method === 'GET' && GET_PATHS.has(sub)) {
      if (sub === 'me') return await handleMe(context, db);
    }
    if (POST_PATHS.has(sub) || GET_PATHS.has(sub)) {
      return methodNotAllowed(method, POST_PATHS.has(sub) ? 'POST' : 'GET');
    }
    return notFound(`未知的鉴权接口：/api/auth/${sub}`);
  } catch (error) {
    return errorResponse(TAG, method, url.pathname, error);
  }
}
