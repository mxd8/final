/**
 * 统一响应、请求体解析与错误出口，供全部 API 路由共用。
 */

/** 转义 SQL LIKE 通配符（% _ \），必须与 SQL 里的 ESCAPE '\' 配套使用 */
export function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/** 纯文本响应：Surge 订阅列表与导出文本用 */
export function textResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

/** 解析请求体 JSON；解析失败不抛错，由调用方决定返回 400 */
export async function readJson(context) {
  try {
    const value = await context.request.json();
    return typeof value === 'object' && value !== null ? { ok: true, value } : { ok: false, value: null };
  } catch {
    return { ok: false, value: null };
  }
}

export function badRequest(error) {
  return jsonResponse({ success: false, error }, { status: 400 });
}

export function notFound(error = '规则不存在') {
  return jsonResponse({ success: false, error }, { status: 404 });
}

export function unauthorized(error = '未通过鉴权') {
  return jsonResponse({ success: false, error }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
}

export function methodNotAllowed(method, allow) {
  return jsonResponse(
    { success: false, error: `不支持的方法：${method}` },
    { status: 405, headers: { Allow: allow } }
  );
}

/** 路由内部异常统一出口：ConfigError 归 400，其余归 500 */
export function errorResponse(tag, method, pathname, error) {
  const detail = error?.stack ?? error?.message;
  console.error(`[${tag}] ${method} ${pathname} 处理失败: ${detail}`);
  const status = error?.name === 'ConfigError' ? 400 : 500;
  return jsonResponse({ success: false, error: error?.message }, { status });
}
