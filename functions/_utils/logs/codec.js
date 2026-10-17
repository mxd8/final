/**
 * params 字段的编解码：对象 ↔ 逗号分隔的 key=value / 标志位文本。
 */

import { RULE_PARAMS, isFlagParam } from '../surge-rule/index.js';
import { MAX_PARAM_LENGTH } from './schema.js';

/** 对象 → 参数文本：只保留白名单参数，标志位写裸键名 */
export function encodeParams(params = {}) {
  const entries = [];
  for (const [name, raw] of Object.entries(params || {})) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) continue;
    if (!RULE_PARAMS.includes(key)) continue;
    const flag = isFlagParam(key);
    const valueText = flag ? '' : String(raw ?? '').trim();
    if (!flag && !valueText) continue;
    entries.push(flag ? key : `${key}=${valueText}`);
  }
  return entries.join(',').slice(0, MAX_PARAM_LENGTH);
}

/** 参数文本 → 对象：空串返回空对象 */
export function decodeParams(text) {
  const out = {};
  const raw = String(text || '').trim();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const key = (eq >= 0 ? item.slice(0, eq) : item).trim().toLowerCase();
    if (!key) continue;
    out[key] = isFlagParam(key) ? null : (eq >= 0 ? item.slice(eq + 1).trim() : '');
  }
  return out;
}

/** 逗号分隔的参数文本 → 对象（Surge 脚本上报的是文本形态） */
export function parseParamsText(text) {
  const parsed = {};
  for (const part of String(text || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const key = (eq >= 0 ? item.slice(0, eq) : item).trim().toLowerCase();
    if (!key) continue;
    parsed[key] = isFlagParam(key) ? null : (eq >= 0 ? item.slice(eq + 1).trim() : '');
  }
  return parsed;
}

/** 结构化入参的 params 归一化：只保留白名单参数 */
export function normalizeParamsObject(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  return decodeParams(encodeParams(params));
}
