/**
 * Surge 官方规则类型全集：键为类型名，值为「是否需要匹配值」。
 * 缺值或多余值都会被解析层标记 invalid。
 */

export const RULE_TYPES = new Map([
  // 域名
  ['DOMAIN', true],
  ['DOMAIN-SUFFIX', true],
  ['DOMAIN-KEYWORD', true],
  ['DOMAIN-WILDCARD', true],
  ['DOMAIN-SET', true],
  // IP
  ['IP-CIDR', true],
  ['IP-CIDR6', true],
  ['GEOIP', true],
  ['IP-ASN', true],
  // HTTP
  ['USER-AGENT', true],
  ['URL-REGEX', true],
  // 进程
  ['PROCESS-NAME', true],
  // 端口 / 客户端属性
  ['DEST-PORT', true],
  ['SRC-PORT', true],
  ['IN-PORT', true],
  ['SRC-IP', true],
  ['DEVICE-NAME', true],
  ['MAC-ADDRESS', true],
  // 协议与网络
  ['PROTOCOL', true],
  ['HOSTNAME-TYPE', true],
  ['SUBNET', true],
  ['CELLULAR-RADIO', true],
  ['CELLULAR-CARRIER', true],
  // 逻辑规则
  ['AND', true],
  ['OR', true],
  ['NOT', true],
  // 脚本与规则集
  ['SCRIPT', true],
  ['RULE-SET', true],
  // 最终规则：没有值
  ['FINAL', false]
]);

/** 全部类型名的扁平数组，供面板下拉框与补全使用 */
export const ALL_RULE_TYPES = Array.from(RULE_TYPES.keys());

/** Surge 内置策略：按策略筛选等统计场景使用 */
export const SURGE_POLICIES = ['PROXY', 'DIRECT', 'REJECT'];
