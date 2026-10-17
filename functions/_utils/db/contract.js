/**
 * 数据库适配器契约：统一错误模型与结果形状。
 *
 * 所有适配器（Turso / D1 / SQLite）对业务层暴露同一套语义，业务代码只认这里的
 * 抽象，不出现任何后端品牌：
 *
 *   execute(sql, params)   → 行对象数组（SELECT / PRAGMA），写语句返回 []
 *   batch(statements)      → [{ rows, changes }]，一个批量的全部语句在同一事务里
 *                            执行：要么全成功要么整体回滚
 *   ping()                 → 连通性探测，失败抛 DbError（kind 已归类）
 *   maxBatchSize           → 单个批量事务的语句数上限（成对操作必须塞进同一个批量）
 *   ready                  → Promise<void>，实例创建后完成一次幂等 schema 迁移
 *
 * 语句入参形状：{ sql, params }；结果 changes 是「受影响行数」的统一数字出口
 * （Turso 的 rows_written / D1 的 meta.changes / SQLite 的 changes 都归一到这里）。
 *
 * 配置错误抛 ConfigError（路由返回 400 语义，见 factory.resolveAdapter）；
 * 运行时错误统一包成 DbError 并按 kind 归类，报告层据此区分
 * 「数据库连不上」和「SQL 写错」，业务层只判断类别不看品牌。
 */

export { ConfigError } from '../turso.js';

/** 运行时错误的归类清单 */
export const DB_ERROR_KINDS = ['connection', 'timeout', 'auth', 'syntax', 'constraint', 'unknown'];

/** 统一的数据库运行时错误：kind ∈ DB_ERROR_KINDS */
export class DbError extends Error {
  constructor(message, kind = 'unknown', { cause } = {}) {
    super(message);
    this.name = 'DbError';
    this.kind = DB_ERROR_KINDS.includes(kind) ? kind : 'unknown';
    this.cause = cause;
  }
}

/** kind → 中文标签（诊断报告用，与「配置问题」区分开） */
export const DB_ERROR_LABELS = {
  connection: '连接类（地址不可达或服务端异常）',
  timeout: '超时类（响应超过时限）',
  auth: '鉴权类（令牌被拒绝）',
  syntax: '语法类（SQL 或表结构不匹配）',
  constraint: '约束类（唯一键冲突或外键失败）',
  unknown: '未知错误'
};

/**
 * 错误归类：消息文本与错误名里找特征。Turso 的错误文案正则全部收在这里，
 * 业务层永远不要自己 match 错误消息。
 */
export function classifyError(error) {
  if (error instanceof DbError) return error.kind;
  const text = String(error?.message ?? '') + ' ' + String(error?.name ?? '');
  if (/abort|timeout|timed?\s?out/i.test(text)) return 'timeout';
  if (/401|403|unauthorized|forbidden|jwt|authentication/i.test(text)) return 'auth';
  if (/unique constraint|constraint fail/i.test(text)) return 'constraint';
  if (/syntax error|no such (table|column|function)|ambiguous column/i.test(text)) return 'syntax';
  if (/fetch failed|network|econnrefused|enotfound|econnreset|socket|dns|5\d\d|internal error/i.test(text)) return 'connection';
  return 'unknown';
}

/** 把任意抛错包成 DbError（已是 DbError / ConfigError 则原样返回） */
export function asDbError(error) {
  if (error instanceof DbError) return error;
  if (error?.name === 'ConfigError') return error;
  return new DbError(error?.message || '数据库操作失败', classifyError(error), { cause: error });
}

/** 批量语句数上限的默认值：单个适配器实现可以收紧 */
export const DEFAULT_MAX_BATCH_SIZE = 250;
