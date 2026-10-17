/**
 * SqliteAdapter：node:sqlite 本地文件适配器。
 *
 * 适用场景：自托管 Node（DB_BACKEND=sqlite + DB_SQLITE_PATH）与 e2e 契约测试——
 * 测试从「mock 模拟 Turso HTTP 形状」升级为「真实适配器」，测试与生产同路径。
 *
 * node:sqlite 需要 Node 22.5+；用惰性动态 import 加载，Cloudflare Workers 的
 * 构建产物只有真的选了 sqlite 后端才会碰到这条路径。
 * 事务能力：真事务（BEGIN IMMEDIATE），完整隔离，无网络超时。
 */

import { ConfigError, asDbError, DEFAULT_MAX_BATCH_SIZE } from './contract.js';

export const SQLITE_PATH_VAR = 'DB_SQLITE_PATH';

export class SqliteAdapter {
  backend = 'sqlite';
  maxBatchSize = DEFAULT_MAX_BATCH_SIZE;

  /** 库实例句柄：自托管脚本与测试直接读数的通道（实现细节，业务层勿依赖） */
  db = null;
  ready = Promise.resolve();

  async init(env) {
    const path = String(env?.[SQLITE_PATH_VAR] ?? '').trim();
    if (!path) {
      throw new ConfigError(`DB_BACKEND=sqlite 需要环境变量 ${SQLITE_PATH_VAR} 指定 SQLite 数据库文件路径（:memory: 亦可）`);
    }
    // 惰性动态 import + 运行时拼接模块名：Cloudflare 构建不会把 node:sqlite 打进产物，
    // workerd（不含 node:sqlite 实现）只有真的选了 sqlite 后端才会走到这里报配置错误
    let DatabaseSync;
    try {
      const moduleSpecifier = 'node:' + 'sqlite';
      ({ DatabaseSync } = await import(moduleSpecifier));
      this.db = new DatabaseSync(path);
    } catch (error) {
      throw new ConfigError(`sqlite 后端初始化失败（需要 Node 22.5+ 的 node:sqlite 与可写的库文件路径）：${error?.message ?? error}`);
    }
  }

  describe() {
    return 'sqlite (本地文件)';
  }

  async ping() {
    try {
      this.#run('SELECT 1');
    } catch (error) {
      throw asDbError(error);
    }
  }

  #run(sql, params = []) {
    const statement = this.db.prepare(sql);
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^(select|pragma|with)\s/i.test(text)) {
      return { rows: statement.all(...params), changes: 0 };
    }
    const info = statement.run(...params);
    return { rows: [], changes: Number(info.changes) || 0 };
  }

  async execute(sql, params = []) {
    try {
      return this.#run(sql, params).rows;
    } catch (error) {
      throw asDbError(error);
    }
  }

  /** 原子语句组：同一事务提交，任一失败整体回滚 */
  async batch(statements) {
    if (!Array.isArray(statements) || !statements.length) return [];
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((statement) => this.#run(statement.sql, statement.params ?? []));
        this.db.exec('COMMIT');
        return out;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw asDbError(error);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'DbError') throw error;
      throw asDbError(error);
    }
  }
}
