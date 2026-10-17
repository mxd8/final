/**
 * 导出取数：按导出条件取记录并格式化成规则文本。
 * 类型 / 来源 / 时间窗 / 命中下限全部在 SQL 侧过滤（getAllLogs），订阅直链
 * 表到几万行时也不用整表进内存；value 为空与 FINAL 规则的数据形态过滤留在内存。
 * 摘要与文本必须由同一批记录算出，面板数字与订阅端行数才不会对不上。
 */

import {
  getAllLogs,
  formatLogRule,
  canonicalizeLogItem,
  markIpVersionFromCanonical,
  describeExportFilter,
  buildExportHeader
} from '../../_utils/logs/index.js';

/** DNS 解析失败占位行：捕获脚本不再上报，但旧库里可能残留，导出一律过滤 */
export const DNS_FAILED_PLACEHOLDER = 'Unresolved Domain (DNS Failed)';

/** 最近 N 天过滤：非正整数一律按「不过滤」处理，避免脏值把订阅清空 */
export function normalizeLastDays(value) {
  const days = Math.floor(Number(value) || 0);
  return days > 0 ? days : 0;
}

/** time 非法或早于 cutoff 视为不在时间窗内；time 由后端统一 ISO UTC 写入 */
export function hitWithinDays(item, cutoff) {
  const stamp = Date.parse(item?.time || '');
  return Number.isFinite(stamp) && stamp >= cutoff;
}

export async function buildExport(config, {
  type = 'all',
  source = '',
  withSource = false,
  minCount = 0,
  lastDays = 0
} = {}) {
  const typeKey = String(type || 'all').trim().toUpperCase();
  const resolvedLastDays = normalizeLastDays(lastDays);
  const cutoff = resolvedLastDays > 0 ? Date.now() - resolvedLastDays * 86400000 : null;

  // 类型（policy 等值）、来源、时间窗、命中下限全部下推 SQL（time/type/source 索引就绪）
  const logs = await getAllLogs(config, {
    minCount,
    policy: typeKey,
    source,
    cutoffIso: cutoff !== null ? new Date(cutoff).toISOString() : ''
  });

  const matched = [];
  const lines = [];
  for (const item of logs) {
    if (!item.value && item.type !== 'FINAL') continue;
    if (item.hostname === DNS_FAILED_PLACEHOLDER || item.value === DNS_FAILED_PLACEHOLDER) continue;
    const canonical = canonicalizeLogItem(item);
    matched.push(markIpVersionFromCanonical(item, canonical));
    lines.push(formatLogRule(item, { withSource, canonical }));
  }

  const hits = matched.reduce((sum, item) => sum + (Number(item.count) || 1), 0);
  return {
    lines,
    matched,
    hits,
    count: lines.length,
    ipv4: matched.filter((item) => item.ipv4).length,
    ipv6: matched.filter((item) => item.ipv6).length
  };
}

/** 把导出结果渲染成订阅文本；meta 时头部加统计注释，无结果时统一返回占位注释 */
export function renderExportText(result, { withMeta, filterText }) {
  const body = result.lines.length ? result.lines.join('\n') : '# 暂无符合条件的规则';
  if (!withMeta || !result.lines.length) return body;
  return buildExportHeader({
    filterText,
    lines: result.matched,
    hits: result.hits,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  }).concat([body]).join('\n');
}
