/**
 * DatabaseFactory：按 DB_BACKEND 环境变量创建并缓存数据库适配器。
 *
 *   turso（默认）  TURSO_API_URL + TURSO_AUTH_TOKEN   现有部署，零配置兼容
 *   d1            Pages 平台绑定（DB_D1）             Cloudflare 生态内闭环
 *   sqlite        DB_SQLITE_PATH 指定的本地库文件      自托管 Node / e2e 真实后端
 *
 * 生命周期：业务路由统一经 getAdapter(env) 取适配器；isolate 内按「配置签名」
 * 缓存实例（同一部署的配置在请求间不可变），惰性初始化——首次使用才校验配置并
 * 跑一次幂等 schema 迁移（adapter.ready）。
 *
 * 失败语义：工厂不吞错——缺配置 / DB_BACKEND 非法值抛 ConfigError，
 * resolveAdapter 把它转成 400 响应（沿用 resolveTursoConfig 的既有交互模式）；
 * 初始化或迁移失败的实例会被逐出缓存，下一次请求重试而不是永远失败。
 */

import { jsonResponse } from '../http.js';
import { ConfigError, DEFAULT_MAX_BATCH_SIZE } from './contract.js';
import { ensureSchema } from './ddl.js';
import { TursoAdapter } from './turso-adapter.js';
import { D1Adapter, D1_BINDING_NAME } from './d1-adapter.js';
import { SqliteAdapter, SQLITE_PATH_VAR } from './sqlite-adapter.js';

export const DB_BACKENDS = ['turso', 'd1', 'sqlite'];

export const DB_BACKEND_VAR = 'DB_BACKEND';

const ADAPTER_CLASSES = {
  turso: TursoAdapter,
  d1: D1Adapter,
  sqlite: SqliteAdapter
};

/** 读取并校验 DB_BACKEND；未配置默认 turso（零配置兼容所有现有部署） */
export function resolveDbBackend(env) {
  const raw = String(env?.[DB_BACKEND_VAR] ?? '').trim().toLowerCase();
  if (!raw) return 'turso';
  if (!DB_BACKENDS.includes(raw)) {
    throw new ConfigError(`DB_BACKEND 取值不合法：${raw}（可选：${DB_BACKENDS.join(' / ')}）`);
  }
  return raw;
}

/** D1 绑定是平台对象，用递增 id 参与缓存签名（WeakMap 防泄漏） */
const bindingIds = new WeakMap();
let nextBindingId = 1;

function signatureFor(env, backend) {
  if (backend === 'turso') return `turso|${String(env?.TURSO_API_URL ?? '')}`;
  if (backend === 'sqlite') return `sqlite|${String(env?.[SQLITE_PATH_VAR] ?? '')}`;
  const binding = env?.[D1_BINDING_NAME];
  if (!binding) return 'd1|missing';
  if (!bindingIds.has(binding)) bindingIds.set(binding, nextBindingId);
  return `d1|${bindingIds.get(binding)}`;
}

const cache = new Map();

/** 取适配器：命中缓存直接返回；未命中则惰性创建 + 幂等迁移 */
export async function getAdapter(env) {
  const backend = resolveDbBackend(env);
  const signature = signatureFor(env, backend);

  const existing = cache.get(signature);
  if (existing) {
    try {
      await existing.ready;
      return existing;
    } catch (error) {
      cache.delete(signature);
      throw error;
    }
  }

  const AdapterClass = ADAPTER_CLASSES[backend];
  const adapter = new AdapterClass();
  adapter.maxBatchSize = adapter.maxBatchSize || DEFAULT_MAX_BATCH_SIZE;
  adapter.ready = (async () => {
    await adapter.init(env);
    await ensureSchema(adapter);
  })();
  cache.set(signature, adapter);

  try {
    await adapter.ready;
  } catch (error) {
    // 初始化失败不缓存：实例逐出，下次请求重新校验（部署修好配置后无需等重启）
    cache.delete(signature);
    throw error;
  }
  return adapter;
}

/**
 * 路由入口专用：ConfigError → 400 响应（缺配置 / 后端名非法），
 * 其余错误原样上抛走 500。返回 { adapter } 或 { response }。
 */
export async function resolveAdapter(env) {
  try {
    return { adapter: await getAdapter(env) };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { response: jsonResponse({ success: false, error: error.message }, { status: 400 }) };
    }
    throw error;
  }
}

/** 诊断信息（健康检测用）：当前后端名 + 脱敏描述，绝不包含令牌与完整地址 */
export function describeBackend(adapter) {
  return `${adapter.backend} · ${adapter.describe()}`;
}
