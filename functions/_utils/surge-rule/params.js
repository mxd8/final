/**
 * 规则参数白名单：官方可选参数分为「纯标志位」与「键=值」两类。
 * 本模块必须先于 policy 定义：策略判定要排除参数名。
 */

/** 纯标志位参数（不带取值） */
export const FLAG_PARAMS = new Set([
  'no-resolve',
  'dns-failed',
  'extended-matching',
  'pre-matching',
  'requires-resolve'
]);

/** 键=值形式参数 */
export const KV_PARAMS = new Set([
  'notification-text',
  'notification-interval',
  'update-interval',
  'always-capture'
]);

/** 参数白名单，用于校验与前端提示 */
export const RULE_PARAMS = [...FLAG_PARAMS, ...KV_PARAMS];

/** 按值形式区分的参数分组：前端选择器分两栏展示 */
export const FLAG_PARAM_NAMES = [...FLAG_PARAMS];
export const KV_PARAM_NAMES = [...KV_PARAMS];

export function isKnownParam(name) {
  return FLAG_PARAMS.has(String(name || '').trim().toLowerCase()) ||
    KV_PARAMS.has(String(name || '').trim().toLowerCase());
}

export function isFlagParam(name) {
  return FLAG_PARAMS.has(String(name || '').trim().toLowerCase());
}

/**
 * 判断片段是否为「规则参数」而不是策略：同时接受 key=value 形式。
 * 必须严格只认白名单，不做「像参数就算参数」的猜测——
 * 猜测会把真实策略组名（my-proxy、work-phone）当成参数吃掉。
 */
export function isRuleParamSegment(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const name = (raw.split('=')[0] || '').trim().toLowerCase();
  return FLAG_PARAMS.has(name) || KV_PARAMS.has(name);
}
