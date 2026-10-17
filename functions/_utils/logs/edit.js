/**
 * 单条记录更新：字段级 patch、换主键（renameLog）与输入校验。
 * 字段取 'UNSET' 或 null 表示「本次不修改」，避免把已有内容覆盖成空。
 */

import { isPolicyName } from '../surge-rule/index.js';
import { encodeParams, normalizeParamsObject } from './codec.js';
import { normalizeRulePolicy, normalizeRuleType, normalizeSource } from './normalize.js';
import { LOGS_TABLE, WRITE_COLUMNS, nowIso, safeCount } from './schema.js';

/**
 * 校验更新补丁，并顺手修正 type / value 不匹配：
 * FINAL 的 value 必须清空；非 FINAL 且 value 为空时用主机名回填。
 * repaired 标记告诉调用方本次是否发生了静默修正。
 */
export function validateLogPatch(entry = {}) {
  const typeText = String(entry.type ?? 'UNSET').trim().toUpperCase();
  const type = typeText === 'UNSET' ? 'UNSET' : normalizeRuleType(typeText);
  const rawValue = String(entry.value ?? 'UNSET').trim();
  let value = rawValue;

  if (type === 'FINAL') {
    value = rawValue === 'UNSET' ? 'UNSET' : '';
  } else if (type !== 'UNSET' && rawValue === '') {
    value = String(entry.hostname || '').trim();
  }

  const policyText = String(entry.policy ?? 'UNSET').trim();
  if (policyText && policyText !== 'UNSET' && !isPolicyName(policyText)) {
    return { ok: false, error: `策略名不合法：${policyText}` };
  }

  if (value !== 'UNSET' && value.length > 512) {
    return { ok: false, error: '匹配值过长（超过 512 字符）' };
  }
  const commentText = entry.comment === null || entry.comment === undefined ? null : String(entry.comment).trim();
  if (commentText && commentText.length > 200) return { ok: false, error: '备注过长（超过 200 字符）' };

  return {
    ok: true,
    repaired: value !== rawValue,
    value: {
      type,
      value,
      policy: policyText === 'UNSET' ? 'UNSET' : normalizeRulePolicy(policyText),
      params: entry.params,
      comment: commentText,
      source: entry.source
    }
  };
}

/** 修改匹配值 = 换主键（hostname 唯一）：删旧行插新行，保留计数、备注、来源、来源 IP 与时间 */
export async function renameLog(db, oldHostname, { newValue, type = 'UNSET', policy = 'UNSET', params = null, comment = null, source = null } = {}) {
  const newHostname = String(newValue || '').trim();
  if (!newHostname || newHostname === oldHostname) return { found: false, created: false, renamed: false };

  const [oldRow] = await db.execute(`SELECT count, time, first_time, policy, comment, source, ip, username, type FROM ${LOGS_TABLE} WHERE hostname = ?`, [oldHostname]);
  const baseCount = oldRow ? safeCount(oldRow.count) : 1;
  const baseTime = oldRow ? String(oldRow.time ?? '') : nowIso();
  const baseFirst = oldRow && String(oldRow.first_time ?? '').trim() !== '' ? String(oldRow.first_time) : baseTime;
  const baseIp = oldRow ? String(oldRow.ip ?? '') : '';
  const baseUsername = oldRow ? String(oldRow.username ?? '') : '';

  const typeText = String(type ?? 'UNSET').trim().toUpperCase();
  const validType = typeText === 'UNSET' ? (oldRow ? normalizeRuleType(oldRow.type) : 'DOMAIN-SUFFIX') : normalizeRuleType(typeText);
  const policyText = String(policy ?? '').trim();
  const validPolicy = policyText === 'UNSET' ? (oldRow ? normalizeRulePolicy(oldRow.policy) : 'PROXY') : normalizeRulePolicy(policyText);
  const validParams = params === null ? '' : encodeParams(normalizeParamsObject(params));
  const validComment = comment === null ? (oldRow ? String(oldRow.comment ?? '') : '') : String(comment).trim();
  const validSource = source === null ? (oldRow ? normalizeSource(oldRow.source) : '') : normalizeSource(source);

  const results = await db.batch([
    { sql: `DELETE FROM ${LOGS_TABLE} WHERE hostname = ?`, params: [oldHostname] },
    {
      sql: `INSERT INTO ${LOGS_TABLE} (${WRITE_COLUMNS}, manual_edited)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      params: [newHostname, validType, newHostname, validPolicy, validParams, validComment, validSource, baseIp, baseUsername, baseFirst, baseTime, baseCount]
    }
  ]);

  return { found: results[0].changes > 0, created: results[1].changes > 0, renamed: true };
}

/** 归一化本次要写入的字段值（'UNSET' 表示不改） */
function normalizePatchFields(patched) {
  const valueType = String(patched.value).trim();
  const typeText = patched.type === 'UNSET' ? 'UNSET' : normalizeRuleType(patched.type);
  const validType = typeText === 'UNSET' ? 'UNSET' : normalizeRuleType(typeText);
  const policyText = patched.policy === 'UNSET' ? 'UNSET' : normalizeRulePolicy(patched.policy);
  const validPolicy = policyText === 'UNSET' ? 'UNSET' : normalizeRulePolicy(policyText);
  const paramsText = patched.params === null ? null : encodeParams(normalizeParamsObject(patched.params));
  return { valueType, typeText, validType, policyText, validPolicy, paramsText };
}

/** 原地更新的成对语句：CASE / COALESCE 表达「本次不改该字段」，不能绑 NULL（NOT NULL 约束） */
function buildFieldUpdateStatements(target, patched, fields) {
  const { valueType, typeText, validType, policyText, validPolicy, paramsText } = fields;
  const commentText = patched.comment === null ? null : String(patched.comment).trim();
  const sourceText = patched.source === null ? null : normalizeSource(patched.source);

  return [
    {
      sql: `UPDATE ${LOGS_TABLE}
            SET type = CASE WHEN ? = 'UNSET' THEN type ELSE ? END,
                value = CASE WHEN ? = 'UNSET' THEN value ELSE ? END,
                policy = CASE WHEN ? = 'UNSET' THEN policy ELSE ? END,
                params = COALESCE(NULLIF(?, ''), params),
                comment = COALESCE(NULLIF(?, ''), comment),
                source = COALESCE(NULLIF(?, ''), source),
                manual_edited = 1
            WHERE hostname = ?`,
      params: [typeText, validType, valueType, valueType === 'UNSET' ? '' : valueType, policyText, validPolicy, paramsText, commentText, sourceText, target]
    },
    {
      sql: `INSERT INTO ${LOGS_TABLE} (${WRITE_COLUMNS}, manual_edited)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
            ON CONFLICT(hostname) DO NOTHING`,
      params: [
        target,
        validType === 'UNSET' ? 'DOMAIN-SUFFIX' : validType,
        valueType === 'UNSET' ? target : valueType,
        validPolicy === 'UNSET' ? 'PROXY' : validPolicy,
        paramsText || '',
        commentText === null ? '' : commentText,
        sourceText === null ? '' : sourceText,
        '',
        '',
        nowIso(),
        nowIso()
      ]
    }
  ];
}

/** 原地字段更新：UPDATE 命中计 found，INSERT 兜底计 created */
async function applyFieldUpdate(db, target, patched, repaired) {
  const fields = normalizePatchFields(patched);
  const results = await db.batch(buildFieldUpdateStatements(target, patched, fields));

  return {
    found: results[0].changes > 0,
    created: results[1].changes > 0,
    renamed: false,
    repaired
  };
}

/** 更新单条记录：匹配值变更走 renameLog 保留计数，否则原地更新 */
export async function updateLog(db, hostname, {
  type = 'UNSET',
  value = 'UNSET',
  policy = 'UNSET',
  params = null,
  comment = null,
  source = null
} = {}) {
  const target = String(hostname || '').trim();
  if (!target) return { found: false, created: false, renamed: false, repaired: false };

  const check = validateLogPatch({ hostname: target, type, value, policy, params, comment, source });
  if (!check.ok) return { found: false, created: false, renamed: false, repaired: false, error: check.error };

  const patched = check.value;
  const valueType = String(patched.value).trim();
  if (valueType && valueType !== 'UNSET' && valueType !== target) {
    return renameLog(db, target, {
      type: patched.type,
      policy: patched.policy,
      params: patched.params,
      comment: patched.comment,
      source: patched.source,
      newValue: valueType
    });
  }

  return applyFieldUpdate(db, target, patched, check.repaired);
}
