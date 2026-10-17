/**
 * FINAL 命中记录：单条 / 批量 upsert 替代「先查再写」，并发命中不会产生重复行。
 * 批量入口 /api/logger/hits 供捕获脚本的本地去重窗口一次提交整组命中，
 * 把写 QPS 从「每次命中一个远端事务」降到「每个窗口一个远端事务」。
 */

import { inferHostType } from '../surge-rule/index.js';
import { encodeParams, parseParamsText, normalizeParamsObject } from './codec.js';
import { normalizeRulePolicy, normalizeRuleType, normalizeSource } from './normalize.js';
import { LOGS_TABLE, WRITE_COLUMNS, nowIso } from './schema.js';

/** 批量上报单次接受的命中条数上限：超出直接拒绝，防止请求体无限膨胀 */
export const HIT_BATCH_MAX_ITEMS = 200;

/** 单个主机名一次上报的触发次数上限：防脏数据把 count 一次推爆 */
const HIT_BATCH_MAX_COUNT = 1000;

/**
 * 入参 type / value / params 可选：中转模式能拿到 $request.matched 的完整规则就一并落库，
 * 拿不到时按主机名形态推断类型、值回落为主机名。
 */
export async function recordHit(db, hostname, {
  source = '',
  policy = 'PROXY',
  type = 'UNSET',
  value = 'UNSET',
  params = null
} = {}) {
  return recordHits(db, [{ hostname, source, policy, type, value, params }]);
}

/** 归一化一条命中的入库字段；hostname 为空返回 null（调用方跳过） */
function normalizeHitInput(item) {
  const target = String(item?.hostname ?? '').trim();
  if (!target) return null;

  const inferredType = inferHostType(target);
  const type = String(item.type ?? '').trim().toUpperCase();
  const rawValue = String(item.value ?? '').trim();
  return {
    hostname: target,
    type: !type || type === 'UNSET' ? inferredType : normalizeRuleType(type),
    value: !rawValue || rawValue === 'UNSET' ? target : rawValue,
    policy: normalizeRulePolicy(item.policy),
    params: item.params == null ? '' : encodeParams(
      typeof item.params === 'string' ? parseParamsText(item.params) : normalizeParamsObject(item.params)
    ),
    source: normalizeSource(item.source),
    count: Math.min(HIT_BATCH_MAX_COUNT, Math.max(1, Math.floor(Number(item.count) || 1)))
  };
}

/**
 * 组装单条 upsert：插入以 count 计数，冲突时按 excluded.count 累加。
 * policy 只在首次插入时写入：命中路径只知道「脚本配置的策略」而非真实命中策略，
 * 冲突覆盖会把用户手工调整过的策略冲掉，所以更新分支不动 policy。
 */
function buildHitStatement(hit, now) {
  return {
    sql: `INSERT INTO ${LOGS_TABLE} (${WRITE_COLUMNS})
          VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
          ON CONFLICT(hostname) DO UPDATE SET
            type = CASE WHEN excluded.type = ? THEN ${LOGS_TABLE}.type ELSE excluded.type END,
            value = CASE WHEN ${LOGS_TABLE}.value = '' THEN excluded.value ELSE ${LOGS_TABLE}.value END,
            count = ${LOGS_TABLE}.count + excluded.count,
            time = excluded.time,
            first_time = COALESCE(NULLIF(${LOGS_TABLE}.first_time, ''), excluded.time),
            source = CASE WHEN ${LOGS_TABLE}.source = '' THEN excluded.source ELSE ${LOGS_TABLE}.source END`,
    params: [
      hit.hostname, hit.type, hit.value, hit.policy, hit.params, hit.source, now, now, hit.count,
      hit.type
    ]
  };
}

/**
 * 批量记录命中：同主机名的多条合并为一条（次数累加），一次批量事务提交整组。
 * 返回 accepted = 去重后的主机名数、changed = 任一语句有写入。
 */
export async function recordHits(db, items = []) {
  if (!Array.isArray(items) || !items.length) return { accepted: 0, changed: false };
  if (items.length > HIT_BATCH_MAX_ITEMS) {
    throw new Error(`单次上报最多 ${HIT_BATCH_MAX_ITEMS} 条命中`);
  }

  const merged = new Map();
  for (const item of items) {
    const hit = normalizeHitInput(item);
    if (!hit) continue;
    const existing = merged.get(hit.hostname);
    if (existing) {
      existing.count = Math.min(HIT_BATCH_MAX_COUNT, existing.count + hit.count);
    } else {
      merged.set(hit.hostname, hit);
    }
  }
  if (!merged.size) return { accepted: 0, changed: false };

  const now = nowIso();
  const results = await db.batch(
    [...merged.values()].map((hit) => buildHitStatement(hit, now))
  );
  return {
    accepted: merged.size,
    changed: results.some((result) => result.changes > 0)
  };
}
