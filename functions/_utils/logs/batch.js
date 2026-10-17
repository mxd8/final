/**
 * 批量逐行覆盖：每行是一条 Surge 规则文本或结构化对象，有则更新、无则新增。
 * merge 模式（Gist 还原）备注与来源非空才覆盖；override 模式（面板显式覆盖）一律写入。
 * 按批量事务上限分块顺序提交，结果聚合成一次返回。
 */

import { parseRuleLine, isInvalidIpLiteral } from '../surge-rule/index.js';
import { encodeParams, normalizeParamsObject } from './codec.js';
import { normalizeRulePolicy, normalizeRuleType, normalizeSource } from './normalize.js';
import { renameLog } from './edit.js';
import { LOGS_TABLE, WRITE_COLUMNS, BATCH_CHUNK_SIZE, BATCH_MAX_LINES, FINAL_KEY, nowIso } from './schema.js';

/** 解析一行规则文本为可入库结构；非法行返回 null（跳过并计入统计） */
function parseOverrideLine(line) {
  const parsed = parseRuleLine(line);
  if (!parsed || parsed.invalid) return null;
  const comment = parsed.comment || '';

  if (parsed.type === 'FINAL') {
    return {
      hostname: FINAL_KEY,
      type: 'FINAL',
      value: '',
      policy: normalizeRulePolicy(parsed.policy),
      params: parsed.params,
      comment,
      source: ''
    };
  }
  if (!parsed.value) return null;
  // IP 类型但值不是合法字面量（如 999.999.999.999）直接丢弃，避免导出无效规则
  if ((parsed.type === 'IP-CIDR' || parsed.type === 'IP-CIDR6') && isInvalidIpLiteral(parsed.value)) return null;

  return {
    hostname: parsed.value,
    type: parsed.type,
    value: parsed.value,
    policy: normalizeRulePolicy(parsed.policy),
    params: parsed.params,
    comment,
    source: ''
  };
}

/** 结构化入参（POST 数组形式）归一化 */
function normalizeOverrideInput(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const type = normalizeRuleType(entry.type);
  const value = String(entry.value ?? entry.hostname ?? entry.target ?? '').trim();
  if (!value && type !== 'FINAL') return null;
  if ((type === 'IP-CIDR' || type === 'IP-CIDR6') && value && isInvalidIpLiteral(value)) return null;
  if (type === 'FINAL') {
    return {
      hostname: FINAL_KEY,
      type: 'FINAL',
      value: '',
      policy: normalizeRulePolicy(entry.policy),
      params: normalizeParamsObject(entry.params),
      comment: String(entry.comment ?? '').trim(),
      source: normalizeSource(entry.source)
    };
  }
  return {
    hostname: value,
    type,
    value,
    policy: normalizeRulePolicy(entry.policy),
    params: normalizeParamsObject(entry.params),
    comment: String(entry.comment ?? '').trim(),
    source: normalizeSource(entry.source)
  };
}

/**
 * 保留现场：第一条是被编辑的原匹配值且与新值不同时，先 rename 继承 count / time /
 * 备注 / 来源，成功后把这行从待处理列表移除（已带原统计入库，只差 params 补一次更新）。
 */
async function preserveEditedRow(db, items, preserveKey, override) {
  const head = items[0];
  if (!head || head.hostname === preserveKey) return false;

  const renamed = await renameLog(db, preserveKey, {
    type: head.type,
    policy: head.policy,
    params: head.params,
    // renameLog 约定 null = 保留旧值、空串 = 显式清空
    comment: override ? head.comment : (head.comment || null),
    source: override ? head.source : (head.source || null),
    newValue: head.hostname
  });
  if (!renamed.found) return false;

  await db.batch([{
    sql: `UPDATE ${LOGS_TABLE} SET params = ? WHERE hostname = ?`,
    params: [encodeParams(head.params), head.hostname]
  }]);
  items.shift();
  return true;
}

/** 每行一对 UPDATE + INSERT 语句；comment / source 两套写法只有「空串」语义差异 */
function buildStatements(items, override, now) {
  const statements = [];
  for (const item of items) {
    const encodedParams = encodeParams(item.params);
    const commentSql = override ? 'comment = ?' : `comment = COALESCE(NULLIF(?, ''), comment)`;
    const sourceSql = override ? 'source = ?' : `source = CASE WHEN ? = '' THEN source ELSE ? END`;
    statements.push({
      sql: `UPDATE ${LOGS_TABLE}
            SET type = ?, value = ?, policy = ?, params = ?, ${commentSql}, ${sourceSql},
                first_time = COALESCE(NULLIF(first_time, ''), ?)
            WHERE hostname = ?`,
      params: override
        ? [item.type, item.value, item.policy, encodedParams, item.comment, item.source, now, item.hostname]
        : [item.type, item.value, item.policy, encodedParams, item.comment, item.source, item.source, now, item.hostname]
    });
    statements.push({
      sql: `INSERT INTO ${LOGS_TABLE} (${WRITE_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(hostname) DO NOTHING`,
      // 批量粘贴 / Gist 还原没有设备上下文：ip / username 留空，命中上报路径才会携带
      params: [item.hostname, item.type, item.value, item.policy, encodedParams, item.comment, item.source, '', '', now, now]
    });
  }
  return statements;
}

/** 分块顺序提交，每块一个远端事务；UPDATE 命中计 updated，INSERT 计 created。
  * 每行都是幂等的 upsert：某一块失败时已提交的块不会回滚，但整批重跑结果一致。
  */
async function flushChunks(db, statements) {
  let updated = 0;
  let created = 0;
  // 每行一对 UPDATE + INSERT 语句：分块尺寸必须是偶数，成对操作才不会跨事务
  const cap = Math.min(BATCH_CHUNK_SIZE * 2, db.maxBatchSize || BATCH_CHUNK_SIZE * 2);
  const chunkSize = Math.max(2, cap - (cap % 2));
  for (let start = 0; start < statements.length; start += chunkSize) {
    const chunk = statements.slice(start, start + chunkSize);
    const results = await db.batch(chunk);
    for (let i = 0; i < results.length; i += 2) {
      if (results[i].changes > 0) updated += 1;
      if (results[i + 1] && results[i + 1].changes > 0) created += 1;
    }
  }
  return { updated, created };
}

export async function batchOverride(db, lines, { mode = 'merge', preserveFrom = '' } = {}) {
  const parsed = new Map();
  let truncated = 0;
  for (const line of lines) {
    if (parsed.size >= BATCH_MAX_LINES) {
      truncated += 1;
      continue;
    }
    const item = typeof line === 'string' ? parseOverrideLine(line) : normalizeOverrideInput(line);
    if (item) parsed.set(item.hostname, item);
  }
  if (parsed.size === 0) return { updated: 0, created: 0, total: 0, preserved: false, skipped: 0, truncated: 0 };

  const override = mode === 'override';
  const items = [...parsed.values()];

  let preserved = false;
  const preserveKey = String(preserveFrom || '').trim();
  if (preserveKey) {
    preserved = await preserveEditedRow(db, items, preserveKey, override);
  }

  const { updated, created } = await flushChunks(db, buildStatements(items, override, nowIso()));
  return { updated, created, total: parsed.size, preserved, skipped: truncated, truncated };
}
