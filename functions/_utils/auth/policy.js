/**
 * 功能级限制策略（v4 预留接口）：按用户 / 用户组判定某个功能是否可用。
 *
 * 判定顺序（先命中先生效）：
 *   1. 管理令牌（token principal）→ 允许（既有部署与外部定时器不受影响）；
 *   2. 管理员用户 → 允许；
 *   3. 注册的动态策略 registerFeaturePolicy(feature, fn) —— 预留接入 AI 检测
 *      或其他动态限制（如按来源设备、按时间窗限流）；
 *   4. 用户组 permissions.features[feature] → 用户 permissions.features[feature]
 *      （用户覆盖组），取值 allow / deny；
 *   5. 默认允许。
 */

import { jsonResponse } from '../http.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** 内置功能清单：面板功能开关的注册表（新功能在此登记后才可被组/用户限制） */
export const FEATURES = {
  'logs.write': '规则写操作（更新 / 删除 / 批量 / 清空）',
  'subscribe.manage': '订阅解析与管理',
  'ai.config': 'AI 连接配置管理',
  'ai.run': 'AI 自动分流执行',
  'users.manage': '用户与权限管理（仅管理员有效）'
};

/** 动态策略注册表：feature → async (principal, feature, context) => { allowed, reason } */
const featurePolicies = new Map();

/**
 * 预留接口：为某个功能注册动态限制策略（AI 检测、限流、灰度等）。
 * 返回 { allowed: boolean, reason?: string }；返回其它值视为未判定（继续走静态规则）。
 */
export function registerFeaturePolicy(feature, policyFn) {
  if (typeof feature !== 'string' || !feature) throw new Error('registerFeaturePolicy: feature 不能为空');
  if (typeof policyFn !== 'function') throw new Error('registerFeaturePolicy: policyFn 必须是函数');
  featurePolicies.set(feature, policyFn);
}

export function unregisterFeaturePolicy(feature) {
  featurePolicies.delete(feature);
}

/** 合并用户组与用户的 features（用户覆盖组） */
function mergedFeatures(principal) {
  return { ...(principal?.group?.permissions?.features ?? {}), ...(principal?.user?.permissions?.features ?? {}) };
}

/** 单一入口：判定 principal 是否可用某功能 */
export async function evaluateFeature(principal, feature, context = {}) {
  if (!principal) return { allowed: false, reason: 'anonymous' };
  if (principal.type === 'token') return { allowed: true, reason: 'legacy-token' };
  if (principal.user?.role === 'admin') return { allowed: true, reason: 'admin' };

  const dynamic = featurePolicies.get(feature);
  if (dynamic) {
    const verdict = await dynamic(principal, feature, context);
    if (verdict && typeof verdict === 'object' && typeof verdict.allowed === 'boolean') {
      return verdict;
    }
  }

  const rule = mergedFeatures(principal)[feature];
  if (rule === 'deny') return { allowed: false, reason: 'permission-deny' };
  if (rule === 'allow') return { allowed: true, reason: 'permission-allow' };
  return { allowed: true, reason: 'default' };
}

/** 路由守卫：不允许时返回 403 响应，允许返回 null */
export async function requireFeature(principal, feature, context = {}) {
  const verdict = await evaluateFeature(principal, feature, context);
  if (verdict.allowed) return null;
  return jsonResponse(
    {
      success: false,
      error: `功能已被限制：${FEATURES[feature] ?? feature}（${verdict.reason}）。请联系管理员调整用户或用户组的功能权限。`
    },
    { status: 403, headers: NO_STORE }
  );
}
