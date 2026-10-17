/**
 * 主机名形态判定与规则类型推断。
 */

import { isIPv4, isIPv6, isCidr } from './ip.js';

/**
 * 目标是否为「主机名字符串」：纯域名、单个 IP 字面量或 CIDR 段。
 * FINAL 命中记录到的基本都是这几类；CIDR 是 IP 规则的合法匹配值，必须算主机名。
 */
export function isHostnameLike(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (isIPv4(text) || isIPv6(text)) return true;
  if (text.includes(':')) return true; // IPv6 前缀或 URL-REGEX
  if (text.startsWith('.') || text.startsWith('*') || text.includes('"') || text.includes("'")) return false;
  return /^[A-Za-z0-9_\-][A-Za-z0-9_\-]*(?:\.[A-Za-z0-9_\-]+)*$/.test(text) || isCidr(text);
}

/**
 * 按匹配值推断规则类型，不改动值本身：
 * 含冒号 → IP-CIDR6，IPv4 或带斜杠 → IP-CIDR，其余 → DOMAIN-SUFFIX。
 */
export function inferHostType(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'DOMAIN-SUFFIX';
  if (text.includes(':')) return 'IP-CIDR6';
  if (isIPv4(text) || text.includes('/')) return 'IP-CIDR';
  return 'DOMAIN-SUFFIX';
}
