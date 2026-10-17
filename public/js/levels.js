/**
 * 降维候选计算：把一条规则拆成「更粗粒度」的候选层级的纯数据。
 *
 * 这里不碰 DOM、不弹窗——渲染交给调用方（快速编辑弹窗内联展示）。
 * Functions 端不依赖这份代码，但降维语义必须一致：
 * 候选里显示的「匹配 N 条记录」= 后端 /exclude 实际会删掉的记录数。
 */

import { ipv4CandidatePrefixes, ipv6CandidatePrefixes, parseIpTarget } from './ipnet.js';

/** 旧版降维接口写入的三段式 IPv4 前缀（192.0.2 → 192.0.2.0/24） */
const LEGACY_V4_PREFIX_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 列出 hostname 可降维的候选层级。
 * IP 场景先保留当前掩码，再按常用层级上卷（v4：/32 → /24 → /16 → /8，
 * v6：/128 → /64 → /48 → /32 → /16），从而让 /16、/24、/32、/128 这类
 * 「具体网段 / 精细掩码」也能直接排除，不会只看到一个粗层级：
 * Surge 按 / 前缀掩码匹配，补不补零覆盖范围一样，保留原 IP 才认得出这是给谁降维的。
 * 域名场景逐层上卷 a.b.c.com → b.c.com → c.com。
 */
export function cpLevelCandidates(hostname, policy) {
    const value = String(hostname || '');
    if (!value) return [];
    const out = [];
    const parsed = parseIpTarget(value);

    if (parsed) {
        const typeName = parsed.family === 4 ? 'IP-CIDR' : 'IP-CIDR6';
        const prefixes = parsed.family === 4 ? ipv4CandidatePrefixes(parsed.prefix) : ipv6CandidatePrefixes(parsed.prefix);
        for (const prefix of prefixes) {
            const cidr = `${parsed.addressText}/${prefix}`;
            out.push({ ruleText: `${typeName},${cidr},${policy}`, target: cidr });
        }
        return out;
    }

    if (LEGACY_V4_PREFIX_RE.test(value) && value.split('.').every((part) => Number(part) <= 255)) {
        const cidr = `${value}.0/24`;
        out.push({ ruleText: `IP-CIDR,${cidr},${policy}`, target: cidr });
        return out;
    }

    const parts = value.split('.');
    for (let i = 0; i < parts.length - 1; i += 1) {
        const domain = parts.slice(i).join('.');
        out.push({ ruleText: `DOMAIN-SUFFIX,${domain},${policy}`, target: domain });
    }
    return out;
}
