/**
 * surge-rule 模块公共出口：解析 / 校验 / 格式化 / 策略与类型常量。
 * 全部为纯函数，零 IO；订阅解析、批量覆盖、单条编辑、导出共用同一份实现。
 */

export { RULE_TYPES, ALL_RULE_TYPES, SURGE_POLICIES } from './types.js';

export {
  FLAG_PARAMS,
  KV_PARAMS,
  RULE_PARAMS,
  FLAG_PARAM_NAMES,
  KV_PARAM_NAMES,
  isKnownParam,
  isFlagParam,
  isRuleParamSegment
} from './params.js';

export { isPolicyName, normalizePolicy } from './policy.js';

export {
  isIPv4,
  isIPv6,
  isCidr,
  isValidIpLiteral,
  isInvalidIpLiteral,
  canonicalIp
} from './ip.js';

export { isHostnameLike, inferHostType } from './host.js';

export { parseRuleLine } from './parse.js';

export { formatRuleItem, formatRule, joinRuleLines } from './format.js';
