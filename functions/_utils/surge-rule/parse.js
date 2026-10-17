/**
 * 一行 Surge 规则文本的结构化解析。
 * 支持 TYPE,VALUE,POLICY[,参数...] 完整结构，以及「值,策略」「裸值」简写；
 * 解析不了的结构返回 invalid 标记，空行与纯注释返回 null。
 */

import { RULE_TYPES } from './types.js';
import { FLAG_PARAMS, KV_PARAMS, isRuleParamSegment } from './params.js';
import { isPolicyName, normalizePolicy } from './policy.js';
import { isHostnameLike, inferHostType } from './host.js';
import { splitRespectingQuotes, stripQuotes, scanCommentStart } from './text.js';

/** 解析策略之后的参数段，保留原顺序；标志位记 null，键值参数取等号右侧 */
function parseRuleParams(rawParams) {
  const params = {};
  for (const raw of rawParams) {
    const part = String(raw || '').trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = (eq >= 0 ? part.slice(0, eq) : part).trim().toLowerCase();
    const flag = FLAG_PARAMS.has(name);
    const validName = flag || KV_PARAMS.has(name) || /^[a-z0-9_-]+$/.test(name);
    if (!validName) continue;
    params[name] = flag ? null : (eq >= 0 ? part.slice(eq + 1).trim() : '');
  }
  return params;
}

/** 单段简写：裸 FINAL 或按值形态推断类型的裸主机名 */
function parseBarePart(bare, comment) {
  if (bare.toUpperCase() === 'FINAL') {
    return { type: 'FINAL', value: '', policy: 'PROXY', params: {}, comment, invalid: false };
  }
  if (isHostnameLike(bare)) {
    return { type: inferHostType(bare), value: bare, policy: 'PROXY', params: {}, comment, invalid: false };
  }
  return null;
}

/** 两段简写：值 + 策略，或值 + 参数（策略缺失按默认 PROXY） */
function parseDoublePart(parts, comment) {
  const [candidate, second] = parts;
  const type = inferHostType(candidate);
  const base = { type, value: candidate, comment, invalid: false };
  if (isRuleParamSegment(second) && isHostnameLike(candidate)) {
    return { ...base, policy: normalizePolicy('PROXY'), params: parseRuleParams([second]) };
  }
  if (isPolicyName(second) && isHostnameLike(candidate)) {
    return { ...base, policy: normalizePolicy(second), params: {} };
  }
  return null;
}

/** 三段及以上：TYPE,VALUE,POLICY[,参数...]；未知类型标记 invalid */
function parseMultiPart(parts, comment) {
  const type = String(parts[0]).trim().toUpperCase();
  if (!RULE_TYPES.has(type)) {
    return { type, value: String(parts[1] ?? '').trim(), policy: String(parts[2] ?? '').trim(), params: {}, comment, invalid: true };
  }
  if (type === 'FINAL') {
    const finalPolicy = String(parts[1] ?? '').trim();
    return { type: 'FINAL', value: '', policy: normalizePolicy(finalPolicy), params: parseRuleParams(parts.slice(2)), comment, invalid: false };
  }
  return parseTypedPart(type, parts, comment);
}

/** 常规类型：策略非法回落默认；策略段缺失时参数顶上来并入参数列表 */
function parseTypedPart(type, parts, comment) {
  const value = String(parts[1] ?? '').trim();
  const rawPolicy = String(parts[2] ?? '').trim();
  const policy = isPolicyName(rawPolicy) ? normalizePolicy(rawPolicy) : normalizePolicy('PROXY');
  const rawParams = parts.slice(3);
  if (!value) {
    return { type, value, policy, params: {}, comment, invalid: true };
  }
  const allParams = [...(isRuleParamSegment(rawPolicy) ? [rawPolicy] : []), ...rawParams];
  return { type, value, policy, params: parseRuleParams(allParams), comment, invalid: false };
}

export function parseRuleLine(line) {
  if (!line) return null;
  let text = String(line).trim();
  if (!text || /^[#;]/.test(text)) return null;

  let comment = '';
  const quotePos = scanCommentStart(text);
  if (quotePos > 0) {
    comment = text.slice(quotePos).trim().replace(/^\/\/|#|;/, '').trim();
    text = text.slice(0, quotePos).trim();
  }
  if (!text) return null;

  const parts = splitRespectingQuotes(text).map((part) => stripQuotes(part));
  if (parts.length < 1) return null;
  if (parts.length === 1) return parseBarePart(parts[0], comment);
  if (parts.length === 2) return parseDoublePart(parts, comment);
  return parseMultiPart(parts, comment);
}
