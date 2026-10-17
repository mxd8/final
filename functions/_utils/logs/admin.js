/**
 * 管理类写操作：删除单条、清空、清空空备注、降维排除。
 */

import { hostInCidr, parseIpTarget } from '../ipnet.js';
import { inferHostType } from '../surge-rule/index.js';
import { normalizeRulePolicy, normalizeSource } from './normalize.js';
import { LOGS_TABLE, nowIso, safeCount } from './schema.js';

/** 按主机名删除单条记录，返回删除条数 */
export async function deleteLog(db, hostname) {
  const target = String(hostname || '').trim();
  if (!target) return 0;
  const results = await db.batch([
    { sql: `DELETE FROM ${LOGS_TABLE} WHERE hostname = ?`, params: [target] }
  ]);
  return results[0].changes;
}

/** 清空全部记录并重置自增序列，高危不可逆 */
export async function clearAllLogs(db) {
  const results = await db.batch([
    { sql: `DELETE FROM ${LOGS_TABLE}` },
    { sql: `DELETE FROM sqlite_sequence WHERE name = ?`, params: [LOGS_TABLE] }
  ]);
  return results[0].changes;
}

/** 只删除备注为空的记录，保留已标注的 */
export async function clearEmptyCommentLogs(db) {
  const results = await db.batch([
    { sql: `DELETE FROM ${LOGS_TABLE} WHERE comment IS NULL OR TRIM(comment) = ''` }
  ]);
  return results[0].changes;
}

/**
 * 旧版降维接口用的三段式 IPv4 前缀（192.0.2 → 192.0.2.0/24）。
 * 段必须都在 0-255 内才算数，其余输入返回 null 走域名分支。
 */
function legacyV4PrefixCidr(key) {
  const parts = key.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return `${key}.0/24`;
}

/** 把受害 hostname 列表拆成 IN (...) 删除语句，每条最多 100 个占位符 */
function buildVictimDeletes(victims) {
  const statements = [];
  for (let start = 0; start < victims.length; start += 100) {
    const chunk = victims.slice(start, start + 100);
    statements.push({
      sql: `DELETE FROM ${LOGS_TABLE} WHERE hostname IN (${chunk.map(() => '?').join(', ')})`,
      params: chunk
    });
  }
  return statements;
}

/** 受害行的「共 X 次触发」：命中的每条记录 count 至少按 1 计，汇总成新规则的 count */
function sumVictimHits(rows) {
  return rows.reduce((total, row) => total + safeCount(row.count), 0);
}

/** 汇总行的 source 不能丢：优先沿用调用方显式传入且确实出现在受害行里的来源，
  * 否则取受害行里出现最多的非空来源；全为空才回落到调用方兜底值。
  */
function pickSummarySource(rows, fallbackSource) {
  const fallback = normalizeSource(fallbackSource);
  const seen = new Map();
  for (const row of rows) {
    const source = normalizeSource(row.source);
    if (!source) continue;
    seen.set(source, (seen.get(source) || 0) + 1);
  }
  if (!seen.size) return fallback;
  if (fallback && seen.has(fallback)) return fallback;
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source]) => source)[0];
}

/**
 * 域名分支的降维：汇总插入与删除放同一个批量事务，一次往返、要么全成要么全回滚。
 * 汇总行的 count / source 用标量子查询在事务内对「即将被删除的同一批行」求值，
 * 与删除条件严格一致，并发命中不再可能把已统计的行复活或漏算。
 * 汇总行主机名满足删除条件，删除语句用 hostname <> ? 把它排除，避免刚插入就被删掉。
 */
async function reduceDomainExclude(db, { insertTarget, type, value, policy, where, whereParams, fallbackSource }) {
  const cond = `(${where.sql})`;
  const sourceFallback = normalizeSource(fallbackSource);
  const insertStatement = {
    sql: `INSERT INTO ${LOGS_TABLE} (hostname, type, value, policy, params, comment, source, first_time, time, count)
          VALUES (
            ?, ?, ?, ?, '', '',
            COALESCE(
              CASE WHEN ? <> '' AND EXISTS (
                SELECT 1 FROM ${LOGS_TABLE} WHERE ${cond} AND source = ?
              ) THEN ? ELSE NULL END,
              (SELECT source FROM ${LOGS_TABLE} WHERE ${cond} AND source <> ''
               GROUP BY source ORDER BY COUNT(*) DESC, source ASC LIMIT 1),
              ?
            ),
            ?, ?,
            MAX((SELECT COALESCE(SUM(MAX(count, 1)), 0) FROM ${LOGS_TABLE} WHERE ${cond}), 1)
          )
          ON CONFLICT(hostname) DO UPDATE SET
            type = excluded.type, value = excluded.value, policy = excluded.policy,
            params = excluded.params, comment = excluded.comment, source = excluded.source,
            first_time = excluded.first_time, time = excluded.time, count = excluded.count`,
    params: [
      insertTarget, type, value, policy,
      // source：兜底来源命中检查（兜底值、条件、兜底值）→ 最常见非空来源（条件）→ 兜底值
      sourceFallback, ...whereParams, sourceFallback, sourceFallback,
      ...whereParams, sourceFallback,
      nowIso(),
      nowIso(),
      ...whereParams
    ]
  };
  const deleteStatement = {
    sql: `DELETE FROM ${LOGS_TABLE} WHERE ${cond} AND hostname <> ?`,
    params: [...whereParams, insertTarget]
  };

  const results = await db.batch([insertStatement, deleteStatement]);
  return {
    deleted: results[1].changes,
    created: results[0].changes > 0
  };
}

/**
 * 降维排除：删掉目标覆盖到的所有记录，换一条汇总记录。
 * - 域名目标：等于或 .后缀 结尾的记录（与 DOMAIN-SUFFIX 语义一致），单事务提交；
 * - IP / CIDR 目标：LIKE 写不出网段包含关系（还会把 61.139.8 误算到 61.139.80.x），
 *   全表取 hostname 在内存里按网段包含筛选后按 IN 分块删；受害行不多的常见场景
 *   同样压进单批事务，只有超过单批容量才分块（汇总插入挂在最后一块收尾）；
 * - 含冒号但不是合法 IPv6：退回旧版字符串前缀匹配兜底。
 * 汇总行的 source 从受害行里继承（调用方显式传入且存在于受害行时优先），
 * count 写入受害行「共 X 次触发」的真实总和，既保来源又保命中次数。
 */
export async function reduceExclude(db, targetKey, { policy = 'PROXY', source = '' } = {}) {
  const key = String(targetKey || '').trim();
  const validPolicy = normalizeRulePolicy(policy);
  if (!key) return { deleted: 0, created: false };

  const parsed = parseIpTarget(key);
  const legacyCidr = parsed ? null : legacyV4PrefixCidr(key);
  const targetIp = parsed || (legacyCidr ? parseIpTarget(legacyCidr) : null);
  // 汇总行主机名保留用户原文本（203.0.113.77/16 不改写成 203.0.0.0/16）：
  // 匹配按 / 前缀掩码归一化后进行，主机位写不写零覆盖范围一样，但保留原 IP 才认得出规则的用途；
  // 只有裸 IP（无 / 前缀）与旧版三段式仍规范化成 a.b.c.d/n
  const insertTarget = targetIp
    ? (parsed && key.includes('/') ? key : targetIp.cidr)
    : key;
  const type = inferHostType(insertTarget);
  const value = insertTarget;

  if (!targetIp) {
    const where = key.includes(':')
      ? { sql: `hostname LIKE ?`, params: [`${key}%`] }
      : { sql: `hostname = ? OR hostname LIKE ?`, params: [key, `%.${key}`] };
    return reduceDomainExclude(db, {
      insertTarget, type, value, policy: validPolicy, where, whereParams: where.params, fallbackSource: source
    });
  }

  // IP 分支：受害行必须先读出（网段包含判断只能内存算），再按 IN 列表删除
  const rows = await db.execute(`SELECT hostname, count, source FROM ${LOGS_TABLE}`);
  const victimRows = rows
    .map((row) => ({
      hostname: String(row.hostname ?? '').trim(),
      count: safeCount(row.count),
      source: row.source
    }))
    .filter((row) => row.hostname && hostInCidr(row.hostname, targetIp));

  const summaryHits = sumVictimHits(victimRows);
  const summarySource = pickSummarySource(victimRows, source);
  const insertStatement = {
    sql: `INSERT INTO ${LOGS_TABLE} (hostname, type, value, policy, params, comment, source, first_time, time, count)
          VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?)
          ON CONFLICT(hostname) DO UPDATE SET policy = excluded.policy`,
    params: [
      insertTarget,
      type,
      value,
      validPolicy,
      summarySource,
      nowIso(),
      nowIso(),
      safeCount(summaryHits)
    ]
  };

  // 删除与插入同批提交（一个事务，失败自动回滚）；受害行超过适配器单批量容量时
  // 按块拆分，插入语句挂在最后一块保证收尾完整
  const DELETE_CHUNK = Math.max(1, Math.min(200, (db.maxBatchSize || 200) - 1));
  const deleteStatements = buildVictimDeletes(victimRows.map((row) => row.hostname));
  const chunks = [];
  for (let start = 0; start < deleteStatements.length; start += DELETE_CHUNK) {
    chunks.push(deleteStatements.slice(start, start + DELETE_CHUNK));
  }
  if (!chunks.length) chunks.push([]);

  let deleted = 0;
  let created = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    const batch = isLast ? [...chunks[i], insertStatement] : chunks[i];
    const results = await db.batch(batch);
    results.forEach((result, index) => {
      if (isLast && index === batch.length - 1) {
        if (result.changes > 0) created = true;
      } else {
        deleted += result.changes;
      }
    });
  }

  return { deleted, created };
}
