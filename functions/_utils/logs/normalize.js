/**
 * 数据库行 / 用户输入的规范化：NULL 统一默认值，类型与策略回落合法值。
 */

import { RULE_TYPES, normalizePolicy as toSurgePolicy } from '../surge-rule/index.js';
import { decodeParams } from './codec.js';
import { MAX_SOURCE_LENGTH, MAX_IP_LENGTH, MAX_USERNAME_LENGTH, safeCount } from './schema.js';

/** 库内策略名规范化，非法值回落 PROXY */
export function normalizeRulePolicy(policy) {
  return toSurgePolicy(policy, 'PROXY');
}

/** 规则类型规范化：未知类型回落 DOMAIN-SUFFIX */
export function normalizeRuleType(type) {
  const text = String(type ?? '').trim().toUpperCase();
  return RULE_TYPES.has(text) ? text : 'DOMAIN-SUFFIX';
}

/** 设备来源规范化：压平换行并截断 */
export function normalizeSource(source) {
  return String(source ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_LENGTH);
}

/** 来源 IP 规范化：去端口与方括号字面量形态，只留地址本体 */
export function normalizeIp(ip) {
  let text = String(ip ?? '').trim();
  if (!text) return '';
  if (text.startsWith('[') && text.includes(']')) text = text.slice(1, text.indexOf(']'));
  else if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(text)) text = text.split(':')[0];
  return text.slice(0, MAX_IP_LENGTH);
}

/** 用户名 / 用户组规范化：压平换行并截断 */
export function normalizeUsername(username) {
  return String(username ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_USERNAME_LENGTH);
}

/**
 * 数据库行 → 前端结构。兼容旧库：旧行只有 hostname，按 DOMAIN-SUFFIX 语义回填，
 * hostname 与 value 保持一致便于排查。
 */
export function normalizeLogRow(row) {
  const type = normalizeRuleType(row.type);
  const value = row.value == null ? '' : String(row.value);
  const hostname = String(row.hostname ?? '').trim() || value;
  return {
    id: row.id,
    hostname,
    type,
    value,
    policy: normalizeRulePolicy(row.policy),
    params: decodeParams(row.params),
    comment: row.comment == null ? '' : String(row.comment),
    source: row.source == null ? '' : String(row.source),
    ip: row.ip == null ? '' : String(row.ip),
    username: row.username == null ? '' : String(row.username),
    first_time: row.first_time == null ? '' : String(row.first_time),
    time: String(row.time ?? ''),
    count: safeCount(row.count),
    /** ✏️ 快速编辑过（手动调整）：展示徽标 + AI 调度优先但不改写其策略 */
    manual_edited: Number(row.manual_edited) ? 1 : 0,
    /** AI 已处理过：自动化调度跳过 */
    ai_processed: Number(row.ai_processed) ? 1 : 0
  };
}
