/**
 * AI 调度的候选规则筛选：识别「未分流」与「无注释」的规则，组成优先级队列。
 *
 * - 未分流：policy 仍是捕获默认值 PROXY（命中入库时的初始策略）；
 * - 无注释：comment 为空串 —— AI 对其做针对性内容推断（补分流 + 补注释）；
 * - ✏️ 快速编辑过的规则（manual_edited = 1）排到队列最前，优先获得处理；
 * - 已处理过的规则（ai_processed = 1）不再进入队列，防止自动化无限重跑。
 */

import { LOGS_TABLE, LOG_COLUMNS } from '../../_utils/logs/schema.js';

/** FINAL 是全局唯一的兜底规则，策略由用户掌控，AI 不参与 */
const EXCLUDE_FINAL = `type != 'FINAL'`;

/** 按配置拼装候选筛选条件；两个筛选开关都关闭时返回 null（没有可处理的目标） */
function buildWhere(config) {
  const targets = [];
  if (config.onlyUnclassified) targets.push(`policy = 'PROXY'`);
  if (config.fillComment) targets.push(`(comment IS NULL OR TRIM(comment) = '')`);
  if (!targets.length) return null;
  return `ai_processed = 0 AND ${EXCLUDE_FINAL} AND (${targets.join(' OR ')})`;
}

/**
 * 取下一批候选规则。
 * @returns {Promise<{items: Array, remaining: number}>}
 */
export async function selectCandidates(db, config, limit) {
  const where = buildWhere(config);
  if (!where) return { items: [], remaining: 0 };

  const order = config.priorityEdited ? 'manual_edited DESC, count DESC, time DESC' : 'count DESC, time DESC';
  const rows = await db.execute(
    `SELECT ${LOG_COLUMNS} FROM ${LOGS_TABLE} WHERE ${where} ORDER BY ${order} LIMIT ?`,
    [Math.max(1, limit)]
  );
  const [{ v: total }] = await db.execute(`SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE ${where}`);
  return { items: rows, remaining: Math.max(0, Number(total) || 0) };
}

/** 队列统计：待处理总数、其中 ✏️ 优先数、已处理总数 */
export async function queueStats(db, config) {
  const where = buildWhere(config);
  const statements = [
    {
      sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE ${where ?? '0 = 1'}`,
      params: []
    },
    {
      sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE ${where ?? '0 = 1'} AND manual_edited = 1`,
      params: []
    },
    {
      sql: `SELECT COUNT(*) AS v FROM ${LOGS_TABLE} WHERE ai_processed = 1`,
      params: []
    }
  ];
  const results = await db.batch(statements);
  return {
    pending: Number(results[0].rows[0]?.v) || 0,
    pendingEdited: Number(results[1].rows[0]?.v) || 0,
    processed: Number(results[2].rows[0]?.v) || 0
  };
}

/** 重置 AI 处理标记：允许全部规则重新参与调度（手动操作，配合筛选开关使用） */
export async function resetProcessed(db) {
  const results = await db.batch([
    { sql: `UPDATE ${LOGS_TABLE} SET ai_processed = 0 WHERE ai_processed = 1`, params: [] }
  ]);
  return { reset: results[0].changes };
}
