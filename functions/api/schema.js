/**
 * 数据库初始化接口：/api/schema
 * 汇总返回全部表的建表语句，首次部署粘到数据库控制台执行即可。
 *
 *   GET /api/schema                全部表（含索引）
 *   GET /api/schema/table/<key>    单张表：rules / logger / prefs / subscriptions / health / heartbeats / meta
 */

import { jsonResponse, textResponse, notFound } from '../_utils/http.js';
import { LOGS_SCHEMA } from '../_utils/logs/index.js';
import { PREFS_SCHEMA } from '../_utils/prefs.js';
import { SUBSCRIPTIONS_SCHEMA } from '../_utils/subscriptions.js';
import { HEALTH_PROBE_SCHEMA, HEARTBEATS_SCHEMA, DB_META_SCHEMA } from '../_utils/db/ddl.js';

/** 订阅规则表建表语句（旧版表，保留为兼容部署） */
const RULES_SCHEMA = `CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  remark TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_domain ON rules(domain);`.trim();

/** key 即 /api/schema/table/<key> 的路径参数 */
const TABLES = {
  rules: RULES_SCHEMA,
  logger: LOGS_SCHEMA,
  prefs: PREFS_SCHEMA,
  subscriptions: SUBSCRIPTIONS_SCHEMA,
  health: HEALTH_PROBE_SCHEMA,
  heartbeats: HEARTBEATS_SCHEMA,
  meta: DB_META_SCHEMA
};

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  const method = context.request.method;

  if (method === 'GET' && path === '/api/schema') {
    return textResponse(
      [RULES_SCHEMA, LOGS_SCHEMA, PREFS_SCHEMA, SUBSCRIPTIONS_SCHEMA, HEALTH_PROBE_SCHEMA, HEARTBEATS_SCHEMA, DB_META_SCHEMA].join('\n\n') +
        '\n\n-- 全部语句均为 IF NOT EXISTS，可重复执行，不会破坏已有数据'
    );
  }

  const match = path.match(/^\/api\/schema\/table\/([\w-]+)$/);
  if (method === 'GET' && match) {
    const schema = TABLES[match[1]];
    if (!schema) return notFound(`未知的表：${match[1]}（可选 rules / logger / prefs / subscriptions / health / heartbeats / meta）`);
    return textResponse(schema);
  }

  if (method === 'GET') return notFound(`未知的接口：${path}`);
  return jsonResponse({ success: false, error: `不支持的方法：${method}` }, { status: 405 });
}
