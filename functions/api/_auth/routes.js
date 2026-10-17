/**
 * /api/auth 路由实现：管理员引导、登录、登出、当前身份、改密。
 *
 *   POST /api/auth/bootstrap        首次初始化：仅 users 表为空时可用，创建管理员并直接登录
 *   POST /api/auth/login            账号密码登录 → 会话令牌（7 天）
 *   POST /api/auth/logout           注销当前会话
 *   GET  /api/auth/me               当前身份（会话用户 / 令牌 / 匿名 + 体系启用状态）
 *   POST /api/auth/change-password  已登录用户改密（改完其余会话全部失效）
 */

import { jsonResponse, readJson, badRequest, notFound, unauthorized } from '../../_utils/http.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../_utils/auth/password.js';
import { createSession, deleteSession } from '../../_utils/auth/sessions.js';
import { resolvePrincipal, isPrincipalAdmin, isAuthEnabled, invalidateAuthStateCache } from '../../_utils/auth/principal.js';
import { FEATURES } from '../../_utils/auth/policy.js';
import {
  createUser, getUserByUsername, updateUser, hasAnyUser,
  validateUsername, markUserLogin
} from '../../_utils/users.js';
import { extractToken } from '../../_utils/auth.js';
import { NO_CACHE } from '../_logger/constants.js';

/** 登录成功的统一响应（含一次性会话令牌） */
function loginResponse(token, expiresAt, user) {
  return jsonResponse(
    { success: true, data: { token, expiresAt, user } },
    { headers: NO_CACHE }
  );
}

/** 创建管理员引导：只在体系未初始化时开放，防止任何人凭它拿管理员 */
export async function handleBootstrap(context, db) {
  if (await hasAnyUser(db)) {
    return jsonResponse(
      { success: false, error: '鉴权体系已初始化：管理员已存在，请直接登录' },
      { status: 409, headers: NO_CACHE }
    );
  }
  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const { username, password, displayName } = parsed.value ?? {};

  const usernameError = validateUsername(username);
  if (usernameError) return badRequest(usernameError);
  const passwordError = validatePasswordStrength(password);
  if (passwordError) return badRequest(passwordError);

  const passwordHash = await hashPassword(password);
  const user = await createUser(db, {
    username: String(username).trim(),
    passwordHash,
    role: 'admin',
    displayName
  });
  invalidateAuthStateCache();

  const session = await createSession(db, user.id, {
    userAgent: context.request.headers.get('user-agent') ?? ''
  });
  return loginResponse(session.token, session.expiresAt, user);
}

export async function handleLogin(context, db) {
  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const { username, password } = parsed.value ?? {};
  if (!username || !password) return badRequest('用户名与密码不能为空');

  const row = await getUserByUsername(db, username);
  if (!row) return unauthorized('用户名或密码错误');
  const passwordOk = await verifyPassword(password, row.password_hash);
  if (!passwordOk) return unauthorized('用户名或密码错误');
  if (String(row.status ?? 'active') !== 'active') {
    return jsonResponse({ success: false, error: '账号已被禁用：请联系管理员' }, { status: 403, headers: NO_CACHE });
  }

  const user = {
    id: Number(row.id),
    username: String(row.username ?? ''),
    displayName: String(row.display_name ?? ''),
    role: String(row.role ?? 'user'),
    groupId: row.group_id == null ? null : Number(row.group_id),
    status: String(row.status ?? 'active')
  };
  const session = await createSession(db, user.id, {
    userAgent: context.request.headers.get('user-agent') ?? ''
  });
  await markUserLogin(db, user.id);
  return loginResponse(session.token, session.expiresAt, user);
}

export async function handleLogout(context, db) {
  const token = extractToken(context.request);
  await deleteSession(db, token);
  return jsonResponse({ success: true, data: { loggedOut: true } }, { headers: NO_CACHE });
}

/** 当前身份：会话用户 / 令牌 / 匿名，前端据此渲染登录卡片与用户管理入口 */
export async function handleMe(context, db) {
  const token = extractToken(context.request) || new URL(context.request.url).searchParams.get('token') || '';
  const principal = await resolvePrincipal(context.env, db, context.request, token);
  const authEnabled = await isAuthEnabled(db);

  const data = {
    authenticated: Boolean(principal),
    authEnabled,
    isAdmin: isPrincipalAdmin(principal),
    features: FEATURES
  };
  if (principal?.type === 'user') {
    data.user = principal.user;
    data.session = { expiresAt: principal.session.expiresAt };
  } else if (principal?.type === 'token') {
    data.tokenAuth = { role: principal.role, via: principal.via };
  }
  return jsonResponse({ success: true, data }, { headers: NO_CACHE });
}

export async function handleChangePassword(context, db) {
  const token = extractToken(context.request);
  const principal = await resolvePrincipal(context.env, db, context.request, token);
  if (principal?.type !== 'user') return unauthorized('请先登录');

  const parsed = await readJson(context);
  if (!parsed.ok) return badRequest('请求体不是有效的 JSON');
  const { currentPassword, newPassword } = parsed.value ?? {};
  if (!currentPassword || !newPassword) return badRequest('当前密码与新密码不能为空');
  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) return badRequest(passwordError);

  const row = await getUserByUsername(db, principal.user.username);
  if (!row) return notFound('用户不存在');
  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    return unauthorized('当前密码不正确');
  }

  const passwordHash = await hashPassword(newPassword);
  await updateUser(db, row.id, { passwordHash });
  // 其余会话全部失效（当前会话保留，避免改完立刻被踢出）
  await db.execute(
    `DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?`,
    [row.id, principal.session.tokenHash]
  );
  return jsonResponse({ success: true, data: { changed: true } }, { headers: NO_CACHE });
}
