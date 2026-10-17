/**
 * Cloudflare Workers AI 客户端：模型列表、推理调用与连通性测试。
 *
 * API 参考（REST）：
 *   GET  https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
 * 鉴权统一 Bearer Token。fetch 复用订阅抓取的超时 + 重试 + 退避套路：
 * 429 / 5xx / 网络抖动才重试，401 / 403 / 404 这类确定性失败立即返回。
 */

import { AI_DEFAULT_MODEL } from './config.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

const LIST_TIMEOUT_MS = 12000;
const RUN_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableNetworkError(error) {
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = String(error?.message ?? '').toLowerCase();
  return ['network', 'fetch failed', 'connection', 'timed out', 'temporarily unavailable'].some((needle) => message.includes(needle));
}

/** 从 CF API 响应体提取人类可读的错误信息 */
async function extractApiError(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    const first = body?.errors?.[0];
    if (first?.message) detail = `${first.message}${first.code != null ? ` (code ${first.code})` : ''}`;
  } catch {
    // 响应体不是 JSON：保留 HTTP 状态码即可
  }
  const error = new Error(`Workers AI 请求失败：${detail}`);
  error.status = response.status;
  return error;
}

/** 带重试的 fetch：单次超时 + 退避重试，确定性失败（4xx 客户端错误）不重试 */
async function fetchWithRetry(url, init, { timeoutMs, maxAttempts = MAX_ATTEMPTS } = {}) {
  let attempt = 0;
  let lastResponse = null;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!isRetryableStatus(response.status) || attempt >= maxAttempts) return response;
      lastResponse = response;
      lastError = null;
      console.warn('[ai][client] 可重试响应', { attempt, status: response.status });
    } catch (error) {
      lastError = error;
      lastResponse = null;
      if (attempt >= maxAttempts || !isRetryableNetworkError(error)) throw error;
      console.warn('[ai][client] 请求异常，准备重试', { attempt, message: error?.message });
    }
    await sleep(RETRY_BASE_DELAY_MS * attempt);
  }

  return lastResponse ?? (() => { throw lastError; })();
}

function assertCredentials(config) {
  const accountId = String(config?.cfAccountId ?? '').trim();
  const token = String(config?.cfApiToken ?? '').trim();
  if (!accountId || !token) {
    const error = new Error('尚未配置 Cloudflare Account ID 或 API Token，请先在「AI配置」页保存连接');
    error.name = 'ConfigError';
    throw error;
  }
  return { accountId, token };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * 拉取账号可用的 Workers AI 模型，只保留文本生成类（分类与注释补全够用）。
 * @returns {Promise<Array<{name, description, task}>>}
 */
export async function listTextModels(config) {
  const { accountId, token } = assertCredentials(config);
  const url = `${CF_API_BASE}/accounts/${accountId}/ai/models/search?per_page=100`;
  const response = await fetchWithRetry(url, { method: 'GET', headers: authHeaders(token) }, { timeoutMs: LIST_TIMEOUT_MS });
  if (!response.ok) throw await extractApiError(response);

  const body = await response.json();
  if (body?.success === false) throw new Error(`Workers AI 请求失败：${body?.errors?.[0]?.message ?? '未知错误'}`);
  const models = Array.isArray(body?.result) ? body.result : [];
  return models
    .filter((model) => model?.task?.name === 'Text Generation' && model?.name)
    .map((model) => ({
      name: String(model.name),
      description: String(model.description ?? '').slice(0, 200),
      task: String(model.task?.name ?? '')
    }));
}

/**
 * 调用文本生成模型。兼容两种返回形态：chat 模型的 result.response 为字符串，
 * 个别模型为对象（取其 response 字段）。
 * @returns {Promise<string>} 模型输出文本
 */
export async function runModel(config, model, messages, { maxTokens = 150, temperature = 0 } = {}) {
  const { accountId, token } = assertCredentials(config);
  const target = String(model || config?.model || '').trim();
  if (!target) {
    const error = new Error('未指定调用模型，请先在「AI配置」页选择');
    error.name = 'ConfigError';
    throw error;
  }

  const url = `${CF_API_BASE}/accounts/${accountId}/ai/run/${target}`;
  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature })
    },
    { timeoutMs: RUN_TIMEOUT_MS, maxAttempts: 2 }
  );
  if (!response.ok) throw await extractApiError(response);

  const body = await response.json();
  if (body?.success === false) throw new Error(`Workers AI 请求失败：${body?.errors?.[0]?.message ?? '未知错误'}`);
  const result = body?.result?.response;
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.response === 'string') return result.response;
  throw new Error('Workers AI 返回了无法识别的结果结构');
}

/** 连通性测试：跑一条最小推理，返回样例输出便于面板展示 */
export async function testConnection(config) {
  const model = String(config?.model || AI_DEFAULT_MODEL).trim();
  const sample = await runModel(config, model, [
    { role: 'user', content: '只回复两个字：连通' }
  ], { maxTokens: 20, temperature: 0 });
  return { model, sample: sample.trim().slice(0, 100) };
}
