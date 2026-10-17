/**
 * 规则对象 → Surge 规则文本的格式化输出。
 */

import { RULE_TYPES } from './types.js';
import { isIPv4, isIPv6, canonicalIp } from './ip.js';
import { isPolicyName } from './policy.js';
import { formatValue } from './text.js';

/**
 * 拼回 Surge 规则文本：TYPE,VALUE,POLICY[,参数...][ // 注释]。
 * 单个 IP 补 /32 或 /128；FINAL 不输出匹配值；值内含逗号时加引号。
 */
export function formatRuleItem({ type, value = '', policy, params = {}, comment = '' } = {}) {
  const typeName = String(type || '').trim().toUpperCase() || 'DOMAIN-SUFFIX';
  const needsValue = RULE_TYPES.get(typeName);
  const { type: finalType, value: normalizedValue } = canonicalIp(typeName, value);
  const parts = needsValue
    ? [finalType, formatValue(finalType, normalizedValue), String(policy || 'PROXY')]
    : [finalType, String(policy || 'PROXY')];
  for (const [name, paramValue] of Object.entries(params || {})) {
    parts.push(paramValue == null || paramValue === '' ? name : `${name}=${paramValue}`);
  }
  const body = parts.join(',');
  return comment && String(comment).trim() ? `${body} // ${String(comment).trim()}` : body;
}

/** 把规则行数组拼成纯文本；没有内容时返回提示文本，便于订阅端识别 */
export function joinRuleLines(lines, emptyText = '# 暂无符合条件的规则') {
  return lines.length > 0 ? lines.join('\n') : emptyText;
}

/** 旧接口兼容：单主机名 + 策略生成规则（导入旧数据或简单场景用） */
export function formatRule(target, policy, comment) {
  const targetText = String(target || '').trim();
  const validPolicy = isPolicyName(policy) ? String(policy).trim().toUpperCase() : 'PROXY';

  let type;
  let value;
  if (!targetText) {
    type = 'DOMAIN-SUFFIX';
    value = '';
  } else if (targetText.includes('/')) {
    type = targetText.includes(':') ? 'IP-CIDR6' : 'IP-CIDR';
    value = targetText;
  } else if (isIPv4(targetText)) {
    type = 'IP-CIDR';
    value = `${targetText}/32`;
  } else if (isIPv6(targetText)) {
    type = 'IP-CIDR6';
    value = `${targetText}/128`;
  } else {
    type = 'DOMAIN-SUFFIX';
    value = targetText;
  }

  return formatRuleItem({ type, value, policy: validPolicy, comment });
}
