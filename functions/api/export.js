/**
 * 固定订阅导出：/api/export?policy=all|proxy|direct|reject
 *
 *   GET /api/export            等价 policy=all
 *   GET /api/export?policy=proxy
 *
 * 与 /api/logger/export 的区别：筛选条件（来源 / 带来源注释 / 命中下限）
 * 不编进 URL，而是读偏好表 user=export 下的全局导出配置——面板「筛选配置」
 * 改完立即生效，Surge 客户端始终用同一条订阅地址，无需重新配置。
 * 显式查询参数仍然可用并优先于偏好（兼容旧链接与临时调试）。
 */

import { textResponse, methodNotAllowed, errorResponse } from '../_utils/http.js';
import { warningHeadersIfOpen } from '../_utils/auth.js';
import { resolveAdapter } from '../_utils/db/factory.js';
import { describeExportFilter } from '../_utils/logs/index.js';
import { listPrefs } from '../_utils/prefs.js';
import { buildExport, renderExportText } from './_logger/exporter.js';
import { readMinCount, readLastDays } from './_logger/constants.js';

const TAG = 'api/export';

/** policy 快捷名 → 内部导出类型；未知值回落 all，订阅端永远拿得到规则文本 */
const POLICIES = new Map([
  ['all', 'ALL'],
  ['proxy', 'PROXY'],
  ['direct', 'DIRECT'],
  ['reject', 'REJECT']
]);

/** 偏好表里的全局导出配置 → 导出参数；URL 显式参数优先于偏好 */
async function resolveFilters(config, params) {
  const prefs = await listPrefs(config, 'export');
  return {
    source: params.has('source') ? params.get('source') : prefs['export.source'] || '',
    withSource: params.has('with-source')
      ? params.get('with-source') === '1'
      : prefs['export.with_source'] === '1',
    minCount: params.has('min-count') ? readMinCount(params) : readMinCount(new URLSearchParams({ 'min-count': prefs['export.min_count'] ?? '' })),
    lastDays: params.has('last-days')
      ? readLastDays(params)
      : readLastDays(new URLSearchParams({ 'last-days': prefs['export.last_days'] ?? '' }))
  };
}

export async function onRequest(context) {
  const { adapter: config, response } = await resolveAdapter(context.env);
  if (response) return response;

  const url = new URL(context.request.url);
  const method = context.request.method;
  try {
    await config.ready;
    if (method !== 'GET') return methodNotAllowed(method, 'GET');

    const requested = (url.searchParams.get('policy') || 'all').toLowerCase();
    const type = POLICIES.get(requested) ? requested : 'all';
    const filters = await resolveFilters(config, url.searchParams);
    const result = await buildExport(config, { type, ...filters });
    const output = renderExportText(result, {
      withMeta: url.searchParams.get('meta') !== '0' && result.lines.length > 0,
      filterText: describeExportFilter({ type, source: filters.source, minCount: filters.minCount, lastDays: filters.lastDays }).text
    });

    // X-Export-* 语义与 /api/logger/export 一致：只统计规则行数，不含头部注释
    return textResponse(output, {
      headers: {
        'Cache-Control': 'public, max-age=30',
        'X-Export-Count': String(result.count),
        'X-Export-IPv4': String(result.ipv4),
        'X-Export-IPv6': String(result.ipv6),
        ...warningHeadersIfOpen(context.env)
      }
    });
  } catch (error) {
    return errorResponse(TAG, method, url.pathname, error);
  }
}
