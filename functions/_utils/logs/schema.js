/**
 * surge_logs 表结构、分块常量与 FINAL 键。
 * 迁移机制已收编到 _utils/db/ddl.js 的版本表（db_meta），这里只保留结构常量。
 */

export const LOGS_TABLE = 'surge_logs';

export const LOG_COLUMNS = 'id, hostname, type, value, policy, params, comment, source, ip, username, first_time, time, count';

/** 写入列集合（INSERT 与 upsert 共用；comment 由字面空串占位，不在参数列） */
export const WRITE_COLUMNS = 'hostname, type, value, policy, params, comment, source, ip, username, first_time, time, count';

/** 单个批量事务最多多少条规则（每条 2 条语句）：控制往返数据量与事务锁时长 */
export const BATCH_CHUNK_SIZE = 100;

/** 单次批量请求行数上限：超出截断而非拒绝，响应带 total/skipped 供前端提示 */
export const BATCH_MAX_LINES = 1500;

export const MAX_PARAM_LENGTH = 1024;
export const MAX_SOURCE_LENGTH = 128;
export const MAX_IP_LENGTH = 64;
export const MAX_USERNAME_LENGTH = 64;

/** FINAL 规则的全局唯一键：库里只允许一条 FINAL 规则 */
export const FINAL_KEY = 'FINAL';

export const LOGS_SCHEMA = `CREATE TABLE IF NOT EXISTS ${LOGS_TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'DOMAIN-SUFFIX',
  value TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL DEFAULT 'PROXY',
  params TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  first_time TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_${LOGS_TABLE}_hostname ON ${LOGS_TABLE}(hostname);
CREATE INDEX IF NOT EXISTS idx_${LOGS_TABLE}_time ON ${LOGS_TABLE}(time);
CREATE INDEX IF NOT EXISTS idx_${LOGS_TABLE}_type ON ${LOGS_TABLE}(type);
CREATE INDEX IF NOT EXISTS idx_${LOGS_TABLE}_source ON ${LOGS_TABLE}(source);
CREATE INDEX IF NOT EXISTS idx_${LOGS_TABLE}_username ON ${LOGS_TABLE}(username);`.trim();

/** 库行 count 可能被写成非法值，统一保证至少为 1 */
export function safeCount(value) {
  return Math.max(1, Number(value) || 1);
}

/** 当前 UTC ISO 时间戳：同一批写库语句共用，保证时间一致 */
export function nowIso() {
  return new Date().toISOString();
}
