/**
 * /api/logger 只读路由实现：列表、统计、导出、摘要、schema、meta。
 */

import { jsonResponse, textResponse } from '../../_utils/http.js';
import { warningHeadersIfOpen, configuredWriteToken, anyConfiguredToken, extractToken, requireHitToken } from '../../_utils/auth.js';
import { clientTzOffset } from '../../_utils/timezone.js';
import { listLogs, getStats, describeExportFilter, summarizeExport, LOGS_SCHEMA } from '../../_utils/logs/index.js';
import { ALL_RULE_TYPES, RULE_PARAMS, FLAG_PARAM_NAMES, KV_PARAM_NAMES, SURGE_POLICIES } from '../../_utils/surge-rule/index.js';
import { buildExport, renderExportText } from './exporter.js';
import { CACHE_OK, readMinCount, readLastDays } from './constants.js';
import { BUILD_LABEL, COMPONENT_VERSIONS } from '../../_utils/build-meta.js';
import { DB_SCHEMA_VERSION } from '../../_utils/db/ddl.js';
import { parseHeartbeatHeaders, recordHeartbeat, listHeartbeats } from '../../_utils/heartbeat.js';

export async function handleList(context, config, url) {
  const logs = await listLogs(config, {
    search: url.searchParams.get('search') || '',
    policy: url.searchParams.get('policy') || 'ALL',
    type: url.searchParams.get('type') || 'ALL',
    limit: url.searchParams.get('limit') || 5000
  });
  return jsonResponse({ success: true, data: logs }, { headers: { ...CACHE_OK, ...warningHeadersIfOpen(context.env) } });
}

/**
 * 面板与前端顶栏共用的统计信息，同时是 Surge 面板脚本的心跳入口：
 *   - 面板脚本在既有 /stats 请求上捎带心跳头（零新增请求），服务端 upsert 进
 *     client_heartbeats 注册表——健康检测的「客户端连通状态」与版本看板共用这份数据；
 *   - 响应捎带 latest（各组件最新版本）与最近心跳清单，网页版本看板零新增请求取数。
 * 心跳失败绝不影响统计返回；带心跳头的请求是个性化响应，禁用共享缓存。
 */
export async function handleStats(context, db, url) {
  let heartbeatNote = '';
  const heartbeat = parseHeartbeatHeaders(context.request);
  if (heartbeat) {
    const hitDenied = requireHitToken(context.env, extractToken(context.request));
    if (hitDenied) {
      heartbeatNote = 'heartbeat-auth-failed';
    } else {
      try {
        await recordHeartbeat(db, heartbeat);
      } catch (error) {
        console.warn('[heartbeat] 心跳记录失败（不影响统计）:', error?.message ?? error);
      }
    }
  }

  const stats = await getStats(db, clientTzOffset(url.searchParams));
  let clients = [];
  if (heartbeat || url.searchParams.get('with-clients') === '1') {
    try {
      clients = await listHeartbeats(db, { limit: 5 });
    } catch {
      clients = [];
    }
  }
  const headers = { ...(heartbeat ? { 'Cache-Control': 'no-store' } : CACHE_OK), ...warningHeadersIfOpen(context.env) };
  return jsonResponse(
    {
      success: true,
      data: {
        ...stats,
        serverVersion: BUILD_LABEL,
        latest: COMPONENT_VERSIONS,
        clients,
        ...(heartbeatNote ? { heartbeat: heartbeatNote } : {})
      }
    },
    { headers }
  );
}

export async function handleExport(context, config, url) {
  const minCount = readMinCount(url.searchParams);
  const lastDays = readLastDays(url.searchParams);
  const source = url.searchParams.get('source') || '';
  const type = url.searchParams.get('type') || 'all';
  const withSource = url.searchParams.get('with-source') === '1';
  const withMeta = url.searchParams.get('meta') === '1';

  const result = await buildExport(config, { type, source, withSource, minCount, lastDays });
  const output = renderExportText(result, {
    withMeta: withMeta && result.lines.length > 0,
    filterText: describeExportFilter({ type, source, minCount, lastDays }).text
  });

  // X-Export-* 语义固定为「规则行数」，不含可选头部注释行
  return textResponse(output, {
    headers: {
      'Cache-Control': 'public, max-age=60',
      'X-Export-Count': String(result.count),
      'X-Export-IPv4': String(result.ipv4),
      'X-Export-IPv6': String(result.ipv6),
      ...warningHeadersIfOpen(context.env)
    }
  });
}

/** 导出摘要：与 /export 共用 buildExport，数字必然一致 */
export async function handleExportSummary(context, config, url) {
  const minCount = readMinCount(url.searchParams);
  const lastDays = readLastDays(url.searchParams);
  const source = url.searchParams.get('source') || '';
  const type = url.searchParams.get('type') || 'all';
  const withSource = url.searchParams.get('with-source') === '1';

  const result = await buildExport(config, { type, source, withSource, minCount, lastDays });
  const summary = summarizeExport(result.matched);
  return jsonResponse(
    { success: true, data: { ...summary, filter: describeExportFilter({ type, source, minCount, lastDays }) } },
    { headers: { ...CACHE_OK, ...warningHeadersIfOpen(context.env) } }
  );
}

export async function handleSchema() {
  return textResponse(LOGS_SCHEMA);
}

/**
 * 规则类型 / 参数 / 策略常量：前端下拉框与参数选择器共用。
 * 同时是版本握手的唯一出口：追加 version 清单（serverVersion / components /
 * dbSchemaVersion），作为三类客户端版本比对的唯一基准——响应 no-store，
 * 版本比对基准绝不能被边缘缓存。字段只增不删，旧客户端忽略未知字段不受影响。
 */
export async function handleMeta(context) {
  return jsonResponse(
    {
      success: true,
      data: {
        ruleTypes: ALL_RULE_TYPES,
        params: RULE_PARAMS,
        flagParams: FLAG_PARAM_NAMES,
        kvParams: KV_PARAM_NAMES,
        policies: SURGE_POLICIES,
        writeAuthRequired: Boolean(configuredWriteToken(context.env)),
        hitAuthRequired: Boolean(anyConfiguredToken(context.env)),
        version: {
          serverVersion: BUILD_LABEL,
          components: COMPONENT_VERSIONS,
          dbSchemaVersion: DB_SCHEMA_VERSION
        }
      }
    },
    { headers: { 'Cache-Control': 'no-store', ...warningHeadersIfOpen(context.env) } }
  );
}
