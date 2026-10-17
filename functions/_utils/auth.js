/**
 * 写接口与上报接口的令牌鉴权。
 * 面板写接口走 Authorization 头；/api/logger/hit 由 Surge 调用、无法设自定义头，
 * 额外接受 URL 查询参数。环境变量支持逗号分隔多令牌以便轮换。
 * 写接口令牌未配置时保持开放（兼容已上线部署），只读响应附带 Warning 头；
 * 上报接口必须配置 PANEL_HIT_TOKEN（未配置一律拒绝），令牌不匹配同样拒绝。
 * 两个令牌变量对上报接口一视同仁：任一变量里的任一令牌匹配即放行。
 */

import { jsonResponse } from './http.js';

export const WRITE_TOKEN_VAR = 'PANEL_WRITE_TOKEN';

export const HIT_TOKEN_VAR = 'PANEL_HIT_TOKEN';

const HEADER_AUTHORIZATION = 'authorization';
const HEADER_PANEL_TOKEN = 'x-panel-token';

const BEARER_PREFIX = 'Bearer ';

/** HTTP 头只能放 latin1，警告用 ASCII 短码，具体文案由 /meta 的 writeAuthRequired 表达 */
export const NO_TOKEN_WARNING = '299 warn-1 "write-auth-not-configured"';

export function configuredWriteToken(env) {
  return String(env[WRITE_TOKEN_VAR] ?? '').trim();
}

export function configuredHitToken(env) {
  return String(env[HIT_TOKEN_VAR] ?? '').trim();
}

/** 逗号切分成令牌数组：过滤空段，避免「连续逗号」产生可被空串匹配的缺口 */
function splitTokenList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 两个令牌变量的全部合法令牌（去空段），任一已配置即视为启用 */
export function anyConfiguredToken(env) {
  return [...splitTokenList(configuredWriteToken(env)), ...splitTokenList(configuredHitToken(env))];
}

/**
 * 逐字符累计差异的等长比较：长度不同也走同样的比较路径，
 * 抹平「提前返回」带来的时序差异（JS 无法做到严格恒定时间，这里是实用近似）。
 */
function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAnyTokenMatch(configuredTokens, supplied) {
  const value = String(supplied ?? '');
  return configuredTokens.some((token) => timingSafeEqual(token, value));
}

/** 从请求头取令牌：Authorization Bearer、明文 Authorization 或 X-Panel-Token */
export function extractToken(request) {
  const authorization = request.headers.get(HEADER_AUTHORIZATION);
  if (authorization) {
    if (authorization.startsWith(BEARER_PREFIX)) {
      return authorization.slice(BEARER_PREFIX.length).trim();
    }
    return authorization.trim();
  }
  return (request.headers.get(HEADER_PANEL_TOKEN) || '').trim();
}

/** 从 URL 查询参数或请求头取令牌，供 /hit 这类无法设置请求头的调用方使用 */
export function extractUrlOrHeaderToken(context) {
  const fromQuery = new URL(context.request.url).searchParams.get('token');
  return (fromQuery && fromQuery.trim()) || extractToken(context.request);
}

/** 写接口鉴权：放行返回 null，拒绝返回 401 响应 */
export function requireWriteToken(env, request) {
  const configured = splitTokenList(configuredWriteToken(env));
  if (!configured.length) return null;

  const supplied = extractToken(request);
  if (!isAnyTokenMatch(configured, supplied)) {
    console.warn(`[${WRITE_TOKEN_VAR}] 写接口鉴权失败：${request.method} ${request.url}`);
    return jsonResponse(
      { success: false, error: '未通过写操作鉴权：请在面板「写接口令牌」中填写正确令牌' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return null;
}

/** 上报接口鉴权：必须配置 PANEL_HIT_TOKEN（写令牌也可匹配），未配置一律拒绝 */
export function requireHitToken(env, supplied) {
  const tokens = anyConfiguredToken(env);
  if (!tokens.length) {
    console.warn('[auth] 上报接口未配置令牌（PANEL_HIT_TOKEN），已拒绝');
    return jsonResponse(
      { success: false, error: '上报接口未配置令牌：请在 Cloudflare 环境变量里配置 PANEL_HIT_TOKEN' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const value = supplied == null ? '' : String(supplied).trim();
  if (!isAnyTokenMatch(tokens, value)) {
    console.warn('[auth] 上报接口鉴权失败');
    return jsonResponse(
      { success: false, error: '上报接口鉴权失败：令牌不匹配' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return null;
}

/** 只读响应追加「写接口未鉴权」警告头，前端据此显示提示横幅 */
export function warningHeadersIfOpen(env) {
  return anyConfiguredToken(env).length ? {} : { Warning: NO_TOKEN_WARNING };
}
