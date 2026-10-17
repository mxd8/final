/**
 * 订阅抓取与规则提取：先按纯文本试，形似 base64 时解码后再试一次。
 */

import { parseRuleLine } from '../../_utils/surge-rule/index.js';

/** 抓取超时（毫秒）：订阅源多在境外，8 秒足够 */
const FETCH_TIMEOUT_MS = 8000;

/** 单条订阅最多尝试几次：默认 + 2 次重试，专门兜「Network connection lost」这类抖动 */
const FETCH_MAX_ATTEMPTS = 3;

/** 两次重试之间的基础退避毫秒：递增 1 倍，避免瞬间再打已经抖动的源 */
const FETCH_RETRY_BASE_DELAY_MS = 300;

/** 整个抓取流程的总预算（毫秒）：要比面板 /parse 请求超时短，避免前端先断 */
const FETCH_MAX_TOTAL_MS = 30000;

/** 订阅内容大小上限（字节）：2MB 大约是十万行规则 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 单条订阅最多提取多少行规则：超出截断，防止无限行拖垮解析 */
const MAX_RULE_LINES = 50000;

/** INI 段头：[General]、[Rule]、[MITM]… */
const SECTION_HEADER = /^\s*\[.*\]\s*$/;

/** 配置行：`key = value`（Surge 的 .conf 与 Sub-Store 的配置段都长这样） */
const CONFIG_LINE = /^\s*[A-Za-z0-9_.-]+\s*=/;

/** base64 特征：字符集干净（含换行）且去空白后长度是 4 的倍数 */
const BASE64_LIKE = /^[A-Za-z0-9+/=\s]+$/;

/**
 * 从订阅内容提取规则行。复用 surge-rule 的 parseRuleLine：
 * 注释、引号包裹的值、非法结构它都已处理，额外只挡 INI 段头与 key=value 配置行。
 */
export function extractRuleLines(content) {
  const text = String(content || '');
  const lines = [];
  let skipped = 0;
  let seen = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    seen += 1;
    if (SECTION_HEADER.test(line) || CONFIG_LINE.test(line)) {
      skipped += 1;
      continue;
    }
    const parsed = parseRuleLine(line);
    if (parsed && !parsed.invalid) {
      lines.push(line);
      if (lines.length >= MAX_RULE_LINES) break;
    } else {
      skipped += 1;
    }
  }
  return { lines, skipped, total: seen };
}

/** 一行内容本身形似 base64 载荷：只含 base64 字符集且长度超过 60 */
function isBase64Payload(line) {
  const text = String(line || '').split('//')[0].trim();
  return text.length > 60 && BASE64_LIKE.test(text);
}

/** base64 解码：非法输入返回空串，不抛异常 */
function decodeBase64(text) {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/** 响应状态与内容读取的统一前置校验 */
async function readBody(response) {
  if (!response.ok) {
    return { ok: false, error: `订阅源返回 HTTP ${response.status}`, status: response.status };
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return { ok: false, error: '返回的是网页而不是规则内容（content-type 为 text/html）' };
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `读取内容失败：${error?.message || '未知原因'}` };
  }
  if (!text.trim()) return { ok: false, error: '订阅内容为空' };
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, error: `订阅内容超过 ${MAX_BODY_BYTES / 1024 / 1024}MB 上限` };
  }
  return { ok: true, text };
}

/** 触发 base64 重试并返回解码结果；不满足条件或解码后无规则返回 null */
function retryAsBase64(text, first) {
  const extractionRate = first.total > 0 ? first.lines.length / first.total : 0;
  const looksBase64 = BASE64_LIKE.test(text) && text.replace(/\s/g, '').length % 4 === 0;
  const soleLineIsBase64 = first.lines.length === 1 && isBase64Payload(first.lines[0]);
  if (!(first.total > 0 && looksBase64 && (extractionRate < 0.1 || soleLineIsBase64))) return null;

  const decoded = decodeBase64(text.replace(/\s/g, ''));
  if (!decoded) return null;
  const second = extractRuleLines(decoded);
  return second.lines.length > 0
    ? { ok: true, ...second, truncated: second.lines.length >= MAX_RULE_LINES }
    : null;
}

/** 退避等待：避免网络抖动瞬间又打同一个订阅源 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日志里的订阅地址脱敏：去掉账号密码，同时避免 token query 打到终端里 */
function redactUrlForLog(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

/** 网络层异常：Workers 常见的是 Network connection lost / fetch failed，重试大概率能救回 */
function isRetryableNetworkError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '').toLowerCase();
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return [
    'network connection lost',
    'fetch failed',
    'network error',
    'connection reset',
    'connection closed',
    'connection aborted',
    'timed out',
    'temporarily unavailable',
    'try again'
  ].some((needle) => message.includes(needle));
}

/** 可重试响应码：429 限流与 5xx / 网关抖动都值得再试一次 */
function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

/**
 * 带总预算的重试抓取：单次超时 8 秒，最多 3 次，总预算 30 秒。
 * 网络异常、超时、429 与 5xx 才会重试；DNS / 协议等确定性失败立即返回，
 * 每次重试前退避 300ms、600ms，并把失败原因落到服务端日志便于排查。
 */
async function fetchWithRetry(url) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastResponse = null;
  let lastError = null;

  while (attempt < FETCH_MAX_ATTEMPTS) {
    attempt += 1;
    const remaining = FETCH_MAX_TOTAL_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const timeoutMs = Math.max(500, Math.min(FETCH_TIMEOUT_MS, remaining));

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!isRetryableStatus(response.status) || attempt >= FETCH_MAX_ATTEMPTS) {
        return response;
      }

      lastResponse = response;
      lastError = null;
      console.warn('[subscribe][fetch] 可重试响应', {
        attempt,
        maxAttempts: FETCH_MAX_ATTEMPTS,
        status: response.status,
        host: redactUrlForLog(url),
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      lastError = error;
      lastResponse = null;
      console.warn('[subscribe][fetch] 抓取异常', {
        attempt,
        maxAttempts: FETCH_MAX_ATTEMPTS,
        name: error?.name || 'Error',
        message: error?.message || 'unknown',
        host: redactUrlForLog(url),
        elapsedMs: Date.now() - startedAt,
        willRetry: attempt < FETCH_MAX_ATTEMPTS && isRetryableNetworkError(error)
      });

      if (attempt >= FETCH_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        error.attempts = attempt;
        throw error;
      }
    }

    await sleep(FETCH_RETRY_BASE_DELAY_MS * attempt);
  }

  if (lastResponse) return lastResponse;
  if (lastError) {
    lastError.attempts = attempt;
    throw lastError;
  }
  const error = new Error('超过抓取总预算');
  error.attempts = attempt;
  throw error;
}
export async function fetchAndExtract(url) {
  let response;
  try {
    response = await fetchWithRetry(url);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, error: `抓取超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒无响应）`, status: 504 };
    }
    const attempts = Number(error?.attempts) > 0 ? Number(error.attempts) : 1;
    return { ok: false, error: `抓取失败：${error?.message || '网络不可达'}（已重试 ${attempts - 1} 次）`, status: 0 };
  }

  const gate = await readBody(response);
  if (!gate.ok) return gate;

  const first = extractRuleLines(gate.text);
  const decoded = retryAsBase64(gate.text, first);
  if (decoded) return decoded;

  if (first.lines.length === 0) {
    return { ok: false, error: '没有从内容里识别出任何规则（可能不是规则订阅）' };
  }
  return { ok: true, ...first, truncated: first.lines.length >= MAX_RULE_LINES };
}
