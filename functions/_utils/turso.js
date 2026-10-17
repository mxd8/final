/**
 * Turso 远端数据库访问层：配置解析 + SQL 执行，全部走 HTTPS API。
 * 错误统一为 ConfigError（配置问题，路由返回 400）与普通异常（500）。
 */

import { jsonResponse } from './http.js';

export const REQUIRED_VARS = ['TURSO_API_URL', 'TURSO_AUTH_TOKEN'];

export const TURSO_TIMEOUT_MS = 10000;

export const CONFIG_ERROR_MSG =
  '请先在 Pages 控制台的 Environment Variables 中配置 TURSO_API_URL 和 TURSO_AUTH_TOKEN';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 抹掉 URL 中的凭据信息，只保留主机名，避免日志泄漏（健康检测的报告脱敏复用） */
export function redactUrl(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return '（无法解析）';
  }
}

export function getTursoConfig(env) {
  const url = String(env.TURSO_API_URL ?? '').trim();
  const authToken = String(env.TURSO_AUTH_TOKEN ?? '').trim();

  const missing = REQUIRED_VARS.filter((name) => !env[name]).join(', ');
  if (missing) {
    console.warn(`[turso] 缺少环境变量：${missing}`);
    return null;
  }

  // Workers 的 fetch 无法解析 libsql:// 协议，只能走 HTTPS 远程访问地址
  if (url.startsWith('libsql://')) {
    throw new ConfigError('TURSO_API_URL 不能用 libsql:// 协议（Workers 无法解析），请改为 https:// 形式');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`TURSO_API_URL 不是合法地址：${redactUrl(url)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`TURSO_API_URL 必须是 https:// 开头，当前为 ${parsed.protocol}`);
  }

  return { url, authToken };
}

/**
 * 读取配置并统一处理两类错误：缺变量返回 400 响应，协议错误同样 400。
 * 所有 API 路由的入口都用它替代各自重复的同名函数。
 */
export function resolveTursoConfig(env) {
  try {
    const config = getTursoConfig(env);
    return config ? { config } : { response: jsonResponse({ success: false, error: CONFIG_ERROR_MSG }, { status: 400 }) };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { response: jsonResponse({ success: false, error: error.message }, { status: 400 }) };
    }
    throw error;
  }
}

/**
 * 写语句的受影响行数，全项目唯一的读取出口。
 * 真实 Turso HTTP 管道把它放在 results.rows_written（部分版本叫 affected_row_count），
 * 顶层没有 changes 字段；e2e 的 node:sqlite mock 按真实形状返回 results.rows_written。
 * 直接读顶层 changes 在真实 Turso 下恒为 undefined，会让删除 / 更新 / 批量统计全部归零。
 */
export function statementChanges(result) {
  return Number(result?.results?.rows_written ?? result?.results?.affected_row_count ?? result?.changes) || 0;
}

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

/** 执行一条 SQL 并返回行对象数组 */
export async function executeTurso(config, sql, params = []) {
  const results = await executeTursoBatch(config, [{ sql, params }]);
  const statement = results[0] ?? {};
  if (statement.error) {
    throw new Error(`Turso 执行失败：${statement.error}`);
  }
  return toRows(statement.results);
}

/**
 * 批量执行多条 SQL：一次网络往返、一个远端事务、失败自动回滚。
 * 「删除 + 新增」这类成对操作必须同事务提交，避免中途失败留下不一致状态。
 */
export async function executeTursoBatch(config, statements) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      statements: statements.map((statement) => ({
        q: statement.sql,
        params: statement.params ?? []
      })),
      serializable: true
    }),
    signal: AbortSignal.timeout(TURSO_TIMEOUT_MS)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    throw new Error(`Turso 请求失败：${payload?.error ?? response.status}`);
  }
  if (!Array.isArray(payload) || payload.length !== statements.length) {
    throw new Error('Turso 返回了意外格式：结果数量与语句数量不一致');
  }
  const failed = payload.find((statement) => statement.error);
  if (failed) {
    throw new Error(`Turso 执行失败：${failed.error}`);
  }
  return payload;
}
