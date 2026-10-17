/**
 * 订阅地址安全过滤：协议 / userinfo / SSRF 字面量黑名单一次判完。
 * 纯字符串判定、不做 DNS 解析：字面量过滤至少能挡掉最常见的探测目标。
 */

import { normalizeSubscriptionUrl, SubscriptionUrlError } from '../../_utils/subscriptions.js';

/** 拒绝的 IPv4 网段：环回、私有、链路本地（含云元数据）、CGNAT、组播、保留 */
const BLOCKED_IPV4 = [
  { test: (p) => p[0] === 0, reason: '0.0.0.0/8 保留网段' },
  { test: (p) => p[0] === 10, reason: '10.0.0.0/8 私有网段' },
  { test: (p) => p[0] === 127, reason: '127.0.0.0/8 环回地址' },
  { test: (p) => p[0] === 169 && p[1] === 254, reason: '169.254.0.0/16 链路本地（含云元数据地址）' },
  { test: (p) => p[0] === 172 && p[1] >= 16 && p[1] <= 31, reason: '172.16.0.0/12 私有网段' },
  { test: (p) => p[0] === 192 && p[1] === 168, reason: '192.168.0.0/16 私有网段' },
  { test: (p) => p[0] === 100 && p[1] >= 64 && p[1] <= 127, reason: '100.64.0.0/10 运营商级 NAT' },
  { test: (p) => p[0] === 198 && p[1] >= 18 && p[1] <= 19, reason: '198.18.0.0/15 基准测试保留' },
  { test: (p) => p[0] >= 224, reason: '组播 / 保留地址' }
];

/** 拒绝的主机名特征：系统与内网约定后缀 */
const BLOCKED_HOST_PATTERNS = [
  { test: (host) => host === 'localhost', reason: 'localhost 属于本机回环' },
  { test: (host) => host.endsWith('.localhost'), reason: '.localhost 后缀属于本机回环' },
  { test: (host) => host.endsWith('.local'), reason: '.local 是 mDNS 内网域名' },
  { test: (host) => host.endsWith('.internal'), reason: '.internal 是内网专用后缀' },
  { test: (host) => host.endsWith('.lan'), reason: '.lan 是内网专用后缀' },
  { test: (host) => host === 'metadata.google.internal', reason: '云厂商元数据服务地址' }
];

function blockedIPv4Reason(octets) {
  const hit = BLOCKED_IPV4.find((rule) => rule.test(octets));
  return hit ? hit.reason : '';
}

function blockedIPv6Reason(host) {
  const text = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (text === '::1') return 'IPv6 环回地址';
  if (text === '::') return 'IPv6 未指定地址';
  if (/^f[cd][0-9a-f]{2}:/.test(text)) return 'fc00::/7 唯一本地地址';
  if (/^fe[89ab][0-9a-f]:/.test(text)) return 'fe80::/10 链路本地地址';
  // ::ffff:x.x.x.x 是 IPv4 映射段，交给 IPv4 规则再判一次
  const mapped = text.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (mapped) return blockedIPv4Reason(mapped.slice(1).map(Number));
  return '';
}

/** 空串表示允许，非空为拒绝原因 */
function blockedHostReason(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return '订阅地址缺少主机名';

  for (const rule of BLOCKED_HOST_PATTERNS) {
    if (rule.test(host)) return rule.reason;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    // 段值超过 255 说明根本不是 IP，交给后续抓取自然失败
    if (octets.some((part) => part > 255)) return '';
    return blockedIPv4Reason(octets);
  }
  if (host.includes(':')) return blockedIPv6Reason(host);
  return '';
}

/** 校验并规范化订阅地址。@returns {{url:string}|{error:string}} */
export function checkSubscriptionUrl(raw) {
  let normalized;
  try {
    normalized = normalizeSubscriptionUrl(raw);
  } catch (error) {
    if (error instanceof SubscriptionUrlError) return { error: error.message };
    return { error: '订阅地址无法解析' };
  }
  const host = new URL(normalized).hostname;
  const reason = blockedHostReason(host);
  if (reason) return { error: `不允许抓取该地址：${reason}` };
  return { url: normalized };
}
