/**
 * 规则文本的前端处理：策略规范化、徽标渲染、规则行拼装与轻量解析。
 */

import { CP_BUILTIN_POLICIES, CP_POLICY_COLORS } from './config.js';
import { cpEscape, cpIsIPv4, cpIsIPv6 } from './dom.js';

const CP_BUILTIN_POLICY_UPPER = CP_BUILTIN_POLICIES.map((name) => name.toUpperCase());

/**
 * 策略名规范化：内置策略统一大写，其余原样保留。
 * DEVICE:<name> 的设备名大小写敏感（Surge 按设备名匹配），不能被统一转大写。
 */
export function normalizePolicy(policy) {
    const text = String(policy ?? '').trim();
    if (!text) return 'PROXY';
    const upper = text.toUpperCase();
    if (CP_BUILTIN_POLICY_UPPER.includes(upper)) return upper;
    if (upper.startsWith('DEVICE:')) return `DEVICE:${text.slice(7)}`;
    return text;
}

/** 策略徽标 HTML：内置策略用固定配色，自定义策略组用灰色 */
export function policyBadge(policy) {
    const text = String(policy || 'PROXY');
    const color = CP_POLICY_COLORS[text.toUpperCase()] || '#6c757d';
    return `<span class="cp-badge rounded-pill" style="color:#fff;background:${color};">🌐 ${cpEscape(text)}</span>`;
}

/** 参数徽标 HTML：标志位显示为标签，键值参数显示 name=value */
export function paramBadges(params = {}) {
    const items = [];
    for (const [name, raw] of Object.entries(params || {})) {
        const label = raw == null || raw === '' ? name : `${name}=${raw}`;
        items.push(`<span class="badge text-bg-light text-dark border">${cpEscape(label)}</span>`);
    }
    return items.join(' ');
}

/** 规则字段值含逗号时加双引号：后端切分时才不会把一条规则拆成多段 */
export function quoteRuleField(value) {
    const text = String(value ?? '');
    return text.includes(',') ? `"${text}"` : text;
}

/**
 * 把一条规则拼成 Surge 规则文本，行为与后端 formatRuleItem 对齐：
 * FINAL 不输出匹配值；单个 IP 字面量补 /32 / /128；值含逗号时加引号。
 * 编辑框里显示的文本必须和最终入库的文本一致。
 */
export function buildRuleLine(entry) {
    const rawType = String(entry.type || 'DOMAIN-SUFFIX').toUpperCase();
    const policy = normalizePolicy(entry.policy);
    const isFinal = rawType === 'FINAL';

    let value = String(entry.value ?? '');
    let type = rawType;
    if (!isFinal) {
        if (cpIsIPv4(value) && !value.includes('/')) {
            type = 'IP-CIDR';
            value = `${value}/32`;
        } else if (cpIsIPv6(value) && !value.includes('/')) {
            type = 'IP-CIDR6';
            value = `${value}/128`;
        }
    }

    const parts = isFinal ? [type, policy] : [type, quoteRuleField(value), policy];
    for (const [name, raw] of Object.entries(entry.params || {})) {
        parts.push(raw == null || raw === '' ? name : `${name}=${quoteRuleField(raw)}`);
    }
    const body = parts.join(',');
    const comment = String(entry.comment || '').trim();
    return comment ? `${body} // ${comment}` : body;
}

/** 找出行内注释起点，跳过引号内的 //、#、;；无注释返回 -1 */
function scanCommentCut(text) {
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '/' && text[i + 1] === '/') { return i; }
        if (char === '#' || char === ';') { return i; }
    }
    return -1;
}

/** 按逗号切分规则体，跳过引号内的逗号，并剥掉包裹引号 */
function splitRuleFields(text) {
    const parts = [];
    let current = '';
    let quote = '';
    for (const char of text) {
        if (quote) {
            current += char;
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === ',') { parts.push(current); current = ''; continue; }
        current += char;
    }
    parts.push(current);
    return parts.map((part) => {
        const trimmed = part.trim();
        return trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.endsWith('"')) || (trimmed[0] === "'" && trimmed.endsWith("'")))
            ? trimmed.slice(1, -1)
            : trimmed;
    });
}

/**
 * 本地解析一行规则文本：仅用于「批量框里这一行像不像规则」的轻量统计。
 * 后端 parseRuleLine 才是权威解析，这里刻意做得宽松，避免把解析逻辑复制一份维护两份。
 */
export function cpParseRuleLine(line) {
    let text = String(line || '').trim();
    if (!text || /^[#;]/.test(text)) return null;

    let comment = '';
    const cut = scanCommentCut(text);
    if (cut >= 0) {
        comment = text.slice(cut).trim().replace(/^\/\/|#|;/, '').trim();
        text = text.slice(0, cut).trim();
    }
    if (!text) return null;

    const fields = splitRuleFields(text);
    if (fields.length < 2) return null;

    const [type, value, policy, ...rawParams] = fields;
    const params = {};
    for (const raw of rawParams) {
        if (!raw) continue;
        const eq = raw.indexOf('=');
        const name = (eq >= 0 ? raw.slice(0, eq) : raw).trim().toLowerCase();
        if (!name) continue;
        params[name] = eq >= 0 ? raw.slice(eq + 1).trim() : null;
    }
    return { type: type || 'DOMAIN-SUFFIX', value: value || '', policy: policy || 'PROXY', params, comment };
}

/** 判断一行是否「看起来是规则」：类型名 + 逗号，用于批量框的行数统计 */
export function cpLooksLikeRule(line) {
    const text = String(line || '').trim();
    if (!text || /^[#;]/.test(text)) return false;
    return /^[A-Za-z0-9-]+\s*,/.test(text);
}
