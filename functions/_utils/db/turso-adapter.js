/**
 * TursoAdapter：把既有 Turso HTTPS 管道封装成 DatabaseAdapter 契约。
 *
 * Turso 专属语义（rows_written 形状、HTTPS 超时、serializable 批量事务、
 * 错误文案）全部收在这里，业务层只见 { rows, changes } 与 DbError。
 * 事务能力：一个批量 = 一个远端事务（serializable），失败自动回滚。
 */

import {
  getTursoConfig,
  executeTursoBatch,
  CONFIG_ERROR_MSG,
  TURSO_TIMEOUT_MS,
  redactUrl
} from '../turso.js';
import { ConfigError, asDbError, DEFAULT_MAX_BATCH_SIZE } from './contract.js';

/** Turso 返回的 columns + rows 数组转对象数组 */
function toRows(results) {
  if (!results || !Array.isArray(results.columns)) return [];
  const { columns, rows = [] } = results;
  return rows.map((row) => {
    const record = {};
    columns.forEach((col, i) => {
      record[col] = row[i];
    });
    return record;
  });
}

/** 写语句的受影响行数：rows_written（新）与 affected_row_count（旧）双形状归一 */
function toChanges(statement) {
  return Number(
    statement?.results?.rows_written ?? statement?.results?.affected_row_count ?? statement?.changes
  ) || 0;
}

export class TursoAdapter {
  backend = 'turso';
  maxBatchSize = DEFAULT_MAX_BATCH_SIZE;

  #config = null;
  ready = Promise.resolve();

  /** 解析配置；缺变量 / 协议错误抛 ConfigError（路由 400 语义） */
  init(env) {
    const config = getTursoConfig(env);
    if (!config) throw new ConfigError(CONFIG_ERROR_MSG);
    this.#config = config;
  }

  /** 诊断信息：只暴露主机名，绝不回传令牌与完整地址 */
  describe() {
    return `turso @ ${redactUrl(this.#config?.url ?? '')}`;
  }

  async ping() {
    try {
      await this.execute('SELECT 1');
    } catch (error) {
      throw asDbError(error);
    }
  }

  async execute(sql, params = []) {
    const results = await this.batch([{ sql, params }]);
    return results[0].rows;
  }

  /** 原子语句组：一次网络往返、一个远端事务，失败自动回滚并抛 DbError */
  async batch(statements) {
    let payload;
    try {
      payload = await executeTursoBatch(this.#config, statements);
    } catch (error) {
      throw asDbError(error);
    }
    return payload.map((statement) => ({
      rows: toRows(statement.results),
      changes: toChanges(statement)
    }));
  }
}

export { TURSO_TIMEOUT_MS };
