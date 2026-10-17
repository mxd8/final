/**
 * 订阅抓取与解析 API：/api/subscribe
 *
 *   GET  /api/subscribe          列出已保存订阅（只读，可匿名）
 *   GET  /api/subscribe/schema   建表语句
 *   POST /api/subscribe/parse    {url} → 服务端抓取并提取规则行，不落库
 *   POST /api/subscribe/save     {name,url[,ruleCount,lastStatus]} → 保存地址与名称
 *   POST /api/subscribe/delete   {id} → 删除一条
 *
 * 抓取必须由服务端代发（订阅源大多不带 CORS 头）；目标地址经 guard.js 白名单式过滤。
 * 写操作在配置了 PANEL_WRITE_TOKEN 时要求令牌。
 */

import { jsonResponse, notFound, methodNotAllowed, errorResponse } from '../_utils/http.js';
import { resolveAdapter } from '../_utils/db/factory.js';
import { requireWriteToken } from '../_utils/auth.js';
import { readJson, badRequest } from '../_utils/http.js';
import { handleSchema, handleList, handleParse, handleSave, handleDelete } from './_subscribe/routes.js';
import { TAG, READ_PATHS, WRITE_PATHS, normalizePath } from './_subscribe/constants.js';

/** 写接口统一令牌校验 + 请求体解析，再分发到具体操作 */
async function dispatchWrite(context, config, path) {
  const denied = requireWriteToken(context.env, context.request);
  if (denied) return denied;

  const body = await readJson(context);
  if (!body.ok) return badRequest('请求体不是有效的 JSON');
  const payload = body.value || {};

  if (path === '/api/subscribe/parse') return handleParse(config, payload);
  if (path === '/api/subscribe/save') return handleSave(config, payload);
  return handleDelete(config, payload);
}

export async function onRequest(context) {
  const { adapter: config, response: configError } = await resolveAdapter(context.env);
  if (configError) return configError;
  await config.ready;

  const url = new URL(context.request.url);
  const path = normalizePath(url.pathname);
  const method = context.request.method;

  try {
    if (method === 'GET' && path === '/api/subscribe/schema') return handleSchema();
    if (method === 'GET' && path === '/api/subscribe') return handleList(context, config);
    if (method === 'POST' && WRITE_PATHS.has(path)) return dispatchWrite(context, config, path);

    if (method === 'GET' && WRITE_PATHS.has(path)) return methodNotAllowed(method, 'POST');
    if (method === 'POST' && READ_PATHS.has(path)) return methodNotAllowed(method, 'GET');
    if (method === 'GET' || method === 'POST') return notFound(`未知的接口：${path}`);
    return methodNotAllowed(method, 'GET, POST');
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}
