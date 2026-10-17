/**
 * D1Adapter：Cloudflare D1 平台绑定适配器（同账号免费互调，免外部服务与配额双算）。
 *
 * 与 Turso 的差异全部内聚在这里：
 *   - 配置来源是平台绑定（env.DB_D1），不需要地址与令牌；
 *   - batch 原子（D1 的 batch 就是 SQL 事务），但没有跨批量事务，也没有
 *     serializable 隔离级别——「删除 + 新增」这类成对操作必须在同一个批量里完成；
 *   - 结果形状 meta.changes → 归一为 changes；results 已是对象数组。
 */

import { ConfigError, asDbError, DEFAULT_MAX_BATCH_SIZE } from './contract.js';

export const D1_BINDING_NAME = 'DB_D1';

export class D1Adapter {
  backend = 'd1';
  // D1 单次批量语句数上限按官方限额取保守值；成对操作（上限 200 条语句的批量上报）
  // 必须整体落进同一个批量，这里不设得更小
  maxBatchSize = 200;

  #binding = null;
  ready = Promise.resolve();

  init(env) {
    const binding = env?.[D1_BINDING_NAME];
    if (!binding || typeof binding.prepare !== 'function') {
      throw new ConfigError(
        `DB_BACKEND=d1 需要 Pages 平台绑定 D1 数据库：在 wrangler.toml 配置 d1_databases ` +
        `并在控制台把绑定名设为 ${D1_BINDING_NAME}`
      );
    }
    this.#binding = binding;
  }

  describe() {
    return 'd1 (平台绑定)';
  }

  #bind(sql, params) {
    const query = this.#binding.prepare(sql);
    return Array.isArray(params) && params.length ? query.bind(...params) : query;
  }

  async ping() {
    try {
      await this.execute('SELECT 1');
    } catch (error) {
      throw asDbError(error);
    }
  }

  async execute(sql, params = []) {
    try {
      const result = await this.#bind(sql, params).all();
      return Array.isArray(result?.results) ? result.results : [];
    } catch (error) {
      throw asDbError(error);
    }
  }

  /** 原子语句组：D1 batch 即事务，任一语句失败整体回滚 */
  async batch(statements) {
    if (!Array.isArray(statements) || !statements.length) return [];
    if (statements.length > this.maxBatchSize) {
      throw new Error(`D1 单次批量最多 ${this.maxBatchSize} 条语句，收到 ${statements.length} 条`);
    }
    try {
      const results = await this.#binding.batch(statements.map((s) => this.#bind(s.sql, s.params)));
      return results.map((result) => ({
        rows: Array.isArray(result?.results) ? result.results : [],
        changes: Number(result?.meta?.changes ?? 0) || 0
      }));
    } catch (error) {
      throw asDbError(error);
    }
  }
}
