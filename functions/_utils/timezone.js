/**
 * 时区换算：把「设备本地今天零点」换算成 UTC ISO 时间戳。
 * Workers 运行时固定 UTC，设备时区由客户端通过查询参数 tz=（分钟，正数 = UTC 以东）传入。
 */

export const TZ_PARAM = 'tz';

/** 合法偏移范围（分钟）：UTC-12 .. UTC+14 */
const MIN_OFFSET = -720;
const MAX_OFFSET = 840;

const MS_PER_DAY = 86400000;

/** 从查询参数取时区偏移，越界或非法按 fallback（默认 0 = UTC）处理 */
export function clientTzOffset(params, fallback = 0) {
  const raw = Number(params.get(TZ_PARAM));
  if (!Number.isFinite(raw) || raw < MIN_OFFSET || raw > MAX_OFFSET) return fallback;
  return raw;
}

/**
 * 计算客户端本地今天零点对应的 UTC ISO 字符串。
 * 用整数毫秒运算：UTC 时刻 + 偏移得本地墙上时间，向下取整到零点，再减回偏移。
 * 双次取模保证负数也能向下取整。ISO 字符串字典序与时间先后一致，SQL 可直接 range 比较。
 */
export function startOfClientDay(offsetMinutes, reference = new Date()) {
  const offsetMs = Number.isFinite(offsetMinutes) ? offsetMinutes * 60 * 1000 : 0;
  const localWallMs = reference.getTime() + offsetMs;
  const localMidnightMs = localWallMs - ((localWallMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return new Date(localMidnightMs - offsetMs).toISOString();
}
