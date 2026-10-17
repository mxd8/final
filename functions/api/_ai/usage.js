/**
 * Cloudflare 用量查询：代理 GraphQL Analytics API，汇总过去 24 小时的
 * Workers AI 推理用量与 Workers 请求次数，供仪表盘「☁️ Cloudflare 用量」卡展示。
 *
 *   POST https://api.cloudflare.com/client/v4/graphql   （鉴权 Bearer Token）
 *
 * 两个数据集独立查询、独立容错（Promise.allSettled）：
 *   - aiInferenceAdaptiveGroups   需要权限 Account Analytics: Read（关键）
 *   - workersInvocationsAdaptive  需要权限 Workers Scripts: Read（可选，缺了只降级该项）
 * 任何一个失败都不影响另一个，失败原因以 warning 带回前端给出可操作提示。
 *
 * 模块级 60 秒缓存：面板整页刷新 / 多标签页同时打开时不会连环打 GraphQL，
 * 匿名读也扛得住（force=1 跳过缓存，但要求写令牌，防止匿名刷穿配额）。
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const QUERY_TIMEOUT_MS = 15000;
const WINDOW_HOURS = 24;
const CACHE_TTL_MS = 60 * 1000;
/** 单数据集最多取多少个分组（按模型 / 脚本名聚合，超出说明该配 token 权限过宽） */
const GROUP_LIMIT = 1000;

const AI_USAGE_QUERY = `
query($accountTag: String!, $since: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      aiInferenceAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: {datetime_geq: $since}
      ) {
        sum { requests totalTokens }
        dimensions { modelName }
      }
    }
  }
}`;

const WORKERS_USAGE_QUERY = `
query($accountTag: String!, $since: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        limit: ${GROUP_LIMIT}
        filter: {datetime_geq: $since}
      ) {
        sum { requests errors }
        dimensions { scriptName }
      }
    }
  }
}`;

/** 模块级缓存：key 含账号与 token 尾段，换配置自动失效 */
let usageCache = { at: 0, key: '', data: null };

async function queryGraphql(token, query, variables) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON 响应：只带 HTTP 状态码即可
  }
  // GraphQL 的鉴权 / 权限错误是 HTTP 200 + errors 数组，必须单独判
  const firstError = body?.errors?.[0]?.message;
  if (firstError) throw new Error(firstError);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return body?.data ?? {};
}

function accountGroups(data) {
  const accounts = data?.viewer?.accounts;
  return Array.isArray(accounts) ? accounts[0] ?? {} : {};
}

/** AI 用量聚合：总请求 / 总 Token / 按模型分布（Token 降序取前 5） */
function sumAiUsage(data) {
  const groups = accountGroups(data).aiInferenceAdaptiveGroups || [];
  let requests = 0;
  let tokens = 0;
  const models = new Map();
  for (const group of groups) {
    const groupRequests = Number(group?.sum?.requests ?? 0) || 0;
    const groupTokens = Number(group?.sum?.totalTokens ?? 0) || 0;
    requests += groupRequests;
    tokens += groupTokens;
    const name = String(group?.dimensions?.modelName || '').trim() || '未知模型';
    const acc = models.get(name) || { name, requests: 0, tokens: 0 };
    acc.requests += groupRequests;
    acc.tokens += groupTokens;
    models.set(name, acc);
  }
  return {
    requests,
    tokens,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5)
  };
}

/** Workers 用量聚合：总请求 / 按脚本分布（请求降序取前 5） */
function sumWorkersUsage(data) {
  const groups = accountGroups(data).workersInvocationsAdaptive || [];
  let requests = 0;
  let errors = 0;
  const scripts = new Map();
  for (const group of groups) {
    const groupRequests = Number(group?.sum?.requests ?? 0) || 0;
    const groupErrors = Number(group?.sum?.errors ?? 0) || 0;
    requests += groupRequests;
    errors += groupErrors;
    const name = String(group?.dimensions?.scriptName || '').trim() || '未命名脚本';
    const acc = scripts.get(name) || { name, requests: 0 };
    acc.requests += groupRequests;
    scripts.set(name, acc);
  }
  return {
    requests,
    errors,
    scripts: [...scripts.values()].sort((a, b) => b.requests - a.requests).slice(0, 5)
  };
}

function cacheKey(config) {
  const token = String(config?.cfApiToken ?? '');
  return `${String(config?.cfAccountId ?? '').trim()}:${token.slice(-6)}`;
}

/**
 * 查询 Cloudflare 用量。凭据复用「AI配置」页保存的连接配置；
 * 未配置时返回 { configured: false }，由前端展示引导而不报错。
 * @returns {Promise<object>} { configured, windowHours, since, ai, workers, warnings }
 */
export async function getCfUsage(config, { force = false } = {}) {
  const accountId = String(config?.cfAccountId ?? '').trim();
  const token = String(config?.cfApiToken ?? '').trim();
  if (!accountId || !token) return { configured: false };

  const key = cacheKey(config);
  if (!force && usageCache.key === key && Date.now() - usageCache.at < CACHE_TTL_MS) {
    return { ...usageCache.data, cached: true };
  }

  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const variables = { accountTag: accountId, since };
  const [aiResult, workersResult] = await Promise.allSettled([
    queryGraphql(token, AI_USAGE_QUERY, variables),
    queryGraphql(token, WORKERS_USAGE_QUERY, variables)
  ]);

  const data = {
    configured: true,
    windowHours: WINDOW_HOURS,
    since,
    fetchedAt: new Date().toISOString(),
    ai: null,
    workers: null,
    warnings: []
  };
  if (aiResult.status === 'fulfilled') {
    data.ai = sumAiUsage(aiResult.value);
  } else {
    data.warnings.push(`AI 用量读取失败（需 Account Analytics: Read 权限）：${aiResult.reason?.message ?? '未知错误'}`);
  }
  if (workersResult.status === 'fulfilled') {
    data.workers = sumWorkersUsage(workersResult.value);
  } else {
    data.warnings.push(`Workers 指标读取失败（可选，需 Workers Scripts: Read 权限）：${workersResult.reason?.message ?? '未知错误'}`);
  }

  usageCache = { at: Date.now(), key, data };
  return { ...data, cached: false };
}
