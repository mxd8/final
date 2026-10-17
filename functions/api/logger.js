/**
 * 捕获记录 API：/api/logger
 *
 *   GET  /api/logger[/stats|/export|/export-summary|/schema|/meta]   只读
 *   POST /api/logger/hit                                             Surge 上报（上报令牌）
 *   POST /api/logger/hits                                            Surge 批量上报（上报令牌）
 *   POST /api/logger[/update|/delete|/exclude|/batch|/clear|/clear-empty]  写操作（写令牌）
 *
 * 分发逻辑只保留路径 → 处理函数的映射，实现在 api/_logger/ 下。
 * 本文件同时被 logger/[[rest]].js 复用，命中 /api/logger 全部子路径。
 */

import { methodNotAllowed, notFound, errorResponse } from '../_utils/http.js';
import { resolveAdapter } from '../_utils/db/factory.js';
import { handleList, handleStats, handleExport, handleExportSummary, handleSchema, handleMeta } from './_logger/reads.js';
import { handleHit, handleHitBatch, handleWrite } from './_logger/writes.js';
import { READ_PATHS, WRITE_PATHS, normalizePath } from './_logger/constants.js';

const TAG = 'api/logger';

function dispatchGet(context, config, url, path) {
  if (path === '/api/logger') return handleList(context, config, url);
  if (path === '/api/logger/stats') return handleStats(context, config, url);
  if (path === '/api/logger/export') return handleExport(context, config, url);
  if (path === '/api/logger/export-summary') return handleExportSummary(context, config, url);
  if (path === '/api/logger/schema') return handleSchema();
  if (path === '/api/logger/meta') return handleMeta(context);
  if (WRITE_PATHS.has(path)) return methodNotAllowed('GET', 'POST');
  return notFound(`未知的接口：${path}`);
}

function dispatchPost(context, config, url, path) {
  if (path === '/api/logger/hit') return handleHit(context, config);
  if (path === '/api/logger/hits') return handleHitBatch(context, config);
  if (WRITE_PATHS.has(path)) return handleWrite(context, config, path);
  if (READ_PATHS.has(path)) return methodNotAllowed('POST', 'GET');
  return notFound(`未知的接口：${path}`);
}

export async function onRequest(context) {
  const { adapter: config, response } = await resolveAdapter(context.env);
  if (response) return response;

  const url = new URL(context.request.url);
  const path = normalizePath(url.pathname);
  const method = context.request.method;

  try {
    // 幂等 schema 迁移在第一次访问前完成，isolate 内只跑一次（factory.ready 缓存）
    await config.ready;

    if (method === 'GET') return await dispatchGet(context, config, url, path);
    if (method === 'POST') return await dispatchPost(context, config, url, path);
    return methodNotAllowed(method, 'GET, POST');
  } catch (error) {
    return errorResponse(TAG, method, path, error);
  }
}
