/**
 * 请求身份解析与写操作鉴权守卫（v4 多用户体系核心）。
 *
 * 三类合法身份（优先级从高到低）：
 *   1. 会话用户  Authorization Bearer <sessionToken> → users 表 active 用户；
 *   2. 管理令牌  PANEL_WRITE_TOKEN 任一匹配 → 视同 admin（兼容既有部署与外部定时器）；
 *   3. 上报令牌  PANEL_HIT_TOKEN 匹配 → 仅限上报接口（/hit /hits /stats 心跳）。
 *
 * 强制策略：鉴权体系启用（users 表存在用户）后，**匿名添加数据一律拒绝**——
 * 写接口 / 上报接口都必须携带合法且有效的鉴权信息；体系未启用（还没执行
 * 管理员引导）时保持旧行为，写接口回落 requireWriteToken（开放 + Warning 头）。
 *
 * 所有守卫返回统一契约：{ ok: true, principal } 或 { ok: false, response }。
 */

import {
  configuredWriteToken, configuredHitToken, requireHitToken,
  extractToken, extractUrlOrHeaderToken, splitTokenList, isAnyTokenMatch,
  warningHeadersIfOpen
} from '../auth.js';
import { jsonResponse } from '../http.js';
import { hasAnyUser, parsePermissions } from '../users.js';
import { findLiveSession, touchSession } from './sessions.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** users 表非空即视为鉴权体系启用（首个管理员经 /api/auth/bootstrap 创建） */
let authStateCache = { enabled: null, at: 0 };
const AUTH_CACHE_TTL_MS = 30 * 1000;

export function invalidateAuthStateCache() {
  authStateCache = { enabled: null, at: 0 };
}

export async function isAuthEnabled(db, nowMs = Date.now()) {
  if (authStateCache.enabled !== null && nowMs - authStateCache.at < AUTH_CACHE_TTL_MS) {
    return authStateCache.enabled;
  }
  const enabled = await hasAnyUser(db);
  authStateCache = { enabled, at: nowMs };
  return enabled;
}

/** 会话令牌 → 活跃用户身份；未命中 / 已过期 / 用户被禁用返回 null */
async function sessionPrincipal(db, token) {
  if (!token) return null;
  const row = await findLiveSession(db, token);
  if (!row) return null;
  if (String(row.status ?? 'active') !== 'active') return null;
  touchSession(db, row.token_hash).catch(() => {});
  return {
    type: 'user',
    user: {
      id: Number(row.u_id),
      username: String(row.username ?? ''),
      displayName: String(row.display_name ?? ''),
      role: String(row.role ?? 'user'),
      groupId: row.group_id == null ? null : Number(row.group_id),
      status: String(row.status ?? 'active'),
      permissions: parsePermissions(row.permissions)
    },
    group: row.group_id != null
      ? { id: Number(row.group_id), name: String(row.group_name ?? ''), permissions: parsePermissions(row.group_permissions) }
      : null,
    session: { tokenHash: row.token_hash, expiresAt: String(row.expires_at ?? '') }
  };
}

/**
 * 解析请求身份：会话令牌优先，其余与既有令牌变量比对。
 * @param token 令牌候选（Bearer / X-Panel-Token / ?token=，由调用方按接口形态传入）
 */
export async function resolvePrincipal(env, db, request, token) {
  const session = await sessionPrincipal(db, token);
  if (session) return session;

  const supplied = String(token ?? '');
  const writeTokens = splitTokenList(configuredWriteToken(env));
  if (writeTokens.length && isAnyTokenMatch(writeTokens, supplied)) {
    return { type: 'token', role: 'admin', via: 'write-token' };
  }
  const hitTokens = splitTokenList(configuredHitToken(env));
  if (hitTokens.length && isAnyTokenMatch(hitTokens, supplied)) {
    return { type: 'token', role: 'report', via: 'hit-token' };
  }
  return null;
}

export function isPrincipalAdmin(principal) {
  if (!principal) return false;
  if (principal.type === 'token') return principal.role === 'admin';
  return principal.user?.role === 'admin';
}

/** 匿名请求的统一 401 出口（提示语区分体系是否已启用） */
function denyMutation(authEnabled) {
  return jsonResponse(
    {
      success: false,
      error: authEnabled
        ? '已启用多用户鉴权：禁止匿名添加数据，请先登录（面板「用户」页）或在请求头携带有效令牌'
        : '未通过写操作鉴权：请在面板「写接口令牌」中填写正确令牌'
    },
    { status: 401, headers: NO_STORE }
  );
}

/**
 * 写接口鉴权（/api/logger/update·delete·…、/api/subscribe/…、/api/prefs 写删等）。
 *   会话用户或管理令牌 → 放行；
 *   鉴权体系已启用 → 其余一律 401（禁止匿名添加数据）；
 *   体系未启用 → 回落旧逻辑：配置了写令牌则校验，未配置保持开放（principal 标记
 *   anonymous-legacy，只读响应继续带 Warning 头）。
 */
export async function requireMutationAuth(env, db, request, context) {
  const supplied = extractToken(request) || extractUrlOrHeaderToken(context);
  const principal = await resolvePrincipal(env, db, request, supplied);
  if (principal && (principal.type === 'user' || principal.role === 'admin')) {
    return { ok: true, principal };
  }

  const authEnabled = await isAuthEnabled(db);
  if (authEnabled) {
    if (principal?.role === 'report') {
      return {
        ok: false,
        response: jsonResponse(
          { success: false, error: '上报令牌仅限数据上报，不能执行面板写操作：请登录管理员账号或使用写接口令牌' },
          { status: 403, headers: NO_STORE }
        )
      };
    }
    return { ok: false, response: denyMutation(true) };
  }
  // 旧行为回落：写令牌未配置 → 开放；配置了 → 不匹配即 401
  if (!splitTokenList(configuredWriteToken(env)).length) {
    return { ok: true, principal: { type: 'anonymous-legacy' } };
  }
  return { ok: false, response: denyMutation(false) };
}

/**
 * 上报接口鉴权（/api/logger/hit·hits 与 /stats 心跳）：令牌必配（未配置一律拒绝），
 * 会话用户同样可上报。
 */
export async function requireReportAuth(env, db, context) {
  const supplied = extractUrlOrHeaderToken(context) || extractToken(context.request);
  const principal = await resolvePrincipal(env, db, context.request, supplied);
  if (principal?.type === 'user') return { ok: true, principal };
  const denied = requireHitToken(env, supplied);
  if (denied) return { ok: false, response: denied };
  return { ok: true, principal: { type: 'token', role: 'report', via: 'hit-token' } };
}

/**
 * 管理接口鉴权（/api/users /api/groups /api/auth 管理面）：
 * 管理员会话或管理令牌；鉴权体系未启用时引导先执行管理员引导（bootstrap）。
 */
export async function requireAdminAuth(env, db, request, context) {
  const supplied = extractToken(request) || extractUrlOrHeaderToken(context);
  const principal = await resolvePrincipal(env, db, request, supplied);
  if (isPrincipalAdmin(principal)) return { ok: true, principal };
  const authEnabled = await isAuthEnabled(db);
  return {
    ok: false,
    response: jsonResponse(
      {
        success: false,
        error: authEnabled
          ? '需要管理员身份：请用管理员账号登录后再操作'
          : '鉴权体系尚未初始化：请先调用 POST /api/auth/bootstrap 创建管理员'
      },
      { status: authEnabled ? 403 : 409, headers: NO_STORE }
    )
  };
}

/** 只读响应的 Warning 头补充：鉴权体系启用后匿名只读不再是「未鉴权」状态 */
export function readOnlyWarningHeaders(env, authEnabled) {
  return authEnabled ? {} : warningHeadersIfOpen(env);
}
