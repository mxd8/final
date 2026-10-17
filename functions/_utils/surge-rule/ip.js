/**
 * IPv4 / IPv6 / CIDR 字面量校验与导出规范化。
 */

const IPV4_OCTET_RE = /^(\d{1,3})$/;

function isIpOctet(text) {
  if (!IPV4_OCTET_RE.test(text)) return false;
  return Number(text) <= 255;
}

/** IPv4 点分十进制，逐段 0-255 校验 */
export function isIPv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => isIpOctet(part));
}

/** IPv6：含基本形态与 ::ffff:1.2.3.4 混合形态 */
export function isIPv6(value) {
  const text = String(value);
  if (isIPv4(text)) return false;
  if (!text.includes(':')) return false;
  if (/\.\d{1,3}(\.\d{1,3}){3}$/.test(text)) return true;
  return /([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}|::/.test(text);
}

function isIntegerPrefix(text) {
  return /^\d+$/.test(text) && Number.isInteger(Number(text));
}

/** CIDR 形式校验，前缀长度按地址族区分（含冒号 0-128，否则 0-32） */
export function isCidr(value) {
  const text = String(value || '');
  const slash = text.lastIndexOf('/');
  if (slash <= 0) return false;

  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (!isIntegerPrefix(prefixText)) return false;

  const prefix = Number(prefixText);
  const maxPrefix = address.includes(':') ? 128 : 32;
  return prefix <= maxPrefix;
}

/** IP 字面量 + 可选前缀是否成对合法（单 IP 也允许，导出时补前缀长度） */
export function isValidIpLiteral(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return isCidr(text) || isIPv4(text) || isIPv6(text);
}

/**
 * 判断值是否「长得像 IP/CIDR 但不合法」（999.999.999.999、10.0.0.0/100）。
 * 域名、进程名、URL-REGEX 一律返回 false，不误伤非 IP 类型。
 */
export function isInvalidIpLiteral(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text) && !isValidIpLiteral(text)) return true;
  const slash = text.lastIndexOf('/');
  if (slash > 0) {
    const address = text.slice(0, slash);
    const prefixText = text.slice(slash + 1);
    if (/^\d+$/.test(prefixText)) {
      const prefix = Number(prefixText);
      const maxPrefix = address.includes(':') ? 128 : 32;
      if (prefix > maxPrefix) return true;
    }
  }
  return false;
}

/**
 * 导出规范化：单个 IP 补 /32 或 /128，已是段前缀的原样输出；
 * IPv6 字面量即使声明为 IP-CIDR 也纠正为 IP-CIDR6。
 */
export function canonicalIp(typeName, value) {
  const text = String(value ?? '').trim();
  if (typeName !== 'IP-CIDR' && typeName !== 'IP-CIDR6') {
    return { type: typeName, value: text };
  }
  if (!text) return { type: typeName, value: text };
  const slash = text.lastIndexOf('/');
  if (slash > 0 && /^\d+$/.test(text.slice(slash + 1))) return { type: typeName, value: text };
  return text.includes(':')
    ? { type: 'IP-CIDR6', value: `${text}/128` }
    : { type: 'IP-CIDR', value: `${text}/32` };
}
