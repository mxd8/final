/**
 * 策略名判定与规范化：PROXY / DIRECT / REJECT / 自定义策略组 / DEVICE:<name>。
 */

import { isRuleParamSegment } from './params.js';

/**
 * 合法策略名判定。必须排除官方参数名：no-resolve 这类全小写加连字符的名字
 * 完全符合自定义策略组名正则，不排除会把参数当策略写进库。
 * DEVICE: 前缀大小写不敏感；FINAL 不是合法策略。
 */
export function isPolicyName(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.toUpperCase() === 'FINAL') return false;
  if (isRuleParamSegment(text)) return false;
  if (/^device:/i.test(text)) return /^[Dd][Ee][Vv][Ii][Cc][Ee]:[\w.\-]+$/.test(text);
  return /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/.test(text);
}

/**
 * 规范化策略名：内置策略与自定义组名统一大写，便于按策略精确筛选；
 * DEVICE: 前缀统一大写，但设备名区分大小写（Surge 按设备名匹配）原样保留；
 * 非法值回落到 fallback。
 */
export function normalizePolicy(policy, fallback = 'PROXY') {
  const text = String(policy || '').trim();
  if (!isPolicyName(text)) return fallback;
  if (/^device:/i.test(text)) return `DEVICE:${text.slice(text.indexOf(':') + 1)}`;
  return text.toUpperCase();
}
