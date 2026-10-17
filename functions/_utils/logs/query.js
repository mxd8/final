/**
 * surge_logs 查询层：列表检索、全量导出读取、统计聚合，全部在数据库侧完成。
 */

import { likeEscape } from '../http.js';
import { RULE_TYPES } from '../surge-rule/index.js';
import { startOfClientDay } from '../timezone.js';
import { LOGS_TABLE, LOG_COLUMNS } from './schema.js';
import { normalizeLogRow, normalizeRulePolicy, normalizeSource } from './normalize.js';

/** search 命中匹配值 / 策略 / 来源 / 注释，LIKE 通配符必须转义 */
function pushSearch(conditions, params, search) {
  const like = `%${likeEscape(search)}%`;
  conditions.push(
    `(hostname LIKE ? ESCAPE '\\'
       OR COALESCE(value, '') LIKE ? ESCAPE '\\'
       OR policy LIKE ? ESCAPE '\\'
       OR COALESCE(source, '') LIKE ? ESCAPE '\\'
       OR COALESCE(comment, '') LIKE ? ESCAPE '\\')`
  );
  params.push(like, like, like, like, like);
}

/** minCount <= 1 不加条件：语义上等于全表，且避免查询计划变差 */
function pushMinCount(conditions, params, minCount) {
  const value = Math.floor(Number(minCount) || 0);
  if (value > 1) {
    conditions.push('count >= ?');
    params.push(value);
  }
}

function normalizePolicyText(policy) {
  return String(policy || 'ALL').trim().toUpperCase() === 'ALL' ? 'ALL' : normalizeRulePolicy(policy);
}

/** 截断 limit 到安全区间 */
function clampLimit(value) {
  return Math.max(1, Math.min(Number(value) || 5000, 50000));
}

/** 读取记录：search / policy / type / minCount 过滤 + limit，按最近命中倒序 */
export async function listLogs(db, { search = '', policy = 'ALL', type = 'ALL', minCount = 0, limit = 5000 } = {}) {
  const conditions = [];
  const params = [];

  if (search) pushSearch(conditions, params, search);
  const policyText = normalizePolicyText(policy);
  if (policyText !== 'ALL') {
    conditions.push('policy = ?');
    params.push(policyText);
  }
  const typeText = String(type || 'ALL').trim().toUpperCase();
  if (typeText !== 'ALL' && RULE_TYPES.has(typeText)) {
    conditions.push('type = ?');
    params.push(typeText);
  }
  pushMinCount(conditions, params, minCount);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.execute(
    `SELECT ${LOG_COLUMNS} FROM ${LOGS_TABLE} ${where} ORDER BY time DESC, id DESC LIMIT ?`,
    [...params, clampLimit(limit)]
  );
  return rows.map(normalizeLogRow);
}

/**
 * 全量读取（导出用）：全部过滤都在 SQL 侧完成——订阅直链不经过面板，
 * 表到几万行时也不能把整表拉进内存再筛。
 * policy / source 是精确等值比较（不做归一化，语义由调用方决定；
 * 写入侧已归一化，与旧版「读出后内存比对归一化值」对正常数据等价），
 * 时间窗用 ISO 字符串比较（等价于时间比较）。
 */
export async function getAllLogs(db, { minCount = 0, policy = 'ALL', source = '', cutoffIso = '' } = {}) {
  const conditions = [];
  const params = [];
  pushMinCount(conditions, params, minCount);
  const policyKey = String(policy ?? 'ALL').trim().toUpperCase();
  if (policyKey && policyKey !== 'ALL') {
    conditions.push('policy = ?');
    params.push(policyKey);
  }
  const sourceKey = normalizeSource(source);
  if (sourceKey) {
    conditions.push('source = ?');
    params.push(sourceKey);
  }
  if (cutoffIso) {
    conditions.push('time >= ?');
    params.push(cutoffIso);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.execute(
    `SELECT ${LOG_COLUMNS} FROM ${LOGS_TABLE} ${where} ORDER BY time DESC, id DESC`,
    params
  );
  return rows.map(normalizeLogRow);
}

/** 一次批量查询算完全部统计；今日新增用 time >= 本地零点的 range 条件走索引 */
function buildStatsStatements(tzOffsetMinutes) {
  return [
    { sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT COALESCE(SUM(count), 0) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT COALESCE(SUM(CASE WHEN policy = 'PROXY' THEN 1 ELSE 0 END), 0) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT COALESCE(SUM(CASE WHEN policy = 'DIRECT' THEN 1 ELSE 0 END), 0) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT COALESCE(SUM(CASE WHEN policy = 'REJECT' THEN 1 ELSE 0 END), 0) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE comment IS NULL OR TRIM(comment) = ''` },
    { sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE time >= ?`, params: [startOfClientDay(tzOffsetMinutes)] },
    { sql: `SELECT COALESCE(NULLIF(TRIM(source), ''), '未标注') AS v, COUNT(*) AS c FROM ${LOGS_TABLE} GROUP BY 1 ORDER BY c DESC` },
    { sql: `SELECT COALESCE(NULLIF(type, ''), 'DOMAIN-SUFFIX') AS v, COUNT(*) AS c FROM ${LOGS_TABLE} GROUP BY 1 ORDER BY c DESC` },
    { sql: `SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(source), ''), '未标注')) AS v FROM ${LOGS_TABLE}` },
    { sql: `SELECT policy AS v, COUNT(*) AS c FROM ${LOGS_TABLE} GROUP BY 1 ORDER BY c DESC` }
  ];
}

function pick(statement) {
  return Number(statement?.rows?.[0]?.v) || 0;
}

function grouped(statement) {
  return (statement?.rows ?? []).map((row) => ({ name: String(row.v), count: Number(row.c) || 0 }));
}

/** 面板与前端顶栏共用的统计信息 */
export async function getStats(db, tzOffsetMinutes = 0) {
  const [total, hits, proxy, direct, reject, emptyComment, todayNew, sources, types, sourceCount, policies] =
    await db.batch(buildStatsStatements(tzOffsetMinutes));

  return {
    totalRules: pick(total),
    totalHits: pick(hits),
    proxyCount: pick(proxy),
    directCount: pick(direct),
    rejectCount: pick(reject),
    emptyCommentCount: pick(emptyComment),
    todayNew: pick(todayNew),
    sourceCount: pick(sourceCount),
    sources: grouped(sources).slice(0, 20),
    types: grouped(types).slice(0, 20),
    // 全量来源名（来源数远小于 20 上限的场景几乎不存在，但下拉框需要完整列表）
    sourceNames: grouped(sources)
      .map((item) => item.name)
      .filter((name) => name && name !== '未标注'),
    // 全部出现过的策略名：编辑弹窗的策略候选与策略筛选共用，前端不必再拉全量列表
    policies: grouped(policies).map((item) => item.name).filter(Boolean)
  };
}
