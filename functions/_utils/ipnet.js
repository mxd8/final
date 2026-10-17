/**
 * IP / CIDR 数学工具：字面量解析、网段基址补零、格式化与网段包含判断。
 *
 * 前端 public/js/ipnet.js 有一份等价实现（静态资源与 Functions 不共享代码），
 * 两边语义必须一致：降维弹窗里显示的「匹配 N 条记录」= 后端实际会删除的记录数。
 */

/** 解析 IPv4 点分十进制为 32 位无符号整数，段越界或格式不对返回 null */
export function parseIpv4(text) {
  const parts = String(text ?? '').split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * 解析 IPv6 为 8 组 16 位整数数组，失败返回 null。
 * 支持 :: 压缩与 ::ffff:1.2.3.4 混合形态；不认 zone id（fe80::1%en0）。
 */
export function parseIpv6(text) {
  const raw = String(text ?? '').trim();
  if (!raw || !raw.includes(':') || raw.includes('%')) return null;

  const halves = raw.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part) => {
    if (part === '') return [];
    const groups = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(piece)) {
        // 混合形态只允许出现在最后一段，占末尾两组
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        groups.push(v4 >>> 16, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return head.concat(new Array(missing).fill(0), tail);
}

/** 8 组 16 位整数转标准压缩文本（最长全零段 ≥2 组时用 ::，平手取最左） */
export function formatIpv6(groups) {
  let bestStart = -1;
  let bestLen = 0;
  let current = -1;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === 0) {
      if (current < 0) current = i;
    } else if (current >= 0) {
      if (i - current > bestLen) {
        bestLen = i - current;
        bestStart = current;
      }
      current = -1;
    }
  }
  if (bestLen < 2) return groups.map((group) => group.toString(16)).join(':');
  const hex = (slice) => slice.map((group) => group.toString(16)).join(':');
  const head = hex(groups.slice(0, bestStart));
  const tail = hex(groups.slice(bestStart + bestLen));
  if (bestStart === 0) return `::${tail}`;
  if (bestStart + bestLen === 8) return `${head}::`;
  return `${head}::${tail}`;
}

/** IPv4 整数按前缀长度清零主机位 */
export function ipv4NetworkBase(int, prefix) {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return int >>> 0;
  return (int & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0;
}

/** IPv6 8 组数组按前缀长度清零主机位，返回新数组 */
export function ipv6NetworkBase(groups, prefix) {
  const out = groups.slice();
  const full = Math.floor(prefix / 16);
  const rest = prefix % 16;
  for (let i = full + (rest > 0 ? 1 : 0); i < 8; i += 1) out[i] = 0;
  if (rest > 0) out[full] = (groups[full] >> (16 - rest)) << (16 - rest);
  return out;
}

/** IPv4 整数 + 前缀长度 → 补零后的 a.b.c.d/n */
export function ipv4CidrString(int, prefix) {
  const base = ipv4NetworkBase(int, prefix);
  return `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}/${prefix}`;
}

/** IPv6 8 组数组 + 前缀长度 → 补零压缩后的 xxxx::/n */
export function ipv6CidrString(groups, prefix) {
  return `${formatIpv6(ipv6NetworkBase(groups, prefix))}/${prefix}`;
}

/**
 * 解析 IP 字面量或 CIDR 段为统一结构，非 IP 返回 null：
 *   { family: 4, baseInt, prefix, cidr: '补零后的 a.b.c.d/n', addressText: '原样地址文本' }
 *   { family: 6, groups, prefix, cidr: '补零压缩后的 ::/n', addressText: '原样地址文本' }
 * 单个 IP 视为 /32 或 /128；主机位不为零的段（61.139.8.102/31）cidr 自动归零，
 * addressText 保留用户输入原文（61.139.8.102）——降维候选只放宽前缀、不动地址，
 * 补零后的 61.139.8.0/24 会让人认不出这条规则原本是给谁用的。
 */
export function parseIpTarget(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const slash = raw.lastIndexOf('/');
  const address = slash > 0 ? raw.slice(0, slash) : raw;
  let prefix = null;
  if (slash > 0) {
    const prefixText = raw.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
  }

  if (address.includes(':')) {
    const groups = parseIpv6(address);
    if (!groups) return null;
    if (prefix === null) prefix = 128;
    if (prefix > 128) return null;
    return { family: 6, groups: ipv6NetworkBase(groups, prefix), prefix, cidr: ipv6CidrString(groups, prefix), addressText: address };
  }

  const ipv4 = parseIpv4(address);
  if (!ipv4) return null;
  if (prefix === null) prefix = 32;
  if (prefix > 32) return null;
  return { family: 4, baseInt: ipv4NetworkBase(ipv4, prefix), prefix, cidr: ipv4CidrString(ipv4, prefix), addressText: address };
}

/**
 * 记录值是否落在目标网段内：记录可为同族单 IP 或 CIDR。
 * CIDR 段之间只有「嵌套或不相交」两种关系，因此包含 = 记录段 ⊆ 目标段，
 * 即记录前缀更细（≥ 目标前缀）且高目标前缀位相同。
 * 目标比记录更粗时返回 false：汇总规则盖不住整条记录，不能删。
 */
export function hostInCidr(hostText, target) {
  const record = parseIpTarget(hostText);
  if (!record || record.family !== target.family) return false;
  if (record.prefix < target.prefix) return false;

  if (record.family === 4) {
    const shift = 32 - target.prefix;
    if (shift === 0) return true;
    return (record.baseInt >>> shift) === (target.baseInt >>> shift);
  }

  const full = Math.floor(target.prefix / 16);
  const rest = target.prefix % 16;
  for (let i = 0; i < full; i += 1) {
    if (record.groups[i] !== target.groups[i]) return false;
  }
  if (rest > 0) {
    const shift = 16 - rest;
    return (record.groups[full] >>> shift) === (target.groups[full] >>> shift);
  }
  return true;
}

/**
 * IPv4 降维候选前缀：先保留当前掩码，再按 /24 → /16 → /8 给更粗层级，
 * 让 /16、/24、/32 这类具体网段也能直接出现在降维排除表里。
 */
export function ipv4CandidatePrefixes(prefix) {
  const current = Math.max(0, Math.min(32, Math.floor(Number(prefix) || 32)));
  const out = [current];
  for (const step of [24, 16, 8]) {
    if (step < current && !out.includes(step)) out.push(step);
  }
  return out;
}

/**
 * IPv6 降维候选前缀：先保留当前掩码，再按 /64 → /48 → /32 → /16 给更粗层级。
 */
export function ipv6CandidatePrefixes(prefix) {
  const current = Math.max(0, Math.min(128, Math.floor(Number(prefix) || 128)));
  const out = [current];
  for (const step of [64, 48, 32, 16]) {
    if (step < current && !out.includes(step)) out.push(step);
  }
  return out;
}
